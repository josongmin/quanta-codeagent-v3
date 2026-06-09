# jun-09 — 남은 흡수 후보 (경쟁사 갭, 결정 대기)

- **날짜**: 2026-06-09
- **출처**: `jun-7-gap-other-agent.md` §27 (코퍼스 2026-06-01 refresh content-diff) 에서 **아직 연동 안 된 것만** 추출 + 직전 reconcile의 진짜 잔여.
- **목적**: 흡수/defer/skip **결정 보드**. jun-7-gap-other-agent.md 본체는 jun-09에 reconcile 완료(닫힌 것 ✅ flip) — 이 문서는 그중 **남은 to-do만** 모은 라이브 결정판.
- **결정 범례**: ⬜ 미정 · ✅ 흡수 · ⏸ defer · ❌ skip(의식적). `결정` 칸 `rec:`=권장(override 가능).
- **신뢰도 주의**: 흡수-fleet이 throttle로 수회 전멸 → inline 단독 어딧. 읽기쉬운 소스(CC settings 123필드/slash/hooks · Codex config.toml/symbol덤프 · Cursor 확장)는 완독, **Codex/Desktop webview minified 로직(collaboration-mode/appgen/telepathy 깊은 메커니즘)은 부분만** — conf=中-低 항목은 content-diff 추가 패스 필요(3바퀴 워크플로우 `competitor-absorption-r3` 결과 도착 시 §F에 병합).

---

## §A 신규 기능 후보 (quanta 부재 — grep 확인)

| # | 후보 | 출처 (경쟁사 evidence) | quanta gap | 흡수 메커니즘 | ROI | effort | conf | 결정 |
|---|---|---|---|---|---|---|---|---|
| N1 | 어시스턴트 언어 자동감지 | Cursor `whichlang-node` (agent-exec, `assistant-language-tracking`, 16-lang) | grep 0 | 유저 입력언어 감지→system-prompt `respond in <lang>` | 중 | S-M | 高 | ✅ **LANDED (jun-09)** — `src/agent/language-detect/`(Unicode-script argmax) + knob `QUANTA_LANG_DETECT`(default-OFF, runtime-config+inventory) + buildDynamicContext push + context-assembler thread. 16 test(detect 8 + buildLanguageHint 5 + hellgate 3) + fc entry. 内 파일 tsc 클린 |
| N2 | Codex collaboration-mode | Codex 3390 `app-server-manager-signals` webview: `collaborationMode`·`handoff`/`handoffId`·`pendingRequestCount` (jun-09 signal-level 확인) | quanta `handoff`은 LLM provider retry routing(`codex-spec-router`)뿐 — 멀티에이전트 턴 핸드오프 아님 | **에이전트↔사용자 턴 핸드오프(handoffId) + pending-request 큐** 추적 | 중 | M | 中-高 | ⬜ rec:흡수검토(북극성 정렬) |
| N3 | Codex appgen 앱생성 | Codex 3390 webview `appgen-page/share-dialog/access-mode` | 전무 | 배포가능 앱 생성 surface | 저-중 | L | 中 | ⬜ rec:defer |
| N4 | `/doctor` 환경 진단 | CC `_cli-symbols.txt` `/doctor` | ~~slash 부재~~ | ~~env/config/MCP 헬스~~ | 중 | S | 高 | ❌ **FALSE-GAP (jun-09 재검증)** — `src/apps/cli/doctor/`(cmd/default-probes/registry/render) **이미 완전 구현**(jun-6 RFC). audit이 CC에 있다고 quanta에도 있는 걸 놓침 |
| N5 | `/catch-up` 세션간 변경요약 | CC `/catch-up` | 부재 | 마지막 세션 이후 repo/대화 변경 요약 | 저-중 | S-M | 中 | ⬜ |
| N6 | `/babysit-prs` 자율 PR 모니터 | CC `/babysit-prs` | 부재 | PR CI/리뷰 폴링 + 자동대응 루프 | 저-중 | M | 中 | ⬜ |
| N7 | 모델 personality 프리셋 | Codex config.toml `personality`(default/friendly/pragmatic) | ~~grep 0~~ | 응답 톤 프리셋 | 저-중 | S | 中 | 🟡 **PARTIAL (jun-09 재검증)** — quanta `pickPersona`/`pickIdentity`(`QUANTA_IDENTITY`+`_MODE` default/plan/review/audit/onboarding, ADR-0198) 존재. **tone-preset 축**(concise/friendly/pragmatic)만 기존 identity provider에 추가하면 됨 |
| N8 | request body gzip 압축 | Codex `enable_request_compression` | grep 0 | 대용량 컨텍스트 LLM 요청 gzip | 저 | S | 高 | ⬜ |
| N9 | `undo` 도구 (액션 되돌리기) | Codex `undo` tool | ~~grep 0~~ | ~~file 되돌리기~~ | 중 | S-M | 高 | ❌ **COVERED (jun-09 재검증)** — `file_history_rewind` 도구(per-file snapshot+restore, `src/tool` + `/rewind-tool` 3-way) = file-mutation undo. Codex `undo`의 non-file 범위만 미세 gap |
| N10 | `js_repl` 도구 | Codex `js_repl_tool` | grep 0 | 세션 영속 JS REPL (code-mode와 별개) | 저-중 | M | 高 | ⬜ |
| N11 | `chronicle` 세션 저널 | Codex `chronicle` | grep 0 | 세션 행적 연대기(무엇/왜, 시간순) | 중 | M | 中 | ⬜ rec:observability 북극성 정렬 |
| N12 | `telepathy` 에이전트간 도구 | Codex `telepathy` tool | grep 0 | 에이전트간 공유 컨텍스트 push | 저 | M | 低 | ⬜ |
| N13 | web_search cached 모드 | Codex `[features].web_search`=live\|cached\|disabled | cached 없음 | 캐시 검색결과 재사용(비용/속도) | 저 | S-M | 高 | ⬜ |

