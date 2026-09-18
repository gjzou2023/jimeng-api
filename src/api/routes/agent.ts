/**
 * agent.ts —— 批量系列图 / 视频 / 模板库 / 一致性 的统一 HTTP 入口
 *
 * 端点：
 *   POST /v1/agent/generate       同步编排（**保留**，向后兼容；张数少时用）
 *   POST /v1/agent/tasks          **异步编排**（提交即返回 task_id，推荐；40 图 / 8 视频必用）
 *   GET  /v1/agent/tasks/:id      查任务进度与逐项结果
 *   GET  /v1/agent/tasks          列出最近任务
 *
 * 请求体（JSON）—— /generate 与 /tasks 共用：
 *   doc            : string  .md/.txt 文档全文（与 skill 二选一）
 *   skill          : string  技能模板名（配合 subject）；如 "角色设计"
 *   subject        : string  模板主题占位符替换，如 "财税顾问王姐"
 *   kind           : string  "image"（默认）| "video"
 *   model          : string  默认模型（场景可覆盖）
 *   ratio          : string  默认比例，如 "1:1" / "3:4" / "2:3"
 *   resolution     : string  默认分辨率 "1k"/"2k"/"4k"；视频默认 "720p"
 *   duration       : number  视频时长（秒），默认 5；仅 kind="video" 生效
 *   consistency    : boolean 是否开启一致性（默认 true；仅图片有效）
 *   ref_strength   : number  img2img 参考强度 0.1-1（默认 0.65）
 *   max_items      : number  主动收紧总量上限（不得超过硬上限 40 图 / 8 视频）
 *   out_dir        : string  服务器保存目录（留空则不落盘，只返回 url）；
 *                             落盘为**全量**——上游单请求固定产出 4 张，全部保存（P0-3/P0-4）；
 *                             张数上限由环境变量 `JIMENG_AGENT_KEEP` 控制（默认 0 = 全存）
 *   strip_watermark : boolean 是否对落盘图片跑去水印（默认跟随 JIMENG_STRIP_WM）
 *
 * 总量硬上限（官方口径：即梦 Agent 模式一次 40 张图 / 8 个视频）：
 *   图片 ≤ MAX_AGENT_IMAGE_COUNT(40)、视频 ≤ MAX_AGENT_VIDEO_COUNT(8)；
 *   超限**直接报错**（不静默截断），错误信息给出上限数值与拆分建议。
 *
 * 行为：
 *   - /generate：同步等待全部场景完成（可能耗时数分钟到数十分钟，仅适合小批量）；
 *   - /tasks：立即返回 task_id，后台执行；进度与逐项结果用 GET /tasks/:id 查；
 *     每完成一项就落盘一次，**中途断连不丢已产出素材**。
 *
 * 多账号：Authorization 头支持逗号分隔的多个 token（或 proxy@region-sessionid 形式），
 *        每场景随机抽一个，复用上游 tokenSplit 轮询。
 */

import _ from "lodash";
import fs from "fs";

import { generateAgentBatch } from "@/agent/batch.ts";
import { createAgentTask, getAgentTask, listAgentTasks, saveSceneToDisk } from "@/agent/tasks.ts";
import logger from "@/lib/logger.ts";

/** 从 body 提取编排公共参数（不含 token / out_dir 等落盘与凭证字段） */
function pickAgentRequest(b: any) {
  return {
    doc: b.doc,
    skill: b.skill,
    subject: b.subject,
    kind: b.kind === "video" ? ("video" as const) : ("image" as const),
    model: b.model,
    ratio: b.ratio,
    resolution: b.resolution,
    duration: typeof b.duration === "number" ? b.duration : undefined,
    consistency: b.consistency !== false,
    ref_strength: b.ref_strength,
    max_items: typeof b.max_items === "number" ? b.max_items : undefined,
  };
}

export default {
  prefix: "/v1/agent",

  post: {
    "/generate": async (request: any) => {
      request
        .validate("headers.authorization", _.isString)
        .validate("body.consistency", (v: any) => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.ref_strength", (v: any) => _.isUndefined(v) || _.isFinite(v))
        .validate("body.kind", (v: any) => _.isUndefined(v) || v === "image" || v === "video")
        .validate("body.duration", (v: any) => _.isUndefined(v) || (_.isFinite(v) && v > 0))
        .validate("body.max_items", (v: any) => _.isUndefined(v) || (_.isFinite(v) && v > 0));

      const b = request.body || {};
      if (!b.doc && !(b.skill && b.subject)) {
        throw new Error("必须提供 doc（.md/.txt 文本）或 skill + subject");
      }

      const outDir = b.out_dir || process.env.JIMENG_AGENT_OUT_DIR || "";
      const stripWm =
        b.strip_watermark === true || process.env.JIMENG_STRIP_WM === "auto";

      const result = await generateAgentBatch({
        ...pickAgentRequest(b),
        token: request.headers.authorization,
      });

      // 可选：下载落盘 + 去水印（与异步任务层共用同一实现，避免两处漂移）
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        for (const sc of result.scenes) {
          // P0-4：判据放宽到 urls —— 全量落盘由 saveSceneToDisk 内部完成，
          // 与异步任务层（tasks.ts）共用同一实现，避免两处漂移。
          if (!sc.url && !(sc.urls && sc.urls.length)) continue;
          try {
            await saveSceneToDisk(sc, outDir, stripWm);
          } catch (e: any) {
            logger.warn(`[agent] 保存失败 ${sc.title}: ${e?.message || e}`);
          }
        }
      }

      return result;
    },

    "/tasks": async (request: any) => {
      request
        .validate("headers.authorization", _.isString)
        .validate("body.consistency", (v: any) => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.ref_strength", (v: any) => _.isUndefined(v) || _.isFinite(v))
        .validate("body.kind", (v: any) => _.isUndefined(v) || v === "image" || v === "video")
        .validate("body.duration", (v: any) => _.isUndefined(v) || (_.isFinite(v) && v > 0))
        .validate("body.max_items", (v: any) => _.isUndefined(v) || (_.isFinite(v) && v > 0));

      const b = request.body || {};
      if (!b.doc && !(b.skill && b.subject)) {
        throw new Error("必须提供 doc（.md/.txt 文本）或 skill + subject");
      }

      const outDir = b.out_dir || process.env.JIMENG_AGENT_OUT_DIR || "";
      const stripWm = b.strip_watermark === true || process.env.JIMENG_STRIP_WM === "auto";

      const view = createAgentTask(pickAgentRequest(b), {
        token: request.headers.authorization,
        outDir,
        stripWm,
      });

      return {
        ...view,
        hint: "任务已提交，请轮询 GET /v1/agent/tasks/<task_id> 获取进度与逐项结果。",
      };
    },
  },

  get: {
    "/tasks": async (request: any) => {
      const limit = Number(request.query?.limit) || 20;
      return { tasks: listAgentTasks(limit) };
    },

    "/tasks/:id": async (request: any) => {
      const id = request.params?.id;
      if (!id) throw new Error("缺少任务 ID：请使用 GET /v1/agent/tasks/<task_id>");
      const view = getAgentTask(id);
      if (!view) {
        throw new Error(`任务不存在或已过期: ${id}（终态任务保留 24 小时后自动清理）`);
      }
      return view;
    },
  },
};
