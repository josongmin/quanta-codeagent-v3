# 04 — 자가 어딧 + 경쟁 비교 (opencode / OmO)

2026-07-12. `00-final-rfc.md`(3 primitive)와 **상보적** 문서다. 00~03은 흡수할 3후보의 미래 설계고,
이 문서는 (a) 경쟁 하네스 대비 우리 위치, (b) 우리 코드의 "정교한데 inert" 병리 스윕, (c) 자기채점 교정을 기록한다.
00과 점수/순서가 충돌하면 흡수-primitive 범위에선 00이 우선. 그 밖 영역은 이 문서가 근거.

> 방법: 모든 점수는 **홈보너스 0**(경쟁사에 쓴 잣대를 우리에게 대칭 적용). 공정성 감사가 편향 교정.

## 1. OmO는 자기 에이전트 루프가 없다

레포 전체 LLM 추론 호출(streamText/generateText/messages.create) **0건**. OmO = opencode(메인) + senpi(서브에이전트) + Codex(대체) 3개 하네스를 오케스트레이션하는 플러그인.

| 루프 | 소유자 | OmO가 하는 일 |
|---|---|---|
| 메인 코딩 | opencode | plugin 훅만 (chat.params/message transform, tool.execute.before/after) |
| 백그라운드/서브에이전트 | senpi (외부 dep) | 세션 spawn + prompt/steer/followUp |
| Codex 하네스 | Codex CLI | TOML 설정/설치 배선 |
| **자체 루프** | **없음** | — |

→ 흡수 후보가 전부 루프 바깥(destruction-port, chaos-bench)에서 나온 이유. 루프에서 배울 게 없는 게 아니라 OmO에 루프가 없다.

## 2. opencode 코어 루프 — 명성 걷으면 48/100

`sst/opencode` `packages/opencode/src/session/` 직접 리뷰. 손수 짠 `while(true)`(prompt.ts:1088 runLoop) — ai-sdk auto-loop 아님. 성숙하지만 명성 보정 걷으면:

| 계층 | 명성보정 | 메리트만 | 최악 결함 (file:line) |
|---|---|---|---|
| 턴 루프 | 82 | **48** | doom-guard가 `parts.slice(-3)`에 reasoning 섞이면 조용히 무력화(processor.ts:356); 재시도 무한 cap 없음+`RETRY_MAX_DELAY=2_147_483_647`≈24.8일(retry.ts:29); max-step 프롬프트-only+default Infinity(prompt.ts:1178) |
| tool dispatch | — | 67 | `ctx.ask` `orDie`가 deny를 FiberFailure로 감싸 → `instanceof RejectedError` 항상 false → deny fail-open(tools.ts:89→processor.ts:200); dispatch를 ai-sdk에 통째 위임; processor-level truncation 없음 |
| compaction | 82 | 70 | `limit.input` 헤드룸 버그 known-yet-unfixed shipped(자기 테스트가 "BUG:" 인정); summary 실패 fallback 전무 → garbage 커밋 영구손실; overflow-replay 멱등성 없음 |
| provider/streaming | 82 | 74 | `pause_turn`→`stop` 오매핑(anthropic-messages.ts:559); 미조율 2-tier retry + 504 blanket retry; abort half-write 창 |

공정성 노트(적대 전제가 틀렸던 것): compaction 트리거는 authoritative(추정 아님), native LLM 스택은 rot 아니라 실코드+테스트(단 default가 ai-sdk).

## 3. 우리 repo 대칭 어딧 — 최종 교정 점수

opencode에 쓴 4-축 잣대(무한재시도 cap/max-turn 하드스톱/반복가드/deny 시맨틱/compaction fallback/abort half-write)를 우리에게 대칭 적용.

| 축 | 우리(교정) | opencode | 판정 |
|---|---|---|---|
| 턴 루프 | **76** | 48 | 우리 우위 (god-fn 분해·retry 하드캡 4회/15s/60s·max-turn 코드 하드스톱 default 30) |
| tool dispatch | **72** | 67 | 우리 소폭 (deny fail-closed 일관·universal output cap·orphan coherent) |
| compaction | **82** | 70 | 우리 우위 (summary 검증-후-폐기·abort half-write 봉쇄·idempotent soft-prune) |
| provider/streaming | **84** | 74 | 우리 우위 (yielded-gate idempotency·exhaustiveness pin·empty-stream 방어) |
| 승인 커널 | **78** | fail-open 결함 | 우리 우위 (예외 전부 deny 수렴, orDie 없음) |

### 우리도 있는 동류 결함 (opencode 깐 그 잣대)
- **턴 루프 WORSE 지점**: 의미론적 doom-loop 가드 **아예 없음**. `maxConsecutiveFailures` dial+카운터+체크 arm이 있는데 loop에서 feed 0 = **inert dead-gate**. 유일 backstop이 maxTurns(30).
- **dispatch 실버그**: read-only 툴이 concurrency-safe로 동시 early-dispatch되며 공유 `readFileState` Map을 완료순서로 mutate → "read-only=abort시 무손실" 불변식 위반. dispatch를 소유했기에 opencode가 구조적으로 못 만드는 side-channel race를 직접 만듦.
- **bash default trust-and-run**: OS sandbox 코드는 있으나 bash 기본 `mode=write`에서 미적용. opencode와 동급으로 뚫림.
- **미조율 2-tier retry**: SDK maxRetries:2 × 우리 4 = pre-stream 최대 8회 곱셈, 조율 주석 없음.

