# 构建阶段
FROM node:18-alpine AS builder

# 设置工作目录
WORKDIR /app

# 安装构建依赖（包括Python和make，某些npm包需要）
RUN apk add --no-cache python3 make g++

# 复制package文件以优化Docker层缓存
COPY package.json package-lock.json ./

# 安装所有依赖（包括devDependencies）
RUN npm ci --registry https://registry.npmmirror.com/

# 复制源代码
COPY . .

# 接收版本号参数并更新 package.json
ARG VERSION
RUN if [ -n "$VERSION" ]; then \
    echo "Updating package.json version to $VERSION"; \
    sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json; \
    cat package.json | grep version; \
    fi

# 构建应用
RUN npm run build

# 生产阶段
FROM node:18-alpine AS production

# 安装健康检查工具 + Python3/Pillow（去水印功能需要）
RUN apk add --no-cache wget python3 py3-pillow

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S jimeng -u 1001

# 设置工作目录
WORKDIR /app

# 复制 package.json（使用构建阶段已更新版本）与 package-lock.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# 只安装生产依赖
RUN npm ci --omit=dev --registry https://registry.npmmirror.com/ && \
    npm cache clean --force

# 从构建阶段复制构建产物
COPY --from=builder --chown=jimeng:nodejs /app/dist ./dist
COPY --from=builder --chown=jimeng:nodejs /app/configs ./configs
# 复制技能模板与去水印脚本（运行时需要，批量系列图 / 去水印功能依赖）
COPY --from=builder --chown=jimeng:nodejs /app/scripts ./scripts

# 创建应用需要的目录并设置权限
RUN mkdir -p /app/logs /app/tmp /app/output && \
    chown -R jimeng:nodejs /app/logs /app/tmp /app/output

# 设置环境变量
ENV SERVER_PORT=5100
# 批量系列图默认张数：**调用方未传 n 时**的兜底值（1 = 只出 1 张，避免 4 倍计费）。
# ⚠️ 2026-09-18 更正：本变量**已生效**。此前它只写进埋点区（报文缺 `abilities.gen_option.gen_count`），
# 上游因此取模型兜底值 4 → 表现为"恒出 4 张、扣 4 份"，该缺陷已修（见 payload-builder.ts 的 buildDraftContent）。
# 优先级：请求参数 n ＞ 本变量 ＞ 默认 1。
ENV JIMENG_BENEFIT_COUNT=1
ENV JIMENG_AGENT_OUT_DIR=/app/output
ENV JIMENG_STRIP_WM=auto
ENV JIMENG_PYTHON=python3
ENV JIMENG_WM_SCRIPT=/app/scripts/watermark_cli.py

# ⚠️ N-11（2026-09-18）：`/app/output` 在本镜像内属主为 jimeng，但**若被 bind mount 覆盖**，
# 属主由宿主目录决定；宿主目录不是 uid=1001 时，服务会因无写权而**静默落盘失败**（EACCES）。
# 部署侧已修：deploy.sh 每次都会把宿主 output/ 的属主校正为 1001，且接口在生成前做可写性预检（N-9）。

# 切换到非root用户
USER jimeng

# 暴露端口
EXPOSE 5100

# 健康检查
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q --spider http://localhost:5100/ping

# 启动应用
CMD ["npm", "start"]
