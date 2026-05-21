# ADR-0078 — Secret redaction as content-plane invariant

## Status
Accepted (2026-05-22)

## Context

The agent loop reads files, runs shell commands, and surfaces both to the
model AND to durable storage (long-term memory, future JSONL envelope).
A single accidental `cat ~/.env` or `aws configure list` returns
credentials that then ride into:

1. the **model context** (LLM provider transcript — possibly logged on
   provider side);
2. the **on-disk JSONL envelope** (session replay);
3. the **memory distill input** (durable knowledge ingest — survives
   beyond the session).

Pre-ADR, the loop trusted the host to know what to read and what not to.
The reviewer-tier + permission-gate stack stops MUTATING actions, not
read-actions. A grep through the corpus shows zero structural redaction
of known-format secrets — every test fixture, every demo, every smoke
session is one fat-finger away from leaking a real key into a place we
do not fully control.

The Codex `seatbelt-sandbox-profile.md` corpus and the
`codex-rule-dsl-pattern.md` memory both treat path classification as a
first-class concern; we have been borrowing that posture for the
permission gate but not for the **content plane**.

## Decision

Introduce a single source-of-truth `src/security/redaction.ts` applied
at three mandatory points and surfaced as a fourth field on the
`AgentOutcome`:

| # | Site                                                 | `RedactionOrigin`     |
|---|------------------------------------------------------|-----------------------|
| 1 | `dispatch.ts` — `execute()` result normalization     | `tool_result`         |
| 2 | `loop.ts` — `finish()` pre-persist snapshot          | `envelope_jsonl`      |
| 3 | `memory-distill.ts` — serialized transcript input    | `memory_distill`      |
| 4 | `AgentOutcome.redactions[]` (audit surface)          | rollup of #1–#3       |

### Two-layer structural model (NEITHER heuristic)

- **Layer 1** — `src/security/sensitivity-classifier.ts`: maps a file
  path OR a shell-command shape to a closed `SensitivityClass`
  (`"public" | "internal" | "secret"`).
  - Path rules are an explicit list: `.env*`, `*.pem`, `*.key`, `~/.aws/
    credentials`, `~/.ssh/id_*`, `~/.gnupg/**`, etc.
  - Command rules match on first token + structural arg shape, NOT
    keyword search: `aws configure list-profiles`, `gh auth token`,
    `cat ~/.env`, bare `printenv` / `env`, password-manager CLIs.
  - `"secret"` short-circuits Layer 2: the entire output is replaced
    with `[REDACTED:source_class_secret] (origin: <path or cmd>)`.

- **Layer 2** — `src/security/redaction.ts`: a closed discriminated
  `RedactionKind` enum, 14 known formats + the source-class kind. Each
  pattern matches a FIXED secret format with a deterministic regex
  (AKIA + 16 base32, `ghp_…`, `AIza` + 35 url-safe, PEM begin/end,
  `sk-ant-…`, etc.). NO confidence scoring, NO probabilistic threshold,
  NO fuzzy-English search. Adding a kind without wiring a matcher is a
  type error (`assertKindWired` switch with `never` default).

### Every redacted span surfaces

Every match emits a `RedactionHit` carrying `kind`, `span`,
`placeholder`. The loop aggregates hits into `AgentOutcome.redactions`
as a frozen, stable-sorted `RedactionRollup[]` (`origin × kind × count`).
The model sees `[REDACTED:<kind>]` placeholders — never silent removal.

### Opt-out gate

`AgentConfig.redaction?: RedactionConfig` is consumed exactly ONCE at
startup via `normalizeRedactionConfig`. `disabled: true` REQUIRES a
non-empty `acknowledgedRisk` string; without it the agent throws
`RedactionConfigError("Secret redaction disabled requires explicit
acknowledgedRisk string. Refusing to start.")` and refuses to start —
mid-turn opt-out is impossible.

When disabled, every turn's `<system-reminder>` carries a single line
`Secret redaction DISABLED. Reason: <ack>` so the model is never
silently unprotected.

## Consequences

- **Positive**
  - One SoT (`src/security/redaction.ts`) for every content-plane
    boundary; no per-call-site copy-paste of regexes.
  - Closed discriminated enum + exhaustive switch makes adding a kind
    a one-line type-checked operation.
  - `AgentOutcome.redactions[]` gives surfaces a stable audit channel —
    "N secrets hidden" is a one-line render, not a transcript scan.
  - Default-ON; the disable path is loud (per-turn banner + ack
    requirement + outcome.redactions rollup that surfaces
    `enabled-but-no-hits` vs `disabled-with-ack`).

