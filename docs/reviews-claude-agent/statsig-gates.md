# Statsig / GrowthBook 피처 게이트 카탈로그 (v2.1.143)

`Z_("tengu_*", default)`로 평가되는 피처 게이트 전수. 코드네임(동물/광물/색상)은 대부분 미출시/실험 기능을 가린다. 본 문서는 4섹션: **카탈로그 / 그룹별 해석 / 게이트 평가 메커니즘 / 흥미로운 발견**.

식별자는 `백틱`. 호출부 거동에서 역추론한 것은 "추정", 호출부 코드로 직접 확인된 것은 "확인".

---

## 1. 카탈로그

표기: default `!0`=true, `!1`=false, `null`/`{}`/`[]`/`""`는 그대로. 평가는 모두 line 5634 `evalStatsigGate` 경유.

### 1.1 코드네임 게이트 (동물/광물/색상 — 미출시·실험)

| gate key | default | 추론 기능 | evidence (호출부) | 분류 |
|---|---|---|---|---|
| `tengu_velvet_cascade` | `null` | **모델→simple system prompt 라우팅 맵** (확인). `{models:[...]}` 객체, 모델 ID가 배열 원소 substring이면 simple prompt 적용 | `UL9(H)`: `K.models.some(O=>_.includes(O))` (offset 4467498) | 설정맵(원격) |
| `tengu_vellum_lantern` | `!1` | **simple system prompt 전역 스위치** (확인). `f$()` 최종 fallthrough — Opus 4.7 등에서 simple prompt 켤지 | `f$=X6(H=>{...return Z_("tengu_vellum_lantern",!1)})` | kill/enable |
| `tengu_verified_vs_assumed` | `!1` | **system prompt bullet 추가** (확인): "be accurate about what you verified vs. what you assumed..." | `# Doing tasks` 빌더 `...Z_(...)?["When reporting results..."]:[]` (offset 12912403) | 프롬프트 A/B |
| `tengu_orchid_mantis` | `!1` | **`/schedule` 자동 제안 프롬프트** (확인). on이면 "finished a task with natural future follow-up → one-line `/schedule` offer" bullet 주입 + `/schedule` whenToUse 문구 교체 | 프롬프트 빌더 + `CqO()` whenToUse (offset 12915801/14171188) | 프롬프트 A/B |
| `tengu_orchid_mantis_v2` | `!1` | `orchid_mantis`의 더 보수적 버전 (확인). "Default: NO `/schedule` offer — offer ONLY when named artifact with future obligation" | 같은 빌더 우선 분기 | 프롬프트 A/B |
| `tengu_slate_harrier` | `"off"` | **investigate-first 모드** (확인). `"additive"`/`"compact"`면 Opus 4.7에서 "spend up to a minute on read-only investigation before asking" bullet 주입. `$d8(H)` | `Z_("tengu_slate_harrier","off")` → `SB3()` (offset 12924162) | 프롬프트 멀티암 |
| `tengu_moth_copse` | `!1` | **memdir(자동 메모리 prefetch) 활성** (확인). off면 `AutoMem` rule 타입 필터 제거 + `startMemdirPrefetch` memdir prefetch 가드 통과 안 함 | `gz_()` + `ga7()` 가드 (offset 6031592/10255177) | kill/enable |
| `tengu_copper_lantern` | `!1` | **데몬 service recall(강제 드레인·언인스톨) 킬스위치** (확인). supervisor 루프가 폴링, true면 워커 드레인 + service uninstall + `d("tengu_copper_lantern",{})` 텔레메트리 | `K==="service"&&q98()` → `k=!0` (offset 14582630) | kill-switch |
| `tengu_cobalt_lantern` | `!1` | **GitHub token-sync 경로** (확인). true면 `Qw7`에서 token-sync로 GitHub 접근 허용 + `/web-setup` 안내 문구로 교체 | `Z_(...)&&await JW5()` (offset 7710501/14172895) | feature flag |
| `tengu_drift_lantern` | `!1` | **event-loop stall detector** 시동 (확인). true면 `startEventLoopStallDetector()` | main init (offset 14481412) | feature flag |
| `tengu_trace_lantern` | `!1` | **상세 베타 트레이싱** (확인). `kf()` — `ENABLE_BETA_TRACING_DETAILED`+endpoint 필요, 비대화형이거나 게이트 on이면 system_prompt_hash 등 span 속성 기록 | `kf()` (offset 6535539) | feature flag |
| `tengu_sedge_lantern` | `!0` | **away-summary(자리비움 요약) 기능** (확인). `RdH()` — default on, 비대화형이거나 holdback이면 off | `RdH()` (offset 7748302) | kill/enable |
| `tengu_sedge_lantern_holdback` | `!1` | away-summary holdback(역게이트). true면 sedge_lantern을 강제 off | 같은 `RdH()` | holdback |
| `tengu_sedge_lantern_config` | `{delayMs:Ni8}` | away-summary 지연 설정맵 | — | 설정맵 |
| `tengu_cobalt_raccoon` | `!1` | **reactive autocompact / autocompact-window 활성** (확인). `Nw_()` — 비대화형이면 false, 아니면 게이트값. `zKH`에서 1M 컨텍스트 모델 윈도우 판정에 사용 | `Nw_()` → `zKH()`, `reactiveCompactPhaseB` (offset 6577313) | kill/enable |
| `tengu_amber_anchor` | `!1` | 백그라운드 supervisor를 **"daemon" vs "background service"** 명명/모드 결정 (확인) | `t$H()` → `BD()` | feature flag |
| `tengu_amber_flint` | `!0` | **agent teams (멀티 에이전트 팀)** 기능 (확인). `K7()` — env 또는 `--agent-teams` + 게이트 | `K7()` (offset 6439827) | kill/enable |
| `tengu_amber_lynx` | `!1` | git/세션 상태 패널 UI 토글 (추정) | React memo `Z_("tengu_amber_lynx",!1)` | UI flag |
| `tengu_amber_lark` | `!1` | 구독/오버리지 상태 메시지에 추가 라인 첨부 (확인) | `if(Z_(...)){...H+=...V97()}` | UI flag |
| `tengu_amber_prism` | `!1` | 권한 거부 메시지에 추가 텍스트 `Mz3` 첨부 (확인) | `UiH(H)` | 프롬프트 tweak |
| `tengu_amber_relay` | `!1` | Remote Control bridge 활성 (확인). `hf8()` | `hf8()` | feature flag |
| `tengu_amber_sentinel` | `!1` | **`Monitor` 도구 — 능동 push 알림** 프롬프트 (확인). on이면 "send a Monitor... the ones that change what they'd do next" 문구 | `Mg()` (Monitor 도구 인근) | 프롬프트 tweak |
| `tengu_amber_creek` | `!1` | TUI downsell 게이트 (추정). `vb1()` flicker/fullscreen 판정 | `vb1()` | UI flag |
| `tengu_amber_rokovoko` | `uE8` | rapid-refill autocompact 임계 비율 (확인). `[0,1)` 범위면 채택, 아니면 `uE8` | `r13()` (offset, compaction) | 숫자 설정 |
| `tengu_amber_wren` | `{}` | 파일 read 한도 설정맵 (`maxSizeBytes`/`maxTokens`) (확인) | `s7H` (offset) | 설정맵 |
| `tengu_amber_relay`/`bridge_vivid` | `!1` | REPL bridge outbound-only / Remote Control | `kW5()` | feature flag |
| `tengu_cobalt_ridge` | `!1` | Windows에서 PowerShell 도구 활성 (확인). `Qu()` — Windows + git 없음일 때 게이트 | `Qu()` (offset 6577) | feature flag |
| `tengu_cobalt_wren` | `!1` | classifier-summary를 LLM→heuristic로 강등 (확인). `Za7()` | `Za7()` | A/B kill |
| `tengu_coral_beacon` | `!1` | 구독 업셀/오버리지 배너 표시 (추정) | React memo | UI flag |
| `tengu_copper_fox` | `!1` | **서브에이전트 fork 모드** (확인). `NHH()` — env 또는 게이트 | `NHH()` (offset 9267155) | kill/enable |
| `tengu_crimson_vector` | `!1` | 1P API에서 이미지 base64 크기 상한 확장 (`Mu9`) (확인) | `Fn1()` (offset 5209219) | feature flag |
| `tengu_velvet_static` | `!1` | **`/radio` 명령 (Claude FM lo-fi 라디오)** 활성 (확인) | `isEnabled:()=>Z_("tengu_velvet_static",!1)` (offset 12342614) | feature flag |
| `tengu_velvet_ibis` | `{}` | MCP 도구 출력 토큰 상한 설정맵 (`mcp_tool`) (확인) | `Lj6()` (offset 10504933) | 설정맵 |
| `tengu_surreal_dali` | `!1` | **원격 routines(`schedule`/RemoteTrigger) 도구 활성** (확인). `isEnabled`에 직접 | `i_3`/`CqO` isEnabled (offset 9985727) | kill/enable |
| `tengu_mocha_barista` | `!1` | `/schedule` whenToUse에 "one-time scheduled run" 문구 추가 (확인) | `CqO` whenToUse (offset 14171555) | 프롬프트 A/B |
| `tengu_quiet_harbor` | `!1` | 데몬 cold-start를 `"ask"` vs `"transient"` (확인). `pS1()` | `pS1()` | feature flag |
| `tengu_slate_harbor` | `!1` | **REPL 변종 활성** (확인). entrypoint=cli/remote일 때 `LX()`가 REPL on | `LX()` (offset, REPL) | feature flag |
| `tengu_slate_harbor_experiment` | `!1` | **신규 `/init` (CLAUDE.md 생성기 v2)** (확인). `kX3()` | `kX3()` (offset) | feature flag |
| `tengu_slate_kestrel` | `!1` | subscription==null 사용자에게 1P scope 허용 (확인). `bp()` 인증 게이트 | `bp()` (offset 10870356) | feature flag |
| `tengu_slate_prism` | `!0` | agent progress summaries(`Zk6`) 활성 — SDK request 처리 시 (확인) | `WH.request.agentProgressSummaries&&Z_(...)` | kill/enable |
| `tengu_slate_finch` | `!1` | effort 셀렉터에 "high · burns fastest — medium handles most tasks" 힌트 (확인) | `kT8()` (offset) | UI/프롬프트 tweak |
| `tengu_slate_thimble` | `!1` | 비대화형에서도 sepia_cormorant memdir 허용 (확인) | `pi_()` | feature flag |
| `tengu_harbor` | `!1` | **channels(플러그인 채널) 기능** 활성 (확인). `DNH()` | `DNH()` (offset, harbor_ledger 인근) | kill/enable |
| `tengu_harbor_ledger` | `[]` | channel allowlist (plugin/marketplace 쌍 배열) (확인). `Dw6()` zod 파싱 | `Dw6()` | 설정맵 |
| `tengu_harbor_permissions` | `!1` | channel 권한 RPC 활성 (추정) | `us7()` | feature flag |
| `tengu_harbor_prism` | `!1` | PR 리뷰 상태를 `gh pr view` 대신 다른 경로로 (확인). `eM_()` | `eM_()` (offset) | A/B |
| `tengu_sepia_cormorant` | `null` | **자동 메모리(memdir) gradual rollout 모델 allowlist** (확인). 배열 + 현재 모델 매칭 시 + `umber_petrel` true면 mute | `mi_()` (offset) | rollout 배열 |
| `tengu_umber_petrel` | `!1` | sepia_cormorant 매칭 시 자동메모리 **비활성화**(역게이트 holdback) (확인) | `mi_()` 마지막 return | holdback |
| `tengu_passport_quail` | `!1` | memdir(`pi_`) 1차 게이트 (확인). false면 무조건 off | `pi_()` (offset) | kill/enable |
| `tengu_sepia_moth` | `!1` | reactive compact 진입 보조 게이트 (확인). `uD8()` | `uD8()` (offset) | feature flag |
| `tengu_ochre_finch` | `!1` | memory `## Types of memory` 섹션 변형 (확인). `g98()` | `g98()` (offset) | 프롬프트 tweak |
| `tengu_ochre_hollow` | `!1` | fullscreen 업셀 표시 (확인). `zp8()` | `zp8()` (offset) | UI flag |
| `tengu_onyx_plover` | `null` | **auto-dream(자율 백그라운드 루프) 설정** (확인). `{enabled,available}` 객체 — `CY6()`/`cX_()` autoDream 판정 | `Zo7()` (offset 10062817) | 설정맵 |
| `tengu_basalt_spur` | `!1` | 대화형 모드 보조 게이트 (`ciH`) (추정) | `ciH()` (offset) | feature flag |
| `tengu_birch_compass` | `!1` | 상태바/사이드 UI 컴포넌트 렌더 (추정) | `J5K()` React (offset) | UI flag |
| `tengu_alder_compass` | `!1` | 신규유저 `/powerup` 튜토리얼 nudge 표시 (확인) | onboarding nudge `isRelevant` | UI nudge |
| `tengu_garnet_finch` | `!1` | `/loop` 명령 nudge 표시 (확인) | nudge `isRelevant` | UI nudge |
| `tengu_dune_wren` | `!1` | "fan out subagents" nudge 표시 (확인) | nudge `isRelevant` | UI nudge |
| `tengu_gouda_loop` | `!1` | 닫힌 GitHub 이슈 알림 표시 (확인). `id3()` | `id3()` (offset 13323009) | UI flag |
| `tengu_gleaming_fair` | `!1` | resume 복귀 시 토큰/시간 임계 알림 (확인). `JbK()` | `JbK()` (offset) | UI flag |
| `tengu_gypsum_kite` | `!1` | pro 사용자에게 Opus "~2× usage vs Sonnet" 라벨 (확인) | `Gb8()` (offset) | UI tweak |
| `tengu_bramble_lintel` | `null` | memory 추출 batch 임계 (`??1`) (확인). `extractMemories` | `Z_(...)??1` (offset) | 숫자 설정 |
| `tengu_brick_follow` | `!1` | VSCode 확장에 experiment_gates로 전달되는 플래그 (확인) | `experiment_gates` notification | passthrough flag |
| `tengu_vellum_siding` | `!1` | 동상 (VSCode passthrough) (확인) | 동일 notification | passthrough flag |
| `tengu_chair_sermon` | `!1` | attachment 메시지 변환 `Lz3` 적용 (확인) | 메시지 정규화 (offset) | A/B |
| `tengu_herring_clock` | `!1` | team memory(`_O_`/`Jr_`) 활성 (확인). `b4()` + 게이트 | `_O_()` (offset) | kill/enable |
| `tengu_idle_amber_finch` | `!1` | idle 관련 UI(`Rt`) (추정) | `Rt()` (offset) | UI flag |
| `tengu_quiet_slate_wren` | `!1` | `dQ9()` 빌링/UI 보조 (추정) | `dQ9()` | UI flag |
| `tengu_marlin_porch` | `!1` | TTY scroll region(DECSTBM) 사용 (확인). `jBH()` | `jBH()` (offset) | feature flag |
| `tengu_hawthorn_steeple` | `!1` | tool_result dedup/replacement 추적 활성 (확인). `Fr9()` | `Fr9()` (offset) | feature flag |
| `tengu_billiard_aviary` | `!1` | **team memory dir 경로 분기**(`dw()`) (확인). `bS1()` 가 `IS1`/`CS1` 선택 | `dw()` (offset) | feature flag |
| `tengu_chomp_inflection` | `!1` | **프롬프트 자동 제안(prompt suggestion)** 활성 (확인). `S76()` | `S76()` (offset) | kill/enable |
| `tengu_pewter_brook` | `!1` | fullscreen TUI 게이트 (확인). `gbGateCached` | `??=Z_("tengu_pewter_brook",!1)` (offset) | UI flag |
| `tengu_pewter_lark` | `"off"` | `/goal` nudge 문구 멀티암 (`copy_orig`/`copy_b`) (확인) | nudge content switch | 프롬프트 멀티암 |
| `tengu_cedar_inlet` | `"off"` | 팀 온보딩 디스커버리 표시 arm(`banner`/`step`) (확인) | `Px3` + `d("tengu_team_onboarding_discovery_shown",{arm})` | UI 멀티암 |
| `tengu_kestrel_arch` | `"off"` | `/claude-api` nudge — `"on"`이면 표시 (확인) | nudge `isRelevant` | UI 멀티암 |
| `tengu_silk_hinge` | `!1` | 설정에 "Show message timestamps" 항목 추가 (확인) | settings 메뉴 (offset) | UI flag |
| `tengu_tussock_oriole` | `!1` | project settings에서 plugin author 노출 (확인). `Mf_()` | `Mf_()` (offset) | feature flag |
| `tengu_shale_finch` | `!1` | 도구 enable 보조 (확인). `mC7()` | `mC7()` (offset) | feature flag |
| `tengu_paper_halyard` | `!1` | **CLAUDE.md Project/Local 지시 제외** (확인). true면 `O.type==="Project"\|"Local"` 메모리 스킵 | `DA8` (offset, paper_halyard) | A/B (위험) |
| `tengu_fennel_kite_model` | `""` | **mid-conversation system prompt 대상 모델**(substring) (확인). `Ll_()` — 모델 ID에 포함되면 mid-conv system 허용. `clientDataCache.tengu_fennel_kite_model` override 우선 | `Ll_=X6(H=>{...Z_("tengu_fennel_kite_model","")})` (offset 5184 인근) | 모델 라우팅 |
| `tengu_kairos_brief` | `!1` | **brief 모드(짧은 상태표시)** 활성 (확인). `jh7()` UI | `Z_("tengu_kairos_brief",!1)` (offset 8968847) | kill/enable |
| `tengu_kairos_brief_config` | `oRK` | brief 모드 설정맵 | — | 설정맵 |
| `tengu_kairos_brief_stop_hook_text` | `""` | brief 모드 stop hook 텍스트 | — | 문자열 설정 |
| `tengu_kairos_loop_dynamic` | `!1` | cron/loop 동적 스케줄링(`aAH`) (확인) | `aAH()` (offset) | feature flag |
| `tengu_hazel_osprey` | `!1` | 422/424 에러 carrier 재시도 메커니즘(`iEK`) (확인) | `iEK()`/`rEK()` (offset 12935048) | feature flag |
| `tengu_hazel_osprey_floor` | `lB3` | 위 메커니즘의 floor 파라미터 | `rEK()` | 숫자 설정 |
| `tengu_turtle_carbon` | `!0` | user 메시지 판정 보조(`pRH`) — default on (확인) | `pRH()` (offset 6435318) | kill/enable |
| `tengu_slim_subagent_claudemd` | `!0` | **서브에이전트 CLAUDE.md 슬림화** — default on (확인). `omitClaudeMd` + 게이트면 claudeMd 제거 | turn 빌더 `l=...&&Z_(...)` (offset 10151322) | kill/enable |
| `tengu_send_user_file` | `!0` | **`SendUserFile` 도구**(스크린샷·산출물 전달) 활성 (확인). 1P + remote 환경 | `isEnabled` (offset 9994552) | kill/enable |
| `tengu_plan_mode_interview_phase` | `!1` | plan mode interview phase (확인). `oX()` | `oX()` (offset) | feature flag |
| `tengu_ember_latch` | `!1` | 빌링 인터럽트 dialog 표시 보조 (확인). `oM_()` | `oM_()` (offset) | UI flag |
| `tengu_immediate_model_command` | `!1` | `/model` 즉시 적용(`paH`) (확인) | `paH()` (offset) | feature flag |
| `tengu_fgts` | `!1` | **fine-grained tool streaming** — 1P+bT일 때 (확인). env override 우선 | `Z_("tengu_fgts",!1)` (offset) | feature flag |
| `tengu_ccr_bridge` | `!1` | CCR(Remote Control) bridge 활성(`YdH`) (확인) | `YdH()` (offset) | feature flag |

