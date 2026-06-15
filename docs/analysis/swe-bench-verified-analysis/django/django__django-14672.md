---
instance_id: django__django-14672
repo: django/django
base_commit: 00ea883ef56fb5e092cbe4a6f7ff2e7470886ac4
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-07-20T10:47:34Z
fail_to_pass: 168
pass_to_pass: 0
gold_files: [django/db/models/fields/reverse_related.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro]
---

# django__django-14672

## 문제 요약
Django 3.2에서 `ForeignObjectRel`에 `identity` property가 추가돼 rel 객체끼리 비교·해시가 가능해졌다. `identity`는 tuple이고 `__hash__`가 `hash(self.identity)`로 동작하므로, 해시 가능하려면 tuple의 모든 원소가 hashable이어야 한다. 부모 `ForeignObjectRel.identity`는 `limit_choices_to`를 `make_hashable`로 감싸 list/dict도 해시 가능하게 만들어 둔다. 그런데 `ManyToManyRel.identity`는 `self.through_fields`를 raw로 끼워 넣는다. 사용자가 `through_fields=['child', 'parent']`처럼 list로 지정하면 tuple 안에 list가 들어가 `hash()` 호출 시 `TypeError: unhashable type: 'list'`로 크래시한다. 증상은 proxy 모델 체크 경로(`_check_field_name_clashes`의 `if f not in used_fields:` set 멤버십 검사)에서 드러나며, `manage.py check`가 통째로 터진다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement 제목 자체가 `"Missing call make_hashable on through_fields in ManyToManyRel"`로 파일·클래스·심볼·누락된 호출까지 전부 지목한다. 트레이스백 마지막 프레임이 `reverse_related.py` line 140 `__hash__ → return hash(self.identity)`. grep 한 방으로 `ManyToManyRel.identity`에 직행. 탐색 비용 0.
- **S (Repair Strategy) = S1 (Direct-Map / template)**: 이슈가 "Solution: Add missing make_hashable call on self.through_fields"라고 픽스를 사실상 명세한다. 결함클래스는 "동종 컬렉션 인자 중 하나만 hashable 정규화 누락" — 부모 클래스가 `limit_choices_to`에 이미 적용한 `make_hashable` 관용구를 형제 필드에 복사하는 기계적 매핑이다. 추론으로 식을 합성(S2)할 필요 없이 기존 패턴을 그대로 따라 붙이면 끝나므로 Direct-Map이 dominant. 새 후보를 여러 개 생성·검증할 여지가 없어 S3/S4 아님.
- **K (Knowledge) = K-Domain**: 픽스 자체는 한 줄이지만, "왜 여기서 이게 hashable해야 하는가"를 이해하려면 django의 `identity`/`__hash__` 계약, `make_hashable` 유틸의 존재와 의도, `ForeignObjectRel` 상속 계층(`ManyToManyRel`이 `ForeignObjectRel`의 `identity`를 `super().identity + (...)`로 확장한다는 점)이라는 ORM 내부 지식이 필요하다. 일반 파이썬 추론만으론 "raw로 두면 왜 안 되는지"를 알기 어렵다. 단 공개 API 시그니처/하위호환을 손대지 않으므로 K-API는 아님.
- **primary type = T-DirectMap**: 위치가 L0로 명확하고 픽스가 S1 기계적 매핑(부모의 `make_hashable` 가드를 그대로 적용)이라, 루브릭의 "위치 명확 + S1 기계적 픽스(가드 추가)" 정의에 정확히 부합. has-repro 신호가 강하지만 이슈가 픽스를 거의 적어줄 정도는 아니고(도메인 맥락은 읽어야 함) S1 가드 추가가 본질이라 T-LocTrivial보다 T-DirectMap이 정확하다.

