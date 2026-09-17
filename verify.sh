#!/usr/bin/env bash
# verify.sh —— jimeng-api (agent 增强版) 部署后复测脚本
#
# 用途：独立、完整地验证「线上仓库部署」后的全部功能是否可用。
# 前置：服务已在 BASE_URL 启动（docker compose -f docker-compose.agent.yml up）。
#
# 用法：
#   bash verify.sh [BASE_URL] [TOKEN]
#   BASE_URL 默认 http://localhost:5100
#   TOKEN    可选；不传则跳过需要鉴权的生成类用例（仅跑健康检查/只读端点）
#
# 张数开关校验：第 7 项断言「单次生成张数 == JIMENG_BENEFIT_COUNT（默认 1）」。
#   若服务以其他值启动（如 JIMENG_BENEFIT_COUNT=4），请以同值 export 后再跑本脚本，
#   否则该项会如实报错——那恰恰说明开关生效了。
# 第 8 项断言「多图路径（jimeng-4.x + 连续/绘本/故事关键词）未写数量时必须被拒绝，
#   且错误信息含数量说明、并写明"位置与形式不限"与示例」。该用例在调用生成接口前即抛错，不消耗积分。
# 第 9 项断言「多图数量超过上限 40 张时必须被拒绝，且错误信息含上限数值」。同样不消耗积分。
#
# 退出码：0 = 全部通过；非 0 = 有失败项。
set -uo pipefail

BASE="${1:-http://localhost:5100}"
TOKEN="${2:-}"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "== 1. /ping 健康检查 =="
if curl -fsS --noproxy '*' "$BASE/ping" >/dev/null 2>&1; then ok "/ping"; else no "/ping 不可达"; fi

echo "== 2. 根端点是否暴露 agent 路由 =="
if curl -fsS --noproxy '*' "$BASE/" 2>/dev/null | grep -q '/v1/agent/generate'; then
  ok "根端点列出 /v1/agent/generate"; else no "根端点缺少 agent 路由"; fi

echo "== 3. /v1/models 可读 =="
if curl -fsS --noproxy '*' "$BASE/v1/models" >/dev/null 2>&1; then ok "/v1/models"; else no "/v1/models"; fi

echo "== 4. 技能模板库存在 =="
if [ -d scripts/skills ] && [ "$(ls scripts/skills/*.md 2>/dev/null | wc -l)" -gt 0 ]; then
  ok "技能模板 $(ls scripts/skills/*.md 2>/dev/null | wc -l) 个"; else no "技能模板库为空"; fi

echo "== 5. 去水印脚本可加载 (python3 + Pillow) =="
if command -v python3 >/dev/null 2>&1 && python3 -c "import PIL; print(1)" >/dev/null 2>&1; then
  ok "python3 + Pillow 就绪"; else no "python3/Pillow 缺失，去水印不可用"; fi

echo "== 6. 真实批量生成 (doc → 系列图, 需 TOKEN) =="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  rm -rf ./verify_out
  if python3 scripts/agent_client.py --url "$BASE" --token "$TOKEN" \
    --doc '# 复测用例
## 场景一
一只橘猫趴在窗台，午后阳光
## 场景二
橘猫拨弄毛线球' --out ./verify_out --strip-wm 2>/dev/null; then
    N=$(ls ./verify_out/*.png 2>/dev/null | wc -l)
    [ "$N" -ge 1 ] && ok "agent 生成并落盘 $N 张" || no "agent 生成未落盘"
  else no "agent 生成失败"; fi
  rm -rf ./verify_out
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 7. 张数开关生效（单次生成张数应 == JIMENG_BENEFIT_COUNT，默认 1）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  EXPECT="${JIMENG_BENEFIT_COUNT:-1}"
  RESP=$(curl -fsS --noproxy '*' -X POST "$BASE/v1/images/generations" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"model":"jimeng-4.0","prompt":"一只白猫坐在窗台","ratio":"1:1","resolution":"1k"}' 2>/dev/null)
  N=$(printf '%s' "$RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('-1'); raise SystemExit
items = d.get('data') or d.get('images') or []
print(len(items) if isinstance(items, list) else '-1')
" 2>/dev/null)
  if [ "$N" = "$EXPECT" ]; then
    ok "单次生成返回 $N 张，与 JIMENG_BENEFIT_COUNT=$EXPECT 一致"
  else
    no "单次生成返回 ${N:-?} 张，期望 $EXPECT 张（开关未生效或服务未按预期启动）"
  fi
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 8. 多图路径强制数量（缺数量必须报错并给出数量说明）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  # 注意：服务端业务错误以 HTTP 200 + {"code":-2000,"message":"..."} 返回，
  # 因此必须判 code 字段，不能用 HTTP 状态码判断。本用例在调用生成接口前即抛错，不消耗积分。
  R8=$(curl -sS --noproxy '*' -X POST "$BASE/v1/images/generations" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"model":"jimeng-4.0","prompt":"绘本风格的小猫","ratio":"1:1","resolution":"1k"}' 2>/dev/null)
  V8=$(printf '%s' "$R8" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL"); raise SystemExit
if not isinstance(d, dict):
    print("PARSE_FAIL"); raise SystemExit
code = d.get("code")
if code != -2000:
    print("NOT_REJECTED:" + str(code)); raise SystemExit
msg = str(d.get("message") or "")
if "张" not in msg:
    print("NO_COUNT_GUIDE")
elif "位置与形式不限" not in msg:
    print("NO_FORM_GUIDE")
elif "例如" not in msg:
    print("NO_EXAMPLE")
else:
    print("PASS")
' 2>/dev/null)
  case "$V8" in
    PASS)           ok "多图缺数量被拒绝，且说明含数量、形式不限与示例 (code=-2000)" ;;
    NO_COUNT_GUIDE) no "多图缺数量被拒绝，但说明未提及数量" ;;
    NO_FORM_GUIDE)  no "多图缺数量被拒绝，但说明未写明「位置与形式不限」" ;;
    NO_EXAMPLE)     no "多图缺数量被拒绝，但说明未给出写法示例" ;;
    *)              no "多图缺数量未被拒绝 (${V8:-无响应/无法解析})" ;;
  esac
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 9. 多图数量上限（超过 40 张必须被拒绝并说明上限）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  R9=$(curl -sS --noproxy '*' -X POST "$BASE/v1/images/generations" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"model":"jimeng-4.0","prompt":"生成41张连续的猫咪插画","ratio":"1:1","resolution":"1k"}' 2>/dev/null)
  V9=$(printf '%s' "$R9" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL"); raise SystemExit
if not isinstance(d, dict):
    print("PARSE_FAIL"); raise SystemExit
code = d.get("code")
if code != -2000:
    print("NOT_REJECTED:" + str(code)); raise SystemExit
msg = str(d.get("message") or "")
if "40" not in msg:
    print("NO_LIMIT_VALUE")
elif "上限" not in msg:
    print("NO_LIMIT_WORD")
else:
    print("PASS")
' 2>/dev/null)
  case "$V9" in
    PASS)           ok "超上限 41 张被拒绝，且说明含上限数值 40 (code=-2000)" ;;
    NO_LIMIT_VALUE) no "超上限未被拒绝得清楚：说明未含上限数值 40" ;;
    NO_LIMIT_WORD)  no "超上限被拒绝，但说明未点明「上限」" ;;
    *)              no "超上限未被拒绝 (${V9:-无响应/无法解析})" ;;
  esac
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo ""
echo "VERIFY: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
