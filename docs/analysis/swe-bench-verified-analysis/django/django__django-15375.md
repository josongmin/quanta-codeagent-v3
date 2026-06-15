---
instance_id: django__django-15375
repo: django/django
base_commit: beb7ddbcee03270e833b2f74927ccfc8027aa693
version: "4.1"
difficulty: 15 min - 1 hour
created_at: 2022-01-28T14:48:03Z
fail_to_pass: 1
pass_to_pass: 95
gold_files: [django/db/models/aggregates.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15375

## 문제 요약
`annotate()` 뒤에 `aggregate()`를 호출하면서 집계 함수에 `default` 인자(4.0 신규)를 주면 크래시가 난다. 예: `Book.objects.annotate(idx=F("id")).aggregate(Sum("id", default=0))`가 `OperationalError: near "FROM": syntax error`를 낸다. 생성된 SQL이 `SELECT FROM (SELECT ... ) subquery`처럼 바깥 SELECT의 컬럼 목록이 통째로 비어 버린 형태다. `default` 없는 동일 쿼리나, 수동 `Coalesce(Sum("id"), 0)`는 정상 동작한다. 즉 `default`가 내부적으로 만드는 Coalesce 래핑 경로에서만 깨지며, 이슈 제보자 노트대로 집계가 annotated 필드를 실제로 쓰든 안 쓰든 발생한다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)** — 근거: 이슈가 파일/심볼을 직접 못 박지는 않지만, problem_statement의 SQL 덤프(`SELECT FROM (...)`)와 힌트의 "Aggregate.default generates a Coalesce internally so it seems a little lower level"라는 한 문장이 `db/models/aggregates.py`의 `Aggregate.resolve_expression`으로 좁은 단일파일 후보로 곧장 수렴시킨다. grep `default`+`Coalesce` 한두 방. 단, `%debug`가 sqlite3/base.py를 가리키는 미끼가 있어 L0(pinpointed)는 아니다.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)** — 근거: 고칠 함수는 비교적 빨리 찾지만, 픽스 자체는 "왜 outer SELECT 컬럼이 비는가"의 불변식 추론을 요구한다. 잘못된 SQL이 증상이고 진짜 결함은 비가시적 상태(`is_summary` 메타플래그)가 래핑 표현식으로 전파되지 않는 것이라, 체크 추가/상수 변경 같은 기계적 템플릿(S1)이 아니다. "Coalesce가 summary로 표시되지 않으면 outer query 컬럼 수집에서 누락된다"는 ORM 내부 불변식을 머리로 따져야 올바른 한 줄이 나온다. APR 관점에서 SemFix/Angelix식 의미 합성에 해당 — 후보를 마구 시도해 테스트로 거르는 G&V가 아니라, 보존되어야 할 invariant(`c.is_summary`)를 추론으로 특정하는 작업.
- **K (Knowledge) = K-Domain** — 근거: `is_summary` 플래그가 `Query.rewrite_cols`/annotation-promotion에서 outer SELECT 컬럼 선택에 어떻게 쓰이는지는 django ORM aggregation 내부 지식이다. 일반 파이썬 추론(K-Gen)으로는 "왜 한 줄이 SQL 형태를 바꾸는지" 정당화 불가.
- **Primary type = T-ConstraintReason** — 위치는 L1로 명확하나 난점이 S2(보존해야 할 불변식의 추론 합성)에 있으므로 T-ConstraintReason. T-DirectMap이 아닌 이유: 픽스가 None가드/기본값 추가 같은 결함클래스 템플릿이 아니라 메타상태 전파라는 의미 추론이기 때문. T-DomainBound로 흡수되지 않는 이유: 도메인지식이 필요하긴 해도 병목은 "어디인지"가 아니라 "올바른 식을 추론하는 것"이라 strategy 축이 dominant.

