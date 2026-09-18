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
- 第二层确认：真实 token 可用、真实生成路径通、Agent 编排链路通、**单图张数开关生效**
  （请求体 `n`，**1–8**，默认 1）。
  > ⚠️ **2026-09-18 口径更正**：原文写「不传 `n` 时上游按模型兜底产出 4 张并扣 4 份」——
  > 那是**报文缺 `abilities.gen_option.gen_count`** 时，上游取模型兜底值 `default_generate_count = 4`
  > 的表现，**不是上游固有行为**；该缺陷已修（C-1，见 `AGENT_FEATURES.md`）。
  > 现在未传 `n` 时，服务端按 `JIMENG_BENEFIT_COUNT`（默认 1）下发 ⇒ **默认只出 1 张、扣 1 份**。
  > 单图**上限为 8**（`MAX_SINGLE_IMAGE_COUNT`），越界**明确报错**而非静默截断。

### 落盘目录属主（N-11，必查）

容器内服务以 **uid 1001（`jimeng`）** 运行，而 `./output` 以 bind mount 挂进容器时
属主由**宿主机目录**决定 → 若不是 1001，服务**无写权**，落盘会 **EACCES 静默失败**
（图已生成、已计分，却没存下来）。

`deploy.sh` 已内置幂等修复：

```bash
mkdir -p output
sudo chown 1001:1001 output && chmod 755 output     # deploy.sh 每次部署都会执行
```

自检（返回 `WRITE_OK` 才算通）：

```bash
docker compose -f docker-compose.agent.yml exec -T jimeng-api-agent \
  sh -c 'touch /app/output/.wtest && rm /app/output/.wtest && echo WRITE_OK'
```

> 服务端另有**生成前预检**（N-9）：`out_dir` 不可写时**在调用上游之前**就报错返回，
> **不消耗积分**，并给出可直接执行的 `chown` 修复命令。

### 任务快照目录（N-12，必查）

**产物目录 ≠ 状态目录**，二者职责不同、排查入口也不同：

| 目录 | 存什么 | 不可写的症状 | 修复 |
|---|---|---|---|
| `/app/output` | 生成出来的**图片/视频** | 图出不来；日志 `EACCES`（N-11） | `chown 1001:1001 <宿主 output>` |
| `/app/.jimeng-agent-tasks` | **任务状态 JSON**（供 `GET /v1/agent/tasks` 跨重启恢复） | 图正常，但**重启后任务列表丢失**；日志 `任务快照落盘失败`（N-12） | 见下 |

`Dockerfile` 已创建该目录并 `chown jimeng:nodejs`，且以 `ENV JIMENG_AGENT_TASK_DIR` 显式指路；
`docker-compose.agent.yml` 亦设同名变量（**只 `up -d` 即可生效，无需重建镜像**）。

自检（两条都过才算通）：

```bash
# ① 目录存在且属主为 jimeng
docker compose -f docker-compose.agent.yml exec -T jimeng-api-agent \
  ls -ld /app/.jimeng-agent-tasks

# ② 以服务同一 uid 做真写真删探针（等价于 N-9 的探针思路）
docker exec -u 1001 jimeng-api-agent \
  sh -c 'touch /app/.jimeng-agent-tasks/.probe && rm /app/.jimeng-agent-tasks/.probe && echo WRITE_OK'
```

> ⚠️ 状态目录**不要**做 bind mount —— 宿主机上并无对应物，且会再次踩 N-11 的属主坑。

### 落盘路径铁律：`out_dir` 必须是**容器内**路径

调用 `/v1/agent/*` 时，`out_dir` 由**容器内服务进程**解析，因此：

- ✅ 正确：`out_dir = "/app/output/batch1"`
- ❌ 错误：`out_dir = "/home/ubuntu/jimeng-api-release/output/batch1"`（宿主机路径）

**宿主机路径在容器内不存在**，`assertWritableDir` 会判定为"创建失败"（EACCES）并**在生成前中止**
（这正是 N-9 的设计意图，0 积分）。若要在宿主机侧准备目录，**必须用容器身份**：

```bash
sudo docker exec -u 1001 jimeng-api-agent mkdir -p /app/output/batch1
```

计数与检查也要走容器：

```bash
sudo docker exec jimeng-api-agent sh -c 'find /app/output/batch1 -type f | wc -l'
```

> **踩坑留痕（2026-09-18）**：真实生成回归脚本曾在**宿主**（`ubuntu`, uid=1000）执行
> `mkdir output/_vc_probe`，而宿主 `output/` 属主为 `lighthouse(uid=1001)` 755 → EACCES。
> 结果是：N-9 **意外正确地工作**（生成前拦下、0 积分），但 **N-11 的落盘能力当次并未被验到**。
> 判读时切勿把"预检拦下"误读成"落盘失败"。

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
