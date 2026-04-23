// ============================================================
// Blog Kairos — router + registry
// ============================================================
// Les articles sont stockes en Markdown dans ./articles/*.md.
// Wrangler les charge comme strings (rule Text dans wrangler.toml) au
// moment du build ; on les parse au 1er hit (puis c'est en memoire du
// worker = tres rapide).
//
// Expose :
//   - handleBlogIndex() : GET /blog
//   - handleBlogPost(slug) : GET /blog/:slug
//   - handleBlogFeed() : GET /blog/feed.xml (RSS 2.0)
//   - listPublishedArticles() : meta-array pour sitemap / sidebar
//
// Chaque article .md a un frontmatter YAML avec : title, slug, description,
// keywords, date, author, readingTime.

import article01 from './articles/01-quest-ce-quun-13F.md';
import article02 from './articles/02-comment-suivre-warren-buffett.md';
import article03 from './articles/03-insider-trading-legal-vs-illegal.md';

import { parseFrontmatter, renderMarkdown, escHtml } from './renderer.js';
import { renderArticlePage, renderIndexPage } from './template.js';

const SITE = 'https://kairosinsider.fr';

// ------------------------------------------------------------
// Raw articles registry — ordre = ordre chrono editorial
// ------------------------------------------------------------
const RAW_ARTICLES = [article01, article02, article03];

// Cache parse : on ne parse les .md qu'une fois par instance de worker
let _parsedCache = null;
function getParsedArticles() {
  if (_parsedCache) return _parsedCache;
  _parsedCache = RAW_ARTICLES.map(md => {
    const { meta, body } = parseFrontmatter(md);
    return { meta, body };
  }).filter(a => a.meta && a.meta.slug);
  return _parsedCache;
}

// ------------------------------------------------------------
// Expose la liste des articles publies (pour sitemap, rss, etc.)
// ------------------------------------------------------------
export function listPublishedArticles() {
  return getParsedArticles().map(a => ({
    slug: a.meta.slug,
    title: a.meta.title,
    description: a.meta.description,
    date: a.meta.date,
    readingTime: a.meta.readingTime,
    keywords: a.meta.keywords,
  }));
}

// ------------------------------------------------------------
// Cherche un article par slug
// ------------------------------------------------------------
function findBySlug(slug) {
  return getParsedArticles().find(a => a.meta.slug === slug) || null;
}

// ------------------------------------------------------------
// GET /blog — page index (liste des articles)
// ------------------------------------------------------------
export function handleBlogIndex() {
  const articles = listPublishedArticles();
  const html = renderIndexPage(articles);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ------------------------------------------------------------
// GET /blog/:slug — article individuel
// ------------------------------------------------------------
export function handleBlogPost(slug) {
  const article = findBySlug(slug);
  if (!article) {
    return new Response(renderNotFound(slug), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const { html, headings } = renderMarkdown(article.body);
  const page = renderArticlePage(article.meta, html, headings);
  return new Response(page, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // CDN cache long (1h) — on repush a chaque deploy donc pas de risque
      // de contenu perime en prod
      'Cache-Control': 'public, max-age=600, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ------------------------------------------------------------
// GET /blog/feed.xml — flux RSS 2.0
// ------------------------------------------------------------
export function handleBlogFeed() {
  const articles = getParsedArticles();
  const items = articles
    .sort((a, b) => (a.meta.date < b.meta.date ? 1 : -1))
    .map(a => {
      const link = `${SITE}/blog/${a.meta.slug}`;
      const pubDate = new Date(a.meta.date).toUTCString();
      return `<item>
<title>${escHtml(a.meta.title)}</title>
<link>${link}</link>
<guid isPermaLink="true">${link}</guid>
<description>${escHtml(a.meta.description)}</description>
<pubDate>${pubDate}</pubDate>
<author>contact@kairosinsider.fr (${escHtml(a.meta.author || 'Kairos Insider')})</author>
</item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>Kairos Insider · Blog</title>
<link>${SITE}/blog</link>
<atom:link href="${SITE}/blog/feed.xml" rel="self" type="application/rss+xml"/>
<description>Smart money expliqué : 13F, insiders, activists, ETF. Voyez ce que les pros voient.</description>
<language>fr-FR</language>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
    },
  });
}

// ------------------------------------------------------------
// 404 html (garde le meme look)
// ------------------------------------------------------------
function renderNotFound(slug) {
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Article introuvable · Kairos Insider</title>
<style>
body{font-family:-apple-system,sans-serif;background:#0A0F1E;color:#F9FAFB;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:20px;text-align:center}
h1{font-size:32px;margin:0 0 12px}
a{color:#3B82F6}
</style></head>
<body><div>
<h1>Article introuvable</h1>
<p>L'article "<code>${escHtml(slug)}</code>" n'existe pas ou a été retiré.</p>
<p><a href="/blog">← Retour au blog</a></p>
</div></body></html>`;
}
