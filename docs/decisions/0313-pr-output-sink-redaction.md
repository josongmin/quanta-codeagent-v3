# ADR-0313 — PR output sink redaction + idempotency invariants

- **Status**: accepted (2026-05-26)
- **Related**: [[0311-github-actions-trigger-adapter]] (sibling — input side), [[0078-secret-redaction-content-plane-invariant]] (`@/security` SoT), [[0132-autonomous-proactive-reactor]] (no-loop discipline), [[0314-mention-filter-trust-scope]] (shared marker SoT)
- **References**:
  - secretlint + our 10-format regex layer ([[secret-and-pii-detection-2026-05-25]])
  - Anthropic claude-code-action (`<!-- claude-code:reaction-id=...-->` marker pattern)
  - GitHub API — comment body 65,536-char limit; PATCH idempotent endpoint

## Problem

If we let the agent post PR comments raw, **any** secret it sees during the turn (logs / env dumps / leaked config) lands on a public PR and becomes externally indexed within minutes. There is no "undo" — even a deleted GH comment is archived for ~14 days.

Equally bad: a network blip causing two POSTs ⇒ duplicate comment spam, with no way to roll back the second one cleanly.

## Decision

`createPrOutputSink(opts) → PrOutputSink` — 3-verb sink (`postComment` / `postReview` / `postReviewComment`) with three structural invariants enforced at construction:

1. **`redactPort` is mandatory** — missing or non-function `redact` ⇒ `throw` AT CONSTRUCT TIME. Boot-time refusal, not runtime fallback. The composition root MUST bind `{ redact: (t) => redactSecrets(t, { origin: "tool_result" }).text }` (or stricter).
2. **Idempotency marker** — every body is suffixed with `<!-- quanta:idempotency=<16hex> -->`. The hex is `sha256(deliveryId + ":" + action).slice(0,16)`. Existing comment with matching marker ⇒ PATCH; otherwise ⇒ POST.
3. **Body cap is BYTE-counted** — 65,000 bytes default, marker counted within. Over-cap bodies are trimmed BEFORE the marker, with `…` sentinel inserted. Multi-byte UTF-8 boundaries are accepted as a documented degradation (we'd rather drop a glyph than skip the marker).

Self-loop defense (defense in depth with [[0311-github-actions-trigger-adapter]]):
- The marker we stamp here is the same string the mention filter excludes — `[[0314-mention-filter-trust-scope]]` rejects any body containing it.
- Our own output therefore cannot wake us up, even if GH eventually surfaces it back to the trigger source.

Files:
- [[../../src/integrations/github/pr-output-sink.ts]] — sink + clamp + PATCH/POST routing
- [[../../src/integrations/github/idempotency.ts]] — `computeIdempotencyKey` (16 hex char SHA-256 truncation)
- 9 hellgate cases in [[../../tests/unit/integrations/github/pr-output-sink-redaction-hellgate.test.ts]] lock AWS key id / GitHub PAT / Anthropic key / JWT / PEM block redaction + marker stamping + recursive-self detection + over-cap trim path.

## Consequences

- A future "post a coverage report" or "post a review verdict" tool can call `sink.postReview(...)` without rewiring the safety story — the same redaction + idempotency invariants apply.
- The sink is `no-throw` (returns `{ ok: false, error }`) so a hostile network never tears down the calling adapter.
- Future GH endpoints (check_run, suggested change) plug in by extending the closed `OutputSinkKind` enum — TS will refuse to compile until the matcher table is updated.

## Negative invariants

- DO NOT bypass `redactPort.redact(body)` on any verb. The flow `clamp ← redact ← body` is single-step; reordering is a regression.
- DO NOT post the marker SoMETHING-ELSE. Mention filter and sink share the literal `<!-- quanta:idempotency=` prefix.
- DO NOT change `computeIdempotencyKey` truncation width without bumping the marker (stored markers from old runs would never match again).
