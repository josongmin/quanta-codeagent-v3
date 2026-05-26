# ADR-0312 — GitHub App webhook host scaffold (Tier 1, intentionally deferred)

- **Status**: accepted (2026-05-26) — scaffold + signature path; impl deferred until host decision
- **Related**: [[0311-github-actions-trigger-adapter]] (sibling Tier-0 path), [[0132-autonomous-proactive-reactor]] (TriggerSourcePort SoT)
- **References**:
  - GitHub Docs — Webhooks `X-Hub-Signature-256` (HMAC-SHA256 over raw body bytes)
  - Cursor BugBot host (single-process HTTP + signature verify before parse)

## Problem

Tier 0 (GH Actions) covers the case where quanta is invited INTO a workflow file. Tier 1 covers the inverse — quanta runs as a long-lived GitHub App that receives webhook deliveries. The host platform (Cloudflare Worker / Vercel / in-process Node) is not yet decided; we don't want to land a half-baked HTTP server that becomes the wrong default.

But we DO want the **shape** of the seam to be tested and reachable, so the host integration is a one-import job when the decision lands.

## Decision

Ship the slice surface with:

1. **`WebhookTransportPort`** — minimal listen-shape (`listen(port, handler) → handle`), agnostic of the underlying engine. Tier-1 host adapters bind a concrete `node:http` / `Bun.serve` / WorkerD wrapper.
2. **`createWebhookEventSource(opts)`** — factory that validates wiring at boot but whose `poll()` throws `NOT_IMPLEMENTED`. This is a **load-bearing scaffold**: misconfigured composition fails at startup, not at first event. The function exists so call sites can import without a future hot-path surprise.
3. **`verifyHubSignature256(rawBody, signatureHeader, secret)`** — production-ready HMAC-SHA256 verifier with:
   - `sha256=` prefix check,
   - hex-only payload guard (`/^[0-9a-fA-F]+$/`),
   - length-equal precondition before `timingSafeEqual`,
   - **empty secret returns `false`** (no open bypass),
   - any IO/crypto throw collapses to `false`.

Files:
- [[../../src/integrations/github/webhook-server.ts]] — scaffold + boot-time wiring
- [[../../src/integrations/github/signature-verify.ts]] — HMAC verifier
- 14 hellgate cases in [[../../tests/unit/integrations/github/signature-verify-attack-hellgate.test.ts]] lock the verifier against forged / malformed signatures, length-extension probes, wrong-secret bypass, sha1-prefix downgrade, and whitespace tampering.

## Consequences

- Tier 1 has a **landing pad** — the moment the host is picked, only the `WebhookTransportPort` adapter needs implementing (raw-body capture is the critical contract: the transport MUST surface the original bytes, NOT a re-stringified body).
- `createWebhookEventSource` failing at boot if `redactPort` is missing prevents the same secret-leak class that [[0313-pr-output-sink-redaction]] handles on Tier 0.
- The signature verifier is shipped tested before any transport exists; no future host adapter can ship without exercising the same 14 adversarial cases.

## Negative invariants

- DO NOT call `createWebhookEventSource(...).poll()` from production code today — it throws by design.
- DO NOT bypass `verifyHubSignature256` once an adapter is wired. Signature check runs BEFORE JSON.parse on the raw body bytes; reordering invalidates the contract.
- Empty secret MUST stay a `false` return — a misconfigured host MUST NOT silently accept arbitrary deliveries.
