/**
 * _verify_payload.ts —— 报文级离线断言（不消耗任何积分）
 *
 * 用途：把 FIX_PLAN_v3.0 §四「核验清单 V-1~V-8」中**不需要真机**的部分全部跑一遍，
 * 逐条打印「改前实测值 → 改后实测值」，供留档对账。
 *
 * 运行方式（见同目录 _run_verify_payload.sh）：
 *   node_modules/.bin/esbuild _verify_payload.ts --bundle --platform=node --format=cjs --outfile=_verify_payload.cjs
 *   node _verify_payload.cjs
 */
import {
  buildDraftContent,
  buildCoreParam,
  buildMetricsExtra,
  resolveRequestImageCount,
  getImageCountPerRequest,
  getBenefitCount,
  MAX_SINGLE_IMAGE_COUNT,
  MAX_GROUP_IMAGE_COUNT,
} from "@/api/builders/payload-builder.ts";
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_MODEL_US, IMAGE_MODEL_MAP, IMAGE_MODEL_MAP_US, IMAGE_MODEL_MAP_ASIA } from "@/api/consts/common.ts";
import { DA_VERSION, WEB_VERSION } from "@/api/consts/dreamina.ts";
import { getModel } from "@/api/controllers/images.ts";

const CN = { isUS: false, isHK: false, isJP: false, isSG: false, isInternational: false, isCN: true };
const US = { isUS: true, isHK: false, isJP: false, isSG: false, isInternational: true, isCN: false };

let pass = 0, fail = 0;
const lines: string[] = [];
function check(id: string, desc: string, cond: boolean, detail: string) {
  const ok = cond ? "PASS" : "FAIL";
  if (cond) pass++; else fail++;
  lines.push(`[${ok}] ${id} ${desc}${detail ? " —— " + detail : ""}`);
}
function safe<T>(fn: () => T): { ok: boolean; v?: T; err?: string } {
  try { return { ok: true, v: fn() }; } catch (e: any) { return { ok: false, err: e?.message || String(e) }; }
}

// ────────────────────────────────────────────────────────────
// V-1 / V-2：gen_count 存在，且 gen_option 在 abilities 层（不在 abilities.generate 内）
// ────────────────────────────────────────────────────────────
const componentId = "11111111-2222-3333-4444-555555555555";
const coreParam = buildCoreParam({
  userModel: "jimeng-5.0-lite",
  model: "high_aes_general_v50",
  prompt: "一只在太空中飞行的柴犬",
  seed: 1,
  sampleStrength: 0.5,
  resolution: { width: 2048, height: 2048, imageRatio: 1, resolutionType: "2k", isForced: false },
  intelligentRatio: false,
  mode: "text2img",
});

const draftText = buildDraftContent({ componentId, generateType: "generate", coreParam, genCount: 3 });
const draft = JSON.parse(draftText);
const comp0 = draft.component_list[0];
const ab = comp0.abilities;

check("V-2a", "abilities.gen_option 存在（张数开关在 abilities 层）", !!ab.gen_option,
  `abilities 键 = ${Object.keys(ab).join(", ")}`);
check("V-2b", "abilities.generate 内**不再**有 gen_option（旧错层已移除）",
  ab.generate && ab.generate.gen_option === undefined,
  `abilities.generate 键 = ${ab.generate ? Object.keys(ab.generate).join(", ") : "(不存在)"}`);
check("V-1", "gen_option.gen_count 已发送且值 = 期望张数 3",
  ab.gen_option?.gen_count === 3, `gen_count = ${JSON.stringify(ab.gen_option?.gen_count)}`);
check("V-2c", "gen_option.generate_all 保持 false", ab.gen_option?.generate_all === false, "");
check("C-4a", "component.gen_type = 1（与官网报文对齐）", comp0.gen_type === 1, `gen_type = ${JSON.stringify(comp0.gen_type)}`);
check("C-4b", "core_param.generate_type = 0（与官网报文对齐）", ab.generate?.core_param?.generate_type === 0,
  `core_param.generate_type = ${JSON.stringify(ab.generate?.core_param?.generate_type)}`);
