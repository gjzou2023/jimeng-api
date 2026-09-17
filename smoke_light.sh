#!/usr/bin/env bash
# smoke_light.sh —— 真机轻量冒烟（零成本健康检查 + 少量真实生成）
# 前置：deploy.sh 已部署且 /ping 正常；token 通过环境变量 JIMENG_TOKEN 传入。
# 用法：
#   bash smoke_light.sh                 # 仅零成本健康检查（断言 1-5，不耗积分）
#   JIMENG_TOKEN='us-xxxx' bash smoke_light.sh   # 加真实生成（断言 6+7，约 1-3 积分）
#
# 设计目标：验证「服务起得来、路由/模型/技能/去水印就绪、真实 token 可用、真实生成路径通」。
# 与 verify.sh 全量（约 10 点）不同，本脚本仅做 2 个真实生成断言，符合「轻量冒烟」成本预期。
set -uo pipefail

cd "$(dirname "$0")" || { echo "无法进入脚本所在目录"; exit 1; }
BASE="${BASE_URL:-http://localhost:5100}"
TOKEN="${JIMENG_TOKEN:-}"
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

echo "== 3. /v1/models 可读 =="
if curl -fsS --noproxy '*' "$BASE/v1/models" >/dev/null 2>&1; then ok "/v1/models"; else no "/v1/models"; fi

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

echo "########## 第二层：轻量真实生成（断言 6 + 7，约 1-3 积分）##########"

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
    [ "$N" -ge 1 ] && ok "agent 生成并落盘 $N 张（编排链路通）" || no "agent 生成未落盘"
  else no "agent 生成失败（token 无效或真实接口异常）"; fi
  rm -rf ./verify_out "$DOCF"
else
  no "缺少 python3，无法跑 agent 生成"; fi

echo "== 7. 单图张数开关（默认 1，应 == JIMENG_BENEFIT_COUNT）=="
EXPECT="${JIMENG_BENEFIT_COUNT:-1}"
[ "$EXPECT" -gt 4 ] && EXPECT=4
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
  ok "单次生成返回 $N 张，与 JIMENG_BENEFIT_COUNT=$EXPECT 一致（开关生效）"
else
  no "单次生成返回 ${N:-?} 张，期望 $EXPECT 张（token 无效或服务未按预期启动）"
fi

echo
echo "SMOKE: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
