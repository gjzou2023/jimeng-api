/**
 * tasks.ts —— Agent 编排的**异步任务层**
 *
 * 为什么需要它：40 张图 ≈ 13–27 分钟、8 段视频 ≈ 16–40 分钟（视频 2–5 分钟/段）。
 * 同步 HTTP 请求会被网关/客户端在几分钟内掐断，用户看到超时就会重试 →
 * 同一批场景被重复提交 → 积分被重复消耗。故必须"提交即返回、进度可查"。
 *
 * 设计取舍（反脆弱优先）：
 *  - **进程内任务表**（Map）：不引入 Redis/DB，单容器部署足够；
 *  - **任务快照落盘**：每次进度变化写一份 JSON（临时文件 + rename 原子替换），
 *    进程重启后仍可读到历史任务（但**不自动续跑**——续跑属于独立特性，本轮不做）；
 *  - **逐项落盘**：每生成一项就立刻下载存盘，中途断开也不丢已产出的素材；
 *  - 任务表容量上限 + TTL 清理，防长期运行内存膨胀。
 *
 * ⚠️ 安全：任务快照**不得写入 Authorization/token** 字段（会落盘泄漏凭证）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";

import { generateAgentBatch, agentCap, AgentBatchResult, AgentKind, AgentSceneResult } from "./batch.ts";
import { AgentRequest } from "./batch.ts";
import logger from "@/lib/logger.ts";

export type AgentTaskStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

export interface AgentTaskProgress {
  total: number;
  done: number;
  succeeded: number;
  failed: number;
}

/** 任务对外视图（**不含 token**） */
export interface AgentTaskView {
  task_id: string;
  kind: AgentKind;
  status: AgentTaskStatus;
  cap: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  elapsed_seconds?: number;
  progress: AgentTaskProgress;
  out_dir?: string;
  scenes: AgentSceneResult[];
  errors: string[];
}

interface AgentTaskRecord {
  id: string;
  kind: AgentKind;
  cap: number;
  status: AgentTaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: AgentTaskProgress;
  outDir?: string;
  stripWm: boolean;
  scenes: AgentSceneResult[];
  errors: string[];
  /** 仅供执行期间使用，**不落盘** */
  token?: string;
  request: Omit<AgentRequest, "token">;
}

/** 内存任务表上限（超出后按创建时间淘汰最旧的终态任务） */
const MAX_TASKS = 200;
/** 终态任务的保留时长（默认 24h） */
const TASK_TTL_MS = 24 * 3600 * 1000;

const tasks = new Map<string, AgentTaskRecord>();

function iso(t?: number): string | undefined {
  return t ? new Date(t).toISOString() : undefined;
}

function taskDir(): string {
  return process.env.JIMENG_AGENT_TASK_DIR || path.join(process.cwd(), ".jimeng-agent-tasks");
}

