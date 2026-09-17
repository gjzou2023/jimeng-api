# jimeng-api 四模式 + Agent 编排 交接包

## 项目背景
在 `gjzou2023/jimeng-api`（即梦 AI 逆向 API，Koa+tsup，:5100）基础上，
内置「批量系列图 / 模板库 / 一致性 / 去水印」四项自包含增强，
并新增**四模式架构**与**Agent 异步编排层**：

| 模式 | 触发 | 上限 | 说明 |
|------|------|------|------|
| M1 单图 | 默认；`mode:"single"` | 4 | `JIMENG_BENEFIT_COUNT`（默认 1）决定实际张数 |
| M2 单视频 | 默认 | 1（按提示词配额） | 配额护栏 ≤4 |
| M3 组图 | 显式 `mode:"group"` | 15 | 提示词必须显式写张数（1–15） |
| M4 Agent 编排 | 显式调用 `/v1/agent/*` | 40图 / 8视频 | 异步任务，`task_id` + 逐项落盘 |

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
- S1 常量拆分：`MAX_SINGLE_IMAGE_COUNT=4` / `MAX_GROUP_IMAGE_COUNT=15` /
  `MAX_AGENT_IMAGE_COUNT=40` / `MAX_AGENT_VIDEO_COUNT=8`；删除失实"1-8"注释
- S2 显式 `mode` HTTP 参数：`single` / `group` / 缺省（兼容模式 + hint）
- S3 Agent 编排层强制 `mode:"single"`，修复静默丢图 P0
- S4 同提示词配额护栏：单图/单视频累加 ≤4，组图/Agent 豁免
- S5 batch 视频分派 + 总量上限 + 并发 2 / 重试
- S6 异步任务层：`POST /tasks` 秒回 `task_id`，`GET /tasks/:id` 查进度，
  逐项落盘，JSON 原子写，**不持久化 token**

## 遗留 / 卡点
1. **变异测试 13 项中 3 项断言不一致**（m07 / m10 实测失败项超出预期；
   m13/m14/m15 90s 兜底超时——根因是 verify.sh 第 15 项配额循环 +
   第 13/14 项任务轮询累计 102s，90s 兜底值偏低）
2. **真机验证 S8**（docker build + 真实 40 图 / 8 视频生成）未执行
3. **Q6 实抓探针**（P2-1，需 Chrome 登录态 + CDP）未执行
4. **远端推送**（`push_to_gh.py`）未执行
5. **复盘文档**（S9）未生成

详见 `HANDOFF.md`。
