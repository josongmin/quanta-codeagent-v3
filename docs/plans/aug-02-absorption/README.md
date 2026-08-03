# Aug-02 Codex/Claude-Code 흡수 — current-HEAD 실행 SSOT

원천 감사: [../../analysis/aug-02-competitor-corpus-refresh-audit.md](../../analysis/aug-02-competitor-corpus-refresh-audit.md).

**Code-audit basis:** `main@0a00ced392102073fe35eccd202bca92cabd71dc`, 2026-08-03 KST. 최초 RFC-01~08 문서군은 `main@0922d737f431ace0d6f2d6505c40351976718981`에 게시됐다. 구현은 아직 시작하지 않았다. 아래 판정이 각 RFC의 과거 초안 문구와 충돌하면 **이 README와 각 문서의 current-HEAD correction이 우선**한다.

## 결론

초기 요약의 큰 방향(대부분 substrate가 있고 실제 delta는 작다)은 맞지만, owner와 안전계약을 재감사하자 RFC-01~08과 detail-only residue 회계가 모두 보정됐다.

| RFC | current-HEAD 판정 | 실제 delta | 노력/상태 |
|---|---|---|---|
| [01 Persistence & Resume](rfc-01-persistence-resume.md) | JSONL store는 wire replay/seq rail이지 semantic state SSOT가 아님. CLI resume은 이미 `@/session` snapshot authority를 사용. 새 checkpoint/physical log truncate는 금지. | existing `SavedSession` schema/loader 확장 · durable `message/turn→ShadowOdb SHA` mapping · rollback intent/effect/receipt coordinator · context-headroom advisory | A7 S/READY · A2 M-L/DESIGN FIRST · A1 M-L/NOT READY |
| [02 Observability](rfc-02-observability.md) | B1은 일반 process manager가 아니라 process-wide **background-shell** registry. B6는 spine만 있고 live caller 미결정. A8은 3개 caller에 걸친 route observation. | `/ps` read-only부터 · 기존 evidence/event projection · live phase source 선정 · caller-owned route transition | B1 list S/READY · A8/C2 M · B6 NOT READY |
| [03 Self-improve & Onboarding](rfc-03-self-improve-onboarding.md) | writer/import substrate는 맞음. 하지만 path-exists evidence, live-dir imported skill, standalone skill_search는 각각 vacuous evidence/RCE/duplicate catalogue 위험. | hash-bound evidence anchors + staged artifact/CAS · staged import/promote · authoritative MEMORY source mapping · existing `ToolSearch` skill-catalog mode + A/B | ToolSearch mode S-M · Import M-L · ProposeSkills M-L |
| [04 Approval & Policy](rfc-04-approval-policy.md) | guardian, hook breadth, ExecPolicy core뿐 아니라 **trust-hash도 이미 구현**. SHA-256(event+matcher+command) + load-time recompute 존재. | real seam은 existing `ToolRegistry`를 감싸는 turn-pinned MCP tool snapshot. TOML은 중복 front-end라 external fixture 전 DROP. | MCP M-L · 나머지 DROP |
| [05 Providers & Transport](rfc-05-providers-transport.md) | D1 owner는 Anthropic multicloud axis가 아니라 OpenAI `createLLM` axis. JSON central config와 두 OpenAI wire surface를 실제로 넓혀야 함. | provenance/schema/merge · Chat+Responses endpoint options · configured-endpoint selector · local no-auth/preset smoke · public Responses WebSocket track | D1 M-L · D2 S-M · A6 L/SEPARATE MEASURED TRACK |
| [06 Worktree & Review UX](rfc-06-worktree-review-ux.md) | user-facing `session fork --worktree`와 CLI/web/SDK hunk apply가 이미 있음. 새 in-memory binding/reaper와 naive inverse revert는 잘못된 owner/unsafe. | current-thread 전환 + persisted ownership/lifecycle · explicit operator GC · anchored comments + CAS undo journal · live objective usage producer · mention composition/lineage | B3 L(full) · B5 M-L · A4.3 M · B4 M-L |
| [07 Claude 오케스트레이션](rfc-07-claude-orchestration.md) | **Workflow 엔진 이미 있음**(`src/workflow/index.ts` agent/parallel/pipeline/phase/fanout export, gated `QUANTA_WORKFLOW`). Task-DAG·mailbox `to:id`·fork·named-registry·lineage gate·codemode-REPL 다 LIVE. dontAsk=`acceptEdits`/`auto`가 이미 사이 티어. | 얇은 delta 3: existing `TaskRegistry`/target policy를 재사용하는 named-`to:` resolver · `BashBgRegistry` drain observer 기반 line-stream watch(measure-first) · `assignee/dependencies`의 owner/blockedBy/blocks read projection. 나머지 DROP | D1-resolver S/READY · D2-watch MED/NOT READY · D3-projection S/READY |
| [08 UX polish & deferred](rfc-08-ux-polish-deferred.md) | keybindings·Ultra=`ReasoningEffort:"max"`·codemode per-cell cap·MCP version SSOT·OS-keyring은 이미 있음. palette/shortcut-editor 등 renderer는 이 repo 밖이다. | **BUILD 1개**: 기존 `EffortStore`를 직접 쓰는 bindable `effort-cycle` action. PARK 7 · DROP 8. 새 cycle store/default chord 금지. | BUILD-1 S · 나머지 PARK/DROP |
| [09 Residual gaps](rfc-09-residual-gaps.md) | coverage critic의 detail-only residue를 live code로 재검증. LSP callable/MCP surface와 `fork_turns`+delegation policy는 이미 live. in-process hook append도 live. | command-hook stdout→existing untrusted prompt-hook bridge · review finding의 model-visible verdict/category/short summary. owner 없는 outcome/last-turn scope는 PARK. | A2 S/READY · A4 S/READY · 나머지 DROP/PARK |
| [10 Second-order sweep](rfc-10-second-order-sweep.md) | **DRY 선언(defended).** raw corpus(bin strings·366 protocol types·387 SDK 필드·i18n)서 audit에 안 잡힌 ~34 blind-spot 토큰 채굴 → 100% already-built(shell_snapshot·async-tool ADR-0287·NotebookeEdit·memory_tool·review three-dot 등) 또는 non-absorbable(117+ GUI client-RPC/sandbox/connector). | **신규 gap 0.** `dangerouslyDisableSandbox`는 quanta의 의도적 안전 divergence(Open-Q, 흡수 아님). | BUILD 0 |

