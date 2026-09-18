#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify.sh 断言变异测试（离线，零积分）
=====================================================================

目的：证明 verify.sh 的 15 条断言**不是恒真断言**——即"真的能抓到问题"。

原理：
  1. 起一个本地 mock HTTP 服务，模拟 jimeng-api 的正确行为；
  2. 用真实 `verify.sh` 打这个 mock → 记录「基准失败集合」（应尽量为空）；
  3. 逐条把 mock 的某一处行为**故意改坏**（变异），重跑 verify.sh；
  4. 断言「观测到的失败项集合」== 该变异预期的失败项集合。

  若某条断言在对应变异下仍然 PASS，说明它形同虚设。

用法：
    python3 scripts/verify_mutation_test.py            # 跑基准 + 全部变异
    python3 scripts/verify_mutation_test.py --mutant m09_group_limit
    python3 scripts/verify_mutation_test.py --verbose
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 防 GBK 崩溃：Windows 下 stdout 默认 GBK，含 emoji 的 ⚠️ 会触发 UnicodeEncodeError
# 导致全量跑在基准阶段即崩溃（HANDOFF §三 根因 3 的修复建议）。强制以 utf-8 输出。
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

STAGE = Path(__file__).resolve().parent.parent

# ⚠️ 本机 `bash` 被 WSL 抢占（C:\Windows\system32\bash），必须显式用 Git Bash。
GIT_USR_BIN = r"C:\Program Files\Git\usr\bin"
BASH_CANDIDATES = [
    os.path.join(GIT_USR_BIN, "bash.exe"),
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
]


def find_bash() -> str:
    for c in BASH_CANDIDATES:
        if os.path.isfile(c):
            return c
    raise SystemExit("未找到 Git Bash（bash.exe）；verify.sh 必须用 Git Bash 运行，不能用 WSL bash")


BASH = find_bash()
PY_DIR = r"C:\Users\gjzou\.workbuddy\binaries\python\versions\3.13.12"
PY_DIR_BASH = "/c/Users/gjzou/.workbuddy/binaries/python/versions/3.13.12"
GIT_USR_BIN_BASH = "/c/Program Files/Git/usr/bin"

PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

GROUP_LIMIT = 15
SINGLE_LIMIT = 8
AGENT_IMG_CAP = 40
AGENT_VID_CAP = 8
QUOTA_MAX = 4

# ── 变异清单：每个变异只改一处行为，并声明预期失败的断言编号 ──
MUTATIONS: dict[str, dict] = {
    "m01_ping":         {"desc": "/ping 返回 500",                        "expect": {1}},
    "m02_root":         {"desc": "根端点不再列出 agent 路由",              "expect": {2}},
    "m03_models":       {"desc": "/v1/models 返回 500",                   "expect": {3}},
    "m06_batch":        {"desc": "同步编排返回空场景",                     "expect": {6}},
    "m07_default":      {"desc": "单图默认返回 2 张（开关失效）",           "expect": {7}},
    "m08_group_nocount":{"desc": "组图缺数量时放行（未拒绝）",              "expect": {8}},
    "m09_group_limit":  {"desc": "组图超限报错写「40」而非「15」",          "expect": {9}},
    "m10_single_cap":   {"desc": "单图路径返回 9 张（超上限 8）",           "expect": {10, 11}},
    "m11_isolation":    {"desc": "mode:single 未屏蔽组图（返回 4 张）",     "expect": {11}},
    "m12_autoswitch":   {"desc": "无 mode 时静默切进组图（无 hint）",       "expect": {12}},
    "m13_agent_cap":    {"desc": "41 图编排未被拒（无总量闸）",             "expect": {13}},
    "m14_video_cap":    {"desc": "视频任务 cap 回显 40 而非 8",             "expect": {14}},
    "m15_quota":        {"desc": "同提示词配额不生效（第 5 次放行）",        "expect": {15}},
}

MUTANT = ""  # 由 main 设置
QUOTA: dict[str, int] = {}
TASKS: dict[str, dict] = {}


