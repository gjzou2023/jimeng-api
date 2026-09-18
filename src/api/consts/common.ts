/**
 * 即梦API通用常量
 */

// API基础URL
export const BASE_URL_CN = "https://jimeng.jianying.com";

export const BASE_URL_US_COMMERCE = "https://commerce.us.capcut.com";
export const BASE_URL_HK_COMMERCE = "https://commerce-api-sg.capcut.com";
export const BASE_URL_HK = "https://mweb-api-sg.capcut.com";

// 默认助手ID
export const DEFAULT_ASSISTANT_ID_CN = 513695;
export const DEFAULT_ASSISTANT_ID_US = 513641;
export const DEFAULT_ASSISTANT_ID_HK = 513641;
export const DEFAULT_ASSISTANT_ID_JP = 513641;
export const DEFAULT_ASSISTANT_ID_SG = 513641;

// 地区
export const REGION_CN = "cn";
export const REGION_US = "US";
export const REGION_HK = "HK";
export const REGION_JP = "JP";
export const REGION_SG = "SG";

// 平台代码
export const PLATFORM_CODE = "7";

// 版本代码
export const VERSION_CODE = "8.4.0";

// 默认模型
// ⚠️ 2026-09-18 更正（C-2）：`jimeng-4.5` → `jimeng-5.0-lite`，对齐即梦官网图片模式默认值。
// 依据（三处独立来源）：
//  ① 官网 UI 实测截图（用户提供）：图片模式模型选择器默认显示「图片 5.0 Lite」；
//  ② `zhizinan1997/jimeng-free-api-all` 更新日志 2026-06-24：
//     「新增 jimeng-image-5.0-lite(high_aes_general_v50) … **图片默认模型更新为 5.0 Lite**」；
//  ③ 同仓库源码 `STATIC_IMAGE_MODELS`：`{ id: "jimeng-image-5.0-lite", modelReqKey: "high_aes_general_v50" }`，
//     且 `resolveModelConfig()` 的图像兜底模型同为 `jimeng-image-5.0-lite`。
// 旧值 `jimeng-4.5` 的依据是「区域默认」推断，已被 ① 直接证伪（官网有选择器且默认不是 4.5）。
export const DEFAULT_IMAGE_MODEL = "jimeng-5.0-lite";
// ⚠️ US 站**本轮维持 4.5 不动**：5.0 Lite 在国际站是否可用**未取证**（FIX_PLAN_v3.0 §五 U-4），
// 凭猜测改动会造成"开箱必败"。待用 us- token 实测后再决定。
export const DEFAULT_IMAGE_MODEL_US = "jimeng-4.5";
export const DEFAULT_VIDEO_MODEL = "jimeng-video-3.5-pro";

// 草稿版本
export const DRAFT_VERSION = "3.3.9";
export const DRAFT_MIN_VERSION = "3.0.2";
export const DRAFT_VERSION_OMNI = "3.3.9";

/**
 * `draft_content.version` —— **本轮有意不动**（2026-09-18 决策留痕）。
 *
 * 参考实现 `zhizinan1997/jimeng-free-api-all` 在修复 `gen_count` 的同一次提交里把
 * `draft_content.version` 从 `3.3.9` 改成 `3.0.2`（新增常量 `DRAFT_CONTENT_VERSION = "3.0.2"`），
 * 但该提交的信息明确写「**the decisive field is `abilities.gen_option`**」——
 * 即版本调整属"顺带对齐"，**不是**治愈"恒出 4 张"的因果字段。
 *
 * 且两处来源互相冲突：
 *  - `wwwzhouhui/jimeng-free-api-all`（deepwiki 版 `MODEL_CONFIGS`）：`draftVersion` **按模型取值**
 *    —— `jimeng-5.0 → 3.3.9`、`jimeng-4.5 → 3.3.4`、`jimeng-3.0 → 3.0.2`；
 *  - `zhizinan1997` 修复后：全模型统一 `3.0.2`。
 *
 * 取舍原则（"一次只改一个变量"）：**非因果 + 证据冲突 + 现值可用** 的字段，不并入本次关键修复批次。
 * 待用官网真实抓包确认后再单独评估。
 */
