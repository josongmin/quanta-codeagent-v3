---
instance_id: django__django-14017
repo: django/django
base_commit: 466920f6d726eee90d5566e0a9948e92b33a122e
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-02-18T13:05:27Z
fail_to_pass: 2
pass_to_pass: 147
gold_files: [django/db/models/query_utils.py]
---

# django__django-14017

## 문제 요약
`Exists(...) & Q()`는 동작하지만, 피연산자 순서를 뒤집은 `Q() & Exists(...)`는 `TypeError`를 던진다. `&`/`|` 연산이 Q-Exists 조합에서 교환법칙(commutative)을 따라야 하는데 그렇지 않다. 사용자는 두 방향 모두 정상적으로 `Q` 객체로 결합되기를 기대했으나, `Q()`가 좌측 피연산자일 때만 예외가 발생한다.

## 유형 분류
- 버그 카테고리: edge-case / API-contract (교환법칙 위반 + 너무 좁은 타입 검사)
- 서브시스템: django ORM query (Q 객체 / 표현식 결합)
- 증상 타입: 예외 (TypeError)
- 로컬라이제이션 신호: problem_statement의 traceback이 `query_utils.py`의 `__and__` → `_combine` → `if not isinstance(other, Q): raise TypeError(other)`를 직접 가리킨다. hints_text도 "이 두 줄이 Combinable._combine에는 없다"고 명시.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query_utils.py` : `Q._combine`
- 근본 원인: `Q._combine`이 `other`를 `isinstance(other, Q)`로만 검사한다. `Exists` 같은 표현식은 `Q`의 인스턴스가 아니므로, `Q()`가 좌측이라 `Q.__and__`가 호출되면 곧장 `TypeError`. 반대 순서(`Exists(...) & Q()`)는 `Exists`(Combinable) 쪽 연산자가 처리되어 통과하므로 비대칭이 생긴다.
- 수정 요지: 타입 검사를 `if not (isinstance(other, Q) or getattr(other, 'conditional', False) is True)`로 완화. `Q`뿐 아니라 `conditional` 속성이 `True`인 객체(불리언 표현식, 예: `Exists`)도 허용하여 결합을 진행한다. 단 한 줄 변경으로 양방향 대칭을 복원한다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_boolean_expression_combined`: 기존 `Exists | Q` 케이스에 더해 `Q(salary__gte=30) & Exists(is_ceo)`, `Q(salary__lt=15) | Exists(is_poc)`처럼 Q가 좌측인 조합을 추가로 검증.
  - `test_boolean_expression_combined_with_empty_Q`: 빈 `Q()`와 `Exists`의 4가지 조합(`Exists & Q()`, `Q() & Exists`, `Exists | Q()`, `Q() | Exists`)을 subTest로 모두 돌린다.
- 증명 방식: 픽스 전에는 `Q() & Exists(...)`가 `Employee.objects.filter(...)` 평가 시점에 `TypeError`로 죽었다. 픽스 후에는 4방향 조합 모두 `filter`가 통과해 `[self.max]` 결과를 동일하게 반환 → 교환법칙 성립을 직접 관찰.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback이 파일·함수·정확한 라인까지 떠먹여 준다. `query_utils.py`의 `Q._combine` 한 곳만 보면 된다. 멀티파일 아님.
- 함정/난이도 메모: `__rand__`를 추가하면 된다는 사용자 추측(problem_statement)에 끌려가면 엉뚱한 곳을 판다. 진짜 픽스는 `Q._combine`의 타입 검사 완화다. 또한 `isinstance(other, Exists)`로 좁게 잡으면 회귀(다른 conditional 표현식 누락)가 나므로, `conditional` 속성 기반의 duck-typing이 정답.
- 우리 에이전트 관점: 막힐 지점은 "어느 객체를 허용할지"의 일반화. `Exists`만 화이트리스트하는 좁은 수정으로 FAIL_TO_PASS는 통과시킬 수 있으나 골드의 의도(모든 conditional 표현식)와 어긋난다. `Combinable`/`BaseExpression`의 `conditional` 플래그를 인지하는지가 핵심. `_combine` 변경이 빈 `Q()` 단축 경로(다음 줄들)와 충돌하지 않는지도 확인 필요.
