# RFC-04 — Approval / Policy / Hook / MCP-Reload Absorption

**Status**: RE-AUDITED — MCP HOT-RELOAD DESIGN FIRST; TOML/GUARDIAN/HOOK-BREADTH/TRUST-HASH DROP. NOT started.
**Scope**: A3 (guardian reviewer router), A5 (declarative ExecPolicy prefix-rule + session amend ledger), A4.2 (hook event breadth + trust-hash), A4 (MCP hot-reload). Context: `docs/analysis/aug-02-competitor-corpus-refresh-audit.md` §3.3/§3.4/§4.2/§8.

---

## 2026-08-03 current-HEAD correction (authoritative)

Audit basis: `main@0a00ced392102073fe35eccd202bca92cabd71dc`. Focused current-head rails: **71 pass / 0 fail**. 이 절과 아래 과거 초안이 충돌하면 **이 절이 우선**한다.

| Item | corrected verdict | owner delta | admission / stop rule |
|---|---|---|---|
| A3 guardian | **DROP** — approval router/core already exists. | 없음. | duplicate router/reviewer 금지. |
| A4.2 hook breadth + trust hash | **DROP** — breadth뿐 아니라 `HookReviewStore.hookBindingKey`가 normalized event+matcher+command SHA-256를 만들고 load 시 current binding key를 재검사한다. | optional hardening만: 현재 16-hex truncation 확대 + versioned migration. | 신규 trust ledger/hash path 금지. |
| A5 ExecPolicy TOML | existing declarative rule model의 중복 front-end다. 현재 `buildAutoModeOverlay`도 live `RulesStore.match` fence가 아니다. | **DROP.** external compatibility fixture와 실제 importer 수요가 생기면 별도 RFC로 재개한다. | parser/loader/event 추가 금지. live provenance fence 문제는 TOML과 분리해 existing RulesStore owner에서 처리. |
| A4 MCP hot-reload | **유일 real seam, M-L.** notification parser/router는 있으나 observer, existing registry, per-turn specs가 원자적으로 연결되지 않았다. | 새 registry 대신 existing `ToolRegistry`와 그 specs/origin/trust fingerprint를 묶는 immutable `TurnRegistrySnapshot` record. capability 확인 → full paginated relist/validate → existing connect-time bridge/collision assembly 재실행 → prior-snapshot replace. turn 시작 시 pin, 다음 boundary에서 publish. | 새 mutable registry/dispatcher/collision algorithm 금지. dispatch registry와 model-visible specs가 같은 generation이 아니면 publish 금지. |

MCP reload는 burst를 one-inflight+dirty-retry로 bounded coalesce하고, 새 tool에 origin `mcp`, trust annotation, admissibility를 재적용한다. 아래 D2 trust-hash 및 “two thin absorptions” 설계는 superseded candidate다.

### SOTA++ direction — immutable capability generations

- hot reload의 owner는 새 registry가 아니라 host/agent composition의 `TurnRegistrySnapshot { id, protocolVersion, registry: ToolRegistry, specs, trustFingerprint }`다. existing `ToolSurface` product axis와 이름/책임을 분리하며 concrete tools/origin은 `ToolRegistry`가 계속 소유한다.
- notification은 invalidate signal일 뿐 authority가 아니다. negotiated `listChanged` 확인 → 모든 pagination 수집 → schema/name/collision/trust 검증 → deterministic sort/hash → complete generation publish 순서다.
- 모델 광고와 dispatcher는 같은 generation pointer를 사용한다. turn 시작 시 pin하고 turn 종료 뒤 atomic pointer swap한다. 제거된 tool은 광고된 turn 동안만 이전 generation dispatcher로 실행 가능하다.
- concurrent notifications는 server별 single-flight + dirty bit로 coalesce한다. fixed one-retry-after-inflight 규칙이며 timer/backoff guess를 두지 않는다. reconnect/older generation 결과는 compare-and-publish에서 폐기하고 failure는 transactional abort로 prior snapshot을 유지한다.
- gate OFF는 observer 미생성뿐 아니라 generation id/spec/dispatcher/help text가 baseline과 같아야 한다. MCP protocol version과 conformance fixture를 ticket에 pin한다.
- ExecPolicy TOML은 existing declarative rules의 중복 front-end이므로 external compatibility 수요와 fixture가 생기기 전 **DROP**한다.
- **중복 금지:** ToolRegistry, bridge/collision logic, permission/admissibility, trust hash, reviewer router, rules engine을 재구현하지 않는다.

## 구현 액션리스트 (authoritative)

