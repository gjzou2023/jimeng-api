/**
 * batch.ts —— Agent 批量编排器（方向1+2+3 的统一调度）
 *
 * 职责：
 *  - 从 doc（.md/.txt）或 skill+subject 构建场景列表；
 *  - 按 kind 分派：`image` 走单图原子链路、`video` 走视频原子链路；
 *  - **总量硬上限**：图片 ≤ MAX_AGENT_IMAGE_COUNT(40)、视频 ≤ MAX_AGENT_VIDEO_COUNT(8)；
 *  - 并发控制：图片并发 2 + 间隔 1.5s；**视频串行（并发 1）+ 间隔 3s**（防风控）；
 *  - 每场景随机选账号 token → 多账号轮询（复用上游 tokenSplit）；
 *  - 一致性模式（方向3）：第 1 张 txt2img，后续 img2img 以首图作参考，
 *    参考强度 = sample_strength（默认 0.65，对应文档「参考强度 60-70」）；
 *  - 单场景失败 → 重试 1 次（指数退避）→ 仍失败则跳过+记录，不整体雪崩；
 *    首图失败 → 一致性降级为纯文本设定。
 *
 * 关键实证（来自上游源码审计）：
 *  - generateImages(_model, prompt, {ratio,resolution,...}, token) 每次独立 prompt；
 *  - generateImageComposition(_model, prompt, images[], {sampleStrength,...}, token)
 *    已原生接收 sampleStrength（默认 0.5），通过 buildBlendAbilityList 写入 strength；
 *  - generateVideo(model, prompt, {ratio,resolution,duration,...}, token) 一次调用返回 1 个 URL
 *    （videos.ts 内 expectedItemCount: 1）——**视频没有"一次出多段"的参数**。
 *
 * ⚠️ 2026-09-17 修复（P0）：此前图片场景调用 generateImages() 时**未指定 mode**，
 * 一旦编排请求显式传 jimeng-4.x 且场景提示词命中「连续/绘本/故事」或任意数量写法，
 * generateImagesInternal 会**自动切换到组图分支**（scene: ImageMultiGenerate，一次 ≤15 张），
 * 而本文件只取 `urls[0]` —— 多出的图**已生成、已计费、URL 被静默丢弃**。
 * 现在强制传 `mode: "single"` + `quotaMode: "agent"` 双重收口：
 * 前者禁止组图分支，后者声明本路径豁免「同提示词产出配额」（编排有自己的总量上限）。
 *
 * ⚠️ 2026-09-18 修复（P0，G-2 契约层）：上述修复**只关掉了组图分支**。
 * Step 0 实测（住宅出口 / CN 区 / 1k）发现：`mode:"single"` 生效后（响应回显 `mode=single`），
 * 上游在**单图路径同样返 4 张**，`jimeng-4.0`/`jimeng-5.0`/`nanobanana` 三模型一致。
 * 当时据此推断「上游自由模式单请求产 4 张是**固有行为**，无参数可减」——**该推断已被证伪**
 * （保留留痕，勿据此再下结论）。真因是**我们从未发送张数开关** `abilities.gen_option.gen_count`，
 * 上游只好取模型兜底值 `default_generate_count = 4`（见 `payload-builder.ts` 的 `buildDraftContent`）。
 * 因此本文件做了**双保险**（两层互补，都要保留）：
 *   - 第一层（治本，2026-09-18 C-1）：`payload-builder.ts` 补齐 `gen_count = n`，
 *     单图路径默认出 **1 张**、可由 `n` 指定 1~8 张；
 *   - 第二层（兜底，P0-1/P0-2）：
 *     `AgentSceneResult` 新增 `urls?: string[]`，单图分支与一致性 img2img 分支均**收集全部** URL
 *     （不再 `url = urls[0]`），落盘层按 `urls` 全量落盘并加 `keep` 上限开关。
 *     即便将来上游又改回"多给"，也不会再有"已生成、已计费却被静默丢弃"的图。
 * 关于 `max_items`：语义仍是"**场景数**"上限（官方口径 40 图 / 8 视频指的是场景数，见 N-6），
 * 单场景产出张数由 `n` 单独控制（默认 1）。
 */

