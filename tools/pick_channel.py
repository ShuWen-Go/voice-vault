# -*- coding: utf-8 -*-
"""
通道选择实验 v2：多时间点 × 双指标

为什么要 v2：
  v1 只看 avg_logprob ⇒ ch0 置信度最高(-0.219)但只转出 5 段、内容严重不全。
  单看置信度会被「只抓住简单几句」骗到。必须双指标：
    · 覆盖率 = 转出的语音时长 / 窗口时长   （抓全了吗）
    · 置信度 = 按段时长加权的 avg_logprob  （抓准了吗）
  且要在多个时间点各测一遍，防止「某通道只在开头好」。

方法：一次解码扫全片，按目标时间点把 8 通道 + 混音切片写入 wav，再用模型统一评。
"""
import os
import sys
import time
import wave
from collections import defaultdict

import av
import numpy as np
from faster_whisper import WhisperModel

SRC = sys.argv[1]
MODEL_DIR = sys.argv[2]
WORK = sys.argv[3]
OFFSETS = [float(x) for x in (sys.argv[4] if len(sys.argv) > 4 else '60,900,1800').split(',')]
WIN = float(sys.argv[5]) if len(sys.argv) > 5 else 20.0
SR = 16000

os.makedirs(WORK, exist_ok=True)
print("源 = %s" % os.path.basename(SRC), flush=True)
print("窗口 = %s 秒 × %d 个时间点 = %s" % (WIN, len(OFFSETS), OFFSETS), flush=True)

# ---------- 1) 一次解码，切片 ----------
container = av.open(SRC)
stream = container.streams.audio[0]
CH = stream.codec_context.channels or 8
print("声道 = %d ｜ 采样率 = %d ｜ 编码 = %s" % (CH, stream.codec_context.sample_rate, stream.codec_context.name), flush=True)

res = av.AudioResampler(format='s16', layout='%dc' % CH, rate=SR)
buffers = defaultdict(list)     # (offset, name) -> [int16 array]
t = 0.0
t0 = time.time()
for frame in container.decode(stream):
    for f in res.resample(frame):
        raw = bytes(f.planes[0])
        a = np.frombuffer(raw, dtype=np.int16).reshape(-1, CH)
        start, end = t, t + f.samples / float(SR)
        for off in OFFSETS:
            if end <= off or start >= off + WIN:
                continue
            i0 = max(0, int(round((off - start) * SR)))
            i1 = min(a.shape[0], int(round((off + WIN - start) * SR)))
            if i1 > i0:
                seg = a[i0:i1]
                for ci in range(CH):
                    buffers[(off, 'ch%d' % ci)].append(seg[:, ci].copy())
                buffers[(off, 'mix')].append(
                    np.clip(seg.astype(np.int32).mean(axis=1), -32768, 32767).astype(np.int16))
    t += frame.samples / float(SR)
container.close()
print("解码扫描用时 %.1fs" % (time.time() - t0), flush=True)

def write_wav(path, arr):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(arr.tobytes())

names = ['mix'] + ['ch%d' % i for i in range(CH)]
paths = {}
for off in OFFSETS:
    for nm in names:
        chunks = buffers.get((off, nm))
        if not chunks:
            continue
        arr = np.concatenate(chunks)[:int(WIN * SR)]
        p = os.path.join(WORK, 'o%d_%s.wav' % (int(off), nm))
        write_wav(p, arr)
        paths[(off, nm)] = p
print("切片文件 %d 个 → %s" % (len(paths), WORK), flush=True)

# ---------- 2) 模型评估 ----------
t0 = time.time()
model = WhisperModel(MODEL_DIR, device='cpu', compute_type='int8')
print("模型加载 %.1fs ｜ %s\n" % (time.time() - t0, os.path.basename(MODEL_DIR)), flush=True)

agg = defaultdict(lambda: {'cov': [], 'conf': []})
for off in OFFSETS:
    print("--- 时间点 %s ---" % ('%d:%02d' % (off // 60, off % 60)), flush=True)
    for nm in names:
        p = paths.get((off, nm))
        if not p:
            continue
        segs, info = model.transcribe(
            p, language='zh', beam_size=5, vad_filter=True,
            initial_prompt='以下是普通话的会议内容，请使用简体中文转写。',
        )
        segs = list(segs)
        speech = sum(max(s.end - s.start, 0.0) for s in segs)
        cov = speech / WIN
        conf = (sum(s.avg_logprob * max(s.end - s.start, 0.01) for s in segs) / speech) if speech > 0 else float('-inf')
        agg[nm]['cov'].append(cov)
        agg[nm]['conf'].append(conf)
        print("  %-4s 覆盖=%4.0f%%  置信=%6.3f  段=%-3d  %s" %
              (nm, cov * 100, conf, len(segs), ''.join(s.text for s in segs)[:56]), flush=True)
    print("", flush=True)

print("=== 汇总（按覆盖率降序，同档看置信度）===", flush=True)
rows = []
for nm in names:
    if nm not in agg:
        continue
    cov = float(np.mean(agg[nm]['cov']))
    conf = float(np.mean(agg[nm]['conf']))
    rows.append((cov, conf, nm))
for cov, conf, nm in sorted(rows, reverse=True):
    print("  %-4s  覆盖率 %5.1f%%   置信度 %6.3f" % (nm, cov * 100, conf), flush=True)

if rows:
    best = sorted(rows, reverse=True)[0]
    print("\n>>> 推荐音轨 = %s（覆盖率 %.1f%% / 置信度 %.3f）" %
          (best[2], best[0] * 100, best[1]), flush=True)
