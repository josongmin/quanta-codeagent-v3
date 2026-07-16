# default-OFF 게이트 전수 어딧 인벤토리 (2026-07-16)

목적: fc 카탈로그 기준 default-OFF 게이트 기능 전수 → **src 실코드 대조 어딧** → e2e 검증 후 켜기(or kill) 캠페인의 supporting inventory. 실행 SSOT는 `docs/plans/jul-16-default-off-sota-plus-plus/00-index.md`다.

방법: 카탈로그 yaml 1차 스캔(8-way) → src 대조 2차 어딧(11-way 병렬): 게이트 실존(파일 확인)·unset시 실제 default·배선 상태·ON경로 테스트 유무·CLI_FEATURE_GATES seed 여부. **카탈로그 prose는 신뢰하지 않고 게이트 코드 사이트를 직접 확인함.**

## 판정 체계 (3R 교정)

기존 A/B/C/D/X는 activation, surface default, wiring, proof, lifecycle을 한 글자에 섞어 flip/delete 판단에 사용할 수 없다. 아래 표의 기존 class는 탐색용 legacy grouping일 뿐이며, 실행 권위는 다음 5축 ledger다.

| 축 | 값 |
|---|---|
| activation | `always` · `inverse-kill-switch` · `env/config` · `host-seeded` · `preset` · `resource/command` · `port-present` · `unwired` |
| effective default | surface별 `on` · `off` · `resource` · `na` · `unknown` (`cli/web/bench/headless/daemon`) |
| reachability | `wired` · `producer-only` · `consumer-only` · `seam-only` · `forward-contract` |
| proof | `unit` · `wire` · `real-loop` · `external-e2e` + 별도 `off_identity`/rollback receipt |
| decision | `enable-now` · `measure-first` · `repair-first` · `hold` · `delete-proven-duplicate` |

삭제는 `production consumer 0 + 고유 behavior 0 + superseded_by/sunset 증거`를 모두 요구한다. built-not-wired, e2e 부재, roadmap 부재만으로는 삭제하지 않는다. 기존 대략 집계와 85/85 수치는 재현 가능한 feature-to-test ledger가 없어 promotion 근거로 사용 금지다.

## 크로스커팅 findings (어딧에서 나온 것)

