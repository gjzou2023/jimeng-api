# Agent 增强功能说明（四模式 · 批量编排 · 模板库 · 一致性 · 去水印）

> **版本**：2026-09-17（四模式架构版）。上一版为「两项路径 + 9 项复测」的早期版本，
> 原文各节均**保留未删**；与本次口径冲突之处已就地加上 `⚠️ 2026-09-17 更正` 标注，并说明改前/改后。

本仓库在 `iptag/jimeng-api`（即梦 AI 逆向 API）基础上，内置了四项**自包含**增强能力。
全部代码、配置、依赖、文档均已并入本仓库，**无需本地仓库 `gjzou-jimeng-api` 或任何外部资源**即可独立部署并跑通全部功能。

> 原始上游：`https://github.com/iptag/jimeng-api`（v1.6.3，Koa + tsup，监听 `:5100`）。
> 本增强**只做编排层叠加**，不新增逆向端点；所有生成仍走上游已有的 `generateImages` / `generateImageComposition` / `generateVideo`。

---

## 0. 四模式架构（2026-09-17 新增）

本服务提供**四条互不干扰的生成模式**。换模式靠**显式参数**，不靠猜。

| # | 模式 | 上游调用次数 | 默认值 | 硬上限 | 触发方式（本版改造后） |
|---|------|-------------|--------|--------|------------------------|
| **M1** | 单图 | 1 次 | **1**（`n` 缺省时） | **8** | `POST /v1/images/generations`（默认），张数由 `n` 指定 |
| **M2** | 单视频 | 1 次 | **1**（天然） | **4**（同提示词累计） | `POST /v1/videos/generations` |
| **M3** | 组图 | **1 次** | 必须写明张数（无默认） | **15** | `POST /v1/images/generations` + `mode:"group"` |
| **M4** | Agent 编排 | **N 次** | 图不限紧 / 视频 1 | **40 图 / 8 视频** | `POST /v1/agent/tasks`（异步，推荐） |
| — | 旧 `/v1/agent/generate` | N 次 | — | 同 M4 | **保留**（向后兼容，仅图片、同步） |

一句话理解：**M1/M2 = 单次调用，张数由 `n` 指定（1–8，默认 1）**；**M3 = 一次调用出多张关联图（≤15）**；**M4 = 多次调用垒量（≤40）**。

### 0.1 三个数字各是什么（不要互相替代）

| 数字 | 它真正的身份 | 依据 |
|---|---|---|
| **4** | **⚠️ 不是上限**——是"未传 `gen_count` 时上游按模型兜底的默认产出"（4.x/5.x = 4），也是「防重试误刷」配额的默认刻度 | 2026-09-18 取证：报文缺 `gen_count` → 回落 `default_generate_count`；官网营销文案「单个提示词生成多达 4 张」说的是**默认产出**，**不等于 UI 可选范围**（UI 实为 1–8） |
| **15** | 组图**单次调用**上限，也是"内容关联性"的保证 | 火山引擎《即梦AI-图片生成4.0》：「输入图数量+输出图数量 ≤ 15 张」 |
| **40 / 8** | Agent **编排产物**的容量上限（**不是某个接口的张数参数**） | 即梦官方《AGENT 使用手册》 |

> ⚠️ **不要把 40 当成"组图上限"，也不要把 15 当成"Agent 上限"**——这两个数字属于两条不同路径。
> ⚠️ **也不要把 4 当单图上限**：单图可选 **1–8**（官网 UI 抓包 + 社区实现双源取证），
> 4 只是默认产出。本项目 `MAX_SINGLE_IMAGE_COUNT` 已改为 **8**。

### 0.2 组图入口改为显式（保留能力、废弃自动触发）

**能力没变**：组图链路（`ImageMultiGenerate`）**完整保留**。**变的是入口**：从「隐式关键词」改为「显式 `mode`」。

| `mode` | 行为 |
|---|---|
| `"single"` | **强制单图**：忽略提示词里的「连续 / 绘本 / 故事」与任何数量写法。**Agent 编排层必须用这个值。** |
| `"group"` | **强制组图**：走组图链路，提示词必须显式写明张数（1–15）。 |
| 缺省 / `"auto"` | **不再自动切换**：即使命中组图特征也**按单图执行**，并在响应里附一条可读 `hint`。 |

**为什么废弃自动触发**（两条实证）：
1. 调用方**无法预期产出张数**——同一请求可能返回 1 张、也可能返回 ≤15 张；
2. 编排层只取 `urls[0]`，静默切换会导致**多出的图已生成、已计费、URL 被丢弃**且日志不报错。**（2026-09-18 已修：`AgentSceneResult` 契约升级为 `urls?: string[]` 并全量收下，落盘同步全量，见 §3.1）**

