// 听藏 · 静音段幻觉闸门（确定性规则：零模型、零成本、完全可审计）
//
// 为什么需要它（实测发现，不是假设）：
//   8 通道真实会议语料里有一段约 1 分半的低电平环境噪声（无人说话）。
//   Whisper 的 VAD 把这段当成了人声，模型于是「凭空造句」——
//   而且造出来的正是我自己写进 initial_prompt 的那句引导语，还重复了两遍。
//   对会议纪要产品来说，这是最坏的一类错误：**编造的内容看起来跟真的一模一样**。
//
// 判据设计（全部确定性，四层从零风险到低风险）：
//   ① prompt_echo  文本落在提示词/指令句式里      —— 零风险（模型背题）
//   ② boilerplate  命中字幕/视频结尾套话，且很短   —— 低风险（套话不会出现在会议里）
//   ③ silence      能量极低 **且** 语音概率极低    —— 双条件，避免误伤轻声说话
//   ④ repeat       与上一段完全相同且很短          —— 零风险（幻觉常连续重复）
//
// 与纠错层同一条纪律：
//   · 不覆盖原文 —— 只给段落打标记（gate: {drop, reason}），原文照留
//   · 可重跑     —— 转写是最贵的一步，闸门改了可以单独重跑（POST /api/gate）
//   · 可审计     —— 丢了哪几段、依据什么理由，全部记在产物里

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES_PATH = fileURLToPath(new URL('./gate-rules.json', import.meta.url));

let cachedRules = null;
let cachedMtime = 0;

export function loadGateRules(rulesPath = RULES_PATH) {
  const mtime = fs.statSync(rulesPath).mtimeMs;
  if (cachedRules && mtime === cachedMtime) return cachedRules;
  cachedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  cachedMtime = mtime;
  return cachedRules;
}

// 归一化：只留中日韩汉字与字母数字，去掉标点空格、统一小写
export function normText(s) {
  return String(s ?? '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').toLowerCase();
}

const REASON_LABEL = {
  prompt_echo: '提示词回声',
  boilerplate: '字幕套话',
  silence: '静音段',
  repeat: '连续重复',
};

/**
 * 判断单段是否应当丢弃。
 * @returns {{drop: true, reason: string, detail?: string} | null}
 */
export function judgeSegment(seg, { rules, rmsP50, prevNorm = '' } = {}) {
  const text = String(seg?.text ?? '').trim();
  if (!text) return { drop: true, reason: 'empty' };
  const n = normText(text);
  const shortMax = rules.shortMaxChars ?? 15;

  // ① 提示词回声：模型把 initial_prompt 原样吐出来（实测形态）
  for (const echo of rules.promptEchoes ?? []) {
    const en = normText(echo);
    if (n.length >= 4 && en && (en.includes(n) || n.includes(en))) {
      return { drop: true, reason: 'prompt_echo', detail: `命中引导语「${echo}」` };
    }
  }

  // ② 字幕/视频套话（只在短句上判，避免误伤正常发言里出现的同形词）
  if ([...text].length <= shortMax) {
    for (const b of rules.boilerplate ?? []) {
      if (text.includes(b)) return { drop: true, reason: 'boilerplate', detail: `命中套话「${b}」` };
    }
  }

  // ③ 静音段：两个条件同时成立才丢（能量低 + 语音概率低）
  const e = rules.energy ?? {};
  if (e.enabled && rmsP50 && typeof seg.rms === 'number' && typeof seg.noSpeech === 'number') {
    const quiet = seg.rms < (e.rmsRatio ?? 0.5) * rmsP50;
    const unsure = seg.noSpeech > (e.minNoSpeech ?? 0.6);
    if (quiet && unsure) {
      return {
        drop: true,
        reason: 'silence',
        detail: `能量 ${seg.rms} < ${Math.round((e.rmsRatio ?? 0.5) * rmsP50)}（0.5×p50）且语音概率 ${seg.noSpeech} > ${e.minNoSpeech}`,
      };
    }
  }

  // ④ 连续重复：同一句紧挨着说两遍（幻觉的典型形态）
  // ⚠️ 默认关闭 —— 真实口语里本来就会重复（实测误伤 2/2），详见 gate-rules.json
  const rep = rules.repeat ?? {};
  if (rep.enabled && n && n.length <= (rep.maxChars ?? 20) && n === prevNorm) {
    return { drop: true, reason: 'repeat', detail: '与上一段完全相同' };
  }

  return null;
}

/**
 * 对一份转写产物执行闸门。
 * 只打标记，不改文本；返回汇总，供接口/前端展示。
 */
export function gateTranscript(data, rules) {
  const r = rules ?? loadGateRules();
  const segments = data.segments ?? [];
  const rmsP50 = data.rmsP50 ?? null;
  const dropped = [];
  const reasons = {};
  let prevNorm = '';

  for (const s of segments) {
    // 幂等：每次从「未经闸门」的状态重新判（闸门规则改了可重跑）
    delete s.gate;
    const verdict = judgeSegment(s, { rules: r, rmsP50, prevNorm });
    if (verdict?.drop) {
      s.gate = verdict;
      dropped.push({
        start: s.start,
        end: s.end,
        text: s.text,
        reason: verdict.reason,
        label: REASON_LABEL[verdict.reason] ?? verdict.reason,
        detail: verdict.detail ?? null,
      });
      reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
      // 丢弃段不参与「连续重复」的比对链（否则会把正常发言也带下去）
      prevNorm = '';
    } else {
      prevNorm = normText(s.text);
    }
  }

  data.gate = {
    version: r.version,
    droppedCount: dropped.length,
    reasons,
    dropped: dropped.slice(0, 200),
    gatedAt: new Date().toISOString(),
  };
  data.gatedText = segments.filter((s) => !s.gate?.drop).map((s) => s.text).join('');
  return {
    hash: null,
    dropped: dropped.length,
    total: segments.length,
    reasons,
    list: dropped.slice(0, 20),
  };
}

/** 对磁盘上的转写产物执行闸门并写回（与纠错层同样式：单一写入口） */
export function gateTranscriptFile(hash, { transcriptDir, rules } = {}) {
  const file = path.join(transcriptDir, hash + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = gateTranscript(data, rules ?? loadGateRules());
  fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
  return { hash, ...r };
}

/** 供下游（结构化/导出/前端）使用：只取未被闸门丢弃的段 */
export function keptSegments(segments) {
  return (segments ?? []).filter((s) => !s?.gate?.drop);
}