## §B 기존 기능 강화 후보 (quanta 얕음/부분)

| # | 후보 | 출처 | quanta 현재 | 강화점 | ROI | effort | conf | 결정 |
|---|---|---|---|---|---|---|---|---|
| E1 | managed-only 엔터프라이즈 락다운 | CC `allowManaged{Hooks,McpServers,PermissionRules}Only`·`strictPluginOnlyCustomization` | central-config+trust(ADR-0497) | 관리자 managed-only 강제 | 중(ent) | M | 高 | 🟡 **CORE 이미존재 + sub LANDED(jun-09)** — perms/hooks managed-only는 ADR-0497로 **이미 있음**(types.ts:53-71). **MCP managed-only(`allowManagedMcpServersOnly`)는 jun-09 추가**(merge.ts, test). MCP enforcement는 jun-10 LIVE(E2 행 참조). 남음: `strictPluginOnlyCustomization`만 |
| E2 | MCP denylist + marketplace 거버넌스 | CC `deniedMcpServers`·`blockedMarketplaces` | allowed/enabled만 | denylist + 거버넌스 | 저-중 | S-M | 高 | ✅ **LIVE (jun-10)** — resolve(merge)+loader 파싱(`deniedServers`/`allowManagedMcpServersOnly`)+**enforcement 배선 완료**: `resolveMcpLaunchPolicy`(비인터랙티브 trust, fail-soft)+`filterMcpServersByPolicy`(pure)+`readMcpConfig` 정책 적용+`loadFeatures` 주입. e2e 6(gate-OFF byte-identical/denylist+slog/trusted allowlist/untrusted deny생존/managed-only/no-cliff)+merge 5+filter 5. **§12.4 built-not-wired도 같이 해소**(mcpEnabledServers 최초 실소비). marketplace 거버넌스는 별도 미착수 |
| E3 | `/rewind` 체크포인트 복원 슬래시 | CC `/rewind` | ~~slash UX 없음~~ | ~~타임라인 복원~~ | 중 | S | 高 | ❌ **FALSE-GAP (jun-09 재검증)** — `/rewind`+`/rewind-tool` **이미 존재**(`rewind-cmd.ts`, `QUANTA_REWIND` gate, 3-way restore files/task/both, ADR-0203/0205). audit 누락 |
| E4 | `/goal` 목표 추적 슬래시 | CC `/goal` | objective 시스템 있음, slash 없음 | objective set/show/clear slash | 저 | S | 高 | ⬜ |
| E5 | cursor-agent-worker startup prewarm | Cursor `cursor-agent-worker` | side-agent/attach-daemon 유사 | startup 상시대기 background agent prewarm | 중 | M | 中 | ⬜ rec:daemon 중복확인 |
| E6 | `claudeMdExcludes` 메모리 로드 제외 | CC `claudeMdExcludes` | CLAUDE.md 무조건 로드 | 거대/무관 메모리 제외 globs | 저 | S | 高 | ⬜ |
| E7 | `/hooks` 인터랙티브 관리 | CC `/hooks` | hook 11종 있음, 관리 slash 없음 | hook list/enable/disable/test slash | 저 | S | 高 | ⬜ |
| E8 | 메모리 lifecycle GC + 모델분리 | Codex `max_unused_days`·`consolidation_model`·`extract_model` | 2-phase distill, GC/모델선택 knob 없음 | 미사용 메모리 GC + consolidation/extract 모델 분리 | 저-중 | S-M | 高 | ⬜ |
| E9 | session rollout/store retention GC | Codex `max_rollout_age_days`·`min_rollout_idle_hours` + CC `cleanupPeriodDays` | session store, age/idle GC 없음 | 세션 보존 GC(나이/idle/startup당) | 저-중 | S-M | 高 | ⬜ |
| E10 | plan-mode 전용 reasoning effort | Codex `plan_mode_reasoning_effort` | 5-tier effort, plan-mode 별도 없음 | plan 모드 별도 effort tier | 저 | S | 高 | ⬜ |
| E11 | granular hook 포인트 | Cursor `beforeContext`·`beforeMCPExecution` | PreToolUse/beforeReadFile만 | `PreContext`·`PreMcpExecution` hook 추가 | 저 | M | 中 | ⬜ |
| E12 | per-agent usage-hint text | Codex `root_agent_usage_hint_text`·`subagent_usage_hint_text` | grep 0 | root vs subagent 별 사용힌트 주입 | 저 | S | 高 | ⬜ |
| E13 | `child_agents_md` 서브에이전트 instruction | Codex `child_agents_md` | AGENTS.md 있으나 child 전용 미확인 | 서브에이전트 별도 instruction 파일 | 저 | S | 中 | ⬜ |
| E14 | apply_patch streaming events | Codex `apply_patch_streaming_events` | V4A apply_patch, streaming 미확인 | 패치 적용 진행 streaming(대형 패치 UX) | 저 | M | 中 | ⬜ |

