import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, parseRegionFromToken, getAssistantId, checkImageContent, RegionInfo } from "./core.ts";
import logger from "@/lib/logger.ts";
import { SmartPoller, PollingStatus } from "@/lib/smart-poller.ts";
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_MODEL_US, IMAGE_MODEL_MAP, IMAGE_MODEL_MAP_US, IMAGE_MODEL_MAP_ASIA } from "@/api/consts/common.ts";
import { uploadImageFromUrl, uploadImageBuffer } from "@/lib/image-uploader.ts";
import { extractImageUrls } from "@/lib/image-utils.ts";
import { assertPromptQuota, commitPromptQuota, QuotaMode } from "@/api/guards/prompt-quota.ts";
import {
  resolveResolution,
  getImageCountPerRequest,
  MAX_GROUP_IMAGE_COUNT,
  MAX_AGENT_IMAGE_COUNT,
  normalizeImageMode,
  ImageMode,
  buildCoreParam,
  buildMetricsExtra,
  buildDraftContent,
  buildGenerateRequest,
  buildBlendAbilityList,
  buildPromptPlaceholderList,
  ResolutionResult,
} from "@/api/builders/payload-builder.ts";

export const DEFAULT_MODEL = DEFAULT_IMAGE_MODEL;
export const DEFAULT_MODEL_US = DEFAULT_IMAGE_MODEL_US;

export interface ModelResult {
  model: string;
  userModel: string;
}

/**
 * 文生图路由元信息（出参）。
 *
 * 用途：把「本次实际走了哪条路径」「有没有可读提示」回传给路由层，
 * 避免像历史实现那样"静默切换 / 静默丢弃"。
 *
 * - `mode`：本次**实际生效**的模式（single / group）。
 * - `hint`：非空表示提示词具备组图特征但未显式声明 mode，本次已按单图执行；
 *   路由层应把它作为响应字段回给调用方。
 */
export interface ImageGenMeta {
  mode?: ImageMode;
  hint?: string;
}

/**
 * 获取模型映射
 * - 根据站点选择不同的模型映射 (CN / US / ASIA)
 * - 不支持的模型会抛出错误
 * - 但如果传入的是国内站默认模型，国际站会自动回退到国际站默认模型
 */
export function getModel(model: string, regionInfo: RegionInfo): ModelResult {
  let modelMap: Record<string, string>;
  if (regionInfo.isUS) {
    modelMap = IMAGE_MODEL_MAP_US;
  } else if (regionInfo.isHK || regionInfo.isJP || regionInfo.isSG) {
    modelMap = IMAGE_MODEL_MAP_ASIA;
  } else {
    modelMap = IMAGE_MODEL_MAP;
  }
  const defaultModel = regionInfo.isInternational ? DEFAULT_MODEL_US : DEFAULT_MODEL;

  // P1-2（2026-09-18 新增分支，纯追加，不改动下方既有逻辑）：
  // 显式定义「**未传** model」的行为 → 落到**区域默认**。
  // 旧实现对未传（空串/undefined）会一路走到下面的 "国际版不支持模型" 抛错，
  // 这正是 P1-1（去 Agent 层硬编码默认模型）的前置依赖。
  if (!model) {
    logger.info(`未指定模型，使用区域默认模型 "${defaultModel}"`);
    return { model: modelMap[defaultModel], userModel: defaultModel };
  }

  if (regionInfo.isInternational && !modelMap[model]) {
    // 如果传入的是国内站默认模型，回退到国际站默认模型
    if (model === DEFAULT_MODEL) {
      logger.info(`国际站不支持默认模型 "${model}"，回退到 "${defaultModel}"`);
      return { model: modelMap[defaultModel], userModel: defaultModel };
    }
    const supportedModels = Object.keys(modelMap).join(', ');
    throw new Error(`国际版不支持模型 "${model}"。支持的模型: ${supportedModels}`);
  }

  const effectiveUserModel = modelMap[model] ? model : defaultModel;
  return { model: modelMap[effectiveUserModel], userModel: effectiveUserModel };
}

/**
 * 记录分辨率信息
 */
