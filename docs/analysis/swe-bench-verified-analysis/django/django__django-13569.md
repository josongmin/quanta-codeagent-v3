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
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13569

## 문제 요약
`annotate(Count(...))`에 `order_by('?')`(랜덤 정렬)를 같이 쓰면 집계가 깨진다. 정상이라면 `GROUP BY "thing"."id"`로 묶여 한 행에 `rc=2`가 나와야 하는데, SQL 컴파일러가 `order_by` 표현식의 source 컬럼을 GROUP BY에 합치면서 `GROUP BY "thing"."id", RANDOM()`가 되어 그룹이 풀리고 행이 쪼개진다(`rc=1`이 두 개). 사용자는 랜덤 함수가 집계와 무관하니 그룹핑을 깨뜨리면 안 된다고 기대했고, problem_statement에 재현코드·덤프된 SQL·`get_group_by` 진입점·후보 패치까지 모두 제시했다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** problem_statement가 `django.db.models.sql.compiler.get_group_by`를 직접 지목하고 문제의 루프(non-aggregate·non-ref order_by 표현식을 group_by로 합치는 부분)까지 보여준다. 다만 골드 픽스가 실제로 착지하는 곳은 그 컴파일러가 아니라 `django/db/models/functions/math.py`의 `Random` 클래스이므로, 지목된 진입점에서 한 단계 더(표현식 다형성 훅)로 수렴하는 약한 탐색이 필요하다 → grep 한 방(L0)은 아니다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning) +S6 (Design-Refactor).** 고칠 "지점"은 알지만 올바른 식을 추론으로 합성해야 한다: "`Random`은 어떤 실제 컬럼도 GROUP BY에 기여하지 않는 표현식"이라는 불변식을 세우고, 그것을 컴파일러 if-분기가 아니라 표현식이 스스로 선언하게 만든다. 골드는 사용자 제안(`isinstance(exp, Random)` 컴파일러 패치)을 거부하고 `get_group_by_cols`를 오버라이드하는 작은 구조적 선택(S6)을 택했다 — 결함 위치를 컴파일러에서 표현식 클래스로 옮긴 것.
- **K (Knowledge) = K-Domain.** `get_group_by_cols(self, alias=None)`라는 Django 표현식 프로토콜 훅의 존재·계약을 알아야 한다. ORM query-compiler가 GROUP BY 컬럼을 표현식별 메서드로 위임한다는 내부 지식이 병목이지, 일반 파이썬 추론으로는 깔끔한 해법에 도달하지 못한다.
- **Primary type = T-DomainBound.** 위치는 비교적 명확(L1)하고 픽스는 3줄로 작지만, 정답과 오답을 가르는 핵심은 "Random만 group-by에서 빼되 다른 DB·다른 표현식을 깨지 않는 도메인적으로 옳은 지점"을 아는 것이다. 즉 병목이 localize도 overfit-탐색도 아닌 프레임워크 내부지식이라 T-ConstraintReason보다 T-DomainBound가 dominant.

