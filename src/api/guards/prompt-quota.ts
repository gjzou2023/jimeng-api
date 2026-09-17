/**
 * prompt-quota.ts —— 「同一提示词产出配额」护栏（单图 / 单视频两条直出路径专用）
 *
 * 为什么需要它（负反馈回路）：
 *   同步生成耗时较长 → 客户端/网关易超时 → 用户重试 → **同一提示词被反复提交**
 *   → 积分被重复消耗 → "省积分"的初衷被抵消。
 *   本护栏治的是「重试型误刷」，**不治创作自由**。
 *
 * 口径（2026-09-17 用户确认）：
 *   - 单图模式：默认产出 1 张，**同一提示词累计产出 ≤ 4 张**
 *   - 单视频模式：默认产出 1 段，**同一提示词累计产出 ≤ 4 段**
 *   - **豁免**：组图（单次调用 ≤15 张，有官方上限）与 Agent 编排（≤40 图 / ≤8 视频，有各自硬上限）
 *     两者都有独立硬上限，不再叠加本配额，避免与官方能力冲突。
 *
 * 开关：
 *   - `JIMENG_PROMPT_QUOTA_MAX`     默认 4；设 0 表示**关闭**本护栏；非法值回退默认。
 *   - `JIMENG_PROMPT_QUOTA_FILE`    配额落盘路径；默认 `<cwd>/.jimeng-prompt-quota.json`。
 *   - `JIMENG_PROMPT_QUOTA_TTL_DAYS` 条目保留天数，默认 7；过期条目在读盘时清理。
 *
 * 落盘理由（反脆弱）：纯内存计数会在服务重启后归零，护栏形同虚设；故默认持久化为 JSON，
 * 写入采用「临时文件 + rename」原子替换，失败只告警不阻断生成（护栏不应成为可用性单点）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";

/** 默认配额：同一提示词的累计产出上限（张 / 段） */
export const DEFAULT_PROMPT_QUOTA_MAX = 4;

/** 参与配额的生成类别 */
export type QuotaKind = "image" | "video";

/**
 * 走哪条路径 —— 决定是否被配额约束。
 * `group`（组图）与 `agent`（编排）**豁免**本配额。
 */
export type QuotaMode = "single" | "group" | "agent";

/** 豁免本配额的路径（它们各自有独立硬上限） */
export const QUOTA_EXEMPT_MODES: ReadonlySet<QuotaMode> = new Set<QuotaMode>(["group", "agent"]);

export interface QuotaCheckResult {
  /** 放行 = true */
  allowed: boolean;
  /** 该提示词已累计产出的数量 */
  used: number;
  /** 配额上限（0 = 已关闭） */
  max: number;
  /** 本次是否豁免 */
  exempt: boolean;
  /** 指纹键（便于日志排查；不含提示词原文，避免日志泄漏内容） */
  key: string;
  /** 拒绝原因（allowed=false 时存在） */
  reason?: string;
}

interface QuotaEntry {
  used: number;
  updatedAt: number;
}

const store = new Map<string, QuotaEntry>();
let loaded = false;

function quotaMax(): number {
  const raw = process.env.JIMENG_PROMPT_QUOTA_MAX;
  if (raw === undefined || raw === "") return DEFAULT_PROMPT_QUOTA_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PROMPT_QUOTA_MAX;
  return Math.floor(n);
}

