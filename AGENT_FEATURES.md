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

## 3. 张数规则与环境变量（含计费保护）

**两条生成路径，两套张数规则**（互不干扰，切勿混淆）：

| 路径 | 触发条件 | 张数决定方式 |
|------|----------|--------------|
| **单图路径** | 默认；模型非 `jimeng-4.x`，或提示词不含多图关键词 | `JIMENG_BENEFIT_COUNT`（默认 `1`） |
| **多图路径** | 模型为 `jimeng-4.0 / 4.1 / 4.5` **且**（提示词含「连续 / 绘本 / 故事」**或**出现任何数量写法） | **必须由提示词显式写明数量（1-40），否则直接报错**；上限 40 张 |

### 多图路径的强制规范（本仓库新增）

- 提示词只写了触发词（如"绘本风格的小猫"）而**未写数量** → 返回业务错误 `code: -2000`，`message` 中给出**位置与形式不限**的写法说明与示例，**不发起生成、不消耗积分**。
- **不再隐式兜底 4 张**（上游原行为），避免误生成造成非预期计费。
- 数量完全由提示词决定（`4张` → 4 张），**不受** `JIMENG_BENEFIT_COUNT` 影响。
- 只想出 1 张时：改用 `jimeng-5.0` 等单图模型，或去掉提示词中的多图关键词。

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

#### 单次上限 40 张

- 提示词写 `41张` 及以上 → `code: -2000`，`message` 明确指出**上限数值与合法范围**（1-40），**不发起生成、不消耗积分**。
- 依据：多图链路是同步轮询（超时 30 分钟），张数过大会长时间占用请求并放大积分消耗。
  上游即梦 UI 可选 1-8，本上限 40 远高于该范围，正常使用不会触达，只用于拦住 `999张` 这类笔误/异常值。
- 单图路径的 `JIMENG_BENEFIT_COUNT` 同样受该上限钳制（统一由 `getImageCountPerRequest()` 做 `Math.min`）。

> 触发判断与取值**共用同一张写法定义表**（`MULTI_IMAGE_COUNT_PATTERNS` + `parseMultiImageCount()`），
> 杜绝"判定为多图却取不到张数"的漂移——历史上正是取值处另写了一遍正则，才把隐式兜底 4 张藏了进去。
> 另注：触发判断用的是"是否**出现**写法"（含超限值），所以 `41张` 也会进入多图分支并拿到明确的超限报错，
> 而不会悄悄退化成单图路径、把用户写的数量默默忽略掉。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `JIMENG_BENEFIT_COUNT` | `1` | **每请求生成张数开关（单图路径）**。默认 `1`：批量场景每场景只出 1 张，避免 4 倍计费。想恢复「生成 4 张候选、4 选 1 挑选」设为 `4`。上限 **40**（超出自动截断）。该开关由 `getImageCountPerRequest()` **单一函数**读取，`buildCoreParam` 的 `benefitCount` 与 poller `expectedItemCount` 都调用它——改一处即全生效，不会出现空等挂起。 |
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
健康检查 → 根端点暴露 agent → /v1/models → 模板库 → Pillow 就绪 → 真实批量生成落盘 → **张数开关断言** → **多图强制数量断言** → **多图上限断言**（共 9 项）。

> 第 7 项断言「单次文生图返回张数 == `JIMENG_BENEFIT_COUNT`（默认 1）」，用于证明张数开关真实生效。
> 第 8 项断言「多图路径未写数量时必须被拒绝（`code: -2000`），且错误信息含数量说明、写明「位置与形式不限」并给出示例」。
> 第 9 项断言「多图数量超过上限 40 时必须被拒绝（`code: -2000`），且错误信息含上限数值」。
> 第 8、9 项均在调用生成接口**之前**抛错，**不消耗积分**。

> **判读要点**：服务端业务错误的 HTTP 状态码仍为 `200`，错误码与说明在响应体的 `code` / `message` 字段。
> 因此判断成败**必须看 `code`**（`0` = 成功），不能用 HTTP 状态码判断。`scripts/agent_client.py` 已按此规则识别并原样打印错误说明。

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
- `src/api/builders/payload-builder.ts`：
  - 新增 `MAX_IMAGE_COUNT_PER_REQUEST = 40`（单次张数上限，两条路径共用）
  - 新增 `getImageCountPerRequest()`：**单图路径张数的唯一读取点**（默认 `1`、非法回退 `1`、超上限截断）；`getBenefitCount()` 改为调用它，消除"两处各读一遍 env"的漂移隐患
- `src/api/controllers/images.ts`：
  - poller `expectedItemCount` 改为调用 `getImageCountPerRequest()`（与 `buildCoreParam` 同源，防挂起）
  - 多图路径新增 `parseMultiImageCount()` + `MULTI_IMAGE_COUNT_PATTERNS` 写法定义表：**位置/形式不限**（数字+张、全角、空格、中文数字、键值式），**序数/指代不算数量**，**上限 40**；缺数量 / 超上限均抛 `code: -2000` 并给出说明（不再隐式兜底 4 张）
  - 多图触发判断改为复用 `parseMultiImageCount()` 的判定（含超限值也会进多图分支，拿到明确报错）
- `scripts/agent_client.py`：识别服务端业务错误码（`code != 0`）并原样打印说明；`scenes` 为空时以非零退出，避免错误被静默吞掉
- `verify.sh`：新增第 8 项「多图缺数量必须被拒绝且给出数量/形式/示例说明」；新增第 9 项「超上限 40 张必须被拒绝且说明含上限数值」
- `Dockerfile`：生产阶段加 `py3-pillow` + 拷贝 `scripts/` + 注入 5 个 ENV
