---
instance_id: django__django-14915
repo: django/django
base_commit: 903aaa35e5ceaa33bfc9b19b7f6da65ce5a91dd4
version: 4.1
difficulty: <15 min fix
created_at: 2021-09-29T22:00:15Z
fail_to_pass: 1
pass_to_pass: 23
gold_files: [django/forms/models.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Gen
flags: [has-repro]
---

# django__django-14915

## 문제 요약
Django 3.0 → 3.1 마이그레이션 후, select 위젯 옵션에 커스텀 `data-*` 속성을 추가하는 사용자 코드가 `TypeError: unhashable type: 'ModelChoiceIteratorValue'`로 깨졌다. 3.1부터 `create_option`에 넘어오는 `value`가 raw pk가 아니라 `ModelChoiceIteratorValue` 래퍼 객체인데, 이 객체가 `__eq__`만 정의하고 `__hash__`는 없어서, dict 키 멤버십 검사(`value in {1: [...]}`)처럼 해시가 필요한 경로에서 실패한다. 사용자가 든 대비가 결정적이다 — 배열 멤버십(`value in [1, 2]`)은 동작하고 dict 멤버십만 깨진다. 즉 `__eq__`-기반 선형탐색(list)은 되지만 해시-기반 탐색(dict/set)은 안 된다 → 원인이 hashability임을 정확히 가리킨다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement 제목에 `ModelChoiceIteratorValue is not hashable`로 클래스명이 박혀 있고 "unhashable type"이 그대로 나온다. grep 한 방으로 `django/forms/models.py`의 단일 클래스로 직행. 탐색 노력 사실상 0.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1)**: 고칠 지점은 자명하나, 픽스의 정확성은 "무엇으로 위임할지"를 hash/eq 계약으로 추론해야 결정된다. `__eq__`가 `self.value` 기준으로 동등성을 판정하므로 `__hash__`도 반드시 `self.value` 기준이어야 한다(Python 데이터모델 불변식: `a == b ⇒ hash(a) == hash(b)`). 단순히 "`__hash__` 하나 추가"는 S1처럼 보이지만, `id(self)`/`super().__hash__()`/`hash((value, instance))` 같은 그럴듯한 오답이 모두 계약을 깬다는 점에서 본질은 올바른 식 합성(S2)이다. 헌트가 정답식을 적어줘 기계적 측면(S1)이 보조로 붙는다.
- **K (Knowledge) = K-Gen**: 필요한 지식은 django 내부가 아니라 일반 Python 규칙 — "`__eq__`를 정의하면 상속된 `__hash__`가 `None`으로 설정되어 unhashable이 된다", 그리고 hash/eq 일관성 계약. ORM·query-compiler·migrations 같은 도메인 지식 불필요.
- **Primary type = T-ConstraintReason**: 위치는 명확(L0)하지만 난점이 "어디"가 아니라 "올바른 hash 식을 eq와 정합하게 합성"하는 데 있다. 루브릭의 T-ConstraintReason("위치 명확하나 S2로 올바른 식·조건을 추론 합성")에 정확히 들어맞는다. T-DirectMap이 아닌 이유: 픽스가 None-가드/기본값/상수 변경 같은 정형 결함클래스 템플릿 매칭이 아니라, eq와의 정합을 따져야 하는 의미적 결정이기 때문.

## 난이도 티어
**Tier = T2 (쉬움)**. 공식 라벨도 "<15 min fix"로 일치한다.

이 티어로 미는 구조적 피처:
- **patch scope 극소**: 1파일, 순추가 3줄(메서드 1개). ICLR 2024 컷에서 "1파일·<5줄 ≈ 48% solve"의 가장 쉬운 구간.
- **localize 직접성 L0**: 클래스명이 제목에 박혀 있어 localization 에러(실패의 ~51%) 위험이 사실상 없다.
- **has-repro**: 트리거 코드(`create_option` + dict 멤버십)와 정확한 예외 메시지가 본문에 있다. repro 존재는 가장 강한 easiness 신호(~87% 해결).
- **P2P trap 약함**: PASS_TO_PASS 23개가 전부 같은 테스트클래스(`ModelChoiceFieldTests`)에 국한되고, 순추가 메서드라 기존 동작을 건드리지 않아 regression-trap 플래그 미부여.

T1(존나쉬움)이 아니고 T2인 이유: 픽스가 "이슈가 거의 적어준" 자명한 한 줄(T1 프로파일, S1)이라기엔, hash 위임 대상을 eq와 맞춰야 하는 S2 추론 한 겹이 있다. 오라클(헌트)이 정답식을 적어줘서 실제론 매우 쉽지만, 오라클 없는 에이전트에겐 `id(self)`/튜플 hash 같은 오답이 통과 테스트를 깨므로 T1보다 한 단 위.

