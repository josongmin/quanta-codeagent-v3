# jul-12 — Seeded-chaos / property harness for our bg state machines (OmO 흡수 #02)

North-star: **agent-state observability**. 백그라운드 프로세스 상태머신이 "뭘 하고
있고 / 왜 멈췄고 / 슬롯이 새는가"를 정직하게 답하려면, happy-path 유닛이 아니라
랜덤 인터리빙에서도 불변식이 성립함을 증명해야 한다. 이 RFC는 그 증명 레일을 깐다.

Constraints (hard):
- **중복구현 금지.** 새 PRNG/clock 헬퍼를 발명하지 않는다 — 아래 §현황에서 실측한
  기존 헬퍼(xorshift32 `Rng`, `ClockPort` fake)를 재사용한다.
- **싸구려 휴리스틱 절대 금지 (이 작업의 핵심 리스크).** 매직넘버 드레인 캡
  금지. OmO 원본이 쓰는 `tasks*4+40` 드레인 상한(§증거 D)은 흡수 대상이 **아니다** —
  명시적 quiesce 조건(큐 빔 + 모든 태스크 terminal + 핸들 미증가)으로 대체한다.
  이 종류의 하네스는 "green인데 아무것도 안 재는" 공허 테스트로 쓰기가 너무 쉽다.
- **hellgate: RED→green→adversarial ≥3R.** 랜딩 전 실주입 red 증명 ≥3개 필수(§3).
- **measure-first / default 무해.** 하네스는 테스트 전용, 프로덕션 바이트 무변경.

두 개의 독립 어딧(적대 + 객관)을 이 초안에 돌려 스코프를 깎았다. 아래는 남은
genuine·non-duplicate 항목만; 죽은 항목은 §killed에 근거와 함께 기록한다.

---

## 현황 (증거기반, file:line)

### A. 우리 bg 상태머신엔 property/chaos 커버리지가 없다 — happy-path 유닛뿐

**후보1 — `src/runtime/bash-bg-registry.ts` (프라임 후보).**
concurrency-slot 상태머신 그 자체다:
- cap-and-evict LRU: `DEFAULT_MAX_BG_SHELLS=16` (`:43`), insertion-order Map을
  LRU로 써서 오버플로 시 **가장 오래된 것**을 kill+drop (`evictOldest` `:336-351`).
- terminal 상태 전이: `running`→`completed`|`killed`|`aborted`
  (`BgShellStatus` `:75`), 각 kill site가 `if (h.status === "running")` 가드
  (`kill` `:540`, `killAll` `:555`, `evictOldest` `:347`, `wireAbortSignal` `:315`).
- bounded buffer: `MAX_BG_BUFFER_BYTES=200_000` (`:64`) — OOM 방지 head+tail.
- 기존 테스트: `tests/unit/runtime/bash-bg-registry-behavior-hellgate.test.ts`,
  `...-adopt-hellgate.test.ts` — **전부 crafted happy-path 시퀀스**. register→
  await→kill을 각각 결정론 순서로 한 번씩 친다. **랜덤 인터리빙 0, cap 경계에서
  evict↔await↔kill이 섞이는 케이스 0.**

**후보2 — `src/runtime/guarded-spawn.ts` `escalatingKill` (회귀가드 앵커).**
SIGTERM→(grace)→SIGKILL 에스컬레이팅 kill. grace 타이머 arm/disarm 로직:
- `KILL_GRACE_MS=2_000` (`:55`), `kill()`가 grace 타이머를 arm (`:162-171`),
  `disarm()`가 clear (`:131-136`), `reaped` 래치가 이미 죽은 pid 재signal 차단
  (`:146-154`, `markReaped` `:147`).
- **재진입 재-arm 방지 주석이 코드에 못박혀 있다:** `:161` `if (graceTimer !==
  undefined) return` — "a re-entrant kill() must not stack timers".
- **모티베이팅 증거 (jun-28 메모리 leaked-timer 버그류):**
  `bash-bg-registry.ts:343-347` 주석이 실버그를 기록한다 —
  > "calling kill on [a completed shell] used to **re-arm a leaked SIGKILL grace
  > timer** (now also latched in `escalatingKill`, but the guard keeps this site
  > consistent + cheaper)."
  즉 disarm/재-arm이 **두 번 발화**해서 grace 타이머가 새던 버그가 실제로 있었고,
  현재는 두 곳(evictOldest의 status 가드 + escalatingKill의 `reaped` 래치)에서
  이중 방어 중이다. 이 이중 방어가 **미래 회귀에도 성립하는지 증명하는 property가
  지금 없다** — guarded-spawn.test.ts는 disarm을 결정론 1회 경로로만 친다
  (`grep`: `:5,52` normal/throw path만, 재진입·evict-after-complete 경로 없음).
  **이것이 정확히 exactly-once-disarm 불변식이 direct regression guard로 삼을
  버그 class다.**