function logResolutionInfo(userModel: string, resolution: ResolutionResult, regionInfo: RegionInfo) {
  if (!resolution.isForced) return;

  if (userModel === 'nanobanana') {
    if (regionInfo.isUS) {
      logger.warn('美区 nanobanana 模型固定使用1024x1024分辨率和2k的清晰度，比例固定为1:1。');
    } else if (regionInfo.isHK || regionInfo.isJP || regionInfo.isSG) {
      const regionName = regionInfo.isHK ? '香港' : regionInfo.isJP ? '日本' : '新加坡';
      logger.warn(`${regionName}站 nanobanana 模型固定使用1k清晰度。`);
    }
  }
}

/**
 * 图生图
 */
export async function generateImageComposition(
  _model: string,
  prompt: string,
  images: (string | Buffer)[],
  {
    ratio = '1:1',
    resolution = '2k',
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  const regionInfo = parseRegionFromToken(refreshToken);
  const { model, userModel } = getModel(_model, regionInfo);

  // 使用 payload-builder 处理分辨率
  const resolutionResult = resolveResolution(userModel, regionInfo, resolution, ratio);
  logResolutionInfo(userModel, resolutionResult, regionInfo);

  const imageCount = images.length;
  logger.info(`使用模型: ${userModel} 映射模型: ${model} 图生图功能 ${imageCount}张图片 ${resolutionResult.width}x${resolutionResult.height} 精细度: ${sampleStrength}`);

  // 获取积分
  try {
    const { totalCredit } = await getCredit(refreshToken);
    if (totalCredit <= 0) {
      logger.info("积分为 0，尝试收取今日积分...");
      try {
        await receiveCredit(refreshToken);
      } catch (receiveError) {
        logger.warn(`收取积分失败: ${receiveError.message}. 这可能是因为: 1) 今日已收取过积分, 2) 账户受到风控限制, 3) 需要在官网手动收取首次积分`);
      }
    }
  } catch (e) {
    logger.warn(`获取积分失败，可能是不支持的区域或token已失效: ${e.message}`);
  }

  // 上传图片
  const uploadedImageIds: string[] = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const image = images[i];
      let imageId: string;
      if (typeof image === 'string') {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (URL)...`);
        imageId = (await uploadImageFromUrl(image, refreshToken, regionInfo)).uri;
      } else {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (Buffer)...`);
        imageId = (await uploadImageBuffer(image, refreshToken, regionInfo)).uri;
      }
      uploadedImageIds.push(imageId);
      await checkImageContent(imageId, refreshToken, regionInfo);
      logger.info(`图片 ${i + 1}/${imageCount} 上传成功: ${imageId}`);
    } catch (error) {
      logger.error(`图片 ${i + 1}/${imageCount} 上传失败: ${error.message}`);
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图片上传失败: ${error.message}`);
    }
  }

  logger.info(`所有图片上传完成，开始图生图: ${uploadedImageIds.join(', ')}`);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 使用 payload-builder 构建 core_param
  const coreParam = buildCoreParam({
    userModel,
    model,
    prompt,
    negativePrompt,
    imageCount,
    sampleStrength,
    resolution: resolutionResult,
    intelligentRatio,
    mode: "img2img",
  });

  // 构建 metrics_extra 中的 abilityList
  const metricsAbilityList = uploadedImageIds.map(() => ({
    abilityName: "byte_edit",
    strength: sampleStrength,
    source: {
      imageUrl: `blob:https://dreamina.capcut.com/${util.uuid()}`
    }
  }));

  // 使用 payload-builder 构建 metrics_extra
  const metricsExtra = buildMetricsExtra({
    userModel,
    model,
    regionInfo,
    submitId,
    scene: "ImageBasicGenerate",
    resolutionType: resolutionResult.resolutionType,
    abilityList: metricsAbilityList,
  });

  // 使用 payload-builder 构建 draft_content
  const abilityList = buildBlendAbilityList(uploadedImageIds, sampleStrength);
  const promptPlaceholderInfoList = buildPromptPlaceholderList(uploadedImageIds.length);
  const posteditParam = {
    type: "",
    id: util.uuid(),
    generate_type: 0
  };

  const draftContent = buildDraftContent({
    componentId,
    generateType: "blend",
    coreParam,
    abilityList,
    promptPlaceholderInfoList,
    posteditParam,
    imageCount,
  });

  // 使用 payload-builder 构建完整请求
  const requestData = buildGenerateRequest({
    model,
    regionInfo,
    submitId,
    draftContent,
    metricsExtra,
  });

  const imageReferer = regionInfo.isCN
    ? "https://jimeng.jianying.com/ai-tool/generate?type=image"
    : "https://dreamina.capcut.com/ai-tool/generate?type=image";

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    { data: requestData, headers: { Referer: imageReferer } }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`图生图任务已提交，history_id: ${historyId}，等待生成完成...`);

  // 轮询结果
  const poller = new SmartPoller({
    maxPollCount: 900,
    pollInterval: 10000, // 10秒轮询间隔
    expectedItemCount: 1,
    type: 'image',
    timeoutSeconds: 1800 // 30 分钟超时
  });

  const { result: pollingResult, data: finalTaskInfo } = await poller.poll(async () => {
    const response = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            { scene: "smart_crop", width: 360, height: 360, uniq_key: "smart_crop-w:360-h:360", format: "webp" },
            { scene: "smart_crop", width: 480, height: 480, uniq_key: "smart_crop-w:480-h:480", format: "webp" },
            { scene: "smart_crop", width: 720, height: 720, uniq_key: "smart_crop-w:720-h:720", format: "webp" },
            { scene: "smart_crop", width: 720, height: 480, uniq_key: "smart_crop-w:720-h:480", format: "webp" },
            { scene: "normal", width: 2400, height: 2400, uniq_key: "2400", format: "webp" },
            { scene: "normal", width: 1080, height: 1080, uniq_key: "1080", format: "webp" },
            { scene: "normal", width: 720, height: 720, uniq_key: "720", format: "webp" },
            { scene: "normal", width: 480, height: 480, uniq_key: "480", format: "webp" },
            { scene: "normal", width: 360, height: 360, uniq_key: "360", format: "webp" }
          ]
        }
      }
    });

    if (!response[historyId]) {
      logger.error(`历史记录不存在: historyId=${historyId}`);
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");
    }

    const taskInfo = response[historyId];
    return {
      status: {
        status: taskInfo.status,
        failCode: taskInfo.fail_code,
        itemCount: (taskInfo.item_list || []).length,
        finishTime: taskInfo.task?.finish_time || 0,
        historyId
      } as PollingStatus,
      data: taskInfo
    };
  }, historyId);

  const item_list = finalTaskInfo.item_list || [];
  const resultImageUrls = extractImageUrls(item_list);

  if (resultImageUrls.length === 0 && item_list.length > 0) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图生图失败: item_list有 ${item_list.length} 个项目，但无法提取任何图片URL`);
  }

  logger.info(`图生图结果: 成功生成 ${resultImageUrls.length} 张图片，总耗时 ${pollingResult.elapsedTime} 秒，最终状态: ${pollingResult.status}`);

  return resultImageUrls;
}

/**
 * 文生图入口
 *
 * mode（可选，见 payload-builder.ts 的 ImageMode）：
 *  - "single" 强制单图；"group" 强制组图；缺省/"auto" 为兼容模式（**不再按关键词切组图**）。
 *
 * meta（可选，出参）：调用方传入一个空对象即可收回本次的路由元信息。
 *  - `meta.hint` 非空时，表示「本提示词具备组图特征但未显式声明 mode，已按单图执行」，
 *    路由层应把这段文案回给调用方（`hint` 字段），做到"不静默切换、也不静默丢弃"。
 */
export async function generateImages(
  _model: string,
  prompt: string,
  {
    ratio = '1:1',
    resolution = '2k',
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
    mode,
    quotaMode = "single",
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
    mode?: ImageMode | string;
    quotaMode?: QuotaMode;
  },
  refreshToken: string,
  meta?: ImageGenMeta
) {
  const regionInfo = parseRegionFromToken(refreshToken);
  const { model, userModel } = getModel(_model, regionInfo);
  logger.info(`使用模型: ${userModel} 映射模型: ${model} 分辨率: ${resolution} 比例: ${ratio} 精细度: ${sampleStrength} 智能比例: ${intelligentRatio}`);

  return await generateImagesInternal(userModel, prompt, { ratio, resolution, sampleStrength, negativePrompt, intelligentRatio, mode, quotaMode }, refreshToken, meta);
}

/**
 * 文生图内部实现
 */
async function generateImagesInternal(
  _model: string,
  prompt: string,
  {
    ratio,
    resolution,
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
    mode,
    quotaMode = "single",
  }: {
    ratio: string;
    resolution: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
    mode?: ImageMode | string;
    quotaMode?: QuotaMode;
  },
  refreshToken: string,
  meta?: ImageGenMeta
) {
  const regionInfo = parseRegionFromToken(refreshToken);
  const { model, userModel } = getModel(_model, regionInfo);

  // 使用 payload-builder 处理分辨率
  const resolutionResult = resolveResolution(userModel, regionInfo, resolution, ratio);
  logResolutionInfo(userModel, resolutionResult, regionInfo);

  // 获取积分
  const { totalCredit, giftCredit, purchaseCredit, vipCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) {
    logger.info("积分为 0，尝试收取今日积分...");
    try {
      await receiveCredit(refreshToken);
      logger.info("积分收取成功，继续生成图片");
    } catch (receiveError) {
      logger.warn(`收取积分失败: ${receiveError.message}. 这可能是因为: 1) 今日已收取过积分, 2) 账户受到风控限制, 3) 需要在官网手动收取首次积分`);
      throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
        `积分不足且无法自动收取。请访问即梦官网手动收取首次积分，或检查账户状态。`);
    }
  } else {
    logger.info(`当前积分状态: 总计=${totalCredit}, 赠送=${giftCredit}, 购买=${purchaseCredit}, VIP=${vipCredit}`);
  }

  // 检查是否为「组图」生成模式 (jimeng-4.0/jimeng-4.1/jimeng-4.5 支持)
  // 「是否存在张数写法」由本文件 parseMultiImageCount() 统一判定（不再在此另写正则，避免两处漂移）。
  // 注意这里判断的是 state !== "absent"（是否"出现"写法）而非"解析是否合法"：
  // 这样「41张」这类超限写法也会进入组图分支，由 generateJimeng4xMultiImages 给出明确的超限报错，
  // 而不会悄悄退化成单图路径、把用户写的数量默默忽略掉。
  //
  // 路由优先级（2026-09-17 显式化，Q3=C1「保留能力、废弃自动触发」）：
  //   ① mode === "single" → 强制单图（忽略关键词与数量写法）—— 编排层必须走这条，防组图吞请求
  //   ② mode === "group"  → 强制组图（需在提示词里写明张数，上限 MAX_GROUP_IMAGE_COUNT）
  //   ③ mode 缺省/"auto"  → **不切换**：命中组图特征时仍走单图，仅回一条可读 hint。
  //      历史行为是"命中关键词就静默切进组图"，已废弃——它让调用方无法预期产出张数，
  //      并使编排层只取 urls[0] 时静默丢图（已生成、已计费、URL 被丢弃）。
  const imageMode = normalizeImageMode(mode);
  const multiImageCountState = parseMultiImageCount(prompt).state;
  const groupKeywordsHit = ["连续", "绘本", "故事"].filter((k) => prompt.includes(k));
  const groupEligibleByKeyword =
    ['jimeng-4.0', 'jimeng-4.1', 'jimeng-4.5'].includes(userModel) &&
    (groupKeywordsHit.length > 0 || multiImageCountState !== "absent");

  let isJimeng4xMultiImage: boolean;
  if (imageMode === "single") {
    isJimeng4xMultiImage = false;
  } else if (imageMode === "group") {
    isJimeng4xMultiImage = true;
  } else {
    // 兼容模式：不自动切换，仅提示（"不静默切换、也不静默丢弃"）
    isJimeng4xMultiImage = false;
    if (groupEligibleByKeyword) {
      const reasons: string[] = [];
      if (groupKeywordsHit.length > 0) reasons.push(`关键词命中「${groupKeywordsHit.join("/")}」`);
      if (multiImageCountState !== "absent") reasons.push(`含数量写法（${multiImageCountState}）`);
      const hint =
        `本次请求未显式声明生成模式（mode），但提示词含组图特征：${reasons.join("；")}。`
        + `本次已按【单图】执行：该模式可关闭组图分支，但上游自由模式的固有产出仍为 4 张`
        + `（2026-09-18 实测：jimeng-4.0 / jimeng-5.0 / nanobanana 一致），本次已全部返回。`
        + `若确实需要一次生成多张内容关联图，请在请求体中显式传 mode:"group"（上限 ${MAX_GROUP_IMAGE_COUNT} 张）；`
        + `若需要跨场景堆量（最多 ${MAX_AGENT_IMAGE_COUNT} 张），请改用 POST /v1/agent/tasks。`;
      if (meta) meta.hint = hint;
      logger.warn(`[image-mode] ${hint}`);
    }
  }
  if (meta) meta.mode = isJimeng4xMultiImage ? "group" : "single";

  if (isJimeng4xMultiImage) {
    return await generateJimeng4xMultiImages(userModel, prompt, { ratio, resolution, sampleStrength, negativePrompt, intelligentRatio }, refreshToken);
  }

  // ── 单图路径：受「同一提示词产出配额」约束 ──
  // 组图（上面已 return）与 Agent 编排（batch.ts 传 quotaMode="agent"）均豁免——
  // 它们各自有独立硬上限（组图 15 / 编排 40 图·8 视频），不叠加本配额。
  // 配额治的是「生成超时后重复提交同一提示词」造成的积分重复消耗。
  const plannedImageCount = getImageCountPerRequest();
  assertPromptQuota(prompt, quotaMode, "image", plannedImageCount);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 使用 payload-builder 构建 core_param
  const coreParam = buildCoreParam({
    userModel,
    model,
    prompt,
    negativePrompt,
    seed: Math.floor(Math.random() * 100000000) + 2500000000,
    sampleStrength,
    resolution: resolutionResult,
    intelligentRatio,
    mode: "text2img",
  });

  // 使用 payload-builder 构建 metrics_extra
  const metricsExtra = buildMetricsExtra({
    userModel,
    model,
    regionInfo,
    submitId,
    scene: "ImageBasicGenerate",
    resolutionType: resolutionResult.resolutionType,
    abilityList: [],
  });

  // 使用 payload-builder 构建 draft_content
  const draftContent = buildDraftContent({
    componentId,
    generateType: "generate",
    coreParam,
  });

  // 使用 payload-builder 构建完整请求
  const requestData = buildGenerateRequest({
    model,
    regionInfo,
    submitId,
    draftContent,
    metricsExtra,
  });

  const imageReferer = regionInfo.isCN
    ? "https://jimeng.jianying.com/ai-tool/generate?type=image"
    : "https://dreamina.capcut.com/ai-tool/generate?type=image";

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    { data: requestData, headers: { Referer: imageReferer } }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  // 轮询结果
  const poller = new SmartPoller({
    maxPollCount: 900,
    pollInterval: 10000, // 10秒轮询间隔
    // 张数开关：默认 1，设 JIMENG_BENEFIT_COUNT=4 切回 4 张候选（上限 40）。
    // ⚠️ 2026-09-18 实测更正：该开关**不控制上游实际产出张数**——住宅出口实测
    // （CN/1k）三模型在 mode:"single" 下均固定返 4 张。expectedItemCount 因此
    // 保持为"期望值"而非"实际值"：轮询以 item_list 非空为准，不会被它卡住。
    // ⚠️ 2026-09-18 二次更正（同上条，勿删前一条留痕）：上方注释中"默认 1（张）"
    // 仅指本函数返回值，**不等于实际产出**；实际产出恒为 4 张且已全部返回给调用方。
    // 必须与 buildCoreParam 的 benefitCount 同源——两处都调用 getImageCountPerRequest()，
    // 原本两处各读一遍 env 的写法已收敛，杜绝「生成 N 张却等 M 张」的轮询挂起。
    expectedItemCount: getImageCountPerRequest(),
    type: 'image',
    timeoutSeconds: 1800 // 30 分钟超时
  });

  const { result: pollingResult, data: finalTaskInfo } = await poller.poll(async () => {
    const response = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            { scene: "smart_crop", width: 360, height: 360, uniq_key: "smart_crop-w:360-h:360", format: "webp" },
            { scene: "smart_crop", width: 480, height: 480, uniq_key: "smart_crop-w:480-h:480", format: "webp" },
            { scene: "smart_crop", width: 720, height: 720, uniq_key: "smart_crop-w:720-h:720", format: "webp" },
            { scene: "smart_crop", width: 720, height: 480, uniq_key: "smart_crop-w:720-h:480", format: "webp" },
            { scene: "smart_crop", width: 360, height: 240, uniq_key: "smart_crop-w:360-h:240", format: "webp" },
            { scene: "smart_crop", width: 240, height: 320, uniq_key: "smart_crop-w:240-h:320", format: "webp" },
            { scene: "smart_crop", width: 480, height: 640, uniq_key: "smart_crop-w:480-h:640", format: "webp" },
            { scene: "normal", width: 2400, height: 2400, uniq_key: "2400", format: "webp" },
            { scene: "normal", width: 1080, height: 1080, uniq_key: "1080", format: "webp" },
            { scene: "normal", width: 720, height: 720, uniq_key: "720", format: "webp" },
            { scene: "normal", width: 480, height: 480, uniq_key: "480", format: "webp" },
            { scene: "normal", width: 360, height: 360, uniq_key: "360", format: "webp" },
          ],
        }
      },
    });

    if (!response[historyId]) {
      logger.error(`历史记录不存在: historyId=${historyId}`);
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");
    }

    const taskInfo = response[historyId];
    return {
      status: {
        status: taskInfo.status,
        failCode: taskInfo.fail_code,
        itemCount: (taskInfo.item_list || []).length,
        finishTime: taskInfo.task?.finish_time || 0,
        historyId
      } as PollingStatus,
      data: taskInfo
    };
  }, historyId);

  const item_list = finalTaskInfo.item_list || [];
  const imageUrls = extractImageUrls(item_list);

  if (imageUrls.length === 0 && item_list.length > 0) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图像生成失败: item_list有 ${item_list.length} 个项目，但无法提取任何图片URL`);
  }

  logger.info(`图像生成完成: 成功生成 ${imageUrls.length} 张图片，总耗时 ${pollingResult.elapsedTime} 秒，最终状态: ${pollingResult.status}`);

  // 生成成功才记账（失败/抛错不占用额度）
  commitPromptQuota(prompt, quotaMode, "image", imageUrls.length);

  return imageUrls;
}