## 난이도 티어 — **T2 (쉬움)**
이 문제를 T2로 미는 구조적 피처:
- **단일 파일·단일 라인 변경**: gold는 `reverse_related.py` 한 파일에서 `self.through_fields,` → `make_hashable(self.through_fields),` 1줄. 구조컷(1파일·<5줄 ≈ 48% solve)의 가장 쉬운 구간.
- **L0 + has-repro**: 이슈가 파일·심볼·해결책을 직접 주고 네이티브 스택트레이스와 최소 재현 모델까지 동봉 — repro는 가장 강한 easiness 신호(해결률 ~87%).
- **S1 가드 추가**: 정형 결함클래스(컬렉션 hashable 정규화)에 부모 클래스 관용구를 복사하는 템플릿 매칭.
- **regression-trap 약함**: PASS_TO_PASS=0이고 변경이 identity 계산 시점의 hashable화에 국한 — 인접 동작을 깨뜨릴 표면이 좁다.

T1이 아닌 이유: 이슈가 픽스를 "거의 적어주긴" 하지만, 올바른 일반화(원본 `through_fields` 보존 + identity 시점에만 hashable화)를 하려면 `make_hashable`의 의도와 상속 계층을 읽어야 하는 K-Domain 비용이 있다. 순수 K-Gen·자명픽스인 T1보다 한 칸 위.

