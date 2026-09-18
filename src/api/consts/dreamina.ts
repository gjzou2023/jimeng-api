// src/api/consts/dreamina.ts

export const BASE_URL_DREAMINA_US = "https://dreamina-api.us.capcut.com";
export const BASE_URL_IMAGEX_US = "https://imagex16-normal-us-ttp.capcutapi.us";

export const BASE_URL_DREAMINA_HK = "https://mweb-api-sg.capcut.com";
export const BASE_URL_IMAGEX_HK = "https://imagex-normal-sg.capcutapi.com";


export const WEB_VERSION = "7.5.0";
/**
 * 请求级 `da_version`。
 *
 * ⚠️ 2026-09-18 由 `3.3.9` → `3.3.20`（对齐官网当前请求格式）。
 * 依据（两处独立来源）：
 *  ① `zhizinan1997/jimeng-free-api-all` 更新日志 2026-06-24 原文：
 *     「更新请求版本参数:图片与视频生成请求统一更新为 web_version=7.5.0、da_version=3.3.20,
 *       同步当前官网请求格式。」
 *  ② 同仓库源码 `DRAFT_VERSION = "3.3.20"`，注释明确写「the request-level da_version stays 3.3.20」。
 *
 * 为什么改它但**不改** `draft_content.version`：见 `common.ts` 中 `DRAFT_CONTENT_VERSION_NOTE`。
 */
export const DA_VERSION = "3.3.20";
export const AIGC_FEATURES = "app_lip_sync";
