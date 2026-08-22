# RFC-05 — Per-Thread Permission-Posture Surface (+ mid-task-question knob)

**Absorbs:** Codex 6662 "permission-mode composer dropdown + `requestUserInput` toggle"
(refresh 2026-08-13; detail `.extracted_source/_deep-codex-ui-med.md` §3 + §5)

## Status
**R6 ARCHITECTURE FROZEN — permission authority and restart contract first; surface implementation
NOT READY.** The approval routes are built, but the repository has no live
`TaggedPermissionProfile` SSOT, no posture event-fold restore authority, and no durable
future-thread default for the question knob. This revision removes those false premises.

## Final audit incorporation — current-HEAD authority (R5, normative)

This section supersedes the historical R1→R4 audit log and any conflicting READY/FINAL,
`TaggedPermissionProfile`, event-sourced durability, or guardian fail-down claim below.

### Ground truth

- `resolveProfileInheritance` and `TwoLayerPermissionManager` carry a bare
  `PermissionProfile`; the runtime behavior owner is still the mutable permission-mode
  cell. There is no resolved object that couples requested preset, effective clamp,
  provenance, and the live evaluator.
- `SessionCommand` events are transport/receipt history, not permission-state restore
  authority. A process restart constructs posture from the host description; it does not
  fold old permission events into a live host.
- `setThreadPermission` accepts a complete `ThreadPermission`. Applying a partial preset
  as a replacement can erase sandbox and question fields.
- `selectExplicitAuthorityReviewer` may select `auto_review` after guardian admission
  fails when auto-review is available. A `hasAutoReview:false` fixture does not prove
  universal fail-down to `user`.
- `askOutsidePlan` has neither a durable global default for future threads nor one shared
  predicate enforced by both tool visibility and direct dispatch.

### Final disposition

| Scope | Disposition | Required authority |
|---|---|---|
| Existing reviewer routes, `ThreadPermission`, mode command, hard-deny floor | **ALREADY** | Reuse; do not fork |
| Resolved posture and managed clamp | **BUILD FIRST** | One live `ResolvedPermissionPosture` owner |
| Restart/resume durability | **BUILD** | Durable posture store + explicit host rebind |
| Presets and CLI/web echo | **BUILD AFTER AUTHORITY** | Lossless CAS patch over the resolved posture |
| `askOutsidePlan` | **BUILD AFTER DEFAULT OWNER** | Future-thread default + immutable thread binding + one visibility/dispatch predicate |
| Config/requirements/cloud lock reasons without a real producer | **PARK** | Admit each reason only with a production producer and enforcement test |
| One-click full-access surface | **PARK** | Product ceremony and policy source must be decided first |
| Bespoke read verb / event-log-as-durability | **DROP** | Existing state echo / durable store are the owners |

### Canonical authority

```ts
interface ResolvedPermissionPosture {
  revision: number
  requestedPreset: PosturePreset | null
  effectiveMode: PermissionMode
  reviewerRoute: ReviewerTier
  threadPermission: ThreadPermission
  locks: readonly PostureLock[]
  provenance: readonly PostureProvenance[]
  askOutsidePlan: boolean
}
```

The same immutable value must drive permission evaluation, server-side revalidation, and
the state echo consumed by CLI/web. `setPosture(patch, expectedRevision)` is the only
writer: it performs a lossless merge over the complete `ThreadPermission`, resolves the
managed ceiling, persists the new requested/effective state, rebinds the live host, and
returns the new resolved value. Stale revision or unsupported host capability is a typed
rejection, never a no-op.

Durability belongs to a posture store keyed by session/thread and read during host
construction. The event log may record the command outcome, but replaying that log is not
the restore algorithm. Future-thread defaults belong to a separate
`PermissionDefaultsStore`; thread creation copies the default into an immutable per-thread
binding, and resume reads that binding rather than the current global default.

## Architecture integration — R6 (normative)

R6 replaces the assumed `TaggedPermissionProfile` wrapper and event-log restore model. Current
behavior is driven by the live permission mode/config path; `two-layer-manager` stores a separate
bare profile and is documented as forward-compatible state, while kernel events are not a durable
host-state fold. The fix is one behavior-live posture authority backed by the existing permission
store. Shared topology is in
[`00-architecture-blueprint.md`](./00-architecture-blueprint.md).

### Existing owner map

| Concern | Current owner | R6 decision |
|---|---|---|
| Durable thread permissions | `src/permission/permission-store.ts` | Evolve this schema; no second posture JSON |
| Profile inheritance/resolution | `src/permission/profile-inheritance.ts` | Reuse as a pure resolver component |
| Two-layer state | `src/permission/two-layer-manager.ts` | Stop treating it as behavior authority; feed authority resolution |
| Live mode mutation | `runner/assemble/session-state.ts`, `host/bootstrap/bootstrap-session.ts`, host context binding, web/agent control-request and `session.permission.set` | Replace the backing cell and every direct writer with posture adapters |
| Reviewer selection | `src/permission/reviewer-default-policy.ts` | Preserve policy truth; do not claim guardian failure always falls to user |
| Kernel event/log | `src/kernel/session/**` | Projection/ack only; never restore authority |

### Target write set

