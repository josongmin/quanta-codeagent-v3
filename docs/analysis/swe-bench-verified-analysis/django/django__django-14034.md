---
instance_id: django__django-14034
repo: django/django
base_commit: db1fc5cd3c5d36cdb5d0fe4404efd6623dd3e8fb
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-02-22T19:32:50Z
fail_to_pass: 1
pass_to_pass: 12
gold_files: [django/forms/boundfield.py]
primary_type: T-SpecInference
tier: T4
loc_axis: L0
repair_strategy: S5 (+S2)
knowledge: K-Domain
flags: [underspecified, regression-trap, has-repro]
---

# django__django-14034

## 문제 요약
`MultiValueField`에서 `require_all_fields=False`로 두고 일부 서브필드만 `required=True`로 지정해도, 렌더링된 HTML의 모든 서브위젯 `<input>`에 `required` 속성이 일괄로 붙는다. 사용자는 서브필드별 `required` 설정이 HTML 속성에도 반영되어 optional 서브필드는 `required` 없이 렌더되기를 기대했다. problem_statement는 `is_valid()` 버그처럼 서술되지만, 힌트 스레드 후반(Jacob/David 합의)에서 검증 로직은 정상이고 — required MVF에 전 서브필드 공란이면 통과하는 동작은 의도된 것이며 기존 테스트도 있음 — 티켓 범위가 "MVF가 required이면서 require_all_fields=False일 때 서브위젯별로 HTML required 속성을 매핑한다"로 재정의되었다.

## 유형 (정형화)

**L (Localization) = L0 — Pinpointed.**
힌트가 수정 지점을 직접 지목한다: "Possible culprit? ...boundfield.py#L221 / Does this method also need to account for the require_all_fields value on MultiValueField?"와 "This code looks at the field required status rather than subwidgets." `boundfield.py`의 `build_widget_attrs`가 grep 한 방으로 단일 진입점. 탐색 노력 거의 없음.

**S (Repair Strategy) = S5 Spec-Inference (+S2 Constraint-Reasoning).**
이게 dominant인 이유: 픽스의 핵심 난점이 "어디/어떻게 코드를 짜나"가 아니라 **"의도된 동작이 무엇인가를 먼저 재구성"**하는 데 있다. 코드만 보면 `attrs['required']=True`가 버그인지 의도인지 결정되지 않고, problem_statement는 `is_valid()`가 틀렸다고 잘못 명세한다(underspecified). 올바른 스펙은 Carlton/Jacob/David의 트래픽 결론과 docs("When require_all_fields set to False, Field.required can be set to False for individual fields to make them optional")에서 재구성해야만 나온다 — "required MVF = 이 서브필드 집합을 통째로 건너뛸 수 있나? / require_all_fields=False면 개별 서브필드는 자기 required를 존중한다". 즉 SpecRover류로 스펙을 먼저 확정해야 픽스 형태가 정해진다. 일단 스펙이 정해지면 조건식 `subwidget.use_required_attribute(self.initial) and subfield.required`를 불변식·엣지(초기값/required 조합)를 따져 합성하는 부분이 S2 보조다.

**K (Knowledge) = K-Domain.**
django forms 내부 모델 지식이 병목: `MultiValueField.require_all_fields` 의미론, `MultiWidget`/서브위젯 `widgets` 배열, `BoundField`가 위젯 attrs를 빌드하는 시점·경로, `widget.use_required_attribute(initial)` 계약, `field.fields`와 `widget.widgets`의 1:1 대응. 일반 파이썬 추론으로는 안 풀린다.

**Primary type = T-SpecInference.**
L0(찾기는 쉬움)·K-Domain이 동반되지만 dominant는 S5다. 진짜 어려움이 "이슈가 잘못 명세한 동작을 트래픽·docs에서 올바른 스펙으로 되살리는 것"에 있고, 그 스펙 확정이 over-fix(validation 수정)를 막는 결정적 분기점이기 때문. K-Domain만으로 T-DomainBound로 보지 않는 이유는, 도메인지식은 위치를 찾고 나면 보조적이고 병목이 스펙 추론이라는 점.

## 난이도 티어
**Tier = T4 (약간 어려움).**