## 커버리지 회계 (정직한 정정)

**수렴(loop-until-dry):** 4차 sweep 모두 완료 — (1) lettered audit→RFC-01~08, (2) coverage-gap→RFC-07/08, (3) coverage-critic→RFC-09, (4) raw-corpus 2nd-order→RFC-10=**DRY**. 각 sweep이 "gap"의 ~75%를 already-built로 붕괴시켰고, 마지막 raw-corpus sweep은 100% 붕괴 → **더 팔 게 없다.** wrong-DROP 누적 0(전 스팟체크 실재 확인).


감사문서의 lettered 후보(A1–A10·B1–B8·C1–C7·D1–D3 + Workflow/REPL)는 RFC-01~08, detail 파일에만 있던 residue는 RFC-09에서 모두 `BUILD`/`MEASURE`/`PARK`/`DROP`으로 disposition했다. 이는 **100% 구현 약속이 아니라 100% 회계**다. `_coverage-critic.md`는 누락을 찾은 adversarial input이며, live-code 반증과 최종 scope는 RFC-09가 우선한다. grounding-first 결과 RFC-07 Workflow와 RFC-09의 LSP 도구/`fork_turns`도 shipped였고, 신규 BUILD은 owner와 소비자가 확인된 얇은 delta만 남는다.

## RFC-01~09 current owner surfaces와 다음 RED

| RFC | owner surfaces | implementation admission RED |
|---|---|---|
| 01 | `src/session/types.ts`, `src/session/store.ts`, `src/session/rewind.ts`, `src/agent/per-tool-checkpoint/three-way-restore.ts`, `src/sdk/runtime/session.ts` | intent/effect/receipt crash matrix; unrelated dirty preservation; full transcript/tool/approval/artifact/revision snapshot roundtrip 전 A1 금지 |
| 02 | `src/runtime/bash-bg-registry.ts`, `src/tool/types.ts`, `src/tool/bash/`, `src/activity/producers/`, `src/apps/cli/retry-with.ts`, `src/llm/fallback.ts` | explicit owner/cross-owner kill refusal; `/ps` redaction/ambiguity; single evidence fan-out; initial request + route-transition ordering |
| 03 | `src/skill/registry.ts`, `src/agent/tier1/skill.ts`, `src/skill/tool-search.ts`, `src/skill/skill-creator.ts`, `src/migration/external-config/` | all surfaces same registry winner; evidence/hash/preimage drift; deny/modify no-live-write; staged import; measured catalog suppression |
| 04 | `src/mcp/resources/notifications.ts`, `src/mcp/client.ts`, `src/agent/mcp-bridge.ts`, `src/runner/assemble/tooling.ts`, `src/agent/loop/turn-gate.ts` | model specs=dispatch generation; capability-gated fake server A→A+B; malformed pagination LKG; burst coalescing; direct/supervised parity |
| 05 | `src/llm/factory.ts`, central config schema/merge, `src/llm/adapters/openai.ts`, `src/llm/adapters/openai-responses.ts`, `src/shared/net/ssrf.ts` | Chat+Responses option parity and gate-OFF constructor parity; canonical SSRF/redirect/env-secret denial; live Ollama/LM Studio streaming tool-call smoke |
| 06 | `src/session/types.ts`, `src/runtime/worktree-fork.ts`, `src/runner/session-ops/index.ts`, `src/runner/hunk-apply.ts`, objective/mention composition | restart-preserved explicit ownership; current forced/string-heuristic remove RED; dirty/unowned no-delete; disk-drift CAS undo; live 429/usage; mention list/lookup parity |
| 07 | `TaskRegistry` + spawn-owner ledger + `subagent-delivery/target-resolver.ts`; `Plan`/`assignee`/`dependencies`; `BashBgRegistry` drain + reactor bridge | named unique/ambiguous/foreign-lineage delivery; owner/blockedBy/blocks deterministic projection; D2는 measured consumer 전 NOT READY |
| 08 | `EffortStore`; slash model wire `current/effortSupport`; keybinding loader/`KEY_ACTIONS`; raw-line-reader dispatch | configured chord → same effort cell → next LLM request; live model switch support; non-reasoning fixpoint; unconfigured callback count 0 |
| 09 | `src/agent/command-hooks/{runner,types,install}.ts`; existing `HookPromptInject` fold; `src/tool/git/review-diff.ts` | command stdout append stays user-side/untrusted and approval-gated; old hook/review shapes byte-identical; verdict/category visible through real parser+renderer |

### 구현 packet dependency map

