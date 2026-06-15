---
instance_id: django__django-11433
repo: django/django
base_commit: 21b1d239125f1228e579b1ce8d94d4d5feadd2a6
version: "3.0"
difficulty: <15 min fix
created_at: 2019-05-31T17:06:20Z
fail_to_pass: 1
pass_to_pass: 142
gold_files: [django/forms/models.py]
---

# django__django-11433

## 문제 요약
ModelForm 제출 시, 어떤 필드가 data payload에 없고(예: 폼에 포함 안 됨, 다른 필드에서 파생되는 값) 그 필드가 모델에 default가 있으면, `clean()`에서 `self.cleaned_data['some_field'] = ...`로 값을 채워 넣어도 그 값이 무시되고 모델 default가 들어간다. 사용자는 `cleaned_data`를 수정하면 그게 인스턴스에 반영되길 기대하지만, 현재는 raw data를 복사·덮어써야만 했다. 즉 `cleaned_data`로 default를 오버라이드할 수 없는 게 증상.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (조건에 `cleaned_data` 검사가 빠진 logic 결함)
- 서브시스템: django forms (ModelForm `construct_instance`)
- 증상 타입: silent-wrong (예외 없이 잘못된 값 저장 — cleaned_data가 조용히 버려짐)
- 로컬라이제이션 신호: "has a default value on the model, it cannot be overwritten with self.cleaned_data" + PR 코멘트 링크. default 처리 분기가 있는 곳 = `django/forms/models.py`의 `construct_instance`, `f.has_default()`와 `value_omitted_from_data` 조합 부분.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py` : `construct_instance()`
- 근본 원인: data에 값이 없으면 모델 default를 유지하려고 `if f.has_default() and widget.value_omitted_from_data(...)`일 때 `continue`로 필드 세팅을 건너뛴다. 그런데 이 분기는 raw data(`form.data`/`form.files`)만 보고, `clean()`이 `cleaned_data`에 채워 넣은 값은 전혀 보지 않는다. 그래서 cleaned_data에 비-빈 값이 있어도 통째로 스킵된다.
- 수정 요지: continue 조건에 세 번째 절을 AND로 추가 — `cleaned_data.get(f.name) in form[f.name].field.empty_values`. 즉 "data에 값이 없고(default 후보) 그리고 cleaned_data 값도 여전히 빈 값일 때만" default를 유지하고 skip한다. cleaned_data에 비-빈 값이 들어 있으면 더 이상 skip하지 않고 그 값을 인스턴스에 세팅하므로 default가 오버라이드된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_default_not_populated_on_non_empty_value_in_cleaned_data` (`model_forms.tests.ModelFormBaseTest`)
- 테스트가 어떻게 픽스를 증명하는지: `PublicationDefaults`(mode에 default='di') 기반 PubForm을 빈 data `{}`로 만들고, `clean()`이 `cleaned_data['mode']`를 mocked 값으로 덮어쓴다. (1) `mocked_mode='de'`로 두면 `save(commit=False)` 인스턴스의 `mode == 'de'`여야 함 — 비-빈 cleaned_data가 default를 오버라이드함을 확인. (2) 그 다음 `field.empty_values`의 각 빈 값(None, '' 등)에 대해 subTest로 돌려, cleaned_data가 빈 값이면 여전히 default `'di'`가 채워짐을 확인. 즉 두 방향(비-빈 → 오버라이드, 빈 → default 유지)을 모두 회귀로 고정.

## 공략 포인트 (뭘 조져야)
- localization 전략: "model default" + "cleaned_data" + "ModelForm save"를 키워드로 `construct_instance`를 바로 찾는다. 이 함수의 `if f.has_default() and ... value_omitted_from_data ...: continue` 한 블록이 유일한 수정 지점.
- 함정/난이도 메모: 단일 파일·단일 조건 수정이라 난이도는 낮지만, "빈 값"의 정의를 직접 `''`/`None` 하드코딩하면 안 되고 `field.empty_values`를 써야 한다(테스트가 empty_values 전체를 순회). 또 인접한 checkbox/SelectMultiple용 기존 테스트(`test_default_not_populated_on_optional_checkbox_input` 등)를 깨면 안 되므로 raw-data 기반 default 보존 동작은 그대로 유지해야 한다.
- 우리 에이전트 관점: 막힐 만한 지점은 (a) cleaned_data를 보지 않고 widget 쪽만 만지려는 오진, (b) empty 판정을 `not cleaned_data.get(f.name)`처럼 truthy로 처리해 `0`/`False` 같은 값을 잘못 빈 값으로 보는 실수. 정답은 정확히 `in field.empty_values` 멤버십 검사라는 점을 짚어야 한다.
