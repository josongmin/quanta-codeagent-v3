# SUPERSEDED - default-OFF 게이트 캠페인 2R 초안

이 문서는 2R 당시의 판단 이력이며 실행 권위가 아니다. 3R current-HEAD 감사에서 CLI effective-default 과소 집계, unreceipted 85/85 수치, web bind/auth P0, shipping `--tool-profile` 버그, prompt-suggestion live-state 갭, read-outline parser 주입 누락, 거짓 kill 기본값이 확인됐다. 실행은 [default-OFF SOTA++ execution board](jul-16-default-off-sota-plus-plus/00-index.md)와 leaf tickets만 따른다.

아래 W0-W5와 D1-D10은 historical input으로 보존하며 그대로 실행하지 않는다.

## 어딧 2R가 확정/뒤집은 사실 (플랜의 토대)

- **반증됨(v1 오류)**: distill-redaction hook 경로는 정상(redact 적용됨, memory-consolidator-hook.ts:240-254) · 유령 2건(auto-dispatch, debug-trace-autofix) 실존 · per-tool-granular auto-record는 QUANTA_PER_TOOL_RECORD ON시 배선됨 · QUANTA_REWIND 기본 ON(rewind-cmd.ts:107) · 0309 gate 실존.
- **확정됨**: 진짜 보안 갭 = `DefaultMemoryAutoTrigger.onSessionEnd`(src/memory/auto-trigger/default-trigger.ts:108-120)가 **raw rollout으로 runPhase1 호출** (opts에 redact 필드 없음) · playbook-trigger EMPTY_REGISTRY(.md 로더 부재) · read-outline apply는 **의도된 registry-only NOOP**(소스 주석 "APPLY IS A NOOP" — 버그 아님, 정직화 대상) · WEAK 판정 3종 스팟체크 전부 유지.

---

## W0 — 진실 정리 (선행, src 무접촉)

1. 인벤토리 정정 커밋: 유령 2건 실존 · REWIND→X(기본ON) · 0309 gate 실존 · per-tool-granular STUB 철회 · distill-redaction="auto-trigger 경로 갭"으로 재기술 · gh_pr_*→B(QUANTA_GIT_TOOLS 계열) · 0315/0316 D 해제 · 0094 oauth 테스트는 코덱-only 아님(풀 bearer/401 cycle e2e 존재) 반영.
2. fc yaml 정정(X류 ~20건 + seed 19종 주석 + read-outline "registry-only knob" 정직화): 커밋 전 `feature-catalog-yaml-hellgate` green. 함정: yaml dup-key(last-key-wins) — 편집마다 동일 들여쓰기 `unit:/integration:/contract:` 중복 검사, evidence 경로 실존 검사.

**DoD**: 인벤토리+fc 커밋, 헬게이트 green.

## W1 — 버그 수리 (W0과 병행 가능, src/memory 계열만)

**W1-1 distill-redaction auto-trigger 경로** (유일한 실버그, 보안):
- `DefaultMemoryAutoTriggerOpts`에 `redact?: DistillRedactor` 추가 → `onSessionEnd()` runPhase1 전 적용 → `new DefaultMemoryAutoTrigger()` 전 호출부 grep해서 hook과 동일 redactor 주입.
- 테스트: **양 경로(hook + auto-trigger)** red-on-injection — 시크릿 심고 distill 입력 불출현 증명.
- **W3 번들9의 선행 조건** (번들9는 W1-1 랜딩 후 시작).

**DoD**: 양경로 테스트 green + 주입 사이트 전수 확인.

## W2 — STUB 처분 (W3 시작 전 결정 완료 — 아래 Decision Log D2~D4)

