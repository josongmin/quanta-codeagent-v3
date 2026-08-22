# RFC-06 — Skills Card Actions Absorption (Copy · Reveal · Enable/Disable/Uninstall · Suggest-from-History)

**Status**: **R6 ARCHITECTURE FROZEN — live runtime authority first; implementation NOT READY.**
Copy/reveal are thin BUILD items. Enable/disable is blocked on a current-session
`SkillRuntimeAuthority`; uninstall and suggest-from-history remain PARKED. All work is
default-OFF (`QUANTA_SKILL_ACTIONS`; future suggestion reuses
`QUANTA_SKILL_CREATOR`). Prior M estimate is revoked.
**Source**: Codex 6662 refresh 2026-08-13, `.extracted_source/_deep-codex-ui-med.md` §2 "Skills card actions" (MEDIUM). Verbatim UI strings: `card.copySkillMarkdown`, `card.revealInFinder`/`revealInFileExplorer`/`revealInFileManager`, `enableSkill`/`disableSkill`/`uninstallSkill`, `computerHistorySuggestions.*`, `appsPage.appDisablement.*` (5-layer).
**Author**: research agent, 2026-08-22. Conventions: hellgate (RED e2e → TDD → 3R adversarial → self-audit); leaf-crate unit; imported/suggested skills UNTRUSTED + HITL before activation (jul-12 `MODE_REPO_RULES_POLICY`, aug-02 RFC-03 skill trust); reuse skill-creator/registry/approval-machine (no reinvent); multi-surface graceful degrade (CLI has no Finder).
**Relation**: strict follow-on to **aug-02 RFC-03** (`docs/plans/aug-02-absorption/rfc-03-self-improve-onboarding.md`) — ProposeSkills/`skill_create` compiler + `SkillRegistry` cutover already LANDED. This RFC adds the **management verbs** around that pipeline and a **suggestion feeder** into it. Does NOT re-implement compiler, registry, approval machine, hash/jail.

---

## Final audit incorporation — current-HEAD authority (R5, normative)

This section supersedes the older review/audit text and any conflicting FINAL, admin-winner,
or current-session disable claim below.

### Ground truth

- `buildSkillBlock` builds a snapshot once at session composition, and `createSkillTool`
  captures a static name map. Re-running `/reload-skills` updates display/pills but does not
  replace the live invocation map, prompt inventory, or ToolSearch catalog.
- Therefore, persisting a disabled set and returning a fresh snapshot does **not** disable a
  skill in the current session. A UI badge/readout fix alone is a dead seam.
- Admin policy loader/decision helpers have no production composition binding on this path,
  and snapshot construction does not receive `orgConfigDir`. Their existence is not proof
  that enable/disable is policy-enforced.
- `requiredSkills` can require a name without an admin-owned SKILL.md winner. Using
  `winnerScope === "admin"` as required-skill authority is invalid.
- Active/callable inventory and management inventory are different projections. Filtering
  the only snapshot destroys the row needed to re-enable a disabled skill.

### Final disposition

| Scope | Disposition | Required authority |
|---|---|---|
| Copy raw SKILL.md | **BUILD** | Action-time registry resolve + disk read |
| Reveal path | **BUILD** | Surface capability adapter; honest unsupported mode |
| Enable/disable | **BUILD AFTER D0** | Live atomic skill authority shared by prompt/search/invocation/management |
| Admin/user disablement projection | **BUILD AFTER POLICY BINDING** | Required/banned decisions by skill name, not winner scope |
| Web mutation | **DECIDE/BUILD** | Existing authenticated control-effect route or omit the action |
| Uninstall | **PARK** | No proven demand; destructive FS authority absent |
| Suggest-from-history | **PARK** | RFC-03 checked proposal/edit authority + narrow evidence convention first |
| Phantom project/session/device layers | **DROP** | No producer, no label |

### Canonical runtime authority

```ts
interface SkillRuntimeView {
  revision: number
  active: readonly Skill[]
  searchableEntries: readonly SkillRegistryEntry[]
  management: readonly ManagedSkill[]
}

interface SkillRuntimeAuthority {
  read(): SkillRuntimeView
  setEnabled(name: string, enabled: boolean, expectedRevision: number): Promise<SkillRuntimeView>
  resolveActive(name: string): Skill | undefined
}
```

One atomic authority owns the registry, disabled names, policy, and revision. Prompt
inventory, ToolSearch, `Skill` invocation, CLI `/skills`, and web readout read the active
projection from it. Management reads a separate projection that retains disabled rows and
their effective reason. Invocation performs an execution-time `resolveActive` check so a
tool handle created before a disable cannot execute afterward. `setEnabled` persists and
atomically publishes a new revision; partial refresh is forbidden.

Admin policy is loaded and injected at composition. Required/banned checks key on the
canonical skill name in policy, independently of the winning file's scope. Unknown policy,
failed persistence, stale revision, or absent mutation capability fails closed.

## Architecture integration — R6 (normative)

R6 replaces snapshot filtering with a live session authority. Today `buildSkillBlock` snapshots at
session construction, `createSkillTool` captures a static `byName`, ToolSearch closes over the old
registry entries, `/reload-skills` refreshes display only, and web-daemon independently discovers
skills. A durable disabled set without live consumers would therefore be a dead actuator. Shared
topology is in [`00-architecture-blueprint.md`](./00-architecture-blueprint.md).

### Existing owner map

| Concern | Current owner | R6 decision |
|---|---|---|
| Discovery/precedence | `src/skill/registry.ts` `buildSkillSnapshot` | Remains the canonical registry builder |
| Direct invocation | `src/skill/skill-tool.ts`, `src/agent/tier1/skill.ts` | Replace captured map with execution-time authority read |
| ToolSearch catalog | `src/skill/tool-search.ts`, tier1 wiring | Use live searchable projection |
| Prompt inventory | agent feature/context assembly | Re-read per turn; do not copy active array into session features |
| CLI reload | `src/apps/cli/repl/skills-surface.ts` | Calls authority sync and renders returned revision |
| Web readout | `src/apps/web-daemon/runtime-factory.ts` | Delete independent discovery; consume projection |
| Admin policy | `src/skill/admin-policy*.ts`, `install-enforcement.ts` | Bind loader at composition; helpers alone are not enforcement |

### Target write set

```text
src/skill/runtime/
  types.ts                 # revisioned active/search/management views
  authority.ts             # sync, read, resolveActive, CAS setEnabled
  projections.ts           # one registry -> distinct consumer views
  actions.ts               # copy/reveal/enable/disable action-time decisions
  disabled-store-port.ts   # durable versioned set contract
  adapters/json-disabled-store.ts
  index.ts
src/skill/{registry,skill-tool,tool-search}.ts
src/tool/types.ts          # optional ToolDynamicSpec
src/tool/registry.ts       # dereference dynamic spec for each model request
src/agent/tier1/skill.ts
src/agent/features.ts      # live reader, not copied skill snapshot
src/agent/tool-surface/live-specs.ts
src/runner/assemble/session-authorities/build-skills.ts
src/apps/cli/repl/skills-surface.ts
src/apps/web-daemon/authority-readouts.ts
src/apps/web-daemon/authority-actions.ts # only if authenticated mutation route is admitted
tests/unit/skill/runtime/
tests/integration/skill-disable-live-all-surfaces.test.ts
```

There is one process-local authority per session and one versioned durable disabled-set adapter;
there is no second registry/cache. Cross-process convergence occurs by comparing durable revision
at turn assembly, management read and execution-time resolution. Watchers may later optimize this,
but correctness cannot depend on watcher delivery.

