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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-10880

## 문제 요약
`Count` 어노테이션에 `Case` 조건과 `distinct=True`를 함께 넘기면 Django 2.2(모든 DB 백엔드)에서 쿼리 문법 에러가 난다. 생성된 SQL이 `COUNT(DISTINCTCASE WHEN ...)`처럼 `DISTINCT` 키워드와 뒤따르는 표현식 사이에 공백이 빠진 형태가 되어 DB가 거부한다. 사용자는 `COUNT(DISTINCT CASE WHEN ...)`로 정상 동작하길 기대했다. hints_text가 회귀 도입 커밋(`#28658 -- Added DISTINCT handling to the Aggregate class`)까지 bisect로 짚어준다.

## 유형 (정형화)

- **L (Localization) = L0 — Pinpointed.** problem_statement가 증상 SQL(`COUNT(DISTINCTCASE WHEN ...)`)과 트리거 조합(`Count` + `distinct=True` + `Case`)을 그대로 적어주고, hints_text가 bisect로 회귀 커밋 `#28658 Added DISTINCT handling to the Aggregate class`를 명시한다. `grep 'DISTINCT'` 한 방이면 `aggregates.py`의 `Aggregate.as_sql`로 직결된다. 후보 탐색이 사실상 없다.
- **S (Repair Strategy) = S1 — Direct-Map (template).** 결함 클래스가 "토큰 결합 시 구분자(공백) 누락"이라는 정형 문자열-조립 버그다. 증상 문자열 `DISTINCTCASE`를 보면 픽스가 기계적으로 도출된다 — `'DISTINCT'` 리터럴에 트레일링 공백 한 칸을 더해 `'DISTINCT '`로 만든다. 식 합성(S2)이나 후보 반복(S3)이 아니라, 결함클래스→템플릿 픽스의 1:1 매핑이다. APR 관점에서 PAR/TBar식 패턴(missing-separator) 매칭에 정확히 해당한다.
- **K (Knowledge) = K-Domain.** 한 글자 수정이지만, "단순 컬럼 distinct는 멀쩡한데 왜 `Case` 표현식만 깨지는가"를 이해하려면 Django aggregate SQL 컴파일 경로(`as_sql` → `extra_context['distinct']`가 템플릿에서 expression SQL 바로 앞에 박힘)를 알아야 한다. 일반 파이썬 추론(K-Gen)만으로는 ORM 내부 템플릿 조립 구조를 못 본다.
- **Primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적 상수 수정(S1: 리터럴 변경)이라 정의상 T-DirectMap. T-LocTrivial은 K-Gen + 픽스 자명을 전제로 하는데, 여기는 K-Domain 이해가 받쳐줘야 픽스의 정당성이 보이므로 T-DirectMap이 더 정확하다.

## 난이도 티어

**Tier = T2 (쉬움).** 공식 라벨 `<15 min fix`(T1~T2 prior)와 정합한다.

이 티어로 미는 구조적 피처:
- **patch scope 극소:** 1파일·1헌크·1줄, 사실상 1글자(`'DISTINCT'` → `'DISTINCT '`). 1파일·<5줄 구간(≈48% solve)에 든다.
- **localize 직접성 최상(L0):** repro 조합 + bisect 커밋이 본문에 박혀 있어 탐색 비용 0에 수렴. `has-repro` 신호(easiness 최강).
- **K-Domain이 약하게 가산:** 픽스 자체는 자명하나 "왜 Case만 깨지나"의 인과가 ORM 컴파일 구조라 순수 T1(K-Gen)은 아니다. 이 한 칸이 T1→T2로 민다.
- **regression-trap 존재:** PASS_TO_PASS 55개가 전부 같은 `AggregateTestCase`라 `sum_distinct`/`count` 등 인접 distinct 경로를 안 깨야 한다. 다만 트레일링 공백 추가는 단순 컬럼 케이스에서 SQL상 무해(`COUNT(DISTINCT col)`)하므로 실제 trap 강도는 약하다 — 그래서 T3로는 안 민다.

공식 라벨과 일치하므로 재조정 없음.

## 골드패치 분석