### 1.2 설정·튜닝·텔레메트리 게이트 (비코드네임)

| gate key | default | 기능 (확인) |
|---|---|---|
| `tengu_log_datadog_events` (상수 `XL9`) | `!1` | true면 텔레메트리를 Datadog로도 전송(`OpH`). `A0H("datadog")`로 차단 가능. `PL9()`/`V98()` |
| `tengu_streaming_tool_execution2` | `!1` | `gates.streamingToolExecution` — `StreamingToolExecutor` 응답중 도구실행 활성 |
| `tengu_stream_watchdog_default_on` | `!0` | byte watchdog default. env override 우선 |
| `tengu_prompt_cache_diagnostics` | `!1` | 프롬프트 캐시 진단 |
| `tengu_compact_cache_prefix` | `!0` | compaction 캐시 prefix 보존 |
| `tengu_auto_mode_config` | `{}`/`A9K`/`uQ9` | auto permission mode 설정 (3개 호출부, 다른 default) |
| `tengu_bg_*` (`attach_stall_ms`,`leftarrow_inprocess`,`low_mem_mb`,`spare_enable`,`classifier_config`) | 각 다름 | 백그라운드 에이전트 튜닝 |
| `tengu_cicada_nap_ms` | `0` | 인위적 지연(ms) |
| `tengu_ccr_bundle_max_bytes` | `null` | CCR 번들 최대 바이트 |
| `tengu_classifier_summary_*` (`kill`,`llm_emit`,`heuristic_emit`) | `!1` | classifier summary emit 모드 / kill |
| `tengu_classifier_disabled_surfaces` | `""` | classifier 비활성 surface 목록 |
| `tengu_bash_allowlist_strip_all` | `!1` | bash allowlist 전체 strip — 텔레메트리 `stripAllBashFlag`로만 관측됨 |
| `tengu_read_dedup_killswitch` | `!1` | true면 Read dedup 비활성(킬스위치) |
| `tengu_disable_bypass_permissions_mode` | `!1` | bypassPermissions 모드 비활성 |
| `tengu_disable_keepalive_on_econnreset` | `!1` | ECONNRESET 시 keepalive 끔 |
| `tengu_disable_streaming_to_non_streaming_fallback` | `!1` | 스트리밍→비스트리밍 fallback 끔 |
| `tengu_destructive_command_warning` | `!1` | 파괴적 명령 경고 |
| `tengu_canary` | `{}` | 카나리 설정맵 |
| `tengu_startup_notice`/`auto_notice_once` | `""`/`!1` | 시작 공지 |
| `tengu_mcp_*` (`directory_bff`,`directory_visibility`,`singleton_unwrap`,`subagent_prompt`) | 각 다름 | MCP 동작 튜닝 |
| `tengu_review_bughunter_config`/`ultraplan_config`/`bg_classifier_config` | `null` | 기능별 설정맵 |
| `tengu_bridge_*` (`attestation_enforce(_config)`,`requires_action_details`,`system_init`,`vivid`) | 각 다름 | Remote bridge attestation |
| `tengu_fleetview_pr_batch` | `!0` | fleet PR 배치 |
| `tengu_remote_backend` | `!1` | 원격 백엔드 |
| `tengu_keybinding_customization_release` | `!0` | 키바인딩 커스터마이즈 릴리스 |
| `tengu_skills_dashboard_enabled` | `!1` | skills 대시보드 |
| `tengu_tab_read_sep`/`terminal_sidebar`/`tool_pear` | `!1` | UI/도구 실험 |
| `tengu_tool_search_unsupported_models` | `null` | ToolSearch 미지원 모델 목록 |
| `tengu_plugin_official_mkt_git_fallback` | `!0` | 플러그인 공식 마켓 git fallback |
| `tengu_vscode_onboarding`/`vscode_review_upsell` | `!1` | VSCode passthrough |
| `tengu_agent_list_attach`/`fg_left_arrow_agents`/`auto_background_agents` | `!1` | 에이전트 UX (`auto_background_agents` true면 자동 백그라운드 지연 120s) |
| `tengu_chrome_auto_enable` | `!1` | Claude-in-Chrome 자동 활성 |
| `tengu_flint_harbor_prompt`/`flint_harbor_share` | `{}`/`!1` | 팀 온보딩 프롬프트/공유 |