### Runtime contracts

```ts
interface SkillRuntimeAuthority {
  read(): SkillRuntimeView
  sync(): Promise<SkillRuntimeView>
  resolveActive(name: string): Promise<ActiveSkillResolution>
  setEnabled(name: string, enabled: boolean, expectedRevision: number): Promise<SkillRuntimeView>
}

interface SkillRuntimeView {
  revision: number
  active: readonly SkillSummary[]
  searchable: readonly SkillSearchEntry[]
  management: readonly ManagedSkill[]
}
```

`management` retains disabled rows and reason codes; `active` and `searchable` exclude them.
Projections are derived atomically from one registry/policy/disabled revision. Consumers never
filter independently.

Enable/disable flow is validate canonical name -> action-time registry resolve -> policy decision by
name -> CAS durable set -> rebuild all projections -> publish revision. Required/banned policy is
keyed by canonical skill name, not `winnerScope`; a required name may have no admin file winner.
Unknown policy, failed load/persist, stale revision, missing skill or ambiguous collision fails
closed.

Invocation always calls `resolveActive(name)` immediately before reading/executing SKILL content.
This closes stale handles. Copy and reveal also re-resolve at action time. Copy returns the current
raw SKILL.md through a bounded action result. Reveal is a surface capability adapter and may return
`unsupported`; domain code does not spawn Finder/Explorer. Uninstall remains PARKED and no delete
adapter/folder is introduced.

### Dynamic model surface

The tool substrate gains an optional dynamic shape, preserving static tools:

```ts
interface ToolDynamicSpec {
  getSpec(): ToolSpec | undefined
}
```

`ToolRegistry.specs()` dereferences it on every model request. Agent context assembly similarly
reads the current skill revision each turn. Direct Skill invocation and ToolSearch perform their
own execution-time resolution. Thus prompt inventory, model tool specs, ToolSearch, direct
invocation, CLI and web converge on the same revision; no display-only reload can claim success.

`SessionFeatures` carries a narrow `SkillRuntimeReader`, not `activeSkills`, static `byName`, or a
copied search catalogue. This is an atomic cutover: the static capture paths are removed in the
same packet that installs the live reader.

### Persistence, policy and protocol

The disabled store persists `{schemaVersion, revision, names}` using an existing jailed/atomic
storage convention. Admin policy is loaded in `build-skills.ts` and injected into the authority.
The production composition test must show a real loader call; existence of decision functions is
not evidence.

CLI and web read projections from narrow ports. Mutations route through
`session.skill.set_enabled` on the existing session command/host path. Web mutation is omitted
unless an authenticated control-effect route with session ownership exists. Protocol DTOs expose
names, enabled state, scope/reason and revision only; raw markdown and source paths stay behind
copy/reveal actions.

### Atomic landing plan

1. **F1 — authority/store:** versioned disabled store, policy binding, projections and CAS tests.
2. **F2 — live invocation:** `resolveActive` at direct execution, then delete captured `byName`.
3. **F3 — live discovery:** dynamic tool spec, per-turn prompt and ToolSearch; delete copied arrays.
4. **F4 — surfaces:** CLI sync/management plus web readout replacement; no independent discovery.
5. **F5 — actions:** copy/reveal and enable/disable command receipt.
6. **F6 — parked work:** uninstall and history suggestion require separate producer/security
   admission; no scaffolding now.

### Executable work packets

Use [`01-execution-board.md`](./01-execution-board.md). F1 begins only after RFC-05 E4 has stabilized
host/session construction. F2 and F3 are one no-split-brain consumer cutover even if reviewed as two
commits; neither may merge alone with a mixed static/live skill surface.

#### F1 — runtime authority, policy and durable set (`codex/aug22-f1-skill-authority`)

- **Prerequisite/owner:** E4; owns `skill/runtime/{types,authority,projections,disabled-store-port,
  adapters/json-disabled-store,index}.ts`, `runner/assemble/session-authorities/build-skills.ts`,
  admin-policy composition binding and unit tests.
- **RED first:** persisted disable leaves active/search/management projections inconsistent; admin
  helper has no production loader call; concurrent setEnabled writes both publish.
- **Implement:** versioned disabled store, canonical-name policy, one atomic registry/policy/disabled
  revision, CAS setEnabled, separate active/search/management projections and sync-on-revision.
- **Verify:** projection matrix, CAS/persistence failure, required/banned/unknown policy, real loader
  composition test, skill/runner/host boundaries and typecheck.
- **Receipt:** one revision yields all three projections and loader-call removal makes the production
  policy test RED. **Stop** if winnerScope substitutes for required/banned name authority or another
  registry/cache is proposed.

#### F2 — execution-time invocation cutover (`codex/aug22-f2-skill-invocation`)

- **Prerequisite/owner:** F1; exclusive owner of `skill/skill-tool.ts`,
  `agent/tier1/skill.ts`, the Skill tool construction and invocation tests.
- **RED first:** construct Skill tool, disable afterward, invoke captured handle; current static
  `byName` still executes. Pin concurrent registry change and missing/collision cases.
- **Implement:** async action-time `resolveActive`, current file re-resolution and policy/revision
  check immediately before content read/execute; delete captured map.
- **Verify:** stale-handle/concurrent-disable tests, existing skill implicit-policy E2E, skill/agent/
  tool boundaries and typecheck.
- **Receipt:** same-session disable blocks the already-created handle and re-enable restores it at a
  higher revision. **Stop** if call safety depends only on prompt/catalog filtering.

#### F3 — live prompt, ToolSearch and dynamic specs (`codex/aug22-f3-skill-discovery`)

- **Prerequisite/owner:** F2 and RFC-05 E5 integrated; exclusive lock on `tool/{types,registry}.ts`,
  `skill/tool-search.ts`, `agent/features.ts`, context/prompt assembly and live-spec bridge.
- **RED first:** after disable, old skill remains in prompt activeSkills and ToolSearch; spec list is
  frozen. Pin exact gate-OFF registry/spec order before changing the substrate.
- **Implement:** optional `ToolDynamicSpec.getSpec`, dereference on every model request, live
  SkillRuntimeReader in SessionFeatures, per-turn active/search reads and execution-time search
  resolution. Remove copied active arrays/catalog closures.
- **Verify:** prompt/search/spec parity test, registry static-tool compatibility, prompt-cache
  gate-OFF snapshot, feature completeness ratchet, agent/tool/skill boundaries and typecheck.
- **Receipt:** one disable revision disappears from prompt, ToolSearch and spec surface before the
  next model call while unrelated static tools remain byte-identical. **Stop** if dynamic behavior
  forces every static tool to change implementation.

#### F4 — CLI/web projection convergence (`codex/aug22-f4-skill-surfaces`)

- **Prerequisite/owner:** F3; owns `apps/cli/repl/skills-surface.ts`, web authority readout and removal
  of web-daemon runtime-factory's independent skill discovery.
- **RED first:** CLI reload and web readout disagree with disabled runtime view. Constructor/discovery
  scan pins the independent web calls.
- **Implement:** `/reload-skills` invokes authority sync and renders its revision; CLI management and
  web readout consume narrow projections. Preserve config-migration discovery because it is not a
  live active-skill surface.
- **Verify:** CLI skills E2E, web readout composition, discovery-owner ratchet, surface coupling and
  skill/host boundaries.
- **Receipt:** CLI, web, prompt, search and invocation report the same revision/state. **Stop** if web
  mutation lacks authenticated session ownership; omit the action rather than add a bypass.

#### F5 — copy/reveal/enable-disable actions (`codex/aug22-f5-skill-actions`)

