# ADR-0399 — PII-redaction wire in dispatch.applyRedaction

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/dispatch.ts` (extend `applyRedaction`) + `src/security/redaction-config.ts` (extend `RedactionConfig` with optional `pii`) + `src/security/index.ts` (re-export) + hellgate `tests/unit/dispatch-pii-redaction-hellgate.test.ts`.
**Default-OFF:** Yes — absent `redaction.pii.enabled === true` ⇒ byte-identical to the secret-only baseline.

## Context

ADR-0171 introduced the PII-redaction slice — a hexagonal port +
`compositePiiScanner` with the closed `PiiKind` enum (email / phone /
SSN / credit-card / IPv4 / IPv6 / IBAN / passport / driver's license),
Luhn validation for credit cards, and `redactText` splicing that
mutates a single input string in start-DESC order.

The slice has been complete and tested in isolation for many months but
**no consumer wires it**. The barrel comment is explicit: "Default-OFF:
nothing in the dispatch/loop seam imports this today." The
`tool_result` text flowing through the agent loop is scrubbed for
**secrets** (ADR-0078: AWS keys, GitHub PATs, PEM blocks) but not for
human PII. A tool that prints an email address or phone number from a
file the agent reads carries that text into the LLM transcript, the
JSONL recorder, and (if observability is on) telemetry exports — the
PII slice exists precisely to close this gap, but nothing is calling it.

The natural wire point is `dispatch.ts:applyRedaction`. That helper is
already the single funnel for tool-result text on its way back to the
caller, and it already owns the secret-redaction call. Adding the PII
pass next to it keeps the two layers in one auditable place and lets
them share the existing `redaction` config slot on `AgentConfig`.

### What is NOT in this ADR

The newer `src/security/secret-detection/` module (async + detection-only,
emits findings but does NOT splice replacements) **cannot drop into the
sync `applyRedaction` masking slot.** Its semantics — async I/O + Shannon
entropy + structural Luhn signaling — are wrong for a redaction
pipeline. Wiring it belongs to a separate ADR with a gate/tool
semantic, not a masking semantic. This ADR deliberately scopes itself
to the sync `compositePiiScanner.redactText` drop-in.

## Decision

Add an optional `pii` field to `RedactionConfig`:

```ts
interface RedactionConfig {
  // existing — unchanged
  readonly disabled?: boolean
  readonly acknowledgedRisk?: string
  readonly whitelist?: ReadonlyArray<RegExp>
  // ADR-0399 — optional PII branch, default-OFF
  readonly pii?: PiiRedactionConfig
}

interface PiiRedactionConfig extends PiiScannerOpts {
  readonly enabled?: boolean
}
```

`PiiRedactionConfig` extends `PiiScannerOpts` (closed at
`src/security/pii-redaction/port.ts`) so the `kinds` / `allowlist` /
`redactionTemplate` knobs forward straight through — adding a kind to
the closed `PiiKind` enum is a TS error here at compile time.

Extend `applyRedaction` in `dispatch.ts` with a second pass that runs
AFTER the secret pass on the already-secret-masked text:

```ts
let postSecret = text
let hits: ReadonlyArray<RedactionHit> = []
if (config.redaction?.disabled !== true) {
  // existing secret pass — unchanged
  const result = redactSecrets(text, { ... })
  postSecret = result.text
  hits = result.hits
}
if (config.redaction?.pii?.enabled === true) {
  const scanner = compositePiiScanner({ /* opts forwarded */ })
  postSecret = scanner.redactText(postSecret)
}
return { output: postSecret, hits }
```

### Pinned invariants

1. **Default-OFF byte-identical.** Absent `redaction.pii` (or
   `enabled !== true`) ⇒ the PII branch never runs, never instantiates
   a scanner, and the output equals the secret-only path. Hellgate A1-A4.
2. **Strict `=== true` gate.** Any other shape (`false`, `undefined`,
   missing block) means OFF — mirrors the `disabled === true` policy on
   the secret branch. Hellgate B4.
3. **Independence.** Either branch can be on with the other off:
   - Secret ON + PII OFF ⇒ existing behaviour. Hellgate C2.
   - Secret OFF (with `acknowledgedRisk` ack) + PII ON ⇒ PII still
     fires. Hellgate C3.
   - Both ON ⇒ both fire. Hellgate C1.
   - Both OFF (disabled with ack, PII absent) ⇒ raw output. Hellgate C4.
4. **Order: secret-first, then PII.** A secret placeholder
   (`[REDACTED:aws_access_key_id]`) can never accidentally re-expose
   PII that was hiding inside the secret span. PII never accidentally
   rewrites a token already substituted by secret-redaction (the
   placeholder format does not match any PII regex).
5. **`redactionHits` envelope unchanged.** Only the secret pass
   populates `hits`. The PII pass does not surface findings on the
   `DispatchResult` (the user-facing audit trail for the PII branch is
   the masked text itself — sibling addition is a separate ADR).
6. **Slice fence.** The dispatch site imports
   `compositePiiScanner` from `@/security/pii-redaction`. No new
   cross-slice dependency — both modules already live under
   `src/security/`.

## Alternatives considered

- **Wire PII into `redactSecrets` itself.** Would entangle two
  conceptually distinct layers (machine secrets vs human PII) under a
  single function and force one shared confidence model. Rejected.
- **Add a separate `applyPiiRedaction` helper called from the loop.**
  Would multiply the redaction touch-points (currently one). Rejected.
- **Wire the async `secret-detection` module instead.** Wrong semantic
  for this slot (detection-only, async, no splice). Tracked as a
  separate gate/tool ADR.

## Test plan

`tests/unit/dispatch-pii-redaction-hellgate.test.ts` — 12 hellgate
cases across A (default-OFF byte-identical, 4), B (PII enabled, 4),
C (independence — secret + PII combinations, 4). 28 assertions, 0 fail.

Regression: `redaction.test.ts` (RFC-0002 secret golden) +
`pii-redaction-hellgate.test.ts` (slice contract) +
`dispatch*.test.ts` (9 dispatch hellgate batteries) +
`loop*.test.ts` + `memory-distill-redaction-hellgate.test.ts` +
`trajectory.test.ts` — 200 tests, 0 fail.

## Wave-2 (out of scope)

- Surface PII findings on `DispatchResult.redactionHits` (or a sibling
  field) — operator audit of WHAT was masked.
- Wire the same pass into the JSONL recorder + memory-distill input
  (the other two ADR-0078 application points).
- A `pii.disabled` strict gate symmetrical to the secret branch so a
  host can demand an `acknowledgedRisk` to turn it off once it has been
  turned on policy-wide.