---

## 2. 그룹별 해석

### 2.1 모델 라우팅 — `velvet_cascade` / `vellum_lantern` / `fennel_kite_model`

simple system prompt 결정 체인 (`f$=X6(H=>...)`, offset 4467498):

```
f$(model):
  if env CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT truthy  → true
  if env ...                       falsy           → false
  if !IC1(model)                                   → false   # IC1: opus-4-7 / -eap / 기타 가족
  if Hr_||BL9(-eap)||UL9(model)                    → true
  else return Z_("tengu_vellum_lantern", false)              # 최종 fallthrough
```

`UL9(model)` (모델→simple-prompt 라우팅, 확인):

```
UL9(model):
  q = v_().clientDataCache?.simple_system_prompt           # 원격 주입 맵 {modelSubstr: true}
  if typeof q==="object" && Object.entries(q).some(([k,v]) => v===true && model.includes(k))
       → true
  K = Z_("tengu_velvet_cascade", null)                     # {models:[...]}
  if K.models is array && K.models.some(m => model.includes(m))
       → true
  → false
```

즉 simple system prompt는 **3중 소스**로 모델별 켜진다: ① `clientDataCache.simple_system_prompt`(서버 push 맵, key=모델 substring, value=true) ② `velvet_cascade.models` 배열(Statsig 실험, 모델 substring 배열) ③ `vellum_lantern` 전역 부울 fallthrough. `IC1()`이 1차 게이트로 `claude-opus-4-7` 및 `-eap` 변종을 통과시킨다.

