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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-17087

## 문제 요약
중첩 클래스(nested class)에 정의된 `@classmethod`를 `Field.default`로 사용하면 `makemigrations`가 잘못된 참조 경로를 직렬화한다. 모델 `Profile` 안의 중첩 `Capability(TextChoices)`에 `default()` classmethod가 있고 `ArrayField(..., default=Capability.default)`로 쓰면, 생성된 마이그레이션이 `appname.models.Capability.default`(바깥 클래스 `Profile` 누락)로 나와 import 불가능한 경로가 되고 후속 `migrate`에서 크래시한다. 기대값은 `appname.models.Profile.Capability.default`. 이슈 본문에 모델 코드·생성 마이그레이션·기대 출력이 모두 있고, hints에 이미 정확한 한 줄 픽스(`__name__` → `__qualname__`)와 테스트 위치(`tests.migrations.test_writer.WriterTests`)까지 제시되어 있다.

## 유형 (정형화)

- **L0 (Localization=Pinpointed)** — 이슈가 "마이그레이션 `default` 직렬화 경로가 틀림" + "classmethod" 라는 직접 포인터를 주고, hints는 아예 `django/db/migrations/serializer.py`의 `FunctionTypeSerializer`와 정확한 라인까지 박아준다. grep("serializer.py" / `__self__` / `FunctionTypeSerializer`) 한 방. 후보 탐색 사실상 0.
- **S1 (Direct-Map / template)** — 정형 결함클래스 "잘못된 속성 선택(`__name__` vs `__qualname__`)"에 기계적으로 매칭되는 1-토큰 치환. 이슈/hints가 픽스를 사실상 명세(이슈 = 결함클래스를 명세하는 it-spells-out-the-fix 케이스). 추론으로 식을 합성(S2)할 필요 없이 "올바른 속성으로 교체"가 끝. CEGIS/G&V 후보 다발도 아님.
- **K-Domain (Domain-bound)** — 일반 파이썬 추론만으로는 부족. `__qualname__`이 중첩 경로(`Profile.Capability`)를 담고 `__name__`은 leaf(`Capability`)만 준다는 파이썬 데이터모델 지식 + django migration serializer가 bound method를 `module.class.method` 문자열로 직렬화한다는 **프레임워크 내부 계약**(import 가능해야 함)을 알아야 "왜 이게 올바른 일반화인지"가 선다. 그래서 K-Gen이 아니라 K-Domain. 단 hints가 지식을 외부에서 공급해주므로 실전 병목은 약함.

**Primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적인 속성 교체(S1). T-LocTrivial은 K-Gen 자명 케이스를 함의하는데 여기는 도메인 속성 의미(`__qualname__`)를 정확히 골라야 해서 한 단계 위인 T-DirectMap이 정확. **왜 S1인가(APR 관점):** 결함이 "표현식 내 잘못된 심볼 1개"로 환원되고 정답 심볼이 동일 객체의 표준 속성(`klass.__qualname__`)으로 유일하게 결정된다 — 식을 새로 합성하지 않고 PAR/TBar식 fix-template("wrong attribute access → correct attribute")의 직접 인스턴스화. 후보 패치 공간이 좁아 test-feedback 반복(S3) 불요.

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨 `<15 min fix`(개발자 구현시간 최저 버킷)와 정합. 이 티어로 미는 구조적 피처:
- 1파일 / 1함수(`FunctionTypeSerializer.serialize`) / **단일 토큰 변경** — patch scope 최소(1파일·<5줄 ≈ 48% solve 구간).
- **has-repro**: 이슈에 모델 코드 + 잘못된 출력 + 기대 출력이 다 있어 localize 직접성 최상(L0).
- 다만 **순수 T1(존나쉬움)은 아니다**: T1 프로파일은 K-Gen("이슈가 픽스를 거의 적어줌 + 일반 추론으로 자명")인데, 본 문제는 (a) `__name__`/`__qualname__` 의미 차이라는 도메인 속성 지식이 필요하고(K-Domain), (b) **regression-trap**으로 P2P 53개(직렬화 전반 — functions/partial/managers/enum/nested-class 등)를 하나도 안 깨야 한다. 픽스가 모든 bound-method 직렬화 경로에 영향을 주므로(최상위 클래스 포함) "최상위에서 `__qualname__ == __name__`이라 동작 불변"이라는 안전성 논증이 깔려야 안심하고 바꿀 수 있다.
- hints가 정답을 공급하지 않는 오라클-없는 에이전트 관점에선 "정확한 분기 식별 + 속성 의미 추론"이라는 가벼운 인지부하가 있어 T1보다 T2가 방어 가능. 공식 시간라벨이 못 잡는 regression 폭(P2P 53)을 반영해 T1로 더 내리지 않는다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/migrations/serializer.py` → `FunctionTypeSerializer.serialize`, bound classmethod 분기(`self.value.__self__`가 클래스인 경로).
- **근본 원인**: bound classmethod를 `module.class.method` 형태로 직렬화할 때 소속 클래스 이름을 `klass.__name__`으로 가져왔다. `__name__`은 클래스의 leaf 이름(`Capability`)만 주고 중첩 위치를 반영하지 못해, 바깥 클래스 `Profile`이 경로에서 탈락한다 → `module.Capability.default`는 실제로 import 불가능 → 마이그레이션 적용 시 크래시.
- **수정 요지**: `klass.__name__` → `klass.__qualname__` 단일 치환.
  ```python
  -            return "%s.%s.%s" % (module, klass.__name__, self.value.__name__), {
  +            return "%s.%s.%s" % (module, klass.__qualname__, self.value.__name__), {
  ```
  `__qualname__`은 `Profile.Capability`처럼 정규화된 점-경로를 담아 `module.Profile.Capability.default`의 import 가능한 참조를 만든다. **메서드 이름 `self.value.__name__`은 그대로 둔다**(그건 leaf 메서드명이 맞음 — 바꿀 대상은 클래스 토큰뿐). 최상위 클래스는 `__qualname__ == __name__`이라 기존 비중첩 케이스는 byte-identical로 보존된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `WriterTests.test_serialize_nested_class_method`.
- **동작/픽스 증명**: 테스트 픽스처 `NestedChoices`(WriterTests 내부 중첩 `TextChoices`)에 `@classmethod def method(cls): return cls.X`를 추가하고, `self.NestedChoices.method`의 직렬화 결과가 `"migrations.test_writer.WriterTests.NestedChoices.method"` + `{"import migrations.test_writer"}`임을 단언한다. 패치 전에는 `WriterTests`가 빠진 `migrations.test_writer.NestedChoices.method`가 나와 실패하고(=정확히 이슈가 보고한 누락 클래스 증상의 테스트화), `__qualname__` 적용 후 전 중첩 경로가 복원되어 통과한다. 기존 `test_serialize_nested_class` 패턴을 답습한 정석 회귀 테스트(hints에서 "regression test is required" 명시).
- **overfit 관점**: 낮음. FAIL_TO_PASS는 1개지만 결함을 `assertSerializedResultEqual`로 **정확한 문자열 동치**로 못박아 special-case 통과 여지가 없다. 픽스가 `__qualname__`이라는 표준 일반 메커니즘이라 "이 테스트만 통과시키는 hack"(예: 문자열로 `Profile.` 재조립)과 명확히 구별된다 — special-case 우회 패치는 비중첩/다중첩에서 깨져 P2P가 잡아낸다. 단, FAIL_TO_PASS가 nested **2단계**만 커버해 3단계 이상 중첩은 미검증이나, `__qualname__` 자체가 임의 깊이를 처리하므로 결함은 아님(overfit-risk 플래그 미부여).
- **regression 관점**: **regression-trap 표기**. P2P 53개가 직렬화 전반(`test_serialize_functions`, `_functools_partial`, `_managers`, `_enums`, `_nested_class`, `_type_model`, import 정렬 등)을 덮어, 동일 `serialize` 경로를 타는 비중첩 bound method가 안 깨져야 한다. 최상위 클래스에서 `__qualname__ == __name__` 불변식이 이 안전성을 보장 → P2P 전부 그린 유지.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈 신호 "마이그레이션 `default` 인자가 잘못된 경로로 직렬화됨" + "nested class의 `@classmethod`" → migration 직렬화 책임 모듈 `django/db/migrations/serializer.py`로 직행. 그 안에서 bound method(=클래스에 묶인 메서드)를 처리하는 분기는 `self.value.__self__`가 클래스인지 검사하는 `FunctionTypeSerializer.serialize`가 유일. 여기서 클래스 경로를 만드는 라인(`klass.__name__`)을 지목. (hints가 라인까지 주지만, 오라클 없이도 "직렬화 + classmethod" 키워드로 L0 수렴.)
2. **픽스와 올바른 일반화 이유**: `klass.__name__` → `klass.__qualname__`. `__name__`은 leaf만, `__qualname__`은 정의 컨텍스트 전체 점-경로를 주므로 임의 깊이 중첩에 대해 항상 import 가능한 정규 경로를 산출. 이게 문자열로 바깥 클래스를 수동 재조립하는 것보다 **올바른 일반화**인 이유: 파이썬이 정의 시점에 보장하는 정규명을 그대로 쓰므로 메타클래스/재정의/중첩 깊이에 무관하게 정확하고, 비중첩에서 동작 불변(`__qualname__ == __name__`).
3. **regression 안전**: P2P 53개(직렬화 전 영역) 그린 유지가 게이트. 핵심 불변식 = 최상위 클래스에서 `__qualname__ == __name__`이므로 `test_serialize_functions`/`_managers`/`_functools_partial` 등 비중첩 bound-method 경로의 출력이 바이트 동일. 메서드명 토큰(`self.value.__name__`)은 절대 건드리지 않음(건드리면 `_functions` 류가 깨짐).
4. **함정 회피**: 오라클 없는 에이전트의 오답 모드 — (a) `__qualname__` 속성을 모르고 `klass.__name__` 출력을 `split`/`Profile.` prefix 붙이기로 **문자열 재조립**(overfit hack: nested 2단계만 통과, 3단계/타 케이스서 깨짐 → P2P/일반성 위반). (b) **분기 오인** — 같은 함수의 일반 함수/언바운드 메서드 분기나 메서드명 토큰을 건드림(P2P 대량 회귀). (c) 회귀 테스트 누락(hints가 "regression test required" 명시 — `test_serialize_nested_class` 패턴 답습이 정석). 회피법: "표준 라이브러리 정규명 속성 1개로 교체 + 비중첩 불변식 확인 + 기존 nested 테스트 패턴 복제"로 좁히면 정확히 골드패치에 수렴.