export const DRAFT_CONTENT_VERSION_NOTE = "draft_content.version 本轮有意维持 3.3.9，见上注";

// omni_reference 模式专用 benefit_type
export const OMNI_BENEFIT_TYPE = "dreamina_video_seedance_20_video_add";
export const OMNI_BENEFIT_TYPE_FAST = "dreamina_seedance_20_fast_with_video";

// 图像模型映射
// ⚠️ 2026-09-18 注（C-2/U-2）：`high_aes_general_v50` 是**同一个内部键**，公开名随官网改版变过三次：
//   `jimeng-5.0-preview`（早期）→ `jimeng-5.0`（中期）→ `jimeng-image-5.0-lite`（当前，即「图片 5.0 Lite」）。
// 本表把 `jimeng-5.0-lite` 作为规范名，`jimeng-5.0` 保留为同义别名（不破坏既有调用方）。
// "图片 5.0 Preview" 与 "5.0 Lite" 是否共用此键**尚未取证**（FIX_PLAN_v3.0 §五 U-2），故不新增 preview 条目。
// 另：`jimeng-4.5 → high_aes_general_v40l` 经双源证实（deepwiki MODEL_CONFIGS 表 + STATIC_IMAGE_MODELS 源码），
// 原 U-3「4.5 键名到底是 v40l 还是 v45」已闭合 —— 是 v40l，本表现值正确。
export const IMAGE_MODEL_MAP = {
  "jimeng-5.0-lite": "high_aes_general_v50",
  "jimeng-5.0": "high_aes_general_v50",
  "jimeng-4.6": "high_aes_general_v42",
  "jimeng-4.5": "high_aes_general_v40l",
  "jimeng-4.1": "high_aes_general_v41",
  "jimeng-4.0": "high_aes_general_v40",
  "jimeng-3.1": "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
  "jimeng-3.0": "high_aes_general_v30l:general_v3.0_18b",
};

export const IMAGE_MODEL_MAP_US = {
  "jimeng-4.5": "high_aes_general_v40l",
  "jimeng-4.1": "high_aes_general_v41",
  "jimeng-4.0": "high_aes_general_v40",
  "jimeng-3.0": "high_aes_general_v30l:general_v3.0_18b",
  "nanobanana": "external_model_gemini_flash_image_v25",
  "nanobananapro": "dreamina_image_lib_1",
};

// 图像模型映射 - 亚洲国际站 (HK/JP/SG)
export const IMAGE_MODEL_MAP_ASIA = {
  "jimeng-5.0-lite": "high_aes_general_v50",
  "jimeng-5.0": "high_aes_general_v50",
  "jimeng-4.6": "high_aes_general_v42",
  "jimeng-4.5": "high_aes_general_v40l",
  "jimeng-4.1": "high_aes_general_v41",
  "jimeng-4.0": "high_aes_general_v40",
  "jimeng-3.0": "high_aes_general_v30l:general_v3.0_18b",
  "nanobanana": "external_model_gemini_flash_image_v25",
  "nanobananapro": "dreamina_image_lib_1",
};

// 视频模型映射 - 国内站 (CN)
export const VIDEO_MODEL_MAP = {
  "jimeng-video-seedance-2.0": "dreamina_seedance_40_pro",
  "jimeng-video-seedance-2.0-fast": "dreamina_seedance_40",
  "jimeng-video-3.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
  "jimeng-video-3.0-pro": "dreamina_ic_generate_video_model_vgfm_3.0_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0",
  "jimeng-video-3.0-fast": "dreamina_ic_generate_video_model_vgfm_3.0_fast",
  "jimeng-video-2.0": "dreamina_ic_generate_video_model_vgfm_lite",
  "jimeng-video-2.0-pro": "dreamina_ic_generate_video_model_vgfm1.0"
};

// 视频模型映射 - 美国站 (US) - 仅保留 3.0 和 3.5-pro
export const VIDEO_MODEL_MAP_US = {
  "jimeng-video-3.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0",
};

