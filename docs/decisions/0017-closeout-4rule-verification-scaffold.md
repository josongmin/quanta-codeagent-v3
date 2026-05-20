# ADR-0017 — Closeout: defended-claim 4-rule + VerificationCloseout scaffold

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 2

## Context

ADR-0013 added a single-line `CLOSEOUT_REMINDER` that compressed Codex's
CloseoutLens directives into one sentence. Codex
`response-assembly-and-closeout.md §5.2` defines the full **4-rule
defended-claim filter** that the LLM should walk over every claim in its
draft before emitting the final answer:

- **R1 Read-source** — if you did not read the surface, don't promote it to
  owner truth.
- **R2 Run-verify** — if you did not run verification, don't call the change
  green.
- **R3 Grep-proof** — grep hits are presence-only, not proof of
  `unused`/`complete`/`correct`.
- **R4 Stale-memory** — memory hints are routing, never proof.

`§5.3` defines the **VerificationCloseout** scaffold the LLM should attach
when verification was in scope. Codex names the fields `performed / rail /
verdict / failure_class / reason_if_skipped`; our in-prompt scaffold
renders them as `performed / rail / verdict / failure / skipped because`
for brevity — field semantics are identical, only the labels differ.

The single-line reminder did not articulate R1–R4 by name or require the
scaffold.

## Decision

Extend `src/agent/closeout-guard.ts` with a NEW constant
`CLOSEOUT_4RULE_REMINDER` that names R1–R4 verbatim AND cues the
VerificationCloseout scaffold from the system prompt (Phase 1). The legacy
`CLOSEOUT_REMINDER` one-liner is preserved for backward compatibility.

Selection is controlled by a new flag on `AgentConfig.closeoutGuard`:

```ts
closeoutGuard?: { enabled?: boolean; fourRule?: boolean }
```

- `enabled: true, fourRule: undefined | false` → legacy one-liner.
- `enabled: true, fourRule: true` → 4-rule checklist.
- `enabled: undefined | { enabled: false }` → guard OFF, byte-identical.

Single-shot semantics (one nudge per run) are preserved.

## Mechanism

Pure policy module — no I/O, no LLM, no imports beyond the sibling
`./types`. The `closeout-guard module purity` test enforces this contract
in CI.

Routing precedence inside `decideCloseoutGuard` (after the existing OFF /
single-shot short-circuits):

```ts
if (isCodeModificationSession(args.history)) {
  return { block: true, text: CODE_MOD_CLOSEOUT_REMINDER }
}
const text = cfg.fourRule === true ? CLOSEOUT_4RULE_REMINDER : CLOSEOUT_REMINDER
```

So the full precedence is:

1. code-modification session (any history entry names a mutating tool —
   `edit` / `write` / `scripted_replace`) ⇒ **Phase 4 four-truth-surface
   reminder** (`CODE_MOD_CLOSEOUT_REMINDER`). This takes precedence over
   `fourRule` because a code change has a stricter post-condition contract
   (type/owner/wire/test) than a general defended-claim closeout.
2. else, `cfg.fourRule === true` ⇒ `CLOSEOUT_4RULE_REMINDER` (R1–R4 +
   VerificationCloseout cue).
3. else ⇒ legacy one-liner `CLOSEOUT_REMINDER`.

The `history` parameter is duck-typed inline as `ReadonlyArray<{name:
string}>` so the module stays import-free. The agent loop's existing
`toolHistory` array (originally built only for `verifyGuard`) is now also
built when `closeoutGuard.enabled === true` and threaded through to
`decideCloseoutGuard`.

## Consequences

- Workloads that need the stricter discipline (SWE-bench, audit-mode runs,
  reviews of risky code) opt in by setting `fourRule: true`.
- All existing callers with `closeoutGuard: { enabled: true }` continue to
  receive the one-liner — no behavior change.
- The VerificationCloseout scaffold cue in the 4-rule reminder matches the
  scaffold defined in Phase 1's `buildSystemPrompt`, so the model sees one
  consistent verification-report shape.

## Tests

- `tests/unit/closeout-guard.test.ts`:
  - `(6)` fourRule:true blocks with 4-rule checklist.
  - `(7)` fourRule:false keeps legacy one-liner.
  - `(8)` fourRule mode is still single-shot per run.
  - `(9)` `CLOSEOUT_4RULE_REMINDER` names R1–R4 + scaffold fields.
- `closeout-guard module purity` (existing) — unchanged, still passes.

## References

- Codex `response-assembly-and-closeout.md §5.2` (defended-claim 4-rule).
- Codex `response-assembly-and-closeout.md §5.3` (VerificationCloseout
  scaffold).
- ADR-0013 (verify-guard; runs BEFORE closeout-guard so verification
  evidence exists when the 4-rule walk happens).