```text
src/permission/posture/
  types.ts             # requested/effective posture, source, lock, revision
  presets.ts           # lossless patches over existing ThreadPermission
  availability.ts      # only admitted producer-derived options/locks
  authority.ts         # validate -> CAS persist -> publish; itself is the live source
  question-policy.ts   # one predicate for request_user_input visibility/dispatch
  ports.ts             # store, managed policy and future-thread-default contracts
  index.ts
src/permission/permission-store.ts   # versioned evolution of existing record
src/permission/two-layer-manager.ts  # resolver, not a parallel mutable owner
src/agent/dispatch-guard/question-availability.ts
src/runner/assemble/session-authorities/build-posture.ts
src/runner/assemble/session-state.ts              # retire independent mode cell
src/host/bootstrap/bootstrap-session.ts           # construct/bind authority
src/host/runtime/internal/context-binding.ts      # command adapter, no local mutation
src/apps/web-daemon/web-control-request-port.ts   # same command/authority
src/agent/control-request/apply.ts                # same command/authority
src/host/runtime/session-authority-host.ts
src/protocol/session/{commands,codec,builders}.ts
src/apps/cli/slash/posture.ts
tests/unit/permission/posture/
tests/integration/permission-posture-live-resume.test.ts
```

All permission invariants stay inside `@/permission`. `@/tool` must not import permission. The
agent bridge consumes a narrow `QuestionAvailabilityReader` and applies the same predicate both
when building live tool specs and at dispatch. Runner/app code does not reinterpret locks or
profiles.

### One authority, requested vs effective state

```ts
interface PermissionPostureAuthority {
  read(): PermissionPostureView
  set(command: PosturePatchCommand): Promise<PostureMutationResult>
  canRequestUserInput(context: QuestionContext): QuestionAvailability
}
```

The view separates:

- `requested`: the operator's lossless patch/preset selection;
- `effective`: the fully resolved live permission mode, sandbox and reviewer route;
- `locks`: producer-backed constraints with stable machine reason codes;
- `revision`: domain CAS revision, independent of kernel event sequence.

Preset selection returns a patch, never a partial `ThreadPermission` masquerading as a full
record. Unmentioned sandbox/reviewer/question fields are preserved. “Custom” is a projection when
the effective record does not exactly match a named preset; selecting/customizing it never deletes
unrelated fields.

The authority validates the patch against managed requirements, resolves the complete candidate,
CAS-persists the requested/bound values, then atomically swaps its immutable in-memory view. It is
itself the behavior-live source: host/AgentConfig gates read its effective getter on the next turn,
so there is no fallible imperative “apply to another mode cell” step and no compensation window.
Persistence failure leaves the old view live. Host capability/binding is validated at construction
before commands are admitted. The existing `session.permission.set` becomes a compatibility
command adapter into this same writer; `session.posture.set` is the richer command, not a second
route.

### Persistence, resume and future-thread defaults

Extend the existing permission-store record with a versioned posture section:

```ts
{ requestedPatch, boundAskOutsidePlan, revision, schemaVersion }
```

Future-thread defaults are a separate named store entry/port, not a mutable process global. New
thread creation copies the current default into the thread-bound record. Existing/resumed threads
read their bound value and are unaffected by later default changes. Missing posture fields migrate
to exact current behavior; no replay inference from kernel events is allowed.

`askOutsidePlan` has two scopes that must remain explicit:

1. future-thread default mutation;
2. current-thread bound mutation.

The CLI labels them separately. A single ambiguous toggle is rejected.

### Question availability and fail-closed policy

`canRequestUserInput` returns an admitted/denied result plus machine reason. The same result controls
both model-visible `request_user_input` specification and execution-time dispatch; stale tool
handles cannot bypass a later posture change. “Plan-only” is exposed only if the real turn mode is
available at this bridge. If it is absent/unknown, the restrictive answer is used.

Reviewer selection preserves current behavior: if guardian selection fails and auto-review exists,
the selector may choose auto-review. A posture label must report that effective route; it may not
promise fail-down to user unless the actual resolved policy does so.

Only locks with a production producer are rendered. Initially this may be managed policy/requirement
only. Cloud/config/organization labels with no bound loader are omitted, not synthesized. Full
access and any posture that weakens existing trust boundaries remain PARKED until separate security
review and explicit enablement.

### Atomic landing plan

1. **E1 — schema/model:** requested/effective/lock/revision types, lossless presets and legacy
   migration tests.
2. **E2 — durable authority/store:** versioned thread/default records, CAS mutation and immutable
   live projection under tests; no surface switch yet.
3. **E3 — behavior-live cutover/restore:** bind the durable authority, then remove the runner mode
   cell plus bootstrap/context-binding/web/agent-control direct writers in the same packet.
4. **E4 — command/front door:** adapt existing permission command and add posture projection/action.
5. **E5 — question guard:** dynamic spec plus execution guard use the same reader/revision.

### Executable work packets

Use [`01-execution-board.md`](./01-execution-board.md). E1 is a leaf/schema packet. E2–E5 merge
serially after RFC-03 C2/C3 because they share host/session/protocol owners. No preset UI lands before
the behavior-live authority replaces the old mode cell.

#### E1 — posture model, presets and migration (`codex/aug22-e1-posture-model`)

- **Prerequisite/owner:** C2 merged for final rebase; development may start earlier in
  `permission/posture/{types,presets,availability,ports}.ts` and unit tests only.
- **RED first:** partial preset application drops unspecified sandbox/reviewer/question fields;
  custom roundtrip is lossy; producer-free lock labels can be constructed.
- **Implement:** requested/effective split, domain revision, closed producer-backed lock reasons,
  lossless patch algebra, named-preset projection and legacy-absence migration to current behavior.
- **Verify:** property/table tests in `tests/unit/permission/posture/`, permission boundary, typecheck
  and serialization determinism.
- **Receipt:** every preset over randomized complete records preserves unmentioned fields and only
  fixtures with an admitted producer can produce a lock. **Stop** if a new PermissionMode or
  ReviewerTier discriminant is required.

#### E2 — durable posture authority/store (`codex/aug22-e2-posture-authority`)

