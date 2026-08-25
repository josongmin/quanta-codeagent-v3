# ADR-0551 — A replay cassette is a secrets-bearing artifact: owner-only on disk, explicitly encrypted in S3, never scrubbed

Status: Accepted (2026-08-24)
Slice: `src/llm/replay/jsonl-store.ts` · `src/apps/bench/resume/security.ts` · `src/apps/eval/trajectory/redacted-export.ts`
Feature: `cassette-artifact-access-policy` (feature-catalog §9-security)
Related: ADR-0192 (JSONL replay store) · the aug-23 review §17.3 (the STOP against canonical cassette scrub)

## Context

A replay cassette records the **full LLM request**: the system prompt, every message, the contents of every file the agent read, and every tool output. If the agent read a `.env`, an `~/.aws/credentials`, or a private key — the very files the stale-read guard and the shell-effect authority exist to reason about — those bytes are in the cassette verbatim.

Written with the process defaults, the file landed at `0644` in a `0755` directory. **World-readable.** On a shared box or a CI runner, any local user could read every secret the agent ever touched.

The remote half had the same shape: the S3 backend PUTs with `aws s3 cp - s3://…` and no `--sse`, so encryption at rest was whatever the bucket happened to default to — fine on a bucket with default encryption configured, silent plaintext on one without.

## Decision

**Access policy on the artifact as it is.**

Local: the store creates its directory `0700` and its file `0600`. The `mode` argument to `appendFile`/`writeFile` applies only when the file is *created*, so an existing cassette — from a prior run, or one this process already opened — would keep whatever mode it had; the mode is therefore re-asserted with `chmod` after each write. A permissions fix that only covered fresh files would leave every recording made before this landed world-readable forever.

Remote: the generic S3 backend retains an explicit `AES256` floor, but raw resume cassettes have a stricter admission boundary. Resume is inactive unless a customer-managed KMS key ARN, IAM principal ARN, and maximum retention are configured. Before the first remote put/get/list, a cached live AWS preflight verifies:

- bucket default encryption is `aws:kms` with the configured key;
- all four S3 public-access-block settings are enabled;
- an enabled lifecycle rule covers the exact resume prefix and expires it within the configured maximum;
- IAM simulation allows the required object/list operations inside the prefix and denies the same operations outside it;
- IAM simulation allows `kms:Encrypt`, `kms:Decrypt`, and `kms:GenerateDataKey` on the configured key.

Every resume PUT also sends `--sse aws:kms --sse-kms-key-id <arn>`. The live attestation is embedded in the resume receipt, and replay requires it to match the current attestation. Missing config, failed inspection, excessive retention, wider S3 access, or KMS mismatch fails closed before cassette I/O.

**The canonical cassette is deliberately not redacted.** Scrubbing the recorded bytes would destroy replay reproducibility — the entire point of a cassette — and would move the content hash, silently retiring every cassette already on disk. For sharing, `eval trajectory redact --source <canonical.jsonl> --out <share.jsonl>` creates a separate owner-only, explicitly non-replayable artifact using the existing `shared.redactValue` authority. Its provenance receipt records source/output paths, byte counts, record count, redactor version, timestamp, and both SHA-256 digests. The source is never rewritten.

## Consequences

- Content and hash are pinned by test: one JSONL line, valid JSON, the secret still present, and `defaultHashRequest` still returning the same 16-hex value. Every existing cassette continues to replay.
- The rewrite path (`truncate` / curation) is asserted not to widen the mode, because it goes through `writeFile` rather than `appendFile`.
- Removing either half restores the hole under injection: dropping the `chmod` re-assert leaves pre-existing files wide, and dropping `--sse` returns encryption to bucket luck.
- Remote resume now requires permission to call IAM policy simulation as part of admission. An operator cannot activate resume merely by supplying a bucket name; the required security knobs and live AWS evidence must all be present.
- The sharing export is intentionally not replayable. Consumers that need deterministic replay must use the protected canonical artifact rather than treating a redacted diagnostic copy as a cassette.
- Windows has no POSIX mode; the `chmod` is a no-op there and the property is a POSIX-only guarantee, which matches where the store is actually used (bench boxes, CI runners, developer machines).
