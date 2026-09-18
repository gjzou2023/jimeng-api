# -*- coding: utf-8 -*-
"""jimeng-api 水印去除核心工具（纯 Pillow，零浏览器依赖）
========================================================

从 gjzou-即梦AI创作/tools/watermark_strip.py 提取的核心函数，
专供 jimeng-api 集成使用。

依赖：仅 Pillow
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from PIL import Image, ImageStat

# ─────────────────────────── 常量 ───────────────────────────

REF_W, REF_H = 2560, 1440
REF_TL_BOX = (26, 25, 135, 121)
REF_CROP_LEFT = 140
REF_CROP_RIGHT = 155
REF_CROP_BOTTOM = 166
REF_BR_ZONE = (0.65, 0.85)

DOD_MAX_BR_NEARWHITE = 50
DOD_ASPECT_TOL = 0.001
DOD_MIN_RES_STRIP = 0.90
DOD_MIN_RES_CROP = 0.85
DOD_MAX_SEAM_STEP = 8.0
DOD_MIN_STD_RATIO = 0.15
DOD_MAX_STD_RATIO = 3.0

NEAR_WHITE_MIN = 150
NEAR_WHITE_SAT = 45

_HASH_RE = re.compile(r"[0-9a-f]{32}")


def extract_hash(text: str) -> str:
    """从 URL 或路径中提取 32 位十六进制 hash。"""
    m = _HASH_RE.search(text or "")
    return m.group(0) if m else ""


def scale_box(box, size, ref=(REF_W, REF_H)):
    """按目标尺寸等比缩放修复盒。"""
    sx, sy = size[0] / float(ref[0]), size[1] / float(ref[1])
    return (int(round(box[0] * sx)), int(round(box[1] * sy)),
            int(round(box[2] * sx)), int(round(box[3] * sy)))


def crop_box_for(size, ref=(REF_W, REF_H)):
    """给出"裁掉水印画边且保持源图宽高比"的裁剪框。"""
    w, h = size
    ratio = w / float(h)
    left = int(round(REF_CROP_LEFT * w / float(ref[0])))
    bottom = int(round(REF_CROP_BOTTOM * h / float(ref[1])))
    new_h = h - bottom
    new_w = int(round(new_h * ratio))
    min_right = int(round(REF_CROP_RIGHT * w / float(ref[0])))
    if w - left - new_w < min_right:
        new_w = w - left - min_right
    new_w = max(8, new_w)
    return (left, 0, left + new_w, new_h)


# ─────────────────────────── 谐波插值（SOR） ───────────────────────────

def _seed_separable(px, box):
    """用盒外一圈真实像素做可分离双线性播种。"""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    top = [px[x0 + i, y0 - 1] for i in range(w)]
    bot = [px[x0 + i, y1] for i in range(w)]
    lft = [px[x0 - 1, y0 + j] for j in range(h)]
    rgt = [px[x1, y0 + j] for j in range(h)]

    cur = []
    for j in range(h):
        vy = (j + 1) / (h + 1.0)
        ly, ry = lft[j], rgt[j]
        row = []
        for i in range(w):
            vx = (i + 1) / (w + 1.0)
            t = top[i]
            b = bot[i]
            h0 = ly[0] + vx * (ry[0] - ly[0])
            h1 = ly[1] + vx * (ry[1] - ly[1])
            h2 = ly[2] + vx * (ry[2] - ly[2])
            v0 = t[0] + vy * (b[0] - t[0])
            v1 = t[1] + vy * (b[1] - t[1])
            v2 = t[2] + vy * (b[2] - t[2])
            row.append([(h0 + v0) * 0.5, (h1 + v1) * 0.5, (h2 + v2) * 0.5])
        cur.append(row)
    return cur


def harmonic_inpaint(img, box, sweeps=600, omega=1.9, tol=0.15, seed=True, report=None):
    """对 img 的 box 区域做谐波插值修复（原地修改）。"""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        raise ValueError(f"修复盒非法: {box}")

    img_w, img_h = img.size
    if x0 < 1 or y0 < 1 or x1 >= img_w or y1 >= img_h:
        raise ValueError(f"修复盒 {box} 需严格位于图像内部")

    px = img.load()
    if seed:
        cur = _seed_separable(px, box)
    else:
        n = w * h
        acc = [0, 0, 0]
        for j in range(h):
            for i in range(w):
                r, g, b = px[x0 + i, y0 + j]
                acc[0] += r; acc[1] += g; acc[2] += b
        mean = [acc[0] / n, acc[1] / n, acc[2] / n]
        cur = [[list(mean) for _ in range(w)] for _ in range(h)]

    used = sweeps
    for s in range(sweeps):
        mx = 0.0
        for j in range(h):
            row = cur[j]
            y = y0 + j
            row_up = cur[j - 1] if j > 0 else None
            row_dn = cur[j + 1] if j < h - 1 else None
            by_u = None if j > 0 else y0 - 1
            by_d = None if j < h - 1 else y1
            for i in range(w):
                c = row[i]
                if i > 0:
                    lv = row[i - 1]
                else:
                    lv = px[x0 - 1, y]
                if i < w - 1:
                    rv = row[i + 1]
                else:
                    rv = px[x1, y]
                if row_up is not None:
                    uv = row_up[i]
                else:
                    uv = px[x0 + i, by_u]
                if row_dn is not None:
                    dv = row_dn[i]
                else:
                    dv = px[x0 + i, by_d]
                for k in range(3):
                    tgt = (lv[k] + rv[k] + uv[k] + dv[k]) * 0.25
                    old = c[k]
                    nv = old + omega * (tgt - old)
                    d = nv - old
                    if d < 0: d = -d
                    if d > mx: mx = d
                    c[k] = nv
        if mx < tol:
            used = s + 1
            break

    for j in range(h):
        row = cur[j]
        y = y0 + j
        for i in range(w):
            v = row[i]
            r = int(v[0] + 0.5)
            g = int(v[1] + 0.5)
            b = int(v[2] + 0.5)
            px[x0 + i, y] = (255 if r > 255 else (0 if r < 0 else r),
                             255 if g > 255 else (0 if g < 0 else g),
                             255 if b > 255 else (0 if b < 0 else b))
    if report is not None:
        report["sweeps_used"] = used
        report["converged"] = bool(used < sweeps)
    return img


# ─────────────────────────── 核心函数 ───────────────────────────

def _resolve_out(srcp, out, out_name, suffix_tag="_nowm"):
    """统一解析输出路径。"""
    if out is None and out_name is None:
        return srcp.with_name(f"{srcp.stem}{suffix_tag}{srcp.suffix}")
    p = Path(out)
    if p.is_dir():
        name = out_name or f"{srcp.stem}{suffix_tag}{srcp.suffix}"
        return p / name
    return p


def strip_file(src, out=None, box=None, sweeps=600, tol=0.15, quality=95, out_name=None):
    """抹除左上角标，输出满幅成品。"""
    srcp = Path(src)
    img = Image.open(srcp).convert("RGB")
    w, h = img.size
    bx = tuple(box) if box else scale_box(REF_TL_BOX, (w, h))
    before = ImageStat.Stat(img.crop(bx).convert("L")).mean[0], ImageStat.Stat(img.crop(bx).convert("L")).stddev[0]

    rep = {}
    t0 = time.time()
    harmonic_inpaint(img, bx, sweeps=sweeps, tol=tol, report=rep)
    elapsed = time.time() - t0
    after = ImageStat.Stat(img.crop(bx).convert("L")).mean[0], ImageStat.Stat(img.crop(bx).convert("L")).stddev[0]

    outp = _resolve_out(srcp, out, out_name)
    outp.parent.mkdir(parents=True, exist_ok=True)
    img.save(outp, quality=quality)

    return {
        "ok": True, "mode": "strip", "src": str(srcp), "out": str(outp),
        "size": [w, h], "bytes": outp.stat().st_size,
        "tl_box": list(bx),
        "tl_before": {"mean": round(before[0], 2), "std": round(before[1], 2)},
        "tl_after": {"mean": round(after[0], 2), "std": round(after[1], 2)},
        "sweeps_used": rep.get("sweeps_used"), "converged": rep.get("converged"),
        "elapsed_s": round(elapsed, 2), "credits": 0,
    }


def crop_file(src, out=None, quality=95, out_name=None):
    """兜底裁剪，保持源图宽高比。"""
    srcp = Path(src)
    img = Image.open(srcp).convert("RGB")
    w, h = img.size
    bx = crop_box_for((w, h))
    out_img = img.crop(bx)
    outp = _resolve_out(srcp, out, out_name)
    outp.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(outp, quality=quality)
    ratio_src = w / float(h)
    ratio_out = out_img.size[0] / float(out_img.size[1])
    return {
        "ok": True, "mode": "crop", "src": str(srcp), "out": str(outp),
        "crop_box": list(bx), "src_size": [w, h], "size": list(out_img.size),
        "bytes": outp.stat().st_size,
        "aspect_dev": round(abs(ratio_out - ratio_src) / ratio_src * 100, 4),
        "area_kept_pct": round(out_img.size[0] * out_img.size[1] / float(w * h) * 100, 2),
        "credits": 0,
    }


# 右下字标检测：用比 DoD 更"紧"的角区，降低画面内容误报
BR_DETECT_ZONE = (0.72, 0.93)
# 判定阈值：紧区内近白像素占比 ≥ 该值才认为"疑似有水印"
BR_DETECT_PCT = 1.0


def detect_watermark(path, br_pct_threshold=BR_DETECT_PCT):
    """启发式检测图片是否带右下角「Dreamina AI」字标。

    背景（2026-09-12 实测）：jimeng-api 返回的图片来自 Dreamina CDN 接口，
    实测 1k/2k 均**不带水印**；而本函数用于在 auto 模式下**保守地**决定是否需要裁剪，
    避免无谓损失约 21.7% 画面。

    返回:
        {"has_wm": bool, "br_count": int, "zone_total": int, "br_pct": float,
         "tl_bright": int, "size": [w, h], "threshold_pct": float}
    """
    p = Path(path)
    img = Image.open(p).convert("RGB")
    w, h = img.size
    px = img.load()

    zx, zy = BR_DETECT_ZONE
    x0, y0 = int(w * zx), int(h * zy)
    br = 0
    tot = 0
    for yy in range(y0, h):
        for xx in range(x0, w):
            tot += 1
            c = px[xx, yy]
            if max(c[:3]) - min(c[:3]) < NEAR_WHITE_SAT and min(c[:3]) > NEAR_WHITE_MIN:
                br += 1
    pct = (100.0 * br / tot) if tot else 0.0

    # 左上角标（较宽的区域，仅作参考）
    box = scale_box(REF_TL_BOX, (w, h))
    tl = sum(1 for yy in range(box[1], box[3]) for xx in range(box[0], box[2])
             if sum(px[xx, yy][:3]) / 3 > 170)

    return {
        "has_wm": pct >= br_pct_threshold,
        "br_count": br, "zone_total": tot, "br_pct": round(pct, 3),
        "tl_bright": tl, "size": [w, h],
        "threshold_pct": br_pct_threshold,
    }


def verify_file(path, src_size=None, tl_box=None, mode="strip"):
    """对成品跑 DoD 验收。"""
    p = Path(path)
    img = Image.open(p).convert("RGB")
    w, h = img.size
    res = {"file": str(p), "mode": mode, "size": [w, h], "bytes": p.stat().st_size, "checks": []}

    # C1: 右下无字标
    px = img.load()
    x0, y0 = int(w * 0.65), int(h * 0.85)
    br = sum(1 for yy in range(y0, h) for xx in range(x0, w)
             if (mr := max(px[xx, yy][:3])) - min(px[xx, yy][:3]) < 45 and min(px[xx, yy][:3]) > 150)
    c1 = br <= DOD_MAX_BR_NEARWHITE
    res["br_nearwhite"] = br
    res["checks"].append({"name": "右下无字标", "value": br, "pass": c1})

    # C2: 左上角标
    box = tuple(tl_box) if tl_box else scale_box(REF_TL_BOX, (w, h))
    tb = sum(1 for yy in range(box[1], box[3]) for xx in range(box[0], box[2])
             if sum(px[xx, yy][:3]) / 3 > 170)
    c2 = tb <= 200
    res["tl_bright"] = tb
    res["tl_box"] = list(box)
    res["checks"].append({"name": "左上角标已抹除", "value": tb, "pass": c2})

    res["ok"] = bool(c1 and c2)
    return res
