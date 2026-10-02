// 听藏 · 导出层：把一条会议记录渲染成 Markdown
//
// 目标读者有两类，需求不一样：
//   ① 参会的人   —— 想快速确认「定了啥、我要做啥」
//   ② 没参会的人 —— 想 30 秒搞懂「这是什么会、聊了啥、结论是什么」
//
// 所以结构按「信息密度递减」排：
//   速览(30 秒) → 关键要点 → 行动区 → 细节区
// 并且**区块顺序随会议类型调整**（把这类会议最该看的东西前置）——
// 而不是让读者自己在文档里翻。

const BLOCK_TITLE = {
  keyPoints: '关键要点',
  numbers: '关键数字',
  decisions: '决议',
  todos: '待办',
  openQuestions: '未决问题',
  risks: '风险与障碍',
};

// 每个会议类型的区块顺序（重点前置）
const BLOCK_ORDER = {
  信息传递: ['keyPoints', 'numbers', 'todos', 'decisions', 'openQuestions', 'risks'],
  讨论决策: ['decisions', 'openQuestions', 'keyPoints', 'todos', 'risks', 'numbers'],
  汇报: ['keyPoints', 'risks', 'todos', 'decisions', 'numbers', 'openQuestions'],
  任务分派: ['todos', 'keyPoints', 'decisions', 'numbers', 'risks', 'openQuestions'],
  访谈: ['keyPoints', 'todos', 'openQuestions', 'decisions', 'numbers', 'risks'],
};
const DEFAULT_ORDER = ['keyPoints', 'todos', 'decisions', 'numbers', 'openQuestions', 'risks'];

const ts = (at) => (at ? `[${at}]` : '');

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

// 单块渲染。返回 '' 表示这块没内容（空数组不渲染空标题 —— 不给读者制造"这里缺东西"的错觉）
function renderBlock(key, note, ctx) {
  const items = note[key] ?? [];
  if (!items.length) return '';

  if (key === 'keyPoints') {
    const lines = items.map((p) => `- **${p.topic ?? ''}**${p.topic ? '：' : ''}${p.detail ?? ''}　${ts(p.at)}`);
    return `## ${BLOCK_TITLE[key]}\n\n${lines.join('\n')}\n`;
  }

  if (key === 'numbers') {
    const rows = items.map((x) => `| ${x.value ?? ''} | ${x.meaning ?? ''} | ${x.at ? `[${x.at}]` : ''} |`);
    const flagged = items.filter((x) => ctx.badNumbers.has(x.value));
    const warn = flagged.length
      ? `\n> ⚠️ 其中 ${flagged.length} 处在原文里找不到对应数字，请核对：${flagged.map((x) => x.value).join('、')}\n`
      : '';
    return `## ${BLOCK_TITLE[key]}\n\n| 数值 | 含义 | 位置 |\n|---|---|---|\n${rows.join('\n')}\n${warn}`;
  }

  if (key === 'todos') {
    const lines = items.map((t) => {
      const bits = [];
      if (t.owner) bits.push(`负责人：${t.owner}${ctx.inferredOwners.has(t.owner) ? '（AI 推测）' : ''}`);
      if (t.due) bits.push(`期限：${t.due}`);
      if (t.at) bits.push(`[${t.at}]`);
      return `- [ ] ${t.what ?? ''}${bits.length ? '　·　' + bits.join('　·　') : ''}`;
    });
    return `## ${BLOCK_TITLE[key]}\n\n${lines.join('\n')}\n`;
  }

  const lines = items.map((it) => {
    const text = it.what ?? it.detail ?? '';
    return `- ${text}　${ts(it.at)}`;
  });
  return `## ${BLOCK_TITLE[key]}\n\n${lines.join('\n')}\n`;
}

/**
 * 把一条记录渲染成 Markdown
 * @param {object} rec store.readRecord(hash, {full:true}) 的结果
 */
export function toMarkdown(rec) {
  const detail = rec.noteDetail;
  const note = detail?.note;
  const meta = detail?.meta ?? {};
  const verify = detail?.verify ?? {};

  const head = [];
  // ① 标题
  head.push(`# ${note?.title || rec.filename || '会议记录'}`, '');

  // ② 元信息行（两类读者都需要先知道"这是哪场会"）
  const metaBits = [
    note?.meetingType ? `**类型** ${note.meetingType}` : null,
    `**时长** ${fmtDuration(rec.durationSeconds)}`,
    rec.updatedAt ? `**整理于** ${fmtTime(rec.updatedAt)}` : null,
  ].filter(Boolean);
  head.push(metaBits.join('　｜　'));

  const techBits = [
    rec.quality || meta.quality ? `**转写** ${rec.quality || meta.quality} 档 · 本地完成` : null,
    rec.correctionChanged ? `**纠错** ${rec.correctionChanged} 处` : null,
    verify.summary
      ? `**核验** 时间戳 ${verify.summary.badAt === 0 ? '全部命中' : `可疑 ${verify.summary.badAt} 处`} · 数字存疑 ${verify.summary.inventedNumbers ?? 0} 处`
      : null,
  ].filter(Boolean);
  // 技术信息用引用块：比 <sub> 兼容性好 —— 这个文件是要粘到飞书/钉钉/邮件里的，
  // 露出 HTML 标签会很难看
  if (techBits.length) head.push(`> ${techBits.join('　｜　')}`);
  head.push('', '---', '');

  // ③ 没有纪要时：如实说明，不假装有
  if (!note) {
    head.push('## 尚未生成纪要', '');
    head.push(
      rec.status === 'transcribed'
        ? '这份录音已经转写完成，但还没有生成结构化纪要。可从「听藏」页面点“生成纪要”后再导出。'
        : '这份录音还没有转写，只有音频文件。',
      '',
    );
    return head.join('\n');
  }

  // ④ 30 秒速览（没参会的人看这一段就够）
  if (note.summary) {
    head.push('## 30 秒速览', '', note.summary, '');
  }

  // ⑤ 按会议类型决定区块顺序（重点前置）
  const order = BLOCK_ORDER[note.meetingType] ?? DEFAULT_ORDER;
  const ctx = {
    inferredOwners: new Set(
      (verify.owners ?? []).filter((o) => o.verified === false && o.owner).map((o) => o.owner),
    ),
    badNumbers: new Set(
      (verify.numbers ?? []).filter((x) => x.verified === false && x.value).map((x) => x.value),
    ),
  };

  for (const key of order) {
    const block = renderBlock(key, note, ctx);
    if (block) head.push(block, '');
  }

  // ⑥ 页脚：把"这玩意儿怎么来的"讲清楚（也是给陌生人的信任背书）
  head.push('---', '');
  head.push(
    `*由「听藏」整理 ｜ 语音转写在本地完成，每条内容都标注了对应的录音位置（mm:ss）` +
    `${detail?.createdAt ? `　｜　生成于 ${fmtTime(detail.createdAt)}` : ''}*`,
  );

  return head.join('\n');
}
