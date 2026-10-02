// 听藏 · 存档层（聚合视图）
//
// 职责：把散落的三层产物（音频 / 转写 / 纪要）横向拼成「一条会议记录」。
//
// 为什么不做成一份大档案：三层各有自己的生命周期 ——
//   转写能单独重跑、纠错能单独重跑、纪要能单独重跑（见 /api/correct、force 参数）。
// 若把它们揉进一个文件，任一层重跑都要重写整份档案，迟早写乱。
// 所以：**各存各的，只在读取时拼装**。

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const HASH_RE = /^[0-9a-f]{12}$/;
const AUDIO_EXTS = ['.m4a', '.webm', '.mp3', '.wav', '.mp4', '.ogg', '.opus', '.aac', '.flac'];

export function createStore() {
  const audioDir = path.join(config.dataDir, 'audio');
  const transDir = path.join(config.dataDir, 'transcripts');
  const noteDir = path.join(config.dataDir, 'notes');
  const indexFile = path.join(config.dataDir, 'audio-index.json');

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function readAudioIndex() {
    return readJson(indexFile)?.items ?? [];
  }

  function writeAudioIndex(items) {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify({ items }, null, 2), 'utf8');
  }

  // 找出音频文件（优先查清单，清单没有就按后缀试探 —— 手工动过目录也要能工作）
  function findAudioFile(hash, ext) {
    if (ext) {
      const p = path.join(audioDir, hash + ext);
      if (fs.existsSync(p)) return p;
    }
    for (const e of AUDIO_EXTS) {
      const p = path.join(audioDir, hash + e);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // 一条记录的「摘要版」——列表用，刻意不含全文（否则列表接口会返回几 MB）
  function summarize(hash, audioItem, tr, note, audioFile) {
    const n = note?.note;
    return {
      hash,
      filename: audioItem?.filename ?? null,
      ext: audioItem?.ext ?? (audioFile ? path.extname(audioFile) : null),
      bytes: audioItem?.bytes ?? (audioFile ? fs.statSync(audioFile).size : null),
      uploadedAt: audioItem?.uploadedAt ?? null,
      // 三态：只传了 / 转写过 / 有纪要 —— 前端按这个显示进度
      status: note ? 'structured' : (tr ? 'transcribed' : 'uploaded'),
      durationSeconds: tr?.durationSeconds ?? null,
      segmentCount: tr?.segmentCount ?? null,
      correctionChanged: tr?.correctionChanged ?? null,
      meetingType: n?.meetingType ?? null,
      title: n?.title ?? null,
      summary: n?.summary ?? null,
      counts: n
        ? {
            keyPoints: n.keyPoints?.length ?? 0,
            numbers: n.numbers?.length ?? 0,
            decisions: n.decisions?.length ?? 0,
            todos: n.todos?.length ?? 0,
            openQuestions: n.openQuestions?.length ?? 0,
            risks: n.risks?.length ?? 0,
          }
        : null,
      verify: note?.verify?.summary ?? null,
      updatedAt: note?.createdAt ?? tr?.createdAt ?? audioItem?.uploadedAt ?? null,
    };
  }

  // 单条记录（full=true 时带全文 segments / text，供导出与详情用）
  function readRecord(hash, { full = false } = {}) {
    if (!HASH_RE.test(hash)) return null;
    const audioItem = readAudioIndex().find((it) => it.hash === hash) ?? null;
    const tr = readJson(path.join(transDir, hash + '.json'));
    const note = readJson(path.join(noteDir, hash + '.json'));
    const audioFile = findAudioFile(hash, audioItem?.ext);

    if (!audioItem && !tr && !note) return null; // 三样都没有 = 这条不存在

    const base = summarize(hash, audioItem, tr, note, audioFile);
    base.audioOnDisk = !!audioFile;

    if (full) {
      base.transcript = tr
        ? {
            quality: tr.quality,
            model: tr.model,
            language: tr.language,
            durationSeconds: tr.durationSeconds,
            elapsedSeconds: tr.elapsedSeconds,
            rtf: tr.rtf,
            segmentCount: tr.segmentCount,
            charCount: tr.charCount,
            segments: tr.segments ?? [],
            text: tr.corrected ?? tr.text ?? '',
            correctionSummary: tr.correctionSummary ?? null,
            correctedAt: tr.correctedAt ?? null,
          }
        : null;
      base.noteDetail = note ?? null; // { note, verify, meta, createdAt }
    }
    return base;
  }

  // 列表：扫三个目录的并集（不依赖清单，避免清单漏记时"数据在但看不见"）
  function listRecords() {
    const hashes = new Set();
    for (const it of readAudioIndex()) hashes.add(it.hash);
    for (const dir of [transDir, noteDir]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.json')) hashes.add(f.replace(/\.json$/, ''));
        }
      } catch { /* 目录还不存在，正常 */ }
    }

    const items = [];
    for (const hash of hashes) {
      const rec = readRecord(hash);
      if (rec) items.push(rec);
    }
    // 最近动过的排前面
    items.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));

    const withDuration = items.filter((r) => r.durationSeconds);
    return {
      count: items.length,
      stats: {
        structured: items.filter((r) => r.status === 'structured').length,
        transcribed: items.filter((r) => r.status === 'transcribed').length,
        uploaded: items.filter((r) => r.status === 'uploaded').length,
        totalDurationSeconds: withDuration.reduce((s, r) => s + (r.durationSeconds || 0), 0),
        totalBytes: items.reduce((s, r) => s + (r.bytes || 0), 0),
      },
      items,
    };
  }

  // 删除：把这条记录的**全部产物**删掉（音频 + 转写 + 纪要 + 清单条目）
  // 返回删掉了哪些文件 —— 让调用方和用户都能看到"到底动了什么"
  function deleteRecord(hash) {
    if (!HASH_RE.test(hash)) return null;
    const audioItem = readAudioIndex().find((it) => it.hash === hash) ?? null;
    const audioFile = findAudioFile(hash, audioItem?.ext);
    const targets = [
      audioFile,
      path.join(transDir, hash + '.json'),
      path.join(noteDir, hash + '.json'),
    ].filter(Boolean);

    const removed = [];
    for (const p of targets) {
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          removed.push(path.basename(p));
        }
      } catch (err) {
        return { hash, error: `删除失败 ${path.basename(p)}：${err.message}`, removed };
      }
    }

    // 清单里也摘掉（否则列表会残留一条空记录）
    if (audioItem) {
      writeAudioIndex(readAudioIndex().filter((it) => it.hash !== hash));
    }
    return { hash, removed, count: removed.length };
  }

  return { listRecords, readRecord, deleteRecord };
}
