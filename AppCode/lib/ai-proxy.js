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
//   4. Return { ok: true, placements } or { ok: false, error }. Never
//      throws out of `chat()` itself — server.js's route handler still
//      wraps the call in try/catch as a second line of defense, same
//      convention as every other route in server.js.
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

// Validates + clamps raw placements against the actual chapter text length.
// - charPos must be a finite number; it's clamped into [0, chapterText.length]
//   rather than rejected outright, since an off-by-a-little offset (e.g. the
//   model counting a trailing newline differently) shouldn't lose an
//   otherwise-good note — insertNoteAt() on the client just inserts at a
//   document position, so a clamped position is still safe, just possibly
//   a character or two off.
// - content must be a non-empty string after trimming.
// - Entries failing either check are dropped silently; this function never
//   throws.
function resolvePlacements(rawPlacements, chapterText) {
  const maxPos = typeof chapterText === 'string' ? chapterText.length : 0;
  const out = [];
  for (const p of rawPlacements) {
    if (!p || typeof p !== 'object') continue;
    const content = typeof p.content === 'string' ? p.content.trim() : '';
    if (!content) continue;
    let charPos = Number(p.charPos);
    if (!Number.isFinite(charPos)) continue;
    charPos = Math.max(0, Math.min(Math.round(charPos), maxPos));
    out.push({ charPos, content });
  }
  return out;
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
//   { ok: true, placements: [{ charPos, content }, ...] }
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
  const placements = resolvePlacements(rawPlacements, chapterText);

  return { ok: true, placements };
}

module.exports = {
  chat,
  // Exported for unit testing only — server.js only ever calls chat().
  _extractJsonArray: extractJsonArray,
  _resolvePlacements: resolvePlacements,
};