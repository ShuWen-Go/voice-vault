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


def rms_profile(path, bucket=1.0, sr=16000):
    """
    逐秒 RMS 能量曲线（用于「静音段幻觉」的判据）。

    为什么单独算一遍：Whisper 的 VAD 在「低电平环境噪声」上会把它当成人声，
    于是模型在近乎无声的段落里凭空造句子（实测会原样背出 initial_prompt）。
    能量是最便宜的旁证 —— 单独一次解码，38 分钟只用 ~3 秒。

    返回 (逐秒 RMS 列表, p50, p90)；任何异常都返回 (None, None, None)，
    不影响主流程（闸门拿不到数据就不启用，而不是把转写搞挂）。
    """
    try:
        import av
        import numpy as np

        step = int(bucket * sr)
        vals, cur, cnt = [], 0.0, 0
        container = av.open(path)
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=sr)
        for frame in container.decode(stream):
            for f in resampler.resample(frame):
                a = np.frombuffer(bytes(f.planes[0]), dtype=np.int16).astype(np.float32)
                i = 0
                while i < a.size:
                    take = min(step - cnt, a.size - i)
                    chunk = a[i : i + take]
                    cur += float((chunk * chunk).sum())
                    cnt += take
                    i += take
                    if cnt >= step:
                        vals.append((cur / step) ** 0.5)
                        cur, cnt = 0.0, 0
        if cnt:
            vals.append((cur / cnt) ** 0.5)
        container.close()
        if not vals:
            return None, None, None
        arr = np.asarray(vals, dtype=np.float64)
        return vals, float(np.median(arr)), float(np.percentile(arr, 90))
    except Exception as e:  # noqa: BLE001 —— 辅助判据，失败就降级
        log("能量曲线计算失败（不影响转写）：%s" % e)
        return None, None, None


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

    # 逐秒能量曲线：只作为「静音段幻觉」闸门的旁证（见 rms_profile 的说明）
    rms_vals, rms_p50, rms_p90 = rms_profile(args.audio)
    if rms_p50:
        log("能量曲线：p50=%.0f p90=%.0f（共 %d 秒）" % (rms_p50, rms_p90, len(rms_vals)))

    # 中文简繁不稳定：同一个模型、同样设了 language=zh，有的录音全出简体、有的全出繁体。
    # Whisper 官方推荐用 initial_prompt 给一句「同语言的引导」来稳定输出风格 —— 实测有效。
    hint = "以下是一段普通话会议录音的转写。" if args.language not in ("", "auto") else None
    try:
        t1 = time.time()
        seg_iter, info = model.transcribe(
            args.audio,
            language=None if args.language in ("", "auto") else args.language,
            beam_size=5,
            vad_filter=True,
            initial_prompt=hint,
        )
    except Exception as e:
        emit({"type": "error", "message": "解码失败（文件可能损坏或格式不支持）：" + str(e)})
        return 5

    total = float(info.duration or 0)
    segs = []
    last_report = 0.0
    # 耗时统计要剔除「时间空洞」：笔记本休眠 / 进程被挂起 时，wall-clock 会猛涨，
    # 上一轮实测就因此报出 RTF 15.45（真实值应是 0.4~0.6）。
    # 判据：相邻两次循环间隔超过 60 秒 ⇒ 认定这段不是计算时间，单列出来。
    gap_seconds = 0.0
    prev_tick = time.time()
    try:
        # 真正的转写发生在这个循环里：generator 边算边给，所以能报进度
        for seg in seg_iter:
            now = time.time()
            gap = now - prev_tick
            if gap > 60.0:
                gap_seconds += gap
                log("检测到 %.0f 秒时间空洞（机器休眠/挂起），已从耗时中剔除" % gap)
            prev_tick = now
            text = seg.text.strip()
            item = {
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": text,
                # 判据随段落盘 —— 闸门（可重跑）和事后标定都要用，
                # 而这些值只有转写时才有，丢了就得重转（转写是最贵的一步）
                "noSpeech": round(float(getattr(seg, "no_speech_prob", 0.0) or 0.0), 3),
                "logprob": round(float(getattr(seg, "avg_logprob", 0.0) or 0.0), 3),
            }
            if rms_vals:
                i0 = max(0, int(seg.start))
                i1 = min(len(rms_vals), max(i0 + 1, int(seg.end + 0.999)))
                chunk = rms_vals[i0:i1]
                if chunk:
                    item["rms"] = round(sum(chunk) / len(chunk))
            segs.append(item)
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

    elapsed = round(time.time() - t1 - gap_seconds, 1)
    full_text = "".join(s["text"] for s in segs)

    result = {
        "quality": args.quality,
        "model": model_ref,
        "language": info.language,
        "languageProbability": round(float(info.language_probability or 0), 3),
        "durationSeconds": round(total, 2),
        "loadSeconds": load_s,
        "elapsedSeconds": elapsed,
        # 被剔除的时间空洞（休眠 / 挂起），便于判断"这么慢到底是不是机器的问题"
        "suspendedSeconds": round(gap_seconds, 1),
        "rtf": round(elapsed / total, 3) if total else None,
        "segmentCount": len(segs),
        "charCount": len(full_text),
        # 能量基准（闸门按「相对基准」判断，不写死绝对阈值 ⇒ 换设备/换场地不用重调）
        "rmsP50": rms_p50,
        "rmsP90": rms_p90,
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
