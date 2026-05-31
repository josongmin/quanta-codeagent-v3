# L2 — Subagent·위임 감사

src/subagent + src/agent/{subagent-*, delegation-runner, fork-session*, identity*, lane-manager, thread-tools, tier1, mention-*, sticky-model, auto-background, session-resource-registry, dispatch-guard} (~19k LOC, 137 .ts)

주 렌즈: 라이프사이클 · leak · 격리(isolation) · 취소(cancellation) · durability

## 방법론 노트 (중요)

- 7 클러스터 병렬, 각 클러스터 객관 1패스 + 적대 1패스 → raw 71건.
- **1라운드 skeptic verify 단계가 rate-limit으로 통째 실패**(86 agent / 2.5M tok 소진) → HIGH 11건 전부 `verifier error`로 미검증 상태였음.
- HIGH 11건을 **독립 재검증 워크플로우**(12 agent, Explore type, 소스 직접 재독)로 다시 돌림 → 환각률 ~45% 적발.
- **확정 LOW 12건은 1라운드 verifier가 정상 처리**한 것(신뢰 가능). **MEDIUM 21건(M-series)은 verify 단계 장애로 미검증** — 같은 환각률 가정하에 신뢰도 낮음으로 분류.

## 카운트

| 분류 | 건수 |
|------|------|
| High 확정 (라이브) | 2 (H6, H7 — 동일 원인) |
| High 확정 (dead-wired 잠재) | 1 (H9) |
| Medium 확정 | 1 (H3) |
| Medium 부분확정 | 1 (H5) |
| Low 확정 | 13 (thread-tools dead + L1~L12) |
| Medium 미검증 (verify 장애) | 21 (M1~M21) |
| 오탐/강등 (HIGH 환각) | 5 (H1·H2·H4·H8·H11) |

## Top 수정 우선순위

1. **[H6+H7] disk-store `lastTouched` 미갱신 → 활성 세션 silent data loss** — `append()`/`getOrBuild()`에서 `lastTouched` 갱신 + `writeMeta` 동기화. **유일한 라이브 데이터-손실 버그.** (`01-critical-high.md`)
2. **[H9] lane-manager abort 시 waiter Promise 영구 deadlock** — abort에서 waiters drain(reject). 현재 dead-wired지만 배선 직전 봉합 필수.
3. **[H3] `continue_from` owner_token gate 부재 → cross-agent 정보유출** — `task_stop`의 S17 token 패턴 차용.

## 교차 패턴 (재검증 후 유효)

- **(A) advisory isolation** — owned/forbidden surface가 seed-prompt 텍스트일 뿐 기계적 강제 없음(H5). 단 이는 설계 의도(H2도 동일) — "버그"가 아니라 "강제 레이어 부재"로 인식할 것.
- **(B) dead-code 은닉처** — lane-manager(H9), thread-tools(H10), identity-pool, fork-session 오케스트레이터, subagent-resume 등 importer 0. 배선 순간 잠재버그가 라이브화. **배선 전 봉합 or 삭제 결정 필요.**
- **(D) "삭제 먼저, 작업 나중" 순서결함** — 미검증 MEDIUM 군집(M4/M5/L12/L2). 재검증 대상.

## 파일

- `01-critical-high.md` — H6, H7, H9 (확정, 근거 코드 포함)
- `02-medium-low.md` — H3·H5 확정 + 확정 LOW 13건 + 미검증 MEDIUM 21건(별도 섹션)
- `03-false-positives.md` — H1·H2·H4·H8·H11 환각 + H10 부분강등 (왜 기각됐는지)