import _ from "lodash";
import { tokenSplit } from "@/api/controllers/core.ts";
import { generateImages, generateImageComposition } from "@/api/controllers/images.ts";
import { generateVideo } from "@/api/controllers/videos.ts";
import { MAX_AGENT_IMAGE_COUNT, MAX_AGENT_VIDEO_COUNT, resolveRequestImageCount } from "@/api/builders/payload-builder.ts";
import { parseDoc } from "./markdown.ts";
import { buildSkillScenes, listSkills } from "./skills.ts";
import logger from "@/lib/logger.ts";

/** 编排产出的两种类别 */
export type AgentKind = "image" | "video";

export interface AgentRequest {
  doc?: string;
  skill?: string;
  subject?: string;
  /** 编排类别，默认 "image" */
  kind?: AgentKind;
  model?: string;
  ratio?: string;
  resolution?: string;
  /** 视频时长（秒），默认 5；仅 kind="video" 生效 */
  duration?: number;
  consistency?: boolean;
  ref_strength?: number;
  token?: string; // 原始 Authorization 头（含 Bearer），由路由传入
  /** 显式收紧总量上限（不得超过硬上限） */
  max_items?: number;
  /**
   * 每个场景的**输出张数**（1~8，默认 1）——透传给 `generateImages` / `generateImageComposition`
   * 的 `n` 参数，最终写入报文 `abilities.gen_option.gen_count`。
   * ⚠️ 与 `max_items` 是两个维度：`max_items` 管**场景数**，`n` 管**每个场景出几张**。
   */
  n?: number;
}

export interface AgentSceneResult {
  index: number;
  title: string;
  kind: AgentKind;
  /** 本场景**首图** URL（向后兼容保留；恒等于 urls[0]） */
  url?: string;
  /**
   * 本场景**全部**产出 URL（2026-09-18 新增，P0-2）。
   *
   * 它为什么存在（以及为什么**保留**，即使 C-1 已让 n 生效）：
   *  C-1 之前我们从未发送 `abilities.gen_option.gen_count`，上游遂按模型兜底
   *  `default_generate_count = 4` 出 4 张；而旧契约 `url: string` **从类型上就只能装 1 张**，
   *  于是另外 3 张**已生成、已计费**却被静默丢弃。现在 n 已可控（默认 1 张），
   *  本字段转为**兜底保险**：若上游将来又改回多给、或调用方显式传 `n>1`，
   *  多出的图仍会被完整收下并落盘，不会重现"静默丢图"。
   */
  urls?: string[];
  file?: string; // 路由侧保存的本地文件路径（可选；对应首图）
  /** 全部落盘路径（与 urls 一一对应） */
  files?: string[];
  error?: string;
}

export interface AgentBatchResult {
  kind: AgentKind;
  total: number;
  succeeded: number;
  failed: number;
  cap: number;
  scenes: AgentSceneResult[];
  errors: string[];
}

/**
 * 进度钩子：每完成一个场景（成功或失败）回调一次。
 * 异步任务层（tasks.ts）用它做「逐项落盘 + 任务快照」，实现"断也不丢"。
 */
export interface AgentHooks {
  onScene?: (r: AgentSceneResult, done: number, total: number) => void | Promise<void>;
}

/** 图片并发度（视频恒为 1：串行防风控） */
const IMAGE_CONCURRENCY = 2;
/** 同类别两次提交之间的最小间隔（ms） */
const IMAGE_INTERVAL_MS = 1500;
const VIDEO_INTERVAL_MS = 3000;
/** 逐项重试次数（首次失败后再试 1 次） */
const SCENE_RETRIES = 1;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 总量硬上限（含官方口径出处） */
export function agentCap(kind: AgentKind): number {
  return kind === "video" ? MAX_AGENT_VIDEO_COUNT : MAX_AGENT_IMAGE_COUNT;
}

/**
 * 参数校验：总量不得超过硬上限。
 * 超限**直接抛错**（不截断、不静默丢弃）——静默截断会让调用方以为全都做完了。
 */
function assertWithinCap(kind: AgentKind, count: number): void {
  const cap = agentCap(kind);
  if (count > cap) {
    throw new Error(
      `Agent 编排总量超限：本次请求 ${count} 个${kind === "video" ? "视频" : "图片"}场景，`
      + `而 Agent 模式单次上限为 ${cap} 个${kind === "video" ? "视频" : "图片"}。`
      + `（官方口径：即梦 Agent 模式「一次生成 ${MAX_AGENT_IMAGE_COUNT} 张创意图片」或 ${MAX_AGENT_VIDEO_COUNT} 个视频）`
      + `请拆成多批提交，或减少 doc / skill 模板中的场景数。`
    );
  }
}

