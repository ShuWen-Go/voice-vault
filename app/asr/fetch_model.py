# -*- coding: utf-8 -*-
"""
听藏 · 模型获取脚本（把 whisper 模型下到本地）

为什么需要这个脚本（两条都是实测踩出来的）：
  1. 官方 huggingface.co 在国内网络【完全不通】（实测 http=000）
     ⇒ 必须走镜像：HF_ENDPOINT=https://hf-mirror.com（实测 1.65 MB/s）
  2. HF 新版的 Xet 传输协议会【绕过镜像】直连 cas-server.xethub.hf.co，直接 401
     ⇒ 必须 HF_HUB_DISABLE_XET=1
  另外：用 local_dir 模式 = 真实复制文件，避免 Windows 上符号链接建失败
        留下 0 字节空文件（会报 "model.bin is incomplete"）。

用法：
  python fetch_model.py [medium|small|large-v3] [目标根目录]
  （目标目录留空则读环境变量 VV_MODEL_DIR）
"""
import os
import sys
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from huggingface_hub import snapshot_download

quality = sys.argv[1] if len(sys.argv) > 1 else "medium"
root = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("VV_MODEL_DIR", "")

if not root:
    print("用法: python fetch_model.py [medium|small|large-v3] <目标根目录>", file=sys.stderr)
    print("（目标目录也可以放在环境变量 VV_MODEL_DIR 里）", file=sys.stderr)
    sys.exit(1)

repo_id = "Systran/faster-whisper-" + quality
dst = os.path.join(root, quality)

print(f"[fetch] 镜像     = {os.environ['HF_ENDPOINT']}")
print(f"[fetch] 模型     = {repo_id}")
print(f"[fetch] 目标目录 = {dst}")

t0 = time.time()
path = snapshot_download(
    repo_id=repo_id,
    local_dir=dst,
    allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
    max_workers=4,
)
elapsed = time.time() - t0

total = 0
for name in os.listdir(dst):
    p = os.path.join(dst, name)
    if os.path.isfile(p):
        total += os.path.getsize(p)

print(f"[fetch] 完成 -> {path}")
print(f"[fetch] 耗时 {elapsed:.1f}s ｜ 体积 {total / 1024 / 1024:.1f} MB")
