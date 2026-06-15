---
instance_id: django__django-13346
repo: django/django
base_commit: 9c92924cd5d164701e2514e1c2d6574126bd7cc2
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-08-25T06:25:31Z
fail_to_pass: 2
pass_to_pass: 65
gold_files: [django/db/models/fields/json.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-13346

## 문제 요약
MySQL, Oracle, SQLite에서 `JSONField`의 key transform에 `__in` 룩업이 제대로 동작하지 않는다. 사용자는 `our_field__key__in=[0]`이 `our_field__key=0`과 같은 queryset을 줄 것으로 기대했지만, `__in`은 0건을 반환했다(`=`는 312건). 힌트로 좁혀진 핵심 사실: 리스트 원소가 **1개일 때만** 깨지고(복수 원소는 정상), PostgreSQL은 정상, Oracle은 문자열 값일 때도 깨진다. 즉 native JSON field가 없는 백엔드에서 `IN`의 RHS 값이 LHS의 JSON 추출 형태와 인용/타입이 맞지 않아 비교가 실패한다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈 본문이 "JSONField", "key transform", "`__in`"을 직접 지목하고, native JSON 백엔드만 정상이라는 단서가 `django/db/models/fields/json.py`의 `KeyTransform*` 룩업 등록부로 좁게 수렴시킨다. 다만 "어느 클래스가 빠졌는가"(=`In` 룩업 미등록)는 grep 한 방이 아니라 인접 `KeyTransformExact`/`KeyTransformIExact` 패밀리를 읽고 패턴에서 `In`의 부재를 인지하는 약한 탐색이 필요 → L0가 아니라 L1.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor)**: 고칠 지점은 명확하지만 픽스는 기계적 가드/상수가 아니다. 각 백엔드(`oracle`/`mariadb`/`mysql`/`sqlite`)별로 RHS를 어떤 JSON 함수(`JSON_VALUE`/`JSON_QUERY`/`JSON_UNQUOTE(JSON_EXTRACT)`/`JSON_EXTRACT`)로 감싸 LHS 추출형태와 **불변식(타입·인용 일치)** 을 맞출지 추론으로 합성해야 한다(S2). 그 합성의 그릇으로 `lookups.In`을 상속한 **신규 클래스 `KeyTransformIn`** 을 도입하고 `register_lookup`으로 패밀리에 끼워넣는 작은 구조 변경이 동반된다(S6 보조).
- **K (Knowledge) = K-Domain**: 일반 파이썬 추론으로는 풀 수 없다. django ORM의 lookup 등록/`process_rhs`/`process_lhs` 메커니즘, `connection.features.has_native_json_field`, `connection.vendor`, `mysql_is_mariadb` 같은 백엔드 feature 플래그, 그리고 각 RDBMS의 JSON 함수 방언을 알아야 한다. 이슈는 증상만 줄 뿐 SQL 레벨 해법은 전적으로 프레임워크 내부지식에서 온다.
- **Primary = T-DomainBound**: 위치는 비교적 명확(L1)하고 strategy도 S2지만, 진짜 병목은 "올바른 식의 추론"보다 **백엔드별 JSON 함수 매트릭스라는 도메인 지식**이다. 한 백엔드만 보고 일반화하면 다른 백엔드를 깨므로 K-Domain이 dominant → T-DomainBound. (T-ConstraintReason 후보였으나, 어려움의 출처가 식 합성 자체가 아니라 4-vendor 도메인 매트릭스라 T-DomainBound가 더 정확.)

## 난이도 티어
**Tier = T4 (약간 어려움)**. 구조적 피처:
- **파일/줄수**: 단일 파일(`json.py`), +25줄 1헌크. scope만 보면 작다 → T2~T3로 끌림.
- **K-Domain 매트릭스**: `oracle`/`mariadb`/`mysql`/`sqlite` 4분기 + native 백엔드 보존 분기. 정확히 이 "constraint추론·소규모 refactor·도메인지식 중 하나, 또는 넓은 P2P trap" 프로파일이 T4의 정의다.
- **regression-trap (P2P=65)**: `TestQuerying` 한 클래스에만 60+ 인접 룩업 테스트가 있다. `process_rhs`를 잘못 손대면 `test_exact`, `test_key_iexact`, `test_deep_lookup_*` 등이 줄줄이 깨질 수 있고, 무엇보다 `has_native_json_field` 분기를 빼면 정상이던 **PostgreSQL native 경로**를 회귀시킨다(native=`has_native_json_field=True`는 PostgreSQL 단독; Oracle/MySQL/MariaDB/SQLite는 base에서 `False`를 상속하므로 native가 아니라 오히려 패치가 가장 복잡하게 재작성하는 분기다).
- **underspecified → has-repro로 일부 상쇄**: 최초 이슈는 모호("작동 안 함")했고 메인테이너도 재현 실패했다. 그러나 후속 힌트가 "1개 원소일 때만", "SQLite/MySQL에서, Oracle은 문자열에서"라는 강한 재현 조건을 제공해 localize를 크게 도왔다. 그래도 SQL 레벨 근본원인 추론은 남는다.

