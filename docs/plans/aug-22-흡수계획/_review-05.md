# Review — RFC-05 Per-Thread Permission-Posture Surface (+ mid-task-question knob)

READ-ONLY review. No code/docs modified except this file.

## A. Snapshot

- **HEAD** = `9d5369d310bba9cfcdf2508ca62e6274f184cdd4`
- **origin/main** = `9d5369d310bba9cfcdf2508ca62e6274f184cdd4` (in sync)
- **branch** = `main`
- **dirty** = large pre-existing bench/leaderboard worktree (src/apps/bench/**, src/runner/batch/**, tools/leaderboard-dashboard/**, adapters/terminal-bench/**, docs/plans/aug-21*/**, docs/plans/aug-22-흡수계획/**). **None** of it touches `src/permission/**`, `src/protocol/session/**`, `src/kernel/session/**`, `src/agent/**`. Left untouched.
- **Target** = `docs/plans/aug-22-흡수계획/rfc-05-permission-posture-surface.md` (DRAFT, default-OFF, not implemented).

**Every grounded code citation in the RFC was checked against the tree and is accurate.** Line numbers land on the claimed symbols:

| RFC claim | Verified |
|---|---|
| `ReviewerTier = user\|auto_review\|guardian_subagent` (types.ts:131) | ✅ types.ts:131 |
| `reviewAction` fails CLOSED — catch emits terminal not-allowed + re-throws, never silent allow (reviewer.ts:269,300-316) | ✅ reviewer.ts:269, 297-316 (catch → emit completed allowed:false → `throw err`) |
| `selectDefaultReviewer` / `selectExplicitAuthorityReviewer` read `approvalsReviewer`+`approvalPolicy`, `agent+on-request+workspace-write→guardian_subagent` else falls **down** to `user` (reviewer-default-policy.ts:41-59,76-109) | ✅ exact; guardian requires `hasGuardianReview`+workspace-write, else `auto_review` if wired, else `user` |
| `ThreadPermission{approvalPolicy,approvalsReviewer,sandboxPolicy}` (permission-store.ts:71-82) | ✅ 71-78 |
| `threadAllowsMutation` fail-closed on empty `writableRoots` ⇒ DENY (per-thread-store.ts:58-77) | ✅ line 66 `if (!roots \|\| roots.length===0) return false` |
| `hostMutationVerdict` maps `custom→defer` (per-host-mode.ts:98-112); `resolveHostId` (:35) | ✅ |
| `PermissionMode` + `ALL_PERMISSION_MODES` + fail-closed `isPermissionMode` (types.ts:80-91) | ✅ |
| `session.permission.set {mode}` verb (commands.ts:53-56,111) | ✅ |
| `setPermissionMode` applier + `ControlEffectApplier` (apply.ts:48-49,33-39) | ✅ |
| HARD_DENY checked **before** read-only fast-path **and before** mode (policy.ts:270-282) | ✅ 277-278 `hardDeny` → 280 read-only → 282 mode; bypass cannot clear a hard-deny hit |
| Managed ceiling: `ProfileTag=managed\|external`, `onManagedWiden:throw\|clamp` (profile-inheritance.ts:80-118); `managedBy:admin,auditRequired` (named-profiles.ts:62) | ✅ |
| `request_user_input` read-only 2-arm; registered when `userInputPort` wired, globally not plan-only (mode.ts:254 `request_user_input:null`; tier1/user-input.ts:21-24; gated-tools.ts request_user_input config-slot userInputPort, CLI default-ON) | ✅ |
| `fail-closed-base.hellgate.test.ts` exists (mirror target) | ✅ `src/permission/__tests__/fail-closed-base.hellgate.test.ts` |

Conclusion on grounding: the "the routes already exist" premise is **true and well-cited**. The missing pieces (preset layer, locked-state derivation, question knob) genuinely do not exist today.

## B. Existing route/state vs actual UI delta

Producer→owner→consumer traced:

- **Per-thread record (owner):** `PermissionStore.setThread/getThread` (permission-store.ts) via facade `setThreadPermission/getThreadPermission/clearThreadPermission` (per-thread-store.ts). File-backed JSON at `~/.quanta/permission-state.json`, multi-process merge-safe, validated on load (`validateThreadPermission`). This is the durable owner of `ThreadPermission`.
- **Route consumer:** `selectExplicitAuthorityReviewer` reads `{approvalsReviewer, approvalPolicy}` from the thread record → `ReviewerTier` → `reviewAction` dispatch. The picker only needs to *write* the record this already reads. **Confirmed: preset is a projection, not a new mode.** No new `ReviewerTier`/`PermissionMode`/`sandboxPolicy` discriminant is required by D1's mapping.
- **Mode axis (separate owner):** `permissionMode` lives in `KernelSessionState` (event-sourced via reducer.ts:141) and is echoed on `session.state.updated` through `SessionHostDescription.permissionMode` (ports.ts:28) + `reconcileSessionPostureState` (scheduler.ts:241). Changed by the `session.permission.set` SessionCommand.
- **Managed ceiling (lock source):** `resolveProfileInheritance` clamps/throws on widen. `deriveLockedPostures` (new) must read this same resolved profile.

**Genuine delta (matches RFC):** (A) `posture-preset.ts` leaf mapping 4 labels→existing shapes; (B) `deriveLockedPostures`; (C) `askOutsidePlan` question knob. All three are absent today.

**Delta the RFC understates (see F):** the *write path* for `session.posture.set` and the *read path* for posture availability. The RFC's D3 wiring is mis-seamed (details in E/F).

## C. Requested / effective / locked authority (SSOT table)

| Value | Where it lives | Authority | Notes |
|---|---|---|---|
| **UI `selected`** (dropdown choice / `/approve <preset>`) | client (CLI arg, web dropdown) | **NOT authority** — a request only | Must be re-validated server-side; never trusted. |
| **`requested` preset** | protocol verb payload (`session.posture.set {preset}`) | untrusted input; `isPosturePreset` fail-closed at boundary | Rejected if unknown or locked. |
| **`effective` ThreadPermission + PermissionMode** | `PermissionStore` (per-thread JSON) + `KernelSessionState.permissionMode` (event log) | **SSOT for the route/mode** | What `selectExplicitAuthorityReviewer` / `evaluate()` actually consume. |
| **`clamped/locked` availability** | derived from resolved `TaggedPermissionProfile` (managed ceiling) + config + host-id | **SSOT for what may be set** — `deriveLockedPostures` reads the *same* profile the kernel clamps against | Persist path re-derives; tooltip mirrors it. |
| **Hard floor** | `hardDeny()` in `evaluate()` | non-bypassable, beats every posture | "Full access" cannot become total fail-open. |

RFC is **correct** that UI `selected` is not authority and that the persisted record + the live managed-clamp are the two SSOTs (route-SSOT and availability-SSOT). Security-model #3/#4 pin this. No split of authority into a parallel UI flag is proposed — good.

## D. Preset → existing-route mapping (verified against `selectExplicitAuthorityReviewer`)

| Preset | writes `approvalsReviewer` | `approvalPolicy` | resulting `ReviewerTier` | `PermissionMode` | verified? |
|---|---|---|---|---|---|
| Ask for approval | `user` | `on-request` | `user` (line 49: `reviewer==="user"→user`) | `default` | ✅ exact |
| Approve for me | `agent` | `on-request` | `guardian_subagent` **iff** `hasGuardianReview`+workspace-write (lines 50-56); else `auto_review` if wired, else `user` | `default` | ✅ — falls *down*, never to silent weaker auto-approve |
| Full access | `agent` | `never` | route as above, but gate short-circuited by mode | `bypass` | ✅ bypass still hits hardDeny first (policy.ts:277) |
| Custom | — (clearThreadPermission) | — | precedence falls to stored named-profile | from profile | ✅ mirrors an unpinned thread today |

The mapping is a faithful projection over the *existing* predicate. The "falls down to user" claim is real (line 49 short-circuits on `approvalsReviewer==="user"`; the guardian branch requires all three conditions or it drops through to `auto_review`/`user`). No new kernel state is introduced by the table.

## E. Fail-open / split-brain risk assessment

1. **No new bypass route — CONFIRMED SOUND.** Every preset routes through `reviewAction`/`evaluate()`. "Full access" = `PermissionMode:"bypass"`, and `evaluate()` runs `hardDeny` at line 277 *before* the mode check at line 282. `rm -rf /`-class is blocked regardless of posture. The picker chooses a reviewer; it does not become one. (RFC R1 finding reproduced in code.)
2. **Split-brain (gray-UI-only) — ADDRESSED by design, IF implemented as written.** Security-model #4 mandates `setPosture` re-runs `deriveLockedPostures` at write time and rejects locked presets, and #3 mandates the derivation read the *same* `TaggedPermissionProfile` the kernel clamps against. This is the correct anti-split-brain shape. **Residual risk = the write verb must actually reach a server-side re-validation seam** — and the RFC mis-identifies that seam (see F.1). If posture.set were wired only to the client-optimistic path, the gray-out would be theater. The plan's intent is right; the wiring target is wrong and must be corrected so the re-validation is on the authoritative (kernel/host) side, not the client.
3. **Locked ⇒ lower layer cannot re-enable full-access / question-bypass — CONFIRMED by the clamp semantics.** `onManagedWiden:"throw"` (strict) / `"clamp"` (narrow-back) means a derived profile *cannot widen* a managed ceiling; config/requirements are narrow-only (Security-model #5). Since `deriveLockedPostures` reads the resolved (already-clamped) profile, a lower layer cannot resurrect a posture the ceiling forbids. **Provided** the derivation reads the resolved profile object, not a copy (RFC R2 flags this; needs the drift test).
4. **Question OFF fail-closed — CONFIRMED subtract-only.** `askOutsidePlan:false` withholds `request_user_input`; absent ⇒ byte-identical (tool offered when port wired). The knob never *adds* capability and never auto-answers. Worst case = "tool unexpectedly absent", never "unexpectedly present" or "auto-approved". This is fail-closed. **The tool does NOT get reimplemented** — the knob only gates `buildUserInputBlock`'s output. ✅
5. **Unknown-value fail-closed — CONFIRMED.** `isPosturePreset`/`isPermissionMode` are `includes()`-guards that reject unknown strings at the boundary; a bad value cannot land as an implicit weaker posture.

**No fail-open security hole found.** The one real risk is #2's wiring-seam mismatch turning re-validation into a no-op — a *plumbing* defect, not a design fail-open, but it must be fixed or the split-brain guarantee is only aspirational.

## F. Minimum write-set & shared-protocol owner (RFC under-scopes this)

RFC claims: "~1 leaf module + 2 protocol verbs + 1 applier method + 1 slash command + 1 web dropdown + `askOutsidePlan` + tests. No kernel change." Two corrections:

**F.1 — The write verb is mis-seamed. `session.permission.set` does NOT land through `ControlEffectApplier`.**
RFC D3 says `session.posture.set` "lands through the same `ControlEffectApplier` seam (apply.ts:33-39)". But the sibling it models on, `session.permission.set`, is a **SessionCommand** routed through the **kernel scheduler + reducer**, not the control-request applier:
- `scheduler.ts:903-905` → `await ctx.host.setPermissionMode?.(command.mode)` → `reconcileSessionPostureState`.
- `reducer.ts:141` → writes `permissionMode` into `KernelSessionState` (event-sourced).
- Additional touch points for a real new SessionCommand: `commands.ts` (interface + `SessionCommand` union + `SESSION_COMMAND_TYPES`), `codec.ts`, `builders.ts`, `verb-surface.ts`, `sdk/runtime/{types.ts,handle-adapter.ts,session/engine.ts}`, `apps/web-daemon/runtime-factory.ts`.

The `ControlEffectApplier` (`apply.ts`) is a **separate** subsystem (ADR-0496 control-request drain, `ControlEffect` union in control-request/types.ts:58-62). Wiring posture there would touch `ControlEffect` union + `planControlRequest` + `apply.ts` instead — and would NOT flow through the kernel session state / event log, so it would not survive resume/replay. **The plan must pick one seam and commit.** Recommendation: mirror `session.permission.set` exactly (SessionCommand → scheduler → `host.setPosture?`) so persistence/resume and re-validation live on the authoritative side. Either way the protocol write-set is materially larger than "2 verbs + 1 applier method."

**F.2 — The read verb is redundant with the existing state echo.**
RFC proposes a new `session.posture.list` read verb. But `SessionHostDescription` (ports.ts:28) already echoes `permissionMode/identityMode/toolProfile/modelSlug` on every `session.state.updated`, reconciled by `reconcileSessionPostureState` (scheduler.ts:241). The posture pill + availability should ride this existing echo (extend `SessionHostDescription` + `KernelSessionState` + `reconcileSessionPostureState`), not a bespoke verb. This is *less* new surface and keeps one owner for "current session posture."

**F.3 — `askOutsidePlan` location is ambiguous and its gating is under-wired.**
- D4 says "add to the per-thread record." If that means `ThreadPermission`, it touches `permission-store.ts` (interface + `validateThreadPermission` + `threadPermEqual`) — a permission-store change, mildly contradicting "no kernel change." If it instead rides `AgentConfig`/session-build, it is not in the durable per-thread store and needs its own persistence story. **Pick and state where it lives.**
- `buildUserInputBlock(config)` (tier1/user-input.ts:21, called at features.ts:270) receives only `AgentConfig` — it has **no** thread-record or plan-mode access today. Gating "outside plan mode" on a static build-time knob is a mismatch: plan-mode is per-turn dynamic, the registry is built per feature-build. The plan must specify how the knob (and current mode) reach the builder. This is real integration work the RFC treats as a one-liner.

**Shared-protocol owner:** the single writer of `{ThreadPermission, PermissionMode}` must be `presetToAuthority` (R4), and both surfaces (CLI `/approve`, web dropdown) must call it — RFC states this and it's correct. But the *protocol* owner for the mutation is the **kernel session scheduler/reducer** (for the mode half) + **PermissionStore** (for the route half), NOT `ControlEffectApplier`. The RFC's F-level plumbing must be re-pointed accordingly.

## G. Policy clamp · lower-layer override · question OFF · resume receipt

- **Policy clamp:** ✅ locked-state derives from the resolved managed profile (`onManagedWiden:throw/clamp`), same object the kernel clamps against. Same-source-of-truth requirement is stated (Security-model #3) and grounded. Needs the R2 drift test to prove the derivation reads the live profile, not a copy.
- **Lower-layer override:** ✅ config/requirements are narrow-only (Security-model #5); managed ceiling wins; a widening directive is ignored. Consistent with the existing `resolveProfileInheritance` semantics. Parity with the `omo` trusted-surface rule (batch/ci must not honor repo config as authority) is the right guard.
- **Question OFF:** ✅ fail-closed subtract-only; never auto-answers, never reimplements `request_user_input`. Byte-identical when absent.
- **Resume/replay receipt — PARTIALLY SPECIFIED, needs tightening.** `permissionMode` survives resume because it is event-sourced in `KernelSessionState` (reducer). The **route half** (`ThreadPermission`) survives via the on-disk permission-state JSON keyed by threadId. But: (a) if `session.posture.set` is wired to `ControlEffectApplier` (F.1) instead of the SessionCommand/event path, the mode half would NOT be in the event log and would be lost on replay — another reason to use the SessionCommand seam. (b) `askOutsidePlan` "bound at thread creation" has **no stated persistence path**; if it lives only in `AgentConfig` it is not replay-durable and must be re-bound from a persisted source on resume. The plan must state the receipt: which store persists it and how thread-creation rebinds it on resume. Thread-creation binding + mid-session no-op (R3) is coherent and safe, but the durable home is unspecified.

## H. Verdict

**REVISE.**

The security core is READY-quality and well-grounded: no new bypass route (hardDeny beats every posture, verified), persist-side re-validation against the same managed clamp (correct anti-split-brain shape), question-OFF is fail-closed subtract-only, unknown values rejected at the boundary, and the preset table is a faithful projection over the existing `selectExplicitAuthorityReviewer` predicate with a real fail-*down*. Every code citation checks out. This is not a PARK — the premise ("routes exist, add a composer") is true.

It is not READY because two design seams are wrong/under-specified and would, if implemented literally, undermine the very guarantees the RFC claims:

1. **D3/F.1 — wrong protocol seam.** `session.posture.set` must mirror `session.permission.set` through the kernel scheduler/reducer (event-sourced, replay-durable, host-authoritative re-validation), NOT the `ControlEffectApplier` the RFC cites. As written, re-validation could land on the non-authoritative side (split-brain) and mode would not survive resume. Protocol write-set is materially larger than "2 verbs + 1 applier method."
2. **F.2 — redundant read verb.** Availability should ride the existing `session.state.updated` / `SessionHostDescription` echo, not a new `session.posture.list`.
3. **F.3/G — `askOutsidePlan` home + wiring + resume receipt unspecified.** Decide where it persists (ThreadPermission vs AgentConfig vs new per-thread field), how it reaches `buildUserInputBlock` (which today sees neither thread state nor plan-mode), and how it rebinds on resume.

None are fail-open security defects; all are plumbing/scoping corrections. Address §F.1–F.3 and the §G resume receipt, keep the §E/§G security invariants and the mandated red-on-injection tests, and this converts cleanly to READY.
