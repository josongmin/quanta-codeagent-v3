# _review-07 — RFC-07 observability signals parity (READ-ONLY grounding review)

Reviewer pass over `rfc-07-observability-signals-parity.md`. No code/docs modified. Every claim below
is grounded to file:line in the working tree at the snapshot HEAD.

---

## A. Snapshot

- HEAD == origin/main == `9d5369d310bba9cfcdf2508ca62e6274f184cdd4` (branch `main`, in sync).
- Working tree DIRTY (pre-existing, NOT mine, untouched): ~42 modified files (bench/runner/dashboard sweep)
  incl. `src/runner/batch/report.ts` — the RFC's §5.2 wiring target is a live-edited file (concurrent-session hazard).
  Untracked: `docs/plans/aug-21-*`, `adapters/terminal-bench/*`. I read only; changed nothing.
- Review touched only reads + this file.

---

## B. Item-by-item verdict (ALREADY / BUILD / DROP / PARK)

| RFC item | RFC says | My verdict | Grounding |
|---|---|---|---|
| gitOperation CORE (classifier→sink→hook→host) | ALREADY-BUILT / DROP | **ALREADY — CONFIRMED** | classifier.ts:253 pure; sink.ts:28 noop sentinel; bash-hook.ts:42 knob+sink gate; wired bash/index.ts:822 → host createPassiveVcsStreamSink agent-config-assembler.ts:696 / maybeWireVcsEventSink:722; knob runtime-config.ts:201. Do NOT rebuild. |
| gitOperation `commit.branch` | BUILD (S) | **BUILD — valid, authoritative** | COMMIT_BRACKET classifier.ts:114 captures only sha today; the `[<branch> <sha>]` bracket literally carries the branch token → parseable, not a guess. |
| gitOperation `pr.action` | BUILD (S) | **BUILD — valid, authoritative** | `input.command` is in scope; `gh pr <verb>` is command-shape (same discipline as AMEND_FLAG/isDryRunPush). Today derivePr (classifier.ts:229) reads only stdout URL/#N → no action. Verb-derived action is authoritative. |
| gitOperation `branch.ref` | DROP (not parseable) | **DROP — CONFIRMED** | MERGE_LINE classifier.ts:90 matches `Fast-forward`/`Merge made by` but captures no target ref; deriving it = heuristic. Keep dropped. |
| failure_mode vocabulary (wire classifyFailure) | BUILD/wire (M) | **BUILD — dead seam confirmed, but wiring cost UNDERSTATED (see D)** | classifyFailure/FailureLabel exported failure-taxonomy.ts:148 / metrics/index.ts:20; the whole metrics barrel is imported by TESTS ONLY (no `src/` production importer). Genuinely dead. |
| task_category (8) | DEFER (churn) | **DROP/DEFER — agree** | single-category SWE corpus; constant tag measures nothing. |
| backgroundEndsWithFinalResponse + owner-scoped reap (P0) | BUILD (M), correctness-first | **REVISE — premise FALSIFIED (see E)** | The over-reap the RFC calls a P0 correctness bug does NOT reproduce in current wiring; and the ownership authority it assumes is ABSENT for subagent shells. |
| asyncDispatched replay-skip | DROP (no consumer) | **DROP — CONFIRMED** | async-helper.ts pull-based `poll_deferred` (DeferredResultRegistry); no on-disk replay engine. Nothing to skip. |
| requestUserInput | DROP (exists; RFC-05 owns surface) | **DROP — CONFIRMED** | src/tool/request-user-input.ts, ADR-0097, closed 2-arm UserInputOutcome. |
| /archive /rename /star | BUILD (small) | **PARK** (see H) | registry-surface.ts has /resume, /branches; archive/rename/star absent — but this is LOW UX churn bundled with a mis-scoped P0; separate it. |
| MCP quick-links / plain-text composer | BUILD (small UI) | **PARK** | LOW UI, no substrate risk, no measurement consumer; do not let it pad the P0 slice. |
| trace keep-local | DROP (already local) | **DROP — agree** | cassettes/trajectories already on disk. |

---

## C. gitOperation — the ACTUAL residual field-set (nothing more)

Only two fields survive, both authoritative from data already in `PassiveVcsInput`:

1. **`commit.branch?: string`** on `VcsCommit` (types.ts:33). Source = the leading token of the already-matched
   `[<branch> <sha>]` bracket (classifier.ts:114). Guards the RFC names are correct and necessary: omit on
   `[detached HEAD <sha>]`; strip `(root-commit)` / `(<n> commits)` parenthetical; omit on ambiguity. Optional ⇒
   OFF byte-identical. No new module/bus/knob (rides QUANTA_PASSIVE_VCS + existing stream sink).
