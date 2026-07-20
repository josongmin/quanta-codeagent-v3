# Default-OFF 백로그 — A/B 필요분 · 억지로 안 킨 것 · 수리 먼저 (2026-07-18)

> 레저·소스·테스트를 대조한 백로그다. 기능별 **역할 / 왜 default-ON 안 했나 / 코드위치**는 레저 ID와 대조한다. 경쟁사 비교는 별도 출처 상태를 명시하며, 인용 없는 항목은 roadmap 근거로 쓰지 않는다.
>
> **Closure 현황 (2026-07-19 source re-audit)**: eligible 172행, **wired 163/172 = 94.8%**, runtime CLI seed 30, unknown-surface 0, unknown-value 0, checker error 0. `compaction-event-emit`와 `context-change-injection`은 normal host에 항상 조립되는 production wire라 default-off denominator에서 제외했다. `fast-apply-merge`는 명시적 host `FastApplyMergeReviewSeam`을 `ToolContext`까지 전달한다; env/model만으로는 계속 fail-closed다.
> decisions: measure-first 67 · **enable-now 68** · repair-first 0 · hold 37.
>
> **남은 9행의 성격**: 4개는 실제 외부 계약/credential 또는 image policy가 먼저 필요하고, 3개는 producer-only여서 수명 소유자가 없으며, 1개는 기존 inline 구현의 중복 포트, 1개는 실행 loop producer가 없는 transport seam이다. 가짜 consumer 또는 자동승인을 만들지 않는 한 이들은 `wired`가 될 수 없다. measure-first 67행은 행동/비용을 바꿔 **efficacy A/B(operator 결정)**가 선행돼야 기본값을 바꿀 수 있다.

### 2026-07-19 구조 재감사 — 레저 정정과 실제 잔여 blocker

| 구분 | feature | 소스 판정 | 다음 변경의 authority |
|---|---|---|---|
| 기존 wire를 레저가 놓침 | `codex-r2-multi-process-flock`, `embed-cache`, `git-directive-emit-leaf`, `search-pipeline-composer`, `semantic-search-port`, `compaction-visibility` | 모두 production caller가 있다. `search_codebase`는 기본 lexical wire이며 `QUANTA_INDEX`는 tool presence가 아니라 hybrid/semantic 승격이다. | ledger/feature catalog/tool manifest를 실제 host composition에 맞춤. |
| 중복 포트 | `identity-mid-session-prompt-rebuild` | live `/identity`는 inline `buildPromptFromIdentityMode`를 이미 호출한다. 별도 rebuilder를 연결하면 동일 prompt rebuild가 두 authority가 된다. | inline owner를 추출·교체하는 별도 refactor가 먼저이며, 단순 wire 금지. |
| producer-only | `model-tag-auto-hook`, `model-tag-versioning`, `message-batches-client-core` | registrar target의 lifetime owner, batch scheduler/poll/retry owner가 없다. | cache/vector-store lifetime 또는 async job authority를 먼저 설계. |
| external/product contract | `bridge-attestation`, `jwks-agent-identity`, `dockersandbox`, `budget-probe-ledger-wire` | secret/IdP/image selector 또는 real run-budget policy가 없으면 보안·비용 의미가 바뀐다. | provisioned secret/issuer, pinned toolchain image, billing budget owner를 product 계약으로 결정. |
| loop protocol 없음 | `streaming-boomerang` | `ChunkProducer`를 만드는 agent-loop lifecycle producer가 없다. | stream ownership·backpressure·cancel contract를 loop owner에서 확정. |

---

## 버킷 A — A/B 필요 (measure-first, 50)

켜면 **에이전트 행동/출력이 바뀌거나 비용이 드는** 것들. A/B 없이 켜면 gaming이라 measure-first로 둠. OFF identity는 42개 unit·8개 wire tier로 기록돼 있으나, 실행 receipt는 아직 0개다. 따라서 "전부 byte-identical"은 증명 완료 주장이 아니라 각 gate의 검증 목표다.

### A-1. 벤치 knob (14) — SWE-bench 런에만 영향, 대화형 제품과 무관

| feature_id | 역할 | knob key | 왜 A/B | 코드위치 |
|---|---|---|---|---|
| adversarial-repro-knob | repro 생성 프롬프트에 adversarial coverage 블록(boundary/must-reject) 추가 (pure prompt-steer) | `QUANTA_BENCH_ADVERSARIAL_REPRO` | repro 프롬프트 변경→행동 변경, 미측정 | `src/config/knob-schema/schemas/bench-b.ts:350` |
| fault-evidence-knob | raw-source 힌트 대신 typed FaultEvidencePacket(경로/심볼만) 주입 | `QUANTA_BENCH_FAULT_EVIDENCE` | 주입 컨텍스트 변경, 미측정 | `src/config/knob-schema/schemas/bench-a.ts:206` |
| issue-hint-expected-actual-opt-in | 이슈에서 expected/actual 증거 추출해 힌트 grounding | `QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL` | 힌트 내용 변경, 미측정 | `bench-a.ts:151` |
| localize-phase-knob | Agentless "localize-first" — phase1 N턴을 탐색 전용 예약 (control-flow) | `QUANTA_BENCH_LOCALIZE_PHASE` | 턴배분 변경 + branch-search와 confound | `src/runner/knobs/knobs/localize-phase.ts:46` |
| primary-rail-knob | planner가 고른 primary rail을 done-gate로 강제 (수렴/종료 게이트) | `QUANTA_BENCH_PRIMARY_RAIL` | repair 반복·종료판정 변경, 미측정 | `bench-a.ts:238` |
| repair-escalation-knob | typed RepairEscalationDecision 산출(single-owner→multi-site 확장 조건) | `QUANTA_BENCH_REPAIR_ESCALATION` | repair 분기 변경, 미측정 | `bench-a.ts:286` |
| repro-doubt-knob | N회 무편집 재실행 후 의심을 PATCH→REPRO TEST로 돌리는 one-shot steer | `QUANTA_BENCH_REPRO_DOUBT` | stuck 시 행동 변경, 미측정 | `src/runner/knobs/knobs/repro-doubt.ts:35` |
| repro-test-mwe-vote | K-of-N resolved 게이트 — 다수결로 single-oracle false-neg 제거 (수용 게이트) | `QUANTA_BENCH_REPRO_VOTE` | 수용판정 변경, 미측정 | `bench-repro.ts:61` |
| retry-transient-knob | transient 실패(empty-patch/infra) 재시도 상한 (측정 인프라, agent 행동 무관) | `QUANTA_BENCH_RETRY_TRANSIENT` | 결과집계/비용 영향, 미측정 | `bench-loop.ts:59` |
| spec-fidelity-steer-knob | 이슈가 구체 expected 선언 시에만 minimal-literal-fix steer (pure prompt-steer) | `QUANTA_BENCH_SPEC_FIDELITY_STEER` | 프롬프트 행동 변경, 미측정 | `bench-a.ts:302` |
| verification-plan-knob | ad-hoc verify 대신 typed VerificationPlan(primary rail+successPredicate) | `QUANTA_BENCH_VERIFICATION_PLAN` | 검증 실행경로 변경, 미측정 | `bench-a.ts:222` |
| patch-budget-admission | 후보 diff patch-budget 분석, strict면 gate 아니면 observe (soft, hard-reject 없음) | 인자 `strict` | gate는 legit fix 제로화 위험(pytest-5787 재발) | `src/runner/batch/eval/patch-budget-admission.ts:16` |
| bench-find-refs-steer | SWE-bench에 `find_references` 도구 노출 + timeout-prone lsp_references에서 전환 steer | `QUANTA_BENCH_FIND_REFS` | ON/OFF composition hellgate는 존재하나 benchmark receipt/effect-size가 없음; 도구셋+프롬프트 변경이라 efficacy는 미측정 | `src/runner/batch/eval/driver/config-build.ts:122` |
| proof-driven-bench-closure | 종료 시 closure 엔진이 typed 증거로 verify·close 판정 + 진단 사이드카 | `QUANTA_BENCH_CLOSURE_DIAG` | 종료판정 변경, 미측정 | `src/apps/bench/run-main.ts:524` |

