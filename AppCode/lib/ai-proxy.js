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
//      ONLY a JSON array of note placements and nothing else.
//   3. Parse + validate the model's raw text response into placements of
//      the shape { charPos, content }, resolving against chapterText so a
//      bad/out-of-range offset from the model can't corrupt the document.
//      Includes plan.md §3's pre-write invariant check: a placement whose
//      charPos would land inside an existing `[mn.*: ...]` note's marker
//      span is rejected outright (not clamped), since clamping there has no
//      safe destination — see resolvePlacements()'s comment below.
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

// ── §3 hallucination-protection: pre-write invariant check ──────────────────
//
// Finds every existing `[mn...: ...]` note marker's [start, end) span in a
// chunk of raw text, so resolvePlacements() below can reject (not clamp) any
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
//   [{ "charPos": 1234, "content": "note text" }, ...]
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

// Validates raw placements against the actual chapter text.
// - charPos must be a finite number; out-of-range values are clamped into
//   [0, chapterText.length] rather than rejected outright, since an
//   off-by-a-little offset (e.g. the model counting a trailing newline
//   differently) shouldn't lose an otherwise-good note — insertNoteAt() on
//   the client just inserts at a document position, so a clamped position
//   is still safe, just possibly a character or two off.
// - content must be a non-empty string after trimming.
// - §3 stricter check: a charPos landing *inside* an existing `[mn.*: ...]`
//   marker's span is REJECTED, not clamped — clamping there would move the
//   insertion to a span boundary silently, which either merges into an
//   adjacent note's text or (worse) still lands mid-marker after rounding.
//   Rejecting is the only safe move for this one case, since there's no
//   nearby "correct" position to clamp to that isn't itself a guess. Existing
//   note spans are computed once per call via findExistingNoteSpans() and
//   passed in as `existingSpans` — cheap, since the model returns at most a
//   few dozen placements per call and a manuscript chapter has at most a
//   few dozen existing notes.
// - Entries failing either the content or charPos-finite check are dropped
//   silently, same as before. Entries rejected for landing inside an
//   existing marker are reported separately via the returned `rejected`
//   count, since that's a signal worth surfacing (a run that rejected
//   several placements likely got confused about offsets) rather than
//   silently disappearing the way a malformed/empty entry does.
// - This function never throws.
function resolvePlacements(rawPlacements, chapterText, existingSpans) {
  const maxPos = typeof chapterText === 'string' ? chapterText.length : 0;
  const spans = Array.isArray(existingSpans) ? existingSpans : [];
  const out = [];
  let rejected = 0;
  for (const p of rawPlacements) {
    if (!p || typeof p !== 'object') continue;
    const content = typeof p.content === 'string' ? p.content.trim() : '';
    if (!content) continue;
    let charPos = Number(p.charPos);
    if (!Number.isFinite(charPos)) continue;
    charPos = Math.max(0, Math.min(Math.round(charPos), maxPos));
    if (landsInsideExistingNote(charPos, spans)) {
      rejected++;
      continue;
    }
    out.push({ charPos, content });
  }
  return { placements: out, rejected };
}

// Builds the instruction wrapper common to every provider — the per-provider
// adapters differ only in how they get this text to the model and back.
function buildPrompt({ systemPrompt, chapterText }) {
  const instructions = [
    'You are an editorial assistant annotating a manuscript chapter with',
    'margin notes. You will be given the full chapter text as plain markdown,',
    'with each character position numbered from 0.',
    '',
    'Decide where notes belong and what each should say. Respond with ONLY a',
    'JSON array, no prose before or after it, no markdown code fence, in',
    'exactly this shape:',
    '[{"charPos": <integer character offset into the chapter text>, "content": "<note text>"}]',
    '',
    'Rules:',
    '- charPos must be an integer offset into the chapter text exactly as given.',
    '- Return an empty array [] if no notes are warranted.',
    '- Keep each note\'s content concise (a sentence or two).',
    '- Do not include any text outside the JSON array.',
  ].join('\n');

  const behaviour = (systemPrompt || '').trim();
  const fullSystem = behaviour
    ? `${instructions}\n\nAdditional instructions from the user for this agent:\n${behaviour}`
    : instructions;

  const userMessage = `Chapter text:\n\n${chapterText || ''}`;

  return { fullSystem, userMessage };
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
async function chat({ provider, model, apiKey, ollamaUrl, systemPrompt, chapterText }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    return { ok: false, error: `Unknown provider: ${provider}` };
  }
  if (typeof chapterText !== 'string' || !chapterText.trim()) {
    return { ok: false, error: 'No chapter text provided' };
  }

  const { fullSystem, userMessage } = buildPrompt({ systemPrompt, chapterText });

  let rawText;
  try {
    rawText = await adapter({ apiKey, model, ollamaUrl, fullSystem, userMessage });
  } catch (e) {
    return { ok: false, error: e.message || 'Request to model provider failed' };
  }

  const rawPlacements = extractJsonArray(rawText);
  const existingSpans = findExistingNoteSpans(chapterText);
  const { placements, rejected } = resolvePlacements(rawPlacements, chapterText, existingSpans);

  // Surfaced but non-fatal: a run that rejected placements still returns
  // ok:true with whatever's left — see agentRunner.js/settingsPanel.js for
  // how `rejected > 0` is folded into the run summary rather than treated
  // as an error, since "the model proposed something bad and we caught it"
  // is exactly this check working as intended, not a failure of the run.
  return { ok: true, placements, rejected };
}

module.exports = {
  chat,
  // Exported for unit testing only — server.js only ever calls chat().
  _extractJsonArray: extractJsonArray,
  _resolvePlacements: resolvePlacements,
  _findExistingNoteSpans: findExistingNoteSpans,
};