---
instance_id: django__django-15503
repo: django/django
base_commit: 859a87d873ce7152af73ab851653b4e1c3ffea4c
version: 4.1
difficulty: 1-4 hours
created_at: 2022-03-12T06:22:37Z
fail_to_pass: 2
pass_to_pass: 78
gold_files: [django/db/models/fields/json.py]
---

# django__django-15503

## 문제 요약
`JSONField()`의 `has_key`, `has_keys`, `has_any_keys` 룩업이 SQLite/MySQL/Oracle에서 숫자 형태의 키(예: `'1111'`)를 찾지 못한다. PostgreSQL에서는 정상 동작한다. 사용자는 `{'1111': 'bar'}`를 저장한 뒤 `data__has_key='1111'`로 1건을 기대했지만 0건이 반환됐다. JSON 경로를 컴파일할 때 정수처럼 보이는 키를 객체 키가 아니라 배열 인덱스로 해석한 것이 원인.

## 유형 분류
- 버그 카테고리: edge-case (숫자 키) / 누락처리
- 서브시스템: django ORM — JSONField 룩업 / SQL 컴파일 (db/models/fields/json.py)
- 증상 타입: silent-wrong (예외 없이 빈 결과셋)
- 로컬라이제이션 신호: problem_statement는 SQLite 한정이라 했지만 hints_text가 정확히 짚어줌 — "uses `compile_json_path()` ... which uses array paths for integers. We shouldn't use array paths for these lookups." 즉 `compile_json_path` 호출부와 `has_key` 계열 클래스가 핵심.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/json.py`
  - `HasKeyLookup.compile_json_path_final_key` (신규 메서드)
  - `HasKeyLookup.as_sql` (RHS 경로 조립 변경)
  - `HasKeyOrArrayIndex(HasKey)` (신규 클래스)
  - `KeyTransformIsNull.as_oracle` / `.as_sqlite`, `KeyTransformExact.as_oracle` (`HasKey` → `HasKeyOrArrayIndex` 교체)
- 근본 원인: `compile_json_path()`는 키가 정수로 파싱되면 `[N]`(배열 인덱스) 경로를, 아니면 `."key"`(객체 키) 경로를 만든다. `has_key` 룩업의 마지막 키 `'1111'`은 정수로 파싱돼 `$[1111]` 같은 배열 경로가 되고, 실제 데이터는 객체 키라 매칭 실패.
- 수정 요지: `as_sql`에서 RHS 키 리스트의 마지막 키를 분리(`*rhs_key_transforms, final_key = ...`)해서, 중간 경로는 기존 `compile_json_path`로 만들고 **마지막 키만** `compile_json_path_final_key`로 컴파일한다. 기본 구현은 `.%s` (json.dumps) 형태로 항상 객체 키 취급. 단, 배열 인덱스가 진짜로 필요한 isnull/exact 같은 경로(`value__array__0__has_key`)를 위해 `HasKeyOrArrayIndex`가 final key에서 다시 `compile_json_path`를 써 정수→배열 인덱스 해석을 허용한다. Oracle/SQLite isnull·exact 분기는 이 새 클래스로 교체.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_has_key_number` (신규), `test_has_keys` (기존이 강화돼 재실행).
- `test_has_key_number`는 `{"123": ..., "nested": {"456":..., "999":True}, "array":[{"789":..., "777":...}], "000":...}`를 저장하고, `has_key="123"`, `nested__has_key="456"`, `array__0__has_key="789"`, 그리고 `has_keys` / `has_any_keys`의 숫자·중첩·배열 인덱스 조합 9가지를 subTest로 돌린다.
- 증명 방식: 각 조건이 정확히 `[obj]` 한 건을 반환해야 한다. 숫자 키(`123`,`456`,`789`,`000`)가 배열 인덱스가 아닌 객체 키로 매칭됨을 확인하면서, `array__0__has_key`처럼 진짜 배열 인덱스(`0`)는 여전히 동작함을 동시에 보장 — 두 해석이 final-key 분리로 공존함을 증명.

## 공략 포인트 (뭘 조져야)
- 어디부터: `db/models/fields/json.py`의 `HasKeyLookup.as_sql`와 `compile_json_path` 헬퍼. hints_text가 함수명을 직접 줘서 로컬라이제이션은 쉬운 편.
- 함정/난이도:
  - "마지막 키만" 객체 키로 취급해야 한다는 게 비직관적 — 전부 객체 키로 바꾸면 `array__0__has_key` 같은 배열 인덱스 경로가 깨진다. final key 분리가 핵심 통찰.
  - 멀티-백엔드: SQLite/MySQL은 `as_sql`, Oracle은 `as_oracle` 경로를 타고, isnull/exact 재사용처(`KeyTransformIsNull`, `KeyTransformExact`)까지 모두 `HasKeyOrArrayIndex`로 교체해야 회귀가 안 난다. 한 군데만 고치면 PASS_TO_PASS의 isnull/exact 케이스가 깨질 수 있음.
  - PostgreSQL은 `PostgresOperatorLookup` 경로라 무관 — 거기 손대면 안 됨.
- 우리 에이전트 관점: 증상이 "SQLite 한정"으로 보고됐지만 실제론 array-path를 쓰는 모든 백엔드 공통이라, SQLite만 보고 좁게 패치하면 Oracle/exact/isnull 분기를 놓친다. final-key를 분리하는 리팩터링과 새 서브클래스 도입이라는 "구조적" 수정을 떠올려야 하는 점에서 단순 조건 추가보다 난이도가 있다.
