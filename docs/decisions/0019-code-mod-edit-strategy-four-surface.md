# ADR-0019 — Code modification: edit-strategy hint + scripted_replace + 4-truth-surface closeout

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 4

## Context

Codex `agent-loop-deep-dive.md §7` defines three sub-loops the agent walks
during code modification:

1. **Owner-finding** — caller/type/test reverse-lookup to identify the file
   that OWNS the contract being changed.
2. **Edit-strategy state machine** — `patch` for stable+local context;
   `scripted_replace` for duplicated/bulk/unstable context. On patch context
   mismatch the model should SWITCH STRATEGIES, not retry the same patch.
3. **Surface-alignment** — after owner fix, walk the four truth surfaces
   (type / owner / wire / test) until no stale semantics remain.

Our v3 had:
- one `edit` tool (exact + fuzzy match), no `scripted_replace`;
- no strategy hint on patch failure — the model would often retry the same
  failing patch;
- no surface-alignment closeout — the model could declare a fix done while
  callers / tests still referenced the old contract.

## Decision

### A. Edit-strategy hint on mismatch
`src/tool/edit/index.ts` now appends a `Strategy hint:` block to every
failure path (not-found / multiple-match / fuzzy-fail). The hint carries:
- a `nextStrategy: scripted_replace | read_then_patch | ambiguous` token
  the LLM (or tooling) can grep;
- a one-line suggestion the LLM can act on.

Exit semantics unchanged: `ok:false` on failure, no structured payload
change (text output growth only).

### B. `scripted_replace` tool
`src/tool/scripted-replace.ts` — new default tool.
- Input: `{ file, pattern, replacement, count?, isRegex? }`.
- Literal substring by default; `isRegex:true` enables capture-group
  expansion (`$&`, `$1`–`$9`, `$$`).
- Count caps replacements; absent means "all".
- Atomic write via `@/storage`; FS-jail respected.
- `isReadOnly:false`, `isConcurrencySafe:false`.

### C. Code-modification closeout reminder
`src/agent/closeout-guard.ts` adds `CODE_MOD_CLOSEOUT_REMINDER` (new export
alongside the legacy `CLOSEOUT_REMINDER` and Phase-2's
`CLOSEOUT_4RULE_REMINDER` — does NOT replace them) and
`isCodeModificationSession(history)` (true iff any history entry names a
mutating tool — `edit`, `write`, `scripted_replace`).

The reminder names the four surfaces:

```
type  — signatures + exported types still align with all uses.
owner — the file that OWNS the changed contract is itself fixed.
wire  — every caller / import / config / wiring point matches.
test  — failing scenario passes AND nearest existing tests still pass.
```

The loop chooses which closeout reminder to inject (currently the existing
single/four-rule path; a future ADR may add code-mod-specific routing).

## Mechanism

- Closeout-guard module purity preserved: `isCodeModificationSession`
  duck-types `ToolHistoryEntry` as `ReadonlyArray<{name: string}>` inline,
  no `@/agent/loop` import. The module-purity test still passes.
- `scripted_replace` core (`applyScriptedReplace`) is a pure function over
  strings, separately unit-testable from the FS shell.

## Consequences

- The model has a structural signal to switch strategies after a patch
  failure (the hint), reducing patch-thrash loops the verify-guard could
  not catch.
- `scripted_replace` handles the cases the `edit` tool was being misused
  for (rename across N occurrences, bulk substitution, files whose context
  is unstable for line-precise patches).
- The 4-surface reminder gives Phase 6's working-state checklist a
  natural closeout hook for code-modification turns.

## Tests

- `tests/unit/scripted-replace.test.ts` — 22 tests: literal, count cap,
  regex with capture groups, file-missing, no-match, FS-jail.
- `tests/unit/edit-strategy-hint.test.ts` — 11 tests: hint appears on
  every failure path, no hint on success.
- `tests/unit/code-mod-closeout.test.ts` — 10 tests: detection over
  history, reminder names four surfaces.

## References

- Codex `agent-loop-deep-dive.md §7` (three sub-loops).
- Codex `tool-routing-and-triggering.md` (patch vs scripted_replace
  routing rule).
- Codex `execution-loop.md §2` (code-repair loop high-level).
