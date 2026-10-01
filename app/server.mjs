// 听藏 voice-vault · D2：音频输入服务
// 零依赖 Node http 服务 = 静态页托管 + 音频上传
// 形态沿用「链藏」app/server.mjs：单文件、不装任何 npm 包、注释即说明文档
//
// 上传方案（D2 技术决策，见 docs/08）：
//   用「raw body + 文件名放请求头」而不是 multipart ——
//   音频是单个二进制大文件，请求体本身就是文件，服务端收到啥存啥，无需拆箱解析。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 静态文件根目录 = 本脚本所在目录（app/），打开 / 就找这里的 index.html
const staticRoot = fileURLToPath(new URL('./', import.meta.url));
// 仓库根目录 = 上一级（.env / data 都在这一层）
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
// 音频落盘目录：data/audio/
const AUDIO_DIR = path.join(repoRoot, 'data', 'audio');
// 上传清单（D5 历史档案的雏形：hash → 原文件名 / 大小 / 时间）
const INDEX_PATH = path.join(repoRoot, 'data', 'audio-index.json');

// 单次上传体积上限：1 小时 m4a 约 30–60MB，这里给到 300MB 留足余量
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

// 允许的音频后缀白名单 —— 不带白名单就等于允许往磁盘写任意文件
const ALLOWED_EXT = new Set(['.m4a', '.mp3', '.wav', '.webm', '.ogg', '.opus', '.aac', '.mp4', '.flac']);

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

// 常见静态文件后缀 → Content-Type，浏览器靠它决定怎么渲染
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

// 把请求体读成 Buffer（⚠️ 必须用 Buffer，不能用 utf8 字符串 —— 音频是二进制，转字符串就毁了）
function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // 超限立即中断：不要边收边涨内存，等收完再判断
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

// 托管 app/ 下的静态文件
function serveStatic(req, res) {
  // 🚨 畸形百分号编码（如直接访问 /%）会让 decodeURIComponent 抛错，
  // 而它在 createServer 回调里是「同步」执行的 → 异常冒泡 → 整个进程退出。
  // 必须兜住，回 400，而不是让一个乱敲的地址把服务搞崩。
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

// 从原文件名 / Content-Type 推断后缀，拿不到就回退 .bin（后续 D3 转写会如实报错）
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

// ========== POST /api/audio：把音频存下来 ==========
// 请求：raw body = 音频二进制；文件名二选一 —— 请求头 X-Filename，或 ?filename= 查询参数
async function handleUpload(req, res) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  const rawName = query.get('filename') || req.headers['x-filename'] || '';
  // 请求头里的中文是百分号编码的，解不开就用原文（文件名只用于展示，不影响落盘）
  let filename = String(rawName);
  try {
    if (filename && /%[0-9a-f]{2}/i.test(filename)) filename = decodeURIComponent(filename);
  } catch {
    /* 解不开就保持原样 */
  }
  filename = filename.trim() || 'audio';

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
    const item = {
      hash,
      ext,
      filename,
      bytes: buf.length,
      uploadedAt: new Date().toISOString(),
    };
    const others = index.items.filter((it) => it.hash !== hash);
    index.items = [item, ...others];
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

// ========== GET /api/audios：已收到的音频清单（验收用） ==========
function handleList(req, res) {
  const index = loadIndex();
  // 顺带核对磁盘：清单里有、但文件不见了的，标记出来（不假装成功）
  const items = index.items.map((it) => {
    const p = path.join(AUDIO_DIR, it.hash + it.ext);
    return { ...it, onDisk: fs.existsSync(p) };
  });
  sendJson(req, res, 200, { count: items.length, items });
}

// 创建 HTTP 服务器：按方法和路径分流
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

  // 其它路径：静态文件（GET / HEAD）
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }

  sendJson(req, res, 400, { error: '不支持的请求' });
});

const PORT = Number(process.env.PORT) || 3000;

// 绑 0.0.0.0 = 监听所有网卡：将来上云容器才能被平台探到端口；本地跑时外网仍进不来
server.listen(PORT, '0.0.0.0', () => {
  console.log(`听藏后端已启动：http://localhost:${PORT}`);
  console.log(`音频落盘目录：${AUDIO_DIR}`);
  console.log('上传接口：POST /api/audio（raw body + X-Filename 头）｜清单：GET /api/audios');
});
