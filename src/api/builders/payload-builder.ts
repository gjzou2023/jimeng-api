import util from "@/lib/util.ts";
import { DRAFT_MIN_VERSION, DRAFT_VERSION, RESOLUTION_OPTIONS, RESOLUTION_OPTIONS_NANOBANANAPRO_4K } from "@/api/consts/common.ts";
import { RegionInfo, getAssistantId } from "@/api/controllers/core.ts";

export type RegionKey = "CN" | "US" | "HK" | "JP" | "SG";

export interface ResolutionResult {
  width: number;
  height: number;
  imageRatio: number;
  resolutionType: string;
  isForced: boolean;
}

function getRegionKey(regionInfo: RegionInfo): RegionKey {
  if (regionInfo.isUS) return "US";
  if (regionInfo.isHK) return "HK";
  if (regionInfo.isJP) return "JP";
  if (regionInfo.isSG) return "SG";
  return "CN";
}

function lookupResolution(resolution: string = "2k", ratio: string = "1:1", userModel?: string) {
  // nanobananapro 模型使用 4k 时，使用专用配置
  if (userModel === "nanobananapro" && resolution === "4k") {
    const ratioConfig = RESOLUTION_OPTIONS_NANOBANANAPRO_4K[ratio];
    if (!ratioConfig) {
      const supportedRatios = Object.keys(RESOLUTION_OPTIONS_NANOBANANAPRO_4K).join(", ");
      throw new Error(`nanobananapro 模型在 4k 分辨率下，不支持的比例 "${ratio}"。支持的比例: ${supportedRatios}`);
    }
    return {
      width: ratioConfig.width,
      height: ratioConfig.height,
      imageRatio: ratioConfig.ratio,
      resolutionType: resolution,
    };
  }

  const resolutionGroup = RESOLUTION_OPTIONS[resolution];
  if (!resolutionGroup) {
    const supportedResolutions = Object.keys(RESOLUTION_OPTIONS).join(", ");
    throw new Error(`不支持的分辨率 "${resolution}"。支持的分辨率: ${supportedResolutions}`);
  }

  const ratioConfig = resolutionGroup[ratio];
  if (!ratioConfig) {
    const supportedRatios = Object.keys(resolutionGroup).join(", ");
    throw new Error(`在 "${resolution}" 分辨率下，不支持的比例 "${ratio}"。支持的比例: ${supportedRatios}`);
  }

  return {
    width: ratioConfig.width,
    height: ratioConfig.height,
    imageRatio: ratioConfig.ratio,
    resolutionType: resolution,
  };
}

/**
 * 统一分辨率处理逻辑
 * - CN 站: 不支持 nano 系列模型 (nanobanana/nanobananapro)，抛出异常
 * - US 站 nanobanana: 强制 1024x1024 @ 2k，image_ratio=1
 * - HK/JP/SG 站 nanobanana: 强制 1k 分辨率，但 ratio 可自定义
 * - 所有站点 nanobananapro: resolution 和 ratio 都可自定义
 */
export function resolveResolution(
  userModel: string,
  regionInfo: RegionInfo,
  resolution: string = "2k",
  ratio: string = "1:1"
): ResolutionResult {
  const regionKey = getRegionKey(regionInfo);

  // ⚠️ 国内站不支持nano系列模型
  if (regionKey === "CN" && (userModel === "nanobanana" || userModel === "nanobananapro")) {
    throw new Error(
      `国内站不支持${userModel}模型,请使用jimeng系列模型`
    );
  }

  // ⚠️ nanobanana 模型的站点差异处理
  if (userModel === "nanobanana") {
    if (regionKey === "US") {
      // US 站: 强制 1024x1024@2k, ratio 固定为 1
      return {
        width: 1024,
        height: 1024,
        imageRatio: 1,
        resolutionType: "2k",
        isForced: true,
      };
    } else if (regionKey === "HK" || regionKey === "JP" || regionKey === "SG") {
      // HK/JP/SG 站: 强制 1k 分辨率，但 ratio 可自定义
      const params = lookupResolution("1k", ratio, userModel);
      return {
        width: params.width,
        height: params.height,
        imageRatio: params.imageRatio,
        resolutionType: "1k",
        isForced: true,
      };
    }
  }

  // 其他所有情况: 使用用户指定的 resolution 和 ratio
  const params = lookupResolution(resolution, ratio, userModel);
  return {
    ...params,
    isForced: false,
  };
}