> **판단**: 벤치 knob은 전부 SWE-bench 측정용. "efficacy A/B"란 곧 이 knob들을 켠 채 벤치 돌려 f2p 상승 확인. operator가 벤치박스에서 A/B 돌릴 때 검증. 제품(CLI/web)엔 영향 0.

### A-2. 행동 바꾸는 에이전트 코어 (13)

| feature_id | 역할 | gate key | 왜 A/B / 현황 | 코드위치 |
|---|---|---|---|---|
| adaptive-thinking | thinking config를 fixed budget→`{type:"adaptive"}` shape로 (모델 지원 시) | `QUANTA_ADAPTIVE_THINKING` | 매 턴 thinking 요청 shape 변경 = provider-cost, 미측정 | `src/agent/loop/skill-gate.ts:197` |
| assistant-language-auto-detect | 최근 user 텍스트 기반 응답 언어 힌트 주입 | `QUANTA_LANG_DETECT` | 출력 언어 바꿈, 미측정 | `src/agent/language-detect/index.ts:134` |
| closeout-critic-gate | closeout에 리뷰어 어댑트한 critic 패스 추가 | `QUANTA_CLOSEOUT_CRITIC` | 완성 행동 변경, 미측정 | `src/agent/optional-ports.ts:396` |
| edit-repair-loop | edit apply 실패 시 커맨드로 repair 후 재시도 | `QUANTA_EDIT_REPAIR_LOOP` | edit/apply 흐름 변경, 미측정 | `src/agent/edit-repair-wire.ts:32` |
| memory-cross-session-inject | 이전 세션 메모리를 프롬프트에 주입 (**opt-OUT, 이미 ON**) | `QUANTA_MEMORY_AUTO` (defaultOn) | **이미 default-ON**(ADR-0413); 역질문=bench 오염 A/B | `src/host/runtime/agent-arg-builder.ts:228` |
| reasoning-carryover | OpenAI Responses reasoning item을 다음 턴 input에 re-feed (Codex식) | `QUANTA_REASONING_CARRYOVER` | provider reasoning 재주입(shape 의존), 미측정 | `src/llm/openai-responses-wire.ts:345` |
| subagent-read-inbox | 서브에이전트가 자기 mailbox를 poll/drain하는 `subagent_read_messages` 도구 | `QUANTA_SUBAGENT_MAILBOX` (port) | multi-agent 도구 추가로 행동 변경, 미측정 | `src/tool/subagent-mailbox/index.ts:219` |
| three-way-restore | `/rewind-tool` — 파일/대화상태/둘다 체크포인트 복원 | `/rewind-tool` command | **conditional opt-in**: `QUANTA_PER_TOOL_RECORD`+`QUANTA_SHADOW`가 필요. files leg는 선택 tag SHA를 ordinal snapshot으로 해석하고 `expectSha`로 fail-closed 복원한다. broad default-ON은 파괴적 UX라 금지 | `src/agent/per-tool-checkpoint/three-way-restore.ts` |
| env-probe | 시작 시 shell/tooling 팩트 스냅샷을 system prompt에 주입 (**이미 CLI-ON**) | `QUANTA_ENABLE_ENV_PROBE` (CLI-seeded) | CLI만 ON; 타 서피스는 프롬프트 추가분 A/B | `src/apps/cli/repl/env-probe-wire.ts:101` |
| item-stream-fine-grained | per-item 스트림 델타(item-typed projection) | `QUANTA_ITEM_STREAM` | 스트림 이벤트 shape 변경; CLI도 gated `ItemStore`→`/activity` 및 attach renderer 소비 경로가 있음. 기본 ON efficacy/출력 영향은 미측정 | `src/apps/cli/repl/surface-compose.ts:589` |
| git-co-change | 히스토리상 함께 바뀐 파일 제안하는 co-change git 도구 추가 | `QUANTA_GIT_CO_CHANGE`(+`QUANTA_GIT_TOOLS`) | 도구 추가로 도구선택 변경, 미측정 | `src/apps/cli/internal.ts:679` |
| per-hunk-diff-accept-reject | 승인 시 개별 diff 헌크 accept/reject (partial-apply) | `QUANTA_HUNK_APPROVAL` | 승인 흐름 변경(CLI-only), 미측정 | `src/apps/cli/repl/hunk-select.ts:70` |
| prompt-suggestion | 턴 후 전용 LLM(text-only) 호출로 프롬프트 제안 생성 | `QUANTA_ENABLE_PROMPT_SUGGESTION` | 매 턴 **추가 LLM 호출** = provider-cost, 미측정 | `src/apps/cli/repl/prompt-suggestion-wire.ts:64` |

### A-3. provider-cost / security / external (11)

