---
instance_id: django__django-11999
repo: django/django
base_commit: 84633905273fc916e3d17883810d9969c03f73c2
version: "3.1"
difficulty: 15 min - 1 hour
created_at: 2019-10-31T10:39:18Z
fail_to_pass: 1
pass_to_pass: 30
gold_files: [django/db/models/fields/__init__.py]
---

# django__django-11999

## 문제 요약
Django 2.2 이상에서 모델에 `get_FOO_display()` 메서드를 직접 정의해 오버라이드해도 무시되고, 항상 choices 기반 자동생성 메서드가 호출된다. 2.1에서는 사용자가 정의한 `get_foo_bar_display()`가 `"something"`을 반환했지만 2.2+에서는 choices 값('foo'/'bar')이 반환된다. 사용자는 자신이 모델에 정의한 메서드가 자동생성 메서드를 이기길 기대한다.

## 유형 분류
- 버그 카테고리: regression (커밋 a68ea231012434b522ce45c513d84add516afa60에서 유입) + 누락처리(기존 속성 존재여부 미검사)
- 서브시스템: django ORM / model fields (`Field.contribute_to_class`)
- 증상 타입: silent-wrong (예외 없이 사용자 정의 메서드가 조용히 덮어써짐)
- 로컬라이제이션 신호: `get_FIELD_display`, "version 2.2", choices라는 키워드 → choices가 있을 때 `get_<name>_display`를 무조건 `setattr`하는 코드. hints에 regression 커밋 SHA까지 명시되어 `Field.contribute_to_class()`로 바로 좁혀진다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` : `Field.contribute_to_class`
- 근본 원인: `self.choices is not None`이면 무조건 `setattr(cls, 'get_%s_display' % self.name, partialmethod(cls._get_FIELD_display, field=self))`를 실행했다. 필드 기여 시점이 클래스 본문 속성 처리보다 (또는 선언 순서에 따라) 나중이면 사용자가 정의한 동명 메서드를 자동생성 partialmethod로 덮어쓴다. 2.1의 "정상 동작"조차 선언 순서에 의존하는 우연이었다.
- 수정 요지: `setattr` 앞에 `if not hasattr(cls, 'get_%s_display' % self.name):` 가드를 추가. 이미 클래스(또는 상위 클래스)에 `get_<name>_display`가 존재하면 자동생성을 건너뛰어 사용자 정의 메서드를 보존한다. 단 두 줄짜리 가드로 선언 순서 의존성을 제거.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_overriding_FIELD_display (model_fields.tests.GetFieldDisplayTests)`
- 테스트는 `foo_bar = IntegerField(choices=[(1,'foo'),(2,'bar')])`를 가진 `FooBar` 모델을 정의하면서 `get_foo_bar_display(self)`를 직접 구현해 `'something'`을 반환하게 한다. 재현 입력 `FooBar(foo_bar=1).get_foo_bar_display()`가 기대 출력 `'something'`이어야 한다. 픽스 전에는 choices 자동생성 메서드가 덮어써 `'foo'`를 반환하므로 실패하고, `hasattr` 가드 적용 후 사용자 메서드가 보존되어 `'something'`을 반환한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `get_FIELD_display` 자동생성 지점을 grep → `Field.contribute_to_class` 내 `partialmethod(cls._get_FIELD_display, ...)`. hints의 regression 커밋이 결정적 단서.
- 함정/난이도 메모: `_get_FIELD_display`(Model 메서드)를 건드리는 오답 유혹이 있다. hints에도 명시되듯 `contribute_to_class`에서 순서를 뒤집는 식의 수정은 pass/fail이 선언 순서에 따라 단순 반전될 뿐이라 불안정하다. 정답은 "덮어쓰기 전 존재여부 검사"라는 멱등 가드. 단일 파일, 두 줄 수정으로 끝나지만 *왜* 그게 안정적인지(상위 클래스 상속 메서드도 hasattr로 잡힘)를 이해해야 한다.
- 우리 에이전트 관점: 증상 재현은 쉽지만 "사용자 메서드를 보존"이라는 의도를 `_get_FIELD_display` 쪽 분기 로직으로 풀려다 과복잡해질 수 있다. 최소 가드 패턴을 선택하는 절제가 관건이며, `hasattr`가 상속 메서드까지 포함한다는 점이 부작용 없는 핵심.
