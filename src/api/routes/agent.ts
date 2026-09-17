/**
 * agent.ts —— 批量系列图 / 模板库 / 一致性 的统一 HTTP 入口
 *
 * 端点：POST /v1/agent/generate
 *
 * 请求体（JSON）：
 *   doc           : string  .md/.txt 文档全文（与 skill 二选一）
 *   skill         : string  技能模板名（配合 subject）；如 "角色设计"
 *   subject       : string  模板主题占位符替换，如 "财税顾问王姐"
 *   model         : string  默认模型（场景可覆盖）
 *   ratio         : string  默认比例，如 "1:1" / "3:4" / "2:3"
 *   resolution    : string  默认分辨率 "1k"/"2k"/"4k"
 *   consistency    : boolean 是否开启一致性（默认 true）
 *   ref_strength   : number  img2img 参考强度 0.1-1（默认 0.65）
 *   out_dir        : string  服务器保存目录（留空则不落盘，只返回 url）
 *   strip_watermark : boolean 是否对落盘图片跑去水印（默认跟随 JIMENG_STRIP_WM）
 *
 * 行为：
 *   - 调用 generateAgentBatch 串行生成；
 *   - 若 out_dir 给定，逐张下载 CDN 图并按 NN_标题.png 命名保存；
 *   - 若 strip_watermark，对落盘图调用 scripts/watermark_cli.py（auto 模式，检测到水印才处理）。
 *
 * 多账号：Authorization 头支持逗号分隔的多个 token（或 proxy@region-sessionid 形式），
 *        每场景随机抽一个，复用上游 tokenSplit 轮询。
 */

import _ from "lodash";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { generateAgentBatch } from "@/agent/batch.ts";
import logger from "@/lib/logger.ts";

function runWatermark(file: string): void {
  const py = process.env.JIMENG_PYTHON || "python3";
  const script =
    process.env.JIMENG_WM_SCRIPT ||
    path.join(process.cwd(), "scripts", "watermark_cli.py");
  try {
    const r = spawnSync(py, [script, file, "--mode", "auto"], { stdio: "ignore" });
    if (r.status !== 0) logger.warn(`[agent] 去水印返回非零: ${r.status}`);
  } catch (e: any) {
    logger.warn(`[agent] 去水印调用失败: ${e?.message || e}`);
  }
}

function safeName(title: string, index: number): string {
  const base = (title || `s${index}`).replace(/[^\w一-龥-]+/g, "_").slice(0, 40);
  return `${String(index).padStart(2, "0")}_${base}.png`;
}

export default {
  prefix: "/v1/agent",

  post: {
    "/generate": async (request: any) => {
      request
        .validate("headers.authorization", _.isString)
        .validate("body.consistency", (v: any) => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.ref_strength", (v: any) => _.isUndefined(v) || _.isFinite(v));

      const b = request.body || {};
      if (!b.doc && !(b.skill && b.subject)) {
        throw new Error("必须提供 doc（.md/.txt 文本）或 skill + subject");
      }

      const outDir = b.out_dir || process.env.JIMENG_AGENT_OUT_DIR || "";
      const stripWm =
        b.strip_watermark === true || process.env.JIMENG_STRIP_WM === "auto";

      const result = await generateAgentBatch({
        doc: b.doc,
        skill: b.skill,
        subject: b.subject,
        model: b.model,
        ratio: b.ratio,
        resolution: b.resolution,
        consistency: b.consistency !== false,
        ref_strength: b.ref_strength,
        token: request.headers.authorization,
      });

      // 可选：下载落盘 + 去水印
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        for (const sc of result.scenes) {
          if (!sc.url) continue;
          try {
            const file = path.join(outDir, safeName(sc.title, sc.index));
            const resp = await fetch(sc.url);
            if (!resp.ok) throw new Error(`下载CDN图失败 ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(file, buf);
            sc.file = file;
            if (stripWm) runWatermark(file);
            logger.info(`[agent] 已保存 ${file}`);
          } catch (e: any) {
            logger.warn(`[agent] 保存失败 ${sc.title}: ${e?.message || e}`);
          }
        }
      }

      return result;
    },
  },
};
