#!/usr/bin/env python3
"""Generate the SealedBid featured image (1280x720, 16:9) for the fest submission.

Title art only: no statistics, no transaction data, nothing fabricated.
Regenerate with: python3 scripts/make-cover.py
"""
from PIL import Image, ImageDraw, ImageFont
import os
import random

W, H = 1280, 720
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "featured.png")

# Deep-space gradient: dark teal -> near-black blue.
top = (10, 34, 44)
bottom = (5, 10, 28)
img = Image.new("RGB", (W, H), top)
px = img.load()
for y in range(H):
    t = y / (H - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    for x in range(W):
        px[x, y] = (r, g, b)

d = ImageDraw.Draw(img, "RGBA")

# Subtle starfield (deterministic pseudo-random dots).
random.seed(7)
for _ in range(200):
    x = random.randint(0, W - 1)
    y = random.randint(0, H - 1)
    r = random.choice([1, 1, 2])
    a = random.randint(24, 90)
    d.ellipse([x - r, y - r, x + r, y + r], fill=(170, 220, 255, a))

# Glow behind the envelope.
cx, cy = 960, 340
for i in range(60, 0, -1):
    a = int(3 + (60 - i) * 0.35)
    d.ellipse([cx - 200 - i * 3, cy - 150 - i * 3, cx + 200 + i * 3, cy + 150 + i * 3],
              fill=(64, 200, 190, a))

# Sealed envelope: body + flap + wax seal.
ex0, ey0, ex1, ey1 = cx - 210, cy - 130, cx + 210, cy + 130
d.rounded_rectangle([ex0, ey0, ex1, ey1], radius=18, fill=(28, 52, 66, 255),
                    outline=(120, 220, 210, 255), width=3)
# Flap (V shape from top corners to centre).
d.polygon([(ex0, ey0 + 10), (ex1, ey0 + 10), (cx, cy + 10)],
          outline=(120, 220, 210, 255), width=3)
# Wax seal: crimson disc with a keyhole-ish "S" cut.
d.ellipse([cx - 52, cy - 52, cx + 52, cy + 52], fill=(178, 58, 72, 255),
          outline=(230, 120, 130, 255), width=3)
d.ellipse([cx - 38, cy - 38, cx + 38, cy + 38], outline=(230, 120, 130, 255), width=2)

# Lock dots: small "sealed" marks along the flap.
for fx in (cx - 120, cx + 120):
    d.ellipse([fx - 8, cy - 58, fx + 8, cy - 42], fill=(120, 220, 210, 255))

# Title text.
def font(size, bold=False):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()

d.text((72, 250), "SealedBid", font=font(92, bold=True), fill=(240, 248, 255, 255))
d.text((76, 360), "Sealed-bid auctions, sealed with", font=font(32), fill=(190, 220, 235, 255))
d.text((76, 405), "ML-KEM-1024 post-quantum encryption.", font=font(32), fill=(190, 220, 235, 255))
d.text((76, 480), "QORECHAIN  •  ENCRYPTED APPS  •  TESTNET", font=font(22, bold=True),
       fill=(120, 220, 210, 255))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT)
print(f"Wrote {OUT}")
