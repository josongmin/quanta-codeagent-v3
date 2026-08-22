# Aug-22 absorption architecture blueprint

**Status:** IMPLEMENTATION PLAN — authority placement and folder boundaries frozen; code not
started.

**Truth snapshot:** `9d5369d310bba9cfcdf2508ca62e6274f184cdd4`. The current bench/report dirty
overlay is outside this plan's write authority. In particular, RFC-07 report work does not
start until that owner releases `src/runner/batch/report.ts`.

## 1. Architectural decision

Do not create a `src/control-plane`, `src/features/aug22`, or a second event bus. The seven
RFCs share a delivery pattern, not a business domain. State stays with the owning domain;
cross-slice construction happens once below the app surfaces.

```text
domain authority -> agent/runner adapter -> kernel host command/echo -> thin app surface
       ^                    |                         |
       +---- durable owner -+----- front-door receipt+
```

Layer ownership:

| Layer | Owner | Rule |
|---|---|---|
| L0 domain | `objective`, `subagent`, `git`, `activity`, `permission`, `skill`, `observability` | Pure model, transition, policy, narrow ports |
| L1 bridge | `agent` | Only layer allowed to join domain ports into turn/tool behavior |
| L2 assembly | `runner/assemble`, `host/runtime`, `kernel/session` | Construct authorities, bind effects, serialize commands, echo projections |
| L3 surface | `apps/cli`, `apps/web-daemon` | Parse/render only; no reusable state or policy |

`kernel/session` is a command serializer and client projection cache. It is not the durable
permission, objective, skill, or attention store.

## 2. Target folder tree

Only folders marked `NEW` are added. Existing files are moved only in an atomic import
migration; no compatibility barrel remains behind.

