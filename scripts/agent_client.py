# -*- coding: utf-8 -*-
"""jimeng-api 批量系列图客户端（调用 /v1/agent/generate 并下载命名）
====================================================================

适用于本地/容器外触发批量生图，并把每张图下载到本地按 NN_标题.png 命名。
依赖：仅 Python 标准库（urllib）；如需去水印需本目录 watermark_cli.py + Pillow。

用法示例：
    python3 agent_client.py \
        --url http://localhost:5100 \
        --token "us-xxxx,jp-yyyy" \
        --skill 角色设计 --subject "财税顾问王姐" \
        --out ./output --consistency --strip-wm

    # 或基于 .md 文档：
    python3 agent_client.py --token "us-xxxx" --doc story.md --out ./output
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path


class ApiError(RuntimeError):
    """服务端业务错误（HTTP 200 但 code != 0）。

    服务端错误响应形如 {"code": -2000, "message": "多图模式必须在提示词中显式指定张数..."}，
    且 HTTP 状态码仍为 200（见 lib/response/FailureBody.ts 的 httpStatusCode 默认值）。
    若不显式识别，响应里既无 scenes 也无 errors，会被误判为"0 个场景成功"而静默退出。
    """

    def __init__(self, code: int, message: str):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message


def _post(url: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=1800) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if isinstance(body, dict) and body.get("code") not in (None, 0):
        raise ApiError(body.get("code"), body.get("message") or "未知错误")
    return body


def _download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "jimeng-agent-client/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        dest.write_bytes(resp.read())


def _safe(title: str, index: int) -> str:
    base = re.sub(r"[^\w一-龥-]+", "_", title or f"s{index}")[:40]
    return f"{str(index).zfill(2)}_{base}.png"


def _run_watermark(path: Path) -> None:
    cli = Path(__file__).parent / "watermark_cli.py"
    if not cli.exists():
        return
    import subprocess
    try:
        subprocess.run([sys.executable, str(cli), str(path), "--mode", "auto"], check=False)
    except Exception:
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="jimeng-api 批量系列图客户端")
    ap.add_argument("--url", default=os.environ.get("JIMENG_API_URL", "http://localhost:5100"))
    ap.add_argument("--token", required=True, help="Bearer sessionid（多账号逗号分隔）")
    ap.add_argument("--doc", help=".md/.txt 文档路径（与 skill 二选一）")
    ap.add_argument("--skill", help="技能模板名")
    ap.add_argument("--subject", help="主题（配合 --skill）")
    ap.add_argument("--out", default="./output")
    ap.add_argument("--model")
    ap.add_argument("--ratio", default="1:1")
    ap.add_argument("--resolution", default="2k")
    ap.add_argument("--consistency", action="store_true")
    ap.add_argument("--ref-strength", type=float, default=0.65)
    ap.add_argument("--strip-wm", action="store_true")
    args = ap.parse_args()

    if not args.doc and not (args.skill and args.subject):
        ap.error("需提供 --doc 或 --skill + --subject")

    doc = open(args.doc, encoding="utf-8").read() if args.doc else None
    payload = {
        "doc": doc,
        "skill": args.skill,
        "subject": args.subject,
        "model": args.model,
        "ratio": args.ratio,
        "resolution": args.resolution,
        "consistency": args.consistency,
        "ref_strength": args.ref_strength,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    try:
        data = _post(f"{args.url.rstrip('/')}/v1/agent/generate", args.token, payload)
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP 错误 {e.code}: {e.read().decode('utf-8', 'ignore')}\n")
        return 1
    except ApiError as e:
        # 业务错误（含参数校验失败，如多图未写张数）——原样打印服务端说明
        sys.stderr.write(f"接口错误: {e}\n")
        return 1
    except Exception as e:  # noqa
        sys.stderr.write(f"请求失败: {e}\n")
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    scenes = data.get("scenes", [])
    if not scenes:
        sys.stderr.write(
            "未返回任何场景：请检查 --doc 是否含 '## 场景标题'，或 --skill 模板是否存在\n"
        )
        return 1
    for sc in scenes:
        if not sc.get("url"):
            print(f"[跳过] #{sc.get('index')} {sc.get('title')}: {sc.get('error')}", file=sys.stderr)
            continue
        fn = out / _safe(sc.get("title", "s"), sc.get("index", 0))
        _download(sc["url"], fn)
        if args.strip_wm:
            _run_watermark(fn)
        print(f"[OK] {fn}")

    if data.get("errors"):
        print("部分场景失败:", json.dumps(data["errors"], ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
