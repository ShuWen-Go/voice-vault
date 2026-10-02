// 听藏 · 配置层
// 为什么要有这一层：本地一套路径、云端另一套（模型在哪、Python 在哪全都不同）。
// 把路径写死在代码里 = 换台机器就废 —— 这正是「本地过 ≠ 云端过」的根源。
// 所以：所有可变路径一律从 .env（或系统环境变量）读，代码里只留默认值。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 仓库根目录（本文件在 app/ 下）
export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// 极简 .env 解析：KEY=VALUE，跳过空行与 # 注释，去掉成对的引号
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    out[key] = value;
  }
  return out;
}

// 读仓库根的 .env（没有就当空对象，允许完全用系统环境变量驱动）
let fileEnv = {};
try {
  fileEnv = parseEnv(readFileSync(path.join(repoRoot, '.env'), 'utf8'));
} catch {
  fileEnv = {};
}

// 取值优先级：系统环境变量 > .env > 默认值
function pick(key, fallback) {
  return process.env[key] ?? fileEnv[key] ?? fallback;
}

export const config = {
  // 跑 ASR 的 Python 解释器；留空则用 PATH 里的 python
  pythonPath: pick('VV_PYTHON', ''),
  // 模型根目录：下面按档位分 small/ medium/ 子目录
  modelDir: pick('VV_MODEL_DIR', ''),
  // 默认档位
  defaultQuality: pick('VV_DEFAULT_QUALITY', 'medium'),
  // 语言：zh 或 auto
  language: pick('VV_LANGUAGE', 'zh'),
  // 转写并发上限（本地 CPU，>1 会互相抢核心）
  maxConcurrency: Math.max(1, Number(pick('VV_MAX_CONCURRENCY', '1')) || 1),
  // 服务端口
  port: Number(pick('PORT', '3000')) || 3000,
  // 数据目录
  dataDir: path.join(repoRoot, 'data'),
};

// 启动时把关键配置打出来 —— 路径配错时，看启动日志比看报错快
export function logConfig() {
  console.log('[config] python   =', config.pythonPath || '(PATH 里的 python)');
  console.log('[config] modelDir =', config.modelDir || '(未配置，将从 HuggingFace 拉取)');
  console.log('[config] quality  =', config.defaultQuality, '| language =', config.language,
              '| 并发上限 =', config.maxConcurrency);
}
