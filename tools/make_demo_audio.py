# -*- coding: utf-8 -*-
"""
把公开语料的会议音频转成「可公开展示」的单文件：

  8 通道远场 FLAC  ->  单声道 16kHz  AAC(.m4a)

为什么这么做：
  · 实测 8 通道直接混音（mix）反而更差 —— 通道间延时互相干涉、听感与识别都变糊
  · 单声道 16k 足够 Whisper 用，体积也小（38 分钟约 15MB，能随包上云）
  · .m4a/AAC 浏览器原生可放，PyAV 也能解，格式最省心

用法：
  python make_demo_audio.py <源.flac> <输出.m4a> [通道号|mix] [限长秒数]
"""
import os
import sys
import time

import av
import numpy as np

SRC = sys.argv[1]
DST = sys.argv[2]
PICK = sys.argv[3] if len(sys.argv) > 3 else 'mix'
LIMIT = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0

SR = 16000
BITRATE = 48000

container = av.open(SRC)
stream = container.streams.audio[0]
CH = stream.codec_context.channels or 1
print("源 %s ｜ 声道 %d ｜ 采样率 %d ｜ 编码 %s" %
      (os.path.basename(SRC), CH, stream.codec_context.sample_rate, stream.codec_context.name), flush=True)

pick = PICK.lower()
if pick == 'mix':
    layout = 'mono'
    idx = -1
else:
    layout = 'mono' if CH == 1 else '%dc' % CH
    idx = int(pick.replace('ch', ''))

res = av.AudioResampler(format='s16', layout=layout, rate=SR)

out = av.open(DST, 'w', format='mp4')
try:
    ost = out.add_stream('aac', rate=SR, layout='mono')   # 显式单声道，体积减半
except TypeError:
    ost = out.add_stream('aac', rate=SR)
ost.bit_rate = BITRATE

t0 = time.time()
fed = 0.0
for frame in container.decode(stream):
    for f in res.resample(frame):
        raw = bytes(f.planes[0])
        if CH > 1 and idx >= 0:
            a = np.frombuffer(raw, dtype=np.int16).reshape(-1, CH)[:, idx].copy()
        else:
            a = np.frombuffer(raw, dtype=np.int16)
            if a.ndim > 1:
                a = a.reshape(-1)
        if LIMIT:
            room = int(LIMIT * SR) - int(fed * SR)
            if room <= 0:
                break
            a = a[:room]
        if a.size == 0:
            continue
        nf = av.AudioFrame.from_ndarray(np.ascontiguousarray(a.reshape(1, -1)), format='s16', layout='mono')
        nf.rate = SR
        nf.pts = int(fed * SR)
        for p in ost.encode(nf):
            out.mux(p)
        fed += a.size / float(SR)
    if LIMIT and fed >= LIMIT:
        break

for p in ost.encode(None):
    out.mux(p)
out.close()
container.close()

size = os.path.getsize(DST)
print("完成：%s ｜ 时长 %.1f 秒（%.1f 分钟）｜ %.1f MB ｜ 用时 %.1fs" %
      (os.path.basename(DST), fed, fed / 60, size / 1048576, time.time() - t0), flush=True)

# 反验：能否解回来
c = av.open(DST)
dur = c.duration / 1000000 if c.duration else 0
st = c.streams.audio[0]
print("反验：时长 %.1fs ｜ 声道 %s ｜ 采样率 %s" %
      (dur, st.codec_context.channels, st.codec_context.sample_rate), flush=True)
c.close()
