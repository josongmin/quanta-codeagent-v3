# Codex 5059 absorption — execution ticket index

- **Date:** 2026-07-13
- **Status:** TRIAGED; implementation not started
- **Design inputs:** `docs/plans/jul-13-codex-5059-absorption.md` and `docs/plans/jul-13-codex-absorption/01..05`
- **Rule:** this index is the execution/status SSOT. The plan documents retain design evidence; when classifications differ, this index wins.
- **Effort:** XS (<0.5 day), S (about 1 day), M (2–3 days), L (1 week+)

## Current-head corrections

1. `code_mode` is landed behind `QUANTA_CODE_MODE`; rebuilding the runtime is prohibited.
2. `fork_turns` core logic is landed, but the strict 6-tool `SpawnAgentInputSchema` rejects the field. This is an activation gap, not zero delta.
3. terminal subagents release the registry concurrency slot immediately. Keep that policy; resource reaping remains the Jul-12 runtime-correctness R-lane's concern.
4. execpolicy amendment is deliberately rejected unless a concrete cross-session approval pain reopens it.
5. compaction has richer local triggers, but not a durable, versioned context projection over a canonical session log.

## Queue

| ID | Ticket | Class | Phase | Effort | State |
|---|---|---|---|---|---|
| C5059-01 | [Code-mode efficacy baseline](01-code-mode-efficacy-baseline.md) | MEASURE-FIRST | P0 | S | READY |
| C5059-04 | [Activate `fork_turns` on the 6-tool schema](04-fork-turns-schema-activation.md) | TRUE-GAP (activation) | P0 | XS | READY |
| C5059-05 | [Default-suppress unrequested delegation](05-delegation-default-suppression.md) | TRUE-GAP | P0 | S | READY |
| C5059-02 | [Bounded code-mode session store](02-code-mode-session-store.md) | TRUE-GAP | P1 | S/M | BLOCKED on C5059-01 |
| C5059-03 | [Exact code-mode output-token budget](03-code-mode-output-token-budget.md) | TRUE-GAP, exactness blocked | P1 | S/M | BLOCKED on tokenizer port + C5059-01 |
| C5059-06 | [Wall-clock and durable wait](06-wall-clock-durable-wait.md) | CONDITIONAL GAP | Backlog | M | NEED NOT PROVEN |
| C5059-07 | [Versioned compaction provenance](07-compaction-provenance.md) | CONDITIONAL GAP | Backlog | M/L | NEED NOT PROVEN |
| C5059-08 | [No-go / skip register](08-no-go-skip-register.md) | DECISIONS | none | 0 | CLOSED |

## Execution order

```text
P0: C5059-04 ─┐
              ├─ independent, may land separately
    C5059-05 ─┘

    C5059-01 ──▶ C5059-02
              └─▶ C5059-03 (also requires exact tokenizer port)

Conditional only:
    long-unattended-run evidence ─▶ C5059-06
    cross-resume context-drift evidence ─▶ C5059-07
```

## Shared closeout gate

- Re-audit `HEAD` and `git diff` before touching an owner surface.
- Default-OFF behavior remains byte-identical unless a ticket explicitly changes a prompt policy default.
- Proof must execute the behavior; source-grep-only tests are insufficient.
- Any model-authored code or delegated child action must still traverse the existing permission, HARD_DENY, plan-mode, and scope gates.
- Measure success, tokens, wall time, and failure modes separately. A latency win does not override a correctness or security regression.
- Update feature YAML and run `bun fc validate && bun fc build` only if implementation changes feature maturity or evidence.