/** 全角数字 → 半角（中文输入法常见），便于统一匹配："４张" 等价于 "4张" */
function normalizeFullWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 中文数字 → 整数（支持 1-99 常用写法：四 / 十 / 十二 / 二十 / 二十四） */
function cnNumeralToInt(raw: string): number | null {
  const DIGITS: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (raw === "十") return 10;
  const tensIdx = raw.indexOf("十");
  if (tensIdx === -1) {
    return raw.length === 1 && DIGITS[raw] !== undefined ? DIGITS[raw] : null;
  }
  const tens = raw.slice(0, tensIdx) === "" ? 1 : DIGITS[raw.slice(0, tensIdx)];
  const ones = raw.slice(tensIdx + 1) === "" ? 0 : DIGITS[raw.slice(tensIdx + 1)];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/**
 * 序数 / 指代标记。
 * 若数量写法之前 1-2 个字符内出现这些标记，则该写法描述的是"顺序/指代"而不是"总张数"，
 * 如「第一张」「最后一张」「另一张」「这一张」。
 * 取 2 字符窗口是为了覆盖「这**是**一张」这类中间插了动词的写法（只看前 1 个字符会漏判）。
 */
const ORDINAL_MARKERS = /[第这那前后每另外某]/;

/** 数量写法是否处于序数/指代语境 */
function isOrdinalContext(text: string, startIdx: number): boolean {
  return ORDINAL_MARKERS.test(text.slice(Math.max(0, startIdx - 2), startIdx));
}

/**
 * 「张数写法」的唯一定义源 —— 组图触发判断与取值共用本表。
 * ⚠️ 禁止在其他位置另写张数正则：两处不同步就会出现「判定为组图却取不到张数」这类漂移缺陷
 * （历史上正是取值处另写了一遍正则，才把隐式兜底 4 张藏了进去）。
 *
 * 位置不限：写法出现在提示词**任意位置**、出现一次即可。形式支持：
 *   ① 阿拉伯数字 + 张   「生成4张连续的猫咪插画」「生成不同风格的猫咪插画，4张」「共 4 张」
 *   ② 键值式            「张数:4」「张数：4」「数量 4」「图片数=4」
 *   ③ 中文数字 + 张      「四张」「十二张」「二十四张」（1-99）
 *   ④ 全角数字          「４张」—— 先归一化为半角再按 ①②③ 匹配
 *
 * 序数 / 指代不算数量说明：见 isOrdinalContext。
 */
const MULTI_IMAGE_COUNT_PATTERNS: Array<{
  re: RegExp;
  toInt: (raw: string) => number | null;
  rejectIfOrdinal?: boolean;
}> = [
  { re: /(\d+)\s*张/g, toInt: (raw) => parseInt(raw, 10), rejectIfOrdinal: true },
  { re: /(?:张数|数量|图片数|生成数)\s*[:：=＝]?\s*(\d+)/g, toInt: (raw) => parseInt(raw, 10) },
  { re: /([一二三四五六七八九十两]{1,3})\s*张/g, toInt: cnNumeralToInt, rejectIfOrdinal: true },
];

/**
 * 解析组图模式的目标张数 —— 组图触发判断与取值共用的唯一入口。
 *
 * 规范：组图提示词必须显式写明数量说明，本函数**不提供隐式默认值**
 * （上游原行为是无匹配时兜底 4 张，已在 fork 中移除）。
 * 数量说明的位置与形式不限，详见 MULTI_IMAGE_COUNT_PATTERNS。
 *
 * @returns state "absent"       未出现任何数量说明
 *                "invalid"      出现了数量说明但无法解析成整数
 *                "out-of-range" 已解析出整数，但不在 1..MAX_GROUP_IMAGE_COUNT 内
 *                "ok"           合法，count ∈ [1, 15]
 */
function parseMultiImageCount(prompt: string):
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "out-of-range"; count: number }
  | { state: "ok"; count: number } {
  const text = normalizeFullWidthDigits(prompt);
  for (const { re, toInt, rejectIfOrdinal } of MULTI_IMAGE_COUNT_PATTERNS) {
    for (const matched of text.matchAll(re)) {
      const startIdx = matched.index ?? 0;
      // 序数/指代（「第一张」「最后一张」「这是一张」）跳过，继续找同一条写法的下一处出现
      if (rejectIfOrdinal && isOrdinalContext(text, startIdx)) continue;

      const count = toInt(matched[1]);
      if (count === null || !Number.isInteger(count)) return { state: "invalid" };
      if (count < 1 || count > MAX_GROUP_IMAGE_COUNT) return { state: "out-of-range", count };
      return { state: "ok", count };
    }
  }
  return { state: "absent" };
}

