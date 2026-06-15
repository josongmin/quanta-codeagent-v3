---
instance_id: django__django-11555
repo: django/django
base_commit: 8dd5877f58f84f2b11126afbd0813e24545919ed
version: 3.0
difficulty: <15 min fix
created_at: 2019-07-10T18:07:07Z
fail_to_pass: 1
pass_to_pass: 26
gold_files: [django/db/models/sql/compiler.py]
---

# django__django-11555

## 문제 요약
멀티테이블 상속(MTI)에서 부모 모델의 `Meta.ordering`이 문자열이 아니라 쿼리 표현식(`OrderBy`, 예: `F('author').asc(...)`, `Lower('name')`)을 포함할 때, 자식 모델을 `order_by()`로 정렬하면 크래시가 난다. 내부적으로 ordering 항목을 문자열로 가정하고 `get_order_dir()`에서 슬라이싱/구독(subscript)하려다 `'OrderBy' object is not subscriptable` 같은 예외가 발생한다. 사용자는 표현식 기반 기본 정렬이 상속 모델에서도 정상 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (타입 분기 누락) / edge-case
- 서브시스템: django ORM query compiler (SQL 정렬 컴파일)
- 증상 타입: 예외 / 크래시 (TypeError: not subscriptable)
- 로컬라이제이션 신호: problem_statement가 "field is an OrderBy object, not a string, during get_order_dir"라고 명시. hints의 `'Lower' object is not subscriptable ... comes via get_order_dir()`도 동일 지점을 가리킴. 스택트레이스 → `get_order_dir` 호출처 = compiler의 ordering 해석 경로(`find_ordering_name`).

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py` : `SQLCompiler.find_ordering_name`
- 근본 원인: `find_ordering_name`이 `opts.ordering`을 순회하며 각 항목을 다시 `self.find_ordering_name(item, ...)`로 재귀 호출하는데, 이 재귀 경로는 항목이 필드명 문자열이라고 가정한다. 항목이 이미 해석 완료된 `OrderBy` 표현식이면 하위에서 `get_order_dir()`이 문자열로 다루며 구독 연산을 시도 → 크래시.
- 수정 요지: ordering 항목을 재귀 처리하기 전에 `isinstance(item, OrderBy)` 검사를 추가. `OrderBy`이면 이미 완성된 정렬 표현식이므로 재귀하지 말고 `results.append((item, False))`로 그대로 결과에 담고 `continue`. 문자열 항목만 기존처럼 `find_ordering_name`으로 재귀해 필드명을 해석한다. 즉 표현식과 문자열을 타입으로 분기.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_order_by_ptr_field_with_default_ordering_by_expression`
- 테스트 셋업: `tests/ordering/models.py`에 `OrderedByAuthorArticle`를 상속한 빈 자식 `class ChildArticle(Article)`(주: 패치 컨텍스트상 표현식 ordering을 갖는 부모 Article 계열)을 추가. 부모의 `Meta.ordering`이 `(models.F('author').asc(nulls_first=True), 'id')` 같은 표현식을 포함.
- 증명 방식: `ChildArticle` 4건을 author 차이로 생성한 뒤 `ChildArticle.objects.order_by('article_ptr')`를 실행. 픽스 전에는 부모의 표현식 ordering 해석 중 크래시. 픽스 후엔 표현식이 그대로 정렬에 반영되어 `assertSequenceEqual(articles, [ca4, ca2, ca1, ca3])`로 nulls_first + author asc 순서를 검증.

## 공략 포인트 (뭘 조져야)
- 어디부터: 예외 메시지(`not subscriptable`)와 `get_order_dir`를 grep → 호출처가 `compiler.py`의 ordering 해석. 단, 진짜 고칠 지점은 `get_order_dir` 자체가 아니라 그 위에서 표현식을 문자열처럼 넘기는 `find_ordering_name`의 `opts.ordering` 순회 루프.
- 함정/난이도: 단일 파일·3줄짜리이지만 (1) 증상 발생 함수(`get_order_dir`)와 수정 함수(`find_ordering_name`)가 달라서 스택트레이스 바닥만 보면 엉뚱한 곳을 고치기 쉽다. (2) MTI일 때만 `opts.ordering`이 표현식째로 재귀에 들어와 재현 조건이 좁다(REPL에선 안 터지고 test db setup에서만 — 부모 메타 ordering 경유). (3) `OrderBy`는 이미 dir이 내장돼 있으므로 `(item, False)`로 reverse=False 처리하는 게 정답.
- 우리 에이전트 관점: 막힐 지점은 "어느 함수를 고칠지". `get_order_dir`에 방어 코드를 넣는 과교정으로 빠지기 쉽다. 올바른 픽스는 표현식이 문자열 해석 경로로 흘러들기 전에 상위 루프에서 타입 분기로 차단하는 것. 재현 테스트가 MTI + 표현식 ordering 조합이라는 점을 못 잡으면 헬게이트 재현 자체가 어렵다.