2. **`pr.action?: VcsPrAction`** (CLOSED union) on `VcsPr` (types.ts:55). Source = the `gh pr <verb>` sub-command in
   `input.command`. Command-shape gate; reuse the existing `invokesGitOrGh` segment scan (classifier.ts:77) so a
   heredoc/echo of `gh pr create` cannot classify. Bare `gh pr view` ⇒ omit action.

DROP (do not build): `branch.ref` (not in stdout), and the note that quanta's `push{localRef,remoteRef}` is already
RICHER than Claude's `push{branch}` — no gap. Both correct in the RFC.

Anti-vacuous rail REQUIRED (RFC §7 already states it, keep it hard): the new fields must be asserted at the
**capturing sink** (they reach the AgentEvent stream), not merely on the pure classifier return. A pure-return-only
test would be vacuous given the field flows through an already-wired sink.

---

## D. Failure taxonomy — producer → report consumer path (and the understated cost)

- **Dead seam CONFIRMED.** `classifyFailure` (failure-taxonomy.ts:148) is exported (metrics/index.ts:20) and consumed
  by NO production code — only `tests/unit/agent/observation/metrics/*`. Testing it in isolation is vacuous; the
  RFC's gate (assert `failure.modes` in `bench-report.json`) is the correct non-vacuous anchor.
- **Authoritative consumer target EXISTS.** report.ts per-instance entry carries `failure?: FailureClassification`
  (report.ts:159–160, built at buildPerInstanceReportEntry ~:364) with `{termination, signals}`. `failure.modes:
  readonly FailureLabel[]` is a clean additive sibling. This is the correct wiring site.
- **⚠️ Wiring cost is UNDERSTATED ("the report wiring is the bulk" hand-waves the hard part).** `classifyFailure`
  does NOT take the failure-classifier's loose `TrajectoryEvent` shape. Its signature (failure-taxonomy.ts:148) is
  `(events: MetricEvent[], bundle: ObservationBundle, inputs: MetricInputs, options)`. The report's producer
  (failure-classifier.ts readTrajectory:73, TrajectoryEvent:57) reads a DIFFERENT shape and has **no ObservationBundle**.
  Several detectors (detectWrongOwner, detectHintOvertrust) DEPEND on `bundle` owner-paths/hints — that bundle is the
  S1–S3 observation-kernel output and is **not currently persisted offline** at report time. So wiring requires either
  (a) reconstructing MetricEvent[]+ObservationBundle+MetricInputs per instance offline, or (b) computing modes inline
  during the run where the bundle is live (RFC Open-Q 11.3 sidecar-vs-inline). This is real M-to-L glue, not a one-liner.
- **The two NEW proposed labels are the cheap, honest part.** `SUBAGENT_OVERSPAWN` / `EXCESSIVE_QUESTIONS` are pure
  trajectory COUNTS — they do NOT need the ObservationBundle. `subagent_spawn` is a real event type
  (stream/types.ts:203,466; item-lifecycle.ts:84) and `request_user_input` is a tool (tool_call event). BUT: verify
  these land in the per-attempt **JSONL** the classifier reads (failure-classifier.ts:11 `<patch>.jsonl`) — `subagent_spawn`
  is emitted on the AgentEvent STREAM (stdout adapter), presence in the recorded trajectory JSONL is UNCONFIRMED (RFC
  Open-Q 11.2, honestly flagged; degrade-to-unavailable, never invent). Each behind a named threshold in
  `TaxonomyOptions` (mirrors verifyLoopThreshold, failure-taxonomy.ts:24) — no magic number. Keep this discipline.
- **Recommendation:** SPLIT 5.2. (i) wire `classifyFailure`→`failure.modes` = the value (makes the jul-6 classifier
  observable, un-vacuous); do it where the bundle is available. (ii) 2 count-labels = additive, cheap, but gated on
  confirming JSONL event presence FIRST. Do NOT expand the enum before (i) lands.

---

## E. Global over-reap — reproduction attempt + ownership authority (THE PIVOT)

The RFC frames §5.3 as a P0 correctness bug: "a synchronous subagent whose teardown fires `killAll()` on the shared
singleton would reap the **parent's** shells." I traced the path end-to-end. **This does not reproduce, and the fix's
ownership premise is false in the current wiring.**

Registry facts (all confirmed):
- `killAll()` (bash-bg-registry.ts:665) clears ALL entries regardless of owner; `killOwned(idOrPrefix, ownerId)` (:636)
  and `listOwned(ownerId)` (:627) are owner-scoped; `ownerId` is stamped at register/adopt (:429,:442,:502,:524).