命中组图特征但未声明 `mode` 时的响应示例：
```jsonc
{
  "created": 1789634941,
  "data": [ { "url": "..." } ],
  "mode": "single",
  "hint": "本次请求未显式声明生成模式（mode），但提示词含组图特征：关键词命中「连续」。本次已按【单图】执行：输出张数由参数 n 决定（默认 1，上限 8 张）。若确实需要一次生成多张内容关联图，请在请求体中显式传 mode:\"group\"（上限 15 张）；若需要跨场景堆量（最多 40 张），请改用 POST /v1/agent/tasks。"
}
```

### 0.3 同提示词产出配额（防「重试型误刷」）

单图 / 单视频两条**直出**路径受「同一提示词产出总量 ≤4」约束：

- 超出后再次提交同一提示词 → `code: -2000`，说明已用 / 剩余额度；
- **豁免**：组图（15）、Agent 编排（40 图 / 8 视频）——它们各有独立硬上限，**不叠加**本配额；
- 默认 `4`，用 `JIMENG_PROMPT_QUOTA_MAX=0` 可整体关闭；
- 计数**落盘 JSON + 原子写（临时文件 + rename）**，服务重启不清零。

> 这条护栏治的**不是创作自由，而是"生成超时后重复提交同一提示词"造成的积分重复消耗**。

### 0.4 Agent 异步任务（40 图 / 8 视频必用）

40 张图约需 **13–27 分钟**、8 段视频更久——**同步请求必被网关/客户端掐断**。因此新增异步任务端点：

```bash
# 提交（秒回 task_id）
curl -X POST http://localhost:5100/v1/agent/tasks \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"doc":"# 设定\n\n## 场景一\n…\n\n## 场景二\n…","kind":"image","max_items":40}'

# 查进度与逐项结果
curl http://localhost:5100/v1/agent/tasks/<task_id> -H "Authorization: Bearer <token>"
```

| 端点 | 说明 |
|---|---|
| `POST /v1/agent/tasks` | 异步提交，立即返回 `task_id` / `status` / `cap` / `progress` |
| `GET  /v1/agent/tasks/:id` | 查状态与**逐项**成败（`scenes[].url` / `scenes[].error`） |
| `GET  /v1/agent/tasks` | 列出最近任务（`?limit=`，默认 20） |
| `POST /v1/agent/generate` | **旧同步端点，保留**（向后兼容，仅图片） |

任务状态流转：`queued → running → succeeded / partial / failed`。
每完成一项即**逐项落盘**（图 `.png` / 视频 `.mp4`）并写任务快照，**中断也不丢已完成部分**；终态任务保留 24 小时后自动清理。

### 0.5 编排层的两条硬闸

- **总量闸**：`kind:"image"` ≤ **40**、`kind:"video"` ≤ **8**。超限**直接抛错**（不截断、不静默丢弃），错误信息给出上限与官方口径；可用 `max_items` 主动收紧（只允许更小）。
- **并发 / 重试**：图片**并发 2** + 间隔 1.5 s；**视频严格串行（并发 1）** + 间隔 3 s（风控面最小化）；单场景失败重试 1 次（指数退避），仍失败则跳过并记录，不整体雪崩。

---

## 1. 三项编排增强

| 方向 | 能力 | 入口 / 文件 |
|------|------|-------------|
| ① 批量系列图 | 解析 `.md/.txt` → 按场景章节拆分 → 串行生成 → 按 `NN_标题.png` 命名 | `src/agent/markdown.ts` `src/agent/batch.ts` |
| ② 模板库 | 4 个财税获客技能模板（电商套图 / 系列套图 / 角色设计 / 世界观美术设定），`{subject}` 占位符替换 | `scripts/skills/*.md` `src/agent/skills.ts` |
| ③ 一致性 | 第 1 张 txt2img，后续 img2img 以首图作参考，`sample_strength` 默认 `0.65`（对应「参考强度 60–70」） | `src/agent/batch.ts` |

统一 HTTP 入口：**`POST /v1/agent/generate`**（`src/api/routes/agent.ts`）。

