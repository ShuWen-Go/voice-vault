// 听藏 · 转写编排层
// 职责：把「跑一次本地 Whisper」包装成可查询、可取消、有并发上限的异步任务。
//
// 为什么编排放 Node 而不是 Python：
//   业务逻辑（排队 / 状态 / 幂等 / 取消）只留在一种语言里；
//   Python 只当"推理工人" —— 它崩了只影响这一个任务，服务照常。
//
// 协议：Python 每产出一段就往 stdout 打一行 JSON（stage / progress / done / error），
//       这里逐行解析 → 变成任务状态。人类日志走 stderr，不参与协议。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
// D3-b：转写一结束就自动跑一遍确定性纠错（"计效→绩效"这类系统性错字）
import { correctTranscriptFile } from './correct.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./asr/transcribe.py', import.meta.url));
const TRANSCRIPT_DIR = path.join(config.dataDir, 'transcripts');

// 对外的任务视图：child 这类进程句柄绝不能外泄
function publicTask(t) {
  const { child, ...rest } = t;
  return rest;
}

export function createTranscriber() {
  const tasks = new Map(); // id -> task
  const queue = [];        // 排队中的任务 id
  let seq = 0;

  const newId = () => 't' + Date.now().toString(36) + '-' + (++seq);

  // 转写产物路径：以音频内容哈希命名 ⇒ 同一份音频天然只对应一份转写
  const transcriptPath = (hash) => path.join(TRANSCRIPT_DIR, hash + '.json');

  function readCached(hash) {
    try {
      return JSON.parse(fs.readFileSync(transcriptPath(hash), 'utf8'));
    } catch {
      return null;
    }
  }

  function runningCount() {
    let n = 0;
    for (const t of tasks.values()) if (t.status === 'running') n += 1;
    return n;
  }

  // 任务表只增不减会一直长肉 —— 腾手清掉老的「已结束」任务（保留最近 MAX_TASKS 条）
  const MAX_TASKS = 200;
  function gc() {
    if (tasks.size <= MAX_TASKS) return;
    for (const [id, t] of tasks) {
      if (tasks.size <= MAX_TASKS) break;
      if (t.status === 'running' || t.status === 'queued' || t.child) continue;
      tasks.delete(id);
    }
  }

  // 调度：有空位就从队列里放一个出来跑
  function pump() {
    while (queue.length && runningCount() < config.maxConcurrency) {
      const id = queue.shift();
      const t = tasks.get(id);
      if (t && t.status === 'queued') start(t);
    }
    gc();
  }

  // 把 Python 打上来的事件合并进任务状态
  function applyEvent(t, ev) {
    if (ev.type === 'stage') {
      t.stage = ev.stage;
      if (ev.model) t.model = ev.model;
      if (ev.loadSeconds != null) t.loadSeconds = ev.loadSeconds;
    } else if (ev.type === 'progress') {
      t.percent = ev.percent;
      t.doneSeconds = ev.doneSeconds;
      t.totalSeconds = ev.totalSeconds;
      t.segments = ev.segments;
    } else if (ev.type === 'done') {
      t.status = 'done';
      t.percent = 100;
      t.segments = ev.segments;
      t.elapsedSeconds = ev.elapsedSeconds;
      t.rtf = ev.rtf;
      t.language = ev.language;
      // D3-b：转写完成后立刻做确定性纠错。
      // 为什么搭在这里而不是独立一步：纠错是纯字符串处理（毫秒级），转写是最贵的一步（分钟级）——
      // 让纠错搭转写的顺风车，用户不用多等一次。词表改了可以用 POST /api/correct 单独重跑。
      // 纠错失败只记日志，绝不推翻「转写已成功」这个事实。
      try {
        const c = correctTranscriptFile(t.hash, { transcriptDir: TRANSCRIPT_DIR });
        t.correction = { changed: c.changed, summary: c.summary };
        console.log(`纠错 ${t.hash}：修了 ${c.changed} 处`, c.summary);
      } catch (err) {
        console.error('[correct] 纠错失败（转写结果本身仍然有效）：', err.message);
        t.correction = { error: err.message };
      }
      t.result = readCached(t.hash); // 产物已落盘，直接读回来（只有一份真源）
    } else if (ev.type === 'error') {
      t.status = 'failed';
      t.error = ev.message;
    }
  }

  function start(t) {
    t.status = 'running';
    t.startedAt = new Date().toISOString();
    const outPath = transcriptPath(t.hash);
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

    const python = config.pythonPath || 'python';
    // -u = 关闭 Python 输出缓冲：不加这个，进度会被攒着，等于没有进度
    const args = [
      '-u', SCRIPT_PATH,
      '--audio', t.audioPath,
      '--out', outPath,
      '--quality', t.quality,
      '--language', config.language,
    ];
    if (config.modelDir) args.push('--model-dir', config.modelDir);

    const child = spawn(python, args, {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        // 模型已在本地 ⇒ 不让它再去联网找模型（也能避免网络卡住）
        HF_HUB_OFFLINE: '1',
      },
      windowsHide: true,
    });
    t.child = child;

    // stdout：按行拆 JSON（一次 data 事件可能是半行，也可能是好几行）
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          applyEvent(t, JSON.parse(line));
        } catch {
          // 不是 JSON 的行直接忽略（Python 那边不该有，但别为此炸掉）
        }
      }
    });

    // stderr：Python 的人类日志，只落到服务端终端
    child.stderr.on('data', (chunk) => {
      process.stderr.write('[asr:' + t.hash + '] ' + chunk.toString('utf8'));
    });

    child.on('error', (err) => {
      t.status = 'failed';
      t.error = '无法启动 Python：' + err.message + '（检查 .env 里的 VV_PYTHON）';
      t.finishedAt = new Date().toISOString();
      t.child = null;
      pump();
    });

    child.on('close', (code) => {
      t.child = null;
      t.finishedAt = t.finishedAt || new Date().toISOString();
      if (t.status === 'canceled') {
        // 用户取消：状态已定，不动
      } else if (code === 0) {
        // 正常退出却没收到 done 事件 → 读产物兜底（不假装失败，也不假装成功）
        if (t.status !== 'done') {
          const r = readCached(t.hash);
          if (r) {
            t.status = 'done';
            t.percent = 100;
            t.result = r;
            t.segments = r.segmentCount;
          } else {
            t.status = 'failed';
            t.error = '转写进程已结束，但没有找到产物文件';
          }
        }
      } else if (t.status !== 'failed') {
        t.status = 'failed';
        t.error = t.error || ('转写进程异常退出（退出码 ' + code + '）');
      }
      pump();
    });
  }

  // ========== 对外接口 ==========

  // 提交任务：已有产物直接读档（幂等 —— 转写是全链路最贵的一步，绝不能重复花）
  function submit({ audioPath, hash, quality, force = false }) {
    const q = quality || config.defaultQuality;

    if (!force) {
      const cached = readCached(hash);
      if (cached) {
        const t = {
          id: newId(), hash, quality: cached.quality || q,
          status: 'done', fromCache: true, percent: 100,
          segments: cached.segmentCount,
          doneSeconds: cached.durationSeconds,
          totalSeconds: cached.durationSeconds,
          elapsedSeconds: cached.elapsedSeconds,
          rtf: cached.rtf,
          result: cached, error: null,
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        tasks.set(t.id, t);
        return publicTask(t);
      }
    }

    const t = {
      id: newId(), hash, quality: q, audioPath,
      status: 'queued', fromCache: false,
      stage: 'queued', percent: 0, segments: 0,
      doneSeconds: 0, totalSeconds: 0,
      result: null, error: null, child: null,
      createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null,
    };
    tasks.set(t.id, t);
    queue.push(t.id);
    pump();
    return publicTask(t);
  }

  function get(id) {
    const t = tasks.get(id);
    return t ? publicTask(t) : null;
  }

  function cancel(id) {
    const t = tasks.get(id);
    if (!t) return null;
    if (t.status === 'queued') {
      const i = queue.indexOf(id);
      if (i >= 0) queue.splice(i, 1);
      t.status = 'canceled';
      t.finishedAt = new Date().toISOString();
    } else if (t.status === 'running' && t.child) {
      t.status = 'canceled';
      t.child.kill();
    }
    return publicTask(t);
  }

  // 最近的任务（倒序），够前端展示即可
  function list(limit = 20) {
    return [...tasks.values()].slice(-limit).reverse().map(publicTask);
  }

  return { submit, get, cancel, list, transcriptPath, readCached };
}