/**
 * 图片张数上限 —— 三条图片路径**各自独立**，禁止共用一个数。
 *
 * 官方口径（逐条取证）：
 *  - 单图（`ImageBasicGenerate`）：**1~8 张，默认 1 张**。
 *    来源：即梦官网图片模式 UI 实测截图（用户提供，2026-09-18）——张数选择器范围 1–8、当前值 1；
 *    旁证：`zhizinan1997/jimeng-free-api-all` README「n 支持 1~8，默认 1 张」。
 *  - 组图（`ImageMultiGenerate`）：最多 **15** 张（输入图数 + 输出图数 ≤ 15）。
 *    来源：火山引擎《即梦AI-图片生成4.0》 https://www.volcengine.com/docs/6394/1820192
 *    原文「组图生成……最多支持生成 15 张（输入图数量+输出图数量 ≤ 15 张）」；参数口径 `max_images 1–15`。
 *  - Agent 编排：**40 图 / 8 视频**。
 *    来源：即梦官方飞书《AGENT 使用手册》（编排产物上限，非某接口的张数参数）。
 *
 * ⚠️ 2026-09-18 二次更正（**推翻 2026-09-17 的 4**）：
 *  上版注释称「单图上游最多 4 张」并引官网功能页「单个提示词生成多达 4 张图像」为据。
 *  该引用**用错了证据等级**——营销文案描述的是"未指定张数时上游的兜底产出"，不是"用户可选范围"。
 *  同一事实的第三面（真正的根因）是：我们**从未发送过张数开关字段** `abilities.gen_option.gen_count`，
 *  上游取模型 `default_generate_count`（4.x/5.x 图片模型 = 4）→ 表现为"恒出 4 张、扣 4 份"。
 *  依据：`zhizinan1997/jimeng-free-api-all` commit `ad24c899`（2026-09-14）原文——
 *  「The `n` parameter was written to the component-level `gen_option` field, **which Jimeng ignores**.
 *    The service therefore always fell back to the model's `default_generate_count`
 *    (**4 for the 4.x/5.x image models**) and billed for four samples regardless of n」，
 *  并附实测「n=1 renders 1 sample and consumes 1 credit (**previously 4 samples / 4 credits**)」。
 *  ⇒ "4" 是**未传时的默认产出**，不是上限。上限 = 官网 UI 的 8。
 *
 * 历史注记（保留留痕，勿据此推断）：本行曾为 `MAX_SINGLE_IMAGE_COUNT = 40`（三路径共用，单图闸门形同虚设），
 * 2026-09-17 改为 `4`（依据错误），2026-09-18 更正为 `8`（依据官网 UI 实测）。
 */
export const MAX_SINGLE_IMAGE_COUNT = 8;
export const MAX_GROUP_IMAGE_COUNT = 15;
export const MAX_AGENT_IMAGE_COUNT = 40;
export const MAX_AGENT_VIDEO_COUNT = 8;

/**
 * 图片生成模式（跨层契约：HTTP 入参 → 路由 → 控制器）。
 *
 * - `"single"` = **强制单图**：忽略提示词里的组图关键词与数量写法，张数由 `n` 决定
 *   （默认 1、上限 `MAX_SINGLE_IMAGE_COUNT` = 8）。**Agent 编排层必须传这个值**，
 *   否则场景提示词一旦含「连续/绘本/故事」就可能被组图分支吞掉（详见 AGENT_FEATURES.md）。
 *   ⚠️ 2026-09-18 修正（上文旧注"张数由 benefitCount 决定"**已证伪**，留痕）：
 *   真正决定张数的是 `abilities.gen_option.gen_count`（本路径由 `n` 注入）；
 *   `benefitCount` 是**埋点区**字段，不控制产出（但它现在**跟随 n 取值**，以与官网报文一致）。
 * - `"group"`  = **强制组图**：走 `ImageMultiGenerate`，必须在提示词里显式写明张数（1–15）。
 * - `"auto"`   = 兼容模式（**默认**）：**不再按关键词自动切组图**。
 *   即使提示词命中「连续/绘本/故事」或出现数量写法，也**按单图执行**，
 *   并在响应里附一条可读 `hint`，提示调用方可改用 `mode:"group"`。
 *
 * ⚠️ 2026-09-17 口径变更（Q3=C1「保留能力、废弃自动触发」）：
 * 历史行为是「命中关键词就静默切进组图分支」。该行为已废弃，原因有二：
 *   ① 调用方**无法预期产出张数**——一次请求可能返回 1 张、也可能返回 15 张；
 *   ② 编排层（`agent/batch.ts`）历史上只取 `urls[0]`，静默切换会导致**多出的图已生成、已计费、
 *      URL 被丢弃**（见 §1.4 缺陷 #1）。
 * 组图**能力完整保留**，只是入口从「隐式关键词」改为「显式 `mode:"group"`」。
 *
 * 新代码请**显式传 mode**，不要依赖 `"auto"`（该值仅为不破坏既有调用方而保留）。
 */
