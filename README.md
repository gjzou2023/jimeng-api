# jimeng-api 四模式 + Agent 编排 交接包

## 项目背景
在 `gjzou2023/jimeng-api`（即梦 AI 逆向 API，Koa+tsup，:5100）基础上，
内置「批量系列图 / 模板库 / 一致性 / 去水印」四项自包含增强，
并新增**四模式架构**与**Agent 异步编排层**：

| 模式 | 触发 | 上限 | 说明 |
|------|------|------|------|
| M1 单图 | 默认；`mode:"single"` | **8** | 请求体 `n` 决定实际张数（默认 1）。`n` 落进报文 `abilities.gen_option.gen_count`——**与官网「图片 5.0 Lite」可选 1–8 张一致**；`JIMENG_BENEFIT_COUNT` 仅兜底（`n` 缺省时生效） |
| M2 单视频 | 默认 | 1（按提示词配额） | 配额护栏 ≤4 |
| M3 组图 | 显式 `mode:"group"` | 15 | 提示词必须显式写张数（1–15） |
| M4 Agent 编排 | 显式调用 `/v1/agent/*` | 40图 / 8视频 | 异步任务，`task_id` + 逐项落盘；每场景张数可由 `n` 指定 |

> **默认模型**：国内站 = `jimeng-5.0-lite`（内部键 `high_aes_general_v50`，对应官网「图片 5.0 Lite」）；
> 国际站暂维持 `jimeng-4.5`（US 站 5.0 Lite 未取证，见 AGENT_FEATURES.md §回炉记录）。
> `GET /v1/models` 可列出全部可用图片/视频模型及区域。

## 目录结构
```
jimeng-api-agent-modes-handoff/
├── README.md                     ← 本文件
├── HANDOFF.md                   ← 交接清单（已完成 / 遗留 / 卡点根因）
├── verify.sh                    ← 15 项部署后复测脚本
├── AGENT_FEATURES.md            ← Agent 功能说明（含四模式对照表）
├── Dockerfile                   ← 生产镜像（含 py3-pillow + scripts/ 拷贝）
├── Caddyfile                    ← 反向代理（含 Agent 路由）
├── docker-compose.agent.yml     ← 部署编排
├── scripts/
│   ├── agent_client.py          ← 客户端（--kind/--duration/--async/--wait/--mode）
│   ├── verify_mutation_test.py  ← 变异测试（13 变异 × 15 断言，离线零积分）
│   ├── watermark_core.py        ← 去水印核心（PIL）
│   ├── watermark_cli.py         ← 去水印 CLI 入口
│   └── skills/                  ← 4 个财税场景模板
│       ├── 世界观美术设定.md
│       ├── 电商套图.md
│       ├── 系列套图.md
│       └── 角色设计.md
└── src/
    ├── agent/
    │   ├── batch.ts             ← Agent 编排层（并发 2 / 串行视频 / 重试）
    │   ├── tasks.ts            ← 异步任务层（task_id + 逐项落盘 + JSON 原子写）
    │   ├── markdown.ts         ← .md/.txt 文档解析
    │   └── skills.ts          ← 模板库加载
    ├── api/
    │   ├── builders/payload-builder.ts   ← 常量拆分（4/15/40/8）+ mode 路由
    │   ├── controllers/images.ts         ← generateImages(mode, quotaMode) + hint
    │   ├── controllers/videos.ts         ← 视频生成（配额护栏接入）
    │   ├── guards/prompt-quota.ts        ← 同提示词配额（≤4，原子写，TTL 清理）
    │   ├── routes/agent.ts              ← POST /generate（同步） + /tasks（异步）
    │   ├── routes/images.ts             ← 单图/组图/兼容模式路由
    │   ├── routes/videos.ts             ← 视频路由
    │   ├── routes/index.ts              ← 路由聚合
    │   └── ...
    └── lib/
        ├── server.ts            ← Koa 服务
        ├── initialize.ts        ← 初始化
        └── request/Request.ts   ← 请求封装
```

## 运行方法

### 1. 本地直接跑（Node 22+ 支持 TS 类型剥离）
```bash
cd <stage>
# 语法检查
node --experimental-strip-types --check src/api/builders/payload-builder.ts
# 类型检查（需 node_modules）
npx tsc --noEmit
```