| feature_id | 역할 | gate key | 왜 A/B (구체) | 코드위치 |
|---|---|---|---|---|
| auto-dream-cross-session | 세션 종료 시 임계 넘으면 백그라운드 메모리 통합 발사 | `QUANTA_AUTO_DREAM` (port) | 매 dream = 추가 LLM consolidate 비용 + 메모리 오염 | `src/memory/dream/cross-session-trigger.ts` |
| background-compaction | 컨텍스트 임계 근접 시 취소가능 speculative summarize 백그라운드 | `QUANTA_BG_COMPACTION` | speculative summarize = 버려질 수 있는 추가 LLM 비용 | `src/agent/compaction/background.ts:47` |
| image-gen | OpenAI images API(gpt-image-1)로 이미지 생성/편집 `image_gen` 도구 | `QUANTA_IMAGE_GEN` (port) | images API 과금(채팅 토큰과 별개) + OPENAI_API_KEY | `src/tool/image-gen/index.ts:5` |
| code-mode-js-runtime | QuickJS-WASM 샌드박스서 모델작성 JS 실행, in-cell 툴콜은 재-게이트 | `QUANTA_CODE_MODE` | 모델작성 코드 실행(샌드박스됨: no fs/net/require), 잔여 eval 표면 | `agent-arg-builder/gated-tool-ports.ts:398` |
| debug-inspect | DAP/CDP로 프로그램 디버깅, breakpoint서 콜스택/locals 리포트 | `QUANTA_DEBUG_TOOLS` | 프로그램 실행=**arbitrary code exec**, always-confirm HIGH RISK | `gated-tool-ports.ts:373` |
| n6-pty-attach | tmux 백엔드로 인터랙티브 터미널 attach/write/read 6도구 | `QUANTA_PTY_ATTACH` (port) | 라이브 터미널 I/O + escape sequence defang 필요 | `src/tool/pty/index.ts:1` |
| sandbox-escalation | sandbox-blocked bash에 3-step 재승인 후 sandbox OFF로 1회 재실행 | `QUANTA_SANDBOX_ESCALATION` | 본질이 **통제된 sandbox escape**; 자동승인 never, 3-step override | `src/agent/sandbox-escalation/orchestrator.ts:30` |
| mcp-tool-annotations-content | MCP 서버 자칭 readOnly/idempotent 힌트로 permission 완화 (trusted 서버만) | `QUANTA_MCP_TOOL_ANNOTATIONS`+trusted | 힌트가 **자칭**이라 hostile server 위험, trust-required로 격리 | `src/mcp/client.ts` |
| jun7-manifest-codex-compat | Codex-shape 매니페스트를 Zod 전 정규화(string→array 등) | `QUANTA_MANIFEST_COMPAT` | 도구-스코핑 grant 필드 접촉(frozen 2-key, grant 확대 없음) | `src/skill/manifest-compat.ts:19` |
| dxt-user-config | DXT `user_config` schema/보간 library | manifest.user_config | **현재 production `launchDxt` caller가 없어 gate/manifest만으로 spawn되지 않음**; plugin discovery·launch composition root가 먼저 필요 | `src/plugin-isolation/dxt-loader.ts:39` |
| worktree-tool | `enter/exit_worktree` — bash/edit cwd를 git worktree로 retarget | `QUANTA_WORKTREE_TOOL` (slot) | 모든 bash/edit의 cwd 변경(git-worktree 상태 mutation) | `src/agent/tier1/worktree.ts:23` |

### A-4. 관측성 / 서피스 / UI (11)

| feature_id | 역할 | gate key | 왜 A/B (구체) | 코드위치 |
|---|---|---|---|---|
| observability-wire | objective/runLedger/approvalSM/shadowVerify 4포트 구성 반환 | `QUANTA_OBSERVABILITY` | **순수 telemetry 아님** — `objective_set/get/update`+`shadow_verify` **LLM 도구 주입**(behavioral leak) | `src/agent/observability-wire/wire.ts:338` |
| observability-live-wire | argv→config 조립 시 위 4포트+HookBus를 base config에 프로젝션 | `QUANTA_OBSERVABILITY` | 도구노출+post_tool_use 구독=LLM 표면/런타임 비용 변화 | `agent-arg-builder/observability-wire.ts:80` |
| observability-ws-sink | 웹 데몬서 WS 연결마다 observability sink attach | `QUANTA_OBSERVABILITY` | 상위 wire 도구주입을 웹으로 전파 | `src/apps/web-daemon/server.ts:311` |
| canvas-web-components | usage/tool-diff/artifact를 WS Canvas 프레임으로 브로드캐스트 | `QUANTA_WEB_CANVAS` | 매 연결 추가 스트림/직렬화 비용, 효능 미측정 | `src/apps/web-daemon/runtime-factory.ts:362` |
| surface-composition-wire-r1 | REPL서 conv-checkpoint 자동record·identity-mode·focus-chain 슬롯 구성 | `QUANTA_CHECKPOINT_CONV`/`_IDENTITY_MODE`/`_FOCUS_CHAIN_EVERY` | turn-end 자동 record(디스크I/O)·프롬프트 슬롯 부작용 | `src/apps/cli/repl/surface-compose.ts:492` |
| surface-wire-r2 | `/rewind-tool`용 per-tool-checkpoint 레코드(shadow ODB) 구성 | `QUANTA_PER_TOOL_RECORD`(+`QUANTA_SHADOW`) | 파괴적 도구 前 shadow anchor 축적(디스크/git-shadow 비용) | `surface-compose.ts:318` |
| playbook-trigger-cli-bind | `.quanta/playbooks/` FS watcher로 트리거 시 플랜 자동 dispatch | `QUANTA_PLAYBOOK_TRIGGER` | **대부분 repo에 playbook 없어 빈-레지스트리 no-op**(스텁 아님) + watcher 상시비용 | `src/apps/cli/repl/playbook-trigger-wire.ts:107` |
| playbook-trigger-flag-echo | 위를 `--playbook-trigger` 플래그로도 켜는 진입경로 | flag/`QUANTA_PLAYBOOK_TRIGGER` | 동일 빈-레지스트리 문제 공유 | `playbook-trigger-wire.ts:79` |
| pre-compact-hitl | compaction 직전 승인/거부 질의(defer_one_turn) | `onPreCompact` port/`QUANTA_PRECOMPACT_CONFIRM` | 매 compaction UI wake; **거부 반복 시 threshold 초과 채 진행 stall 위험** | `src/agent/compaction.ts:716` |
| passive-vcs-classify | bash git/gh stdout 파싱해 구조화 VCS 이벤트를 버스에 주입 | `QUANTA_PASSIVE_VCS` | **base AgentEvent 스트림 변형**(bench 재현성) + 정규식 오탐 | `src/git/passive-classify/index.ts:16` |
| projects-kb | 로컬 파일을 세션 KB로 인덱싱, 원문 대신 메타+스니펫 반환(context-offload) | `QUANTA_PROJECTS_KB` (slot) | LLM 도구표면 확대 + `rag_active` 임계 미검증 | `src/tool/index.ts:807` |

### A-5. 리트리벌 파이프라인 (1)

| feature_id | 역할 | gate key | 왜 A/B (구체) | 코드위치 |
|---|---|---|---|---|
| pipeline-composition-root-wire | `search_codebase` 도구에 lexical/semantic/rerank 파이프라인 preset을 조립 | `QUANTA_PIPELINE` | `none` 외 preset은 검색 결과·도구 출력·adapter/provider 비용을 바꾸므로 efficacy 측정 전 기본값 유지 | `src/runner/assemble/search-pipeline.ts:284` |

---

## 버킷 B — 억지로 안 킨 것 (hold, 46)

hold는 "기본 활성화 보류" 결정이며 미배선과 동의어가 아니다. 46개 중 **26개는 이미 wired**이고, dormant 계열은 seam-only 11·producer-only 7·consumer-only 1·forward-contract 1이다. 후자만 살아있는 consumer 없이 억지 배선하면 dead-wire가 된다. 나머지는 외부 의존, 안전성, 비용, 또는 operator configuration 때문에 기본값을 유지한다.

### B-1. codex-r2 흡수 primitive — producer/seam과 조건부 live wire 혼재

