# RFC-04 Approval/Policy/MCP backlog — CURRENT-code audit (2026-08-10)

Read-only audit of the four RFC-04 sub-items against live `src/` at `main` HEAD.
The README/RFC status is **STALE**: the item RFC-04 called "the ONE real seam"
(MCP hot-reload) has since been **fully landed** by a concurrent session.

Basis: `docs/plans/aug-02-absorption/{README.md,rfc-04-approval-policy.md}` vs. current `src/`.
Round 1 = existence/wiring. Round 2 = adversarial refutation (dead-seam / gate / improvement).

---

## Sub-item 1 — MCP hot-reload / tool-surface refresh

**Verdict: ALREADY-BUILT (was "DESIGN FIRST / M-L" GAP) — real + wired + gated + turn-pinned.**

The entire RFC04-0..3 packet is landed. It is NOT a dead seam.

Round-1 evidence (existence + wiring, end-to-end):
- Turn snapshot record + atomic pointer: `src/agent/turn-registry-snapshot.ts:61` `TurnRegistrySnapshot{id,protocolVersion,registry,specs,fingerprint}`, `:101` `buildTurnRegistrySnapshot` (specs derived from the SAME registry → "advertise A / dispatch B" is unrepresentable), `:127` `createTurnRegistrySnapshotRef` (read-only `current()` + host-only `publish`).
- **Turn-boundary generation pin: YES.** `src/agent/loop/session-bootstrap.ts:243-244` reads `cfg.registrySnapshotRef?.current()` exactly ONCE per turn boundary; `:248-249` feeds `registrySnapshot.specs`/`registrySnapshot` into `TurnSession`. A publish between turns is picked up NEXT turn; a pinned turn keeps its generation.
- **listChanged consumed + capability-gated: YES.** `src/mcp/resources/notifications.ts:76` parses `notifications/tools/list_changed` into a typed `{kind:"tools_list_changed"}`; `src/mcp/client.ts:418-424` `gatedResourceObserver` DROPS the event unless `serverSupportsToolsListChanged()` (`src/mcp/client/capabilities-gate.ts:48` reads `capabilities.tools.listChanged === true`, fail-closed). An unsolicited notification from a non-advertising server cannot trigger a reload.
- Observer→controller edge: `src/host/mcp-composition.ts:716-736` builds the observer whose `onNotification` fires `controller.requestReload()` only on `tools_list_changed` and only once the controller is late-bound.
- Reload controller (single-flight + dirty replay + compare-and-publish + LKG): `src/host/runtime/mcp-tool-reload.ts:98-117` `runOnce` (rebuild → `fingerprint` compare → atomic `publish`, **rebuild throw ⇒ retain prior snapshot**, no partial/empty publish), `:122-128` `drain` (one-inflight + one dirty replay, no timer/backoff).
- Composition root wiring: `src/host/bootstrap/bootstrap-session.ts:634-666` `buildMcpHotReloadFeeder` seeds from connect-time registry, builds `rebuild = buildTurnRegistrySnapshot(rebuildRegistry(await relistMcpTools(sources)))`, creates the controller, and **late-binds** it into the observer. CLI enables the rebuild surface at `src/apps/cli/internal.ts:922-925` (`exposeRebuild` under the same gate) and wires the observer at `:599-607` (`resolveMcpHotReload` + `mcpHotReloadLoadOpts`).
- **Both client modes covered.** Supervised (auto-restart) path also relists: `src/host/mcp-composition.ts:748-752` no longer gates out `autoRestart`; the observer is baked into the supervisor factory (`:836-846`).
- Gate: `src/host/mcp-composition.ts:90` `mcpHotReloadEnabled` = `QUANTA_MCP_HOT_RELOAD` (default OFF); catalogued at `src/config/knob-inventory/host.ts:437`.

