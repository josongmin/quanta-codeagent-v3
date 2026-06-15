---
instance_id: django__django-15467
repo: django/django
base_commit: e0442a628eb480eac6a7888aed5a86f83499e299
version: "4.1"
difficulty: <15 min fix
created_at: 2022-02-27T03:00:31Z
fail_to_pass: 1
pass_to_pass: 62
gold_files: [django/contrib/admin/options.py]
---

# django__django-15467

## 문제 요약
`radio_fields`가 지정된 `ModelAdmin`에서 ForeignKey 필드의 `empty_label`을 커스텀으로 설정해도 무시된다. 사용자가 `formfield_for_foreignkey`를 오버라이드해 `kwargs['empty_label']`을 직접 넣어줘도, 상위 구현이 이를 무조건 `_('None')`(또는 None)으로 덮어쓴다. 사용자는 자신이 지정한 "I WANT TO SET MY OWN EMPTY LABEL" 같은 라벨이 적용되길 기대했지만 항상 기본 라벨이 나온다.

## 유형 분류
- 버그 카테고리: logic / API-contract (오버라이드 가능해야 할 인자를 무조건 덮어씀)
- 서브시스템: django contrib.admin (ModelAdmin formfield 생성)
- 증상 타입: silent-wrong (예외 없이 잘못된 라벨이 렌더됨)
- 로컬라이제이션 신호: problem_statement가 파일·라인(`django/contrib/admin/options.py`, row 234)과 정확한 코드 라인(`kwargs['empty_label'] = _('None') if db_field.blank else None`)을 직접 지목 — 사실상 핀포인트로 주어짐.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py` : `ModelAdmin.formfield_for_foreignkey` (radio_fields 분기 내부)
- 근본 원인: radio_fields 분기에서 `kwargs["empty_label"]`을 무조건적 대입으로 설정했기 때문에, 호출자가 미리 넣어둔 `empty_label`이 항상 폐기됨. 즉 "blank이면 기본 라벨" 로직이 호출자 의도보다 우선권을 가짐.
- 수정 요지: 대입을 `kwargs.get("empty_label", _("None"))` 기반으로 바꿔, `db_field.blank`일 때 호출자가 이미 제공한 `empty_label`이 있으면 그 값을, 없으면 `_("None")`을 사용하도록 함. blank가 아니면 종전대로 `None`. 한 줄짜리 변경으로 기존 기본 동작은 보존하면서 오버라이드만 허용.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_radio_fields_foreignkey_formfield_overrides_empty_label` — `formfield_overrides = {ForeignKey: {"empty_label": "Custom empty label"}}` + `radio_fields`를 동시에 가진 ModelAdmin을 만든다.
- 증명 방식: `Inventory._meta.get_field("parent")`(blank=True인 self-FK)에 대해 `formfield_for_dbfield`를 호출하고, 생성된 formfield의 `ff.empty_label`이 `"Custom empty label"`과 같은지 단언한다. 패치 전에는 `_('None')`으로 덮여 실패, 패치 후에는 `kwargs.get`이 오버라이드 값을 살려 통과. 기존 `test_radio_fields_ForeignKey`(empty_label가 None인 케이스)는 PASS_TO_PASS로 회귀 방지.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일·라인·정확한 한 줄을 다 주므로 `formfield_for_foreignkey`의 radio_fields 분기를 바로 찾으면 됨. localization은 거의 공짜.
- 함정/난이도: 단일 파일·단일 라인. 단, 제안된 `kwargs.get('empty_label') or _('None')`는 빈 문자열/falsy 라벨을 `_('None')`으로 다시 덮는 미묘한 버그가 있어, 골드는 `kwargs.get("empty_label", _("None"))`(키 부재만 기본값)로 더 정확하게 처리함 — `or` vs `get(default)` 구분이 핵심.
- 우리 에이전트 관점: 막힐 여지는 적으나, problem_statement의 제안 코드를 그대로 베끼면 falsy-label 엣지에서 미세하게 어긋날 수 있음. blank가 아닐 때 `None`을 유지해야 하는 조건분기를 깨뜨리지 않는 것도 주의.
