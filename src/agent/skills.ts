/**
 * skills.ts —— 技能模板库（方向2）
 *
 * 把《即梦Jimeng Agent模式使用明细指南》§1.4 官方技能转化为本地可编辑的 prompt 模板。
 * 重要边界（来自研判报告）：官方技能的具体 prompt 文本并未公开，此处仅「复刻意图」，
 * 用通用专业提示词近似；效果弱于官方，但用户可自主编辑 .md 文件迭代（贴合「非代码、自主可控」）。
 *
 * 模板格式（scripts/skills/<name>.md）：
 *   ---
 *   name: 电商套图
 *   model: jimeng-5.0
 *   ratio: 3:4
 *   resolution: 2k
 *   ---
 *   ## 主图
 *   {subject}，纯白浅色背景，专业电商摄影风格……
 *   ## 细节图
 *   {subject} 局部材质纹理特写……
 *
 * {subject} 占位符在调用时由用户主题替换。
 */

import fs from "fs";
import path from "path";

export interface SkillDef {
  name: string;
  model?: string;
  ratio?: string;
  resolution?: string;
  scenes: { title: string; prompt: string }[];
}

const SKILLS_DIR = path.resolve(process.cwd(), "scripts", "skills");

export function listSkills(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

export function loadSkill(name: string): SkillDef | null {
  const p = path.join(SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(p)) return null;

  const content = fs.readFileSync(p, "utf-8");
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const meta: Record<string, string> = {};
  if (fm) {
    fm[1].split(/\r?\n/).forEach((l) => {
      const m = l.match(/^([\w一-龥]+)\s*[:：]\s*(.+)$/);
      if (m) meta[m[1]] = m[2].trim();
    });
  }

  const bodyStart = fm ? content.indexOf("---", 3) + 3 : 0;
  const body = content.slice(bodyStart);

  const scenes: { title: string; prompt: string }[] = [];
  const secRe = /^#{2,3}\s*(.+?)\s*$/gm;
  const matches: { title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(body))) {
    matches.push({ title: m[1].trim(), start: m.index + m[0].length, end: 0 });
  }
  for (let i = 0; i < matches.length; i++) {
    matches[i].end = i + 1 < matches.length ? matches[i + 1].start : body.length;
    scenes.push({
      title: matches[i].title,
      prompt: body.slice(matches[i].start, matches[i].end).trim(),
    });
  }

  return {
    name: meta.name || name,
    model: meta.model,
    ratio: meta.ratio,
    resolution: meta.resolution,
    scenes,
  };
}

export function buildSkillScenes(
  name: string,
  subject: string
): { index: number; title: string; prompt: string; params: any }[] | null {
  const def = loadSkill(name);
  if (!def || def.scenes.length === 0) return null;
  return def.scenes.map((s, i) => ({
    index: i + 1,
    title: s.title,
    prompt: s.prompt.replace(/\{subject\}/g, subject),
    params: { model: def.model, ratio: def.ratio, resolution: def.resolution },
  }));
}