- **건드린 파일·함수:** `django/db/models/aggregates.py` — `Aggregate.as_sql`.
- **근본 원인:** `as_sql`에서 `extra_context['distinct'] = 'DISTINCT' if self.distinct else ''`로 세팅한 값이 SQL 템플릿에서 표현식 SQL 바로 앞에 연결된다. 피연산자가 단순 컬럼명일 때는 우연히 깨지지 않았으나, `Case(When(...))` 같은 표현식이 곧바로 이어지면 `DISTINCT`와 `CASE` 사이에 구분자가 없어 `DISTINCTCASE`로 붙어 DB 문법 에러가 난다. 회귀는 `#28658`에서 DISTINCT 처리를 `Aggregate`로 끌어올리며 도입됐다.
- **수정 요지:** 리터럴 `'DISTINCT'`를 `'DISTINCT '`(끝에 공백 1칸)로 변경. distinct 키워드 뒤에 항상 구분자가 보장되어 `COUNT(DISTINCT CASE WHEN ...)`가 올바르게 조립된다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1):** `test_count_distinct_expression (aggregation.tests.AggregateTestCase)` — `Book.objects.aggregate(distinct_ratings=Count(Case(When(pages__gt=300, then='rating')), distinct=True))`가 예외 없이 실행되고 `aggs['distinct_ratings'] == 4`여야 한다. test_patch는 `from django.db.models.expressions import Case, When` import 추가도 포함한다.
- **픽스 증명:** 테스트 입력이 정확히 버그 트리거(`Count` + `Case/When` 표현식 + `distinct=True`)를 재현한다. 픽스 전에는 `COUNT(DISTINCTCASE ...)` SQL이 DB에서 거부되어 실행 자체가 실패하고, 픽스 후에는 공백이 들어가 정상 쿼리가 돌아 기대값 4가 나온다. 즉 "예외 발생 → 정상 실행 + 정확한 집계값"으로 동작 차이를 직접 관찰한다.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇지만, 픽스가 special-case 분기가 아니라 모든 distinct 경로에 적용되는 구분자 보장이라 overfit 위험이 낮다. 테스트 너머 입력(다른 표현식 종류)에도 동일하게 일반화된다.
- **regression 관점:** PASS_TO_PASS 55개 중 `test_sum_distinct_aggregate`, `test_count`, `test_count_star` 등 기존 distinct/count 경로가 트레일링 공백 추가로도 그대로 통과해야 한다. 단순 컬럼에서 `COUNT(DISTINCT col)`은 공백이 하나 더 들어가도 SQL 의미 불변이라 안전.

## 모범답안 (오라클 기반)

1. **localize 경로:** problem_statement의 증상 문자열 `COUNT(DISTINCTCASE WHEN ...)`이 결정적 단서 — `DISTINCT`와 `CASE`가 붙었다는 건 SQL 문자열 조립부에서 구분자가 빠졌다는 뜻. hints_text의 bisect 커밋 `#28658 Added DISTINCT handling to the Aggregate class`가 `django/db/models/aggregates.py`의 `Aggregate`로 직행시킨다. `grep -n DISTINCT django/db/models/aggregates.py` → `as_sql` 안의 `extra_context['distinct'] = 'DISTINCT' ...` 한 줄로 수렴.
2. **픽스와 일반화 정당성:** `'DISTINCT'`를 `'DISTINCT '`로 바꾼다. 이는 distinct 키워드 자체에 트레일링 구분자를 보장하는 것이라, 뒤따르는 SQL이 단순 컬럼이든 `CASE` 표현식이든 임의 expression이든 항상 올바르게 분리된다. Case 표현식만 특별 처리하는 분기를 추가하는 식의 좁은 픽스가 아니라 토큰 결합 규칙 자체를 바로잡으므로 overfit이 아닌 올바른 일반화다.
3. **regression 안전:** PASS_TO_PASS의 `test_sum_distinct_aggregate`, `test_count`, `test_count_star`, `test_single_aggregate` 등 기존 distinct/count 경로가 안 깨져야 한다. 단순 컬럼 케이스는 픽스 후 `COUNT(DISTINCT col)`로 공백이 1칸 더 들어가지만 SQL 토큰화상 무해(`DISTINCT col` == `DISTINCT  col` 의미상 동일)하므로 모두 통과한다. distinct=False 경로는 빈 문자열이라 영향 없다.
4. **함정 회피:** 오라클 없는 에이전트가 빠지기 쉬운 곳 — (a) "단순 컬럼은 되는데 Case만 깨진다"를 보고 `Case`/`When` 표현식 컴파일러나 SQL 템플릿 쪽을 의심해 헛파기. → 회피: 증상이 `DISTINCTCASE`라는 **문자열 붙음**이므로 string-level 구분자 누락으로 보고 distinct 토큰 생성 지점만 보면 된다. (b) Case 전용 분기를 추가하는 과도한 픽스로 다른 표현식에서 같은 버그를 남김. → 회피: 키워드 뒤 구분자를 일괄 보장. (c) 재현 SQL을 안 캡처하고 추측. → 회피: `CaptureQueriesContext`로 생성 SQL을 한 번 찍어 `DISTINCTCASE` 문자열을 눈으로 확인하면 즉시 수렴한다.