/** 任务快照落盘（原子写；失败只告警，不影响编排） */
function persistTask(rec: AgentTaskRecord): void {
  try {
    const dir = taskDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe: AgentTaskView = toView(rec);
    const file = path.join(dir, `${rec.id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch (e: any) {
    logger.warn(`[agent-task] 任务快照落盘失败（不影响编排）: ${e?.message || e}`);
  }
}

function toView(rec: AgentTaskRecord): AgentTaskView {
  return {
    task_id: rec.id,
    kind: rec.kind,
    status: rec.status,
    cap: rec.cap,
    created_at: iso(rec.createdAt)!,
    started_at: iso(rec.startedAt),
    finished_at: iso(rec.finishedAt),
    elapsed_seconds: rec.finishedAt && rec.startedAt
      ? Math.round((rec.finishedAt - rec.startedAt) / 1000)
      : rec.startedAt
        ? Math.round((Date.now() - rec.startedAt) / 1000)
        : undefined,
    progress: { ...rec.progress },
    out_dir: rec.outDir,
    scenes: rec.scenes,
    errors: rec.errors,
  };
}

function prune(): void {
  const now = Date.now();
  for (const [id, rec] of tasks.entries()) {
    const terminal = rec.status === "succeeded" || rec.status === "partial" || rec.status === "failed";
    if (terminal && rec.finishedAt && now - rec.finishedAt > TASK_TTL_MS) {
      tasks.delete(id);
    }
  }
  if (tasks.size > MAX_TASKS) {
    const sorted = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    const removable = sorted.filter((r) => r.status !== "running" && r.status !== "queued");
    for (const r of removable) {
      if (tasks.size <= MAX_TASKS) break;
      tasks.delete(r.id);
    }
  }
}

function safeName(title: string, index: number): string {
  const base = (title || `s${index}`).replace(/[^\w一-龥-]+/g, "_").slice(0, 40);
  const ext = ".png"; // 视频任务此处由调用方覆盖为 .mp4
  return `${String(index).padStart(2, "0")}_${base}${ext}`;
}

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

/**
 * 每场景最多落盘几张（环境变量 `JIMENG_AGENT_KEEP`，默认 `0` = 全部落盘）。
 *
 * 它是**磁盘/带宽的保险丝**：正常情况下每场景产出 = 请求的 `n`（默认 1 张），
 * 落盘量与 `n` 成正比；但若上游将来又改回"多给"，或调用方显式传 `n=8`，
 * 落盘量会成倍上升（40 场景 × 8 张 × ~1MB ≈ 320MB/次）。
 * 设为 `1` 即"每场景只留首图"（字段层仍向后兼容，见 P0-2）。
 *
 * ⚠️ 2026-09-18 更正：旧注释称"上游单图路径每次请求固定产出 4 张（实测）"——**已证伪**。
 * 真因是报文缺 `abilities.gen_option.gen_count`（已修，见 `payload-builder.ts` 的 `buildDraftContent`）。
 */
function resolveKeep(): number {
  const n = Number(process.env.JIMENG_AGENT_KEEP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0; // 0 / 非法 → 全部落盘
}

/**
 * 逐项落盘：把一个场景的**全部**产出下载到本地（图片按 .png、视频按 .mp4）。
 * 同步端点与异步任务层共用本函数，避免两处实现漂移。
 *
 * ⚠️ 2026-09-18 变更（P0-3/P0-4，取代旧实现）：
 * 旧实现只取 `sc.url`（首图）→ 上游**同一请求已生成、已计费**的其余 3 张被静默丢弃。
 * 现改为遍历 `sc.urls ?? [sc.url]` 全量落盘：
 *   - 多张 → `NN_标题_01.png … NN_标题_NN.png`；**恰好 1 张 → 保持旧命名** `NN_标题.png`
 *     （不破坏既有消费方的路径假设，属向后兼容取舍）；
 *   - `sc.file` 仍为首图路径（向后兼容）；新增 `sc.files` = 全部落盘路径；
 *   - 单张下载失败只告警并**继续下一张**（不因一张失败丢掉整个场景）；
 *     全部失败才抛错，交由调用方记录；
 *   - 落盘张数上限由 `JIMENG_AGENT_KEEP` 控制（默认 0 = 全存）。
 */
export async function saveSceneToDisk(
  sc: AgentSceneResult,
  outDir: string,
  stripWm: boolean
): Promise<void> {
  if (!outDir) return;
  const urls = (sc.urls && sc.urls.length ? sc.urls : sc.url ? [sc.url] : []).filter((u) => !!u);
  if (!urls.length) return;

  const keep = resolveKeep();
  const picked = keep > 0 ? urls.slice(0, keep) : urls;
  if (picked.length < urls.length) {
    logger.info(
      `[agent] ${sc.title}: 上游产出 ${urls.length} 张，按 JIMENG_AGENT_KEEP=${keep} 仅保留前 ${picked.length} 张`
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  const base = safeName(sc.title, sc.index).replace(/\.png$/, sc.kind === "video" ? ".mp4" : ".png");
  const ext = sc.kind === "video" ? ".mp4" : ".png";
  const stem = base.replace(/\.(png|mp4)$/, "");

  const files: string[] = [];
  for (let k = 0; k < picked.length; k++) {
    // 多张 → 带序号；恰好 1 张 → 沿用旧命名（向后兼容）
    const name = picked.length > 1 ? `${stem}_${String(k + 1).padStart(2, "0")}${ext}` : base;
    const file = path.join(outDir, name);
    try {
      const resp = await fetch(picked[k]);
      if (!resp.ok) throw new Error(`下载 CDN 文件失败 ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(file, buf);
      files.push(file);
      // 去水印只对图片有意义（视频链路不做像素裁剪）
      if (stripWm && sc.kind !== "video") runWatermark(file);
      logger.info(`[agent] 已保存 ${file}`);
    } catch (e: any) {
      logger.warn(
        `[agent] ${sc.title} 第 ${k + 1}/${picked.length} 张保存失败（继续下一张）: ${e?.message || e}`
      );
    }
  }

  if (!files.length) throw new Error(`全部 ${picked.length} 张下载失败（出图成功但落盘失败）`);
  sc.file = files[0]; // 向后兼容：首图路径
  sc.files = files;   // 新增：全部落盘路径
}

