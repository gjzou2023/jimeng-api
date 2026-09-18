#!/usr/bin/env bash
# real_gen_verify.sh —— 真实生成层回归（**分层断言**）
#
# 为什么需要它（FIX_PLAN_v2.0 §3.4 约束理论 · 瓶颈＝真实生成层无回归）：
#   `smoke_light.sh` 的断言 1–5 全为**零成本**健康检查，与"能不能出图、扣多少分"完全无关；
#   历史教训是 **"8/8 DEPLOY VERIFIED" ≠ "功能可用"** —— 零成本层全绿，掩盖了 3 个 P1。
#   本脚本补上被漏掉的那一环，并把断言**分层**，使失败原因可分辨。
#
# 三层断言（互相独立、各自计数）：
#   L1 请求成功     ：HTTP 可达 且 服务端响应 `code == 0`
#   L2 出图成功     ：`scenes[0]` 至少返回 1 个 URL
#   L3 张数符合预期 ：服务端报告落盘数 == 上游 items 数，且 >= EXPECT_MIN
#                     （若 out_dir 本地可见，再与磁盘实际 .png 数交叉核对）
#
# 与旧断言的区别（G-5）：旧断言把"出图"与"张数 == 环境变量"绑死，
#   而上游单图路径**固有产出 4 张**（2026-09-18 实测），该等式不成立 → 旧断言恒红。
#   本脚本 L2/L3 分离：出图与否、张数多寡，各判各的。
#
# 用法：
#   JIMENG_TOKEN='cn-xxxxxxxxxxxxxxxx' bash scripts/real_gen_verify.sh
#
# 可选环境变量：
#   BASE_URL   服务地址（默认 http://localhost:5100）
#   OUT_DIR    落盘目录（不设则不落盘，仅校验 URL 层）
#   MODEL      模型（默认 jimeng-4.0 —— **1 分/张，最省**；5.0/nanobanana 为 3 分/张）
#   EXPECT_MIN 期望最少张数（默认 1）
#
# 成本：1 个场景 × 上游固定产出（实测 4 张）≈ 4 积分（jimeng-4.0 / 1k）。
# 护栏：
#   - 提示词带 **nonce**（每次唯一）→ 绕开「同提示词产出配额」护栏，
#     否则第 5 次同提示词会被自己的门禁拒绝，把"没测到"伪装成"上游不可用"（G-8）。
#   - L1 失败则不再继续（本就只发一个请求，不会二次耗分）。
#   - 单价最低的模型做默认，避免用 3 分/张的模型做冒烟。
set -uo pipefail

cd "$(dirname "$0")/.." || { echo "无法进入仓库根目录"; exit 1; }

BASE="${BASE_URL:-http://localhost:5100}"
TOKEN="${JIMENG_TOKEN:-}"
OUT_DIR="${OUT_DIR:-}"
MODEL="${MODEL:-jimeng-4.0}"
EXPECT_MIN="${EXPECT_MIN:-1}"
NONCE="rv-$(date +%Y%m%d-%H%M%S)-$$"

[ -z "$TOKEN" ] && {
  echo "缺少 token。用法： JIMENG_TOKEN='<前缀>-<sessionid>' bash scripts/real_gen_verify.sh"
  echo "（前缀必须与账号真实区域一致：us- / jp- / hk- / sg- / cn-，错配会返回 34010105）"
  exit 2
}

PY="$(command -v python3 || command -v python || true)"
[ -z "$PY" ] && { echo "需要 python3（或 python）来解析响应 JSON"; exit 3; }

WORK="$(mktemp -d 2>/dev/null || echo ".realgen-tmp-$$")"
mkdir -p "$WORK"
REQ="$WORK/req.json"
RESP="$WORK/resp.json"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "########## real_gen_verify —— 真实生成层分层断言 ##########"
echo "  nonce    : $NONCE"
echo "  base     : $BASE"
echo "  model    : $MODEL"
echo "  out_dir  : ${OUT_DIR:-（未指定 → 只校验 URL 层）}"
echo

# ---------- 1. 构造请求（nonce 化，绕开配额护栏） ----------
"$PY" - "$NONCE" "$OUT_DIR" "$MODEL" > "$REQ" <<'PYEOF'
import json, sys
nonce, out_dir, model = sys.argv[1], sys.argv[2], sys.argv[3]
doc = "## 场景1\n一张极简的蓝色圆形图标，纯色背景，无文字。实验编号 %s\n" % nonce
body = {
    "doc": doc,
    "kind": "image",
    "model": model,
    "ratio": "1:1",
    "resolution": "1k",
    "max_items": 1,
    "consistency": False,
}
# 注意：mode 由编排层（batch.ts）内部强制传 "single"，无需 API 入参
if out_dir:
    body["out_dir"] = out_dir
