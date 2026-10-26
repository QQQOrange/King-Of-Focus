"""生成 King of Focus 的新图标：取景框 + 焦点
深色圆角底 + 金色四角取景框 + 中心准心，表达"只看这一个窗口"的专注遮罩。
"""
from PIL import Image, ImageDraw, ImageFilter
import os

S = 1024
OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")

GOLD = (245, 181, 68)
GOLD_DIM = (196, 138, 44)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def vertical_gradient(size, top, bottom):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size))


def main():
    base = vertical_gradient(S, (34, 41, 57), (12, 15, 21))
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0))
    icon.putalpha(rounded_mask(S, int(S * 0.22)))

    d = ImageDraw.Draw(icon)

    # 顶部高光，给一点玻璃质感
    hi = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dh = ImageDraw.Draw(hi)
    dh.ellipse([-S * 0.35, -S * 0.55, S * 1.35, S * 0.52], fill=(255, 255, 255, 16))
    icon.alpha_composite(hi)

    # 四角取景框（L 形）
    pad = int(S * 0.185)
    arm = int(S * 0.20)
    w = int(S * 0.055)
    r = int(S * 0.03)

    def corner(x, y, dx, dy):
        # 横臂
        d.rounded_rectangle(
            [x if dx > 0 else x - arm, y if dy > 0 else y - w,
             (x + arm) if dx > 0 else x, (y + w) if dy > 0 else y],
            radius=r, fill=GOLD,
        )
        # 竖臂
        d.rounded_rectangle(
            [x if dx > 0 else x - w, y if dy > 0 else y - arm,
             (x + w) if dx > 0 else x, (y + arm) if dy > 0 else y],
            radius=r, fill=GOLD,
        )

    corner(pad, pad, 1, 1)
    corner(S - pad, pad, -1, 1)
    corner(pad, S - pad, 1, -1)
    corner(S - pad, S - pad, -1, -1)

    # 中心准心：外环 + 实心点
    c = S // 2
    ring = int(S * 0.135)
    d.ellipse([c - ring, c - ring, c + ring, c + ring], outline=GOLD_DIM, width=int(S * 0.022))
    dot = int(S * 0.052)
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=GOLD)

    # 十字细线（从环向外，短促）
    gap = ring + int(S * 0.045)
    length = int(S * 0.085)
    lw = int(S * 0.016)
    for (x0, y0, x1, y1) in [
        (c, c - gap, c, c - gap - length),
        (c, c + gap, c, c + gap + length),
        (c - gap, c, c - gap - length, c),
        (c + gap, c, c + gap, c + length),
    ]:
        d.rounded_rectangle(
            [min(x0, x1) - lw // 2, min(y0, y1) - lw // 2,
             max(x0, x1) + lw // 2, max(y0, y1) + lw // 2],
            radius=lw // 2, fill=GOLD_DIM,
        )

    # 金色外发光，小尺寸下更醒目
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dg = ImageDraw.Draw(glow)
    dg.rounded_rectangle([6, 6, S - 7, S - 7], radius=int(S * 0.22),
                         outline=(245, 181, 68, 70), width=int(S * 0.012))
    glow = glow.filter(ImageFilter.GaussianBlur(int(S * 0.012)))
    icon.alpha_composite(glow)

    # 输出各种尺寸
    os.makedirs(OUT, exist_ok=True)
    for name, size in [("32x32.png", 32), ("48x48.png", 48),
                       ("128x128.png", 128), ("128x128@2x.png", 256),
                       ("icon.png", 512)]:
        icon.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))

    ico = os.path.join(OUT, "icon.ico")
    icon.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                          (64, 64), (128, 128), (256, 256)])
    print("图标已生成 ->", OUT)


if __name__ == "__main__":
    main()
