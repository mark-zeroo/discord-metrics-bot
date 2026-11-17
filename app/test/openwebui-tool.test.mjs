// The tool clamps `top` locally, the API rejects out-of-range values. That asymmetry is
// fine, but the two numbers have to agree: if the API's ceiling rises and the tool keeps
// clamping to the old figure, callers silently get fewer channels than they asked for,
// and the docstring quietly becomes a lie. This pins all three together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const appDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const toolSource = readFileSync(path.join(appDir, 'openwebui', 'discord_metrics_tool.py'), 'utf8');
const paramsSource = readFileSync(path.join(appDir, 'src', 'api', 'params.js'), 'utf8');

/** The API's default ceiling for ?top=, from src/api/params.js. */
function apiCeiling() {
  const match = paramsSource.match(/const MAX_TOP = (\d+);/);
  assert.ok(match, 'MAX_TOP not found in params.js');
  return Number(match[1]);
}

/** Every `min(int(top), N)` clamp in the tool. */
function toolClamps() {
  return [...toolSource.matchAll(/min\(int\(top\),\s*(\d+)\)/g)].map((m) => Number(m[1]));
}

test('the tool clamps top to the API ceiling', () => {
  const ceiling = apiCeiling();
  const clamps = toolClamps();
  assert.equal(clamps.length, 2, 'expected a clamp in get_activity_series and get_voice_activity');
  for (const clamp of clamps) {
    assert.equal(
      clamp,
      ceiling,
      `tool clamps top at ${clamp} but the API ceiling is ${ceiling} — a caller asking for ` +
        `${ceiling} would silently receive ${clamp}`,
    );
  }
});

test('top docstrings describe clamping, not rejection', () => {
  const docstrings = [...toolSource.matchAll(/:param top:([^\n]*(?:\n\s{12}[^\n]*)*)/g)].map((m) => m[1]);
  assert.equal(docstrings.length, 2, 'expected a top docstring in both tool methods');
  for (const text of docstrings) {
    assert.match(text, /[Cc]lamped/, 'the tool clamps locally, so the docstring must say so');
    // The API does reject, but this text is read by the model calling the *tool*, which
    // never forwards an out-of-range value. Saying "rejected" here is what was wrong.
    assert.doesNotMatch(
      text,
      /rejected, not clamped/,
      'contradicts the clamp in the method body below it',
    );
  }
});

test('the API still rejects out-of-range top rather than clamping it', () => {
  // Documented tool behaviour must not leak into the API contract: a direct caller
  // passing top=999 gets a 400, which keeps the failure visible instead of silent.
  const testSource = readFileSync(path.join(appDir, 'test', 'api.test.mjs'), 'utf8');
  assert.match(testSource, /\/v1\/activity\?top=999'\)\)\.status, 400/);
  assert.match(paramsSource, /if \(n < min \|\| n > max\) throw new ParamError/);
});