## §C 진짜 잔여 (의식적 defer / 외부차단 — 흡수대상 아님)

| 항목 | 상태 | 근거 |
|---|---|---|
| NotebookEdit (P17, §16.5) | ✅ **LANDED (jun-09, W6)** | `notebook_edit` 도구(str_replace/insert/delete, FS-jail atomic, `QUANTA_NOTEBOOK_EDIT`) — §F W6 행 참조. 라이브커널 실행만 별도 defer |
| Windows `bash -lc` (P16, §17.2) | ⏸ defer | darwin서 테스트 불가, 플랫폼 수요 대기 |
| crash-RESUME interrupted-turn 마커 (§13.2) | 🟡 built-not-wired | same-turn interrupt-restore는 LANDED; 영속 마커만 미배선. **§12.4 MCP는 jun-10 LIVE로 해소**(같은 inert 클래스의 첫 배선) |
| Codex computer-use (matured) | ⏸ RFC-defer | 최고 보안표면, Tauri/desktop-only |
| Mantle SDK 어댑터 | ❌ blocked | `@anthropic-ai/mantle-sdk` 미발행(외부) |
| jun-8-ide-plugin 플랜 (`/plugins` 표면 등 티켓 01-08) | 📐 design | 인프라 reuse✅, 티켓 미구현 — forward 작업(닫힌 백로그 아님) |

## §D 저ROI / skip 권장 (결정만)

CC UI 토글: `showThinkingSummaries`·`showTurnDuration`·`showMessageTimestamps`·`spinnerTips`·`terminalProgressBarEnabled`·`theme`·`prefersReducedMotion`(a11y) · `attribution`·`autoUpdatesChannel`/버전핀 · `skipWebFetchPreflight` · `isolatePeerMachines` · `feedbackSurveyRate` · `companyAnnouncements`. → surface polish/니치, quanta 모델과 결 다름. **결정: ⬜ (기본 ❌)**