- **Prerequisite/owner:** F4 and protocol chain through E4; owns `skill/runtime/actions.ts`,
  `session.skill.set_enabled` command/host adapter, CLI actions and optional authenticated web action.
- **RED first:** action-time disk mutation is not reflected by copy; stale revision disable is not
  rejected; reveal capability absence is indistinguishable from success.
- **Implement:** re-resolve canonical skill/path at action time, bounded raw markdown copy,
  capability-based reveal, CAS enable/disable through the authority and typed unsupported/error
  receipts. No delete operation.
- **Verify:** disk-race/path-jail/copy tests, reveal supported/unsupported adapters, command codec/
  scheduler, same-session all-surface enable-disable E2E and shared ladder.
- **Receipt:** disable removes all active consumers, management retains row/reason, re-enable restores;
  copy reflects current bytes and reveal unsupported is honest. **Stop** on destructive filesystem
  access or unauthenticated web control.

#### F6 — uninstall and history suggestion (PARKED, no branch)

Uninstall requires a destructive jailed filesystem authority, concurrent replacement defense and a
demonstrated reclaim need. Suggestion requires RFC-03 checked proposal/edit authority plus a narrow
materialized evidence file accepted by the existing compiler. Do not create actuators, scoring,
history watchers, delete helpers or placeholder disablement layers before those conditions close.

### Architectural completion gates

- One end-to-end rail disables after tool construction and proves immediate absence from prompt,
  ToolSearch, direct Skill execution, CLI and web; re-enable restores all at one higher revision.
- Cross-process rail writes the disabled set in session A and proves session B denies on its next
  turn/execution without restart.
- Policy-binding rail uses real admin required/banned inputs; removing the loader call makes it RED.
- Projection completeness ratchet enumerates all consumers and requires live reader calls, with an
  anti-vacuum floor; bare imports do not satisfy it.
- Persistence-failure/stale-CAS tests prove no partial active/search/management publication.
- Gate-OFF receipt preserves current prompt/tool/catalog ordering and bytes.

**R6 status:** architecture frozen; enable/disable is BUILD only after F1 and must land through F5.
Uninstall and suggest-from-history remain PARKED.

---

## Historical review incorporation (R4, superseded by R5)

`_review-06.md` (verdict REVISE) CONFIRMED, against origin/main `9d5369d31`, nearly every file:line, the reuse-not-reinvent framing, and the "disable-is-decision-only dead-seam" (`decideInstall`/`decideDisable`/`decideNonAdminInstall` are pure decisions with **zero actuation**). Three code-verified corrections fold in here; the per-verd verdicts are re-scoped.