```text
src/
  objective/                                      # NEW: promote agent/objective atomically
    model.ts                                      # Objective, criterion, status, revision
    mutations.ts                                  # closed ObjectiveMutation union
    authority.ts                                  # only mutation entrypoint + CAS
    store.ts                                      # current store evolved; no second store
    ports.ts                                      # gate, persistence, criterion executor
    criteria/
      model.ts                                    # declared check + completion provenance
      verifier.ts                                 # verifier-only completion transition
    execution/
      lease.ts                                    # per-thread execution lease
      lifecycle.ts                                # timeout/cancel/source-digest/CAS
    index.ts

  session/
    user-question/                                # NEW: question truth, not UI state
      types.ts                                    # requestId, owner task/thread, outcome
      broker.ts                                   # request/answer/cancel/list pending
      index.ts

  git/
    review-source/                                # NEW: pure diff semantics
      types.ts                                    # closed DiffSource union
      resolve.ts                                  # source -> typed git operation
      generated-attributes.ts                     # NUL-safe attr parser/filter
      ports.ts                                    # injected GitReadPort / last-turn port
      index.ts
    passive-classify/
      pr-action.ts                                # NEW: exact gh argv grammar
      classifier.ts                               # existing owner, consumes grammar

  activity/
    progress.ts                                   # NEW: typed indeterminate/ratio progress
    subscription.ts                               # NEW: reader/writer/subscription ISP
    producers/
      worktree.ts                                 # local structural input -> operation/step nodes
    store.ts                                      # existing store gains subscribe; no new bus

  permission/
    posture/                                      # NEW: one behavior-live posture owner
      types.ts                                    # resolved posture + domain revision
      presets.ts                                  # lossless patch, never full replacement
      availability.ts                             # projection of admitted lock producers
      authority.ts                                # validate -> persist -> publish
      question-policy.ts                          # canRequestUserInput predicate
      ports.ts                                    # narrow store/default/policy contracts
      index.ts
    permission-store.ts                           # evolve existing schema; no posture JSON twin
    two-layer-manager.ts                          # resolver component, no longer live owner

  skill/
    runtime/                                      # NEW: dynamic session skill authority
      types.ts                                    # active/search/management projections
      authority.ts                                # sync, CAS enable/disable, active resolve
      projections.ts                              # one registry -> three views
      actions.ts                                  # copy/reveal/enable/disable decisions
      disabled-store-port.ts                      # versioned durable-set port
      adapters/
        json-disabled-store.ts                    # concrete jailed adapter
      index.ts
    registry.ts                                   # existing precedence SSOT, unchanged owner
    skill-tool.ts                                 # execution-time active resolve
    tool-search.ts                                # dynamic searchable getter

  tool/
    types.ts                                      # optional ToolDynamicSpec contract
    registry.ts                                   # dereference dynamic spec per model request

  observability/
    failure-taxonomy/                             # NEW: pure facts -> labels
      types.ts                                    # versioned FailureTaxonomyFacts
      classify.ts                                 # no ObservationBundle dependency
      index.ts

  agent/
    attention/                                    # NEW: legal cross-slice projection bridge
      types.ts
      resolver.ts                                 # TaskRegistry x UserQuestionBroker join
      port.ts                                     # read-only navigation contract
      index.ts
    user-question/
      tool-adapter.ts                             # ToolContext request -> broker request
      task-correlation.ts                         # explicit taskId; no rootId inference
    observation/metrics/
      failure-facts.ts                            # ObservationBundle/events -> compact facts
    objective-execution/
      workspace-barrier.ts                        # shared with normal-turn file mutation
    dispatch-guard/
      question-availability.ts                    # same predicate for spec + dispatch
    tool-surface/
      live-specs.ts                               # per-turn spec availability/projection
    tier1/
      objective.ts                                # thin tool adapter only
      skill.ts                                    # consumes SkillRuntimeAuthority

  runtime/
    worktree/
      types.ts                                    # WorktreeCreateProgress closed union
      create.ts                                   # split from worktree-fork.ts
      progress-parser.ts                          # git-owned progress, ambiguity -> indeterminate
    worktree-fork.ts                              # retired after atomic import migration

  runner/
    assemble/
      session-authorities/                        # NEW: only multi-domain constructor
        types.ts
        build.ts                                  # flat orchestration only
        build-objective.ts
        build-posture.ts
        build-skills.ts
        build-questions.ts
        restore.ts
        lifecycle.ts
        index.ts
    session-ops/
      worktree/
        transition.ts                             # split from current-thread-worktree.ts
        activity-adapter.ts
    batch/
      failure-facts.ts                            # persist/read versioned inline facts

  protocol/
    session/
      commands.ts                                 # extend existing union; no new command bus
      codec.ts
      builders.ts
    observability/
      failure-facts.ts                            # persisted DTO decoder/version guard

  kernel/session/
    ports.ts                                      # narrow host methods + projection DTOs
    scheduler.ts                                  # serialize/ack; no policy
    reducer.ts                                    # projection only; not restore authority

  host/runtime/
    session-authority-host.ts                     # NEW: domain authorities -> SessionHost

  apps/cli/
    slash/
      attention.ts
      objective.ts
      posture.ts
      skills.ts
    repl/
      activity-renderer.ts                        # subscribe before operation

  apps/web-daemon/
    authority-readouts.ts                         # projections only; no independent discovery
    authority-actions.ts                          # authenticated supported mutations only
```

## 3. Per-session assembly owner

`src/runner/assemble/session-authorities/build.ts` constructs the authority graph. It may
import across slices because `runner/assemble` is an explicit composition layer. It contains
no transition logic.

```ts
interface SessionAuthorities {
  readonly tasks: TaskRegistry
  readonly objective: ObjectiveAuthority
  readonly posture: PermissionPostureAuthority
  readonly skills: SkillRuntimeAuthority
  readonly questions: UserQuestionBroker
  readonly attention: AttentionReader
  readonly activity: ActivityReader & ActivityWriter
}
```

`TaskRegistry` construction moves out of `buildSessionFeatures` into this assembly. The
subagent tools, lifecycle emitter, attention resolver, CLI, and web all receive that exact
instance; feature builders may consume it but may not mint a fallback registry.