`fennel_kite_model`은 별개 — **mid-conversation system prompt**를 어느 모델에 허용할지 결정(`Ll_`). `clientDataCache.tengu_fennel_kite_model`(string) override가 Statsig보다 우선.

### 2.2 프롬프트 tweak — `verified_vs_assumed` / `orchid_mantis(_v2)` / `slate_harrier`

`# Doing tasks` 빌더(offset 12912403)에서 게이트별 bullet을 spread로 조건 삽입:

- `verified_vs_assumed`: 확인 vs 추정 구분 강제 bullet.
- `orchid_mantis`/`_v2`/`mocha_barista`: `/schedule` 자동 제안 정책. `_v2`가 최우선(가장 보수적: "named artifact with future obligation만"), 다음 `orchid_mantis`(75%+ 확신 시 제안), 둘 다 off면 제안 없음. `CqO()` `/schedule` whenToUse 문구도 동일 게이트로 분기.
- `slate_harrier` (`$d8`, multivariate `"off"/"additive"/"compact"`): Opus 4.7 전용. 클러파잉 질문 전 "spend up to a minute on read-only investigation" bullet(`SB3`). simple-prompt(`f$`)면 강제 off.
- `amber_prism`/`amber_sentinel`/`ochre_finch`/`chair_sermon`: 권한 거부 문구, Monitor 도구 push 문구, memory 타입 섹션, attachment 변환 등 추가 프롬프트 tweak.