**SOLID 경계:** MCP client는 protocol capability/notification/list를, existing bridge는 tool conversion/collision/trust를, host composition은 generation rebuild/publish를, agent turn bootstrap은 immutable snapshot pin을 소유한다. `ToolRegistry`는 concrete dispatch authority로 남고 snapshot은 registry와 model-visible specs의 일관성 record일 뿐이다.

### Symbol-level reuse / delete / new ledger

| disposition | existing/new symbol | exact action | 금지되는 평행 구현 |
|---|---|---|---|
| **KEEP AUTHORITY** | `ToolRegistry` | tools/origin/specs/dispatch의 유일 concrete owner | hot-reload registry/subclass/mutable overlay |
| **REFACTOR/REUSE** | `loadMcpTools`, `loadMcpToolsOrEmpty`, runner tooling assembly | connect-time conversion/collision/trust pipeline을 pure reusable assembly로 추출 | reload 전용 converter/collision code |
| **REUSE** | `McpResourceObserver`의 `tools_list_changed` arm | negotiated invalidation signal만 전달 | 새 notification parser/event bus |
| **EXTEND STRUCTURALLY** | `McpStoppable` load result/direct+supervised handle | observer bind + full relist source capability 제공 | client-mode별 reload adapter/registry |
| **REPLACE READ** | `session-bootstrap`의 `cfg.registry.specs()` | `buildTurnSessionView`가 pin한 snapshot specs로 교체 | turn 중 global registry 재조회 |
| **NEW — ONE RECORD** | `TurnRegistrySnapshot` / `TurnRegistrySnapshotRef` | registry+specs+origin/trust generation identity | `ToolSurface` 대체 또는 tool storage |
| **NEW — ONE CONTROLLER** | host `mcp-tool-reload` controller | single-flight, dirty replay, compare-and-publish | timer debounce/backoff, partial publish |

**삭제/대체 완료 조건:** turn execution 경로에서 bootstrap 이후 `current registry`를 다시 읽는 call site가 0이어야 한다. connect와 reload가 서로 다른 tool name/collision/trust 결과를 만드는 duplicated assembly가 있으면 merge 불가다.

### RFC04-0 — turn registry snapshot pin (P0, M)

- **Depends:** 없음. reload 전에 반드시 landing.
- **Owner/write-set:** 신규 `src/agent/turn-registry-snapshot.ts`, `src/agent/loop/session-bootstrap.ts`, `src/agent/loop/turn-gate.ts`, `src/agent/turn-context.ts`, `src/agent/dispatch/`, snapshot parity tests.
- **Actions:**
  1. `TurnRegistrySnapshot {id,protocolVersion,registry,specs,trustFingerprint}`와 read-only `TurnRegistrySnapshotRef.current()`을 정의한다.
  2. turn 시작 `buildTurnSessionView`에서 pointer를 정확히 한 번 읽고 pinned registry와 그 registry에서 나온 specs를 같은 `TurnSession` config에 넣는다.
  3. 현재 `runTurn`의 pre-pin `config` destructuring을 제거해 admissibility/dispatch/help/schema 모든 consumer가 `turnSession.config`만 사용하게 한다.
- **RED:** generation A specs를 모델에 광고하면서 generation B registry로 dispatch되는 synthetic swap test.
- **GREEN/DoD:** 한 turn 내 generation 불변, model specs/origin/trust/dispatch 동일 id, gate OFF registry/spec/help deep-equal.
- **Stop:** dispatch consumer 하나라도 global/current registry를 turn 중 다시 읽으면 reload admission 금지.

### RFC04-1 — negotiated listChanged observer parity (P0, S-M)

- **Depends:** RFC04-0.
- **Owner/write-set:** `src/mcp/client.ts`, `src/mcp/client/inbound-router.ts`, `src/mcp/resources/notifications.ts`, `src/mcp/reconnect/port.ts`, `src/agent/mcp-bridge.ts`, MCP composition tests.
- **Actions:**
  1. server capabilities의 `tools.listChanged`를 typed predicate로 노출하고, advertised capability가 있는 server만 `tools_list_changed`를 invalidation signal로 전달한다.
  2. direct client와 reconnect supervisor가 동일 structural observer/relist handle을 노출하도록 existing `McpStoppable` load result를 좁게 evolve한다. observer는 no-throw signal만 보내고 async reload를 직접 실행하지 않는다.
  3. supervised path에서 observer parity를 제공할 수 없으면 해당 path hot-reload gate를 fail-closed 한다.
- **RED:** capability 미광고 notification이 reload, reconnect 후 stale connection notification이 publish, single/supervised 동작 불일치.
- **GREEN/DoD:** capability-gated signal, generation-tagged source, both client modes parity, baseline resources/prompts observer 회귀 없음.
- **Stop:** string-matching raw JSON이나 client별 별도 notification parser가 필요하면 중단한다.

