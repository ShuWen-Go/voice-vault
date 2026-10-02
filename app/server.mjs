// 听藏 voice-vault · 服务端
// 零依赖 Node http 服务 = 静态页托管 + 音频上传（D2） + 本地转写任务（D3）
// 形态沿用「链藏」app/server.mjs：单文件路由、不装任何 npm 包、注释即说明文档
//
// 上传方案（D2 技术决策）：raw body + 文件名放请求头。
//   音频是单个二进制大文件，请求体本身就是文件，服务端"收到啥存啥"，无需拆箱解析。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// D3：配置集中一处（路径不写死 —— 本地一套、云端可换，这正是「本地过 ≠ 云端过」的对策）
import { config, logConfig } from './config.mjs';
// D3：转写编排（起 Python 子进程 + 任务队列 + 进度 + 取消 + 幂等）
import { createTranscriber } from './transcribe.mjs';

// 静态文件根目录 = 本脚本所在目录（app/），打开 / 就找这里的 index.html
const staticRoot = fileURLToPath(new URL('./', import.meta.url));
// 音频落盘目录
const AUDIO_DIR = path.join(config.dataDir, 'audio');
// 上传清单（hash → 原文件名 / 大小 / 时间）
const INDEX_PATH = path.join(config.dataDir, 'audio-index.json');
// 转写产物目录
const TRANSCRIPT_DIR = path.join(config.dataDir, 'transcripts');

// 单次上传体积上限：1 小时 m4a 约 30–60MB，这里给到 300MB 留足余量
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

// 允许的音频后缀白名单 —— 不带白名单就等于允许往磁盘写任意文件
const ALLOWED_EXT = new Set(['.m4a', '.mp3', '.wav', '.webm', '.ogg', '.opus', '.aac', '.mp4', '.flac']);
// 明确不支持的格式：能识别就给出「为什么不行」，比一句"上传失败"有用得多
const UNSUPPORTED_EXT = new Set(['.amr', '.silk', '.wma', '.ape', '.m4b']);

// Content-Type → 后缀：浏览器录音多为 audio/webm，手机导出多为 audio/mp4(.m4a)
const CT_EXT = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function getMime(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return mimeTypes[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

// 统一的 JSON 响应 + 一行访问日志
function sendJson(req, res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
  console.log(`${req.method} ${req.url} ${statusCode}`);
}

// 统一的文本/二进制响应 + 一行访问日志
function sendRaw(req, res, statusCode, contentType, body) {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
  console.log(`${req.method} ${req.url} ${statusCode}`);
}

// 读请求体为 Buffer（⚠️ 音频是二进制，转成 utf8 字符串就毁了）
function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 读 JSON 请求体
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 托管 app/ 下的静态文件
function serveStatic(req, res) {
  // 🚨 畸形百分号编码（如直接访问 /%）会让 decodeURIComponent 抛错，
  // 而它在 createServer 回调里是「同步」执行的 → 异常冒泡 → 整个进程退出。
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    console.error('畸形 URL 编码，已拒绝：', req.url);
    sendRaw(req, res, 400, 'text/plain; charset=utf-8', 'Bad Request');
    return;
  }
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = fileURLToPath(new URL('.' + relative, import.meta.url));
  // 防 ../ 跳出静态根目录去读仓库根的文件（例如 .env）
  if (!filePath.startsWith(staticRoot)) {
    sendRaw(req, res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendRaw(req, res, 404, 'text/plain; charset=utf-8', 'Not Found');
        return;
      }
      console.error(err);
      sendRaw(req, res, 500, 'text/plain; charset=utf-8', '服务器内部错误');
      return;
    }
    sendRaw(req, res, 200, getMime(filePath), data);
  });
}

// 读上传清单（不存在就当空清单）
function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return { items: [] };
  }
}