### 2.3 메모리 — `moth_copse` / `sepia_cormorant`+`umber_petrel` / `passport_quail` / `billiard_aviary` / `herring_clock`

- `moth_copse`: memdir(자동 메모리 prefetch) 마스터. off면 `AutoMem` rule 필터 제거 + `ga7()` prefetch 가드가 항상 early-return (offset 6031592/10255177).
- `passport_quail`: memdir 1차 부울 게이트(`pi_`), false면 즉시 off. `slate_thimble`은 비대화형 예외 허용.
- `sepia_cormorant`(rollout 배열) + `umber_petrel`(역게이트): 모델이 배열에 매칭되고 `umber_petrel`까지 true면 자동메모리 **mute**(`mi_()`). 점진 출시 + 비상 holdback 패턴.
- `billiard_aviary`(`dw()`): team memory dir 경로(`IS1` vs `CS1`) 선택.
- `herring_clock`(`_O_`): team memory 활성. `bramble_lintel`: 추출 batch 임계.

### 2.4 텔레메트리 — `log_datadog_events` / `trace_lantern`

- `log_datadog_events`(상수 `XL9`): `PL9()` true면 `TC1`/`$C1`가 일반 텔레메트리 외에 Datadog(`OpH`)로 추가 전송. `A0H("datadog")`(opt-out)이 게이트보다 우선. `V98()`로 캐시.
- `trace_lantern`(`kf`): `ENABLE_BETA_TRACING_DETAILED`+`BETA_TRACING_ENDPOINT` 전제, 비대화형(`R8()`)이거나 게이트 on이면 span에 `system_prompt_hash`, (`OTEL_LOG_USER_PROMPTS`면) `system_prompt_preview` 500자 기록.