### RFC04-2 — full-bundle reload controller (P0, M-L)

- **Depends:** RFC04-0/1.
- **Owner/write-set:** `src/host/mcp-composition.ts`, `src/runner/assemble/tooling.ts`, 신규 `src/host/runtime/mcp-tool-reload.ts`, `src/agent/mcp-bridge.ts`, reload controller tests.
- **Actions:**
  1. connect-time MCP assembly를 pure reusable function으로 추출해 all-page list, name disambiguation, origin, annotation/trust, admissibility, deterministic sort를 한 경로로 실행한다.
  2. server별 contribution을 patch하지 않고 현재 live sources 전체를 relist해 global collision result를 재계산한다.
  3. controller는 one-inflight+dirty-bit fixed replay만 사용한다. timer/debounce/backoff heuristic은 없다. 각 attempt는 source generation과 base snapshot id를 갖는다.
- **RED:** A tool이 B와 collision을 새로 만들 때 per-server patch가 잘못된 이름을 유지, multi-page B가 유실, burst가 unbounded relist하는 tests.
- **GREEN/DoD:** connect/reload identical assembly result, complete pagination, burst bounded, stale source generation discarded.
- **Stop:** 새 ToolRegistry subclass, mutable in-place registration, 두 번째 collision/trust algorithm이 생기면 중단한다.

### RFC04-3 — transactional next-turn publish (P0, M)

- **Depends:** RFC04-2.
- **Owner/write-set:** `src/host/runtime/mcp-tool-reload.ts`, runner/agent composition, `tests/integration/mcp-tool-hot-reload-hellgate.test.ts`.
- **Actions:**
  1. relist/convert/validate/hash가 전부 성공한 immutable snapshot만 compare-and-publish한다. malformed page, duplicate schema, trust/admissibility failure는 prior snapshot을 유지한다.
  2. mid-turn notification은 current turn을 바꾸지 않고 다음 turn bootstrap에서만 새 snapshot을 pin한다. 삭제된 tool도 광고된 turn의 old registry에서만 실행 가능하다.
  3. publish/abort/reload failure를 stable activity/diagnostic event로 surface하되 notification은 completion authority가 아니다.
- **RED:** mid-turn removal, malformed second page, reload failure, reconnect stale completion, specs/dispatcher mixed-generation integration fixtures.
- **GREEN/DoD:** LKG retention, atomic next-turn swap, current-turn dispatch continuity, origin/trust/admissibility preservation, gate OFF exact parity.
- **Stop:** partial publish 또는 failed reload 뒤 empty registry fallback이 가능하면 release 금지.

### RFC04-4 — DROP regression guard (P1, S)

- **Depends:** RFC04-0~3과 무관.
- **Owner/write-set:** feature catalog YAML/architecture test만; production parser/router 추가 없음.
- **Actions:** A3/A4.2/A5가 existing reviewer ladder, `HookReviewStore.hookBindingKey`, `RulesStore`의 owner임을 evidence로 고정하고 신규 guardian/TOML/trust-ledger entry를 feature catalog에 추가하지 못하게 review checklist를 둔다.
- **GREEN/DoD:** DROP 항목은 구현 LoC 0; optional hook hash truncation 확대가 필요하면 독립 migration ticket.
- **Stop:** 외부 compatibility fixture와 실제 importer consumer가 생기기 전 A5를 재개하지 않는다.

### Landing rail

1. `bun test tests/unit/agent/loop/turn-gate.test.ts tests/unit/session-bootstrap-toolsearch-hellgate.test.ts tests/integration/plan-mode-x-tool-registry-cross.test.ts`.
2. `bun test tests/integration/mcp-client.test.ts tests/integration/mcp-bridge.test.ts tests/unit/mcp/tool-name-collision-hellgate.test.ts tests/unit/mcp-tool-annotations-wire.test.ts`.
3. 신규 hot-reload hellgate는 capability 미광고, pagination, burst, malformed page LKG, reconnect stale generation, current-turn removal을 한 fake-server suite에서 각각 RED-on-injection으로 증명한다.
4. `bun run typecheck`와 `bun test tests/unit/god-code-ratchet.test.ts`.

새 static scan을 추가한다면 bare `registry` identifier가 아니라 post-pin live call pattern을 검사하고 anti-vacuum floor와 red-on-injection을 함께 둔다.

## Archived pre-correction draft (non-authoritative)

