# 2026-06-02 4사 기능 합집합 어딧 — quanta 흡수/강화 델타

> 3회 어딧(R1 vendor 인벤토리 추출 → R2 stale-claim ground-truth 검증 + 교차수렴/buried 스윕 → R3 진짜-갭 숏리스트 실코드 최종검증). 입력 = [quanta-comparison.md](quanta-comparison.md) + vendor 원본 문서들([claude.md](claude.md)/[codex.md](codex.md)/[cursor.md](cursor.md) + 변종 + [repomaps](../code-agent-suit/)) + [10.feature-catalog.md](../../../10.feature-catalog.md) + 실제 `src/`.
>
> 표기: ✅보유(wired) · 🟡부분/seam/default-OFF · ❌없음. ROI = 흡수가치/비용.

---

## 0. 헤드라인 — 비교 문서가 stale다

[quanta-comparison.md](quanta-comparison.md)는 5/27 기준인데, 거기 "★ quanta 갭"으로 적힌 항목 **대부분이 이미 landed + wired**다. R2/R3에서 실제 `src/`로 ground-truth를 찍어 확인:

| comparison이 "갭"이라 한 것 | 2026-06-02 실측 | 증거 |
|---|---|---|
| A8 idle/stream-hang timeout (HIGH 갭) | ✅ **LANDED·wired** | `src/llm/stream-timeout.ts` `withStreamTimeout`(firstChunk 60s+idle 120s), 전 어댑터(anthropic/openai/responses/bedrock/vertex/foundry) 호출. ADR-0200/0227 |
| B8 OS sandbox (★★★ 최대 갭) | ✅ **LANDED·enforcing** | `os-sandbox/{seatbelt,landlock,landlock-native,bubblewrap}.ts` + verbatim profile. `runShell`이 `getShellSandbox()` 소비(global) + bash `mode=read` 시 실제 `sandbox-exec`/Landlock wrap(per-call, fail-closed). Darwin VZ만 scaffold |
| B9 shell 격리 | ✅ disclaimer + 위 OS wrap | `shell-disclaim.ts` `--noprofile --norc` + B8 |
| B12 MCP Tasks+Elicitation | 🟡 **split** | Elicitation ✅ wired(`mcp/client.ts` routeElicitation). Tasks 🟡 port+in-memory store만, **live JSON-RPC transport 없고 `mcp_tasks` 툴 미등록** |
| C2 identity variant | ✅ static wired | `buildSystemPromptForMode` variantFor(mode).identity, 6-mode 테이블. ⚠️ per-turn `buildIdentityReminderText`만 dead-code(test-only) |
| F11 vision/image | ✅ **LANDED·default-on** | `tool/image/{read,from-url}.ts`, `buildDefaultTools` 무조건 등록 |
| F12 web | ✅ web_fetch always-on / web_search default-OFF | `webFetchTool()` 무조건. `web-search.ts`는 `config.webSearch.provider` 필요 |
| A9 background subagent fork | ✅ **LANDED·wired e2e** | `tool/subagent-bg/` fork→handle 즉시반환·detached, `session-execution-plane.ts` 실 scheduler + stuck-detector(ADR-0223) |
| B11 hook updated_input | ✅ wired | `admissibility-gate.ts` onInputMutation→`dispatch.ts` effectiveCall. ADR-0113 |
| retrieval 합성루트 (deferred) | ✅ **wired 양 surface** | `apps/cli/internal.ts` + `apps/agent/index.ts` `buildSearchPipelineFromEnv` → `search_codebase` |

**결론**: "OS sandbox가 단일 최대 갭"이라는 옛 결론은 틀렸다 — 이미 enforcing 중이고 남은 건 Darwin VZ scaffold 하나. quanta는 합집합 대부분을 hard-gate 철학으로 이미 덮었다.

---

## 1. 합집합 골격 (R1, 축별 vendor signature)

전체 인벤토리는 R1 에이전트 4건이 A~H축으로 떴음(이 문서 범위 밖, 요약만):

