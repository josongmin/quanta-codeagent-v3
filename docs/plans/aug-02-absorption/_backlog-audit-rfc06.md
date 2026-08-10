# RFC-06 backlog audit vs CURRENT code (aug-10)

**Basis:** `main` HEAD (post concurrent-session landing). README RFC-06 row + `rfc-06-worktree-review-ux.md` Status line ("B3 DESIGN FIRST; B5 ANCHOR FIRST; A4.3 PRODUCER GAP; B4 DESIGN FIRST. Not yet implemented.") are **STALE** — RFC06-1/2/3 and RFC06-4 (B5) have since landed. This audit corrects the record against live code. Read-only; no source modified.

Method: 2-round multi-angle grounded in current code. R1 = existence/wiring (grep + file:line). R2 = adversarial refute (real+wired+gated, state-machine actually fires, lineage-gate load-bearing).

Landing commits observed: `c91830a29` RFC06-1 porcelain inspector + hardened remove · `a57b78cd9`/`9d25f80f2`/`2d972d09f` RFC06-2 current-thread transition + activity + reconcile-target · `4a0583cd4` RFC06-3 operator GC · `d734c767d` RFC06-4 CAS undo journal · `30ff1d9c4` `/undo` surface · `458cdad74` RFC-12 Surface B anchored review producer · `8cfc35275` legacy-fork salvage notice.

---

## B3 — worktree USER mode (current-thread switch + persisted ownership/lifecycle + activity)

**Verdict: ALREADY-BUILT (RFC06-0/1/2/3), with two genuine residual gaps.** Was "DESIGN FIRST / L".

