# `tests/integration/agent-loop-bugbash/` — ALBB-24 behavioral proof rail

Named, **red-on-injection** hellgates for the jul-9 agent-loop bug-bash
(Wave A/B/C) fixes. ALBB-24 is a *proof-pinning* ticket: it does **not** change
production behavior — it gives each landed fix an executable proof so a re-inline
OR a silent behavior regression both fail loudly.

This is the **behavioral** companion to the **structural** facade guard
`tests/unit/agent/loop-decomposition-hellgate.test.ts` (which stays purely
structural — `readFileSync` + `toContain`/`not.toMatch` over `loop.ts`; it never
invokes `runAgent`). A structural guard is necessary but not sufficient; each
behavioral contract also gets its own effect-observing proof.

Every test embeds its ALBB id in the `describe`, arranges the minimum slice that
exercises the seam, asserts observable EFFECTS (not "it runs"), pairs each pin
with a control, and is validated by a transient src mutation that must turn it
RED (documented in each file's header).

## Files owned by this namespace

| ALBB id | File | Seam pinned | Mutation that reds it |
|---------|------|-------------|-----------------------|
| ALBB-24 | `createStreamDispatcher-seams.test.ts` | `createStreamDispatcher` (`src/agent/stream-callbacks.ts`) DENY short-circuit — a denied tool (skill-scope v2 OFF) short-circuits via `skillScopeDeny` and NEVER dispatches (spy counter stays 0); returned block is the `skill-scoped` deny shape. Paired controls: allow-gate + no-gate both dispatch (counter 1). | Remove the `scoped ??` short-circuit (`stream-callbacks.ts` ~L355) ⇒ denied tool dispatches ⇒ counter 1 ⇒ RED. |
| ALBB-24 | `createStreamDispatcher-seams.test.ts` | `patchHistoryOutcome` history back-patch — a matching `toolHistory` slot's `ok`/`output` are back-patched after dispatch; unrelated slots untouched; `toolHistory === undefined` is a no-throw no-op. | Delete the two `slot.ok`/`slot.output` writes (`stream-callbacks.ts:150-152`) ⇒ slot stays pre-dispatch ⇒ RED. |
| ALBB-24 / ALBB-08 | `applyProactiveResult-strike.test.ts` | Proactive-compaction STRIKE result-branch (`src/agent/loop/compaction-wire.ts:469-478`) — `no_boundary` AND `empty_summary` each record one no-progress proactive strike (`recordProactive(before, before)`); a productive compaction resets strikes + emits `compaction_event` + `context_compacted` + appends one archive entry. | Revert the strike (`compaction-wire.ts:477`) OR re-narrow the guard to `reason === "no_boundary"` only ⇒ `empty_summary` (and, for the strike revert, `no_boundary` too) reads `strikes.proactive === 0` ⇒ RED. This closes the branch the sibling THROW-branch test (`src/agent/loop/__tests__/proactive-compact-failure-breaker.test.ts`) does NOT cover. |

> ALBB-08 note: the `empty_summary` strike is the SHIPPED fix (Wave A) — an
> `empty_summary` proactive result now accrues a proactive strike via the SSOT
> set `UNPRODUCTIVE_PROACTIVE_REASONS = {no_boundary, empty_summary}`
> (`src/agent/compaction.ts`). The ticket's earlier "open question" about
> `empty_summary` recording no strike is therefore RESOLVED and pinned GREEN
> here, not re-opened.

## Sibling ALBB proofs (landed in their own owner tickets)

These bug-bash fixes ship their own named red-on-injection tests outside this
directory; ALBB-24 tracks them but does not duplicate them (measure-first: only
assert what a fix actually ships). CI runs both slices together (below).

| ALBB id | Test file |
|---------|-----------|
| ALBB-03 (content_filtered default proceed) | `tests/integration/content-filtered-default-e2e.test.ts` |
| ALBB-06 (interrupted-turn signal abort) | `tests/integration/interrupted-turn-signal-abort.test.ts` |
| ALBB-07 (objective-budget / PTL salvage) | `tests/unit/agent/albb-07-objective-budget-fail-closed.test.ts`, `tests/unit/agent/albb-07-ptl-salvage-activemodel.test.ts` |
| ALBB-10 (persistence save emit) | `tests/unit/agent/albb-10-persistence-save-emit.test.ts` |
| ALBB-11 (allowlistEscalated comp-root HITL wiring) | `tests/unit/albb-11-comproot-hitl-wiring.test.ts` |
| ALBB-12 (SDK optional-ports parity) | `tests/unit/sdk/embed-optional-ports-parity.test.ts` |
| ALBB-14 (automation wire) | `tests/integration/albb-14-automation-wire.test.ts` |
| ALBB-19 (compaction/system parity) | `tests/unit/agent/albb-19-compaction-system-parity.test.ts` |

## CI slice

```sh
# behavioral namespace + per-ticket named units
bun test tests/integration/agent-loop-bugbash tests/unit/agent/albb-*
# structural facade guard (kept structural — do NOT bloat with behavior)
bun test tests/unit/agent/loop-decomposition-hellgate.test.ts
# the sibling that pins the proactive THROW branch (distinct from our result branch)
bun test src/agent/loop/__tests__/proactive-compact-failure-breaker.test.ts
```
