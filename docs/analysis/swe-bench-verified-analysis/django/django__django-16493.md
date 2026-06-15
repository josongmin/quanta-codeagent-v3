---
instance_id: django__django-16493
repo: django/django
base_commit: e3a4cee081cf60650b8824f0646383b79cb110e7
version: "5.0"
difficulty: 15 min - 1 hour
created_at: 2023-01-20T18:29:25Z
fail_to_pass: 1
pass_to_pass: 91
gold_files: [django/db/models/fields/files.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-16493

## 문제 요약
`FileField`의 `storage` 인자에 호출가능(callable)을 넘기고 그 callable이 `default_storage`를 반환하면, 필드를 deconstruct할 때 `storage` kwarg가 누락된다. 사용자는 makemigrations가 항상 `storage=myapp.models.get_storage`처럼 callable 참조를 포함하길 기대하지만, callable이 `default_storage`를 반환하는 순간(예: `random.choice([default_storage, other_storage])`)에는 누락된다. 결과적으로 `makemigrations`를 반복 실행하면 같은 모델 정의에서 storage kwarg가 들어갔다 빠졌다 하는 **비결정적 마이그레이션**이 생성된다. problem_statement는 이 결함이 #31941 수정에서 누락된 케이스이며 `deconstruct`가 `self.storage is not default_storage`로 판정하는데 이 시점의 `self.storage`는 **이미 평가된 버전**이라서 잘못된다고 직접 진단한다.

## 유형 (정형화)

- **L (Localization) = L0 (Pinpointed)**: problem_statement가 "the deconstruct method tests if `self.storage is not default_storage`"와 "#31941 fix"를 코드 표현식 수준으로 지목한다. `grep deconstruct django/db/models/fields/files.py` 한 방이면 끝. 단일 메서드, 단일 파일.
- **S (Repair Strategy) = S2 (Constraint-Reasoning)**: 고칠 위치는 자명하지만, 올바른 픽스는 "비교 대상은 평가된 storage 인스턴스가 아니라 **직렬화에 실제 쓸 값**(callable이면 `_storage_callable`, 아니면 `self.storage`)이어야 한다"는 불변식을 추론해야 합성된다. 단순히 None가드/상수변경 같은 템플릿(S1)이 아니다 — `self.storage`(evaluated)와 `_storage_callable`(original callable)의 의미 차이를 따져 비교/저장의 피연산자를 하나로 통일하는 의미적 추론이 핵심. 후보 패치를 마구 던져 테스트로 거르는 G&V(S3)도 아니다(정답이 추론으로 단번에 나옴).
- **K (Knowledge) = K-Domain**: django model-field deconstruct/직렬화 계약과 storage descriptor의 `_storage_callable` lazy-evaluation 메커니즘(callable일 때만 원본을 별도 보존)을 알아야 한다. 일반 파이썬 추론(K-Gen)만으로는 "왜 `self.storage`가 이미 평가된 값인지"를 알 수 없다.
- **primary type = T-ConstraintReason**: 위치는 명확(L0)하나 픽스가 S1 기계적 매핑이 아니라 S2 제약추론으로 도출되므로 T-ConstraintReason이 dominant. 픽스 줄수는 작지만 난점은 "어떤 줄을 고치나"가 아니라 "어떤 값으로 비교해야 의미상 옳은가"에 있다. → APR 관점에서 SemFix/Angelix 계열(고칠 location 고정, 조건식을 의미적으로 합성).

## 난이도 티어
**T3 (중간).**

이 티어로 미는 구조적 피처:
- **단일 파일·단일 함수·실효 2줄**: 1파일·소규모는 본래 T1~T2 쪽 신호(1파일·<5줄 ≈ 48% solve).
- **그러나 S2 의미추론 + K-Domain**: 픽스가 템플릿(S1)이 아니라 `_storage_callable` vs 평가된 `self.storage`의 도메인 의미를 추론해야 도출된다. 루브릭상 "L1 + S2/S5, 단일파일이나 실질 추론"이 T3의 전형. localize가 L0로 더 쉽긴 하나, repair가 S2/K-Domain이라 T2로 내리기엔 무겁다.
- **regression-trap (넓은 P2P)**: PASS_TO_PASS 91개, 그중 `test_deconstruction`(non-default callable 보존)과 "Deconstructing gives the original callable, not the evaluated value."가 과교정을 직접 막는 인접 동작. 어설픈 픽스가 깰 수 있는 면이 분명히 존재.
- **has-repro**: problem_statement에 makemigrations 재현 시나리오 + 정확한 원인 라인이 있어 easiness를 강하게 끌어올림.

**공식 라벨("15 min - 1 hour")과의 관계**: 공식 라벨은 개발자 구현시간 기준이며 이 케이스에선 T3와 합리적으로 일치한다(상한이 1시간으로 T2보다 위). repro+L0 신호 덕에 에이전트 난이도는 라벨 중에서도 낮은 쪽이지만, S2 추론과 과교정 함정 때문에 T2로 내리지 않고 T3 유지.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/fields/files.py` : `FileField.deconstruct`
- **근본 원인**: 비교 피연산자가 잘못됨. 기존 코드
  ```python
  if self.storage is not default_storage:
      kwargs["storage"] = getattr(self, "_storage_callable", self.storage)
  ```
  에서 **판정**(`if`)은 평가된 `self.storage`로 하고 **저장값**은 `_storage_callable`로 한다 — 둘이 불일치. callable이 `default_storage`를 반환하면 `self.storage`가 `default_storage`로 평가되어 `if`가 False가 되고, `_storage_callable`에 원본 callable이 멀쩡히 보존돼 있는데도 kwarg를 빼버린다.
- **수정 요지**: 판정과 저장의 피연산자를 **하나의 변수로 통일**한다.
  ```python
  storage = getattr(self, "_storage_callable", self.storage)
  if storage is not default_storage:
      kwargs["storage"] = storage
  ```
  먼저 직렬화에 쓸 실제 값(callable이면 원본 callable, 아니면 인스턴스)을 `storage`로 뽑고, 그 값으로 default 판정 + 저장을 모두 수행. callable 경로에선 비교 대상이 **callable 객체 자체**가 되므로 callable이 무엇을 반환하든(default_storage 포함) `is not default_storage`가 항상 True → 누락 없음. 비-callable이 실제 `default_storage`인 경우만 정당하게 생략. hints_text의 "use `getattr(self, "_storage_callable", self.storage)` in both lines" 제안과 정확히 일치.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_deconstruction_storage_callable_default` — "A callable that returns default_storage is not omitted when deconstructing."
- **동작/픽스 증명**: `tests/file_storage/models.py`에 `callable_default_storage()`(= `default_storage`를 반환하는 함수)와 이를 쓰는 필드 `storage_callable_default = models.FileField(storage=callable_default_storage, upload_to="storage_callable_default")`를 추가. 테스트는
  ```python
  *_, kwargs = obj._meta.get_field("storage_callable_default").deconstruct()
  self.assertIs(kwargs["storage"], callable_default_storage)
  ```
  로, kwargs에 **원본 callable 객체가 그대로 보존**됨을 `assertIs`(동일성)로 단언한다. 픽스 전: `self.storage`가 `default_storage`로 평가되어 `if` False → `kwargs["storage"]` 미존재 → `KeyError`로 실패. 픽스 후: 비교 대상이 `_storage_callable`(= `callable_default_storage`)이라 통과.
- **overfit 관점**: `assertIs`로 정확한 객체 동일성을 보므로 단순 통과용 special-case 패치는 통하기 어렵다. 다만 FAIL_TO_PASS가 1개뿐이라 "default_storage 비교를 통째로 제거"하는 과교정도 이 테스트만 보면 통과한다 → overfit 위험 자체는 낮지 않으나, 아래 P2P가 그 과교정을 잡는다.
- **regression 관점**: PASS_TO_PASS 91개. 핵심 가드는 (1) `test_deconstruction` — non-default callable(`callable_storage`)이 deconstruct에 보존되는지, (2) "Deconstructing gives the original callable, not the evaluated value." — callable이 평가값이 아니라 원본으로 직렬화되는지, (3) `test_file_field_storage_none_uses_default_storage` — 실제 default_storage(비-callable)는 생략되는지. 골드 패치는 callable/비-callable 두 경로의 의미를 모두 보존하므로 이들을 깨지 않는다.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 "`#31941` fix" + "`deconstruct` method tests if `self.storage is not default_storage`"를 명시 → `django/db/models/fields/files.py`의 `FileField.deconstruct`를 즉시 지목. 그 줄 위 `getattr(self, "_storage_callable", self.storage)` 사용을 보고 "판정은 `self.storage`로, 저장은 `_storage_callable`로 하는 불일치"를 발견.
2. **픽스 (올바른 일반화인 이유)**: 비교/저장을 단일 변수 `storage = getattr(self, "_storage_callable", self.storage)`로 통일. 이게 special-case가 아닌 올바른 일반화인 이유 — deconstruct의 의도는 "직렬화에 쓸 그 값"이 default_storage와 동일할 때만 생략하는 것이다. 직렬화에 쓰는 값은 callable이면 원본 callable이므로, **판정 대상도 그 동일한 값이어야** 의미가 일관된다. 평가 결과(`self.storage`)는 직렬화에 쓰이지도 않는데 판정에 끼어든 게 버그의 본질. callable이 무엇을 반환하든 callable 객체 자체는 `default_storage`가 아니므로 항상 보존 → 비결정성 제거.
3. **regression 안전**: 비-callable이 실제 `default_storage`인 경우 `getattr`는 `self.storage`(= default_storage)를 돌려주므로 여전히 생략된다(`test_file_field_storage_none_uses_default_storage` 보존). non-default callable은 원본 callable로 보존된다(`test_deconstruction`, "Deconstructing gives the original callable…" 보존). 즉 두 기존 경로의 동작이 byte-identical하게 유지됨.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 과교정 — "default_storage 비교를 통째로 제거해 항상 storage를 포함"하면 FAIL_TO_PASS 1개는 통과하지만, 실제 `default_storage`(비-callable)도 직렬화에 끼워넣어 `test_file_field_storage_none_uses_default_storage` 등 P2P를 깬다. 또 다른 함정 — `if`에 callable 여부 별도 분기(`hasattr(self, "_storage_callable")`)를 추가하는 식의 ad-hoc 패치는 callable/비-callable 경로를 깔끔히 통일하지 못해 코드가 늘고 엣지가 샌다. 회피법: `self.storage`가 이미 평가된 값임을 storage descriptor/`_storage_callable` 설정 경로까지 읽어 확인한 뒤, 골드처럼 **비교와 저장의 피연산자를 한 변수로 통일**하는 최소·일관 패치를 택한다.
