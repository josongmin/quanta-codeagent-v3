---
instance_id: django__django-14238
repo: django/django
base_commit: 30e123ed351317b7527f632b3b7dc4e81e850449
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-04-08T10:41:31Z
fail_to_pass: 2
pass_to_pass: 39
gold_files: [django/db/models/fields/__init__.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-14238

## 문제 요약
`DEFAULT_AUTO_FIELD`를 `BigAutoField`/`SmallAutoField`의 **서브클래스**(예: `MyBigAutoField(models.BigAutoField)`)로 지정하면 Django가 `django.setup()` 단계에서 크래시한다. 모델 준비 시 `ValueError: Primary key '...MyBigAutoField' referred by DEFAULT_AUTO_FIELD must subclass AutoField`가 발생해 앱 부팅 자체가 실패한다. 사용자는 `BigAutoField`를 상속한 커스텀 PK 필드가 당연히 `AutoField`로 인정되길 기대했지만, `AutoFieldMeta._subclasses` 튜플에 직접 등록된 클래스가 아닌 손자 클래스는 가상 서브클래스 검사를 통과하지 못했다. problem_statement에 완전한 네이티브 스택트레이스와 재현 코드가 포함되어 있고, 마지막 줄이 픽스 지점(`AutoFieldMeta.__subclasscheck__`)까지 직접 명시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement 마지막 줄이 "This can be fixed in `AutoFieldMeta.__subclasscheck__` by allowing subclasses of those classes in the `_subclasses` property"라고 파일/메타클래스/메서드/프로퍼티를 전부 콕 집어준다. 스택트레이스의 `options._get_default_pk_class` → `issubclass(pk_class, AutoField)` 역추적도 같은 지점으로 수렴. grep 한 방.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나 올바른 식을 추론으로 합성해야 한다. `subclass in self._subclasses`(멤버십=정확히 일치)와 `issubclass(subclass, self._subclasses)`(파이썬 서브클래스 관계, 튜플 OR)의 **의미 차이**를 이해해야 정답에 도달한다. None가드/상수변경 같은 템플릿 매칭(S1)이 아니라, "가상 서브클래스를 어떻게 표현해야 후손까지 포함되는가"라는 불변식을 따져 1라인을 합성하는 SemFix/Angelix류 의미적 수리다.
- **K (Knowledge) = K-Domain**: 파이썬 일반지식만으로는 부족. `AutoFieldMeta`가 ABC 메타클래스로 `__subclasscheck__`/`__instancecheck__`를 오버라이드해 **가상 서브클래스 등록**을 흉내내는 django ORM 내부 메커니즘과, `DEFAULT_AUTO_FIELD` 해석 시 `_get_default_pk_class`가 `issubclass(.., AutoField)`를 호출한다는 도메인 배선을 알아야 한다.
- **Primary type = T-ConstraintReason**: 위치는 L0로 명확하나, 진짜 난점은 멤버십 검사를 `issubclass` 위임으로 바꾸는 의미적 추론(S2)에 있다. localize가 trivial이라 T-LocTrivial 후보지만, 픽스가 S1 기계적 가드가 아니라 검사 의미 자체를 재설계하는 추론이므로 T-ConstraintReason이 dominant. K-Domain이 보조 병목이나 단일 명확 픽스라 T-DomainBound까지 끌어올리진 않는다.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- **patch scope = 1파일·1라인** (`django/db/models/fields/__init__.py` 한 글자 수준 의미 치환) — ICLR 2024 컷에서 1파일·<5줄은 ~48% solve 구간.
- **L0 직접 localize**: 이슈가 파일·메서드·프로퍼티를 명시하고 픽스 방향("allowing subclasses")까지 적어준다.
- **has-repro**: 완전한 네이티브 스택트레이스 + 최소 재현 코드 존재 → ORACLE-SWE 기준 가장 강한 easiness 신호(repro 동반 시 해결률 ~87%).
- 단, **순수 T1은 아님**: 픽스가 S1 템플릿(가드 추가/상수 변경)이 아니라 `in`→`issubclass` 의미 추론(S2)이고, K-Domain(메타클래스 virtual-subclass 메커니즘)이 끼며, **regression-trap**(39개 P2P가 기존 직접 클래스/인스턴스 동작 보존 요구)이 있어 T1보다 한 단계 위.

공식 difficulty 라벨은 "15 min - 1 hour"(T3 prior에 해당). **본 분석은 T2로 한 단계 낮춘다** — 공식 라벨은 "개발자 구현시간"이고 테스트 작성·확인을 포함하지만, 에이전트 난이도 관점에서는 localize가 L0로 거의 공짜이고 픽스가 단일 라인이라 시간라벨이 과대평가한다. localize 어려움이나 overfit 위험이 없어(이슈가 일반 의도를 명시) 시간라벨 prior를 하향 조정하는 게 루브릭의 "구조피처 우선" 원칙에 부합.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/fields/__init__.py` 의 `AutoFieldMeta.__subclasscheck__`.
- **근본 원인**: `__subclasscheck__`가 `subclass in self._subclasses`로 **튜플 멤버십(정확히 일치)** 검사를 했다. `_subclasses`는 `(BigAutoField, SmallAutoField)` 튜플이라, `BigAutoField`를 상속한 `MyBigAutoField`는 튜플 원소와 정확히 같지 않아 `False`. `super().__subclasscheck__`도 `AutoField`가 `MyBigAutoField`의 실제 베이스(MRO 상)가 아니므로 통과 못 해 `issubclass(MyBigAutoField, AutoField)`가 거짓 → `_get_default_pk_class`가 `ValueError`를 던진다.
- **수정 요지**: `subclass in self._subclasses` → `issubclass(subclass, self._subclasses)`. `issubclass`의 2번째 인자에 튜플을 넘기면 OR로 해석되어 `BigAutoField`/`SmallAutoField` **및 그 모든 후손**이 가상 `AutoField` 서브클래스로 인정된다. 별도 루프·동적 등록 불필요. `__instancecheck__` 경로는 이미 `isinstance(instance, self._subclasses)`를 써서 인스턴스 측은 정상이었으므로 손대지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_issubclass_of_autofield (model_fields.test_autofield.AutoFieldInheritanceTests)`: 기존 `BigAutoField`/`SmallAutoField`에 더해 새로 정의한 `MyBigAutoField(BigAutoField)`, `MySmallAutoField(SmallAutoField)`까지 `issubclass(field, models.AutoField)`가 `True`임을 단언. 즉 직접 클래스와 손자 클래스 둘 다 커버.
  - `test_default_auto_field_setting_bigautofield_subclass (model_options.test_default_pk.TestDefaultPK)`: `DEFAULT_AUTO_FIELD='model_options.test_default_pk.MyBigAutoField'`로 설정하고 모델 정의 시 `Model._meta.pk`가 `MyBigAutoField` 인스턴스가 되는지(=크래시 없이 PK 클래스 채택) 확인. 이슈의 end-to-end 부팅 경로를 직접 재현.
- **픽스 증명**: 패치 전이면 서브클래스에서 `issubclass`가 `False`라 첫 테스트가 실패, 두 번째는 `_get_default_pk_class`에서 `ValueError`로 터진다. 패치 후 `issubclass` 위임으로 둘 다 통과.
- **overfit 관점**: FAIL_TO_PASS가 단순 멤버십이 아니라 **새로 정의한 서브클래스**를 명시적으로 테스트하므로 special-case(예: 하드코딩으로 `MyBigAutoField`만 추가)로는 통과 불가 — 일반 `issubclass` 위임을 강제한다. overfit 위험 낮음.
- **regression 관점**: 39개 PASS_TO_PASS가 직접 클래스/인스턴스 동작(`test_isinstance_of_autofield`, `test_default_auto_field_setting`, `test_default_auto_field_setting_non_auto`, `test_app_default_auto_field*`, 각종 `test_coercing`/`test_types`/`test_rel_db_type`)이 회귀 없이 유지됨을 보증. `issubclass`는 기존 멤버십이 참이던 모든 경우의 상위집합이라(직접 클래스 = 자기 자신의 서브클래스) 기존 통과를 깨지 않는다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement 마지막 줄("This can be fixed in `AutoFieldMeta.__subclasscheck__` ... `_subclasses` property")이 곧장 `django/db/models/fields/__init__.py`의 `AutoFieldMeta` 메타클래스로 직행시킨다. 힌트가 없어도 스택트레이스의 `options._get_default_pk_class` → `issubclass(.., AutoField)` 호출을 역추적하면 `AutoField`의 메타클래스 `AutoFieldMeta.__subclasscheck__`에 도달.
2. **픽스와 일반화 근거**: `subclass in self._subclasses`(정확히 일치 멤버십)를 `issubclass(subclass, self._subclasses)`로 교체. 이게 overfit이 아닌 올바른 일반화인 이유 — 사용자가 기대하는 의미는 "`BigAutoField`/`SmallAutoField`를 상속한 **모든** 필드는 AutoField로 취급"이고, `issubclass(x, tuple)`이 정확히 그 도메인 의도(임의 깊이 후손 포함)를 표현한다. 특정 클래스만 `_subclasses`에 추가하는 해법은 다음 서브클래스에서 또 깨지므로 일반화 실패.
3. **regression 안전**: 직접 등록 클래스는 `issubclass(C, (C, ...))`가 항상 참이라 기존 멤버십 통과 케이스를 모두 포함 — `test_isinstance_of_autofield`, `test_default_auto_field_setting*`, `test_app_default_auto_field*` 등 39 P2P가 안전. `__instancecheck__`는 이미 `isinstance` 기반이라 건드리면 안 됨(불필요 변경 = 회귀 표면 확대).
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) **과수정**: `_subclasses`에 서브클래스를 동적 등록하거나 `__mro__`를 수동 순회하는 장황한 해법으로 빠짐. 골드는 `issubclass`가 튜플을 그대로 받는다는 점을 활용해 1라인으로 끝낸다. (b) `__instancecheck__`까지 같이 손대는 유혹 — 그쪽은 이미 `isinstance`라 불필요, 변경 시 regression 표면만 늘림. (c) `in`과 `issubclass`의 의미 차이를 놓치고 멤버십 그대로 두면 손자 클래스가 영영 안 잡힘. 핵심은 **골드의 미니멀함(단일 라인, 위임)을 재현**하는 것.
