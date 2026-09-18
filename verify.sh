#!/usr/bin/env bash
# verify.sh —— jimeng-api（四模式 + Agent 增强版）部署后复测脚本
#
# 用途：独立、完整地验证「线上仓库部署」后的全部功能是否可用。
# 前置：服务已在 BASE_URL 启动（docker compose -f docker-compose.agent.yml up）。
#
# 用法：
#   bash verify.sh [BASE_URL] [TOKEN]
#   BASE_URL 默认 http://localhost:5100
#   TOKEN    可选；不传则跳过需要鉴权的生成类用例（仅跑健康检查/只读端点）
#
# ⚠️ 积分成本：提供 TOKEN 时，第 6/7/10/11/12/15 项会**真实调用生成接口**，
#   预计消耗约 10 张图片的积分（1k 分辨率，每张约 1 点）。
#   第 8/9/13/14 项在**参数校验阶段**即被拒绝，不消耗积分。
#
# 断言总览（共 15 项）：
#   1  /ping 健康检查                                  （零成本）
#   2  根端点暴露 agent 路由                            （零成本）
#   3  /v1/models 可读                                  （零成本）
#   4  技能模板库存在                                   （零成本）
#   5  去水印脚本可加载 (python3 + Pillow)              （零成本）
#   6  真实同步编排生成（doc → 系列图）                  （耗积分）
#   7  张数开关生效（单图默认 1）                        （耗积分）
#   8  组图缺数量必须被拒（mode:"group"）                （零成本）
#   9  组图超上限 16 必须被拒并说明上限 15               （零成本）
#  10  单图上限钳制（JIMENG_BENEFIT_COUNT=40 → ≤4）      （耗积分）
#  11  显式 mode:"single" 屏蔽组图（编排隔离断言）        （耗积分）
#  12  兼容模式不静默切换 + 返回可读 hint                （耗积分）
#  13  编排总量超限被拒（41 图 > 40）                    （零成本）
#  14  视频任务 cap 断言（kind=video → cap=8）           （零成本）
#  15  同提示词产出配额（第 5 次必须被拒）                （耗积分）
#
# 说明：第 10 项需服务以 JIMENG_BENEFIT_COUNT 启动；本脚本默认按 1 校验。
#   若服务以其他值启动（如 4），请以同值 export JIMENG_BENEFIT_COUNT 后再跑，
#   否则该项会如实报错——那恰恰说明开关生效了。
#   第 15 项若服务端已用 JIMENG_PROMPT_QUOTA_MAX=0 关闭配额，请同样 export 后再跑。
#
# 退出码：0 = 全部通过；非 0 = 有失败项。
set -uo pipefail

BASE="${1:-http://localhost:5100}"
TOKEN="${2:-}"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# 统一 POST JSON 的小工具（关闭代理，避免 http_proxy 劫持 localhost）
post_json(){ curl -sS --noproxy '*' -X POST "$1" \
  -H "Authorization: Bearer $2" -H 'Content-Type: application/json' -d "$3" 2>/dev/null; }

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
  # ⚠️ --doc 期望的是**文件路径**而非文档正文。历史版本把正文直接当参数传入，
  #    导致本项在客户端 open() 处即抛 OSError、永远不可能通过（2026-09-17 修正）。
  DOCF="./verify_doc.md"
  cat > "$DOCF" <<'EOF'
