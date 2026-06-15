---
instance_id: django__django-16950
repo: django/django
base_commit: f64fd47a7627ed6ffe2df2a32ded6ee528a784eb
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-06-06T19:58:48Z
fail_to_pass: 1
pass_to_pass: 3
gold_files: [django/forms/models.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S4)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-16950

## 문제 요약
Admin 인라인(`StackedInline`)에서 부모 모델이 `UUIDField(default=uuid.uuid4)`를 가지고 자식 FK가 `to_field`로 그 UUID(alternate key)를 참조할 때, 메인 객체와 인라인 자식을 함께 추가하면 저장이 실패한다. 부모 인스턴스의 `id`(UUID)가 default로 이미 채워졌는데도, 인라인 폼셋 폼을 구성하는 과정(`add_fields`)에서 부모의 해당 필드를 `None`으로 덮어쓴다. 그 결과 부모 PK/AK가 null이 되어 자식 FK가 끊기고 무결성 예외가 발생한다. hints의 디버깅 로그가 `_construct_form`/`is_valid` 호출 직후 `new_object.id`가 None으로 mutate됨을 명확히 보여준다.

## 유형 (정형화)
- **L (Localization) = L1** — 이슈 본문("value of id ... being set to null")과 hints가 문제 코드 블록 `if to_field.has_default(): setattr(self.instance, to_field.attname, None)`을 거의 그대로 인용한다. `BaseInlineFormSet.add_fields` 단일 함수로 키워드 추적이 바로 수렴한다(L0에 가까운 L1). cross-file·다중후보 없음.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S4)** — 고칠 위치는 이미 안다. 진짜 작업은 "언제 default를 무시(=None reset)해야 하는가"라는 **올바른 조건식을 불변식으로부터 합성**하는 것이다: (a) to_field가 부모의 진짜 pk인가(`attname == model._meta.pk.name`) vs 별도 alternate key인가, (b) 폼이 bound인가(`form.data` 유무). 이 둘을 AND/OR로 정밀 결합해야 하므로 SemFix/Angelix류의 의미적 조건 합성이다. 동시에 주어진 FAIL_TO_PASS 1개만으로는 픽스가 **과소명세**(특수 케이스로도 통과 가능)되므로, 인접 동작을 깨지 않는 일반화를 스스로 만들어야 한다는 점에서 S4(CEGIS) 성격이 보조로 깔린다.
- **K (Knowledge) = K-Domain** — django forms/inline-formset 내부 모델을 알아야 한다. `self.fk.remote_field.model._meta.pk.name`(부모 모델의 pk 이름)과 `to_field.attname`, bound form의 `form.data` 의미, `instance._state.adding` 컨텍스트 — 전부 프레임워크 내부지식. 일반 파이썬 추론만으로는 도출 불가.
- **Primary type = T-ConstraintReason** — 위치는 명확(L1)하나 난점이 "정확한 가드 조건의 추론 합성"에 있다. localize가 어렵지도(→T-DiffuseLoc 아님), 단순 가드/기본값 기계적 추가도(→T-DirectMap 아님) 아니다. 픽스가 한 줄짜리 조건이지만 그 조건의 **정합성**이 본질이라 T-ConstraintReason이 dominant.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(T2~T3 prior)지만 한 단계 위로 조정한다.
- 이 티어로 미는 구조적 피처: (1) **regression-trap** — PASS_TO_PASS 3개(#24377 두 케이스 + #24958)가 모두 "to_field가 진짜 pk이거나 unbound일 때는 여전히 None reset" 동작에 의존한다. naive하게 `setattr ... None`을 제거하거나 단일 조건만 추가하면 이 중 하나가 깨진다. (2) **S2 조건 합성 + K-Domain** — pk-vs-AK 구분과 bound/unbound 구분 두 축을 동시에 반영해야 하고, 그 축이 `_meta.pk.name`/`form.data`라는 도메인 심볼로만 표현된다.
- 공식 라벨과 다른 이유: 개발자 구현시간(diff는 6줄)은 짧지만, 에이전트 난이도는 "조건을 어느 정도로 좁힐지"에서 발산한다. over-fix(전부 보존) / under-fix(조건 하나만)로 인접 테스트를 깨기 쉬워 시간라벨에 안 잡히는 regression·overfit 리스크가 실제 난이도를 끌어올린다. 단, 단일파일·소규모·has-repro라 T5까지는 아님.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py` — `BaseInlineFormSet.add_fields`
- 근본 원인: 기존 로직은 `to_field.has_default()` **단일 조건**만 보고 부모 인스턴스의 `to_field` 필드를 `None`으로 초기화했다. 이 "default 무시"는 본래 모델 필드 default를 가진 PK가 인라인 폼에 우연히 채워지는 것을 막으려는 의도(#24377)였다. 그러나 `to_field`가 모델의 pk가 아닌 별도 alternate key(여기선 `UUIDField` AK)이고 실제 폼 데이터가 제출된 경우까지 무차별 적용되어, 부모의 auto-generated UUID를 날려버렸다.
- 수정 요지: `has_default()` 조건에 가드를 AND로 결합한다.
  ```python
  if to_field.has_default() and (
      to_field.attname == self.fk.remote_field.model._meta.pk.name
      or not form.data
  ):
      setattr(self.instance, to_field.attname, None)
  ```
  즉 (1) **to_field가 부모 모델의 진짜 pk일 때**(`attname == _meta.pk.name`)이거나, (2) **폼 데이터가 없을 때**(`not form.data`, 초기 unbound 렌더링)에만 None reset을 수행한다. to_field가 pk가 아닌 alternate key이면서 동시에 데이터가 제출된(bound) 경우에만 reset을 건너뛰어 UUID가 보존된다 — 바로 버그 시나리오.

## 검증 (test_patch)
- FAIL_TO_PASS (1개): `test_inlineformset_factory_nulls_default_pks_alternate_key_relation_data` — `ParentWithUUIDAlternateKey`/`ChildRelatedViaAK` 조합으로 인라인 폼셋 생성, `childrelatedviaak_set-0-name="Test"` 등 자식 폼 데이터를 bound 제출. 단언: `formset.is_valid() is True`, **`formset.instance.uuid`가 `assertIsNotNone`**(부모 AK 보존), 그리고 `formset.forms[0].instance.parent_id == formset.instance.uuid`(자식 FK가 부모 UUID에 정확히 연결).
- 픽스 증명: bound + (to_field=AK ≠ pk) 경로에서 reset이 건너뛰어지므로 `instance.uuid`가 살아남고 child `parent_id`로 전파된다. 두 단언이 "값이 None 아님 + 정확히 그 값으로 연결"을 함께 검사해 vacuous 통과를 막는다.
- overfit·regression 관점: PASS_TO_PASS 3개가 paired-control로 작동한다 — #24377("model field default should ignore that default"), #24377("adding a new object, a parent's auto-generated pk"), #24958 variant는 모두 **pk 케이스 / unbound 케이스에서는 여전히 None reset**되어야 정상이다. 또한 test_patch는 기존 `test_inlineformset_factory_ignores_default_pks_on_submit`에 `assertIsNone(formset.instance.uuid)` / `assertIsNone(...parent_id)`를 **보강**해, 새 가드가 정상 reset 경로를 죽이지 않았음을 직접 관찰한다. FAIL_TO_PASS가 1개로 얇지만 이 보강·P2P trio가 over-fix(전부 보존)를 즉시 red로 만들어 overfit을 차단한다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "value of id ... being set to null" + hints의 `is_valid`/`_construct_form` 직후 `new_object.id == None` 디버깅 로그 → 폼셋 폼 구성 시점에 부모 인스턴스를 mutate하는 지점을 찾는다. hints가 인용한 `if to_field.has_default(): setattr(self.instance, to_field.attname, None)` 블록으로 `django/forms/models.py`의 `BaseInlineFormSet.add_fields`를 바로 지목.
2. **픽스와 올바른 일반화 이유**: `setattr ... None`을 무조건 막는 게 아니라, "default 무시"가 **정당한 경우**만 남긴다. 정당한 경우는 두 가지 불변식 — (a) to_field가 부모의 실제 pk(자동생성 pk가 폼에 새지 않게), (b) unbound form(초기 렌더, 사용자 입력 없음). 둘 중 하나라도 참이면 reset 유지, 둘 다 거짓(=AK이면서 bound)일 때만 보존. 이는 특정 UUID 타입에 하드코딩하지 않고 "pk-ness × bound-ness"라는 도메인 불변식으로 표현했기에 올바른 일반화다 — 다른 alternate-key 타입에도 그대로 성립.
3. **regression 안전**: #24377 두 케이스(pk 케이스 → `attname == _meta.pk.name`이 참이라 reset 유지)와 #24958 variant, 그리고 보강된 `ignores_default_pks_on_submit`(여기선 to_field가 pk라 여전히 `assertIsNone`)가 안 깨져야 한다. 가드를 OR로 둔 덕에 pk 경로와 unbound 경로가 모두 기존 동작을 보존한다 — 새 조건은 "AK+bound" 교집합만 좁게 도려낸다.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 오답 — (i) **over-fix**: `setattr ... None`을 통째로 제거 → #24377 pk 케이스가 reset 안 되어 P2P red. (ii) **under-fix**: `not form.data` 하나만 추가 → bound인데 pk인 합법 reset 케이스가 깨질 수 있고, AK 판별이 빠져 일반성 부족. (iii) UUID 타입을 직접 검사(`isinstance(to_field, UUIDField)`) → overfit, 다른 AK 타입에 깨짐. 회피법: 실패 1건만 보고 만족하지 말고 PASS_TO_PASS trio를 control로 돌려, "언제 reset이 합법인가"를 pk-name·form.data 두 도메인 신호로 정확히 표현했는지 검증한다.
