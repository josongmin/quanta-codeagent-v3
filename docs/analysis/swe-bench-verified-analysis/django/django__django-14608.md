---
instance_id: django__django-14608
repo: django/django
base_commit: 7f33c1e22dbc34a7afae7967783725b10f1f13b1
version: 4.0
difficulty: <15 min fix
created_at: 2021-07-07T19:51:30Z
fail_to_pass: 4
pass_to_pass: 394
gold_files: [django/forms/formsets.py]
---

# django__django-14608

## 문제 요약
Django의 Form은 non-field 에러를 렌더링할 때 ErrorList에 `nonfield` CSS 클래스를 붙여준다. 그런데 FormSet의 non-form 에러(예: `clean()` 교차검증 실패, validate_max/validate_min 초과)에는 대응되는 CSS 클래스가 없어서, 커스텀 ErrorList가 "필드 에러 / non-field 에러 / non-form 에러"를 구분해 렌더링할 수 없었다. 사용자는 FormSet의 non-form 에러에 `nonform` CSS 클래스를 추가해 주기를 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (API-contract — Form 쪽 규약을 FormSet이 따라가지 못함)
- 서브시스템: django forms / formsets (ErrorList 렌더링)
- 증상 타입: silent-wrong (예외는 없고 HTML 출력에 CSS 클래스가 빠짐)
- 로컬라이제이션 신호: "non form errors in FormSets", "nonfield CSS class for non field errors"라는 문구가 곧장 `forms/formsets.py`의 `non_form_errors` / `_non_form_errors` 경로를 가리킨다. 기존 `nonfield` 처리(`forms.py`)를 grep하면 동일 패턴을 FormSet으로 옮기면 된다는 게 드러난다.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/formsets.py` : `BaseFormSet.full_clean`
- 근본 원인: `full_clean()`에서 `self._non_form_errors`를 `self.error_class()`로 생성할 때 `error_class` 인자를 넘기지 않아, ErrorList의 기본 CSS 클래스(`errorlist`)만 적용되고 non-form 에러임을 표시하는 클래스가 누락됨.
- 수정 요지: `_non_form_errors`를 초기화하는 두 군데를 모두 `error_class='nonform'`을 넘기도록 변경했다. (1) 메서드 진입부의 빈 초기화 `self.error_class()` → `self.error_class(error_class='nonform')`, (2) `self.clean()`이 ValidationError를 던졌을 때의 `self.error_class(e.error_list)` → `self.error_class(e.error_list, error_class='nonform')`. 이렇게 하면 렌더링 시 `<ul class="errorlist nonform">`이 출력된다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: validate_max/validate_min 위반 시, formset의 `clean()` 교차검증 실패 시, 그리고 admin changelist의 non-form 에러가 ErrorList로 렌더링될 때 `nonform` 클래스가 붙는지.
- 테스트가 픽스를 증명하는 방식: `test_formset_validate_max_flag`/`min_flag`/`test_non_form_errors`는 검증 실패 formset의 `str(formset.non_form_errors())`가 정확히 `'<ul class="errorlist nonform"><li>...</li></ul>'`와 같은지 단언한다. admin 쪽 `test_non_form_errors_is_errorlist`는 기대값을 `ErrorList(["Grace is not a Zombie"])` → `ErrorList([...], error_class='nonform')`로 바꿔, 패치 전이라면 클래스 불일치로 문자열이 달라져 실패하게 만든다.

## 공략 포인트 (뭘 조져야)
- localization 전략: "FormSet non-form errors CSS class"가 단서. `non_form_errors` 메서드와 `_non_form_errors` 필드가 정의/대입되는 곳을 따라가면 `full_clean` 하나로 수렴한다. Form 쪽의 기존 `nonfield` 처리(`forms.py`의 `add_error`/`full_clean`)를 레퍼런스로 삼아 동일 인자를 미러링하면 된다.
- 함정/난이도 메모: `_non_form_errors` 대입 지점이 한 곳이 아니라 두 곳(빈 초기화 + ValidationError 캐치)이다. 한 군데만 고치면 일부 경로(특히 `clean()` 실패 경로)에서 클래스가 누락돼 FAIL_TO_PASS 일부가 안 풀린다. 단일 파일이지만 패치를 paired로 적용해야 함. 또 ErrorList 생성자 시그니처상 `error_class`가 키워드 인자라는 점을 정확히 맞춰야 한다.
- 우리 에이전트 관점: 난이도 자체는 낮은(<15분) 추가-인자 패치라 막힐 지점은 적다. 위험은 (1) 두 번째 대입 지점을 놓치는 부분 수정, (2) 테스트가 정확한 HTML 문자열 비교라서 클래스 순서/문구가 어긋나면 실패하는 점. 문서화(릴리스 노트/ErrorList 문서)는 FAIL_TO_PASS에 안 걸리므로 코드 두 줄만 정확히 잡으면 통과한다.
