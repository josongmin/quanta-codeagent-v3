# Review — RFC-04 Worktree-init staged progress + setup hook

READ-ONLY review. No code/doc modified. Reviewer verified every `file:line` claim in the RFC against the tree.

---

## A. Snapshot

- **HEAD** `9d5369d310bba9cfcdf2508ca62e6274f184cdd4` (branch `main`), **origin/main** identical (`9d5369d31`). No unpushed commits.
- **Dirty tree:** 69 paths, ALL under `src/apps/bench/**`, `src/runner/batch/**`, `tools/leaderboard-dashboard/**`, `adapters/terminal-bench/**`, `docs/plans/**`. A concurrent bench/dataset sweep. Left untouched.
- **Write-set overlap with RFC-04:** **NONE.** No dirty file touches `src/activity/**`, `src/runtime/worktree*`, `src/runtime/shell.ts`, `src/runner/session-ops/{index,current-thread-worktree}.ts`, or `src/agent/run-mode/**`. RFC-04's write-set is conflict-free with the live sweep.

---

## B. Already-wired substrate (proven) vs stale docs

### Proven LIVE (RFC-04 Current-state is accurate)

| RFC-04 claim | Verified at | Verdict |
|---|---|---|
| `cmdWorktree` front door mints ownershipId + passes optional `TransitionActivity` sink | `session-ops/index.ts:842,872-874` — sink built from `deps.activityStore` at `:873`, renders snapshot at `:894` | ✅ exact |
| `transitionThreadToWorktree` persists intent→emits open→git effect→emits settle failed/ready | `current-thread-worktree.ts:202,260,283,307` | ✅ exact |
| **Sink is genuinely LIVE-wired to a real surface** | `apps/cli/repl.ts:155` constructs `activityStore: createActivityStore()` into the `quanta session worktree <id>` deps; also `serve-stdio-cmd.ts:243`, `brain-mode-session-scaffold.ts:46`, `repl/factories/lifecycle.ts:48` | ✅ **the "live caller undecided" claim is truly RESOLVED** — not a phantom. The CLI `session worktree` shell front door emits + renders the node. |
| Producer emits exactly ONE `phase` node (running→terminal), no children/percent | `activity/producers/worktree.ts:74,105` — `worktreeOpenActivity` (running) + `worktreeSettleActivity` (done/failed via `SETTLED_STATUS` table) | ✅ exact — one node, leaf today |
| `createWorkflowSink` = the container+child-step pattern to copy | `activity/store.ts:113` — container node + `ensureStep` children emitted `running→done`/`skipped`/`failed` | ✅ exact |
| `deriveContainerStatus`: closed container = failed iff a child failed, else asserted; **`skipped` non-fatal** | `activity/spine.ts:183-199` — `has("failed") ? "failed" : asserted`; `skipped` never in the fatal test | ✅ exact — the load-bearing skipped≠failed rule is real |
| `createPersistentWorktree` = single opaque `git worktree add --no-track -B … -- … HEAD`, no `--progress` | `runtime/worktree-fork.ts:112-150`; `grep --progress src/runtime` → **0 hits** | ✅ exact — checkout is opaque today |
| `runShell` already exposes a streaming closed-union event seam (per-stream byte offsets) | `runtime/shell.ts:~109` doc: `options.onShellEvent` emits start/stdout/stderr(offset)/exit; absent ⇒ byte-identical | ✅ exact — no new streaming infra needed |
| Trust SSOT `modeLoadsRepoRules` / `MODE_REPO_RULES_POLICY` | `agent/run-mode/repo-rules-policy.ts:26-39` — exhaustive `Record<AgentMode,…>`; interactive/headless/ide=`load`, batch/ci-bot/daemon=`rule-less` | ✅ exact, fail-closed by construction |
| No setup-script concept exists | `grep worktreeSetup src tests` → **0 hits** | ✅ confirmed — D3 is genuinely new |

### Stale documentation to flag (in aug-02 RFC-06)

RFC-06's **Status header** ("RE-AUDITED … Not yet implemented") is now **stale for the whole worktree lane**: RFC06-0 (`WorkspaceOwnership`), RFC06-1 (`inspectWorktrees`/hardened `removeWorktree`/`findByExactPath`), RFC06-2 (`transitionThreadToWorktree` + `cmdWorktree`), RFC06-3 (`worktree gc` via `runGcApply`) all LANDED (imports live in `current-thread-worktree.ts:31-51`, `session-ops/index.ts`).

Specific stale "caller 없음 / 배선 필요" statements:

