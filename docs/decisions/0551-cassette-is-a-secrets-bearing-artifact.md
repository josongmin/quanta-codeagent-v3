# ADR-0551 — A replay cassette is a secrets-bearing artifact: owner-only on disk, explicitly encrypted in S3, never scrubbed

Status: Accepted (2026-08-24)
Slice: `src/llm/replay/jsonl-store.ts` · `src/shared/remote-store/s3-backend.ts`
Feature: `cassette-artifact-access-policy` (feature-catalog §9-security)
Related: ADR-0192 (JSONL replay store) · the aug-23 review §17.3 (the STOP against canonical cassette scrub)

## Context

A replay cassette records the **full LLM request**: the system prompt, every message, the contents of every file the agent read, and every tool output. If the agent read a `.env`, an `~/.aws/credentials`, or a private key — the very files the stale-read guard and the shell-effect authority exist to reason about — those bytes are in the cassette verbatim.

Written with the process defaults, the file landed at `0644` in a `0755` directory. **World-readable.** On a shared box or a CI runner, any local user could read every secret the agent ever touched.

The remote half had the same shape: the S3 backend PUTs with `aws s3 cp - s3://…` and no `--sse`, so encryption at rest was whatever the bucket happened to default to — fine on a bucket with default encryption configured, silent plaintext on one without.

## Decision

**Access policy on the artifact as it is.**

Local: the store creates its directory `0700` and its file `0600`. The `mode` argument to `appendFile`/`writeFile` applies only when the file is *created*, so an existing cassette — from a prior run, or one this process already opened — would keep whatever mode it had; the mode is therefore re-asserted with `chmod` after each write. A permissions fix that only covered fresh files would leave every recording made before this landed world-readable forever.

Remote: every PUT passes `--sse` (default `AES256`, overridable to `aws:kms`). Reads need no flag — S3 decrypts SSE-S3 transparently — which is why `get` is asserted to stay unchanged. There is deliberately no "off": a caller who wants different encryption configures the bucket rather than silently weakening every producer.

**Deliberately NOT redaction.** Scrubbing the recorded bytes would destroy replay reproducibility — the entire point of a cassette — and would move the content hash, silently retiring every cassette already on disk. A redacted *export* is a separate concern with its own output. The hellgate asserts the opposite of a scrub: the secret is still in the file, and the match hash is unchanged.

## Consequences

- Content and hash are pinned by test: one JSONL line, valid JSON, the secret still present, and `defaultHashRequest` still returning the same 16-hex value. Every existing cassette continues to replay.
- The rewrite path (`truncate` / curation) is asserted not to widen the mode, because it goes through `writeFile` rather than `appendFile`.
- Removing either half restores the hole under injection: dropping the `chmod` re-assert leaves pre-existing files wide, and dropping `--sse` returns encryption to bucket luck.
- Windows has no POSIX mode; the `chmod` is a no-op there and the property is a POSIX-only guarantee, which matches where the store is actually used (bench boxes, CI runners, developer machines).
