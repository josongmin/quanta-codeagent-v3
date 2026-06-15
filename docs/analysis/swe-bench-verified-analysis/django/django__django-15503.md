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
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15503

## 문제 요약
`JSONField()`의 `has_key`, `has_keys`, `has_any_keys` 룩업이 SQLite/MySQL/Oracle에서 숫자 형태의 키(예: `'1111'`)를 찾지 못한다. PostgreSQL에서는 정상 동작한다. 사용자는 `{'1111': 'bar'}`를 저장한 뒤 `data__has_key='1111'`로 1건을 기대했지만 0건이 반환됐다(예외 없는 silent-wrong, 빈 결과셋). 근본 원인은 JSON 경로 컴파일 시 정수처럼 보이는 키를 객체 키가 아니라 **배열 인덱스**로 해석한 것. hints_text가 정확히 짚는다: "uses `compile_json_path()` ... which uses array paths for integers. We shouldn't use array paths for these lookups."

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: problem_statement는 "SQLite 한정"이라 오도하지만, hints_text가 함수명 `compile_json_path()`와 영향 룩업 3종(`has_key`/`has_keys`/`has_any_keys`)을 직접 지목한다. 단일 파일 `db/models/fields/json.py`로 수렴하나, 정확한 수정 지점(`HasKeyLookup.as_sql`의 RHS 경로 조립부)과 동반 교체처(isnull/exact의 `as_oracle`/`as_sqlite`)를 좁히는 데 약간의 탐색이 든다. L0(grep 한 방)은 아님.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning)**: 한 줄 가드/상수 변경이 아니다. "마지막 키만 객체 키로, 중간 경로는 그대로"라는 구조 분해가 필요 — `as_sql`에서 RHS 키 리스트를 `*rhs_key_transforms, final_key = ...`로 split하고, final-key 컴파일을 **오버라이드 가능한 메서드**(`compile_json_path_final_key`)로 추출한 뒤, 배열 인덱스가 정말 필요한 경로용으로 서브클래스 `HasKeyOrArrayIndex`를 신설하는 collect-then-process형 리팩터다(S6). 동시에 "어느 키를 객체로, 어느 키를 인덱스로 봐야 하는가"라는 불변식을 추론으로 합성해야 하므로 S2 보조.
- **K (Knowledge) = K-Domain**: django ORM의 JSONField 룩업 계층(`HasKeyLookup`/`HasKey`/`KeyTransformIsNull`/`KeyTransformExact`), `compile_json_path`의 정수→`[N]` vs 객체→`."key"` 분기, 백엔드별 `as_sql`/`as_oracle`/`as_sqlite` 디스패치를 알아야 한다. 일반 파이썬 추론(K-Gen)으론 부족하고, postgres만 `PostgresOperatorLookup` 별경로라 무관함을 아는 것도 도메인 지식.
- **primary type = T-DomainBound**: 진짜 병목이 "어디인지 찾기"(L2/L3)가 아니라 — hints가 위치를 줬으니 — JSONField SQL 컴파일 내부 동작과 멀티-백엔드 디스패치라는 **프레임워크 내부 지식**에 있다. S6 refactor라 T-DesignRefactor 후보지만, 그 refactor를 올바르게 설계하려면 백엔드별 경로·재사용처 매핑이라는 도메인 지식이 dominant 병목이라 T-DomainBound로 분류.

## 난이도 티어
**T4 (약간 어려움)**. 공식 라벨 "1-4 hours"(T4 대역)와 일치.
- 이 티어로 미는 구조적 피처: (1) **K-Domain 병목** — JSONField 룩업 계층·`compile_json_path` 내부 분기·백엔드 디스패치 이해 필요. (2) **S6 소규모 refactor** — 단순 조건 추가가 아니라 final-key 분리 + 오버라이드 훅 + 서브클래스 신설. (3) **regression-trap** — `array__0__has_key`처럼 진짜 배열 인덱스가 필요한 경로를 깨지 않아야 하고, isnull/exact 재사용처(`KeyTransformIsNull.as_oracle`/`.as_sqlite`, `KeyTransformExact.as_oracle`)까지 모두 새 클래스로 교체해야 PASS_TO_PASS 78건의 isnull/exact 케이스가 안 깨진다. 한 군데만 고치면 회귀.
- T5로 안 올리는 이유: 단일 파일·~25줄 변경, 멀티-site지만 모두 한 파일 내 조율이라 cross-file-dep 없음, has-repro로 재현·검증이 명확. overfit 위험은 낮다(test_patch가 숫자/중첩/배열-인덱스 9조합을 커버).
- T3로 안 내리는 이유: hints가 없었다면 "SQLite 한정"이라는 오보고에 속아 좁게 패치할 위험이 크고, final-key 분리라는 비직관적 통찰과 백엔드 전수 교체가 필요해 단일파일 가벼운 추론(T3) 이상이다.

