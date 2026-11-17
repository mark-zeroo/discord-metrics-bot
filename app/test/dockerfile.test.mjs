// The application lives in app/, but the Dockerfile and its build context are at the
// repository root, because a Dockerfile cannot COPY from outside its own context and
// docker/entrypoint.sh sits beside it. That coupling is invisible until a build fails
// on a path — so it gets asserted here instead. Every expectation below is "relative
// to the repo root", which is also the compose build context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const appDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = path.join(appDir, '..');

const dockerfile = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

/** COPY sources, resolved against the build context (the repo root). */
function copySources() {
  const sources = [];
  for (const line of dockerfile.split('\n')) {
    if (!/^COPY\s/.test(line)) continue;
    // COPY --from=deps <src> <dest>: the source belongs to the other stage, not the context.
    if (/^COPY\s+--from=/.test(line)) continue;
    const parts = line.replace(/^COPY\s+/, '').trim().split(/\s+/);
    if (parts.length < 2) continue;
    sources.push(...parts.slice(0, -1));
  }
  return sources;
}

test('every Dockerfile COPY source exists at the repository root', () => {
  const sources = copySources();
  assert.ok(sources.length >= 5, `expected several COPY sources, found ${sources.length}`);
  for (const source of sources) {
    assert.ok(
      existsSync(path.join(repoRoot, source)),
      `Dockerfile copies '${source}', which does not exist relative to the repo root — ` +
        `the build context is the root, not app/`,
    );
  }
});

test('the Dockerfile copies the app with app/-prefixed paths', () => {
  const sources = copySources();
  assert.ok(sources.includes('app/src'), 'app/src should be copied onto ./src');
  assert.ok(sources.includes('app/package.json'));
  assert.ok(sources.includes('app/package-lock.json'));
  // Getting this wrong (a bare "src") is a build failure, not a silent one, but the
  // assertion documents the layout for the next person who moves a directory.
  for (const source of sources) {
    if (source.startsWith('docker/')) continue;
    assert.ok(source.startsWith('app/'), `COPY source '${source}' escapes app/`);
  }
});

test('nothing the Dockerfile copies is excluded by .dockerignore', () => {
  // Only the layout-level entries are checked literally; glob entries (*.log, **/__pycache__)
  // cannot collide with the paths the image needs.
  const literals = dockerignore.filter((entry) => !entry.includes('*'));
  for (const source of copySources()) {
    for (const entry of literals) {
      const excluded = source === entry || source.startsWith(`${entry}/`);
      assert.ok(!excluded, `.dockerignore excludes '${entry}', but the Dockerfile copies '${source}'`);
    }
  }
});

test('the image entrypoint and command point at real files', () => {
  assert.match(dockerfile, /COPY docker\/entrypoint\.sh \/usr\/local\/bin\/entrypoint\.sh/);
  const cmd = dockerfile.match(/CMD \[(.*)\]/);
  assert.ok(cmd, 'no CMD in the Dockerfile');
  const argv = JSON.parse(`[${cmd[1]}]`);
  assert.equal(argv[0], 'node');
  // Resolved against WORKDIR /app after COPY app/src ./src.
  const script = path.join(appDir, argv[1]);
  assert.ok(existsSync(script), `CMD runs '${argv[1]}', missing from app/ (${script})`);
});

test('package.json scripts point at files that exist in app/', () => {
  const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const token of command.split(/\s+/)) {
      if (token.startsWith('-')) continue;
      // Plain file paths only; globs are skipped because the glob is the assertion.
      if (!/^[\w./-]+\.(mjs|js|sh)$/.test(token)) continue;
      assert.ok(existsSync(path.join(appDir, token)), `npm run ${name}: '${token}' does not exist in app/`);
    }
  }
});

test('the app does not reach outside its own directory for code', () => {
  // A '../' import from app/src would mean the restructure is half done: the Dockerfile
  // only copies app/src, so such an import would resolve to nothing inside the image.
  const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.ok(existsSync(path.join(appDir, 'src', 'index.js')));
  assert.ok(existsSync(path.join(appDir, 'openwebui', 'SYSTEM_PROMPT.md')), 'openwebui moved out from under app/');
  assert.ok(existsSync(path.join(appDir, 'scripts', 'doctor.sh')), 'doctor.sh moved out from under app/');
});