### 请求体（JSON）—— `/generate` 与 `/tasks` 共用
```jsonc
{
  "doc": "整篇 .md/.txt 文本（与 skill 二选一）",
  "skill": "模板名，如 \"角色设计\"",   // 需配合 subject
  "subject": "主题占位符，如 \"财税顾问王姐\"",
  "kind": "image",                    // 2026-09-17 新增：image（≤40 张）｜video（≤8 段），默认 image
  "model": "jimeng-5.0",              // 默认模型，场景可覆盖
  "ratio": "1:1",                     // 默认比例
  "resolution": "2k",                 // 默认分辨率（视频默认 720p）
  "duration": 5,                      // 2026-09-17 新增：视频时长（秒），仅 kind=video 生效
  "consistency": true,                // 方向③ 一致性，默认开
  "ref_strength": 0.65,               // img2img 参考强度
  "max_items": 40,                    // 2026-09-17 新增：主动收紧总量上限（只允许比硬上限更小）
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

## 3. 张数规则与环境变量（含计费保护）

> ⚠️ **2026-09-17 更正**：本节原文只描述「单图路径 / 多图路径」**两条**，并把 40 写成"多图上限"。
> 现行口径是 **M1 单图（≤8）/ M3 组图（≤15）/ M4 Agent（≤40 图 · ≤8 视频）三条图片链路各自独立**，
> 详见 §0。下表为**更正后**版本；原文的两路径说法已由本节取代。

**三条生成路径，三套独立张数规则**（互不干扰，切勿混淆）：

| 路径 | 触发条件 | 张数决定方式 |
|------|----------|--------------|
| **单图路径（M1）** | 默认；或显式传 `mode:"single"` | **由请求体 `n` 决定（1–8，默认 1）**；`n` 写入报文 `abilities.gen_option.gen_count`。<br>⚠️ **不传 `n` 时**上游按模型兜底 `default_generate_count`（4.x/5.x **= 4**），表现为"恒出 4 张、扣 4 份"——这正是 2026-09-17 被误判为"固有行为"的现象。上限 **`MAX_SINGLE_IMAGE_COUNT` = 8** |
| **组图路径（M3）** | **必须显式传 `mode:"group"`**（原关键词自动触发已废弃） | **必须由提示词显式写明数量（1–15），否则直接报错**；上限 **`MAX_GROUP_IMAGE_COUNT` = 15** |
| **Agent 编排（M4）** | `POST /v1/agent/tasks` | 场景数由 `.md` / 模板决定，每场景张数由 `n` 指定，总量上限 **`MAX_AGENT_IMAGE_COUNT` = 40 图 / `MAX_AGENT_VIDEO_COUNT` = 8 视频** |

> **历史行为（已废弃）**：模型为 `jimeng-4.x` **且**提示词含「连续 / 绘本 / 故事」**或**出现数量写法时，
> **隐式自动切进组图路径**。该行为在 2026-09-17 被废弃，原因见 §0.2。现在命中这些特征只会拿到一条 `hint`，
> **默认仍走单图**。

### 组图路径的强制规范

- 提示词只写了触发词（如"绘本风格的小猫"）而**未写数量** → 返回业务错误 `code: -2000`，`message` 中给出**位置与形式不限**的写法说明与示例，**不发起生成、不消耗积分**。
- **不再隐式兜底 4 张**（上游原行为），避免误生成造成非预期计费。
- 数量完全由提示词决定（`4张` → 4 张），**不受** `JIMENG_BENEFIT_COUNT` 影响。
- 只想出 1 张时：传 `n: 1`（默认值，**推荐显式写出**）。
  > ✅ **2026-09-18 定论（推翻本节旧结论）**：原文称"上游自由模式的固有产出仍为 4 张、无参数可减"，
  > **已被证伪**。真因是**报文缺 `abilities.gen_option.gen_count`**，上游于是回落到模型的
  > `default_generate_count`（4.x/5.x = 4）。补齐该字段后，`n=1` 即出 1 张、扣 1 份。
  > 注意字段层级：必须放在 **`abilities` 下、与 `generate` 平级**；放进 `component` 级或
  > `abilities.generate` 内部**都会被上游忽略**（这是上一轮"改了没用"的直接原因）。
  > 另：换非 4.x 模型**不能**减少张数，反而单价更高（`jimeng-5.0` / `nanobanana` = 3 分/张 vs `jimeng-4.0` 的 1 分/张）。

#### 数量写法：位置不限、形式不限

只要提示词里**出现过一次数量说明**即可，写在句中或句末都行，不要求固定句式：

| 形式 | 示例 | 解析结果 |
|------|------|----------|
| 阿拉伯数字 + 张（句中） | 「生成**4张**连续的猫咪插画」 | 4 |
| 阿拉伯数字 + 张（句末） | 「生成不同风格的猫咪插画，**4张**」 | 4 |
| 数字与「张」之间有空格 | 「生成**4 张**连续的插画」 | 4 |
| 全角数字（中文输入法） | 「生成**４张**连续的插画」 | 4 |
| 中文数字 + 张 | 「生成**四张**…」「**十二张**」「**二十四张**」 | 4 / 12 / 24 |
| 键值式 | 「**张数:4**」「**数量：4**」「图片数 4」 | 4 |

**序数 / 指代不算数量说明**：紧接在 第/这/那/前/后/每/另/某 之后 2 个字符内的数量写法一律跳过——
「第一张」「最后一张」「另一张」「这是一张照片」均不视为数量，仍会按"缺失数量"报错。

#### 组图单次上限 15 张

- 提示词写 `16张` 及以上（且 `mode:"group"`）→ `code: -2000`，`message` 明确指出**上限数值与合法范围**（1-15），**不发起生成、不消耗积分**。
- 依据：组图是**单次调用**链路（同步轮询，超时 30 分钟），张数过大会长时间占用请求并放大积分消耗；
  上限 15 来自官方口径「输入图数量 + 输出图数量 ≤ 15 张」。
- 需要超过 15 张时：改用 **Agent 编排**（`POST /v1/agent/tasks`，最多 40 张，异步不阻塞）。
- 单图路径的张数由 **请求体 `n`（1–8）** 决定；`JIMENG_BENEFIT_COUNT` 仅在 `n` 缺省时兜底。
  `resolveRequestImageCount(n)` 是**唯一解析点**（越界/非整数**明确报错**，不静默截断），
  解析结果同时喂给报文 `gen_count`、埋点 `benefitCount` 与 poller `expectedItemCount`——三者同源，不会漂移。

> ✅ **2026-09-18 双重更正（本节历史结论均作废）**：
> - **2026-09-17 版**写道「上游即梦 UI 可选 1-8，本上限 40 远高于该范围」→ 被当作"无来源的推断产物"删除，
>   并把单图上限改成 4。**这是错的**：官网 UI 抓包 + 社区实现（`zhizinan1997/jimeng-free-api-all`
>   commit `ad24c899`）双源证实「**单图可选 1–8**」是真实的 UI 范围。**"4"只是未传 `gen_count`
>   时的默认产出，不是上限**。现值已回到 **8**。
> - **2026-09-18 版**写道「上游固定产出 4 张，无参数可减」→ 见上，**已证伪**。
>
> 方法论教训：**"验证了 A 字段无效" ≠ "没有字段有效"**。枚举不完整就得出了"无参数可减"的伪结论。
> 排错必须**对照官网真实报文**，不能用"试了几个字段"替代取证。

> 触发判断与取值**共用同一张写法定义表**（`MULTI_IMAGE_COUNT_PATTERNS` + `parseMultiImageCount()`），
> 杜绝"判定为组图却取不到张数"的漂移——历史上正是取值处另写了一遍正则，才把隐式兜底 4 张藏了进去。
> 另注：触发判断用的是"是否**出现**写法"（含超限值），所以 `41张` 也会进入组图分支并拿到明确的超限报错，
> 而不会悄悄退化成单图路径、把用户写的数量默默忽略掉。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `JIMENG_BENEFIT_COUNT` | `1` | **单图路径（M1）张数的兜底值**——仅当请求体未传 `n` 时生效。**推荐始终显式传 `n`**（1–8）。该值同时写入报文 `abilities.gen_option.gen_count` 与埋点 `metrics_extra.benefitCount`。<br>⚠️ **历史口径更正留痕**：本节曾写"该变量不控制上游产出、上游固定 4 张、控制面没有任何张数字段"——**该结论已证伪**。真因是报文**缺** `gen_count`；补齐后 `n` 直接决定产出张数与扣分。上限 **8**（`MAX_SINGLE_IMAGE_COUNT`；<br>⚠️ **2026-09-17** 曾误改为 4，**2026-09-18** 依官网 UI 取证回改为 8）。 |
| `JIMENG_PROMPT_QUOTA_MAX` | `4` | **同一提示词产出配额（仅单图 / 单视频直出路径）**。超出后再次提交 → `code: -2000`。设 `0` = 关闭该护栏。组图与 Agent 编排**豁免**。计数落盘 JSON + 原子写，重启不清零。 |

> **默认图片模型**（源码常量，非环境变量）：`src/api/consts/common.ts` 的
> `DEFAULT_IMAGE_MODEL = "jimeng-5.0-lite"`（内部键 `high_aes_general_v50`，对应即梦官网
> 图片模式默认「图片 5.0 Lite」，2026-09-18 依官网 UI + 社区实现双源取证）；
> `DEFAULT_IMAGE_MODEL_US` 维持 `"jimeng-4.5"`（US 站是否有 5.0 Lite **尚未取证**，未取证前不改）。
> 请求体 `model` 缺省时按区域取上述默认值；传未知模型**明确报错**，不再静默降级。
> 可用清单见 `GET /v1/models`。| `JIMENG_AGENT_OUT_DIR` | `/app/output` | 落盘目录（异步任务的逐项落盘也用它） |
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
npm start                            # 单图默认出 1 张（n 缺省时取 JIMENG_BENEFIT_COUNT=1）
JIMENG_BENEFIT_COUNT=1 npm start     # `n` 缺省时的兜底张数（推荐调用方显式传 n）
```

