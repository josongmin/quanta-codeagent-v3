---
instance_id: django__django-17087
repo: django/django
base_commit: 4a72da71001f154ea60906a2f74898d32b7322a7
version: 5.0
difficulty: <15 min fix
created_at: 2023-07-17T20:28:41Z
fail_to_pass: 1
pass_to_pass: 53
gold_files: [django/db/migrations/serializer.py]
---

# django__django-17087

## 문제 요약
중첩 클래스(nested class)에 정의된 classmethod를 `Field.default`로 사용하면 makemigrations가 잘못된 참조 경로를 생성한다. 예를 들어 `Profile.Capability.default` 가 마이그레이션 파일에 `appname.models.Capability.default` 로 직렬화되어, 바깥 클래스 `Profile`이 경로에서 빠진다. 사용자는 마이그레이션이 `appname.models.Profile.Capability.default` 로 직렬화되어 import 가능한 올바른 경로가 나오길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (중첩 클래스 한정 직렬화 누락)
- 서브시스템: django migrations serializer (FunctionTypeSerializer)
- 증상 타입: 잘못된 출력 (생성된 마이그레이션 코드가 import 불가능 → 후속 migrate 시 크래시)
- 로컬라이제이션 신호: "default 인자가 잘못된 값으로 직렬화됨", classmethod를 default로 사용, 마이그레이션 직렬화 결과의 경로 누락 → migrations serializer의 bound-method 직렬화 경로

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/serializer.py` : `FunctionTypeSerializer.serialize`
- 근본 원인: bound classmethod를 직렬화할 때 소속 클래스 이름을 `klass.__name__` 으로 가져왔다. `__name__` 은 중첩 위치를 반영하지 못하고 마지막 클래스 이름(`Capability`)만 주므로, 바깥 클래스(`Profile`)가 경로에서 사라진다.
- 수정 요지: 단 한 글자급 변경 — `klass.__name__` 을 `klass.__qualname__` 으로 교체. `__qualname__` 은 `Profile.Capability` 같은 정규화된 점-경로를 담고 있어 `module.Profile.Capability.default` 형태의 import 가능한 참조가 생성된다. 최상위 클래스에서는 `__qualname__ == __name__` 이라 기존 동작과 동일(회귀 없음).

## 검증 (test_patch)
- FAIL_TO_PASS: `WriterTests.test_serialize_nested_class_method`
- 테스트 픽스처 `NestedChoices`(WriterTests 내부 중첩 TextChoices)에 `@classmethod def method(cls)` 를 추가하고, `self.NestedChoices.method` 를 직렬화한 결과가 `"migrations.test_writer.WriterTests.NestedChoices.method"` 와 `{"import migrations.test_writer"}` 임을 단언한다. 패치 전에는 `WriterTests.NestedChoices` 가 빠진 `migrations.test_writer.NestedChoices.method` 가 나와 실패하고, `__qualname__` 적용 후 전체 중첩 경로가 복원되어 통과한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: "마이그레이션 default 직렬화 경로가 틀림" + "classmethod" 단서 → `db/migrations/serializer.py` 에서 bound method / classmethod 를 처리하는 분기(`self.value.__self__` 가 클래스인 경우)를 찾는다. `FunctionTypeSerializer.serialize` 가 유일 후보.
- 함정/난이도 메모: 단일 파일·단일 라인 수정이라 난이도는 매우 낮으나, 같은 함수에 일반 함수/언바운드 메서드 분기도 있어 어느 분기를 고치는지 정확히 짚어야 한다(고칠 곳은 `klass = self.value.__self__` 인 classmethod 경로뿐). `self.value.__name__`(메서드명)은 그대로 두고 `klass.__name__` 만 바꿔야 함 — 헷갈려 둘 다 건드리면 안 됨.
- 우리 에이전트 관점: 막힐 지점은 디버깅보다 "정확한 분기 식별". `__name__` vs `__qualname__` 차이를 모르면 엉뚱하게 문자열 조작으로 클래스 경로를 재조립하려는 과한 수정에 빠질 수 있다. 정답은 표준 라이브러리 속성 교체 한 줄. 회귀 테스트(중첩 classmethod) 작성도 요구되므로 기존 `test_serialize_nested_class` 패턴 답습이 핵심.