- **Prerequisite/owner:** E1+C2; owns `permission/posture/authority.ts`, versioned extension in
  `permission-store.ts`, future-default entry/adapter and authority/store tests. No host/surface
  behavior changes in this packet.
- **RED first:** concurrent writes both succeed, persistence failure can publish a new live view,
  corrupt/unknown schema is not rejected, and a changed default has no thread-copy boundary.
- **Implement:** persist requested patch + bound question value + revision, separate future-thread
  default entry, validate/resolve candidate, CAS-persist then atomically publish immutable view.
  Missing legacy fields map to current behavior.
- **Verify:** authority race/transition, persistence failure, corrupt/version migration, new-vs-
  existing thread default and permission boundary tests.
- **Receipt:** one of two writers commits; failed persistence leaves the old revision/view; records
  close/reopen exactly. **Stop** if this needs a second posture JSON, event fold or compensation
  across two stores.

#### E3 — behavior-live cutover and restart (`codex/aug22-e3-posture-live-cutover`)

- **Prerequisite/owner:** E2; exclusive lock on `runner/assemble/session-state.ts`,
  `runner/assemble/session-authorities/build-posture.ts`, `host/bootstrap/bootstrap-session.ts`, host
  context binding, web control request and agent control-request apply paths.
- **RED first:** direct mode-cell write changes next-turn behavior outside posture revision; fresh
  runtime behavior disagrees with E2's restored view; writer scan enumerates current direct owners.
- **Implement:** bind E2 authority during restore, copy defaults at thread creation, resolve against
  current managed policy, make host/AgentConfig gates read the live getter, delete the mode cell and
  convert existing writers to delegating adapters. Kernel events remain evidence only.
- **Verify:** next-turn behavior, close/reopen, managed-policy-change-on-resume, direct-writer
  completeness ratchet, permission/runner/host/agent boundaries and typecheck.
- **Receipt:** one live writer/revision remains; two threads created across a default change retain
  distinct values after restart; unsupported binding rejects. **Stop** if any surface needs its own
  mirror or an imperative second apply target.

#### E4 — posture command and selector (`codex/aug22-e4-posture-frontdoor`)

- **Prerequisite/owner:** E3 and protocol chain through C3; owns `session.posture.set` additions,
  compatibility `session.permission.set` adapter, host projection and `apps/cli/slash/posture.ts`.
- **RED first:** codec lacks lossless patch/revision; current command can report success through an
  absent optional host method; CLI cannot distinguish current-thread from future-thread scope.
- **Implement:** versioned command/receipt, expected posture revision, requested/effective/locks
  projection, explicit current/default commands and named preset/custom rendering.
- **Verify:** protocol codec/scheduler/reducer tests, CLI selector test, unsupported-host negative,
  permission/protocol/kernel/host/surface boundaries.
- **Receipt:** CLI mutation changes the next turn and state echo at the same revision; stale command
  conflicts. **Stop** if the reducer becomes restore authority or surface remaps lock reasons.

#### E5 — question availability at spec and dispatch (`codex/aug22-e5-question-guard`)

- **Prerequisite/owner:** E4 + RFC-01 A5; owns `permission/posture/question-policy.ts`,
  `agent/dispatch-guard/question-availability.ts`, model-spec projection and dispatch guard tests.
- **RED first:** obtain a request-user-input tool/spec, change posture to deny, then invoke stale
  handle; current path still dispatches. Also cover unknown plan-mode context.
- **Implement:** one `QuestionAvailabilityReader` result controls both spec visibility and immediate
  pre-dispatch admission. Bind real turn mode; unknown uses restrictive result. Tool slice receives
  only a duck-typed/agent-owned guard and never imports permission.
- **Verify:** stale-handle integration, spec/dispatch parity table, mode transition, gate-OFF prompt
  snapshot, agent/tool/permission boundaries and typecheck.
- **Receipt:** every deny reason removes the spec and rejects stale dispatch; admitted posture does
  both. **Stop** if visibility and execution require separate policy implementations.

#### Full access (PARKED, no branch)

Do not add a preset, label or action. Unpark only after security review specifies the hard-deny
floor, managed ceiling, sandbox implications, explicit ceremony and recovery route. A surface-only
option or reliance on existing mode names is not admission.

### Architectural completion gates

- Direct-writer completeness ratchet requires live calls to the authority, has a non-zero owner
  floor and fails when any legacy state-cell `setPermissionMode` mutation is reintroduced. The
  protocol/host compatibility method may remain only as a delegating adapter and is tested as such.
- Preset property test applies every preset to arbitrary full records and proves unspecified fields
  survive; custom roundtrip is lossless.
- Resume rail restarts the runtime and proves effective mode, sandbox, reviewer route and question
  policy match the persisted thread record without event replay.
- Concurrent CAS rail admits one of two posture writes and returns conflict for the other.
- Stale-handle rail disables questions after specs were obtained and proves dispatch is denied.
- Managed/auto-review fixtures are non-vacuous: each producer is present and its removal flips the
  expected reason/route.

**R6 status:** architecture frozen; E1–E5 are required before the selector can be called behavior-
live. Full-access posture remains PARKED.

---

## Historical review incorporation (R4, superseded by R5)
Review (`_review-05.md`, verdict **REVISE**) confirmed the security core is READY-quality
and every code citation is accurate: **preset = projection, not a new mode** (no new
`ReviewerTier`/`PermissionMode`/`sandboxPolicy` discriminant); **no new fail-open** —
`hardDeny()` floor runs before the mode check (`policy.ts:277` before `:282`) so "Full
access" cannot become total fail-open; **managed-ceiling clamp** is authoritative and the
lock derives from the same `TaggedPermissionProfile` the kernel clamps against;
**question-OFF is fail-closed subtract-only** (byte-identical when absent, never
auto-answers). Three seam corrections are folded in — none are fail-open defects, all are
plumbing/scope:

