/**
 * markdown.ts —— 文档解析器（方向1：批量系列图）
 *
 * 解析 .md / .txt：
 *  - 以 `#`/`##`/`###` 切分章节；
 *  - 标题命中「基础设定/人物设定/参数要求/风格/设定」→ 作为 meta（注入每个场景 prompt 前缀）；
 *  - 标题命中「场景一/场景二/场景N/第N张/镜头N/图N」→ 作为独立场景；
 *  - 标题命中「技术要求/参数/注意事项/说明/备注…」→ 作为 meta，不当作场景（避免把设定/说明误生成）；
 *  - 其他有内容的标题 → 容错当作场景，但若整段以「key：value」参数为主则跳过（防御未知技术类标题）；
 *  - 无标题（纯 .txt）→ 整篇作为单个场景。
 *
 * 设计原则（来自深度思维推演）：
 *  - 零 LLM：文档本身结构化时，「规划」这步不需要大模型，规则解析即可；
 *  - 不侵入原语：本模块只是 generateImages 的上层消费者；
 *  - 容错：解析失败兜底为「整篇=1 场景」，绝不整体雪崩。
 */

import fs from "fs";

export interface AgentScene {
  index: number;
  title: string;
  prompt: string;
  params: { model?: string; ratio?: string; resolution?: string };
}

export interface ParsedDoc {
  meta: Record<string, string>;
  metaPromptPrefix: string;
  scenes: AgentScene[];
}

const META_TITLES = /^(基础设定|人物设定|参数要求|整体要求|全局设定|风格|设定)$/;
// 技术/说明类标题：属于设定与约束，不当作要生成的画面场景
const NON_SCENE_TITLES =
  /^(技术要求|技术参数|参数|参数说明|注意事项|说明|备注|提示|限制|约束|参考|参考图|版权|版权声明|使用说明|交付|交付要求|风格参考)$/;
const SCENE_TITLE =
  /^(场景[一二三四五六七八九十\d]+|第[一二三四五六七八九十\d]+[张幅]|镜头[一二三四五六七八九十\d]+|图[一二三四五六七八九十\d]+|章节[一二三四五六七八九十\d]+)/;

/**
 * 判断一段正文是否「以键值参数（key：value）为主」。
 * 这类段落属于设定/说明（如「风格：xxx」「分辨率：xxx」），
 * 即便标题未被显式列入 NON_SCENE_TITLES，也不应误判为生成场景。
 */
function isParamLike(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const kv = lines.filter((l) => /^\s*[-*]?\s*[^:：]+?\s*[:：]/.test(l)).length;
  return kv / lines.length >= 0.6;
}

interface RawSection {
  title: string;
  body: string;
}

function splitSections(md: string): RawSection[] {
  const lines = md.split(/\r?\n/);
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let preamble: string[] = [];

  for (const line of lines) {
    const m = line.match(/^#{1,3}\s*(.+?)\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1].trim(), body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    } else if (line.trim()) {
      preamble.push(line);
    }
  }
  if (cur) sections.push(cur);
  if (preamble.length) {
    sections.unshift({ title: "", body: preamble.join("\n") });
  }
  return sections;
}

function parseMetaKV(body: string): Record<string, string> {
  const kv: Record<string, string> = {};
  let lastKey = "";
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]?\s*([^:：]+?)\s*[:：]\s*(.+?)\s*$/);
    if (m) {
      lastKey = m[1].trim();
      kv[lastKey] = m[2].trim();
    } else if (lastKey && line.trim()) {
      kv[lastKey] += " " + line.trim();
    }
  }
  return kv;
}

/** 去掉「key：value」行，保留真正的画面描述作为 prompt 主体 */
function stripMetaLines(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*[-*]?\s*[^:：]+?\s*[:：]/.test(l))
    .join("\n")
    .trim();
}

export function parseDoc(text: string): ParsedDoc {
  const sections = splitSections(text);
  const meta: Record<string, string> = {};
  const scenes: AgentScene[] = [];

  for (const sec of sections) {
    if (META_TITLES.test(sec.title) || NON_SCENE_TITLES.test(sec.title)) {
      // 设定/技术说明类 → 提取 KV 进 meta 前缀，不当作场景
      const kv = parseMetaKV(sec.body);
      Object.assign(meta, kv);
      // 兜底：标题本身是 meta 键（如「风格」「色调」）但正文未以 KV 形式给出时，
      // 把整段正文作为该键的值，确保 meta 前缀能注入（服务于一致性方向）。
      if (META_TITLES.test(sec.title) && !meta[sec.title] && Object.keys(kv).length === 0) {
        const v = stripMetaLines(sec.body);
        if (v) meta[sec.title] = v;
      }
    } else if (SCENE_TITLE.test(sec.title)) {
      const params: AgentScene["params"] = {};
      const kv = parseMetaKV(sec.body);
      if (kv["模型"]) params.model = kv["模型"];
      if (kv["比例"]) params.ratio = kv["比例"];
      if (kv["分辨率"]) params.resolution = kv["分辨率"];
      scenes.push({
        index: scenes.length + 1,
        title: sec.title,
        prompt: stripMetaLines(sec.body) || sec.title,
        params,
      });
    } else if (sec.title && sec.body.trim() && !isParamLike(sec.body)) {
      // 未知标题但有内容 → 容错当作场景（参数型段落除外，避免误生成说明）
      scenes.push({
        index: scenes.length + 1,
        title: sec.title,
        prompt: (sec.title ? sec.title + "\n" : "") + stripMetaLines(sec.body),
        params: {},
      });
    }
  }

  // meta → prompt 前缀
  const prefixParts: string[] = [];
  if (meta["风格"]) prefixParts.push(`风格：${meta["风格"]}`);
  if (meta["色调"]) prefixParts.push(`色调：${meta["色调"]}`);
  if (meta["整体氛围"] || meta["情绪"]) prefixParts.push(`氛围：${meta["整体氛围"] || meta["情绪"]}`);
  if (meta["模型"]) prefixParts.push(`模型：${meta["模型"]}`);
  const metaPromptPrefix = prefixParts.join("，");

  for (const s of scenes) {
    s.prompt = [metaPromptPrefix, s.prompt].filter(Boolean).join("\n");
    if (!s.params.model && meta["模型"]) s.params.model = meta["模型"];
    if (!s.params.ratio && meta["比例"]) s.params.ratio = meta["比例"];
    if (!s.params.resolution && meta["分辨率"]) s.params.resolution = meta["分辨率"];
  }

  // 兜底：无任何场景 → 整篇作为单场景
  if (scenes.length === 0) {
    scenes.push({ index: 1, title: "整体", prompt: text.trim(), params: {} });
  }

  return { meta, metaPromptPrefix, scenes };
}

export function parseDocFile(path: string): ParsedDoc {
  return parseDoc(fs.readFileSync(path, "utf-8"));
}
