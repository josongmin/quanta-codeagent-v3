# May 31 Bugbash — Full Resolution Execution Plan

Companion to [README.md](README.md). The README defines **what** (Tracks A–H, tickets T01–T13, audit-ID coverage). This file defines **how to actually land all 13 tickets** end-to-end: wave order, parallelism, file-ownership deconfliction, proof gates, and the methodology guardrails that keep this from regressing into patch-on-patch.

Snapshot baseline: repo HEAD `57d78b8a`. Re-verify HEAD before every wave dispatch (see Guardrails §G1).

---

## Pre-flight verification result (done 2026-05-31)

The ticket plan was machine-checked against the audit docs before scheduling:

- All 92 `src/**` paths referenced by the tickets **exist on disk** (0 missing).
- Every audit ID cited by a ticket (`L1…L9`, 103 citations) **exists in the audit docs** (0 fabricated / mistyped).
- **0 contradictions**: no ID appears in both the solve set and the "Explicitly Not" exclusion list.

One open item must be resolved in **Wave 0** before any ticket dispatches.

### W0 gap reconciliation (blocking)

These audit IDs are *defined* in the audit docs but appear in **neither** a ticket/Tier row **nor** the explicit exclusion list. Each needs a one-line verdict — `carry into ticket Tnn` or `add to Explicitly-Not` — so no agent has to guess mid-flight:

