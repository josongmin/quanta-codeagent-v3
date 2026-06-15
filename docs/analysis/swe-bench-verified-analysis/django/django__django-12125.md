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
primary_type: T-DirectMap
tier: T3
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-12125

## 문제 요약
다른 클래스의 inner class로 정의한 필드 서브클래스(또는 nested Enum/Choices)를 모델에서 쓰면, `makemigrations`가 생성한 마이그레이션 파일이 그 inner class를 마치 모듈 최상위 클래스인 것처럼 잘못된 경로로 직렬화한다. 예: `Outer.Inner`가 `test1.models.Inner`로, `Thing.State`가 `test1.models.State`로 직렬화된다. 사용자는 `test1.models.Outer.Inner`처럼 바깥 클래스를 포함한 정규 경로를 기대했고, 잘못된 경로는 마이그레이션 적용 시 `module has no member` 에러로 크래시한다. 이전 커밋들이 `EnumSerializer`(Enum *멤버*)는 이미 `__qualname__`으로 고쳤지만, Enum/필드 *클래스 타입 자체*는 `serializer_factory`가 `TypeSerializer`로 라우팅해서 여전히 `__name__`을 써 깨진 채로 남아 있었다.

## 유형 (정형화)
- **L0 (Pinpointed)** — `hints_text`가 `serializer.py#L266`라는 정확한 파일·라인과 `TypeSerializer`가 여전히 `__name__`을 쓴다는 심볼을 직접 지목한다. `serializer.py`에서 `__name__` grep 한 방이면 분기가 나온다. 탐색 비용 사실상 0.
- **S1 Direct-Map (+S2 보조)** — 픽스가 사실상 명세돼 있다: hints가 "`__qualname__`을 쓰라"고 단어까지 박아줬고, 결함클래스(`__name__`↔`__qualname__` 혼동)는 정형 템플릿이다. 단순 토큰 치환이라 S1이 dominant. 다만 builtins 분기는 건드리면 안 되고 *else 분기만* 바꿔야 한다는 점, "왜 EnumSerializer 고쳤는데도 깨지냐"(타입 vs 멤버, factory 라우팅)의 인과를 추론해야 엉뚱한 곳을 손대지 않는다는 점에서 약한 S2(constraint-reasoning)가 보조로 붙는다.
- **K-Domain** — 일반 파이썬 추론(`__qualname__`이 바깥 스코프를 포함한다)은 K-Gen이지만, "어느 serializer가 어느 입력을 받고 `serializer_factory`가 Enum 클래스를 `EnumSerializer`가 아니라 `TypeSerializer`로 라우팅한다"는 건 django migrations serializer 내부 구조 지식이다. 이 라우팅을 모르면 이미 고쳐진 `EnumSerializer`만 보고 "처리됨"으로 오판한다.
- **primary = T-DirectMap** — 위치가 명확(L0)하고 픽스가 기계적 토큰 치환(S1: `__name__`→`__qualname__`)이라 T-DirectMap. T-DomainBound이 아닌 이유는 도메인지식이 병목이 아니라 *함정 회피*용 보조이기 때문이고, T-ConstraintReason이 아닌 이유는 올바른 식을 추론 합성할 필요 없이 hints가 답을 줬기 때문이다.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `<15 min fix`(개발자 구현시간 prior로 T1~T2 시사)지만 에이전트 난이도로 한 단계 올린다. 구조적 피처:
- **scope는 T1급** — 1파일·1줄(`serializer.py` 단일 토큰 치환). 이것만 보면 T1.
- **그러나 인과 함정이 tier를 민다** — `EnumSerializer`가 이미 `__qualname__`으로 고쳐져 있어 "Enum은 처리됨"으로 오판하기 쉽다. 진짜 결함은 Enum *멤버*가 아니라 Enum/필드 *클래스 타입*이 `serializer_factory`→`TypeSerializer`로 빠진다는 점이고, 이 라우팅을 짚어야(K-Domain) 한다.
- **regression-trap** — PASS_TO_PASS 45개 중 `test_serialize_enums`, `test_serialize_choices`, `test_serialize_class_based_validators`, `test_serialize_functions` 등 인접 직렬화 경로가 다수다. `EnumSerializer`나 `deconstruct` 로직을 잘못 건드리면 이들이 깨진다. builtins 분기를 함께 바꿔도 무해하긴 하나(builtins는 `__qualname__==__name__`) 정확히 else만 손대는 절제가 필요.
- **has-repro 없음(스택트레이스 부재)** — 이슈에 재현 모델 코드는 있으나 네이티브 스택트레이스는 없다(easiness 신호 약화). hints가 그 공백을 메워 L0로 끌어주지만 자력 추론이었으면 더 어려웠을 것.