Evidence (real + wired + gated):
- **Persisted ownership + closed 6-state machine.** `src/session/types.ts:91,102-109` `SessionMeta.workspaceOwnership` + `WorkspaceOwnershipState = creating|ready|active|closing|removed|failed|quarantined`. State machine `src/session/workspace-ownership.ts:47-63` `ALLOWED_TRANSITIONS` (terminal states have no outgoing edge; self-transition rejected `:104-107`), zod-closed enum `:116` (unknown wire value fail-closes the load).
- **Current-thread transition transaction.** `src/runner/session-ops/current-thread-worktree.ts:202` `transitionThreadToWorktree` — persists `creating` INTENT before the git effect (`:254`), runs the KEPT create owner `createPersistentWorktree` (`:265`), publishes `creating→ready` + cwd in one write (`:296-304`), cleans the SAFE exact target on git failure (`:278`). One-owner-per-thread reject at `:214-222`. NEVER throws.
- **CLI-wired + live activity producer.** `src/runner/session-ops/index.ts:842` `cmdWorktree`, registered `case "worktree"` at `:948` — i.e. `quanta session worktree <id> [--branch]` is a real subcommand. Activity store is threaded live from the REPL composition root (`src/apps/cli/repl.ts:155` `activityStore: createActivityStore()`), and the transition emits correlated `running→done|failed` nodes (`current-thread-worktree.ts:81-110`, `index.ts:872-897`). This is the FIRST real operation-correlated activity producer.
- **cwd pin follower wired to the turn loop.** `src/runner/orchestrate/worktree-cwd-pin-wire.ts:74` `pinTurnBoundaryCwd`, called at turn start by `src/runner/orchestrate/session-turn-driver.ts:154`. Gated `QUANTA_WORKTREE_CWD_PIN` (default-OFF ⇒ no load, byte-identical). Pins only `ready`/`active` (`workspace-ownership.ts:93-99`), at turn boundary never mid-turn.
- **Hardened remove owner (RFC06-1).** `src/runtime/worktree-fork.ts:233` `removeWorktree` — porcelain-exact match, `locked`⇒refused, dirty⇒refused, git-status error⇒fail-closed `error`, DEFAULT non-force remove, non-zero exit⇒`refused:"remove_failed"` (never coerced), branch delete a separate post-remove step. The old unconditional `--force` is now isolated to `forceRemoveWorktree` (`:303`) for the eval/throwaway lifecycle ONLY, documented distinct from the user path.
- **Porcelain read adapter (RFC06-1).** `src/runtime/worktree-inspect.ts:189` `inspectWorktrees` returns typed `InspectResult` — a git non-zero exit is an explicit `{ok:false}`, NOT coerced to empty (so a caller can't misread "git failed" as "no worktrees ⇒ safe to remove"). Pure parser `parseWorktreePorcelain:133` unit-testable without a subprocess.

R2 adversarial (refute "ALREADY-BUILT"):
- **Real, not a dead seam** — the transition has a production caller (`index.ts:832` "FIRST production caller"), CLI registration, and a live activity store. Not a library-only stub.
- **GAP-1 (crash reconciliation UNWIRED).** `reconcileCreatingWorktree` (`current-thread-worktree.ts:334`) is a complete, correct restart-reconciler (registered⇒promote_ready, absent⇒mark_failed, registry-unreadable⇒quarantine, matched by ownershipId-derived slug path so branch drift can't orphan). **But it has ZERO production caller** — grep finds it only in a comment. A crash between intent-persist (step 1) and ready-publish (step 3) leaves a durable `creating` record that NOTHING reconciles at restart. The machinery exists; the restart hook is missing. **ROI: HIGH-for-safety, LOW-effort** (one call at session-load/resume; the reconciler is pure and returns the transitioned record for the caller to persist).
- **GAP-2 (legacy leaked dirs never reported).** GC (`worktree-gc.ts`) only classifies records that HAVE `workspaceOwnership` (`collectOwnedWorktrees:150-162` skips any session without it). The ~53 leaked `.claude/worktrees/agent-*` dirs have no ownership record ⇒ they are invisible to `worktree gc --dry-run`. RFC intent = "salvage report only, elsewhere"; a salvage NOTICE exists only for legacy-fork *session delete* (`index.ts:655,664-671`), not a standalone operator inventory of the 53 orphans. **ROI: MED** (a read-only `worktree salvage` that lists porcelain entries with NO owning session — dirty/locked/unique-commit — no delete, matches the RFC "report-only, no PID inference, no auto-delete" stop rule).

**Reaper-safety note (matches the RFC mandate):** the design correctly has NO autonomous reaper / no `--force` / no TTL/PID inference. GC removes only `eligible` (registered+clean+unlocked+branch-matched) with a TOCTOU recheck (`worktree-gc.ts:225-253`); dirty/locked/moved/quarantined are report-only. This is already the "dirty/unowned no-delete" posture the prompt asked to verify — it is present and load-bearing.

---

## B5 — inline review comments + per-hunk apply/reapply/revert + CAS undo journal

**Verdict: ALREADY-BUILT (RFC06-4 + RFC-12 Surface B).** Was "ANCHOR FIRST / M-L, not yet implemented" — STALE.

Evidence (real + wired + gated):
- **CAS undo journal.** `src/runner/hunk-mutation-journal.ts` — `HunkMutationReceipt {originalBefore(+Hash), proposedAfter(+Hash), expectedCurrentHash, appliedHunks, state}` (`:34-55`). `applyHunkSelectionWithReceipt:106` calls the SINGLE apply owner `applyHunkSelection` exactly once, persists the receipt only AFTER `applied` (no success-before-effect `:116,133`). `undoHunkMutation:152` = CAS gate on `sha256Hex(currentDisk) === expectedCurrentHash` (`:173`), refuses on drift with ZERO write (`:174`), reverts via the SAME engine (current→originalBefore, `:178-184`) — never treats current disk as a new baseline. Double-revert fail-closed (`:160-163`). Durable store reuses the existing atomic writer (`makeDurableJournalStore:246`), no new ODB.
- **Anchored comments.** `src/tool/git/review-anchor.ts:46` `validateAnchoredFinding` — a finding is actionable ONLY when `beforeHash/afterHash` match `sha256Hex(ctx.before/after)` (`:58`) AND `hunkId ∈ splitHunks(before,after)` (`:61`); else non-actionable (dropped, honest anchoring). `ReviewCommentAnchor` on `ReviewFinding` at `src/tool/git/review-diff.ts:93-110`.
- **Wired across surfaces.** CLI: `/undo` (`src/apps/cli/undo-cmd.ts`, registered `src/apps/cli/slash/registry-app.ts:30`), per-hunk apply flow `src/apps/cli/repl/cli-hunk-select-flow.ts:72-86` wraps apply with the journal when the gate is on AND a store is wired; durable store threaded at `src/apps/cli/repl/runtime-context-compose.ts:91,488`. Web: canvas anchored-finding producer `src/tool/git/review-anchor-synth.ts` (re-validated through the SAME `validateAnchoredFinding` `:89`), `src/apps/web-daemon/canvas-tool-diff-source.ts:79`. Approval seam `src/host/runtime/internal/context-binding/approval-protocol.ts:158`.
- **Gated.** `QUANTA_HUNK_MUTATION_RECEIPT` + `QUANTA_HUNK_UNDO` (`src/shared/runtime-config.ts:335,339`; types `src/shared/runtime-config/types.ts:446,455`). OFF ⇒ `mutationJournal` field omitted ⇒ byte-identical (`runtime-context-compose.ts:477`).

R2 adversarial:
- **Undo-journal correctness is sound.** CAS is content-hash not path (`:173`), inverse goes through the one engine (no fuzzy relocation), `reverted` state blocks double-undo, malformed receipt file ⇒ `null` fail-closed (`:255-260`). The engine's own staleness gate re-fires inside the inverse apply (`hunk-apply.ts:102`) so an undo that loses a CAS race still refuses (`:185`).
- **Residual (minor).** The receipt stores `originalBefore`/`proposedAfter` full strings verbatim (`:40,44`) — fine for durability but unbounded for very large files; no size cap. Also no explicit "reapply a reverted hunk" command surfaced (the journal supports the data, `state` toggles applied/reverted, but only `/undo` is wired, not a forward `/redo`). **ROI: LOW** (reapply = re-run apply against current tree; the RFC scoped it, machinery is present, only a surface verb is missing).

---

## B4 — rich @-mentions (agent/mcp/skill/tab/conversation sources + lineage gate)

**Verdict: PARTIAL — mostly landed via a DIFFERENT RFC (RFC-12-2), with one load-bearing lineage GAP.** Was "M-L / DESIGN FIRST".

Evidence:
- **Enum grew to 10 kinds** (`src/agent/mention-injection/types.ts:74-84`): `skill|plugin|app|file|symbol|folder|git|mcp|subagent|thread`. The three new B4-shaped kinds (`mcp`, `subagent`, `thread`) landed under **RFC-12-2**, not RFC-06. `agent`≈`subagent`, `conversation`≈`thread`, `mcp` server present; `browser-tab` still absent.
- **Parser** colon-prefixed sigils matched before the generic `@`-cascade (`src/agent/mention-injection/parser.ts:120`): `@mcp:<name>`, `@subagent:<name>`, `@thread:<id>` — exactly the disambiguation the RFC-06 design prescribed.
- **Resolvers** `src/agent/plugin-app-resolver/{thread,subagent}-resolver.ts`, `resolveMcp?` (`resolver.ts:79`). Gated per-kind: `QUANTA_MENTION_MCP` / `QUANTA_MENTION_SUBAGENT` / `QUANTA_MENTION_THREAD` (default-ON kill-switches, `default-resolver.ts:232,244,251`) — but each requires its port wired at the host root (`src/host/runtime/internal/mention-source-deps.ts:142-154`); absent source ⇒ kind resolves `null` (byte-identical).
- **Autocomplete `list()`** still file+symbol(+kebab skill/plugin/app) only (`src/apps/cli/at-autocomplete/provider.ts:4-13`); the new kinds have resolvers but NO enumerator ⇒ `@thread:`/`@subagent:` don't appear in the dropdown (resolve-only, not list-able). Matches RFC-06 delta note.

R2 adversarial (lineage-gate LOAD-BEARING check — the jul-15 headline trap):
- **`@subagent` is lineage-SAFE by construction.** `subagent-resolver.ts:15-20` documents FOREIGN-LINEAGE SAFETY (RFC-07): the named-agent registry holds only repo-declared role definition files, never another task's live child roster ⇒ no cross-session child handle to leak. Verified: it resolves `NamedAgentResolver.resolve(target)` (`:54`), a repo-role lookup, not a task-id lookup.
- **`@thread` is NOT lineage-scoped — the genuine gap.** `src/host/runtime/internal/mention-source-deps.ts:120-135` `threadSummaryFor` resolves against `all = await sessions()` (the FULL `listSessions()`) with `all.find(m => m.id === id)` (`:127`). There is **no lineage/subtree predicate** anywhere in `mention-runner/` (grep for `lineage|sibling|scope|ensureLineage` = 0 hits). So `@thread:<any-session-id>` — including a sibling task OUTSIDE the caller's lineage — resolves to that session's summary. **Bounded to metadata** (title, id, cwd, gitBranch, threadSource — `thread-resolver.ts:63-70`), NOT the transcript, so the blast radius is smaller than the jul-15 sub-agents-panel transcript leak. But it IS cross-lineage enumeration of arbitrary session ids, default-ON when the port is wired, and the RFC-06 design explicitly called the lineage predicate "load-bearing, RED-tested with a sibling id." **That RED test / scope predicate does not exist.**
  - **Improvement / ROI: MED-HIGH (security).** Thread `threadSummaryFor` through the same `ensureLineageTask`/subtree predicate the sub-agents panel uses (jul-15), so `@thread:` resolves only within-lineage ids and returns `null`+redaction for out-of-subtree — and make the future `list()` enumerator scoped too (never suggest a sibling). Low code, closes a documented exfil class. Note the injection-defang side is partly covered (bodies are metadata-only for thread, and MCP bodies route through the existing envelope), but the enumeration scope is the missing guard.
- **`browser-tab` / true live-`agent` roster: GAP** (unbuilt, per surface-model the CLI would return "no tabs" gracefully). ROI: LOW (niche, needs a new ADR + browser surface owner).

---

## A4.3 — goal 6-state + budget coupling

**Verdict: ALREADY-BUILT (state machine), with the live-producer GAP the RFC named still open.** RFC said ALREADY-BUILT — confirmed for the machine; the RFC06-5 producer is NOT wired.

Evidence (state machine real + fires, not just types):
- **6-state closed set** `src/agent/objective/types.ts:43` `active|paused|usage_limited|budget_limited|completed|blocked` (Codex `goals.rs` parity).
- **Priority-ordered TOTAL derivation** `src/agent/objective/store.ts:94` `deriveStatus`: blocked > (enforce∧usage-window) > (enforce∧budget-exhausted `>=`) > completed > explicit. `budgetExhausted:68` exact `>=` predicate; `usageWindowActive:77` clock-derived auto-reset (equality = reset instant, no sticky flag).
- **Transition ACTUALLY FIRES (not just types).** `recordUsage` (via the model-facing objective tool `src/tool/objective/index.ts:265-269`) increments `cell.tokensUsed`; when `enforce && tokensUsed >= maxTokens`, `deriveStatus` returns `budget_limited`. Test-verified with red-on-injection: `tests/unit/objective-budget-enforce-e2e-hellgate.test.ts:184` asserts `status === "budget_limited"` with knob ON and continuation suppressed, and `:213` asserts `active` (never limited) with the knob OFF — the knob-toggle is the injection control. `derived` states can't be set directly (`store.ts:299-308` silent no-op). Gate `QUANTA_OBJECTIVE_BUDGET_ENFORCE`; default false ⇒ byte-identical to ADR-0394.

R2 adversarial:
- **Live producer GAP (RFC06-5).** `markUsageLimited` (`store.ts:311`) has **ZERO non-test caller** (grep: only the type decl `types.ts:134` + the impl). No adapter in `src/llm/retry/` wires a provider 429/`retry-after` into it — `usage_limited` can only ever be derived from a window that nothing sets in production. So the transient rate-limit lane is dead-in-prod.
- **`recordUsage` producer is the LLM's self-report, not real token accounting.** The only `recordUsage` caller into the ObjectivePort is the model tool (`tool/objective/index.ts:269`). The real per-turn token counter `src/agent/work-metrics-collector.ts:89` `recordUsage` is a DIFFERENT method (metrics collector) invoked at `src/agent/loop/emit-helpers.ts:96` — it does NOT feed the objective budget. So even `budget_limited` in prod depends on the model honestly self-reporting usage via the tool, not on measured provider usage. **ROI: MED** (a composition adapter that forwards the provider's typed usage/`retry-after` to `port.recordUsage`/`markUsageLimited`, behind the existing enforce gate — the RFC06-5 packet, still unbuilt). Efficacy of enforcement stays measure-first (no A/B yet).
- **Surfacing (minor).** `/goal` renders `status: ${o.status}` generically (`src/apps/cli/slash/goal-cmd.ts:67`) — the two limited states aren't distinctly explained (paused-until-reset vs hard-cap). ROI: LOW cosmetic.

---

## What Round 2 changed vs Round 1

- R1 read the README/RFC Status ("not yet implemented") and would have called B3/B5/B4 GAP. R2 grounded in code and **overturned that**: RFC06-1/2/3 (B3) and RFC06-4 (B5) are landed, wired, and gated — the doc Status line is stale.
- R2 found B3's `reconcileCreatingWorktree` is fully-built but **unwired at restart** (R1 "ALREADY-BUILT" → R2 "ALREADY-BUILT + crash-reconcile GAP").
- R2 found B4's `mcp/subagent/thread` kinds landed under **RFC-12-2 not RFC-06**, and — the load-bearing correction — `@thread` resolution is **NOT lineage-scoped** (`mention-source-deps.ts:127` resolves any session id; zero lineage predicate in `mention-runner/`), the exact jul-15 sibling class the RFC called load-bearing, though bounded to metadata. `@subagent` verified safe-by-construction.
- R2 confirmed A4.3's budget transition **actually fires** (red-on-injection test, not just types), but the RFC06-5 **live 429/usage producer is unbuilt** (`markUsageLimited` has no prod caller; objective budget is fed only by the model's self-report tool, not measured provider usage).

## Prioritized follow-ups (feature + why + ROI)

1. **Wire `reconcileCreatingWorktree` at session load/resume** (crash-safety: a create-crash leaves an un-reconciled `creating` record; reconciler is pure and already correct) — **HIGH safety / LOW effort**.
2. **Lineage-scope `@thread` resolution + enumeration** (closes a documented cross-lineage exfil class named load-bearing in the RFC; bounded-to-metadata today but default-ON) — **MED-HIGH security / LOW effort**.
3. **RFC06-5 live usage/rate-limit producer** (forward provider typed usage/`retry-after` to `recordUsage`/`markUsageLimited`; today prod budget rides the model's self-report, and `usage_limited` is dead-in-prod) — **MED / MED effort**, efficacy still measure-first.
4. **`worktree salvage` read-only inventory of ownership-less `agent-*` dirs** (the ~53 orphans are invisible to GC; report-only, no delete, matches the no-PID/no-force stop rule) — **MED / LOW effort**.