export type ImageMode = "single" | "group" | "auto";

/** 入参 mode 归一化：非法/缺失一律回退 `"auto"`。 */
export function normalizeImageMode(raw: unknown): ImageMode {
  return raw === "single" || raw === "group" ? raw : "auto";
}

/**
 * 单图路径「每请求生成张数」的**唯一读取/钳制点**。
 *
 * 取值优先级：**显式入参 `n`** ＞ 环境变量 `JIMENG_BENEFIT_COUNT` ＞ 默认 `1`。
 * 说明：本函数是**兜底路径**——越界/非数字 → 回退 `1`；超过 `MAX_SINGLE_IMAGE_COUNT` → 按上限截断。
 * 调用方若要走"越界就报错"的严格语义，请用 `resolveRequestImageCount()`（HTTP 入口用那个）。
 *
 * ⚠️ 2026-09-18 更正（推翻本函数旧注释「该目标无法通过现有参数达成」）：
 *  旧注释断言"三模型在 mode:single 下均固定返回 4 张，无参数可控"——**已证伪**。
 *  真因是本函数的值**只写进了埋点区**（`metrics_extra.sceneOptions[0].benefitCount`），
 *  而**控制面** `component.abilities.gen_option` 里**根本没有 `gen_count`**（我们从未发过它）。
 *  现已补齐（见 `buildDraftContent`），本函数的返回值同时进入两处、且**同源**：
 *    ① 控制面 `abilities.gen_option.gen_count`（决定上游实际产出张数）
 *    ② 埋点区 `metrics_extra...benefitCount`（与官网报文一致）
 *
 * ⚠️ 本函数是「单图路径张数」的唯一来源：`buildMetricsExtra` 的 benefitCount、
 * `buildDraftContent` 的 gen_count 与 images.ts 中 SmartPoller 的 expectedItemCount 都取同一个值。
 * 三处若各自读一遍环境变量，就会出现「只生成 N 张、却轮询等待 M 张」的请求挂起。
 */
export function getImageCountPerRequest(explicitCount?: unknown): number {
  const raw = explicitCount !== undefined && explicitCount !== null && explicitCount !== ""
    ? explicitCount
    : process.env.JIMENG_BENEFIT_COUNT;
  const configured = Number(raw);
  const count = Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
  return Math.min(count, MAX_SINGLE_IMAGE_COUNT);
}

/**
 * 校验并归一化「调用方显式传入的张数 `n`」。
 *
 * 与 `getImageCountPerRequest()` 的分工：
 *  - 显式入参**越界必须报错**（不静默截断）——否则调用方以为拿到了 9 张，实际只给 8 张；
 *  - 未传时才回退环境变量/默认值（静默是安全的，因为本来就是"用默认"）。
 *
 * @throws Error 当 n 非整数或不在 [1, MAX_SINGLE_IMAGE_COUNT] 内
 */
export function resolveRequestImageCount(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return getImageCountPerRequest();
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SINGLE_IMAGE_COUNT) {
    throw new Error(
      `参数 n（生成张数）必须是 1-${MAX_SINGLE_IMAGE_COUNT} 之间的整数，收到: ${JSON.stringify(raw)}。`
      + `（官网图片模式单图可选范围 1-${MAX_SINGLE_IMAGE_COUNT}，默认 1；`
      + `需要更多张请改用 mode:"group"（≤${MAX_GROUP_IMAGE_COUNT} 张）或 POST /v1/agent/tasks（≤${MAX_AGENT_IMAGE_COUNT} 张）。）`
    );
  }
  return n;
}