---

## 5. 复测

部署后运行 `bash verify.sh http://localhost:5100 "<token>"`，共 **15 项**断言：

| # | 断言 | 是否消耗积分 |
|---|------|--------------|
| 1–5 | `/ping`、根端点暴露 agent 路由、`/v1/models`、模板库、Pillow 就绪 | 否 |
| 6 | 真实同步编排生成并落盘 | **是** |
| 7 | 单图请求**可出图** | **是** |
| 8 | **组图缺数量必须被拒**（`mode:"group"`，零成本前置校验） | 否 |
| 9 | **组图超上限 16 必须被拒并说明上限 15** | 否 |
| 10 | **单图上限钳制**（`JIMENG_BENEFIT_COUNT` 超限时必须被钳到 **8**） | **是** |
| 11 | **编排隔离断言**（`mode:"single"` + `jimeng-4.5` + 组图特征 → 走单图路径、**不静默丢图**） | **是** |
| 12 | **兼容模式不静默切换**（无 `mode` + 组图特征 → 单图 + 返回 `hint`） | **是** |
| 13 | **41 图编排超限被拒**（生成前拦截，`cap=40`） | 否 |
| 14 | **视频任务 cap 断言**（`kind:"video"` → `cap=8`） | 否 |
| 15 | **同提示词产出配额**（第 5 次必须被拒） | **是** |