function ttlDays(): number {
  const n = Number(process.env.JIMENG_PROMPT_QUOTA_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

function stateFile(): string {
  return (
    process.env.JIMENG_PROMPT_QUOTA_FILE ||
    path.join(process.cwd(), ".jimeng-prompt-quota.json")
  );
}

/** 提示词归一化：折叠空白 + 去首尾 + 转小写（同义不同写尽量落同一键） */
export function normalizePrompt(prompt: string): string {
  return String(prompt || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 指纹键：sha256(kind|mode|归一化提示词) 前 32 位（不落提示词原文） */
export function quotaKey(prompt: string, mode: QuotaMode, kind: QuotaKind): string {
  return crypto
    .createHash("sha256")
    .update(`${kind}|${mode}|${normalizePrompt(prompt)}`)
    .digest("hex")
    .slice(0, 32);
}

function loadIfNeeded(): void {
  if (loaded) return;
  loaded = true;
  const file = stateFile();
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, QuotaEntry>;
    const cutoff = Date.now() - ttlDays() * 24 * 3600 * 1000;
    let kept = 0;
    let dropped = 0;
    for (const [k, v] of Object.entries(raw || {})) {
      if (!v || typeof v.used !== "number" || typeof v.updatedAt !== "number") continue;
      if (v.updatedAt < cutoff) {
        dropped++;
        continue;
      }
      store.set(k, v);
      kept++;
    }
    logger.info(`[prompt-quota] 已加载配额状态: 保留 ${kept} 条 / 清理过期 ${dropped} 条 (${file})`);
  } catch (e: any) {
    logger.warn(`[prompt-quota] 配额状态文件读取失败，按空状态继续: ${e?.message || e}`);
  }
}

function persist(): void {
  const file = stateFile();
  try {
    const obj: Record<string, QuotaEntry> = {};
    for (const [k, v] of store.entries()) obj[k] = v;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf-8");
    fs.renameSync(tmp, file); // 原子替换
  } catch (e: any) {
    // 护栏不应成为可用性单点：落盘失败只告警
    logger.warn(`[prompt-quota] 配额状态落盘失败（不影响本次生成）: ${e?.message || e}`);
  }
}

/**
 * 检查配额（**只读**，不占额）。
 *
 * @param amount 本次将要产出的数量（单图 = benefitCount；单视频 = 1）
 */
export function checkPromptQuota(
  prompt: string,
  mode: QuotaMode,
  kind: QuotaKind,
  amount: number = 1
): QuotaCheckResult {
  const key = quotaKey(prompt, mode, kind);
  const max = quotaMax();

  if (QUOTA_EXEMPT_MODES.has(mode)) {
    return { allowed: true, used: 0, max, exempt: true, key };
  }
  if (max === 0) {
    return { allowed: true, used: 0, max: 0, exempt: false, key };
  }

  loadIfNeeded();
  const used = store.get(key)?.used ?? 0;
  const want = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1;
  if (used + want > max) {
    return {
      allowed: false,
      used,
      max,
      exempt: false,
      key,
      reason:
        `同一提示词的累计产出已达上限：已用 ${used}/${max}，本次请求再产出 ${want} 将超出。`
        + `本护栏用于防止「生成超时后重复提交」造成积分重复消耗（单图/单视频默认 1、同提示词累计 ≤ ${max}）。`
        + `如确需更多，请：① 微调提示词措辞（不同提示词各自独立计数）；`
        + `② 需要多张关联图请传 mode:"group"（单次上限 15 张，豁免本配额）；`
        + `③ 需要批量素材请走 Agent 编排 POST /v1/agent/tasks（上限 40 图 / 8 视频，豁免本配额）；`
        + `④ 运维层面设 JIMENG_PROMPT_QUOTA_MAX=0 可整体关闭本护栏。`,
    };
  }
  return { allowed: true, used, max, exempt: false, key };
}

/** 检查并**占用**额度（生成成功后调用 `commitPromptQuota` 记账；失败可 `releasePromptQuota` 归还） */
export function assertPromptQuota(
  prompt: string,
  mode: QuotaMode,
  kind: QuotaKind,
  amount: number = 1
): QuotaCheckResult {
  const r = checkPromptQuota(prompt, mode, kind, amount);
  if (!r.allowed) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, r.reason || "同一提示词产出配额已用尽");
  }
  return r;
}

/** 记账：生成成功后累加已产出数量 */
export function commitPromptQuota(
  prompt: string,
  mode: QuotaMode,
  kind: QuotaKind,
  produced: number
): void {
  if (QUOTA_EXEMPT_MODES.has(mode) || quotaMax() === 0) return;
  const n = Number.isFinite(produced) && produced > 0 ? Math.floor(produced) : 0;
  if (n === 0) return;
  loadIfNeeded();
  const key = quotaKey(prompt, mode, kind);
  const prev = store.get(key)?.used ?? 0;
  store.set(key, { used: prev + n, updatedAt: Date.now() });
  persist();
  logger.info(`[prompt-quota] 记账 +${n} → ${prev + n}/${quotaMax()} (key=${key})`);
}

/** 仅测试/运维用：清空内存计数（不动落盘文件） */
export function __resetPromptQuotaMemory(): void {
  store.clear();
  loaded = false;
}