| feature_id | 역할(흡수한 codex 능력) | 현황 | 왜 HELD | 코드위치 |
|---|---|---|---|---|
| codex-r2-disk-persistence-and-env-swap | logs_2.sqlite/JSONL-parity 세션 백엔드 스왑(재시작 넘어 재사용) | wired, env-off면 in-memory | `QUANTA_SESSION_REGISTRY_DISK_DIR` unset ⇒ 디스크경로 미진입 | `src/agent/session-resource-registry/global.ts:85` |
| codex-r2-mention-injection-pipeline | `@skill/plugin://@@app/@file/@Symbol` 7-sigil 파서 | `@file`은 라이브, plugin/app 활성화는 HELD | plugin discovery source 미배선 | `src/agent/mention-injection/parser.ts:287` |
| codex-r2-multi-process-flock | 세션별 O_EXCL 락+stale-reap+refcount(다중 프로세스 안전) | disk registry 선택 시 wired | `QUANTA_SESSION_REGISTRY_DISK_DIR`가 없는 기본 경로에서는 미사용; disk registry 선택·다중 프로세스 receipt가 필요 | `src/agent/session-resource-registry/disk-adapter/disk-store.ts:332` |
| codex-r2-observability-decorators | SystemPromptCache를 hit/miss 카운터로 감싸는 데코레이터 | 조건부 wired | 기본 호스트가 MetricsRegistry 미주입→auto-wrap skip | `observability/codex-r2-metrics/cache-metrics-decorator.ts:31` |
| codex-r2-plugin-system | `.codex-plugin/plugin.json` breadth-1 discovery | workspace plugin auto-wire 존재 | `<cwd>/.quanta/plugins`에 manifest가 없으면 빈 registry no-op; discovery source 부재가 아니라 실제 manifest/activation receipt가 없음 | `src/agent/plugin-activation-handler/auto-wire.ts:121` |
| codex-r2-sqlite-session-registry | logs_2.sqlite WAL-parity 내구성 레지스트리 | wired-but-unselected | `QUANTA_SESSION_REGISTRY_SQLITE_PATH` 비어있으면 미구성 | `session-resource-registry/sqlite-adapter/sqlite-store.ts:94` |
| codex-r2-system-prompt-cache-and-audit | 세션-scoped system-prompt 캐시(get_base_instructions parity) | wired | 호스트가 pre-built `system` 넘기면 우회 | `src/llm/system-prompt-cache/in-memory-cache.ts:63` |
| codex-r2-typed-event-store | append-only typed-history 이벤트 store(ADR-0319) | **wired, opt-in replay** | `QUANTA_TYPED_EVENT_REPLAY`에서 bounded append-index reader가 stored `compaction_event`만 다음 turn context에 replay; context/mention은 direct owner를 유지해 중복 주입하지 않음 | `src/agent/codex-r2-wire-install/install.ts` |
| template-literal-windsurf | windsurf식 `{{var}}` 템플릿 확장기(ADR-0252) | production consumer 없음 | barrel export는 존재하지만 production caller가 없음; 호출자를 꾸며내지 않고 playbook renderer owner가 필요 | `src/skill/playbook/template-literal/index.ts:5` |

### B-2. 리트리벌 스택 / 모델 관리 (13) — default-OFF provider/index 비용과 미소비 leaf가 혼재

| feature_id | 역할 | 현황 | 왜 HELD | 코드위치 |
|---|---|---|---|---|
| budget-probe-ledger-wire | ledger snapshot을 pipeline budget-gate용 BudgetProbe로 어댑트 | seam-only | 어셈블리서 ledger→probe DI 미배선, budget-gate 스테이지 미구성 | `src/retrieval/budget-probe/from-ledger.ts:44` |
| codebase-indexer | 워크스페이스 스캔/청킹/델타로 벡터·렉시컬 store 채움 | wired(env-gated, OFF) | provider registry와 index pipeline은 존재; index build·provider 비용·precision receipt 없이 기본 ON 하지 않음 | `src/retrieval/indexer/index.ts:21` |
| embed-cache | 임베딩 캐시 백엔드 선택(in-memory/sqlite/none) | pipeline adapter에서 소비 | semantic/hybrid preset일 때만 유효; 기본 `none`에서 cache 효과·invalidations의 운영 receipt가 없음 | `src/runner/assemble/pipeline.ts:131` |
| model-preset-sticky-resolver | opusplan식 named 프리셋(role→model)을 sticky 해석 | producer-only | 호스트 wire·`/presets` 커맨드 미구현(V1 순수 레지스트리만) | `src/llm/model-preset.ts:136` |
| model-tag-auto-hook | EmbedCache/VectorStore를 versioning invalidator 콜백으로 등록 | producer-only | 컴포지션 루트가 registrar 생성+installAll 미호출 | `src/retrieval/auto-hook/default-registrar.ts:120` ⚠️레저 경로 stale |
| model-tag-versioning | ModelTag 코덱+invalidation 콜백 레지스트리 | producer-only | 등록자(auto-hook)도 미배선→레지스트리 항상 빔 | `src/retrieval/versioning/registry-callbacks.ts:33` ⚠️레저 경로 stale |
| search-pipeline-composer | Stage[] DAG(lexical/semantic/rerank/rrf)를 SearchPipeline으로 reduce | semantic preset에서 소비 | `semantic-only`/`parallel-rrf`/`semantic-then-rerank`가 compose를 호출; 기본 ON 판단에는 corpus·provider receipt가 부족 | `src/retrieval/pipeline/semantic-only.ts:13` |
| semantic-search-port | 결정론적 headless embedder seam(삭제된 text-in port의 잔존 대체) | semantic preset에서 wired | `src/runner/assemble/pipeline.ts`가 semantic preset에 소비한다. 실제 provider/index 품질은 sibling `search-index-backend`가 소유하므로 headless 자체를 semantic-quality 증거로 승격하지 않음 | `src/retrieval/semantic/headless-embedder.ts` |
| multi-source-rules-vendor-detector | cursor/cline/roo/aider/windsurf/quanta 6소스 룰 감지·정규화 | seam-only | additive seam, 컴포지션 루트가 `detectAll` 미호출 | `src/rules/vendor-detector/index.ts:18` |
| effort-classifier | 프롬프트 키워드로 effort 분류/에스컬레이션 | **wired(env-gated)** ⚠️레저 unwired stale | `QUANTA_EFFORT_AUTO` 시 배선·소비 실존, effort ladder A/B 대기 | `src/agent/optional-ports.ts:162` |
| node-repl-persistent-kernel | 상태유지 Node.js REPL 커널(spawn/exec/list) | seam-only | agent 도구 미등록→LLM 도달 불가 | `src/runtime/node-repl/index.ts:10` |
| message-batches-client-core | Anthropic Message Batches API(50% 비동기) 씬 클라이언트 | producer-only | V1 클라이언트만(폴링루프·도구·호스트배선 없음) | `src/llm/message-batches.ts:159` |
| llm-record-replay | LLM record/replay 결정론 재생 seam | **wired(env-gated)** ⚠️레저 정정됨 | `QUANTA_LLM_REPLAY` 시 factory서 실 스트림 삽입; 테스트/벤치 전용 default-OFF | `src/llm/replay/index.ts:12` → `factory.ts:444` |

### B-3. 인프라 / 통합 / 보안 (11) — 외부 의존(creds/network/docker/platform) 필요

