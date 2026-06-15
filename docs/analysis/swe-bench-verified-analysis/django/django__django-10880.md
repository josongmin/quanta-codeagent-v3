---
instance_id: django__django-10880
repo: django/django
base_commit: 838e432e3e5519c5383d12018e6c78f8ec7833c1
version: "3.0"
difficulty: <15 min fix
created_at: 2019-01-21T00:22:36Z
fail_to_pass: 1
pass_to_pass: 55
gold_files: [django/db/models/aggregates.py]
---

# django__django-10880

## 문제 요약
`Count` 어노테이션에 `Case` 조건과 `distinct=True`를 함께 넘기면 Django 2.2(모든 DB 백엔드)에서 쿼리 문법 에러가 난다. 생성된 SQL이 `COUNT(DISTINCTCASE WHEN ...)`처럼 `DISTINCT`와 뒤따르는 표현식 사이에 공백이 빠진 형태가 되기 때문이다. 사용자는 `COUNT(DISTINCT CASE WHEN ...)`로 정상 동작하길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case (SQL 문자열 조립 시 공백 누락 — off-by-one 성격의 토큰 결합 버그)
- 서브시스템: django ORM / aggregates (집계 SQL 컴파일)
- 증상 타입: 예외 (DB 문법 에러 — 잘못된 SQL 생성)
- 로컬라이제이션 신호: problem_statement가 `Count` + `distinct=True` + `Case` 조합과 `COUNT(DISTINCTCASE ...)` 출력을 직접 명시. hints_text가 `#28658 -- Added DISTINCT handling to the Aggregate class` 커밋으로 bisect 결과까지 짚어줘서 `Aggregate`의 DISTINCT 처리 지점으로 바로 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/aggregates.py` : `Aggregate.as_sql`
- 근본 원인: `as_sql`에서 `extra_context['distinct'] = 'DISTINCT' if self.distinct else ''`로 설정하는데, 이 값이 템플릿에서 표현식 SQL 바로 앞에 붙는다. 표현식 토큰이 단순 컬럼명일 때는 별도 공백 처리가 있었지만 `CASE WHEN ...` 같은 표현식이 곧바로 이어지면 `DISTINCT`와 `CASE` 사이에 공백이 없어 `DISTINCTCASE`가 된다.
- 수정 요지: `'DISTINCT'`를 `'DISTINCT '`(끝에 공백 추가)로 바꿔, distinct 키워드 뒤에 항상 한 칸을 보장한다. 단 한 글자(공백) 수정으로 `COUNT(DISTINCT CASE WHEN ...)`가 올바르게 조립된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_count_distinct_expression` — `Book.objects.aggregate(distinct_ratings=Count(Case(When(pages__gt=300, then='rating')), distinct=True))`가 에러 없이 실행되고 결과가 4여야 한다.
- 테스트가 어떻게 픽스를 증명하는지: `Count`에 `Case/When` 표현식과 `distinct=True`를 동시에 넘기는, 정확히 문제를 재현하는 입력을 만든다. 픽스 전에는 `COUNT(DISTINCTCASE ...)` SQL이 DB에서 거부되어 예외가 발생하고, 픽스 후에는 공백이 들어가 정상 쿼리가 실행되어 `distinct_ratings == 4`라는 기대 출력이 나온다. test_patch는 `Case, When`을 import에 추가하는 변경도 포함한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: hints_text의 bisect 커밋(`#28658 Added DISTINCT handling`)이 결정적. `django/db/models/aggregates.py`의 `Aggregate` 클래스에서 `distinct` 키워드를 SQL에 박아넣는 `as_sql`만 보면 된다. `grep 'DISTINCT'`로 즉시 위치 특정 가능.
- 함정/난이도 메모: 단일 파일·단일 글자 수정이지만, 기존에 단순 컬럼 케이스에서는 멀쩡히 동작했기 때문에 "왜 일부만 깨지는가"를 표현식 종류별로 따져봐야 보인다. 트레일링 공백 추가가 다른 백엔드 템플릿에서 이중 공백을 만들지 않는지 살펴야 하나, SQL상 무해하므로 안전.
- 우리 에이전트 관점: 막힐 지점은 "단순 컬럼 distinct는 통과하는데 왜 Case만 깨지나"의 원인 추적. 토큰 결합부의 공백을 string-level로 보는 통찰이 필요하고, 자칫 템플릿/컴파일러나 Case 표현식 쪽을 의심해 헛파기 쉽다. 재현 SQL을 한 번 캡처해 `DISTINCTCASE` 문자열을 눈으로 확인하면 즉시 수렴한다.