**후보3 — `src/side-agent/process-registry.ts` (2차 확장 대상, 이번 스코프 밖).**
또 하나의 concurrency-slot 머신: `DEFAULT_MAX_CONCURRENT=2` (`:58`),
oldest-terminal prune `maxRetained=100` (`:60,148-156`), idempotent `stop()`
(`:243`). 같은 하네스 패턴이 적용되나, bash-bg가 패턴을 증명한 뒤 확장(§ro드맵).

### B. 재사용할 기존 인프라 (재발명 금지 — 실측)

- **seeded PRNG:** `tests/unit/fuzz-pure-cores-r4-hellgate.test.ts:35-60`에 이미
  xorshift32 `Rng` 클래스가 있다 (`next/int/float/bool`, zero-fixpoint 회피
  `:39`, "counterexample 재현" 규율 `:32-34`). OmO의 `RandomSource`(FNV seed +
  `deriveSeed` 서브스트림)와 동형 — **우리 `Rng`를 정본으로 승격**해 `test-support/`
  공용 모듈로 추출하고 chaos 하네스가 import한다. OmO의 prng.ts를 복붙하지 않는다.
- **injected clock:** `src/connectors/__tests__/token-refresh-scheduler-hellgate
  .test.ts:55-63`의 `clockOf(start)` → `ClockPort & { set, advance }` (`now()`
  순수 함수, `advance(d)`). grace-timer 결정론에 이 shape를 재사용.
- **real-timer positive control 선례:** `tests/unit/runtime/guarded-spawn.test
  .ts:38` "positive control: timer FIRES when no guard is applied (proves the
  timer is real)" — vacuous-guard 방어의 우리 기존 문화. chaos 하네스도 이 규율을
  상속한다(§3).

### 결론
bash-bg-registry는 **cap·terminal·disarm이 얽히는 concurrency-slot 머신인데
인터리빙 커버리지가 0**이다. jun-28 leaked-timer 버그는 정확히 이 얽힘에서 났고,
현재 이중 방어는 property로 핀되어 있지 않다. 흡수할 OmO 자산은 "4-불변식 seeded-
chaos 드라이브" 패턴이지 그 코드가 아니다(우리 헬퍼가 이미 있음).

---

## 제안 / IMPLEMENT

### C1 (KEYSTONE) — bash-bg-registry chaos 하네스
`tests/unit/runtime/bash-bg-registry-chaos.test.ts` 신설. seeded `Rng`로 ~200
iteration, 각 iteration마다 fresh `createBashBgRegistry({ port: fakePort,
maxEntries: rng.int(1,4) })` + fake `BashProcessHandlePort`(결정론 exit/chunk)
+ injected clock으로 grace-timer 구동. 각 iteration은 랜덤 이벤트 믹스를 인터리브:
`register` / `adopt` / `awaitHandle(regex|timeout)` / `kill` / `killAll` /
abort-signal fire / cap-overflow evict / notifier(drain)-throw. 그다음 **명시적
quiesce**까지 몰고(§4) 4-불변식을 검사.

**우리 4-불변식 (OmO 4개를 우리 코드에 concretely 매핑):**

1. **cap-never-exceeded** (OmO inv3 슬롯누수 ⇒ 우리 cap 불변식).
   임의 인터리빙 어느 시점에도 `registry.size() ≤ maxEntries`. 그리고 OmO의
   "fresh batch 재제출로 슬롯 해제 증명" 기법을 채택: quiesce 후 `maxEntries`개
   fresh register가 **전부 즉시 등록**되고 그 이전 것들은 전부 evict/terminal —
   즉 슬롯이 실제로 반환됐음을 재제출로 증명(단순 count 비교가 아니라).

2. **terminal-idempotence** (OmO inv2).
   `completed`/`killed`/`aborted`로 간 핸들에 늦은 이벤트(evict의 kill, 중복
   `kill(id)`, abort-after-exit)가 와도 status를 되돌리지 않는다("revive 없음").
   witness: 한 iteration의 각 핸들에 대해 terminal 도달 후 status 문자열이 두 번
   이상 바뀌지 않음(observing wrapper로 status 쓰기를 기록).