1. **CLI effective-default seed 27종**: `CLI_FEATURE_GATES` 19 behavior gates와 tool-surface manifest의 CLI-default 8 tool gates를 CLI entrypoint가 합성한다 ([index.ts:42](../../src/apps/cli/index.ts#L42)). 따라서 19종만 센 기존 모수는 과소 집계다. 이 seed는 interactive CLI 기준이며, 각 non-CLI surface는 별도로 계산해야 한다.
2. **default-ON/가용성 오분류 클러스터**: QUANTA_SUBAGENT/QUANTA_SKILLS `?? true` (internal.ts:335/406) → 시스템 스킬 번들 6종·subagent 블록은 이미 라이브. QUANTA_FS_JAIL은 **역게이트**(기본 ON, `=off`로 끔). scripted_replace/grep-flags/bash-background/atomic-write는 항상 라이브지만, **gh_pr_*는 always-ON이 아님**: GitHub surface는 `QUANTA_GIT_TOOLS` opt-in이고, `gh_pr_open`은 추가로 `authorLLM + gitRunner` 배선이 있어야만 등록됨.
3. **bench measure-first인데 preset 선탑재**: `QUANTA_BENCH_LLM_SELECT`·`LOCATION_FANOUT`이 이미 agentless-v7-oracle-multifile 프리셋에 들어감(jun-30 RFC 승인) — "measure-first hold" 서사는 이 둘에 한해 이미 무효.
4. **reachability 교정**: prompt-suggestion은 CLI turn-completion에서 호출되는 live opt-in이고, plan-queue와 `/profile`도 live다. recovery-router·lane-manager·bug-fix-proposal-queue는 production caller가 없는 seam-only다. playbook-trigger는 confined disk registry에서 실제 registration을 로드해 external prompt queue까지 dispatch한다.
5. **surface 상태 오분류 수정**: `0315 web-daemon-surface`는 L3 + `surface_integration.web: full`, `0316 web-frontend-surface`도 L2지만 `surface_integration.web: full`이다. D(hold)로 묶을 대상이 아니며, **hold 성격이 남는 건 `0317 tauri-desktop-shell`의 scaffold/unverified 상태뿐**.
6. **read 계열 분리**: syntax-aware index chunking은 production indexer가 parser를 주입한다. read-outline도 이제 `QUANTA_READ_OUTLINE=1`일 때 runner composition root가 tool-local parser port를 주입하며, 별도 `QUANTA_SYNTAX_CHUNK` gate와 독립적으로 동작한다.
7. **P0 web 기본값 모순 해결**: daemon 기본 bind는 `127.0.0.1`로 교정됐다. IPv4/IPv6 wildcard는 non-empty token 또는 strict `QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD=1` 없이는 listen 전에 fail-closed한다.

---

## A — WIRED + e2e 있음 (바로 flip 후보, ~75)

| 기능 | 섹션 | 게이트 | ON경로 테스트 | 켜는 법 / 비고 |
|---|---|---|---|---|
| closeout-critic-gate | 01 | QUANTA_CLOSEOUT_CRITIC | closeout-critic-hellgate (runAgent) | =1; fail-open |
| cap-enforcer | 01/07 | QUANTA_CAP_ENFORCE | next-action-cap-enforce | =1; dispatch 배선 확인됨 |
| prompt-directive-bundle | 01 | QUANTA_DIRECTIVE_* ×7 + QUANTA_ADVISOR_RAIL | prompt-directives-hellgate + byte-identity | knob별 =1; dynamic slot만 변경 |
| language-detect | 01 | QUANTA_LANG_DETECT | language-hint-prompt-hellgate | =1 |
| refusal-fallback-recovery | 01 | QUANTA_REFUSAL_FALLBACK(+_PROMPT) | refusal-fallback-recovery-hellgate (runAgent) | =1 |
| subagent-agent-type | 01 | QUANTA_SUBAGENT_TYPED_KIND | typed-kind-live-wire-hellgate | =1 |
| subagent-fs-ownership-enforce | 01 | QUANTA_FS_OWNERSHIP_ENFORCE | ownership-dispatch-e2e-hellgate | =1 |
| subagent-introspect-tools | 01 | QUANTA_SUBAGENT_INTROSPECT | subagent-introspect-hellgate + turn-wake | **CLI effective-default ON**; flip 후보에서 제외 |
| subagent-model-override | 01 | agent tool input(model/role/effort) | spawn 테스트 | 입력 필드; env 없음 |
| subagent-role-identity | 01 | .quanta/agents/*.md | named-agent-spawn-hellgate | 정의 파일 존재 시 자동 |
| branch-search-progress | 01 | DI(BranchSearchAnchor) | anchor-hellgate | caller 주입형 |
| conversation-action-steering | 01 | DI + QUANTA_CONVERSATION_ACTIONS | smoke 13/13 | ⚠️seed로 CLI 이미 ON |
| async-tools + deferred-registry | 02 | QUANTA_ASYNC_TOOLS (+DEFERRED_CAP) | async-tool-dispatch-hellgate | =1; sqlite persistence는 후속 |
| browser-automation | 02 | QUANTA_BROWSER_TOOL(+NETWORK) | browser-agent-loop-e2e | =1 + Chrome 바이너리 필요 |
| code-mode-js-runtime | 02 | QUANTA_CODE_MODE (strict =1) | code-mode-real-quickjs + full-surface-e2e | strict; +CODE_MODE_ONLY 페이즈3 |
| collect-evidence | 02 | cfg.evidence (내부 슬롯) | keystone-real-e2e (실 LSP+DAP) | env 아님 — 컴포지션 플래그; HIGH-RISK always-confirm |
| debug-inspect | 02 | cfg.debugTools (내부 슬롯) | debugpy-real-e2e | 상동 |
| git-co-change | 02 | QUANTA_GIT_CO_CHANGE (+GIT_TOOLS) | longtail-new-tools-e2e | =1 |
| per-hunk-diff-accept-reject | 02 | QUANTA_HUNK_APPROVAL | e2e-pty/cli-hunk-approval | =1 |
| radar-cards | 02 | QUANTA_RADAR | radar-e2e-hellgate | =1; /radar |
| run-tests | 02 | test-runner knob(QUANTA_TEST_RUNNER) | run-tests-real-e2e (cargo/go/py 실검증) | HIGH-RISK |
| run-workflow | 02 | QUANTA_WORKFLOW | workflow-e2e-hellgate | =1 + subagent 필요 |
| mcp-server-reverse | 02 | QUANTA_MCP_SERVER (strict =1) | server hellgate 배터리 | `quanta mcp-server` |
| 0061-remember-patterns | 03 | QUANTA_REMEMBER_PATTERNS | remember-patterns-cascade-hell (integration) | =1 |
| remember-patterns-dangerous | 03 | +QUANTA_REMEMBER_PATTERNS_DANGEROUS | dangerous-knob-hellgate | 부모 knob도 필요 |
| 0438-permission-profiles | 03 | QUANTA_PERMISSION_PROFILES_JSON | profile-inheritance-wire-hellgate | JSON 인라인 |
| 0455-local-environments | 03 | QUANTA_LOCAL_ENV | local-env-wire-hellgate | .quanta/environment.toml |
| 0498-central-config-trust | 03 | QUANTA_CENTRAL_CONFIG (strict) | central-config-trust-hellgate ×4 | =1 |
| jun6-sandbox-escalation | 03 | QUANTA_SANDBOX_ESCALATION(+MAX) | sandbox-escalation-real-loop-e2e | =1 |
| jun6-exfil-write-budget | 03 | QUANTA_WRITE_BUDGET(+MAX) | exfil-rails-dispatch-wire | ⚠️UNTRUSTED_ENVELOPE는 seed로 CLI ON |
| jun6-secret-egress | 03 | QUANTA_SECRET_EGRESS(+MAX_BODY) | secret-egress-proxy-e2e | plaintext만; HTTPS는 D(TLS-MITM) |
| network-egress-enforcement | 03 | ModePolicy.network (mode 파생) | network-egress-wiring-hellgate | ci-bot 등 batch mode에서 활성 |
| pluggable-embedder-store | 04 | QUANTA_EMBED_PROVIDER + QUANTA_VECTOR_STORE | lance-real-wire (contract, 실 lancedb) | 둘 다 설정 |
| semantic-index-real-embedder | 05 | 동일 pair | search-pipeline-lance-wire | 미설정=hashEmbed 폴백 |
| codex-2-phase-consolidator | 05 | AgentConfig.memoryConsolidator | consolidate-phase2-end-to-end | config 주입형 |
| 0138-budget-ledger | 06 | cfg.budgetLedger | budget-ledger-hellgate | config 주입형 |
| 0145-background-subagent | 06 | QUANTA_SUBAGENT_BG | subagent-background-hellgate | =1 |
| 0219-focus-chain | 06 | focusChainEvery | focus-chain-loop-seam-e2e | env/args |
| 0223-stuck-detector | 06 | cfg.autoBackground.detector | stuck-detector-real-loop-e2e | config 주입형 |
| 03-plan-mode | 06 | cfg.planStore | 14 unit 파일 (integration 無 — 준A) | config 주입형 |
| ai-session-title | 06 | QUANTA_SESSION_AUTO_TITLE + _MODEL | byok-reachability 포함 3종 | 둘 다 필수 |
| 0228-queue-mutators | 06 | /queue | queue-cmd-hellgate | 항상 컴파일, 호출시만 효과 |
| session-rewind-fork | 06 | QUANTA_REWIND(+_GIT) | session-rewind-e2e | ⚠️0297에선 REWIND 기본ON 주장 — flip 전 확인 |
| skill-scope-v2 | 06 | QUANTA_SKILL_SCOPE_V2 | escalation unit + web pending-approvals | =1 |
| runner-persist-turn | 06 | QUANTA_STATE_PATH / idMeta | resume-e2e | 둘 다 OFF면 no-op |
| adversarial-multi-voter | 07 | QUANTA_MULTI_VOTER | multi-voter-hellgate | branch-search 한정 |
| image-history-sanitization | 07 | cfg.imageSanitizationRetry.enabled | wrapping.hellgate | config 주입형 |
| edit-repair-loop | 07 | QUANTA_EDIT_REPAIR_LOOP (strict) | edit-repair-loop-hellgate | =1 |
| ratelimit-snapshot(proactive) | 07 | QUANTA_RATELIMIT_PROACTIVE | reachability-hellgate | =1 |
| session-resilience | 07 | QUANTA_CRASH_RESUME(+_PARTIAL) | crash-resume-wire (integration) | ADR-0528 LIVE |
| adaptive-thinking | 08 | QUANTA_ADAPTIVE_THINKING | adaptive-thinking-hellgate | =1; 4.6+ 모델만 adaptive |
| brief-mode | 08 | QUANTA_BRIEF / /brief | brief-mode-hellgate + slash | |
| context-1m-window | 08 | QUANTA_CONTEXT_1M / [1m] suffix | context-1m-factory-e2e | Anthropic만 |
| prompt-cache-1h-ttl | 08 | QUANTA_PROMPT_CACHE_TTL=1h | ttl-codec-hellgate | 모델 allowlist 폴백 안전 |
| reasoning-carryover | 08 | QUANTA_REASONING_CARRYOVER | carryover-live-e2e | OpenAI-Responses만 |
| session-effort-wire | 08 | QUANTA_EFFORT / /effort | session-effort-precedence (integration) | |
| byok-apikey-helper | 08 | 3중: LEGACY_VENDOR + HELPER + TRUSTED | byok-apikey-e2e | anthropic/openai만 |
| live-usage-counter | 08 | liveUsage (TTY 자동) | slice 테스트 | 사실상 TTY-auto |
| b5-notify-presence | 08 | QUANTA_NOTIFY_PRESENCE | notify-presence-wire.hellgate | fail-open |
| debug-tracer | 08 | QUANTA_DEBUG / /debug | debug-tracer-hellgate | TTY-only |
| decision-counter-sink | 08 | QUANTA_DECISION_METRICS | decision-counter-hellgate | 18 시계열 고정 |
| permission-otel-recorder | 08 | setPermissionRecorder (구성됨) | permission-otel-emit-hellgate | runtimeContext가 이미 등록 |
| session-transcript-retention | 08 | QUANTA_SESSION_TRANSCRIPT_MAX_BYTES | retention-e2e-hellgate | bytes 지정 |
| sticky-model (store+consume) | 08 | config.stickyModelStore | loop-sticky-model (integration) | SET 서피스(/slash) 미완 |
| reactor self-wake + trigger | 09 | QUANTA_PROACTIVE_REACTOR | reactor-babysit-end-to-end | =1; CLI 한정 |
| llm-provider-fork + phase2 | 09 | QUANTA_LLM_TRANSPORT | bedrock/vertex 실스트림 hellgate ×7 | bedrock\|vertex\|foundry |
| github-webhook host | 09 | QUANTA_GITHUB_WEBHOOK=1(+SECRET) | webhook-reactor-e2e-hellgate | `quanta webhook` |
| mcp-auto-restart | 09 | QUANTA_MCP_AUTORESTART | reconnect/supervisor.hellgate | =1 |
| heartbeat-eligibility | 09 | QUANTA_AUTORUN_POLICY | heartbeat-eligibility-hellgate | never\|on-request\|on-failure\|always |
| 215-automation-engine | 09 | (lib; QUANTA_AUTOMATION 경유) | automation-engine-hellgate | 0279로 배선 |
| observability-ws-sink | 09 | QUANTA_OBSERVABILITY=on | ws-sink-hellgate ×14 | web-daemon |
| cli-attach-daemon | 10 | `quanta attach` (+AUTH_TOKEN) | attach-e2e (실 데몬 loop) | 게이트 없음, 서브커맨드 |
| cli-jun11-turn-input-layer | 10 | QUANTA_LLM_REPLAY | e2e-pty ×2 | 카세트 경로 지정 |
| completion-notify | 10 | QUANTA_NOTIFY=bell\|title | completion-notify-live-e2e | TTY만 |
| thread-follower-cocontrol | 10 | QUANTA_THIN_CLIENT_DISPATCH | cocontrol-hellgate + registry 계약 | web-daemon은 hardwired |
| 0123/0291/r10-ports | 10 | 포트주입형 (env 없음) | 각 wire-hellgate | 서피스가 포트 주입 시 slot 노출 |
| bench 10종 (adversarial-repro, fault-evidence, localize-phase, no-patch-breaker, patch-hygiene, primary-rail, proof-closure, repair-escalation, retry-transient, verification-plan) | bench | QUANTA_BENCH_* | wiring hellgate + preset-drives-config | v6-closure/v7 프리셋에 앵커됨; 효능은 A/B 필요 |

## B — WIRED, ON경로 e2e 없음 (~75) → **e2e 만들고 켜기**

| 기능 | 섹션 | 게이트 | 비고 (e2e 갭) |
|---|---|---|---|
| mid-turn-steering | 01 | loop 내장 (env 없음) | unit뿐; turnKind 주입 e2e 없음 |
| dispatch-guard-wiring | 01 | config.dispatchGuard | loop e2e 없음 |
| idle-monitor-snooze | 01 | QUANTA_IDLE_* | ⚠️SUPPRESS 기본 "1" — 사실상 ON. CLI 전용 |
| subagent-multi-agent-bounds | 01 | config.subagent.enable6Tools 등 | live-assembly hellgate뿐 |
| plan-queue-helper | 01 | helper (env 없음) | **CLI에서 store 생성 + `/queue` + sendNow live**; STUB 아님 |
| refusal-stop-reason-branching | 01 | config.stopReasonPolicy | 33 unit; 기본 consumer 미실현 |
| response-in-progress | 01 | provider 이벤트 의존 | OpenAI Responses 필요 |
| projects-kb | 02 | QUANTA_PROJECTS_KB | unit뿐 |
| shell-snapshot-spawner | 02 | CLI 내부 opt-in | env 게이트 없음 |
| realtime-voice-session | 02 | QUANTA_VOICE_LIVE | REPL slash만; loop e2e 없음 |
| advisor-consult-tool | 02 | QUANTA_ADVISOR_MODEL (allowlist strict) | bench 제외 서피스 |
| image-gen | 02 | QUANTA_IMAGE_GEN (strict) | synthetic e2e만 (provider mock) |
| office-authoring / pptx | 02 | QUANTA_OFFICE_AUTHORING (strict) | roundtrip e2e는 있으나 loop 아님 |
| artifact-canvas-store | 02 | QUANTA_ARTIFACT_STORE | loop 아님 |
| communicate-update | 02 | QUANTA_PROGRESS_UPDATE | loop 아님 |
| ast-grep-tool | 02 | QUANTA_AST_GREP + 바이너리 | loop 아님 |
| commit-pr-authoring | 02 | QUANTA_COMPOSE_AUTHORING (strict) | loop 아님 |
| file-history-rewind | 02 | QUANTA_FILE_HISTORY | unit뿐 |
| gh-pr-resolve-thread | 02 | QUANTA_GIT_TOOLS | unit뿐 |
| lsp-call-hierarchy | 02 | QUANTA_LSP_TOOLS=full | unit뿐 |
| notebook-edit | 02 | QUANTA_NOTEBOOK_EDIT | unit뿐 |
| realtime-websocket | 02 | 포트주입 + VOICE_LIVE | ⚠️카탈로그 "hold"는 stale — WS live(jun-15); media 깊이만 hold |
| reflect | 02 | QUANTA_REFLECT (포트) | unit뿐 |
| subagent-bg-tools-trio | 02 | scheduler 포트 주입 | unit뿐 |
| tool-interrupt-block | 02 | QUANTA_TOOL_INTERRUPT_BLOCK (strict) | unit 배터리 2종뿐 |
| worktree-tool | 02 | QUANTA_WORKTREE_TOOL | CLI-only mint; dispatch-e2e는 있음(준A) |
| appshot-verify-loop | 02 | QUANTA_APPSHOT + BROWSER + chrome | render+judge e2e는 Phase2 |
| 0171-pii-redaction (+0399 wire) | 03 | config.redaction.pii | dispatch fold unit뿐 |
| 0209-per-tool-checkpoint | 03 | assembly opt-in | CLI repl만 |
| 0210-three-way-restore | 03 | /rewind-tool | ⚠️카탈로그 "미등록" stale — 등록돼 있음 |
| 0213-tool-profile-preset | 03 | /profile + --tool-profile | `/profile`과 startup flag가 같은 session authority를 사용하며 split/equal form 모두 값 검증 후 prompt에서 제거됨 |
| 0295-bash-mode-sandbox | 03 | bash input mode="read" | 런타임 선택형; e2e 없음 |
| 0164-secret-detection + 0412 tool | 03 | QUANTA_SECRET_CHECK_TOOL=on | 스캐너는 무게이트, tool만 게이트 |
| 0497-guardian-assessor | 03 | QUANTA_GUARDIAN_ASSESSOR (strict) | integration 없음 |
| jun6-exfil-scouting | 03 | QUANTA_EXFIL_SCOUTING + _K (K 필수) | advisory-only |
| 99-landlock-phase2 | 03 | Linux+bwrap 존재 | 실 bwrap e2e 없음 |
| per-tool-granular-registry | 04 | AgentConfig.granularRegistry | producer는 `QUANTA_PER_TOOL_RECORD=on`에서 live; raw snapshot consumer가 없음 |
| env-build-dynamic-context | 04 | 주입형 | 22 unit |
| glob-rules | 04 | config.globRules | composition root 미자동배선 |
| pre-compact-hitl | 04 | onPreCompact 콜백 | unit뿐 |
| delta-token-accounting | 04 | QUANTA_DELTA_TOKEN_COUNT (strict) | 전용 e2e 없음 |
| microcompact | 04 | QUANTA_MICROCOMPACT | keep/floor/interval 기본값 없음(no-heuristics) |
| issue-hint-expected-actual | 04 | QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL | 부모 게이트도 필요 |
| syntax-aware-chunking / read-outline | 04 | QUANTA_SYNTAX_CHUNK / QUANTA_READ_OUTLINE | 두 독립 gate 모두 production parser composition live; unsupported/parse failure는 visible line fallback |
| on-session-minted / multi-source-vendor / model-tag 계열 | 04 | 콜백/호출형 | glob-rules 통합 미완 |
| consolidator-session-hook / distill-redaction / line-citation 3종 / phase2-promotion / phase2-auto-trigger / stage1-wire | 05 | config/env 혼합 | phase2 e2e는 sibling이 커버; 개별 loop e2e 없음 |
| 0218-subagent-mode-typed | 06 | QUANTA_SUBAGENT_TYPED_KIND 연동 | |
| 0293/0301-playbook-trigger | 06 | QUANTA_PLAYBOOK_TRIGGER / --playbook-trigger | confined disk registry + named dispatch + external prompt queue live; default flip은 별도 판단 |
| 0393-delegate-tool | 06 | cfg.delegation | |
| 04-seam skill overrides | 06 | SKILL.md model:/effort: | loop 테스트 있음(준A) |
| 0404-lsp-rename | 06 | QUANTA_LSP_TOOLS=full | |
| 0487-force-background | 06 | QUANTA_FORCE_BACKGROUND (+QUEUE) | |
| 5059-delegation-suppression | 06 | QUANTA_SUBAGENT_DELEGATE_SUPPRESS | A/B 후 default-ON 계획 |
| agent-jobs-batch | 06 | QUANTA_SPAWN_AGENTS_CSV / `quanta batch` | |
| assemble-store-core | 06 | QUANTA_MEMORY(+EMBED 3중 AND) | |
| 0405-lsp-diagnostics-hook | 06 | QUANTA_LSP_DIAGNOSTICS_HOOK | Delete/Move matcher 미완 |
| 241-playbook-auto-dispatch | 06 | cfg.playbook.autoDispatch | inline-trigger-dispatch integration 있음(준A) |
| rewind-skill | 06 | skills(기본ON) + shadowOdb 2차게이트 | shadowOdb 없으면 noop |
| skill-creator-tool | 06 | QUANTA_SKILL_CREATOR + user dir | |
| subagent-persistence | 06 | hydrateFrom 주입 | |
| runner-run-once | 06 | optional gates | L2, 테스트 부재 |
| verify-and-select | 06 | QUANTA_BENCH_VERIFY_SELECT | bench 전용; concurrency integration 있음 |
| bug-fix-proposal-queue | 06 | leaf (배선자 없음) | C 성격 겸함 |
| structured-output-mode | 08 | StreamInput.responseFormat | OpenAI만; Anthropic adapter 미소비 |
| ndjson-introspection | 08 | QUANTA_NDJSON_INGEST_PORT | HTTP 서버/프로듀서 배선 잔여 |
| 0094-chatgpt-oauth | 09 | 토큰 존재 시 활성 (+QUANTA_OAUTH_*) | unit 9종 |
| 0279/0280-automation | 09 | QUANTA_AUTOMATION=on (strict "on") | inbox/tool까지 한 게이트 |
| 0162-mcp-isolated-spawn | 09 | MCP_USE_ISOLATED_SPAWN | |
| 0454-command-hooks | 09 | QUANTA_COMMAND_HOOKS=1 + _ACK (3중) | 보안: ack 없으면 throw |
| approval-SM + gate-wire | 09 | 포트 주입 | producer 미배선 — C 성격 겸함 |
| compaction-visibility | 09 | 콜백 주입 | loop.ts 배선 deferred |
| observability-live-wire | 09 | QUANTA_OBSERVABILITY=on (exact) | web-daemon 경로 |
| 0440-canvas-web | 09 | QUANTA_WEB_CANVAS | web-daemon 부분배선 |
| 0182-prompt-cache-obs | 10 | QUANTA_PROMPT_CACHE_STATUS | |
| 0302-identity-rebuild | 10 | onChange 콜백 | 프로덕션은 inline lambda |
| 0309-per-tool-record | 10 | QUANTA_PER_TOOL_RECORD=on | |
| 0310-r1 composition | 10 | QUANTA_CHECKPOINT_CONV 등 5종 | |
| cli-background-turn | 10 | QUANTA_BG_TURN | Ctrl+B + /background |
| slash-queue-per-msg | 10 | /queue | sendNow sink 미배선 (부분) |
| session-import-export | 10 | /session export·import | |
| bench: find-refs / patch-budget / spec-fidelity / trajectory-record / repro-doubt / repro-vote | bench | QUANTA_BENCH_* | 행동 e2e 없음; repro-doubt은 apply live·preset 0회 |

## C — built-not-wired (~25) → 배선 or kill

| 기능 | 섹션 | 상태 | kill/배선 판단 재료 |
|---|---|---|---|
| inline-trigger-wiring | 01 | 호스트 wirer 미실행 | 0293 playbook-trigger가 유사 기능 — 중복 검토 |
| lane-manager-parallel | 01 | env reader와 production consumer 없음 | seam-only. 대체/중복 증거 전에는 delete 금지; host owner를 정하거나 deliberate hold 유지 |
| spec-to-test-gen-devin | 01 | 호출자 0 | |
| voice-input-stt-slice | 02 | 어댑터 완비, 주입 0 | voice-live(B)와 통합 검토 |
| ci-finding / gh-pr-code-tour | 02 | ci-bot mode 전용 (interactive 미도달) | promotion_path 문서화돼 있음 |
| conflict-parser-lib | 02 | 순수 lib, caller 0 | fix-merge-conflicts skill이 미래 소비자 |
| node-repl-persistent-kernel | 02 | tool 등록 자체가 없음 | |
| 0235-shell-snapshot-runshell | 03 | 포트 정의만, 주입 0 | |
| 076-deny-and-steer | 03 | steerInjection emit되나 loop이 안 먹음 | jul-15 dead-seam 류 |
| multimodal-embedding / search-pipeline-composer / embed-cache / semantic-search-port / reranker-port / model-tag ×2 / side-chat(L1) | 04 | retrieval 체인 전체가 배선 대기 | 켜려면 pipeline-composition-root-wire(QUANTA_PIPELINE)로 묶어서 |
| adaptive-escalation-v5 | 06 | bench driver wire Wave-3 보류 | |
| user-authored-playbook-frontmatter | 06 | leaf-only | |
| recovery-router-codex-spec | 07 | codexSpecRoute 미배선 (jul-15 발견과 일치) | RetryingLLM 통합이 배선 경로 |
| message-batches / model-preset / ratelimit-dual-window | 08 | export-only L2 | 소비자 0; kill 후보 검토 |
| llm-record-replay | 08 | barrel fence (side-agent에선 live) | 의도적 — 유지 |
| 0311-gh-actions-trigger / from-pr CLI | 09 | daemon/headless만·CLI 배선 hold | Tier0 실배달 축적 후 |
| fast-apply-wire (agent측) | 09 | tool측 완료, dispatch 어댑터 미구현 | ADR-0417 A1 |
| prompt-suggestion | 10 | CLI turn-completion wire live | suppression state 4종을 `false`로 고정한 partial bug 수리 후 enable 심사 |

## D — hold (~17)

| 기능 | 사유 |
|---|---|
| n-phase-hitl / streaming-boomerang / streaming-cancellation / subagent-resume-replay / plan-writeback / playbook-nesting (01) | 의도적 host-wire 보류 (ADR별 재개 필요) |
| 0441-windows-sandbox (03) | helper exe 미빌드 (passthrough 안전 폴백) |
| jun7-tls-mitm-egress (03) | Phase-2 RFC (CA lifecycle) |
| memory-telemetry-port (04) | seam-only; 실 어댑터는 별도 기능 |
| llm-adapter-mantle (08) | @anthropic-ai/mantle-sdk 미출시 |
| 0461-token-refresh-scheduler (09) | 정직한 prod rotator 부재 |
| 0317 tauri-desktop-shell (10) | L2 scaffold + zero tests + cargo build 미검증. source/manifests는 있으나 shipping-wired로 닫기엔 증거 부족 |
| bench: effort-ladder / submit-review | 진짜 measure-first (preset 0회, e2e 0) |
| bench: llm-select / location-fanout | measure-first 명분이나 **이미 v7 preset 탑재** — hold 서사 무효, 측정으로 정리해야 |

## X — 카탈로그 오류 / 이미 ON (~25)

**이미 default-ON / always-on (카탈로그가 default-OFF로 오기)**:

| 기능 | 실상 |
|---|---|
| async-shell-background | bash BASE tool의 timeout_behavior 파라미터 — 항상 라이브 |
| atomic-write + hash-precondition | edit BASE 경로 — expected_hash는 옵션 파라미터 |
| scripted_replace | BASE_TOOL_NAMES 포함 |
| grep-rg-flags | 정적 서피스, 항상 활성 |
| 01-fsjailerror | **기본 ON** (QUANTA_FS_JAIL=off가 escape hatch — 역게이트) |
| apply-patch-structured | manifest SSOT + CLI seed 경로로 **CLI에서는 이미 default-ON**, bench/web/headless는 opt-in |
| QUANTA_SUBAGENT / QUANTA_SKILLS | `?? true` default-ON (RFC 의도적 예외) |
| 시스템 스킬 번들 6종 (product-onboard/ctk-git/debug-blame/engineering/git-log-search 등) | skills 기본ON이라 discovery부터 라이브 |
| assemble-tooling-core / tier1-skill-block / tier1-subagent-block | 상동 |
| cli-turn-summary | TTY-auto (unset=TTY에서 ON) |
| 0297 knobs (HISTORY/MULTILINE/REWIND/MEMORY_SLASH) | 기본 ON |
| idle-monitor QUANTA_IDLE_SUPPRESS | 기본 "1" |

**CLI behavior seed로 인터랙티브 CLI에서 사실상 ON (19종)**:
QUANTA_ENABLE_ENV_PROBE · **QUANTA_STALE_READ_GUARD** · QUANTA_UNTRUSTED_ENVELOPE · **QUANTA_READ_DEDUP** · QUANTA_TEAM_DAG/BROKER/IDLE · **QUANTA_SUBAGENT_FOLLOWUP** · QUANTA_AT_AUTOCOMPLETE · QUANTA_EXTERNAL_EDITOR · QUANTA_KEYBINDINGS · **QUANTA_RATELIMIT_NOTICE** · QUANTA_MODE_CYCLE · **QUANTA_MIDTURN_CAPTURE** · QUANTA_MIDTURN_VISIBLE · QUANTA_PREFLIGHT_CHECK · QUANTA_BRACKETED_PASTE · **QUANTA_CONVERSATION_ACTIONS** · QUANTA_SPINNER_STALL

(여기에 tool-surface manifest가 CLI-default로 seed하는 8 tool gates가 더해져 effective-default universe는 27종이다. bench/daemon/headless는 blanket OFF로 추정하지 말고 각 composition root에서 별도 계산한다.)

---

# 3R current-HEAD audit verdict (2026-07-16)

이전의 `85/85 green`, `STRONG 41 / MEDIUM 30 / WEAK 14`, `A≈66 / B≈85`는 feature id, test path, command, exit code, revision을 연결한 receipt가 저장돼 있지 않다. 일부 focused rails가 green인 사실과 전수 promotion proof는 다르므로 수치는 **unverified**로 강등한다. DOF-00 ledger는 175행/27 CLI seed를 고정했지만 unknown surface 851, unknown value 2,354가 남아 있으므로 전수 batch flip은 계속 금지다.

| 판정 | 기능 | 다음 액션 |
|---|---|---|
| security-blocking | web daemon bind/auth | default loopback 또는 non-loopback auth-required + negative test |
| live-bug | shipping `--tool-profile` | valued argv parser를 단일 SSOT로 합치고 prompt 오염 RED rail 수리 |
| live-partial | prompt-suggestion | plan/rate-limit/elicitation/permission live state를 wire한 뒤 ON 심사 |
| live | plan-queue, `/profile`, goal-continuation | kill 목록에서 제거; 실제 default와 proof만 정정 |
| producer-only | per-tool recorder | consumer를 정하거나 explicit telemetry-only로 demote |
| repair-first | read-outline | read tool composition root에 parser 주입; syntax index chunking과 분리 |
| operationally inert | playbook-trigger + 241 | `.quanta/playbooks/*.md` registry loader와 real dispatch proof |
| seam-only | lane-manager, bug-fix queue, recovery-router | owner/consumer를 정해 wire하거나 hold; duplicate 증거 전 delete 금지 |
| catalog-stale | prompt-suggestion, tool-profile, plan-queue, stale-read-guard, fsjail, objective-goal 등 | YAML 수정 후 `bun fc validate && bun fc build && bun fc diff` |

## 실행 원칙

1. machine-readable ledger와 catalog drift를 먼저 닫는다.
2. 보안·prompt corruption·silent-inert 경로를 default flip보다 먼저 수리한다.
3. safe/read-only/observability는 explicit-OFF와 상속 matrix가 있으면 enable-now로 처리한다.
4. 제어흐름·품질·비용 변화는 paired A/B 후 default를 바꾼다.
5. browser/network/mutating/provider-cost 기능은 default-OFF라도 `policy_gated_live`면 목표 달성으로 센다.
6. 삭제는 proven duplicate만 허용하며, 단순 무소비자는 `seam-only/hold`로 남긴다.