- **Negative**
  - Tools that return ≥20 base64 alphanumeric of legitimate non-secret
    data (e.g. a SHA hash list, a base64-encoded image, a JSON token
    that LOOKS like a key but is not one) may trip Layer-2. The
    `whitelist?: ReadonlyArray<RegExp>` opt-out is the structural
    escape valve; the false-positive test battery documents the
    common-prose patterns that must pass through.
  - Layer-2 is O(text × patterns); for now patterns are run linearly
    (14 regexes). At the largest current `tool_result` (≤4 KB
    `stderrTail`) the cost is < 1 ms — measured. If a future format
    requires backtracking we'll switch to a unified RE2-style scanner.

- **Deliberate non-goals**
  - This ADR does NOT redact the conversation buffer the loop returns
    to the host on `AgentOutcome.messages` — host UIs and state-resume
    expect the live transcript. The redaction is on the content-plane
    boundaries (model, disk, distill); the in-memory buffer stays
    canonical so a resume after redaction-config flip is consistent.
  - This ADR does NOT introduce confidence scoring or thresholds. A
    pattern either matches or doesn't.

## Implementation

### New files
- `src/security/redaction.ts` — `redactSecrets`, `RedactionKind`,
  `RedactionHit`, `RedactionOrigin`, `RedactResult`.
- `src/security/sensitivity-classifier.ts` — `SensitivityClass`,
  `classifyPath`, `classifyCommandShape`.
- `src/security/redaction-config.ts` — `RedactionConfig`,
  `normalizeRedactionConfig`, `RedactionConfigError`,
  `REDACTION_DISABLED_WITHOUT_ACK_MESSAGE`.
- `src/security/index.ts` — barrel.

### Modified files
- `src/agent/types.ts` — `AgentConfig.redaction?:`, `AgentOutcome.
  redactions?:`, `RedactionRollup` interface.
- `src/agent/dispatch.ts` — Layer-1 derivation
  (`deriveSourceClass`) + `applyRedaction` over the result text in
  `execute()`. Attaches `DispatchResult.redactionHits`.
- `src/agent/dispatch-types.ts` — `DispatchResult.redactionHits?:`.
- `src/agent/streaming-dispatch.ts` — `DispatchOutcome.
  redactionHits?:`.
- `src/agent/loop.ts` — `normalizeRedactionConfig` at startup,
  `RedactionAggregator`, dispatch-side aggregation, pre-persist
  envelope-jsonl pass, rollup on outcome, `redactionDisabledReason`
  threaded into `prepareTurnContext`.
- `src/agent/memory.ts` — `PersistDeps` carries
  `redactionDisabled` / `redactionWhitelist` / `onRedactionHits`.
- `src/agent/memory-distill.ts` — `DistillOptions` extended; serializes,
  redacts, then prompts the model.
- `src/agent/prompt.ts` — `TurnContextInput.redactionDisabledReason?:`
  renders a `<system-reminder>` line.
- `tsconfig.json` — `@/security` / `@/security/*` path aliases.

### Tests
- `tests/unit/security/redaction-patterns.test.ts` — 23 cases (one per
  `RedactionKind` + determinism + whitelist + PEM-eats-embedded).
- `tests/unit/security/redaction-false-positive.test.ts` — 11 cases
  for prose / identifiers / regex-literals that must pass through.
- `tests/unit/security/sensitivity-classifier.test.ts` — 19 cases for
  path / command-shape rules.
- `tests/unit/security/redaction-config.test.ts` — 6 cases for the
  startup contract.
- `tests/integration/redaction-three-application-points.test.ts` — 6
  cases asserting all 3 points + the opt-out contract.

## Verification

- `bun run typecheck` — no new errors (3 pre-existing in
  `src/apps/cli/index.ts` / `internal.ts` are untouched).
- `bun test tests/unit/security/` — 59 pass / 0 fail.
- `bun test tests/integration/redaction-three-application-points.
  test.ts` — 6 pass / 0 fail.
- `bun test tests/unit/agent tests/integration/agent-{features,memory,
  memory-e2e,loop,abort,recovery-e2e}.test.ts` — 301 pass / 0 fail
  (no regression).