Apps never receive this whole object. Each surface factory receives only its narrow reader,
writer, or action port. `AgentConfig` receives narrow live getters/guards rather than
snapshots. `SessionHost` receives mutation methods and projection getters.

Restore order is fixed:

1. load session identity and `SavedSession`;
2. load durable objective/posture/default/disabled state;
3. resolve current managed/admin policy;
4. construct authorities and bind live permission/tool behavior;
5. construct kernel host and publish `SessionHostDescription`;
6. construct surface adapters and start subscriptions;
7. admit the first turn.

No turn may run between steps 2 and 5.

## 4. Authority contracts

### 4.1 Mutation contract

Every durable mutable domain uses its own revision namespace. Do not reuse the kernel's
session revision as objective/posture/skill revision.

```text
validate input -> check expected domain revision -> evaluate policy/HITL
-> stage complete next value -> persist next value -> publish live value -> echo receipt
```

Persist or policy failure leaves the previous live value intact. Stale revision and missing
host capability are typed rejections. Optional host methods never acknowledge a no-op.

An HITL mutation uses a two-phase form:

```text
prepare(current revision, mutation, actor) -> immutable candidate
-> release domain/kernel lease -> wait for approval
-> commit(candidate, expected revision) -> success or stale
```

No kernel/domain writer lock is held while the operator decides. Revised approval is a new
prepare request; it does not mutate the candidate in place.

Do not build a generic `Authority<T>` framework now. Objective, posture, and skills have
different policy and persistence semantics. Extract only a shared revision helper after
three production implementations prove an identical primitive.

### 4.2 Read/projection contract

- `read()` is immutable and deterministic.
- Model prompt, visible tool specs, dispatch, CLI, and web read the same domain revision.
- Management projections may contain disabled/locked rows; active projections may not.
- Free-form `meta` is not used for progress, policy, or completion. Those receive closed
  typed fields.
- All ordered output uses `byteCompare`, never locale ordering.

`ActivityReader.subscribe` immediately emits the current snapshot and then monotonically
sequenced snapshots for subsequent events. The sequence is store-local observation order,
not a durable domain revision and not an agent count.

### 4.3 Dynamic tool contract

The current static tool registry is retained, but two dynamic seams are added:

1. optional `ToolDynamicSpec.getSpec()` for model specs that depend on live authority state;
   `ToolRegistry.specs()` dereferences it at each request.
2. Agent-owned `ToolAvailabilityPort` applied both when projecting specs and immediately
   before dispatch. RFC-05's question policy uses this port.

`SessionFeatures` carries a `SkillRuntimeReader`, not a copied `activeSkills` array or copied
allowlist/override maps. `same-turn-engine`/`context-assembler` dereference the reader at each
turn before prompt assembly, and the dispatch skill gate dereferences it for each call.

The `Skill` tool performs an additional argument-level `resolveActive(name)` at execution
time. This prevents a stale tool handle from invoking a disabled skill.

At each turn boundary `SkillRuntimeAuthority.sync()` checks the durable disabled-set
revision and republishes a complete active/search/management view. This provides
same-process and cross-process convergence without inventing another event bus.

## 5. RFC placement and data flow

### RFC-01 — attention

`UserQuestionBroker` is the truth. `TaskRegistry` remains the task truth. The join lives in
`@/agent/attention` because `@/subagent` is forbidden from importing `@/session`; attention
is a read-only bridge keyed by explicit `taskId`:

```ts
type QuestionOwner =
  | { kind: "root" }
  | { kind: "task"; taskId: string }
```

Only the task arm joins the subagent attention list. Root questions remain session-level
questions; no synthetic root task or ancestry-derived root id is minted.
The broker itself is session-scoped; protocol/host routing supplies session identity outside
the domain record instead of duplicating it on every owner arm.

