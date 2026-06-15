---
instance_id: django__django-12965
repo: django/django
base_commit: 437196da9a386bd4cc62b0ce3f2de4aba468613d
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-05-24T13:20:03Z
fail_to_pass: 1
pass_to_pass: 52
gold_files: [django/db/models/sql/compiler.py]
---

# django__django-12965

## 문제 요약
Django 3.1에서 `Model.objects.all().delete()`가 3.0의 단순한 `DELETE FROM table` 대신 `DELETE FROM table WHERE id IN (SELECT id FROM table)` 형태로 불필요한 서브쿼리를 생성하는 성능/기능 회귀다. 서브쿼리에 alias가 없어 MySQL `LOCK TABLES`와 함께 쓸 수 없고, 10만 행 기준 0.2초 → 7.5초로 큰 성능 저하를 일으킨다. 사용자는 단일 테이블 풀 delete에서는 3.0처럼 subquery 없는 평면 DELETE가 나오길 기대한다.

## 유형 분류
- 버그 카테고리: regression (PR #11931 / #23576에서 유입된 회귀)
- 서브시스템: django ORM query compilation (SQL delete compiler)
- 증상 타입: 성능 저하 + 잘못된 SQL 생성(불필요 subquery)
- 로컬라이제이션 신호: problem_statement가 생성 SQL과 `delete()`를 직접 지목하고, hints_text가 "single alias일 때 query를 막을 수 있어야 한다"고 정확히 가리킨다. → delete SQL 생성 경로 = `SQLDeleteCompiler.single_alias`.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/compiler.py` : `SQLDeleteCompiler.single_alias` (cached_property)
- 근본 원인: `single_alias`는 `alias_refcount`가 0보다 큰 alias 개수가 정확히 1개인지를 세서, 단일 테이블이면 평면 `DELETE FROM`(`_as_sql`), 아니면 subquery 경로를 탄다. 그런데 `Model.objects.all()`처럼 필터/조인이 전혀 없는 쿼리에서는 base 테이블의 alias가 `alias_map`에 아직 등록되지 않아 refcount 합이 0이 되고, 결과적으로 `single_alias`가 False로 평가되어 불필요한 subquery 경로로 빠졌다.
- 수정 요지: `single_alias` 계산 전에 `self.query.get_initial_alias()`를 호출해 base 테이블 alias를 강제로 `alias_map`에 채워 넣는다. 이로써 단일 테이블 풀 delete에서도 alias 카운트가 1이 되어 평면 `DELETE FROM table` 경로가 선택되고, 3.0 동작이 복원된다. 단 2줄(주석 1 + 호출 1) 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_fast_delete_all (delete.tests.FastDeleteTests)`
- 테스트가 어떻게 픽스를 증명하는지: `User.objects.all().delete()`를 실행하면서 `assertNumQueries(1)`로 쿼리 1개만 나가는지 확인하고, 캡처된 SQL(`ctx.captured_queries[0]['sql']`)에 `assertNotIn('SELECT', sql)`로 subquery가 없음을 단언한다. 픽스 전에는 `... WHERE id IN (SELECT ...)`라 SELECT가 포함되어 실패, 픽스 후에는 평면 `DELETE FROM`이라 통과한다. PASS_TO_PASS 51개는 fast-delete/cascade/restrict 등 인접 delete 동작이 회귀 없이 유지됨을 보장한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: `delete()` → `Collector.delete()` → fast-delete 경로 → `SQLDeleteCompiler`로 좁힌다. hints_text("single alias")가 `single_alias` 속성을 거의 직접 지목하므로 grep 한 방으로 도달 가능.
- 함정/난이도 메모: 단일 파일·단일 메서드 수정이지만, `alias_refcount`/`alias_map`/`get_initial_alias`의 lazy-population 의미를 이해해야 한다. alias가 "왜 0인지"를 모르면 잘못된 곳(예: `_as_sql`이나 Collector)을 고치려 들기 쉽다. 핵심은 "필터 없는 쿼리는 alias가 아직 채워지지 않았다"는 점.
- 우리 에이전트 관점: 막힐 지점은 정답이 cached_property 안의 한 줄 추가라 표면적으로 단순하지만, 실제로 SQL을 찍어 비교(3.0 vs 3.1)하지 않으면 "어디서 subquery가 생기는지"를 못 짚을 수 있다. 평면 DELETE 경로(`_as_sql`)를 직접 고치려는 과잉 수정보다, alias가 채워지지 않은 게 원인임을 진단하는 게 관건이다.