check("C-4c", "draft_content.version 仍为 3.3.9（本轮**有意**不动，见 common.ts 注）",
  draft.version === "3.3.9", `version = ${draft.version}`);
check("V-8a", "gen_count 可到上限 8", (() => {
  const d = JSON.parse(buildDraftContent({ componentId, generateType: "generate", coreParam, genCount: 8 }));
  return d.component_list[0].abilities.gen_option.gen_count === 8;
})(), "");
check("V-8b", `gen_count 超过上限 9 会被钳到 ${MAX_SINGLE_IMAGE_COUNT}（内层钳制，外层已在路由报错）`, (() => {
  const d = JSON.parse(buildDraftContent({ componentId, generateType: "generate", coreParam, genCount: 9 }));
  return d.component_list[0].abilities.gen_option.gen_count === MAX_SINGLE_IMAGE_COUNT;
})(), "");
check("C-1c", "未传 genCount 时落到环境变量/默认 1", (() => {
  const d = JSON.parse(buildDraftContent({ componentId, generateType: "generate", coreParam }));
  return d.component_list[0].abilities.gen_option.gen_count === getImageCountPerRequest();
})(), `默认 = ${getImageCountPerRequest()}`);

// blend（图生图）分支
const blendText = buildDraftContent({
  componentId, generateType: "blend", coreParam, imageCount: 1, genCount: 2,
  abilityList: [], promptPlaceholderInfoList: [], posteditParam: { type: "", id: "x", generate_type: 0 },
});
const blend = JSON.parse(blendText).component_list[0];
check("C-1d", "blend 分支同样带 abilities.gen_option.gen_count = 2（且与 blend 平级）",
  blend.abilities.gen_option?.gen_count === 2 && !!blend.abilities.blend,
  `abilities 键 = ${Object.keys(blend.abilities).join(", ")}`);

// ────────────────────────────────────────────────────────────
// C-5：benefitCount 跟随 n（不再硬编码）
// ────────────────────────────────────────────────────────────
const mExtra = JSON.parse(buildMetricsExtra({
  userModel: "jimeng-5.0-lite", model: "high_aes_general_v50", regionInfo: CN as any,
  submitId: "s", scene: "ImageBasicGenerate", resolutionType: "2k", abilityList: [], imageCount: 3,
}));
const bc = JSON.parse(mExtra.sceneOptions)[0].benefitCount;
check("C-5a", "埋点 benefitCount 跟随 n=3", bc === 3, `benefitCount = ${JSON.stringify(bc)}`);
check("C-5b", "多图模式不加 benefitCount", getBenefitCount("jimeng-4.0", CN as any, true, 3) === undefined, "");

// ────────────────────────────────────────────────────────────
// V-8：n 的入参校验（越界必须报错，不静默截断）
// ────────────────────────────────────────────────────────────
check("V-8c", "n=1 合法", safe(() => resolveRequestImageCount(1)).v === 1, "");
check("V-8d", "n=8 合法", safe(() => resolveRequestImageCount(8)).v === 8, "");
check("V-8e", "n=9 被拒（> 上限 8）", safe(() => resolveRequestImageCount(9)).ok === false, "已抛出明确报错");
check("V-8f", "n=0 被拒", safe(() => resolveRequestImageCount(0)).ok === false, "");
check("V-8g", "n=2.5 被拒（非整数）", safe(() => resolveRequestImageCount(2.5)).ok === false, "");
check("V-8h", "n 未传 → 回退默认", resolveRequestImageCount(undefined) === getImageCountPerRequest(), "");