/**
 * benefitCount 规则（**埋点区**字段，不控制产出）
 * - 生图模式：取传进来的 `imageCount`（与 `gen_count` 同源），未传则回退 `getImageCountPerRequest()`
 * - 多图模式：不加（张数由提示词决定，见 images.ts 的 parseMultiImageCount）
 *
 * ⚠️ 2026-09-18 更正：旧实现此处**硬编码**为 `getImageCountPerRequest()` 的返回值，
 * 而调用方（images.ts）已算好本次张数 → 一旦传了显式 `n`，埋点值会与真实张数脱节。
 * 现改为**跟随 `n`**（与官网报文一致；参考实现同样把 `benefitCount` 从"按分辨率硬编码"改为 `benefitCount: n`）。
 */
export function getBenefitCount(
  userModel: string,
  regionInfo: RegionInfo,
  isMultiImage: boolean = false,
  imageCount?: number
): number | undefined {
  if (isMultiImage) return undefined;
  return imageCount !== undefined ? Math.min(imageCount, MAX_SINGLE_IMAGE_COUNT) : getImageCountPerRequest();
}

export type GenerateMode = "text2img" | "img2img";

export interface BuildCoreParamOptions {
  userModel: string;  // 用户模型名（如 'jimeng-4.0', 'nanobanana'）
  model: string;      // 映射后的内部模型名
  prompt: string;
  imageCount?: number;  // 图生图时的图片数量，用于生成动态 ## 前缀
  negativePrompt?: string;
  seed?: number;
  sampleStrength: number;
  resolution: ResolutionResult;
  intelligentRatio?: boolean;
  mode?: GenerateMode;
}

/**
 * 构建 core_param
 * - 图生图: image_ratio 始终保留，prompt 前缀为 ## * imageCount
 * - 文生图: intelligent_ratio=true 时移除 image_ratio
 * - intelligent_ratio 仅对 jimeng-4.0/jimeng-4.1/jimeng-4.5 模型有效，其他模型忽略此参数
 *
 * ⚠️ 2026-09-18 新增 `generate_type: 0`（C-4，报文对齐官网）。
 * 依据：`zhizinan1997/jimeng-free-api-all` commit `ad24c899` 的 diff —— 文生图与图生图
 * **两个分支**都在 `core_param` 内加上了 `generate_type: 0`（与官网当前报文一致）。
 * 该字段**不是**治愈"恒出 4 张"的因果字段（因果字段是 `abilities.gen_option.gen_count`），
 * 属"降低被上游拒绝概率"的格式对齐；若线上回归异常，可单独回退本行。
 */
export function buildCoreParam(options: BuildCoreParamOptions) {
  const {
    userModel,
    model,
    prompt,
    imageCount = 0,
    negativePrompt,
    seed,
    sampleStrength,
    resolution,
    intelligentRatio = false,
    mode = "text2img",
  } = options;

  // ⚠️ intelligent_ratio 仅对 jimeng-4.0/jimeng-4.1/jimeng-4.5/jimeng-4.6/jimeng-5.0 模型有效
  const effectiveIntelligentRatio = ['jimeng-4.0', 'jimeng-4.1', 'jimeng-4.5', 'jimeng-4.6', 'jimeng-5.0', 'jimeng-5.0-lite'].includes(userModel) ? intelligentRatio : false;

  // 图生图时，prompt 前缀规则: 每张图片对应 2 个 #
  // 1张图 → ##, 2张图 → ####, 3张图 → ######
  const promptPrefix = mode === "img2img" ? '#'.repeat(imageCount * 2) : '';

  const coreParam: any = {
    type: "",
    id: util.uuid(),
    model,
    // C-4：与官网当前报文对齐（见函数头注）。0 = 普通生成。
    generate_type: 0,
    prompt: `${promptPrefix}${prompt}`,
    sample_strength: sampleStrength,
    large_image_info: {
      type: "",
      id: util.uuid(),
      min_version: DRAFT_MIN_VERSION,
      height: resolution.height,
      width: resolution.width,
      resolution_type: resolution.resolutionType,
    },
    intelligent_ratio: effectiveIntelligentRatio,
  };

  if (mode === "img2img") {
    coreParam.image_ratio = resolution.imageRatio;
  } else if (!effectiveIntelligentRatio) {
    coreParam.image_ratio = resolution.imageRatio;
  }

  if (negativePrompt !== undefined) {
    coreParam.negative_prompt = negativePrompt;
  }

  if (seed !== undefined) {
    coreParam.seed = seed;
  }

  return coreParam;
}

