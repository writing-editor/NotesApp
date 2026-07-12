// lib/ai-proxy.js — Stage 3.
//
// Plain function library, called from one inline route in server.js
// (`app.post('/api/ai/chat', ...)`) — NOT an Express router, NOT mounted
// via app.use(). This mirrors lib/git-Sync.js's actual shape, not the
// router-mount shape an earlier plan revision assumed. See
// AppCode/CONTEXT.md §6 for the corrected write-up.
//
// Responsibility of this module, end to end:
//   1. Take { provider, model, apiKey, ollamaUrl, systemPrompt, chapterText }
//      from the request body (see server.js's /api/ai/chat handler).
//   2. Dispatch to the right provider adapter (callClaude/callOpenAI/
//      callGemini/callOllama), each of which prompts the model to return
//      ONLY a JSON array of note placements and nothing else. The model is
//      never asked for a raw character offset — chapterText is pre-split
//      into paragraphs (lib/paragraphs.js) and numbered before it's shown
//      to the model, which only ever names a paragraph ID ("P3") it
//      recognizes from that numbering. See buildPrompt()'s comment below
//      for why (models can't reliably count characters; they can
//      recognize which paragraph they're looking at).
//   3. Parse + validate the model's raw text response — { paragraphId,
//      content } entries — resolving each paragraphId to that paragraph's
//      real, exact charPos (a lookup, not a guess) so the final placement
//      shape handed back is still { charPos, content }, unchanged for
//      every downstream consumer (noteSplice.js, agentRunner.js). Includes
//      a pre-write invariant check: a resolved charPos that would land
//      inside an existing `[mn.*: ...]` note's marker span is rejected
//      outright (not clamped), since clamping there has no safe
//      destination — see resolveParagraphPlacements()'s comment below.
//   4. Return { ok: true, placements, rejected } or { ok: false, error }.
//      `rejected` is the count of placements dropped by the §3 check above
//      (0 when nothing was dropped) — server.js's route passes it straight
//      through, agentRunner.js folds it into the run summary. Never throws
//      out of `chat()` itself — server.js's route handler still wraps the
//      call in try/catch as a second line of defense, same convention as
//      every other route in server.js.
//
// Key handling: request-scoped only, exactly like the git PAT today (see
// CONTEXT.md §6) — the key arrives in the POST body per-request, is used
// for that request's provider call(s), and is never written to disk or
// logged. This module holds no state between calls.
//
// No new dependencies. Node 22 (see package.json) has global fetch, so
// none of node-fetch/axios/provider SDKs are needed — matches git-Sync.js's
// existing preference for isomorphic-git over shelling out, i.e. keep the
// dependency surface as small as the job allows.

'use strict';

const { splitIntoParagraphs } = require('./paragraphs');

// ── §3 hallucination-protection: pre-write invariant check ──────────────────
//
// Finds every existing `[mn...: ...]` note marker's [start, end) span in a
// chunk of raw text, so resolveParagraphPlacements() below can reject (not clamp) any
// model-proposed charPos that would land *inside* one of those spans — which
// would otherwise silently split an existing note's marker in half when the
// insertion happens (both spliceNotes()'s insertNoteAt() and
// spliceIntoRawText() are plain string/position inserts; neither one knows or
// cares whether the position it's given sits inside another marker).
//
// Deliberately a small standalone scanner using the same marker shape
// lib/parse.js's MN_RE matches, rather than importing parseMd() itself —
// parseMd() returns per-note charPos but not each match's *length*, and its
// output shape (HTML + segment spans) is tuned for the browser-render path,
// not for "give me every existing marker's span." Keeping this local avoids
// changing parseMd()'s return shape for a second consumer with different
// needs; the two are kept in sync by using the identical regex literal.
const MN_MARKER_RE = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;

// Separate literal (same pattern as MN_MARKER_RE, no shared lastIndex
// state) used only to strip markers out of the text shown to the model —
// see buildPrompt()'s displayText() below. Kept distinct from
// MN_MARKER_RE/findExistingNoteSpans, which manually drive `exec()` in a
// loop and rely on that regex's own `.lastIndex`; `String.replace()` with a
// `/g` regex resets lastIndex itself each call, but giving stripping its
// own literal avoids any risk of the two use sites interfering if either
// one's calling convention changes later.
const MN_MARKER_RE_G = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;

