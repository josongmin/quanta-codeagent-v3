# _review-06 — RFC-06 Skills Card Actions (Copy · Reveal · Enable/Disable/Uninstall · Suggest-from-History)

READ-ONLY code-grounded review. Reviewer: research agent, 2026-08-22.
Target: `docs/plans/aug-22-흡수계획/rfc-06-skills-actions.md`
Cross-check: `docs/plans/aug-02-absorption/rfc-03-self-improve-onboarding.md`

---

## A. Snapshot

- **git**: HEAD = origin/main = main = `9d5369d310bba9cfcdf2508ca62e6274f184cdd4` (branch `main`, clean sync).
- **dirty (pre-existing, NOT touched — bench/leaderboard workstream)**: `M src/apps/bench/**`, `M src/runner/batch/**`, `M tools/leaderboard-dashboard/**`, plus untracked `adapters/terminal-bench/**`, `docs/plans/aug-21-*`. **Zero overlap with the skill slice** (`src/skill/`, `src/agent/tier1/skill.ts`, `src/apps/cli/repl/skills-surface.ts`, `src/apps/web-daemon/runtime-factory.ts` are all clean). RFC-06's write-set is collision-free against the current dirty set.
- **RFC file:line audit — accurate**. Every cited symbol/line resolves within ±a few lines:
  - `registry.ts:237 buildSkillRegistry` ✅, `:315 buildSkillSnapshot` ✅, 7-scope + precedence + collision receipts ✅, **no disabled-filter** ✅ (confirmed absent).
  - `types.ts` `Skill.sourcePath` (line 104, interface at 88) ✅, `scope` closed union `:23` ✅, `installState` `:62` ✅, `body` = "Markdown body **after** the frontmatter block" (`:93`) ✅ — confirms copy-from-`body` drops frontmatter.
  - `compiler.ts:128 compileSkillProposal` ✅, `:59 resolveEvidence` ✅ (empty→`no_evidence`, escape/missing→`evidence_unresolved`, per-anchor sha256 `:71`) ✅, `:78 checkAdmission` (system-shadow/unknown-target) ✅.
  - `skill-creator.ts:256 createSkillCreatorTool` ✅, `compileAndStage:213` ✅ (output = "staged for review… installed only after you approve").
  - `tier1/skill.ts:206` evidence roots = `[dir, process.cwd()]` ✅ (memory dir NOT a root), `:112-116` `promote-skill-proposal` is a **LABEL — dead seam** ✅ (comment states no consumer re-verifies+CAS-promotes).
  - `install-enforcement.ts:117 decideInstall`, `:91 decideDisable`, `:62 decideNonAdminInstall` ✅ — **pure decisions, zero actuation** ✅. `admin-policy.ts:96 loadAdminPolicy` ✅.
  - `memory/consolidate/paths.ts:20 resolveMemoryDirPaths` (`.root` exists) ✅, `stage1-store/types.ts:17 Stage1Entry` (`rawMemory:27`, `rolloutSlug`, `usageCount:37`) ✅.
  - `browser-flow.ts:46 openBrowserDefault` (spawn open/cmd-start/xdg-open, `detached, stdio:"ignore"`) ✅ — **but** it THROWS `BrowserFlowError` on failure (not "no-throw"); the no-throw/injectable-`opener` seam is the surrounding flow, not this const. RFC uses it only as a *shape* reference, which is fine.
  - `appendAuditEntry` exists (`src/skill/audit-log.ts:132`, `<repo>/.quanta/audit/skill-install.log`) ✅ — RFC's "audit reuses appendAuditEntry" is grounded.
  - "no `revealIn*`/`enableSkill`/`disableSkill`/`uninstallSkill`/`disabledNames`/`.disabled.json` symbol anywhere in `src/`" ✅ (grep empty). Clipboard is paste-IN only ✅.
  - `QUANTA_SKILL_ACTIONS` / `QUANTA_SKILL_SUGGEST` do **not** exist yet ✅; `QUANTA_SKILL_CREATOR` wired via `gateOn` (`runtime-config.ts:314`, `knobs-a.ts:169`, `types.ts:405`, `gated-tools.ts:700`) — the knob-add pattern is established. Strict-truthy parse pattern confirmed in `runner/knobs/knobs/skills.ts`.