### 2. 部署（Docker）
```bash
docker compose -f docker-compose.agent.yml up -d
# 复测
bash verify.sh http://localhost:5100 "Bearer <token>"
```

### 3. 离线变异测试（零积分，无需服务）
```bash
python3 scripts/verify_mutation_test.py            # 全量
python3 scripts/verify_mutation_test.py --mutant m07_default   # 单跑
python3 scripts/verify_mutation_test.py --serve-only 5199      # 只起 mock 调试
```

## 已完成（S1–S6，类型检查 0 新增错误，verify.sh 15/15 基准通过）
- S1 常量拆分：`MAX_SINGLE_IMAGE_COUNT=8` / `MAX_GROUP_IMAGE_COUNT=15` /
  `MAX_AGENT_IMAGE_COUNT=40` / `MAX_AGENT_VIDEO_COUNT=8`
  > ⚠️ 口径更正（2026-09-18）：S1 当时把单图上限设为 4，并删掉了"1-8"注释。
  > 经官网 UI + 社区实现双源取证，**"单图可选 1–8"是真实 UI 范围**，
  > 4 只是「未传 `gen_count` 时上游按模型兜底 `default_generate_count` 的产出」，
  > 不是上限。现值已改回 **8**。
- S2 显式 `mode` HTTP 参数：`single` / `group` / 缺省（兼容模式 + hint）
- S3 Agent 编排层强制 `mode:"single"`，修复静默丢图 P0
- S4 同提示词配额护栏：单图/单视频累加 ≤4，组图/Agent 豁免
- S5 batch 视频分派 + 总量上限 + 并发 2 / 重试
- S6 异步任务层：`POST /tasks` 秒回 `task_id`，`GET /tasks/:id` 查进度，
  逐项落盘，JSON 原子写，**不持久化 token**

## 回炉记录（v3.0，2026-09-18）

上一版把「上游恒出 4 张、无参数可减」当成**固有行为**写进了文档，这个结论**已被证伪**。
真根因是：**我们从未向报文发送 `gen_count`**，上游于是回落到模型的
`default_generate_count`（4.x/5.x = 4）。

| 项 | 修复 |
|----|------|
| N-10-C1（降本主杠杆） | `abilities.gen_option.gen_count` 补进报文。⚠️ 必须放在 **`abilities` 层、与 `generate` 平级**；放进 `component` 级或 `abilities.generate` 内部**都会被上游忽略**（这是上一轮"改了没用"的原因） |
| N-10-C2（对齐官网） | 默认模型 `jimeng-4.5` → `jimeng-5.0-lite`（`high_aes_general_v50`）；`GET /v1/models` 可列出+可选；未知模型**明确报错**（不再静默降级） |
| 报文版本对齐 | `da_version` 3.3.9 → **3.3.20**；`core_param.generate_type=0` 补齐 |
| N-9（止血） | 落盘目录可写性预检**前移到生成之前** → 不可写时立即报错、**0 积分**，不再"跑完 12 张才发现一张没存" |
| N-11（止血） | 容器内 `/app/output` 属主 root:root → **uid 1001（jimeng）**；`deploy.sh` 每次部署幂等 `chown` |

**降本效果**：修复前每请求恒扣 4 份；修复后 `n=1` 即扣 1 份 —— 单请求成本降至原来的 1/4。

## 遗留 / 卡点
1. **国际站默认模型仍为 `jimeng-4.5`**：US 站是否有「5.0 Lite」需官网抓包取证（U-4 待办），
   未取证前不改，避免开箱必败。
2. **`draft_content.version` 维持 3.3.9**：两个来源冲突（参考实现单一 3.0.2 vs 按模型取值
   3.3.9/3.3.4），且该字段**非因果**，本轮有意不动，已在源码注释留痕。
3. **真机回归（张数==n / 扣分 / 落盘数）需在线执行**，见 `local_verify.sh` 与
   `scripts/real_gen_verify.sh`。
4. **Q6 实抓探针**（P2-1，需 Chrome 登录态 + CDP）仍未执行。

详见 `AGENT_FEATURES.md`。
