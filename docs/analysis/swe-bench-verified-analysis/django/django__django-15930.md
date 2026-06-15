---
instance_id: django__django-15930
repo: django/django
base_commit: 63884829acd207404f2a5c3cc1d6b4cd0a822b70
version: 4.2
difficulty: <15 min fix
created_at: 2022-08-07T15:26:41Z
fail_to_pass: 1
pass_to_pass: 88
gold_files: [django/db/models/expressions.py]
---

# django__django-15930

## 문제 요약
`Case(When(~Q(pk__in=[]), then=...))` 형태로 "항상 참인" 조건을 쓰면 `ProgrammingError: syntax error at or near "THEN"`가 발생한다. `~Q(pk__in=[])`는 모든 행에 매칭되는 sentinel 조건인데, 생성된 SQL이 `CASE WHEN THEN True ...`처럼 조건절이 통째로 비어버린다. 사용자는 모든 행이 조건에 매칭되므로 전부 `True`로 annotate되기를 기대했다.

## 유형 분류
- 버그 카테고리: edge-case (always-true 조건의 빈 SQL 처리 누락) + 누락처리
- 서브시스템: django ORM query / SQL 컴파일 (conditional expressions, `Case`/`When`)
- 증상 타입: 예외 (DB 레벨 SQL syntax error / `ProgrammingError`)
- 로컬라이제이션 신호: 문제는 `When` 조건의 SQL 컴파일에서 빈 문자열이 나오는 것 → conditional expression의 `as_sql`. `Case()`/`When()` 클래스는 `django/db/models/expressions.py`에 정의됨. "WHERE clause에서는 빈 문자열로 처리"라는 점이 핵심 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/expressions.py` → `When.as_sql`
- 근본 원인: `~Q(pk__in=[])` 같은 "everything-matches" 필터는 WHERE 절에서는 빈 문자열(`""`)로 컴파일되어 정상 동작한다 (WHERE 전체가 생략됨). 하지만 `CASE WHEN <cond> THEN ...` 구문에서는 `<cond>` 자리에 빈 문자열이 들어가면 `WHEN THEN`이 되어 SQL 문법 오류가 난다.
- 수정 요지: `When.as_sql`에서 `condition_sql, condition_params = compiler.compile(self.condition)` 직후, `condition_sql == ""`이면 항상 참인 술어로 대체한다 — `compiler.compile(Value(True))`로 재컴파일하여 `condition_sql`/`condition_params`를 채운다. 즉 WHERE에서는 empty가 맞지만 CASE WHEN 컨텍스트에서는 명시적 True 술어가 필요하다는 차이를 보정.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_annotate_with_full_when` — `Case(When(~Q(pk__in=[]), then=Value("selected")), default=Value("not selected"))`로 annotate.
- 증명 방식: 재현 입력은 항상 참인 조건 `~Q(pk__in=[])`. 기대 출력은 (1) 쿼리가 SQL 오류 없이 실행되어 `len(objects) == CaseTestModel.objects.count()` (전 행 반환), (2) 모든 객체의 `selected == "selected"` (조건이 항상 참이므로 default가 아닌 then 값). 기존 `test_annotate_with_empty_when`(항상 거짓 `Q(pk__in=[])`)과 대칭쌍을 이뤄, empty/full 양쪽 sentinel을 모두 커버.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: SQL 오류가 `CASE WHEN THEN`에서 나므로 `When` expression의 SQL 생성 지점인 `When.as_sql`(`expressions.py`). `condition_sql`이 빈 문자열로 나오는 경로를 추적하면 바로 도달.
- 함정/난이도 메모: 단일 파일, 5줄짜리 fix지만 "왜 빈 문자열이 나오는가"를 이해해야 한다. WHERE 절에서는 empty-string이 정상(올웨이즈-트루를 생략으로 표현)이라는 Django 내부 관례를 모르면, `Q(pk__in=[])` 빈 리스트 처리나 `WhereNode` 쪽을 잘못 파고들 수 있다. 실제 fix는 그 윗레벨이 아니라 `When` 컨텍스트에서 보정하는 것. `Value(True)`로 재컴파일하는 것이 백엔드 호환(`1=1` 등)을 자동 처리해주는 핵심.
- 우리 에이전트 관점: 막힐 지점은 (1) 빈 문자열의 출처를 `Q`/`WhereNode` 깊숙이 추적하다 over-engineering, (2) DB별로 다른 always-true 리터럴(`TRUE`/`1`)을 하드코딩하려는 유혹. 골드처럼 `Value(True)`에 위임하는 최소 보정이 정답. always-false 케이스(empty_when)는 이미 통과하므로 그쪽은 건드리면 안 됨.
