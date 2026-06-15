---
instance_id: django__django-13401
repo: django/django
base_commit: 453967477e3ddae704cd739eac2449c0e13d464c
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-09-09T11:19:00Z
fail_to_pass: 1
pass_to_pass: 32
gold_files: [django/db/models/fields/__init__.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro, overfit-risk]
---

# django__django-13401

## 문제 요약
추상(abstract) 모델 `A`를 상속한 두 구상 모델 `B`, `C`가 같은 필드 `myfield`를 상속하면, `B._meta.get_field('myfield')`와 `C._meta.get_field('myfield')`가 서로 다른 모델 소속임에도 `==`로 동등하게 비교된다. 그 결과 `set`에 함께 넣으면 하나가 중복 제거되어 조용히 사라진다. 사용자는 모델이 다르면 필드도 서로 다른 것으로 취급되길 기대했고, 근본 원인은 `Field.__eq__`가 `self.creation_counter`만 보고 비교하기 때문이다. 이슈 본문은 `__eq__`/`__hash__`/`__lt__` 세 dunder를 함께 고쳐야 하며, `__lt__`는 후방 호환을 위해 `creation_counter`로 먼저 정렬해야 한다고 직접 명시한다(실험 브랜치에서 model-first 정렬 시 깨진 테스트가 있었다는 경고 포함).

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈가 결함 심볼을 직접 지목한다: "fields only consider `self.creation_counter` when comparing for equality", "adjust `__eq__` so that ... Similarly ... `__hash__` and `__lt__`". `creation_counter`로 grep하면 `django/db/models/fields/__init__.py`의 `Field` 클래스 비교 dunder 3종으로 즉시 수렴. 탐색 노력 사실상 0.
- **S2 (Constraint-Reasoning) +S6 (Design-Refactor)** — 위치는 자명하지만 *올바른 식·조건을 추론으로 합성*해야 한다. 단순 가드 추가(S1)가 아니다: `__lt__`는 3-way 분기(carrier 동률·model 유무 비대칭·model 양쪽 보유)를 불변식으로 따져 설계해야 하고, 정렬 totality(@total_ordering 일관성)와 후방호환(creation_counter 우선)을 동시에 만족하는 비교식을 *생각으로* 도출해야 한다. `__eq__`/`__hash__`/`__lt__` 세 메서드를 상호 일관되게 조율하는 작은 구조 변경이라 S6 보조. 테스트를 마구 돌려 수렴하는 G&V가 아니라 계약 추론이 본질이라 S3/S4 아님.
- **K-Domain** — Django ORM 내부 지식이 병목. abstract 모델 상속 시 필드가 deepcopy되며 `creation_counter`가 보존된다는 점, `field.model` 속성이 *바인딩 후에만* 존재한다는 점(`hasattr(self, 'model')` 가드 필요), `model._meta.app_label`/`model_name`이 안정적 identity 키라는 점을 알아야 올바른 식이 나온다. 일반 파이썬 추론만으론 부족.
- **primary = T-ConstraintReason** — L0로 위치는 명확하나, 픽스가 기계적 템플릿이 아니라 정렬·해시·동등성 계약을 동시에 만족하는 조건식 합성이다. 이슈가 "무엇을" 가리키지만 "정확히 어떤 식으로"는 추론으로 채워야 하므로 T-DirectMap(S1)이 아니라 T-ConstraintReason.

## 난이도 티어

**T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(T2~T3 prior)지만 다음 구조적 피처가 T4로 민다:

- **constraint-reasoning + 소규모 refactor (S2+S6)**: 단일 파일이지만 3개 메서드를 상호 계약이 깨지지 않게 동시에 고쳐야 함. `__lt__`의 3-way 분기는 단순 None-guard보다 추론 부담이 큼 → T4의 "constraint추론·소규모 refactor 중 하나" 프로파일에 정확히 부합.
- **regression-trap (넓은 P2P)**: PASS_TO_PASS 32개 중 "Fields are ordered based on their creation."가 직접 트랩. 이슈 본문이 "ordered them by model first → one test broke"라고 명시적으로 경고. model-first 정렬로 짜면 이 P2P가 깨진다. 넓은 P2P trap은 T4의 추가 트리거.
- **has-repro**가 난이도를 낮추는 방향(L0와 결합해 localize는 거의 공짜)이지만, 픽스 합성의 추론 부담과 regression-trap이 더 강해 T3에 머무르지 않고 T4로 상승.

공식 라벨(개발자 구현시간)과 다른 이유: 시간라벨은 코드 줄수가 작아 짧게 잡히지만, 에이전트 관점에선 정렬 우선순위 트랩과 `hasattr` 가드 누락·`__hash__` 동시수정 일관성이 "줄수에 안 잡히는" 실패 표면이라 한 티어 위로 본다.

## 골드패치 분석