/**
 * jimeng-4.0/jimeng-4.1/jimeng-4.5 组图生成（上游 scene: ImageMultiGenerate，官方单次上限 15 张）
 */
async function generateJimeng4xMultiImages(
  _model: string,
  prompt: string,
  {
    ratio = '1:1',
    resolution = '2k',
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  const regionInfo = parseRegionFromToken(refreshToken);
  const { model, userModel } = getModel(_model, regionInfo);

  // 使用 payload-builder 处理分辨率
  const resolutionResult = resolveResolution(userModel, regionInfo, resolution, ratio);

  // 张数必须由提示词显式指定，不再隐式兜底 4 张（原行为：无匹配时默认生成 4 张）。
  // 缺数量 / 无法解析 / 超上限 → 抛参数错误并给出写法说明与数值范围，避免误生成造成非预期计费。
  const countCheck = parseMultiImageCount(prompt);
  if (countCheck.state === "out-of-range") {
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      `组图张数超出上限：本次从提示词解析到 ${countCheck.count} 张，单次上限为 ${MAX_GROUP_IMAGE_COUNT} 张，已停止生成。`
      + `请把数量改为 1-${MAX_GROUP_IMAGE_COUNT} 之间的整数（如「${MAX_GROUP_IMAGE_COUNT}张」），或分批多次生成。`
      + `（组图为单次调用上限：官方口径「输入图数量 + 输出图数量 ≤ ${MAX_GROUP_IMAGE_COUNT} 张」；`
      + "若需要更多张，请走 Agent 编排路径 POST /v1/agent/tasks，上限 40 张。）"
    );
  }
  if (countCheck.state !== "ok") {
    const hitKeywords = ["连续", "绘本", "故事"].filter((k) => prompt.includes(k));
    throw new APIException(
      EX.API_REQUEST_PARAMS_INVALID,
      "组图模式必须在提示词中写明数量，位置与形式不限（写在句中句末均可），例如："
      + "「生成4张连续的猫咪插画」，或「生成不同风格的猫咪插画，4张」。"
      + "也支持「张数:4」「数量：4」「四张」「４张」等写法。"
      + `本次提示词${hitKeywords.length ? `命中了组图关键词（${hitKeywords.join(" / ")}）` : "使用了组图模型 jimeng-4.x"}，`
      + `但未包含可识别的数量说明，已停止生成以避免非预期计费（合法范围 1-${MAX_GROUP_IMAGE_COUNT} 张）。`
      + "若只想生成 1 张：请去掉提示词中的组图关键词（走单图路径）——"
      + "但请注意，**上游自由模式单请求固有产出 4 张**（2026-09-18 住宅出口实测："
      + "jimeng-4.0 / jimeng-5.0 / nanobanana 三模型一致，mode:\"single\" 亦无法减少），"
      + "因此改用非 4.x 模型**不会**变少，且单价更高（5.0 / nanobanana = 3 分/张，jimeng-4.0 = 1 分/张）；"
      + "或在请求里显式传 mode:\"single\"（强制单图）/ mode:\"group\"（强制组图）。"
    );
  }
  const targetImageCount = countCheck.count;

  logger.info(`使用 组图生成: ${targetImageCount}张图片 ${resolutionResult.width}x${resolutionResult.height} 精细度: ${sampleStrength}`);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 使用 payload-builder 构建 core_param
  const coreParam = buildCoreParam({
    userModel,
    model,
    prompt,
    negativePrompt,
    seed: Math.floor(Math.random() * 100000000) + 2500000000,
    sampleStrength,
    resolution: resolutionResult,
    intelligentRatio,
    mode: "text2img",
  });

  // 使用 payload-builder 构建 metrics_extra (组图模式)
  const metricsExtra = buildMetricsExtra({
    userModel,
    model,
    regionInfo,
    submitId,
    scene: "ImageMultiGenerate",
    resolutionType: resolutionResult.resolutionType,
    abilityList: [],
    isMultiImage: true,
  });

  // 使用 payload-builder 构建 draft_content
  const draftContent = buildDraftContent({
    componentId,
    generateType: "generate",
    coreParam,
  });

  // 使用 payload-builder 构建完整请求
  const requestData = buildGenerateRequest({
    model,
    regionInfo,
    submitId,
    draftContent,
    metricsExtra,
  });

  const imageReferer = regionInfo.isCN
    ? "https://jimeng.jianying.com/ai-tool/generate?type=image"
    : "https://dreamina.capcut.com/ai-tool/generate?type=image";

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    { data: requestData, headers: { Referer: imageReferer } }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`组图生成任务已提交，submit_id: ${submitId}, history_id: ${historyId}，等待生成 ${targetImageCount} 张图片...`);

  // 轮询结果
  const poller = new SmartPoller({
    maxPollCount: 600,
    pollInterval: 10000, // 10秒轮询间隔
    expectedItemCount: targetImageCount,
    type: 'image',
    timeoutSeconds: 1800 // 30 分钟超时
  });

  const { result: pollingResult, data: finalTaskInfo } = await poller.poll(async () => {
    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            { scene: "smart_crop", width: 360, height: 360, uniq_key: "smart_crop-w:360-h:360", format: "webp" },
            { scene: "smart_crop", width: 480, height: 480, uniq_key: "smart_crop-w:480-h:480", format: "webp" },
            { scene: "smart_crop", width: 720, height: 720, uniq_key: "smart_crop-w:720-h:720", format: "webp" },
            { scene: "smart_crop", width: 720, height: 480, uniq_key: "smart_crop-w:720-h:480", format: "webp" },
            { scene: "normal", width: 2400, height: 2400, uniq_key: "2400", format: "webp" },
            { scene: "normal", width: 1080, height: 1080, uniq_key: "1080", format: "webp" },
            { scene: "normal", width: 720, height: 720, uniq_key: "720", format: "webp" },
            { scene: "normal", width: 480, height: 480, uniq_key: "480", format: "webp" },
            { scene: "normal", width: 360, height: 360, uniq_key: "360", format: "webp" },
          ],
        },
      },
    });

    if (!result[historyId])
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");

    const taskInfo = result[historyId];
    return {
      status: {
        status: taskInfo.status,
        failCode: taskInfo.fail_code,
        itemCount: (taskInfo.item_list || []).length,
        finishTime: taskInfo.task?.finish_time || 0,
        historyId
      } as PollingStatus,
      data: taskInfo
    };
  }, historyId);

  const item_list = finalTaskInfo.item_list || [];
  const imageUrls = extractImageUrls(item_list);

  if (imageUrls.length === 0 && item_list.length > 0) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `组图生成失败: item_list有 ${item_list.length} 个项目，但无法提取任何图片URL`);
  }

  logger.info(`组图生成结果: 成功生成 ${imageUrls.length} 张图片，总耗时 ${pollingResult.elapsedTime} 秒，最终状态: ${pollingResult.status}`);
  return imageUrls;
}


export default {
  generateImages,
  generateImageComposition,
};