```text
request_user_input -> agent tool adapter -> broker.request(requestId, taskId, prompt)
                                      -> attention resolver -> CLI row
/attention answer <requestId> <text> -> broker.answer -> blocked tool resumes
```

Do not add `awaitingInput` to every idle task and do not infer a session root from task
ancestry. Follow-up turn-gate park is not an attention producer.

### RFC-02 — diff source

`@/git/review-source` owns source semantics; `@/tool/git` only binds the existing GitRunner.
The initial union contains branch merge-base, commit first-parent, and explicit tree range.
Generated filtering is a NUL-safe `diff --name-only -z` plus `check-attr -z --stdin` pass.

Exact last-turn remains a port with no adapter until SavedSession/ShadowOdb stores an exact
same-turn before/after ref pair. `fromSha` cannot implement that port.

### RFC-03 — objective

Promote `src/agent/objective` to `src/objective` in one commit.
`ObjectiveAuthority.prepare/commit` is the only write protocol. Existing CLI and model tools
become adapters. `objective_set`, proposed goals, edits, criterion completion, and undo all
flow through the same mutation union and expected revision.

Checked criteria can be completed only by `criteria/verifier.ts` with persisted execution
provenance. Manual criteria retain an explicit user/manual provenance arm. Exact undo stores
the prior immutable objective and applies it only when the current revision matches.

The execution evaluator stays PARKED until a non-shell-string `RuntimeProcessPort` reuses the
runtime sandbox/env/cancellation owner. It must not add a direct `Bun.spawn` adapter. It also
requires a workspace-scoped mutation barrier shared with normal turn/tool file mutations;
the objective execution lease alone is insufficient. The barrier is acquired before the
source digest, held through process completion and post-digest validation, then released
before the objective CAS commit.

### RFC-04 — worktree progress

`runtime/worktree/create.ts` emits only typed worktree progress. Runner maps it to activity.
Activity gains `operation` and `step` node kinds so worktree stages do not alter agent counts,
plus a typed `node_progress` event:

```ts
type ActivityProgress =
  | { kind: "indeterminate" }
  | { kind: "ratio"; completed: number; total: number; unit: "files" }
```

CLI subscribes before starting the transition and renders every revision. Setup execution
remains PARKED; ADR-0455 remains environment-selection authority.

`@/activity` does not import `@/runtime`. `runner/session-ops/worktree/activity-adapter.ts`
maps the runtime union into the activity-local structural input.

### RFC-05 — permission posture

`PermissionPostureAuthority` replaces, rather than wraps alongside, the live permission-mode
cell. Host/AgentConfig behavior reads its effective getter each turn; there is no second fallible
imperative apply target. Existing `session.permission.set` becomes a patch adapter into this
authority. The new preset command uses the same writer.

The existing `permission-store.ts` schema gains requested posture, bound per-thread question
policy, and revision. A named defaults entry/port holds future-thread defaults; thread creation
copies it into the bound thread record. `two-layer-manager` becomes a pure resolver used inside
the authority. Kernel events acknowledge a projection; fresh-runtime restore reads the permission
store and re-resolves effective posture against the current managed ceiling.

Only producer-backed lock reasons enter the union. Full access stays PARKED.

### RFC-06 — skills

`buildSkillRegistry` remains the one discovery/precedence owner. `SkillRuntimeAuthority`
applies policy and disabled state and projects:

- active skills for prompt/tool dispatch;
- searchable entries for ToolSearch;
- management rows including disabled reason/provenance.

Admin required/banned checks key on canonical name, not winner scope. Web readout consumes
the authority; its independent `discoverSkills` scan is deleted. Copy reads raw disk bytes at
action time. Reveal is capability-based. Uninstall and history suggestion remain PARKED.

### RFC-07 — observability

PR actions use the exact parsed-argv table in RFC-07. No full-command regex or output guess.

