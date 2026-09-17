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
# 批量系列图：每请求生成 1 张（避免 4 倍计费）；输出目录；去水印默认 auto（CDN 图通常无水印，检测到才处理）
ENV JIMENG_BENEFIT_COUNT=1
ENV JIMENG_AGENT_OUT_DIR=/app/output
ENV JIMENG_STRIP_WM=auto
ENV JIMENG_PYTHON=python3
ENV JIMENG_WM_SCRIPT=/app/scripts/watermark_cli.py

# 切换到非root用户
USER jimeng

# 暴露端口
EXPOSE 5100

# 健康检查
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q --spider http://localhost:5100/ping

# 启动应用
CMD ["npm", "start"]
