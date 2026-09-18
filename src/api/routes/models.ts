import { IMAGE_MODEL_MAP, IMAGE_MODEL_MAP_US, IMAGE_MODEL_MAP_ASIA, VIDEO_MODEL_MAP, VIDEO_MODEL_MAP_US, VIDEO_MODEL_MAP_ASIA, DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_MODEL_US, DEFAULT_VIDEO_MODEL } from '@/api/consts/common.ts';
import { MAX_SINGLE_IMAGE_COUNT, MAX_GROUP_IMAGE_COUNT, MAX_AGENT_IMAGE_COUNT, MAX_AGENT_VIDEO_COUNT } from '@/api/builders/payload-builder.ts';

/**
 * 图片模型条目（带"哪几个站点支持"的说明）。
 *
 * ⚠️ 2026-09-18 变更（C-6）：**此前 `/v1/models` 只有 4 个视频模型，一个图片模型都没有**——
 * 而图片模式恰恰是官网默认入口（默认模型「图片 5.0 Lite」），调用方无从发现可选模型。
 * 本版把图片模型补齐，并顺带补上 `VIDEO_MODEL_MAP` 里已支持但未列出的视频模型
 * （含**视频默认模型** `jimeng-video-3.5-pro`，此前也没列出来）。
 *
 * 站点可用性（由 `getModel()` 实际校验，这里只做提示）：
 *  - `cn`  : IMAGE_MODEL_MAP（不含 nano 系列）
 *  - `us`  : IMAGE_MODEL_MAP_US（含 nano 系列；**不含 5.0 Lite**，未取证）
 *  - `hk/jp/sg` : IMAGE_MODEL_MAP_ASIA（含 nano 系列）
 */
const IMAGE_MODELS: Array<{ id: string; description: string; cn: boolean; us: boolean; asia: boolean }> = [
  { id: 'jimeng-5.0-lite', description: '图片 5.0 Lite（官网图片模式**默认模型**；内部键 high_aes_general_v50；单价 3 分/张）', cn: true, us: false, asia: true },
  { id: 'jimeng-5.0', description: '图片 5.0 Lite 的同义别名（与 jimeng-5.0-lite 指向同一内部键，保留以兼容旧调用方）', cn: true, us: false, asia: true },
  { id: 'jimeng-4.6', description: '图片 4.6（内部键 high_aes_general_v42）', cn: true, us: false, asia: true },
  { id: 'jimeng-4.5', description: '图片 4.5（内部键 high_aes_general_v40l；亦为**国际站**默认图片模型）', cn: true, us: true, asia: true },
  { id: 'jimeng-4.1', description: '图片 4.1（内部键 high_aes_general_v41）', cn: true, us: true, asia: true },
  { id: 'jimeng-4.0', description: '图片 4.0（内部键 high_aes_general_v40；极致省分时可用，单价 1 分/张）', cn: true, us: true, asia: true },
  { id: 'jimeng-3.1', description: '图片 3.1（艺术风格；内部键 high_aes_general_v30l_art_fangzhou）', cn: true, us: false, asia: false },
  { id: 'jimeng-3.0', description: '图片 3.0（通用；内部键 high_aes_general_v30l）', cn: true, us: true, asia: true },
  { id: 'nanobanana', description: 'NanoBanana（国际站专有；CN 站不支持）', cn: false, us: true, asia: true },
  { id: 'nanobananapro', description: 'NanoBanana Pro（国际站专有；CN 站不支持）', cn: false, us: true, asia: true },
];

/** 视频模型条目（站点标志与上方同义） */
const VIDEO_MODELS: Array<{ id: string; description: string; cn: boolean; us: boolean; asia: boolean }> = [
  { id: 'jimeng-video-seedance-2.0', description: 'Seedance 2.0（内部键 dreamina_seedance_40_pro）', cn: true, us: false, asia: false },
  { id: 'jimeng-video-seedance-2.0-fast', description: 'Seedance 2.0 Fast（内部键 dreamina_seedance_40）', cn: true, us: false, asia: false },
  { id: 'jimeng-video-3.5-pro', description: '视频 3.5 专业版（**默认视频模型**）', cn: true, us: true, asia: true },
  { id: 'jimeng-video-3.0-pro', description: '视频 3.0 专业版', cn: true, us: false, asia: true },
  { id: 'jimeng-video-3.0', description: '视频 3.0 标准版', cn: true, us: true, asia: true },
  { id: 'jimeng-video-3.0-fast', description: '视频 3.0 快速版', cn: true, us: false, asia: true },
  { id: 'jimeng-video-2.0', description: '视频 2.0 轻量版', cn: true, us: false, asia: true },
  { id: 'jimeng-video-2.0-pro', description: '视频 2.0 专业版', cn: true, us: false, asia: true },
  { id: 'jimeng-video-veo3', description: 'Veo 3（国际站专有）', cn: false, us: false, asia: true },
  { id: 'jimeng-video-veo3.1', description: 'Veo 3.1（国际站专有）', cn: false, us: false, asia: true },
  { id: 'jimeng-video-sora2', description: 'Sora 2（国际站专有）', cn: false, us: false, asia: true },
];