function findExistingNoteSpans(text) {
  const spans = [];
  if (typeof text !== 'string' || !text) return spans;
  const re = new RegExp(MN_MARKER_RE.source, MN_MARKER_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

// True if `pos` falls strictly inside an existing marker's span (not at its
// exact boundaries — inserting exactly at a span's start or end is fine,
// since that's "before" or "after" the existing note, not "through" it).
function landsInsideExistingNote(pos, spans) {
  for (const { start, end } of spans) {
    if (pos > start && pos < end) return true;
  }
  return false;
}

// ── Shared placement-parsing step ───────────────────────────────────────────
//
// Every provider is prompted to return ONLY a JSON array like:
//   [{ "paragraphId": "P3", "content": "note text" }, ...]
// Models are unreliable about "ONLY" (code fences, leading prose, trailing
// commentary), so this strips the common wrapping before JSON.parse rather
// than trusting the raw string. Anything that still doesn't parse, isn't an
// array, or has entries missing either field is dropped — a partially-bad
// response degrades to fewer notes, not a hard failure for the whole run.
function extractJsonArray(rawText) {
  if (typeof rawText !== 'string') return [];
  let text = rawText.trim();

  // Strip a ```json ... ``` or ``` ... ``` fence if the model wrapped one.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  // If there's still leading/trailing prose around the array, take the
  // outermost [ ... ] span rather than requiring the whole string to
  // parse cleanly.
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  const candidate = text.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

// Validates raw placements against the actual paragraph list — NOT against
// a raw character offset the model invented. The model is never asked for
// charPos at all (see buildPrompt() below): it's shown text pre-split and
// numbered into paragraphs ("[P1] ...", "[P2] ...") and asked only to name
// which paragraph a note belongs to. This function's whole job is turning
// that paragraphId back into the one real, exact charPos the code already
// knows for that paragraph — a string-index lookup, not a guess — so a
// note anchored to "paragraph 4" always lands at the actual start of
// paragraph 4, never mid-word or in a neighboring paragraph.
//
// - paragraphId must match one of `paragraphs`' ids (as produced by
//   splitIntoParagraphs()) exactly. Anything else (missing, misspelled,
//   an id past the end of the text) is dropped — there's no reasonable
//   position to clamp a bad id to, unlike the old charPos scheme where an
//   off-by-a-little number could still be clamped safely.
// - content must be a non-empty string after trimming.
// - At most ONE placement per paragraph is kept — the prompt asks for this,
//   but a model that ignores it and returns two entries for the same
//   paragraph shouldn't produce two overlapping notes; the first one in
//   the model's own returned order wins and later duplicates for that same
//   paragraphId are dropped.
// - §3 stricter check, unchanged in spirit from before: a resolved charPos
//   landing *inside* an existing `[mn.*: ...]` marker's span is REJECTED,
//   not clamped — there's no nearby "correct" position to clamp to that
//   isn't itself a guess. This is now rare (paragraph starts essentially
//   never sit inside a note marker) but kept as a backstop for the
//   rare paragraph whose very first character was itself where a prior
//   run inserted a note.
// - This function never throws.
function resolveParagraphPlacements(rawPlacements, paragraphs, existingSpans) {
  const spans = Array.isArray(existingSpans) ? existingSpans : [];
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  const seenIds = new Set();
  const out = [];
  let rejected = 0;
  for (const p of rawPlacements) {
    if (!p || typeof p !== 'object') continue;
    const content = typeof p.content === 'string' ? p.content.trim() : '';
    if (!content) continue;
    const paragraphId = typeof p.paragraphId === 'string' ? p.paragraphId.trim() : '';
    const paragraph = byId.get(paragraphId);
    if (!paragraph) continue; // unknown/malformed id — nothing safe to clamp to
    if (seenIds.has(paragraphId)) continue; // one note per paragraph, first wins
    const charPos = paragraph.start;
    if (landsInsideExistingNote(charPos, spans)) {
      rejected++;
      continue;
    }
    seenIds.add(paragraphId);
    out.push({ charPos, content });
  }
  return { placements: out, rejected };
}

// Builds the instruction wrapper common to every provider — the per-provider
// adapters differ only in how they get this text to the model and back.
//
// Deliberately says "text" throughout, not "chapter" — this same wrapper
// runs for a whole chapter (chapter scope), a single highlighted paragraph
// or two (selection scope), and every file in the vault in turn (all
// scope), and the vault itself isn't always fiction (see e.g. Copyedit.md,
// written for treaty/legal text). "Chapter" would be actively wrong for a
// selection or a non-fiction document; "text" is accurate for all of them.
//
// ── Why paragraphs, not characters ──────────────────────────────────────
// This used to ask the model for a raw character offset ("each character
// position numbered from 0... charPos must be an integer offset"). That
// doesn't work: models don't reliably count characters over a document of
// any real length, so the offsets they returned were routinely off —
// landing mid-word, in the wrong sentence, sometimes in the wrong
// paragraph entirely. The model was being asked to do coordinate
// arithmetic it can't do accurately, and every downstream placement bug
// traced back to trusting that number.
//
// Instead, splitIntoParagraphs() (lib/paragraphs.js) segments the text
// server-side first, and the model is only ever asked to name a
// paragraph's ID ("P1", "P2", ...) it already sees printed next to that
// paragraph in the prompt — recognizing which block of text it's talking
// about, not counting characters. resolveParagraphPlacements() then looks
// up that id's exact, real start offset — a deterministic string lookup
// the code already has, not a guess. This also naturally bounds each note
// to "the issues in this one paragraph," which is what pushes the model
// toward one substantive note per paragraph instead of a separate tiny
// note per word-level nitpick — the old failure mode where notes were
// individually so small they read as clutter came from the same
// character-counting framing as the misplacement bug, not a separate
// problem with a separate fix.
function buildPrompt({ systemPrompt, chapterText }) {
  const paragraphs = splitIntoParagraphs(chapterText);

  // Strip existing `[mn: ...]` / `[mn.type: ...]` note markers out of the
  // text shown to the model entirely, rather than leaving them in and
  // relying on an instruction to ignore them. This is stronger than an
  // instruction: the model literally never sees them, so it can't quote,
  // reference, second-guess, or nest a new note around one — the class of
  // bug where a returned note ends up wrapping or duplicating an existing
  // marker traced back to the marker being present in the model's input at
  // all, not to the model failing to follow a "please disregard" rule.
  //
  // This only changes what's DISPLAYED to the model (`p.text` below, used
  // to build `numberedText`) — it must NOT touch `paragraphs` itself.
  // `paragraphs[].start`/`.end` are real byte offsets into the actual,
  // unmodified chapterText, and resolveParagraphPlacements() below looks
  // up a returned paragraphId's charPos from those same untouched offsets.
  // If markers were stripped from chapterText before splitIntoParagraphs()
  // ran, every offset after the first stripped marker would shift left of
  // where that text actually sits in the real document, and every note
  // placed by paragraph id after that point would land in the wrong spot.
  // Stripping only the display copy, per-paragraph, keeps the offsets the
  // rest of the pipeline depends on completely unaffected.
  const displayText = (text) => text.replace(MN_MARKER_RE_G, '').trim();
  const numberedText = paragraphs
    .map((p) => ({ id: p.id, text: displayText(p.text) }))
    .filter((p) => p.text) // a paragraph that was ONLY a note marker strips to empty — omit it rather than showing the model a pointless empty [Pn] tag it could still (uselessly) try to flag
    .map((p) => `[${p.id}] ${p.text}`)
    .join('\n\n');

  const instructions = [
    'You are an editorial assistant annotating a document with margin',
    'notes. The text below has already been split into paragraphs for you',
    'and each one is tagged with its ID in square brackets, e.g. "[P3]"',
    'immediately before that paragraph\'s text. These IDs are the ONLY way',
    'you place a note \u2014 you never count characters or estimate a position',
    'yourself.',
    '',
    'Decide which paragraphs need a note and what each should say. Respond',
    'with ONLY a JSON array, no prose before or after it, no markdown code',
    'fence, in exactly this shape:',
    '[{"paragraphId": "<the P-number of the paragraph, exactly as tagged, e.g. \\"P3\\">", "content": "<note text>"}]',
    '',
    'Rules:',
    '- paragraphId must be copied exactly from one of the "[Pn]" tags shown',
    '  \u2014 do not invent an id, and do not try to point at a specific word,',
    '  sentence, or character within the paragraph; a note always applies',
    '  to the whole paragraph it is tagged with.',
    '- At most ONE note per paragraph. If a paragraph has more than one',
    '  issue worth flagging, combine them into that paragraph\'s single note',
    '  (e.g. as short clauses or a semicolon-separated list) rather than',
    '  returning two entries with the same paragraphId.',
    '- If an issue involves more than one paragraph (e.g. two clauses that',
    '  contradict each other), anchor the note at whichever of those',
    '  paragraphs appears FIRST in the text, and mention the other by its',
    '  paragraph ID or a short quote so it is easy to find \u2014 do not return',
    '  a second entry for the other paragraph just to cross-reference it.',
    '- Return an empty array [] if no notes are warranted.',
    '- Do not include any text outside the JSON array.',
    '',
    'Density \u2014 this is the most important rule and overrides your own sense',
    'of thoroughness:',
    '- Do not flag every paragraph. A margin note next to every paragraph is',
    '  not useful to the person reading it \u2014 it is clutter they have to read',
    '  past. Most paragraphs in a clean text should get no note at all.',
    '- Only flag a paragraph if fixing what you\'d note would meaningfully',
    '  improve the text. If you are unsure whether an issue is worth a note,',
    '  leave it unflagged.',
    '- If the same kind of issue (e.g. a repeated crutch word) occurs in',
    '  many paragraphs, do not give each one its own note. Note it once, on',
    '  its first or most representative paragraph, and cite the OTHER',
    '  paragraph IDs where it recurs by their actual "Pn" tags, not a vague',
    '  count (e.g. "\'suddenly\' also appears in P7, P12, and P19" \u2014 not',
    '  "appears 6 times in this text").',
    '- Use British spelling and punctuation conventions (e.g. "colour", "centre", "realise", Oxford commas, etc.)', 
    '  unless the text is clearly written in American English, in which case use American conventions.',
  ].join('\n');

  const behaviour = (systemPrompt || '').trim();
  const fullSystem = behaviour
    ? `${instructions}\n\nAdditional instructions from the user for this agent:\n${behaviour}`
    : instructions;

  const userMessage = `Text (paragraph IDs shown in [brackets]):\n\n${numberedText}`;

  return { fullSystem, userMessage, paragraphs };
}

// ── Provider adapters ───────────────────────────────────────────────────────
// Each returns the model's raw text response (or throws with a message
// suitable to surface to the UI). chat() below does the JSON extraction /
// placement resolution once, in common, after any adapter returns.

async function callClaude({ apiKey, model, fullSystem, userMessage }) {
  if (!apiKey) throw new Error('Missing API key for Claude');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: fullSystem,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `Claude API error (${resp.status})`);
  }
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

async function callOpenAI({ apiKey, model, fullSystem, userMessage }) {
  if (!apiKey) throw new Error('Missing API key for OpenAI');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: fullSystem },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `OpenAI API error (${resp.status})`);
  }
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