| feature_id | 역할 | 현황 | 왜 HELD (외부의존) | 코드위치 |
|---|---|---|---|---|
| bridge-attestation | host-bridge 액션마다 HMAC STS 토큰 mint/verify + 정책테이블 | seam-only | 프로비저닝된 32-byte+ 서명 시크릿과 preflight caller 필요; 누락/blank/weak secret은 생성 시 fail-closed | `src/security/bridge-attest/default-attestor.ts` |
| jwks-agent-identity | JWKS 클라이언트로 서명된 agent-identity JWT 검증 | forward-contract | **외부 JWKS 엔드포인트 + IdP 발급자** 필요(verify-only) | `src/security/jwks-identity/default-client.ts:48` |
| streaming-boomerang | back-pressure 단일슬롯 취소가능 스트리밍 spawn | seam-only | 실 agent loop 브리지 producer 미작성 | `src/agent/streaming-boomerang/default-streamer.ts:324` |
| streaming-cancellation-primitive | CancellationController + AbortSignal 왕복 어댑터 | **wired, host opt-in** | sampling loop이 `AgentConfig.streamCancellation`을 provider/turn signal과 cancellable stream cleanup에 실제 소비. 표준 CLI/web에는 typed cause producer가 없어 broad enable은 보류 | `src/agent/loop/stream-cancellation-wire.ts` |
| realtime-websocket-codex | Bun WebSocket RealtimePort(SDP negotiate, voices) | wired-but-gated | **realtime WS 엔드포인트 + bearer creds**(유료 provider 소켓) | `src/realtime/default-adapter.ts:351` |
| voice-input-stt-slice | sox/parec/arecord 오디오 레코더 + transcriber, `/voice` 슬래시 | **not activatable** | recorder/transcriber pair를 만드는 production composition root가 없어 mic/STT 의존을 채워도 `/voice`가 live port를 얻지 못함 | `src/apps/cli/voice-cmd.ts:341` |
| vscode-chatsessions-surface | session.v1→VS Code chatSessions 프로젝션 | **not activatable** | adapter만 있고 extension `activate()`/provider registration 및 emit artifact가 없어 VS Code host만으로 로드되지 않음 | `surfaces/vscode/src/provider.ts:57` |
| github-actions-trigger-adapter | GITHUB_EVENT_PATH 읽어 ProactiveTrigger 발사(self-loop 방어 3중) | wired | **GitHub Actions 러너 env** 안에서만 유의미 | `src/integrations/github/event-source-actions.ts:63` |
| github-pr-from-pr-cli | `from-pr` — 트리거 폴링→gh로 PR 컨텍스트→idempotent 코멘트 | standalone runner only | top-level CLI dispatcher에는 아직 등록되지 않음; `from-pr-cmd-runner`를 직접 실행하고 Actions env·gh auth·network가 있어야 동작 | `src/apps/cli/from-pr-cmd-runner.ts:1` |
| gh-pr-code-tour | `gh pr diff` 파싱해 헌크별 numbered 투어(read-only) | wired(ci-bot preset) | **gh CLI + network** | `src/tool/gh/pr-code-tour.ts:151` |
| dockersandbox | `docker run --rm` 실행 경계(--network none, bind mount) | **seam-only** ⚠️레저 정정됨 | 라이브 selector 없음(no `new DockerSandbox`). 2026-07-19 로컬 daemon contract는 통과했지만 기본 `node:22-slim`은 mutable/root/writable mount이며 CPU·memory 기본값도 없다. host Bun/git/rg 부재까지 있어 기존 bash 전역 대체는 기능 퇴행; digest-pinned hardened profile을 소유한 전용 consumer가 먼저 필요 | `src/runtime/sandbox.ts:306` |

### B-4. 패치 / 체크포인트 / git (11) — 대부분 env-gated로 배선됨, default-OFF 유지

| feature_id | 역할 | 현황 | 왜 HELD | 코드위치 |
|---|---|---|---|---|
| fast-apply-fallback | V4A apply 실패 시 side-conversation 모델로 1회 fast-apply 재시도 | **wired(env-gated)** ⚠️레저 activation stale | `QUANTA_FAST_APPLY` 시 end-to-end; default-OFF | `apply-patch.ts:626` |
| fast-apply-merge | `{original,editSketch}`를 apply-model에 보내 머지 파일 추출 | **hold, wired(host review required)** | env/model은 merge port만 만든다. host가 명시적으로 준 complete before/after `FastApplyMergeReviewSeam`은 `ToolContext`까지 전달된다. 그 seam이 없으면 provider dispatch 전에 mismatch로 fail-closed. ToolDiffSink는 post-write 관측이라 승인 권한이 아니다. | `src/agent/dispatch/tool-context.ts` |
| force-background | queued 백그라운드 서브에이전트를 즉시/FIFO-head 승격 | wired(env-gated) | `QUANTA_FORCE_BACKGROUND`+admission queue 필요 | `src/agent/subagent-background.ts:172` |
| per-tool-checkpoint-granularity | 도구별 granular 체크포인트 정책(개별 record/rewind) | **wired(env-gated)** ⚠️레저 stale | `QUANTA_PER_TOOL_RECORD`+shadowOdb, default-OFF | `src/agent/per-tool-checkpoint/index.ts:34` |
| identity-mid-session-prompt-rebuild | `/identity` 스왑 후 다음 턴 system prompt 리빌드 클로저 | consumer-only(forward-seam) | 라이브는 인라인 `buildPromptFromIdentityMode` 사용, 이 포트 caller 없음 | `src/apps/cli/repl/system-prompt-rebuilder.ts:57` |
| conflict-parser-lib | git 충돌 마커를 구조화 헌크로 파싱(순수 lib) | **wired** ⚠️레저 stale | `gitConflictInspectTool`이 소비; git 도구그룹 활성 시 도달 | `src/git/conflict-parser.ts` → `tool/git/conflict-inspect.ts:31` |
| git-directive-emit-leaf | GitDirective를 `::git-<kind>{json}` Codex 와이어 포맷으로 직렬화 | wired(leaf) | protocol 게이트와 transitively HELD | `src/agent/git-directives/serializer.ts:20` |
| git-directive-emit-protocol | `::git-*` 방출을 final-answer phase에서만 허용(phase-guard) | wired(env-gated) | `QUANTA_GIT_DIRECTIVE_EMIT` knob를 라이브 서피스가 default 미설정 | `src/git/directive-emit/phase-guard.ts:19` |
| no-patch-breaker-knob | empty-patch breaker 비활성(패치 없어도 계속) | wired(bench-only) | NOOP-apply, 벤치 driver posture서 소비 | `src/runner/knobs/knobs/no-patch-breaker.ts:14` |
| patch-hygiene-knob | 생성 diff에 patch-hygiene 리포트/정규화 패스 | wired(bench-only) | NOOP-apply, 벤치 posture서 소비 | `src/runner/knobs/knobs/patch-hygiene.ts:14` |
| compaction-visibility | 히스토리 fold 후 `postCompactEmit(provenance)` 훅 발사 | **wired, command-hooks opt-in** | `QUANTA_COMMAND_HOOKS`+ACK+`PostCompact` binding에서 CLI HookBus가 provenance를 실제 hook command로 전달. 외부 command 실행/compaction 행동 영향 때문에 default-ON 전환은 A/B·operator 결정 | `src/agent/loop/compaction-wire.ts` |

---

## 버킷 C — 수리 먼저 (repair-first, 17)

16개 모두 실제 wired product path를 가진다. 기본 활성화 전에 **켜기 전 고쳐야 할 구체 결함** 또는 컴포지션 루트 blocker가 있는 것들이다.

