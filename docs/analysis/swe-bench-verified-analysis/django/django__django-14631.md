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
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-14631

## 문제 요약
`BaseForm._clean_fields()`와 `BaseForm.changed_data`가 필드 값/initial을 `BoundField` 객체를 거치지 않고 `self.fields`에서 직접 다시 계산한다. 그 결과 `form._clean_fields()`가 산출한 disabled 필드의 initial 값이 `form[name].initial`(BoundField의 cached initial)과 달라질 수 있다. 핵심 증상은 callable initial(예: `datetime.datetime.now`)을 쓰는 disabled 필드에서 두 경로가 각각 callable을 호출해 서로 다른 값을 만든다는 것. 이슈는 단순 버그 수정이 아니라 "값 접근을 BoundField로 일원화하고, per-field changed 판정 로직을 `bf._did_change()`류 메서드로 옮기는" **구조 변경**을 요청하며, 목표 형태(`_bound_items()`, `[name for name, bf in self._bound_items() if bf._did_change()]`)까지 이슈 본문에 명시한다.

## 유형 (정형화)

3축 점수:

- **L = L3 (Multi-site)**. 픽스가 `django/forms/forms.py`(`_bound_items`/`__iter__`/`_html_output`/`_clean_fields`/`changed_data`/`_field_data_value` 제거)와 `django/forms/boundfield.py`(`BoundField.data`/신규 `_has_changed`) **두 파일에 조율되어 함께** 바뀐다. forms.py가 새로 만든 `_bound_items()`와 `BoundField._has_changed()`가 서로 맞물려야 하므로 단일-site가 아님. 다만 이슈가 심볼을 직접 지목하므로 "어디"를 찾는 비용 자체는 낮다(localize 난이도가 아니라 site 수가 L3을 만든다).
- **S = S6 (Design-Refactor) + 보조 S2 (Constraint-Reasoning)**. dominant는 한 줄 픽스가 아니라 *데이터 접근 경로를 BoundField로 일원화하는 작은 구조 변경*이다: collector 메서드(`_bound_items`) 도입 + per-field 로직을 `BoundField`로 lifecycle 이전. 보조 S2인 이유는, 옮긴 `_has_changed()` 안에서 `show_hidden_initial` 분기와 `to_python` 실패 시 `ValidationError`→"변경됨" 간주 같은 **불변식을 정확히 보존**해야 하고, disabled일 때 `bf.initial`(cached)·아니면 `bf.data`를 쓰는 조건을 정확히 합성해야 하기 때문(아무 후보나 던져 통과시키는 게 아님).
- **K = K-Domain**. django forms의 BoundField/Field/Widget lifecycle, `cached_property initial`, `show_hidden_initial`/`hidden_widget`/`html_initial_name`, `value_from_datadict`, FileField clean의 initial 인자 등 forms 서브시스템 내부 계약을 알아야 올바르게 옮길 수 있다. 일반 파이썬 추론만으론 부족.

**primary type = T-DesignRefactor** — L3 멀티파일 + S6가 dominant. 이슈가 위치를 다 알려줘 T-DiffuseLoc은 아니고, 픽스가 가드/상수 같은 기계적 한 줄이 아니므로 T-DirectMap도 아니다. 진짜 난점은 "조율된 구조 변경을 회귀 없이 수행"하는 데 있다.

**왜 이 strategy인가 (APR 관점)**: 결함의 근본은 *중복된 두 데이터 경로*(BoundField 경유 vs `_field_data_value`/`get_initial_for_field` 직접 호출)다. 패치는 결함 라인을 국소 수정하는 게 아니라 한쪽 경로를 제거하고 모두 BoundField로 수렴시키는 collect-then-process 형태의 구조 재배치 — 전형적 S6. 동시에 옮겨진 로직이 원래 불변식(hidden-initial, validation-fail-as-changed)을 보존해야 하므로 S2가 보조로 붙는다. G&V(S3/S4)로 "테스트만 통과시키는 후보"를 던지면 `_bound_items` 도입 범위를 잘못 잡아 P2P가 깨지기 쉬워 부적합.

## 난이도 티어
**Tier = T4 (약간 어려움)**. 공식 라벨 `1-4 hours`와 일치한다(재조정 불필요).