공식 라벨 `15 min - 1 hour`(T3 prior에 해당)와 **T4로 한 단계 상향**한 이유: 공식 라벨은 "정답을 아는 개발자의 구현시간"이다. 오라클 없는 에이전트에게는 (a) 4-vendor JSON 함수 방언이라는 지식 병목과 (b) native-백엔드 보존을 빼먹는 회귀 함정이 시간라벨에 안 잡힌다. 도메인 지식 + P2P trap 두 축이 T4로 민다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/json.py`
  - 신규 클래스 `KeyTransformIn(lookups.In)` + `process_rhs(self, compiler, connection)` 오버라이드
  - 등록 라인 추가: `KeyTransform.register_lookup(KeyTransformIn)` (기존 `KeyTransformExact`/`KeyTransformIExact`/`KeyTransformIsNull` 등록 블록 상단)
- **근본 원인**: `KeyTransform`에 전용 `In` 룩업이 없어 django 기본 `lookups.In`이 그대로 적용됐다. native JSON이 없는 백엔드에서 LHS(key transform)는 `JSON_EXTRACT`/`JSON_VALUE` 등으로 추출·역인용된 스칼라인데, 기본 `In`의 RHS 파라미터는 JSON 인코딩된 원시 문자열(따옴표 포함 등)이라 양쪽 타입/인용이 어긋나 매칭 0건. (이 타입/인용 불일치가 진짜 근본 원인이다.) 단, "원소 1개일 때만 표면화"는 `In`이 단일원소를 서브쿼리/직접비교 등 다른 경로로 처리해서가 **아니다**: `In.process_rhs`는 직접값에 대해 원소 수와 무관하게 `OrderedSet` 생성 → `None` 제거 → `batch_process_rhs`를 균일하게 호출한다(1개든 N개든 동일). 원소 수 기반 분기는 `max_in_list_size`(대용량 리스트)에 걸리는 `split_parameter_list_as_sql`뿐이며 단일 원소와는 무관하다. 따라서 단일/복수 경로 차이라는 메커니즘은 코드 근거가 없다(왜 하필 1개에서만 사용자에게 드러났는지는 별개 관측 사실로, 위 타입/인용 불일치의 표면화 조건일 뿐 별도 코드 경로 때문이 아니다).
- **수정 요지**: `process_rhs`가 `super().process_rhs()`로 baseline rhs/params를 얻은 뒤, `not has_native_json_field`일 때 각 RHS 항목을 백엔드별 JSON 함수로 감싸 LHS와 형태를 맞춘다.
  - **oracle**: 각 값을 `json.loads`로 파싱해 list/dict면 `JSON_QUERY`, 스칼라면 `JSON_VALUE`로 `'$.value'` 경로 추출하고 값을 SQL에 **인라인**(`json.dumps({'value': value})`), `rhs_params=()`로 비움 — 플레이스홀더 비대칭 처리.
  - **mariadb**: `("JSON_UNQUOTE(JSON_EXTRACT(%s, '$'))",) * len(rhs_params)`
  - **sqlite/mysql**: `("JSON_EXTRACT(%s, '$')",) * len(rhs_params)`
  - 최종 `rhs = rhs % func`로 `IN (...)` 플레이스홀더 자리를 각 함수 표현으로 치환. native 백엔드(PostgreSQL — `has_native_json_field=True`는 PG 단독)만 `if not ...` 가드에 안 걸려 baseline 그대로 → 무회귀. Oracle은 native가 아니라 `if not has_native_json_field` 블록의 첫 분기(`vendor == 'oracle'`)에 걸려 적극적으로 재작성된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_key_in`, `test_key_iregex` (`model_fields.test_jsonfield.TestQuerying`).
