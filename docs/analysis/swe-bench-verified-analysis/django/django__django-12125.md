---
instance_id: django__django-12125
repo: django/django
base_commit: 89d41cba392b759732ba9f1db4ff29ed47da6a56
version: "3.1"
difficulty: "<15 min fix"
created_at: 2019-11-22T12:55:45Z
fail_to_pass: 2
pass_to_pass: 45
gold_files: [django/db/migrations/serializer.py]
---

# django__django-12125

## 문제 요약
다른 클래스의 inner class로 정의한 필드 서브클래스(또는 nested Enum)를 모델에서 쓰면, `makemigrations`가 생성한 마이그레이션 파일이 그 inner class를 마치 모듈 최상위 클래스인 것처럼 잘못된 경로로 참조한다. 예: `Outer.Inner`가 `test1.models.Inner`로, `Thing.State`가 `test1.models.State`로 직렬화된다. 사용자는 `test1.models.Outer.Inner`처럼 바깥 클래스를 포함한 정규 경로를 기대했고, 잘못된 경로는 마이그레이션 적용 시 "module has no member" 에러를 낸다.

## 유형 분류
- 버그 카테고리: logic / 누락처리 (`__name__` vs `__qualname__` 혼동)
- 서브시스템: django migrations serializer (마이그레이션 직렬화)
- 증상 타입: 잘못된 출력 (silent-wrong 코드 생성 → 이후 마이그레이션 적용 시 크래시)
- 로컬라이제이션 신호: problem_statement가 "직렬화된 경로가 틀렸다"를 말하고, hints_text가 명시적으로 `serializer.py#L266`의 `TypeSerializer`가 여전히 `__name__`을 쓴다고 지목 → `django/db/migrations/serializer.py`로 직행

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/serializer.py` — `TypeSerializer.serialize()`
- 근본 원인: 타입(클래스)을 직렬화할 때 `module.value.__name__`을 써서 경로를 만들었다. `__name__`은 leaf 이름(`Inner`, `State`)만 주므로 바깥 클래스 경로가 누락된다. inner class에서는 잘못된 top-level 경로가 나온다.
- 수정 요지: `self.value.__name__` → `self.value.__qualname__` 한 글자(한 줄) 변경. `__qualname__`은 `Outer.Inner`, `Thing.State`처럼 바깥 스코프를 포함한 정규화 이름을 주므로 nested class도 올바른 경로(`module.Outer.Inner`)로 직렬화된다. EnumSerializer는 이미 이전 커밋에서 `__qualname__`로 고쳐졌지만, Enum 서브클래스 *타입 자체*는 `serializer_factory`가 `TypeSerializer`로 라우팅해서 여전히 깨졌던 것이 이번에 닫힌다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_serialize_nested_class`, `test_serialize_numbers`
- 테스트가 픽스를 증명하는 방식:
  - 새 `test_serialize_nested_class`가 `WriterTests` 안에 nested 정의된 `NestedEnum`(IntEnum)과 신규 `NestedChoices`(`models.TextChoices`)를 직렬화하고, 결과가 `"migrations.test_writer.WriterTests.NestedEnum"` 처럼 **바깥 클래스(WriterTests)를 포함**한 경로 + import set이어야 함을 `assertSerializedResultEqual`로 단언. `__name__`만 쓰면 `WriterTests.` 접두가 빠져 실패.
  - `DeconstructibleInstances` 헬퍼 클래스를 `test_deconstruct_class_arguments` 메서드 로컬에서 모듈 top-level로 끌어올려, 그 클래스를 default로 직렬화하면 `migrations.test_writer.DeconstructibleInstances`가 나오는지 확인(qualname이 top-level에서도 회귀 없이 동작함을 보장).

## 공략 포인트 (뭘 조져야)
- localization 전략: hints가 `serializer.py`의 정확한 라인과 `TypeSerializer`/`__name__` 키워드를 줬다. `serializer.py`에서 `__name__` 사용처를 grep하면 `TypeSerializer.serialize()`의 분기(builtins가 아닌 경우)가 바로 나온다.
- 함정/난이도 메모: EnumSerializer는 이미 고쳐져 있어서 "Enum은 처리됨"으로 오판하기 쉽다. 핵심은 Enum *멤버* 직렬화(EnumSerializer)가 아니라 Enum/필드 *클래스 타입* 직렬화가 `serializer_factory` → `TypeSerializer`로 빠진다는 점. builtins 분기는 건드리면 안 되고 else 분기만 바꿔야 한다(`builtins`는 `__qualname__==__name__`이라 무해하긴 함).
- 우리 에이전트 관점: 한 줄 수정이라 난이도는 낮지만, "왜 EnumSerializer 고쳐졌는데 여전히 깨지냐"의 인과(타입 vs 멤버, factory 라우팅)를 안 짚으면 엉뚱한 곳(EnumSerializer, deconstruct 로직)을 손대 회귀를 낼 수 있다. `__name__`→`__qualname__` 차이를 nested 컨텍스트에서 정확히 이해하는 게 관건.