// 视频模型映射 - 亚洲国际站 (HK/JP/SG)
export const VIDEO_MODEL_MAP_ASIA = {
  "jimeng-video-veo3": "dreamina_veo3_generate_video",
  "jimeng-video-veo3.1": "dreamina_veo3.1_generate_video",
  "jimeng-video-sora2": "dreamina_sora2_generate_video",
  "jimeng-video-3.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
  "jimeng-video-3.0-pro": "dreamina_ic_generate_video_model_vgfm_3.0_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0",
  "jimeng-video-3.0-fast": "dreamina_ic_generate_video_model_vgfm_3.0_fast",
  "jimeng-video-2.0": "dreamina_ic_generate_video_model_vgfm_lite",
  "jimeng-video-2.0-pro": "dreamina_ic_generate_video_model_vgfm1.0"
};

// 状态码映射
export const STATUS_CODE_MAP = {
  20: 'PROCESSING',
  10: 'SUCCESS',
  30: 'FAILED',
  42: 'POST_PROCESSING',
  45: 'FINALIZING',
  50: 'COMPLETED'
};

// 重试配置
export const RETRY_CONFIG = {
  MAX_RETRY_COUNT: 3,
  RETRY_DELAY: 5000
};

// 轮询配置
export const POLLING_CONFIG = {
  MAX_POLL_COUNT: 900,   // 最大轮询次数
  POLL_INTERVAL: 5000,   // 轮询间隔 5 秒
  STABLE_ROUNDS: 5,      // 稳定轮次
  TIMEOUT_SECONDS: 900   // 默认超时 15 分钟
};

// 支持的图片比例和分辨率
export const RESOLUTION_OPTIONS = {
  "1k":{
    "1:1": { width: 1024, height: 1024, ratio: 1 },
    "4:3": { width: 768, height: 1024, ratio: 4 },
    "3:4": { width: 1024, height: 768, ratio: 2 },
    "16:9": { width: 1024, height: 576, ratio: 3 },
    "9:16": { width: 576, height: 1024, ratio: 5 },
    "3:2": { width: 1024, height: 682, ratio: 7 },
    "2:3": { width: 682, height: 1024, ratio: 6 },
    "21:9": { width: 1195, height: 512, ratio: 8 },
  },

  "2k": {
    "1:1": {width: 2048, height: 2048, ratio: 1},
    "4:3": {width: 2304, height: 1728, ratio: 4},
    "3:4": {width: 1728, height: 2304, ratio: 2},
    "16:9": {width: 2560, height: 1440, ratio: 3},
    "9:16": {width: 1440, height: 2560, ratio: 5},
    "3:2": {width: 2496, height: 1664, ratio: 7},
    "2:3": {width: 1664, height: 2496, ratio: 6},
    "21:9": {width: 3024, height: 1296, ratio: 8},
  },
  "4k": {
    "1:1": {width: 4096, height: 4096, ratio: 101},
    "4:3": {width: 4608, height: 3456, ratio: 104},
    "3:4": {width: 3456, height: 4608, ratio: 102},
    "16:9": {width: 5120, height: 2880, ratio: 103},
    "9:16": {width: 2880, height: 5120, ratio: 105},
    "3:2": {width: 4992, height: 3328, ratio: 107},
    "2:3": {width: 3328, height: 4992, ratio: 106},
    "21:9": {width: 6048, height: 2592, ratio: 108}
  }
};

// nanobananapro 模型专用的 4k 分辨率配置（ratio 值与 1k/2k 一致）
export const RESOLUTION_OPTIONS_NANOBANANAPRO_4K = {
  "1:1": { width: 4096, height: 4096, ratio: 1 },
  "4:3": { width: 4693, height: 3520, ratio: 4 },
  "3:4": { width: 3520, height: 4693, ratio: 2 },
  "16:9": { width: 5404, height: 3040, ratio: 3 },
  "9:16": { width: 3040, height: 5404, ratio: 5 },
  "3:2": { width: 4992, height: 3328, ratio: 7 },
  "2:3": { width: 3328, height: 4992, ratio: 6 },
  "21:9": { width: 6197, height: 2656, ratio: 8 }
};
