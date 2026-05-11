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

# Brand colors (RGB) — palette v3 alignee sur le logo Kairos
# Logo : anneau gradient bleu vif top-left -> violet milieu -> rose
# magenta bottom-right. Pour matcher, on utilise blue-500 -> pink-500.
BLUE = (59, 130, 246, 255)         # #3B82F6 (blue-500, saturated)
PINK = (236, 72, 153, 255)         # #EC4899 (pink-500, saturated)
VIOLET = (139, 92, 246, 255)       # #8B5CF6 (violet-500, point d'interpolation)
YELLOW = (250, 204, 21, 255)       # #FACC15
GREEN = (16, 185, 129, 255)        # #10B981
WHITE = (255, 255, 255, 255)


def make_gradient_circle_bg(color1, color2, radius=42):
    """Background circle with real diagonal gradient (color1 top-left ->
    color2 bottom-right) + subtle glow.

    Implementation : on dessine un gradient diagonal full-size, puis on
    masque par un cercle. PIL ne supporte pas les gradients natifs ; on
    interpole pixel par pixel le long de l'axe diagonal."""
    # 1. Calque gradient full-size : interpolation diagonale
    grad = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    pixels = grad.load()
    # Axe de projection diagonale : on calcule la position normalisee
    # de chaque pixel le long de l'axe (top-left -> bottom-right).
    max_dist = (W + H) / 2.0  # demi-diagonale approximative
    for y in range(H):
        for x in range(W):
            # Position normalisee 0..1 le long de la diagonale
            t = (x + y) / (W + H - 2)
            t = max(0.0, min(1.0, t))
            # Interpolation lineaire RGB (pas LAB — overkill pour email)
            r = int(color1[0] + (color2[0] - color1[0]) * t)
            g = int(color1[1] + (color2[1] - color1[1]) * t)
            b = int(color1[2] + (color2[2] - color1[2]) * t)
            pixels[x, y] = (r, g, b, 255)

    # 2. Masque circulaire (rond plein) pour ne garder que le disque
    mask = Image.new('L', (W, H), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.ellipse([
        CENTER[0] - radius, CENTER[1] - radius,
        CENTER[0] + radius, CENTER[1] + radius
    ], fill=255)

    # 3. Combine : gradient * mask (zero outside circle)
    chip = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    chip.paste(grad, (0, 0), mask)

    # 4. Outer soft glow (low alpha autour du cercle, flou gaussien)
    # Cree separement pour ne pas affecter le bord net du gradient.
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    # Glow = couleur moyenne entre color1 et color2, alpha tres faible
    mid_r = (color1[0] + color2[0]) // 2
    mid_g = (color1[1] + color2[1]) // 2
    mid_b = (color1[2] + color2[2]) // 2
    glow_draw.ellipse([
        CENTER[0] - radius - 8, CENTER[1] - radius - 8,
        CENTER[0] + radius + 8, CENTER[1] + radius + 8
    ], fill=(mid_r, mid_g, mid_b, 50))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=6))

    # 5. Composition : glow en arriere-plan, chip par-dessus
    result = Image.alpha_composite(glow, chip)
    return result


def icon_decode():
    """Magnifying glass — represente 'decode/analyze'.

    Background gradient bleu->rose pour matcher exactement le gradient
    du logo Kairos (anneau gradient bleu top-left -> magenta bottom-right).
    Le glyph (loupe) est en blanc pour ressortir sur le bg gradient.
    """
    img = make_gradient_circle_bg(BLUE, PINK, radius=42)
    draw = ImageDraw.Draw(img)

    # Magnifying glass : circle + diagonal handle (en blanc translucide
    # pour conserver le bg gradient visible sous le glyph)
    glass_center = (W // 2 - 4, H // 2 - 4)
    glass_radius = 14
    glyph_color = WHITE  # opaque pour bonne lecture

    # Glass circle ring (thick)
    draw.ellipse([
        glass_center[0] - glass_radius, glass_center[1] - glass_radius,
        glass_center[0] + glass_radius, glass_center[1] + glass_radius
    ], outline=glyph_color, width=4)

    # Glass handle (diagonal line bottom-right)
    handle_start = (
        glass_center[0] + int(glass_radius * 0.7),
        glass_center[1] + int(glass_radius * 0.7),
    )
    handle_end = (handle_start[0] + 12, handle_start[1] + 12)
    draw.line([handle_start, handle_end], fill=glyph_color, width=5)
    # Cap rounded
    draw.ellipse([handle_end[0] - 2, handle_end[1] - 2,
                  handle_end[0] + 2, handle_end[1] + 2], fill=glyph_color)

    return img


def icon_activists():
    """Lightning bolt — represente 'fast signal / activists day 1'.
    Glyph en blanc pour bon contraste sur le bg gradient jaune."""
    img = make_gradient_circle_bg(YELLOW, (252, 226, 91, 255), radius=42)
    draw = ImageDraw.Draw(img)

    # Lightning bolt Z polygon (glyph en blanc opaque)
    bolt_simple = [
        (W // 2 + 4, H // 2 - 24),
        (W // 2 - 10, H // 2 + 2),
        (W // 2 - 2, H // 2 + 2),
        (W // 2 - 6, H // 2 + 24),
        (W // 2 + 12, H // 2 - 4),
        (W // 2 + 2, H // 2 - 4),
    ]
    draw.polygon(bolt_simple, fill=WHITE, outline=(180, 140, 8, 200))

    return img


def icon_markets():
    """Globe with longitude/latitude — represente 'multi-markets / global coverage'.
    Glyph en blanc pour contraste sur le bg gradient vert."""
    img = make_gradient_circle_bg(GREEN, (52, 211, 153, 255), radius=42)
    draw = ImageDraw.Draw(img)

    # Globe : main circle (glyph en blanc)
    globe_radius = 20
    cx, cy = W // 2, H // 2

    # Outer globe ring
    draw.ellipse([cx - globe_radius, cy - globe_radius,
                  cx + globe_radius, cy + globe_radius],
                 outline=WHITE, width=3)

    # Equator (horizontal line)
    draw.line([(cx - globe_radius + 1, cy),
               (cx + globe_radius - 1, cy)], fill=WHITE, width=2)

    # Meridian (vertical ellipse — simulates Earth rotation visual)
    draw.ellipse([cx - globe_radius // 2, cy - globe_radius,
                  cx + globe_radius // 2, cy + globe_radius],
                 outline=WHITE, width=2)

    # 2 tropics (horizontal thin lines) — alpha 200 sur WHITE
    tropic_color = WHITE[:3] + (200,)
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
