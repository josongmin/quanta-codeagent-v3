---
instance_id: django__django-14007
repo: django/django
base_commit: 619f26d2895d121854b1bed1b535d42b722e2eba
version: "4.0"
difficulty: 1-4 hours
created_at: 2021-02-13T09:00:02Z
fail_to_pass: 1
pass_to_pass: 12
gold_files: [django/db/models/sql/compiler.py]
---

# django__django-14007

## 문제 요약
`BigAutoField`를 서브클래싱하고 `from_db_value` 컨버터를 정의해도, INSERT 시 DB가 반환한 PK 값에는 그 컨버터가 적용되지 않는다. 일반 쿼리(`first()` 등)로 가져온 인스턴스의 `id`는 래퍼 클래스(`MyIntWrapper`)인데, `objects.create()`나 `bulk_create()`로 생성한 직후의 `id`는 컨버터를 거치지 않은 raw 정수다. 사용자는 INSERT 반환값도 다른 쿼리 경로와 동일하게 `from_db_value`를 통과하길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (INSERT 반환 경로에서 converter 적용 단계가 빠짐)
- 서브시스템: django ORM / SQL compiler (insert returning fields)
- 증상 타입: silent-wrong (예외 없이 잘못된 타입의 값이 attribute에 세팅됨)
- 로컬라이제이션 신호: "on insert the returned integer is not passed through database converters", "returning_fields", `from_db_value` 키워드 → INSERT의 returning 값을 처리하는 `SQLInsertCompiler.execute_sql`로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py` : `SQLInsertCompiler.execute_sql`
- 근본 원인: `execute_sql`은 `fetch_returned_insert_rows` / `fetch_returned_insert_columns` / `last_insert_id` 각 분기에서 곧바로 `return` 해버렸다. SELECT 경로는 `get_converters` / `apply_converters`를 거치지만, INSERT returning 경로에는 그 단계 자체가 없어 raw DB 값이 그대로 모델 attribute에 들어갔다.
- 수정 요지:
  - 각 백엔드 분기에서 즉시 `return` 하던 것을 `rows`라는 로컬 변수에 모으는 `if/elif/else` 구조로 변경.
  - `cursor` 컨텍스트를 빠져나온 뒤, `self.returning_fields`로부터 `field.get_col(opts.db_table)`로 컬럼 표현식 `cols`를 만들고 `self.get_converters(cols)`를 호출.
  - converter가 있으면 `self.apply_converters(rows, converters)`로 변환한 뒤 반환.
  - `opts = self.query.get_meta()`를 상단에서 한 번만 캐싱(중복 `get_meta()` 호출 정리).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_auto_field_subclass_create` — `CustomAutoFieldModel.objects.create()`로 만든 객체의 `id`가 `MyWrapper` 인스턴스인지 검증.
- 테스트 셋업: `tests/custom_pk/fields.py`에 `MyAutoField(models.BigAutoField)`를 새로 추가(`from_db_value`가 값을 `MyWrapper`로 감쌈). 기존 `MyAutoField`(CharField 기반)는 `MyWrapperField`로 rename되어 이름 충돌 회피. `tests/custom_pk/models.py`에 `CustomAutoFieldModel`(id=MyAutoField) 추가.
- 증명 방식: 픽스 전에는 `create()` 반환 객체의 `id`가 raw int라 `assertIsInstance(obj.id, MyWrapper)`가 실패. 픽스 후 INSERT 반환값이 `apply_converters`를 거쳐 `MyWrapper`로 래핑되어 통과. `test_auto_field_subclass_bulk_create`는 `can_return_rows_from_bulk_insert` 지원 백엔드에서 bulk 경로까지 확인(`skipUnlessDBFeature`).

## 공략 포인트 (뭘 조져야)
- localization 전략: `returning_fields` + `from_db_value` 키워드로 grep → `SQLInsertCompiler.execute_sql`이 유일한 후보. SELECT 경로와 비교하면 `get_converters`/`apply_converters` 호출 부재가 바로 보인다.
- 함정/난이도 메모: 세 개의 백엔드 분기(bulk insert rows / single-row columns / last_insert_id)를 모두 한 곳으로 모아 공통 converter 적용을 끼워야 한다. 하나만 고치면 다른 백엔드에서 회귀. 또한 converter 적용은 `cursor` 컨텍스트 종료 후에 해야 하며, `cols`는 `returning_fields` 기준으로 만들어야 정렬이 맞는다.
- 우리 에이전트 관점: 코드 한 파일·한 함수라 localization은 쉽지만, "즉시 return 3개"를 "rows에 모았다가 후처리"로 리팩터하는 구조 변경이 필요하다. converter를 어디서 어떻게 가져오는지(SELECT 경로의 `get_converters(cols)` 패턴)를 모르면 단순 `from_db_value` 직접 호출 같은 우회 구현으로 빠질 위험이 있다. `field.get_col(opts.db_table)`로 col 표현식을 만드는 관용구를 인접 코드에서 정확히 가져오는 것이 관건.
