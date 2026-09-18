#!/usr/bin/env bash
# smoke_light.sh —— 真机轻量冒烟（零成本健康检查 + 少量真实生成）
# 前置：deploy.sh 已部署且 /ping 正常；token 通过环境变量 JIMENG_TOKEN 传入。
# 用法：
#   bash smoke_light.sh                 # 仅零成本健康检查（断言 1-5，不耗积分）
#   JIMENG_TOKEN='us-xxxx' bash smoke_light.sh   # 加真实生成（断言 6+7，约 3 积分）
#
# 设计目标：验证「服务起得来、路由/模型/技能/去水印就绪、真实 token 可用、真实生成路径通、
#           张数开关生效」。与 verify.sh 全量（约 10 点）不同，本脚本仅做 2 个真实生成断言。
#
# ⚠️ 2026-09-18 变更：断言 7 的判据从"区间 1..4"改为"**张数 == 请求的 n**"。
#   为什么改：旧判据建立在"上游固有产出 4 张、无参数可减"这个**已被证伪**的结论上
#   （真因是报文缺 `abilities.gen_option.gen_count`，已修）。现在 n 是可控量，
#   就应该按"所言即所得"来判——否则修复失效也不会被发现（假验收）。
set -uo pipefail

cd "$(dirname "$0")" || { echo "无法进入脚本所在目录"; exit 1; }
BASE="${BASE_URL:-http://localhost:5100}"
TOKEN="${JIMENG_TOKEN:-}"
# 冒烟默认用 1 分/张的模型（jimeng-4.0）；5.0-lite 为 3 分/张
SMOKE_MODEL="${SMOKE_MODEL:-jimeng-4.0}"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
post_json(){ curl -sS --noproxy '*' -X POST "$1" \
  -H "Authorization: Bearer $2" -H 'Content-Type: application/json' -d "$3" 2>/dev/null; }

echo "########## 第一层：零成本健康检查（断言 1-5）##########"

echo "== 1. /ping 健康检查 =="
if curl -fsS --noproxy '*' "$BASE/ping" >/dev/null 2>&1; then ok "/ping"; else no "/ping 不可达"; fi

echo "== 2. 根端点暴露 agent 路由 =="
if curl -fsS --noproxy '*' "$BASE/" 2>/dev/null | grep -q '/v1/agent/generate'; then
  ok "根端点列出 /v1/agent/generate"; else no "根端点缺少 agent 路由"; fi

