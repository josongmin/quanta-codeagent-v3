---
instance_id: django__django-14631
repo: django/django
base_commit: 84400d2e9db7c51fee4e9bb04c028f665b8e7624
version: 4.0
difficulty: 1-4 hours
created_at: 2021-07-13T09:16:48Z
fail_to_pass: 2
pass_to_pass: 117
gold_files: [django/forms/boundfield.py, django/forms/forms.py]
---

# django__django-14631

## 문제 요약
`BaseForm._clean_fields()`와 `BaseForm.changed_data`가 값을 `BoundField` 객체를 통하지 않고 직접 `self.fields`에서 가져온다. 그 결과 `form._clean_fields()`가 계산한 disabled 필드의 initial 값이 `form[name].initial`(BoundField의 캐시된 initial)과 달라질 수 있다. callable initial(예: `datetime.datetime.now`)을 쓰는 disabled 필드에서 두 경로가 각각 callable을 호출해 서로 다른 값을 만드는 게 핵심 증상이다. 일관성 향상과 코드 경로 축소를 위해 두 메서드가 모두 BoundField를 거치도록 리팩터링하길 기대.

## 유형 분류
- 버그 카테고리: logic / API-contract (consistency, 중복 코드 경로로 인한 값 불일치)
- 서브시스템: django forms (BaseForm / BoundField)
- 증상 타입: silent-wrong (예외 없이 cleaned_data와 bf.initial이 불일치)
- 로컬라이제이션 신호: problem_statement가 `BaseForm._clean_fields()`, `BaseForm.changed_data`, `BoundField`를 직접 명시하고, `bf.did_change()`/`_bound_items()` 같은 목표 형태까지 제시한다. 파일은 `django/forms/forms.py`와 `django/forms/boundfield.py`로 직결.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/forms/boundfield.py`: `BoundField.data` (property), 신규 `BoundField._has_changed()`
  - `django/forms/forms.py`: 신규 `BaseForm._bound_items()`, `__iter__`, `_html_output()`, `_clean_fields()`, `changed_data`, 삭제된 `_field_data_value()`
- 근본 원인: `_clean_fields()`와 `changed_data`가 `self._field_data_value(field, ...)`와 `self.get_initial_for_field(field, name)`로 값/initial을 그때그때 다시 계산했다. disabled + callable initial이면 BoundField가 캐시한 `bf.initial`과 별개로 callable을 다시 호출해 다른 시각/값을 산출.
- 수정 요지:
  - `BaseForm._bound_items()`를 추가해 `(name, bf)` 쌍을 yield, `_html_output`/`_clean_fields`/`changed_data`/`__iter__`가 모두 BoundField 경유로 통일.
  - `_clean_fields()`에서 disabled면 `bf.initial`, 아니면 `bf.data`를 사용하고 FileField clean의 initial도 `bf.initial`로 교체.
  - `changed_data`를 `[name for name, bf in self._bound_items() if bf._has_changed()]` 한 줄로 축소하고, 기존 per-field 로직을 `BoundField._has_changed()`로 이동(show_hidden_initial 처리, to_python 실패 시 `ValidationError`로 변경 간주 포함).
  - `BoundField.data`를 `_field_data_value` 대신 `_widget_data_value(self.field.widget, ...)`로 바꾸고 죽은 `_field_data_value()` 제거.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - "Cleaning a form with a disabled DateTimeField and callable initial" → `test_datetime_clean_disabled_callable_initial_microseconds`
  - "The cleaned value for a form with a disabled DateTimeField and callable" → `test_datetime_clean_disabled_callable_initial_bound_field`
- 테스트가 어떻게 픽스를 증명하는지: 헬퍼 `get_datetime_form_with_callable_initial`이 `FakeTime.now`를 initial로 쓰는데, 호출될 때마다 `elapsed_seconds`를 +1 해서 매 호출 다른 시각을 반환한다. 픽스 전이면 `_clean_fields`와 `bf.initial`이 각각 callable을 호출해 14:30:46 vs 14:30:47처럼 어긋난다. 픽스 후엔 둘 다 동일한 `bf.initial`(캐시)을 참조하므로 `cleaned_data['dt'] == datetime(2006,10,25,14,30,46)`이고 `cleaned == bf.initial`이 성립. microseconds 버전은 disabled clean이 마이크로초를 제거함도 함께 검증.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/forms/forms.py`의 `_clean_fields`와 `changed_data`. 두 메서드가 `self.fields.items()`를 직접 순회하며 `_field_data_value`/`get_initial_for_field`를 호출하는 부분이 표적. BoundField 경유로 바꾸는 게 본질.
- 함정/난이도 메모:
  - 멀티파일(forms.py + boundfield.py). `changed_data`의 show_hidden_initial 분기 로직을 그대로 `BoundField._has_changed()`로 옮길 때 `html_initial_name`/`hidden_widget`/`to_python` ValidationError 처리를 빠뜨리기 쉽다.
  - `BoundField.initial`은 cached_property라 "한 번만 호출"이 픽스의 핵심 — 단순히 메서드만 옮기고 여전히 callable을 재호출하면 회귀.
  - `_field_data_value` 제거 시 다른 호출처(BoundField.data)도 함께 갱신해야 한다(잔존하면 dead/불일치).
- 우리 에이전트 관점: 증상이 예외가 아닌 silent 값 불일치라 재현 테스트 없이는 "동작한다"고 오판하기 쉽다. 또한 callable initial을 매번 다른 값으로 만드는 FakeTime 패턴을 못 떠올리면 lambda 고정값으로 테스트해 버그가 가려진다. 리팩터링 범위(`_bound_items` 도입으로 `__iter__`/`_html_output`까지 손대는지)를 좁게 잡으면 119개 PASS_TO_PASS 중 일부가 깨질 수 있다.
