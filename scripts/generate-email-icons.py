#!/usr/bin/env python3
"""
Generate 3 premium PNG icons for welcome email body.
Icons are 96x96 @2x (rendered at 48px in email = retina sharp).
Background : transparent.
Style : flat geometric, brand gradient blue/violet, soft contour.

Output : assets/email/icon-decode.png, icon-activists.png, icon-markets.png

Why local generation (vs emojis or external CDN) :
- Emojis render differently per OS (Apple vs MS vs Google) -> not premium
- External icon CDNs (iconify) don't serve PNG natively
- Self-hosted PNG = consistent rendering across all email clients
  (Apple Mail, Gmail web/iOS/Android, Outlook desktop/web, Yahoo, etc.)
"""
from PIL import Image, ImageDraw, ImageFilter
import os
import math

# Output directory
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'email')
os.makedirs(OUT_DIR, exist_ok=True)

# Canvas dimensions (retina @2x)
W, H = 96, 96
CENTER = (W // 2, H // 2)

# Brand colors (RGB)
BLUE = (116, 185, 255, 255)        # #74b9ff
VIOLET = (162, 155, 254, 255)      # #a29bfe
YELLOW = (250, 204, 21, 255)       # #FACC15
GREEN = (16, 185, 129, 255)        # #10B981
WHITE = (255, 255, 255, 255)


def make_gradient_circle_bg(color1, color2, radius=42):
    """Background circle with brand gradient + subtle glow."""
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Outer soft glow (low alpha, larger radius, blurred)
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse([
        CENTER[0] - radius - 8, CENTER[1] - radius - 8,
        CENTER[0] + radius + 8, CENTER[1] + radius + 8
    ], fill=color1[:3] + (35,))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=6))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # Solid circle (the chip itself) — mid-tone blend of color1/color2
    # Simulate a gradient by drawing color2, then color1 with mask top-down.
    chip = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    chip_draw = ImageDraw.Draw(chip)
    chip_draw.ellipse([
        CENTER[0] - radius, CENTER[1] - radius,
        CENTER[0] + radius, CENTER[1] + radius
    ], fill=color2[:3] + (45,))
    # Soft inner stroke for depth
    chip_draw.ellipse([
        CENTER[0] - radius, CENTER[1] - radius,
        CENTER[0] + radius, CENTER[1] + radius
    ], outline=color1[:3] + (140,), width=2)

    img = Image.alpha_composite(img, chip)
    return img


def icon_decode():
    """Magnifying glass over a small chart bar — represente 'decode/analyze'."""
    img = make_gradient_circle_bg(BLUE, VIOLET, radius=42)
    draw = ImageDraw.Draw(img)

    # Magnifying glass : circle + diagonal handle
    glass_center = (W // 2 - 4, H // 2 - 4)
    glass_radius = 14

    # Glass circle ring (thick)
    draw.ellipse([
        glass_center[0] - glass_radius, glass_center[1] - glass_radius,
        glass_center[0] + glass_radius, glass_center[1] + glass_radius
    ], outline=BLUE, width=4)

    # Glass handle (diagonal line bottom-right)
    handle_start = (
        glass_center[0] + int(glass_radius * 0.7),
        glass_center[1] + int(glass_radius * 0.7),
    )
    handle_end = (handle_start[0] + 12, handle_start[1] + 12)
    draw.line([handle_start, handle_end], fill=BLUE, width=5)
    # Cap rounded
    draw.ellipse([handle_end[0] - 2, handle_end[1] - 2,
                  handle_end[0] + 2, handle_end[1] + 2], fill=BLUE)

    return img


def icon_activists():
    """Lightning bolt — represente 'fast signal / activists day 1'."""
    img = make_gradient_circle_bg(YELLOW, (252, 226, 91, 255), radius=42)
    draw = ImageDraw.Draw(img)

    # Lightning bolt path (z-shape)
    bolt = [
        (W // 2 + 6, H // 2 - 22),    # top-right
        (W // 2 - 8, H // 2),          # mid-left
        (W // 2 - 2, H // 2),          # mid-center
        (W // 2 - 6, H // 2 + 22),    # bottom
        (W // 2 + 12, H // 2 - 4),    # right-mid
        (W // 2 + 4, H // 2 - 4),     # back to start chain
    ]
    # Drawing as filled polygon — classic Z bolt
    bolt_simple = [
        (W // 2 + 4, H // 2 - 24),
        (W // 2 - 10, H // 2 + 2),
        (W // 2 - 2, H // 2 + 2),
        (W // 2 - 6, H // 2 + 24),
        (W // 2 + 12, H // 2 - 4),
        (W // 2 + 2, H // 2 - 4),
    ]
    draw.polygon(bolt_simple, fill=YELLOW, outline=(180, 140, 8, 220))

    return img


def icon_markets():
    """Globe with longitude/latitude — represente 'multi-markets / global coverage'."""
    img = make_gradient_circle_bg(GREEN, (52, 211, 153, 255), radius=42)
    draw = ImageDraw.Draw(img)

    # Globe : main circle
    globe_radius = 20
    cx, cy = W // 2, H // 2

    # Outer globe ring
    draw.ellipse([cx - globe_radius, cy - globe_radius,
                  cx + globe_radius, cy + globe_radius],
                 outline=GREEN, width=3)

    # Equator (horizontal line)
    draw.line([(cx - globe_radius + 1, cy),
               (cx + globe_radius - 1, cy)], fill=GREEN, width=2)

    # Meridian (vertical ellipse — simulates Earth rotation visual)
    draw.ellipse([cx - globe_radius // 2, cy - globe_radius,
                  cx + globe_radius // 2, cy + globe_radius],
                 outline=GREEN, width=2)

    # 2 tropics (horizontal thin lines) — alpha 180 sur GREEN
    tropic_color = GREEN[:3] + (180,)
    for dy in [-8, 8]:
        # Each tropic = horizontal line clipped to circle
        # Approximate width via pythagore
        h_at_dy = int(math.sqrt(max(0, globe_radius**2 - dy**2)))
        draw.line([(cx - h_at_dy + 2, cy + dy),
                   (cx + h_at_dy - 2, cy + dy)], fill=tropic_color, width=1)

    return img


# Generate + save all icons
icons = {
    'icon-decode': icon_decode(),
    'icon-activists': icon_activists(),
    'icon-markets': icon_markets(),
}

for name, img in icons.items():
    # Apply final subtle smoothing
    img = img.resize((96, 96), Image.LANCZOS)
    out_path = os.path.join(OUT_DIR, name + '.png')
    img.save(out_path, 'PNG', optimize=True)
    print(f'Generated {out_path} ({os.path.getsize(out_path)} bytes)')

print('\nDone. 3 icons generated in assets/email/')
