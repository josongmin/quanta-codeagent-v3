---
instance_id: django__django-14725
repo: django/django
base_commit: 0af9a5fc7d765aa05ea784e2c3237675f3bb4b49
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-08-01T21:24:36Z
fail_to_pass: 3
pass_to_pass: 64
gold_files: [django/forms/models.py]
---

# django__django-14725

## 문제 요약
모델 폼셋(ModelFormSet)에는 "수정 전용(edit-only)" 뷰, 즉 기존 객체 편집만 허용하고 신규 객체 생성은 막는 방법이 없다. 사용자들은 `extra=0`으로 이를 흉내내려 하지만 `extra`는 단지 표시할 추가 폼 개수를 뜻할 뿐이라 JavaScript나 추가 POST 데이터로 폼을 더 보내면 새 객체가 생성된다. `max_num`+`validate_max` 조합도 `form-INITIAL_FORMS` 값을 조작하면 추가 인스턴스가 만들어지는 빈틈이 있다. 사용자는 신규 생성을 확실히 차단하는 1급 옵션을 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (missing-feature / API-contract — 신규 생성을 막는 공식 옵션 부재)
- 서브시스템: django forms (model formsets)
- 증상 타입: silent-wrong (의도치 않게 새 객체가 생성됨)
- 로컬라이제이션 신호: "model formsets", "extra=0", "save_existing_object" 같은 단서가 모두 `django/forms/models.py`의 폼셋 팩토리/`save()` 경로를 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py` — `BaseModelFormSet.save()`, `modelformset_factory()`, `inlineformset_factory()`
- 근본 원인: `save()`가 항상 `save_existing_objects(commit) + save_new_objects(commit)`를 호출해 신규 폼을 무조건 저장했고, 신규 생성을 원천 차단할 클래스 수준 플래그가 존재하지 않았다.
- 수정 요지:
  - `save()`에 `self.edit_only` 분기 추가 — `True`면 `save_existing_objects(commit)`만 반환하고 `save_new_objects()`를 호출하지 않는다.
  - `modelformset_factory()`에 `edit_only=False` 인자를 추가하고 생성된 `FormSet.edit_only = edit_only`로 클래스 속성을 박는다.
  - `inlineformset_factory()`에도 `edit_only=False` 인자를 추가, kwargs에 실어 `modelformset_factory()`로 전달한다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `tests/model_formsets/tests.py`의 `test_edit_only`, `test_edit_only_inlineformset_factory`, `test_edit_only_object_outside_of_queryset`.
- 테스트가 픽스를 증명하는 방식:
  - `test_edit_only`: `edit_only=True` 폼셋에 신규 폼 2개를 보내고 `save()` 후 Author 테이블에 기존 charles만 남는지 확인. 이후 기존 객체 수정 데이터를 보내면 charles.name이 갱신되되 새 객체는 생기지 않음을 검증.
  - `test_edit_only_inlineformset_factory`: 인라인 폼셋에서도 기존 Book만 수정되고 신규 Book이 저장되지 않음을 확인.
  - `test_edit_only_object_outside_of_queryset`: queryset 밖의 pk(walt)를 보내도 새로 생성·수정되지 않고 기존 객체들이 그대로 유지됨을 `assertCountEqual`로 확인.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `django/forms/models.py`의 `BaseModelFormSet.save()`가 신규/기존 저장을 합치는 지점이 핵심 chokepoint. 그 다음 `modelformset_factory`/`inlineformset_factory` 팩토리가 클래스 속성을 어떻게 세팅하는지 따라가면 된다.
- 함정/난이도 메모: 수정 자체는 3줄 분기로 작지만, 새 옵션을 `inlineformset_factory` → `modelformset_factory` → `FormSet` 클래스 속성까지 일관되게 흘려야 한다(멀티 함수, 단일 파일). `max_num=0` 같은 기존 메커니즘으로 해결하려는 오해(hints에 길게 논의됨)에 빠지면 정작 `save()` 경로를 못 본다.
- 우리 에이전트 관점: 막힐 만한 지점은 (1) hints의 `max_num`/`validate_max` 우회를 진짜 해법으로 착각해 검증 레이어만 건드리는 것, (2) `save()`에만 플래그를 넣고 팩토리 두 곳에 인자 배선을 빠뜨려 `edit_only`가 클래스에 닿지 않는 것. 두 팩토리 모두에 인자를 추가하고 `FormSet.edit_only` 속성까지 세팅해야 inline 케이스가 통과한다.