| RFC | 실행 packet | 핵심 dependency / 병렬성 |
|---|---|---|
| 01 | `RFC01-0` durable records → `RFC01-2` mapping → `RFC01-3` rollback; `RFC01-1` headroom 독립; `RFC01-4` rehydrate conditional | A1은 full-fidelity RED 전 시작 금지 |
| 02 | `RFC02-0` ownership → `RFC02-1` `/ps` → `RFC02-2` kill; `RFC02-3` reroute 독립; `RFC02-4` evidence; `RFC02-5` phase conditional | phase는 RFC06-2 front door 선택 시 그 뒤 |
| 03 | `RFC03-0` canonical registry → `RFC03-1` search, `RFC03-2` proposal → `RFC03-3` promote → `RFC03-4` import; `RFC03-5` measure last | registry cutover 전 search/mentions/import 활성화 금지 |
| 04 | `RFC04-0` turn pin → `RFC04-1` observer → `RFC04-2` rebuild → `RFC04-3` publish; `RFC04-4` DROP guard 독립 | reload보다 snapshot pin이 먼저 |
| 05 | `RFC05-0` schema → `RFC05-1` network policy → `RFC05-2` adapter parity → `RFC05-3` local smoke; `RFC05-4` WS 별도 | WS는 D1/D2 DoD가 아님 |
| 06 | `RFC06-0` ownership → `RFC06-1` git hardening → `RFC06-2` transition / `RFC06-3` GC; `RFC06-4` receipt; `RFC06-5` objective; `RFC06-6` mentions | `RFC06-6`은 RFC03-0, activity는 RFC02 contract 의존 |
| 07 | `RFC07-3` task projection + `RFC07-1` named resolver는 독립; `RFC07-2M` measurement → conditional `RFC07-2B` | D1은 existing target/lineage authority 재사용; D2는 consumer/latency admission 없으면 PARK, build는 RFC02 bg-owner 뒤 |
| 08 | `RFC08-1` bindable effort action 단일 packet | RFC07과 독립; existing `EffortStore`/model wire/keybinding path 외 authority 생성 금지 |
| 09 | `RFC09-1` command-hook append bridge · `RFC09-2` review finding consumed fields | 서로 file-disjoint; existing prompt-hook/reviewer parser를 확장하며 새 inject/review/scope authority 금지 |

### RFC-07/08 immediate structural action list

세부 계약과 명령은 각 RFC의 `Structural action packet(s)`가 authority다. 아래 표는 실행 큐와 종료 산출물만 고정한다.

| order | packet | state | exact owner/write-set | first RED | completion artifact | hard stop |
|---|---|---|---|---|---|---|
| 1A | `RFC07-3` task projection | **READY / P0 / S** | `agent/plan/task-projection.ts`, plan mutator read view, tool context mirror, `current-plan.ts` | `A`, `B→A`, `C→A+B`가 public `current_plan`에서 exact owner/blockedBy/blocks를 못 냄 | deterministic projection + public tool receipt; mutation/snapshot unchanged | stored reverse edge, second owner field, task-store/API clone |
| 1B | `RFC08-1` effort-cycle | **READY / P0 / S** | `EffortStore`, live slash model wire, key action enum, raw-line-reader callback path | configured chord가 same effort cell/next request를 못 바꿈 | chord→handler→same store→next LLM request receipt; OFF callback 0 | new store/model table/default chord/config system |
| 2 | `RFC07-1` named resolver | **READY / P1 / S** | `TaskRegistry` records, owner ledger, `target-resolver.ts`, mailbox composition callback | unique/ambiguous/foreign-lineage delivery matrix | exact-one delivery + zero-enqueue ambiguity/foreign receipt; legacy ids unchanged | global/fuzzy/nearest resolver, user-derived lineage, named-definition registry mutation |
| 3 | `RFC07-2M` line-watch measurement | **REQUIRED / P2** | evidence only; production `src/` write 없음 | current `bash_await`/reactor가 named consumer SLO를 충족하는지 미측정 | one of `DROP`, `PARK`, `ADMIT` with consumer + numeric bounds | parity-only or consumer-less justification |
| 4 | `RFC07-2B` line-watch build | **CONDITIONAL / P3 / MED** | existing `BashBgRegistry` drain + reactor bridge/self-wake | admitted line/latency/failure fixture | real process→drain→line→simulated-turn, bounded overflow, `bash_kill`, OFF receipt | no `ADMIT`; second spawner/registry/kill; unbounded queue |

Execution rules:

1. `RFC07-3` and `RFC08-1` are disjoint and may execute together. Each closes its own owner-local RED/GREEN/typecheck/god-code receipt before merge.
2. `RFC07-1` is security-sensitive; its foreign-lineage and ambiguity tests are admission tests, not follow-up hardening.
3. `RFC07-2M` may measure now, but `RFC07-2B` cannot edit `BashBgRegistry` until RFC-02's background-shell ownership packet is landed or explicitly declared non-overlapping at the hunk/contract level.
4. A `PARK`/`DROP` measurement verdict is a valid closeout. Do not create skeleton ports, dormant knobs, placeholder tools, or catalog rows for a non-admitted build.
5. Every packet reports five states separately: plan, implementation, owner-local proof, campaign/front-door closure, Git publication.

Immediate checklist:

- [ ] `RFC07-3`: create RED fixtures and land pure read projection.
- [ ] `RFC08-1`: create configured-chord/live-model REDs and land same-store handler.
- [ ] `RFC07-1`: freeze delivery matrix and factor existing resolver authority.
- [ ] `RFC07-2M`: publish consumer/SLO measurement verdict.
- [ ] `RFC07-2B`: execute only if the verdict is `ADMIT` and RFC-02 owner overlap is cleared.

