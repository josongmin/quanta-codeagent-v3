---
instance_id: django__django-13028
repo: django/django
base_commit: 78ad4b4b0201003792bfdbf1a7781cbc9ee03539
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-06-05T19:49:04Z
fail_to_pass: 2
pass_to_pass: 276
gold_files: [django/db/models/sql/query.py]
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-13028

## 문제 요약
`filterable`라는 이름의 `BooleanField`를 가진 모델 인스턴스를 다른 쿼리의 필터 값(RHS)으로 넘기면 `NotSupportedError: <Model> is disallowed in the filter clause.`가 발생한다. 예: `ProductMetaData.objects.filter(value="...", metadata_type=self.brand_metadata)`에서 `metadata_type`이 `filterable=False` 필드를 가진 `ProductMetaDataType` 인스턴스를 가리키면 터진다. 사용자는 평범한 FK 필터를 기대했지만, 모델의 `filterable` 컬럼명이 우연히 Django ORM 내부의 expression 제약 플래그(`filterable`)와 충돌해, 정상 필터가 크래시한다. problem_statement에 풀 네이티브 traceback이 그대로 들어 있고, hints_text에는 거의 정답에 가까운 diff까지 동봉돼 있다. 회귀 출처는 커밋 `4edad1ddf6203326e0be4bdb105beecb0fe454c4`로 명시.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — 근거: problem_statement의 traceback이 `django/db/models/sql/query.py:1131 check_filterable` → `build_filter`를 줄 단위로 직접 지목한다. `"disallowed in the filter clause"` 문자열을 grep하면 단 한 함수 `Query.check_filterable`로 즉시 수렴한다. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1 Direct-Map)** — 근거: 고칠 위치는 자명(L0)하지만, 픽스의 본질은 "표현식 vs 모델 인스턴스"를 구분하는 **올바른 술어를 추론으로 합성**하는 것이다. 단순히 `filterable` 검사를 지우거나 `try/except`로 삼키는 건 안 됨(회귀). 정답은 `getattr(expression, 'filterable', True)` 검사 **앞에** `hasattr(expression, 'resolve_expression')` 가드를 AND-단락으로 넣어, "진짜 Django expression일 때만" 제약을 적용하는 불변식을 새로 세우는 것. 이는 GenProg식 생성-검증(S3)이 아니라 SemFix/Angelix식 조건 합성(S2)이다. 다만 결함 클래스가 "None/타입 가드 누락"이라는 정형 패턴(S1 template)에도 매칭되므로 보조로 S1을 표기.
- **K (Knowledge) = K-Domain** — 근거: `resolve_expression`의 유무가 Django에서 "이 객체가 query expression인가 아니면 평범한 값인가"를 판별하는 **관용 duck-typing 패턴**임을 알아야 정답 가드를 선택할 수 있다. expression 프로토콜(`filterable` 메타 속성이 `BaseExpression`에 달려 있다는 사실)은 ORM 내부 지식. 일반 파이썬 추론만으로는 "왜 모델 인스턴스에 `filterable` 속성이 우연히 존재하는가"의 충돌 메커니즘을 짚기 어렵다.
- **Primary Type = T-DirectMap** — 위치가 L0로 명확하고, 픽스가 "타입/프로토콜 가드 1개 추가"라는 정형 결함클래스(누락된 타입 강제)에 매핑된다. 진짜 어려움은 "어디"가 아니라 "정확히 어떤 가드냐"에 있으나, 그 가드가 도메인 관용구(`resolve_expression` duck-typing)로 거의 기계적으로 결정되므로 ConstraintReason보다 DirectMap이 dominant. (도메인 지식 비중이 크지만 병목이 localize가 아니라 픽스-합성이라 T-DomainBound로는 가지 않음.)

## 난이도 티어
**Tier = T3 (중간).** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 경계의 개발자 구현시간 prior)이며, 본 분석은 이를 **T3로 미세 상향 유지**한다.

