---
instance_id: django__django-15916
repo: django/django
base_commit: 88e67a54b7ed0210c11523a337b498aadb2f5187
version: 4.2
difficulty: 15 min - 1 hour
created_at: 2022-08-04T18:59:18Z
fail_to_pass: 2
pass_to_pass: 149
gold_files: [django/forms/models.py]
---

# django__django-15916

## 문제 요약
`ModelForm`의 `Meta`에 `formfield_callback`을 지정해도 `modelform_factory`로 폼을 파생시키면 그 콜백이 무시된다. `modelform_factory`는 `formfield_callback` 인자를 받지만, 명시적으로 넘기지 않으면 베이스 폼의 `Meta.formfield_callback`을 쓰는 게 아니라 `None`(콜백 없음)으로 덮어쓴다. 사용자는 다른 `Meta` 옵션들(widgets, labels 등)과 일관되게 베이스 폼의 콜백이 상속되어 파생 폼에서도 필드가 동일하게 가공되길 기대한다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (다른 Meta 옵션과의 일관성 결여)
- 서브시스템: django forms / ModelForm 메타클래스
- 증상 타입: silent-wrong (예외 없이 콜백이 조용히 적용 안 됨)
- 로컬라이제이션 신호: problem_statement가 `django.forms.modelform_factory`와 `formfield_callback`을 직접 지목 → `django/forms/models.py`의 `modelform_factory`와 `ModelFormMetaclass`로 직행

## 골드패치 분석
- 건드린 파일/함수:
  - `django/forms/models.py:ModelFormOptions.__init__` — `formfield_callback`을 다른 Meta 옵션처럼 `getattr(options, "formfield_callback", None)`로 흡수
  - `django/forms/models.py:ModelFormMetaclass.__new__` — bases 순회로 `base_formfield_callback`을 찾던 로직과 `attrs.pop("formfield_callback", ...)`을 제거하고, `fields_for_model` 호출 시 `opts.formfield_callback`을 전달
  - `django/forms/models.py:modelform_factory` — `form_class_attrs`에서 `"formfield_callback"` 키를 빼고 `{"Meta": Meta}`만 남김
- 근본 원인: `formfield_callback`이 클래스 속성(attrs)으로만 다뤄지고 `Meta` 옵션 체계(`ModelFormOptions`)에 편입되지 않아, factory가 명시 인자를 안 받으면 베이스 폼의 Meta 콜백을 회수할 경로가 없었다.
- 수정 요지: `formfield_callback`을 정식 `Meta` 옵션으로 승격. `ModelFormOptions`가 이를 보관하고 메타클래스가 `opts.formfield_callback`을 단일 소스로 사용. factory는 더 이상 콜백을 별도 클래스 속성으로 주입하지 않으므로, `Meta`를 통해 자연스럽게 상속/전파된다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_custom_callback_in_meta` — `Meta`에만 `formfield_callback`을 둔 `ModelForm`을 정의했을 때 모든 `base_fields` 위젯이 콜백이 반환한 `Textarea`인지 확인
  - `test_custom_callback_from_base_form_meta` — `Meta`에 콜백을 둔 `BaseForm`을 `modelform_factory(form=BaseForm)`로 파생하고, 다시 서브클래싱한 `InheritedForm`까지 모든 필드 위젯이 `Textarea`로 상속되는지 확인
- 증명 방식: 콜백이 모든 필드를 `CharField(widget=Textarea)`로 강제 → 수정 전이면 factory 경로에서 콜백이 `None`으로 덮여 기본 위젯이 나오므로 `assertEqual(..., Textarea)` 실패. 수정 후 `Meta`를 통해 콜백이 전파되어 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: `grep formfield_callback django/forms/models.py`로 3개 사용처(`ModelFormMetaclass.__new__`의 bases 루프, `modelform_factory`의 `form_class_attrs`, `fields_for_model` 호출)를 동시에 잡아야 한다. `ModelFormOptions`가 Meta 옵션을 모으는 SSOT임을 인지하는 게 핵심.
- 함정/난이도 메모: 단일 파일이지만 3곳을 일관되게 고쳐야 한다. 메타클래스의 bases 순회만 지우고 `ModelFormOptions`에 추가를 빠뜨리면 콜백이 완전히 사라지고, factory의 `form_class_attrs`를 안 고치면 콜백이 attrs와 Meta 두 경로로 중복 전달돼 PASS_TO_PASS(`test_inherit_after_custom_callback`, `A custom formfield_callback is used if provided`)가 깨질 수 있다.
- 우리 에이전트 관점: "버그"가 아니라 "Meta 옵션으로 승격"이라는 리팩토링성 수정이라, 최소 변경만 하려는 에이전트는 메타클래스에 fallback 한 줄 추가로 때우려 들기 쉽다. 그러면 인접한 inherit/override 회귀 테스트와 충돌한다. `ModelFormOptions`로 콜백을 끌어올리는 구조적 정답을 찾는 게 관건.
