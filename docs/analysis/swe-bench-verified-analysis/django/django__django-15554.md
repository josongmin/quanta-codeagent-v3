---
instance_id: django__django-15554
repo: django/django
base_commit: 59ab3fd0e9e606d7f0f7ca26609c06ee679ece97
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-03-29T10:12:46Z
fail_to_pass: 1
pass_to_pass: 41
gold_files: [django/db/models/sql/query.py]
---

# django__django-15554

## 문제 요약
같은 relation(`myrelation__nested`)에 대해 서로 다른 condition을 가진 `FilteredRelation`을 여러 개 선언하면, ORM이 SQL JOIN을 하나만 생성하고 나머지를 무시한다. 사용자는 `relation_zone`과 `relation_all` 각각에 대한 별도 JOIN을 기대했지만, `print(str(qs.query))` 상에서 첫 번째 것만 JOIN으로 나타난다. 결과적으로 두 번째 `FilteredRelation`이 가리키는 컬럼이 잘못된 alias를 참조해 값이 누락된다.

## 유형 분류
- 버그 카테고리: regression (커밋 0c71e0f9cfa714a22297ad31dd5613ee548db379에서 도입), edge-case (동일 relation 다중 FilteredRelation)
- 서브시스템: django ORM query 컴파일 (sql/query.py, join alias 재사용 로직)
- 증상 타입: silent-wrong (예외 없이 JOIN이 병합되어 잘못된 결과 반환)
- 로컬라이제이션 신호: "generates a single SQL JOIN ... ignores the other" → JOIN alias 재사용/병합 로직. FilteredRelation 경로는 `build_filtered_relation_q` → `setup_joins` → `join`으로 흐르므로 query.py의 alias 재사용 조건이 의심 지점.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py`의 `join`, `build_filter`, `build_filtered_relation_q`, `setup_joins`
- 근본 원인: `join()`의 alias 재사용 후보 산정에서 `j.equals(join)`을 사용했는데, `equals`는 `filtered_relation`을 무시한 채 동일 테이블/조건의 join을 동등하다고 판단한다. 따라서 condition이 다른 두 FilteredRelation이 같은 relation을 가리키면 기존 alias가 재사용되어 두 번째 JOIN이 생성되지 않는다.
- 수정 요지: `reuse_with_filtered_relation` 플래그를 `join`/`build_filter`/`setup_joins`에 추가. 이 플래그가 True일 때는 `equals`(filtered_relation 무시)가 아니라 더 엄격한 `j == join`(`__eq__`, filtered_relation까지 비교)을 쓰고, 재사용 후보를 `can_reuse`에 명시된 alias로만 제한한다. `build_filtered_relation_q`가 `build_filter`를 호출할 때 `reuse_with_filtered_relation=True`를 전달하고, `setup_joins`는 이때 `reuse = can_reuse`로 강제해 FilteredRelation별 JOIN이 독립적으로 생성되도록 한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_multiple` — `book_title_alice`(title contains "Alice")와 `book_title_jane`(title icontains "Jane") 두 FilteredRelation을 같은 `book` relation에 걸고 `.values(...)`로 두 컬럼을 함께 조회.
- 증명 방식: name="Jane"인 Author 2명에 대해, Alice 조건은 매칭이 없어 `book_title_alice__title`이 None(또는 빈 문자열), Jane 조건은 각각 "The book by Jane A"/"The book by Jane B"가 나와야 한다. 버그 상태에서는 JOIN이 하나로 병합되어 두 컬럼이 같은 alias를 공유 → 잘못된/누락된 값. 픽스 후 두 JOIN이 분리되어 기대 결과가 나온다. `assertCountEqual`로 순서 무관 비교.

## 공략 포인트 (뭘 조져야)
- localization 전략: `FilteredRelation` 키워드로 query.py를 grep → `build_filtered_relation_q` 진입점 확인 → 그 안의 `build_filter`/`setup_joins`/`join` 콜체인을 따라가며 alias 재사용 결정 지점(`join()`의 `reuse_aliases` 산정)을 찾는다.
- 함정/난이도: 핵심은 `j.equals(join)`와 `j == join`(`__eq__`)의 미묘한 차이다. `equals`는 의도적으로 `filtered_relation`을 무시하도록 설계되어 있어, 이를 무조건 `==`로 바꾸면 일반 JOIN 재사용이 깨져 다른 41개 PASS_TO_PASS가 회귀한다. 따라서 새 플래그로 FilteredRelation 경로에서만 엄격 비교를 켜야 한다. 단일 파일이지만 4개 함수에 플래그를 일관되게 통과시켜야 하는 멀티-시그니처 변경.
- 우리 에이전트 관점: 막힐 지점은 (1) `equals` vs `__eq__`의 차이가 JoinInfo/Join 클래스 정의를 읽어야 드러나는 점, (2) 단순히 비교만 고치면 회귀가 나므로 "FilteredRelation일 때만" 분기해야 한다는 걸 PASS_TO_PASS 보호를 의식해 추론해야 하는 점, (3) `setup_joins`에서 `reuse = can_reuse if join.m2m ...` 라인까지 플래그를 엮어야 JOIN이 실제로 분리된다는 배선 완결성.