### 자기채점 인플레 (공정성 감사가 잡음)
- **SE 지표 96 → 84~88**: god-code 라쳇 만점 크레딧인데 라쳇 **현재 RED**(fresh 위반) + slice-boundary 4 RED. "설계상 GREEN·실무상 RED"에 만점은 부정직.
- **견고성 80 → 72~75**: side-agent LIVE 프로세스 leak. opencode fail-open을 최독성 감점했으면 우리 LIVE leak도 동급.
- **"우리 LLM 스택 소유(default)"**: 사실은 HONEST(플래그 뒤 아님). 단 "opencode native는 experimental" 스핀은 과장(걔들 default는 성숙한 ai-sdk).

## 4. 핵심 병리 — "정교한 기계 + green 테스트 + live 미연결" (미커버 6영역 스윕)

`maxConsecutiveFailures` inert가 예외가 아니라 **구조**였다. 홈보너스 0으로 6영역 판 결과:

| 영역 | 점수 | 상태 |
|---|---|---|
| 승인 커널 | 78 | fail-closed 성립(조건부: bypass+no-sandbox면 HARD_DENY 정규식이 유일 egress 게이트). 도구 매니페스트 양방향 드리프트 가드=이 세션 최고 |
| 프롬프트/도구서피스 | 74 | 매니페스트 최고. **repo-rules(AGENTS.md/CLAUDE.md)가 프로덕션 프롬프트에 절대 안 감**. mode축 inert forward-seam. verifyStrategy 벤치전용 |
| 서브에이전트/팀 | 68 | DAG/mailbox/park-gate 견고. **exec_command tree-kill 없음(라이브 BASE)**, registry per-pass timeout 없음, 트리 토큰 예산 무한 |
| 벤치 하네스 | 65 | grading rail 신뢰가능(측정구멍 전부 가드). knob 111개 중 **효능 실측 2개(~2%)**. SUBMIT_REVIEW/REPRO_VIABILITY는 lever인 척 observe-only |
| 영속/트레이싱 | 59 | 세션스토어 atomic. 리코더 **fsync 없음**("on disk" 오버클레임). **LLM 카세트 미삭제**(events). verdict/editTrace enricher 미배선 |
| 관측커널 / evidence-ledger | 58 / **35** | 관측커널=**벤치 전용**(CLI/터미널 미도달). evidence-ledger=**0-import dead code** |

### VERDICT: LOAD-BEARING / OBSERVE-ONLY / INERT
- **evidence-ledger → INERT.** producer 0, consumer 0, 디렉토리 밖 import 0. barrel이 "no consumer" 자백. (단 jul-5 P1 문서화 자산이라 삭제는 net-negative — 05 참조)
- **observation kernel → LOAD-BEARING(bench-only).** `<quanta_observations>`가 실제 프롬프트 바꾸나 `runner/batch/eval`에만. 인터랙티브 surface 미도달. static-owner provider="main wires later" 미배선 → 3-tier authority top-tier가 라이브 dead branch. 효능 계측(`onObservationBundle`) supplier 0 = default-ON인데 측정 불가.
- **owner critic S1 → OBSERVE-ONLY.** veto/gate 0.

## 5. 새로 발견한 leak/hole (00-RFC R1 레인에 얹을 것)

00-RFC의 R1(ResourceScope)이 side-agent-fork-port.ts:78 leak을 다루지만, 이번 어딧이 **같은 클래스의 추가 사이트**를 찾았다:

- 🔴 **`subagent/handlers-6.ts:377,386` exec_command** — 단일-PID `proc.kill()` on `bash -lc` 프로세스 트리. **라이브 6-tool BASE 도구**라 side-agent(default-OFF)보다 임팩트 큼. R1 레인이 side-agent만 다루면 이건 누락됨 → R1 스코프에 추가 권장.
- 🔴 side-agent `registry.ts:195` per-pass timeout 부재 → runner hang 시 슬롯 영구 점유.
- 🔴 subagent 트리 토큰/turn 예산 무한(누적/전파 0, depth cap만).

정본 파괴포트는 `escalatingKill`(guarded-spawn.ts:112, SIGTERM→2s→SIGKILL+tree+pid>0 자살가드+reaped 래치). exec.ts:50은 그 이전 세대 반쪽 중복. → **signalTree sprinkle 금지, escalatingKill로 수렴**. 05 참조.

## 6. 흡수 후보 최종 스코어 (참고, 00이 primitive 설계 SSOT)

| 후보 | 총점 | 판정 |
|---|---|---|
| single-writer 파괴포트+정적감사 | 82 | → 00-RFC Primitive A(ResourceScope) |
| chaos-bench property 테스트 | 82 | → 00-RFC Primitive B(SimulationKernel) |
| hashline remap 아이디어만 | 63 | → 00-RFC Primitive C(VersionedWorkspace, 다운스코프) |
| DAG 경계강제 | 33 | 비채택 — 우리 AST스캐너+cycle hellgate+라쳇이 상위호환 |