### Cross-RFC single-owner matrix

이 표는 구현 중 **새로 만들 수 없는 authority 이름표**다. 새 abstraction이 필요하다는 이유만으로 평행 owner를 추가하지 않고, 아래 symbol의 contract를 최소 확장하거나 host/`@/agent` composition adapter에서 조합한다.

| concern | single owning symbol/module | allowed change | 반드시 제거/금지할 duplicate |
|---|---|---|---|
| session durability | `SavedSession`, `saveSessionById`, `loadSessionById` | optional versioned records/migration | rollback/workspace/journal store, semantic JSONL projector |
| working-tree restore | `ThreeWayRestorePort` + ShadowOdb | target mapping과 typed receipt | rollback file writer, second ODB |
| background shell lifecycle | `BashBgRegistry` | explicit owner/list/kill | process manager/store, public unscoped kill |
| execution evidence | `ToolResultEvidence` | executor-known additive facts | hint envelope, stderr/command classifier |
| operation activity | `AgentActivityEvent` spine | producer/correlation projection | feature phase bus/state machine |
| model transition | caller semantics + existing `AgentEvent` | `FallbackLLM.onTransition` bridge | route bus/store, `modelsUsed` state |
| skill catalog | `buildSkillRegistry` / `SkillRegistry` | pinned snapshot consumers | tier1/CLI discovery merge, skill cache/registry |
| skill search | `createToolSearchTool` | `catalog:"skills"` mode | standalone `skill_search`, second scorer |
| approval lifecycle | `ApprovalStateMachinePort` | artifact ref/hash binding | proposal review store/state machine |
| artifact bytes | `SkillProposalArtifactPort` backed by existing storage | staged put/get/CAS promote | hash/jail/atomic writer/ledger |
| tool catalog/dispatch | `ToolRegistry` | immutable turn snapshot wrapping | reload registry/dispatcher/collision algorithm |
| MCP change signal | existing client observer + `tools_list_changed` parser | negotiated relist handle | second notification parser/bus |
| LLM endpoint composition | `createLLM` + `CreateLLMOptions` | named OpenAI endpoint options | provider/endpoint registry, retry decorator |
| network admission | `ssrfDeny` / `fetchWithSsrfGuard` | typed policy/classification | LLM-specific SSRF/redirect classifier |
| user-session worktree | `SessionMeta` + `createPersistentWorktree`/hardened `removeWorktree` | persisted lifecycle + typed inspect | binding/lease store, GC remover/reaper |
| hunk mutation | `applyHunkSelection` | receipt/CAS wrapper | undo/reapply/fuzzy patch engine |
| objective state | `ObjectivePort` | typed provider producer | second goal store, UI mutation |
| mention resolution | existing autocomplete provider/default resolver | canonical catalog list/lookup injection | parser/catalog/registry |
| subagent live address | `TaskRegistry` records + spawn-owner ledger + `createTargetResolver` | unique exact name → existing `mailboxLabel` projection | global name registry, nearest/fuzzy resolver, definition-registry mutation |
| plan task compatibility view | canonical `Plan.assignee` + `Plan.dependencies` | `owner/blockedBy/blocks` pure read projection | stored reverse edges, second owner field, task-store clone |
| reasoning effort state | `EffortStore` + slash model wire | bindable key action computes next supported tier and calls existing setter | `EffortCycleStore`, second effort/model table, direct adapter mutation |

### Shared write-set serialization

같은 파일을 여러 RFC가 건드리는 경우 병렬 구현하지 않는다. 아래 owner packet이 schema/contract를 먼저 랜딩하고 follower는 그 revision 위에서 rebase한다.

| shared write-set | owner packet first | follower order | merge rule |
|---|---|---|---|
| `src/session/types.ts`, `src/session/store.ts` | `RFC01-0` optional operation record envelope | `RFC06-0` workspace ownership → `RFC06-4` mutation receipt → conditional `RFC01-4` | schema version/migration/atomic save는 한 PR씩 직렬; follower가 새 store/helper를 만들지 않음 |
| `src/stream/types.ts`와 event projections | `RFC01-1` headroom event | `RFC02-3` route transition | closed union/exhaustive projection cascade를 각 PR이 완결; 임시 `unknown` fallback 금지 |
| `src/agent/tier1/skill.ts` | `RFC03-0` registry cutover | `RFC03-1` ToolSearch skill mode → `RFC06-6` mention callbacks | discovery 제거 PR이 먼저; follower가 filesystem discovery를 복원하면 reject |
| `src/runner/assemble/llm.ts` | `RFC02-3` stateless transition callback | `RFC05-2` endpoint composition | route observation과 endpoint selection을 별도 함수/dep로 유지; wrapper nesting/retry 추가 금지 |
| activity producer/composition | `RFC02-5` operation correlation contract | `RFC06-2` worktree producer | B6 generic fake producer를 먼저 만들지 않고 RFC06 live caller를 첫 real producer로 삼아도 됨 |
| MCP/tool turn bootstrap | `RFC04-0` turn snapshot | `RFC04-1` observer → `RFC04-2` controller → `RFC04-3` publish | snapshot pin 이전 reload wiring 금지 |
| worktree runtime/session ops | `RFC06-1` inspect/remove hardening | `RFC06-2` transition → `RFC06-3` GC | force/string heuristic 제거 전 user-mode/GC 추가 금지 |
| `src/runtime/bash-bg-registry.ts` | `RFC02-0` ownership/lifecycle contract | `RFC02-1/2` list/kill → conditional `RFC07-2B` observer | line-watch는 owner/list/kill contract 위 optional observation만 추가; spawn/drain/kill authority를 재구성하지 않음 |

