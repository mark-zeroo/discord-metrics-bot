# Security policy

## What this service holds

Worth knowing before you file anything, because it shapes what counts as a bug:

- **A Discord bot token** in `.env`. Read at start-up, never logged, never
  written to the database, never exposed over HTTP.
- **API tokens as SHA-256 hashes only**, in `/data/tokens.json` (inside the
  `metrics-data` volume). Each entry is `{id, label, hash, scopes, revoked_at}`
  and the plaintext exists exactly once — printed to the terminal by
  `npm run token`. A copy of the volume therefore yields no usable token.
  The API re-stats that file and reloads it within ~5 seconds, so
  `npm run token -- revoke <id>` takes effect without a restart.
- **Aggregates about one guild** — message counts per channel per hour, voice
  seconds per channel, join/leave events, and HMAC'd per-member counters
  (`PER_MEMBER_COUNTERS=hmac`). Message text, member names, and avatars are
  never stored. See the privacy section of the README for the full inventory.

The API is loopback-only, GET-only, and rate-limited per token (60 requests per
minute by default), so a leaked token grants eleven fixed questions and no write
path; every request is recorded in the `api_audit` table with its token id.

## Reporting

Please **do not** open a public issue for anything in this list:

- token disclosure, or a path that writes a token into logs, errors, or the DB
- authentication bypass, token enumeration, or a timing oracle in the hash check
- SQL injection through any endpoint parameter
- bypass of the IP allowlist or the per-token rate limit
- privilege escalation in the slash commands' role allowlist
- anything that makes a *read-only* endpoint mutate state

Use GitHub's **private vulnerability reporting** (Security → Advisories → Report
a vulnerability) on this repository. If that is unavailable, contact a maintainer
directly rather than opening an issue.

Expect an acknowledgement within a few days. This is a self-hosted project
maintained on a best-effort basis — there is no SLA, but a credible report will
get a fix and credit if you want one.

## If you have exposed a token

1. **Bot token** — reset it in the Discord Developer Portal, then recreate the
   container (`docker compose up -d --force-recreate`) so the new value in
   `.env` is picked up.
2. **API token** — `npm run token -- revoke <id>` (run it against the token file
   inside the container or on the host, whichever owns the volume). It takes
   effect on the next request; no restart needed. An entry with `revoked_at` set
   is skipped on load.

## Supported versions

The `main` branch only. This project is deployed from source and is not
distributed as a versioned package, so fixes land on `main` rather than in
backports.