### 2.5 데몬·서비스 — `copper_lantern`(킬스위치) / `amber_anchor` / `quiet_harbor`

- `copper_lantern`: supervisor 폴링 루프가 `K==="service"&&q98()`이면 `k=true` → 워커 SIGTERM 드레인 + service 언인스톨 + `d("tengu_copper_lantern",{})`. **원격 강제 service recall 킬스위치**(확인).
- `amber_anchor`: supervisor를 "daemon" 명명/모드로. `quiet_harbor`: cold-start를 `"ask"` vs `"transient"`.

### 2.6 기능 토글 (kill/enable)

`streamingToolExecution`(`tengu_streaming_tool_execution2`), `send_user_file`, `slim_subagent_claudemd`, `surreal_dali`(routines), `harbor`(channels), `amber_flint`(agent teams), `kairos_brief`, `velvet_static`(`/radio`), `chomp_inflection`(prompt suggestion), `cobalt_raccoon`(reactive compact), `slate_prism`(progress summaries) 등.

---

## 3. 게이트 평가 메커니즘

`Z_(H, _)` (extracted-functions.js:5634):

```
function Z_(H,_){
  let q=m3_(); if(q && H in q) return q[H];          // 1순위: m3_() override 맵
  let K=p3_(); if(K && H in K) return K[H];           // 2순위: p3_() override (현재 빌드 undefined)
  if(!Gs()) return _;                                  // GrowthBook 비활성 → default
  if(s$H.has(H)) Ii_(H); else x3_.add(H);              // 노출 추적: 실험이면 Ii_(노출 emit), 아니면 x3_ 집합 추가
  if(XF.has(H)) return XF.get(H);                      // 강제값 캐시
  try{ let O=v_().cachedGrowthBookFeatures?.[H];        // 실제 소스: GrowthBook 캐시
       return O!==void 0 ? O : _; }
  catch{ return _; }
}
```