병렬 작업은 **write-set이 겹치지 않고 semantic owner도 다른 packet만** 허용한다. same-file overlap을 별도 implementation으로 피하지 말고 owner packet에 합류하거나 직렬 rebase한다.

### 중복개발 pre-merge gate

각 packet PR은 다음을 description/receipt에 명시해야 한다.

1. **Changed owner:** 위 matrix의 기존 symbol 하나와 변경 이유.
2. **Deleted bypass:** 교체·삭제한 old caller 목록. additive wiring만 하고 bypass를 남기면 미완료다.
3. **Only-new seam:** 이 README allowlist의 신규 seam 하나 이하. 둘 이상이면 architecture 재감사.
4. **Caller closure:** CLI/web/SDK/agent 중 reachable caller가 모두 같은 owner를 통과한다는 call-site inventory.
5. **RED-on-injection:** 새 owner call을 제거하거나 old bypass를 복원하면 정확히 RED가 되는 rail.
6. **Gate-OFF parity:** specs/help/event count/model text/constructor가 baseline과 동일.
7. **No authority heuristic:** PID/TTL/path-name/URL-shape/keyword/stderr/weighted score가 mutation·trust·ownership·routing 판정에 없음.

보조 정적 감사는 `rg`로 call site를 셀 수 있지만 bare identifier 존재만으로 GREEN 처리하지 않는다. source guard를 CI에 넣으면 live call pattern, anti-vacuum floor, red-on-injection 세 조건을 모두 만족해야 한다.

## SOTA++ target architecture

여기서 **SOTA++는 구현 완료 판정이 아니라 목표 구조**다. 문서/owner-local unit GREEN만으로는 SOTA++라 부르지 않는다. crash/restart·concurrency·TOCTOU proof, live front door, 동일 revision의 운영 측정까지 통과해야 `PROVEN`으로 승격한다.

| correctness primitive | owning truth | RFC consumers | 금지할 방향 |
|---|---|---|---|
| **Durable Run Projection** | `@/session` snapshot/projection + append-only intent/outcome receipt; sequence/revision/schema identity | 01, 06 | 불완전한 wire event를 semantic event store처럼 fold, physical history truncate, success-before-effect |
| **Turn Capability Snapshot** | host/agent composition이 **기존 `ToolRegistry` + specs + origin/trust fingerprint**를 한 immutable record로 묶고 turn 시작에 pin | 03, 04 | 평행 registry/dispatcher 구현, registry만 hot-swap, turn 중 capability mutation |
| **Operation Activity Spine** | 기존 `@/activity` event/snapshot; producer는 operation/thread correlation과 stable status를 제공 | 02, 06 | feature별 status bus, 동적 event name, observation event를 control authority로 사용 |
| **Trusted Artifact Promotion** | stage → validate → existing approval lifecycle → hash/preimage CAS → promote; provenance/receipt 보존 | 03, 05 | 새 approval state machine, import 즉시 live discovery, path-exists evidence, mutable review payload |
| **Mutation Receipt** | existing session/run identity와 before/after/expected-current hashes; mutation은 intent/effect/terminal receipt | 01, 06 | 새 file writer/apply engine, current-file을 새 baseline으로 삼는 revert, success-before-effect |
| **Persisted Workspace Ownership** | `SavedSession`/`SessionMeta`의 explicit ownership id + lifecycle state; cleanup은 operator command | 06 | TTL/PID/path-name ownership 추정, autonomous reaper, dirty/locked force cleanup |
| **Measured Transport Profile** | existing `CreateLLMOptions`/central config를 확장한 OpenAI endpoint policy; Chat/Responses adapter가 소비 | 05, 02 | 새 provider registry/adapter/retry loop, URL 기반 wire inference, hidden failover |

이 primitive들은 **공통 패턴이지 새 shared god-module이 아니다**. repo slice fence에 따라 semantic owner는 유지하고 `@/agent`/host composition에서만 조합한다.

### 중복/휴리스틱 삭제 register

| 삭제할 제안 | 재사용할 owner | 판정 |
|---|---|---|
| 새 projection/checkpoint store | `SavedSession` atomic snapshot을 schema-evolve; kernel JSONL은 receipt rail | **DELETE** |
| 새 rollback file writer/ODB | `ThreeWayRestorePort` + ShadowOdb | **DELETE** |
| 새 process registry | `BashBgRegistry`; owner id는 register 시 명시 | **DELETE** |
| 새 bash-hint/event bus | `ToolResultEvidence`, existing `AgentEvent`, `@/activity`에서 각 fact를 소유하고 projection | **DELETE** |
| `backgroundCwd` shell-string parser, `gh` stderr matcher | typed executor/tool-adapter fact가 생기기 전까지 | **DROP / NOT READY** |
| standalone `skill_search`, 새 skill registry, weighted scorer | existing `ToolSearch`에 `SkillRegistry.entries/lookup` backed mode; exact/prefix/field filters만 | **DELETE** |
| 새 proposal approval lifecycle | existing `ApprovalStateMachine` + hash-bound staged artifact reference | **DELETE** |
| 새 hook trust hash, guardian router, TOML policy engine | existing `HookReviewStore`, reviewer ladder, `RulesStore` | **DROP** |
| 새 mutable MCP registry | existing `ToolRegistry`를 포함한 immutable turn snapshot | **DELETE** |
| 새 declarative provider adapter/registry/retry loop | existing `createLLM`, Chat/Responses adapters, existing retry authorities | **DELETE** |
| 새 in-memory worktree binding/TTL-PID reaper | persisted session ownership + explicit `worktree gc --dry-run/apply` | **DELETE** |
| 새 hunk apply/revert engine | existing `applyHunkSelection` + durable CAS journal | **DELETE** |

