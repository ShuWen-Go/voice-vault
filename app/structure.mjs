// app/structure.mjs —— 结构化层：转写文本 → 强约束 prompt → DeepSeek → 纪要 JSON + 实体核验
//
// 复用链藏 structure.mjs 的经验（W2-D4 定论 + D5 两条防线），但**防线对象换了**：
//   链藏防的是「金句有没有逐字照录」——那是"摘录"任务，可以逐字核验；
//   纪要是「归纳」任务，不能逐字核验 ⇒ 改成核验**实体**：
//     · at（时间戳）必须来自输入里真实出现过的时间
//     · owner / numbers 必须在原文里出现
//     · 归纳类内容无法核验 ⇒ 不装确定，交给前端标注「AI 归纳」
//
// 「能核的核，不能核的明说」—— 这是本层最重要的一条设计。

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';

// ⚠️ 模板正文必须顶格写（行首空白会原样进 prompt），且不得含反引号 / ${
export const SYSTEM_PROMPT = `【角色】
你是会议纪要整理器。从用户给出的会议转写文本里整理出结构化纪要，只输出一个 JSON 对象。

【只输出 JSON】
- 不要任何开场白、说明文字或结尾总结
- 不要用小标题、加粗、列表符号等 markdown 排版
- 不要用代码块标记把 JSON 包起来
- 输出的第一个字符必须是 {，最后一个字符必须是 }

【输入格式】
每行形如 [mm:ss] 文本，表示这句话出现在录音的第几分几秒。

【字段规范】必须包含且只包含这 9 个字段：
- meetingType：字符串。从这五个里选一个：信息传递 / 讨论决策 / 汇报 / 任务分派 / 访谈。
  判据：一方单向讲、另一方主要听 = 信息传递；双方对方案来回取舍 = 讨论决策；
        一方汇报进展与问题 = 汇报；明确谁做什么、什么时候做 = 任务分派；一问一答式交流 = 访谈。
- title：字符串。会议主题，8 到 20 字。
- summary：字符串。3 句以内概括这次沟通的核心内容。
- keyPoints：数组，3 到 10 条。每条形如 {"topic":"主题","detail":"要点内容","at":"mm:ss"}。
- numbers：数组。每条形如 {"value":"18K","meaning":"它代表什么","at":"mm:ss"}。只收明确出现的数字、金额、比例、期限、日期。
- decisions：数组。每条形如 {"what":"决定了什么","at":"mm:ss"}。
- todos：数组。每条形如 {"what":"要做什么","owner":"谁负责","due":"什么时候完成","at":"mm:ss"}。owner 和 due 原文没说就给 null。
- openQuestions：数组。每条形如 {"what":"还没定的问题","at":"mm:ss"}。
- risks：数组。每条形如 {"what":"风险或障碍","at":"mm:ss"}。

【时间戳规则】
- at 的值必须来自输入里真实出现过的 [mm:ss]，不要自己编造时间
- 实在找不到对应位置就写 null

【占位规则】最重要，违反即视为错误
- 原文没说的信息，一律给空数组或 null，绝对不要根据常识补充
- 不要因为"会议通常会有待办"就编一条待办出来
- numbers 里不要出现原文没有的数字
- 宁可整段留空，也不要编造

【书写要求】
- 键名和字符串值都用半角双引号
- 字符串内部不要换行
- 字符串内部【不要出现半角双引号】：需要引用原话时用中文引号「」或直接不加引号
  （半角引号会破坏 JSON 结构，这是最常见的输出格式错误）`;