- **RFC-06 line 20** execution order lists "current-thread CLI/setup activity" as pending — the CLI transition + single-node activity **shipped**; only *staged* activity + *setup* remain (exactly RFC-04's delta).
- **RFC-06 RFC06-2 GREEN/DoD line 86** "front-door activity visible" — a pending goal that is now **met** (`cmdWorktree` renders it).
- **RFC-06 Archived draft §Slice B3 (lines 213-220)** proposes an **in-memory `WorktreeBindingPort`**, a phase enum `creating→adding_worktree→running_setup→ready`, and a **reaper + startup sweep**. All three are **superseded** — by the persisted `WorkspaceOwnership` authority and explicit operator `worktree gc` (no daemon/reaper), per RFC-06's own current-HEAD correction (lines 20-30). RFC-04 correctly does **not** revive any of them.
- **`current-thread-worktree.ts:28-29` docstring** explicitly names the "RFC06-2 activity/UI deferral" — RFC-04 is the follow-through that closes that deferral. Consistent, not contradictory.

RFC-04's own framing ("sits ON TOP of RFC-06 B3 + RFC-02 B6, both landed") is **accurate**. It does not re-implement the transaction, producer, or caller.

---

## C. D1 / D2 / D3 disposition

### D1 — Staged worktree-init producer → **BUILD**
Lowest-risk, highest-confidence. Reuses `createWorkflowSink` shape, `deriveContainerStatus`, the already-live sink, the existing `phase`/`agent` kinds and `AgentActivityEvent`. **No new node kind, no new event type, no second phase machine** — verified those primitives already carry everything needed. The `Record<WorktreeStep,…>` label table + drift-guard is the correct `exhaustive-record-classification` reuse. Ships independently behind `QUANTA_WORKTREE_PROGRESS`; flag-off = byte-identical single node.

### D2 — Real checkout % → **BUILD (independent, after D1)**
The streaming seam (`runShell.onShellEvent`) genuinely exists and `git worktree add --progress` writes `Updating files: N% (x/y)` to stderr — so the ratio is git's OWN, not fabricated; unparseable ⇒ node stays `running` indeterminate. Sound.
**Caveat (write-set, not a blocker):** the progress callback must thread through the **module-private `git()` runner** which today calls `runShell(…, { cwd })` **without** `onShellEvent` (`worktree.ts:31`) — and there is a **DUPLICATE `git()` helper** at `worktree-fork.ts:25`. `runWorktreeAddWithRetry`'s signature `(repoRoot,args)=>Promise<ShellResult>` (`worktree.ts:80`) carries no observer. So D2 = add `--progress` to the arg string + widen the `git()`/retry signatures to pass an optional observer. ~80 LOC is realistic; the RFC should name the duplicate-`git()` seam explicitly.

### D3 — Setup hook (trust-gated) → **BUILD (LAST, independent)**
The RCE-bearing slice, correctly sequenced last and correctly gated. Trust gate reuses the proven fail-closed `modeLoadsRepoRules` SSOT; config-only source (never a repo file) is the right call — absorbing Codex's literal `.codex/environments` auto-run is correctly **rejected**. skipped≠failed mapping is proven load-bearing.
**Open dependency (real):** `worktreeSetup` config field **does not exist** — D3 must first resolve **which config system** owns it (Open-Q #3) against `knob-config-systems-inventory` to avoid a 4th parallel config system. This is a genuine pre-req, not a detail.

### D4 / D3b (selector UI + auto-fix repair thread) → **PARK**
Correctly deferred to last, multi-surface, and (D3b) coupled to the agent-spawn seam. No objection to keeping them out of D1-D3.

---

## D. State transitions & container regression

- **Regression vector is REAL but well-contained.** Two tests read the worktree-op node:
  - `tests/unit/activity/worktree-producer-hellgate.test.ts` — calls the producers directly with **no children**; `deriveContainerStatus([]) = asserted`, so it stays green. Not broken by D1.
  - `tests/unit/session-ops/worktree-cmd-activity-e2e.test.ts:110-113` — filters `opNodes` by `correlation !== undefined` (children are `kind:"agent"` **without** correlation, per the workflow-sink pattern), so `opNodes.length === 1` **survives** child emission; `:113 status === "done"` reads the now-DERIVED status, which stays `done` on an all-done/skipped happy path.
- **The genuine break** only occurs when a **fatal `setup` child** flips a parent the caller settled `done` → `failed`. That is the *intended* Codex semantic (RFC-04 Risk MED), not a defect.
- **Guarantee that matters:** flag-off (`QUANTA_WORKTREE_PROGRESS` unset) ⇒ no children emitted ⇒ node count + asserted status unchanged ⇒ e2e byte-identical. RFC-04's byte-identical golden obligation is the correct anchor. RFC-04's "any test asserting the parent's asserted leaf status must be updated" is slightly conservative (the two live tests actually survive the happy path), but the obligation is sound and should stay.
- **skipped≠failed** is the #1 semantic and is correctly pinned by red-on-injection #1. Verified `deriveContainerStatus` actually distinguishes them — the guard is not cosmetic.

---

## E. Trust / RCE threat model

- **Fail-closed condition holds:** `MODE_REPO_RULES_POLICY` is an exhaustive `Record<AgentMode,…>` — a new mode fails to compile until classified, so no surface can silently enable setup in an untrusted mode. batch/ci-bot/daemon = `rule-less` ⇒ D3 must **omit the setup step entirely** (not even `skipped`), pinned by a red-on-injection trust test (flip ci-bot→allowed ⇒ RED). Correct and grounded.
- **Source = config only, never repo file.** Verified no repo-file auto-run path is proposed. This defeats the `<pr_untrusted_data>` self-approval class the policy doc (`repo-rules-policy.ts:20`) warns about.
- **node_modules symlink hazard** (`worktree-node-modules-hazard`): RFC-04 forbids symlink shortcuts and pins a real-install e2e (file lands in worktree, not main). Correct.
- **Residual to watch (not blocking):** the setup command runs through `runShell` env-scrubbed + timeouted — verify D3 actually passes the scrubbed path (no `inheritEnv`) and bounds/redacts output onto node meta, not the full log. RFC-04 states this; hold it to a test.

---

## F. Minimal write-set & conflict owners

| Slice | Files | Owner conflict |
|---|---|---|
| D1 | `src/activity/producers/worktree.ts` (+label table), `src/runner/session-ops/current-thread-worktree.ts` (child emit at existing boundaries), a new leaf test under `tests/unit/activity/` | none dirty |
| D2 | `src/runtime/worktree-fork.ts`, `src/runtime/worktree.ts` (git runner + retry signature — **note duplicate `git()`**), thread callback to `current-thread-worktree.ts` | none dirty |
| D3 | new config field (system TBD — Open-Q#3), `current-thread-worktree.ts` (gated setup step), reuse `repo-rules-policy.ts` (read-only), `runtime/shell.ts` (reuse, no change) | none dirty |

All target dirs are outside the 69-file dirty sweep. No cross-session collision at write time. Standard `concurrent-session-git-hazard` HEAD-recheck-before-commit still applies.

---

## G. Hellgate coverage check (the four that matter)

1. **Real git progress:** parse real `--progress` stderr fixtures; monotonic ratios ∈[0,1]. ✅ specified. Add: assert the ratio is git's reported `(done/total)`, not a timer.
2. **Unparseable → indeterminate:** node stays `running`, no meta, no fabricated %. ✅ specified, matches `no-heuristics`.
3. **Setup failure ≠ worktree failure:** proceed-anyway ⇒ `skipped` ⇒ parent derives `done`; red-on-injection flips skipped→failed ⇒ RED. ✅ load-bearing, verified the spine actually enforces it.
4. **Untrusted injection:** ci-bot/daemon/batch ⇒ zero setup exec, no `setup` node; interactive ⇒ exec in worktree cwd; red-on-injection flips gate ⇒ RED. ✅ specified, reuses proven SSOT.

Plus the **byte-identical golden** (flags off ⇒ empty event stream + identical `worktree add` arg string) — mandatory, and the true regression fence per §D.

---

## H. Fix order & effort validation

Sequence D1 → D2 → D3 (→ D3b/D4 parked) is correct: dependency-free, risk-ascending, each independently deployable.

- **D1 — S (~120 LOC + ~8 tests):** plausible. Pure producer + reused derivation. ✅
- **D2 — S–M (~80 LOC):** plausible **but** the effort must account for widening `git()` + `runWorktreeAddWithRetry` signatures and the duplicate `git()` helper — slightly under-stated if consolidation is required. Call it solid **M**.
- **D3 — M (~150 LOC):** plausible **only after** Open-Q#3 (config-system ownership) is resolved; otherwise it risks a 4th config system. Gate the M estimate on that resolution.

---

## I. Verdict — **READY (with 2 pre-D3 conditions)**

The RFC is an honest, minimal extension of proven live substrate. It does **not** re-implement the worktree transaction, producer, caller, phase machine, or streaming infra — every one of those was verified already-wired. D1/D2/D3 are cleanly separable and default-OFF byte-identical. The container-regression and RCE risks are correctly identified and grounded in real code.

Two conditions before D3 lands (neither blocks D1/D2):
1. **Resolve Open-Q #3** (which config system owns `worktreeSetup`) against `knob-config-systems-inventory` — avoid a 4th parallel config system.
2. **Name the duplicate `git()` seam** (`worktree.ts:31` + `worktree-fork.ts:25`) in D2's write-set so progress threading doesn't fork behavior.

Proceed D1 immediately; D2 after D1; D3 last, gated on condition (1).