아래 내용은 최초 gap 가설과 adversarial audit 이력을 보존하기 위한 것이다. 구현 ticket/DoD/노력치는 위 current-HEAD correction과 README만 사용한다. README의 중복/휴리스틱 삭제 register와 충돌하는 archive 항목은 구현 후보로 복구하지 않는다.

### Original motivation

Codex 5973 ships four approval/policy surfaces the corpus audit flagged as gaps: a 3-way approval reviewer router, a declarative exec-policy prefix engine with per-session amend memory, a broader lifecycle-hook event set with `trusted_hash` gating, and MCP `listChanged` hot-reload. This RFC grounds each against quanta `src/` FIRST — and the load-bearing finding is that **three of the four are already built** in quanta (jul-18 "backlog = graveyard" pattern). The RFC exists to (a) refute the false gaps with `file:line` so we don't re-plan shipped code, and (b) scope the two genuinely-missing seams precisely.

## Non-goals

- Re-planning the existing hook engine, reviewer 3-tier, prefix-rule DSL, or session-grant ledger. Only EXTENSIONS are in scope.
- Network MITM hooks (Codex host/methods/path_prefixes inject/strip) — out of scope; quanta has no proxy layer to host them. Deferred, separate RFC.
- MCP resource/prompt `list_changed` re-fetch (only `tools_list_changed` re-registration is in scope; resources/prompts have no registered agent surface to swap).
- Changing HARD_DENY corpus or the OS-sandbox backends.
- Efficacy A/B (measure-first; every item lands default-OFF, byte-identical when OFF).

---

## Current state (grounded, `file:line`)

### A3 — Guardian reviewer router — **ALREADY BUILT** (refuted gap)
- `src/permission/types.ts:131` — `ReviewerTier = "user" | "auto_review" | "guardian_subagent"` (the exact Codex `approvals_reviewer` enum).
- `src/permission/reviewer.ts:247-260` `dispatchFresh` — routes to `userReview` / `autoReview` / `guardianReview`, plus the richer `guardianAssess` under `runtimeConfig().guardianAssessor` (ADR-0497). `reviewAction` (`:269`) is the entry; fail-CLOSED on a throwing/invalid port (`:300-316` re-throws after closing the lifecycle surface).
- `src/permission/reviewer-default-policy.ts:76` `selectDefaultReviewer` — picks the tier from per-thread authority + `autoReviewEnabled` opt-in + sandbox posture; final fallback is `"user"` (`:108`, fail-closed).
- `src/permission/assessment-collapse.ts` — single boundary reducing `ActionAssessment → ApprovalDecision`.
- Wired: `src/apps/cli/repl/reviewer-policy.ts`, `src/host/bootstrap/types.ts` (guardianReview / guardianAssess port slots), `src/agent/types/wire-slots-core.ts` (`reviewerPort`).
- **Delta = ZERO new routing.** The only genuine remaining work is UX legibility of an auto/guardian approval (partly done: `auto-approval-review-observer.ts` + the `emitOperatorNotice` guardian-approve fallback at `reviewer.ts:339`). Nothing to absorb here — the RFC's A3 recommendation is **DROP** (already SOTA++).

### A5 — ExecPolicy prefix-rule + session amend — **MOSTLY BUILT** (partial gap)
- Prefix-rule DSL EXISTS: `src/rules/types.ts:30` `RuleAction = allow|deny|ask`, `:56` `argv?` = Codex `prefix_rule(pattern=[...])` token-prefix parity, `:35` 3-layer `system|user|project` precedence. `src/rules/store.ts` is the 3-layer store.
- Untrusted-source fence EXISTS: `src/permission/circumvention.ts:521` `buildAutoModeOverlay` — a `project`(repo)-layer rule may ONLY tighten (`soft_deny`); an untrusted `allow` or `hard_deny` is DROPPED/demoted (`:495-503`). This is the MODE_REPO_RULES_POLICY (jul-12) fence applied to rules.
- Session amend ledger EXISTS: `src/permission/session-grant-prefix.ts` — `derivePrefixGrantKey` (`:77`) + `actionMatchesPrefixGrant` (`:99`), keyed `tool|<firstToken>`, with shell-metachar smuggling guard (`:43`). `src/permission/types.ts:159` `user_approved_for_session` outcome. `remember-patterns.ts` = grant cascade.
- HARD_DENY corpus: `src/permission/policy-rules.ts` (~30 rules) + `normalizeShellForDeny` (`:329`) checked BEFORE reviewer (canonical gate step 4).
- **Delta = a declarative TOML front-end** carrying Codex's `justification` field, parsing into the EXISTING `Rule`/layer model, and a NAMED amend event (`ExecPolicyAmendmentApprovedForSession`) that today is the anonymous `user_approved_for_session` prefix-grant. The engine, fence, and ledger are all present. Absorb is **thin** (parser + one typed event), NOT a new policy engine.