## 골드패치 분석
- **건드린 파일·함수**: `django/forms/models.py` — `ModelChoiceIteratorValue.__hash__` 신규 추가(`__str__`과 `__eq__` 사이).
- **근본 원인**: Python은 클래스가 `__eq__`를 정의하면 상속받은 `object.__hash__`를 자동으로 `None`으로 설정해 인스턴스를 unhashable로 만든다. `ModelChoiceIteratorValue`는 3.1에서 `__eq__`만 추가했으므로 dict 키 비교·set 멤버십 등 해시가 필요한 모든 경로가 `TypeError: unhashable type`로 깨졌다. 사용자가 본 배열 OK/dict 깨짐 대비가 이 원인의 직접 증거다.
- **수정 요지**:
  ```python
  def __hash__(self):
      return hash(self.value)
  ```
  내부 `self.value`로 위임. `__eq__`가 `self.value`(필요시 상대도 `ModelChoiceIteratorValue.value`로 언랩) 기준으로 동등성을 판정하므로, hash도 동일 기준으로 맞춰 `a == b ⇒ hash(a) == hash(b)` 계약을 보존한다. `instance` 인자는 동등성·해시에 무관(value만 의미 캐리어)하므로 hash에서 의도적으로 제외.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_choice_value_hash` — `tests/model_forms/test_modelchoicefield.py`.
  - 동작: `ModelChoiceIteratorValue(self.c1.pk, self.c1)`의 hash가 `ModelChoiceIteratorValue(self.c1.pk, None)`의 hash와 **같음**을 단언 → `instance` 인자는 hash에 무관, `value`(pk)만 좌우함을 증명(위임 정확성). 동시에 서로 다른 pk(c1 vs c2)는 hash가 **다름**을 단언 → 상수 반환이나 무의미한 위임을 배제.
  - 픽스 증명: 픽스 전엔 `hash(value_1)` 호출 자체가 `TypeError`로 죽어 RED. 픽스 후 `__hash__`가 정의되어 호출 가능 + 위 두 단언 통과.
- **overfit 관점**: 테스트가 얇긴 하지만(`FAIL_TO_PASS` 1개), 두 방향 단언(같은 value→같은 hash / 다른 value→다른 hash)이 `id(self)` 반환(다른 인스턴스 같은 pk에서 첫 assertEqual 실패)과 상수 반환(둘째 assertNotEqual 실패)을 모두 잡아낸다. 정답식이 사실상 유일하게 강제되므로 overfit 위험 낮음 → overfit-risk 플래그 미부여.
- **regression 관점**: 순추가 메서드라 기존 23개 P2P가 손대지 않는 경로를 그대로 유지한다. `__hash__` 추가가 `__eq__`/`__str__` 동작을 바꾸지 않으므로 위젯 렌더링·choices 관련 테스트 회귀 없음.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement 제목 `ModelChoiceIteratorValue is not hashable` + 예외 메시지 `unhashable type: 'ModelChoiceIteratorValue'`에서 클래스명을 grep → `django/forms/models.py`의 `class ModelChoiceIteratorValue` 단일 정의로 직행. `__eq__`는 있고 `__hash__`는 없음을 즉시 확인. 증상은 사용자 `create_option`에서 났지만 한 단계 거슬러 래퍼 클래스가 진짜 원인임을 판단.
2. **픽스와 일반화 근거**: `__hash__`를 추가하되 반드시 `__eq__`와 같은 키(`self.value`)로 위임 — `return hash(self.value)`. 이게 올바른 일반화인 이유: Python 데이터모델이 요구하는 `a == b ⇒ hash(a) == hash(b)`를 만족시키기 때문. `__eq__`가 value로 비교하므로 hash도 value로 둬야 dict/set에서 일관되게 동작한다. 이건 "dict 멤버십만 통과시키는" 특수해가 아니라, 해시 기반 컬렉션 전체에서 올바른 보편 동작.
3. **regression 안전**: 순추가이므로 P2P 23개(전부 `ModelChoiceFieldTests`: `test_basics`, `test_choices*`, `test_clean_*`, `test_disabled_*` 등) 중 어느 것도 깨지 않아야 하고, `__hash__`가 기존 `__eq__`/`__str__`/렌더링 경로를 건드리지 않으니 자연히 안전. 핵심은 기존 메서드를 수정하지 말고 새 메서드만 추가하는 것.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) hash를 `id(self)`/`object.__hash__`/`hash((self.value, self.instance))`로 위임하면 "다른 instance, 같은 pk"에서 hash가 갈려 첫 assertEqual에서 fail. eq가 value-only임을 읽고 hash도 value-only로 맞춰야 함. (b) 증상 위치인 사용자 `create_option`이나 호출부를 고치려는 유혹 — 진짜 원인은 래퍼 클래스의 hashability이므로 클래스 자체를 고쳐야 함. (c) 상수 hash 반환은 동작은 하지만 둘째 assertNotEqual에서 fail(그리고 해시 충돌로 성능 저하). value 위임이 유일한 정답.