1. **D3 seam was mis-identified (BLOCKER, fixed).** The RFC originally proposed wiring
   `session.posture.set` through the `ControlEffectApplier` (`apply.ts:33-39`). That is the
   **wrong subsystem.** The sibling verb `session.permission.set` does **not** land through
   the applier — it is a **SessionCommand** routed through the **event-sourced kernel
   scheduler + reducer**:
   - `scheduler.ts:903-905` → `await ctx.host.setPermissionMode?.(command.mode)` →
     `reconcileSessionPostureState`.
   - `reducer.ts:141-144` → writes `permissionMode` into `KernelSessionState` (event log).
   - echoed via `SessionHostDescription.permissionMode` (`ports.ts:28-30`, `describe()` `:218`).
   The `setPermissionMode` method on `ControlEffectApplier` (`apply.ts:49`, `permission-mode-set`
   effect kind) is a **separate** control-request drain lane (ADR-0496) that does **not** flow
   through `KernelSessionState` / the event log — so a posture wired there would (a) make
   re-validation non-authoritative (split-brain: the UI lock and the persisted mode could
   disagree) and (b) **lose the mode on resume/replay**. Corrected below (D3): mirror
   `session.permission.set` exactly through the SessionCommand → scheduler → `host.setPosture?`
   path. The real protocol write-set is therefore **materially larger** than the original
   "2 verbs + 1 applier method" — see the revised Effort/write-set.

2. **Read verb deduplicated (fixed).** The RFC proposed a new `session.posture.list` read
   verb. Redundant — `SessionHostDescription` (`ports.ts:28`) already echoes posture on every
   `session.state.updated`, reconciled by `reconcileSessionPostureState` (`scheduler.ts:241`).
   The posture pill/availability now **extends that existing echo**, adding no bespoke verb.

3. **`askOutsidePlan` persistence + resume receipt specified (fixed).** `buildUserInputBlock`
   (`tier1/user-input.ts:21`, called `features.ts:270`) receives only `AgentConfig` today —
   it sees **neither** the thread record **nor** plan-mode. The revised D4 states where the
   knob persists and how it re-binds on resume/replay (the resume receipt).