### A4.2 — Hook events + trust-hash — **EVENTS BUILT, HASH MISSING** (partial gap)
- All 11 events dispatched: `src/agent/hooks/event-types.ts:11-117` — `session_start`, `session_end`, `pre_tool_use`, `post_tool_use`, `post_tool_use_failure`, `pre_compact`, `post_compact`, `subagent_start`, `subagent_stop`, `permission_request`, `user_prompt_submit`, `turn_start`.
- Real emit sites (grounded): `src/agent/loop/session-lifecycle.ts` (session_start/end), `src/agent/loop/turn-iteration.ts` (turn_start), `src/agent/loop-helpers.ts` (post_compact), `src/agent/subagent-runner.ts:435,464` (subagent_start/stop).
- Command-hook mapper ALREADY covers the full Codex 10-event set: `src/agent/command-hooks/gate.ts:132-191` `mapClaudeEvent` (T04/UC4 — "zero-unwired").
- Trust gate TODAY is **provenance + approval-ledger**, NOT content-hash: `src/agent/command-hooks/types.ts:46-64` `CommandHookSource`/`sourceNeedsReview`; runner holds `needsReview` bindings fail-closed (`runner.ts:84-108`); on-disk `HookReviewStore` keyed by `event:command` (`command-hooks-wire.ts:84-89`).
- **Delta = trusted_hash.** The current ledger approves a binding by identity (`event:command`); it does NOT pin the binding CONTENT to a hash, so a re-imported binding whose command bytes changed under the same event still reads "approved". Codex's `trusted_hash` closes exactly this — approval is bound to a content digest; a content change re-arms review. Event breadth = **DROP** (built); trust-hash = **thin, genuine**.

### A4 — MCP hot-reload — **NOTIFICATION PARSED, RE-LIST UNWIRED** (genuine gap)
- Negotiator is connect-time only: `src/mcp/capabilities/full-negotiator.ts:52` advertises `tasks.listChanged:false`; no reload path.
- Inbound `tools_list_changed` IS parsed + routed: `src/mcp/resources/notifications.ts:25,36,76` (`TOOLS_LIST_CHANGED_METHOD`), routed via `routeResourceNotification` (`:83`) → `src/mcp/client/inbound-router.ts` → `src/mcp/client.ts` `resourceObserver`.
- BUT: grep confirms **no consumer re-lists tools or swaps the registered surface** on `tools_list_changed` (`resourceObserver` is never constructed with a real impl outside tests; the notifications.ts:24 "so a host can re-`tools/list`" is an unwired forward seam).
- **Delta = the observer + re-list + registry swap**, i.e. the actual hot-reload behavior. The transport plumbing is done; the reload actuator is missing. This is the ONE item with real substrate work.

### Ownership fence (jul-27) — the child≤parent invariant we must respect
- `src/agent/ownership-policy.ts:394` `narrowChildOwnership(parent, child)` — when `parent.enforced`, a child's `owned` is intersected to `insideOrEqual` a parent surface; `forbidden` is UNIONED (child can only add). A guardian/reviewer subagent spawned for A3, or any hook-spawned child, MUST route through this fence — it cannot broaden the write universe.

---

## Design

Given the grounding, the RFC ships **two thin absorptions** (A5-TOML, A4.2-hash) + **one real seam** (A4-reload), and **DROPS A3** and hook-event-breadth as already-built.

### D1 — A5: declarative ExecPolicy TOML front-end (thin)
- New leaf `src/rules/exec-policy-toml.ts`: parse `[[rule]] pattern="..." decision="allow|deny|ask" justification="..."` into the EXISTING `Rule[]` (`argv` populated for bracketed token arrays; `justification` carried as a new optional `Rule.justification?` used ONLY in diagnostics/audit, never in matching). Layer is stamped by the LOADER (system/user/project), NEVER read from the TOML body (a repo TOML is always `project` layer → the `buildAutoModeOverlay` fence at `circumvention.ts:495` already demotes its `allow`/`hard_deny`).
- Named amend event: rename the anonymous session-grant to a typed `ExecPolicyAmendmentApprovedForSession { prefixKey, justification?, decidedAt }` emitted from the existing `session-grant-prefix` mint site (recorder seam only — no behavior change). This is observability, not a new grant path.
- Reuse: `derivePrefixGrantKey` for the amend key; the shell-metachar smuggling guard is inherited unchanged.

