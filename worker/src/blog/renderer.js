// ============================================================
// Mini Markdown renderer pour les articles blog Kairos.
// ============================================================
// Pas de dep externe (pas de package.json dans ce worker) → on ecrit
// un renderer minimaliste qui couvre exactement ce qu'on utilise dans
// nos articles pillar SEO :
//   - Frontmatter YAML (--- ... ---)
//   - h1 h2 h3 (avec id auto-genere depuis <a id="..."></a>)
//   - paragraphes
//   - listes ul (-) et ol (1. 2. 3.)
//   - bold (**x**) italic (*x*)
//   - liens [x](y)
//   - code inline (`x`)
//   - code blocks (``` ... ```)
//   - tables pipe-syntax
//   - blockquotes (> ...)
//   - hr (---)
//   - emoji + unicode : passe-plat
//
// C'est volontairement restreint : aucune conversion "fancy" que Markdown
// standard supporte mais qu'on n'utilise pas (footnotes, task lists, etc.).

// ------------------------------------------------------------
// Parse le frontmatter YAML tres simple : --- \n key: value \n ... \n ---
// ------------------------------------------------------------
export function parseFrontmatter(md) {
  const meta = {};
  let body = md;
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3);
    if (end > 0) {
      const front = md.slice(3, end).trim();
      body = md.slice(end + 4).replace(/^\n+/, '');
      for (const line of front.split('\n')) {
        const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        // Retire les guillemets eventuels
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        meta[m[1]] = v;
      }
    }
  }
  return { meta, body };
}

// ------------------------------------------------------------
// Escape HTML pour le contenu utilisateur.
// ------------------------------------------------------------
export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------
// Transforme une ligne inline : **bold** *italic* `code` [link](url)
// ------------------------------------------------------------
function renderInline(text) {
  // On escape d'abord tout, puis on re-active les patterns Markdown.
  // Attention : les patterns operent sur HTML deja escaped donc les &lt;
  // d'une balise <a id=".."> dans la source MD passent bien en <a id="..">
  // NON : on veut laisser passer les <a id="..."></a> tels quels pour que
  // les liens d'ancre fonctionnent. On fait donc une premiere passe pour
  // les remplacer par un placeholder, on escape, on remet les <a id="..">.

  const anchors = [];
  text = text.replace(/<a\s+id="([a-zA-Z0-9_\-]+)"><\/a>/g, (_m, id) => {
    anchors.push(id);
    return `\u0000A${anchors.length - 1}\u0000`;
  });

  let s = escHtml(text);

  // Restore des anchors
  s = s.replace(/\u0000A(\d+)\u0000/g, (_m, i) => `<a id="${anchors[+i]}"></a>`);

  // Code inline : `code`
  s = s.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');

  // Links [text](url) — on re-parse le text pour bold/italic eventuels.
  // Transforme aussi les liens relatifs vers d'autres articles :
  //   ./NN-slug.md        → /blog/slug
  //   ./slug.md           → /blog/slug
  // Cela permet d'ecrire les .md avec des liens relatifs lisibles sur GitHub
  // tout en servant les bonnes URLs en prod sur le blog.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    let finalHref = href;
    const mdMatch = href.match(/^\.?\/?(?:\d+-)?([a-z0-9-]+)\.md$/i);
    if (mdMatch) {
      finalHref = `/blog/${mdMatch[1]}`;
    }
    const isExt = /^https?:\/\//i.test(finalHref);
    const rel = isExt ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${finalHref}"${rel}>${label}</a>`;
  });

  // Bold **x** (avant italic pour eviter les conflits)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic *x*
  s = s.replace(/(^|[^\w*])\*([^\s*][^*]*?)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');

  return s;
}

// ------------------------------------------------------------
// Slugify un heading pour l'id auto
// ------------------------------------------------------------
function slugify(txt) {
  return txt
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

// ------------------------------------------------------------
// Render principal : prend le body markdown, retourne du HTML
// ------------------------------------------------------------
export function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;

  const headings = []; // pour generer le TOC interne si voulu plus tard

  while (i < lines.length) {
    const line = lines[i];

    // Code block ``` ... ```
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      out.push(`<pre class="code-block"><code class="lang-${escHtml(lang)}">${escHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Hr ---
    if (/^---+\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Headings h1 h2 h3 — on supporte un <a id="..."></a> prefixant le texte
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const level = hm[1].length;
      const inner = hm[2].trim();
      // Extrait un <a id="..."></a> leading eventuel
      const idMatch = inner.match(/^<a\s+id="([a-zA-Z0-9_\-]+)"><\/a>\s*(.*)$/);
      const id = idMatch ? idMatch[1] : slugify(inner.replace(/<[^>]+>/g, ''));
      const text = idMatch ? idMatch[2] : inner;
      const rendered = renderInline(text);
      // Pour la TOC, on nettoie les marqueurs Markdown (**, *, `, [x](y), HTML)
      // sinon on affiche "**legal**" tel quel au lieu de "legal".
      const plainText = text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [label](href) → label
        .replace(/\*\*([^*]+)\*\*/g, '$1')         // **bold** → bold
        .replace(/\*([^*]+)\*/g, '$1')             // *italic* → italic
        .replace(/`([^`]+)`/g, '$1')               // `code` → code
        .replace(/<[^>]+>/g, '')                   // <tag> → ''
        .trim();
      headings.push({ level, id, text: plainText });
      out.push(`<h${level} id="${id}"><a class="heading-anchor" href="#${id}" aria-hidden="true">#</a> ${rendered}</h${level}>`);
      i++;
      continue;
    }

    // Table pipe syntax : | a | b | suivi de | --- | --- |
    if (/^\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
      const headerCells = line.slice(1, -1).split('|').map(c => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) {
        const cells = lines[i].slice(1, -1).split('|').map(c => c.trim());
        rows.push(cells);
        i++;
      }
      const thead = `<thead><tr>${headerCells.map(c => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      // Rendu inline simple de la blockquote (peut contenir bold etc.)
      out.push(`<blockquote>${buf.map(b => renderInline(b)).join('<br>')}</blockquote>`);
      continue;
    }

    // Liste non-ordonnee (-, *, +)
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*[-*+]\s+/, '');
        // Lignes de continuation indentees
        const buf = [item];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          buf.push(lines[i].trim());
          i++;
        }
        items.push(renderInline(buf.join(' ')));
      }
      out.push(`<ul>${items.map(it => `<li>${it}</li>`).join('')}</ul>`);
      continue;
    }

    // Liste ordonnee (1. 2. 3.)
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*\d+\.\s+/, '');
        const buf = [item];
        i++;
        while (i < lines.length && /^\s{3,}\S/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
          buf.push(lines[i].trim());
          i++;
        }
        items.push(renderInline(buf.join(' ')));
      }
      out.push(`<ol>${items.map(it => `<li>${it}</li>`).join('')}</ol>`);
      continue;
    }

    // Ligne vide → separateur de paragraphe
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Paragraphe normal : consomme toutes les lignes non-vides consecutives
    // qui ne sont pas un marker de bloc (heading, liste, table, etc.)
    const pbuf = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\|.+\|\s*$/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i])
    ) {
      pbuf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(pbuf.join(' '))}</p>`);
  }

  return { html: out.join('\n'), headings };
}
