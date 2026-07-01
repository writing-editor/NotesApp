// lib/parse.js — shared markdown parser for server.js and pdf.js
//
// Two modes:
//   parseMd(raw)              → full parse with position-encoded segment spans (for browser)
//   parseMdPrint(raw)         → lightweight parse for PDF (no segment spans, just endnotes)

'use strict';

const { marked } = require('marked');

const MN_RE = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;

// ── Shared inline renderer ────────────────────────────────────────────────────
function inlineMarkdown(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/gs,     '<em>$1</em>')
    .replace(/~~(.+?)~~/gs,     '<del>$1</del>')
    .replace(/_(.+?)_/gs,       '<em>$1</em>');
}

// ── Note type → CSS class map ─────────────────────────────────────────────────
const NOTE_TYPE_CLASS = {
  query: 'mn-type-query',
  ref:   'mn-type-ref',
  todo:  'mn-type-todo',
};

// ── List block detector (avoids false positives on lines starting with digits) ─
function isListBlock(text) {
  return /^(\s*[-*]|\s*\d+\.)\s/.test(text);
}

// ── Full parse (server — includes segment spans for write-back) ───────────────
function parseMd(raw) {
  const notes = [];
  let   noteIndex = 0;

  // Use the offset argument of replace() directly — no need for a separate pre-scan.
  const withPlaceholders = raw.replace(MN_RE, (full, type, content, offset) => {
    noteIndex++;
    const id = noteIndex;
    notes.push({ id, content: content.trim(), type: type || null, charPos: offset });
    const marker = `\x00MN${id}\x00`;
    return marker.padEnd(full.length, '\x01');
  });

  // Build blocks (consecutive non-empty lines)
  const blocks = [];
  let current = [];
  let charPos  = 0;

  withPlaceholders.split('\n').forEach(line => {
    if (line.trim() === '') {
      if (current.length) {
        blocks.push({
          lines:     current,
          startChar: charPos - current.reduce((a, l) => a + l.length + 1, 0),
        });
        current = [];
      }
      charPos += line.length + 1;
    } else {
      current.push(line);
      charPos += line.length + 1;
    }
  });
  if (current.length) {
    blocks.push({
      lines:     current,
      startChar: charPos - current.reduce((a, l) => a + l.length + 1, 0),
    });
  }

  let bodyHtml = '';

  blocks.forEach(block => {
    const blockText = block.lines.join('\n');
    const isHeading  = /^#{1,6}\s/.test(blockText);
    const isList     = isListBlock(blockText);
    const isBlockquote = /^>\s/.test(blockText);
    const isCodeFence  = /^```/.test(blockText);

    if (isHeading || isList || isBlockquote || isCodeFence) {
      const restored = blockText.replace(/\x00MN(\d+)\x00/g, (_, id) => {
        const note      = notes.find(n => n.id === Number(id));
        const typeClass = note?.type ? ` ${NOTE_TYPE_CLASS[note.type] || ''}` : '';
        return `<span class="mn-anchor${typeClass}" data-note-id="${id}"><sup class="mn-marker">${id}</sup></span>`;
      });
      bodyHtml += marked.parse(restored) + '\n';
      return;
    }

    const parts  = blockText.split(/(\x00MN\d+\x00\x01*)/);
    let   segIdx = 0;
    let   segOff = 0;
    let   inner  = '';

    parts.forEach(part => {
      const mnMatch = part.match(/^\x00MN(\d+)\x00\x01*$/);
      if (mnMatch) {
        const id        = mnMatch[1];
        const note      = notes.find(n => n.id === Number(id));
        const typeClass = note?.type ? ` ${NOTE_TYPE_CLASS[note.type] || ''}` : '';
        inner  += `<span class="mn-anchor${typeClass}" data-note-id="${id}"><sup class="mn-marker">${id}</sup></span>`;
        segOff += part.length;
      } else if (part.length > 0) {
        inner  += `<span class="txt-seg" data-block="${block.startChar}" data-off="${segOff}" data-seg="${segIdx}">${inlineMarkdown(part)}</span>`;
        segOff += part.length;
        segIdx++;
      }
    });

    bodyHtml += `<p data-block="${block.startChar}">${inner}</p>\n`;
  });

  return { bodyHtml, notes };
}

// ── Print parse (pdf.js — no segment spans needed) ───────────────────────────
function parseMdPrint(raw) {
  const notes = [];
  let   noteIndex = 0;

  const withPlaceholders = raw.replace(MN_RE, (full, type, content) => {
    noteIndex++;
    notes.push({ id: noteIndex, content: content.trim(), type: type || null });
    return `\x00MN${noteIndex}\x00`;
  });

  const blocks = [];
  let current = [];
  withPlaceholders.split('\n').forEach(line => {
    if (line.trim() === '') {
      if (current.length) { blocks.push(current.join('\n')); current = []; }
    } else { current.push(line); }
  });
  if (current.length) blocks.push(current.join('\n'));

  let bodyHtml = '';
  blocks.forEach(block => {
    const isHeading    = /^#{1,6}\s/.test(block);
    const isList       = isListBlock(block);
    const isBlockquote = /^>\s/.test(block);
    const isCodeFence  = /^```/.test(block);

    if (isHeading || isList || isBlockquote || isCodeFence) {
      const restored = block.replace(/\x00MN(\d+)\x00/g, (_, id) =>
        `<sup class="mn-marker">${id}</sup>`);
      bodyHtml += marked.parse(restored) + '\n';
      return;
    }

    const parts = block.split(/(\x00MN\d+\x00)/);
    let inner = '';
    parts.forEach(part => {
      const mn = part.match(/^\x00MN(\d+)\x00$/);
      if (mn) {
        inner += `<sup class="mn-marker">${mn[1]}</sup>`;
      } else if (part.length > 0) {
        inner += inlineMarkdown(part);
      }
    });
    bodyHtml += `<p>${inner}</p>\n`;
  });

  return { bodyHtml, notes };
}

// ── Word / character count ────────────────────────────────────────────────────
function countWords(raw) {
  const stripped = raw
    .replace(MN_RE, '')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
  const words = stripped.split(/\s+/).filter(Boolean).length;
  const chars = stripped.replace(/\s/g, '').length;
  return { words, chars };
}

module.exports = { parseMd, parseMdPrint, countWords };