## 골드패치 분석
- **건드린 파일**: `django/db/models/fields/json.py` (단일).
- **건드린 심볼**:
  - `HasKeyLookup.compile_json_path_final_key` — 신규 메서드. final key를 `".%s" % json.dumps(key_transform)`로, 즉 정수 해석 없이 **항상 객체 키**로 컴파일.
  - `HasKeyLookup.as_sql` — RHS 경로 조립 변경. 기존엔 `compile_json_path(rhs_key_transforms, include_root=False)` 전체를 한 번에 붙였으나, `*rhs_key_transforms, final_key = rhs_key_transforms`로 마지막 키를 분리해 중간 경로만 `compile_json_path`로, final key는 `compile_json_path_final_key`로 따로 조립.
  - `HasKeyOrArrayIndex(HasKey)` — 신규 서브클래스. `compile_json_path_final_key`를 오버라이드해 `compile_json_path([key_transform], include_root=False)`를 호출 → final key에서 **정수→배열 인덱스 해석을 다시 허용**.
  - `KeyTransformIsNull.as_oracle` / `KeyTransformIsNull.as_sqlite` / `KeyTransformExact.as_oracle` — 내부의 `HasKey(...)` 생성을 `HasKeyOrArrayIndex(...)`로 교체.
- **근본 원인**: `compile_json_path()`는 키가 정수로 파싱되면 `[N]`(배열 인덱스) 경로를, 아니면 `."key"`(객체 키) 경로를 만든다. `has_key='1111'`의 final key가 정수로 파싱돼 `$[1111]` 같은 배열 경로가 되고, 실제 데이터는 `{"1111": ...}` 객체 키라 SQLite/MySQL/Oracle의 JSON path 매칭이 실패(0건). PostgreSQL은 `PostgresOperatorLookup`의 `?`/`?&`/`?|` 연산자 경로라 이 버그에 무관.
- **수정 요지**: `has_key` 계열의 **마지막 키만** 무조건 객체 키로 취급(기본 동작)하되, isnull/exact가 내부적으로 has-key를 재사용하는 경로에서는 `value__array__0__...`처럼 진짜 배열 인덱스가 final key일 수 있으므로 `HasKeyOrArrayIndex`로 정수 해석을 복구. 즉 "두 해석"을 오버라이드 훅 하나로 분기해 공존시킨다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2건)**: `test_has_key_number`(신규), `test_has_keys`(기존, **미수정**). test_patch는 `test_has_key_number`만 추가하며 `test_has_keys`는 손대지 않는다. 그 본문도 `value__has_keys=["a","c","h"]`(숫자 키 0개, `self.objs[4]`만 대상)이라 base의 `as_sql`도 `."a"`/`."c"`/`."h"` 경로를 정상 생성해 통과해야 한다. 따라서 `test_has_keys`가 FAIL_TO_PASS에 든 것은 numeric-key 동작과 무관한 SWE-bench 하네스/로그-파싱 아티팩트이며, 진짜 신규·실효 FAIL_TO_PASS는 `test_has_key_number` 하나다.
- **FAIL_TO_PASS 동작**: `test_has_key_number`는 `{"123": "value", "nested": {"456":"bar","lorem":"abc","999":True}, "array":[{"789":"baz","777":"def","ipsum":200}], "000":"val"}`를 저장하고, 9가지 조건을 subTest로 돌린다 — `has_key="123"`, `nested__has_key="456"`, `array__0__has_key="789"`, 그리고 `has_keys`/`has_any_keys`의 숫자·중첩·배열-인덱스 혼합 조합. 각 조건은 정확히 `[obj]` 한 건을 반환해야 한다.
- **픽스 증명**: 숫자 문자열 키(`123`,`456`,`789`,`000`)가 배열 인덱스가 아닌 **객체 키**로 매칭됨(픽스의 final-key 객체화)을 확인하는 동시에, `array__0__has_key`처럼 final key 앞 경로의 진짜 배열 인덱스(`0`)는 여전히 동작함을 검증 — 두 해석이 final-key 분리로 공존함을 한 테스트가 증명한다.
- **overfit 관점**: 낮음. test_patch가 단일 숫자 키, 중첩 객체, 배열 원소, `has_keys`/`has_any_keys` 다중 키까지 9조합을 커버해 special-case 우회 패치를 배제한다. flags에 overfit-risk 미부여.
- **regression 관점**: PASS_TO_PASS 78건이 isnull/exact/has_key/deep-lookup/key-transform 전반을 덮는다. 핵심 trap은 `test_isnull_key`, `test_isnull_key_or_none`, `test_none_key*`, `test_deep_lookup_array`, `test_has_key_deep` 등 — isnull/exact가 has-key를 재사용하므로 `HasKeyOrArrayIndex`로 전수 교체하지 않으면 이들이 깨진다. flags에 regression-trap 부여.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈는 "SQLite 한정, 숫자 키 has_key 실패"라고 하지만 hints_text의 결정적 신호 — "uses `compile_json_path()` ... array paths for integers. We shouldn't use array paths for these lookups." — 를 신뢰한다. `db/models/fields/json.py`에서 `compile_json_path`와 그 호출부 `HasKeyLookup.as_sql`로 직행. 호출 그래프상 `HasKey`/`HasKeys`/`HasAnyKeys`가 `HasKeyLookup` 자식이고, isnull/exact가 `HasKey`를 재사용함을 확인.
2. **픽스와 왜 올바른 일반화인가**: `as_sql`에서 RHS 키 리스트의 final key를 분리해 객체 키로 강제(`."key"`)하고, 중간 경로는 기존 `compile_json_path`(정수→인덱스 허용)를 유지. 이게 올바른 일반화인 이유 — has-key 의미론은 "이 키가 객체에 존재하는가"이므로 final key는 본질적으로 객체 멤버이지 배열 인덱스가 아니다. 동시에 `value__array__0__has_key`에서 `0`은 has_key의 final이 아니라 **경로 중간**의 배열 인덱스라 중간 경로 처리에 자연히 흡수된다. 숫자/문자/중첩/배열 모든 키 형태에 일관 적용되므로 special-case가 아님.
3. **regression 안전**: isnull/exact는 내부적으로 `HasKey`를 만들어 has-key SQL을 재사용하는데, 이들 중 일부 경로(`value__array__0__isnull` 등)는 final key가 **진짜 배열 인덱스**일 수 있다. 따라서 정수 해석을 복구하는 `HasKeyOrArrayIndex` 서브클래스를 만들어 `KeyTransformIsNull.as_oracle`/`.as_sqlite`, `KeyTransformExact.as_oracle`의 생성을 교체해야 `test_isnull_key*`, `test_none_key*`, `test_deep_lookup_array`가 안 깨진다. PostgreSQL 경로(`PostgresOperatorLookup`)는 손대지 않는다 — 거기 손대면 postgres has_key 회귀.
4. **함정 회피**: 오라클 없는 에이전트의 주된 실패 모드 — (a) "SQLite 한정" 오보고를 믿고 SQLite 분기만 좁게 패치 → Oracle/MySQL 미해결. (b) 모든 키를 객체 키로 일괄 변환 → `array__0__has_key`의 배열 인덱스 경로가 깨짐(final-key만 분리해야 한다는 통찰을 놓침). (c) `as_sql`만 고치고 isnull/exact 재사용처를 빠뜨려 PASS_TO_PASS 회귀. 회피법: has_key 호출 그래프와 백엔드별 디스패치를 먼저 전수 매핑하고, "final key는 객체, 중간 인덱스는 인덱스"라는 불변식으로 모든 진입점을 한 번에 교체.