> 提供 token 时预计消耗约 **10 张图片**的积分（1k 分辨率）。
> ⚠️ **2026-09-18 修正**：该估算的旧前提是"上游固定 4 张/请求"，**已证伪**。
> 现在 `JIMENG_BENEFIT_COUNT` 会真正写进报文 `gen_count`，服务端默认 `1`，
> 故实际消耗**回到约 10 张**（即原估算），不再 ×4。
> 第 8/9/13/14 项在**参数校验阶段**即被拒绝，不消耗积分。
> 第 10 项需与服务端 `JIMENG_BENEFIT_COUNT` 对齐；第 15 项需与服务端 `JIMENG_PROMPT_QUOTA_MAX` 对齐（服务端设为 `0` 时本项跳过）。
>
> ✅ **2026-09-18 遗留项已消解**：此前登记「`verify.sh` 第 7 / 11 / 12 项以"返回张数 ==
> `JIMENG_BENEFIT_COUNT`"为通过条件，而 Step 0 实测证伪该等式 → 三项预期为红」。
> 根因（报文缺 `gen_count`）修复后，**该等式重新成立**，三项**恢复为绿**，
> 无需改动 `verify.sh`（该脚本仍处于阶段 1 §3 字节级冻结清单，本版未触碰）。
> 更严格的分层断言另建于 `scripts/real_gen_verify.sh`（三层独立：请求成功 / 出图成功 / 张数严格 == N）。

> **判读要点**：服务端业务错误的 HTTP 状态码仍为 `200`，错误码与说明在响应体的 `code` / `message` 字段。
> 因此判断成败**必须看 `code`**（`0` = 成功），不能用 HTTP 状态码判断。`scripts/agent_client.py` 已按此规则识别并原样打印错误说明。

### 5.1 断言的变异测试（防恒真断言）

`verify.sh` 的 15 项断言配有一套**离线变异测试**（零积分）：

```bash
python3 scripts/verify_mutation_test.py
```

它起一个本地 mock 服务模拟正确行为，先跑基准（应 15/15 全绿），
再**逐条把某一处行为故意改坏**（如"组图超限报错写 40 而非 15"），
断言"观测到的失败项集合 == 该变异预期的失败项集合"。
若某条断言在对应变异下仍然通过，说明它形同虚设。

> 本套件在首次运行时**抓出了一处真实缺陷**：第 6 项曾把文档**正文**当作 `--doc` 参数传入，
> 而客户端 `--doc` 期望的是**文件路径**，导致该项在 `open()` 处必然抛错、永远无法通过。已修正。

---

## 6. 文件清单（本增强新增 / 改动）

### 2026-09-17 四模式改造新增
- **`src/api/guards/prompt-quota.ts`**：同提示词产出配额护栏（键 = `sha256(归一化 prompt)`；`JIMENG_PROMPT_QUOTA_MAX` 默认 4、`0` 关闭；组图 / Agent 豁免；JSON 落盘 + 原子写）
- **`src/agent/tasks.ts`**：进程内任务表（`queued/running/succeeded/partial/failed`）+ 逐项落盘 + 任务快照（原子写、**不落盘 token**）+ 24h TTL 清理
- **`scripts/verify_mutation_test.py`**：`verify.sh` 15 项断言的离线变异测试（零积分）

### 2026-09-17 四模式改造改动
> ⚠️ **本小节为历史留痕**，其中两处口径已于 2026-09-18 回炉更正，见下方「2026-09-18 回炉（v3.0）」。
- `src/api/builders/payload-builder.ts`：
  - **1 个共用常量拆为 4 个**：`MAX_SINGLE_IMAGE_COUNT=4`（⚠️ **2026-09-18 已改回 8**）/ `MAX_GROUP_IMAGE_COUNT=15` / `MAX_AGENT_IMAGE_COUNT=40` / `MAX_AGENT_VIDEO_COUNT=8`
  - `getImageCountPerRequest()` 的 `Math.min` 改用**单图**常量（修"单图闸门形同虚设"）
  - 新增 `ImageMode`（`single`/`group`/`auto`）+ `normalizeImageMode()`
  - ~~删除无依据的"上游 UI 可选 1-8"注释~~ → ⚠️ **该删除是错的**：2026-09-18 经官网 UI 抓包 + 社区实现双源取证，
    「单图可选 1–8」确实成立，已恢复该口径并写入可溯源注释