- **건드린 파일/함수**: `django/db/models/fields/__init__.py` → `Field.__eq__`, `Field.__lt__`, `Field.__hash__` (단일 파일, 3 메서드).
- **근본 원인**: 세 비교 연산자가 모두 `creation_counter` 단독을 identity 기준으로 삼음. abstract 모델의 단일 `Field` 인스턴스가 상속 시 각 구상 모델로 deepcopy되며 `creation_counter`를 그대로 물려받아, 서로 다른 모델의 필드가 동일 카운터 → 동등 비교·동일 해시로 충돌, set 중복 제거.
- **수정 요지**:
  - `__eq__`: `self.creation_counter == other.creation_counter` 에 더해 `getattr(self, 'model', None) == getattr(other, 'model', None)` 를 AND. `getattr(..., None)`으로 model 미바인딩 필드 안전 처리.
  - `__lt__`: (1) `creation_counter`가 다르거나 *양쪽 다 model 없으면* 종전대로 `creation_counter`로 비교(후방호환). (2) `hasattr(self,'model') != hasattr(other,'model')`이면 no-model 필드를 앞에(`return not hasattr(self, 'model')`). (3) 카운터 동률 + 양쪽 model 보유면 `(app_label, model_name)` 튜플로 tie-break.
  - `__hash__`: `hash(creation_counter)` → `hash((creation_counter, app_label or None, model_name or None))`. model 없으면 None 사용해 `__eq__` 계약과 일치.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_abstract_inherited_fields` — docstring "Field instances from abstract models are not equal."
- **동작**: 테스트가 `abstract=True`인 `AbstractModel`(field=IntegerField)과 이를 상속한 `InheritAbstractModel1/2`를 정의하고 `_meta.get_field('field')`로 세 필드를 꺼낸다.
  - **assertNotEqual 3쌍**: 추상↔상속1, 추상↔상속2, 상속1↔상속2 모두 비동등. 픽스 전엔 `creation_counter` 동일로 `==`였음 → `__eq__`의 model 조건 추가를 증명.
  - **assertLess 3쌍**: 추상 < 상속1 < 상속2 순서. 단, 추상 모델의 필드도 클래스 본문 정의 시 `contribute_to_class`가 호출되어 `self.model = AbstractModel`로 바인딩되므로 세 필드 모두 `.model`을 가진다(no-model 아님). 또한 상속 필드는 deepcopy되며 `creation_counter`를 보존해 세 필드의 카운터가 동률이다. 따라서 이 체인은 `__lt__`의 no-model-first 비대칭 분기(`hasattr` 불일치)를 전혀 타지 않고, 오직 카운터 동률 + 양쪽 model 보유 시의 `(app_label, model_name)` 튜플 분기로만 결정된다(알파벳순 `abstractmodel` < `inheritabstractmodel1` < `inheritabstractmodel2`). 즉 이 테스트가 증명하는 것은 tie-break 튜플 분기이며, no-model-first 분기는 본 테스트로 검증되지 않는 미커버 경로다.
  - **hash 3쌍 비동등**: `__hash__`가 model을 포함하도록 바뀐 것을 증명 → set 중복 제거 회귀 차단(원래 버그의 직접 표면).
- **overfit 관점 (`overfit-risk`)**: FAIL_TO_PASS가 1개뿐이고 한 시나리오(abstract 상속)만 직접 검증. 에이전트가 `__eq__`만 고치면 base `__eq__`가 model을 무시했던 것과 달리 assertNotEqual 3쌍은 전부 통과한다. 그러나 base `__lt__`가 `creation_counter` 단독 비교(`self.creation_counter < other.creation_counter`)이고 세 필드의 카운터가 동률이라, `__lt__`를 안 고치면 assertLess 3쌍이 모두 `False`가 되어 *1차로* 실패한다. 즉 `__lt__` 누락을 잡는 주된 게이트는 hash 단언이 아니라 assertLess 단언이다. hash 단언은 `__hash__` 누락에 한해 그것을 잡는다. 다만 `__lt__`의 totality(@total_ordering 일관성)는 이 테스트로 완전 검증되지 않아, special-case 정렬식으로도 통과 가능한 여지가 있다.
- **regression 관점 (`regression-trap`)**: PASS_TO_PASS의 "Fields are ordered based on their creation." (`BasicFieldTests`)가 model-first 정렬을 직접 금지. "Field instances can be pickled.", "Field.__hash__ 기반 set/dict 사용" 인접 동작들도 `__hash__` 변경에 민감 → creation_counter 우선·None-안전 해시를 유지해야 32개 P2P 전부 통과.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "fields only consider `self.creation_counter` when comparing for equality" + "adjust `__eq__` / `__hash__` / `__lt__`" 신호 → `Field` 클래스의 비교 dunder. `grep -n creation_counter django/db/models/fields/__init__.py`로 세 메서드 정의(L516 부근)에 즉시 도달. 추가 탐색 불필요(L0).
2. **픽스와 올바른 일반화인 이유**: identity를 `creation_counter` 단독에서 `(creation_counter, field.model)`로 확장. 이게 overfit이 아닌 이유 — 버그 근본은 deepcopy된 필드가 카운터를 공유하는 것이므로, 구분 키로 *소속 모델*을 추가하는 것은 abstract-상속뿐 아니라 임의의 동일-카운터 충돌 일반에 올바르다. `app_label`+`model_name` 튜플은 모델의 안정적 전역 identity라 적절한 일반화. `getattr/hasattr` 가드는 바인딩 전 필드까지 포괄해 special-case가 아님.
3. **regression 안전**: `__lt__`를 **반드시 creation_counter로 먼저 정렬**하고 동률일 때만 model로 tie-break해야 "Fields are ordered based on their creation."(P2P)가 보존된다. no-model 필드를 앞에 두는 규칙은 바인딩 전/후 필드 혼재 정렬을 안정화. `__hash__`는 `__eq__`와 동일 키 집합을 써야 해시 계약(`a==b ⇒ hash(a)==hash(b)`)이 유지되고 pickle/set 인접 P2P가 안 깨진다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `__lt__`를 model-first로 정렬 → 창제순 정렬 P2P 깨짐(이슈가 경고한 바로 그것). (b) `self.model` 직접 접근으로 바인딩 전 필드에서 `AttributeError` 회귀 → 반드시 `getattr(...,None)`/`hasattr` 가드. (c) `__eq__`만 고치고 `__hash__` 누락 → set 중복 제거 버그 잔존(@total_ordering이 `__eq__`/`__lt__`만 묶고 `__hash__`는 별도이므로 세 메서드 모두 손대야 함). 세 dunder의 상호 계약을 동시에 만족시키는지가 정답 여부를 가른다.