Round-2 (adversarial):
- Dead-seam? NO — observer is constructed at the composition root under the gate (`bootstrap-session.ts:661-663`), not test-only. The R1-DEAD-1 concern in the RFC is closed.
- Auto-elevation (R1-SEC-1)? Trust is preserved: `rebuild` re-runs the SAME `rebuildRegistryWithMcpTools` assembly connect uses, so reloaded tools inherit connect-time origin/trust; no auto-approve path.
- Fail-open on relist error (R3-SEC-1)? Closed: `mcp-tool-reload.ts:104-107` retains the prior snapshot (LKG) on rebuild throw.
- Reconnect/negotiator refresh (Round-2 mandate): `src/mcp/reconnect/supervisor.ts:387` re-runs `tools/list` on restart, but ONLY as a health check (a non-advertising server ⇒ failed restart); it does NOT itself publish the new list. Refresh flows through the same observer/controller, not the supervisor. So there is no second/duplicate reload owner.
- **Gap: essentially none.** Only tiny hardening left: `full-negotiator.ts:52` still advertises `tasks.listChanged:false` (client→server direction, unrelated to inbound tool-reload). No action.

ROI: **0 (done).** Update README RFC-04 row + Wave-3 line ("RFC-04 MCP hot reload") to LANDED.

---

## Sub-item 2 — trust-hash (hook binding content hash)

**Verdict: ALREADY-BUILT — real + wired + fail-closed (confirms RFC "already implemented").**

Round-1:
- `src/agent/command-hooks/review-store.ts:50-53` `hookBindingKey` = SHA-256 over the NORMALIZED tuple `event \x00 matcher \x00 command`, truncated to 16 hex. Digests all THREE fields (event+matcher+command) — this is exactly the R2-SEC-2 fix the RFC listed as "genuine delta," already present. A widened matcher or changed command bytes re-arms review.
- Load-time recompute: `:117-124` — on load, the store trusts `hookBindingKey(rec)` recomputed FROM the record content, not the stored key; a tampered key→command mismatch cannot pre-approve a different command.
- Fail-closed load: `:100-127` — absent/unreadable/malformed ledger ⇒ empty store (nothing approved).

Round-2:
- Tautology risk (R1-VAC-1)? Not a production concern; the store's `isApproved` (`:132,142`) is the public surface, keyed by the recomputed digest.
- **Gap: the 16-hex truncation** the RFC flagged as "optional hardening" is unchanged (64-bit space; collision is a local-integrity, not adversarial-crypto, threat per RFC Open-Q). Widening to full SHA-256 + a `version` bump is a self-contained migration, but low value.

ROI: **~0.** Optional hardening only. Update RFC A4.2 note: trust-hash DONE, not "thin genuine delta remaining."

---

## Sub-item 3 — Guardian / auto_review routing

**Verdict: ALREADY-BUILT — real, reachable, fail-closed, gated. One genuine improvement lever.**

Round-1:
- Tier enum (Codex `approvals_reviewer` parity): `src/permission/types.ts:131` `ReviewerTier = "user" | "auto_review" | "guardian_subagent"`.
- Router: `src/permission/reviewer.ts:247-260` `dispatchFresh` routes user/auto/guardian, with the richer `guardianAssess` under `runtimeConfig().guardianAssessor` (ADR-0497). Entry `reviewAction` (`:269`) fails CLOSED — a throwing/invalid port re-throws into the gate deny path (`:300-316`) after closing the lifecycle surface.
- Tier selection: `src/permission/reviewer-default-policy.ts:90-100` `selectDefaultReviewer` — `autoReviewEnabled + hasGuardianReview` ⇒ guardian, else auto_review, else fallback `user` (fail-closed).
- **auto_review mode + disable exist** as gates, not a `disableAutoReview` flag: `QUANTA_AUTO_REVIEW` (strict `=== "1"`) and `QUANTA_APPROVAL_LADDER` posture (`src/shared/runtime-config.ts:677,681`; knobs `src/shared/runtime-config-knobs/knobs-b.ts:203,211`). CLI opt-in at `src/apps/cli/repl/cli-admissibility-compose.ts:40,80`. Default OFF ⇒ tier is `user`, i.e. auto-review is disabled by default (there is no separate disable flag because it is opt-IN).
- Collapse boundary: `src/permission/assessment-collapse.ts:96` `collapseAssessment` (ActionAssessment → ApprovalDecision, conservative/total, fail-closed to `guardian_denied`).
- **Risk-level scoring already exists** (Round-2 mandate re: Codex `GuardianRiskLevel`): `src/permission/types.ts:169` `riskLevel: "low" | "medium" | "high"` on every `ApprovalDecision`.

