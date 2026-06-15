---
instance_id: django__django-11603
repo: django/django
base_commit: f618e033acd37d59b536d6e6126e6c5be18037f6
version: 3.0
difficulty: <15 min fix
created_at: 2019-07-28T18:14:23Z
fail_to_pass: 2
pass_to_pass: 58
gold_files: [django/db/models/aggregates.py]
---

# django__django-11603

## 문제 요약
`Avg`와 `Sum` 집계에 `distinct=True`를 넘기면 Django 2.2부터 예외가 발생한다. #28658에서 `Count`에 DISTINCT를 허용한 것의 연장선으로, 일반 집계(`Avg`, `Sum`)에서도 DISTINCT를 지원해야 한다. 2.2 이전에는 파라미터를 무시했지만 지금은 throw 하므로, 해당 클래스들이 DISTINCT를 허용하도록 표시만 하면 된다.

## 유형 분류
- 버그 카테고리: 누락처리 / API-contract (지원되어야 할 인자가 거부됨)
- 서브시스템: django ORM aggregates (`django.db.models.aggregates`)
- 증상 타입: 예외 (`distinct=True` 전달 시 DISTINCT 미허용 에러)
- 로컬라이제이션 신호: "Avg and Sum aggregates", "setting these classes as allowing DISTINCT", #28658(Count distinct) 참조 → 집계 클래스 정의 파일(`aggregates.py`)로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/aggregates.py` — `Avg` 클래스, `Sum` 클래스 (클래스 속성)
- 근본 원인: 베이스 `Aggregate` 클래스는 `allow_distinct = False`가 기본이며, `__init__`에서 `distinct=True`인데 `allow_distinct`가 False면 `TypeError`를 던진다. `Count`만 `allow_distinct = True`로 설정돼 있어 `Avg`/`Sum`은 DISTINCT 거부.
- 수정 요지: `Avg` 클래스에 `allow_distinct = True` 한 줄, `Sum` 클래스에 `allow_distinct = True` 한 줄을 추가. 함수 위치는 각각 `function = 'AVG'`/`function = 'SUM'` 정의 바로 아래. 로직 변경 없이 기존 `Aggregate.__init__`의 distinct 게이트를 통과시키는 선언적 수정.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_distinct_on_aggregate` — `Avg`/`Count`/`Sum` 각각에 대해 `Book.objects.aggregate(ratings=aggregate('rating', distinct=True))`를 실행하고 기대값(Avg→4.125, Count→4, Sum→16.5)을 검증.
  - `test_empty_aggregate` — 전체 집계 동작 회귀 보장.
- 테스트가 픽스를 증명하는 방식: 패치 전에는 `Avg('rating', distinct=True)` / `Sum('rating', distinct=True)` 생성 자체가 예외를 던져 테스트가 실패한다. `allow_distinct = True` 추가 후에는 중복 제거된 rating 집합(distinct 4건)에 대해 평균/합/카운트가 계산돼 기대값과 일치. 또한 기존 `test_count`에서 `Count("rating", distinct=True)` 케이스를 제거해 distinct 검증을 새 통합 테스트로 이관.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `django/db/models/aggregates.py`의 클래스 정의들. `Count`에 이미 있는 `allow_distinct = True`를 grep으로 찾으면 패턴이 즉시 드러난다 — `Avg`/`Sum`에 동일 속성만 미러링.
- 함정/난이도 메모: 단일 파일·2줄 추가의 trivial 픽스. 진짜 로직은 베이스 `Aggregate.__init__`(distinct + allow_distinct 검사)에 있으므로 그쪽을 고치려 하면 오버엔지니어링/회귀 위험. problem_statement가 "setting these classes as allowing DISTINCT"라고 처방까지 줘서 의도 파악은 쉬움. Min/Max도 가능하다 언급되나 골드는 적용 안 함(불필요).
- 우리 에이전트 관점: 막힐 지점은 거의 없음. 다만 distinct 게이트 로직을 `Aggregate` 베이스에서 손대는 과잉수정, 또는 Min/Max까지 손대 PASS_TO_PASS 외 동작을 건드리는 정도가 리스크. 정답은 "기존 `Count`의 `allow_distinct` 선언을 그대로 따라가기".
