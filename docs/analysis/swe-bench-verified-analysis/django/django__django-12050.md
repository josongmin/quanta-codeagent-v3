---
instance_id: django__django-12050
repo: django/django
base_commit: b93a0e34d9b9b99d41103782b7e7aeabf47517e3
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-11-10T08:53:45Z
fail_to_pass: 1
pass_to_pass: 10
gold_files: [django/db/models/sql/query.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-12050

## 문제 요약
`Query.resolve_lookup_value`가 lookup 값으로 들어온 `list`를 항상 `tuple`로 강제 변환한다. PR #30687 변경에서 생긴 회귀로, 입력 iterable 타입이 보존되지 않는다. PickledField처럼 입력 타입이 정확히 일치해야 동작하는 ORM 필드의 exact value 쿼리가 깨진다. 기대 동작은 반환 iterable 타입이 입력 iterable 타입과 동일하게 유지되는 것이다.

## 유형 (정형화)

**3축 점수**

- **L (Localization) = L0 (Pinpointed)** — problem_statement가 `Query.resolve_lookup_value`라는 메서드명과 회귀를 도입한 PR #30687을 둘 다 명시적으로 지목한다. 메서드명이 그대로 골드 파일(`django/db/models/sql/query.py`)의 단일 함수로 직결되어 grep 한 방이면 끝난다. 탐색 비용 사실상 0.

- **S (Repair Strategy) = S1 (Direct-Map) +S2 (Constraint-Reasoning)** — 결함클래스가 정형(타입강제 회귀: 입력 컨테이너 타입 손실)이고 이슈가 픽스를 거의 명세한다("반환 iterable 타입은 입력 iterable 타입과 일치해야"). 핵심 픽스는 `tuple(...)` → `type(value)(...)`로 컨테이너 생성자만 동적화하는 기계적 1-수정이라 S1이 dominant. 다만 골드패치는 단순히 생성자만 바꾼 게 아니라 명령형 루프 + 수동 F/expression isinstance 분기를 `resolve_lookup_value` 재귀 호출로 접어버려, 스칼라 분기가 expression/F를 이미 처리한다는 불변식을 추론해야 안전하게 단순화된다 — 이 부분이 S2 보조. APR 관점: TBar/PAR류 템플릿(타입강제 교정)에 곧장 매칭되는 전형적 Direct-Map이고, generate-&-validate로 후보를 뿌릴 필요가 없다(올바른 식이 추론으로 바로 나온다).

- **K (Knowledge) = K-Domain** — 일반 파이썬 추론만으로 `type(value)` 보존 아이디어는 떠올릴 수 있으나, 재귀 단순화가 안전한 이유(스칼라 경로의 `resolve_expression` 분기가 F를 이미 커버)와 PickledField가 왜 깨지는지(rhs repr 동일성에 의존하는 ORM lookup 의미)를 이해하려면 django ORM lookup/expression resolution 도메인 지식이 필요하다.

**primary type = T-DirectMap** — 위치가 L0로 명확하고 픽스가 S1 기계적 타입강제 교정(`tuple` → `type(value)` 생성자)이므로 T-DirectMap. L0+S1이지만 픽스가 이슈에 완전히 적혀있진 않고(컨테이너 생성자 보존 + 재귀 접기를 합성) K-Domain 의존이 있어 T-LocTrivial보다는 T-DirectMap이 정확하다.

## 난이도 티어

**Tier = T2 (쉬움)**

이 티어로 미는 구조적 피처:
- **파일/줄수**: 단일 파일·단일 메서드, 골드 diff는 +5/-14줄(순감소). 1파일 소규모 → 구조컷상 high-solve 구간.
- **localize 직접성**: L0 — 메서드명·PR번호 직접 지목, 탐색 노력 거의 0.
- **repro**: 네이티브 스택트레이스나 실행 가능한 재현코드는 없음(`has-repro` 미부여) — 가장 강한 easiness 신호가 빠져 T1까지는 안 내려감.
- **repair**: S1 기계적이지만 가벼운 엣지추론(컨테이너 타입 보존 + 재귀 접기 안전성)이 동반 → T2의 "가벼운 엣지추론" 프로파일과 정확히 일치.
- **P2P trap**: PASS_TO_PASS 10개(`test_foreign_key_f`, `test_transform`, `test_complex_query` 등 F/transform/복합쿼리 경로)는 같은 메서드의 인접 동작을 검증하므로 `regression-trap` 부여. 재귀 단순화가 이들을 깨면 안 됨. 다만 trap이 광범위(수십 케이스)는 아니라서 T4로 올리진 않는다.

**공식 라벨과의 차이**: 공식 difficulty는 "15 min - 1 hour"(T3 수준 prior)인데 본 분석은 T2로 한 단계 낮춘다. 이유: 공식 라벨은 개발자 구현시간(테스트 작성 + 재귀 리팩터 결정 포함)을 반영하지만, 에이전트 난이도 관점에서 localize가 L0로 거의 공짜이고 핵심 픽스가 `type(value)` 한 패턴으로 결정되며 overfit 위험이 낮다. 시간라벨에 잡히지 않는 localize 직접성·낮은 overfit 위험이 T2 쪽으로 끌어내린다.

## 골드패치 분석

- **건드린 파일·함수**: `django/db/models/sql/query.py` : `Query.resolve_lookup_value` (list/tuple 분기 한 곳).
- **근본 원인**: `isinstance(value, (list, tuple))` 분기에서 각 `sub_value`를 명령형 루프로 풀어 `resolved_values` 리스트에 모은 뒤 `value = tuple(resolved_values)`로 **무조건 tuple로 재조립**했다. 입력이 list여도 출력이 tuple이 되어 컨테이너 타입이 손실된다(#30687 회귀). 부수적으로 루프 내부에 F인지 일반 expression인지를 `isinstance(sub_value, F)`로 갈라 `resolve_expression(...)`을 두 번 호출하는 중복 코드가 있었다.
- **수정 요지**: 명령형 루프 + `tuple(resolved_values)` 재조립 + 수동 F 분기 전체를 한 줄로 교체:
  `return type(value)(self.resolve_lookup_value(sub_value, can_reuse, allow_joins, simple_col) for sub_value in value)`.
  (1) `type(value)(...)`로 원본 컨테이너 타입(list↔tuple)을 보존하고, (2) 각 `sub_value`를 `resolve_lookup_value` 자신으로 **재귀 호출**해 스칼라/expression/F 처리를 위임 → 메서드 앞부분의 expression·F 분기가 이미 그 케이스를 다루므로 수동 isinstance(F) 분기를 안전하게 삭제한다.

## 검증 (test_patch)

- **FAIL_TO_PASS 동작**: `test_iterable_lookup_value` — `Query(Item)`에서 `query.build_where(Q(name=['a', 'b']))`를 만들고, `where.children[0]`이 `Exact` 인스턴스인지, 그리고 그 `rhs`가 문자열 `"['a', 'b']"`인지 단언한다.
- **픽스 증명**: rhs가 list의 repr인 `"['a', 'b']"`와 같다는 것은 내부에서 list가 tuple로 변환되지 **않았음**을 직접 의미한다 — 회귀 코드였다면 `tuple(...)`을 거쳐 rhs가 `"('a', 'b')"`가 되어 `assertEqual`이 실패한다. 즉 컨테이너 타입 보존을 repr 동일성으로 핀포인트 검증.
- **overfit 관점**: FAIL_TO_PASS가 1개뿐이라 얇아 보이지만, `type(value)` 픽스는 그 테스트만 통과시키는 special-case가 아니라 **list/tuple 양쪽을 일반적으로** 보존하는 올바른 일반화다(테스트는 list 케이스만 검증하지만 tuple은 PASS_TO_PASS가 커버). `value = list(...)`로 하드코딩하면 이 테스트는 통과하나 tuple 입력이 깨지므로 overfit 함정이 존재 — 그래서 `overfit-risk`를 부여하진 않되 잘못된 일반화 가능성은 모범답안에서 명시. CEGIS가 필요할 정도의 과소명세는 아님(S4 아님).
- **regression 관점**: PASS_TO_PASS 10개가 `Query` lookup 경로 전반(`test_foreign_key_f` = F expression, `test_transform`, `test_complex_query`, `test_negated_nullable` 등)을 덮는다. 재귀 단순화가 F/expression/transform 처리를 깨면 이들이 RED → `regression-trap` 유효. 골드의 재귀 위임이 기존 스칼라 분기를 재사용하므로 이 P2P들이 보존된다.

## 모범답안 (오라클 기반)

이상적 풀이 궤적 4단계:

1. **localize 경로**: problem_statement가 `Query.resolve_lookup_value`와 PR #30687을 직접 준다 → `django/db/models/sql/query.py`의 해당 메서드로 바로 진입. `git log`/`git blame`으로 #30687의 변경 hunk를 찾으면 `value = tuple(resolved_values)` 라인이 회귀 지점임을 즉시 확인. 탐색 노력 거의 없음(L0).

2. **픽스(올바른 일반화인 이유)**: list/tuple 분기의 `tuple(resolved_values)` 재조립을 `type(value)(...)` 생성자로 바꿔 원본 컨테이너 타입을 보존한다. 이게 overfit이 아니라 올바른 일반화인 이유: 이슈가 요구하는 불변식("반환 iterable 타입 == 입력 iterable 타입")을 list/tuple 모든 경우에 대해 만족시키며, 특정 테스트 입력(`['a','b']`)에 맞춘 게 아니다. 추가로 각 원소를 `resolve_lookup_value`로 재귀 호출하면 스칼라/expression/F 처리가 한 곳으로 수렴해 중복 isinstance(F) 분기가 자연 제거된다.

3. **regression 안전**: 깨지면 안 되는 P2P = `test_foreign_key_f`(F expression 해석), `test_transform`, `test_complex_query`, `test_negated_nullable`, `test_multiple_fields` 등 — 모두 같은 메서드의 lookup/expression 경로다. 재귀 위임이 메서드 앞부분의 expression·F 분기를 그대로 재사용하므로 이들 동작이 보존된다. 핵심: 재귀로 단순화하기 전에 "스칼라 분기가 이미 `resolve_expression`/F를 처리한다"는 불변식을 확인해야 안전.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 타입 보존을 놓치고 `value = list(resolved_values)`로 하드코딩 → FAIL_TO_PASS는 통과하나 tuple 입력 회귀(부분적 overfit). 반드시 `type(value)`로 동적 보존. (b) 재귀 단순화를 안 하고 루프를 유지한 채 마지막만 `type(value)(resolved_values)`로 감싸는 것은 동작상 안전하지만, 무리하게 F 분기를 건드리면 `test_foreign_key_f`/`test_transform`을 의도치 않게 깰 수 있음. (c) 테스트가 rhs repr 문자열을 정확 비교하므로(`"['a', 'b']"`), 타입 보존만 정확히 맞추면 통과 — 과한 리팩터는 risk만 키운다.