3. **exactly-once-disarm** (← **direct regression guard**, jun-28 버그 class).
   escalatingKill이 handle 하나당 grace 타이머를 **arm하면 정확히 한 번 disarm/
   clear**되고 재-arm 없음. 계측: fake clock으로 grace 타이머 arm/clear/fire를
   카운트하는 관측 seam을 escalatingKill 주입점에 심어, 어느 핸들도 `disarmCount
   > armCount`(과잉 disarm)도 `arm 후 clear 없이 dangling`(누수)도 아님을 단언.
   이게 `bash-bg-registry.ts:343-347` + `guarded-spawn.ts:161`이 지키는 성질의
   property 증명이다.

4. **no-unhandled-rejection** (OmO inv4).
   `process.on("unhandledRejection", …)`를 run 전체에 arm(OmO와 동형,
   chaos-bench.test.ts:33-40). notifier/drain throw를 주입해도 floating rejection
   0. bun 러너 자체가 hard enforcer.

**시드 재현:** `SEED=<label> bun test ...-chaos.test.ts`로 단일 시드 재생(OmO
`deriveSeed` 서브스트림 규율 = 우리 `Rng(base + iter*prime)` 재시딩, fuzz-pure-
cores와 동일 패턴). counterexample은 minimize해서 인접 crafted 회귀로 승격.

### C2 — 공용 PRNG 추출 (중복제거 선행)
`Rng`를 `test-support/seeded-rng.ts`(또는 기존 공용 위치)로 추출, fuzz-pure-cores와
chaos 하네스가 공유. 순수 추출 — fuzz 스위트 green 유지(byte-identical 동작).

---

## §3 — HARD anti-vacuous gate (랜딩 차단 조건)

이 하네스는 **green인데 아무것도 안 재기가 극히 쉽다** (fake port가 항상 즉시
complete하면 evict/disarm 경로가 안 걸리고, 불변식 검사가 공집합을 훑는다). 우리
test-quality 문화(mutation-resistant, 무조건-단언-후-내로잉, red-on-injection)를
그대로 적용한다. **≥3개 실주입 red 증명 없이는 랜딩 불가:**

- **RED-1 (cap off-by-one):** `evictOldest`의 임계를 `>= maxEntries` →
  `> maxEntries`로 변조. inv1(cap-never-exceeded)이 RED. (슬롯 하나 초과 누수.)
- **RED-2 (double-arm the timer):** `guarded-spawn.ts:161`의 재진입 가드
  (`if (graceTimer !== undefined) return`)를 제거해 kill() 재호출이 타이머를
  stack. inv3(exactly-once-disarm)이 RED. **이게 jun-28 leaked-timer 버그의 직접
  재현** — 하네스가 그 버그를 잡는다는 증거.
- **RED-3 (skip a slot release):** `evictOldest`의 `entries.delete(oldestId)`를
  스킵(또는 terminal 핸들의 status 되돌리기 주입). inv1(재제출로 증명하는 슬롯해제)
  또는 inv2(terminal-idempotence)가 RED.
- (권장 추가) **RED-4 (terminal revive):** completed 핸들의 status 가드
  (`bash-bg-registry.ts:347` `if (handle.status === "running")`)를 제거 →
  inv2 RED.

각 red는 mutation을 걸고 **하네스가 실제로 붉어지는 로그**를 RFC 이행 시 첨부.
positive-control(guarded-spawn.test.ts:38 선례)도 유지: fake clock을 안 붙이면
grace 타이머가 진짜 fire함을 별도 단언해, inv3가 "타이머가 죽어서 green"이 아님을
증명.

## §4 — `tasks*4+40` 휴리스틱 명시적 기각

OmO `chaos-drive.ts:12` `const cap = state.taskIds.length * 4 + 40`은 드레인
루프의 매직 상한이다. 이건 "충분히 크겠지" 추정치 — 우리 no-heuristics 하드룰
위반. **채택하지 않는다.** 대체:

