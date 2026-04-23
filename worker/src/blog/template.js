// ============================================================
// Template HTML des pages blog Kairos
// ============================================================
// Rendu full-SSR : aucun JS cote client sauf pour l'inscription newsletter
// (optionnel). SEO-friendly, responsive, respecte le meme look que la landing
// (dark theme #0A0F1E, Space Grotesk + Inter, gradient primary).
//
// Deux templates :
//   - renderArticlePage(meta, htmlBody, headings) → page article individuelle
//   - renderIndexPage(articles) → /blog (liste)

import { escHtml } from './renderer.js';

const SITE = 'https://kairosinsider.fr';

// ------------------------------------------------------------
// CSS partage entre index + article (inline pour 0 requete externe)
// ------------------------------------------------------------
const SHARED_CSS = `
  :root {
    --bg-primary: #0A0F1E;
    --bg-secondary: #111827;
    --bg-card: rgba(255, 255, 255, 0.02);
    --bg-elevated: rgba(255, 255, 255, 0.04);
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.15);
    --text-primary: #F9FAFB;
    --text-secondary: #9CA3AF;
    --text-muted: #6B7280;
    --accent-blue: #3B82F6;
    --accent-purple: #8B5CF6;
    --accent-green: #10B981;
    --accent-orange: #F59E0B;
    --accent-pink: #EC4899;
    --gradient-primary: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
  }
  * { margin:0; padding:0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.7;
    font-size: 17px;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  body::before {
    content: '';
    position: fixed; inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(ellipse at top, rgba(0,0,0,0.5), transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse at top, rgba(0,0,0,0.5), transparent 70%);
    pointer-events: none; z-index: 0;
  }
  a { color: var(--accent-blue); text-decoration: none; transition: color 0.15s; }
  a:hover { color: var(--accent-purple); }

  /* --- Nav (identique landing) --- */
  .nav-wrap {
    position: sticky; top: 0; z-index: 100;
    background: rgba(10, 15, 30, 0.85);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
  }
  .nav {
    max-width: 1280px;
    margin: 0 auto;
    padding: 16px 32px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .logo {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 21px; font-weight: 700;
    color: var(--text-primary);
    display: inline-flex; align-items: center; gap: 10px;
    text-decoration: none;
  }
  .logo-mark {
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .logo-mark img { width: 100%; height: 100%; object-fit: contain; }
  .logo-text {
    font-family: 'Space Grotesk', sans-serif;
    background: linear-gradient(135deg, #F9FAFB 0%, #9CA3AF 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .nav-links { display: flex; gap: 32px; align-items: center; }
  .nav-links a {
    color: var(--text-secondary);
    font-size: 14px; font-weight: 500;
    transition: color 0.2s;
    text-decoration: none;
  }
  .nav-links a:hover { color: var(--text-primary); }
  .nav-links a.is-current { color: var(--text-primary); }
  .btn-cta {
    padding: 11px 22px;
    background: var(--gradient-primary);
    color: #fff !important;
    border-radius: 10px;
    font-size: 14px; font-weight: 600;
    box-shadow: 0 4px 14px rgba(59,130,246,0.4), 0 0 0 1px rgba(255,255,255,0.1) inset;
    transition: all 0.2s;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .btn-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 24px rgba(59,130,246,0.55), 0 0 0 1px rgba(255,255,255,0.18) inset;
    filter: brightness(1.08);
    color: #fff !important;
  }
  @media (max-width: 760px) {
    .nav { padding: 12px 20px; }
    .nav-links { gap: 14px; }
    .nav-links a:not(.btn-cta) { display: none; }
    .logo-text { display: none; } /* on garde juste le logo-mark pour economiser l'espace */
  }

  /* --- Layout container --- */
  .container {
    position: relative; z-index: 1;
    max-width: 780px;
    margin: 0 auto;
    padding: 48px 32px 80px;
  }
  .container-wide {
    max-width: 1040px;
    margin: 0 auto;
    padding: 48px 32px 80px;
    position: relative; z-index: 1;
  }
  @media (max-width: 640px) {
    .container, .container-wide { padding: 32px 20px 60px; }
  }

  /* --- Footer --- */
  footer {
    padding: 40px 32px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    border-top: 1px solid var(--border);
    position: relative; z-index: 1;
  }
  footer a { color: var(--text-secondary); margin: 0 12px; }

  /* --- Article content typography --- */
  .article h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 42px;
    line-height: 1.15;
    letter-spacing: -0.02em;
    margin: 0 0 24px;
    background: linear-gradient(135deg, #F9FAFB 0%, #C7D2FE 70%, #A78BFA 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .article h2 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 28px;
    line-height: 1.2;
    margin: 48px 0 16px;
    color: var(--text-primary);
    letter-spacing: -0.01em;
    scroll-margin-top: 80px;
  }
  .article h3 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 21px;
    line-height: 1.25;
    margin: 32px 0 12px;
    color: var(--text-primary);
    scroll-margin-top: 80px;
  }
  @media (max-width: 640px) {
    .article h1 { font-size: 30px; }
    .article h2 { font-size: 23px; margin: 36px 0 12px; }
    .article h3 { font-size: 19px; }
  }
  .heading-anchor {
    color: var(--text-muted);
    margin-right: 8px;
    font-weight: 400;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .article h2:hover .heading-anchor,
  .article h3:hover .heading-anchor { opacity: 0.6; }

  .article p {
    margin: 18px 0;
    color: var(--text-secondary);
  }
  .article strong { color: var(--text-primary); font-weight: 600; }
  .article em { color: var(--text-primary); }
  .article ul, .article ol {
    margin: 18px 0 18px 24px;
    color: var(--text-secondary);
  }
  .article li { margin: 6px 0; }
  .article li::marker { color: var(--accent-blue); }

  /* Code */
  .article code.inline {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 0.9em;
    padding: 2px 6px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--accent-orange);
  }
  .article pre.code-block {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 22px;
    margin: 24px 0;
    overflow-x: auto;
    line-height: 1.55;
  }
  .article pre.code-block code { color: #CBD5E1; }

  /* Blockquote */
  .article blockquote {
    margin: 28px 0;
    padding: 16px 22px;
    border-left: 3px solid var(--accent-purple);
    background: linear-gradient(90deg, rgba(139,92,246,0.08) 0%, rgba(139,92,246,0.02) 100%);
    border-radius: 0 10px 10px 0;
    color: var(--text-primary);
    font-style: italic;
  }

  /* Table */
  .article .table-wrap {
    margin: 24px 0;
    overflow-x: auto;
    border-radius: 10px;
    border: 1px solid var(--border);
  }
  .article table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .article th, .article td {
    padding: 10px 14px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .article th {
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-weight: 600;
    font-family: 'Space Grotesk', sans-serif;
    letter-spacing: 0.01em;
  }
  .article tr:last-child td { border-bottom: none; }
  .article tr:hover td { background: rgba(255,255,255,0.015); }

  .article hr {
    border: none;
    height: 1px;
    background: var(--border);
    margin: 40px 0;
  }

  /* --- Article meta row --- */
  .article-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
    margin: 0 0 32px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .article-meta .dot { opacity: 0.4; }
  .article-meta .badge {
    padding: 3px 10px;
    background: rgba(59,130,246,0.12);
    border: 1px solid rgba(59,130,246,0.25);
    color: #93C5FD;
    border-radius: 100px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* --- Mid-article CTA newsletter --- */
  .cta-newsletter {
    margin: 48px 0;
    padding: 28px 32px;
    background: linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(139,92,246,0.06) 100%);
    border: 1px solid rgba(139,92,246,0.25);
    border-radius: 16px;
    text-align: center;
  }
  .cta-newsletter h4 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-primary);
  }
  .cta-newsletter p { margin: 0 0 18px; color: var(--text-secondary); font-size: 14px; }
  .cta-form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: center;
    max-width: 440px;
    margin: 0 auto;
  }
  .cta-form input {
    flex: 1;
    min-width: 200px;
    padding: 12px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
  }
  .cta-form input:focus { outline: none; border-color: var(--accent-blue); }
  .cta-form button {
    padding: 12px 20px;
    background: var(--gradient-primary);
    color: #fff;
    border: none;
    border-radius: 10px;
    font-weight: 600;
    font-size: 14px;
    font-family: inherit;
    cursor: pointer;
    transition: transform 0.15s;
  }
  .cta-form button:hover { transform: translateY(-1px); }

  /* --- Article end CTA (Pro) --- */
  .cta-pro {
    margin: 56px 0 24px;
    padding: 36px 40px;
    background:
      radial-gradient(ellipse at top right, rgba(139,92,246,0.25), transparent 60%),
      linear-gradient(135deg, rgba(59,130,246,0.12), rgba(139,92,246,0.08));
    border: 1px solid rgba(139,92,246,0.35);
    border-radius: 18px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .cta-pro h3 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 26px;
    margin: 0 0 10px;
    background: linear-gradient(135deg, #F9FAFB, #A78BFA);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .cta-pro p { color: var(--text-secondary); margin: 0 0 22px; font-size: 15px; }
  .cta-pro .btn-big {
    display: inline-block;
    padding: 14px 32px;
    background: var(--gradient-primary);
    color: #fff;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 700;
    box-shadow: 0 8px 24px rgba(59,130,246,0.4);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .cta-pro .btn-big:hover { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(59,130,246,0.5); color: #fff; }
  .cta-pro .fine { margin-top: 12px; font-size: 12px; color: var(--text-muted); }

  /* --- TOC sidebar sticky (desktop only) --- */
  .layout-with-toc {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 56px;
    max-width: 1100px;
    margin: 0 auto;
    padding: 48px 32px 80px;
    position: relative; z-index: 1;
  }
  .toc {
    position: sticky;
    top: 88px;
    align-self: start;
    max-height: calc(100vh - 110px);
    overflow-y: auto;
    padding: 18px 4px 18px 18px;
    border-left: 1px solid var(--border);
  }
  .toc h4 {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin-bottom: 14px;
    font-weight: 700;
    font-family: 'Space Grotesk', sans-serif;
    padding-left: 2px;
  }
  .toc ul { list-style: none; margin: 0; padding: 0; }
  .toc li { margin: 0; }
  .toc a {
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 6px 0 6px 14px;
    margin-left: -1px;
    border-left: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    font-size: 13px;
    line-height: 1.4;
    word-break: break-word;
  }
  .toc a[data-level="2"] {
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 13px;
    margin-top: 10px;
  }
  .toc a[data-level="2"]:first-child { margin-top: 0; }
  .toc a[data-level="3"] {
    padding-left: 28px;
    font-size: 12px;
    font-weight: 400;
    color: var(--text-muted);
    opacity: 0.85;
  }
  .toc a:hover {
    color: var(--text-primary);
    border-left-color: var(--accent-purple);
    background: rgba(139,92,246,0.05);
  }
  .toc a.active {
    color: var(--text-primary);
    border-left-color: var(--accent-blue);
    background: rgba(59,130,246,0.06);
  }
  /* Scrollbar custom TOC */
  .toc::-webkit-scrollbar { width: 4px; }
  .toc::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
  @media (max-width: 960px) {
    .layout-with-toc { grid-template-columns: 1fr; padding: 32px 20px 60px; gap: 24px; }
    .toc {
      position: static; max-height: none; margin-bottom: 12px;
      border-left: none;
      padding: 14px 18px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
  }

  /* --- Blog index --- */
  .blog-hero {
    text-align: center;
    padding: 48px 0 32px;
  }
  .blog-hero h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 48px;
    line-height: 1.1;
    letter-spacing: -0.03em;
    background: linear-gradient(135deg, #F9FAFB 0%, #C7D2FE 60%, #A78BFA 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 14px;
  }
  .blog-hero p {
    color: var(--text-secondary);
    font-size: 17px;
    max-width: 560px;
    margin: 0 auto;
  }
  @media (max-width: 640px) { .blog-hero h1 { font-size: 34px; } }

  .posts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 20px;
    margin-top: 40px;
  }
  .post-card {
    display: block;
    padding: 28px 28px 24px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    transition: transform 0.2s, border-color 0.2s, background 0.2s;
    color: inherit;
  }
  .post-card:hover {
    transform: translateY(-3px);
    border-color: rgba(139,92,246,0.4);
    background: linear-gradient(135deg, rgba(59,130,246,0.04), rgba(139,92,246,0.02));
    color: inherit;
  }
  .post-card .post-meta {
    font-size: 12px; color: var(--text-muted);
    letter-spacing: 0.03em;
    margin-bottom: 12px;
    display: flex; gap: 8px; align-items: center;
  }
  .post-card h2 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 20px;
    line-height: 1.3;
    color: var(--text-primary);
    margin: 0 0 10px;
    letter-spacing: -0.01em;
  }
  .post-card p {
    color: var(--text-secondary);
    font-size: 14px;
    line-height: 1.55;
    margin: 0 0 14px;
  }
  .post-card .read-more {
    color: var(--accent-blue);
    font-size: 13px;
    font-weight: 600;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .post-card:hover .read-more { color: var(--accent-purple); }
`;