## Motivation
Codex ships a first-class, per-thread **approval-posture selector** in the composer —
a dropdown answering *"How should ChatGPT actions be approved?"* with four modes
(Ask for approval / Approve for me / Full access / Custom-config.toml), plus **locked
tooltips** when org policy or config fixes the posture ("Managed by enterprise policy",
"Disabled in config.toml", "Disabled by requirements.toml", "Unavailable while working
in the cloud"). It also ships a per-thread `requestUserInput` toggle — *"Allow Codex to
ask questions outside Plan mode. Changes apply only to new threads."*

quanta has reviewer routes, a per-thread permission record, a mode-set command, and the
mid-task-question tool. It does **not** yet have one live resolved posture owner coupling
those pieces, nor a restart restore/default-binding contract. The delta is therefore the
R5 authority + durability + CAS protocol first, followed by the surface. UI-only composition
over today's independent values is explicitly out of scope.

## Non-goals
- NOT re-inventing the reviewer routes, `ThreadPermission`, or the mode gate. This RFC is
  a *composer* over `reviewer-default-policy.ts` + `permission-store.ts`.
- NOT changing any default posture. Gate-absent ⇒ selection logic is byte-identical to
  today's `selectDefaultReviewer`.
- NOT adding new `ReviewerTier`/`PermissionMode`/`sandboxPolicy` discriminants. The four
  Codex "modes" are *presets over existing enums*, not new kernel states.
- NOT auto-granting sandbox/network escalations (that is the separately-gated guardian
  `escalate` lane; out of scope here).
- NOT a cloud/enterprise MDM policy *engine* — we consume the managed ceiling that
  `profile-inheritance.ts` already produces; we do not author org policy.

## Current-state (grounded — the routes exist)

**Reviewer routes (RFC-04 already built).** `ReviewerTier = "user" | "auto_review" |
"guardian_subagent"` (`src/permission/types.ts:131`). Dispatch is
`reviewAction(action, ctx, port)` (`src/permission/reviewer.ts:269`); a throwing/invalid
port **fails CLOSED at the gate** — the catch emits a terminal not-allowed and re-throws,
never a silent allow (`src/permission/reviewer.ts:300-316`).

**Default-reviewer selection (the map target).** `selectDefaultReviewer(...)`
(`src/permission/reviewer-default-policy.ts:76-109`) already resolves a tier from
`{threadPermission, permissionMode, sandboxProfile, hasAutoReview, hasGuardianReview,
autoReviewEnabled}`. Its explicit-authority branch `selectExplicitAuthorityReviewer`
(`:41-59`) reads `ThreadPermission.approvalsReviewer` (`"user" | "agent"`) +
`approvalPolicy` (`"on-request"`). Guardian admission failure may continue to
`auto_review` when available, or to `user`; the production selector is the route SSOT.

**Per-thread posture record.** `ThreadPermission {approvalPolicy: "never"|"on-request"|
"on-failure"|"always"; approvalsReviewer: "user"|"agent"; sandboxPolicy: read-only |
workspace-write{writableRoots,networkAccess} | danger-full-access}`
(`src/permission/permission-store.ts:71-82`). Facade get/set/clear in
`src/permission/per-thread-store.ts:18-37`. `threadAllowsMutation` is **fail-closed**:
empty/absent `writableRoots` under `workspace-write` ⇒ DENY, not writable-anywhere
(`:58-77`).

**Per-host axis (also fail-closed).** `HostAgentMode = "full-access"|"read-only"|"custom"`;
`hostMutationVerdict` maps `custom → "defer"` (caller must resolve, never implicit allow)
(`src/permission/per-host-mode.ts:98-112`).

**Permission mode + mid-session set (transport seam, not restore authority).** `PermissionMode =
"default"|"acceptEdits"|"bypass"|"auto"` with `ALL_PERMISSION_MODES` + fail-closed guard
`isPermissionMode` (`src/permission/types.ts:80-91`). Mid-session change is a **SessionCommand**
`session.permission.set {mode}` (`src/protocol/session/commands.ts:54,107-111`) that flows
through the kernel scheduler + reducer, NOT the control-request applier:
`scheduler.ts:903-905` (`ctx.host.setPermissionMode?.(command.mode)` →
`reconcileSessionPostureState`) → `reducer.ts:141-144` (writes `permissionMode` into
`KernelSessionState`) → echoed on `session.state.updated` via
`SessionHostDescription.permissionMode` (`ports.ts:28-30`, `describe()` `:218`). Its
protocol surface spans `commands.ts` (interface `:54` + `SessionCommand` union `:97` +
`SESSION_COMMAND_TYPES` `:107-111`), `codec.ts`, `builders.ts` (`buildPermissionSet` `:129`),
`verb-surface.ts` (`:80`), `sdk/runtime/handle-adapter.ts` (`:171-174`), and
`apps/web-daemon/runtime-factory.ts`. ⚠️ The `setPermissionMode` method on
`ControlEffectApplier` (`src/agent/control-request/apply.ts:49`, `permission-mode-set` effect
kind) is a **separate** control-request drain subsystem (ADR-0496) that does **not** touch
`KernelSessionState` / the event log. Neither lane, by itself, is a fresh-runtime posture
restore authority; R5 adds explicit durable host rebind.

**Hard-deny floor survives every posture (the fail-open backstop).** `evaluate()` checks
`hardDeny(action)` **before** the read-only fast-path and **before** mode, so
`bypass`/`acceptEdits` never clear a HARD_DENY hit (`src/permission/policy.ts:270-282`).
"Full access" therefore cannot become a total fail-open — the `rm -rf /`-class floor is
non-bypassable.

**Managed / enterprise primitives (not yet the live lock SSOT).** `ProfileTag = "managed" | "external"`;
a managed base imposes a ceiling a derived (user) profile **cannot widen**
(`src/permission/profile-inheritance.ts:80-84`, `onManagedWiden: "throw"|"clamp"` `:115-118`);
`named-profiles.ts:62` carries `managedBy: "admin", auditRequired: true`. The resolver and
manager currently carry bare profiles, so D0 must bind clamp provenance and the live
evaluator before any tooltip can claim authority.

**Mid-task question (tool exists, posture-knob missing).** `request_user_input`
(`src/tool/request-user-input.ts`) lets the model ask + block on a typed 2-arm outcome
(`answer` / `cancelled`); read-only + concurrency-UNSAFE. It is registered whenever
`userInputPort` is wired — **globally, not plan-only** (`src/agent/mode.ts:254`;
`src/agent/tier1/user-input.ts:21-24`; gate `config-slot userInputPort`, CLI default-ON,
`src/tool/surface/gated-tools.ts:402-409`). So quanta ALREADY "asks outside plan mode"
when the port is present — but presence is **binary/always-on**; there is no per-thread
posture knob to *opt out* the way Codex's toggle does.

**The real delta:** D0 resolved live authority; durable schema/migration and fresh-host
rebind; lossless revisioned preset mutation; admitted lock producers; and a future-thread
default plus one dynamic visibility/dispatch predicate for `request_user_input`.

## Design

### D0 — Resolved posture owner (blocking prerequisite)

Introduce a permission-slice `PermissionPostureAuthority` whose read model is the R5
`ResolvedPermissionPosture`. Composition must bind the exact same authority to:

1. the live permission evaluator and reviewer selector;
2. the `session.state.updated` posture projection;
3. the `setPosture(patch, expectedRevision)` server handler; and
4. host construction/resume from the durable posture store.

No UI-specific lock derivation may inspect environment/config independently. A lock exists
only if a production policy producer contributes it to the authority and that same lock
participates in write rejection. Start with the managed ceiling that is actually wired;
requirements/cloud/server-default arms remain absent until their owners exist.

### D1 — Lossless posture presets

New leaf module `src/permission/posture-preset.ts` contains only the closed preset union and
`presetToPatch`. It returns a patch, not a partial `ThreadPermission` masquerading as a
complete record.

Closed union — the SSOT for the picker:
```ts
export type PosturePreset = "ask" | "approve_for_me" | "full_access" | "custom"
export const ALL_POSTURE_PRESETS = ["ask","approve_for_me","full_access","custom"] as const
export const isPosturePreset = (v: unknown): v is PosturePreset =>
  typeof v === "string" && (ALL_POSTURE_PRESETS as readonly string[]).includes(v)  // fail-closed
```

`setPosture` merges the patch into the current complete record, preserving
`sandboxPolicy`, `askOutsidePlan`, writable roots, and network access unless the selected
preset explicitly owns that field. `custom` clears only `requestedPreset`; it does not call
`clearThreadPermission` and does not delete unrelated per-thread state.

| Preset (Codex label)        | `approvalsReviewer` | `approvalPolicy` | resulting route            | `PermissionMode` |
|-----------------------------|---------------------|------------------|----------------------------|------------------|
| **Ask for approval** (dflt) | `user`              | `on-request`     | `user` (interactive HITL)  | `default`        |
| **Approve for me**          | `agent`             | `on-request`     | existing selector result*  | `default`        |
| **Full access**             | `agent`             | `never`          | `auto_review`/route, but…  | `bypass`†        |
| **Custom (config.toml)**    | — (clear override)  | —                | stored named-profile       | from profile     |

\* The existing selector remains authoritative. Depending on guardian and auto-review
capabilities, its result may be `guardian_subagent`, `auto_review`, or `user`. The preset
must not duplicate or promise a narrower route than that selector implements.

† "Full access" is the **only** hazardous preset. It does NOT get a bespoke bypass route —
it sets `PermissionMode: "bypass"`, which still passes through `evaluate()` and thus the
**non-bypassable HARD_DENY floor** (`policy.ts:270-282`). See Security-model for the
fail-closed constraints that gate whether this preset is even *offered*.

**Custom** does not invent policy. It removes only the preset projection and asks the
authority to resolve the existing complete record/profile chain again.

### D2 — Locked-state derivation from admitted producers only

`deriveLockedPostures(resolved): Record<PosturePreset, PostureAvailability>` projects the
live resolved posture. It does not accept raw env/config facts from the surface.
```ts
type PostureAvailability =
  | { state: "available" }
  | { state: "locked"; reason: LockReason; label: string }  // label = tooltip text
type LockReason = "managed_by_enterprise" // v1: only a wired enforcement producer
```

The union expands only when a production producer is bound to
`PermissionPostureAuthority` and a paired test proves that removing enforcement makes both
the write and the UI projection wrong. Unknown/unavailable policy facts fail closed at the
authority; they do not become invented tooltip reasons.

### D3 — Surfaces and durable reconciliation
- **CLI** — a `/approve` (alias `/posture`) slash command + a status-line posture
  indicator. `/approve` with no arg prints the four options with lock reasons; `/approve
  <preset>` sends one CAS command. It never writes route and mode independently.
- **Web/Tauri + IDE** — a composer dropdown. **Read (availability) rides the existing
  state echo, no new verb:** extend `SessionHostDescription` (`ports.ts:28`) +
  `KernelSessionState` + `reconcileSessionPostureState` (`scheduler.ts:241`) to carry the
  active `PosturePreset` + its `deriveLockedPostures` availability, delivered on the
  `session.state.updated` event the dropdown already consumes. **NO `session.posture.list`
  verb** (it would duplicate the echo that already carries `permissionMode/identityMode/
  toolProfile`; see 리뷰 반영 #2).
- **Write — a new SessionCommand on the session scheduler path.** Add
  `session.posture.set {preset, expectedRevision}`, validated by
  `isPosturePreset` (fail-closed at the codec boundary). It routes through the kernel
  scheduler for host-authoritative mutation and acknowledgement; durability comes from
  the D0 store/rebind contract, not command-event replay:
  - `commands.ts` — new `SessionPosturePreSetCommand` interface + add to the `SessionCommand`
    union (`:97`) + `SESSION_COMMAND_TYPES` (`:107-111`) + an `isSessionCommandType`-covered
    literal;
  - `codec.ts` — encode/decode arm; `builders.ts` — `buildPostureSet` mirroring
    `buildPermissionSet` (`:129`); `verb-surface.ts` — `posture:` verb next to `permission:`
    (`:80`);
  - `scheduler.ts` — a `command.type === "session.posture.set"` arm mirroring `:903-905`:
    `await ctx.host.setPosture(command.preset, command.expectedRevision)` (lossless merge,
    clamp, persist, live rebind, echo), then
    `reconcileSessionPostureState(nextState, ctx.host.describe())`; plus the terminal
    `case "session.posture.set"` in the switch at `:938`;
  - `reducer.ts` — record the acknowledged projection/revision for clients; this is not the
    durable host restore owner;
  - `sdk/runtime/handle-adapter.ts` — `posture.set` on the handle (mirror `permission.set`
    `:171-174`); `apps/web-daemon/runtime-factory.ts` — host `setPosture?` wired to
    `presetToAuthority` + the persist re-validation.
  A host without posture-mutation capability must omit/hide the command surface or return
  `unsupported`; it must never acknowledge a no-op.

On process restart, runtime construction reads the durable posture store, resolves the
current managed ceiling, initializes the live mode/reviewer owner, and only then publishes
`SessionHostDescription`. A command-event replay test is insufficient.

### D4 — Mid-task-question default, binding, and enforcement

Add a durable user/workspace `PermissionDefaultsStore` field
`askOutsidePlanForNewThreads`. Thread creation copies that value into the complete
`ThreadPermission.askOutsidePlan`; changing the default affects only subsequently created
threads. Resume reads the existing thread binding. There is no mid-thread silent rewrite.

**Wiring into the builder (the real integration the RFC previously treated as a one-liner).**
`buildUserInputBlock(config)` (`tier1/user-input.ts:21`, called `features.ts:270`) today sees
**neither** the thread record **nor** the current plan-mode. Two facts must reach it:
(a) the persisted `askOutsidePlan` for the thread, and (b) whether the turn is in plan mode.
Because tool inventory can be cached while plan mode changes per turn, define one dynamic
`canRequestUserInput({threadId, turnMode})` predicate owned by the bound posture. Both
visible-spec generation and `request_user_input` dispatch call it. When false outside plan
mode the tool is hidden; a forged/direct call is rejected with a typed permission error.
Absent migrated state preserves the current behavior.

**Receipt:** default=false → create thread A → outside-plan tool absent/direct call denied;
change default=true → A is unchanged → create thread B → tool available; restart → A/B
retain their own bindings.

## Security model (normative)

1. Presets never bypass `reviewAction`, `evaluate`, or the hard-deny floor.
2. The UI projects the same `ResolvedPermissionPosture` used by the live evaluator.
3. Every mutation is server-revalidated, revision-checked, durable before acknowledgement,
   and echoed from the resulting authority value.
4. Unknown preset, stale revision, missing capability, unresolved policy, or failed persist
   is a typed denial with no live mutation.
5. Full access remains PARKED until a production policy source and explicit dangerous-action
   ceremony are specified. A feature flag alone is not a security boundary.
6. The question knob is subtract-only and enforced at both discovery and dispatch.

## Default-OFF and migration

`QUANTA_PERMISSION_POSTURE` remains a registered default-OFF runtime gate for the new
surface. The authority/store schema may land first behind internal composition because it
must not make an unsupported command a silent no-op. Missing persisted fields migrate to
today's effective posture and current question-tool behavior. Gate-off receipts compare
the real evaluator, reviewer selector, state echo, and tool registry/dispatch against the
baseline.

## TDD + hellgates

- **Authority identity:** evaluator, state echo, and mutation handler observe the same
  resolved revision/object; substituting a UI-only resolver makes the test RED.
- **Lossless presets:** every preset patch preserves sandbox, writable roots, network, and
  question binding; `custom` does not delete the record.
- **Selector matrix:** `approve_for_me` covers guardian available/unavailable and
  `hasAutoReview` true/false; expected route comes from the production selector.
- **Managed clamp:** hostile widening is rejected by the mutation authority and shown
  locked by the echoed projection. Removing the live clamp makes both assertions RED.
- **CAS:** two clients mutate revision N; one succeeds and the other receives stale-state
  without overwriting the winner.
- **Restart receipt:** persist posture, destroy runtime, construct a new host from the
  store, and prove evaluator + echo agree. Do not seed the new host by replaying the old
  command event.
- **Unsupported host:** verb hidden or typed `unsupported`; never successful no-op.
- **Question default/binding:** new-thread-only matrix and restart receipt from D4.
- **Visibility/dispatch parity:** outside-plan tool hidden and forged direct invocation
  denied by the same predicate.
- **Default-off paired control:** gate-off production composition remains behavior-identical.

## Effort

**Large.** This is not a surface-only feature. It requires the live resolved-posture owner,
durable schema/migration and host rebind, CAS mutation protocol, state echo, lossless preset
projection, future-thread defaults, dynamic tool enforcement, CLI/web surfaces, and
non-vacuous restart/security tests. Estimate only after D0 owner placement and store reuse
are frozen; the prior Medium estimate is revoked.

## Risks + traps

- Split route/mode writers create a posture the UI cannot explain. One CAS authority owns
  both.
- Event receipts can look durable while a fresh runtime silently resets to host defaults.
- Partial preset replacement can erase sandbox constraints.
- Capability-optional host methods can acknowledge mutations that never happened.
- Cached tool inventories can hide a tool while direct dispatch remains open.
- Synthetic lock labels are security theater if no production producer enforces them.
- Full access turns a pre-existing bypass into a discoverable one-click action; keep PARKED.

## Sequencing

1. D0 resolved authority + identity/managed-clamp hellgate.
2. Durable store, migration, restart host rebind, and revision CAS.
3. Lossless preset projection and selector matrix.
4. Session command/state echo/CLI surface; web only after the same echo is consumed.
5. Future-thread default + immutable thread binding + shared question predicate.
6. Re-evaluate full-access ceremony and additional lock producers separately.

No RFC-04 implementation dependency remains beyond reusing its existing reviewer routes.
Shared session protocol surfaces must be serialized with other RFCs touching the scheduler,
codec, or CLI command registry.

## Open decisions

- Durable posture store reuse versus a new versioned store; decide by restart ownership,
  not file convenience.
- Whether the user-facing `custom` label includes resolved profile provenance.
- Which real cloud/requirements policy producer, if any, earns a new lock-reason arm.
- Full-access confirmation ceremony and audit receipt. Until decided, it stays PARKED.

---

## Historical audit log (R1→R4, superseded by R5; not implementation authority)

### Round 1 — "does exposing Full access create a fail-open?"
- **Attack:** operator (or a hostile web client) selects "Full access" → agent runs
  `rm -rf ~/repo` / `git push --force` / arbitrary shell with zero prompts.
- **Finding (partial fail-open, bounded):** `rm -rf /`-class is BLOCKED — `evaluate()`
  runs `hardDeny(action)` before mode, so bypass never clears a HARD_DENY hit
  (`policy.ts:270-282`). Verified in code, not assumed. BUT bypass DOES auto-approve every
  non-HARD_DENY mutating action (that is what bypass means today). So "Full access" is not
  a *new* hole — it is a one-click surfacing of the pre-existing
  `QUANTA_SANDBOX=danger-full-access` posture. The hazard is **discoverability**: a
  dropdown makes the most dangerous posture one click away.
- **Fix folded into design:** (a) "Full access" default-locked + behind the feature gate;
  (b) individually lockable by managed/config/requirements/cloud; (c) Q3 raises a typed
  confirmation; (d) bypass-floor invariant test with red-on-injection so a future refactor
  can't quietly turn it into a total fail-open. Verdict: acceptable *iff* default-locked;
  NOT acceptable as a plain always-visible option. Design updated to default-locked.

### Round 2 — "locked-state trust + bound-at-creation"
- **Attack A (gray-out theater):** the surface shows "Managed by enterprise policy" but the
  persist path still writes the posture (tooltip is cosmetic) → operator bypasses org
  policy via the API verb while the UI lies.
- **Finding:** a naive impl (UI-only disable) IS vulnerable. Closed by Security-model #4
  (persist re-validates via `deriveLockedPostures` at write time) + the derivation reads the
  SAME `TaggedPermissionProfile` the kernel clamps against (`profile-inheritance.ts`,
  `onManagedWiden:"throw"`), so the lock and the clamp cannot disagree. Red-on-injection
  test pins it: remove the managed check ⇒ RED.
- **Attack B (bound-at-creation escape):** does binding `askOutsidePlan` at creation let a
  thread that started restricted silently gain the ask-tool mid-thread, or vice-versa?
- **Finding:** No — bound-at-creation means the value is *fixed* for the thread; a
  mid-thread flip is a no-op by design (matches Codex "new threads only"). The knob only
  *subtracts* the tool (never adds capability), so the failure mode is at worst "tool
  unexpectedly absent", never "unexpectedly present". Safe. Documented as R3.
- **Attack C (config widens):** a repo-supplied `config.toml`/`requirements.toml` sets
  `full_access` as default to escape the managed clamp.
- **Finding:** closed by Security-model #5 — config is narrow-only; a widening directive is
  ignored; managed ceiling wins. Added the untrusted-config test (parity with the
  trusted-surface rule that batch/ci contexts must not honor repo config as authority).

### Round 3 — "default-OFF byte-identity + vacuous tests + SSOT desync"
- **Attack A (not byte-identical):** does adding `askOutsidePlan` / the posture presets
  perturb the default (gate-off) tool registry or `selectDefaultReviewer` output?
- **Finding:** must be proven, not asserted. `askOutsidePlan` absent ⇒ `buildUserInputBlock`
  unchanged; presets never computed when gate off; `selectDefaultReviewer` untouched.
  Mandated the non-vacuous default-OFF snapshot test across all four preset-equivalent
  inputs. If any differs gate-off ⇒ RED. (Memory `jul-16` vacuous-narrowing trap: the test
  must flow the full union through a real registry build, not a single-literal stub.)
- **Attack B (vacuous availability tests):** a test that asserts `full_access` is locked
  under one hard-coded managed fixture proves nothing about the other presets / contexts.
- **Finding:** required `Record<PosturePreset, PostureAvailability>` exhaustive coverage +
  a drift-guard so a new preset fails to compile until classified
  (`exhaustive-record-classification-drift-guard`). Availability asserted for EVERY preset
  under managed/config/cloud/clean contexts (paired-control), not one.
- **Attack C (SSOT desync):** CLI `/approve` and web dropdown each compute their own
  label→route mapping ⇒ they drift; one exposes `full_access` the other locks.
- **Finding:** real risk. Fixed by R4 — `presetToAuthority` + `deriveLockedPostures` are the
  SINGLE writers, called by both surfaces; neither surface embeds its own mapping. Added a
  test that both the CLI arg parser and the web verb handler resolve through the one leaf fn.
- **Residual open:** Q2 (cloud-lock signal authority) and Q3 (typed confirm for full-access)
  remain genuinely open — flagged, not hand-waved. No further fail-open found after R3;
  convergence reached on the *security* posture (default-locked full-access + persist
  re-validation + non-bypassable floor). Surface ergonomics (Q1/Q4) are non-security and
  deferred.

### Round 4 — external review incorporation (`_review-05.md`, verdict REVISE)
- **Security core confirmed by the reviewer**, not just self-asserted: hardDeny beats every
  posture (`policy.ts:277` before `:282`), preset = faithful projection over
  `selectExplicitAuthorityReviewer` with a real fail-*down*, managed clamp shares one source
  of truth, question-OFF is subtract-only, unknown values rejected at the boundary. Every
  code citation in the RFC verified accurate against HEAD `9d5369d31`.
- **Correction 1 (BLOCKER — wrong protocol seam):** the RFC wired `session.posture.set` to
  `ControlEffectApplier` (`apply.ts`). Grounded refutation: `session.permission.set` — the
  sibling being modeled — routes through the **event-sourced scheduler** (`scheduler.ts:903-905`
  `ctx.host.setPermissionMode?`) → **reducer** (`reducer.ts:141-144`, writes `KernelSessionState`),
  NOT the applier. Verified by grep this pass. Wiring to the applier would make re-validation
  non-authoritative (split-brain) and lose the mode on resume/replay. Re-scoped D3 + Effort to
  the full SessionCommand write-set (commands/codec/builders/verb-surface/scheduler/reducer/
  sdk/web-daemon). The `apply.ts:49` `setPermissionMode` is a *separate* control-request drain
  lane (ADR-0496) — explicitly disqualified.
- **Correction 2 (read-verb dedup):** dropped the proposed `session.posture.list`; availability
  now rides the existing `SessionHostDescription` / `reconcileSessionPostureState` echo
  (`ports.ts:28`, `scheduler.ts:241`) — one owner for "current session posture", less surface.
- **Correction 3 (`askOutsidePlan` receipt):** specified persistence on `ThreadPermission`
  (durable `permission-state.json`, replay-durable — chosen over non-durable `AgentConfig`),
  the build-time + turn-time wiring into `buildUserInputBlock` (which sees neither thread state
  nor plan-mode today), and resume re-bind from the keyed store. Added a resume-durability test
  with red-on-injection (applier-wiring ⇒ mode lost ⇒ RED).
- **Verdict path:** all three are plumbing/scope, none fail-open. §E/§G security invariants and
  the red-on-injection suite kept intact. This is the FINAL, review-incorporated version.