## §E 우선순위 제안 (jun-09 코드 재검증 반영)

> **🔴 false-gap 정정:** audit "rec:흡수" 6개 중 **N4 /doctor·E3 /rewind = 이미 존재**, **N9 undo = file_history_rewind로 커버**, **N7 personality = pickPersona/Identity로 부분커버**. 코드검증 없이 흡수권장한 게 틀림(false-parity 함정 재현 — [[jun-07-gap-other-agent-audit]] 교훈). **빌드 전 반드시 broad-grep 검증.**

**✅ 랜딩:** N1 언어 자동감지 (jun-09) · W6 notebook_edit (jun-09) · MCP 거버넌스 LIVE (jun-10, ADR-0530) · **W5 DAP 디버거 `debug_inspect` (jun-10, ADR-0531)**.

**🟥 DROP:** DXT launcher 배선 — `.dxt` 소비처(discovery 경로)가 src 전무라 배선하려면 안 쓰는 포맷의 discovery까지 새로 지어야 함(투기적). built-not-wired지만 살릴 소비자 없음 → 정직 스킵.

**🔚 jun-10 CLOSEOUT — 마퀴 갭 전부 완결, 나머지는 저ROI tail (빌드 전 검증 결과):**

실질가치 큰 비-inert 갭은 모두 랜딩됨(N1·W6·MCP거버넌스·W5 DAP). 남은 후보는 broad-grep 검증 결과 **저ROI거나 quanta 모델 불일치** — build-for-build's-sake 회피, 사용자가 ROI 보고 선택할 항목으로 (기능)+(왜)+(ROI) 정리:

| 후보 | (기능) | (왜/현재상태) | (ROI) |
|---|---|---|---|
| E6 claudeMdExcludes | 메모리/contract 로드 제외 globs | glob-rules가 **이미** per-file 64KiB + 256파일 cap으로 bloat 보호; quanta는 단일 contract 모델(계층적 다중 CLAUDE.md auto-discovery 부재)이라 exclude 전제 약함 | **저** — 보호는 cap으로 이미 존재 |
| E1 strictPluginOnlyCustomization | 플러그인 커스터마이징 managed-only 잠금 | perms/hooks/MCP managed-only는 완료(ADR-0497/0530), plugin-customization 표면 게이팅 의존 | **저(엔터프라이즈 니치)** |
| N5 /catch-up | 세션간 변경요약 슬래시 | dream/cross-session-trigger·session-memory-auto 머신리 존재, 슬래시 surface만 부재 | **중-저** — 기존 위 얇은 surface |
| E4 /goal | objective set/show/clear 슬래시 | objective 시스템 존재(agent-config-assembler), /goal 슬래시 부재 | **중-저** — 북극성(상태가시성) 정렬되나 thin |
| N11 chronicle | 세션 행적 연대기 | `agent/working-state.ts`+`memory/working.ts`+away-summary와 **중과반복** | **저** — 기존 세션저널류와 겹침 |
| N8 gzip·N10 js_repl | 요청압축·JS REPL | provider-acceptance/exec 리스크 | **defer(리스크)** |

→ **이 tail은 사용자 지목 시 개별 풀사이클**. 무지목 빌드는 저가치 중복개발이라 보류.

**✅ 랜딩 완료 타겟:**
1. ✅ ~~**W5 DAP 디버거 도구군**~~ — **LANDED (jun-10, ADR-0531)**: `debug_inspect`(launch→첫 breakpoint→stack/scope/vars 1샷), DAP codec/client/driver/port 4층, 25 test, default-OFF+always-confirm. continue/step-across-calls는 후속
2. **W6 Jupyter 셀 편집/실행** — ipynb READ만 있음, EDIT/EXECUTE 부재. **편집(str_replace_cell/add/delete)은 bounded**(=NotebookEdit P17 defer 해소), 라이브커널 실행은 L
3. **N11 chronicle** — 세션 저널, agent-state observability 북극성 정렬 (M)
4. **E1 managed-only 락다운** — 엔터프라이즈 central-config 확장 (M)
5. **W1/W2/W3 plugin 보안·거버넌스** — DXT 호환성/코드서명/org-allowlist (M~L)
6. **N7 tone-preset** — 기존 identity provider에 concise/friendly/pragmatic 축 추가 (S, additive)