휴리스틱은 **관찰/검색 보조**로만 허용하고 mutation, trust, routing, ownership, completion authority에는 사용하지 않는다. archive 초안에서 이 register와 충돌하는 항목은 명시적으로 구현 금지다.

### 허용되는 최소 신규 seam

| seam | 이유 | 기존 authority를 복제하지 않는 조건 |
|---|---|---|
| `SavedSession` optional projection/workspace/mutation fields | restart durability | 기존 atomic session file/loader 안에서만 schema evolve |
| `ThreadRollbackCoordinator` application service | session receipt와 file effect 순서화 | `@/agent`에 위치; store/hash/restore 구현 없음 |
| `BgShellSnapshot.ownerId` + register/adopt input | cross-session kill 차단 | caller가 명시; PID/cwd/id로 derive 금지 |
| `ToolContext.ownerId` optional dispatch fact | bash tool이 own-shell authority를 증명 | stable session/thread identity를 composition이 주입; tool이 derive 금지 |
| `FallbackLLMOptions.onTransition` structural callback | `@/llm` slice 밖 existing `AgentEvent`로 project | lifecycle/store/bus 없음; runner adapter만 보유 |
| `SkillProposalArtifactPort` | `@/skill` slice가 staged content를 host storage에 위임 | host adapter는 existing `@/storage` atomic/hash/jail 사용; approval lifecycle은 existing SM |
| `ApprovalRequest.artifactRef/artifactHash` optional fields | decision을 exact proposal bytes에 bind | status/settle/store semantics는 변경하지 않음 |
| `TurnRegistrySnapshotRef` atomic pointer | existing ToolRegistry+specs를 turn-boundary에 함께 pin | existing `ToolSurface` axis와 별개; registry/dispatcher/collision logic을 소유하지 않음 |
| existing MCP load result의 structural relist/observer handle | direct/supervised client의 hot-reload parity | `McpStoppable` lifecycle을 evolve; client별 registry/parser 없음 |
| host `McpToolReloadController` application service | full relist/validate/compare-and-publish 순서화 | registry/converter/trust/notification logic 없음; fixed single-flight+dirty only |
| `OpenAIEndpointOptions` in existing config/factory | declarative endpoint data | 새 provider id/registry/adapter/retry owner 없음 |
| typed `WorktreeInspection` read model | porcelain Git facts를 mutation 전 검증 | ownership/state/remove authority 없음; `SessionMeta`와 runtime mutation owner가 계속 결정 |
| optional named-address callback at mailbox composition | tool slice가 host target authority를 재사용 | `TaskRegistry`/owner-ledger resolution만 호출; 자체 map/registry 없음 |
| optional `BashBgRegistry.register` output observer | admitted line-watch가 existing drain을 관찰 | 새 spawn/registry/kill 없음; D2 measurement 통과 전 추가 금지 |
| `ReadLineOptions.onCycleEffort` callback | configured key action을 canonical session effort setter에 연결 | store/model/config를 소유하지 않는 UI callback만 허용 |

이 목록 밖 새 port/store/registry/projector/scorer는 Wave 0에서 중복 여부를 다시 증명하기 전 admission 금지다.

### 현재 공개 기준과 설계 반영

