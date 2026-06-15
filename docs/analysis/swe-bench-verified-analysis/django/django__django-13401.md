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
---

# django__django-13401

## 문제 요약
추상(abstract) 모델 `A`를 상속한 두 구상 모델 `B`, `C`가 같은 필드 `myfield`를 상속하면, `B._meta.get_field('myfield')`와 `C._meta.get_field('myfield')`가 서로 다른 모델 소속임에도 `==`로 동등하게 비교된다. 그 결과 `set`에 함께 넣으면 하나가 중복 제거되어 사라진다. 사용자는 모델이 다르면 필드도 서로 다른 것으로 취급되길 기대했다. 근본 원인은 `Field.__eq__`가 `self.creation_counter`만 보고 비교하기 때문이다.

## 유형 분류
- 버그 카테고리: API-contract (equality/hash 의미론 결함) / edge-case (추상 모델 상속)
- 서브시스템: django ORM / model fields (`Field` 비교 연산자)
- 증상 타입: silent-wrong (예외 없이 set 중복 제거로 데이터가 조용히 사라짐)
- 로컬라이제이션 신호: problem_statement이 "fields only consider `self.creation_counter` when comparing for equality"와 "adjust `__eq__` / `__hash__` / `__lt__`"를 직접 명시 → `Field` 클래스의 비교 dunder 3종이 곧 타겟. `creation_counter`로 grep하면 `django/db/models/fields/__init__.py`로 바로 수렴.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` → `Field.__eq__`, `Field.__lt__`, `Field.__hash__`
- 근본 원인: 세 비교 연산자가 모두 `creation_counter`만 기준으로 삼음. 추상 모델의 단일 필드 인스턴스가 상속 시 각 구상 모델로 deepcopy되면서 `creation_counter`를 그대로 물려받아, 서로 다른 모델의 필드가 동일 카운터를 갖게 됨 → 동등/동일 해시로 충돌.
- 수정 요지:
  - `__eq__`: `creation_counter` 일치에 더해 `getattr(self, 'model', None) == getattr(other, 'model', None)` 조건을 AND로 추가 (model 미바인딩 필드 안전하게 처리).
  - `__lt__`: 후방 호환을 위해 **먼저 `creation_counter`로 정렬**. 카운터가 같고 둘 다 model이 있을 때만 `(app_label, model_name)` 튜플로 tie-break. model 보유 여부가 다르면 no-model 필드를 앞에 둠.
  - `__hash__`: `creation_counter` 단독에서 `(creation_counter, app_label, model_name)` 튜플 해시로 변경 (model 없으면 None 사용).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_abstract_inherited_fields` ("Field instances from abstract models are not equal.")
- 테스트가 어떻게 픽스를 증명하는지: 테스트 내부에서 `abstract=True`인 `AbstractModel`과 이를 상속한 `InheritAbstractModel1/2`를 정의하고 각각의 `field`를 꺼낸다.
  - 재현 입력 → 기대 출력: 추상 필드와 두 상속 필드, 그리고 두 상속 필드끼리 `assertNotEqual` (동등하지 않아야 함). 픽스 전에는 `creation_counter`가 같아 `==`였음.
  - `assertLess`로 추상(no/abstract model) < 상속1 < 상속2 순서를 확인해 `__lt__`의 model tie-break 정렬을 검증.
  - `hash()` 3쌍이 모두 다름을 확인해 `__hash__`가 model을 포함하도록 바뀐 것을 검증 (→ set 중복 제거 회귀 차단).

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `Field` 클래스의 `__eq__`/`__lt__`/`__hash__` 세 메서드만 보면 됨. `creation_counter` grep → `fields/__init__.py` 단일 파일.
- 함정/난이도 메모:
  - `__lt__`를 model 우선으로 정렬하면 다른 테스트가 깨진다(problem_statement이 직접 경고). 반드시 `creation_counter` 우선 정렬을 유지하고 동률일 때만 model로 tie-break해야 함 — 정렬 우선순위를 뒤집는 게 가장 흔한 함정.
  - `model` 속성이 항상 존재하지 않음 (바인딩 전 필드). `getattr(..., 'model', None)` / `hasattr` 가드 없이 `self.model`에 접근하면 `AttributeError` 회귀.
  - `@total_ordering`이 걸려 있어 `__eq__`/`__lt__` 둘 다 일관되게 고쳐야 하고, `__hash__`도 같이 안 고치면 set 중복 제거 버그가 남는다 (세 메서드 동시 수정 필수, 단일 파일이지만 멀티 메서드).
- 우리 에이전트 관점: 막힐 지점은 (1) `__lt__`에서 정렬 우선순위 — model-first로 짜면 PASS_TO_PASS의 "Fields are ordered based on their creation."가 깨진다, (2) model 미바인딩 케이스의 가드 처리 누락, (3) `__hash__`를 빠뜨려 `__eq__`만 고치고 set 동작이 여전히 틀리는 부분 일관성. 세 메서드의 상호 계약을 동시에 만족시키는지가 핵심.