async function callGemini({ apiKey, model, fullSystem, userMessage }) {
  if (!apiKey) throw new Error('Missing API key for Gemini');
  const modelName = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: fullSystem }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `Gemini API error (${resp.status})`);
  }
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  return (parts && parts.map(p => p.text || '').join('')) || '';
}

async function callOllama({ model, ollamaUrl, fullSystem, userMessage }) {
  const base = (ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const resp = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'llama3',
      stream: false,
      messages: [
        { role: 'system', content: fullSystem },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error || ''; } catch { /* ignore */ }
    throw new Error(detail || `Ollama request failed (${resp.status}) — is it running at ${base}?`);
  }
  const data = await resp.json();
  return (data.message && data.message.content) || '';
}

const ADAPTERS = {
  claude: callClaude,
  openai: callOpenAI,
  gemini: callGemini,
  ollama: callOllama,
};

// ── Public entry point ──────────────────────────────────────────────────────
//
// server.js calls this once per /api/ai/chat request:
//   const result = await aiProxy.chat({ provider, model, apiKey, ollamaUrl,
//                                        systemPrompt, chapterText });
//
// Always resolves (never rejects) with either:
//   { ok: true, placements: [{ charPos, content }, ...], rejected: <number> }
//   { ok: false, error: '<message safe to show in the settings panel>' }
// Hard backstop behind the prompt's own density guidance (see buildPrompt's
// "Density" rule) — a small/local model in particular may ignore a prompt
// instruction it was given and return a note for nearly every sentence
// anyway. Rather than trusting the prompt alone, cap the *actual* placement
// count server-side at roughly one note per MIN_WORDS_PER_NOTE words of
// chapter text, keeping placements spread across the chapter rather than
// e.g. only the first N in document order (which would silently blind the
// run to anything past the cap if the model happened to front-load its
// notes). Picks by evenly sampling across the sorted list, not by any
// judgment of which note is "better" — this function has no way to know
// that, only resolveParagraphPlacements' upstream content/position checks do.
const MIN_WORDS_PER_NOTE = 50; // stricter than the prompt's own "~1 per 5-8 paragraphs" suggestion, since this is the hard ceiling, not the target
function capPlacementDensity(placements, chapterText) {
  const wordCount = (chapterText || '').trim().split(/\s+/).filter(Boolean).length;
  const maxNotes = Math.max(3, Math.ceil(wordCount / MIN_WORDS_PER_NOTE));
  if (placements.length <= maxNotes) return { kept: placements, capped: 0 };

  const sorted = [...placements].sort((a, b) => a.charPos - b.charPos);
  const step = sorted.length / maxNotes;
  const kept = [];
  for (let i = 0; i < maxNotes; i++) {
    kept.push(sorted[Math.floor(i * step)]);
  }
  return { kept, capped: sorted.length - kept.length };
}