/**
 * ★ N-9 修复（2026-09-18）：落盘目录**可写性预检** —— 必须调用在生成**之前**。
 *
 * 为什么必须前移：
 *   原实现（routes/agent.ts）是先 `await generateAgentBatch()` → **图片已生成、积分已扣**，
 *   之后才 `fs.mkdirSync(outDir)` / 逐张写文件。目录不可写时，**已经白花了钱**才报错。
 *   线上实测（2026-09-18，Lighthouse 容器）：宿主 `/app/output` 属主 root:root、
 *   容器内服务账号 `jimeng(uid=1001)` 无写权 → **12 次 EACCES 落盘静默失败**，
 *   而每个场景 4 分的积分照扣，且 HTTP 接口仍返回 url（调用方以为保存成功）。
 *
 * 现在：不可写 → **0 积分**、请求直接失败，并在报错里给出可执行的修复命令。
 *
 * 为什么"探测写一个文件再删"而不是只看 `fs.accessSync`：
 *   `accessSync` 只看权限位，会被只读挂载、磁盘满、inode 耗尽、ACL 等情形骗过；
 *   真写真删才是端到端可用性证据（同理：`/token/check` 不可靠 → 以真生成为准，见项目记忆）。
 */
export function assertWritableDir(outDir: string): void {
  if (!outDir) return;

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e: any) {
    throw new Error(
      `落盘目录不可用（创建失败）：${outDir} —— ${e?.message || e}。`
      + `为避免"图生成成功却存不下来"的积分浪费，本次请求已在**生成前**中止（未消耗积分）。`
      + `请检查路径是否合法、父目录权限是否允许创建。`
    );
  }

  const probe = path.join(outDir, `.write_probe_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (e: any) {
    throw new Error(
      `落盘目录不可写：${outDir} —— ${e?.message || e}。`
      + `为避免"图生成成功却存不下来"的积分浪费，本次请求已在**生成前**中止（未消耗积分）。`
      + `最常见原因：Docker bind mount 的宿主目录属主不是容器内服务用户（uid=1001）。`
      + `修复：sudo chown 1001:1001 <宿主 output 目录>，或改用命名卷（named volume）。`
    );
  }
}

/** 创建任务（同步返回视图），并**立即异步启动**；调用方不等待完成 */
export function createAgentTask(
  request: Omit<AgentRequest, "token"> & { kind?: AgentKind },
  opts: { token?: string; outDir?: string; stripWm?: boolean }
): AgentTaskView {
  const kind: AgentKind = request.kind === "video" ? "video" : "image";
  const id = crypto.randomUUID();
  const rec: AgentTaskRecord = {
    id,
    kind,
    cap: agentCap(kind),
    status: "queued",
    createdAt: Date.now(),
    progress: { total: 0, done: 0, succeeded: 0, failed: 0 },
    outDir: opts.outDir,
    stripWm: !!opts.stripWm,
    scenes: [],
    errors: [],
    token: opts.token,
    request: { ...request, kind },
  };
  tasks.set(id, rec);
  prune();
  persistTask(rec);
  logger.info(`[agent-task] 已创建任务 ${id} kind=${kind} cap=${rec.cap}`);

  // 不 await：提交即返回；失败在任务状态里体现
  void runTask(id);
  return toView(rec);
}

async function runTask(id: string): Promise<void> {
  const rec = tasks.get(id);
  if (!rec) return;
  rec.status = "running";
  rec.startedAt = Date.now();
  persistTask(rec);

  const { token, ...reqNoToken } = rec.request as any;
  const isVideo = rec.kind === "video";

  try {
    const result: AgentBatchResult = await generateAgentBatch(
      { ...reqNoToken, token: rec.token },
      {
        onScene: async (r: AgentSceneResult, done: number, total: number) => {
          rec.progress.total = total;
          rec.progress.done = done;
          rec.progress.succeeded = r.url ? rec.progress.succeeded + 1 : rec.progress.succeeded;
          rec.progress.failed = r.url ? rec.progress.failed : rec.progress.failed + 1;
          // 逐项落盘：拿一项存一项，中途断开也不丢已产出素材。
          // P0-3：判据放宽到 urls —— 由 saveSceneToDisk 全量落盘（张数由 n / gen_count 决定，
          // 未传 n 时上游按模型兜底 default_generate_count，4.x/5.x 为 4；已改为显式下发 gen_count）。
          if (rec.outDir && (r.url || (r.urls && r.urls.length))) {
            try {
              await saveSceneToDisk(r, rec.outDir, rec.stripWm);
            } catch (e: any) {
              logger.warn(`[agent-task] 保存失败 ${r.title}: ${e?.message || e}`);
            }
          }
          rec.scenes.push(r);
          persistTask(rec);
        },
      }
    );

    rec.scenes = result.scenes;
    rec.errors = result.errors;
    rec.progress = {
      total: result.total,
      done: result.scenes.length,
      succeeded: result.succeeded,
      failed: result.failed,
    };
    rec.status = result.failed === 0 ? "succeeded" : result.succeeded === 0 ? "failed" : "partial";
  } catch (e: any) {
    rec.status = "failed";
    rec.errors.push(e?.message || String(e));
    logger.error(`[agent-task] 任务 ${id} 失败: ${e?.message || e}`);
  } finally {
    rec.finishedAt = Date.now();
    rec.token = undefined; // 清除凭证，避免随快照落盘
    persistTask(rec);
    logger.info(
      `[agent-task] 任务 ${id} 结束：${rec.status} 成功 ${rec.progress.succeeded}/${rec.progress.total}`
      + `（${isVideo ? "视频" : "图片"}，上限 ${rec.cap}）`
    );
  }
}

export function getAgentTask(id: string): AgentTaskView | undefined {
  prune();
  const rec = tasks.get(id);
  if (rec) return toView(rec);
  // 内存里没有 → 尝试从落盘快照恢复（进程重启场景）
  try {
    const file = path.join(taskDir(), `${id}.json`);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as AgentTaskView;
    }
  } catch (e: any) {
    logger.warn(`[agent-task] 读取任务快照失败 ${id}: ${e?.message || e}`);
  }
  return undefined;
}

export function listAgentTasks(limit: number = 20): AgentTaskView[] {
  prune();
  return [...tasks.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, limit))
    .map(toView);
}