- **Claude**: 13툴 풀 JSON 스키마 클라전송 · stop_reason 8-enum 1급 · MCP 풀스택(Tasks+Elicitation+OAuth-upscope+Sampling+Streaming) · rewind+fork 타임트래블 · disclaimer POSIX_SPAWN_SETDISCLAIM · trust 5-tier space×time · Cowork microVM(Go runtime+vsock+MITM) · Computer Use Carbon-level · 22+ env 멀티클라우드(Foundry+OIDC) · section-granular prompt cache · post-compact 파일복원(50K/5K).
- **Codex**: exec_command 원툴-셸 철학 · native multiple function_call(max 17) · apply_patch V4A(`*** Move to:` atomic rename) · 2-phase LLM 메모리 consolidator(임베딩 0, injection 방어 codified) · Chronicle ambient 메모리 · mid-turn cancellation-free steer + NonSteerableTurnKind · 16-type closed error enum · shell_snapshots 헤르메틱 env · Node REPL 영속 커널 · RRULE automations + inbox · 6-engine 브라우저 + exportGsuite · `::git-*` directive(실행/보고 분리) · Guardian post-denial precedence · OTel `_safe`/`_log_only` dual-copy.
- **Cursor**: 44 typed ToolCall + per-failure-mode oneof · model_visible≠client_visible 에러 · FastApply(stream full-content + 25 모델 A/B) · fused cursor-prediction(Tab-Tab 다음위치) · 25/60ms 디바운서 · .mdc glob 룰 + read-time `related_cursor_rules` · 20 hook(updated_input + followup_message) · provider-backed rejection-history 휴리스틱 · 구조화 5-field `reflect` + lint-grounded OpusChainReflect 3-way · crepe ngram-역색인 grep · shadow git ODB(AIMD budget + geometric repack) · `await{regex}` + async-shell BACKGROUND · in-process network proxy · pr-review-canvas moved-code detection · AI-tracking provenance DB.
- **quanta**: 합집합 대비 위치는 §2~3. 고유자산(3사 어디에도 없음): B5 ApprovalOutcome 8-state+invariant · B3 admissibility 8-stage 단일함수 SSOT · B10 fs-jail branded type+scanner · A3 RecoveryAction 6-enum · A4 streaming HOL barrier+order · C1 정책스택 L1-L9 코드화 · C3 escapeReminderBoundary · D5 verify-guard+closeout hard-gate("test 안 하면 종료 불가" 유일) · E2 3단 edit 회복.

---

## 2. 신규 흡수 — ❌ 진짜 없음 (R3 실코드 검증)

| 기능 | 출처 | 왜 좋은지 | ROI |
|---|---|---|---|
| **diff→PR본문/커밋메시지 자동 작성** | Copilot/Codex yeet/Cursor | `git_commit`은 `wip:` 타임스탬프만 자동, regular는 메시지를 받기만 함. diff를 읽어 conventional-commit 메시지/PR body를 **저작**하는 스텝 없음. usecase상 Copilot 압도 최대 *볼륨* 카테고리(PR설명 28K·커밋 1.2K), CLI/git 에이전트에 딱·위험 낮음 | **높음 / 비용↓** |
| **compaction 후 워킹셋 파일 복원** | Claude(50K총/5K파일) | 현 compaction은 "건드린 파일 목록" terse brief만, 편집 중이던 파일 *내용* 재주입 없음. 긴 멀티파일 작업서 압축 직후 작업대상 파일이 컨텍스트서 빠짐. (rewind/checkpoint restore는 user-triggered라 직교) | 중 |
| **read_paths(이미 읽은 파일) 추적** | Cursor `ConversationStateStructure.read_paths`(field 18) | 재읽기 dedup + closeout R1("진짜 소스 읽었나") 백업 신호. 현재 read 도구가 무엇을 읽었는지 추적 안 함 | 중·저 / 비용↓ |
| **실행중 셸 mid-flight 백그라운드 detach** | Cursor `force_background_shell` + `ShellBackgroundReason` | `bash timeout_behavior=background`는 *자기 데드라인* 만료시에만 detach. 이미 돌고있는 명령을 죽이지 않고 지금 백그라운드 전환하는 경로 없음 | 저 |

---

## 3. 강화 — 🟡 부분 보유 (R3 실코드 검증)