## 난이도 티어
**T4 (약간 어려움).** 이 티어로 미는 구조적 피처:
- 수정 범위는 1파일·1함수·실질 3줄(추가 2줄)로 매우 작아 그 자체로는 T2 신호.
- 그러나 **S2 constraint 추론 + K-Domain**이 결합: 픽스가 한 줄이어도 그 한 줄의 정당성을 세우려면 `is_summary`가 outer-SELECT 컬럼 수집을 좌우한다는 ORM 내부 모델을 알아야 한다. 루브릭 T4 정의("constraint추론·소규모 refactor·도메인지식 중 하나")에 정확히 해당.
- **regression-trap (P2P=95)**: aggregation.tests 전체가 P2P로 묶여 있어 `is_summary` 처리를 잘못 일반화하면(예: 힌트의 `= True` 하드코딩) `default`만 쓰고 annotate 없는 케이스나 nested 집계에서 인접 동작을 깰 수 있다. 넓은 P2P trap이 T4를 굳힌다.
- has-repro(네이티브 스택+재현 쿼리+SQL 덤프)는 easiness 신호라 T5로 올라가는 것을 막는다 → T5 미만.

공식 difficulty 라벨은 "15 min - 1 hour"(prior로 T3~T4 경계). 본 분석은 **T4로 한 칸 높게** 본다: 시간라벨은 골드를 아는 개발자의 구현시간이라 한 줄로 짧지만, 오라클 없는 에이전트 입장에서는 (a) base.py 미끼를 흘려보내는 localize 절제, (b) `is_summary` 의미를 ORM 내부에서 재구성하는 추론, (c) `True` 하드코딩 대신 `c.is_summary` 복사라는 올바른 일반화 판단이 모두 비자명하다 — 이 세 축은 시간라벨에 안 잡힌다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/aggregates.py` → `Aggregate.resolve_expression`
- **근본 원인**: `default`가 설정되면 `resolve_expression`이 resolve된 집계 `c`를 `Coalesce(c, default, output_field=c._output_field_or_none)`로 다시 감싸 새 표현식을 반환한다. 그런데 새로 만든 `Coalesce` 인스턴스에는 원래 집계 `c`의 `is_summary` 플래그가 전파되지 않는다(생성자 디폴트 False). `is_summary`는 "전체 행 요약 집계"임을 표시하는 플래그로, annotate가 선행해 쿼리가 서브쿼리로 감싸질 때 outer SELECT의 컬럼 목록은 summary 표현식만 끌어온다. Coalesce가 summary로 표시되지 않으니 outer SELECT 컬럼 수집에서 누락되어 `SELECT FROM (...) subquery`라는 빈 컬럼 SQL이 생성된다.
- **수정 요지**: 한 줄 `return Coalesce(...)`를 세 줄로 풀어, `coalesce = Coalesce(...)` 변수로 추출한 뒤 `coalesce.is_summary = c.is_summary`로 원본 집계의 summary 여부를 래핑된 표현식에 그대로 복사하고 그 인스턴스를 반환한다. 힌트 패치는 `is_summary = True` 하드코딩이었으나, 골드는 `c.is_summary` 복사로 일반화해 non-summary(annotate 내부에서 쓰이는 등) 경로의 False도 보존한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_aggregation_default_after_annotation` — `Publisher.objects.annotate(double_num_awards=F('num_awards')*2).aggregate(value=Sum('double_num_awards', default=0))`가 크래시 없이 `40`을 반환하는지 확인. 픽스 전엔 outer SELECT 컬럼 누락 → OperationalError로 `aggregate()` 자체가 실패. 픽스 후 Coalesce가 summary로 표시되어 outer SELECT에 정상 포함 → 올바른 SQL + 기대값.
- **픽스 증명**: 신규 테스트가 "annotate 선행 + 집계에 default" 라는 정확한 트리거 조합을 친다. summary 누락이 고쳐졌음을 SQL 실행 성공(=값 반환)으로 관찰한다.
- **overfit 관점**: FAIL_TO_PASS는 1개지만 P2P로 들어간 `test_aggregation_default_not_in_aggregate`(annotate에만 default, 집계엔 없음 → `20`)가 짝을 이뤄, "집계가 annotated 필드를 쓰든 안 쓰든 깨진다"는 두 번째 시나리오를 커버한다. 즉 `is_summary = True` 같은 special-case 픽스가 통과하지 못하도록 구별용 입력이 마련돼 있어 overfit-risk 플래그를 달지 않았다. CEGIS(S4)가 필요할 만큼 과소명세는 아니다.
- **regression 관점**: P2P=95에 `test_aggregation_default_*` 계열(zero/integer/expression/compound/group_by/passed_another_aggregate/using_*_from_*)이 대거 포함. `c.is_summary` 복사가 아닌 무조건 True 하드코딩이었다면 이들 중 non-summary 경로나 group_by 케이스에서 회귀 위험이 있었다 — 골드의 일반화가 regression-trap을 정확히 빗겨간다.