// ────────────────────────────────────────────────────────────
// V-5：默认模型 = 5.0 Lite；内部键 = high_aes_general_v50
// ────────────────────────────────────────────────────────────
check("V-5a", "DEFAULT_IMAGE_MODEL = jimeng-5.0-lite", DEFAULT_IMAGE_MODEL === "jimeng-5.0-lite", DEFAULT_IMAGE_MODEL);
check("V-5b", "别名映射 5.0-lite → high_aes_general_v50", IMAGE_MODEL_MAP["jimeng-5.0-lite"] === "high_aes_general_v50", "");
check("V-5c", "旧名 jimeng-5.0 保留为同义别名（向后兼容）", IMAGE_MODEL_MAP["jimeng-5.0"] === "high_aes_general_v50", "");
check("V-5d", "ASIA 映射含 5.0-lite", IMAGE_MODEL_MAP_ASIA["jimeng-5.0-lite"] === "high_aes_general_v50", "");
check("V-5e", "US 映射**不含** 5.0-lite（U-4 未取证，维持现状）", IMAGE_MODEL_MAP_US["jimeng-5.0-lite"] === undefined, "");
check("V-5f", "DEFAULT_IMAGE_MODEL_US 仍为 jimeng-4.5（国际站未取证）", DEFAULT_IMAGE_MODEL_US === "jimeng-4.5", DEFAULT_IMAGE_MODEL_US);
check("V-5g", "jimeng-4.5 内部键 = high_aes_general_v40l（U-3 已闭合）", IMAGE_MODEL_MAP["jimeng-4.5"] === "high_aes_general_v40l", "");

// ────────────────────────────────────────────────────────────
// V-5/V-7：getModel 行为（默认落点 / 未知模型不静默降级）
// ────────────────────────────────────────────────────────────
const mDefault = safe(() => getModel("", CN as any));
check("V-5h", "CN 站不传 model → 落到区域默认 5.0-lite / v50",
  mDefault.ok && mDefault.v!.userModel === "jimeng-5.0-lite" && mDefault.v!.model === "high_aes_general_v50",
  JSON.stringify(mDefault.v || mDefault.err));
const mJimeng = safe(() => getModel("jimeng", CN as any));
check("V-5i", "传通用占位符 jimeng → 同样落到区域默认",
  mJimeng.ok && mJimeng.v!.userModel === "jimeng-5.0-lite", JSON.stringify(mJimeng.v || mJimeng.err));
const mUnknown = safe(() => getModel("jimeng-9.9-typo", CN as any));
check("V-7a", "CN 站未知模型**明确报错**（不再静默换成默认模型）", mUnknown.ok === false,
  mUnknown.ok ? "⚠️ 仍被静默降级！" : "已报错");
const mUnknownUS = safe(() => getModel("jimeng-5.0-lite", US as any));
check("V-7b", "US 站收到 CN 默认模型 → 仍回退（原有兼容行为未破坏）",
  mUnknownUS.ok && mUnknownUS.v!.userModel === "jimeng-4.5", JSON.stringify(mUnknownUS.v || mUnknownUS.err));
const mUSUnknown = safe(() => getModel("jimeng-4.6", US as any));
check("V-7c", "US 站不支持的其他模型 → 报错", mUSUnknown.ok === false, mUSUnknown.ok ? "⚠️ 未报错" : "已报错");

// ────────────────────────────────────────────────────────────
// C-4：版本参数
// ────────────────────────────────────────────────────────────
check("C-4d", "DA_VERSION = 3.3.20（请求级，对齐官网）", DA_VERSION === "3.3.20", DA_VERSION);
check("C-4e", "WEB_VERSION 仍为 7.5.0（本就对齐）", WEB_VERSION === "7.5.0", WEB_VERSION);

console.log("\n".repeat(1));
console.log("=== 张数/模型修复 · 报文级离线断言 ===");
console.log(`上限：单图 ${MAX_SINGLE_IMAGE_COUNT} / 组图 ${MAX_GROUP_IMAGE_COUNT}`);
console.log("-".repeat(80));
lines.forEach((l) => console.log(l));
console.log("-".repeat(80));
console.log(`PASS ${pass} / FAIL ${fail} / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
