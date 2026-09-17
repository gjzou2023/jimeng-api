# jimeng-api（四模式 + Agent 增强版）真机部署与轻量冒烟指南

本目录 `jimeng-api-release/` 是一棵**既完整又最新**的可部署源码树：
- 基底 = GitHub `gjzou2023/jimeng-api` 当前快照（完整 Koa + tsup 框架）
- 叠加了本地最新增强：`src/agent/tasks.ts`（S6 异步任务层）、`src/api/guards/prompt-quota.ts`（S4 配额护栏），以及 6 个差异文件（batch / payload-builder / images / routes 等）。
- **已本地验证**：`npm install` + `npm run build`（tsup）通过；离线变异测试 13/13。
- **不含任何凭证**：`sessions.json` 等 token 文件**未进入本目录**，也不会被提交。

## 一、凭证模型（重要，避免踩坑）

服务端 `gjzou2023/jimeng-api` 是**无状态代理**：
- 它**不读取也不存储** `sessions.json`；
- token 由**调用方**在每次请求经 `Authorization: Bearer <token>` 传入（`src/api/controllers/core.ts` 拼接 `sessionid=`，`src/api/routes/agent.ts` 支持多账号 `proxy@region-sessionid` 形式）；
- 因此**服务器上不需要放 `sessions.json`**——那是你本地 `gjzou-jimeng-api` skill 的客户端轮换文件，与部署无关。

冒烟时只需一个真实 token（即梦 sessionid，**必须带区域前缀**：`us-` / `jp-` / `cn-`，前缀须与账号真实区域一致，错配恒报 `34010105 login error`）。

## 二、部署步骤（在 Lighthouse 服务器上）

```bash
# 1. 把本目录传到服务器（任选其一，见下方「传输方式」）
# 2. 进入目录
cd jimeng-api-release
# 3. 一键构建 + 启动 + 等健康
bash deploy.sh
```

`deploy.sh` 会执行 `docker compose -f docker-compose.agent.yml up -d --build`（镜像内 `npm ci` + `npm run build`），并轮询 `/ping` 直到就绪。

## 三、轻量冒烟（在服务器上，建议先零成本再真实）

```bash
# 第一层：零成本健康检查（断言 1-5，不耗积分）
bash smoke_light.sh

# 第二层：加真实生成（断言 6+7，约 1-3 积分）
export JIMENG_TOKEN='us-<你的即梦sessionid>'
bash smoke_light.sh
```

- 第一层确认：服务起得来、agent 路由暴露、`/v1/models` 可读、技能模板库存在、去水印加载器（python3+Pillow）就绪。
- 第二层确认：真实 token 可用、真实生成路径通、Agent 编排链路通、单图张数开关生效。

> 如需跑**全量** 15 项断言（约 10 积分，含组图上限/视频 cap/配额护栏等），用仓库自带脚本：
> `bash verify.sh http://localhost:5100 "$JIMENG_TOKEN"`

## 四、传输方式（如何把本目录弄到服务器）

| 通道 | 做法 |
|---|---|
| SSH/SCP（若服务器 22 端口可达） | `scp -r jimeng-api-release/ user@43.134.47.240:~/` |
| Lighthouse 控制台 / 网页终端 | 在腾讯云控制台用「终端」或「文件」功能上传目录 |
| 先推 GitHub 再 `git clone` | 见 `push_to_gh.py` / 下方说明（推送后服务器 `git clone gjzou2023/jimeng-api`） |

## 五、推送（可选，交付到 GitHub 主仓）

`E:\Workbuddy工作空间\2026-09-17-10-31-01\push_to_gh.py` 当前写死推送源为 `jimeng-api-stage`（不完整旧副本）。
正式推送前需把该脚本的 `STAGE` 改为本目录 `jimeng-api-release`，并确保：
- `GH_TOKEN` 环境变量可用；
- 目标仓库/分支 `gjzou2023/jimeng-api@main` 正确；
- **绝不包含 `sessions.json` 等凭证**（本目录已确保不含）。
