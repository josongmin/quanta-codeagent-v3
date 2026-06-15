---
instance_id: django__django-15268
repo: django/django
base_commit: 0ab58c120939093fea90822f376e1866fc714d1f
version: 4.1
difficulty: 1-4 hours
created_at: 2022-01-01T09:57:13Z
fail_to_pass: 3
pass_to_pass: 130
gold_files: [django/db/migrations/operations/models.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-15268

## 문제 요약
#31503에서 `AlterUniqueTogether`/`AlterIndexTogether`(통칭 AlterFooTogether)를 "기존 제약 제거 → 새 제약 추가" 두 단계로 쪼개도록 바꿨다. 그 결과 같은 모델에 대해 `unique_together=set()`으로 비우는 연산과 `unique_together={("col",)}`로 다시 채우는 연산이 연달아 생성되는데, 이 둘은 사실 하나로 합쳐질 수 있다. problem_statement는 마이그레이션 옵티마이저가 이 잉여 쌍을 단일 연산으로 reduce해주길(`optimize ... into one`) 기대한다고 명시한다. 즉 기능 결함이 아니라 최적화 누락(redundant operation pair가 squash되지 않음)이다.

## 유형 (정형화)

**L (Localization) = L1 — Traceable.**
problem_statement가 "reduce", "AlterFooTogether", "optimize into one"을 직접 적어주어 후보 파일(`django/db/migrations/operations/models.py`)로 거의 바로 수렴한다. 다만 L0(grep 한 방)은 아니다 — 정확히 어느 클래스의 `reduce()`를 고쳐야 하는지는 `ModelOperation → ModelOptionOperation → AlterTogetherOptionOperation → AlterUniqueTogether/AlterIndexTogether` 상속 사슬을 읽어 결정해야 하며, optimizer(`optimizer.py`)와 autodetector(`autodetector.py`)라는 인접 오답 후보가 존재한다. 약간의 탐색이 필요하므로 L1.

**S (Repair Strategy) = S2 (+S6) — Constraint-Reasoning + Design-Refactor.**
고칠 지점(어느 `reduce`)을 찾는 것보다, **언제 두 AlterTogether 연산 사이를 통과(reduce)시켜도 안전한가**라는 불변식을 추론으로 합성하는 것이 본질이라 dominant는 S2다. 기존 가드 `not operation.references_model(self.name, app_label)`은 같은 모델을 참조하는 모든 후행 연산을 차단하는데, 정답은 "참조하더라도 상대가 다른 종류(Unique vs Index)의 AlterTogether면 직교하므로 통과시켜도 된다"는 정밀 조건(`isinstance(operation, AlterTogetherOptionOperation) and type(operation) is not type(self)`)이다. 이 조건은 G&V로 우연히 맞출 수 없고 의미적으로 따져야 한다. 동시에 보조로 S6: 인라인 한 줄 수정이 아니라 `reduce()`의 후반 항을 `can_reduce_through()` 후크 메서드로 추출하고 서브클래스에서 super-OR 체인으로 오버라이드하는 작은 구조 변경(extract-method + template-method 패턴)을 도입한다.

**K (Knowledge) = K-Domain.**
django migrations optimizer의 reduce 프로토콜(`reduce()`가 True/list/False 중 무엇을 반환하면 어떤 squash가 일어나는지), `references_model`의 의미, #31503에서 왜 일부러 제약 제거/추가를 분리했는지(필드 변경 사이 안전성)를 알아야 "교차 타입만 통과" 범위를 정확히 좁힐 수 있다. 일반 파이썬 추론(K-Gen)으로는 squash 안전 조건을 도출할 수 없고, 공개 API 시그니처 계약(K-API) 문제도 아니다.

**Primary type = T-DomainBound.**
L1으로 위치는 비교적 명확하고 패치도 1파일·소규모(+12/-1)지만, 진짜 병목은 "migrations optimizer의 reduce 의미론과 #31503 분리 의도"라는 프레임워크 내부 지식이다. S2 추론도 그 도메인 지식 위에서만 성립한다. 따라서 K-Domain이 dominant인 T-DomainBound이 가장 방어 가능하다(T-ConstraintReason과 경합하나, 추론 자체가 도메인 지식 종속이라 DomainBound로 귀속).

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 라벨 "1-4 hours"와 정합.

이 티어로 미는 구조적 피처:
- **패치 scope는 작다** (1파일, +12/-1, 헌크 2개) → 그 자체로는 T2~T3 신호.
- 그러나 **K-Domain이 dominant** — optimizer reduce 의미론과 #31503 의도를 모르면 정답 조건을 못 만든다. 루브릭상 K-Domain 단독으로도 T4로 끌어올리는 축이다.
- **regression-trap이 강하다** — PASS_TO_PASS 130개 중 다수가 마이그레이션 연산의 **순서·개수**를 단언한다("Fields are altered after deleting some index/unique_together", "Added fields will be created before using them in index/unique_together" 등). reduce를 과하게 풀면 #31503이 일부러 유지한 단계 분리가 깨져 이들이 회귀한다. 넓은 P2P trap은 루브릭에서 명시적으로 T4 신호.
- **localize는 L1로 직접적이고 repro(예시 operations 리스트)도 본문에 있어** T5로 올리진 않는다 — overfit 위험도 낮다(아래 검증 참고).

공식 difficulty와 동일(T4≈1-4h)이라 별도 불일치 해명은 불필요. 시간 비용은 "조건 합성 + 회귀 안전 검증"에서 오지, 코드량에서 오지 않는다.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/migrations/operations/models.py`
  - `ModelOperation.reduce()` — 후반 항을 직접 식에서 메서드 호출로 교체. (patch hunk 1의 컨텍스트가 `def references_model(self, name, app_label)` 바로 다음의 `def reduce`로, base line 34-38의 `ModelOperation.reduce`다. `ModelOptionOperation.reduce`(base line 411)는 `if isinstance(operation, (self.__class__, DeleteModel)) ... return [operation]`라는 별개 메서드로 패치가 손대지 않는다.)
  - 신규 `ModelOperation.can_reduce_through()` — 기본 구현(기존 동작 보존).
  - 신규 `AlterTogetherOptionOperation.can_reduce_through()` — 오버라이드로 교차 타입 허용.
- **근본 원인:** 기존 `reduce()`는
  `super().reduce(...) or not operation.references_model(self.name, app_label)`
  였다. 후행 AlterFooTogether 연산은 **같은 모델을 참조**하므로 `references_model`이 True → `not ...`이 False → 절대 reduce 통과 불가. 따라서 `unique_together=set()`(비우기)와 `unique_together={...}`(채우기) 쌍이 항상 둘로 남았다. optimizer는 직교한 두 연산(Unique 변경 / Index 변경)을 서로 통과시켜 인접 같은-종류 연산끼리 squash시킬 기회를 얻지 못했다.
- **수정 요지:** reduce 조건의 후반부를 `can_reduce_through()` 후크로 추출(extract-method)하여
  `super().reduce(...) or self.can_reduce_through(operation, app_label)`로 바꿨다. 기본 `can_reduce_through`는 기존 `not references_model(...)`을 그대로 반환(동작 보존). `AlterTogetherOptionOperation`은 이를 오버라이드해
  `super().can_reduce_through(...) or (isinstance(operation, AlterTogetherOptionOperation) and type(operation) is not type(self))`
  로 확장한다. 즉 같은 모델을 참조해도 **상대가 AlterTogether 계열이고 자신과 타입이 다르면**(Unique↔Index) 사이를 통과시켜, 같은 종류의 인접 AlterTogether 두 개(비우기+채우기)가 최종값 하나로 reduce되게 한다. `type(operation) is not type(self)`가 핵심 가드 — 같은 타입(Unique+Unique)은 통과시키면 안 되고 교차 타입만 허용.

## 검증 (test_patch)
- **FAIL_TO_PASS(3개) 동작:** `tests/migrations/test_autodetector.py`의
  1. "index/unique_together also triggers on ordering changes." (`test_foo_together_ordering`)
  2. "Removed fields will be removed after updating index/unique_together." (`test_remove_field_and_foo_together`)
  3. "Fields are renamed before updating index/unique_together." (`test_rename_field_and_foo_together`)
- **픽스 증명:** 세 테스트 모두 autodetector가 만든 AlterTogether 연산 시퀀스를 단언한다. 패치 전 기대는 `AlterUniqueTogether(set())` + `AlterIndexTogether(set())` + `AlterUniqueTogether({...})` + `AlterIndexTogether({...})` 4개. test_patch는 이를 **빈 set으로 비우는 두 연산을 삭제하고** 최종값을 가진 `AlterUniqueTogether({('title','author')})` + `AlterIndexTogether(...)` 2개만 남도록 수정(`assertOperationTypes` 리스트 4→2, 후속 `assertOperationAttributes` 인덱스 재정렬). remove/rename 케이스도 동일하게 잉여 비우기 쌍이 사라지고 RemoveField/RenameField와의 상대 순서는 보존됨을 확인한다.
- **overfit 관점:** 낮음. 테스트는 픽스를 "비우기 연산 개수 0"이라는 일반 결과로 단언하지 가짜 special-case로 통과 가능한 얇은 단언이 아니다(F2P 3개 + 직교한 ordering/remove/rename 시나리오). 정답 조건이 `type(operation) is not type(self)`로 정확히 일반화되어 있어 S4(CEGIS) 과소명세 위험이 작다 → overfit-risk 플래그 미부여.
- **regression 관점:** 높음. PASS_TO_PASS 130개에 "Fields are altered after deleting some index/unique_together", "Added fields will be created before using them in index/unique_together", "Tests unique_together and field removal detection & ordering" 등 **연산 순서·존재**를 보장하는 테스트가 다수. 따라서 regression-trap 플래그 부여. 정답이 `references_model` 가드를 통째로 제거하지 않고 "교차 타입 AlterTogether" 한 경우만 추가 허용하기 때문에 이 회귀들이 보존된다.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement의 "reduce", "AlterFooTogether", "optimize ... into one" 키워드 → 마이그레이션 옵티마이저의 연산 reduce 로직. autodetector가 연산을 *만드는* 쪽이 아니라 optimizer가 연산을 *합치는* 쪽(`reduce()`)이 핵심임을 구분해야 한다. `operations/models.py`에서 `ModelOperation.reduce`(base 메서드)의 후반 항 `not operation.references_model(...)`이 같은-모델 후행 연산을 전부 막는다는 걸 확인한다. 이 가드 항은 base `ModelOperation.reduce`에만 산다 — `ModelOptionOperation.reduce`는 그 항을 갖지 않고 `super().reduce(...)`로 위임하며 동시에 `isinstance(operation, (self.__class__, DeleteModel))`일 때 `[operation]` 리스트를 반환하는 별개 로직을 가진다(그래서 패치가 손대는 건 base `ModelOperation.reduce`다).
2. **픽스(올바른 일반화인 이유):** "비우기/채우기가 안 합쳐지는" 근본 이유는 직교한 두 종류(Unique/Index) 연산이 서로를 통과하지 못해 같은-종류 인접 squash 기회를 못 얻는 것. 따라서 "상대가 AlterTogether 계열이고 타입이 다르면 통과"(`isinstance(..., AlterTogetherOptionOperation) and type(operation) is not type(self)`)가 정확한 조건이다. 이는 특정 테스트값(`{('col',)}`)에 묶이지 않은 구조적 불변식이라 overfit이 아니다. `can_reduce_through` 후크로 추출(S6)하면 기본 동작은 super로 보존되고 확장만 서브클래스에 국한 → 변경 표면 최소화.
3. **regression 안전:** `references_model` 가드를 **삭제하지 말고** `super().can_reduce_through(...)`로 보존한 뒤 OR로 한 경우만 추가해야 한다. 그래야 "Fields are altered after deleting some index/unique_together" 같은 단계-분리 보장 테스트와 RemoveField/RenameField 상대 순서 테스트(P2P 130개 중 다수)가 깨지지 않는다. 같은-타입(Unique+Unique) 합치기를 허용하지 않는 `type(...) is not type(self)`도 회귀 방지의 일부.
4. **함정 회피:** 오라클 없는 에이전트의 전형 오답 — (a) autodetector 쪽을 고치려다 길을 잃음 → reduce/optimizer가 올바른 지점. (b) `references_model` 가드를 통째로 제거해 모든 후행 연산을 통과시킴 → P2P 순서 보장 대량 회귀. (c) 교차/동일 타입 구분을 빼서 Unique+Unique까지 잘못 합침. (d) `super().reduce()`/`super().can_reduce_through()` 단락-OR 체인을 끊어 다른 연산의 기존 reduce를 무력화. 회피법: 변경을 "추가 허용 한 경우"로만 좁히고, P2P의 ordering 테스트를 정답성 오라클로 사용해 과확장을 즉시 적발한다.