// 秒 → mm:ss（超过 60 分钟就继续累加分钟，保证与输入完全一致）
export function fmtTs(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// mm:ss → 秒（认不出来返回 null）
export function parseTs(at) {
  if (typeof at !== 'string') return null;
  const m = at.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 把纠错后的段拼成「带时间戳的文本」——时间戳是 LLM 给出 at 的唯一合法来源
export function buildTimestampedText(segments) {
  return (segments ?? [])
    .map((s) => `[${fmtTs(s.start)}] ${s.text}`)
    .join('\n');
}

// 结构层判据（剥代码围栏 + JSON.parse）
export function checkJson(raw) {
  let t = String(raw).trim();
  const fenced = /^```/.test(t);
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return { ok: true, value: JSON.parse(t), fenced };
  } catch (err) {
    return { ok: false, message: err.message, fenced };
  }
}

// 字段层判据：必填字段齐全、类型正确
const ARRAY_FIELDS = ['keyPoints', 'numbers', 'decisions', 'todos', 'openQuestions', 'risks'];
const MEETING_TYPES = ['信息传递', '讨论决策', '汇报', '任务分派', '访谈'];

export function checkNote(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return '不是 JSON 对象';
  if (typeof note.meetingType !== 'string') return 'meetingType 缺失或不是字符串';
  if (!MEETING_TYPES.includes(note.meetingType)) return `meetingType 不在允许取值内：${note.meetingType}`;
  if (typeof note.title !== 'string') return 'title 缺失或不是字符串';
  if (typeof note.summary !== 'string') return 'summary 缺失或不是字符串';
  for (const key of ARRAY_FIELDS) {
    if (!Array.isArray(note[key])) return key + ' 缺失或不是数组';
    if (note[key].length > 30) return key + ' 条目过多（>30）';
  }
  return null;
}

// ===== 数字归一化（只用于核验，绝不修改原文） =====
// 为什么必须做：模型会把口语里的「三个月 / 百分之七十五 / 两百块钱」标准化成「3个月 / 75% / 200元」——
// 若直接整串子串比对，这些**完全正确**的标准化表达会被误判成「编造」。
// 核验器自己误报，等于废掉整条防线（第一次实测 21 个数字里误报 9 个）。
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

// 汉字数字 → 阿拉伯（覆盖 十五 / 七十五 / 五百 / 两千 / 一万 这类常见写法）
function cn2num(str) {
  let result = 0, section = 0, number = 0, seen = false;
  for (const ch of str) {
    if (CN_DIGIT[ch] !== undefined) { number = CN_DIGIT[ch]; seen = true; }
    else if (CN_UNIT[ch] !== undefined) {
      seen = true;
      const unit = CN_UNIT[ch];
      if (unit === 10000) { section = (section + number) * unit; result += section; section = 0; }
      else section += (number || 1) * unit;
      number = 0;
    } else return null;
  }
  return seen ? result + section + number : null;
}

// 归一化：全角→半角、百分之X→X%、汉字数字→阿拉伯、去标点与「左右」这类软修饰
function normBasic(s) {
  let t = String(s ?? '');
  t = t.replace(/[０-９Ａ-Ｚａ-ｚ％（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/％/g, '%');
  t = t.replace(/百分之([零〇一二两三四五六七八九十百千万]+)/g, (m, g) => {
    const n = cn2num(g);
    return n === null ? m : n + '%';
  });
  t = t.replace(/[零〇一二两三四五六七八九十百千万]+/g, (m) => {
    const n = cn2num(m);
    return n === null ? m : String(n);
  });
  return t.replace(/[\s，,、。.？?！!：:；;“”"'（）()]/g, '').replace(/左右|大约|约/g, '');
}

// 抽出表达式里的数字 token：'3个月' → ['3']｜'0.3到1.3' → ['0.3','1.3']｜'20%（五分之一）' → ['20','5']
function numberTokens(s) {
  return [...normBasic(s).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

// 内容层判据（本项目的版本）：核验「实体」而不是「金句」
// 能核的：时间戳是否真在输入里 / owner 与 numbers 是否在原文出现
// 核不了的：归纳内容本身 —— 如实标记 unverifiable，不在后端假装确定
export function verifyEntities(note, { segments = [], text = '', duration = 0 } = {}) {
  const srcFlat = String(text || '').replace(/\s/g, '');
  const srcNorm = normBasic(text);
  const starts = (segments ?? []).map((s) => Math.floor(Number(s.start) || 0));

  // ① 时间戳：必须落在输入时间轴上（±2 秒容差，吸收取整误差）
  const atRows = [];
  for (const field of ARRAY_FIELDS) {
    for (const item of note[field] ?? []) {
      const at = item && item.at != null ? item.at : null;
      let ok = null;
      if (at !== null) {
        const sec = parseTs(at);
        if (sec === null) ok = false;
        else if (duration && sec > duration + 2) ok = false;
        else ok = starts.some((x) => Math.abs(x - sec) <= 2);
      }
      atRows.push({ field, at, ok });
    }
  }

  // ② owner：原文里必须能找到（找不到 ⇒ 模型给的是角色推断，不是原文人名）
  const owners = (note.todos ?? []).map((t) => {
    const owner = t && t.owner ? String(t.owner) : null;
    return {
      owner,
      // null = 原文本来就没提负责人（合规）；true/false = 给了，核验结果
      verified: owner ? srcFlat.includes(owner.replace(/\s/g, '')) : null,
    };
  });

  // ③ numbers：比对「数字成分」而不是整串 —— 见文件上方 normBasic 的说明
  const numbers = (note.numbers ?? []).map((n) => {
    const value = n && n.value != null ? String(n.value) : null;
    if (!value) return { value, verified: null, tokens: [] };
    const tokens = numberTokens(value);
    if (!tokens.length) return { value, verified: null, tokens: [] }; // 没有数字成分 → 不判定
    const hit = tokens.filter((tk) => srcNorm.includes(tk));
    return {
      value,
      tokens,
      hit,
      // true 全中 ｜ 'partial' 部分中（可能是表达差异）｜ false 全不中（高度可疑）
      verified: hit.length === tokens.length ? true : (hit.length === 0 ? false : 'partial'),
    };
  });

  const badAt = atRows.filter((r) => r.ok === false).length;
  const inferredOwners = owners.filter((o) => o.verified === false).length;
  const inventedNumbers = numbers.filter((n) => n.verified === false).length;
  const partialNumbers = numbers.filter((n) => n.verified === 'partial').length;

  return {
    at: atRows,
    owners,
    numbers,
    summary: { total: atRows.length, badAt, inferredOwners, inventedNumbers, partialNumbers },
    // 归纳类内容（summary / keyPoints.detail / decisions.what …）无法逐字核验
    unverifiable: ['summary', 'keyPoints', 'decisions', 'openQuestions', 'risks'],
  };
}

/**
 * 一次会议转写 → 结构化纪要
 * @param {{hash, segments, text, duration, quality}} input segments 用纠错后的段
 * @param {{apiKey: string, maxTokens?: number}} opts
 */
export async function structureMeeting(input, { apiKey, maxTokens = 8000 } = {}) {
  if (!apiKey) throw new Error('未提供 DeepSeek apiKey');

  const body = buildTimestampedText(input.segments);
  const minutes = (Number(input.duration || 0) / 60).toFixed(1);

  const userPrompt = `会议音频时长：${minutes} 分钟
转写模型档位：${input.quality || 'medium'}

现在整理这次会议的转写文本：
${body}`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    // 硬超时：120 秒没回应就放弃 —— 宁可报错，也不让前端无限等
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: MODEL,
      temperature: 0, // 结构化字段名不能飘
      max_tokens: maxTokens, // 🚨 reasoning 从总额度里扣，太小会把正文吃光
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek 调用失败 HTTP ${response.status}：${rawText.slice(0, 200)}`);
  }

  const data = JSON.parse(rawText);
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  const usage = data?.usage ?? {};

  // 🚨 截断层（W2 结论）：max_tokens 吃光 = 正文 0 字且零报错，必须显式检查
  if (finishReason === 'length') {
    throw new Error(`模型输出被 max_tokens 截断（finish_reason=length, usage=${JSON.stringify(usage)}）`);
  }
  if (typeof content !== 'string' || !content) {
    throw new Error('模型返回字段不完整（缺 content）');
  }

  const checked = checkJson(content);
  if (!checked.ok) {
    throw new Error(`模型输出不是合法 JSON：${checked.message}｜前 300 字：${content.slice(0, 300)}`);
  }

  const noteError = checkNote(checked.value);
  if (noteError) {
    throw new Error(`纪要字段不完整：${noteError}｜前 300 字：${content.slice(0, 300)}`);
  }

  // 内容层：核验实体（能核的核，不能核的如实标记）
  const verify = verifyEntities(checked.value, {
    segments: input.segments,
    text: input.text || (input.segments ?? []).map((s) => s.text).join(''),
    duration: input.duration || 0,
  });

  return {
    note: checked.value,
    verify,
    finishReason: finishReason ?? null,
    jsonFenced: checked.fenced,
    usage: {
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.reasoning_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    },
  };
}