**보류/저가치:** N8 gzip(provider가 request-body gzip 수용 안 할 risk — 검증 먼저) · N13 web_search cached(저) · N2/N3/N12(Codex webview content-diff 미완, §G)

## §F 3바퀴 워크플로우 결과 (도착 시 병합)

`competitor-absorption-r3` 워크플로우: R1이 10 후보 산출(cursor/cc-ide/claude-desktop finder 성공) → R2 verify는 **전부 throttle 전멸** → 트랜스크립트서 10개 회수 후 **메인루프서 직접 grep-verify**(jun-09). **9/10 진짜 gap 확인**(전부 §A/§B와 비중복, 새 영역). Codex finder(webview collab-appgen/codex-rs novel/cc-cli)는 socket-close+throttle로 사망 → **Codex 깊은 content-diff는 여전히 TODO**(§G).

| # | 후보 | type | 출처 evidence | quanta gap (grep 확인) | ROI | effort | conf | 결정 |
|---|---|---|---|---|---|---|---|---|
| W1 | DXT 확장 호환성 매트릭스 게이트 | enh | claude-desktop DXT runtime `compatibility`(runtimes/nodeVersion/pythonVersion) | shallow — `src/plugin-isolation/dxt-loader.ts` DxtManifestSchema에 `compatibility` 필드 없음 | 고 | M | 高 | ⬜ |
| W2 | 확장 코드서명 인증서체인 검증 | new | claude-desktop signed/self-signed/unsigned + x509 chain | absent — `verifySignature/x509/codeSign` grep 0 (plugin-isolation/skill) | 중 | L | 高 | ⬜ rec:보안가치 |
| W3 | org-스코프 확장 allow/blocklist + can_install (원격+TTL) | enh | claude-desktop 원격 org allowlist + 암호화캐시 TTL | shallow — `marketplace-policy.ts`는 정적 exact-match만(fetch/remote/TTL 없음) | 중 | M | 高 | ⬜ |
| W4 | @-멘션 라이브 외부UI 윈도우→스크린샷 | new | claude-desktop 멀티모달 컨텍스트 주입 | absent — 멘션리졸버는 file/symbol/skill/plugin/folder만 | 저 | L | 中 | ⬜ |
| W5 | **DAP 디버거 제어 도구군** | new | CC-IDE `set_breakpoint/step/evaluate/get_stack_trace/get_variables/get_scopes/continue/pause` | ~~absent~~ | 중 | L | 高 | ✅ **LANDED (jun-10, ADR-0531)** — `src/tool/debug/` (codec/client/inspect-driver/port) + `debug_inspect` 도구(launch→첫 breakpoint→stack/scope/vars/eval 1샷). default-OFF `QUANTA_DEBUG_TOOLS`, always-confirm(코드실행). 25 test. continue/step-across-calls 후속 |
| W6 | **Jupyter 셀 도구**(편집/실행) | new | CC-IDE `execute_cell/get_cells/add_cell/str_replace_cell` | shallow — ipynb READ만, EDIT/EXECUTE 불가 | 중 | L | 高 | ✅ **LANDED (jun-09)** — `notebook_edit` 도구 완성: core(editNotebook 12 test) + wrapper(FS-jail R/W·atomic·NEVER-throws) + git-write-guard 보강 + manifest GATED `QUANTA_NOTEBOOK_EDIT`(drift 라쳇 통과) + knob trio + registry(DefaultToolPorts.notebookEdit) + e2e hellgate(6) + fc. src tsc 클린. **NotebookEdit P17 defer 해소.** 라이브커널 실행=별도 L defer |
| W7 | workspace python venv/conda auto-activation | enh | CC-IDE 도구실행 전 `VIRTUAL_ENV`+PATH prepend | ⚠️ **possibly-present** — `VIRTUAL_ENV` grep 히트(local-env selection?) — 재검증 필요 | 저 | S | 低 | ⬜ rec:기존 local-env와 중복확인 |
| W8 | agent-authored 인터랙티브 canvas (.canvas.tsx) | enh | Cursor `cursor/canvas` authoring SDK | shallow — quanta canvas는 read-ONLY(`tool.diff`/`context.usage` 렌더만), 작성 불가 | 중 | L | 高 | ⬜ |
| W9 | per-environment rule scoping | enh | Cursor `environments`/`disabled_environments`/`attach_to_background_agents` | absent — glob-rules는 `globs`/`alwaysApply`/`description`만 | 저 | S | 高 | ⬜ |
| W10 | `suggest_next_prompt` 도구 | new | Cursor agent-suggested 다음 프롬프트 | absent — `suggestNextPrompt` grep 0 | 저 | S | 高 | ⬜ |

