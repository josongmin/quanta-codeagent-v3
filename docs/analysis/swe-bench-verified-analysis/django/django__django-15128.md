---
instance_id: django__django-15128
repo: django/django
base_commit: cb383753c0e0eb52306e1024d32a782549c27e61
version: "4.1"
difficulty: 1-4 hours
created_at: 2021-11-25T15:50:24Z
fail_to_pass: 1
pass_to_pass: 282
gold_files: [django/db/models/sql/query.py]
---

# django__django-15128

## 문제 요약
두 QuerySet을 OR(`|`)로 결합할 때, 특정 조인 구조에서 `Query.change_aliases`가 `AssertionError`를 던진다. 양쪽 쿼리가 같은 alias_prefix(`T`)를 쓰고 rhs가 연속된 alias(예: `T4`, `T5`)를 갖고 있으면, 결합 중 생성되는 change_map이 `{'T4':'T5','T5':'T6'}`처럼 키와 값이 겹쳐버린다. 사용자는 `qs2 | qs1`은 동작하는데 `qs1 | qs2`만 깨지는, 결합 순서에 의존하는 크래시를 겪었다.

## 유형 분류
- 버그 카테고리: edge-case (alias 충돌) / logic
- 서브시스템: django ORM query (SQL 컴파일러의 alias relabeling)
- 증상 타입: 예외 (AssertionError) — 결과 손상이 아니라 결합 자체가 실패
- 로컬라이제이션 신호: 트레이스백에 `query.py`의 `Query.change_aliases`, `change_map = {'T4': 'T5', 'T5': 'T6'}`가 직접 찍혀 있고, problem_statement이 `Query.combine`/`Query.table_alias`/`Query.join`을 근본 원인으로 지목한다. hints_text에서 Simon Charette가 `Query.bump_prefix`를 정확히 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py` — `Query.combine`, `Query.change_aliases`, `Query.bump_prefix`
- 근본 원인: lhs와 rhs가 동일한 `alias_prefix`를 공유하면 결합 시 rhs alias를 relabel하는 change_map의 키와 값이 교집합을 가질 수 있고(`T4->T5`, `T5->T6`), 이 경우 alias가 두 번 갱신되어 `change_aliases` 첫 줄의 `assert set(change_map).isdisjoint(change_map.values())`가 깨진다.
- 수정 요지:
  - `combine`에서 change_map을 만들기 전에 `initial_alias = self.get_initial_alias()`를 구해 `rhs.bump_prefix(self, exclude={initial_alias})`를 호출 — rhs의 prefix를 미리 한 칸 올려 충돌 가능성을 제거한다.
  - `bump_prefix(self, outer_query)`를 `bump_prefix(self, other_query, exclude=None)`로 확장. relabel 딕셔너리 생성 시 `if alias not in exclude`로 base 테이블(initial alias)은 제외 — 양쪽에 반드시 존재하는 base 테이블은 merge 시작점이라 그대로 둬야 KeyError가 안 난다.
  - `change_aliases`의 assert 위에 키/값 교집합 시 alias 이중 갱신 위험을 설명하는 주석 추가(문서화 요청 반영).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_conflicting_aliases_during_combine (queries.tests.QuerySetBitwiseOperationTests)` 1건.
- 재현 입력: `tests/queries/models.py`에 `BaseUser.annotation`(FK)과 `Task.note`(FK)를 추가해 같은 prefix로 연속 alias가 생기는 조인을 만든다. 테스트는 `qs1 = annotation_1.baseuser_set.all()`과 두 OR 분기(`owner__note__in` / `creator__note__in`)를 가진 `qs2`를 구성한 뒤, `qs2 | qs1`과 `qs1 | qs2` 둘 다 평가한다.
- 증명 방식: 픽스 전엔 `qs1 | qs2`가 `AssertionError`로 죽는다. 픽스 후 `assertCountEqual(qs2 | qs1, qs1 | qs2)`로 양방향 결합이 모두 성공하고 결과가 동일함(교환법칙 성립)을 확인하며, 결과 집합이 `[base_user_1, base_user_2]`임을 검증한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: 트레이스백이 `change_aliases`의 assert를 정확히 가리키므로 진입점은 쉽다. 다만 진짜 수정은 assert가 아니라 그 위쪽 `combine`이 만드는 change_map의 생성 과정이다 — assert를 약화/삭제하면 안 되고 충돌이 발생하지 않도록 prefix를 미리 올려야 한다.
- 함정/난이도 메모: 단순히 `bump_prefix(self)`를 호출하면 base 테이블 alias까지 바뀌어 merge 알고리즘이 시작점을 잃고 KeyError가 난다(hints_text의 흔한 실패). 핵심은 `exclude={initial_alias}`로 base 테이블만 보존하는 것. random/순환 prefix 같은 휴리스틱은 subquery alias 충돌로 다른 테스트를 깨뜨린다(hints에 실패 사례 명시). 한 파일 3함수 시그니처를 일관되게 손봐야 하는 멀티-함수 수정.
- 우리 에이전트 관점: assert를 보고 "단언이 틀렸다"며 assert를 지우거나 완화하는 오답으로 빠지기 쉽다. 또 `bump_prefix`가 기존엔 subquery용으로만 쓰여서 combine에 재사용 가능하다는 점, exclude로 initial alias만 보호해야 한다는 점을 파악하려면 alias relabeling/merge 흐름을 끝까지 추적해야 한다 — 표면 패치로는 248개 회귀 테스트를 통과 못 한다.
