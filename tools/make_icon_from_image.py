# -*- coding: utf-8 -*-
"""把用户提供的图转成应用图标：去掉四角白底 → 生成 PNG 套图 + ICO"""
import os
from collections import deque
from PIL import Image, ImageFilter

SRC = r"C:\Users\64381\.workbuddy\clipboard-images\clipboard-2026-10-26T11-31-27-229Z-695beb2e.jpg"
ROOT = r"C:\Users\64381\WorkBuddy\2026-10-26-19-01-38\king-of-focus"


def near_white(c, tol=232):
    return c[0] > tol and c[1] > tol and c[2] > tol


def load_square():
    im = Image.open(SRC).convert("RGB")
    w, h = im.size
    if w != h:
        s = min(w, h)
        im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    px = im.load()
    w, h = im.size

    # 从四条边泛洪，把连通的近白像素变透明（保留画面内部的白色）
    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    vis = bytearray(w * h)
    q = deque()

    def push(x, y):
        if 0 <= x < w and 0 <= y < h:
            i = y * w + x
            if not vis[i] and near_white(px[x, y]):
                vis[i] = 1
                q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    cleared = 0
    while q:
        x, y = q.popleft()
        ap[x, y] = 0
        cleared += 1
        push(x - 1, y)
        push(x + 1, y)
        push(x, y - 1)
        push(x, y + 1)

    print(f"透明化像素: {cleared} ({cleared / (w * h) * 100:.2f}%)")
    rgba = im.convert("RGBA")
    rgba.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.8)))

    # 按 alpha 裁掉多余空白
    bbox = rgba.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    print("裁剪后尺寸:", rgba.size)
    return rgba


def main():
    master = load_square().resize((1024, 1024), Image.LANCZOS)

    icons = os.path.join(ROOT, "src-tauri", "icons")
    ext = os.path.join(ROOT, "extension", "icons")
    ui = os.path.join(ROOT, "ui")
    for d in (icons, ext, ui):
        os.makedirs(d, exist_ok=True)

    def save(size, path):
        master.resize((size, size), Image.LANCZOS).save(path, "PNG")
        print("  ->", os.path.relpath(path, ROOT), size)

    for size, name in [(32, "32x32.png"), (48, "48x48.png"), (128, "128x128.png"),
                       (256, "128x128@2x.png"), (512, "icon.png")]:
        save(size, os.path.join(icons, name))

    for size, name in [(16, "16.png"), (48, "48.png"), (128, "128.png")]:
        save(size, os.path.join(ext, name))

    save(128, os.path.join(ui, "logo.png"))

    ico_path = os.path.join(icons, "icon.ico")
    master.save(ico_path, format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("  -> src-tauri/icons/icon.ico", os.path.getsize(ico_path), "bytes")


if __name__ == "__main__":
    main()