| lane | unaccounted IDs | likely disposition (confirm, don't assume) |
|---|---|---|
| L1 | `M6` | exclusion list already names "L1 M6" in prose — fold the ID in formally |
| L2 | `H1 H2 H4 H5 H8`, `M2–M21` | README says "L2 M1-M21 is the biggest excluded pool"; the H-row L2 issues need an explicit verdict, not aggregate prose |
| L3 | `C-8 C-16 C-17 C-19 C-21` | `C-15/16/19/21` named in exclusions; `C-8`, `C-17` are unlisted — verdict needed |
| L5 | `H-6 H-9 M-4 M-7` | unlisted — verdict needed |
| L6 | `H5 H9 H10 M12 M13 M14` | `H9/H10/M12-14` named in exclusions; `H5` unlisted — verdict needed |
| L8 | `M3 M7` | unlisted — verdict needed |
| L9 | `H14 M5 M16` | `H14/M16` named in exclusions; `M5` unlisted — verdict needed |

W0 output = README updated so every defined audit ID is either in a ticket or in "Explicitly Not". Then the ticket set is closed and execution can start.

---

## Wave schedule

Strict dependency order from the README's Program Order, expressed as dispatch waves. **A wave does not start until the previous wave is cherry-picked to `main` and green** (gate below). This is load-bearing: T01's shared primitive must be on `main` before any consumer ticket branches, or consumers will re-create local timeout/abort helpers — exactly the patch-on-patch the plan forbids.

| wave | tickets | parallel agents | depends on | why this barrier |
|---|---|---|---|---|
| **W0** | gap reconciliation | 1 (no worktree) | — | close the ticket set |
| **W1** | **T01** Boundary Primitive Kit | 1 | W0 | foundation; every boundary ticket consumes it |
| **W2** | **T02**, **T03** | 2 | T01 on main | turn-integrity, highest live risk; consume T01 signal |
| **W3** | **T04**, **T05** | 2 | W2 | move invariants into owning stores before more boundary churn |
| **W4** | **T06**, **T07**, **T08** | 3 | W3 + T01 | live runtime / provider / permission boundaries |
| **W5** | **T09**, **T10**, **T11**, **T12** | 4 | W4 + T01 | large durability / boundary sweeps |
| **W6** | **T13** | 1 | T07 on main | SSOT cleanup; needs T07's canonical provider owner to exist first |

Critical-path length is 6 waves. Wall-clock is dominated by W4/W5 fan-out, not ticket count.

---

## File-ownership deconfliction

Only 4 files are touched by more than one ticket. All 4 resolve cleanly under the "fix at the owning seam, consumer doesn't re-touch" rule — enforce this so cherry-picks never collide:

| file | owner ticket | rule for the other ticket |
|---|---|---|
| `src/llm/provider-router.ts` | **T07** (defines canonical provider-metadata authority) | **T13** only deletes the duplicate body + re-points imports; never edits T07's authority logic |
| `src/mcp/transports/http-sse.ts` | **T01** (adopts the abort/deadline primitive) | **T12** consumes the primitive for SSE lifecycle; does not re-add its own timeout |
| `src/media/stt/deepgram-adapter.ts` | **T01** (primitive adoption: `fetchWithDeadline`) | **T09** consumes for drain/timeout; does not open-code a second wrapper |
| `src/media/stt/openai-whisper-adapter.ts` | **T01** | same as above |

Because the owner is always the *earlier* wave, the consumer always branches from a `main` that already has the owner's edit. No worktree sees a stale copy of a shared file.

---

## Per-ticket dispatch spec

Each ticket = **one worktree-isolated agent** (the established SOTA++ pattern), branch `bugbash/t<NN>-<slug>`. Agent prompt must carry: the ticket's Touch-files / Core-logic / DoD / Proof-rail verbatim, the relevant audit-doc excerpts (`docs/bugbash/may-31-gqlang-audit/<lane>/01-critical-high.md`), the staleness preamble (§G1), and the closed-port injection rule (§G3).

| ticket | branch | hellgate proof rail (must be green before cherry-pick) |
|---|---|---|
| T01 | `bugbash/t01-boundary-primitive` | cancelled eval / shadow-verify / STT / HTTP-SSE terminate underlying work; no `new AbortController().signal` placeholder on carried surfaces |
| T02 | `bugbash/t02-turn-authority` | refusal / budget / user-cancel / approval-pause all hit one closeout authority with identical transcript invariants (no orphan `tool_use`, observability flushed once) |
| T03 | `bugbash/t03-kernel-cancel-lease` | public cancel changes active turn deterministically; same-actionKey host concurrency does not share grants; `onCommitted` failure can't corrupt outcome |
| T04 | `bugbash/t04-plan-session-owner` | `todo.phaseId`↔`phase.todoIds` atomic on add/move/remove; append+cache-hit refresh liveness; `continue_from` rejects foreign task id |
| T05 | `bugbash/t05-memory-contract` | stage1 reuse can't double-bump usage; hostile logger/hook can't abort consolidation; async delete no sync-throw; context-event exhaustiveness fails compile when a kind is added |
| T06 | `bugbash/t06-search-cli-lifecycle` | invalid explicit `QUANTA_VECTOR_STORE` fails closed; no interval/handle/queue survives partial init; export digest stable + compensating |
| T07 | `bugbash/t07-realtime-llm-wire` | close idempotent under racing callbacks; replay/recorder/foundry/openai classify abort vs provider failure consistently; provider-metadata SSOT ratchet |
| T08 | `bugbash/t08-permission-failclosed` | protected-branch reset / lexical traversal / empty writable root / DXT path-escape all fail closed; persistence failure visible |
| T09 | `bugbash/t09-boundary-io` | Lima no injectable shell assembly; watcher brace-expansion bounded; OTel exporter bounded under sustained failure; whisper/STT drain+timeout |
| T10 | `bugbash/t10-scheduler` | one fire → at most one owned attempt; errored automations retry after restart; storage failure can't mark work complete |
| T11 | `bugbash/t11-persistence` | connector outage ≠ empty catalog; custom-3p / shadow-ODB / import-log recover after crash window; size-cap holds on error |
| T12 | `bugbash/t12-github-mcp-ipc` | review/comment dedup survives restart; skybridge can't report `sandboxApplied:true` when policy dropped; stdio version-mismatch can't hang bridge |
| T13 | `bugbash/t13-ssot-consolidation` | one owner each for provider metadata + conflict parsing; import-fence / exact-zero ratchet blocks re-divergence |

---

## Per-wave integration gate

After a wave's agents finish, integrate and gate before opening the next wave:

1. **Cherry-pick** each ticket branch onto `main`. Use `-X theirs` only where the branch is a deliberate superset of an in-flight main change; resolve real conflicts by hand. Confirm each pick is non-empty (empty pick = already on main, investigate).
2. **Gate commands** (all must pass):
   - `bun run typecheck` → src tsc **0 errors**
   - `bun run lint` → biome **0 errors** (wrt the touched slices)
   - `bun test tests/unit tests/integration` → **0 fail** (full suite; the wave's new hellgates included)
   - the wave's named hellgates green (table above)
   - `bun run smoke` → tier-0 replay battery **0 regression**
   - `bun run fc build` if any feature-catalog YAML was added
3. **ADR**: each ticket lands its ADR under `docs/decisions/`. On number collision with a user in-flight ADR, **renumber ours** to next-free and fix cross-refs (user-deference policy).
4. Only when green: dispatch the next wave (agents branch from the now-updated `main`).

Do not claim closeout on a track without its owning proof rail green (README Do-Not-Do list).

---

## Guardrails (carry into every agent prompt)

- **G1 — Staleness preamble.** Every worktree agent prompt opens with: 🛑 verify `git HEAD` == current `main`, `git fetch`/ff if behind, before editing. (Three prior incidents of stale-worktree work loss.)
- **G2 — Owning-seam discipline.** Fix the contract, not the last visible caller. No new local boolean/timeout/no-throw fork when the concern is cross-cutting — consume the shared primitive (T01) or the owning store (T04/T05/T07). If the same bug exists via two adapters, the port is wrong.
- **G3 — Closed-port injection.** New ports inject all dependencies; no hidden globals. Default-OFF seam where behavior changes, so a half-landed ticket is dead code, not a live regression.
- **G4 — Hellgate-first (TDD).** Write the proof-rail hellgate first (red), then implement to green. The hellgate is the closeout criterion, not an afterthought.
- **G5 — No patch-on-patch.** Per ticket's "Patch-on-patch to avoid" list is binding. Reviewer rejects any per-branch `wm.append`, inline `try/catch {}`, `.catch(()=>undefined)`, duplicate timeout wrapper, or "keep both copies in sync" comment.
- **G6 — In-flight isolation.** The user may have uncommitted work (current `git status` shows lance-store / search-pipeline edits). Agents touch only their ticket's files; never `git add -u`, never sweep unrelated changes into a ticket commit.

---

## Recommended kickoff

1. Do **W0** now (single edit pass on README to close the gap table) — cheap, unblocks everything.
2. Dispatch **W1 / T01** as one worktree agent. Gate.
3. Proceed wave by wave. W4 and W5 are the only multi-agent fan-outs (3 and 4 agents).

Total: 13 implementation agents across 6 sequenced waves + 1 reconciliation pass, ~6 integration gates.