> **W5/W6 주목:** DAP 디버거 + Jupyter 실행은 quanta가 전혀 없는 **새 도구 패밀리**(§C의 NotebookEdit defer를 실행까지 포함해 대체). W1/W2/W3은 plugin/확장 보안·거버넌스 강화.

## §G 미완 — Codex deep content-diff (throttle TODO)

> 흡수-fleet의 Codex finder(`codex-webview-collab-appgen`/`codex-rs-novel-tools`/`cc-cli-deep`)가 socket-close + 지속 throttle로 **3회 연속 사망**. inline 보강(jun-09):
> - **N2 collaboration-mode = signal-level 확인됨**: webview `app-server-manager-signals`서 `collaborationMode`·`handoff`/`handoffId`·`pendingRequestCount` 식별 → 메커니즘 = **턴 핸드오프 + 펜딩요청 큐**(quanta의 `handoff`=provider retry routing과 무관). conf 中→中-高.
> - **N3 appgen / N12 telepathy = 여전히 미확정**(minified webview/symbol 레벨만, 깊은 동작 미해독).
> - **TODO(throttle 해제 시):** `competitor-absorption-r3` 재개(`resumeFromRunId: wf_68d59202-771` — 성공한 cursor/cc-ide/desktop finder는 캐시재사용) 또는 Codex webview/codex-rs를 메인루프서 직접 content-read.

## §H 🔴 메타발견 (jun-09) — "흡수"의 진짜 갭은 신규 흡수가 아니라 BUILT-NOT-WIRED 배선

빌드 전 broad-grep 재검증을 슬라이스마다 돌린 결과, 이 코퍼스(2026-06-01)는 jun-05~09 작업으로 **이미 ~95% 흡수**돼 있고, audit "신규 후보"의 대부분이 둘 중 하나였다:

1. **FALSE-GAP (이미 LIVE 구현)** — 6건: N4 `/doctor`·E3 `/rewind`·N9 `undo`(=file_history_rewind)·N7 personality(=`persona.ts` ADR-0068)·E1 perms/hooks managed-only(ADR-0497). 코드검증 없이 "흡수권장"한 게 false-parity 함정.
2. **BUILT-NOT-WIRED (resolve/core만, consumer 미배선 = inert)** — 확인된 것:
   - ~~**§12.4 central-config `mcpEnabledServers`** — launcher 미소비 inert~~ → ✅ **jun-10 LIVE 배선 완료**(`resolveMcpLaunchPolicy`+`filterMcpServersByPolicy`+`readMcpConfig`/`loadFeatures`; e2e 6). inert→LIVE 패턴의 첫 적용.
   - **DXT loader (`launchDxt`/`validateDxt`)** — 정의·export만, **호출 0**. plugin-discovery/launcher가 안 씀. (W1 DXT-호환성을 여기 지으면 또 inert.)

**결론 — 진짜 SOTA++ 다음 작업 우선순위 재정의:**
- (A) **inert→LIVE 배선** (높은 ROI, 이미 만든 것 살림): §12.4 MCP enabled/denied를 `loadFeatures`의 readMcpConfig 소비에 연결(central-config resolve+trust 필요) · DXT launcher를 plugin load 경로에 배선.
- (B) **진짜 신규 LIVE 빌드**: W5 DAP 디버거 도구군(유일한 큰 비-inert 신규, 전용 집중 필요).
- (C) **그만 흡수**: 남은 audit 후보(N8 gzip risky·N10 js_repl exec-risk·N13 저·W2/W3 plugin보안)는 저ROI/risk — inert layer 위 추가 금지.

**교훈(메모리화):** "경쟁사 흡수" 더 파기 전에 **기존 흡수분이 LIVE인지(consumer 배선) 먼저 grep**. resolve/core 존재 ≠ 기능 LIVE. [[jun-09-integration-audit-3round]] §13.2 built-not-wired 패턴의 반복.