### D2 — A4.2: trusted_hash gating on the hook review ledger (thin)
- Extend `CommandHookReviewPort.isApproved` to compare a `trustedHash` = digest of the NORMALIZED binding content (`event` + `command` + `matcher`) against the ledger's stored hash for that binding identity. Approval now binds `identity → contentHash`; a content change (same event, different command bytes) ⇒ no hash match ⇒ HELD (re-review). Fail-closed default (absent/mismatched hash ⇒ not approved) is the SAME posture the store already has (`command-hooks-wire.ts:88`).
- The hash is computed by TRUSTED code at load time (never read in a loosening direction from disk), mirroring the provenance-stamp discipline at `types.ts:39-45`.
- Default-OFF: gated behind the EXISTING `QUANTA_HOOK_TRUST_GATE` (`command-hooks-wire.ts:52`). When that gate is OFF, the hash is never computed and the path is byte-identical.

### D3 — A4: MCP tools hot-reload actuator (real seam)
- New `McpToolsReloadObserver implements McpResourceObserver` in `src/mcp/` that, on `tools_list_changed`, (a) re-issues `tools/list` to the affected client, (b) re-runs the capability gate (`src/mcp/client/capabilities-gate.ts`), (c) atomically swaps the registered tool surface for THAT server namespace only.
- Race-safe swap: a monotonic generation counter per server; a re-list result older than the current generation is discarded (last-writer-wins by generation, not by arrival). Concurrent tool CALLS in flight resolve against the generation they started under; the swap is a pointer replace, not an in-place mutation.
- Trust: newly-appeared tools from a hot-reload inherit the SAME per-server trust posture as connect-time tools (no auto-elevation). A tool that appears via reload is NOT auto-approved — it enters the normal permission gate.
- Default-OFF: gated behind a new `QUANTA_MCP_HOT_RELOAD` env gate; when unset the observer is never constructed (`resourceObserver` stays `undefined`) and the client path is byte-identical to today.

---

## Security model (fail-CLOSED)

| Surface | Fail-closed rule | Enforced at |
|---|---|---|
| A5 TOML `allow`/`hard_deny` from a repo | DROPPED / demoted to soft_deny — repo cannot loosen | `circumvention.ts:495-503` (reused) |
| A5 amend prefix grant | only SIMPLE commands (no shell metachar) derive a key; complex ⇒ re-prompt | `session-grant-prefix.ts:43,77` (reused) |
| A4.2 trust-hash | content-hash mismatch ⇒ HELD (not approved); absent ledger ⇒ not approved | D2 + existing `runner.ts:94` deny-on-doubt |
| A4.2 hook allow | can only TIGHTEN; HARD_DENY evaluated FIRST (a hook `allow` never routes around denylist) | `event-types.ts:85-91` (existing floor) |
| A4 reload new tools | inherit per-server trust; enter normal permission gate; NO auto-approve | D3 |
| Any spawned child (guardian/hook) | `owned` ⊆ parent; `forbidden` unioned | `ownership-policy.ts:394` (reused) |
| Reviewer port throws | re-throws → gate deny path; NEVER silent allow | `reviewer.ts:300-316` (existing) |

## Default-OFF gate

- A5-TOML: only parsed when a policy TOML file is present under a trusted config dir; repo-supplied TOML is `project` layer (fenced). No file ⇒ byte-identical.
- A4.2-hash: `QUANTA_HOOK_TRUST_GATE` (existing) — OFF ⇒ hash never computed.
- A4-reload: new `QUANTA_MCP_HOT_RELOAD` — OFF ⇒ observer never constructed.
- A3: nothing to gate (already shipped behind `QUANTA_APPROVAL_LADDER` / `QUANTA_AUTO_REVIEW` / `guardianAssessor`).

## TDD + hellgate

1. **RED e2e first** per item: (A5) a repo TOML with `decision="allow"` for `rm -rf /X` must NOT loosen — assert the command still HARD_DENYs and the overlay drops the allow (red-on-injection: flip the fence to trusting → test goes red). (A4.2) approve a hook, mutate its command bytes on disk, assert HELD (red-on-injection: skip hash → approved-stale). (A4) drive a fake MCP server that emits `tools_list_changed` adding a tool, assert the registered surface gains it AND the new tool routes through the permission gate (red-on-injection: auto-approve → test red).
2. **Leaf-crate units** (punch-card, no full build): `exec-policy-toml.test.ts`, hash-in-ledger test, reload-generation-race test. Each asserts unconditionally then narrows (test-quality culture: no vacuous single-literal).
3. **OFF byte-identical** guard per item: gate OFF ⇒ zero new events / zero re-list / zero hash compute (assert emit-count == 0 with a capturing sink, per jul-13 OTel pattern).
4. **3R adversarial** (below) + self-audit.

## Effort

