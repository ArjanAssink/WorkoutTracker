"""Draws the iOS app icon: the web app's W, on a deeper gradient, with a sync badge.

The home-screen bookmark (the PWA) and the native app sit side by side on the phone, so the
app's icon keeps the same W and blue family but adds a sync mark and a darker ground.
Geometry was measured from public/app-assets/icon-v1-512.png. Re-run after changing it:
    python3 scripts/dev/make-ios-icon.py
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / "ios/WorkoutSync/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
SIZE, SS = 1024, 4                      # final size, supersampling factor
S = SIZE * SS
k = S / 512                             # 512-space (the measured icon) → canvas

TOP, BOTTOM = (42, 120, 214), (16, 52, 120)   # web icon blue → deep navy
WHITE = (255, 255, 255)

img = Image.new("RGB", (S, S))
d = ImageDraw.Draw(img)
for y in range(S):
    t = y / (S - 1)
    d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))

# The W: same polyline and stroke as the web icon, round caps and joins.
pts = [(102, 228), (167, 343), (247, 213), (322, 343), (412, 160)]
pts = [(x * k, y * k) for x, y in pts]
w = 58 * k
d.line(pts, fill=WHITE, width=round(w), joint="curve")
for x, y in pts:
    r = w / 2
    d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)

# Sync badge, bottom right: white disc, two arrows chasing round a circle.
cx, cy, R = 418 * k, 418 * k, 62 * k
d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=WHITE)
ring, stroke = R * 0.56, R * 0.17
arrow = BOTTOM
for start in (200, 20):                 # two 140° arcs, gaps at the arrowheads
    end = start + 125
    d.arc([cx - ring, cy - ring, cx + ring, cy + ring], start, end, fill=arrow, width=round(stroke))
    a = math.radians(end)
    tip = (cx + ring * math.cos(a), cy + ring * math.sin(a))
    tangent = (-math.sin(a), math.cos(a))          # direction of travel (clockwise in image space)
    normal = (math.cos(a), math.sin(a))
    h = stroke * 1.9
    p1 = (tip[0] + tangent[0] * h * 0.9, tip[1] + tangent[1] * h * 0.9)
    p2 = (tip[0] + normal[0] * h * 0.75, tip[1] + normal[1] * h * 0.75)
    p3 = (tip[0] - normal[0] * h * 0.75, tip[1] - normal[1] * h * 0.75)
    d.polygon([p1, p2, p3], fill=arrow)

img.resize((SIZE, SIZE), Image.LANCZOS).save(OUT, optimize=True)
print(OUT)