**Correction 1 — D2 disabled-filter was incomplete across surfaces (BLOCKER).** Filtering only `snapshot.skills` removes a disabled skill from the `Skill` tool inventory, prompt block, and CLI `/skills` — but **two more consumed read surfaces still leak it**:
1. **ToolSearch skill-catalog reads `snapshot.registry.entries`, NOT `snapshot.skills`** — `createToolSearchTool(() => config.registry.specs(), () => snapshot.registry.entries)` (`src/agent/tier1/skill.ts:192-195`, confirmed by grep). A disabled skill still appears in `catalog:"skills"` search results (the model's discovery surface). Invocation is still blocked (the filtered `createSkillTool` refuses an unknown name) ⇒ **discovery-surface dead-seam**, not an invocation escape — but exactly the jul-15 badge-lie class on the model's own surface.
2. **Web-daemon readout runs an INDEPENDENT discovery** — `runtime-factory.ts:440` `buildReadoutSources.skills` calls `discoverSkills(skills.dir)` + `discoverSystemSkills()` directly (own Map-based collision merge), bypassing `buildSkillSnapshot` entirely ⇒ the web `/skills` panel still lists a disabled skill as active (display dead-seam).
   → **D2 MUST cover all 3 read surfaces** (skills snapshot + `registry.entries` + web `discoverSkills`), and the RED e2e must assert the disabled skill is **ABSENT from ALL three** (not just `snapshot.skills`). Invocation is already safe via the filtered `createSkillTool`; the holes are discovery/display. See revised D2 + write-set (`web-daemon/runtime-factory.ts` added).

**Correction 2 — vacuous evidence was only half-blocked.** `resolveEvidence` (`compiler.ts:59`) checks non-empty + resolves-under-root + readable, but a **whole-file `raw_memories.md` citation PASSES all three** and gets a valid whole-file sha256. So "route through the compiler ⇒ anti-vacuous applies for free" is only partial — the compiler stops empty/escape/nonexistent, NOT wholesale. Because evidence is `path → sha256(whole-file-bytes)`, the RFC's preferred **line-anchor into `raw_memories.md` is incompatible with the current compiler** (it would hash the whole file; a slice-hash convention would be a forbidden compiler change). Open-Q RESOLVED: **materialize the narrow anchor to its own jailed file and cite that file** (whole-file hash == the slice). The feeder — not the compiler — forces the specific anchor.

**Correction 3 — load-bearing wiring must be pinned.**
- `setEnabled` must pass the **real `winnerScope`** = `snapshot.registry.lookup(name).winnerScope` (an admin-required skill's winnerScope IS `"admin"`, top precedence). A hardcoded `"user"` silently lets a user disable an admin-required skill — `decideDisable` only blocks when `requestedScope === "admin"` (`install-enforcement.ts:96-99`).
- **enable must route through the `install` decision, not `disable`** — `decideDisable` does NOT check `bannedSkills`; the ban check lives in `decideNonAdminInstall` (`:66`). `setEnabled(name,true)` MUST call `decideInstall({kind:"install", requestedScope:<non-admin winnerScope>})` so an admin-banned skill is re-checked and refused (`banned_install_blocked`). Routing enable as `kind:"disable"` (clear-set) skips the ban.
- **uninstall needs action-time re-resolve** beyond the jail — a concurrent session (this repo has racing committers) can replace the skill dir between snapshot and delete. Re-resolve `registry.lookup(name)` at action-time and verify the dir still holds THAT skill's SKILL.md before `rm`, else it deletes a repurposed dir.

**Verdict re-scope** (per-verb):

| Action | Verdict | Rationale |
|---|---|---|
| copyMarkdown (D1a) | **BUILD** | Thin disk-read reuse; real gap; test = frontmatter-present + disk-mutation-reflected. |
| reveal (D1b) | **BUILD (thin)** | Design *is* the honest-unavailable degrade; surface-gated not platform-gated. |
| enable/disable (D2 + D1c) | **BUILD — keystone** | Closes the jul-15 trust invariant. D2 must be 3-surface-complete first. |
| **uninstall (D1d)** | **PARK** | Low ROI over disable; safety is ~all NEW bespoke FS code (`decideInstall` remove gives nothing for non-admin — returns `allowed:true` unconditionally). Disable already lets a user hide *any* skill incl. system. Un-park only on a concrete disk-reclaim / user-churn need. |
| suggest-from-history (D3) | **draft-only, after RFC03-3** | Compiler reuse genuine but non-vacuity is NOT free (Correction 2) and it inherits the `promote-skill-proposal` dead seam (`tier1/skill.ts:112`). Ships draft+stage only. |
| **5-layer projection (D4)** | **DROP 3 phantom layers → keep admin+user (2 values)** | Only `administrator` (org-policy.json) + `user` (disabled-set) have real sources. Fabricating project/session/device reason strings = trust lie (own R3 forbids it). Ship a 2-value disablement source; OMIT the rest until a real config.toml layer exists. |

**Effort re-eval: real effort = M** (not M-L). Shippable high-value core = D2-complete (3 surfaces) + copy/reveal/disable + slim-D4. The old "M-L" folded in uninstall (PARK) and D3 (blocked on RFC03-3), inflating both scope and apparent readiness.

---

## Motivation

Codex surfaces per-skill management on the Skills card: Copy Markdown, Reveal-in-OS-file-manager, Enable/Disable/Uninstall (with success toasts + "Disabled" badge), plus a "Based on your Computer History → Create skill" suggestion, all gated by a 5-layer config.toml disablement matrix. quanta owns the deep substrate (registry, proposal compiler, approval machine, memory store) but exposes **zero user-facing management verbs** and has **no suggestion feeder** and **only a 1-layer** (admin) disablement model. This RFC closes the surface gap by wiring thin verbs onto existing authorities, and routes the suggestion through the existing anti-vacuous `skill_create` compiler so a "skill from history" cannot be invented from nothing.

## Non-goals

- No new approval state machine, registry, hash/jail, or atomic writer (aug-02 RFC-03 §"중복 금지"). Reuse `ApprovalStateMachinePort`, `buildSkillRegistry`, `@/storage`, `SkillProposalArtifactPort`.
- No auto-trigger of suggestions from repetition/similarity/score (aug-02 RFC-03: proposal starts only on explicit tool/user invocation; model judges CONTENT not promotion authority). The history feeder is **operator-initiated** (a CLI/UI affordance), never a background daemon.
- No marketplace / plugin store install (Codex `plugins.store.*` is skip-listed).
- No fuzzy ranking of history candidates — deterministic anchor selection only.
- Uninstall does NOT touch `system`/`admin`/`repo`/`team` scopes (see Trust-model). Only `user`/`personal`.

## Current state (file:line — existing skill infra)

**Registry / discovery (single authority — reuse):**
- `src/skill/registry.ts:237` `buildSkillRegistry` + `:315` `buildSkillSnapshot` — 7-scope discovery + precedence + collision receipts. Every surface (prompt, `Skill` tool, CLI `/skills`) reads THIS snapshot (`src/agent/tier1/skill.ts:180`, `src/apps/cli/repl/skills-surface.ts:29`).
- `src/skill/types.ts:88` `Skill` has `sourcePath` (abs path to the on-disk SKILL.md — the copy/reveal source of truth), `scope` (`:23`, closed union incl. `system`), `installState` (`:62` required/recommended/optional).
- **GAP confirmed**: `registry.ts` / `discover.ts` have **no disabled-filter** — the snapshot cannot hide a skill.

**Proposal compiler (reuse for suggest-from-history):**
- `src/skill/proposal/compiler.ts:128` `compileSkillProposal` — anti-vacuous: `resolveEvidence` (`:59`) rejects empty evidence (`no_evidence`) and any path not resolving under allowed roots (`evidence_unresolved`); each anchor is content-hashed (`:71` `sha256`). `checkAdmission` (`:78`) refuses system-shadow / unknown-target.
- `src/skill/skill-creator.ts:256` `createSkillCreatorTool` → compile → **stage** (`compileAndStage:213`), never a live write. Default-OFF `QUANTA_SKILL_CREATOR`.
- `src/agent/tier1/skill.ts:203` composition: evidence roots today = `[dir, process.cwd()]` (`:206`). **GAP**: the memory dir `~/.quanta/memory/` is NOT an evidence root, so a history-cited memory file would fail `resolveUnderRoots`.
- `src/agent/tier1/skill.ts:112-116` **KNOWN GAP (hellaudit A2)**: `resumeStep:"promote-skill-proposal"` is a LABEL — no consumer re-verifies + CAS-promotes on approve. So `skill_create` is *staged-but-not-promotable-live* today. The suggestion feeder INHERITS this gap.

**Enterprise disablement (1-layer today — reuse + extend):**
- `src/skill/install-enforcement.ts:117` `decideInstall(attempt, policy)` — pure decisions for `install`/`remove`/`disable`. `decideDisable` (`:91`) blocks disabling an **admin-required** skill (`admin_attempt_disable`). `decideNonAdminInstall` (`:62`) blocks **banned** skills. **GAP**: decisions are computed but nothing **actuates** disable/remove (no persisted disabled-set, no deleter).
- `src/skill/admin-policy.ts:96` `loadAdminPolicy` — `<orgConfigDir>/org-policy.json` (`requiredSkills`/`bannedSkills`/`auditRequired`). This is the **administrator** layer only — Codex's other 4 layers (project/session/device/other) have no analog.

**Memory (history evidence source — reuse):**
- `src/memory/consolidate/paths.ts:20` `resolveMemoryDirPaths` → `~/.quanta/memory/{MEMORY.md,raw_memories.md,memory_summary.md}`.
- `src/memory/stage1-store/types.ts:17` `Stage1Entry` — per-thread record with `rawMemory` (`:27`, "Raw key facts / decisions / preferences / blockers"), `rolloutSummary`, `rolloutSlug`, `usageCount`. **This is "recent activity"** — the exact Codex "Computer History" analog.

**OS-open pattern (reuse for reveal):**
- `src/auth/chatgpt-oauth/browser-flow.ts:46` `openBrowserDefault` — `spawn` `open`/`cmd /c start`/`xdg-open`, `detached:true, stdio:"ignore"`, no-throw seam with injectable `opener`. Reveal reuses this shape (different args), NOT this function.

**CLI/clipboard:**
- Clipboard today is paste-IN only (`src/apps/cli/paste-cmd.ts`, `text-inbox.ts`) — **no copy-OUT of skill markdown**.
- No `revealIn*`, `enableSkill`, `disableSkill`, `uninstallSkill` symbol anywhere in `src/`.

**Real delta (net):** substrate is 90% present; missing = (1) copy-SKILL.md-to-clipboard, (2) reveal-in-file-manager with surface degrade, (3) a **persisted disabled-set + 3-surface snapshot filter** (disable actuator — must cover `snapshot.skills` + `registry.entries` (ToolSearch) + the web-daemon readout; see D2), (4) [PARK] an **uninstall deleter** with scope/system safety + action-time re-resolve, (5) memory dir as evidence root + a **suggest-from-history** affordance (draft-only after RFC03-3) that drafts a `skill_create` proposal, (6) a **2-layer disablement projection** (admin + user only) with reason strings. Gate default-OFF everywhere.

---

## Design (R5, normative)

### D0 — Live `SkillRuntimeAuthority` (blocking prerequisite)

Replace frozen per-session skill maps with an injected atomic authority. The authority may
publish immutable snapshots through an atomic reference, but every consumer must dereference
it at use time:

- prompt/tool visible-spec generation reads `active` for the current turn;
- ToolSearch reads `searchableEntries` for the current query;
- `Skill` dispatch calls `resolveActive(name)` immediately before reading/executing;
- CLI/web active readouts read `active`;
- management views read `management`, which includes disabled skills and reason/provenance.

The authority is constructed once per session/runtime and receives the production admin
policy plus the durable disabled-name store. `/reload-skills` and `setEnabled` both rebuild
and atomically publish the complete view. A session whose consumers still capture the old
map is not admitted.

### D1 — Copy and reveal

`copyMarkdown(name)` resolves the management row at action time and reads raw `sourcePath`
bytes from disk, preserving frontmatter. A vanished or repointed path returns a typed error;
there is no cached-body fallback. The host surface owns the clipboard: CLI emits bytes,
Tauri uses its clipboard capability, and plain web omits the action unless an authenticated
bridge exists.

`reveal(name)` returns `path-printed` for CLI, uses a capability adapter for Tauri, and
returns `unsupported` for headless/plain web. OS process spawning is behind that adapter,
never inferred from `process.platform` alone.

### D2 — Enable/disable actuator

`setEnabled(name, enabled, expectedRevision)`:

1. re-resolves the canonical name from the management projection;
2. applies required/banned policy by **name**, not winner scope;
3. writes the jailed durable disabled set;
4. rebuilds registry + active/search/management projections;
5. atomically publishes the next revision; and
6. returns that exact view for the UI receipt.

Disable removes the skill from prompt, search, visible tools, and invocation immediately
while preserving its management row. Enable re-runs banned/admission policy before clearing
the user-disabled bit. Admin-required cannot be user-disabled even when its winning file is
system/user/repo scoped. A failed write or refresh leaves the previous view live.

### D3 — Policy and surface binding

Composition must load admin policy and inject it into D0. Do not claim admin enforcement
until a front-door test reaches that binding. CLI commands bind directly to the session
authority. Web mutation ships only through an existing authenticated control-effect route
with revision/rejection echo; otherwise web is read-only. No separate web discovery scan is
allowed.

The management disablement reason union contains only production-backed sources:
`administrator` and `user`. Project/session/device reasons stay absent until their policy
producer and enforcement path exist.

### D4 — Deferred actions

- **Uninstall: PARK.** Disable satisfies the primary control need without destructive
  filesystem ownership. Un-park only with measured disk/churn demand and an action-time
  re-resolve + jail + identity receipt.
- **Suggest-from-history: PARK.** It depends on RFC-03's checked criterion/proposal and HITL
  promotion authority. A future feeder must materialize a narrow jailed evidence artifact;
  whole-file `raw_memories.md` evidence is rejected before compile.

## Historical design (R4, superseded by R5)

Five thin verbs on existing authorities + one suggestion feeder. All behind gates; gate-OFF ⇒ byte-identical surface.

### D1 — `SkillActionsPort` (one new port, surface-agnostic)

A single injected port the composition root builds per surface; verbs are pure decision + typed result, side-effects behind the port.

```
interface SkillActionsPort {
  copyMarkdown(name): Promise<{ ok, bytes?, error? }>      // reads sourcePath from DISK
  reveal(name): Promise<{ mode: "spawned" | "path-printed" | "unsupported", path }>
  setEnabled(name, enabled): Promise<Decision & { snapshotAfter }>
  uninstall(name): Promise<Decision>
}
```

- **copyMarkdown**: resolve `name` → `snapshot.registry.lookup(name)` → read `skill.sourcePath` **at action-time from disk** (NOT the in-memory `skill.body`, which is frontmatter-stripped/normalized — see R1). No-throw: a vanished/moved file ⇒ `{ ok:false, error:"file gone" }`, never a stale in-memory fallback. The *host surface* performs the actual clipboard write (Tauri clipboard API / CLI prints to stdout for shell pipe) — the port returns bytes, the surface owns the sink. Toast `card.copiedSkillMarkdown` = "Copied SKILL.md" on `ok`.
- **reveal**: **surface-gated, not platform-gated.** The port takes a `surfaceKind: "cli" | "web" | "tauri" | "headless"`. Only `tauri` (and `web` via a Tauri shell bridge) spawns the native file manager (`open -R <path>` mac / `explorer /select,<path>` win / `xdg-open <dir>` linux — note linux cannot *select*, only open the containing dir). `cli` returns `mode:"path-printed"` with the abs path (copy-pasteable). `headless`/unknown returns `mode:"unsupported"`. Spawn is `detached, stdio:"ignore"`, no-throw. Platform string selection reuses the `browser-flow` shape.
- **setEnabled** — wiring is load-bearing (Correction 3): actuates a **persisted disabled-set** (new small store, `~/.quanta/skills/.disabled.json` under the user skills dir, jailed write via `@/storage`). BEFORE write it MUST pass the **real winnerScope** = `snapshot.registry.lookup(name).winnerScope` (NOT a hardcoded `"user"` — an admin-required skill's winnerScope is `"admin"`, and `decideDisable` blocks only when `requestedScope === "admin"`; a hardcoded `"user"` would silently let a user disable an admin-required skill).
  - **disable** (`enabled=false`) → `decideInstall({kind:"disable", requestedScope:winnerScope, skillName}, policy)` — an admin-required skill refuses (`admin_attempt_disable`).
  - **enable** (`enabled=true`) → routes through the **`install` decision, not `disable`**: `decideInstall({kind:"install", requestedScope:<non-admin winnerScope>}, policy)` so `decideNonAdminInstall`'s `bannedSkills` check re-fires and an admin-banned skill is refused (`banned_install_blocked`). Clearing the disabled-set via a `kind:"disable"` clear would SKIP the ban re-check.
  - The disabled-set is **read by the D2 filter (all 3 surfaces)** so the skill actually leaves discovery+invocation. Returns the fresh snapshot for readback. Success strings `card.enableSuccess`/`disableSuccess`.
- **uninstall** — **PARK** (low ROI over disable; safety is ~all new bespoke FS code — see §"리뷰 반영"). Design retained for un-park: **scope-fenced.** Refuses unless `skill.scope ∈ {user, personal}` AND `sourcePath` is jailed under the user skills dir. Refuses `system` (bundled, ships with binary — read-only), `admin`/`repo`/`team` (shared/policy). `decideInstall({kind:"remove"})` returns `allowed:true` for any non-admin remove — it contributes only the admin-remove guard; ~all real safety is new. **Action-time re-resolve (Correction 3):** beyond the static jail, re-resolve `registry.lookup(name)` at delete-time and verify the on-disk dir still holds THAT skill's SKILL.md before `rm` — a concurrent session (racing committers, see memory) could have repointed `sourcePath` since the snapshot, and a jail-only check would delete a repurposed dir. Then delete via a jailed `@/storage` deleter. Success `card.removeSuccess`, failure `card.removeFailed`. HITL: destructive ⇒ explicit confirm (approval request in interactive; `--yes` in CLI).

### D2 — Disabled-set snapshot filter — 3-surface-complete (the actuator that makes "Disabled" real)

`buildSkillSnapshot` gains an optional `disabledNames: ReadonlySet<string>` input (default empty ⇒ byte-identical). When set, the resolved `entries` are partitioned: disabled winners are **removed from `skills`** (so `Skill` tool inventory + prompt block + `/skills` list all drop them) but retained in a new `snapshot.disabled: Skill[]` so the UI can render the "Disabled" badge with the skill still visible-but-inert.

**The filter MUST cover all THREE consumed read surfaces** — filtering only `snapshot.skills` leaves two disabled-but-visible leaks (Correction 1):

1. **`snapshot.skills`** — the invocable/prompt/`/skills` surface (filtered by the partition above). Invocation is safe: the filtered `createSkillTool(skills)` refuses an unknown name.
2. **`snapshot.registry.entries`** — the view ToolSearch's `catalog:"skills"` mode reads (`createToolSearchTool(() => config.registry.specs(), () => snapshot.registry.entries)`, `tier1/skill.ts:192-195`). Expose a **filtered entries view** that also drops disabled winners, and pass THAT to `createToolSearchTool` (or cut ToolSearch over to a filtered accessor). Else a disabled skill still shows in the model's discovery-search results — a discovery-surface dead-seam.
3. **Web-daemon readout** — `runtime-factory.ts:440` `buildReadoutSources.skills` runs an INDEPENDENT `discoverSkills(skills.dir)` + `discoverSystemSkills()`, bypassing `buildSkillSnapshot`. **Cut this readout over to the filtered snapshot** (preferred — kills the second discovery) OR thread `disabledNames` through it. Else the web `/skills` panel lists the disabled skill as active.

This closes the jul-15 dead-seam class ("badge shows Disabled but tool still invocable/discoverable" = a trust lie) across every read surface, not just the main one. Gate `QUANTA_SKILL_ACTIONS`; OFF ⇒ `disabledNames` never populated ⇒ filter is a no-op on all three (byte-identical).

### D3 — Suggest-from-history → `skill_create` (feeder, not a new compiler)

Operator-initiated (CLI `/skill-suggest`, or a web "Based on your Computer History" section). Flow:

1. **Gather** (deterministic, no LLM ranking): read `Stage1Entry[]` from the stage1 store (or `raw_memories.md` sections). Present candidate anchors = specific thread records (`rolloutSlug` + `rawMemory`), highest `usageCount` first. NOT the whole memory file (see R2 — wholesale citation is vacuous).
2. **Draft**: the model drafts a SKILL.md body from the SELECTED anchor's content, and cites the **materialized narrow anchor** as `evidence[]`. Correction 2 (RESOLVED Open-Q): because the compiler hashes `path → sha256(whole-file-bytes)`, the anchor MUST be **materialized to its own jailed file** (the stage1 record / the narrow `raw_memories.md` slice written to a dedicated jailed path) and THAT file cited — so its whole-file hash == the slice. A raw line-anchor into `raw_memories.md` does NOT work (the compiler would hash the whole file; a slice-hash convention is a forbidden compiler change). The feeder — not the compiler — forces the specific anchor; a whole-file citation is a vacuity the compiler alone does NOT catch.
3. **Compile + stage**: routed through the EXISTING `skill_create` / `compileSkillProposal` — the system-shadow refusal, the size cap, and the approval-bound staging apply unchanged, and `resolveEvidence` still catches empty/escape/nonexistent. But `resolveEvidence` does NOT catch a whole-file citation (Correction 2), so non-vacuity is enforced by the feeder's materialize-narrow-anchor step (2), not "for free" by the compiler. The evidence anchor is content-hashed; a mutated memory invalidates the proposal.
4. **Wiring change**: add `~/.quanta/memory/` (via `resolveMemoryDirPaths().root`) to the `buildProposalIo` evidence roots in `src/agent/tier1/skill.ts:206` — **only when `QUANTA_SKILL_SUGGEST` is on** (default-OFF ⇒ roots unchanged, byte-identical).
5. **Promotion**: a suggested skill is UNTRUSTED — it lands **staged**, never live, and is installed only after operator approve. ⚠️ Inherits the RFC03-3 `promote-skill-proposal` actuator gap (`tier1/skill.ts:112`): until that resume→CAS-promote is wired, the suggestion degrades honestly to "drafted + review-bound, promotion pending host wiring" — never a silent write.

### D4 — Disablement-source projection — **2 real layers only** (admin + user)

**DROP the 3 phantom layers** (Correction / verdict): only two disablement sources have a real backing today, so ship exactly two and OMIT the rest — fabricating a "Disabled by project settings" reason string when no project layer source exists is a trust lie (own R3 forbids it). Project a `SkillDisablement` view = the highest-precedence *real* disablement layer + its verbatim reason string. Layers, precedence high→low:
- **administrator** — `org-policy.json` bannedSkills (`appsPage.appDisablement.administratorPolicy`="Disabled by your administrator").
- **user/personal** — the D1 disabled-set (user-actuated).

`project`/`session`/`device` are **NOT built** — they have no config.toml/env source today; when a real config.toml layer lands (RFC-03 §3, share the read-only projection type), add them then with real sources, never before. A lower layer can NEVER re-enable what a higher layer disabled (see R3): admin supreme over user. Gate-OFF ⇒ only `installState` shown as before.

### Surface degrade matrix

| verb | CLI | web (thin) | Tauri | headless/CI |
|---|---|---|---|---|
| copyMarkdown | print bytes to stdout | clipboard API | clipboard API | print bytes (or no-op) |
| reveal | print abs path | Tauri shell bridge | native file mgr | `unsupported` |
| enable/disable | mutate disabled-set + reload | control-request | direct port | allowed (no display needed) |
| uninstall *(PARK)* | `--yes` confirm + delete | approval request | approval dialog | refuse unless `--yes` |

---

## R5 verification, gates, effort, and sequencing (normative)

### Default-OFF

`QUANTA_SKILL_ACTIONS` is registered in shared runtime config and resolved at composition.
Gate-off must keep the current frozen implementation behavior-identical; the new live
authority is not half-bound. `QUANTA_SKILL_SUGGEST` remains unregistered/unimplemented while
D4 is PARKED.

### Non-vacuous receipts

- **Current-session disable:** invoke skill S successfully, disable at revision N, then
  prove in the same session that prompt inventory, ToolSearch, visible tools, CLI/web active
  views omit S and a stale/direct `Skill(S)` call is rejected. Re-enable and prove all views
  converge on N+2.
- **Management retention:** disabled S remains in management with the real effective reason.
- **Frozen-map injection:** deliberately retain the old `byName` map in one consumer; the
  parity test must fail specifically for that consumer.
- **Policy binding:** required skill by name with a non-admin winner cannot be disabled;
  banned disabled skill cannot be re-enabled. Run through the production composition root.
- **CAS/race:** concurrent toggles from the same revision produce one success and one stale
  rejection; failed durable write leaves every live consumer on the old revision.
- **Copy:** raw frontmatter present and action-time disk mutation reflected.
- **Reveal:** headless adapter never calls the spawner; plain web does not advertise a dead
  action.
- **Web:** if shipped, authenticated mutation returns the exact new revision and a hostile
  client cannot bypass policy.
- **Gate-off:** production prompt/search/invocation/readout snapshots match baseline.

### Effort

Copy/reveal alone are **S**. Live enable/disable is **M–L** because it replaces frozen
consumer capture, binds policy, adds durable CAS publication, and removes independent web
discovery. Estimate suggestion/uninstall only when un-parked. The prior total-M claim is
revoked.

### Sequence

1. D0 authority interface, composition binding, and frozen-map RED rail.
2. Cut prompt/search/invocation/CLI/web read consumers to the live projections.
3. Bind admin policy and durable disabled store; implement CAS actuator.
4. Add CLI actions and receipts; web only with a real mutation route.
5. Add copy/reveal independently after the same action-time resolver exists.
6. Revisit suggestion after RFC-03 authority; uninstall only after measured demand.

Hot files include `src/agent/tier1/skill.ts` and web runtime composition; serialize those
changes with other session-composition RFCs.

## Historical trust model (R4, superseded)

- **Imported/suggested skills are UNTRUSTED.** A suggest-from-history draft is agent-authored from local memory and MUST pass the existing `compileSkillProposal` gates + land staged + HITL approve before it is ever discoverable/invocable (aug-02 RFC-03; jul-12 trust). No auto-promote.
- **System skills are read-only.** Uninstall/disable of a `system` skill: disable is *allowed* (§0134 "system: 사용자 disable 가능" — a user may hide a bundled skill via the disabled-set), but **uninstall is refused** (the file ships with the binary; deleting it is out-of-scope and would break on next upgrade). system-shadow at the proposal layer is unchanged (`checkAdmission`).
- **Admin authority is supreme.** `decideInstall` is the SSOT: admin-required cannot be disabled; admin-banned cannot be enabled or installed. The user disabled-set (D1) is a LOWER layer and never overrides admin. Audit reuses `appendAuditEntry` when `auditRequired`.
- **Copy source of truth = disk.** Copy the raw `sourcePath` bytes (frontmatter intact, round-trippable), never the parsed in-memory `body`.
- **Path jail on every write/delete.** disabled-set write and uninstall delete go through jailed `@/storage` under the user skills dir; a path escaping the jail is a refusal, not a throw.

## Historical default-OFF gate (R4, superseded)

- `QUANTA_SKILL_ACTIONS` — gates D1 (copy/reveal/enable/disable verbs; uninstall PARKed) + D2 (3-surface disabled-filter) + D4 (2-layer projection). OFF ⇒ no port constructed, no verbs registered, `disabledNames` never populated, snapshot byte-identical across all 3 read surfaces, `/skills` unchanged.
- `QUANTA_SKILL_SUGGEST` — gates D3 (history feeder + memory evidence root). OFF ⇒ evidence roots unchanged (`[dir, cwd]`), no `/skill-suggest`, byte-identical. Depends on `QUANTA_SKILL_CREATOR` (reuses `skill_create`).
- Strict truthy parse only (`"1"`/`"on"`/`"true"`), mirroring `knobs/skills.ts`. No heuristics.

## Historical TDD + hellgate (R4, superseded)

- **RED e2e**: (a) a skill toggled disabled must be ABSENT from **all THREE read surfaces** (Correction 1): (i) the real `buildSkillBlock` `Skill` tool inventory + prompt block + CLI `/skills` list (`snapshot.skills`), (ii) the **ToolSearch `catalog:"skills"` results** (`snapshot.registry.entries` view — `tier1/skill.ts:192-195`), and (iii) the **web-daemon readout** `buildReadoutSources.skills()` (`runtime-factory.ts:440`) — one assertion each; fails today (no filter, and ii/iii are independent discovery paths). (b) copy-markdown of a skill whose file has frontmatter must return bytes CONTAINING the frontmatter (`---\nname:`), failing a naive `body`-copy. (c) reveal on `surfaceKind:"headless"` must return `unsupported` and MUST NOT call the spawner (red-on-injection: inject a throwing spawner, assert not invoked).
- **Leaf-crate unit**: `install-enforcement` decisions already covered; add disabled-set store put/readback/prune; `SkillActionsPort` copy (disk read, vanished-file refusal), reveal (per-surface branch), uninstall scope-fence (system/repo/admin refusal, user allow). Snapshot filter partition (disabled leaves `skills`, enters `disabled`).
- **Anti-vacuity pins**: copy test asserts against RAW FILE + red-on-injection (mutate file on disk between reads, assert bytes change — proves disk-read not cached body). disable test asserts FRESH snapshot readback (skill absent) across **all 3 read surfaces**, not just "flag set". suggest test asserts the proposal's evidence sha256 == the **materialized narrow-anchor file's** hash (NOT the parent `raw_memories.md` hash); empty/escape citation is refused by `resolveEvidence` (reuse existing compiler tests), but **whole-file citation is refused by the FEEDER** (the compiler passes it — Correction 2), so add a feeder-side test that a whole-file citation drafted from history is rejected before compile. setEnabled test pins: admin-required + disable ⇒ refused (`admin_attempt_disable`, requires real `winnerScope`); admin-banned + enable ⇒ refused (`banned_install_blocked`, requires install-route not disable-route).
- **3R adversarial audit** before "done" (see log). **Self-audit** after.

## Historical effort (R4, superseded)

Shippable high-value core = **D2-complete (3 surfaces) + copy/reveal/disable + slim-D4**.

- D1 copy + reveal + enable/disable: **M** (thin verbs; setEnabled winnerScope + install-route wiring is fiddly-small but load-bearing).
- D2 disabled-set store + snapshot filter across **3 read surfaces**: **S/M** (one store, one optional input, one partition + the `registry.entries` filtered view + the web-readout cutover — three consumed views, not one; the review upgrades this from S).
- D4 disablement-source projection, **2 layers only** (admin + user): **XS** (read-only view over existing admin policy + the disabled-set; the 3 phantom layers are DROPPED).
- **uninstall (D1d) — PARK.** If un-parked: **M** (safety is ~all new: scope-fence + jail + action-time re-resolve).
- **D3 suggest-from-history — after RFC03-3**, or draft-only with honest degrade: **M + a new evidence-materialization convention** (gather from stage1 store + memory-root wiring + CLI/web affordance + materialize-narrow-anchor-to-jailed-file; NOT "reuses compiler wholesale"). User value capped by the `promote-skill-proposal` dead seam.
- **Total honest estimate ≈ M** (core: D2-complete + copy/reveal/disable + slim-D4). The old "M-L" folded in PARKed uninstall and RFC03-3-blocked D3, inflating scope and apparent readiness. Gated, additive, no hot-path substrate change.

## Historical risks + traps (R4, superseded)

- **Reveal on headless/SSH** — spawning `open` on a display-less box hangs/errors. Mitigation: surface-gated (not platform-gated); headless ⇒ `unsupported`. Trap: `process.platform==="darwin"` on a headless mac still has no Finder — MUST key on `surfaceKind`, not platform. (R1)
- **Copy from `body` not disk** — the in-memory `Skill.body` is frontmatter-stripped; copying it yields a non-round-trippable artifact. MUST read `sourcePath`. Trap: `sourcePath` stale after moin/delete — no-throw refusal. (R1)
- **Disable badge without filter** — a "Disabled" badge while the skill stays in the `Skill` tool = jul-15 dead-seam trust lie. D2 filter is mandatory, not cosmetic. (R3)
- **Uninstall deleting system/shared skills** — `decideInstall` remove path returns `allowed:true` for non-admin unconditionally; the ACTUATOR must add the scope-fence. Trap: deleting a `repo`/`team` skill mutates version-controlled shared files. Fence to `user`/`personal`. (R2)
- **Vacuous history evidence** — citing the whole `raw_memories.md` is always-true. `resolveEvidence` forbids empty/escape/nonexistent but "whole file" PASSES (Correction 2) — so the FEEDER must **materialize the narrow anchor to its own jailed file and cite that** (line-anchor-into-raw_memories is incompatible with the path→whole-file-hash compiler). Test pins non-wholesale: proposal evidence sha256 == the *slice/materialized-file* hash, not the parent file's. (R2)
- **Promotion actuator gap** — D3 inherits `tier1/skill.ts:112` (resumeStep is a label). Honest degrade to "staged, promotion pending"; do NOT claim live install. (R2)
- **Lower layer overriding admin** — user disable-set must never re-enable an admin-banned skill. `decideInstall` is SSOT. (R3)
- **Concurrent-session hazard** — this repo has concurrent committers; `tier1/skill.ts` and `registry.ts` are hot. Land on a fresh worktree off `origin/main`, re-verify HEAD, no `git add -u`.

## Historical sequencing (R4, superseded)

1. **RFC03-0/2/3 (LANDED)** — registry cutover, `skill_create` compiler + stage. This RFC **depends on all three**.
2. **RFC03-3 promotion actuator (PREREQ for D3 live)** — the `promote-skill-proposal` resume→CAS-promote dispatch (`tier1/skill.ts:112` gap) must land before D3 suggestions can install live. Until then D3 ships as "draft + stage only".
3. **This RFC order**: D2 (3-surface disabled-filter — smallest high-value, unblocks the trust invariant across all read surfaces) → D1 copy+reveal+enable/disable (verbs on the completed filter; uninstall PARKed) → D4 (2-layer projection) → D3 (feeder, draft-only, after RFC03-3). D3 is the only item overlapping RFC-03's "self-improve" direction — it is a *feeder into*, not a *fork of*, `skill_create`.
4. No overlap with the other aug-22 RFCs except shared `config.toml` disablement plumbing (RFC-03 permission-mode composer §3 also reads a disablement matrix — share the read-only projection type, do NOT fork it).

## Historical open questions (R4, superseded)

- Disabled-set location: `~/.quanta/skills/.disabled.json` vs a `config.toml` key. Leaning JSON (jailed, simple) but Codex uses config.toml — align if RFC-03 §3 lands a config.toml reader first (share it).
- ~~Stage1 record → evidence path: materialize vs line-anchor?~~ **RESOLVED (Correction 2): materialize the narrow anchor to its own jailed file and cite that.** The compiler hashes `path → sha256(whole-file-bytes)`, so a line-anchor into `raw_memories.md` would hash the whole file (vacuous-passing); a slice-hash convention would be a forbidden compiler change. Materialize-to-jailed-file makes the whole-file hash == the slice.
- Web/Tauri reveal bridge: does the thin web client get a `control-request` shell-open, or is reveal Tauri-only? Surface-availability gating (surface-model memory: do not gate absorption on surface availability — but reveal is intrinsically display-bound).
- ~~5-layer: build project/session/device now, or projections?~~ **RESOLVED: DROP the 3 phantom layers.** Ship administrator+user (2 real sources) only; do NOT emit project/session/device reason strings until a real config.toml/env source exists (emitting them with no source = a fabricated reason = trust lie, R3). Add them when RFC-03 §3's config.toml layer lands.

---

## Audit log R1 → R3 (adversarial — break it)

### R1 — surface degrade + source-of-truth

- **BREAK (reveal/headless)**: initial design keyed reveal on `process.platform`. On a headless mac (`platform==="darwin"`) it would spawn `open -R` into a nonexistent WindowServer → hang or error, and on CI it silently opens nothing. **FIX**: key on `surfaceKind`, not platform; headless/unknown ⇒ `mode:"unsupported"`; CLI ⇒ `path-printed`. Only `tauri`/`web-bridge` spawns. Red-on-injection test: throwing spawner + `surfaceKind:"headless"` asserts spawner NOT called.
- **BREAK (copy source)**: first draft copied `skill.body` from the registry snapshot. That body is the post-frontmatter-parse markdown (`types.ts:93`) — it DROPS `---\nname:...\n---`, producing a SKILL.md that no longer round-trips through `discoverSkills`. Copying "Markdown" that isn't a valid skill file is a silent corruption. **FIX**: `copyMarkdown` reads raw `sourcePath` bytes at action-time. Trap surfaced: `sourcePath` can be stale (file moved/uninstalled since snapshot) → no-throw `{ok:false}`, never fall back to in-memory body. Test asserts frontmatter present + red-on-injection (disk mutation reflected).
- **BREAK (copy on truly headless)**: CLI "copy to clipboard" has no clipboard in a pipe/CI. **FIX**: CLI prints bytes to stdout (shell can `| pbcopy`); the port returns bytes, the surface owns the sink. No hard clipboard dependency in the leaf.
- **RESIDUAL**: linux `xdg-open` cannot *select* the file, only open the containing dir — documented, not a select-guarantee. Acceptable degrade.

### R2 — anti-vacuous history + uninstall safety

- **BREAK (vacuous suggestion)**: a suggestion could cite `raw_memories.md` wholesale as `evidence[]`. `resolveEvidence` (`compiler.ts:59`) only checks non-empty + resolves-under-root — a whole-file path PASSES. So "create skill from history" could distill a skill from an anchor it never actually read, laundering vacuity through a real-but-irrelevant path. **FIX**: the FEEDER (D3) must select a SPECIFIC anchor (a stage1 thread record / line-anchored slice) and cite THAT; the drafted body must derive from the anchor content. Test pins: (a) whole-file/empty citation refused; (b) proposal evidence sha256 == cited slice hash; (c) an anchor whose content does not appear in the body is flagged (HITL review catches semantic drift — the compiler cannot, so review is the backstop, honestly stated).
- **BREAK (memory root not jailed correctly)**: adding `~/.quanta/memory/` to evidence roots could let the agent cite `memory_summary.md` (LLM-distilled, second-order) as if it were raw evidence. **FIX**: acceptable — it still resolves to a real local file the operator reviews; but the CANDIDATE gatherer only surfaces `Stage1Entry.rawMemory`/`raw_memories.md`, not the summary, so first-order evidence is preferred. Root addition is `QUANTA_SKILL_SUGGEST`-gated.
- **BREAK (uninstall deletes system/shared)**: `decideInstall({kind:"remove"})` returns `allowed:true` for any non-admin remove (`install-enforcement.ts:129`). A naive actuator would `rm -rf` a bundled `system` skill dir (breaks next upgrade) or a `repo`/`team` skill (version-controlled). **FIX**: actuator scope-fence to `{user,personal}` + jail under user skills dir + `sourcePath` must be inside it; system/admin/repo/team ⇒ refuse with reason. Disable (hide) is still allowed for system per §0134.
- **BREAK (promotion overclaim)**: D3 "Create skill" success toast could imply the skill is installed. It is only STAGED (RFC03-3 actuator gap). **FIX**: success string = "staged for review", never "installed"; matches `skill_create`'s existing `compileAndStage` output ("installed only after you approve it").

### R3 — enterprise disablement trust + gate honesty

- **BREAK (lower layer re-enables admin-banned)**: a user "Enable skill" on an admin-banned skill would, if it just cleared the disabled-set, resurrect a policy-forbidden skill. **FIX**: `setEnabled(name,true)` runs `decideInstall({kind:"install"/"disable"})` against the loaded admin policy FIRST — banned ⇒ refuse. The disabled-set is strictly a LOWER layer; the 5-layer precedence (D4) makes admin supreme. Test: admin-banned skill + user enable ⇒ refused + audit `banned_install_blocked`.
- **BREAK (disable badge is cosmetic)**: if D2's filter were skipped and only a badge rendered, the skill stays in the `Skill` tool inventory → the model can still invoke a "disabled" skill (jul-15 dead-seam). **FIX**: D2 filter is the actuator; the badge is derived from `snapshot.disabled`. RED e2e asserts the disabled skill is ABSENT from a real `buildSkillBlock` inventory, not merely flagged. This is the load-bearing test.
- **BREAK (5-layer projection invented)**: surfacing "Disabled by project settings" when no project layer source exists = a fabricated reason string (measurement/trust lie). **FIX**: D4 emits a layer's reason ONLY when that layer has a real source (administrator=org-policy.json, user=disabled-set today; project/session/device emit ONLY if a real config.toml/env source is present, else omitted). No phantom reasons. Open-Q flags project/session/device as projections pending a real config.toml layer.
- **BREAK (gate leak)**: `QUANTA_SKILL_ACTIONS` OFF must be byte-identical. Risk: D2 adding `disabledNames` param to `buildSkillSnapshot` changes the call even when empty. **FIX**: param optional, default empty set ⇒ filter is a structural no-op (partition of ∅), snapshot output identical; assert byte-parity of `/skills` + prompt block with gate OFF. Same for the evidence-root addition (D3) — roots unchanged when `QUANTA_SKILL_SUGGEST` OFF.
- **SELF-AUDIT residual**: the memory-root evidence widening (D3) is the one genuinely new trust surface (the agent can now cite `~/.quanta/memory/`). It is double-gated (`QUANTA_SKILL_CREATOR` ∧ `QUANTA_SKILL_SUGGEST`), staged-only, HITL-reviewed, content-hashed. Acceptable under the existing skill-trust posture, but flagged as the item most deserving a 3rd-round re-audit at implementation time (claim-100 rule).
