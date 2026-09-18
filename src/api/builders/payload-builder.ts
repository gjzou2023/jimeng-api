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
 * ⚠️ 2026-09-17 更正：此前三条路径共用一个 `MAX_IMAGE_COUNT_PER_REQUEST = 40`，
 * 结果是「单图路径的闸门形同虚设」——单图上游候选实际只有 1–4 张，却按 40 放行，
 * 一旦有人写 `JIMENG_BENEFIT_COUNT=40`，会产生 40 倍积分消耗且报错前无法察觉。
 *
 * 官方口径（逐条取证）：
 *  - 单图（`ImageBasicGenerate` / `benefitCount`）：单提示词最多 **4** 张候选图。
 *    来源：即梦官网功能页 https://jimeng.jianying.com/features/resource/ai-image-generator-free-online
 *    原文「即梦AI可以帮助您通过单个提示词生成多达 4 张图像」。
 *  - 组图（`ImageMultiGenerate`）：最多 **15** 张（输入图数 + 输出图数 ≤ 15）。
 *    来源：火山引擎《即梦AI-图片生成4.0》 https://www.volcengine.com/docs/6394/1820192
 *    原文「组图生成……最多支持生成 15 张（输入图数量+输出图数量 ≤ 15 张）」；参数口径 `max_images 1–15`。
 *  - Agent 编排：**40 图 / 8 视频**。
 *    来源：即梦官方飞书《AGENT 使用手册》（编排产物上限，非某接口的张数参数）。
 *
 * 历史注记：此处曾写「单图路径上游即梦 UI 的可选范围是 1-8」，该数字**无任何来源**，
 * 系推断产物，已删除并按上表更正为官方口径 1–4（证据优先原则）。
 */
export const MAX_SINGLE_IMAGE_COUNT = 4;
export const MAX_GROUP_IMAGE_COUNT = 15;
export const MAX_AGENT_IMAGE_COUNT = 40;
export const MAX_AGENT_VIDEO_COUNT = 8;

/**
 * 图片生成模式（跨层契约：HTTP 入参 → 路由 → 控制器）。
 *
 * - `"single"` = **强制单图**：忽略提示词里的组图关键词与数量写法，张数由 `benefitCount` 决定
 *   （默认 1、上限 `MAX_SINGLE_IMAGE_COUNT`）。**Agent 编排层必须传这个值**，
 *   否则场景提示词一旦含「连续/绘本/故事」就可能被组图分支吞掉（详见 AGENT_FEATURES.md）。
 *   ⚠️ 2026-09-18 实测更正（上文"张数由 benefitCount 决定"**已证伪**，原文留痕）：
 *   本值的真实、且唯一有效的作用是**禁止组图分支**（这一点未变，编排层仍必须传）；
 *   它**改不了上游固有产出**——自由模式单图路径固定返 4 张（三模型一致）；
 *   `benefitCount` 亦**不决定张数**（只写埋点区，见下方 `getImageCountPerRequest()`）。
 * - `"group"`  = **强制组图**：走 `ImageMultiGenerate`，必须在提示词里显式写明张数（1–15）。
 * - `"auto"`   = 兼容模式（**默认**）：**不再按关键词自动切组图**。
 *   即使提示词命中「连续/绘本/故事」或出现数量写法，也**按单图执行**，
 *   并在响应里附一条可读 `hint`，提示调用方可改用 `mode:"group"`。
 *
 * ⚠️ 2026-09-17 口径变更（Q3=C1「保留能力、废弃自动触发」）：
 * 历史行为是「命中关键词就静默切进组图分支」。该行为已废弃，原因有二：
 *   ① 调用方**无法预期产出张数**——一次请求可能返回 1 张、也可能返回 15 张；
 *   ② 编排层（`agent/batch.ts`）只取 `urls[0]`，静默切换会导致**多出的图已生成、已计费、
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
 * 单图路径「每请求生成张数」的唯一读取点。
 *
 * - 默认 1 张（按排查报告"修正与补充"要求：每次只生成 1 张，省约 3/4 计费）
 *   ⚠️ 2026-09-18 实测更正：**该目标无法通过现有参数达成**。住宅出口实测（CN / 1k /
 *   同一提示词形态）：jimeng-4.0、jimeng-5.0、nanobanana 三模型在 mode:"single" 下
 *   **均固定返回 4 张**。本函数返回值只写进埋点区 metrics_extra.sceneOptions[0].benefitCount，
 *   而控制面 core_param 中**没有任何张数字段**——故"省约 3/4 计费"表述已作废（保留原文留痕）。
 * - 设 JIMENG_BENEFIT_COUNT=4 可切回上游行为（生成 4 张候选、4 选 1 挑选）
 *   ⚠️ 2026-09-18 实测更正：设 `1` 或 `4` **产出都是 4 张**——该变量不改变实际产出；
 *   本行仅描述"取值语义与钳制上限"，勿据此推断"设 1 就是 1 张"。
 * - 未设置 / 非数字 / 小于 1 → 回退 1；超过 MAX_SINGLE_IMAGE_COUNT → 按上限截断
 *
 * ⚠️ 本函数是「单图路径张数」的唯一来源：buildCoreParam 的 benefitCount 与
 * images.ts 中 SmartPoller 的 expectedItemCount 都必须调用它。
 * 两处若各自读一遍环境变量，就会出现「只生成 N 张、却轮询等待 M 张」的请求挂起。
 */
export function getImageCountPerRequest(): number {
  const configured = Number(process.env.JIMENG_BENEFIT_COUNT);
  const count = Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
  return Math.min(count, MAX_SINGLE_IMAGE_COUNT);
}

/**
 * benefitCount 规则
 * - 生图模式：取 getImageCountPerRequest()（默认返回 1）
 *   ⚠️ 2026-09-18 实测：该返回值只写**埋点区**，**不影响上游实际产出张数**——
 *   单图路径恒返 4 张（详见 `getImageCountPerRequest()` 注释与 AGENT_FEATURES.md §3.1）。
 * - 多图模式：不加（张数由提示词决定，见 images.ts 的 parseMultiImageCount）
 */
export function getBenefitCount(
  userModel: string,
  regionInfo: RegionInfo,
  isMultiImage: boolean = false
): number | undefined {
  if (isMultiImage) return undefined;
  return getImageCountPerRequest();
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
  const effectiveIntelligentRatio = ['jimeng-4.0', 'jimeng-4.1', 'jimeng-4.5', 'jimeng-4.6', 'jimeng-5.0'].includes(userModel) ? intelligentRatio : false;

  // 图生图时，prompt 前缀规则: 每张图片对应 2 个 #
  // 1张图 → ##, 2张图 → ####, 3张图 → ######
  const promptPrefix = mode === "img2img" ? '#'.repeat(imageCount * 2) : '';

  const coreParam: any = {
    type: "",
    id: util.uuid(),
    model,
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
}: BuildMetricsExtraOptions): string {
  const benefitCount = getBenefitCount(userModel, regionInfo, isMultiImage);

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
  imageCount?: number;  // 图生图时的图片数量
}

export function buildDraftContent({
  componentId,
  generateType,
  coreParam,
  abilityList,
  promptPlaceholderInfoList,
  posteditParam,
  imageCount = 0,
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

  if (generateType === "generate") {
    abilities.generate = {
      type: "",
      id: util.uuid(),
      core_param: coreParam,
      gen_option: {
        type: "",
        id: util.uuid(),
        generate_all: false,
      },
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
    abilities.gen_option = {
      type: "",
      id: util.uuid(),
      generate_all: false,
    };
  }

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