- `src/api/controllers/images.ts`：组图路由**显式化**（`mode` 三分支 + 兼容模式仅提示不切换）、新增 `ImageGenMeta` 出参、配额护栏接入单图路径、级联改用新常量
- `src/api/routes/images.ts`：新增 `body.mode` 校验（`single|group|auto`）、响应回传 `mode` 与条件性 `hint`
- `src/api/routes/videos.ts` + `src/api/controllers/videos.ts`：接入配额护栏（补齐单视频「≤4」）
- `src/agent/batch.ts`：**强制传 `mode:"single"`**（消除静默丢图）、新增 `kind:"image"|"video"` 分派、总量闸、并发池、逐项重试、`onScene` 进度钩子
- `src/api/routes/agent.ts`：新增 `POST /v1/agent/tasks`、`GET /v1/agent/tasks`、`GET /v1/agent/tasks/:id`；**旧 `/generate` 保留**
- `scripts/agent_client.py`：新增 `--kind` / `--duration` / `--async` / `--wait` / `--interval` / `--max-items` / `--mode` / `--prompt`
- `verify.sh`：9 项 → **15 项**（并修正第 6 项「把正文当文档路径传参」的真实缺陷）

### 早期版本新增（保留）
- `src/agent/markdown.ts` `src/agent/skills.ts` `src/agent/batch.ts`
- `src/api/routes/agent.ts`
- `scripts/watermark_core.py` `scripts/watermark_cli.py` `scripts/agent_client.py`
- `scripts/skills/*.md`（4 个财税模板）
- `docker-compose.agent.yml` `Caddyfile` `verify.sh` `AGENT_FEATURES.md`

### 早期版本改动（保留；其中被本次取代的条目已在上面列出）
- `src/api/routes/index.ts`：挂载 `agent` 路由 + 根端点列出 `/v1/agent/generate`
- `src/api/builders/payload-builder.ts`：
  - ~~新增 `MAX_IMAGE_COUNT_PER_REQUEST = 40`（单次张数上限，两条路径共用）~~
    ⚠️ **2026-09-17 已废弃并拆分**为 4 个独立常量（见上）。
  - 新增 `getImageCountPerRequest()`：**单图路径张数的唯一读取点**（默认 `1`、非法回退 `1`、超上限截断）；`getBenefitCount()` 改为调用它，消除"两处各读一遍 env"的漂移隐患
- `src/api/controllers/images.ts`：
  - poller `expectedItemCount` 改为调用 `getImageCountPerRequest()`（与 `buildCoreParam` 同源，防挂起）
  - 组图路径新增 `parseMultiImageCount()` + `MULTI_IMAGE_COUNT_PATTERNS` 写法定义表：**位置/形式不限**（数字+张、全角、空格、中文数字、键值式），**序数/指代不算数量**；缺数量 / 超上限均抛 `code: -2000` 并给出说明（不再隐式兜底 4 张）
    ⚠️ **2026-09-17 更正**：该表原口径为"上限 40"，现为 **15**（组图单次调用上限）。
  - 组图触发判断改为复用 `parseMultiImageCount()` 的判定（含超限值也会进组图分支，拿到明确报错）
    ⚠️ **2026-09-17 更正**：该"自动触发"已废弃，改为必须显式 `mode:"group"`。
- `scripts/agent_client.py`：识别服务端业务错误码（`code != 0`）并原样打印说明；`scenes` 为空时以非零退出，避免错误被静默吞掉
- `verify.sh`：新增第 8 项「组图缺数量必须被拒绝且给出数量/形式/示例说明」；新增第 9 项「超上限必须被拒绝且说明含上限数值」
- `Dockerfile`：生产阶段加 `py3-pillow` + 拷贝 `scripts/` + 注入 5 个 ENV

---

## 2026-09-18 回炉（v3.0）：张数开关 + 默认模型 + 落盘止血

**触发**：对照即梦官网真实 UI 复核，发现本服务可控面与官网存在系统性偏差，且历史结论有伪。

### C-1 张数开关（★降本主杠杆）

- **根因**：报文**从未发送** `abilities.gen_option.gen_count` ⇒ 上游回落模型默认
  `default_generate_count`（4.x/5.x **= 4**）⇒ 每请求恒出 4 张、扣 4 份。
- **修复**：`buildDraftContent()` 把 `gen_option` 从 `abilities.generate` 内**上移到 `abilities` 层**，
  并补 `gen_count: n`。**层级是成败关键**——放进 `component` 级或 `abilities.generate` 内部均被忽略。
- **新入参**：`POST /v1/images/generations` 与 `/v1/images/compositions` 支持 `n`（1–8，默认 1）；
  响应体回显 `n` 便于对账。越界/非整数**明确报错**（`resolveRequestImageCount()`），不再静默截断。
- **常量**：`MAX_SINGLE_IMAGE_COUNT` 4 → **8**。
- **配套**：`smoke_light.sh` 断言7 判据由"区间 1..4"改为"严格 = n"；
  `scripts/real_gen_verify.sh` 判据为 L3「返回张数 == N」严格等式。