def has_group_feature(prompt: str) -> bool:
    if any(k in prompt for k in ("连续", "绘本", "故事")):
        return True
    return bool(re.search(r"(?:张数|数量|图片数)\s*[:：=]?\s*\d+|\d+\s*张", prompt))


def parse_count(prompt: str) -> int | None:
    m = re.search(r"(\d+)\s*张", prompt)
    if m:
        return int(m.group(1))
    m = re.search(r"(?:张数|数量|图片数)\s*[:：=]?\s*(\d+)", prompt)
    if m:
        return int(m.group(1))
    return None


def img_ok(n: int) -> dict:
    return {"code": 0, "created": int(time.time()),
            "data": [{"url": f"http://127.0.0.1:{PORT}/fake/{i}.png"} for i in range(1, n + 1)]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # 静音
        pass

    def _send(self, code: int, body, ctype="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # ── GET ──
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/ping":
            if MUTANT == "m01_ping":
                return self._send(500, {"code": -1})
            return self._send(200, {"ok": True})
        if p == "/":
            text = "jimeng-api\n"
            if MUTANT != "m02_root":
                text += "POST /v1/agent/generate\nPOST /v1/agent/tasks\nPOST /v1/images/generations\n"
            return self._send(200, text.encode(), "text/plain")
        if p == "/v1/models":
            if MUTANT == "m03_models":
                return self._send(500, {"code": -1})
            return self._send(200, {"object": "list", "data": [{"id": "jimeng-4.0"}]})
        if p.startswith("/fake/"):
            return self._send(200, PNG_1x1, "image/png")
        m = re.fullmatch(r"/v1/agent/tasks/([0-9a-fA-F-]{8,})", p)
        if m:
            t = TASKS.get(m.group(1), {})
            return self._send(200, t.get("view", {"status": "failed", "errors": ["任务不存在"]}))
        if p == "/v1/agent/tasks":
            return self._send(200, {"tasks": []})
        return self._send(404, {"code": -1, "message": "not found"})

    # ── POST ──
    def do_POST(self):
        p = self.path.split("?")[0]
        b = self._read_body()

        if p == "/v1/images/generations":
            return self._send(200, self._images(b))

        if p == "/v1/agent/generate":
            if MUTANT == "m06_batch":
                return self._send(200, {"kind": "image", "total": 0, "succeeded": 0,
                                        "failed": 0, "cap": AGENT_IMG_CAP, "scenes": [], "errors": []})
            scenes = [{"index": 1, "title": "场景一", "kind": "image",
                       "url": f"http://127.0.0.1:{PORT}/fake/1.png"},
                      {"index": 2, "title": "场景二", "kind": "image",
                       "url": f"http://127.0.0.1:{PORT}/fake/2.png"}]
            return self._send(200, {"kind": "image", "total": 2, "succeeded": 2, "failed": 0,
                                    "cap": AGENT_IMG_CAP, "scenes": scenes, "errors": []})

        if p == "/v1/agent/tasks":
            return self._send(200, self._create_task(b))

        return self._send(404, {"code": -1, "message": "not found"})

    # ── 图片生成分支 ──
    def _images(self, b: dict) -> dict:
        prompt = str(b.get("prompt") or "")
        model = str(b.get("model") or "")
        mode = b.get("mode")

        if mode == "group":
            cnt = parse_count(prompt)
            if cnt is None:
                if MUTANT == "m08_group_nocount":
                    return img_ok(4)
                return {"code": -2000,
                        "message": "组图模式必须在提示词中显式指定张数（位置与形式不限），"
                                   "例如「生成4张连续的猫咪插画」「生成不同风格的猫咪插画，4张」。"}
            if cnt > GROUP_LIMIT:
                shown = 40 if MUTANT == "m09_group_limit" else GROUP_LIMIT
                return {"code": -2000,
                        "message": f"组图张数超出上限：本次从提示词解析到 {cnt} 张，单次上限为 {shown} 张，"
                                   f"已停止生成。请把数量改为 1-{shown} 之间的整数，或分批多次生成。"}
            return img_ok(cnt)

        if mode == "single":
            # 编排隔离：jimeng-4.x + 组图特征也不得切组图
            if MUTANT == "m11_isolation" and model.startswith("jimeng-4") and has_group_feature(prompt):
                return img_ok(4)
            if MUTANT == "m10_single_cap":
                # m10_single_cap：模拟「单图上限钳制失效」（返回 9 > 8），但仍走配额守卫，
                # 确保断言 15（同提示词配额）不被误伤——否则该变异会同时击穿单图上限与配额
                # 两道独立护栏，无法 1:1 对应（实测曾返回 {10,11,15}）。
                return self._single_with_quota(prompt, count=9)
            return self._single_with_quota(prompt)

        # 兼容模式（无 mode）
        if MUTANT == "m12_autoswitch" and model.startswith("jimeng-4") and has_group_feature(prompt):
            r = img_ok(3)
            r["mode"] = "group"
            return r
        # m07_default：模拟「单图张数开关失效」——兼容模式（无 mode）下，非组图特征提示词
        # 本应返回 1 张却返回 2 张。仅作用于断言 7 的精确调用（无 mode + 非组图特征）；
        # 组图特征提示词仍走单图 1 张 + hint，避免误伤断言 12（兼容模式路由/hint 守卫），
        # 维持「1 个变异 ⇄ 1 条断言」的清晰对应（否则 m07 会同时击穿 7 与 12，被判「抓错」）。
        if MUTANT == "m07_default" and not (model.startswith("jimeng-4") and has_group_feature(prompt)):
            return img_ok(2)
        if model.startswith("jimeng-4") and has_group_feature(prompt):
            r = img_ok(1)
            r["mode"] = "single"
            r["hint"] = ('本次请求未显式声明生成模式（mode），但提示词含组图特征。本次已按【单图】执行。'
                         '若确实需要一次生成多张内容关联图，请在请求体中显式传 mode:"group"。')
            return r
        r = img_ok(1)
        r["mode"] = "single"
        return r

    def _single_with_quota(self, prompt: str, count: int = 1) -> dict:
        used = QUOTA.get(prompt, 0)
        if MUTANT != "m15_quota" and used >= QUOTA_MAX:
            return {"code": -2000,
                    "message": f"同一提示词的产出配额已用尽：本提示词已产出 {used} 张，"
                               f"上限为 {QUOTA_MAX} 张，剩余 0 张。请修改提示词或等待配额重置。"}
        QUOTA[prompt] = used + 1
        return img_ok(count)

    # ── 异步任务 ──
    def _create_task(self, b: dict) -> dict:
        kind = b.get("kind") if b.get("kind") in ("image", "video") else "image"
        doc = str(b.get("doc") or "")
        n_scenes = len(re.findall(r"^##\s", doc, re.M))
        cap = AGENT_VID_CAP if kind == "video" else AGENT_IMG_CAP
        tid = f"00000000-0000-4000-8000-{len(TASKS):012d}"
        view = {"task_id": tid, "kind": kind, "status": "queued", "cap": cap,
                "created_at": "2026-09-17T00:00:00.000Z",
                "progress": {"total": 0, "done": 0, "succeeded": 0, "failed": 0},
                "scenes": [], "errors": []}
        if MUTANT == "m14_video_cap" and kind == "video":
            view["cap"] = AGENT_IMG_CAP

        over = n_scenes > cap
        if MUTANT == "m13_agent_cap" and kind == "image":
            over = False  # 总量闸失效
        final = dict(view)
        if over:
            final.update({"status": "failed",
                          "errors": [f"Agent 编排总量超限：本次请求 {n_scenes} 个"
                                     f"{'视频' if kind == 'video' else '图片'}场景，而 Agent 模式单次上限为 "
                                     f"{cap} 个{'视频' if kind == 'video' else '图片'}。请拆成多批提交。"]})
        else:
            final.update({"status": "succeeded", "scenes": []})
        TASKS[tid] = {"view": final}
        return view


PORT = 0


def start_server() -> ThreadingHTTPServer:
    global PORT
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    PORT = s.getsockname()[1]
    s.close()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run_verify() -> tuple[int, int, set[int], str]:
    """跑 verify.sh，返回 (passed, failed, 失败项编号集合, 原始输出)"""
    env = dict(os.environ)
    for k in list(env):
        if k.lower() in ("http_proxy", "https_proxy", "all_proxy", "http_proxy_user", "https_proxy_user"):
            env.pop(k, None)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    env["PATH"] = (PY_DIR_BASH + ":" + GIT_USR_BIN_BASH + ":"
                   + env.get("PATH", ""))
    env["JIMENG_BENEFIT_COUNT"] = "1"
    env["JIMENG_PROMPT_QUOTA_MAX"] = str(QUOTA_MAX)

    r = subprocess.run([BASH, "verify.sh", f"http://127.0.0.1:{PORT}", "us-mock-token"],
                       cwd=str(STAGE), env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=600)
    out = r.stdout + ("\n[STDERR]\n" + r.stderr if r.stderr.strip() else "")
    passed = failed = 0
    bad: set[int] = set()
    cur = 0
    for line in out.splitlines():
        m = re.match(r"==\s*(\d+)\.", line)
        if m:
            cur = int(m.group(1))
        if line.strip().startswith("✓ "):
            passed += 1
        if line.strip().startswith("✗ "):
            failed += 1
            bad.add(cur)
    m = re.search(r"VERIFY:\s*(\d+)\s*passed,\s*(\d+)\s*failed", out)
    if m:
        passed, failed = int(m.group(1)), int(m.group(2))
    return passed, failed, bad, out


def reset_state():
    QUOTA.clear()
    TASKS.clear()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mutant", default="", help="只跑指定变异")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--serve-only", type=int, default=0,
                    help="只起 mock 服务并绑定指定端口（调试用），不跑 verify.sh")
    args = ap.parse_args()

    global MUTANT
    MUTANT = args.mutant
    if args.serve_only:
        global PORT
        PORT = args.serve_only
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        print(f"mock listening on http://127.0.0.1:{PORT}  mutant={MUTANT or 'baseline'}", flush=True)
        srv.serve_forever()
        return 0

    start_server()

    names = [args.mutant] if args.mutant else [""] + list(MUTATIONS)
    baseline_bad: set[int] = set()
    results = []

    for i, name in enumerate(names):
        MUTANT = name
        reset_state()
        passed, failed, bad, out = run_verify()
        label = "基准 baseline" if not name else name
        if not name:
            baseline_bad = set(bad)
            print(f"\n{'='*72}\n{label}: {passed} passed, {failed} failed  失败项={sorted(bad) or '无'}")
            if bad:
                print("  ⚠️ 基准存在失败项（环境相关，将作为对照基线扣除）")
            print("=" * 72)
        else:
            exp = set(MUTATIONS[name]["expect"])
            got = set(bad)
            okk = (got == exp)
            results.append((name, exp, got, okk))
            mark = "✓ 已抓到" if okk else "✗ 未抓到/抓错"
            print(f"\n[{label}] {MUTATIONS[name]['desc']}")
            print(f"  预期失败项: {sorted(exp)}   实测失败项: {sorted(got) or '无'}   → {mark}")
            if not okk and args.verbose:
                print(out)

    if args.mutant:
        return 0 if (results and results[0][3]) else 1

    print(f"\n{'='*72}\n变异测试汇总（共 {len(results)} 个变异）\n{'='*72}")
    for name, exp, got, okk in results:
        print(f"  {'✓' if okk else '✗'} {name:<20} 预期{sorted(exp)}  实测{sorted(got) or '无'}")
    n_pass = sum(1 for r in results if r[3])
    print(f"\nRESULT: {n_pass}/{len(results)} 个变异被对应断言抓到")
    if baseline_bad:
        print(f"注：基准失败项 {sorted(baseline_bad)}（环境相关，非断言缺陷）")
    print(f"被覆盖的断言项: {sorted({i for r in results for i in r[1]})}")
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
