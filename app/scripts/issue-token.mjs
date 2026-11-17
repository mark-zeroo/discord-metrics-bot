#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../src/api/auth.js';

/**
 * API token management. Tokens are generated here, shown once, and stored only
 * as SHA-256 hashes. The file is written 0600 and atomically replaced, so a
 * reader never sees a half-written file and another user never sees the file.
 *
 *   npm run token -- issue --label openwebui
 *   npm run token -- list
 *   npm run token -- revoke <id>
 */

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const tokensFile = process.env.TOKENS_FILE ?? '/data/tokens.json';

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
    return Array.isArray(parsed.tokens) ? parsed.tokens : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function write(tokens) {
  fs.mkdirSync(path.dirname(tokensFile), { recursive: true, mode: 0o750 });
  const tmp = `${tokensFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, tokensFile);
  fs.chmodSync(tokensFile, 0o600);
}

/** base64url of 32 bytes = 43 chars; hashToken's shape check matches this. */
const newToken = () => randomBytes(32).toString('base64url');

switch (cmd) {
  case 'issue': {
    const label = flag('label', 'openwebui');
    const scopes = flag('scopes', 'stats:read').split(',').map((s) => s.trim()).filter(Boolean);
    const tokens = read();
    const id = `tok_${randomBytes(4).toString('hex')}`;
    const plaintext = newToken();

    tokens.push({
      id,
      label,
      scopes,
      hash: hashToken(plaintext),
      created_at: new Date().toISOString(),
      revoked_at: null,
    });
    write(tokens);

    process.stdout.write(
      [
        '',
        '  Token created. It is shown once and cannot be recovered.',
        '',
        `  id      : ${id}`,
        `  label   : ${label}`,
        `  scopes  : ${scopes.join(', ')}`,
        '',
        `  token   : ${plaintext}`,
        '',
        `  Stored hashed in ${tokensFile} (mode 0600).`,
        '  Paste it into the Open WebUI tool valve, not into a document.',
        '',
      ].join('\n'),
    );
    break;
  }

  case 'list': {
    const tokens = read();
    if (tokens.length === 0) {
      process.stdout.write('No tokens.\n');
      break;
    }
    for (const t of tokens) {
      const state = t.revoked_at ? `revoked ${t.revoked_at}` : 'active';
      process.stdout.write(`${t.id}\t${t.label}\t${(t.scopes ?? []).join(',')}\t${state}\n`);
    }
    break;
  }

  case 'revoke': {
    const id = args[1];
    if (!id) {
      process.stderr.write('usage: npm run token -- revoke <id>\n');
      process.exit(2);
    }
    const tokens = read();
    const match = tokens.find((t) => t.id === id);
    if (!match) {
      process.stderr.write(`no token with id ${id}\n`);
      process.exit(1);
    }
    match.revoked_at = new Date().toISOString();
    write(tokens);
    process.stdout.write(`revoked ${id} (${match.label})\n`);
    break;
  }

  default:
    process.stdout.write(
      [
        'usage:',
        '  npm run token -- issue --label <name> [--scopes stats:read]',
        '  npm run token -- list',
        '  npm run token -- revoke <id>',
        '',
      ].join('\n'),
    );
}
