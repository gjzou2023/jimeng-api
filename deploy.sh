#!/usr/bin/env bash
# deploy.sh —— 在 Lighthouse 服务器上构建并启动 jimeng-api（四模式 + Agent 增强版）
# 用法：把 jimeng-api-release/ 整目录传到服务器后，进入该目录执行：
#   bash deploy.sh
# 说明：仅做「docker compose 构建 + 启动 + 等 /ping 健康」，不触碰任何凭证。
#       凭证（token）由冒烟脚本在调用时通过环境变量 JIMENG_TOKEN 传入，绝不写入镜像或仓库。
set -uo pipefail

cd "$(dirname "$0")" || { echo "无法进入脚本所在目录"; exit 1; }
echo "==> 工作目录: $(pwd)"

# ── N-11 修复（2026-09-18）：落盘目录属主校正 ─────────────────────────────
# 症状（已在线上复现）：compose 把 ./output bind mount 到 /app/output，
# 若宿主 output/ 不存在，Docker 会以 root:root 创建它；而容器内服务以
# jimeng(uid=1001) 运行 → 目录不可写 → 落盘 **静默失败**（日志 EACCES），
# 但 HTTP 接口仍返回 url，调用方以为保存成功。这是最危险的"假成功"。
# 对策：每次部署都幂等地把 output/ 属主校正为容器内服务用户 uid=1001。
# 为什么放这里而不是只手工 chown 一次：重装/重新解包会重置属主 → 必须可重复。
mkdir -p output
chmod 755 output 2>/dev/null || true
if [ "$(stat -c %u output 2>/dev/null)" != "1001" ]; then
  echo "==> [N-11] 校正 output/ 属主为 1001:1001（容器内服务用户 jimeng）..."
  if sudo -n chown 1001:1001 output 2>/dev/null || chown 1001:1001 output 2>/dev/null; then
    echo "✓ output/ 属主已校正"
  else
    echo "⚠️  output/ 属主校正失败 —— 落盘可能静默失败，请手工执行： sudo chown 1001:1001 output"
  fi
fi
[ "$(stat -c %u output 2>/dev/null)" = "1001" ] \
  && echo "✓ output/ 属主 = 1001（可写）" \
  || echo "⚠️  output/ 属主 ≠ 1001（落盘有风险）"

echo "==> docker compose 构建并后台启动 (jimeng-api-agent) ..."
docker compose -f docker-compose.agent.yml up -d --build
BUILD_RC=$?
[ $BUILD_RC -ne 0 ] && { echo "✗ docker compose 构建/启动失败 (rc=$BUILD_RC)"; exit $BUILD_RC; }

echo "==> 等待 /ping 健康检查 (最多 90s) ..."
OK=0
for i in $(seq 1 30); do
  if curl -fsS --noproxy '*' http://localhost:5100/ping >/dev/null 2>&1; then
    echo "✓ 服务健康 (第 $i 次探测成功)"; OK=1; break
  fi
  sleep 3
done
[ $OK -eq 0 ] && { echo "✗ 90s 内 /ping 未就绪，请查 docker compose logs -f"; exit 1; }

echo
echo "==> 容器状态 =="
docker compose -f docker-compose.agent.yml ps
echo
echo "==> 部署完成。继续真机冒烟（轻量，约 1-3 积分）："
echo "    export JIMENG_TOKEN='<即梦sessionid，需带区域前缀 us-/jp-/cn->'"
echo "    bash smoke_light.sh"