- Durable execution의 append-only history는 모든 state-changing event가 complete하고 replayable할 때만 semantic authority가 된다. 현재 quanta event는 그 조건을 충족하지 않으므로 snapshot/projection + receipt hybrid가 옳다. [Temporal Event History](https://docs.temporal.io/workflow-execution/event)
- Observability event는 checkpoint/state change/outcome을 나타내되 event name은 stable/low-cardinality여야 한다. 내부 canonical vocabulary를 고정하고 OTel mapping은 adapter로 둔다. 현재 OTel event conventions는 Development 상태이므로 내부 SSOT를 외부 draft에 종속시키지 않는다. [OpenTelemetry event conventions](https://opentelemetry.io/docs/specs/semconv/general/events/)
- MCP `tools/list`는 pagination·deterministic ordering·`listChanged` capability negotiation을 요구한다. reload는 complete list 검증 후 다음 turn generation으로 atomic publish한다. 구현 시 protocol version과 conformance fixture를 pin한다. [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools)
- Skills/imported config/provider profiles는 executable supply-chain artifact로 취급한다. provenance는 어디서·언제·어떻게 생성됐는지 검증 가능한 정보여야 하며, 여기서는 staging/hash/CAS/review receipt로 적용한다. SLSA 준수를 주장하는 것이 아니라 동일한 provenance 원칙을 차용한다. [SLSA provenance](https://slsa.dev/spec/v1.2/provenance)
- Git은 locked worktree의 prune/remove를 막고 dirty worktree remove에 force를 요구한다. 따라서 quanta cleanup은 persisted ownership + clean state를 operator에게 보여주는 dry-run/apply command여야 한다. [Git worktree documentation](https://git-scm.com/docs/git-worktree.html)
- Responses WebSocket은 공개 production transport지만 이 repo의 우월성은 별도 A/B로 증명해야 한다. 연결 캐시/세션 상태는 turn-pinned transport session에 포함하고 silent SSE fallback은 금지한다. [OpenAI WebSocket engineering note](https://openai.com/index/speeding-up-agentic-workflows-with-websockets/)

### Proof ladder

1. **L0 Contract:** authority, identity, schema version, fail-closed transition, owner files 고정.
2. **L1 Owner-local:** RED-on-injection + gate-OFF parity + deterministic property tests.
3. **L2 Adversarial:** crash between intent/effect/receipt, restart, concurrent reload, stale hash, dirty/locked workspace.
4. **L3 Product:** CLI/web/SDK 실제 front door에서 model-visible/dispatch-visible/surface-visible state 일치.
5. **L4 Production:** bounded canary, latency/token/error/cardinality budget, rollback criterion. 여기까지 같은 revision receipt가 있어야 `SOTA++ PROVEN`.

## 계획을 뒤집은 confirmed corrections

- **RFC-01 A1:** 현재 `SessionEvent`에는 full transcript/tool result/approval/artifact를 exact 복원할 정보가 없다. `rehydrateState(events)`는 DROP. 기존 snapshot loader를 runtime에 주입하거나 full-fidelity checkpoint schema를 별도로 설계한다.
- **RFC-01 A2:** event log는 append-only로 유지한다. rollback은 `requested → ShadowOdb restore → rolled_back` 순서이며 실패 시 `rollback_failed`; 성공 event를 tree mutation보다 먼저 쓰지 않는다.
- **RFC-04 trust-hash:** `HookReviewStore.hookBindingKey`가 이미 normalized event+matcher+command를 SHA-256한다. 신규 D2는 DROP; 16-hex truncation 확대는 optional hardening이다.
- **RFC-04 project rule trust:** `buildAutoModeOverlay`는 prompt overlay일 뿐 live matcher fence가 아니다. repo TOML `allow`를 `RulesStore`에 넣기 전에 provenance 기반 drop/demotion이 필요하다.
- **RFC-05 A6:** 2026-04-22 공개된 Responses API WebSocket mode가 있으므로 “Codex-internal이면 DROP” 가정은 폐기한다. 다만 이 repo에는 turn framing이 없고, 자체 A/B 없이 default-ON 금지다.
- **RFC-06 cleanup:** 현재 53 registered worktrees 중 42 dirty, 7 locked다. `.claude/worktrees/agent-*`는 quanta 소유 증거가 없으므로 자동 삭제 금지. 기존 tree는 별도 salvage report, 신규 owned tree도 explicit operator GC만 허용한다.
- **RFC-06 B5:** forward partial apply는 CLI/web/SDK에 이미 배선돼 있다. delta는 anchor와 `{originalBefore, proposedAfter, expectedCurrent, appliedHunks}` CAS undo journal이다.
- **RFC-07 Workflow:** audit이 "구조적 최대 gap"이라던 declarative multi-agent DAG는 `src/workflow/index.ts`에 이미 shipped(agent/parallel/pipeline/phase/fanout, gated `QUANTA_WORKFLOW`). 신규 엔진/DSL/executor/run-store 금지. Task-DAG/mailbox/fork/named registry/lineage/codemode는 LIVE이고 genuine delta는 named-`to:` resolver·line-watch·owner/blocks projection 3개뿐이다.
- **RFC-07 named-`to:`:** 전역 name→id 맵 금지. `TaskRegistry.agentType/mailboxLabel` + spawn-owner ledger + existing target policy에서 unique exact match만 허용하고, 모호하면 zero enqueue, foreign lineage는 존재 자체를 숨긴다.
- **RFC-07 owner/blocks:** 새 stored `owner`가 아니다. `owner:=assignee`, `blockedBy:=dependencies`, `blocks:=reverse(dependencies)`인 pure read projection이다. snapshot/DAG mutation/CAS는 변경하지 않는다.
- **RFC-07 line-watch:** 새 watcher spawner/process registry/task_stop 경로 금지. measurement가 통과한 경우에만 `BashBgRegistry`의 existing drain에 optional observer를 붙이고 기존 `bash_kill` lifecycle을 사용한다.
- **RFC-08 대부분 DROP/PARK:** keybindings config·Ultra(`ReasoningEffort:"max"`)·codemode per-cell cap·MCP version SSOT·OS-keyring은 이미 있음(DROP). renderer/미측정 편의 7개는 PARK. 실 BUILD은 effort-cycle action 1개이며, 새 store/default chord 없이 existing `EffortStore`와 live model wire를 쓴다.

## 실행 순서

### Wave 0 — 안전/authority 계약

1. **WT-SALVAGE (운영 감사, 구현과 분리):** 기존 53 worktree를 registered path/branch/SHA/dirty/lock reason/unique commit으로 분류한다. PID로 owner를 추정하지 않고 자동 삭제하지 않는다. stop = provenance 없는 항목 또는 dirty/locked 항목 발견.
2. **DURABLE-RUN-CONTRACT (RFC01/06):** projection checkpoint identity와 operation intent/effect/receipt를 고정한다. stop = incomplete event fold, 새 ODB, physical history truncate, success-before-effect.
3. **TURN-CAPABILITY-SNAPSHOT-CONTRACT (RFC03/04):** existing `ToolRegistry`/specs/origin/trust fingerprint를 한 immutable record로 고정하고 turn-boundary publish를 정의한다. stop = 새 registry/dispatcher 또는 turn 중 mutation.
4. **OPERATION-ACTIVITY-CONTRACT (RFC02/06):** `run/thread/turn/operation/sequence` correlation과 canonical status mapping을 고정한다. stop = feature별 bus 또는 activity를 control authority로 사용.
5. **ENDPOINT-PROFILE-CONTRACT (RFC05):** JSON config provenance/merge, Chat/Responses 공통 endpoint/network/secret policy를 고정한다. stop = multicloud registry 확장 또는 wire grammar 복제.
6. **WORKSPACE-OWNERSHIP-CONTRACT (RFC06):** `SavedSession`/`SessionMeta` 기반 explicit owner/lifecycle, `.quanta/worktrees/thread-*`, mutation journal CAS를 고정한다. stop = lease TTL/PID/path-name 추정 또는 force removal.

### Wave 1 — 작은 독립 delta

- RFC-01 A7 context-headroom edge-latched advisory (기존 BudgetMeter/compaction 재사용).
- RFC-02 B1 `/ps` **list-only** background-shell surface. raw command/cwd/output는 bounded+redacted; kill은 owner/authority 계약 후 후속.
- RFC-02 operation correlation + activity producer pure mapping을 먼저 랜딩하되 live caller 없는 B6 완료 판정은 금지.
- RFC-04 existing `ToolRegistry`를 감싸는 immutable turn snapshot + generation pin을 reload 없이 먼저 랜딩한다. 새 registry/dispatcher는 만들지 않는다.
- RFC-06 B5 anchored comment model만 먼저 랜딩 가능; undo는 journal/CAS 설계 뒤.
- RFC-07 D3 `owner:=assignee`/`blockedBy:=dependencies`/`blocks:=reverse(dependencies)` pure projection(stored alias/reverse edge 금지) · RFC-08 bindable effort-cycle action(existing `EffortStore` 직접 사용, 새 cycle store/default chord 금지).

### Wave 2 — owner-local product seams

- RFC-01 A2 durable mapping + rollback coordinator.
- RFC-02 existing `AgentEvent`/recorder projection과 caller-owned typed route transition wiring. 별도 protocol bus/sink 금지.
- RFC-03 hash-bound proposal store/HITL actuator + staged skill import/promote.
- RFC-03 existing `ToolSearch`에 `catalog:"skills"` mode를 additive하게 추가하고 `SkillRegistry` snapshot 위 exact/prefix/scope/category filters만 제공한다. standalone tool/weighted scorer 금지. full skill inventory를 제거한 gate에서 prompt tokens와 task success를 A/B한다.
- RFC-05 D1 configured OpenAI endpoint + D2 live local tool-stream smoke.
- RFC-06 persisted current-thread worktree lifecycle + activity feed + explicit operator GC. autonomous reaper 금지.

### Wave 3 — 큰/조건부

- RFC-04 MCP hot reload.
- RFC-05 Responses WebSocket measured track.
- RFC-06 CAS undo/reapply + multi-surface, rich mention source expansion.
- RFC-01 full-fidelity SDK projection checkpoint는 owner 선택 후에만.
- RFC-07 named-`to:` resolver(existing target/lineage owner, ambiguity fail-closed). RFC-07 D2는 measurement admission이 통과한 경우에만 existing bg-registry drain observer + rate cap + operator-only surface로 진행한다.

## 공통 admission / stop rules

- **Authority one:** snapshot/event-log/checkpoint/registry/specs 중 어느 것이 mutation authority인지 ticket마다 하나만 명시한다.
- **No false GREEN:** projector unit만으로 완료 금지. 실제 front door → owner → model-visible/surface-visible effect를 관찰한다.
- **Default-OFF parity:** gate OFF에서 tool/spec/help/event count와 model text가 기존 baseline과 deep-equal이어야 한다.
- **Fail closed:** missing mapping/hash/preimage/provenance/owner/generation이면 mutation 또는 permission widening 금지.
- **No destructive cleanup:** dirty/unowned worktree, unrelated untracked file, unknown checkpoint는 preserve/report한다.
- **No duplicate owner:** `SavedSession`, `ToolRegistry`, `SkillRegistry`, `ApprovalStateMachine`, OpenAI Chat/Responses, retry policy, hunk apply, ShadowOdb, rule matcher를 새 leaf에서 재구현하지 않는다.
- **No heuristic authority:** PID/TTL/path-name/URL shape/keyword score/stderr text는 mutation·ownership·routing·trust·completion 판정에 사용하지 않는다.
- **Current-turn pin:** MCP tool generations와 rollback/checkpoint identity는 한 turn 동안 변하지 않는다.
- **Proof receipt:** owner-local RED/GREEN rail과 gate-OFF rail을 같은 revision에 남긴다. build/commit/push는 별도 상태다.

## Fresh audit receipts

- RFC-03/04 focused rails: **71 pass / 0 fail**.
- RFC-05/06 focused rails: **165 pass / 0 fail** (OpenAI routing, multicloud reachability, session worktree fork/delete, CLI/web/SDK hunk apply, objective, deep hunk rails).
- RFC-07/08 substrate recheck: **227 pass / 0 fail** across Workflow real-loop/gate/tool/engine, subagent delivery controller + real-loop modes, plan DAG/mutations/tools, keybindings, mode-cycle, and model-effort clamp rails. 이 receipt는 existing substrate를 증명하며 D1/D3/BUILD-1 구현 완료를 뜻하지 않는다.
- RFC-01/02는 read-only owner/caller audit만 수행했으며 fresh test receipt는 아직 없다.
- Git: 원천 감사와 RFC-01~08 baseline은 `main@0922d737f431ace0d6f2d6505c40351976718981`에 local commit됐다. RFC-09 residue correction도 문서 publication일 뿐이며, 구현 완료나 remote publication을 뜻하지 않는다.