function regions(entry: { cn: boolean; us: boolean; asia: boolean }): string {
  const list: string[] = [];
  if (entry.cn) list.push('cn');
  if (entry.us) list.push('us');
  if (entry.asia) list.push('hk/jp/sg');
  return list.join(', ') || '（无）';
}

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            // 自检：清单必须与真实映射表一致（防止"列了但用不了 / 能用但没列"）
            const imageIds = new Set([
                ...Object.keys(IMAGE_MODEL_MAP),
                ...Object.keys(IMAGE_MODEL_MAP_US),
                ...Object.keys(IMAGE_MODEL_MAP_ASIA),
            ]);
            const videoIds = new Set([
                ...Object.keys(VIDEO_MODEL_MAP),
                ...Object.keys(VIDEO_MODEL_MAP_US),
                ...Object.keys(VIDEO_MODEL_MAP_ASIA),
            ]);
            const listedImage = new Set(IMAGE_MODELS.map((m) => m.id));
            const listedVideo = new Set(VIDEO_MODELS.map((m) => m.id));
            const missingImage = [...imageIds].filter((id) => !listedImage.has(id));
            const missingVideo = [...videoIds].filter((id) => !listedVideo.has(id));
            const extraImage = [...listedImage].filter((id) => !imageIds.has(id));
            const extraVideo = [...listedVideo].filter((id) => !videoIds.has(id));
            const warnings: string[] = [];
            if (missingImage.length) warnings.push(`图片模型未列出: ${missingImage.join(', ')}`);
            if (missingVideo.length) warnings.push(`视频模型未列出: ${missingVideo.join(', ')}`);
            if (extraImage.length) warnings.push(`图片条目无映射: ${extraImage.join(', ')}`);
            if (extraVideo.length) warnings.push(`视频条目无映射: ${extraVideo.join(', ')}`);

            return {
                "data": [
                    {
                        "id": "jimeng",
                        "object": "model",
                        "owned_by": "jimeng-api",
                        "description": `通用占位模型：不指定具体模型时使用**区域默认**——国内站为 "${DEFAULT_IMAGE_MODEL}"（图片 5.0 Lite），国际站为 "${DEFAULT_IMAGE_MODEL_US}"；视频默认 "${DEFAULT_VIDEO_MODEL}"`
                    },
                    ...IMAGE_MODELS.map((m) => ({
                        "id": m.id,
                        "object": "model",
                        "owned_by": "jimeng-api",
                        "type": "image",
                        "regions": regions(m),
                        "description": m.description,
                    })),
                    ...VIDEO_MODELS.map((m) => {
                        // `videos`/`images` 两条链路共用同一批模型名，用 type 区分
                        return {
                            "id": m.id,
                            "object": "model",
                            "owned_by": "jimeng-api",
                            "type": "video",
                            "regions": regions(m),
                            "description": m.description,
                        };
                    }),
                ],
                // 张数参数说明（2026-09-18 新增）：调用方据此知道"怎么少出图"
                "image_count_options": {
                    "param": "n",
                    "single": { "min": 1, "max": MAX_SINGLE_IMAGE_COUNT, "default": 1, "note": "单图路径输出张数，也可用环境变量 JIMENG_BENEFIT_COUNT 设默认值" },
                    "group": { "min": 1, "max": MAX_GROUP_IMAGE_COUNT, "note": "组图路径：mode:\"group\"，张数写在提示词里（如「4张」）" },
                    "agent": { "max_images": MAX_AGENT_IMAGE_COUNT, "max_videos": MAX_AGENT_VIDEO_COUNT, "note": "Agent 编排：POST /v1/agent/tasks，max_items 为**场景数**上限" },
                },
                ...(warnings.length ? { "warnings": warnings } : {}),
            };
        }

    }
}