json.dump(body, sys.stdout, ensure_ascii=False)
PYEOF

# ---------- 2. 发起真实生成 ----------
HTTP_CODE="$(curl -sS --noproxy '*' -o "$RESP" -w '%{http_code}' -X POST "$BASE/v1/agent/generate" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @"$REQ" 2>/dev/null || echo 000)"

case "$HTTP_CODE" in
  000) no "L1 请求成功 — HTTP 不可达（服务未启动？端口错？代理劫持？试试 --noproxy / 清 http_proxy 环境变量）" ;;
  2*)  ;;
  *)   no "L1 请求成功 — HTTP $HTTP_CODE（服务端网关层错误）" ;;
esac

# ---------- 3. 分层判定 ----------
if [ "$HTTP_CODE" != "000" ]; then
  VERDICT="$("$PY" - "$RESP" "$OUT_DIR" "$EXPECT_MIN" <<'PYEOF'
import glob, json, os, sys

resp_path, out_dir, expect_min = sys.argv[1], sys.argv[2], int(sys.argv[3])
out = []
def emit(layer, passed, msg):
    out.append("%s|%s|%s" % (layer, "PASS" if passed else "FAIL", msg))

raw = ""
if os.path.exists(resp_path):
    with open(resp_path, encoding="utf-8", errors="replace") as fh:
        raw = fh.read()

try:
    d = json.loads(raw)
except Exception as exc:
    emit("L1", False, "响应非 JSON（%s）；正文前 200 字：%s"
         % (exc, raw[:200].replace("\n", " ")))
    print("\n".join(out)); sys.exit(0)

# ---- L1 请求成功 ----
if isinstance(d, dict) and "code" in d and d.get("code") not in (0, None):
    emit("L1", False, "服务返回业务错误 code=%s message=%s"
         % (d.get("code"), str(d.get("message"))[:300]))
    print("\n".join(out)); sys.exit(0)
emit("L1", True, "请求成功（响应 code=0 / 无错误码）")

scenes = (d.get("scenes") or []) if isinstance(d, dict) else []
s0 = scenes[0] if scenes else {}
urls = s0.get("urls") or ([s0["url"]] if s0.get("url") else [])
files = s0.get("files") or ([s0["file"]] if s0.get("file") else [])
n_urls, n_files = len(urls), len(files)

# ---- L2 出图成功 ----
if n_urls >= 1:
    emit("L2", True, "scenes[0] 返回 URL 数 = %d（首图 %s）"
         % (n_urls, str(urls[0])[:80]))
else:
    emit("L2", False, "scenes[0] 无 URL；场景错误=%s（上游拒绝时看 fail_code：4013=风控）"
         % str(s0.get("error"))[:300])

# ---- L3 张数符合预期 ----
ok3 = (n_urls >= expect_min) and (n_files == n_urls)
detail = "上游 items=%d，服务端报告落盘=%d，期望>=%d" % (n_urls, n_files, expect_min)
if out_dir and os.path.isdir(out_dir):
    disk = len(glob.glob(os.path.join(out_dir, "*.png")))
    detail += "，磁盘实际 png=%d" % disk
    if disk != n_urls:
        ok3 = False
        detail += " ← 不一致（落盘实现缺陷）"
else:
    detail += "（out_dir 本地不可见，跳过磁盘核对）"
emit("L3", ok3, detail)

print("\n".join(out))
PYEOF
)"

  while IFS='|' read -r layer verdict msg; do
    [ -z "${layer:-}" ] && continue
    case "$layer" in
      L1) label="L1 请求成功    " ;;
      L2) label="L2 出图成功    " ;;
      L3) label="L3 张数符合预期" ;;
      *)  label="$layer" ;;
    esac
    if [ "$verdict" = "PASS" ]; then ok "$label — $msg"; else no "$label — $msg"; fi
  done <<< "$VERDICT"
fi

# ---------- 4. 汇总 ----------
echo
echo "########## 汇总 ##########"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "  分层判读：L1 过 / L2 挂 → 请求通、上游拒（查 fail_code，4013=风控）；"
echo "            L2 过 / L3 挂 → 出图了但张数不符（查落盘实现或上游行为变化）。"
if [ "$FAIL" -eq 0 ]; then
  echo "  ⇒ 真实生成层：全绿"
  exit 0
fi
echo "  ⇒ 真实生成层：存在失败项（退出码 1）"
exit 1