/** 逐项重试（指数退避）；全部失败时抛出最后一次异常以便记录原因 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= SCENE_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (attempt < SCENE_RETRIES) {
        const backoff = 2000 * Math.pow(2, attempt);
        logger.warn(`[agent] ${label} 第 ${attempt + 1} 次失败，${backoff}ms 后重试: ${e?.message || e}`);
        await delay(backoff);
      }
    }
  }
  throw lastErr;
}

/** 简易并发池：按 limit 并发执行，单项失败不阻断其余项 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<void>
): Promise<void> {
  const queue = items.map((it, i) => ({ it, i }));
  const n = Math.max(1, Math.min(limit, queue.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        while (queue.length) {
          const job = queue.shift();
          if (!job) break;
          await worker(job.it, job.i);
        }
      })()
    );
  }
  await Promise.all(workers);
}

export async function generateAgentBatch(
  req: AgentRequest,
  hooks: AgentHooks = {}
): Promise<AgentBatchResult> {
  let scenes: { index: number; title: string; prompt: string; params: any }[] = [];

  if (req.doc) {
    const parsed = parseDoc(req.doc);
    scenes = parsed.scenes.map((s) => ({
      index: s.index,
      title: s.title,
      prompt: s.prompt,
      params: s.params,
    }));
  } else if (req.skill && req.subject) {
    const built = buildSkillScenes(req.skill, req.subject);
    if (!built) {
      throw new Error(
        `技能模板不存在: ${req.skill}（可用: ${listSkills().join(", ") || "（无）"}）`
      );
    }
    scenes = built;
  } else {
    throw new Error("必须提供 doc（.md/.txt 文本）或 skill + subject");
  }

  const kind: AgentKind = req.kind === "video" ? "video" : "image";
  const cap = agentCap(kind);

  // 可选：调用方用 max_items 主动收紧上限；只允许"更小"，不允许突破硬上限
  if (typeof req.max_items === "number" && Number.isFinite(req.max_items) && req.max_items > 0) {
    scenes = scenes.slice(0, Math.min(Math.floor(req.max_items), cap));
  }

  // 总量硬闸（防误烧积分）
  assertWithinCap(kind, scenes.length);
  if (scenes.length === 0) {
    throw new Error("场景列表为空：请检查 doc 是否含 '## 场景标题'，或 skill 模板是否存在");
  }

  const globalModel = req.model;
  const globalRatio = req.ratio || "1:1";
  const globalResolution = req.resolution || (kind === "video" ? "720p" : "2k");
  const globalDuration = req.duration && req.duration > 0 ? Math.floor(req.duration) : 5;
  const consistency = !!req.consistency;
  const refStrength =
    req.ref_strength && req.ref_strength >= 0.1 && req.ref_strength <= 1
      ? req.ref_strength
      : 0.65;

  const tokens = req.token ? tokenSplit(req.token) : [];
  const pickToken = (): string => (tokens.length ? (_.sample(tokens) as string) : "");

  // 每个场景的输出张数（1~8，默认 1）。
  // ★ 在这里**一次性**解析：非法值在"生成任何一个场景之前"就抛错，不白扣积分。
  // 未传 → undefined → 由 images.ts 回退到环境变量 JIMENG_BENEFIT_COUNT / 默认 1。
  const sceneImageCount = req.n !== undefined ? resolveRequestImageCount(req.n) : undefined;
  if (kind === "image") {
    logger.info(
      `[agent] 每个场景输出张数 n = ${sceneImageCount ?? "（未指定，取环境变量/默认 1）"}`
      + ` —— 注意与 max_items（场景数上限 ${cap}）是两个维度`
    );
  }

  const results: (AgentSceneResult | undefined)[] = new Array(scenes.length);
  const errors: string[] = [];
  let firstImageUrl: string | undefined;

  logger.info(
    `[agent] 开始编排：kind=${kind} 场景数=${scenes.length} 上限=${cap} `
    + `并发=${kind === "video" ? 1 : IMAGE_CONCURRENCY} 间隔=${kind === "video" ? VIDEO_INTERVAL_MS : IMAGE_INTERVAL_MS}ms`
  );

  const worker = async (sc: (typeof scenes)[number], i: number): Promise<void> => {
    // P1-1 / G-13：不再硬编码 jimeng-5.0（去掉该字符串字面量默认值）。硬编码的代价不只是"国际版不支持它、
    // 开箱必败"，更是**成本 3 倍**——Step 0 实测同提示词同分辨率（CN/1k）：
    // jimeng-4.0 = 1 分/张，jimeng-5.0 与 nanobanana = 3 分/张。
    // 传空串交由 images.ts 的 resolveModel 按**区域默认**决定（DEFAULT_MODEL / DEFAULT_MODEL_US）。
    const model = sc.params.model || globalModel || "";
    const ratio = sc.params.ratio || globalRatio;
    const resolution = sc.params.resolution || globalResolution;
    const token = pickToken();
    const label = `场景${sc.index}「${sc.title}」`;

    try {
      let urls: string[] = [];

      if (kind === "video") {
        const duration = sc.params.duration || globalDuration;
        const videoUrl = await withRetry(label, () =>
          generateVideo(model, sc.prompt, { ratio, resolution, duration } as any, token)
        );
        urls = videoUrl ? [videoUrl] : [];
      } else if (consistency && i > 0 && firstImageUrl) {
        urls = (await withRetry(label, () =>
          generateImageComposition(
            model,
            sc.prompt,
            [firstImageUrl as string],
            { ratio, resolution, sampleStrength: refStrength, n: sceneImageCount } as any,
            token
          )
        )) || [];
      } else {
        // ★ 强制单图 + 声明豁免配额：见文件头「2026-09-17 修复（P0）」
        // ★ n：每场景输出张数（未传则走默认 1）——见文件头「C-1」
        urls = (await withRetry(label, () =>
          generateImages(
            model,
            sc.prompt,
            { ratio, resolution, mode: "single", quotaMode: "agent", n: sceneImageCount } as any,
            token
          )
        )) || [];
      }

      const url = urls.filter((u) => !!u)[0];
      if (!url) throw new Error("未返回 URL");
      if (kind === "image" && i === 0) firstImageUrl = url;
      // 兜底保险（P0-1）：若上游仍多给（或调用方传了 n>1），**全部**收下，不静默丢弃。
      const allUrls = urls.filter((u) => !!u);
      results[i] = { index: sc.index, title: sc.title, kind, url, urls: allUrls };
      logger.info(`[agent] ${label} 生成成功（产出 ${allUrls.length} 张，全部保留）`);
    } catch (e: any) {
      const msg = `${label}失败: ${e?.message || e}`;
      logger.error(msg);
      errors.push(msg);
      results[i] = { index: sc.index, title: sc.title, kind, error: e?.message || String(e) };
      if (kind === "image" && consistency && i === 0) {
        logger.warn("[agent] 首图失败，后续一致性参考降级为纯文本设定");
      }
      // 跳过 + 记录，不整体中断
    }

    // 进度回调（逐项落盘 / 任务快照由调用方决定，失败不影响编排继续）
    if (hooks.onScene) {
      const done = results.filter(Boolean).length;
      try {
        await hooks.onScene(results[i] as AgentSceneResult, done, scenes.length);
      } catch (e: any) {
        logger.warn(`[agent] onScene 回调失败（已忽略，编排继续）: ${e?.message || e}`);
      }
    }
  };

  if (kind === "video") {
    // 视频：严格串行 + 固定间隔（风控面最小化）
    for (let i = 0; i < scenes.length; i++) {
      await worker(scenes[i], i);
      if (i < scenes.length - 1) await delay(VIDEO_INTERVAL_MS);
    }
  } else {
    // 图片：并发池 + 每项之间最小间隔
    await runPool(scenes, IMAGE_CONCURRENCY, async (sc, i) => {
      await worker(sc, i);
      await delay(IMAGE_INTERVAL_MS);
    });
  }

  const finalScenes = results.filter(Boolean) as AgentSceneResult[];
  const succeeded = finalScenes.filter((s) => !!s.url).length;
  const failed = finalScenes.length - succeeded;

  logger.info(`[agent] 编排结束：成功 ${succeeded} / 失败 ${failed} / 共 ${scenes.length}`);

  return { kind, total: scenes.length, succeeded, failed, cap, scenes: finalScenes, errors };
}