핵심:

- **우선순위**: `m3_()` override → `p3_()` override → GrowthBook 캐시(`cachedGrowthBookFeatures`) → default. `m3_()`는 lazy 초기화 후 `lR9` 반환(확인), `p3_()`는 이 빌드에서 `return;`(undefined)이라 비활성(확인).
- **`Gs()`**: `!DISABLE_GROWTHBOOK env && fF()`. env로 전체 무력화 가능 — 그러면 모든 게이트가 default.
- **노출 텔레메트리**: `s$H`(실험 정의 맵)에 키가 있으면 `Ii_(H)`가 `experimentId/variationId/userAttributes`와 함께 노출 이벤트 emit(A/B 실험). 아니면 단순 `x3_` 집합 등록(피처 플래그).
- **별도 override 채널 — `clientDataCache`**: `evalStatsigGate`가 아니라 `v_().clientDataCache?.<key>`로 직접 읽는 키가 있다(서버 push). 확인된 것: `simple_system_prompt`(맵), `tengu_fennel_kite_model`(string), `tengu_loud_sugary_rock`, `kelp_forest_sonnet`. 이 경로는 Statsig를 우회/선행.
- **결정**: 게이트는 GrowthBook(Statsig계열) feature catalog로 평가, env/override가 상위.

### 게이트 성격 구분

| 성격 | 식별 기준 | 예 |
|---|---|---|
| 순수 config flag | `x3_`에만 등록(실험정의 `s$H` 없음), default 의미가 분명, env override 동반 | `tengu_stream_watchdog_default_on`, `tengu_send_user_file`, `tengu_amber_wren`(설정맵) |
| A/B 실험 | `s$H`에 있어 `Ii_()` 노출 emit, 보통 multivariate(`"off"/"a"/"b"`) 또는 프롬프트 분기 | `tengu_slate_harrier`, `tengu_pewter_lark`, `tengu_cedar_inlet`, `tengu_verified_vs_assumed`, `tengu_orchid_mantis(_v2)` |
| 킬스위치 | default가 "정상 동작"이고 게이트가 true→차단/강등, 또는 supervisor가 폴링 | `tengu_copper_lantern`(service recall), `tengu_read_dedup_killswitch`, `tengu_classifier_summary_kill`, `tengu_sedge_lantern_holdback`, `tengu_umber_petrel`(holdback) |
| 점진 출시(rollout) | 배열/맵 + 모델·사용자 매칭 | `tengu_velvet_cascade.models`, `tengu_sepia_cormorant`, `clientDataCache.simple_system_prompt` |