**Net: the RFC's current-state map is trustworthy.** Substrate reuse is real. Three concrete holes (below) keep it out of READY.

---

## B. Per-action BUILD / DROP / PARK

| Action | Verdict | One-line rationale |
|---|---|---|
| **copyMarkdown (D1a)** | **BUILD** | Thin, clean disk-read reuse; real gap (clipboard is paste-in only); load-bearing test = frontmatter-present + disk-mutation-reflected. |
| **reveal (D1b)** | **BUILD (thin)** | Almost no substrate; the whole design *is* the honest-unavailable degrade. Correctly surface-gated (not platform-gated). |
| **enable/disable (D2 + D1c)** | **BUILD — keystone** | Closes the jul-15 dead-seam trust invariant. **BUT the D2 filter as written is incomplete** (§D/§G-1). Highest priority; do first. |
| **uninstall (D1d)** | **PARK** | Low ROI over disable; destructive; its real safety is ~all NEW bespoke FS code (`decideInstall` remove gives nothing for non-admin). Disable already lets a user hide *any* skill incl. system. Revisit only on a concrete disk-reclaim / user-authored-churn need. |
| **suggest-from-history (D3)** | **BUILD-PARTIAL / defer** | Compiler reuse is genuine, but "anti-vacuous for free" is only *partially* true (§G-4) and it inherits the promote-actuator dead seam (`tier1/skill.ts:112`). Ships "draft+stage only" until RFC03-3. Consider PARK until RFC03-3 lands to avoid shipping a half-dead verb. |
| **5-layer projection (D4)** | **DROP the phantom 3 / BUILD 2** | Only `administrator` (org-policy.json) + `user` (disabled-set) have real sources today. Ship a 2-value "disablement source" and honestly OMIT project/session/device until a real config.toml layer exists. Fabricating 3 reason strings = trust lie; RFC's own R3 forbids it — so just don't build the 3. |

---

## C. Existing registry/compiler reuse map (what is genuinely reused vs new)

| RFC verb | Reuses (verified) | Genuinely NEW code | Reuse honesty |
|---|---|---|---|
| copyMarkdown | `snapshot.registry.lookup(name)` → `skill.sourcePath`; `@/storage readFile` | port wrapper + surface sink (stdout/clipboard) | **Sound** — no reinvention. |
| reveal | `browser-flow` spawn *shape* (not the fn) | `surfaceKind` branch + per-OS args | **Sound** — RFC explicitly says "shape, not this function". |
| setEnabled | `decideInstall`/`decideDisable`/`decideNonAdminInstall` (SSOT decisions); `loadAdminPolicy`; `@/storage` jailed write; `appendAuditEntry` | `.disabled.json` store + **D2 snapshot filter** | **Sound decision-reuse**, but the *actuator* (store+filter) is the whole point and is new — correctly scoped as "no new decision machine". |
| uninstall | `decideInstall({kind:"remove"})` for the admin path only; `@/storage` jailed deleter | **scope-fence to {user,personal} + jail + sourcePath-inside + stale re-verify** | **Thin reuse**: `decideInstall` remove returns `allowed:true` unconditionally for non-admin (`install-enforcement.ts:129`). ~All real safety is new. RFC states this (R2) but the "reuse decideInstall" framing overstates the help. |
| suggest-from-history | `compileSkillProposal` + `skill_create` + `SkillProposalStagePort` + `resolveMemoryDirPaths`/`Stage1Entry` | memory-root add + **anchor materialization** + CLI/web affordance | **Partial** — see §G-4: the compiler does NOT reject whole-file citation, so non-vacuity needs new feeder logic, not reuse. |
| D2 filter | `buildSkillSnapshot` optional `disabledNames` param | partition of `entries` into `skills` vs `disabled` | **Sound as a projection** (matches "no separate registry"), but must cover more views than `snapshot.skills` (§D). |

**No SkillRegistry / compiler / approval-machine reimplementation is proposed.** The one new port (`SkillActionsPort`) + one new store (`.disabled.json`) + one optional snapshot input is consistent with RFC-03's "중복 금지" register. ✅