// hash → 音频绝对路径（后缀优先从清单查，清单没有就按白名单逐个试探）
function findAudioByHash(hash) {
  if (!/^[0-9a-f]{12}$/.test(hash)) return null;
  const idx = loadIndex();
  const hit = idx.items.find((it) => it.hash === hash);
  const names = hit ? [hit.hash + hit.ext] : [...ALLOWED_EXT].map((e) => hash + e);
  for (const name of names) {
    const p = path.join(AUDIO_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 从原文件名 / Content-Type 推断后缀，拿不到就回退 .bin
function pickExt(filename, contentType) {
  const dot = filename.lastIndexOf('.');
  if (dot !== -1) {
    const ext = filename.slice(dot).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return ext;
  }
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (CT_EXT[ct]) return CT_EXT[ct];
  return '.bin';
}

// ========== D2 · POST /api/audio：把音频存下来 ==========
async function handleUpload(req, res) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  const rawName = query.get('filename') || req.headers['x-filename'] || '';
  // 请求头里的中文是百分号编码的，解不开就用原文（文件名只用于展示，不影响落盘）
  let filename = String(rawName);
  try {
    if (filename && /%[0-9a-f]{2}/i.test(filename)) filename = decodeURIComponent(filename);
  } catch { /* 解不开就保持原样 */ }
  filename = filename.trim() || 'audio';

  // 明确不支持的格式：先说清"为什么不行"，而不是让它在转写阶段才炸
  const lower = filename.toLowerCase();
  for (const bad of UNSUPPORTED_EXT) {
    if (lower.endsWith(bad)) {
      sendJson(req, res, 415, {
        error: `暂不支持 ${bad} 格式（微信语音常用 amr/silk）。请先转成 m4a / mp3 / wav 再上传。`,
      });
      return;
    }
  }

  let buf;
  try {
    buf = await readBodyBuffer(req);
  } catch (err) {
    sendJson(req, res, 413, { error: err.message });
    return;
  }
  if (!buf || buf.length === 0) {
    sendJson(req, res, 400, { error: '音频内容为空' });
    return;
  }

  // 内容哈希做文件名 ⇒ 同一个文件传两次只占一份（幂等），也天然防路径穿越
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const ext = pickExt(filename, req.headers['content-type']);
  const target = path.join(AUDIO_DIR, hash + ext);

  try {
    await mkdir(AUDIO_DIR, { recursive: true });
    const existed = fs.existsSync(target);
    if (!existed) await writeFile(target, buf);

    // 清单里按 hash 去重更新（重复上传只刷时间，不新增条目）
    const index = loadIndex();
    const item = { hash, ext, filename, bytes: buf.length, uploadedAt: new Date().toISOString() };
    index.items = [item, ...index.items.filter((it) => it.hash !== hash)];
    await writeFile(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');

    sendJson(req, res, 200, {
      ok: true,
      hash,
      ext,
      filename,
      bytes: buf.length,
      sizeMB: +(buf.length / 1024 / 1024).toFixed(2),
      existed, // true = 哈希命中，磁盘上本来就有这份（没重复写）
      fromClient: req.headers['content-type'] || '',
    });
  } catch (err) {
    console.error('落盘失败：', err);
    sendJson(req, res, 500, { error: '保存失败：' + err.message });
  }
}

// ========== D2 · GET /api/audios：已收到的音频清单 ==========
function handleList(req, res) {
  const index = loadIndex();
  // 顺带核对磁盘：清单里有、文件不见了的，如实标出来（不假装成功）
  const items = index.items.map((it) => ({
    ...it,
    onDisk: fs.existsSync(path.join(AUDIO_DIR, it.hash + it.ext)),
    transcribed: fs.existsSync(path.join(TRANSCRIPT_DIR, it.hash + '.json')),
  }));
  sendJson(req, res, 200, { count: items.length, items });
}

// ========== D3 · 转写任务 ==========
const transcriber = createTranscriber();

// POST /api/transcribe：提交任务，立刻返回 taskId
// （绝不同步等 —— medium 跑 22.5 分钟音频要 ~15 分钟）
async function handleTranscribeSubmit(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch {
    sendJson(req, res, 400, { error: '请求体不是合法 JSON' });
    return;
  }
  const hash = typeof payload.hash === 'string' ? payload.hash : '';
  const audioPath = findAudioByHash(hash);
  if (!audioPath) {
    sendJson(req, res, 404, { error: `没有这份音频（hash=${hash}）` });
    return;
  }
  const quality = ['small', 'medium', 'large-v3'].includes(payload.quality)
    ? payload.quality
    : config.defaultQuality;

  const t = transcriber.submit({ audioPath, hash, quality, force: payload.force === true });
  console.log(`转写任务 ${t.id} hash=${hash} quality=${quality} 状态=${t.status}${t.fromCache ? '（读档，未重算）' : ''}`);
  sendJson(req, res, 200, t);
}

// DELETE /api/transcribe/:id：取消
function handleTranscribeCancel(req, res, id) {
  const t = transcriber.cancel(id);
  if (!t) {
    sendJson(req, res, 404, { error: '任务不存在' });
    return;
  }
  console.log(`取消任务 ${id} → ${t.status}`);
  sendJson(req, res, 200, t);
}

// GET /api/transcripts：已落盘的转写产物清单
function handleTranscriptList(req, res) {
  let items = [];
  try {
    items = fs.readdirSync(TRANSCRIPT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = path.join(TRANSCRIPT_DIR, f);
        const st = fs.statSync(p);
        let meta = {};
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          meta = {
            quality: j.quality,
            durationSeconds: j.durationSeconds,
            elapsedSeconds: j.elapsedSeconds,
            rtf: j.rtf,
            segmentCount: j.segmentCount,
            charCount: j.charCount,
            language: j.language,
          };
        } catch { /* 坏文件也照实列出来，不隐藏 */ }
        return { hash: f.replace(/\.json$/, ''), bytes: st.size, mtime: st.mtime.toISOString(), ...meta };
      });
  } catch {
    items = [];
  }
  sendJson(req, res, 200, { count: items.length, items });
}

// ========== 服务器：按方法和路径分流 ==========
const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];

  // D2 音频上传：只接受 POST
  if (pathname === '/api/audio') {
    if (req.method !== 'POST') {
      sendJson(req, res, 400, { error: '请使用 POST 调用 /api/audio' });
      return;
    }
    handleUpload(req, res);
    return;
  }

  // D2 已收音频清单
  if (pathname === '/api/audios') {
    handleList(req, res);
    return;
  }

  // D3 提交转写任务
  if (pathname === '/api/transcribe') {
    if (req.method !== 'POST') {
      sendJson(req, res, 400, { error: '请使用 POST 调用 /api/transcribe' });
      return;
    }
    handleTranscribeSubmit(req, res);
    return;
  }

  // D3 查询（GET）/ 取消（DELETE）某个任务
  const taskMatch = pathname.match(/^\/api\/transcribe\/([\w-]+)$/);
  if (taskMatch) {
    const id = taskMatch[1];
    if (req.method === 'DELETE') {
      handleTranscribeCancel(req, res, id);
      return;
    }
    const t = transcriber.get(id);
    if (!t) {
      sendJson(req, res, 404, { error: '任务不存在' });
      return;
    }
    sendJson(req, res, 200, t);
    return;
  }

  // D3 转写产物清单
  if (pathname === '/api/transcripts') {
    handleTranscriptList(req, res);
    return;
  }

  // D3-b 重跑纠错：改完词表不用重新转写（转写是最贵的一步，纠错是免费的）
  if (pathname === '/api/correct') {
    if (req.method !== 'POST') {
      sendJson(req, res, 400, { error: '请使用 POST 调用 /api/correct' });
      return;
    }
    (async () => {
      let payload;
      try {
        payload = await readJson(req);
      } catch {
        sendJson(req, res, 400, { error: '请求体不是合法 JSON' });
        return;
      }
      const hash = typeof payload.hash === 'string' ? payload.hash : '';
      if (!/^[0-9a-f]{12}$/.test(hash)) {
        sendJson(req, res, 400, { error: 'hash 不合法' });
        return;
      }
      try {
        const { correctTranscriptFile } = await import('./correct.mjs');
        const r = correctTranscriptFile(hash, { transcriptDir: TRANSCRIPT_DIR });
        console.log(`纠错 ${hash}：修了 ${r.changed} 处`, r.summary);
        sendJson(req, res, 200, r);
      } catch (err) {
        console.error('纠错失败：', err.message);
        sendJson(req, res, 500, { error: '纠错失败：' + err.message });
      }
    })();
    return;
  }

  // D3 最近任务（内存态：服务重启即空 —— 有意设计，产物才是持久的）
  if (pathname === '/api/tasks') {
    sendJson(req, res, 200, { items: transcriber.list() });
    return;
  }

  // 其它路径：静态文件（GET / HEAD）
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }

  sendJson(req, res, 400, { error: '不支持的请求' });
});

const PORT = config.port;

// 绑 0.0.0.0 = 监听所有网卡：将来上云容器才能被平台探到端口；本地跑时外网仍进不来
server.listen(PORT, '0.0.0.0', () => {
  console.log(`听藏后端已启动：http://localhost:${PORT}`);
  console.log(`音频目录：${AUDIO_DIR}`);
  console.log(`转写产物：${TRANSCRIPT_DIR}`);
  logConfig();
  console.log('上传 POST /api/audio ｜ 转写 POST /api/transcribe（异步任务）｜ 清单 GET /api/audios');
});