### C-2 默认模型对齐官网

- `DEFAULT_IMAGE_MODEL`：`jimeng-4.5` → **`jimeng-5.0-lite`**（内部键 `high_aes_general_v50`）。
- `IMAGE_MODEL_MAP`（三区域）新增 `jimeng-5.0-lite` 别名；旧名 `jimeng-5.0` 保留。
- `GET /v1/models` 重写：列出 10 个图片模型 + 11 个视频模型，带 `type`/`regions`/`description`
  与 `image_count_options` 说明，并自检清单与映射表一致性。
- 未知模型**明确报错**（原为静默降级到区域默认）。
- ⚠️ `DEFAULT_IMAGE_MODEL_US` **维持 `jimeng-4.5`**：US 站是否有 5.0 Lite **未取证**，不凭猜测开箱必败。

### C-4 报文版本对齐

- `da_version`：3.3.9 → **3.3.20**（对齐官网更新日志）；`web_version` 维持 `7.5.0`。
- 新增 `core_param.generate_type = 0`、`component.gen_type = 1`。
- ⚠️ `draft_content.version` **有意维持 3.3.9**：两来源冲突（参考实现单一 `3.0.2` vs
  按模型取值 `5.0→3.3.9 / 4.5→3.3.4`），且该字段**非因果** → 留痕不动，避免引入非必要风险。

### N-9 落盘可写性预检前移（止血）

- 新增 `assertWritableDir(outDir)`：`mkdir` + **真写真删**探针（不只看权限位）。
- 调用点前移到 `generateAgentBatch()` / `createAgentTask()` **之前** ⇒ 不可写时**立即报错、0 积分**，
  不再"跑完 12 张才发现一张没落盘"。

### N-11 容器落盘目录属主（止血）

- **现象**：容器内 `jimeng(uid=1001)` 对 `/app/output`（root:root 755 bind mount）**无写权**，
  12 次落盘 EACCES **静默失败**。
- **修复**：`sudo chown 1001:1001 /app/output && chmod 755`（已在线验证 `touch` → WRITE_OK）。
- **防回归**：`deploy.sh` 每次部署**幂等**执行同一 `chown`。

### 验证记录

| 层次 | 工具 | 结果 |
|------|------|------|
| 类型检查 | `tsc --noEmit` | 基线 13 条既有错误，**改动文件零新增** |
| 构建 | `npm run build` | 通过 |
| 报文级（离线、0 积分） | `verify_payload.ts` | **33/33 全绿**（含 V-1/V-2/V-5/V-7/V-8/C-4/C-5） |
| 链路级（本地起服务） | `local_verify.sh` | `/v1/models` 清单、`n=9` 越界报错、未知模型报错、N-9 正反例 **全绿** |

> **踩坑留痕**：`local_verify.sh` 起初用字符串拼接 `C="curl --noproxy *"`，
> 导致 `*` 被 bash 展开命中同目录文件名、请求打外网返回 nginx 301 的**假绿**。
> 必须用数组 `C=(curl --noproxy '*' -m 20)`。
> 方法论：**"部署验证全绿" ≠ "功能可用"**，mock/离线断言必须与真实生成层分开回归。

---

## 2026-09-18 回炉（v3.1）：N-12 快照目录 + 测试脚手架 + 上游风控阻塞

> 背景：v3.0 的代码改动**已上线**且零成本可验证（`/v1/models` 在线返回 image 模型清单、
> `dist` 内 `MAX_SINGLE_IMAGE_COUNT = 8` / `gen_count` 12 处 / `jimeng-5.0-lite` 28 处），
> 但**生成层验收被上游风控阻塞**（N-13），且回归过程暴露出两类**脚手架**问题。
> 详见 `DIAG_REVIEW_v3.1.md`。

### N-12 任务快照目录不可写（已修 · 0 成本可验）

- **现象**：`[agent-task] 任务快照落盘失败: EACCES mkdir '/app/.jimeng-agent-tasks'`（warning，不阻断）。
- **影响**：任务快照不持久化 ⇒ `GET /v1/agent/tasks` **跨重启丢失任务列表**。
- **根因**：`tasks.ts:82` 默认 `path.join(process.cwd(), ".jimeng-agent-tasks")` = `/app/.jimeng-agent-tasks`；
  而 `Dockerfile` 此前只创建了 `/app/logs`、`/app/tmp`、`/app/output`，**`/app` 自身是 root:root**，
  非 root 用户（uid=1001）无法在其中 `mkdir` 子目录。
- **修复**（三层，互为冗余）：
  1. `Dockerfile`：`mkdir -p` 序列加入 `/app/.jimeng-agent-tasks` 并 `chown jimeng:nodejs`；
  2. `Dockerfile`：显式 `ENV JIMENG_AGENT_TASK_DIR=/app/.jimeng-agent-tasks`（防 `WORKDIR` 漂移）；
  3. `docker-compose.agent.yml`：`environment` 同名变量（**只 `up -d` 即可生效，无需重建镜像**）。