이 티어로 미는 구조적 피처:
- **단일 파일·단일 함수** (`boundfield.py:build_widget_attrs`), gold patch 1파일 ~11줄 추가 + import 1줄 → scope 자체는 작음(이건 T2 쪽 신호).
- 하지만 **S5 spec-inference + underspecified**: problem_statement가 증상을 `is_valid()` 버그로 오도해, 표면만 읽으면 `MultiValueField.clean`으로 파고들어 검증 로직을 over-fix한다. 정답 범위 수렴이 힌트 스레드의 합의를 정확히 읽어야만 가능 — 이게 T2/T3가 아니라 T4로 올리는 핵심.
- **regression-trap (P2P=12)**: `test_clean`, `test_clean_disabled_multivalue`, `test_form_as_table`, `test_form_cleaned_data` 등 인접 동작이 넓게 묶여 있어, validation을 건드리면 즉시 깨진다. 픽스를 HTML 속성 경로로만 한정해야 통과.
- **K-Domain**: 서브위젯 attrs 매핑·`use_required_attribute` 계약을 정확히 써야 함.

공식 라벨("15 min - 1 hour")은 개발자가 합의된 스펙을 손에 쥔 뒤의 *구현* 시간이다. 에이전트 관점에서는 그 합의(스펙)를 스스로 복원해야 하고 over-fix 함정이 있어 시간라벨보다 어렵다 — 그래서 T3가 아닌 T4. 반대로 멀티파일·구조변경·overfit 고위험이 없어 T5까지는 가지 않는다.

