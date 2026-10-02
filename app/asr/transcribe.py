# -*- coding: utf-8 -*-
"""
听藏 · ASR 转写模块（被 Node 以子进程方式调用）

设计要点（每条都是踩过坑才这么写的）：
  1. 只做一件事：音频 → 带时间戳的文本，并把结果写成 JSON 文件
  2. 进度是「流式」的：边转边往 stdout 打一行 JSON，Node 边读边更新进度
     —— medium 跑 22.5 分钟音频要 ~15 分钟，用户必须看到"在动"
  3. stdout 只跑协议（JSON 行），人类日志一律走 stderr —— 免得污染管道
  4. 每条 JSON 后必须 flush：管道模式下默认带缓冲，不 flush 等于没输出
  5. 强制 UTF-8：Windows 默认 cp936，中文 JSON 出去就成乱码
  6. 所有路径从命令行传入（不写死）：本地一套、云端可换

用法：
  python -u transcribe.py --audio <音频> --out <产物.json> [--quality medium]
                          [--model-dir <目录>] [--language zh]
"""
import argparse
import json
import os
import sys
import time

# 让 stdout / stderr 都用 UTF-8（Windows 上不设就是 cp936）
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def emit(obj):
    """向 Node 输出一行 JSON 事件（stage / progress / done / error）"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    """人类可读日志走 stderr，不参与 stdout 协议"""
    sys.stderr.write("[asr] " + msg + "\n")
    sys.stderr.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="音频文件路径")
    ap.add_argument("--out", required=True, help="转写产物 JSON 的落盘路径")
    ap.add_argument("--quality", default="medium", choices=["small", "medium", "large-v3"])
    ap.add_argument("--model-dir", default=os.environ.get("VV_MODEL_DIR", ""),
                    help="本地模型根目录（下面按档位分 small/ medium/ 子目录）")
    ap.add_argument("--language", default=os.environ.get("VV_LANGUAGE", "zh"),
                    help="语言；填 auto 则让模型自己判断")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        emit({"type": "error", "message": "音频不存在：" + args.audio})
        return 2

    # 模型引用：优先用本地目录（离线、可控），没配就回退到 HF 仓库名
    local = os.path.join(args.model_dir, args.quality) if args.model_dir else ""
    model_ref = local if (local and os.path.isdir(local)) else "Systran/faster-whisper-" + args.quality

    emit({"type": "stage", "stage": "loading_model", "model": model_ref})

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        emit({"type": "error", "message": "无法导入 faster-whisper：" + str(e) + "（检查依赖是否装好）"})
        return 3

    try:
        t0 = time.time()
        model = WhisperModel(model_ref, device="cpu", compute_type="int8")
        load_s = round(time.time() - t0, 1)
    except Exception as e:
        emit({"type": "error", "message": "模型加载失败：" + str(e)})
        return 4

    emit({"type": "stage", "stage": "transcribing", "loadSeconds": load_s})

    try:
        t1 = time.time()
        seg_iter, info = model.transcribe(
            args.audio,
            language=None if args.language in ("", "auto") else args.language,
            beam_size=5,
            vad_filter=True,
        )
    except Exception as e:
        emit({"type": "error", "message": "解码失败（文件可能损坏或格式不支持）：" + str(e)})
        return 5

    total = float(info.duration or 0)
    segs = []
    last_report = 0.0
    try:
        # 真正的转写发生在这个循环里：generator 边算边给，所以能报进度
        for seg in seg_iter:
            text = seg.text.strip()
            segs.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
            now = time.time()
            # 节流：最快每秒报一次，避免刷爆管道
            if now - last_report >= 1.0:
                last_report = now
                done = round(seg.end, 1)
                emit({
                    "type": "progress",
                    "segments": len(segs),
                    "doneSeconds": done,
                    "totalSeconds": round(total, 1),
                    "percent": round(done / total * 100, 1) if total else 0,
                })
    except Exception as e:
        emit({"type": "error", "message": "转写中断：" + str(e)})
        return 6

    elapsed = round(time.time() - t1, 1)
    full_text = "".join(s["text"] for s in segs)

    result = {
        "quality": args.quality,
        "model": model_ref,
        "language": info.language,
        "languageProbability": round(float(info.language_probability or 0), 3),
        "durationSeconds": round(total, 2),
        "loadSeconds": load_s,
        "elapsedSeconds": elapsed,
        "rtf": round(elapsed / total, 3) if total else None,
        "segmentCount": len(segs),
        "charCount": len(full_text),
        "text": full_text,
        "segments": segs,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }

    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    emit({
        "type": "done",
        "out": out_path,
        "segments": len(segs),
        "chars": len(full_text),
        "durationSeconds": round(total, 2),
        "elapsedSeconds": elapsed,
        "rtf": result["rtf"],
        "language": info.language,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