| feature_id | 역할 | 왜 REPAIR-FIRST (구체 blocker) | 코드위치 |
|---|---|---|---|
| apply-patch-structured-result | **Wave R에서 enable-now로 승격됨** — V4A patch의 per-op atomic/cross-op partial sibling | real-FS partial/jail receipt `25d19d89b`; 실패 target 보존 + 성공 sibling 유지가 명시적 제품 계약, `=0` rollback | `src/tool/surface/gated-tools.ts:77` |
| approval-gate-wire | ApprovalStateMachine로 도구 승인에 durable attribution ID | port 미주입 시 `approvalId=""`로 조용히 degrade; 전 서피스 SM 주입 필요 | `src/agent/approval-gate-wire/wire.ts:124` |
| appshot-verify-loop | generate→render→screenshot→judge 반복 정제 | CDP+judge assembly는 존재; Chrome/provider 실운영 receipt와 반복 비용 policy가 없음 | `src/host/runtime/agent-config-assembler.ts:345` |
| branch-search-progress | N개 branch-search 후보를 Shadow-ODB에 anchor, git delta 측정 | delta는 scoring/selector에서 소비됨; winner selection의 efficacy·cost가 기본 ON blocker | `src/agent/branch-search/tool.ts:161` |
| collect-evidence | run_tests/DAP/LSP/git를 하나의 EvidencePacket으로 융합 | 도구는 always-confirm으로 wired; untrusted repo 자식프로세스의 sandbox/allowlist posture를 확정해야 함 | `src/tool/evidence/tool.ts:104` |
| command-hooks | 디스크 설정 shell 훅을 도구 이벤트에 실행(Claude식) | armed/ack·provenance·permission core는 존재; 남은 blocker는 review-port/`/hooks` UX 및 운영 receipt | `src/agent/command-hooks/runner.ts:211` |
| ndjson-introspection | 이벤트→NDJSON 인코더+ring-buffer sink(Cursor식) | file+loopback HTTP adapter와 CLI session producer가 존재; 운영 endpoint/retention policy가 기본 ON blocker | `src/apps/cli/repl/ndjson-wire.ts:45` |
| ratelimit-dual-window-snapshot | Codex dual-window 쿼터 헤더 파싱 | loop parser/meter는 소비됨; `createAccountRateLimitStore`만 production consumer가 없어 한 row에 두 seam이 섞여 있음 | `src/agent/loop/stream-consume.ts:195` |
| recovery-router-codex-spec | LLMErrorKind→Codex-spec RecoveryAction 라우팅(단일 retry 권위) | outer loop가 router를 소비함; `not_implemented`를 retry할지 terminal로 둘지의 semantic policy를 결정해야 함 | `tests/unit/recovery-router-consumer-wire.test.ts:45` |
| response-in-progress | Codex `response.in_progress` 하트비트를 StreamEvent로 | Codex가 이 이벤트를 조용히 drop(forward-compat gap); provider 미방출 | `src/llm/streaming-events.ts:53` |
| run-ledger-attribution | post_tool_use서 run ledger(start/touch/settle) 구동 | observability wire가 구독함; `QUANTA_OBSERVABILITY`+HookBus 조건에서의 cost/behavior가 기본 ON blocker | `src/agent/observability-wire/wire.ts:273` |
| shadow-verify | 패치를 scratch overlay에 적용해 lint/type/test(commit 전 verify) | real scratch-worktree/V4A/LSP-test adapter가 wired; mutation·시간·resource policy와 production receipt가 기본 ON blocker | `src/agent/shadow-verify-adapters/index.ts:35` |
| structured-output-mode | JSON-Schema response_format 부착 + no-throw 검증 | provider adapter(OpenAI/Anthropic)는 구현됐지만 standard CLI/web/agent surface가 `responseFormat`을 공급하지 않아 **product gate-on 경로 없음**; SDK caller용 port만 동작 | `src/llm/anthropic-messages-codec.ts:256` |
| subagent-fs-ownership-enforce | 서브에이전트 소유 서브트리 밖 write 거부(canonical path) | child config가 policy를 만들고 dispatch가 hard-deny함; broad default activation의 compatibility policy를 정해야 함 | `src/agent/subagent/dispatch.ts:327` |
| subagent-resume-replay | 중단된 서브에이전트 핸들을 재시작 시 re-fork(replay) | session execution plane의 live gate가 consumer; legacy handle depth-guard migration policy가 blocker | `src/runner/session-execution-plane.ts:207` |
| syntax-aware-chunking | outline-first read(시그니처+skeleton)로 구조맵 | production tree-sitter adapter wire와 real-WASM integration이 존재; grammar coverage/unsupported grammar fallback policy가 blocker | `src/runner/assemble/tooling.ts:249` |

---

## 재감사 결과 — 구현 품질과 promotion 증거는 별개 (2026-07-18)

이번 재감사는 레저 ID 전수와 production consumer, owner-local test를 대조했다. `wired`는 **조립 경로 존재**만 뜻하며, efficacy·운영 내구성·default-ON 적합성을 뜻하지 않는다. 따라서 아래 결과는 기본값을 자동으로 뒤집지 않는다.

전 173개 eligible row의 reachability·ON/OFF proof tier·receipt 유무는 [per-feature audit matrix](backlog-audit-matrix.md)에 고정했다. 이 매트릭스가 기능별 “잘 만들어짐”의 현재 증거 상한이다.

| cohort | 구현/소비 상태 | 증거 품질 | 판정 |
|---|---|---|---|
| measure-first 50 | 50/50 wired | ON real-loop 9, wire 18, unit 23; 모든 receipt null | 구조상 built이지만 efficacy A/B 및 production receipt 없음 |
| hold 46 | wired 26, dormant 20(seam 11/producer 7/consumer 1/forward 1) | 모든 receipt null | hold를 미배선으로 일반화 금지; wired 행은 default-policy/external/operator 조건을 따로 판정 |
| repair-first 17 | wired 16, seam 1 | 13 focused suites 154 pass / 0 fail | 다수의 “미배선” blocker는 stale이었다. 남은 것은 안전성·semantic policy·composition-root·운영 receipt 문제 |

### 확인된 수정

- A는 `pipeline-composition-root-wire` 누락을 보완해 50/50 레저 커버리지를 맞췄다.
- `bench-find-refs-steer`에는 실제 ON/OFF composition test가 있어 proof tier를 `wire`로 정정했다. 효과 크기/bench receipt는 여전히 없다.
- `item-stream-fine-grained`는 CLI에서도 `/activity`와 attach renderer가 소비한다. “CLI inert” 주장은 제거했다.
- B의 plugin activation, disk/sqlite registry, retrieval pipeline/cache/compose, template literal과 C의 appshot, NDJSON, recovery, shadow verify, structured output, ownership, resume, syntax-aware chunking은 기존의 “미배선/없음” 설명이 실제 소비 경로와 맞지 않아 위 행에서 교정했다.

### 아직 잘 만들어졌다고 말할 수 없는 지점

