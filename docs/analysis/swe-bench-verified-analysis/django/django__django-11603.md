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
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11603

## 문제 요약
`Avg`와 `Sum` 집계에 `distinct=True`를 넘기면 Django 2.2부터 예외가 발생한다. #28658에서 `Count`에 DISTINCT를 허용한 것의 연장선으로, 일반 집계(`Avg`, `Sum`)에서도 DISTINCT를 지원해야 한다는 요청이다. 2.2 이전에는 파라미터를 조용히 무시했지만 지금은 throw 하므로, 이슈 본문이 직접 처방하듯 "해당 클래스를 DISTINCT 허용으로 표시"만 하면 된다. Min/Max도 가능하지만 무의미하다고 본문이 명시.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: 이슈가 `Avg`/`Sum` aggregate 클래스를 직접 지목하고, 참조 이슈 #28658(Count distinct)이 정확히 같은 파일(`django/db/models/aggregates.py`)을 가리킨다. `allow_distinct` grep 한 방이면 `Count`의 기존 선언이 드러나 위치 확정. 탐색 노력 사실상 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)**: 이슈가 픽스를 거의 명세("setting these classes as allowing DISTINCT"). 결함 클래스가 "기능 플래그 미설정"이라 기계적 처방 — 베이스가 제공하는 `allow_distinct` 게이트에 클래스 속성 `allow_distinct = True`를 선언으로 미러링. 식·조건을 추론 합성할 필요가 없으므로 S2가 아님. 후보 패치를 테스트로 수렴시킬 일도 없어 S3/S4도 아님.
- **K (Knowledge) = K-Domain**: 일반 파이썬 추론만으론 안 된다. `Aggregate` 베이스에 `allow_distinct` 게이트가 존재하고 `Count`만 켜져 있다는 Django ORM aggregate 클래스 계층 지식이 픽스 형태를 결정한다. 다만 깊은 call-chain은 아니라 K-Domain 중에서도 얕은 쪽.
- **primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 S1 기계적 플래그 토글. T-LocTrivial(K-Gen 전제)이 아니라 도메인 속성 지식이 약하게 필요해 T-DirectMap이 정확.
- **왜 이 repair strategy인가 (APR 관점)**: PAR/TBar류 템플릿 수리에서 "missing-feature-flag enablement"는 가장 단순한 fix template이다. 올바른 패치 형태가 인접 sibling(`Count.allow_distinct = True`)에 이미 example로 존재하므로 transplant/mirror가 정답 경로 — semantic synthesis(S2)나 generate-and-validate 반복(S3) 불필요.