# 复测用例
## 场景一
一只橘猫趴在窗台，午后阳光
## 场景二
橘猫拨弄毛线球
EOF
  if python3 scripts/agent_client.py --url "$BASE" --token "$TOKEN" \
    --doc "$DOCF" --out ./verify_out --strip-wm 2>/dev/null; then
    N=$(ls ./verify_out/*.png 2>/dev/null | wc -l)
    [ "$N" -ge 1 ] && ok "agent 生成并落盘 $N 张" || no "agent 生成未落盘"
  else no "agent 生成失败"; fi
  rm -rf ./verify_out "$DOCF"
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 7. 单图张数开关（默认 1，应 == JIMENG_BENEFIT_COUNT）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  EXPECT="${JIMENG_BENEFIT_COUNT:-1}"
  [ "$EXPECT" -gt 8 ] && EXPECT=8   # 超过单图上限 MAX_SINGLE_IMAGE_COUNT(=8) 时按 8 钳制
  N=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
    '{"model":"jimeng-4.0","prompt":"一只白猫坐在窗台","ratio":"1:1","resolution":"1k"}' \
    | python3 -c "
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

echo "== 8. 组图缺数量必须被拒（mode:\"group\" + 无数量写法）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  # 注意：服务端业务错误以 HTTP 200 + {"code":-2000,"message":"..."} 返回，
  # 因此必须判 code 字段，不能用 HTTP 状态码判断。本用例在调用生成接口前即抛错，不消耗积分。
  V8=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
    '{"model":"jimeng-4.0","prompt":"绘本风格的小猫","ratio":"1:1","resolution":"1k","mode":"group"}' \
    | python3 -c '
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
    PASS)           ok "组图缺数量被拒绝，且说明含数量、形式不限与示例 (code=-2000)" ;;
    NO_COUNT_GUIDE) no "组图缺数量被拒绝，但说明未提及数量" ;;
    NO_FORM_GUIDE)  no "组图缺数量被拒绝，但说明未写明「位置与形式不限」" ;;
    NO_EXAMPLE)     no "组图缺数量被拒绝，但说明未给出写法示例" ;;
    *)              no "组图缺数量未被拒绝 (${V8:-无响应/无法解析})" ;;
  esac
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 9. 组图数量上限（16 张必须被拒并说明上限 15）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  V9=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
    '{"model":"jimeng-4.0","prompt":"生成16张连续的猫咪插画","ratio":"1:1","resolution":"1k","mode":"group"}' \
    | python3 -c '
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
if "15" not in msg:
    print("NO_LIMIT_VALUE")
elif "上限" not in msg:
    print("NO_LIMIT_WORD")
else:
    print("PASS")
' 2>/dev/null)
  case "$V9" in
    PASS)           ok "组图超上限 16 张被拒绝，且说明含上限数值 15 (code=-2000)" ;;
    NO_LIMIT_VALUE) no "组图超上限未被拒绝得清楚：说明未含上限数值 15" ;;
    NO_LIMIT_WORD)  no "组图超上限被拒绝，但说明未点明「上限」" ;;
    *)              no "组图超上限未被拒绝 (${V9:-无响应/无法解析})" ;;
  esac
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 10. 单图上限钳制（JIMENG_BENEFIT_COUNT 超上限时必须被钳到 8）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  # 以 mode:"single" 显式走单图路径；即便服务端 JIMENG_BENEFIT_COUNT=40，也不得超过 8 张。
  N10=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
    '{"model":"jimeng-4.0","prompt":"一只戴帽子的白色小狗在草地上","ratio":"1:1","resolution":"1k","mode":"single"}' \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('-1'); raise SystemExit
items = d.get('data') or d.get('images') or []
print(len(items) if isinstance(items, list) else '-1')
" 2>/dev/null)
  if [ "${N10:-0}" -ge 1 ] 2>/dev/null && [ "${N10:-99}" -le 8 ] 2>/dev/null; then
    ok "单图路径只返回 $N10 张（≤ MAX_SINGLE_IMAGE_COUNT=8），上限钳制生效"
  else
    no "单图路径返回 ${N10:-?} 张，超出单图上限 8（常量拆分未生效？）"
  fi
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 11. 编排隔离断言（显式 mode:\"single\" + jimeng-4.5 + 组图特征 → 只出 1 张）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  # 这正是 agent/batch.ts 调用图片生成的形态。旧实现下该提示词会被组图分支吞掉、
  # 返回 ≤15 张而编排层只取 urls[0] —— 多出的图已计费却静默丢弃（缺陷 #1）。
  N11=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
    '{"model":"jimeng-4.5","prompt":"生成4张连续的猫咪插画","ratio":"1:1","resolution":"1k","mode":"single"}' \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('-1'); raise SystemExit
items = d.get('data') or d.get('images') or []
print(len(items) if isinstance(items, list) else '-1')
" 2>/dev/null)
  if [ "${N11:-0}" = "1" ]; then
    ok "mode:\"single\" 成功屏蔽组图分支，只返回 1 张（编排层不再静默丢图）"
  elif [ "${N11:-0}" -gt 1 ] 2>/dev/null; then
    no "mode:\"single\" 未屏蔽组图：返回 ${N11} 张（编排层会静默丢弃 $((N11-1)) 张已计费结果）"
  else
    no "编排隔离用例失败 (${N11:-无响应/无法解析})"
  fi
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 12. 兼容模式不静默切换（无 mode + 组图特征 → 走单图并返回 hint）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  R12=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
    '{"model":"jimeng-4.5","prompt":"生成3张连续的小猫绘本故事插画","ratio":"1:1","resolution":"1k"}' 2>/dev/null)
  V12=$(printf '%s' "$R12" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL"); raise SystemExit
if not isinstance(d, dict):
    print("PARSE_FAIL"); raise SystemExit
if d.get("code") not in (None, 0):
    print("ERROR:" + str(d.get("code"))); raise SystemExit
items = d.get("data") or []
mode = d.get("mode")
hint = d.get("hint") or ""
if mode != "single":
    print("NOT_SINGLE:" + str(mode)); raise SystemExit
if len(items) != 1:
    print("COUNT:" + str(len(items))); raise SystemExit
if "mode" not in hint and "组图" not in hint:
    print("NO_HINT"); raise SystemExit
print("PASS")
' 2>/dev/null)
  case "$V12" in
    PASS)        ok "无 mode + 组图特征 → 按单图执行（1 张）并回可读 hint，未静默切换" ;;
    NO_HINT)     no "已按单图执行，但响应缺少可读 hint（调用方无从得知可用 mode:\"group\"）" ;;
    NOT_SINGLE:*) no "仍被静默切换到组图（mode=${V12#NOT_SINGLE:}），Q3=C1 未生效" ;;
    COUNT:*)     no "返回了 ${V12#COUNT:} 张，兼容模式应恒为单图 1 张" ;;
    *)           no "兼容模式用例失败 (${V12:-无响应/无法解析})" ;;
  esac
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 13. 编排总量上限（41 图场景 > 40 必须在生成前被拒）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  R13=$(python3 -c '
import json
doc = "\n".join("## 场景%d\n一只猫在窗台晒太阳" % i for i in range(1, 42))
print(json.dumps({"doc": doc, "kind": "image"}))
' | curl -sS --noproxy '*' -X POST "$BASE/v1/agent/tasks" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @- 2>/dev/null)
  TID=$(printf '%s' "$R13" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("task_id",""))
except Exception: print("")' 2>/dev/null)
  CAP13=$(printf '%s' "$R13" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("cap",""))
except Exception: print("")' 2>/dev/null)
  if [ -n "$TID" ]; then
    ST=""; MSG=""
    for ((i=0; i<15; i++)); do
      S=$(curl -sS --noproxy '*' "$BASE/v1/agent/tasks/$TID" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
      read -r ST MSG < <(printf '%s' "$S" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("? "); raise SystemExit
err = " ".join(str(x) for x in (d.get("errors") or []))
print((d.get("status") or "?") + " " + err.replace("\n", " "))
' 2>/dev/null)
      [ "$ST" = "failed" ] && break
      sleep 2
    done
    if [ "$ST" = "failed" ] && [ "$CAP13" = "40" ] \
       && printf '%s' "$MSG" | grep -q "上限" && printf '%s' "$MSG" | grep -q "40"; then
      ok "41 图编排在生成前被拒（status=failed, cap=40，说明含「上限」与 40），未消耗积分"
    else
      no "41 图编排未被正确拒绝（status=${ST:-?} cap=${CAP13:-?}）: ${MSG:0:120}"
    fi
  else
    no "异步任务提交未返回 task_id（响应: ${R13:0:160}）"
  fi
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 14. 视频任务 cap 断言（kind=video → cap=8）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  R14=$(python3 -c '
import json
doc = "\n".join("## 镜头%d\n一只猫跳上窗台" % i for i in range(1, 10))
print(json.dumps({"doc": doc, "kind": "video", "duration": 5}))
' | curl -sS --noproxy '*' -X POST "$BASE/v1/agent/tasks" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @- 2>/dev/null)
  V14=$(printf '%s' "$R14" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL"); raise SystemExit
if not isinstance(d, dict):
    print("PARSE_FAIL"); raise SystemExit
if not d.get("task_id"):
    print("NO_TASK_ID"); raise SystemExit
if d.get("kind") != "video":
    print("KIND:" + str(d.get("kind"))); raise SystemExit
if str(d.get("cap")) != "8":
    print("CAP:" + str(d.get("cap"))); raise SystemExit
print("PASS")
' 2>/dev/null)
  case "$V14" in
    PASS)        ok "kind=video 任务已受理，kind=video 且 cap=8（视频路径已接通，上限正确）" ;;
    KIND:*)      no "视频任务 kind 回显为 ${V14#KIND:}，未正确分派到视频路径" ;;
    CAP:*)       no "视频任务 cap 为 ${V14#CAP:}，期望 8（MAX_AGENT_VIDEO_COUNT）" ;;
    NO_TASK_ID)  no "视频任务提交未返回 task_id" ;;
    *)           no "视频任务用例失败 (${V14:-无响应/无法解析})" ;;
  esac
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo "== 15. 同提示词产出配额（第 5 次必须被拒，默认 JIMENG_PROMPT_QUOTA_MAX=4）=="
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  QMAX="${JIMENG_PROMPT_QUOTA_MAX:-4}"
  if [ "$QMAX" = "0" ]; then
    echo "  (跳过：服务端已用 JIMENG_PROMPT_QUOTA_MAX=0 关闭配额)"
  else
    # 用时间戳构造唯一提示词，避免与其他用例的历史配额互相干扰
    QP="配额复测专用提示词-$(date +%s)-一只戴围巾的橘猫"
    GEN=0
    for ((k=1; k<=QMAX; k++)); do
      C=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
        "{\"model\":\"jimeng-4.0\",\"prompt\":\"$QP\",\"ratio\":\"1:1\",\"resolution\":\"1k\",\"mode\":\"single\"}" \
        | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("code", 0))
except Exception: print("-99")' 2>/dev/null)
      [ "$C" = "0" ] && GEN=$((GEN+1))
    done
    V15=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
      "{\"model\":\"jimeng-4.0\",\"prompt\":\"$QP\",\"ratio\":\"1:1\",\"resolution\":\"1k\",\"mode\":\"single\"}" \
      | python3 -c '
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
print("PASS" if ("配额" in msg) else "NO_QUOTA_WORD")
' 2>/dev/null)
    case "$V15" in
      PASS)        ok "前 $GEN 次成功、第 $((QMAX+1)) 次被拒且说明含「配额」（防重试误刷生效）" ;;
      NO_QUOTA_WORD) no "第 $((QMAX+1)) 次被拒，但说明未点明「配额」，调用方无法自查" ;;
      *)           no "第 $((QMAX+1)) 次未被拒绝 (${V15:-无响应/无法解析})，配额护栏未生效" ;;
    esac
  fi
else
  echo "  (跳过：未提供 TOKEN 或缺少 python3)"; fi

echo ""
echo "VERIFY: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