이 티어로 미는 구조적 피처:
- **localize 직접성 (T1 방향)**: L0 + has-repro(네이티브 traceback). 오라클 분석연구에서 repro 존재는 가장 강한 easiness 신호(~87% 해결률). 이 한 축만 보면 T1~T2급.
- **픽스 합성 난도 (T3 방향)**: 픽스가 1파일 3줄로 작지만, 올바른 술어(`hasattr(resolve_expression)`)를 **AND 단락의 앞쪽**에 배치해야 한다는 순서 제약 + expression 프로토콜이라는 도메인 지식이 끼어 단순 S1 템플릿보다 한 단계 추론이 더 든다. 오답 후보(검사 제거 / except 삼킴 / `isinstance` 오용)가 그럴듯하게 많아 G&V로 풀면 overfit 가능.
- **regression-trap (T3~T4 방향)**: **P2P가 276개**로 매우 광범위하다. `check_filterable`은 slice된 QuerySet·평가된 QuerySet 등을 필터에서 막는 정당한 동작도 책임지므로, 가드를 잘못 넓히면 `QuerySetSupportsPythonIdioms`/`WeirdQuerysetSlicingTests`/`#13227`(평가된 queryset을 arg로) 류가 줄줄이 깨진다. 넓은 P2P trap은 시간 라벨에 안 잡히는 난이도 요인이라 T3를 정당화.