- A3: **0** (drop — already built; the audit's job was to prove this).
- A5-TOML: ~S (parser leaf + one typed event + fence-reuse tests). ~1 focused session.
- A4.2-hash: ~S (ledger digest field + review-port compare + red-on-injection). ~1 session.
- A4-reload: ~M (observer + re-list + generation-safe registry swap + fake-server e2e). The only substrate item. ~1–2 sessions.

## Risks + traps

- **Graveyard trap (jul-18)**: three "gaps" are already built. Risk = re-implementing them. Mitigated by the `file:line` refutations above — DROP A3 + hook-events explicitly.
- **Vacuous test trap**: an A4 reload test with a fake server that always returns the same tool list proves nothing. The test MUST observe the surface CHANGE (tool count delta) and the new tool hitting the gate.
- **TOCTOU (A4.2)**: hash computed at load, checked at fire — if the file changes between, the fire uses the loaded (in-memory) binding, whose hash matches its own content. The threat is a STALE approval for CHANGED content across sessions; the ledger stores the hash of the content that was approved, so a new session with new content re-reviews. Same-session in-memory content is self-consistent (no intra-session TOCTOU window because the binding is loaded once).
- **Reload race (A4)**: two `tools_list_changed` in flight → stale re-list overwrites fresh. Mitigated by generation counter (discard older gen).
- **god-code**: `notifications.ts` and `reviewer.ts` are near their SRP ceiling; new logic goes in NEW leaves (`exec-policy-toml.ts`, `mcp-tools-reload.ts`), never bloating existing modules past the 1000-line ratchet.
- **Masking artifact note**: the corpus grep display filter masks `review`/`emit`/`amend` tokens as `_n`/`ln` in tool output — the `file:line` citations were read directly, not from masked grep.

## Sequencing

1. A4.2-hash (smallest, self-contained, extends a live gate).
2. A5-TOML (reuses the fence + ledger; independent of A4).
3. A4-reload (the real seam; do last, most substrate).
- A3: no work; note the refutation in the absorption ledger so it's not re-opened.
- File-disjoint → the three CAN parallelize in worktrees (jul-28 pattern), but the ROI is low; serial is fine.

## Open questions

- A5: does `Rule.justification` belong on the `Rule` type or a side-map? Side-map keeps the matcher leaf pure (no new field flowing into determinism). Lean side-map.
- A4: on reload that REMOVES a tool mid-turn while a call to it is in flight — resolve against the starting generation (call completes) then drop it. Confirm no dangling registration. Needs an e2e.
- A4.2: hash algorithm — a stable non-crypto digest (FNV) is enough (integrity vs. a local operator's own imported file, not adversarial collision); but a repo-shipped hook IS attacker-influenced. Use SHA-256 to be safe (cheap, one-shot at load).

---

## Audit log R1 → R3 (adversarial — break it)

### Round 1 — three lenses (security / dead-seam / vacuity)

- **[R1-SEC-1] A4 reload auto-elevation.** First draft let a hot-reloaded tool "inherit connect-time registration" — read literally, that could mean it skips the permission gate a freshly-connected tool also skips under `bypass`. **Verdict: real hole.** A reload is an ATTACKER-TRIGGERABLE moment (a malicious server emits `tools_list_changed` after the human approved the initial toolset, then swaps in a `shell`-shaped tool). **Fix (D3):** newly-appeared tools enter the NORMAL permission gate; NO auto-approve; explicit in the Security model table.
- **[R1-DEAD-1] A4 observer never reached.** The `tools_list_changed` event is parsed and routed, but if the observer is only constructed under a gate that's never wired at the composition root, the whole D3 is a dead seam (jul-15 pattern: circumvention-escalate that never reached the gate). **Verdict: latent.** **Fix:** the RED e2e (TDD step 1) must drive a REAL fake MCP server through the transport and assert the registered surface changes — proving the observer is reached end-to-end, not unit-mocked at the observer boundary.
- **[R1-VAC-1] A4.2 hash test tautology.** A hash test that computes the hash the same way in the assertion as in production proves nothing (compares f(x) to f(x)). **Verdict: real risk.** **Fix:** the red-on-injection variant mutates the on-DISK command bytes and asserts HELD via the PUBLIC `isApproved` result — not by recomputing the digest in the test.
- **[R1-DROP-check] A3 really built?** Adversarially: is `guardian_subagent` actually REACHABLE, or is it a defined-but-never-selected tier? `selectDefaultReviewer` (`reviewer-default-policy.ts:97,102`) DOES route to it under `autoReviewEnabled + hasGuardianReview` and under `default` mode + workspace-write. **Verdict: genuinely reachable → DROP stands.**

### Round 2 — re-break R1's fixes + new surfaces

- **[R2-SEC-1] A5 TOML layer spoofing.** Can a repo TOML declare its own layer to claim `user` (trusted) and thus land an `allow`? **Verdict: blocked by design** — D1 stamps layer at the LOADER by file provenance; the TOML BODY has no layer field read. This mirrors the hook `source` discipline (`types.ts:39-45`, "the disk parser strips the key and the merge re-stamps it authoritatively"). Added an explicit non-negotiable: TOML body layer field is IGNORED if present.
- **[R2-SEC-2] A4.2 hash covers command only?** If the hash digests ONLY `command`, an attacker who re-points a `matcher` (e.g. widens `Edit` → `*`) under an approved command keeps the stale approval and now fires on more tools. **Verdict: real gap in R1 draft.** **Fix (D2):** digest the NORMALIZED tuple `event + command + matcher` — any of the three changing re-arms review.
- **[R2-DEAD-1] A5 amend event consumer.** The `ExecPolicyAmendmentApprovedForSession` event — does anything consume it, or is it emit-into-void? **Verdict:** it's observability-only by design (recorder seam), which is FINE as long as it's labeled as such and not claimed to drive behavior. Clarified in D1: "recorder seam only — no behavior change." Not a dead seam because its contract IS to be an audit record; a dead seam is one that CLAIMS behavior it doesn't deliver.
- **[R2-RACE-1] A4 generation counter off-by-one.** If generation is bumped AFTER the swap instead of before the re-list, two concurrent reloads can both read gen=N, both re-list, both swap — last arrival wins regardless of freshness. **Verdict: real.** **Fix:** bump generation BEFORE issuing `tools/list`; a result tagged with a gen < current is discarded. Documented in D3 + Risks.

### Round 3 — deepest: fail-open under error, ownership, TOCTOU

- **[R3-SEC-1] A4 reload error → fail-open.** If the re-`tools/list` THROWS (server returns garbage mid-reload), does the surface end up EMPTY (denies legit tools — annoying but safe) or does it RETAIN the old surface (safe) or CLEAR then fail (fail-open to no-gate)? **Verdict: must specify.** **Fix:** on re-list error, RETAIN the prior generation's surface (never clear-then-populate); the swap is atomic pointer-replace ONLY on a fully-validated new list. Fail-closed = keep the last-known-good, never a half-populated registry. Added to D3.
- **[R3-SEC-2] A4.2 ledger read fail-open.** `HookReviewStore.load` on a corrupt ledger — the existing code (`command-hooks-wire.ts:88`) is fail-closed (unreadable ⇒ nothing approved). The hash extension MUST preserve this: a ledger entry present but with a MISSING hash field (old format) ⇒ treat as NOT approved (re-review), NOT as "approved, hash-check skipped." **Verdict: migration trap.** **Fix:** absent-hash ledger entry = not approved under the trust gate; the operator re-approves once (binds the hash). Documented in Security model.
- **[R3-OWN-1] Guardian/hook child broadening.** A guardian subagent (A3) or a hook that spawns a child — can it write outside the parent's owned set? **Verdict: must route `narrowChildOwnership`.** A3 is already-built and already routes through the dispatch ownership gate; the RFC's new spawns (none, actually — A5/A4.2/A4 spawn nothing) don't add a spawn surface. Confirmed: this RFC introduces NO new subagent spawn, so the fence is respected by not adding a bypass. Noted in Current-state + Security table for completeness.
- **[R3-TOCTOU-1] A4.2 cross-session.** Re-examined: the only TOCTOU is load-time-vs-fire-time WITHIN a session, but the binding is loaded ONCE and its in-memory content is what's hashed AND fired — self-consistent, no window. The cross-session case (approve content A, later import content B under same identity) is EXACTLY what the hash closes. **Verdict: no residual TOCTOU.** Documented in Risks.
- **[R3-VAC-2] OFF-byte-identical vacuity.** An "OFF = byte-identical" test that only checks a boolean flag is vacuous. **Fix:** assert via a CAPTURING sink that emit-count / re-list-count / hash-compute-count == 0 when the gate is OFF (jul-13 OTel capturing-exporter pattern), not that a config field is false.

**Convergence:** R3 produced no NEW class of finding beyond R2's (error-path fail-open + migration + vacuity are refinements of the fail-closed and vacuity lenses already open). Audit converged at R3. All findings routed into Design/Security/Risks above. The dominant conclusion mirrors jul-18: **the biggest "gap" was a measurement gap — A3 and hook-event-breadth are already built; the real work is two thin extensions + one MCP reload actuator.**