- Module singleton `getBashBgRegistry()` (:710). The **bash tool always adopts into the singleton DIRECTLY**
  (bash/index.ts:494 `getBashBgRegistry().adopt({... ownerId: ctx.ownerId})`) — it does NOT use `cfg.bgShellRegistry`.
- `ctx.ownerId = config.sessionId ?? config.run?.runId` (tool-context.ts:190) — composition-supplied, never PID/cwd.
- Teardown reap: session-lifecycle.ts:145 `await args.cfg.bgShellRegistry?.killAll()` — **optional-chained on cfg**.

**Falsification 1 — the subagent teardown never fires killAll.** The child AgentConfig is built by `buildChildConfig`
(subagent-runner-child-config.ts:261 → buildChildBase:134 + buildChildInheritedConfig:206). Neither branch sets
`bgShellRegistry`. Grep confirms: `bgShellRegistry` appears in agent/ ONLY at wire-slots-core.ts:440 (the narrow
`{killAll()}` port type) and session-lifecycle.ts:145 (the call). It is bound to the singleton ONLY on the HOST/ROOT
path (agent-config-assembler.ts:913, context-binding/base.ts:55 wireRuntimePorts) — which subagents do NOT traverse
(subagents fork `runAgent` directly with the raw child config). So for a subagent, `cfg.bgShellRegistry === undefined`
⇒ `?.killAll()` short-circuits ⇒ **no reap, no over-reap**. RFC Open-Q 11.1 resolves to **NO**.

**Falsification 2 — subagent shells are UNOWNED, so owner-scoped killOwned can't target them anyway.** The child config
sets NEITHER `sessionId` NOR `run` (grep: no sessionId in any subagent-runner*/child-config; buildChild* spread neither
`parent.sessionId` nor `parent.run`). Therefore the child's `ctx.ownerId` is OMITTED (tool-context.ts:190 guard), and
the child's background shells adopt into the singleton with **no ownerId**. `killOwned(subagentOwnerId)` /
`listOwned(subagentOwnerId)` would match **nothing**. The ownerId is NOT preserved from registration time for
subagent-spawned shells → this trips the stated guard "no ownership ⇒ do not propose killOwned; and never PID/TTL."

**What the real defect actually is (inverted direction).** It is an UNDER-reap / mild leak, not an over-reap: a
subagent's own background shells are never reaped at subagent teardown (bgShellRegistry undefined) and linger in the
singleton until the ROOT session teardown `killAll()` sweeps everything (the intended M1 leak fix, root path only).
Because they are unowned, they cannot even be individually enumerated. A correct fix would FIRST have to thread session
identity into the child config (so child shells register owned), THEN reap owner-scoped at child teardown — which is a
larger change than the RFC's "swap killAll for killOwned" and is a prerequisite the RFC does not name.

**Reproduction rails (what a test must show):**
- Over-reap rail as written (spawn sync subagent while parent holds a bg shell; end subagent; assert parent shell
  survives) will pass TRIVIALLY today — the subagent never calls killAll — so it is a **vacuous green**, not a
  regression catch. Do NOT ship it as proof.
- The honest failing rail is the leak: spawn subagent, subagent registers a bg shell, subagent ends → assert the
  subagent's shell is reaped (fails today: it is neither owned nor killAll'd until root teardown). Fixing THAT needs
  child-session-identity + a widened reap port ({listOwned,killOwned} not just {killAll}) + a defined child ownerId.

**Verdict E:** §5.3's P0 is mis-scoped. Either (a) DOWNGRADE it to the leak framing with the identity-threading
prerequisite made explicit, or (b) PARK it until the child-session-identity question is settled. The
`backgroundEndsWithFinalResponse` model-facing flag is independent and harmless (optional ToolResult field), but note
its own trigger condition ("owning session is a synchronous subagent") also needs a subagent-session signal the child
config does not currently expose — so it inherits the same identity gap.

---

## F. Minimal write-set + concurrent-modification conflict

- **5.1 (gitOperation fields):** `src/git/passive-classify/{classifier.ts,types.ts}` + a hellgate matrix test. LEAF crate
  (`@/git`), pure, no host churn. These files are NOT in the dirty set → **conflict-free**. Lowest risk; land first.
- **5.2 (taxonomy wiring):** `src/agent/observation/metrics/failure-taxonomy.ts` (labels) + `src/runner/batch/report.ts`
  (consumer field) + an offline bundle-reconstruction seam. **⚠️ report.ts is DIRTY in a concurrent session** — re-read +
  merge before any edit; do not race it. The bundle-availability question (D) may force touching the run-side observation
  path too.