## 골드패치 분석
- **건드린 파일/함수**: `django/forms/boundfield.py` — `BoundField.build_widget_attrs` (+ 모듈 import에 `MultiWidget` 추가).
- **근본 원인**: `build_widget_attrs`는 `widget.use_required_attribute(self.initial) and self.field.required and self.form.use_required_attribute`가 참이면 무조건 `attrs['required'] = True`를 부모 위젯 레벨에 세팅했다. `MultiValueField`처럼 서브필드/서브위젯이 여럿인 경우에도 부모 필드의 `required`만 보기 때문에, `require_all_fields=False`로 켜둔 개별 서브필드의 required 의도가 HTML 속성에서 전부 균일하게 뭉개진다.
- **수정 요지**: 필드가 `require_all_fields` 속성을 갖고 그 값이 False이며 `isinstance(self.field.widget, MultiWidget)`인 경우를 분기. 이 경우 부모 `attrs`에 일괄 세팅하지 않고, `zip(self.field.fields, widget.widgets)`로 서브필드/서브위젯을 짝지어 순회하며 각 `subwidget.attrs['required']`를 `subwidget.use_required_attribute(self.initial) and subfield.required`로 **개별** 설정한다. 그 외 일반 케이스는 기존대로 `attrs['required'] = True`. 검증 경로(`MultiValueField.clean`)는 손대지 않는다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_render_required_attributes (forms_tests.field_tests.test_multivaluefield.MultiValueFieldTest)`.
  - `PartiallyRequiredField(MultiValueField)` + `PartiallyRequiredForm`을 신규 정의: `fields=(CharField(required=True), CharField(required=False))`, `required=True`, `require_all_fields=False`, `widget=MultiWidget([TextInput(), TextInput()])`.
- **픽스 증명**: `{'f_0':'Hello','f_1':''}` 입력에서 `is_valid()`가 True임을 먼저 확인(검증 로직 무변경 증명) 후, `assertInHTML`로 `f_0` input에는 `required`가 붙고(`<input ... name="f_0" ... required ...>`) `f_1` input에는 `required`가 **없음**을 검증. 마지막으로 `{'f_0':'','f_1':''}`은 required 서브필드(`f_0`)가 비어 `is_valid()`가 False임을 확인 — 서브필드별 검증 의미는 보존됨.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇다. 주의할 인과: 두 `is_valid()` 단언은 `build_widget_attrs`가 아니라 `MultiValueField.clean`(value/required로만 검증, 서브위젯 required 분기와 독립)을 경유하므로, `build_widget_attrs`에서 "첫 서브위젯만 required, 나머지는 not"으로 하드코딩하는 special-case를 **전혀 막지 못한다** — 그 hack은 두 is_valid 단언과 HTML 단언(f_0 required, f_1 no-required)을 모두 통과한다. 실제로 막히는 것은 (a)`f_1`에 required가 없어야 한다는 HTML 단언이 원래의 무조건 `attrs['required']=True` 동작을 막는 것뿐이고, gold 테스트의 필드 순서가 `required=True`(f_0)를 먼저 두므로 "first-only required" 하드코딩 overfit은 여전히 통과 가능하다. 더해 초기값(`initial`)이 있는 시나리오·required=False 서브필드가 첫 위치인 조합 등 미검증 입력공간이 남아 있어, 골드의 `use_required_attribute(self.initial)` 항이 빠진 부분픽스도 이 테스트만으론 통과 가능한 잔여 overfit 여지가 있다.
- **regression 관점**: P2P 12개가 validation·렌더 전반(`test_clean*`, `test_form_as_table*`, `test_form_cleaned_data`, `test_*has_changed*`)을 덮는다. 픽스를 `clean`이 아닌 `build_widget_attrs`의 새 분기로만 한정했고, 비-MVF/`require_all_fields` 미보유 필드는 기존 `else` 경로(`attrs['required']=True`)로 byte-동일하게 흐르므로 인접 동작이 안 깨진다.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement의 "모든 input에 required가 붙는다"는 HTML 증상 + 힌트의 직접 포인터("boundfield.py#L221", "looks at the field required status rather than subwidgets")를 따라간다. `grep build_widget_attrs django/forms/boundfield.py` 한 방으로 `BoundField.build_widget_attrs`에 도달. `attrs['required'] = True`가 부모 필드 `self.field.required`만 보고 서브위젯을 구분하지 않는 라인이 결함 지점.

2. **픽스와 왜 올바른 일반화인가**: `require_all_fields` 속성 보유 + False + 위젯이 `MultiWidget`일 때만 새 경로로 분기하여, `zip(self.field.fields, widget.widgets)`로 각 `subwidget.attrs['required']`를 `subwidget.use_required_attribute(self.initial) and subfield.required`로 설정. 이게 special-case 박기가 아니라 올바른 일반화인 이유: 조건식이 (a)서브필드 자신의 `subfield.required`를 권위로 삼고(=docs가 명시한 "individual fields can be optional" 계약), (b)부모 케이스와 동일한 `use_required_attribute(self.initial)` 가드를 서브위젯 단위로 재적용해 초기값/hidden 위젯 등 기존 required-억제 의미를 보존하기 때문. 즉 임의 입력의 어떤 서브필드 조합에도 "required MVF + 서브필드별 required 존중"이라는 재구성된 스펙대로 동작한다.

3. **regression 안전**: 분기 조건을 `hasattr(require_all_fields) and not require_all_fields and isinstance(widget, MultiWidget)`로 좁혀, 일반 단일 위젯 필드·`require_all_fields`가 True인 MVF는 모두 기존 `else: attrs['required']=True` 경로로 그대로 흐른다 → `test_form_as_table*` 등 기존 required 렌더가 보존. 검증 로직(`MultiValueField.clean`)은 절대 건드리지 않아 `test_clean`, `test_clean_disabled_multivalue`, `If insufficient data is provided, None is substituted.` 등 P2P가 안전. "required MVF 전체 공란 → 통과"는 기존 의도된 동작이므로 유지.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 두 가지. (1) **over-fix**: problem_statement가 `is_valid()`를 버그로 명세하므로 `MultiValueField.clean`을 고치려 들기 쉽다 → P2P `test_clean*`이 깨진다. 회피법은 hints_text 후반의 범위 축소 합의("avoid making changes to validation", "only handle ... set the required attribute on the widget")를 신뢰해 HTML 속성 경로로만 한정하는 것. (2) **잘못된 타깃 객체**: 부모 `attrs['required']`가 아니라 각 `subwidget.attrs['required']`에 써야 서브위젯별로 갈린다. 더해 `MultiWidget` import 누락 시 `NameError`로 즉시 실패하므로 import 추가를 잊지 말 것.