- **동작**: `test_key_in`은 9개 케이스를 `subTest`로 돌린다 — `value__c__in=[14]`(**단일 원소**), `[14,15]`(복수), `value__0__in=[1]`(배열 인덱스 키), 문자열 RHS `value__foo__in=['bar']`, 리스트 값 `value__bar__in=[['foo','bar']]`, 딕셔너리 값 `value__bax__in=[{'foo':'bar'},...]` 등을 각각 기대 객체(`self.objs[...]`)와 `assertSequenceEqual`로 일치 확인.
- **픽스 증명**: 단일 원소 케이스(`[14]`, `[1]`, `['bar']`)가 힌트의 "1개 원소일 때만 깨짐" 회귀를 직접 봉인한다. 리스트/딕셔너리 값 케이스는 Oracle의 `JSON_QUERY` vs `JSON_VALUE` 분기를 커버하고, 문자열 케이스는 "Oracle은 문자열에서 깨짐" 단서를 커버한다. 골드 픽스가 없으면 native 아닌 백엔드에서 이들이 빈 결과를 내 실패.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇아 보이나 `test_key_in` 내부가 9-케이스 매트릭스(스칼라/배열인덱스/문자열/리스트/딕셔너리 × 단일/복수)라 special-case 통과가 어렵다 → overfit 위험은 실질적으로 낮다(그래서 `overfit-risk` 플래그 미부여). 즉 이 인스턴스의 실질 검증은 사실상 `test_key_in` 단독이다. `test_key_iregex`도 FAIL_TO_PASS에 들어있지만 이는 픽스의 행위적 결과가 **아니다**: 골드 패치는 regex/iregex 경로를 단 한 줄도 건드리지 않고(`KeyTransformIn` 추가 + `register_lookup`만), test_patch도 `test_key_in`만 추가한다. `test_key_iregex`는 base 시점에 이미 존재하며(test_jsonfield.py:653) test_patch가 추가·수정하지 않는다. 거의 동일한 `test_key_regex`(line 650)는 PASS_TO_PASS에 있는데 `test_key_iregex`만 FAIL_TO_PASS인 것은 SQLite 백엔드에서의 수집/격리/환경 기인 SWE-bench 아티팩트일 뿐, 픽스가 검증하는 인접 텍스트 룩업 회귀 감시가 아니다.
- **regression 관점**: P2P 65개 중 대부분이 같은 `TestQuerying` 클래스의 인접 룩업이라 `process_rhs` 오작성 시 광범위 회귀 가능. native 백엔드 보존(`has_native_json_field` 가드)이 무회귀의 핵심.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "JSONField + key transform + `__in`" + "native 백엔드(PG)는 정상, MySQL/Oracle/SQLite만 깨짐" 신호 → `django/db/models/fields/json.py`의 `KeyTransform*` 룩업 패밀리로 직행. 하단 `register_lookup` 블록을 보면 `Exact`/`IExact`/`IsNull`/`Numeric*`은 있는데 `In`이 없음 → "전용 `In` 룩업 미구현"이 근본원인임을 패턴 부재로 확정.
2. **픽스**: `lookups.In`을 상속한 `KeyTransformIn`을 만들고 `process_rhs`만 오버라이드해 `not has_native_json_field`일 때 RHS를 LHS의 JSON 추출형태와 동일한 함수로 감싼다. 이게 overfit이 아니라 올바른 일반화인 이유: 버그의 근본은 "LHS는 추출/역인용된 스칼라, RHS는 raw JSON" 형태 불일치이고, 픽스는 그 불일치를 **모든 non-native 백엔드에서 대칭적으로** 해소한다(단일 케이스가 아니라 vendor 매트릭스 전체). 인접 `KeyTransformExact.process_lhs`/`process_rhs`가 이미 같은 백엔드 분기 패턴을 쓰고 있어, 그 검증된 베이스라인을 흡수해 채우는 것이 정답.
3. **regression 안전**: `has_native_json_field`(또는 `connection.vendor` 화이트리스트) 가드를 반드시 둬서 PostgreSQL-native 경로(`has_native_json_field=True`는 PG 단독)를 baseline 그대로 통과시킨다 — P2P의 `test_exact`, `test_deep_lookup_*`, `test_key_iexact` 등이 깨지지 않게. (Oracle은 native가 아니라 `if not ...` 블록에서 재작성되는 쪽임에 주의.) `super().process_rhs()`를 먼저 호출해 표준 파라미터화를 보존하고 그 위에 함수 래핑만 얹는다.
4. **함정 회피**: (a) 한 백엔드(예: SQLite)만 보고 `JSON_EXTRACT`로 일반화하면 MariaDB(`JSON_UNQUOTE` 필요)와 Oracle(`JSON_VALUE`/`JSON_QUERY` + 인라인 파라미터)을 깬다 — vendor 매트릭스를 전부 채워야 함. (b) Oracle은 값을 플레이스홀더가 아니라 SQL에 인라인하고 `rhs_params=()`로 비우는 **비대칭** 처리가 필수(이걸 모르면 파라미터 카운트 불일치로 깨짐). (c) Oracle에서 list/dict 값은 `JSON_QUERY`, 스칼라는 `JSON_VALUE`로 갈라야 함(`json.loads` 후 타입검사). (d) native 분기 가드를 빼면 정상이던 PG를 회귀시키는 silent regression — 오라클 없는 에이전트가 가장 빠지기 쉬운 함정.
