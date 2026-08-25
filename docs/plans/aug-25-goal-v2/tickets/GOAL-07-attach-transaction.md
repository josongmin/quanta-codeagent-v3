# GOAL-07 — attach transaction: CLI/web thread attach 시 objective 교체, generation fence

**Priority:** P1 · **Depends on:** GOAL-06 · **크기:** ~30 tool-use, main-direct

## 목적
다른 thread를 attach/hydrate할 때 이전 objective가 live로 남거나(no-clobber), 이전 thread의 queued continuation이 실행되는 것을 막는다.
최초 hydrate(no-clobber 정당)와 명시적 attach(교체)를 다른 함수로 분리한다.

## 작업명세
### 파일
- `src/objective/authority.ts` — 신규 `replaceDomainForAttach({ liveThreadId, persistedDomain: ObjectiveDomainSnapshot | null }): { ok: true; revision } | { ok: false; reason }`
  - 입력 domain 0개 또는 1개만; `decodeObjectiveSnapshot` 결과가 2개 이상이거나 threadId 중복이면 fail-closed(아무 상태도 안 바꿈).
  - live objective 제거(progress 포함) → snapshot 있으면 liveThreadId로 re-key, objectiveId 유지 → 새 `attachGeneration` 부여, revision은 이전 live revision보다 크게(queued attempt stale화).
- `src/host/runtime/objective-store-wire.ts` — `restoreObjectiveSnapshotInto`는 **최초 hydrate 전용**으로 이름 유지, 주석에 명시. attach는 새 함수 사용.
- web: `src/apps/web-daemon/server.ts:328-345` `hydrateThreadIntoLiveSession` — `restoreObjective`를 `replaceDomainForAttach`로 교체. 트랜잭션의 `wake cancel`/`re-arm` 단계는 콜백 슬롯으로 두고 **이 티켓에서는 no-op**(웹 wake controller는 GOAL-08이 조립·주입). CLI는 기존 controller를 즉시 연결. 순서 고정:
  `goal wake cancel → attach 가능 검사(mid-turn이면 거절, 상태 불변) → transcript replace → persistence target → objective replace → commit → 새 revision으로 wake re-arm`.
- CLI: fork/attach 경로 정독(이 티켓 첫 단계 — `src/apps/cli/repl/**`에서 `setActiveThreadId`/`hydrate` 검색) 후 동일 트랜잭션 적용. `beginObjectiveProgress(objectiveStore, setup.sessionId, …)`(interactive-loop.ts:154)처럼 boot-time id 캡처 지점을 live identity getter로 교체.
- fork: 기본 **paused clone**(objectiveId 새로 발급, progress 미복제, explicit paused). 명시 결정으로 기록.
- registry(GOAL-06) entry는 attach 시 삭제.

## RED
`tests/unit/apps/web-daemon/thread-hydrate-hellgate.test.ts`, `web-daemon-objective-reopen-restore-hellgate.test.ts`, 신규 `tests/unit/objective/attach-replace.test.ts`, `tests/unit/apps/cli/attach-objective.test.ts`
1. live A(goal A) → attach B(goal B) → `readDomain(live).objectiveId === B`, A의 progress 0, wake는 B revision으로 1회.
2. A(goal A) → attach B(no goal) → live state null, wake 0.
3. attach 중 transcript replace throw → objective A 그대로, revision 불변.
4. attach 전 queued continuation(A revision) → dequeue 시 `revision-changed` skip, agent body 0회.
5. snapshot에 domain 2개 → fail-closed, 아무것도 변경 안 됨.
6. mid-turn attach 거절 → transcript/objective/persistence 모두 불변(3 spy 모두 0 호출).
7. 최초 hydrate(no-clobber)는 기존 동작 byte-identical(paired control: 기존 테스트 그대로 GREEN).
8. fork → 새 objectiveId, paused, progress 0.
9. red-on-injection: 순서에서 "wake cancel"을 뒤로 옮긴 mutant에서 4 RED.

## E2E
- web daemon `tests/integration/*-daemon-e2e.test.ts` 패턴으로 신규 `goal-attach-daemon-e2e.test.ts`: 세션 A goal 설정 → thread B hydrate → `/goal` 조회가 B → 재기동 후 B 유지.
- PTY: `/resume <threadB>`(또는 해당 CLI attach 명령) 후 `/goal`이 B, 이전 A continuation 출력 0.

## Proof rails
GOAL-06 rail + `bun test tests/unit/apps/web-daemon tests/integration/goal-attach-daemon-e2e.test.ts`.

## 함정
- `web-daemon-objective-session-stability-hellgate.test.ts`는 "per-boot session id가 바뀌어도 objective 유지"를 고정 — re-key 로직은 유지, 교체 로직만 추가.