종합: hints에 거의 정답이 노출됐다는 점(에이전트 입장에선 더 쉬움)과 hint를 못 본 채 풀 때의 regression 함정/도메인 추론을 상쇄하면, 공식 prior와 거의 일치하는 **T3**가 방어 가능하다. ≥3파일/>100줄 컷에 전혀 걸리지 않으므로(1파일·3줄·+0/+10 헌크) T5 이상은 배제.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/sql/query.py` → `Query.check_filterable`.
- **근본 원인**: `check_filterable`은 expression이 WHERE 절에 들어갈 수 없는 경우(`filterable=False`인 일부 expression)를 막으려고 `getattr(expression, 'filterable', True)`를 무차별 검사했다. 그런데 RHS가 expression이 아니라 **평범한 모델 인스턴스**이고, 그 모델이 우연히 `filterable`라는 이름의 필드를 가지면, `getattr`이 사용자 데이터(예: `False`)를 ORM 내부 제약 플래그로 오인해 정상 FK 필터를 disallow한다. 즉 **사용자 필드 네임스페이스와 ORM expression 메타 속성 네임스페이스의 충돌**. 커밋 `4edad1ddf6203326e0be4bdb105beecb0fe454c4`에서 도입된 회귀.
- **수정 요지**: 가드 조건을 `if not getattr(expression, 'filterable', True):` 에서

  ```python
  if (
      hasattr(expression, 'resolve_expression') and
      not getattr(expression, 'filterable', True)
  ):
  ```

  로 좁힘. `resolve_expression`을 가진 객체(=진짜 Django expression)에 한해서만 `filterable` 제약을 적용한다. 모델 인스턴스는 `resolve_expression`을 갖지 않으므로 우연한 `filterable` 필드가 있어도 더 이상 막히지 않는다. AND 단락 평가로 `hasattr` 가드가 먼저 통과해야만 `getattr` 검사에 도달하는 **순서**가 정답의 핵심.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `test_field_with_filterable (queries.tests.Queries1Tests)`(신규), `test_ticket8439 (queries.tests.Queries1Tests)`(기존, fixture 변경으로 재검증).
- **픽스 증명 메커니즘**:
  - `tests/queries/models.py`의 `ExtraInfo` 모델에 `filterable = models.BooleanField(default=True)` 필드를 추가 — 이게 "내부 플래그와 충돌하는 사용자 필드"를 재현한다.
  - fixture에서 `cls.e2 = ExtraInfo.objects.create(..., filterable=False)`로 생성. 즉 `e2`의 `filterable` 속성이 `False`라서, 픽스 전 코드라면 `e2`를 RHS로 쓰는 필터가 `NotSupportedError`로 터진다.
  - 신규 `test_field_with_filterable`이 `Author.objects.filter(extra=self.e2)`를 실행하고 결과가 `[self.a3, self.a4]`(extra가 e2인 저자들)임을 단언. 픽스 후 `e2`는 `resolve_expression`이 없으므로 제약을 건너뛰어 정상적으로 두 행을 반환.
  - 부수적으로 `a3`를 `cls.a3`로 승격하고 `Report(creator=cls.a3)`로 바꾼 건 신규 단언이 `a3`를 참조하기 위한 fixture 정리(그래서 `test_ticket8439`도 같은 fixture 위에서 재검증됨).
- **overfit 관점**: 테스트가 정확히 "filterable 필드를 가진 모델을 RHS로" 시나리오를 재현하므로, 가드 추가가 이 시나리오를 진짜로 풀었는지 직접 증명한다. 다만 F2P가 2개로 얇아, `isinstance(expression, Model)`로 막거나 `filterable` 검사를 통째로 삭제하는 식의 over-narrow/over-broad 오답도 이 2개는 통과시킬 수 있다(special-case 통과). 그래서 진짜 안전망은 F2P가 아니라 광범위한 P2P다.
- **regression 관점**: **P2P 276개**가 가드가 너무 넓어지지 않았음을 보증한다. 특히 `check_filterable`이 정당하게 막아야 하는 동작 — slice된 QuerySet/평가된 QuerySet을 필터 arg로 쓰는 케이스(`QuerySetSupportsPythonIdioms`, `WeirdQuerysetSlicingTests`, `#13227 -- If a queryset is already evaluated...`) — 이들은 `resolve_expression`을 가진 객체라 가드를 통과해 여전히 제약을 받는다. 즉 픽스가 "진짜 expression은 여전히 검사, 모델 인스턴스만 면제"라는 정확한 경계를 유지함을 P2P가 증명.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 traceback이 `query.py` 호출 사슬 `filter → _filter_or_exclude → add_q → _add_q → build_filter → check_filterable`을 끝까지 보여주고, 마지막 프레임이 `query.py:1131 check_filterable`의 `raise NotSupportedError`다. 에러 문구 `"is disallowed in the filter clause"`로 grep → `Query.check_filterable` 단일 함수 도달. 한 방 localize(L0).
2. **픽스 (왜 올바른 일반화인가)**: 함수 본문 `if not getattr(expression, 'filterable', True):`를 보면, `expression`이 항상 expression이라고 가정하지만 실제로는 모델 인스턴스도 들어온다는 걸 알 수 있다. 충돌의 본질은 "사용자가 `filterable` 필드를 정의 → 인스턴스에 `filterable` 속성 존재 → `getattr`이 그걸 내부 플래그로 오인". 올바른 일반화는 **"제약은 expression에만 적용"**이라는 원래 의도를 코드로 복원하는 것 — `hasattr(expression, 'resolve_expression')`로 expression 여부를 duck-typing 판별해 가드. 이는 `e2.filterable` 한 케이스만 가리는 게 아니라 "expression이 아닌 모든 값"을 일관되게 면제하므로 overfit이 아닌 의도-정합 일반화다.
3. **regression 안전**: 깨지 말아야 할 핵심 P2P는 `check_filterable`의 정당한 disallow들 — slice된 서브쿼리/평가된 QuerySet/특정 expression을 필터에 못 넣게 하는 동작(`WeirdQuerysetSlicingTests`, `QuerySetSupportsPythonIdioms`, `#13227`, `SubqueryTests` 등). 이들은 모두 `resolve_expression`을 가진 객체라 가드 통과 후에도 검사를 받는다. AND 단락에서 `hasattr` 가드를 **앞에** 두는 게 중요 — 뒤에 두면 모델 인스턴스에서 `getattr`이 먼저 평가돼 의미가 없다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 회귀 원인을 "사용자 코드 문제"로 오판하고 문서화만 권고(이슈 본문도 "documented or fix"라 underspecified 유혹), (b) `filterable` 검사를 통째로 제거 → 진짜 disallow가 풀려 다수 P2P 깨짐, (c) `try/except NotSupportedError`로 삼킴 → 정당한 에러까지 묵살, (d) `isinstance(expression, Model)`로 좁히면 expression 계층의 다른 비-Model 값 처리가 어긋날 수 있고 import 결합도 증가. 회피법: "제약은 expression 전용"이라는 의도를 먼저 확정하고, Django 관용구인 `resolve_expression` 유무로 판별하되 **반드시 기존 검사보다 앞쪽 AND 절**에 배치 — hints_text의 권고 diff와 골드패치가 정확히 이 형태다.