## 난이도 티어
**T1 (존나쉬움)** — 공식 라벨 `<15 min fix`와 일치.
- 미는 피처: 단일 파일(`aggregates.py`) / +2줄(클래스 속성 2개) / localize 직접성 최상(L0, sibling example 존재) / 이슈가 사실상 처방 제공 / repro 명확(`aggregate('rating', distinct=True)` 한 줄로 예외 재현 — `has-repro`).
- 구조적 컷: 1파일·<5줄 변경은 ICLR 2024 기준 solve-rate 상위 구간(≈48%+). L0+S1+소규모는 T1 전형.
- 공식 라벨과 동일하지만 한 가지 단서: `regression-trap`(P2P 58개, aggregation 스위트 전체)이 있어 베이스 `Aggregate.__init__`를 잘못 건드리면 인접 동작이 광범위하게 깨진다. 다만 정답 경로(클래스 속성 추가)는 베이스 로직을 전혀 안 건드리므로 trap이 실현되지 않아 T1을 유지. trap이 tier를 끌어올리지 않는 이유는, 올바른 픽스가 trap을 자연히 우회하기 때문.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/aggregates.py` — `class Avg(FixDurationInputMixin, NumericOutputFieldMixin, Aggregate)`와 `class Sum(FixDurationInputMixin, Aggregate)` 두 클래스 본문(클래스 속성).
- **근본 원인**: 베이스 `Aggregate`는 `allow_distinct = False`가 기본이고, `Aggregate.__init__`가 `distinct=True`인데 `allow_distinct`가 False면 `TypeError("... does not allow distinct.")`를 던진다. #28658에서 `Count`만 `allow_distinct = True`로 켜졌고 `Avg`/`Sum`은 꺼진 채라 DISTINCT 인자를 거부.
- **수정 요지**: `Avg`에 `allow_distinct = True` 한 줄(위치: `function = 'AVG'` / `name = 'Avg'` 아래), `Sum`에 `allow_distinct = True` 한 줄(`function = 'SUM'` / `name = 'Sum'` 아래) 추가. 로직 변경 없이 베이스의 distinct 게이트를 통과시키는 순수 선언적 수정. SQL 컴파일은 베이스가 이미 `DISTINCT ` 접두어를 처리하므로 추가 작업 불요.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개, JSON 배열 길이 일치)**:
  - `test_distinct_on_aggregate` — `(Avg, 4.125), (Count, 4), (Sum, 16.5)` 세 집계에 대해 `Book.objects.aggregate(ratings=aggregate('rating', distinct=True))`를 `subTest`로 순회하며 기대값 검증. 패치 전엔 `Avg(..., distinct=True)`/`Sum(..., distinct=True)` 생성 시점에 예외 → 실패. 패치 후엔 중복 제거된 rating(distinct 4건)에 대해 평균/합/카운트가 계산돼 기대값 일치.
  - `test_empty_aggregate` — 전체 집계 기본 동작 회귀 가드.
- **픽스 증명 방식**: 새 테스트가 `Avg`/`Sum`을 `Count`와 동일 루프에서 검증하므로, 두 클래스 모두 켜져야만 통과. `allow_distinct = True` 미러링이 정확히 이 동작을 만든다. 동시에 test_patch는 `test_count`에서 `Count("rating", distinct=True)` 케이스를 제거(통합 테스트로 이관)해 중복 제거.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇지만, `test_distinct_on_aggregate`가 세 집계 타입을 묶어 검증하고 distinct 의미(중복 제거 결과값)까지 단언하므로 special-case 토글로는 통과 불가 — overfit 위험 낮음. `overfit-risk` 미부여.
- **regression 관점**: P2P 58개(aggregation 스위트 전반: `test_count`, `test_sum_distinct_aggregate`, `test_count_distinct_expression` 등 distinct 인접 동작 포함)를 안 깨야 함 — `regression-trap` 부여. 정답 픽스는 클래스 속성만 추가하고 베이스 `__init__`/SQL 생성을 안 건드려 P2P 전부 보존.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "Avg and Sum aggregates" + "setting these classes as allowing DISTINCT" + 참조 #28658(Count distinct) 신호 → `django/db/models/aggregates.py`로 직결. `grep allow_distinct`로 `Count.allow_distinct = True`를 찾으면 정확한 패턴·위치가 즉시 노출.
2. **픽스와 올바른 일반화 이유**: `Avg`·`Sum` 클래스에 `allow_distinct = True` 선언 추가. 이게 overfit이 아닌 이유 — 베이스 `Aggregate`가 이미 `allow_distinct` 게이트와 DISTINCT SQL 생성을 일반 메커니즘으로 갖고 있고, `Count`라는 검증된 sibling이 정확히 같은 형태로 동작 중. 따라서 플래그만 켜는 것이 프레임워크 설계 의도에 맞는 일반화이지 테스트 특정 hack이 아니다.
3. **regression 안전**: 베이스 `Aggregate.__init__`의 distinct 검사 로직과 SQL 컴파일을 절대 안 건드린다. 그래야 `Count` distinct(`test_count_distinct_expression`, `test_sum_distinct_aggregate`)와 비-distinct 집계 58개 P2P가 전부 보존. 변경을 클래스 속성 2개로 격리하는 것이 regression 면역의 핵심.
4. **함정 회피**: (a) 베이스 `Aggregate.__init__`의 게이트 로직을 "더 우아하게" 고치려는 과잉수정 — P2P 광범위 파괴 위험. (b) 이슈가 "could also be applied to Min and Max"라 했지만 "(although pointless)"라며 골드는 적용 안 함 — Min/Max에 손대면 FAIL_TO_PASS엔 무해해도 불필요한 scope 확장이라 오라클과 불일치. (c) `distinct`를 클래스 속성이 아닌 `__init__` 시그니처로 받으려는 시도 — 베이스가 이미 처리하므로 중복/회귀. 정답은 "`Count`의 `allow_distinct` 선언을 그대로 미러링, 그 이상도 이하도 아님".