---

## D. Disable actuator — actual consumption path (the load-bearing trace)

**Invocable surface (agent loop) is uniformly gated — GOOD:**
`buildSkillBlock` (`tier1/skill.ts:169`) is the single builder. `createSkillTool(skills)` (`:187`) is the ONLY `createSkillTool` call site in `src/`, and `skills = [...snapshot.skills]` (`:181`). The prompt suggestion inventory (`:250`) and CLI `/skills` (`skills-surface.ts:29-32` → `snapshot.skills`) also read `snapshot.skills`. **So partitioning `snapshot.skills` DOES remove a disabled skill from: the `Skill` tool inventory, the prompt block, and CLI `/skills`.** The RFC's three named surfaces are correctly covered → no invocation escape on the main path.

**Two additional consumed views the RFC's D2 does NOT filter — REAL leaks:**

1. **ToolSearch skill-catalog reads `snapshot.registry.entries`, NOT `snapshot.skills`.** `createToolSearchTool(() => specs, () => snapshot.registry.entries)` (`tier1/skill.ts:192-195`). D2 partitions `skills` but the RFC never says it filters the `registry.entries` view. Result: a disabled skill **still appears in the `catalog:"skills"` search results** (the model's discovery surface). Invocation is still blocked (the filtered `createSkillTool` refuses an unknown name), so it is a **discovery-surface dead-seam**, not an invocation escape — but it is exactly the jul-15 "shows as available while disabled" trust-lie class, on the model's own surface.

2. **Web-daemon readout runs an INDEPENDENT discovery.** `runtime-factory.ts:440-441` `buildReadoutSources.skills` calls `discoverSkills(skills.dir)` + `discoverSystemSkills()` directly (its own Map-based collision merge, even with the *wrong* "system wins" precedence vs ADR-0134 user-wins — a pre-existing inconsistency, not this RFC's). This path bypasses `buildSkillSnapshot` entirely, so the **web /skills panel would still list a disabled skill as active**. RFC03-0's cutover cleaned `tier1/skill.ts` + `skills-surface.ts` but never touched web-daemon's readout.

**Consequence for D2:** the projection must be threaded into (a) the `registry.entries` view ToolSearch consumes and (b) the web readout — OR both must be cut over to consume the filtered snapshot. Filtering only `snapshot.skills` leaves two "Disabled-but-visible" surfaces. This upgrades D2 from S to **S/M** and is the #1 REVISE item.

**setEnabled wiring correctness (load-bearing):** `decideDisable` blocks only when `requiredSkills.includes(name) && requestedScope === "admin"` (`install-enforcement.ts:96-99`). The actuator MUST pass `requestedScope = snapshot.registry.lookup(name).winnerScope` (an admin-required skill's winnerScope IS "admin" since admin has top precedence) — a hardcoded `"user"` would silently let a user disable an admin-required skill. Pin this in a test.

---

## E. Scope/policy precedence + delete threat model

- **Admin supremacy — sound, with a wiring caveat.** `decideInstall` is the SSOT. For **re-enable of an admin-banned skill**: `decideDisable` does NOT check `bannedSkills`; the ban check lives in `decideNonAdminInstall` (`:66`). So `setEnabled(name,true)` MUST route through `decideInstall({kind:"install", requestedScope:<non-admin winnerScope>})` to hit the banned block — RFC R3 says exactly this. Caveat: if the enable path is routed as `kind:"disable"` (clear-set) instead of `kind:"install"`, the ban is NOT re-checked. Pin the "admin-banned + user enable ⇒ refused + audit(`banned_install_blocked`)" test.
- **Registry scope-retag HELPS the uninstall fence.** `discoverSkillSourcesIn` (`registry.ts:168-170`) forces each skill's `scope` to its **source directory's** scope whenever it differs (overriding even a frontmatter `scope:` claim). So effective `scope === "user"` ⟺ mounted under the user source dir. A malicious `SKILL.md` in the user dir claiming `scope: admin` (to look undeletable) or claiming `scope: user` from a system dir (to look deletable) is **retagged to its mount dir** → the fence (`scope ∈ {user,personal}` + `sourcePath` jailed under the user skills dir) is double-guarded and cannot be spoofed by frontmatter. (Note: the code comment says "frontmatter wins" but the code forces source-dir scope; the security property the fence needs holds regardless.)
- **Uninstall FS boundary (must be explicit):** delete target = the skill DIR derived from `sourcePath`; system skills live under `systemSkillsDir()` (bundled, outside the user dir) so a user-dir jail naturally refuses them; `repo`/`team` live under `<repo>/.quanta/skills` & `<repo>/.team-skills` (version-controlled) — also outside the user jail. Fence = scope∈{user,personal} AND `sourcePath` canonicalized-under user skills dir AND (see §G) name-of-dir still matches. `decideInstall` contributes only the admin-remove guard; everything else is new.

---

## F. Minimum write-set + conflict owners

| File | Change | Owner / conflict risk |
|---|---|---|
| `src/skill/registry.ts` | `buildSkillSnapshot` optional `disabledNames`; partition `entries` → `skills` / `disabled`; **also expose a filtered entries view for ToolSearch** | HOT (RFC-03 owner). Concurrent-session hazard — land off fresh origin/main. |
| `src/agent/tier1/skill.ts` | thread `disabledNames` into snapshot; pass filtered entries to `createToolSearchTool`; add memory root when `QUANTA_SKILL_SUGGEST`; construct `SkillActionsPort` | HOT. Same hazard. |
| `src/apps/cli/repl/skills-surface.ts` | consume `snapshot.disabled` for badge; wire enable/disable/uninstall/suggest slash verbs | Clean today. |
| `src/apps/web-daemon/runtime-factory.ts:440` | **cut readout over to snapshot OR thread disabledNames** (else web panel leaks disabled) | Clean today; NOT in RFC's stated write-set — **add it**. |
| `src/skill/skill-actions*.ts` (NEW) | `SkillActionsPort` copy/reveal/setEnabled/uninstall | New file. |
| `src/skill/disabled-set*.ts` (NEW) | `.disabled.json` jailed store put/readback/prune | New file. |
| `src/shared/runtime-config*.ts`, `runtime-config-knobs/knobs-a.ts`, `tool/surface/gated-tools.ts` | register `QUANTA_SKILL_ACTIONS`, `QUANTA_SKILL_SUGGEST` (mirror `skillCreator`) | drift-guard forces the SSOT entry. |

The RFC's write-set omits `web-daemon/runtime-factory.ts` — that omission is the mechanism behind the §D-2 leak.

---

## G. Hellgate targets (stale sourcePath · admin-ban re-enable · scope escape · vacuous history)

1. **D2 completeness (NEW, from this review):** RED e2e must assert a disabled skill is ABSENT from **all four** read surfaces — `Skill` tool inventory, prompt block, CLI `/skills`, **AND** `ToolSearch catalog:"skills"` results **AND** the web readout `skills()` — not just `snapshot.skills`. RFC's stated RED (three surfaces) is insufficient; add the ToolSearch + web-readout assertions or the seam ships half-dead.
2. **Stale sourcePath — copy is handled, uninstall is under-specified.** Copy: no-throw `{ok:false}` on vanished file ✅. Uninstall: between snapshot and delete, a concurrent session (this repo has committers racing — see memory) could replace the skill dir. Jail-check alone is insufficient — the actuator must **re-resolve via `registry.lookup(name)` at action-time and verify the dir still holds that skill's SKILL.md** before `rm`, else it deletes a repurposed dir. Pin a "sourcePath repointed since snapshot ⇒ refuse" test.
3. **Admin-ban re-enable:** test admin-banned + `setEnabled(true)` ⇒ refused + `banned_install_blocked` audit; and admin-required + `setEnabled(false)` ⇒ refused + `admin_attempt_disable` (requires passing real `winnerScope`, §D).
4. **Vacuous history — the weakest reuse claim.** `resolveEvidence` (`compiler.ts:59-73`) checks only non-empty + resolves-under-root + readable. **A whole-file `raw_memories.md` citation PASSES all three** and gets a valid whole-file sha256. So "route through the compiler ⇒ anti-vacuous applies unchanged" is **only partially true**: the compiler stops empty/escape/nonexistent, NOT wholesale. Enforcing "specific anchor" needs NEW feeder logic, and because evidence is `path → sha256(whole-file-bytes)`, a "line-anchored slice" only works if the slice is **materialized to its own jailed file** whose whole-file hash == the slice (RFC Open-Q option A). The "line-anchor into raw_memories.md" option (Open-Q, "prefer") does NOT work against the current compiler — it would hash the whole file — unless a slice-hash convention is added to `ProposalIo`, which is a compiler change the RFC forbids. **Resolve the Open-Q toward materialize-to-jailed-file.** Test must pin: whole-file citation drafted from history ⇒ refused (by the feeder, since the compiler won't) + proposal evidence sha256 == the *slice* hash, not the parent file's.
5. **Scope escape:** covered by the registry retag (§E) — add a test that a user-dir skill with frontmatter `scope: admin` is still uninstallable-refused/allowed per its MOUNT scope, proving frontmatter cannot flip the fence.

---

## H. Recommended order + M-L effort re-eval

**Order (revised):**
1. **D2 disabled-projection FIRST**, but scoped to cover `snapshot.skills` + the ToolSearch `registry.entries` view + the web readout. **S → S/M** (RFC's S undercounts: three consumed views, not one).
2. **D1 copy + reveal + enable/disable** on the completed filter. **M** (fair: 4 verbs × surface-degrade matrix; setEnabled winnerScope wiring is fiddly-small).
3. **D4 → downgrade**: ship a 2-value disablement-source (admin|user), OMIT project/session/device. **S → XS.**
4. **uninstall → PARK** (see §B). If un-parked later: **M** (safety is ~all new).
5. **D3 suggest-from-history → after RFC03-3**, or ship draft-only with honest degrade. **M** for the draft path, but user value is capped by the promote-actuator dead seam AND the anchor-materialization work (§G-4). Not "reuses compiler wholesale, ~M" — closer to **M + a new evidence-materialization convention**.

**Total honest estimate:** the shippable, high-value core (D2-complete + copy/reveal/disable + D4-slim) is **M**. The RFC's "M-L total" folds in uninstall (PARK) and D3 (blocked on RFC03-3), which inflates both scope and apparent readiness.

---

## I. Verdict: **REVISE**

The RFC is unusually well-grounded — file:line claims are accurate, the substrate reuse is real (no registry/compiler/approval reinvention), and the two hardest truths (the `promote-skill-proposal` dead seam and the "system disable-yes / uninstall-no" posture) are honestly flagged. It is NOT ready as written because of three concrete, code-verified holes:

1. **D2's filter is incomplete** — it removes disabled skills from `snapshot.skills` but NOT from the `registry.entries` view ToolSearch skill-mode reads (`tier1/skill.ts:194`) NOR from the web-daemon's independent readout discovery (`runtime-factory.ts:440`). Both must be threaded through the projection (or cut over to the snapshot), and the RED e2e must assert absence on all of them — else "Disabled" is a badge-only lie on two surfaces (the exact class the RFC claims to close).
2. **"Anti-vacuous applies for free via the compiler" is only partial** — `resolveEvidence` passes whole-file citations. Non-vacuity requires new feeder-side anchor materialization to a jailed file (resolve Open-Q toward option A; the "line-anchor" preference is incompatible with the current path→whole-file-hash compiler).
3. **Load-bearing wiring not yet pinned** — setEnabled must pass the real `winnerScope` and route enable through the `install` decision (not `disable`) to keep admin supreme; uninstall needs action-time re-resolve beyond the jail to survive the concurrent-committer hazard.

Plus two scoping steers this review endorses: **PARK uninstall** (low ROI over disable, safety is ~all new code) and **DROP the 3 phantom disablement layers** (ship admin+user only). With D2 completed across all consumed views, the vacuous-history Open-Q resolved to materialize-to-jailed-file, and the wiring tests pinned, copy + reveal + disable + (post-RFC03-3) suggest are READY to build; uninstall and the 5-layer breadth are not worth the current cost.
