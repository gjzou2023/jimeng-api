# Agent 增强功能说明（批量系列图 · 模板库 · 一致性 · 去水印）

本仓库在 `iptag/jimeng-api`（即梦 AI 逆向 API）基础上，内置了四项**自包含**增强能力。
全部代码、配置、依赖、文档均已并入本仓库，**无需本地仓库 `gjzou-jimeng-api` 或任何外部资源**即可独立部署并跑通全部功能。

> 原始上游：`https://github.com/iptag/jimeng-api`（v1.6.3，Koa + tsup，监听 `:5100`）。
> 本增强**只做编排层叠加**，不新增逆向端点；所有生成仍走上游已有的 `generateImages` / `generateImageComposition`。

---

## 1. 三项编排增强

| 方向 | 能力 | 入口 / 文件 |
|------|------|-------------|
| ① 批量系列图 | 解析 `.md/.txt` → 按场景章节拆分 → 串行生成 → 按 `NN_标题.png` 命名 | `src/agent/markdown.ts` `src/agent/batch.ts` |
| ② 模板库 | 4 个财税获客技能模板（电商套图 / 系列套图 / 角色设计 / 世界观美术设定），`{subject}` 占位符替换 | `scripts/skills/*.md` `src/agent/skills.ts` |
| ③ 一致性 | 第 1 张 txt2img，后续 img2img 以首图作参考，`sample_strength` 默认 `0.65`（对应「参考强度 60–70」） | `src/agent/batch.ts` |

统一 HTTP 入口：**`POST /v1/agent/generate`**（`src/api/routes/agent.ts`）。

### 请求体（JSON）
```jsonc
{
  "doc": "整篇 .md/.txt 文本（与 skill 二选一）",
  "skill": "模板名，如 \"角色设计\"",   // 需配合 subject
  "subject": "主题占位符，如 \"财税顾问王姐\"",
  "model": "jimeng-5.0",              // 默认模型，场景可覆盖
  "ratio": "1:1",                     // 默认比例
  "resolution": "2k",                 // 默认分辨率
  "consistency": true,                // 方向③ 一致性，默认开
  "ref_strength": 0.65,               // img2img 参考强度
  "out_dir": "/app/output",           // 服务器保存目录；留空仅返回 url
  "strip_watermark": true             // 落盘图跑去水印（auto 模式：检测到才处理）
}
```
`Authorization` 头支持逗号分隔的多个 token，每场景随机抽一个，复用上游 `tokenSplit` 多账号轮询。

### curl 示例
```bash
# 文档驱动批量生成
curl -X POST http://localhost:5100/v1/agent/generate \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"doc":"# 设定\n风格：写实\n\n## 场景一\n财税顾问在办公室\n\n## 场景二\n合同特写","out_dir":"/app/output","strip_watermark":true}'

# 模板驱动（含 subject 替换）
curl -X POST http://localhost:5100/v1/agent/generate \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"skill":"角色设计","subject":"财税顾问王姐","out_dir":"/app/output"}'
```

Python 客户端见 `scripts/agent_client.py`（仅标准库，跨平台）：
```bash
python3 scripts/agent_client.py --url http://localhost:5100 --token "Bearer <t>" \
  --skill 角色设计 --subject "财税顾问王姐" --out ./out --strip-wm
```

---

## 2. 去水印（独立补齐的能力）

本地仓库 `gjzou-jimeng-api` 已有去水印能力，本仓库已**完整内置等价实现**，不再依赖本地仓库：

- `scripts/watermark_core.py`：纯 Pillow 谐波修复（harmonic inpainting），无浏览器依赖。
- `scripts/watermark_cli.py`：自包含 CLI（`--mode auto|strip|crop`），仅 `auto` 模式会在**检测到水印**时才处理。
- 服务侧 `agent.ts` 在 `out_dir` 落盘后自动调用去水印（受 `JIMENG_STRIP_WM` 控制）。

> 设计依据：即梦 CDN 接口图（干净版）通常**无水印**；Dreamina 网页下载版才带水印。强制裁切会损失约 21.7% 画面，故默认 `auto`：先检测，有强证据才处理。

---

## 3. 环境变量（含计费保护）

| 变量 | 默认 | 说明 |
|------|------|------|
| `JIMENG_BENEFIT_COUNT` | `1` | **每请求生成张数开关**。默认 `1`：批量场景每场景只出 1 张，避免 4 倍计费。想恢复「生成 4 张候选、4 选 1 挑选」设为 `4`。该开关由 `getBenefitCount()` 与 poller `expectedItemCount` **两处同源读取**，代码默认值也统一为 `1`，改一处即全生效，不会出现空等挂起。 |
| `JIMENG_AGENT_OUT_DIR` | `/app/output` | 落盘目录 |
| `JIMENG_STRIP_WM` | `auto` | `auto`=检测后处理；`off`=关闭 |
| `JIMENG_PYTHON` | `python3` | 去水印解释器 |
| `JIMENG_WM_SCRIPT` | `/app/scripts/watermark_cli.py` | 去水印脚本路径 |

---

## 4. 独立部署

### Docker（推荐）
```bash
docker compose -f docker-compose.agent.yml up -d --build
```
该 compose 基于本仓库 `Dockerfile`（生产阶段已含 `py3-pillow` 与 `scripts/` 拷贝），构建版本标签 `1.6.3-agent`，挂载 `./scripts/skills`（只读）与 `./output`。

### 反向代理（可选，自动 TLS）
`Caddyfile` 已提供：`localhost:5100` 反代 + 自动证书。

### 离线/无 Docker
```bash
npm install && npm run build
npm start                            # 默认即 1 张
JIMENG_BENEFIT_COUNT=4 npm start     # 切回 4 张候选（4 选 1 挑选）
```

---

## 5. 复测

部署后运行 `bash verify.sh http://localhost:5100 "Bearer <token>"`：
健康检查 → 根端点暴露 agent → /v1/models → 模板库 → Pillow 就绪 → 真实批量生成落盘 → **张数开关断言**。

> 第 7 项断言「单次文生图返回张数 == `JIMENG_BENEFIT_COUNT`（默认 1）」，用于证明张数开关真实生效。

---

## 6. 文件清单（本增强新增/改动）

新增：
- `src/agent/markdown.ts` `src/agent/skills.ts` `src/agent/batch.ts`
- `src/api/routes/agent.ts`
- `scripts/watermark_core.py` `scripts/watermark_cli.py` `scripts/agent_client.py`
- `scripts/skills/*.md`（4 个财税模板）
- `docker-compose.agent.yml` `Caddyfile` `verify.sh` `AGENT_FEATURES.md`

改动：
- `src/api/routes/index.ts`：挂载 `agent` 路由 + 根端点列出 `/v1/agent/generate`
- `src/api/builders/payload-builder.ts`：`getBenefitCount` 读 `JIMENG_BENEFIT_COUNT`
- `src/api/controllers/images.ts`：poller `expectedItemCount` 读 `JIMENG_BENEFIT_COUNT`（与上式同源，防挂起）
- `Dockerfile`：生产阶段加 `py3-pillow` + 拷贝 `scripts/` + 注入 5 个 ENV
