// lib/typst.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

// Cheap, cached check for whether the `typst` binary is on PATH at all — this is
// the actual detection mechanism generatePdf() relies on (via spawnSync below),
// exposed here so server.js's /api/export/pdf route can guard *before* doing any
// metadata/markdown work, rather than discovering the failure after building the
// whole Typst source document (Section 6.5 of the mobile sync plan: neither typst
// nor puppeteer is expected to be available inside the embedded mobile Node
// runtime, and this lets the route fail fast with a clear message instead of
// wasting work — and leaving stray .typ temp files behind — on every mobile call).
let _typstAvailable = null;
function isTypstAvailable() {
  if (_typstAvailable !== null) return _typstAvailable;
  try {
    const result = spawnSync('typst', ['--version'], { timeout: 5000 });
    _typstAvailable = !result.error && result.status === 0;
  } catch {
    _typstAvailable = false;
  }
  return _typstAvailable;
}

function getMeta(vaultPath) {
  let title = 'Manuscript';
  let author = '';
  const metaPath = path.join(vaultPath, '_meta.md');
  
  if (fs.existsSync(metaPath)) {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const yamlMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (yamlMatch) {
      const block = yamlMatch[1];
      const get = key => { const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
      title  = get('title')  || title;
      author = get('author') || '';
    } else {
      title = raw.split('\n')[0].replace(/^#+\s*/, '').trim() || title;
      author = (raw.split('\n').find(l => l.startsWith('author:')) || '').replace('author:', '').trim();
    }
  }
  return { title, author };
}

function getFiles(vaultPath) {
  const files = [];
  ['front', 'chapters', 'back'].forEach(dir => {
    const d = path.join(vaultPath, dir);
    if (!fs.existsSync(d)) return;
    
    fs.readdirSync(d)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .sort()
      .forEach(f => files.push({ dir, rel: path.join(dir, f), full: path.join(d, f) }));
  });
  return files;
}

function parseToTypst(md, isChapterFile) {
  // 0. Convert Markdown lists (* Item) to Typst lists (- Item) BEFORE bold/italic parsing.
  // This completely removes the list asterisks so they can never bleed into italics!
  // It supports indented sub-lists natively as well.
  md = md.replace(/^(\s*)\*\s+(.*)$/gm, '$1- $2');
  md = md.replace(/^(\s*)-\s+(.*)$/gm, '$1- $2');

  // 1. Convert valid Markdown syntax using ReDoS-proof negated character classes.
  md = md.replace(/^###\s+(.*)$/gm, 'PHHTHREE$1');
  md = md.replace(/^##\s+(.*)$/gm, 'PHHTWO$1');
  md = md.replace(/^#\s+(.*)$/gm, 'PHHONE$1');
  
  md = md.replace(/\[mn(?:\.([a-z]+))?\s*:\s*([^\]]+)\]/g, (m, type, content) => {
    return `PHMNSTART${type || 'none'}PHMNSEP${content}PHMNEND`;
  });

  md = md.replace(/\*\*([^\*]+)\*\*/g, 'PHB$1PHBEND');
  md = md.replace(/__([^_]+)__/g, 'PHB$1PHBEND');
  
  md = md.replace(/\*([^\*]+)\*/g, 'PHI$1PHIEND');
  md = md.replace(/_([^_]+)_/g, 'PHI$1PHIEND');

  // 2. Escape actual stray symbols to prevent Typst syntax errors
  md = md.replace(/\\/g, '\\\\'); 
  md = md.replace(/([$@#*_\[\]`])/g, '\\$1');

  // 3. Restore placeholders into native Typst Functions
  md = md.replace(/PHHTHREE([^\n]*)/g, '=== $1');
  md = md.replace(/PHHTWO([^\n]*)/g, '== $1');
  md = md.replace(/PHHONE([^\n]*)/g, '= $1');

  md = md.replace(/PHMNSTART([a-z]+)PHMNSEP([\s\S]*?)PHMNEND/g, '#mn("$1")[$2]');
  md = md.replace(/PHB([\s\S]*?)PHBEND/g, '#strong[$1]');
  md = md.replace(/PHI([\s\S]*?)PHIEND/g, '#emph[$1]');

  md = md.replace(/\]([\(\[\{])/g, ']\\$1');

  // 4. Inject Drop Cap
  if (isChapterFile) {
    let blocks = md.split(/\n{2,}/);
    for (let i = 0; i < blocks.length; i++) {
      let block = blocks[i].trim();
      if (block && !block.startsWith('=')) {
        let match = block.match(/^(\\.|.)/);
        if (match) {
          let firstChar = match[1];
          let rest = block.slice(firstChar.length);
          blocks[i] = `#local-dropcap[${firstChar}]${rest}`;
        }
        break; 
      }
    }
    md = blocks.join('\n\n');
  }

  return md;
}

function buildTypstDoc(meta, files) {
  const compiledChapters = files.map(file => {
    const raw = fs.readFileSync(file.full, 'utf8');
    return parseToTypst(raw, file.dir === 'chapters');
  });

  // Sanitize quotes in metadata to prevent Typst compiler crashes
  const safeTitle = meta.title.replace(/"/g, '\\"');
  const safeAuthor = meta.author.replace(/"/g, '\\"');

  return `
#let c-ink = rgb("#1c1a18")
#let c-ink-light = rgb("#3a3630")
#let c-accent = rgb("#7a3525")
#let c-query = rgb("#4a7a9b")
#let c-ref = rgb("#6a8a3a")
#let c-todo = rgb("#c47a20")

// Native Offline Drop Cap Alternative
#let local-dropcap(letter) = box(height: 1em, baseline: 15%)[
  #text(size: 2.8em, fill: c-accent, weight: "medium")[#letter]
] + h(0.05em)

#let f-body = ("EB Garamond", "Georgia", "Linux Libertine", "Libertinus Serif")
#let f-sans = ("JetBrains Mono", "Courier New", "DejaVu Sans Mono", "New Computer Modern Sans")
#let f-note = ("Crimson Pro", "Georgia", "Linux Libertine", "Libertinus Serif")

#set document(title: "${safeTitle}", author: "${safeAuthor}")
#set page(
  paper: "us-trade",
  margin: (top: 0.9in, bottom: 0.85in, left: 0.85in, right: 0.85in),
  header: context {
    let pageNum = here().page()
    let headings = query(heading.where(level: 1))
    let is-chapter-start = headings.any(h => h.location().page() == pageNum)
    if pageNum == 1 or is-chapter-start { return none }
    set text(font: f-sans, size: 7pt, tracking: 0.12em, fill: luma(150))
    if calc.odd(pageNum) { align(right, upper("${safeTitle}")) } 
    else { align(left, upper("${safeAuthor}")) }
  },
  footer: context {
    let pageNum = here().page()
    let headings = query(heading.where(level: 1))
    let is-chapter-start = headings.any(h => h.location().page() == pageNum)
    if pageNum == 1 or is-chapter-start { return none }
    set text(font: f-sans, size: 7pt, fill: luma(150))
    align(center)[#counter(page).display()]
  }
)

#set text(font: f-body, size: 11pt, fill: c-ink)
#set par(justify: true, leading: 0.65em, spacing: 0.13in)

#show heading: it => {
  set text(fill: c-ink, weight: 600)
  set block(above: 1.5em, below: 1em)
  it
}
#show heading.where(level: 1): it => {
  set text(size: 22pt, weight: 500)
  set block(above: 0in, below: 0.5in)
  it
}

#let mn(type, content) = {
  let c = c-accent
  if type == "query" { c = c-query }
  else if type == "ref" { c = c-ref }
  else if type == "todo" { c = c-todo }
  footnote[
    #set text(font: f-note, size: 9pt, fill: c-ink-light, style: "italic")
    #content
  ]
}

#if "${safeTitle}" != "" {
  align(center + horizon)[
    #text(size: 28pt, weight: 500, "${safeTitle}")
    #v(0.3in)
    #text(font: f-note, size: 13pt, fill: c-ink-light, style: "italic", "${safeAuthor}")
  ]
  pagebreak()
}

${compiledChapters.join('\n\n#pagebreak()\n\n')}
`;
}

// NOTE: This function mimics the exact behavior of the old pdf.js `generatePdf`
async function generatePdf(vaultPath) {
  console.log("\n[Typst PDF] 🚀 Starting compilation process...");

  if (!isTypstAvailable()) {
    throw new Error('Typst is not installed on this machine. PDF export requires the `typst` binary on PATH.');
  }
  
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawnSync } = require('child_process');

  console.log("[Typst PDF] 1. Reading metadata (_meta.md)...");
  const meta = getMeta(vaultPath);
  console.log("[Typst PDF]    Metadata loaded:", meta.title, "by", meta.author);

  console.log("[Typst PDF] 2. Locating chapter files...");
  const files = getFiles(vaultPath);
  console.log("[Typst PDF]    Found", files.length, "markdown files.");

  console.log("[Typst PDF] 3. Building Typst source document (parsing markdown)...");
  const typstSource = buildTypstDoc(meta, files);
  console.log("[Typst PDF]    Source document successfully constructed.");

  // We write the temp files to the system temporary directory (/tmp)
  // Since Typst is now native, it has full permissions here, 
  // and no file watchers will ever see these files!
  const tmpTyp = path.join(os.tmpdir(), `_print_${Date.now()}.typ`);
  const tmpPdf = path.join(os.tmpdir(), `_manuscript_${Date.now()}.pdf`);
  
  console.log("[Typst PDF] 4. Writing temporary file to:", tmpTyp);
  fs.writeFileSync(tmpTyp, typstSource, 'utf8');

  // We point Typst to a "fonts" folder inside your AppCode directory
  const fontDir = path.join(__dirname, '..', 'fonts');
  
  // Build arguments cleanly for direct binary execution
  const args = ['compile'];
  if (fs.existsSync(fontDir)) {
    args.push('--font-path', fontDir);
  }
  args.push(tmpTyp, tmpPdf);

  console.log("[Typst PDF] 5. Running Typst binary command: typst", args.join(' '));
  const result = spawnSync('typst', args, { timeout: 15000 });
  console.log("[Typst PDF] 6. Typst compiler finished. Exit status:", result.status);

  // Check if process failed or timed out
  if (result.error || result.status !== 0) {
    const errorMsg = result.stderr ? result.stderr.toString() : (result.error ? result.error.message : 'Unknown compilation error');
    console.error("\n=== TYPST COMPILATION ERROR ===");
    console.error(errorMsg);
    console.error("===============================\n");
    
    // Save copy for debugging
    const debugFile = path.join(process.cwd(), 'debug_failed.typ');
    fs.writeFileSync(debugFile, typstSource, 'utf8');
    
    if (fs.existsSync(tmpTyp)) fs.unlinkSync(tmpTyp);
    throw new Error("Typst compilation failed. See server console for details.");
  }

  // Cleanup the temporary source file on success
  if (fs.existsSync(tmpTyp)) fs.unlinkSync(tmpTyp); 
  console.log("[Typst PDF] 7. 🎉 PDF generated successfully! Path:", tmpPdf);
  
  return { path: tmpPdf, title: meta.title };
}

module.exports = { generatePdf, isTypstAvailable };