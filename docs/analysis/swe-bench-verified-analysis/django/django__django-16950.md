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
---

# django__django-16950

## 문제 요약
Admin 인라인(StackedInline)에서 부모 모델이 `UUIDField(default=uuid.uuid4)`를 가지고 `to_field`로 그 UUID를 참조할 때, 메인 객체와 인라인 자식을 함께 추가하면 저장이 실패한다. 부모의 `id`(UUID) 값이 default로 채워졌는데도 폼셋 폼을 구성하는 과정에서 `None`으로 덮어써진다. 사용자는 부모의 auto-generated UUID가 유지되어 자식 FK에 연결되길 기대했으나, 실제로는 부모 `id`가 null이 되어 무결성 예외가 발생한다.

## 유형 분류
- 버그 카테고리: edge-case (조건 누락 / over-broad reset)
- 서브시스템: django forms — model formsets / inline formsets (`BaseInlineFormSet.add_fields`)
- 증상 타입: silent-wrong → 다운스트림 크래시 (부모 PK/AK가 None으로 mutate되어 저장 시 예외)
- 로컬라이제이션 신호: "value of id ... being set to null", hints의 디버깅 로그가 `_construct_form` 직후 `new_object.id`가 None이 됨을 지목 → `add_fields`에서 `setattr(self.instance, to_field.attname, None)` 하는 코드. 즉 default를 무시하려는 로직이 부모의 alternate key(UUID)에도 무차별 적용됨.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py` : `BaseInlineFormSet.add_fields`
- 근본 원인: 기존 로직은 `to_field.has_default()`만 보고 부모 인스턴스의 해당 필드를 `None`으로 초기화했다. 이 "default 무시" 동작은 원래 모델 필드 default를 가진 PK가 폼 표시에서 우연히 채워지지 않게 하려는 것(#24377)이었는데, `to_field`가 모델의 pk가 아닌 별도의 alternate key(여기선 UUID)이고 실제 폼 데이터가 제출된 경우까지 잡아버려 부모의 auto-generated UUID를 날렸다.
- 수정 요지: `has_default()` 조건에 추가 가드를 AND로 결합. 즉 (1) `to_field.attname == self.fk.remote_field.model._meta.pk.name` — to_field가 부모 모델의 진짜 pk일 때이거나, (2) `not form.data` — 폼 데이터가 없을 때(초기 렌더링)에만 None으로 리셋한다. 부모의 pk가 아닌 alternate key이면서 데이터가 제출된 경우에는 더 이상 default 값을 지우지 않아 UUID가 보존된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_inlineformset_factory_nulls_default_pks_alternate_key_relation_data` — `ParentWithUUIDAlternateKey` / `ChildRelatedViaAK` 조합으로 인라인 폼셋을 만들고 자식 폼 데이터를 제출했을 때, 부모의 auto-generated alternate key(UUID)가 보존되는지 검증.
- 증명 방식: TOTAL_FORMS=3에 0번 폼에 `name="Test"` 데이터를 채워 제출 → `formset.is_valid()`가 True이고, 핵심으로 `formset.instance.uuid`가 `None`이 아니며(`assertIsNotNone`), `formset.forms[0].instance.parent_id == formset.instance.uuid`로 자식 FK가 부모 UUID에 정확히 연결됨을 확인. 추가로 기존 `test_inlineformset_factory_ignores_default_pks_on_submit`에 `assertIsNone(formset.instance.uuid)` / `assertIsNone(...parent_id)` 단언을 보강해, to_field가 진짜 pk인 케이스에서는 여전히 None으로 리셋되는 정상 동작(`not form.data` 분기와 pk-name 분기)이 깨지지 않음을 paired-control로 보장.

## 공략 포인트 (뭘 조져야)
- 어디부터: 증상 키워드 "id being set to null"과 hints의 `to_field.has_default(): setattr(..., None)` 코드 블록 → `django/forms/models.py`의 `BaseInlineFormSet.add_fields`를 바로 지목 가능. localization은 비교적 쉬움.
- 함정/난이도: 단순히 `setattr ... None`을 제거하면 #24377/#24958 회귀(PASS_TO_PASS 3개)가 깨진다. 핵심은 "언제 default를 무시해야 하는가"를 정밀하게 좁히는 것 — pk vs alternate key 구분과 bound/unbound(form.data 유무) 구분 두 축을 모두 반영해야 한다. 단일 조건만 추가하면 한쪽 테스트가 깨짐.
- 우리 에이전트 관점: 막힐 지점은 픽스 위치가 아니라 가드 조건의 정확성. `self.fk.remote_field.model._meta.pk.name`이라는 부모 pk 이름 접근 경로를 알아야 하고, `not form.data`로 초기 렌더(unbound) 케이스를 살려둬야 한다는 점을 회귀 테스트 없이 추론하긴 어렵다. over-fix(전부 보존)나 under-fix(조건 하나만)로 PASS_TO_PASS를 깨기 쉬운 전형적인 "조건 좁히기" 문제.
