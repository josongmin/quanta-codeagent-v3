---
instance_id: django__django-13343
repo: django/django
base_commit: ece18207cbb64dd89014e279ac636a6c9829828e
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-08-24T19:29:12Z
fail_to_pass: 1
pass_to_pass: 130
gold_files: [django/db/models/fields/files.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-13343

## 문제 요약
`FileField`에 `storage` 인자로 callable을 넘기면, 필드가 deconstruct될 때(즉 `makemigrations` 시) callable이 호출되어 "평가된 Storage 인스턴스"가 마이그레이션에 인라인된다. 이는 "런타임마다 storage가 달라질 수 있다"는 callable storage의 의도를 깨뜨린다. 올바른 동작은 deconstruction 시 평가값이 아니라 원래 callable에 대한 참조를 반환하는 것이며, 이는 callable `upload_to`가 이미 그렇게 동작하는 것과 일관된다. 이슈는 회귀 출처(PR #8477 / ticket 28184)까지 직접 명시한다.

## 유형 (정형화)

- **L (Localization) = L1 (Traceable)** — 이슈가 클래스명(`FileField`)·메서드 개념(`deconstruct`)·트리거(`makemigrations`)·회귀 PR까지 다 주지만, 진짜 픽스 지점은 `deconstruct()` 한 곳이 아니라 *callable이 소실되는* `__init__`까지 거슬러 올라가야 드러난다. `git grep "callable(self.storage)"` 한두 방으로 단일 파일(`fields/files.py`)에 수렴하므로 L0이라기엔 한 단계 인과추적이 들어가 L1이 정확하다.
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning)** — 한 줄 가드 추가가 아니라 *lifecycle 재배치*가 본질이다. 평가 시점(`__init__`)에 원본 callable을 별도 상태(`self._storage_callable`)로 보존하고, 그 상태를 소비 시점(`deconstruct`)에서 읽도록 두 메서드를 **조율**해야 한다(collect-then-process 형태의 작은 구조 변경 → S6). 보조로 S2: `deconstruct`에서 callable/비-callable 두 분기를 모두 깨지 않으려면 `getattr(self, '_storage_callable', self.storage)`라는 *기본값 fallback 조건*을 추론해야 한다(무조건 `_storage_callable` 참조 시 일반 storage 케이스에서 AttributeError). overfit 위험이 낮으므로 S3/S4(generate-&-validate/CEGIS)는 아니다 — 후보를 던져보며 수렴하는 문제가 아니라 상태 보존 구조를 한 번에 설계하는 문제다.
- **K (Knowledge) = K-Domain** — django migrations의 `deconstruct()` 계약(필드를 "재생성 가능한 인자"로 직렬화하며, callable은 import 경로 참조로 보존된다)을 알아야 "평가값을 넣으면 왜 틀린지"가 이해된다. 순수 파이썬 추론(K-Gen)만으론 `deconstruct`가 마이그레이션 직렬화용이라는 의미를 못 짚는다. 공개 시그니처 변경은 없으므로 K-API가 dominant는 아니다.
- **primary type = T-DomainBound** — 병목이 "어디를 고치나"(localize는 비교적 친절)도 "픽스 후보 수렴"(자명한 구조)도 아니라, **django deconstruct/migration 직렬화 의미론을 알아야 근본원인을 `__init__`의 조기평가로 귀착시킬 수 있다**는 도메인 지식이다. S6 구조변경이 두 번째 축이지만, 그 구조변경의 필요성 자체를 깨닫게 하는 게 도메인 지식이므로 T-DomainBound가 dominant. (S6만 보면 T-DesignRefactor지만, refactor 범위가 2줄+1줄로 작아 "조율된 대규모 구조변경"이라기엔 약해 K-Domain이 더 결정적.)

## 난이도 티어
**T4 (약간 어려움).** 구조적 피처:
- 파일 1개·골드 +3/-1줄·단일 클래스 2메서드 → scope 자체는 작아 T2~T3쪽으로 당긴다.
- 그러나 (a) **K-Domain**(deconstruct/migration 직렬화 의미론), (b) **소규모 S6 refactor**(평가 시점 상태보존 + 소비 시점 fallback의 두-메서드 조율), (c) **`cross-file-dep`**(`__init__`에 심은 `_storage_callable`을 `deconstruct`가 읽는 암묵적 상태 의존), (d) **넓은 `regression-trap`**(PASS_TO_PASS 130개 중 `FieldCallableFileStorageTests`·여러 `*StorageTests`가 인접) — 이 4개가 모두 T4 프로파일(L1 + S6/K-Domain + 넓은 P2P)에 정확히 들어맞는다.
- 공식 라벨 "15 min - 1 hour"와 **일치**한다. 다만 공식 라벨은 *오라클을 가진 개발자 구현시간*이라 "왜 deconstruct가 평가값을 내보내는가"의 인과를 `__init__`까지 역추적하는 비용(에이전트 입장의 실난점)은 시간라벨에 안 잡힌다 — 그 역추적이 이 문제를 T3가 아닌 T4로 미는 핵심 피처다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/files.py` — `FileField.__init__`, `FileField.deconstruct`.
- **근본 원인**: `__init__`에서 `if callable(self.storage): self.storage = self.storage()`로 callable을 *즉시 평가*하면서 원본 callable에 대한 참조를 어디에도 보관하지 않았다. 그 결과 `deconstruct()`의 `kwargs['storage'] = self.storage` 시점엔 이미 평가된 Storage 인스턴스만 남아, 그 인스턴스가 마이그레이션에 인라인됐다. (회귀 출처: PR #8477 / ticket 28184 — callable storage 도입 시 deconstruct 일관성을 빠뜨림.)
- **수정 요지**:
  - `__init__`에서 callable을 평가하기 **직전**에 `self._storage_callable = self.storage`로 원본 callable 참조를 별도 저장(주석: "Hold a reference to the callable for deconstruct()").
  - `deconstruct()`에서 `kwargs['storage'] = self.storage` → `kwargs['storage'] = getattr(self, '_storage_callable', self.storage)`. callable로 초기화된 경우엔 원본 callable을, 아니면 평가된 storage 인스턴스를 반환.
  - `getattr` 기본값(`self.storage`) 덕에 **비-callable 일반 storage 케이스는 기존 동작과 바이트 동일**하게 유지(AttributeError 회피 + 회귀 0).

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_deconstruction (file_storage.tests.FieldCallableFileStorageTests)`. 모델의 `storage_callable` 필드를 `_meta.get_field('storage_callable').deconstruct()`로 분해해 `kwargs['storage']`를 꺼내고, `assertIs(storage, callable_storage)`로 그 값이 *평가된 인스턴스가 아니라* `models.py`의 원본 `callable_storage` 함수 객체 **그 자체**(동일성 `is`)임을 확인한다. test_patch는 `from .models import (... callable_storage ...)` import도 추가한다.
- **픽스 증명**: 픽스 전엔 `kwargs['storage']`가 `self.storage`(평가된 Storage 인스턴스)라 `assertIs(..., callable_storage)`가 실패. 픽스 후엔 `getattr(self, '_storage_callable', ...)`가 `__init__`에서 저장한 원본 callable을 그대로 돌려주어 `is` 동일성이 성립.
- **overfit 관점**: `assertIs`(동일성)는 약한 검사가 아니다 — "원본 객체 참조를 그대로 보존"이라는 정확한 일반동작을 강제하므로 special-case 통과가 어렵다. 다만 FAIL_TO_PASS가 1개뿐이라 *비-callable 케이스 회귀*는 이 테스트만으론 안 잡힌다 → `overfit-risk`보다 `regression-trap`이 더 본질적 위험.
- **regression 관점**: PASS_TO_PASS 130개 중 `test_callable_class_storage_file_field`, `test_callable_function_storage_file_field`, `test_callable_storage_file_field_in_model`, `test_file_field_storage_none_uses_default_storage`(callable이 아닌/default storage 경로), 그리고 `FileSystemStorageTests.test_deconstruction`(storage 자신의 deconstruct)이 인접한다. `getattr` 기본값 패턴이 비-callable·default_storage·storage 클래스 인스턴스 케이스를 모두 기존대로 보존해야 이 130개가 산다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "callable storage", "deconstruct", "makemigrations" + "PR #8477 / ticket 28184" 신호 → `django/db/models/fields/files.py`의 `FileField`로 직행. `deconstruct()`를 보면 `kwargs['storage'] = self.storage`인데, `self.storage`가 어디서 바뀌는지 `__init__`을 보면 `if callable(self.storage): self.storage = self.storage()`로 **callable이 평가 후 소실**됨을 발견 — 진짜 픽스 대상은 deconstruct 한 곳이 아니라 *상태가 사라지는* `__init__`이다.
2. **픽스(왜 올바른 일반화인가)**: `__init__` 평가 직전에 `self._storage_callable = self.storage`로 원본을 보존하고, `deconstruct`에서 `getattr(self, '_storage_callable', self.storage)`로 읽는다. 이는 callable `upload_to`가 이미 따르는 "deconstruct는 원본 callable 참조를 보존한다"는 django 계약과 정합하므로, 특정 테스트를 통과시키는 특수처리가 아니라 *모든 callable storage 필드에 일반적으로 올바른* 동작이다. `getattr` 기본값이 비-callable 분기를 무손실 보존하므로 일반화가 양방향으로 안전하다.
3. **regression 안전**: 비-callable storage(클래스 인스턴스/`default_storage`/`None`) 케이스는 `_storage_callable` 속성이 없어 `getattr` 기본값 `self.storage`로 떨어져 **기존 동작 바이트 동일** → PASS_TO_PASS의 `test_callable_class_storage_file_field`·`test_file_field_storage_none_uses_default_storage`·`FileSystemStorageTests.test_deconstruction` 등 130개를 안 깬다. 무조건 `_storage_callable`을 참조하면 이들에서 AttributeError로 광범위 회귀가 난다.
4. **함정 회피**: (a) deconstruct만 보고 "callable을 역추적/재호출"로 고치려 하면 평가 후 callable이 사라져 원본을 복원할 수 없다 — 반드시 `__init__`에서 **평가 직전** 상태를 보존해야 한다. (b) `deconstruct`에서 `self._storage_callable`을 직접 참조하면 비-callable 케이스가 AttributeError로 무너진다 — `getattr(..., self.storage)` 기본값이 필수. (c) FAIL_TO_PASS가 1개뿐이라 callable 케이스만 보고 끝내기 쉽지만, 넓은 P2P가 비-callable 경로 회귀를 잡으므로 fallback 분기를 반드시 함께 설계해야 한다. (d) `upload_to` callable 처리를 참조 모델로 삼으면 일관된 해법을 빠르게 유도할 수 있다.