## 모범답안 (오라클 기반)
이상적 풀이 궤적 4단계:

1. **Localize 경로**: 증상은 "잘못된 SQL"이지만 SQL **생성**(compiler/backend)을 파는 대신 expression **resolution**을 의심한다. 결정 신호 두 개 — (a) `default`가 있을 때만 깨지고 수동 `Coalesce(Sum(...), 0)`는 멀쩡함 → 차이는 `default` → Coalesce 자동 래핑 경로뿐, (b) 힌트의 "generates a Coalesce internally ... lower level". 두 신호가 `Aggregate.resolve_expression`의 Coalesce 래핑 분기로 수렴. `%debug`가 sqlite3/base.py를 가리키는 건 미끼이므로 흘려보낸다.

2. **픽스와 올바른 일반화인 이유**: 잘못된 SQL이 outer SELECT 컬럼 누락이라는 점에서, "annotate 후 집계는 서브쿼리로 감싸지고 outer는 summary 표현식만 수집한다"는 ORM 동작을 떠올려 래핑된 Coalesce가 `is_summary`를 잃었음을 특정한다. 픽스는 `coalesce.is_summary = c.is_summary`. **`True` 하드코딩이 아니라 원본 복사**가 올바른 일반화인 이유: resolve_expression은 summary 컨텍스트(`aggregate()`)뿐 아니라 non-summary 컨텍스트(annotate 내부 집계 등)에서도 호출되므로, 원본 `c`의 상태를 보존해야 양쪽 모두 정확하다. 트리거 테스트만 통과시키는 special-case가 아니라 메타상태 전파 일반 규칙을 복원하는 것.

3. **Regression 안전**: P2P 95개 중 `test_aggregation_default_zero/integer/expression/compound_expression/group_by/passed_another_aggregate/unset/unsupported_by_count/using_*` 군을 안 깨야 한다. 이들은 default가 다양한 타입·컨텍스트에서 동작하는 경로다. `c.is_summary`를 그대로 복사하면 기존 summary 경로는 True 유지, non-summary는 False 유지로 모두 보존된다. group_by 케이스(`test_aggregation_default_group_by`)가 특히 hard-True 하드코딩에 취약했을 지점.

4. **함정 회피**: 오라클 없는 에이전트의 오답 지점 — (a) SQL 텍스트 `SELECT FROM`에 낚여 compiler/sqlite3 backend를 수정하려 함(증상 위치 ≠ 원인 위치); (b) annotate 없는 `default` 단독 케이스로만 재현 시도 → summary 추출 경로를 안 타서 버그가 안 보임(반드시 annotate 선행 조합으로 재현); (c) 힌트의 `is_summary = True`를 그대로 베껴 non-summary 경로 회귀를 유발. 회피법: 차이 분석(default vs 수동 Coalesce)으로 래핑 경로를 좁히고, `is_summary`의 소비처(outer SELECT 컬럼 수집)를 확인해 원본 보존이 필요함을 도출한 뒤 `c.is_summary` 복사로 픽스한다.