- 이 감사 스냅샷 당시 113개 전 행의 `proof.receipt`가 null이었다. Wave R에서 `apply-patch-structured-result`가 첫 명시적 promotion receipt를 얻었고, 나머지 null 행에 대해서는 여전히 레저 체커의 schema·커버리지·CLI seed parity만으로 ON runtime efficacy나 external dependency 실행을 주장하지 않는다.
- `apply-patch-structured-result`의 partial-apply는 Wave R에서 명시적으로 promotion됐다. whole-patch atomicity는 기존 `apply_patch`, per-op atomic/cross-op partial + targeted retry는 `apply_patch_structured`가 소유한다. real-FS 실패-target byte 보존과 jail escape 격리는 receipt `25d19d89b`로 고정됐다.
- `approval-gate-wire`는 state-machine request 실패 시 legacy resolver fallback을 허용한다. durable approval attribution을 보안 통제로 승격하기 전 strict fail-closed surface policy가 필요하다.
- `collect-evidence`, command hooks, shadow verify, appshot은 untrusted repo 실행·mutation·Chrome/provider cost가 걸려 있어 real external receipt와 permission/sandbox policy 없이는 default-ON 후보가 아니다.
- Stage1 V2 reuse duplicate는 제거됐다. SQLite lifecycle과 canonical Phase2 DI는 `buildSessionMemoryAutoWires`의 `@/memory/consolidate` store만 소유한다; vendor glob은 독립된 live `QUANTA_VENDOR_RULES` feature다.

### 단순 gate-on readiness 재감사

`gate=1`만 설정했을 때의 판정은 기존 proof tier와 다르다. production composition root까지 trace하고 focused rail을 실행한 결과는 다음과 같다.

**범위:** ledger eligible **173/173 feature ID**를 owner seam, production caller, activation condition, existing rail로 대조했다. `PASS`는 gate/기본값이 production consumer까지 도달함을 뜻하고, 성공 결과가 특정 입력·provider·platform에 달린 경우는 `CONDITIONAL`, consumer/selector가 없는 경우는 `NOT ACTIVATABLE`, host-turn receipt가 약한 경우는 `PROOF GAP`으로 보류했다.

- **바로 조립 경로에 도달 (대표 PASS):** adaptive thinking, language detect, edit repair, env probe, projects KB, run workflow, subagent mailbox, approval/run-ledger/shadow verify, retrieval indexer, recovery router, code mode, manifest compat, worktree. 단, 동작이 실제로 발화하려면 해당 입력(예: failed edit, rate-limit header, subagent message)이 필요할 수 있다.
- **조건부:** semantic pipeline/cache는 preset·index·provider 조합, replay는 cassette path, fast apply는 model, per-tool checkpoint는 `QUANTA_PER_TOOL_RECORD`+`QUANTA_SHADOW`, MCP/PTY/image/debug/GitHub/realtime는 trusted server·binary·credential·network·TTY가 필요하다. 조건이 없을 때 typed failure/no-op으로 끝나는지가 정상 동작이다.
- **단순 turn-on 불가 (production selector/consumer 없음):** `bridge-attestation`, `jwks-agent-identity`, `dockersandbox`, `voice-input-stt-slice`, `streaming-boomerang`, `budget-probe-ledger-wire`, `model-preset-sticky-resolver`, `model-tag-auto-hook`, `model-tag-versioning`, `node-repl-persistent-kernel`, `message-batches-client-core`, `dxt-user-config`, `vscode-chatsessions-surface`, `prefix-rule-dsl`, `structured-output-mode`.
- **구현은 있지만 현재 broad enable 금지:** `three-way-restore`는 tag-selected file restore를 SHA-pinned fail-closed로 수리했지만, `QUANTA_PER_TOOL_RECORD`+`QUANTA_SHADOW`와 명시 `/rewind-tool` 호출이 필요한 파괴적 opt-in이다. `identity-mid-session-prompt-rebuild`는 해당 module 자체는 unconsumed이지만 별도 inline identity refresh path가 live다. 후자를 기능 부재로 오판하면 안 된다.
- **proof gap (조립/단위 rail만 확인):** bench knob 다수, session prewarm, stale-read guard, subagent tool variants, team coordination, tool interrupt block, untrusted envelope, surface-wire-r2. 이들은 false-wired로 판정하지 않았지만, real host-turn activation receipt 전에는 “켜면 잘 돈다”는 결론을 보류한다.

실행한 focused rail은 core/CLI 186 pass, retrieval/session 56 pass, external/security 215 pass였고 모두 0 fail이다. 단일 suite 중 unrelated catalog guard는 `QUANTA_OBJECTIVE_TOOLS` uncatalogued와 `QUANTA_COVERAGE_TOOL` stale bookkeeping 때문에 RED이며, activation rail의 실패로 계산하지 않았다.

**검증 명령:** `bun tools/feature-catalog/default-off-ledger-checker.ts`, `bun test tests/unit/default-off-ledger-hellgate.test.ts`, 그리고 repair-first owner rails 13개(154 pass / 0 fail). 이 문서의 행 설명만 수정했으며, decision/reachability 재분류는 레저 owner가 별도 change와 red-on-injection rail로 처리해야 한다.

---

## 경쟁사 비교

> **출처 상태:** 아래 표의 인용 없는 경쟁사 구현 세부는 재검증 전 가설이며 roadmap 근거로 쓰지 않는다. 이번에 공식 문서로 재확인한 사실은 Claude의 `autoCompactEnabled`·file checkpoint 기본값과 Cursor의 project-open 자동 indexing뿐이다. Codex 내부 저장 형식/rollout 동작은 공개 인용이 추가되기 전까지 비교 가설로 유지한다.

### Claude Code