공식 라벨(`15 min - 1 hour`)과의 차이: 공식은 "개발자 구현시간" prior로, 도메인 맥락 파악 + 테스트 추가까지 포함해 T3 하단처럼 보일 수 있다. 그러나 에이전트 난이도 축(localize 직접성·repro·patch scope)에서는 L0·has-repro·1라인이라 더 쉬운 T2가 방어 가능하다. localize 어려움이 0이고 overfit 위험이 거의 없어 시간라벨이 과대평가된 케이스.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/reverse_related.py` — `ManyToManyRel.identity` (property).
- **근본 원인**: `ManyToManyRel.identity`는 `super().identity + (self.through, self.through_fields, self.db_constraint)`로 부모 tuple을 확장한다. 부모 `ForeignObjectRel.identity`는 `limit_choices_to`를 `make_hashable`로 감싸 hashable 불변식을 유지하지만, `ManyToManyRel`이 추가한 `through_fields`는 raw로 들어간다. `through_fields`는 list로 지정될 수 있고(`['child', 'parent']`), 그러면 `identity` tuple이 unhashable list를 품게 돼 `__hash__ → hash(self.identity)`가 `TypeError`로 깨진다. 즉 "부모가 세운 hashable 불변식을 서브클래스가 확장하면서 깬" 누락 결함.
- **수정 요지**: `identity` property에서 `self.through_fields,` 한 줄을 `make_hashable(self.through_fields),`로 교체. `make_hashable`이 list를 (재귀적으로) tuple로 변환해 identity 전체가 다시 hashable해진다. 원본 `self.through_fields` 속성은 그대로 보존되고 identity 계산 시점에만 정규화되므로 다른 소비처에 영향이 없다. `make_hashable`은 동일 모듈에서 이미 import·사용 중이라 추가 import도 불필요.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작 (168개)**: 핵심 신규 테스트는 두 개다.
  - `m2m_through.tests.M2mThroughTests.test_reverse_inherited_m2m_with_through_fields_list_hashable`: `m2m_through/models.py`의 `Event.invitees` M2M `through_fields`를 tuple `('event','invitee')` → list `['event','invitee']`로 바꾸고 `PersonChild(Person)` 상속 모델을 추가한 뒤, `Person`과 상속받은 `PersonChild`의 reverse field `events_invited`를 꺼내 `through_fields == ['event','invitee']`임을 확인하고 결정적으로 `hash(reverse_m2m) == hash(inherited_reverse_m2m)`를 단언한다. 픽스 전이면 `hash()` 호출 자체가 `TypeError`로 터진다 (재현 입력 → 기대 출력: 예외 없이 두 rel 해시 동일).
  - `invalid_models_tests.test_models.ShadowingFieldsTests.test_field_name_clash_with_m2m_through`: `through_fields=['parent','model']` list를 쓴 모델에서 `Child.check()`가 크래시 없이 정확히 하나의 `models.E006`(필드 충돌) Error를 반환하는지 검사 — `_check_field_name_clashes`의 `if f not in used_fields:`(set 멤버십, 내부적으로 `__hash__` 사용) 경로가 살아 있음을 증명.
- **픽스 증명**: 두 테스트 모두 list형 `through_fields`를 가진 모델을 정의하고 해시/체크 경로를 직접 통과시킨다. 픽스 후엔 `make_hashable`로 list가 tuple화돼 해시가 성립하고 같은 identity면 같은 해시가 보장된다.
- **F2P가 168개로 폭증한 이유 (overfit 관점)**: `m2m_through/models.py`의 `Event` 정의(이제 list `through_fields`)가 모듈 import 시점에 평가되므로, 픽스 전엔 이 테스트 모듈을 import하는 거의 모든 테스트가 collection 단계에서 동반 실패한다. 따라서 F2P가 얇지 않고 오히려 모듈 전체를 게이트한다 — special-case로 통과시키는 식의 overfit이 사실상 불가능하다(import-time 해시가 무조건 깨지므로). 좁은 `make_hashable` 정규화 외의 우회로는 collection 자체를 살릴 수 없다.
- **regression 관점**: PASS_TO_PASS=0. 변경이 identity 계산 시점에만 list→tuple 정규화를 추가하고 원본 속성·동등성 의미를 보존하므로, tuple로 이미 넘기던 기존 호출은 `make_hashable`이 tuple을 그대로 통과시켜 byte-동등. 인접 회귀 표면이 좁다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 제목 `"Missing call make_hashable on through_fields in ManyToManyRel"`이 클래스·심볼·누락 호출을 직접 지목 → `reverse_related.py`에서 `class ManyToManyRel` → `identity` property로 직행. 트레이스백 마지막 프레임(`__hash__ → return hash(self.identity)`)이 hashable 불변식이 깨지는 지점을 확정해 준다. 부모 `ForeignObjectRel.identity`를 함께 읽어 `make_hashable(self.limit_choices_to)` 관용구가 이미 있음을 확인.
2. **픽스와 올바른 일반화**: `identity` 안에서 `self.through_fields,`를 `make_hashable(self.through_fields),`로 교체. 이게 올바른 일반화인 이유 — 부모가 `limit_choices_to`에 세운 "identity 원소는 hashable"이라는 불변식을 서브클래스가 동일 유틸로 따르는 것이라 국소적이지 않고 **정합적**이다. `make_hashable`은 이미 tuple/scalar는 그대로 통과시키므로 list가 아니어도 안전. 원본 `self.through_fields`는 손대지 않아 직렬화·동등성 등 다른 소비처가 영향받지 않는다.
3. **regression 안전**: P2P가 비어 있어도 실질 회귀면은 "tuple `through_fields`를 쓰던 기존 모델들의 identity/hash 동등성". `make_hashable`이 tuple을 항등 통과시키므로 기존 해시·동등 의미가 보존된다. identity 비교(`__eq__`)도 동일 변환을 거치므로 list와 tuple이 섞여도 일관. 깨면 안 되는 건 m2m_through 모듈의 대량 기존 테스트들인데, 이들은 모듈 import만 성공하면 정상 통과한다.
4. **함정 회피 (오라클 없는 에이전트가 어디서 틀릴지)**: (a) **over-engineering** — `through_fields`를 생성자에서 tuple로 영구 정규화하거나 `__hash__`/`__eq__`를 손대면 골드와 어긋나고 직렬화/마이그레이션 비교 등에서 회귀를 부른다. 정답은 identity 계산 시점에만 hashable화. (b) **import 누락 오판** — `make_hashable`이 동일 모듈에 이미 import돼 있음을 확인 안 하고 중복 import하거나, 반대로 없다고 가정하고 인라인 변환 코드를 짜는 실수. (c) **잘못된 위치** — `through` 등 다른 인자까지 무차별로 감싸기. 누락된 건 list가 될 수 있는 `through_fields` 하나뿐이다. (d) **단서가 너무 명확해서 의심하다가 범위 확대** — 부모 클래스의 `make_hashable` 관용구를 그대로 미러링하는 게 최소·정답 변경임을 신뢰하는 것이 핵심.
