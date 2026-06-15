---
instance_id: django__django-13569
repo: django/django
base_commit: 257f8495d6c93e30ab0f52af4c488d7344bcf112
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-10-19T21:20:55Z
fail_to_pass: 1
pass_to_pass: 66
gold_files: [django/db/models/functions/math.py]
---

# django__django-13569

## 문제 요약
`annotate(Count(...))`에 `order_by('?')`(랜덤 정렬)를 같이 쓰면 집계가 깨진다. 정상이라면 `GROUP BY "thing"."id"`로 묶여 한 행에 `rc=2`가 나와야 하는데, 컴파일러가 `order_by` 표현식을 GROUP BY에 합치면서 `GROUP BY "thing"."id", RANDOM()`가 되어 그룹이 풀려 행이 쪼개진다(`rc=1`이 두 개). 사용자는 랜덤 함수가 집계와 무관하니 그룹핑을 깨뜨리면 안 된다고 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (특정 함수에 대한 group-by 제외 처리 부재)
- 서브시스템: django ORM query compiler / database functions
- 증상 타입: silent-wrong (예외 없이 잘못된 집계 결과 — 행 수와 카운트가 틀림)
- 로컬라이제이션 신호: problem_statement가 직접 `django.db.models.sql.compiler.get_group_by`를 지목하고, 거기서 order_by 표현식을 group_by로 합치는 루프를 보여준다. 또 `RANDOM()`이라는 SQL이 곧 `Random` 함수 클래스를 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/functions/math.py` → `Random.get_group_by_cols`
- 근본 원인: `SQLCompiler.get_group_by`는 non-aggregate, non-ref order_by 표현식의 source 컬럼들을 GROUP BY에 추가한다. `Random`은 인자 없는 순수 함수라 정상적으로는 group-by에 들어갈 컬럼이 없어야 하는데, 기본 `get_group_by_cols` 동작 때문에 `RANDOM()` 자체가 group-by 컬럼으로 끌려 들어가 그룹핑을 깨뜨렸다.
- 수정 요지: 사용자가 제안한 컴파일러 루프 직접 수정(`Random` 인스턴스 필터링) 대신, 더 깔끔하게 `Random` 함수 클래스에 `get_group_by_cols(self, alias=None)`를 오버라이드해 빈 리스트 `[]`를 반환하게 했다. 즉 "이 표현식은 어떤 컬럼도 GROUP BY에 기여하지 않는다"고 표현식 스스로 선언하게 만들어, 컴파일러는 손대지 않고 Random만 group-by에서 제외된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_aggregation_random_ordering` ("Random() is not included in the GROUP BY when used for ordering.")
- 증명 방식: `Author.objects.annotate(contact_count=Count('book')).order_by('?')`를 만들고, 각 저자별 책 수를 `(name, contact_count)`로 비교한다. 픽스 전에는 GROUP BY에 RANDOM()이 끼어 그룹이 풀리며 Peter Norvig 같은 다중 저자 행이 쪼개져 count가 틀린다. 픽스 후에는 정상적으로 저자별 1행씩 묶여 Peter Norvig=2 등 기대 매핑이 나온다(`ordered=False`로 랜덤 순서는 무시).

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 `get_group_by`를 정확히 짚어줘서 진입점은 쉽다. 하지만 진짜 핵심은 "어디를 고치냐"의 선택 — 컴파일러 루프를 `isinstance(exp, Random)`로 패치하는 사용자 방식도 동작하지만, 골드는 표현식 다형성(`get_group_by_cols` 오버라이드)으로 해결한다.
- 함정/난이도: 사용자 제안 패치는 SQLite에서만 통과했고, hints에서도 MySQL/PostgreSQL에서 실패했다고 명시. "no-cols 표현식 전부 스킵" 같은 일반화 시도는 raw SQL 등에서 깨질 수 있다. 정답은 컴파일러를 일반화하지 않고 `Random`에만 국소적으로 빈 group-by를 부여하는 1-파일·3-라인 변경.
- 우리 에이전트 관점: 막힐 지점은 (1) 사용자가 제시한 그럴듯한 컴파일러 패치에 끌려가 `compiler.py`를 광범위하게 건드리려다 다른 DB에서 회귀를 내는 것, (2) `get_group_by_cols`라는 표현식 레벨 훅의 존재를 모르면 깔끔한 해법을 놓치는 것. 67개 PASS_TO_PASS가 회귀 가드라서 컴파일러 일반화는 위험하고, Random 클래스에 국한된 최소 변경이 정답임을 인지해야 한다.