async function chat({ provider, model, apiKey, ollamaUrl, systemPrompt, chapterText }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    return { ok: false, error: `Unknown provider: ${provider}` };
  }
  if (typeof chapterText !== 'string' || !chapterText.trim()) {
    return { ok: false, error: 'No text provided' };
  }

  const { fullSystem, userMessage, paragraphs } = buildPrompt({ systemPrompt, chapterText });

  let rawText;
  try {
    rawText = await adapter({ apiKey, model, ollamaUrl, fullSystem, userMessage });
  } catch (e) {
    return { ok: false, error: e.message || 'Request to model provider failed' };
  }

  const rawPlacements = extractJsonArray(rawText);
  const existingSpans = findExistingNoteSpans(chapterText);
  const { placements: resolved, rejected } = resolveParagraphPlacements(rawPlacements, paragraphs, existingSpans);
  const { kept: placements, capped } = capPlacementDensity(resolved, chapterText);

  // Surfaced but non-fatal: a run that rejected or capped placements still
  // returns ok:true with whatever's left — see agentRunner.js/
  // settingsPanel.js for how `rejected`/`capped` are folded into the run
  // summary rather than treated as an error. A capped run isn't a bug catch
  // the way a rejected one is (that's the model returning something bad);
  // it's this function trimming an over-eager but individually valid
  // response back down to something a person can actually work with.
  return { ok: true, placements, rejected, capped };
}

module.exports = {
  chat,
  // Exported for unit testing only — server.js only ever calls chat().
  _extractJsonArray: extractJsonArray,
  _resolveParagraphPlacements: resolveParagraphPlacements,
  _findExistingNoteSpans: findExistingNoteSpans,
  _capPlacementDensity: capPlacementDensity,
  _splitIntoParagraphs: splitIntoParagraphs,
};