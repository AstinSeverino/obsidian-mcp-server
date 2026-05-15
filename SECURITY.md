# Security Policy

## Supported versions

Only the latest commit on `main` is supported. There are no formal version
tags yet; if you depend on a specific commit, pin it via your package
manager.

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for security reports.**

If you believe you have found a vulnerability in this MCP server:

1. Email the maintainer privately at **astin464@gmail.com** with subject
   `[security] obsidian-mcp-server`.
2. Include:
   - A description of the issue
   - Steps to reproduce (or a minimal proof-of-concept)
   - The version / commit SHA you tested against
   - Your assessment of impact (confidentiality, integrity, availability)
   - Whether you'd like attribution in the fix commit

I'll acknowledge receipt within **7 days** (best-effort, single
maintainer). For confirmed issues I'll work on a fix and coordinate
public disclosure timing with you.

## Scope

In scope:

- The TypeScript source in `src/` and `tests/`
- The CI workflow at `.github/workflows/test.yml`
- The security model documented in [README.md](./README.md#security)
  (path traversal, frontmatter sanitization, extension whitelist,
  permission scoping)

Out of scope (please report upstream):

- Vulnerabilities in third-party dependencies — open an issue with the
  upstream maintainer (npm package owner). I'll bump the dependency
  once a patched version exists.
- Vulnerabilities in the underlying Node runtime, the MCP SDK itself,
  SQLite, or `sqlite-vec` — these have their own security policies.
- Misconfiguration of a downstream consumer (e.g. exposing the stdio
  transport over an untrusted network without an authn layer in
  front of it).

## Hardening checklist for operators

If you run this server, make sure:

- The vault directory is on a filesystem you trust.
- The process runs as a user with no privileges beyond what the vault
  requires (no `root`, no shell access beyond the vault tree).
- `BRAIN_PERMISSION_MODE=read-only` for any client you do not fully
  trust.
- The `data/brain.db` file is **not** committed to source control or
  uploaded to a public bucket — it contains note content and embeddings.
