---
instance_id: django__django-15128
repo: django/django
base_commit: cb383753c0e0eb52306e1024d32a782549c27e61
version: "4.1"
difficulty: 1-4 hours
created_at: 2021-11-25T15:50:24Z
fail_to_pass: 1
pass_to_pass: 282
gold_files: [django/db/models/sql/query.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-15128

## 문제 요약
두 QuerySet을 OR(`|`)로 결합할 때, 특정 조인 구조에서 `Query.change_aliases`가 `AssertionError`를 던진다. 양쪽 쿼리가 같은 `alias_prefix`(`T`)를 쓰고 rhs가 연속된 alias(예: `T4`, `T5`)를 갖고 있으면, 결합 중 생성되는 change_map이 `{'T4':'T5','T5':'T6'}`처럼 키와 값이 겹쳐버린다. 사용자는 `qs2 | qs1`은 동작하는데 `qs1 | qs2`만 깨지는, 결합 순서에 의존하는 크래시를 겪었다(OR 연산이 비가환). 트레이스백은 `query.py`의 `change_aliases` 첫 줄 `assert set(change_map).isdisjoint(change_map.values())`를 정확히 가리킨다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)** — 트레이스백이 `query.py`의 `Query.change_aliases`와 깨지는 `change_map`을 직접 찍어주고, problem_statement이 `Query.combine`/`Query.table_alias`/`Query.join`을 후보로 좁혀준다. hints_text에서 Simon Charette가 `Query.bump_prefix`를 명시적으로 지목한다. 단일 파일(`sql/query.py`)로 수렴하지만 assert가 "터지는 지점"이지 "고칠 지점"이 아니라서(진짜 수정은 그 위의 `combine`/`bump_prefix`) L0(grep 한 방)는 아니다.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning)** — 픽스가 한 줄 가드 추가가 아니라 **세 함수에 걸친 조율된 구조 변경**이다: (1) `bump_prefix` 시그니처를 `(outer_query)`→`(other_query, exclude=None)`로 확장하고 relabel 딕셔너리 생성에 `exclude` 분기를 도입, (2) `combine`이 change_map 생성 *전에* `rhs.bump_prefix(self, exclude={initial_alias})`를 선행 호출하도록 lifecycle을 재배치, (3) `combine` 안의 중복 `get_initial_alias()` 호출을 위로 끌어올림. 이는 "기존 메서드를 재사용 가능하게 파라미터화하고 호출 시점을 옮기는" 전형적 S6. 동시에, "왜 `exclude`가 base alias 하나여야 하는가(merge 시작점은 양쪽에 공통이라 보존해야 KeyError를 피한다)"는 불변식 추론이 필요해 S2가 보조로 붙는다.
- **K (Knowledge) = K-Domain** — django ORM의 SQL 컴파일러 내부(alias 생성/relabel, `alias_prefix` 카르테시안곱 증분, subquery alias 충돌 회피, combine의 join-merge 알고리즘)를 알아야 한다. 일반 파이썬 추론으로는 `bump_prefix`가 이 문제의 올바른 재사용 지점이라는 사실에 도달할 수 없다. hints_text 자체가 "이미 모든 무거운 로직은 `bump_prefix`에 있고, combine의 merge 알고리즘이 양쪽 공통 initial alias를 요구한다"는 도메인 사실을 풀이의 핵심으로 제시한다.
- **Primary = T-DomainBound** — 위치는 L1로 비교적 잡히지만(따라서 T-DiffuseLoc 아님), 병목은 **ORM alias-relabeling 도메인 지식**에 있다. 정답 경로(기존 `bump_prefix` 재사용 + `exclude`로 base만 보존)는 프레임워크 내부 계약을 알아야만 나오고, 도메인을 모르면 hints에 기록된 실패들(랜덤 prefix→비결정 실패, 순환 prefix→subquery 충돌, assert 약화→다수 회귀)로 정확히 빠진다. K-Domain이 dominant라 T-DomainBound.

## 난이도 티어
**T5 (어려움).** 공식 라벨은 "1-4 hours"(T4 prior)지만 T5로 한 칸 올린다.