| 기능 | 현 상태 | 강화 포인트 | ROI |
|---|---|---|---|
| **co-change를 검색 신호로** | `git_churn`/`blame_heatmap`/`git_moved_code` **툴**은 있으나 `src/retrieval/`에 co-change feed 없음(commit-*메시지* 임베딩만) | 함께 바뀌는 파일을 context로 surface(Cursor GetGitGraphRelatedFiles `{path,weight}`). usecase상 Learning 19%+Read-mode 40%가 요구 | **높음** |
| **시맨틱 코드검색 default** | `search_codebase` 기본 `lexical-only`, 임베딩은 `QUANTA_INDEX=on` 필요 | 기본 도달성/자동 인덱싱 — 단 BYO-key 비용 트레이드오프 신중히 | 중(비용주의) |
| **MCP Tasks** | port+in-memory store+poller만, live JSON-RPC transport 없고 `mcp_tasks` 툴 미등록 | 실 transport 바인딩 + 툴 등록(Elicitation은 이미 완비). Claude/Codex 둘 다 보유 | 중 |
| **automation 엔진** | RRULE파서+sqlite+ticker+`QUANTA_AUTOMATION=on`+`automation_update` 툴 다 있는데 base가 stub agentLoop 주입 → 재귀 실행 라이브 아님(mode-preset만 override) | live loop handler 와이어. **단 CLI 단일세션 scope 질문이라 의도적 보류일 수 있음 — scope 판단 먼저** | 중 |
| **plan-effort 분리 + xhigh** | effort 5단(default/max/high/med/low) 세션 단일축, plan/exec 공유, xhigh 없음 | plan-mode 별도 effort + xhigh 추가(Codex). "계획은 깊게 실행은 빠르게" | 저·중 |
| **identity per-turn 리마인더** | static per-mode 슬롯 wired, `buildIdentityReminderText` dead-code(test-only) | 프로덕션 호출부 1줄 연결 | 사소 |

---

## 4. 검토할 buried gems (미구현 검증, 후보)

R2 교차수렴/buried 스윕에서 나온 것 중 quanta가 안 가진 것으로 보이는 것 (실코드 미검증, 흡수 전 확인 필요):

- **read-time 룰 자동첨부** — Cursor `read_file`이 glob 매칭된 `.mdc` 룰을 결과에 붙임(`related_cursor_rules`). quanta는 per-turn glob 룰 주입이라 read시점 첨부가 더 샤프(룰이 read 시점에 맥락화).
- **context chunk 출처 태그** — Cursor `CodeChunk.Intent` 9종(MENTIONED/VISIBLE/AI_EDITED/SELECTION/TERMINAL_SELECTION/...). 각 컨텍스트 조각이 왜 들어왔는지 모델에 알려 가중치 부여.
- **`verify-this` falsifiable verdict 스킬** — Cursor: claim을 반증가능 형태로 + baseline/treatment + exactly-one verdict{VERIFIED/NOT/INCONCLUSIVE}. quanta verify-guard 하드게이트가 더 세지만, 타입드 verdict 스킬은 추가 여지.
- **automation용 `agentic_filter_prompt`** — Cursor: 트리거 발화↔에이전트 기상 사이 LLM 게이트(ALLOW/BLOCK + rationale). 노이즈 이벤트마다 에이전트 스폰 차단. automation 엔진 강화와 짝.
- **WriteStdin 직전 오프셋 반환** — Cursor `terminal_file_length_before_input_written`. stdin 주입 후 모델이 응답을 정확히 어디서부터 읽을지 앎.

---

## 5. 의도적 보류 (흡수 안 함 — scope/철학)

- **browser-drive / E2E 6엔진**(Cursor/Codex) — 고비용, CLI surface 밖. Testing 카테고리 상한이지만 빈도·비용상 보류 정당.
- **Computer Use 네이티브**(Carbon/NSXPC) — surface 밖.
- **microVM / desktop IPC / marketplace / BLE pet / Squirrel** — 제품/운영 인프라(ADR-0011 근거).
- **Fernet reasoning 암호화**(Codex) — 멀티테넌트 아님, IP보호 불필요.
- **Statsig/Datadog/Sentry 원격 텔레메트리** — BYO-key 프라이버시 의도적 opt-in(Codex와 동일 철학).

---

## 6. 권장 착수 순서

1. **diff→PR/커밋메시지 자동 작성** (§2, ROI 1위) — 최고 볼륨·최저위험. `git_commit` 메시지 저작 스텝 + PR-body-from-diff 스킬/툴.
2. **co-change 검색 신호** (§3) — 기존 `git_churn`/`blame_heatmap` 출력을 retrieval context feed로 연결. Learning/Read-mode 빈도 가중 최상위.
3. **MCP Tasks live transport** (§3) — Elicitation 완비 상태라 sibling 마무리.
4. **compaction 워킹셋 복원** (§2) + **read_paths 추적** (§2) — 긴 작업 신뢰성.
5. automation live handler / plan-effort+xhigh / identity per-turn 리마인더 — scope 판단 후.

방법론은 기존 패턴(worktree-isolated SOTA++ 병렬 + cherry-pick, default-OFF seam, hellgate-first TDD) 그대로. 전부 신규/leaf 슬라이스라 conflict-free 흡수 가능.