Round-2 (adversarial + improvement):
- `guardian_subagent` reachable, not dead? YES — `reviewer-default-policy.ts:97` routes to it under `autoReviewEnabled + hasGuardianReview` (RFC R1-DROP-check verified this too).
- **Real improvement lever (the one worth noting):** the deterministic auto-tier NEVER produces `medium`. `src/agent/reviewer-port.ts:46-47` `riskLevelFor = action.isReadOnly ? "low" : "high"` — a binary. The `medium` literal is only ever emitted by an external guardian assessor via `collapseAssessment` (`assessment-collapse.ts:107` clamp). So quanta HAS a 3-level type but the built-in scorer is 2-level. Codex `GuardianRiskLevel{low|med|high|critical}` is 4-level. Adding a `critical` tier + a graded (not binary) `riskLevelFor` (e.g. HARD_DENY-adjacent ⇒ critical, mutation ⇒ high, config-read ⇒ medium) would let the reviewer route by severity instead of a boolean. **But** this must stay ADVISORY (README "No heuristic authority": PID/keyword/score must NOT drive trust/routing/mutation authority) — so this is a diagnostics/UX legibility lever, not a gating one. Guard against it becoming a keyword-scored authority.
- Gap otherwise: NONE. Router is SOTA++; RFC verdict DROP stands.

ROI: **low.** `critical` tier + graded advisory `riskLevelFor` = ~S, UX/legibility only, must be non-authoritative. Everything else DROP (built).

---

## Sub-item 4 — ExecPolicy prefix-rule TOML

**Verdict: GAP (not built) — and correctly DROPPED. Do not build without an external fixture/consumer.**

Round-1:
- The rule ENGINE exists: `src/rules/types.ts:30` `RuleAction = allow|deny|ask`, `:56` `argv?` token-prefix (Codex `prefix_rule` parity), 3-layer `system|user|project` store (`src/rules/store.ts`, `src/rules/parser.ts`, `src/rules/argv.ts`).
- The untrusted-source fence exists: `src/permission/circumvention.ts` `buildAutoModeOverlay` (repo/project-layer rule may only tighten; `allow`/`hard_deny` from a repo is dropped/demoted).
- Session-amend ledger exists: `src/permission/session-grant-prefix.ts` (`derivePrefixGrantKey`, shell-metachar smuggling guard).
- **No `src/rules/exec-policy-toml.ts`, no `justification` field, no TOML parser/loader** anywhere in `src/` — confirmed by grep. The declarative TOML front-end was never built.

Round-2:
- Is it partially there under another name? NO — the disposition is deliberate. README single-owner matrix + delete-register: "새 declarative provider adapter / TOML policy engine → DELETE / DROP." RFC-04 correction: TOML is "existing declarative rule model의 중복 front-end … DROP until external compatibility fixture + real importer."
- Gap = a redundant front-end onto an engine that already exists. Building it now would add a parser/loader/event with no consumer.

ROI: **DROP (do not build).** Reopen only with an external Codex-TOML fixture AND a real importer consumer, as its own RFC.

---

## Round-2 net changes vs Round-1

Round 1 already classified 1=ALREADY-BUILT, 2=ALREADY-BUILT, 3=ALREADY-BUILT, 4=GAP-but-DROP. Round 2 did NOT overturn any verdict but ADDED:
1. Confirmed the MCP reload is NOT a dead seam (observer built at composition root, both client modes, LKG on error) and that the supervisor's restart-time `tools/list` is only a health check, so there is no duplicate reload owner.
2. Surfaced the one concrete improvement (`riskLevelFor` is binary low/high; `medium` unreachable from the built-in scorer; no `critical` tier vs Codex) — flagged as advisory-only to respect the no-heuristic-authority fence.
3. Confirmed trust-hash covers all three fields (not command-only) and recomputes on load — the R2-SEC-2 hole the RFC worried about is already closed.

**Headline: the README RFC-04 row and Wave-3 "MCP hot reload" entry are STALE — that item is LANDED (gated `QUANTA_MCP_HOT_RELOAD`, turn-pinned, capability-gated, LKG-safe). The remaining backlog is effectively empty: trust-hash + guardian are built; TOML stays dropped; only an advisory risk-tier polish is optional.**