| capability | Claude Code | 시사점 |
|---|---|---|
| Extended/adaptive thinking | **default-ON(auto)** — interleaved-thinking, trigger-word로 budget 상향 | quanta는 opt-in(adaptive-thinking); tool_use 간 interleaved default-ON seam 검토 |
| Cross-session memory | **default-ON** — CLAUDE.md 계층 자동로드+@import+`#` quick-add | quanta도 opt-out(memory-auto) 보유; 계층/team-share 모델 정합만 확인 |
| Auto-compaction | **default-ON** — `autoCompactEnabled` 기본값 true ([official settings](https://docs.anthropic.com/en/docs/claude-code/settings)) | quanta compaction이 opt-in이면 default-ON 검토 |
| Pre-compact 승인 | **opt-in(훅 등록 시)** — PreCompact 훅 | quanta pre-compact-hitl과 대응, opt-in observer로 |
| 라이프사이클 훅 | **opt-in** — PreToolUse/PostToolUse/SessionStart/SubagentStop/UserPromptSubmit... | quanta command-hooks와 대응; 이벤트 카탈로그 갭 점검 |
| Checkpoints & rewind | **file checkpoint default-ON** — edit 전 snapshot. code rewind는 history를 유지하고, conversation branch는 fork한다; in-place “conversation/both 복원”으로 단정하지 않음 ([official IDE docs](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)) | quanta는 file-checkpoint opt-in; file restore와 conversation fork를 분리해 설계 |
| Subagents | **default-ON** — Task 도구 상시+`/agents` 커스텀 | quanta subagent orchestration 랜딩됨; 정의 UX 비교 |
| MCP annotations | **default 소비** — readOnlyHint로 permission 완화 | quanta가 미반영이면 갭(우리 mcp-tool-annotations가 그것) |
| OS sandbox/permission | permission mode default-ON(ask), OS sandbox opt-in | quanta os-sandbox와 대응; 4-mode 매핑 점검 |
| Per-hunk accept/reject | 파일/edit 단위가 default, per-hunk는 제한적/unverified | quanta per-hunk가 잠재 우위 seam |

### Codex

| capability | Codex | 시사점 |
|---|---|---|
| Reasoning carryover | **default-ON** — 매 턴 reasoning item(encrypted)을 rollout+다음 input에 re-feed | quanta는 Anthropic 기반이라 개념 부재; codec 확장 필요(우리 reasoning-carryover가 그 시도) |
| Typed event/session store | **default-ON** — archived_sessions/*.jsonl authoritative + logs_2.sqlite | quanta jsonl-recorder는 RECORD opt-in+retention 없음; turn_context 스냅샷이 더 풍부 |
| Durable session registry | **default-ON** — state_5.sqlite threads+resume_picker TUI | **quanta 최대 gap** — InMemory뿐(durable event log 부재) |
| Multi-process locking | **default-ON(암묵)** — config/sqlite lockfile | quanta 단일프로세스 가정; 다중 surface durable화 시 필요 |
| Plugin discovery | **default-ON discovery** — .codex-plugin, 서명검증 비활성 | quanta 동형 스키마 채택+Ed25519 서명은 우리가 더 엄격 |
| @-mention injection | **default-ON** — 12-field attachment envelope+IDE selection | quanta는 CLI중심이라 IDE/browser context 채널 얇음 |
| Message Batches API | **미사용(N/A)** — Responses API 동기 스트리밍만 | 둘 다 대화형이라 무관(우리 message-batches도 흡수대상 아님) |
| Realtime WS/voice | **opt-in** — WebRTC+server VAD, mute=text injection | ★흡수가치 높음 — Tauri WebView surface에 out-of-band injection 패턴 |
| Effort ladder | **default 있음, per-turn 조정** — effort low/med/high turn_context 스냅샷 | quanta effort-ladder는 bench-only default-OFF; 일반 턴 상시화가 방향 |
| System prompt cache | **default-ON** — base_instructions 세션 스냅샷+content-hash | quanta는 3축 조립 parity 있으나 명시 세션 스냅샷 캐시는 improvement seam |

### Cursor

| capability | Cursor | 시사점 |
|---|---|---|
| Semantic indexing | 프로젝트를 열면 indexing 자동 시작 ([official docs](https://docs.cursor.com/get-started/installation)); backend/re-index 세부는 별도 출처 필요 | quanta의 semantic/hybrid pipeline은 존재하나 기본 ON precision·cost receipt가 없어 gap은 측정 후 판정 |
| Embedding cache/re-index | **default-ON** — Merkle-tree 델타만 재임베딩 | quanta는 임베딩 자체 부재; 도입 시 Merkle 델타 참조 |
| Fast Apply | **default-ON** — 전용 apply 모델(Codestral-rewrite 등) | quanta는 도구기반 정확 edit 철학; 속도 UX용, correctness와 별개 |
| Edit-repair loop | **default-ON** — applyFailed→REAPPLY 스트림 | quanta edit는 fail-loud; 우리 edit-repair-loop가 흡수 후보 |
| Per-hunk accept/reject | **default-ON** — 인라인 diff 헌크 단위(HUNKING_STRATEGY) | quanta 멀티서피스라 per-hunk UX 약함(우리 per-hunk-diff가 그것) |
| Background agents | **opt-in** — cursor-agent-worker 원격 detached | quanta는 in-process/queue orchestration; Cursor는 원격 detached |
| Git worktree isolation | **opt-in** — 병렬 에이전트를 worktree 격리 | quanta는 자체 미제공(우리 worktree-tool이 그 방향) |
| Reply-language 감지 | **default-ON(추정)** — whichlang+DetectLanguage | quanta 명시 로직 없음(우리 language-detect가 그것); 한국어 유저 대비 |
| Prompt/next-action 제안 | **default-ON(모드형)** — FollowUp(all/plan/execute)+Tab prediction | quanta goal-pursuit 있으나 "다음액션 칩" 약함(우리 prompt-suggestion) |
| @-mention context | **default-ON** — @file/@symbol/@Docs/@web/@codebase | quanta 도구기반 위주; Web surface에 인라인 @-멘션 흡수 후보 |

---

## 조사 중 발견된 레저 드리프트 (후속 정리)

소스대조로 확인된 **레저 필드 오류**. 이번에 metric 움직이는 2건은 정정 완료(상쇄=net 0), 나머지는 cosmetic이라 후속 정리 백로그.

- ✅정정됨: `llm-record-replay` reachability consumer-only→**wired**(factory.ts:444 라이브 소비 확인, +1)
- ✅정정됨: `dockersandbox` reachability wired→**seam-only**(`new DockerSandbox` 프로덕션 콜러 0, −1)
- ⬜후속: `effort-classifier`·`fast-apply-fallback`·`per-tool-checkpoint-granularity`·`conflict-parser-lib`·`ratelimit-dual-window`·`run-ledger-attribution`·`subagent-resume-replay` — activation 필드가 `unwired`인데 실제 라이브 소비자 있음(reachability는 이미 wired라 metric 무영향, activation 라벨만 stale)
- ⬜후속: `model-tag-auto-hook`/`model-tag-versioning` owner_seam 경로 stale(`src/retrieval/model-tag/`→실제 `auto-hook/`+`versioning/`)
- ⬜후속: `template-literal-windsurf` — barrel export는 있으나 production caller가 없음; "barrel 미노출=unreachable" 설명을 "unconsumed leaf"로 정정

---

## 시사점 — operator가 실제로 결정할 것

**1. efficacy A/B 돌릴 후보 (measure-first 중 제품 영향 있는 것)** — 벤치박스서 A/B, f2p 오르면 default-ON:
- `adaptive-thinking`·`edit-repair-loop`·`reasoning-carryover`·`memory-cross-session`(bench 오염 역검증)·`subagent-read-inbox` — 경쟁사 전부 default-ON인 축(thinking/memory/edit-repair)이라 ROI 가능성 높음.
- 벤치 knob 14종 — 이미 preset에 일부 탑재, operator가 knob-sweep A/B.

**2. 경쟁사 대비 진짜 gap (신규 작업 후보, ROI순)**:
- ★ **Durable session registry/resume** (Codex default-ON, quanta InMemory뿐) — jul-16 어딧서도 "온디스크 이벤트로그 부재"가 진짜 병목으로 지목. codex-r2-sqlite-session-registry가 이미 BUILT(seam), 컴포지션 루트 배선만.
- ★ **Semantic codebase index** (Cursor default-ON, quanta 부재) — semantic-search-port+embed-cache+indexer 체인 BUILT지만 라이브 임베딩 provider 미배선. semantica-codegraph가 후보(precision 미측정=measure-first).
- ○ **Realtime WS/voice** (Codex opt-in) — Tauri WebView surface에 흡수가치, transport-unified SDK가 WS door 여는 중.

**3. 그대로 둘 것 (건드리면 손해/gaming)**:
- observability trio(LLM 도구 4개 주입=behavioral leak) · passive-vcs(base 스트림 변형=bench 재현성) · 벤치 knob의 무근거 flip.
- 외부의존 hold(jwks/bridge/docker/voice/github) — creds/network/platform 없으면 실행 불가, forward-contract로 보존이 정답.
