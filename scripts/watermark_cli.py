# -*- coding: utf-8 -*-
"""jimeng-api 去水印 CLI（自包含，仅依赖 Pillow）
==============================================

纯本地处理，无浏览器、无外部仓库依赖。供 Agent 路由在落盘图片后可选调用。

用法：
    python3 watermark_cli.py <图片路径> [--out 输出] [--mode auto|strip|crop]
    --mode auto  : 先检测，仅当检测到水印才 strip（推荐；jimeng-api CDN 图通常无水印）
    --mode strip : 强制抹除左上角标（谐波插值修复）
    --mode crop  : 强制裁剪画边（兜底）

依赖：仅 Pillow（容器内已通过 apk add py3-pillow 安装）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from watermark_core import (  # noqa: E402
    detect_watermark,
    strip_file,
    crop_file,
    verify_file,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="jimeng-api 水印去除（自包含）")
    ap.add_argument("input", help="输入图片路径")
    ap.add_argument("--out", "-o", help="输出路径或目录")
    ap.add_argument("--mode", "-m", choices=["auto", "strip", "crop"], default="auto")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        print(json.dumps({"ok": False, "error": f"源文件不存在: {src}"}, ensure_ascii=False))
        return 1

    if args.mode == "auto":
        det = detect_watermark(str(src))
        if not det.get("has_wm"):
            print(json.dumps({
                "ok": True,
                "mode": "skip",
                "reason": "未检测到水印（jimeng-api CDN 图通常无水印）",
                "detect": det,
            }, ensure_ascii=False))
            return 0
        res = strip_file(str(src), out=args.out)
        res["detect"] = det
        print(json.dumps(res, ensure_ascii=False))
        return 0 if res.get("ok") else 1

    if args.mode == "strip":
        res = strip_file(str(src), out=args.out)
        print(json.dumps(res, ensure_ascii=False))
        return 0 if res.get("ok") else 1

    # crop
    res = crop_file(str(src), out=args.out)
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
