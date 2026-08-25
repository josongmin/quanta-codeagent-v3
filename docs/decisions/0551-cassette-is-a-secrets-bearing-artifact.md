# ADR-0551 — A replay cassette is a secrets-bearing artifact: owner-only on disk, explicitly encrypted in S3, never scrubbed

Status: Accepted (2026-08-24)
Slice: `src/llm/replay/jsonl-store.ts` · `src/apps/bench/resume/security.ts` · `src/apps/eval/trajectory/redacted-export.ts`
Feature: `cassette-artifact-access-policy` (feature-catalog §9-security)
Related: ADR-0192 (JSONL replay store) · the aug-23 review §17.3 (the STOP against canonical cassette scrub)

## Context

A replay cassette records the **full LLM request**: the system prompt, every message, the contents of every file the agent read, and every tool output. If the agent read a `.env`, an `~/.aws/credentials`, or a private key — the very files the stale-read guard and the shell-effect authority exist to reason about — those bytes are in the cassette verbatim.

Written with the process defaults, the file landed at `0644` in a `0755` directory. **World-readable.** On a shared box or a CI runner, any local user could read every secret the agent ever touched.

The remote half had the same shape: the S3 backend PUTs with `aws s3 cp - s3://…` and no `--sse`. S3 now applies SSE-S3 by default, but that does not pin a customer-managed key or establish access and retention policy.

## Decision

**Access policy on the artifact as it is.**

Local: the store creates a missing managed directory with `0700` and its file with `0600`. The `mode` argument to `appendFile`/`writeFile` applies only when the file is *created*, so an existing cassette — from a prior run, one this process already opened, or a caller-supplied resume materialization path — would keep whatever mode it had; file mode is therefore re-asserted with `chmod` after each write/download. Arbitrary existing parents are not chmodded because a configured cassette/export path may live directly in a repository root or `/tmp`; changing that parent would be a destructive scope violation. A permissions fix that only covered fresh files would leave every recording made before this landed world-readable forever.

Remote: the generic S3 backend retains an explicit `AES256` floor, but raw resume cassettes have a stricter admission boundary. Resume is inactive unless a customer-managed KMS key ARN, IAM principal ARN, and maximum retention are configured. Before the first remote put/get/list, a cached live AWS preflight verifies:

- the active AWS caller is the configured IAM role or one of its assumed-role sessions;
- bucket default encryption is `aws:kms` with the configured key;
- all four S3 public-access-block settings are enabled;
- an enabled unconditional or plain-prefix lifecycle rule covers the exact resume prefix and expires it within the configured maximum; tag, size, and `And` filters are rejected because the producer does not establish their predicates;
- IAM simulation allows the required object/list operations inside the prefix and denies them at a representative sibling prefix;
- IAM simulation allows `kms:Encrypt`, `kms:Decrypt`, and `kms:GenerateDataKey` on the configured key.

Every resume PUT also sends `--sse aws:kms --sse-kms-key-id <arn>`. An application-layer wrapper rejects every put/get/list path outside the attested prefix before backend I/O. The live v2 attestation is embedded in the resume receipt, and replay requires it to match the current attestation. Missing config, caller mismatch, failed inspection, excessive retention, failed scope probes, an out-of-prefix application path, or KMS mismatch fails closed.

A secondary upload or security-attestation failure permanently degrades that recording run. The degraded receipt is retried after a receipt PUT failure until it is durably written; the recorder never falls back to writing a later healthy receipt. An older healthy receipt plus any missing or extra segment is rejected by the exact contiguous-count launch gate.

On a resumed `record-and-passthrough` run, replay matching and miss recording share the same local+S3 tee store. The tee initializes its receipt count from the existing durable segment set, so the first new live turn extends `N` to `N+1` instead of resetting the receipt to `1`. A curation `save` always degrades the resume key because the S3 adapter cannot delete a stale tail safely.

`SimulatePrincipalPolicy` is not a universal least-privilege proof. Effective AWS authorization can also depend on resource policies, permissions boundaries, SCPs, and request context, and simulator results can differ from live authorization. The receipt therefore records the exact claims `iamScopeProbePassed` and `applicationPrefixEnforced`; it does not claim that the configured principal has no other permissions. The AWS preflight mints only the IAM probe; `applicationPrefixEnforced` is added by the `resumeStore` composition that actually installs the path-checking backend wrapper. Deployment policy remains an infrastructure control.

**The canonical cassette is deliberately not redacted.** Scrubbing the recorded bytes would destroy replay reproducibility — the entire point of a cassette — and would move the content hash, silently retiring every cassette already on disk. For sharing, `eval trajectory redact --source <canonical.jsonl> --out <share.jsonl>` creates a separate owner-only, explicitly non-replayable artifact using the existing `shared.redactValue` authority. Its provenance receipt records source/output paths, byte counts, record count, redactor version, timestamp, and both SHA-256 digests. The source is never rewritten.

## Consequences

- Content and hash are pinned by test: one JSONL line, valid JSON, the secret still present, and `defaultHashRequest` still returning the same 16-hex value. Every existing cassette continues to replay.
- The rewrite path (`truncate` / curation) is asserted not to widen the mode, because it goes through `writeFile` rather than `appendFile`.
- Newly created managed directories are `0700`; existing arbitrary parents retain their mode, while cassette, redacted export, and provenance files are always `0600`.
- Resume materialization additionally binds the receipt's key/campaign/instance identity and exact contiguous segment count before writing the local owner-only cassette.
- Both the initial production bench record composition and resumed `record-and-passthrough` misses write through the same local+S3 tee; durability does not depend on an unused helper entrypoint.
- Removing either half restores the hole under injection: dropping the `chmod` re-assert leaves pre-existing files wide, and dropping `--sse` returns encryption to bucket luck.
- Remote resume now requires permission to call STS caller identity and IAM policy simulation as part of admission. An operator cannot activate resume merely by supplying a bucket name; the required security knobs and live AWS evidence must all be present.
- The sharing export is intentionally not replayable. Consumers that need deterministic replay must use the protected canonical artifact rather than treating a redacted diagnostic copy as a cassette.
- Windows has no POSIX mode; the `chmod` is a no-op there and the property is a POSIX-only guarantee, which matches where the store is actually used (bench boxes, CI runners, developer machines).
