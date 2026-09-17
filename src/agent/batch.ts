/**
 * batch.ts —— Agent 批量编排器（方向1+2+3 的统一调度）
 *
 * 职责：
 *  - 从 doc（.md/.txt）或 skill+subject 构建场景列表；
 *  - 串行逐场景生成（间隔 1.5s 防风控）；
 *  - 每场景随机选账号 token → 多账号轮询（复用上游 tokenSplit）；
 *  - 一致性模式（方向3）：第 1 张 txt2img，后续 img2img 以首图作参考，
 *    参考强度 = sample_strength（默认 0.65，对应文档「参考强度 60-70」）；
 *  - 单场景失败 → 跳过+记录，不整体雪崩；首图失败 → 一致性降级为纯文本设定。
 *
 * 关键实证（来自上游源码审计）：
 *  - generateImages(_model, prompt, {ratio,resolution,...}, token) 每次独立 prompt；
 *  - generateImageComposition(_model, prompt, images[], {sampleStrength,...}, token)
 *    已原生接收 sampleStrength（默认 0.5），通过 buildBlendAbilityList 写入 strength。
 *    因此「参考强度 60-70」= sample_strength=0.65，无需改 payload-builder。
 */

import _ from "lodash";
import { tokenSplit } from "@/api/controllers/core.ts";
import { generateImages, generateImageComposition } from "@/api/controllers/images.ts";
import { parseDoc } from "./markdown.ts";
import { buildSkillScenes, listSkills } from "./skills.ts";
import logger from "@/lib/logger.ts";

export interface AgentRequest {
  doc?: string;
  skill?: string;
  subject?: string;
  model?: string;
  ratio?: string;
  resolution?: string;
  consistency?: boolean;
  ref_strength?: number;
  token?: string; // 原始 Authorization 头（含 Bearer），由路由传入
}

export interface AgentSceneResult {
  index: number;
  title: string;
  url?: string;
  file?: string; // 路由侧保存的本地文件路径（可选）
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function generateAgentBatch(
  req: AgentRequest
): Promise<{ scenes: AgentSceneResult[]; errors: string[] }> {
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

  const globalModel = req.model;
  const globalRatio = req.ratio || "1:1";
  const globalResolution = req.resolution || "2k";
  const consistency = !!req.consistency;
  const refStrength =
    req.ref_strength && req.ref_strength >= 0.1 && req.ref_strength <= 1
      ? req.ref_strength
      : 0.65;

  const tokens = req.token ? tokenSplit(req.token) : [];
  const pickToken = (): string => (tokens.length ? (_.sample(tokens) as string) : "");

  const results: AgentSceneResult[] = [];
  const errors: string[] = [];
  let firstImageUrl: string | undefined;

  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const model = sc.params.model || globalModel || "jimeng-5.0";
    const ratio = sc.params.ratio || globalRatio;
    const resolution = sc.params.resolution || globalResolution;
    const token = pickToken();

    try {
      let url: string | undefined;
      if (consistency && i > 0 && firstImageUrl) {
        const urls = await generateImageComposition(
          model,
          sc.prompt,
          [firstImageUrl],
          { ratio, resolution, sampleStrength: refStrength },
          token
        );
        url = urls[0];
      } else {
        const urls = await generateImages(model, sc.prompt, { ratio, resolution }, token);
        url = urls[0];
      }
      if (!url) throw new Error("未返回图片URL");
      if (i === 0) firstImageUrl = url;
      results.push({ index: sc.index, title: sc.title, url });
      logger.info(`[agent] 场景${sc.index}「${sc.title}」生成成功`);
    } catch (e: any) {
      const msg = `场景${sc.index}「${sc.title}」失败: ${e?.message || e}`;
      logger.error(msg);
      errors.push(msg);
      results.push({ index: sc.index, title: sc.title, error: e?.message || String(e) });
      if (consistency && i === 0) {
        logger.warn("[agent] 首图失败，后续一致性参考降级为纯文本设定");
      }
      // 跳过 + 记录，不整体中断
    }

    if (i < scenes.length - 1) await delay(1500);
  }

  return { scenes: results, errors };
}
