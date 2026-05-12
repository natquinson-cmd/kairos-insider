#!/usr/bin/env python3
"""
Genere le banner X (cover photo) pour @KairosInsider.

Specs X : 1500x500 px (ratio 3:1), max 5 MB, PNG ou JPG.
- Sur desktop : visible entier
- Sur mobile : cropping vertical ~~ centre 1500x350 visible
  -> on garde le contenu critique dans la zone centrale safe (1300x300)

Design (mai 2026 v1) :
- Dark navy bg #0A0E1A avec radial glow gradient brand au centre
- Decorative : ligne de cours boursier qui traverse en zigzag (rappel logo)
- Hero text central : tagline 'Before the news. Before the 13F. Before the herd.'
  3 lignes, derniere en gradient brand bleu->rose
- Bottom strip : nom des 9 regulateurs couverts
- Logo + wordmark en haut a gauche (signature discrete)
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
import math
import random

# Repere repo
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_BOLD = os.path.join(REPO, 'worker', 'fonts', 'Inter-Bold.ttf')
FONT_REG = os.path.join(REPO, 'worker', 'fonts', 'Inter-Regular.ttf')
LOGO = os.path.join(REPO, 'assets', 'logo-256.png')
OUT = os.path.join(REPO, 'assets', 'social', 'x-banner.png')

os.makedirs(os.path.dirname(OUT), exist_ok=True)

# Specs banner X
W, H = 1500, 500
# Zone safe : X impose plusieurs contraintes
# - mobile crop vertical ~75px haut/bas
# - photo profil 200x200 overlay bottom-left (centre vers x=140, y=420)
# - bouton "Editer le profil" / "Suivre" overlay bottom-right
# - sur desktop, le banner s'affiche a ~800px de large (sidebar) donc
#   font 64px -> 34px effectif = trop petit. On bump tout x1.5.
SAFE_TOP = 75
SAFE_BOTTOM = H - 75
PROFILE_PIC_OVERLAP_X = 280   # px reserves en bas a gauche
BUTTON_OVERLAP_X = 220        # px reserves en bas a droite

# Palette brand (cf welcome email + logo)
BG = (10, 14, 26, 255)           # #0A0E1A
SURFACE = (17, 22, 42, 255)      # #11162A
TEXT = (241, 245, 249, 255)      # #F1F5F9 slate-100
MUTED = (148, 163, 184, 255)     # #94A3B8 slate-400
MUTED_DEEP = (100, 116, 139, 255) # #64748B slate-500
BLUE = (59, 130, 246, 255)       # #3B82F6
PINK = (236, 72, 153, 255)       # #EC4899
VIOLET = (139, 92, 246, 255)     # #8B5CF6


def make_radial_glow(width, height, cx, cy, radius, color, max_alpha=80):
    """Cree un glow radial doux (alpha decreasant du centre vers l'exterieur)."""
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    pixels = img.load()
    r2 = radius * radius
    for y in range(max(0, cy - radius), min(height, cy + radius)):
        for x in range(max(0, cx - radius), min(width, cx + radius)):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if d2 < r2:
                t = 1.0 - math.sqrt(d2) / radius
                a = int(max_alpha * (t ** 2))
                pixels[x, y] = color[:3] + (a,)
    return img


def make_gradient_text(text, font, color1, color2, padding=10):
    """Rend un texte avec un gradient horizontal color1->color2.
    Retourne une image RGBA tight-bounded au texte."""
    # Mesure le texte
    dummy = Image.new('RGBA', (1, 1))
    bbox = ImageDraw.Draw(dummy).textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    # Canvas avec padding
    cw = tw + padding * 2
    ch = th + padding * 2

    # 1. Mask alpha du texte (en blanc opaque sur fond transparent)
    mask = Image.new('L', (cw, ch), 0)
    ImageDraw.Draw(mask).text((padding - bbox[0], padding - bbox[1]), text, font=font, fill=255)

    # 2. Gradient horizontal color1 -> color2 sur toute la largeur
    grad = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    gpx = grad.load()
    for x in range(cw):
        t = x / max(1, cw - 1)
        r = int(color1[0] + (color2[0] - color1[0]) * t)
        g = int(color1[1] + (color2[1] - color1[1]) * t)
        b = int(color1[2] + (color2[2] - color1[2]) * t)
        for y in range(ch):
            gpx[x, y] = (r, g, b, 255)

    # 3. Composite : gradient masque par le texte
    out = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def draw_chart_line(img, color_start, color_end, points, line_width=3, glow=True):
    """Dessine une polyline avec gradient + glow optionnel."""
    if glow:
        # Glow : meme line en plus epais avec alpha faible, puis flou
        glow_img = Image.new('RGBA', img.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow_img)
        # Glow couleur moyenne
        mid = tuple((color_start[i] + color_end[i]) // 2 for i in range(3)) + (110,)
        for i in range(len(points) - 1):
            gd.line([points[i], points[i + 1]], fill=mid, width=line_width + 8)
        glow_img = glow_img.filter(ImageFilter.GaussianBlur(radius=8))
        img.alpha_composite(glow_img)

    # Ligne principale segmentee avec gradient horizontal
    draw = ImageDraw.Draw(img)
    if len(points) < 2:
        return
    min_x = min(p[0] for p in points)
    max_x = max(p[0] for p in points)
    span = max(1, max_x - min_x)
    for i in range(len(points) - 1):
        x_mid = (points[i][0] + points[i + 1][0]) / 2
        t = (x_mid - min_x) / span
        r = int(color_start[0] + (color_end[0] - color_start[0]) * t)
        g = int(color_start[1] + (color_end[1] - color_start[1]) * t)
        b = int(color_start[2] + (color_end[2] - color_start[2]) * t)
        draw.line([points[i], points[i + 1]], fill=(r, g, b, 255), width=line_width)


# ===== Construction du banner =====

img = Image.new('RGBA', (W, H), BG)

# 1. Subtle radial glow brand au centre (effet halo)
glow_blue = make_radial_glow(W, H, W // 3, H // 2, 380, BLUE, max_alpha=55)
glow_pink = make_radial_glow(W, H, int(W * 0.72), H // 2, 380, PINK, max_alpha=55)
img.alpha_composite(glow_blue)
img.alpha_composite(glow_pink)

# 2. Decorative chart line en HAUT (vs bas avant) — le bas est crope par la
# photo de profil donc invisible. En haut on a une zone safe ~75-200px.
# 14 points sur la largeur, tendance haussiere avec bruit.
random.seed(42)  # reproductible
N = 14
chart_points = []
y_baseline = H * 0.32  # base dans le tiers superieur (au-dessus du texte)
y_amplitude = 60       # variation verticale (plus petite, on a moins de place)
for i in range(N):
    x = int(40 + (W - 80) * i / (N - 1))
    # Tendance haussiere (y diminue car axis inverse) + bruit
    trend = -y_amplitude * 0.7 * (i / (N - 1))
    noise = random.uniform(-y_amplitude * 0.3, y_amplitude * 0.3)
    y = int(y_baseline + trend + noise)
    chart_points.append((x, y))

# Lissage : moyenne mobile sur 3 points pour effet plus organique
smoothed = []
for i in range(N):
    if i == 0 or i == N - 1:
        smoothed.append(chart_points[i])
    else:
        x = chart_points[i][0]
        y = (chart_points[i - 1][1] + chart_points[i][1] + chart_points[i + 1][1]) // 3
        smoothed.append((x, y))

draw_chart_line(img, BLUE, PINK, smoothed, line_width=3, glow=True)

# 3. Dot rose au bout du chart (echo du logo qui a un dot rose)
end_x, end_y = smoothed[-1]
draw = ImageDraw.Draw(img)
# Glow autour du dot
glow_dot = make_radial_glow(W, H, end_x, end_y, 28, PINK, max_alpha=120)
img.alpha_composite(glow_dot)
# Dot solide
dot_r = 9
draw.ellipse([end_x - dot_r, end_y - dot_r, end_x + dot_r, end_y + dot_r], fill=PINK)
# Inner highlight blanc
draw.ellipse([end_x - 3, end_y - 3, end_x + 3, end_y + 3], fill=(255, 255, 255, 255))

# NB: pas de wordmark top-left. X affiche deja "Kairos Insider" juste sous le
# banner. Doubler le branding fait amateur. On laisse le banner = tagline pure.
# Pas de bottom strip regulators non plus (zone cropee par photo profil
# bottom-left + bouton "Editer le profil" bottom-right).

# 5. Hero text central — 3 lignes BEAUCOUP plus grosses (98px vs 64px)
# Sur X desktop le banner est rendu a ~800px de large (sidebars). Avec
# 98px on a ~52px effectif a l'affichage = lisible et impactant.
# "Before the news. Before the 13F. Before the herd."
font_hero = ImageFont.truetype(FONT_BOLD, 88)
lines = [
    ("Before the news.", TEXT, False),
    ("Before the 13F.", TEXT, False),
    ("Before the herd.", None, True),  # gradient
]

# Mesure hauteur totale et offset vertical
# 88px font + 32px de gap = lines bien aerees, pas de chevauchement
line_spacing = 32
line_heights = []
for txt, _, _ in lines:
    bb = draw.textbbox((0, 0), txt, font=font_hero)
    line_heights.append(bb[3] - bb[1])
total_h = sum(line_heights) + line_spacing * (len(lines) - 1)
# Decale legerement vers le haut pour eviter overlap photo profil bottom-left
y_start = (H - total_h) // 2 - 20

y_cursor = y_start
for (txt, color, is_grad), lh in zip(lines, line_heights):
    bb = draw.textbbox((0, 0), txt, font=font_hero)
    tw = bb[2] - bb[0]
    x_center = (W - tw) // 2
    if is_grad:
        # Rendu gradient (3e ligne "Before the herd.")
        grad_img = make_gradient_text(txt, font_hero, BLUE, PINK, padding=12)
        img.alpha_composite(grad_img, (x_center - 12, y_cursor - bb[1] - 12))
    else:
        draw.text((x_center, y_cursor - bb[1]), txt, font=font_hero, fill=color)
    y_cursor += lh + line_spacing

# Save (PNG pour qualite, JPEG si on veut economiser bytes)
# X accepte PNG jusqu'a 5 MB ; 1500x500 PNG plein ~ 200-600 KB.
img.convert('RGB').save(OUT, 'PNG', optimize=True)
print(f"Generated: {OUT} ({os.path.getsize(OUT)} bytes)")
print(f"Dimensions: {W}x{H}")
