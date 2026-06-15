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
---

# django__django-14238

## 문제 요약
`DEFAULT_AUTO_FIELD`를 `BigAutoField`/`SmallAutoField`의 **서브클래스**(예: `MyBigAutoField(models.BigAutoField)`)로 지정하면 Django가 `django.setup()` 단계에서 크래시한다. 모델 준비 시 `ValueError: Primary key '...MyBigAutoField' referred by DEFAULT_AUTO_FIELD must subclass AutoField`가 발생한다. 사용자는 `BigAutoField`를 상속한 커스텀 PK 필드가 당연히 `AutoField`로 인정되길 기대했지만, 직접적인 등록 클래스가 아닌 손자 클래스는 검사를 통과하지 못했다.

## 유형 분류
- 버그 카테고리: edge-case / logic (subclass 검사 누락)
- 서브시스템: django ORM model fields (`AutoFieldMeta` 메타클래스, `DEFAULT_AUTO_FIELD` 해석)
- 증상 타입: 예외 / 크래시 (`ValueError`로 앱 부팅 실패)
- 로컬라이제이션 신호: problem_statement 마지막 줄이 직접 범인을 지목한다 — "This can be fixed in `AutoFieldMeta.__subclasscheck__` by allowing subclasses of those classes in the `_subclasses` property." 또한 트레이스백의 `options._get_default_pk_class`가 `issubclass(pk_class, AutoField)` 검사를 호출하는 지점이다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` : `AutoFieldMeta.__subclasscheck__`
- 근본 원인: `__subclasscheck__`가 `subclass in self._subclasses`로 **멤버십(정확히 일치)** 검사를 했다. `_subclasses`는 `(BigAutoField, SmallAutoField)` 튜플이므로, `BigAutoField`를 상속한 `MyBigAutoField`는 튜플에 그 자체가 들어있지 않아 `False`가 되고, `super().__subclasscheck__`도 `AutoField`가 실제 베이스가 아니라 통과하지 못해 `issubclass(MyBigAutoField, AutoField)`가 거짓이 된다.
- 수정 요지: 한 글자 의미 변경 — `subclass in self._subclasses`를 `issubclass(subclass, self._subclasses)`로 교체. 이로써 `BigAutoField`/`SmallAutoField` **및 그 모든 후손**이 가상 `AutoField` 서브클래스로 인정된다. `isinstance` 경로(`__instancecheck__`)는 이미 `isinstance`를 쓰고 있어 손대지 않았다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_issubclass_of_autofield`: 기존 `BigAutoField`/`SmallAutoField`에 더해 새로 정의한 `MyBigAutoField`, `MySmallAutoField` 서브클래스까지 `issubclass(field, models.AutoField)`가 `True`임을 단언.
  - `test_default_auto_field_setting_bigautofield_subclass`: `DEFAULT_AUTO_FIELD='model_options.test_default_pk.MyBigAutoField'`로 설정하고 모델을 정의했을 때 `Model._meta.pk`가 `MyBigAutoField` 인스턴스가 되는지(=크래시 없이 PK 클래스로 채택) 확인.
- 픽스 증명: 패치 전이면 서브클래스에서 `issubclass`가 `False`라 첫 테스트가 실패하고, 두 번째는 `_get_default_pk_class`에서 `ValueError`로 터진다. 패치 후 `issubclass` 위임으로 둘 다 통과한다. `test_isinstance_of_autofield` 등 39개 PASS_TO_PASS는 기존 직접 클래스/인스턴스 동작이 회귀 없이 유지됨을 보증.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 `AutoFieldMeta.__subclasscheck__`와 `_subclasses`를 명시적으로 지목 — 곧장 `django/db/models/fields/__init__.py`의 `AutoFieldMeta` 메타클래스로 직행하면 된다. 트레이스백의 `options._get_default_pk_class` → `issubclass(... AutoField)`를 역추적해도 동일 지점에 도달.
- 함정/난이도 메모: `in` 멤버십과 `issubclass`의 의미 차이를 인지하는 게 핵심. `_subclasses`가 튜플이라는 점이 `issubclass(subclass, tuple)`이 그대로 동작하게 해준다(별도 루프 불필요). `__instancecheck__`까지 같이 고치고 싶은 유혹이 있지만 그쪽은 이미 `isinstance`라 불필요 — 과수정 주의. 단일 파일·단일 라인이라 멀티파일 위험은 없음.
- 우리 에이전트 관점: 위치는 쉽게 찾지만 "튜플 멤버십 → issubclass 위임"이라는 정확한 1라인 치환에 도달하지 못하고, `_subclasses`에 서브클래스를 동적으로 추가하거나 `__mro__`를 수동 순회하는 과한 해법으로 빠질 수 있다. 골드의 미니멀함을 재현하는 게 관건.