// ------------------------------------------------------------
// Layout commun : head + nav + footer
// ------------------------------------------------------------
function layout({ title, description, canonical, ogImage, bodyHtml, extraJsonLd = '' }) {
  const ogImg = ogImage || `${SITE}/og-image.png`;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImg}">
<meta property="og:site_name" content="Kairos Insider">
<meta property="og:locale" content="fr_FR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(description)}">
<meta name="twitter:image" content="${ogImg}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${extraJsonLd}
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="nav-wrap">
  <nav class="nav">
    <a href="/" class="logo">
      <span class="logo-mark"><img src="/assets/logo.svg" alt="Kairos Insider"></span>
      <span class="logo-text">Kairos Insider</span>
    </a>
    <div class="nav-links">
      <a href="/#features">Fonctionnalités</a>
      <a href="/#pricing">Tarifs</a>
      <a href="/blog" class="is-current">Blog</a>
      <a href="/dashboard.html" class="btn-cta">Accéder gratuitement</a>
    </div>
  </nav>
</div>
${bodyHtml}
<footer>
  <div style="margin-bottom:16px">
    <a href="/">Accueil</a>
    <a href="/blog">Blog</a>
    <a href="/legal.html">Mentions légales</a>
    <a href="/privacy.html">Confidentialité</a>
    <a href="/cgv.html">CGV</a>
  </div>
  <div>© ${new Date().getFullYear()} Kairos Insider · Éditeur de données financières · Les informations publiées ne constituent pas un conseil en investissement.</div>
