---
instance_id: django__django-14122
repo: django/django
base_commit: bc04941bf811d1ea2c79fb7fc20457ed2c7e3410
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-03-13T19:57:16Z
fail_to_pass: 1
pass_to_pass: 26
gold_files: [django/db/models/sql/compiler.py]
---

# django__django-14122

## 문제 요약
모델 `Meta.ordering`이 설정된 상태에서 `.values(...).annotate(Count(...))` 같은 집계 쿼리를 돌리면, `Meta.ordering`에 쓰인 필드들이 GROUP BY 절에 끼어들어가 잘못된 집계 결과가 나온다. 이전 커밋 `0ddb4ebf`가 이 경우 ORDER BY는 제거했지만 GROUP BY는 여전히 ordering 필드로 채워 그룹이 과도하게 쪼개졌다. 사용자는 명시적으로 묶은 컬럼(`author`)만으로 그룹핑되어 올바른 카운트가 나오길 기대한다.

## 유형 분류
- 버그 카테고리: regression (이전 fix가 불완전했던 후속 버그) / edge-case
- 서브시스템: django ORM query / SQL compiler (GROUP BY 생성)
- 증상 타입: silent-wrong (예외 없이 잘못된 집계 출력)
- 로컬라이제이션 신호: "GROUP BY", "Meta.ordering", "wrong aggregation" 키워드와 기존 커밋 `0ddb4ebf` 참조가 SQL compiler의 `get_group_by` 로직을 직접 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py` : `SQLCompiler.get_group_by`
- 근본 원인: `get_group_by`는 `order_by` 항목 중 SELECT 참조가 아닌(`is_ref`가 False인) 표현식의 컬럼을 GROUP BY에 추가한다. 그런데 ordering이 사용자가 명시한 게 아니라 `Meta.ordering`에서 암묵적으로 온 경우에도 이 컬럼들이 GROUP BY로 들어가, 의도하지 않은 컬럼으로 그룹이 추가 분할됐다.
- 수정 요지: `order_by` 표현식을 GROUP BY에 추가하는 루프 전체를 `if not self._meta_ordering:` 가드로 감쌌다. 즉 ordering이 `Meta.ordering`에서 파생된 것이면 그 컬럼들을 GROUP BY에 넣지 않는다. 사용자가 명시적으로 `order_by()`를 건 경우에는 기존 동작이 그대로 유지된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_default_ordering_does_not_affect_group_by` — `Meta.ordering`이 있는 `Article`에서 author별 카운트가 정확히 나오는지 검증.
- 테스트가 어떻게 픽스를 증명하는지: author_1을 3개 기사(Article 4 제외)에, author_2를 1개(Article 4)에 할당한 뒤 `Article.objects.values('author').annotate(count=Count('author'))`를 실행. 버그 상태에서는 `Meta.ordering` 필드가 GROUP BY에 끼어 author당 카운트가 1씩으로 쪼개진다. 픽스 후에는 `[{author: pk1, count: 3}, {author: pk2, count: 1}]`가 나와 author만으로 그룹핑됨을 증명한다(`assertCountEqual`).

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `compiler.py`의 `get_group_by`에서 `order_by` 루프가 GROUP BY 표현식을 확장하는 부분. `self._meta_ordering` 플래그가 이미 존재하므로(ORDER BY 제거 로직에서 쓰임) 그 플래그를 GROUP BY 분기에도 재사용하는 게 핵심.
- 함정/난이도 메모: 단일 파일·소규모 변경이지만 정확한 조건이 까다롭다. ordering 전체를 무조건 빼면 명시적 `order_by()` 케이스가 깨진다 — 반드시 `Meta.ordering` 출처일 때(`_meta_ordering`)만 걸러야 한다. `is_ref` 처리(SELECT 참조 스킵)는 유지해야 한다.
- 우리 에이전트 관점: 증상이 silent-wrong이라 재현 없이는 위치 파악이 어렵다. ORDER BY는 잘 나오는데 GROUP BY만 틀린, ORDER BY/GROUP BY 생성 경로의 비대칭을 짚어야 하고, 이미 있는 `_meta_ordering` 플래그를 발견·재사용하는 것이 over-engineering 없이 최소 수정으로 가는 길이다.