이 티어로 미는 구조적 피처:
- **멀티-함수 조율 패치(S6)**: 1파일이지만 `combine`/`change_aliases`/`bump_prefix` 3함수를 일관되게 손봐야 하고, `bump_prefix`의 시그니처 변경이 호출부와 맞물린다. 단일 헌크 가드가 아니다.
- **광범위 P2P trap (regression-trap)**: PASS_TO_PASS가 **282건**, 대부분 `queries.tests`의 ORM 쿼리/조인/alias 동작이다. `bump_prefix`는 subquery resolve에서도 쓰이므로(`resolve_expression`→`bump_prefix`) 시그니처/동작을 잘못 건드리면 인접 동작이 줄줄이 깨진다. hints_text에 "5개 테스트 실패", "여러 테스트 실패" 같은 오답 시도의 회귀 사례가 다수 기록돼 있다 — overfit이 아니라 회귀가 진짜 함정.
- **깊은 도메인 추론(K-Domain)**: alias 충돌이 "왜 키/값 교집합으로 이어지는지", "왜 base alias만 exclude해야 하는지"를 SQL 컴파일러 흐름을 끝까지 따라가야 안다.

T6은 아니다 — 단일 파일, ~20줄, gold 변경이 한 메서드 묶음에 국한되고 L1로 진입점이 잡힌다(>100줄/다수 파일/L3 조율이 아님). has-repro(이슈에 완전한 재현 모델+코드)가 진입 난이도를 낮춰 T6까지 가진 않지만, 회귀 폭과 도메인 깊이가 T4의 "가벼운 constraint추론"을 넘어서므로 T5가 맞다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/sql/query.py` — `Query.combine`, `Query.change_aliases`, `Query.bump_prefix`.
- **근본 원인**: lhs와 rhs가 동일한 `alias_prefix`(`T`)를 공유하면, `combine`이 rhs alias를 relabel하려고 만드는 `change_map`의 키와 값이 교집합을 가질 수 있다(`{'T4':'T5','T5':'T6'}`). 이러면 dict 순회 순서에 따라 한 alias가 두 번 갱신(`T4→T5` 후 다시 `T5→T6`)되어 잘못된 relabel이 되고, 이를 막는 `change_aliases` 첫 줄의 `assert set(change_map).isdisjoint(change_map.values())`가 터진다.
- **수정 요지**:
  - `combine`에서 change_map을 만들기 **전에** `initial_alias = self.get_initial_alias()`를 구하고 `rhs.bump_prefix(self, exclude={initial_alias})`를 호출 — rhs의 prefix를 미리 한 칸 올려 양쪽 prefix를 분리, 충돌 가능성을 원천 제거한다. (기존엔 `combine` 뒤쪽에 있던 중복 `self.get_initial_alias()` 호출을 위로 호이스트하면서 제거.)
  - `bump_prefix(self, outer_query)` → `bump_prefix(self, other_query, exclude=None)`로 확장. 내부 relabel 딕셔너리 컴프리헨션에 `if alias not in exclude`를 추가해 base 테이블(initial alias)은 relabel에서 제외 — base는 양쪽에 반드시 존재하는 merge 시작점이라 그대로 둬야 KeyError가 안 난다. `exclude is None`이면 `{}`로 폴백. `outer_query.subq_aliases` 갱신도 `other_query`로 변수명 정리.
  - `change_aliases`의 assert 위에 키/값 교집합 시 alias 이중 갱신 위험을 설명하는 주석 추가(이슈의 문서화 요청 반영).

## 검증 (test_patch)
- **FAIL_TO_PASS (1건)**: `test_conflicting_aliases_during_combine (queries.tests.QuerySetBitwiseOperationTests)`.
- **재현 셋업**: `tests/queries/models.py`에 `BaseUser.annotation`(FK→Annotation)과 `Task.note`(FK→Note)를 추가해, 같은 prefix로 연속 alias가 생기는 조인 구조를 만든다. 테스트는 `qs1 = annotation_1.baseuser_set.all()`과 두 OR 분기(`Q(owner__note__in=...) | Q(creator__note__in=...)`)를 가진 `qs2`를 구성한다.
- **픽스 증명**: 픽스 전엔 `qs1 | qs2`가 `AssertionError`로 죽는다. 테스트는 먼저 `qs1`/`qs2` 각각의 결과를 고정(`[base_user_1]`, `[base_user_2]`)한 뒤, `assertCountEqual(qs2 | qs1, qs1 | qs2)`로 **양방향 결합이 모두 성공하고 결과가 동일**함(교환법칙 성립)을, 그리고 결과가 `[base_user_1, base_user_2]`임을 검증한다.
- **overfit 관점**: FAIL_TO_PASS는 1건뿐이라 표면적으론 얇다. 하지만 테스트가 `qs2|qs1`(원래 통과하던 경로)까지 함께 단언해 단순 special-case 우회를 막고, 결과 집합 동등성까지 확인하므로 "assert만 지우는" overfit은 통과 못 한다. 진짜 일반화 검증은 P2P가 담당한다.
- **regression 관점**: 282개 P2P가 `queries.tests`의 alias/join/subquery/combine 동작 전반을 덮는다(`UnionTests`, `JoinReuseTest`, `ExcludeTests`, `DisjunctionPromotionTests`, `Queries1~6Tests`, `test_subquery_aliases` 등). `bump_prefix`는 subquery resolve 경로에서도 호출되므로, 시그니처/exclude 로직을 틀리면 여기서 즉시 깨진다 — 회귀가 정답을 강제하는 핵심 압력.

## 모범답안 (오라클 기반)
1. **localize 경로**: 트레이스백의 `assert set(change_map).isdisjoint(change_map.values())`(`change_aliases` 첫 줄)와 `change_map = {'T4':'T5','T5':'T6'}`를 본다 → assert가 "터지는 곳"이지만, change_map은 호출자 `Query.combine`이 만든다. `combine`을 거슬러 올라가 rhs alias가 lhs와 같은 prefix(`T`)로 relabel되며 키/값이 겹친다는 데이터플로우를 파악. hints가 `bump_prefix`를 "이미 충돌 회피 로직을 다 가진 기존 메서드"로 지목 → 진짜 수정 지점은 `combine`의 change_map 생성 *직전* + `bump_prefix`의 파라미터화.
2. **픽스와 올바른 일반화인 이유**: assert를 약화/삭제하는 게 아니라 **충돌이 애초에 발생하지 않도록** `combine`이 change_map을 만들기 전에 `rhs.bump_prefix(self, exclude={initial_alias})`로 rhs prefix를 미리 올린다. `exclude={initial_alias}`는 "merge 시작점인 base 테이블은 양쪽에 공통이어야 한다"는 ORM 불변식을 보존 — base만 빼고 나머지 alias의 prefix를 분리하므로 어떤 입력에서도 키/값 교집합이 생기지 않는다. 특정 `T4/T5` 케이스가 아니라 "공유 prefix" 결함클래스 전체를 닫는 구조적 일반화라 overfit이 아니다. assert는 불변식 가드로 그대로 유지(주석만 보강).
3. **regression 안전**: `bump_prefix`는 기존에 subquery resolve(`resolve_expression`→`bump_prefix(query)`)에서 단일 인자로 쓰인다. `exclude=None` 기본값으로 시그니처를 하위호환 유지해 기존 호출부 동작을 byte-동등하게 보존해야 `JoinReuseTest`/`Queries1~6Tests`/subquery 관련 282 P2P가 안 깨진다. `combine`의 join-merge가 base alias를 시작점으로 요구하는 계약(exclude로 보호)도 유지해 `UnionTests`/`combine` 계열 회귀를 막는다.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 오답 — (a) **assert를 지우거나 완화**: 이중 갱신된 잘못된 SQL이 조용히 생성되고 다수 회귀. (b) **`bump_prefix(self)`를 그냥 호출**: base alias까지 바뀌어 merge가 시작점을 잃고 KeyError(hints의 대표 실패). 반드시 `exclude={initial_alias}`. (c) **랜덤/순환 prefix 휴리스틱**(`table_alias` 손보기): hints에 명시된 대로 비결정 실패 또는 26자 wrap 후 subquery alias 충돌로 5개+ 테스트 실패. 정답은 "새 알고리즘을 만들지 말고 기존 `bump_prefix`를 exclude 파라미터로 재사용"이라는 도메인 사실을 따르는 것.