scope 1파일·<5줄(≈48% solve 구간)이라 T4까지 올리진 않고, hints가 답을 거의 적어줘 T2 아래로도 내릴 뻔하나, factory 라우팅 인과 + 넓은 P2P trap이 T3로 고정한다.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/migrations/serializer.py` — `TypeSerializer.serialize()` (else 분기, ~line 272).
- **근본 원인:** 타입(클래스)을 직렬화할 때 `"%s.%s" % (module, self.value.__name__)`로 경로를 만들었다. `__name__`은 leaf 이름(`Inner`, `State`)만 주므로 바깥 클래스 경로가 누락돼, inner class가 모듈 top-level인 것처럼 잘못된 경로로 나온다. 이전 커밋들(fb0f987, 451b585, 6452112 등)이 `Field.deconstruct`/model operations/`EnumSerializer`를 `__qualname__`으로 고쳤지만 `TypeSerializer`(Enum/필드 *클래스 타입*을 받는 경로)는 누락된 채였다.
- **수정 요지:** `self.value.__name__` → `self.value.__qualname__` (단일 토큰, 1줄). `__qualname__`은 `Outer.Inner`, `WriterTests.NestedEnum`처럼 바깥 스코프를 포함한 정규화 이름을 주므로 nested class도 `module.Outer.Inner`로 올바르게 직렬화된다. builtins 분기(`module == builtins.__name__`)는 그대로 두고 else만 변경 — builtins 타입은 nested가 없어 `__qualname__==__name__`이므로 무관.

## 검증 (test_patch)
- **FAIL_TO_PASS (정확히 2):** `test_serialize_nested_class`, `test_serialize_numbers`.
- **픽스 증명 방식:**
  - 신규 `test_serialize_nested_class`가 `WriterTests` 내부에 nested 정의한 `NestedEnum`(IntEnum)과 신규 `NestedChoices`(`models.TextChoices`)를 직렬화하고, 결과가 `"migrations.test_writer.WriterTests.NestedEnum"`처럼 **바깥 클래스 `WriterTests`를 포함**한 경로 + `{'import migrations.test_writer'}` import set이어야 함을 `assertSerializedResultEqual`로 단언. `__name__`만 쓰면 `WriterTests.` 접두가 빠져 RED.
  - `DeconstructibleInstances` 헬퍼를 `test_deconstruct_class_arguments` 메서드 로컬에서 모듈 top-level로 끌어올려, default로 직렬화하면 `migrations.test_writer.DeconstructibleInstances`가 나오는지 확인 — top-level에서도 `__qualname__`이 회귀 없이 동작(`__qualname__==__name__`)함을 보장.
- **overfit 관점:** FAIL_TO_PASS가 IntEnum과 TextChoices 두 종을 subTest로 돌려 nested 케이스를 일반화한다. 다만 핵심 검증은 nested 1단계뿐이라 깊은 다중 중첩(`A.B.C.Inner`)은 미검증 — 그래도 `__qualname__`은 임의 깊이를 정확히 처리하므로 overfit-risk 플래그는 달지 않는다(픽스가 테스트보다 일반적). `test_serialize_numbers`는 별개 무관 테스트가 같은 모듈 import 부수효과로 묶여 FAIL_TO_PASS에 들어온 것으로, 픽스 자체의 oracle은 `test_serialize_nested_class`다.
- **regression 관점:** PASS_TO_PASS 45개의 `test_serialize_enums`/`test_serialize_choices`/`test_serialize_class_based_validators` 등이 top-level 직렬화를 커버 — `__qualname__`이 top-level에서 `__name__`과 동일 결과라 안 깨진다. `EnumSerializer`나 builtins 분기를 잘못 손댔다면 이들이 RED가 됐을 것.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement가 "직렬화된 경로가 틀렸다(`test1.models.Inner`이 아니라 `Outer.Inner`여야)"를 말하고, hints_text가 `serializer.py#L266`의 `TypeSerializer`가 여전히 `__name__`을 쓴다고 직접 지목 → `django/db/migrations/serializer.py`로 직행. `__name__` grep으로 `TypeSerializer.serialize()`의 non-builtins(else) 분기를 즉시 찾는다.
2. **픽스와 일반화:** 그 분기의 `self.value.__name__`을 `self.value.__qualname__`으로 치환. `__qualname__`은 정의 시점의 모든 enclosing 스코프(`Outer.Inner`, `Thing.State`, `WriterTests.NestedEnum`)를 점으로 연결해 주므로, 특정 테스트 케이스가 아니라 *임의 깊이의 모든 nested 클래스*에 올바른 import 경로를 준다 — 이게 special-case가 아닌 올바른 일반화인 이유다. builtins 분기는 nested가 없어 동일 결과이므로 손대지 않는다.
3. **regression 안전:** top-level 클래스에서는 `__qualname__==__name__`이라 기존 직렬화 결과가 byte-identical. `test_serialize_enums`/`test_serialize_choices`/`test_serialize_class_based_validators`/`test_serialize_functions` 등 인접 P2P가 모두 그대로 통과해야 하고 통과한다. `EnumSerializer`나 `deconstruct` 로직은 건드리지 않는다(이미 고쳐졌고, 멤버 직렬화는 별개 경로).
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) `EnumSerializer`가 이미 `__qualname__`인 걸 보고 "Enum 처리됨"으로 오판해 엉뚱한 곳을 수정. 핵심은 Enum *멤버*(EnumSerializer)가 아니라 Enum/필드 *클래스 타입*이 `serializer_factory`→`TypeSerializer`로 라우팅된다는 인과를 짚는 것. (b) `__name__`을 너무 광범위하게(builtins 분기 포함 또는 다른 serializer까지) 치환해 회귀를 내는 것 — non-builtins else 분기 한 곳만 바꾼다. (c) deconstruct/model operations 쪽을 추가로 손대 over-edit — 그쪽은 이전 커밋이 이미 닫았다.