(주의: 어떤 키가 `s$H`에 등록되는지는 런타임 GrowthBook payload에 의존 — 정적 추출만으로는 A/B vs flag를 100% 단정 못 함. 위 표는 호출부 형태 기반 추정.)

---

## 4. 흥미로운 발견

1. **`copper_lantern` = 원격 데몬 self-destruct.** 백그라운드 supervisor가 게이트를 주기 폴링하다 true가 되면 워커 SIGTERM 드레인 + service 언인스톨 + 텔레메트리. Anthropic이 원격으로 사용자 머신의 백그라운드 서비스를 강제 회수할 수 있는 킬스위치(확인).

2. **`simple_system_prompt`의 3중 라우팅.** Statsig 게이트(`velvet_cascade.models`), 서버 push 맵(`clientDataCache.simple_system_prompt`), 전역 부울(`vellum_lantern`)이 모두 모델 substring 매칭으로 simple prompt를 켠다. `claude-opus-4-7`/`-eap`이 1차 통과 대상. 즉 특정 모델에 한해 시스템 프롬프트를 **런타임에 슬림 버전으로 교체**할 수 있는 인프라.

3. **`orchid_mantis` / `orchid_mantis_v2` — `/schedule` 자가영업 실험.** v2는 "named artifact with a stated cleanup/ramp date를 verbatim 인용할 때만 1회 제안", v1은 "75%+ 확신 시 제안". 모델이 작업 후 스스로 후속 cron을 권하도록 하는 프롬프트 A/B가 두 단계로 점진 보수화됨.

4. **`slate_harrier` (investigate-first) — Opus 4.7 한정 행동 실험.** `"additive"`/`"compact"` arm에서 "클러파잉 질문 전 최대 1분 read-only 조사" 지시를 주입. simple-prompt면 강제 off — 즉 프롬프트 다이어트와 상호배타.

5. **`paper_halyard` — CLAUDE.md Project/Local 무시 A/B (위험).** true면 프로젝트/로컬 CLAUDE.md 지시를 메모리 빌드에서 통째로 스킵. 사용자 지시 준수에 직접 영향하는 실험 게이트.

6. **`sepia_cormorant` + `umber_petrel` 이중 게이트.** 전자는 자동메모리 모델 allowlist(점진 출시), 후자는 매칭됐을 때 오히려 끄는 holdback. rollout + 즉시 비상 차단을 한 함수(`mi_`)에 내장.

7. **`isAnt` 하드코딩 false + 살아있는 분기.** `ya7()`가 `isAnt:!1`로 박지만, 메인 루프에 `X.gates.isAnt && Z7H(z)!=="auxiliary"` → `Y57(agentId)` 경로가 그대로 존재(offset 10131126). Anthropic-internal 전용 코드패스가 이 빌드에서는 게이트 false로만 닫혀 있음(다른 빌드/원격 override에서 활성 가능). `NNH(...)`의 `D26()==="ant"`도 메시지 정규화에 ant 전용 단축 경로(offset 12772291) — Statsig가 아닌 user-type 판정.

8. **`velvet_static` = Claude FM lo-fi 라디오(`/radio`, https://clau.de/radio).** 게이트 하나로 가려진 이스터에그성 명령.

9. **`Monitor`/`amber_sentinel` — 모델 능동 push.** on이면 "사용자가 지금 행동할 만한 이벤트면 Monitor push를 보내라" 프롬프트. 모델이 사용자에게 능동 알림을 보내는 행동을 게이트로 토글.

10. **`amber_flint`(agent teams, default `!0`) / `surreal_dali`(remote routines) / `harbor`(plugin channels)** — 미발표 대형 서브시스템이 게이트 뒤에 완성된 채 대기. `amber_flint`는 default true라 env(`--agent-teams`)만 주면 동작.

11. **`clientDataCache`는 Statsig 우회 채널.** `simple_system_prompt`, `fennel_kite_model`, `loud_sugary_rock`, `kelp_forest_sonnet`이 `evalStatsigGate` 노출추적 없이 서버 push로 직접 읽힘 — A/B 분석 외 즉시 적용 경로.

12. **`cobalt_raccoon`가 reactive autocompact + 1M-context window 판정의 마스터 게이트.** off면 reactive compaction과 autocompact-window 자체가 비활성(`Nw_`). 컨텍스트 관리 핵심이 단일 코드네임 게이트에 묶임.