export type SceneType = "ImageBasicGenerate" | "ImageMultiGenerate";

/**
 * metrics_extra 中 abilityList 的能力项
 * - source.imageUrl: 前端使用 blob URL (如 blob:https://dreamina.capcut.com/[uuid])
 * - 后端实现时需要生成占位符,保持 blob URL 格式
 */
interface Ability {
  abilityName: string;
  strength: number;
  source?: {
    imageUrl: string;  // 格式: blob:https://dreamina.capcut.com/[uuid]
  };
}

export interface BuildMetricsExtraOptions {
  userModel: string;
  model: string;       // 映射后的内部模型名 (如 high_aes_general_v50)
  regionInfo: RegionInfo;
  submitId: string;
  scene: SceneType;
  resolutionType: string;
  abilityList?: Ability[];
  isMultiImage?: boolean;
  /** 本次实际张数（与 gen_count 同源；未传则回退 getImageCountPerRequest()） */
  imageCount?: number;
}

/**
 * 构建 metrics_extra，自动处理 benefitCount 站点差异 & 多图禁用
 */
export function buildMetricsExtra({
  userModel,
  model,
  regionInfo,
  submitId,
  scene,
  resolutionType,
  abilityList = [],
  isMultiImage = false,
  imageCount,
}: BuildMetricsExtraOptions): string {
  const benefitCount = getBenefitCount(userModel, regionInfo, isMultiImage, imageCount);

  const sceneOption: any = {
    type: "image",
    scene,
    modelReqKey: model,
    resolutionType,
    abilityList,
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: `${model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
  };

  if (benefitCount !== undefined) {
    sceneOption.benefitCount = benefitCount;
  }

  const metrics: any = {
    promptSource: "custom",
    generateCount: 1,
    enterFrom: "click",
    sceneOptions: JSON.stringify([sceneOption]),
    generateId: submitId,
    isRegenerate: false,
  };

  if (isMultiImage) {
    Object.assign(metrics, {
      templateId: "",
      templateSource: "",
      lastRequestId: "",
      originRequestId: "",
    });
  }

  return JSON.stringify(metrics);
}

export interface BuildDraftContentOptions {
  componentId: string;
  generateType: "generate" | "blend";
  coreParam: any;
  abilityList?: any[];
  promptPlaceholderInfoList?: any[];
  posteditParam?: any;
  imageCount?: number;  // 图生图时的**输入**图片数量
  /**
   * ★ 本次请求的**输出**张数 → 写入 `abilities.gen_option.gen_count`（1~8，默认 1）。
   * 未传则回退 `getImageCountPerRequest()`（环境变量 JIMENG_BENEFIT_COUNT → 默认 1）。
   */
  genCount?: number;
}

/**
 * 构建 draft_content —— **"恒出 4 张"的根因就在本函数**。
 *
 * ⚠️ 2026-09-18 关键修复（C-1）：
 *  ① `gen_option` 从 `abilities.generate` **内部** 上移到 `abilities` **层**
 *     （与 `generate` / `blend` 平级）——这是官网报文的真实层级；
 *  ② 补上 `gen_count = n`（1~8）——这是我们**从未发送过**的字段。
 *
 * 为什么这是根因（逐字取证）：
 *  `zhizinan1997/jimeng-free-api-all` commit `ad24c899`（2026-09-14）原文——
 *  「The `n` parameter was written to the component-level `gen_option` field,
 *    **which Jimeng ignores**. The service therefore always fell back to the model's
 *    `default_generate_count` (**4 for the 4.x/5.x image models**) and billed for four samples
 *    regardless of n, while the response was silently truncated to n items via slice(0, n).」
 *  修后实测：「n=1 renders 1 sample and consumes 1 credit (previously 4 samples / 4 credits),
 *            n=2 renders 2 samples / 2 credits」。
 *
 *  我们的缺陷形态与其**同源不同形**：它把 `gen_option` 放在 **component 级**（被忽略），
 *  我们把 `gen_option` 放在 **`abilities.generate` 内部**（同样被忽略），且**都没有 `gen_count`**。
 *  共同结果：上游找不到张数开关 → 取模型兜底 `default_generate_count = 4` → 恒出 4 张、扣 4 份。
 *
 * 回退开关：若线上回归发现异常，只需把 `abilities.gen_option` 移回 `abilities.generate` 内
 * 并去掉 `gen_count`，即恢复本次修复前的行为（其他改动互不影响）。
 */
export function buildDraftContent({
  componentId,
  generateType,
  coreParam,
  abilityList,
  promptPlaceholderInfoList,
  posteditParam,
  imageCount = 0,
  genCount,
}: BuildDraftContentOptions): string {
  const abilities: any = {
    type: "",
    id: util.uuid(),
  };

  // 图生图时，draft 和 blend 的 min_version 规则:
  // - draft.min_version: 始终为 "3.2.9"
  // - blend.min_version: 仅当 imageCount >= 2 时添加 "3.2.9"
  const isBlend = generateType === "blend";
  const draftMinVersion = isBlend ? "3.2.9" : DRAFT_MIN_VERSION;

  // ★ 本次输出张数（唯一钳制点，防越界）
  const requestedGenCount = getImageCountPerRequest(genCount);

  if (generateType === "generate") {
    // ⚠️ `gen_option` **不在这里**（C-1 修复点）——它必须放在 abilities 层，见下方统一赋值。
    abilities.generate = {
      type: "",
      id: util.uuid(),
      core_param: coreParam,
    };
  } else {
    abilities.blend = {
      type: "",
      id: util.uuid(),
      ...(imageCount >= 2 ? { min_version: "3.2.9" } : {}),
      min_features: [],
      core_param: coreParam,
      ability_list: abilityList,
      prompt_placeholder_info_list: promptPlaceholderInfoList,
      postedit_param: posteditParam,
    };
  }

  // ★★ 张数开关：`abilities.gen_option`（与 generate / blend **平级**），内含 `gen_count`。
  // 两种模式（generate / blend）都需要它——官网报文在两个分支里都带这一层。
  abilities.gen_option = {
    type: "",
    id: util.uuid(),
    gen_count: requestedGenCount,
    generate_all: false,
  };

  const draftContent = {
    type: "draft",
    id: util.uuid(),
    min_version: draftMinVersion,
    min_features: [],
    is_from_tsn: true,
    version: DRAFT_VERSION,
    main_component_id: componentId,
    component_list: [
      {
        type: "image_base_component",
        id: componentId,
        min_version: DRAFT_MIN_VERSION,
        aigc_mode: "workbench",
        metadata: {
          type: "",
          id: util.uuid(),
          created_platform: 3,
          created_platform_version: "",
          created_time_in_ms: Date.now().toString(),
          created_did: "",
        },
        generate_type: generateType,
        // C-4：官网报文在 component 层带 `gen_type: 1`（与 generate_type / aigc_mode 平级）。
        // 依据同 commit `ad24c899`（该行由 component 级 `gen_option` 替换而来）。
        gen_type: 1,
        abilities,
      },
    ],
  };

  return JSON.stringify(draftContent);
}

export interface BuildGenerateRequestOptions {
  model: string;
  regionInfo: RegionInfo;
  submitId: string;
  draftContent: string;
  metricsExtra: string;
}

export function buildGenerateRequest({
  model,
  regionInfo,
  submitId,
  draftContent,
  metricsExtra,
}: BuildGenerateRequestOptions) {
  return {
    extend: {
      root_model: model,
    },
    submit_id: submitId,
    metrics_extra: metricsExtra,
    draft_content: draftContent,
    http_common_info: {
      aid: getAssistantId(regionInfo),
    },
  };
}

export function buildBlendAbilityList(uploadedImageIds: string[], strength: number): any[] {
  return uploadedImageIds.map((imageId) => ({
    type: "",
    id: util.uuid(),
    name: "byte_edit",
    image_uri_list: [imageId],
    image_list: [
      {
        type: "image",
        id: util.uuid(),
        source_from: "upload",
        platform_type: 1,
        name: "",
        image_uri: imageId,
        width: 0,
        height: 0,
        format: "",
        uri: imageId,
      },
    ],
    strength,
  }));
}

export function buildPromptPlaceholderList(count: number): any[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "",
    id: util.uuid(),
    ability_index: index,
  }));
}
