// 听藏 · 纠错层（确定性规则：零模型、零成本、完全可审计）
//
// 设计原则（全部来自 D1 真实语料实测，不是拍脑袋）：
//   1. 错字是「系统性高频重复」的 —— 一条规则能修几十处（实测"技术→绩效" 31 次），杠杆率极高
//   2. 但同一个词「有时对有时错」（"薪资"有时写对、"华中"有时写对）
//      ⇒ 绝不能无脑全局替换，会误伤
//   3. 所以分两类规则：
//        exact       —— 原词本身不成词（"计效""新测"），替换零风险
//        contextual  —— 原词可能是真词（"技术""适用期"），必须邻近出现证据词才替换
//   4. 原文永不覆盖：产物里同时保留 raw / corrected / corrections（改了哪、依据哪条）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES_PATH = fileURLToPath(new URL('./corrections.json', import.meta.url));

let cachedRules = null;
let cachedMtime = 0;

// 读词表（带 mtime 缓存：改了词表自动重新读，不用重启服务）
export function loadRules(rulesPath = RULES_PATH) {
  const mtime = fs.statSync(rulesPath).mtimeMs;
  if (cachedRules && mtime === cachedMtime) return cachedRules;
  cachedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  cachedMtime = mtime;
  return cachedRules;
}

// 对一段文本做纠错，返回 { corrected, corrections, summary, changed }
export function correctText(text, rules) {
  const src = String(text ?? '');
  const edits = [];

  // ① 精确替换：原词不成词，见到就改
  for (const r of rules.exact ?? []) {
    let idx = 0;
    while ((idx = src.indexOf(r.wrong, idx)) !== -1) {
      edits.push({
        start: idx, end: idx + r.wrong.length,
        from: r.wrong, to: r.right, rule: 'exact', why: r.why || '',
      });
      idx += r.wrong.length;
    }
  }

  // ② 上下文替换：只有邻近窗口里出现「证据词」才改
  for (const r of rules.contextual ?? []) {
    const w = r.window ?? 12;
    let idx = 0;
    while ((idx = src.indexOf(r.wrong, idx)) !== -1) {
      const ctx = src.slice(Math.max(0, idx - w), idx + r.wrong.length + w);
      const hit = (r.near ?? []).filter((n) => ctx.includes(n));
      if (hit.length) {
        edits.push({
          start: idx, end: idx + r.wrong.length,
          from: r.wrong, to: r.right, rule: 'contextual',
          evidence: hit, why: r.why || '',
        });
      }
      idx += r.wrong.length;
    }
  }

  // ③ 从后往前应用：位置始终基于原文，不会互相错位
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  const applied = [];
  let boundary = Infinity; // 已被替换覆盖的最左位置
  for (const e of edits) {
    // 重叠 ⇒ 跳过。宁可不改，也不改错（一个字符只允许被一条规则命中）
    if (e.end > boundary) continue;
    out = out.slice(0, e.start) + e.to + out.slice(e.end);
    applied.push(e);
    boundary = e.start;
  }
  applied.reverse();

  // 汇总：改了哪几类、各多少处（可审计、可展示）
  const summary = {};
  for (const e of applied) {
    const key = `${e.from} → ${e.to}`;
    summary[key] = (summary[key] || 0) + 1;
  }

  return { corrected: out, corrections: applied, summary, changed: applied.length };
}

// 对一份转写产物做纠错并写回文件
// 逐段纠错为准（段内上下文），全文由纠错后的段拼接 —— 保证「全文 = 段之和」不会自相矛盾
export function correctTranscriptFile(hash, { transcriptDir, rules } = {}) {
  const file = path.join(transcriptDir, hash + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const useRules = rules ?? loadRules();

  const segments = (data.segments ?? []).map((s) => {
    // 被静音闸门判定为幻觉的段：不纠错、也不进 corrected
    // —— 纠错对"本来就编造出来的句子"没有意义
    if (s?.gate?.drop) {
      const out = { ...s };
      delete out.raw;
      delete out.corrections;
      return out;
    }
    // 幂等：若这段之前纠错过，从 raw（原始转写）重新来 ——
    // 否则重复纠错会把 raw 覆盖成「已纠错文本」，原文就再也找不回来了。
    // 「原文永不覆盖」是这一层的底线：纠错可以被推翻，转写事实不行。
    const src = typeof s.raw === 'string' ? s.raw : s.text;
    const c = correctText(src, useRules);
    const out = { ...s, text: c.corrected };
    if (c.changed) {
      out.raw = src;
      out.corrections = c.corrections;
    } else {
      delete out.raw;
      delete out.corrections;
    }
    return out;
  });

  let changed = 0;
  const summary = {};
  for (const s of segments) {
    for (const c of s.corrections ?? []) {
      changed += 1;
      const key = `${c.from} → ${c.to}`;
      summary[key] = (summary[key] || 0) + 1;
    }
  }

  data.segments = segments;
  data.corrected = segments.filter((s) => !s?.gate?.drop).map((s) => s.text).join('');
  data.correctionSummary = summary;
  data.correctionChanged = changed;
  // 计数也只算"留下的"段 —— 否则统计口径和 corrected 正文对不上
  data.correctedSegmentCount = segments.filter((s) => s.raw && !s?.gate?.drop).length;
  data.correctedAt = new Date().toISOString();
  data.rulesVersion = useRules.version;

  fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
  return { hash, changed, summary, correctedSegmentCount: data.correctedSegmentCount };
}