이 티어로 미는 구조적 피처:
- **멀티파일 조율(L3)** + **S6 구조 변경**: 두 파일이 새 메서드(`_bound_items`, `BoundField._has_changed`)를 통해 맞물려 바뀌어야 한다. T5의 "깊은 도메인/멀티헌크 overfit 고위험"까지는 아니고, 변경이 mechanical하게 따라가는 부분이 많아 T4가 적정.
- **넓은 P2P trap (regression-trap)**: PASS_TO_PASS 117개 — `_html_output`/`__iter__`까지 손대므로 폼 렌더링·iteration·changed_data·clean 전 영역의 인접 동작을 안 깨야 한다. 이게 단순 T3을 넘어 T4로 미는 핵심.
- **has-repro 완화**: 이슈가 조정 가능한 실패 테스트 형태를 직접 제시(`test_datetime_clean_initial_callable_disabled`를 어떻게 고치면 실패하는지 hint까지). 재현 신호가 강해 T5로 올리진 않는다.
- **localize 직접성**: 이슈가 파일·메서드·목표 코드 형태까지 적어줘 localize 비용은 거의 0. 난이도는 전적으로 "구조 변경을 회귀 없이 정확히 수행"에 있다.

공식 difficulty와 동일하지만, 그 시간이 "구현 분량"이 아니라 *117개 P2P를 안 깨는 조율*에서 온다는 점이 시간라벨에는 안 잡힌다.

## 골드패치 분석
- **건드린 파일/함수**:
  - `django/forms/boundfield.py`:
    - `ValidationError` import 추가.
    - `BoundField.data` (property): `self.form._field_data_value(self.field, ...)` → `self.form._widget_data_value(self.field.widget, ...)`.
    - 신규 `BoundField._has_changed()`: `show_hidden_initial`이면 `hidden_widget`/`html_initial_name`로 initial을 읽어 `field.to_python` (실패 시 `ValidationError`→`return True`), 아니면 `self.initial` 사용 후 `field.has_changed(initial_value, self.data)`.
  - `django/forms/forms.py`:
    - 신규 `BaseForm._bound_items()`: `for name in self.fields: yield name, self[name]`.
    - `__iter__`: docstring 추가(동작 동일).
    - `_html_output()`: `for name, field in self.fields.items()` → `for name, bf in self._bound_items()` + `field = bf.field`, 중복 `bf = self[name]` 제거.
    - `_clean_fields()`: `_bound_items()` 순회로 전환, `value = bf.initial if field.disabled else bf.data`, FileField clean의 initial을 `bf.initial`로.
    - `changed_data`: ~20줄 per-field 로직 → `return [name for name, bf in self._bound_items() if bf._has_changed()]`.
    - `_field_data_value()` **삭제**.
- **근본 원인**: `_clean_fields()`와 `changed_data`가 `self._field_data_value(field, ...)`와 `self.get_initial_for_field(field, name)`로 값·initial을 그때그때 재계산했다. `BoundField.initial`은 `cached_property`라 한 번만 평가되는데, 직접 경로는 그와 별개로 callable initial을 **다시 호출**한다. disabled + callable initial(`FakeTime.now`처럼 호출마다 다른 값)이면 `cleaned_data`와 `bf.initial`이 어긋난다.
- **수정 요지**: 모든 값/initial 접근을 BoundField 경유로 일원화(`_bound_items` 도입), `changed_data`의 per-field 판정을 `BoundField._has_changed()`로 lifecycle 이전, disabled 시 `bf.initial`(cached) 재사용으로 callable 단일 호출 보장, 중복 경로 `_field_data_value` 제거.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**:
  - "Cleaning a form with a disabled DateTimeField and callable initial" → `test_datetime_clean_disabled_callable_initial_microseconds`
  - "The cleaned value for a form with a disabled DateTimeField and callable" → `test_datetime_clean_disabled_callable_initial_bound_field`