| 기능 | 결정 | 스코프 |
|---|---|---|
| playbook-trigger (0293/0301) | **수리 확정** | 신규 `src/skill/playbook/registry-from-disk.ts` (~80-150 LOC, .quanta/playbooks/*.md 로더) + playbook-trigger-wire.ts EMPTY_REGISTRY 교체 + 로더 hellgate. DoD: 로더 red-on-injection 포함 green |
| plan-queue-helper 가족 (helper + mid-turn-steering + sendNow) | **유저 결정 D2** — 같은 plan-queue seam 3소비자, 한 번에: (A) loop 소비 배선까지 살림 → W3 번들7 풀스코프 / (B) helper kill + 0228만 유지 → 번들7 축소 | 결정 1개, 번들7 착수 전 |
| tool-profile-preset (0213) | **유저 결정 D3** — 쓸 거면 /profile 인자 연결, 아니면 kill | 결정 1개 |
| read-outline | **유저 결정 D4** — by-design registry-only로 fc 정직화(기본) or knob 자체 kill. "미완이라 kill"은 오진 — 의도된 NOOP | W0-2에 편승 |

## W3 — e2e 부채 상환 (본진, ~90기능 → 파일 ~35 상한)

레시피: `runAgent × scripted-LLM`, **bun test per-file green + `typecheck:all`**(bun test는 테스트파일 typecheck 안 함) 판정. 실행자: 에이전트(로컬). PARTIAL 항목은 "선수리 완료 = 해당 번들 착수 조건".

| # | 번들 (seam) | 커버 기능 | 선수리 조건 | 파일 |
|---|---|---|---|---|
| 1 | subagent 실루프 | introspect · 0145-bg-subagent · role-identity · bg-tools-trio · persistence · multi-agent-bounds · 0218-mode-typed · 0393-delegate · 0487-force-bg · agent-jobs-batch · 5059-suppress | 0487 LRU 경계 케이스 포함 | 3 |
| 2 | workflow | run-workflow (scriptedAgent fake → 실 agent.run) | — | 1 |
| 3 | automation | 0279-engine-wire · 0280-tool+inbox · **215-automation-engine**(tick 드라이버 실구동) | — | 1 |
| 4 | 도구 gate→등록→dispatch→효과 | projects-kb · communicate-update · ast-grep · reflect · file-history · notebook-edit · gh-pr-resolve · lsp-call-hierarchy · commit-pr-authoring · advisor · tool-interrupt-block · worktree · shell-snapshot | — | 4 |
| 5 | 생성물 도구 / 저장 분리 | image-gen·office·pptx(생성 파일 실검증) 1파일 + artifact-store(write→register→list/get 저장 seam) 별도 1파일 | — | 2 |
| 6 | 관측·CLI 서피스 | debug-tracer · 0182 · ndjson · 0302 · 0309(+granular) · 0310-r1 · bg-turn · session-import-export · idle-monitor | ndjson HTTP 배선 · 0302 port 정리 | 4 (PTY분은 tests/e2e-pty) |
| 7 | plan-queue/steering | 0228-mutators · mid-turn-steering · sendNow (D2 산출 스코프) | **D2 결정** + sendNow 타이밍 window 수리 | 1-2 |
| 8 | 권한·안전 레일 | guardian · exfil-scouting · secret-check(0164+0412) · 0295 bash-mode · landlock(bwrap — Linux 전용 mark, macOS visible-skip) · 0209+0210 checkpoint/restore · dispatch-guard · refusal-stop-reason · 0454 command-hooks · 0162 isolated-spawn | — | 5 |
| 9 | context/memory | glob-rules+env-context · pre-compact-hitl · microcompact · delta-token · consolidator family+distill-redaction 양경로 · line-citation · phase2 promotion+auto-trigger · stage1+vendor-detector · on-session-minted · model-tag | **W1-1 랜딩 선행** · microcompact 튜닝주입 배선 · stage1 loop 소비 갭은 갭으로 명기 | 5 |
| 10 | llm/loop 단독 seam | language-detect · budget-ledger · multi-voter+branch-search-progress(동일 러너, 한 파일) · structured-output(OpenAI 실스트림) · 0094 oauth(기존 bearer/401 e2e 보강 — mint는 수동 카나리아) | response-in-progress는 loop consumer 부재 → **W5 D6** | 4 |
| 11 | web-daemon | observability-live-wire · 0440 canvas · compaction-visibility **consumer**(producer는 W5 D7) | attribution race 수리 | 2 |
| 12 | bench 행동 e2e | find-refs · patch-budget(+strict) · spec-fidelity · trajectory-record · repro-doubt · repro-vote · verify-and-select · issue-hint-EA | — | 2 |
| 13 | MEDIUM 승급 (6종만) | mcp-server(loop 경유) · byok(실 mint) · local-env(bash 적용) · central-config(trust 시나리오) · network-egress(ci-bot) · focus-chain(케이던스 실루프). **나머지 MEDIUM 24는 승급 안 함(명시)** | — | 3 |

합계: 기능 ~90 (B 85 − STUB 정산 + MEDIUM 6) / 파일 ~33-38 (상한 목표, 파일당 ≤3기능·비대화 금지).

**배선·랜딩 가드**: add-only 테스트는 병렬 OK. 단 ①`__resetRuntimeConfig`/공유 setup 만지는 번들(6·9) 상호 순차 ②src 수리 포함 번들(1·6·7·9·11)은 hot-module(surface-compose·runtime-config·agent-arg-builder) 겹침 시 순차 ③push 직전 `git fetch && rebase origin/main`, **force 계열 금지**(동시 세션·ref rewrite 금지), 충돌 시 테스트 재실행 후 push ④worktree cp-land 시 node_modules 심볼릭 먼저 rm ⑤판정은 per-file green만(full-suite 오염 오탐 금지).

**우선순위**: 번들 2·7·10 + 번들1 (WEAK 강등분 집중 — "e2e 있다"고 믿었던 거짓 안심이 최고 리스크) → 나머지 병렬.

## W4 — flip 결정·실행 (W3 뒤)

- **L1 opt-in 유지 (flip 아님)**: 도구류(browser/office/image-gen/worktree/code-mode/mcp-server/run-tests/debug-inspect/collect-evidence 등 HIGH-RISK 포함) · 보안 다중게이트(command-hooks) · bench knob 전부.
- **L2 CLI seed 추가** (cli-feature-gates.ts, **한 커밋**, describe 필드+help-render 파생+parity hellgate): ⚠️seed는 env 상속으로 **spawn된 subagent/자식 프로세스까지 전파** — 후보별 상속 영향 1줄 판정 필수(D5). 후보(관측/출력 side-effect류만): **b5-notify-presence · completion-notify · debug-tracer(TTY-only) · decision-counter**. ~~edit-repair-loop · refusal-fallback~~ → **L3로 이동** (R2 지적: 루프 제어흐름 변경 = 행동변경류). crash-resume은 checkpoint 쓰기+재개가 subagent 멱등성 깨뜨릴 수 있어 **seed 제외, opt-in 유지**.
- **L3 코드 default-ON (measure-first — 측정 스펙)**:
  - 대상: prompt-directive · delegation-suppress · closeout-critic · cap-enforcer · adaptive-thinking · **edit-repair-loop · refusal-fallback**(L2에서 이동).
  - 측정 레일: ①행동 회귀 = tests/smoke 배터리(실 loop replay+judge) 전후 비교 ②효능 = SWE picks A/B(기존 6-pick 스모크 기준선, CONCURRENCY=3·채점 SERIAL 원칙) — knob ON/OFF paired run, resolved-delta 기준. 오르지 않으면 default-OFF 유지(안 오르면 삭제 원칙).
  - bench llm-select/location-fanout preset 모순(D8): jun-30 탑재가 측정 기반이었는지 확인 → 측정 있으면 유지, 없으면 hold 복귀+선측정.

## W5 — C/D/kill 처분 (독립 트랙, W2/W1의 fallback 아님 — 신규 항목만)

- retrieval 체인(reranker·embed-cache·semantic-search·multimodal·model-tag auto-hook): **QUANTA_PIPELINE 묶음 일괄 결정 D9** (개별 판단 금지).
- 소비자-로드맵 판정 D6·D7: response-in-progress(W3-10 이관 — OpenAI Responses consumer 로드맵 있으면 유지, 없으면 kill) · approval-SM producer + compaction-visibility producer(HITL attribution 로드맵) · recovery-router(RetryingLLM 통합 ADR 여부) · prompt-suggestion · fast-apply(agent측) · 0311 CLI.
- kill 후보 명단 D10 (유저 go/no-go): lane-manager(reader 부재) · spec-to-test-gen · node-repl · conflict-parser · voice-input-stt(voice-live 통합?) · message-batches · model-preset · ratelimit-dual-window (+D3/D4 결과에 따른 tool-profile/read-outline).
- D 무접촉: mantle SDK · TLS-MITM · 0317 tauri · windows-sandbox · token-refresh.

## Decision Log (유저 결정 포인트 전수 — 이것만 답하면 나머지는 기계적)

| # | 결정 | 시점 | 기본값(무응답 시) |
|---|---|---|---|
| D1 | W0 인벤토리/fc 정정 커밋 승인 | W0 | 진행 |
| D2 | plan-queue 가족: loop 소비까지 살림(A) vs helper kill(B) | 번들7 전 | B (보수) |
| D3 | tool-profile: /profile 연결 vs kill | W2 | kill |
| D4 | read-outline: fc 정직화 vs knob kill | W0-2 | 정직화 |
| D5 | L2 seed 후보 4종 승인 (상속영향 판정문 첨부) | W4 | 미승인(opt-in 유지) |
| D6 | response-in-progress 유지/kill | W5 | kill |
| D7 | approval-SM·compaction producer 로드맵 | W5 | 유지(코드 무접촉) |
| D8 | llm-select/location-fanout preset 모순 처리 | W4-L3 | 선측정 |
| D9 | retrieval 체인 일괄 살림/kill | W5 | 보류(무접촉) |
| D10 | kill 명단 8종 go/no-go | W5 | 보류 |

## 순서

W0 → (W1 ∥ W2결정) → W3 (2·7·10·1 먼저 → 나머지 병렬, 6·9 상호순차, 9는 W1-1 후) → W4 (L2 한 커밋 → L3 측정) → W5 독립.