</footer>
</body>
</html>`;
}

// ------------------------------------------------------------
// Formatage date FR
// ------------------------------------------------------------
function fmtDateFR(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

// ------------------------------------------------------------
// Page article individuelle
// ------------------------------------------------------------
export function renderArticlePage(meta, htmlBody, headings = []) {
  const canonical = `${SITE}/blog/${meta.slug}`;
  const title = `${meta.title} · Kairos Insider`;

  // TOC generation (h2 + h3 uniquement) — on exclut :
  //   - le h2 "Table des matieres" (redondant avec la TOC sidebar elle-meme)
  //   - le h2 "FAQ" s'il est tout seul on le garde (utile)
  const isTocMeta = (t) => /table\s*des\s*mati[eè]res/i.test(t);
  const tocItems = headings
    .filter(h => (h.level === 2 || h.level === 3) && !isTocMeta(h.text))
    .map(h => `<li><a href="#${h.id}" data-level="${h.level}">${escHtml(h.text)}</a></li>`)
    .join('');
  const tocHtml = tocItems
    ? `<aside class="toc"><h4>Dans cet article</h4><ul>${tocItems}</ul></aside>`
    : '';

  // Mid-article CTA newsletter (insere apres ~50% du contenu)
  const bodyWithCta = injectMidCta(htmlBody);

  // JSON-LD Article schema
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: meta.title,
    description: meta.description,
    author: { '@type': 'Organization', name: meta.author || 'Kairos Insider' },
    publisher: {
      '@type': 'Organization',
      name: 'Kairos Insider',
      logo: { '@type': 'ImageObject', url: `${SITE}/favicon.svg` },
    },
    datePublished: meta.date,
    dateModified: meta.date,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    image: meta.ogImage || `${SITE}/og-image.png`,
    keywords: meta.keywords || '',
  };
  const jsonLdBlock = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

  const content = `