- **픽스 증명**: 새 헬퍼 `get_datetime_form_with_callable_initial`이 `FakeTime.now`를 initial로 쓰는데, 호출될 때마다 `elapsed_seconds += 1`로 매번 다른 시각(14:30:46, 14:30:47, ...)을 반환한다. 픽스 전이면 `_clean_fields`와 `bf.initial`이 각각 callable을 호출해 서로 다른 시각을 산출 → `bound_field` 테스트의 `cleaned == bf.initial`이 깨지고, `microseconds` 테스트의 고정 기대값(`14:30:46`)도 불안정. 픽스 후엔 둘 다 cached `bf.initial`을 참조하므로 `cleaned_data['dt'] == datetime(2006,10,25,14,30,46)`이고 `cleaned == bf.initial`이 성립. microseconds 버전은 disabled clean이 마이크로초까지 제거(DateTimeField 처리)함도 함께 검증.
- **overfit 관점**: FAIL_TO_PASS 2개는 disabled+callable이라는 좁은 케이스만 직접 친다. 단순히 "disabled면 cleaned를 bf.initial로 강제"하는 special-case 픽스로도 이 둘은 통과 가능(overfit 여지) — 그래서 골드는 그 좁은 패치 대신 경로 자체를 일원화한다.
- **regression 관점**: 진짜 안전판은 117개 PASS_TO_PASS다. `test_changed_data`, `test_datetime_changed_data_callable_with_microseconds`, `#23674 invalid initial data should not break form.changed_data()`(= `to_python` 실패 시 changed 간주 불변식), `test_form_with_disabled_fields`, `_html_output` 계열(`test_field_named_data`, hidden input 병합 등), `__iter__` 계열(`test_form_with_iterable_boundfield`)이 구조 변경이 인접 동작을 안 깼는지 강하게 검증. `_bound_items` 도입이 `_html_output`/`__iter__`까지 손대므로 이 P2P 폭이 overfit-only 픽스를 거른다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `BaseForm._clean_fields()`·`BaseForm.changed_data`·`BoundField`를 직접 지목하고 `_bound_items()`/`bf._did_change()`/한 줄 `changed_data` 목표 형태까지 적어준다 → `django/forms/forms.py`의 두 메서드와 `django/forms/boundfield.py`로 즉시 수렴(L3이지만 탐색 비용은 거의 0). 신호: "form._clean_fields()가 form[name].initial과 다른 값을 반환할 수 있다".
2. **픽스와 왜 올바른 일반화인가**: 좁은 disabled-special-case가 아니라 **데이터 접근을 BoundField로 일원화**한다. `_bound_items()`로 `(name, bf)`를 yield하고 `_clean_fields`/`changed_data`/`_html_output`/`__iter__`를 모두 거기로 통일, per-field changed 판정을 `BoundField._has_changed()`로 이전. 핵심은 disabled일 때 `bf.initial`(cached_property)을 재사용해 callable initial을 **단 한 번만** 호출하는 것 — 이게 `cleaned_data`와 `bf.initial` 동일성을 모든 필드 타입/경로에서 보장하므로 테스트 너머로 일반화된다. 중복 경로 `_field_data_value` 제거로 "두 경로가 갈라질" 결함 클래스 자체를 소거.
3. **regression 안전**: `_has_changed()`로 옮길 때 원래 `changed_data`의 불변식을 전부 보존해야 한다 — `show_hidden_initial`이면 `hidden_widget`+`html_initial_name`로 읽어 `to_python`, 그 `ValidationError`는 "변경됨으로 간주"(`return True`)(= P2P `#23674`). FileField clean의 initial을 `bf.initial`로. `_html_output`/`__iter__`는 동작 동일하게(렌더 P2P 다수)·`_bound_items`가 `self[name]` 즉 BoundField를 정확히 yield하도록. 안 깨야 할 대표 P2P: `test_changed_data`, `test_datetime_changed_data_callable_with_microseconds`, `test_form_with_disabled_fields`, hidden/iterable boundfield 계열.
4. **함정 회피**: (a) silent 값 불일치라 재현 테스트 없이는 "동작한다"고 오판 — `FakeTime.now`처럼 **호출마다 다른 값**을 주는 callable로 재현해야 버그가 드러난다(lambda 고정값이면 가려짐). (b) `BoundField.initial`이 `cached_property`인 점을 놓치고 메서드만 옮기면서 여전히 callable을 재호출하면 회귀. (c) 리팩터 범위를 너무 좁게(예: disabled만 패치) 잡으면 일관성 결함은 남고, 너무 넓게/부정확하게(`_bound_items`로 `_html_output`·`__iter__` 손대며 BoundField 캐싱·error 처리 바꿈) 잡으면 117 P2P가 깨진다 — collector 도입 + 로직 이전이라는 골드의 정확한 절개선을 따라가는 게 안전.
