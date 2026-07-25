#!/usr/bin/env python3
"""生成总账 PWA 图标：¥ 白字 + 红色渐变背景。"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)

BRAND_TOP = (198, 40, 40)     # #c62828
BRAND_BOT = (163, 29, 29)     # #a31d1d

def find_font(size):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

def gradient(size, maskable=False):
    img = Image.new("RGB", (size, size), BRAND_TOP)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / size
        r = int(BRAND_TOP[0] * (1 - t) + BRAND_BOT[0] * t)
        g = int(BRAND_TOP[1] * (1 - t) + BRAND_BOT[1] * t)
        b = int(BRAND_TOP[2] * (1 - t) + BRAND_BOT[2] * t)
        d.line([(0, y), (size, y)], fill=(r, g, b))
    return img

def rounded(img, radius_ratio=0.22):
    size = img.size[0]
    r = int(size * radius_ratio)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=r, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out

def draw_symbol(img, size, scale=0.62):
    d = ImageDraw.Draw(img)
    font = find_font(int(size * scale))
    text = "¥"
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    d.text((x, y), text, font=font, fill=(255, 255, 255))
    return img

def make(size, name, rounded_corners=True, maskable=False):
    img = gradient(size).convert("RGBA")
    scale = 0.5 if maskable else 0.62   # maskable 留安全边距
    draw_symbol(img, size, scale=scale)
    if rounded_corners and not maskable:
        img = rounded(img)
    img.save(os.path.join(OUT, name))
    print("saved", name)

make(180, "icon-180.png", rounded_corners=False)   # iOS apple-touch-icon（系统自动加圆角）
make(192, "icon-192.png", rounded_corners=True)
make(512, "icon-512.png", rounded_corners=True)
make(512, "icon-512-maskable.png", rounded_corners=False, maskable=True)
print("done")
