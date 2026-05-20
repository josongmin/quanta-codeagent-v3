# ADR-0016 — Prompt policy: claim ladder + trust ladder + budget + honesty rail

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 1

## Context

Codex `judgment-and-tool-usage-audit.md` and `response-assembly-and-closeout.md`
encode response-shaping policy that our system prompt did not articulate:

- A **claim ladder** (`FACT / INFERENCE / UNKNOWN`) that separates directly
  observed evidence from strong-but-undocumented inference and from honest
  gaps.
- A **trust ladder** ordering source/runtime above tests above docs/memory;
  grep hits are PRESENCE evidence only, never proof of "unused" or
  "complete".
- A **5-axis budget** (tool / read / edit / validation / parallelism) that
  forbids broad scans, unrequested heavy validation, and patch-thrash.
- A **4-rule honesty rail** that the closeout must satisfy (Phase 2 ties
  this to the closeout-guard).
- A **task-kind reporting shape** matrix (8 kinds) so the final answer
  matches the request shape.
- An explicit **9-layer policy stack** so the LLM knows which layer governs
  what (and that a user request cannot override L1–L5).

## Decision

Embed these directly in `buildSystemPrompt` (`src/agent/prompt.ts`) as
byte-stable static prose — never per-turn. The static prefix grows by ~80
lines but remains byte-identical across all turns of a session, so the
provider cache prefix still holds.

Insertions (in source order):

1. **Policy stack navigation aid** — labels L1–L9 with the non-bypass rule.
2. **Evidence discipline (claim ladder)** — FACT/INFERENCE/UNKNOWN with the
   "never present INFERENCE or UNKNOWN as FACT" anchor.
3. **Trust ladder** — primary/secondary/routing-hint tiers; grep-as-presence.
4. **Artifact-as-memory paragraph** (Phase 6 addition) — durable state lives
   in workspace files, memory recall is a routing hint.
5. **Budget discipline** — 5 axes with concrete anti-patterns named
   (`ls -R`, `rg --files`, broad scan, re-read).
6. **Honesty rail** — 4 rules: did-not-read / did-not-run / partial /
   weak-signal.
7. **Reporting shape table** — 8 task kinds mapped to answer shapes.
8. **Verification report scaffold** — `performed / rail / verdict / failure /
   skipped because`; matches Phase 2's `CLOSEOUT_4RULE_REMINDER` cue.

## Mechanism

Static prose. No per-turn variation. The cache lever (ADR-0004) is preserved:
the system prompt remains a byte-stable SystemBlock with `cache:true`, and
the per-turn `<system-reminder>` carries only the variable parts (date, cwd,
mode notice, repo rules, working state, memory hints, active skills).

## Consequences

- Provider-side prompt cache continues to hit on the prefix.
- The model now has a single canonical place to read what counts as evidence,
  what cannot be claimed, how to budget tools, and how to shape the final
  answer.
- Tests pin every absorption by stable concept match (lowercased), so
  rewording survives but deletion fails.
- Phase 2 (`CLOSEOUT_4RULE_REMINDER`) and Phase 6 (artifact-as-memory)
  reference the verbatim scaffold/paragraph in this prompt.

## Tests

- `tests/unit/prompt.test.ts` — new `describe("Codex-absorption guarantees
  are present (Phase 1)")` block: policy stack, claim ladder, trust ladder,
  5-axis budget, honesty rail, reporting shape, VerificationCloseout scaffold,
  4-truth-surface name list.

## References

- Codex `judgment-and-tool-usage-audit.md` §3, §5, §14.
- Codex `budget-management-audit.md` (5-axis).
- Codex `response-assembly-and-closeout.md` §5.4 (reporting shape table).
- Codex `prompt-and-policy-stack.md` (9-layer stack).