<div class="layout-with-toc">
  ${tocHtml}
  <article class="article">
    <div class="article-meta">
      <span class="badge">Guide</span>
      <span>${fmtDateFR(meta.date)}</span>
      <span class="dot">·</span>
      <span>${escHtml(meta.readingTime || '8 min')} de lecture</span>
      <span class="dot">·</span>
      <span>${escHtml(meta.author || 'Kairos Insider')}</span>
    </div>
    ${bodyWithCta}

    <div class="cta-pro">
      <h3>Prêt à voir ce que les pros voient ?</h3>
      <p>Kairos Insider agrège tous les signaux smart money (insiders, hedge funds, activists, ETF) dans une plateforme francophone. Kairos Score 0-100 sur 8 axes, alertes, screener.</p>
      <a href="/dashboard.html" class="btn-big">Tester gratuitement →</a>
      <div class="fine">3 analyses complètes par jour · sans carte bancaire</div>
    </div>
  </article>
</div>
`;

  return layout({
    title,
    description: meta.description,
    canonical,
    ogImage: meta.ogImage,
    bodyHtml: content,
    extraJsonLd: jsonLdBlock,
  });
}

// ------------------------------------------------------------
// Page index /blog
// ------------------------------------------------------------
export function renderIndexPage(articles) {
  const canonical = `${SITE}/blog`;

  const cards = articles
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(a => `
      <a href="/blog/${a.slug}" class="post-card">
        <div class="post-meta">
          <span>${fmtDateFR(a.date)}</span>
          <span>·</span>
          <span>${escHtml(a.readingTime || '8 min')}</span>
        </div>
        <h2>${escHtml(a.title)}</h2>
        <p>${escHtml(a.description)}</p>
        <span class="read-more">Lire l'article →</span>
      </a>`)
    .join('');

  const content = `
