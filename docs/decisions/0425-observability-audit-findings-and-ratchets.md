# ADR-0425 — Observability stack audit (3-round, adversarial) findings + structural ratchets

**Status:** Accepted (2026-05-29)
**Type:** Audit closeout + discipline ADR — captures structural decisions, no new product code.
**Scope:** Waves 1–5 observability stack (ADR-0394/0395/0396/0400/0401/0402/0403/0404/0406/0407/0408/0409/0415/0416/0417/0419/0420/0421) + the effort-classifier and fast-apply consumer wires that landed on top.

## Context

The observability stack reached "end-to-end live" after Wave 5 (ADR-0420 served-WebSocket sink) and the effort/fast-apply consumer wires. The stack was test-green per-slice, but it had never been adversarially probed as a whole — the kind of cross-cutting check that turns up dead seams, NO-THROW gaps, banner drift between tools and matchers, and unbounded internal state.

This ADR captures the audit, the resulting structural fixes, the two design decisions that were CONFIRMED (not bugs), and the ratchets installed to prevent the same classes from recurring.

## The audit

Three rounds, deliberately layered:

- **Round 1 (4 lenses):** correctness/integration (effort+fast-apply), observability lifecycle (HookBus / WS sink / emitter), test coverage + dead-seam grep, cross-cutting hygiene (ADR↔code, fc validate, gates, slice-fence, committed-vs-uncommitted drift).
- **Round 2 (3 adversarial lenses):** actively refute the Round-1 HIGH findings (could they be wrong?), malicious input (line-injection / spoofing / cap exhaustion), concurrency + resource lifecycle (timer leaks, handler accumulation, store growth, retry recursion).
- **Round 3 (synthesis):** re-verify each surviving finding against the moving working tree, classify contested-vs-safe, produce a fix recipe. (The Round-3 agent dropped to a transient API socket error and was salvaged on `main` per ADR-0389 rather than retried.)

## Findings and resolutions

| Sev | Finding | Resolution (commit) |
|---|---|---|
| **HIGH** | F1 ADR-0409 `post_compact` DEAD — neither `maybeCompact` nor `reactiveCompact` threaded the emit/Objective bridge into `compactIfNeeded` | `3e15001d` — new `buildPostCompactEmit(hooks, threadId)` helper; proactive site threads four callbacks under `exactOptionalPropertyTypes`; reactive site emits inline (NO-THROW) with `reason:"ptl_reactive"` |
| MED | F2 mailbox `renderMessage` line-injection — body newlines forge fake `victim→root [response]` lines | `1510d80d` — `escapeBodyForLine` collapses `\r\n|\r|\n` → literal `\n`; +1 hellgate |
| MED | F3-asm approval `requests` Map monotonic growth | `156d768b` — `maxRetained` default 1024 + LRU evict in `store()` (settle-later triggers); pending never evicted; +2 hellgate |
| MED | F3-obj objective `successCriteria` / `blockers` unbounded | `a7eb0d8c` — `MAX_CRITERIA_PER_OBJECTIVE=256` + `MAX_BLOCKERS_PER_OBJECTIVE=64`; +2 hellgate |
| P1 | F5 effort keyword identifier/path false positives (`myUltrathinkVariable` triggered escalation) | `85406bdb` — `\b…\b` anchors; +2 hellgate (negative identifier + positive control) |
| MED | F6 attribution banner literal-anchor drift risk | `27c85264` — 4 cross-module banner-pin tests (bash bg/await/kill + subagent launch) |
| MED | F7 real-`HookBus` e2e never proven (existing tests used a fake) | `eaa58e73` — 3 e2e tests through the production `HookBus` class |
| ops | fc validate blocked by stale ADR-0418 mention-runner evidence paths | `1b73588b` — propagate `runner.ts`→`default-resolver.ts` rename, rebuild catalog |

## Decisions CONFIRMED (not bugs)

Two adversarial findings turned out to be intentional design choices and are documented here so the next reader doesn't re-litigate:

1. **Effort classifier reset is session-scope (compaction-only).** The store's docstring explicitly says "session-accumulated state". The classifier is an escalate-only floor; the natural reset point is compaction (`wm.replace(...)`), not turn boundaries. A host running without compaction is expected to call `reset()` itself at turn endings if it wants per-turn semantics. We marked this `// UNBOUNDED: …` in the store so the bounded-store ratchet (G2 below) recognises the intentional opt-out.
2. **RunLedger `running`/`waiting` entries are never evicted by design.** The LRU is settled-only, mirroring `TaskRegistry`'s "active never evicted" intent — an unresolved long-running task must stay observable until it settles. A long-lived session that starts entries without settling will grow; that is the documented trade-off, not a leak to fix.

## Structural ratchets (`tests/unit/observability-audit-ratchet.test.ts`)

Three read-only file scans that block the same CLASS of bug from recurring, not just the specific instance:

- **G1 (F1-class):** `src/agent/loop.ts` MUST contain all four `post_compact` wire markers (`buildPostCompactEmit(`, `type: "post_compact"`, `recoveryReason:`, `objectiveSetNextActions`). A refactor that drops any one resurrects F1.
- **G2 (F3-class):** every `src/agent/<slice>/store.ts` MUST be bounded (`maxRetained` / `MAX_*` / `evictIfOverCap`) OR carry an explicit `// UNBOUNDED: <reason>` comment. A new unbounded store added without either fails CI immediately.
- **G3 (F6-class):** every literal anchor inside `run-ledger-attribution/matchers.ts` (`startsWith` / `.test`) MUST appear verbatim in `src/tool/**` or `src/subagent/**`. New banners are auto-discovered — the ratchet does not need updating when a banner is added.

The ratchets are ~10 ms each and run on every CI pass.

## Discipline (audit pattern, reusable)

For any future "structurally probe a stack" pass:

1. **3 rounds, layered.** R1 = correctness lenses (parallel). R2 = adversarial refutation + malicious input + concurrency (parallel). R3 = synthesis against the current tree, classify contested-vs-safe, produce recipes.
2. **Adversarial = try to PROVE EACH FINDING WRONG.** A finding that survives a refutation pass is worth fixing; a finding that gets refuted saves a regression-fix.
3. **Bank clean units immediately** under API instability (per the prior Wave-4 lesson, [[may-28-wave-4-live-wire-mailbox-effort]]).
4. **Salvage on main, do not retry** when an audit agent dies to API socket errors (ADR-0389). The main session has the context loaded; the agent does not.
5. **Confirm vs change.** If a finding's "fix" would alter intended design, document the intent (docstring + `UNBOUNDED:` style markers) rather than silently changing behaviour. Two of this audit's findings turned out to be design, not defects.
6. **Ratchet the class, not the instance.** A grep-based scan that catches the FAMILY of bug (e.g. "every store either caps or opts out") survives the next refactor; an instance-only test does not.

## Non-goals

- Net-new product features (this is a closeout).
- Changing the design decisions captured under "CONFIRMED" above — re-opening either requires its own ADR.

## References

- [[may-29-audit-3r-fix-pass]] (memory) — process notes + verbatim verdict table.
- ADR-0389 — worktree-agent API-instability retry harness (the salvage discipline used in R3).
- ADR-0371 — worktree-HEAD staleness preamble (the dispatch discipline R1/R2 followed).
- ADR-0409 — compaction-visibility (the dead-wire fixed under F1).
- ADR-0401 — run-ledger attribution (the banner contract pinned under F6).
- ADR-0417 — effort-classifier + fast-apply ports (the consumer wires probed under F5 + the apply-wire under F1's sibling fix).
