#!/usr/bin/env python3
"""Split batch-1 contact sheets into frames and key out white backgrounds.

Strategy (robust to the rounded-corner cards on peek/hang sheets):
  1. Split sheet into N equal vertical cells.
  2. fg = pixels with min_channel < WHITE_T (non-white).
  3. Morphological opening (disk r=4) removes thin card-border lines.
  4. Keep the largest connected component = the character.
  5. Dilate slightly, fill small interior holes (eye whites, teeth, highlights).
  6. Feathered alpha from distance transform + white decontamination.
  7. Crop every frame of a sheet to the UNION bbox (padded) so frames stay
     registered with each other for animation.
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage

WHITE_T = 235
OPEN_R = 4
FEATHER = 3
ERODE = 1

SHEETS = [
    {
        "file": "media-generation-interact-thumbsup-0-6ad87194-a00c-46d6-9912-faac515a7326.png",
        "frames": 6,
        "names": [f"nila_thumbsup_{i:02d}" for i in range(1, 7)],
        "subdir": "interaction",
    },
    {
        "file": "media-generation-interact-point-0-2bfdd74c-e4c6-4bdf-b6dd-f4afe09f9665.png",
        "frames": 6,
        "names": [f"nila_point_{i:02d}" for i in range(1, 7)],
        "subdir": "interaction",
    },
    {
        "file": "media-generation-interact-cheer-0-118d7c24-a4b7-4531-9a56-b4140c0f7ed2.png",
        "frames": 6,
        "names": [f"nila_cheer_{i:02d}" for i in range(1, 7)],
        "subdir": "interaction",
    },
    {
        "file": "media-generation-interact-stretch-0-ebb489d8-0c3c-414a-bda8-3794cfb659ca.png",
        "frames": 6,
        "names": [f"nila_stretch_{i:02d}" for i in range(1, 7)],
        "subdir": "interaction",
    },
    {
        "file": "media-generation-interact-drink-0-bbd1177b-4270-40c8-9357-2928cc0d75d4.png",
        "frames": 6,
        "names": [f"nila_drink_{i:02d}" for i in range(1, 7)],
        "subdir": "interaction",
    },
    {
        "file": "media-generation-sleep-seq-0-a755dc2b-359e-40f4-a3b9-d0d85b00b300.png",
        "frames": 6,
        "names": [f"nila_sleep_{i:02d}" for i in range(1, 7)],
        "subdir": "sleep",
    },
    {
        "file": "media-generation-celebration-seq-5f.png",
        "frames": 5,
        "names": [f"nila_celebration_{i:02d}" for i in range(1, 6)],
        "subdir": "celebration",
    },
    {
        "file": "media-generation-hang-upside-seq-0-cbbfbf71-28a2-4433-909f-68fe541d9d8e.png",
        "frames": 6,
        "names": [f"nila_hang_upside_{i:02d}" for i in range(1, 7)],
        "subdir": "peek/top",
    },
]

BASE = os.path.dirname(os.path.abspath(__file__))
SHEET_DIR = os.path.join(BASE, "sheets")


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def process_cell(rgb):
    """Return (rgba_float, bbox) for one cell. rgb: HxWx3 float 0..255."""
    fg = rgb.min(axis=2) < WHITE_T
    # kill thin card-border lines, keep chunky character
    fg_open = ndimage.binary_opening(fg, structure=disk(OPEN_R))
    labels, n = ndimage.label(fg_open)
    if n == 0:
        # empty cell -> fully transparent
        h, w = rgb.shape[:2]
        return np.zeros((h, w, 4), np.float32), None
    sizes = ndimage.sum(fg_open, labels, range(1, n + 1))
    char = labels == (np.argmax(sizes) + 1)
    # regrow the eroded rim a little, then fill small interior holes
    char = ndimage.binary_dilation(char, structure=disk(OPEN_R - 1), iterations=1)
    holes = ndimage.binary_fill_holes(char) & ~char
    hlab, hn = ndimage.label(holes)
    if hn:
        hsizes = ndimage.sum(holes, hlab, range(1, hn + 1))
        keep = np.zeros_like(holes)
        for i, s in enumerate(hsizes, 1):
            if s < 0.01 * char.sum():  # small holes: eye whites, teeth, highlights
                keep |= hlab == i
        char = char | keep
    # feathered alpha
    dist = ndimage.distance_transform_edt(char)
    alpha = np.clip((dist - ERODE) / FEATHER, 0, 1)
    # decontaminate white spill on semi-transparent edge pixels
    a = alpha[..., None]
    rgb_out = np.where(a > 1e-3, (rgb - (1 - a) * 255.0) / np.maximum(a, 1e-3), 0)
    rgb_out = np.clip(rgb_out, 0, 255)
    rgba = np.dstack([rgb_out, alpha * 255.0]).astype(np.float32)
    ys, xs = np.nonzero(alpha > 0.03)
    bbox = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    return rgba, bbox


def main():
    for spec in SHEETS:
        path = os.path.join(SHEET_DIR, spec["file"])
        sheet = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
        H, W, _ = sheet.shape
        n = spec["frames"]
        cw = W // n
        print(f"== {spec['file']}: {W}x{H}, {n} cells of ~{cw}px")
        cells = [sheet[:, i * cw:(i + 1) * cw] for i in range(n)]
        # last cell takes any remainder
        if n * cw < W:
            cells[-1] = sheet[:, (n - 1) * cw:W]

        results = [process_cell(c) for c in cells]
        bboxes = [b for _, b in results if b]
        if not bboxes:
            print("   no foreground found, skipping")
            continue
        x0 = min(b[0] for b in bboxes)
        y0 = min(b[1] for b in bboxes)
        x1 = max(b[2] for b in bboxes)
        y1 = max(b[3] for b in bboxes)
        pad = max(16, int(0.03 * cw))
        # union bbox in sheet coords, using first-cell origin (all cells same size except maybe last)
        # -> compute per-cell crop: same relative box for every cell
        rel = (max(0, x0 - pad), max(0, y0 - pad),
               min(cells[0].shape[1], x1 + pad), min(cells[0].shape[0], y1 + pad))
        print(f"   union crop (rel): {rel} -> {(rel[2]-rel[0])}x{(rel[3]-rel[1])}")

        outdir = os.path.join(BASE, spec["subdir"])
        os.makedirs(outdir, exist_ok=True)
        for (rgba, _), name in zip(results, spec["names"]):
            crop = rgba[rel[1]:rel[3], rel[0]:rel[2]]
            if crop[..., 3].max() < 1:
                print(f"   WARN {name}: empty frame")
            im = Image.fromarray(np.clip(crop, 0, 255).astype(np.uint8), "RGBA")
            out = os.path.join(outdir, name + ".png")
            im.save(out)
            print(f"   wrote {out} {im.size} "
                  f"{os.path.getsize(out)//1024}KB")


if __name__ == "__main__":
    main()
