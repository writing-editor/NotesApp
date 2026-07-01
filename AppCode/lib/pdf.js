// lib/pdf.js
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { parseMdPrint } = require('./parse');

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
      .forEach(f => files.push({ rel: path.join(dir, f), full: path.join(d, f) }));
  });
  return files;
}

function buildPrintHtml(meta, files) {
  let chaptersHtml = meta.author
    ? `<div class="book-title-page"><h1>${meta.title}</h1><div class="author">${meta.author}</div></div>`
    : '';

  files.forEach((file) => {
    const { bodyHtml, notes } = parseMdPrint(fs.readFileSync(file.full, 'utf8'));
    chaptersHtml += `
      <div class="chapter-break">
        <div class="chapter-body">${bodyHtml}</div>
        ${notes.length ? `
        <div class="chapter-notes">
          <div class="notes-rule"></div>
          ${notes.map(n => `
            <div class="note-entry">
              <span class="note-num${n.type ? ` type-${n.type}` : ''}">${n.id}</span>
              <span class="note-text">${n.content}</span>
            </div>`).join('')}
        </div>` : ''}
      </div>`;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${meta.title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Crimson+Pro:ital,wght@0,300;0,400;1,300;1,400&family=JetBrains+Mono:wght@300;400&display=swap" rel="stylesheet">
  <style>
    @page { size: 6in 9in; margin: 0.9in 0.85in 0.85in 0.85in; @top-center { content: "${meta.title}"; font-family: 'JetBrains Mono', monospace; font-size: 7pt; letter-spacing: 0.12em; color: #999; text-transform: uppercase; } @bottom-center { content: counter(page); font-family: 'JetBrains Mono', monospace; font-size: 7pt; color: #999; } }
    @page :first { @top-center { content: none; } @bottom-center { content: none; } }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --ink: #1c1a18; --ink-light: #3a3630; --rule: #cdc8be; --accent: #7a3525; }
    html { font-size: 11pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: 'EB Garamond', Georgia, serif; color: var(--ink); line-height: 1.7; background: white; }
    .chapter-break { page-break-after: always; }
    .chapter-break:last-child { page-break-after: avoid; }
    h1 { font-size: 22pt; font-weight: 500; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 0.5in; page-break-after: avoid; }
    h2 { font-size: 14pt; font-weight: 600; font-style: normal; margin: 0.45in 0 0.15in; color: var(--ink); border-bottom: 0.5pt solid var(--rule); padding-bottom: 0.05in; page-break-after: avoid; }
    h3 { font-family: 'JetBrains Mono', monospace; font-size: 6.5pt; font-weight: 400; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); margin: 0.35in 0 0.12in; page-break-after: avoid; }
    p { font-size: 11pt; margin-bottom: 0.13in; text-align: justify; hyphens: auto; orphans: 3; widows: 3; }
    .chapter-body > p:first-of-type::first-letter { font-size: 3em; font-weight: 500; float: left; line-height: 0.82; margin-right: 0.06em; margin-top: 0.07em; color: var(--accent); }
    em { font-style: italic; } strong { font-weight: 600; }
    .mn-marker { font-family: 'JetBrains Mono', monospace; font-size: 6pt; color: var(--accent); vertical-align: super; line-height: 0; }
    .chapter-notes { margin-top: 0.4in; } .notes-rule { width: 1.5in; border-top: 0.5pt solid var(--rule); margin-bottom: 0.18in; }
    .note-entry { display: flex; align-items: flex-start; gap: 0.15in; margin-bottom: 0.1in; }
    .note-num { font-family: 'JetBrains Mono', monospace; font-size: 6.5pt; color: var(--accent); flex-shrink: 0; margin-top: 0.05em; min-width: 0.15in; }
    .note-num.type-query { color: #4a7a9b; } .note-num.type-ref { color: #6a8a3a; } .note-num.type-todo { color: #c47a20; }
    .note-text { font-family: 'Crimson Pro', Georgia, serif; font-size: 9pt; line-height: 1.5; color: var(--ink-light); font-style: italic; }
    .book-title-page { text-align: center; padding-top: 2in; page-break-after: always; }
    .book-title-page h1 { font-size: 28pt; margin-bottom: 0.3in; }
    .book-title-page .author { font-family: 'Crimson Pro', serif; font-size: 13pt; color: var(--ink-light); font-style: italic; }
  </style>
</head>
<body>${chaptersHtml}</body>
</html>`;
}

async function generatePdf(vaultPath) {
  const meta = getMeta(vaultPath);
  const files = getFiles(vaultPath);
  if (!files.length) throw new Error('No markdown files found.');

  const html = buildPrintHtml(meta, files);
  
  // Create temporary files
  const tmpHtml = path.join(os.tmpdir(), `_print_${Date.now()}.html`);
  const tmpPdf  = path.join(os.tmpdir(), `_manuscript_${Date.now()}.pdf`);
  
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const candidates = [
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', 
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const executablePath = candidates.find(c => fs.existsSync(c));
  const launchOpts = { headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] };
  if (executablePath) launchOpts.executablePath = executablePath;

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.goto('file://' + tmpHtml, { waitUntil: 'networkidle0', timeout: 30000 });
  
  // Do NOT pass `format` — let the CSS @page { size: 6in 9in } rule drive the output size.
  // Passing format: 'A4' here overrides the stylesheet and breaks the trade paperback layout.
  await page.pdf({ 
    path: tmpPdf,
    width: '6in',
    height: '9in',
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' } 
  });

  await browser.close();
  fs.unlinkSync(tmpHtml); // Clean up HTML file
  
  return { path: tmpPdf, title: meta.title };
}

module.exports = { generatePdf };