```
// quiesce until fixpoint — NO magic iteration cap
while (true) {
  const before = registry.size()
  await flushMicrotasks(); clock.advance(KILL_GRACE_MS)  // let grace timers fire
  await flushMicrotasks()
  const settled = registry.size() === before
    && allHandlesTerminal(registry)   // no non-terminal
    && queueEmpty(registry)           // (side-agent: no pending)
  if (settled) break
  // 진행 증명: settled 아니면 handle count가 단조감소해야 함 — 아니면 즉시 fail
  // (무한루프 = 진짜 버그, 매직 cap으로 가리지 말 것)
}
```
quiesce는 **상태로 정의**하지 라운드 수로 정의하지 않는다. 만약 fixpoint에 도달
못하면 그건 감출 버그(라이브락)이지 cap을 키울 일이 아니다 — 단조감소 위반 시 즉시
fail시켜 무한루프를 RED로 노출.

---

## §killed (어딧이 죽인 항목)

- **OmO prng.ts / RandomSource 복붙 — 기각(중복).** 우리 xorshift32 `Rng`
  (fuzz-pure-cores-r4:35)가 이미 동형·검증됨. FNV seed 해싱은 우리 `Rng(base +
  iter*prime)` 재시딩으로 충분. 새 PRNG 모듈 금지.
- **`tasks*4+40` 드레인 캡 — 기각(휴리스틱).** §4 명시적 quiesce로 대체.
- **side-agent/scheduler 동시 착수 — 이번 스코프에서 defer(measure-first).**
  bash-bg가 패턴을 증명(≥3 red)하기 전엔 두 번째 머신에 복제 안 함. 확장은 §ro드맵.
- **fake-timer 라이브러리 도입 — 기각.** `ClockPort` fake(token-refresh
  scheduler:55) shape 재사용으로 충분. 새 의존성 없음.

---

## §ro드맵 — bash-bg가 패턴을 증명한 뒤

1. **side-agent/process-registry.ts** — `maxConcurrent=2`, oldest-terminal prune,
   idempotent stop. 동일 4-불변식(slot-cap / terminal-idempotence / stop-exactly-
   once / no-rejection). 하네스 골격 재사용, 이벤트 어휘만 교체(start/stop/reap/
   prune).
2. **scheduler-runtime** (`tests/unit/scheduler-runtime.test.ts` 대상 코드) —
   rrule 기반 발화의 재진입/중복발화 불변식(injected clock 필수).
3. 공용 chaos 드라이버 추출(state-machine-agnostic driver + per-machine action
   table)은 **2개 머신이 실제로 공유 형태를 보인 뒤** 결정 — 조기 추상화 금지.

---

## Effort / Risk

- **Effort:** C2 PRNG 추출 ~0.5d(순수 이동+fuzz green 확인). C1 하네스 ~1.5–2d
  (fake port + observing status wrapper + disarm 계측 seam + quiesce + ≥3 red
  주입/로그). red 증명이 대부분의 시간 — 하지만 이게 landing gate라 협상 불가.
- **Risk-1 (vacuous green):** 최상위 리스크. §3 red-on-injection ≥3로 강제 방어.
- **Risk-2 (disarm 계측 seam이 프로덕션 침습):** escalatingKill에 카운터 hook을
  넣을 때 프로덕션 경로 바이트 무변경이어야 함 — 관측은 테스트가 주입하는 killer/
  clock DI 경계에서만(이미 `escalatingKill(proc, killer?)` seam 존재,
  guarded-spawn.ts:112). 프로덕션 default 무변경 paired-control로 핀.
- **Risk-3 (flaky microtask 타이밍):** OmO가 `flushMicrotasks()` 2회
  (chaos-bench.test.ts:54-55)로 안정화. 우리는 그 위에 injected-clock advance로
  grace 타이머를 결정론화 — wall-clock `setTimeout` 실대기 금지(테스트 느려지고
  flaky). `.unref()` 타이머(guarded-spawn.ts:171)라 결정론 advance가 필수.
- **Risk-4 (worktree 오염):** `.claude/worktrees/*`에 stale bash-bg-registry
  사본 다수(§현황 grep). 신규 테스트는 **메인 `tests/unit/runtime/`에만** 추가,
  worktree 사본 무시.

## 실행 순서 (hellgate, main-inline)
C2(PRNG 추출, fuzz green 유지) → C1 RED(하네스 골격 + ≥3 실주입 red 로그 첨부) →
green(불변식 통과) → adversarial self-audit ≥3R → 시드 재현/minimize 회귀 승격.
side-agent/scheduler 확장은 C1이 green+red-proven 된 뒤 별 RFC 항목으로.
