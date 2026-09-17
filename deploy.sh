#!/usr/bin/env bash
# deploy.sh —— 在 Lighthouse 服务器上构建并启动 jimeng-api（四模式 + Agent 增强版）
# 用法：把 jimeng-api-release/ 整目录传到服务器后，进入该目录执行：
#   bash deploy.sh
# 说明：仅做「docker compose 构建 + 启动 + 等 /ping 健康」，不触碰任何凭证。
#       凭证（token）由冒烟脚本在调用时通过环境变量 JIMENG_TOKEN 传入，绝不写入镜像或仓库。
set -uo pipefail

cd "$(dirname "$0")" || { echo "无法进入脚本所在目录"; exit 1; }
echo "==> 工作目录: $(pwd)"

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