For taxonomy, choose inline compact facts, not a full `ObservationBundle` sidecar. Where the
bundle is live, `agent/observation/metrics/failure-facts.ts` derives a versioned, JSON-safe
`FailureTaxonomyFacts`. Runner persists those facts with the attempt. The report later maps
facts to labels through the pure observability classifier. Missing/version-mismatched facts
produce `unavailable`.

Spawn/question counts are persisted as raw facts only. They do not become failure labels
until task complexity/policy and calibrated thresholds exist.

## 6. Persistence and protocol map

| Domain | Durable owner | Runtime owner | Protocol projection |
|---|---|---|---|
| Objective | `SavedSession.objective` using existing session store | `ObjectiveAuthority` | objective revision/status summary |
| Posture | evolved `PermissionStore` + defaults | `PermissionPostureAuthority` | resolved posture revision/locks |
| Skills | versioned disabled-set adapter; registry files remain sources | `SkillRuntimeAuthority` | active/management revision summary |
| Questions | none in v1; pending request is session-lifetime | `UserQuestionBroker` | attention projection only |
| Activity | event stream/snapshot as today | extended `ActivityStore` | subscribed snapshot/progress |
| Failure facts | existing per-attempt result envelope | runner attempt | versioned facts/unavailable |

Every persisted decoder is strict on known fields/types and fail-closed on unknown versions.
Legacy absence migrates to today's behavior; it is not interpreted as a restrictive or
permissive new preset.

Operator mutations reuse the existing `SessionCommand` bus:

| Command | Domain call | Required payload/receipt |
|---|---|---|
| `session.objective.mutate` | `ObjectiveAuthority.prepare` + `commit` | mutation + actor + expectedObjectiveRevision / new revision |
| `session.posture.set` | `PermissionPostureAuthority.set` | lossless patch + expectedPostureRevision / resolved projection |
| `session.skill.set_enabled` | `SkillRuntimeAuthority.setEnabled` | name + enabled + expectedSkillRevision / full view revision |
| `session.question.answer` | `UserQuestionBroker.answer` | requestId + answer + expectedQuestionRevision / resumed-or-stale result |

The codec, builder, scheduler, reducer projection, SDK handle, and web adapter must land in
one packet per command. Model-owned objective tool calls may invoke the same domain authority
without a protocol round trip; they do not receive a separate writer. Copy/reveal are host
capability actions, not session-state commands.

Protocol projections omit raw skill bodies/source paths and internal permission profiles.
Attention projections carry a bounded, redacted prompt preview plus opaque `requestId`; the
broker retains the full in-process request for actual delivery.

## 7. Slice fences

At HEAD, `activity`, `runtime`, and `protocol` already have configs and entrypoint tests in the
machine SSOT. Preserve and exercise them; do not create replacement fence files. Register only the
new `objective` slice in `tests/unit/_arch/slice-boundary-configs.ts` plus a paired
`tests/unit/objective-slice-boundary.test.ts`. Do not add a deny config that immediately needs a
broad allowlist.

Required direction:

```text
objective  -> shared only; effects through ports
activity   -> shared only
git        -> shared only
permission -> shared plus its existing approved persistence seam
skill      -> shared/tool as already admitted; policy/storage through ports
session    -> shared only for user-question domain
observability -> shared only
runtime    -> existing effect-layer dependencies after inventory; never domain/apps
agent      -> may bridge all domain ports
runner/host/kernel -> composition and protocol
apps       -> adapters only
```

Add `@/objective` to the peer-library deny set for every lower slice. Migrate all
`@/agent/objective` imports atomically and delete the old folder in the same commit.

## 8. Landing plan

Packet-level branch names, exact write-sets, RED commands, receipts, shared-owner locks and estimates
are specified in [`01-execution-board.md`](./01-execution-board.md) and each RFC's
`Executable work packets` section. This section owns only the cross-RFC architectural wave order.

### Wave A — architecture rails

1. Freeze file-owner map and current dirty exclusions.
2. Add only the new objective slice boundary config/test; run existing activity/runtime/protocol
   boundaries and parity/up-import proofs unchanged.
