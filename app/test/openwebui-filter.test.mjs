import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { FILTER_PATH, PROMPT_PATH, renderFilter, isInSync } from '../scripts/sync-prompt.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SELFTEST = path.join(root, 'openwebui', 'filter_selftest.py');

/**
 * The filter is Python, so these checks are the seam between the two languages: the
 * embedded prompt copy must match the .md (otherwise the injectable text rots), the
 * module must actually parse, and its decision logic must pass its own suite.
 */
test('filter embeds the current SYSTEM_PROMPT.md', () => {
  assert.ok(isInSync(), 'openwebui/metrics_filter.py is stale — run: node scripts/sync-prompt.mjs --write');
});

test('embedded prompt is a single JSON-escaped literal, so any prompt text is safe', () => {
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  const rendered = renderFilter(fs.readFileSync(FILTER_PATH, 'utf8'), prompt);

  // The copy lives on exactly one line: a newline inside a bare Python string literal
  // would be a syntax error, which is why the block is JSON-encoded rather than
  // dropped in as a triple-quoted docstring.
  const line = rendered.split('\n').find((l) => l.startsWith('FULL_INSTRUCTIONS = '));
  assert.ok(line, 'FULL_INSTRUCTIONS assignment not found');
  assert.equal(JSON.parse(line.slice('FULL_INSTRUCTIONS = '.length)), prompt);
});

/**
 * MAX_CHARS refuses injection rather than truncating it, so a prompt that outgrows the
 * cap turns the filter off silently — which is exactly what happened once: the full
 * prompt grew by a paragraph, INSTRUCTIONS=both crossed 12000, and every injected rule
 * disappeared with no error anywhere. Pin the largest mode well under the default.
 */
test('the largest injection mode fits inside MAX_CHARS with headroom', () => {
  const filter = fs.readFileSync(FILTER_PATH, 'utf8');

  const capBlock = filter.slice(filter.indexOf('MAX_CHARS: int = Field'));
  const cap = Number(capBlock.match(/default=(\d+)/)?.[1]);
  assert.ok(Number.isFinite(cap), 'MAX_CHARS default not found');

  // Slice out the compact literal by hand: it opens with `"""\` (line continuation) and
  // closes at the next `"""`, and a lazy regex over the whole file happily spans both
  // literals instead. The range check below is what makes a parsing miss loud.
  const MARKER = 'COMPACT_INSTRUCTIONS = """';
  const open = filter.indexOf(MARKER) + MARKER.length;
  const body = filter.slice(open + (filter[open] === '\\' ? 1 : 0), filter.indexOf('"""', open));
  const compact = body.length;
  assert.ok(compact > 2000 && compact < 6000, `COMPACT_INSTRUCTIONS parsed at ${compact} chars, which looks wrong`);

  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  // both mode injects compact + full, plus the header and its separator, every turn.
  const both = compact + prompt.length + 150;

  assert.ok(
    both < cap,
    `INSTRUCTIONS=both is ~${both} chars against MAX_CHARS=${cap}: the filter would refuse ` +
      'to inject anything and look like it never fired. Raise MAX_CHARS, or shorten the prompt.',
  );
  // Headroom, not a hair's breadth: the old cap cleared the prompt by about 20 characters,
  // so the very next edit tripped it.
  assert.ok(both < cap * 0.9, `INSTRUCTIONS=both is ~${both} of ${cap} chars — too close to the cap`);
});

test('sync script is idempotent', () => {
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  const once = renderFilter(fs.readFileSync(FILTER_PATH, 'utf8'), prompt);
  assert.equal(renderFilter(once, prompt), once, 'second render changed the file');
});

test('filter parses as Python', () => {
  const res = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', FILTER_PATH], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `python could not parse the filter:\n${res.stderr}`);
});

test('filter decision logic passes its own checks', () => {
  const res = spawnSync('python3', [SELFTEST], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /(\d+)\/\1 filter checks passed/, `unexpected selftest output:\n${res.stdout}`);
});
