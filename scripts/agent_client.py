# -*- coding: utf-8 -*-
"""jimeng-api 批量生成客户端（图片/视频、同步/异步、编排/直出）
====================================================================

适用于本地/容器外触发批量生成，并把每项按 NN_标题.png|mp4 命名落盘。
⚠️ 2026-09-18：落盘为**全量**——上游单请求固定产出 4 张，多张时命名 `NN_标题_01.png …`；
   可用环境变量 `JIMENG_AGENT_KEEP`（默认 0 = 全存）限制每场景落盘张数。
依赖：仅 Python 标准库（urllib）；如需去水印需本目录 watermark_cli.py + Pillow。

三种交付形态（互不干扰）：

  1) 同步编排（默认）          → POST /v1/agent/generate      （阻塞，适合场景数少）
  2) 异步编排（--async）        → POST /v1/agent/tasks         （秒回 task_id）
     配 --wait 则自动轮询 GET /v1/agent/tasks/:id 到结束并下载
  3) 直出单次（--mode）         → POST /v1/images/generations  （显式 single / group）

用法示例：

    # 图片编排（同步）
    python3 agent_client.py --token "us-xxxx,jp-yyyy" \
        --skill 角色设计 --subject "财税顾问王姐" --out ./output --consistency

    # 8 段视频编排（异步提交 + 等完成）
    python3 agent_client.py --token "us-xxxx" --doc story.md --out ./out \
        --kind video --duration 5 --async --wait

    # 直出：显式组图（一次 15 张，需提示词写明张数）
    python3 agent_client.py --token "us-xxxx" --prompt "生成4张连续的猫咪插画" \
        --mode group --out ./out

    # 直出：强制单图
    python3 agent_client.py --token "us-xxxx" --prompt "一只橘猫" --mode single --out ./out
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


class ApiError(RuntimeError):
    """服务端业务错误（HTTP 200 但 code != 0）。

    服务端错误响应形如 {"code": -2000, "message": "组图模式必须在提示词中显式指定张数..."}，
    且 HTTP 状态码仍为 200（见 lib/response/FailureBody.ts 的 httpStatusCode 默认值）。
    若不显式识别，响应里既无 scenes 也无 errors，会被误判为"0 个场景成功"而静默退出。
    """

    def __init__(self, code: int, message: str):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message


def _request(url: str, token: str, method="POST", payload: dict | None = None,
             timeout: int = 1800) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Authorization": f"Bearer {token}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if isinstance(body, dict) and body.get("code") not in (None, 0):
        raise ApiError(body.get("code"), body.get("message") or "未知错误")
    return body


def _post(url: str, token: str, payload: dict) -> dict:
    return _request(url, token, "POST", payload)


def _get(url: str, token: str) -> dict:
    return _request(url, token, "GET", None, timeout=120)


def _download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "jimeng-agent-client/1.1"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        dest.write_bytes(resp.read())


def _safe(title: str, index: int, ext: str = "png", seq: int | None = None) -> str:
    """生成落盘文件名 `NN_标题.ext`；同场景多张产出时追加 `_NN` 序号后缀。"""
    base = re.sub(r"[^\w一-龥-]+", "_", title or f"s{index}")[:40]
    stem = f"{str(index).zfill(2)}_{base}"
    if seq:
        stem += f"_{str(seq).zfill(2)}"
    return f"{stem}.{ext.lstrip('.')}"


def _run_watermark(path: Path) -> None:
    cli = Path(__file__).parent / "watermark_cli.py"
    if not cli.exists():
        return
    import subprocess
    try:
        subprocess.run([sys.executable, str(cli), str(path), "--mode", "auto"], check=False)
    except Exception:
        pass


def _ext_for(kind: str) -> str:
    """按类别决定落盘扩展名。视频恒为 mp4（上游返回 mp4 直链）。"""
    return "mp4" if kind == "video" else "png"


def _download_items(items, out: Path, kind: str, strip_wm: bool) -> int:
    """把 [{index,title,url,urls,error}] 逐项**全量**下载落盘。返回成功数。

    ⚠️ 2026-09-18 变更（与服务端 `src/agent/tasks.ts` 的 `saveSceneToDisk` 对齐）：
    上游单图路径**每次请求固定产出 4 张**，服务端响应已带 `urls: string[]` 全量字段。
    旧实现只取 `url`（首图）→ 其余 3 张**已生成、已计费**却被丢弃（G-2）。
    现优先取 `urls` 全量（缺失时回退 `url`，向后兼容）；多张命名 `NN_标题_01.png …`，
    恰好 1 张时保持旧命名 `NN_标题.png`。环境变量 `JIMENG_AGENT_KEEP`
    （默认 0 = 全存）可限制每场景落盘张数。
    """
    out.mkdir(parents=True, exist_ok=True)
    ext = _ext_for(kind)
    try:
        keep = int(os.environ.get("JIMENG_AGENT_KEEP", "0") or "0")
    except ValueError:
        keep = 0
    n_ok = 0
    for sc in items:
        urls = sc.get("urls") or ([sc["url"]] if sc.get("url") else [])
        urls = [u for u in urls if u]
        if not urls:
            print(f"[跳过] #{sc.get('index')} {sc.get('title')}: {sc.get('error')}", file=sys.stderr)
            continue
        if keep > 0:
            urls = urls[:keep]
        multi = len(urls) > 1
        for k, u in enumerate(urls, start=1):
            fn = out / _safe(sc.get("title", "s"), sc.get("index", 0), ext,
                             seq=(k if multi else None))
            _download(u, fn)
            # 去水印仅对图片有意义（视频不裁剪）
            if strip_wm and kind == "image":
                _run_watermark(fn)
            print(f"[OK] {fn}")
            n_ok += 1
    return n_ok


def _wait_task(base: str, token: str, task_id: str, interval: int = 5) -> dict:
    """轮询异步任务直到终态。返回最终任务对象。

    终态：succeeded / partial / failed（见 src/agent/tasks.ts 的 AgentTaskStatus）。
    轮询异常不致命——网络抖动时继续等，直到任务本身到终态。
    """
    terminal = {"succeeded", "partial", "failed"}
    last_status = None
    while True:
        try:
            data = _get(f"{base}/v1/agent/tasks/{task_id}", token)
        except Exception as e:  # noqa
            sys.stderr.write(f"[warn] 查询任务失败（继续重试）: {e}\n")
            time.sleep(interval)
            continue
        task = data.get("task", data)
        status = task.get("status")
        prog = task.get("progress") or {}
        if status != last_status:
            print(
                f"[进度] {status}  已完成 {prog.get('done', 0)}/{prog.get('total', 0)}",
                file=sys.stderr,
            )
            last_status = status
        if status in terminal:
            return task
        time.sleep(interval)


def _run_direct(base: str, args) -> int:
    """直出单次调用：显式 single / group。用于验证 M1 / M3 两条模式。"""
    if not args.prompt:
        sys.stderr.write("--mode 需配合 --prompt 使用（直出单次调用）\n")
        return 2
    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "ratio": args.ratio,
        "resolution": args.resolution,
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    payload["mode"] = args.mode
    try:
        data = _post(f"{base}/v1/images/generations", args.token, payload)
    except ApiError as e:
        sys.stderr.write(f"接口错误: {e}\n")
        return 1
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP 错误 {e.code}: {e.read().decode('utf-8', 'ignore')}\n")
        return 1

    if data.get("hint"):
        print(f"[提示] {data['hint']}", file=sys.stderr)
    print(f"[模式] 本次实际模式 = {data.get('mode')}", file=sys.stderr)

    items = [
        {"index": i + 1, "title": f"direct_{args.mode}", "url": d.get("url")}
        for i, d in enumerate(data.get("data", []))
    ]
    if not items:
        sys.stderr.write("未返回任何图片\n")
        return 1
    n = _download_items(items, Path(args.out), "image", args.strip_wm)
    print(f"[汇总] 直出 mode={args.mode} 落盘 {n}/{len(items)}")
    return 0 if n else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="jimeng-api 批量生成客户端（图片/视频、同步/异步）")
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
    # ── 编排类别 ──
    ap.add_argument("--kind", choices=["image", "video"], default="image",
                    help="编排类别：image（≤40 张）｜video（≤8 段）")
    ap.add_argument("--duration", type=int, default=None,
                    help="视频时长（秒），仅 --kind video 生效，默认 5")
    # ── 交付形态 ──
    ap.add_argument("--async", dest="use_async", action="store_true",
                    help="走异步任务端点 POST /v1/agent/tasks（秒回 task_id）")
    ap.add_argument("--wait", action="store_true",
                    help="异步提交后轮询到任务结束并下载（隐含 --async）")
    ap.add_argument("--interval", type=int, default=5, help="异步轮询间隔（秒），默认 5")
    ap.add_argument("--max-items", type=int, default=None,
                    help="主动收紧本次总量上限（**场景数**，非图片数；"
                         "上游单请求固定产出 4 张，故实际图片数可能为其 4 倍）")
    # ── 直出单次 ──
    ap.add_argument("--mode", choices=["single", "group"],
                    help="直出模式：single 强制单图｜group 强制组图（需配合 --prompt）")
    ap.add_argument("--prompt", help="直出单次调用的提示词（配合 --mode）")
    args = ap.parse_args()

    base = args.url.rstrip("/")

    # ③ 直出路径
    if args.mode:
        return _run_direct(base, args)

    # ①② 编排路径
    if not args.doc and not (args.skill and args.subject):
        ap.error("需提供 --doc 或 --skill + --subject，或改用 --mode + --prompt 直出")

    wait = args.wait
    use_async = args.use_async or wait

    doc = open(args.doc, encoding="utf-8").read() if args.doc else None
    payload = {
        "doc": doc,
        "skill": args.skill,
        "subject": args.subject,
        "kind": args.kind,
        "model": args.model,
        "ratio": args.ratio,
        "resolution": args.resolution,
        "duration": args.duration,
        "consistency": args.consistency,
        "ref_strength": args.ref_strength,
        "max_items": args.max_items,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    endpoint = "/v1/agent/tasks" if use_async else "/v1/agent/generate"
    try:
        data = _post(f"{base}{endpoint}", args.token, payload)
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP 错误 {e.code}: {e.read().decode('utf-8', 'ignore')}\n")
        return 1
    except ApiError as e:
        # 业务错误（含参数校验失败，如组图未写张数、总量超限）——原样打印服务端说明
        sys.stderr.write(f"接口错误: {e}\n")
        return 1
    except Exception as e:  # noqa
        sys.stderr.write(f"请求失败: {e}\n")
        return 1

    if use_async:
        task_id = data.get("task_id") or data.get("task", {}).get("id")
        print(f"[任务] task_id = {task_id}  状态 = {data.get('status')}", file=sys.stderr)
        if not wait:
            print(json.dumps(data, ensure_ascii=False))
            return 0
        task = _wait_task(base, args.token, task_id, args.interval)
        final = task.get("progress") or {}
        print(
            f"[任务结束] status={task.get('status')} "
            f"成功={final.get('succeeded')} 失败={final.get('failed')} "
            f"耗时={task.get('elapsed_seconds')}s",
            file=sys.stderr,
        )
        scenes = task.get("scenes", [])
        if not scenes:
            sys.stderr.write("任务结束但未返回任何场景结果\n")
            return 1
        n = _download_items(scenes, Path(args.out), args.kind, args.strip_wm)
        if task.get("errors"):
            print("部分场景失败:", json.dumps(task["errors"], ensure_ascii=False), file=sys.stderr)
        print(f"[汇总] 异步 {args.kind} 落盘 {n}/{len(scenes)}")
        return 0 if n else 1

    # 同步编排
    scenes = data.get("scenes", [])
    if not scenes:
        sys.stderr.write(
            "未返回任何场景：请检查 --doc 是否含 '## 场景标题'，或 --skill 模板是否存在\n"
        )
        return 1
    n = _download_items(scenes, Path(args.out), args.kind, args.strip_wm)
    if data.get("errors"):
        print("部分场景失败:", json.dumps(data["errors"], ensure_ascii=False), file=sys.stderr)
    print(f"[汇总] 同步 {args.kind} 落盘 {n}/{len(scenes)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
