---
instance_id: django__django-15382
repo: django/django
base_commit: 770d3e6a4ce8e0a91a9e27156036c1985e74d4a3
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2022-02-01T18:29:41Z
fail_to_pass: 1
pass_to_pass: 161
gold_files: [django/db/models/expressions.py]
---

# django__django-15382

## 문제 요약
`~Exists(EmptyQuerySet)`를 다른 조건과 AND로 묶어 `filter()`하면 WHERE 블록 전체가 사라진다. `MyModel.objects.filter(~models.Exists(MyModel.objects.none()), name='test')`가 빈 결과를 반환하고 `print(qs.query)`는 `EmptyResultSet`을 띄운다. 부정된 EXISTS는 항상 참이어야 하므로 `name='test'` 조건은 남아 정상적으로 필터링되어야 하는데, 빈 서브쿼리가 던진 `EmptyResultSet`이 위로 전파되며 쿼리 전체를 비워버린다.

## 유형 분류
- 버그 카테고리: edge-case (빈 queryset + 부정 조합) / 누락처리 (예외 미처리)
- 서브시스템: django ORM query / expressions (Subquery·Exists SQL 컴파일)
- 증상 타입: silent-wrong (예외 없이 잘못된 빈 결과, WHERE 절 누락)
- 로컬라이제이션 신호: problem_statement의 `models.Exists(...)`와 `EmptyResultSet`, hints의 "issue with Exists.as_sql when self.invert is True" → `Exists.as_sql`로 바로 지목됨

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/expressions.py` : `Exists.as_sql`
- 근본 원인: 빈 서브쿼리(`.none()`)는 컴파일 시 `EmptyResultSet`을 던진다. `Exists.as_sql`이 `super().as_sql(...)`(Subquery 컴파일) 호출에서 이 예외를 그대로 전파시킨다. EXISTS가 부정(`~`)된 경우 의미상 "항상 참"이라 WHERE에서 무시 가능해야 하는데, 예외가 위로 올라가 쿼리셋 전체가 `EmptyResultSet`으로 처리된다.
- 수정 요지: `super().as_sql(...)` 호출을 `try/except EmptyResultSet`로 감싼다. 예외가 잡히고 `self.negated`이면 빈 SQL `('', ())`를 반환해 해당 조건을 사실상 무시(항상 참)하게 한다. 부정이 아니면 `raise`로 기존 동작 유지. hints의 `'%s = %s', (1, 1)` 제안과 달리 골드는 더 간결한 빈 문자열 반환을 택했다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_negated_empty_exists (expressions.tests.ExistsTests)`
- 동작: `Manager` 한 건 생성 후 `~Exists(Manager.objects.none()) & Q(pk=manager.pk)`로 필터링. 부정된 빈 EXISTS는 무시되어야 하므로 `pk=manager.pk` 조건만 살아남아 그 객체가 결과에 포함되어야 한다.
- 픽스 증명: 픽스 전이면 `EmptyResultSet`이 전파되어 `qs`가 빈 리스트가 되고 `assertSequenceEqual(qs, [manager])`가 실패한다. 픽스 후에는 부정 EXISTS가 `('', ())`로 떨어져 WHERE가 `pk=manager.pk`만 남고 manager가 반환되어 통과한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: `expressions.py`에서 `class Exists`와 `as_sql`/`__invert__`를 읽는다. problem_statement의 `EmptyResultSet`을 grep하면 `Subquery.as_sql` 경로와 `Exists`가 바로 잡힌다.
- 함정/난이도: 단일 파일·단일 함수라 범위는 좁지만, 핵심은 "부정일 때만" 예외를 삼켜야 한다는 비대칭 처리. 부정이 아닌 EXISTS에서까지 삼키면 잘못된 결과가 나오므로 `self.negated` 가드가 필수다. 또한 빈 SQL을 반환할지 `1=1` 같은 항상-참 술어를 넣을지 선택지가 있는데, 골드는 `('', ())` 빈 반환을 신뢰. 참조 티켓 #33018과 유사 패턴.
- 우리 에이전트 관점: `EmptyResultSet`의 의미(빈 결과 단락 신호)와 부정 컨텍스트를 함께 추론해야 한다. 단순히 예외를 잡아 무조건 빈 문자열을 반환하면 비부정 EXISTS 회귀가 생기므로, `negated` 분기를 빠뜨리면 PASS_TO_PASS의 다수 EXISTS/Subquery 테스트가 깨질 위험이 있다.