- ★ **口径铁律：产物目录（`output`）≠ 状态目录（`.jimeng-agent-tasks`）**。
  排查口诀：**图出不来 → 看 `output`；任务列表丢了 → 看 `.jimeng-agent-tasks`**。
  状态目录**不要**做 bind mount（宿主无对应物，且会再踩属主坑）。

### N-13 上游风控阻塞（**非代码问题** · 待外部条件恢复）

- **现象**：`POST /token/points` 对 us / jp / cn **三账号同时**返回
  `{"code":-2002,"message":"[登录失效]: check login error"}`；
  生成请求则返回 `ret=-6 / fail_code=4013 / web_risk_control_message_reject_generation`
  （556~693ms 即返回、`aigc_data:null`、**积分未扣**）。
- **关键对照（决定性证据）**：**同一个 sessionid，改从本机（非服务器出口）发起** → **出图正常**。
  ⇒ 账号与凭证**均有效**，唯一变量是**出口 IP** ⇒ 判定为 **IP 级风控**，非账号级失效。
- **机理**：反爬系统维护**数据中心 IP 段 / ASN 黑名单**（云厂商网段可被直接识别为服务器而非真实用户），
  命中后按 `ret=1015`（即梦反爬码）拒答；出口 IP 为腾讯云新加坡 `43.134.47.240`。
- **纪律（红线）**：**严禁"换 IP 快速轮试同一账号"** —— 上游文案为
  `unusual activity in your account`，连续试探有**永久封号**风险。
- **处置**：见 `DIAG_REVIEW_v3.1.md` 线路 B（判别 → 分支处置）。

### 测试脚手架 6 处缺陷修复（`_gen_realgen_script.py` / `_run_realgen.sh`）

| 编号 | 缺陷 | 修复 | 离线干跑断言 |
|---|---|---|---|
| F1 | 响应未判错，把上游 error 当"0 张" | 统一 `parse()`：`error`/`code<0` → 判 **BLOCKED**，不计入张数断言 | `gen_error` 模式 → 输出 `[BLOCKED] n=1 上游/接口拒绝（code=-6）` ✅ |
| F2 | `out_dir` 用**宿主**路径 + 宿主 mkdir | 改**容器内** `/app/output/_vc_probe`，由 `docker exec -u 1001` 在容器内创建与计数 | 静态断言 ✅ |
| F3 | `task_id` 为空仍进轮询（**本次"空转 5 分钟"真根因**） | POST 后立即校验；为空则**不进 `for` 循环** | 干跑全程 **9s**（原 300s）✅ |
| F4 | 轮询无上界语义 | 上界 36 次；连续 6 次空 `status` 即 `break` 报错 | 静态断言 ✅ |
| F5 | 步骤间隔仅 3s，易撞风控 | 步骤间 `STEP_GAP=35`（≥ 上游建议 30s） | 静态断言 ✅ |
| F6 | 无账号预检，直接开跑 | 第 0 步预检；不可用 → `REALGEN_ABORTED` 并 `exit 2`，**不进入生成** | `login_fail` 模式 → `REALGEN_ABORTED reason=login_invalid code=-2002` ✅ |
| F3' | 进程异常退出无留痕 → 外层干等 40 min | 远端脚本加 `trap 'echo REALGEN_EXIT rc=$?' EXIT`；外层据此立即退出 | 静态断言 ✅ |

**外层快速退出**（`_run_realgen.sh`）：四条通道 —— ① `REALGEN_DONE` ② `REALGEN_ABORTED`
③ `REALGEN_EXIT` 且无 DONE ④ 连续 3 次"无进程且无标记"兜底；并改为**一次 SSH 同时取日志与进程数**，
降低该服务器约 1/3 概率的 RST 影响。

### 验证记录（v3.1）

| 层次 | 工具 | 结果 |
|------|------|------|
| 语法 | `bash -n` | 生成脚本 + 外层脚本 **均通过** |
| 离线干跑（0 成本、不触达上游） | `_dryrun_verify.sh`（本地 mock 三模式） | **18/18 全绿** |
| 部署侧（N-12） | `docker exec ls -ld` + uid=1001 真写探针 | 见 `DIAG_REVIEW_v3.1.md` 复测记录 |

> **方法论沉淀（本次最重要的一条）**：
> ★ **"看起来卡死"必须区分三层** —— ①**被测对象空转** ②**可观测性缺陷**（日志无新增行）
> ③**编排层缺陷**（无死进程检测）。本次三层全中，但**被测代码里一处无界循环都没有**。
> ★ **测试脚手架必须校验每一步的返回值**（尤其是"依赖前一步产物"的 ID 类字段），
> 否则会把"上一步失败"放大成"下一步空转 5 分钟"，并让"没测到"看起来像"测出了问题"。