echo "== 3. /v1/models 可读且含图片模型 =="
# ⚠️ 2026-09-18（C-6）：此前 /v1/models 只有 4 个视频模型、**一个图片模型都没有**，
# 而图片恰是官网默认入口 → 调用方无从发现可选模型。这里一并断言"清单里有图片模型"。
MODELS_JSON=$(curl -fsS --noproxy '*' "$BASE/v1/models" 2>/dev/null || echo '{}')
IMG_N=$(echo "$MODELS_JSON" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
print(len([m for m in d.get('data', []) if m.get('type') == 'image']))
" 2>/dev/null || echo -1)
if [ "$IMG_N" = "-1" ]; then no "/v1/models 不可读或非 JSON"
elif [ "$IMG_N" -ge 5 ]; then ok "/v1/models 含 ${IMG_N} 个图片模型"
else no "/v1/models 图片模型仅 ${IMG_N} 个（应 ≥5；C-6 回归？）"; fi

echo "== 4. 技能模板库存在 =="
if [ -d scripts/skills ] && [ "$(ls scripts/skills/*.md 2>/dev/null | wc -l)" -gt 0 ]; then
  ok "技能模板 $(ls scripts/skills/*.md 2>/dev/null | wc -l) 个"; else no "技能模板库为空"; fi

echo "== 5. 去水印脚本可加载 (容器内 python3 + Pillow) =="
# 去水印由容器内运行环境执行（Dockerfile 安装 py3-pillow，JIMENG_WM_SCRIPT 指向 /app/scripts/watermark_cli.py），
# 故优先校验容器；仅在无容器时退回校验宿主（兼容非 docker 部署）。宿主装没装 Pillow 与 API 去水印能力无关。
CONTAINER=""
if command -v docker >/dev/null 2>&1; then
  CONTAINER=$(docker compose -f docker-compose.agent.yml ps -q 2>/dev/null | head -1)
  [ -z "$CONTAINER" ] && CONTAINER=$(docker ps -q --filter "name=jimeng-api-agent" 2>/dev/null | head -1)
fi
PIL_OK=0
if [ -n "$CONTAINER" ] && docker exec "$CONTAINER" python3 -c "import PIL" >/dev/null 2>&1; then
  PIL_OK=1
elif command -v python3 >/dev/null 2>&1 && python3 -c "import PIL" >/dev/null 2>&1; then
  PIL_OK=1
fi
if [ "$PIL_OK" -eq 1 ]; then ok "python3 + Pillow 就绪（去水印可用）"; else no "python3/Pillow 缺失，去水印不可用"; fi

echo
if [ -z "$TOKEN" ]; then
  echo "########## 第二层：跳过（未设置 JIMENG_TOKEN）##########"
  echo "提示：export JIMENG_TOKEN='<带区域前缀的即梦sessionid>' 后重跑，"
  echo "      将额外验证「真实 token 可用 + 真实生成路径 + Agent 编排 + 单图张数开关」。"
  echo
  echo "SMOKE(零成本): $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

echo "########## 第二层：轻量真实生成（断言 6 + 7）##########"
# 成本口径（2026-09-18 更正）：张数开关已修复 → 每个请求产出 = n（默认 1）。
#   本层 ≈ (2 场景 × 1) + (1 请求 × 1) = 3 张；
#   用 $SMOKE_MODEL（jimeng-4.0 = 1 分/张）≈ 3 积分。
#   ⚠️ 若改用 5.0-lite（3 分/张）则约 9 积分。分层回归详见 scripts/real_gen_verify.sh。
echo "  模型：$SMOKE_MODEL（改 SMOKE_MODEL=环境变量可换）"

echo "== 6. 真实 Agent 编排生成（doc → 系列图，需 TOKEN）=="
if command -v python3 >/dev/null 2>&1; then
  rm -rf ./verify_out
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
    # 2 个场景 × n(默认 1) = 期望 2 张；至少 1 张才算"链路通"
    [ "$N" -ge 1 ] && ok "agent 生成并落盘 $N 张（编排链路通；期望 2 = 2 场景 × 默认 n=1）" || no "agent 生成未落盘"
  else no "agent 生成失败（token 无效或真实接口异常）"; fi
  rm -rf ./verify_out "$DOCF"
else
  no "缺少 python3，无法跑 agent 生成"; fi

# ⚠️ 2026-09-18 判据变更（推翻本处旧断言）：
#   旧断言：「返回张数 == JIMENG_BENEFIT_COUNT」→ 当时被证伪（上游固定出 4 张），
#           遂改为宽松的"区间 1..4"，但那会**掩盖修复失效**（4 张也算"在区间内"）。
#   真因已查明并修复：报文缺 `component_list[0].abilities.gen_option.gen_count`。
#   现在 n 是可控量 → 判据回到**严格等式**：返回张数必须 == 请求的 n。
#   这既是修复的验收，也是上游行为的哨兵：一旦上游又忽略 gen_count，本断言立刻变红。
echo "== 7. 单图张数开关断言（严格：返回张数 == 请求的 n）=="
EXPECT="${SMOKE_N:-1}"
N=$(post_json "$BASE/v1/images/generations" "$TOKEN" \
  "{\"model\":\"$SMOKE_MODEL\",\"prompt\":\"一只白猫坐在窗台，编号 $(date +%s)\",\"ratio\":\"1:1\",\"resolution\":\"1k\",\"n\":$EXPECT}" \
  | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('-1'); raise SystemExit
if isinstance(d, dict) and d.get('code') not in (0, None):
    print('-2'); raise SystemExit
items = d.get('data') or d.get('images') or []
print(len(items) if isinstance(items, list) else '-1')
" 2>/dev/null)
if [ -z "$N" ] || [ "$N" = "-1" ]; then
  no "单图请求失败：响应不可解析（token 无效 / 服务未就绪 / 上游拒绝，看 fail_code）"
elif [ "$N" = "-2" ]; then
  no "单图请求被业务错误拒绝（模型不支持 / 风控 / 积分不足，看服务日志）"
elif [ "$N" -lt 1 ]; then
  no "单图请求成功但未出图（items=0）"
elif [ "$N" -ne "$EXPECT" ]; then
  no "张数开关未生效：请求 n=$EXPECT，实际返回 $N 张 —— 检查报文 abilities.gen_option.gen_count（C-1 回归？）"
else
  ok "单图请求成功：请求 n=$EXPECT，实际返回 $N 张 —— 张数开关生效"
fi

echo
echo "SMOKE: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