<div class="container-wide">
  <div class="blog-hero">
    <h1>Le blog Kairos</h1>
    <p>Guides pratiques, études smart money, analyses hedge funds et insiders — tout pour comprendre ce que les pros voient avant vous.</p>
  </div>
  <div class="posts-grid">${cards || '<p style="text-align:center;color:var(--text-muted)">Aucun article pour le moment.</p>'}</div>

  <div class="cta-newsletter" style="margin-top:64px">
    <h4>Newsletter hebdomadaire · gratuite</h4>
    <p>Le Brief du lundi : les 5 mouvements smart money de la semaine, en 3 min de lecture.</p>
    <form class="cta-form" action="/api/newsletter/subscribe" method="post">
      <input type="email" name="email" placeholder="votre@email.com" required>
      <button type="submit">S'inscrire</button>
    </form>
  </div>
</div>
`;

  return layout({
    title: 'Blog · Kairos Insider · Smart money expliqué',
    description: 'Guides et analyses sur les hedge funds, les insiders, les activists. Voyez ce que les pros voient.',
    canonical,
    bodyHtml: content,
  });
}

// ------------------------------------------------------------
// Injection CTA newsletter au milieu d'un article
// Heuristique : on coupe juste avant le premier <hr> qui se trouve apres
// ~40% du body HTML (sinon on tombe sur la TOC en debut d'article).
// ------------------------------------------------------------
function injectMidCta(html) {
  const cta = `
<div class="cta-newsletter">
  <h4>📬 Le Brief du lundi</h4>
  <p>Chaque lundi 8h : les 5 mouvements smart money de la semaine, en 3 minutes.<br>Gratuit, pas de spam.</p>
  <form class="cta-form" action="/api/newsletter/subscribe" method="post">
    <input type="email" name="email" placeholder="votre@email.com" required>
    <button type="submit">S'inscrire</button>
  </form>
</div>
`;
  const half = Math.floor(html.length * 0.5);
  const idx = html.indexOf('<hr>', half);
  if (idx === -1) return html + cta; // fallback : en fin
  return html.slice(0, idx) + cta + html.slice(idx);
}
