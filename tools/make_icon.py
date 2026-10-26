# -*- coding: utf-8 -*-
"""生成 自律大王 的应用图标（PNG + ICO），纯标准库实现。"""
import struct, zlib, os

S = 3  # 超采样倍数

BG_TOP = (0x25, 0x2A, 0x3D)
BG_BOT = (0x0E, 0x10, 0x18)
BORDER = (0x33, 0x3A, 0x52)
GOLD = (0xFF, 0xB0, 0x24)
GOLD2 = (0xFF, 0x8A, 0x1C)


def rounded(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def wang(x, y):
    """王 字几何"""
    x0, x1 = 0.305, 0.695
    y0, y1 = 0.285, 0.735
    t = 0.085
    if not (x0 <= x <= x1):
        # 竖笔可以超出一点视觉更好，这里严格对齐
        pass
    mid = (y0 + y1) / 2.0
    if x0 <= x <= x1 and (y0 <= y <= y0 + t):
        return True
    if x0 <= x <= x1 and (mid - t / 2 <= y <= mid + t / 2):
        return True
    if x0 <= x <= x1 and (y1 - t <= y <= y1):
        return True
    vt = 0.10
    if (0.5 - vt / 2) <= x <= (0.5 + vt / 2) and (y0 <= y <= y1):
        return True
    return False


def sample(x, y):
    if not rounded(x, y, 0.0, 0.0, 1.0, 1.0, 0.215):
        return None
    if not rounded(x, y, 0.028, 0.028, 0.972, 0.972, 0.196):
        return BORDER
    if wang(x, y):
        return lerp(GOLD, GOLD2, (y - 0.28) / 0.46)
    return lerp(BG_TOP, BG_BOT, y)


def render(size, ss=S):
    rows = []
    for py_i in range(size):
        row = bytearray()
        for px_i in range(size):
            ar = ag = ab = aa = 0.0
            n = 0
            for sy in range(ss):
                for sx in range(ss):
                    n += 1
                    x = (px_i + (sx + 0.5) / ss) / size
                    y = (py_i + (sy + 0.5) / ss) / size
                    c = sample(x, y)
                    if c is not None:
                        ar += c[0]
                        ag += c[1]
                        ab += c[2]
                        aa += 1.0
            if aa == 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes((int(round(ar / aa)), int(round(ag / aa)),
                              int(round(ab / aa)), int(round(255 * aa / n))))
        rows.append(bytes(row))
    return rows


def png_bytes(size):
    rows = render(size)
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico_bytes(sizes):
    entries = []
    for s in sizes:
        rows = render(s)
        # BMP 条目：32bit BGRA，自下而上，height 为 2 倍
        px = bytearray()
        for r in reversed(rows):
            for i in range(0, len(r), 4):
                px += bytes((r[i + 2], r[i + 1], r[i], r[i + 3]))
        mask_row = ((s + 31) // 32) * 4
        mask = b"\x00" * (mask_row * s)
        header = struct.pack("<IiiHHIIiiII", 40, s, s * 2, 1, 32, 0, len(px) + len(mask), 0, 0, 0, 0)
        data = header + bytes(px) + mask
        entries.append((s, data))

    out = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dirs = b""
    body = b""
    for s, data in entries:
        dirs += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        body += data
    return out + dirs + body


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons = os.path.normpath(os.path.join(here, "..", "src-tauri", "icons"))
    os.makedirs(icons, exist_ok=True)
    for name, size in [("32x32.png", 32), ("128x128.png", 128),
                       ("128x128@2x.png", 256), ("icon.png", 512), ("48x48.png", 48)]:
        with open(os.path.join(icons, name), "wb") as f:
            f.write(png_bytes(size))
        print("png", name)
    with open(os.path.join(icons, "icon.ico"), "wb") as f:
        f.write(ico_bytes([16, 24, 32, 48, 64, 128, 256]))
    print("ico icon.ico")

    ext = os.path.normpath(os.path.join(here, "..", "extension", "icons"))
    os.makedirs(ext, exist_ok=True)
    for name, size in [("16.png", 16), ("48.png", 48), ("128.png", 128)]:
        with open(os.path.join(ext, name), "wb") as f:
            f.write(png_bytes(size))
    print("extension icons ok")


if __name__ == "__main__":
    main()