3. Add `session-authorities` assembly contracts with fakes only; no behavior switch.
4. Add front-door RED tests proving today's split owners: objective surface ownership,
   frozen skill invocation, post-hoc worktree rendering, and question visibility/dispatch
   mismatch.

### Wave B — independent leaf work

Run in parallel because files are disjoint:

- B1: RFC-02 review-source core and generated filter.
- B2: RFC-07 exact passive-VCS argv grammar.
- B3: activity typed progress/subscription model.
- B4: session user-question broker and pure attention resolver.

### Wave C — state-authority cutovers, serialized

1. C1 Objective: promote slice, add revisioned mutation authority, migrate all writers.
2. C2 Permission: evolve store, bind live posture authority, then protocol/host/surfaces.
3. C3 Skills: dynamic spec/availability substrate, then runtime authority and all consumers.

These are serialized because they overlap session assembly, AgentConfig, kernel host ports,
and CLI composition.

Each cutover has a no-split-brain commit boundary:

- Objective commit removes CLI-owned construction, migrates every import/writer, binds
  SavedSession restore, and deletes `src/agent/objective` together.
- Permission commit makes the posture authority the backing store for the existing mode
  getter/setter before adding any preset UI. The former independent mode cell is removed.
- Skill commit changes prompt inventory, dynamic tool spec, ToolSearch, dispatch gate,
  CLI/web readout, and `/reload-skills` together. A mixed static/live consumer set cannot
  merge.

### Wave D — product delivery

1. D1 Attention CLI navigate/answer/resume.
2. D2 Worktree live staged progress.
3. D3 Objective proposal/editor/CAS undo.
4. D4 Permission presets and future-thread question knob.
5. D5 Skill copy/reveal/enable-disable; web only after authenticated action binding.

### Wave E — deferred engine work

- Exact last-turn ShadowOdb pair.
- Objective execution oracle after `RuntimeProcessPort`.
- Failure facts after dirty report ownership clears.
- Full-access ceremony, setup hooks, skill suggestion/uninstall, semantic count labels, and
  child-shell ownership only under their RFC prerequisites.

## 9. Verification ladder

Each packet must pass, in order:

1. typecheck + slice boundary + god-code ratchet;
2. domain transition/decoder unit tests;
3. persistence restart and CAS race tests;
4. agent/host composition integration;
5. real CLI or web front-door receipt;
6. gate-OFF production-composition parity;
7. red-on-injection proving the exact live call or enforcement removal turns RED.

No packet may add a >1000-line module or >150-line function. `build.ts`, scheduler arms,
surface handlers, and authority transitions are split before they reach the ratchet rather
than allowlisted.

Required scenario receipts:

- question -> attention row -> answer by requestId -> same child resumes;
- posture write -> restart fresh host -> evaluator and echo agree;
- skill disable -> same session prompt/search/direct invocation/readout all converge;
- worktree command -> progress visible before completion, agent aggregate unchanged;
- objective two-writer race -> one commit, one stale rejection, exact undo CAS;
- generated filter -> NUL-safe paths and attribute-only exclusion;
- missing taxonomy facts -> explicit unavailable, never partial labels.

## 10. Explicitly prohibited implementations

- New generic control-plane/store/event-bus/cache/registry.
- UI-local mirrors that can affect a later turn.
- `TaskRecord.status === completed` or turn-gate idle as attention evidence.
- `fromSha`, newest event, cwd, PID, path, branch, stderr, or keyword inference as authority.
- Partial `ThreadPermission` replacement or a second posture JSON file.
- Static skill `byName` maps after disable support lands.
- Independent CLI/web skill discovery.
- Optional host mutation methods that return successful no-op.
- Direct `Bun.spawn` for objective criteria or setup hooks.
- Free-form activity `meta` carrying progress semantics.
- Failure labels computed from missing bundle/facts or uncalibrated counts.
- Compatibility re-export from `@/agent/objective` after the atomic move.
