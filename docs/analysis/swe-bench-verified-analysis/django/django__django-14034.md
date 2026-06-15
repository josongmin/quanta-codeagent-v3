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
---

# django__django-14034

## 문제 요약
`MultiValueField`에서 `require_all_fields=False`로 두고 일부 서브필드만 `required=True`로 지정해도, 렌더링된 HTML의 모든 서브위젯 `<input>`에 `required` 속성이 붙어버린다. 사용자는 서브필드별 `required` 설정이 HTML 속성에도 반영되어, optional한 서브필드는 `required` 없이 렌더되기를 기대했다. (검증/`is_valid()` 동작 자체는 정상이며, 트래픽 끝의 합의대로 이 티켓은 "렌더링 시 required 속성" 문제로 좁혀졌다.)

## 유형 분류
- 버그 카테고리: 누락처리 (서브필드 단위 required를 위젯 속성에 반영하지 않음) / API-contract
- 서브시스템: django forms (BoundField 위젯 속성 빌드, MultiValueField/MultiWidget)
- 증상 타입: 잘못된 출력 (HTML 렌더링이 의도와 다름; silent-wrong)
- 로컬라이제이션 신호: 힌트에서 `boundfield.py`의 `build_widget_attrs`가 명시적으로 지목됨 — "This code looks at the field required status rather than subwidgets". 필드 전체의 `required`만 보고 개별 서브위젯을 구분하지 못한다는 점이 핵심 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/boundfield.py:BoundField.build_widget_attrs`
- 근본 원인: `build_widget_attrs`는 `self.field.required`가 True면 무조건 `attrs['required'] = True`를 세팅했다. `MultiValueField`처럼 여러 서브필드를 가진 경우에도 부모 필드의 required만 보기 때문에, 각 서브위젯의 개별 required 의도가 무시된다.
- 수정 요지: 필드가 `require_all_fields` 속성을 가지고 그 값이 False이며 위젯이 `MultiWidget`인 경우를 분기. 이 경우 `attrs['required']`를 일괄 세팅하지 않고, `zip(self.field.fields, widget.widgets)`로 서브필드/서브위젯을 짝지어 순회하면서 각 `subwidget.attrs['required']`를 `subwidget.use_required_attribute(self.initial) and subfield.required`로 개별 설정한다. 그 외 일반 케이스는 기존대로 `attrs['required'] = True`. import에 `MultiWidget` 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_render_required_attributes` — `MultiValueField`(required=True, require_all_fields=False)에서 첫 서브필드만 `required=True`인 `PartiallyRequiredForm`을 렌더.
- 증명 방식: `{'f_0':'Hello','f_1':''}` 입력으로 `is_valid()`가 True임을 확인하고, `assertInHTML`로 `f_0` input에는 `required`가 붙고 `f_1` input에는 `required`가 없음을 검증. 추가로 `{'f_0':'','f_1':''}`은 required 서브필드가 비어 `is_valid()`가 False임을 확인해, 검증 로직은 손대지 않으면서 HTML 속성만 서브필드별로 갈린다는 점을 증명.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: `boundfield.py`의 `build_widget_attrs`가 단일 진입점. 힌트가 정확히 지목하므로 localization은 쉬운 편.
- 함정/난이도 메모: (1) problem_statement는 `is_valid()` 버그처럼 읽히지만, 트래픽 끝 합의(Jacob/David 코멘트)대로 검증 로직(`MultiValueField.clean`)은 건드리면 안 됨 — required MVF에 전 서브필드 공란이면 통과하는 기존 동작은 정상이고 테스트도 있음. validation을 고치려 들면 PASS_TO_PASS(`test_clean` 등)가 깨진다. (2) `attrs['required']`(부모)가 아니라 `subwidget.attrs['required']`(서브위젯)에 써야 함. (3) `MultiWidget` import 누락 시 즉시 실패.
- 우리 에이전트 관점: 막힐 지점은 "증상 서술과 실제 골드 수정 범위의 불일치". 문제문만 보면 `clean`/`is_valid`로 파고들어 over-fix하기 쉽다. 힌트 스레드 후반의 범위 축소 합의를 읽어야 정답 범위로 수렴하므로, problem_statement 표면이 아닌 hints_text의 최종 결론을 신뢰해야 한다.