- **5.3 (reap):** would touch `src/agent/loop/session-lifecycle.ts`, `src/agent/types/wire-slots-core.ts` (widen port),
  `src/agent/subagent-runner-child-config.ts` (thread session identity). Correctness-sensitive AND premise-broken (E) →
  do not open until re-scoped.
- **5.4 (LOW bundle):** `src/apps/cli/slash/registry-surface.ts` + `src/host/mcp-composition.ts` + a composer pref. UI
  slices, disjoint from the above.

---

## G. Report-integration / owner-isolation / default-OFF receipts

- **Report-integration (5.2):** the only non-vacuous receipt is `failure.modes` OBSERVED in `bench-report.json`
  per-instance (report.ts:159/364) — not a classifier-in-isolation unit. `Record<FailureLabel, …>` drift-guard so a new
  label is a compile error at consumers. HELD as a hard gate.
- **Owner-isolation (5.3):** cannot be received today — there is no owned subagent shell to isolate (E). Any
  "owner-scoped reap preserves parent shells" receipt would be vacuous. Blocked on child-session-identity.
- **Default-OFF (all):** 5.1 optional fields ride noopVcsEventSink + QUANTA_PASSIVE_VCS (bash-hook.ts:49 returns before
  classify when OFF) ⇒ byte-identical — SOUND. 5.2 is offline report-side (fence like closure-diagnostics) ⇒ no runtime
  path ⇒ SOUND. 5.3 flag optional + knob ⇒ SOUND in principle, but the reap correctness fix has no validated red to gate
  behind (E).

---

## H. Recommended sequencing (correctness → wiring → optional)

The RFC's own sequence (5.1 → 5.2 → 5.3 → 5.4) puts the mis-scoped reap AFTER the real levers, which is fortunate.
Corrected order:

1. **5.1 gitOperation fields** — pure, leaf, conflict-free, authoritative. Land first. (S)
2. **5.2a wire classifyFailure → `failure.modes`** — the genuine lever (un-deads the jul-6 classifier). Resolve the
   ObservationBundle-availability question BEFORE coding; coordinate on dirty report.ts. (M/L, not the RFC's "M-lite")
3. **5.2b two count-labels** — only AFTER confirming `subagent_spawn` / `request_user_input` are in the recorded JSONL
   (D); else degrade-to-unavailable. (S)
4. **5.3 — PARK / RE-SCOPE.** Do not implement owner-scoped reap as written. First settle: should subagent bg shells
   carry a session-owner identity at all? If yes, that identity-threading is the real ticket; the reap swap is downstream.
   The `backgroundEndsWithFinalResponse` flag can proceed independently only once a subagent-session signal exists.
5. **5.4 LOW bundle — PARK as a separate UX ticket.** It does not belong in an observability-correctness RFC; bundling it
   risks it padding the (broken) P0 slice's apparent scope.

---

## I. Overall verdict — **REVISE**

The RFC's grounding is largely SOUND and the anti-scope-creep discipline is good: gitOperation CORE / asyncDispatched /
requestUserInput / trace-local / task_category are correctly DROPPED-or-DEFERRED with confirmed substrate, and the
residual gitOperation field-set (commit.branch + pr.action, minus branch.ref) is real and authoritative. The
dead-seam diagnosis for the failure taxonomy is correct and the non-vacuous report-field gate is the right rail.

Two REVISE-blocking issues:

1. **§5.3 P0 is mis-scoped (falsified premise).** The "synchronous subagent killAll over-reaps the parent" bug does NOT
   reproduce — the child config carries no `bgShellRegistry`, so its teardown killAll short-circuits. And subagent shells
   register UNOWNED (no child `sessionId`), so the proposed `killOwned` fix has no ownership to scope to. The real defect
   is the inverse (a mild under-reap leak), and any correct fix requires first threading child-session identity — an
   unnamed prerequisite. The RFC's own red-on-injection rail, as written, would be a vacuous green. Re-scope or PARK.
2. **§5.2 wiring cost understated.** `classifyFailure` needs `MetricEvent[]` + `ObservationBundle` + `MetricInputs`; the
   report producer has none of these offline and several detectors depend on the bundle. "The report wiring is the bulk"
   hides a bundle-availability decision (inline vs sidecar) that materially raises the effort above the stated M.

Everything else is READY-to-build behind the existing default-OFF fences. Recommend: land 5.1, land 5.2a with the
bundle question resolved, gate 5.2b on JSONL event presence, PARK 5.3 pending child-session identity, PARK 5.4 as a
separate UX ticket.