## 난이도 티어
**T4 (약간 어려움).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior)다. 그러나 구조적 피처가 한 단계 위로 민다:
- **K-Domain 병목**: 픽스는 1파일·3줄이라 patch-scope로는 쉬워 보이지만, `get_group_by_cols` 오버라이드라는 도메인 훅을 모르면 사용자 제안 경로(컴파일러 일반화)로 끌려가 다른 DB에서 회귀를 낸다. 루브릭상 K-Domain이 dominant이면 최소 T4.
- **regression-trap 강함**: PASS_TO_PASS 66개가 전부 aggregation 동작이다. "no-cols 표현식 전부 스킵" 같은 일반화는 hints에서 명시적으로 MySQL/PostgreSQL에서 깨졌다 — 넓은 P2P trap이 T4 신호.
- **localize 직접성·has-repro는 난이도를 낮추는 방향**: 재현코드+덤프 SQL+진입점 지목이 있어 T5까지는 안 간다. 단일 파일·소규모 헌크라 멀티사이트 조율(T5)도 아니다.
- 공식 라벨(개발자 구현시간)과 다른 이유: 시간라벨은 "정답을 아는 개발자가 타이핑하는 시간"을 재므로 3줄이면 짧다. 그러나 에이전트 난이도는 *그럴듯한 오답*(컴파일러 패치)을 배제하고 옳은 훅을 찾는 데 있고, 이 부분이 시간라벨에 안 잡힌다. 그래서 T2~T3 prior를 K-Domain+regression-trap으로 T4로 재조정.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/functions/math.py` → `Random` 클래스에 `get_group_by_cols(self, alias=None)` 추가.
- **근본 원인**: `SQLCompiler.get_group_by`는 non-aggregate·non-ref order_by 표현식의 source 컬럼들(`expr.get_group_by_cols()` 기본 구현)을 GROUP BY에 추가한다. `Random`은 인자 없는 순수 SQL 함수(`RANDOM()`)지만 `Func`의 기본 `get_group_by_cols`가 자기 자신을 group-by 컬럼으로 돌려주기 때문에, `RANDOM()`이 GROUP BY 절에 끌려 들어가 모든 행이 매번 다른 랜덤 값으로 그룹핑되어 사실상 그룹이 전부 풀린다.
- **수정 요지**: `Random.get_group_by_cols`를 오버라이드해 `[]`를 반환. "이 표현식은 어떤 컬럼도 GROUP BY에 기여하지 않는다"고 표현식 스스로 선언하게 만든다. 컴파일러 루프(`get_group_by`)는 손대지 않으므로, 다른 표현식·다른 DB 백엔드의 group-by 동작은 그대로 유지되고 Random만 국소적으로 제외된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_aggregation_random_ordering` — docstring "Random() is not included in the GROUP BY when used for ordering."
- **동작/픽스 증명**: `Author.objects.annotate(contact_count=Count('book')).order_by('?')`를 만들고 `(a.name, a.contact_count)`로 9명 저자의 기대 매핑을 `ordered=False`로 비교한다(Peter Norvig=2, 나머지=1). 픽스 전에는 `GROUP BY ..., RANDOM()`로 그룹이 풀려 Peter Norvig 행이 둘로 쪼개지고 count가 1로 틀린다. 픽스 후 저자별 1행으로 정상 그룹핑되어 매핑이 일치한다. `ordered=False`로 랜덤 정렬 순서 자체는 단언에서 배제 → 테스트가 비결정적 순서에 flaky하지 않게 설계됨.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 얇아 보이지만, 골드 픽스는 special-case(특정 쿼리 모양)에 맞춘 게 아니라 "Random 표현식의 group-by 기여 = 빈 집합"이라는 일반 불변식을 표현식 레벨에 박았으므로 미검증 쿼리 형태에도 일반화된다 → overfit-risk 낮음. flag에 overfit-risk 미표기.
- **regression 관점**: 66개 PASS_TO_PASS가 광범위한 aggregation/annotate/subquery group-by 동작을 커버한다(regression-trap flag). 골드가 컴파일러를 건드리지 않고 Random 한 클래스에만 메서드를 더했기 때문에 이 66개를 깨지 않는다. 반대로 사용자가 제안한 `compiler.get_group_by` 직접 패치는 MySQL/PostgreSQL에서 회귀를 냈음(hints).

## 모범답안 (오라클 기반)
1. **Localize 경로**: 이슈가 친절하게 `django.db.models.sql.compiler.get_group_by`와 "order_by 표현식의 source 컬럼을 group_by에 합치는 루프"를 짚어준다. 덤프된 `GROUP BY ..., RANDOM()`에서 `RANDOM()`이 곧 `Random` 함수 클래스임을 잡고, `get_group_by` 루프가 호출하는 `expr.get_group_by_cols()`로 한 단계 내려가 "어떤 표현식이 자신을 group-by 컬럼으로 내놓는가"로 질문을 좁힌다 → 표현식 레벨이 진짜 수술 부위.
2. **픽스와 일반화 정당성**: `Random.get_group_by_cols`가 `[]`를 반환. Random은 실제 테이블 컬럼을 참조하지 않는 순수 비결정 함수이므로 "group-by에 기여할 컬럼 없음"은 쿼리 모양과 무관한 보편 진실이다. 컴파일러의 일반 규칙은 건드리지 않고 표현식 다형성으로 예외를 선언하므로, special-case가 아니라 올바른 일반화다.
3. **Regression 안전**: 깨면 안 되는 것은 66개 PASS_TO_PASS의 정상 group-by 합성(`test_grouped_annotation_in_group_by`, `test_aggregate_in_order_by`, subquery annotation group-by 등). 컴파일러 루프를 그대로 두고 Random에만 빈 리스트를 부여하므로 다른 표현식·다른 백엔드의 group-by 행동은 불변 → 이 66개가 안전하게 통과.
4. **함정 회피**: 오라클 없는 에이전트가 틀리기 쉬운 두 지점 — (1) problem_statement에 박힌 그럴듯한 컴파일러 패치(`isinstance(exp, Random)` 또는 "no-cols 표현식 전부 스킵")에 끌려가 `compiler.py`를 일반화하다 MySQL/PostgreSQL에서 회귀(hints가 실제로 실패했다고 경고). (2) `get_group_by_cols` 표현식 훅의 존재를 몰라 컴파일러에서만 해결하려 함. 회피법: PASS_TO_PASS가 광범위한 group-by 회귀 가드임을 인식하고, 컴파일러 일반 규칙을 건드리는 대신 결함을 가진 표현식 클래스(Random)에 국소적으로 빈 group-by를 선언하는 1파일·3줄 최소 변경을 택한다.
