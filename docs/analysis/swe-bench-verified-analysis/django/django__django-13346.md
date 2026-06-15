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
---

# django__django-13346

## 문제 요약
MySQL, Oracle, SQLite에서 `JSONField`의 key transform(`value__key__in=[...]`)에 `__in` 룩업이 제대로 동작하지 않는다. 사용자는 `value__key__in=[0]`과 `value__key=0`이 같은 결과를 줄 것으로 기대했지만, `__in`은 0건을 반환했다. 힌트에 따르면 리스트 원소가 1개일 때 특히 깨지고(PostgreSQL은 정상), Oracle은 문자열일 때도 깨진다.

## 유형 분류
- 버그 카테고리: 누락처리 (key transform 전용 In 룩업 미구현) / API-contract (다른 필드의 `__in`과 동작 불일치)
- 서브시스템: django ORM / JSONField key transform 룩업
- 증상 타입: silent-wrong (예외 없이 빈 queryset 반환)
- 로컬라이제이션 신호: "JSONField", "key transform", "__in"이 명시 → `django/db/models/fields/json.py`의 `KeyTransform*` 룩업 등록부. native JSON이 없는 백엔드(MySQL/Oracle/SQLite)만 깨진다는 단서가 RHS 값을 JSON 함수로 감싸는 처리 누락을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/json.py` — 신규 `KeyTransformIn.process_rhs()` 클래스 추가 + `KeyTransform.register_lookup(KeyTransformIn)` 등록
- 근본 원인: 기존엔 `KeyTransform`에 전용 `In` 룩업이 없어 기본 `lookups.In`이 그대로 쓰였다. native JSON field가 없는 백엔드에서 LHS는 `JSON_EXTRACT`/`JSON_VALUE` 등으로 추출된 값인데, RHS의 IN 파라미터는 그 추출 형태와 타입/인용이 맞지 않아 비교가 실패 → 빈 결과.
- 수정 요지: `lookups.In`을 상속한 `KeyTransformIn`이 `process_rhs`를 오버라이드해, `connection.features.has_native_json_field`가 아닐 때 각 RHS 파라미터를 백엔드별 JSON 함수로 감싼다. Oracle은 값이 list/dict면 `JSON_QUERY`, 아니면 `JSON_VALUE`로 `$.value` 경로 추출(파라미터는 SQL에 인라인), MariaDB는 `JSON_UNQUOTE(JSON_EXTRACT(%s,'$'))`, SQLite/MySQL은 `JSON_EXTRACT(%s,'$')`로 감싸 `rhs % func`로 플레이스홀더를 치환한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_key_in`, `test_key_iregex` — `tests/model_fields/test_jsonfield.py::TestQuerying`
- 증명 방식: `test_key_in`은 `value__c__in=[14]`(단일 원소), `[14,15]`(복수), 배열/딕셔너리/문자열 RHS 등 9가지 케이스를 `subTest`로 돌리며 각각 기대 객체(`self.objs[...]`)와 `assertSequenceEqual`로 일치 확인. 특히 단일 원소 케이스(`[14]`, `[1]`, `['bar']`)가 힌트의 "1개 원소일 때만 깨짐" 회귀를 직접 막는다. 골드 픽스가 없으면 이들이 빈 결과를 내 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: `json.py` 안의 `KeyTransformExact`, `KeyTransformIExact` 등 `KeyTransform*` 룩업 패밀리와 하단의 `register_lookup` 블록. 이 패밀리에 `In`만 빠져 있다는 걸 알아채는 게 핵심.
- 함정/난이도: `has_native_json_field` 분기를 빼먹으면 PostgreSQL(정상이던 것)을 깨뜨린다. 백엔드별 JSON 함수 이름이 제각각(`JSON_VALUE`/`JSON_QUERY`/`JSON_EXTRACT`/`JSON_UNQUOTE`)이고, Oracle은 파라미터를 플레이스홀더가 아닌 인라인 문자열로 넣으며 `rhs_params=()`로 비우는 비대칭 처리가 필요하다. MariaDB와 MySQL 분기가 갈린다는 점도 함정.
- 우리 에이전트 관점: 단일 파일 수정이라 멀티파일 함정은 없으나, "왜 빈 결과인가"를 SQL 레벨에서 추론해야 한다. 다른 `KeyTransform*` 룩업의 `process_rhs`/`process_lhs` 패턴을 베이스라인으로 흡수해 백엔드 매트릭스를 채우는 게 정답이며, 한 백엔드만 보고 일반화하면 다른 백엔드를 깬다.
