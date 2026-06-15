---
instance_id: django__django-12713
repo: django/django
base_commit: 5b884d45ac5b76234eca614d90c83b347294c332
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-04-13T23:57:12Z
fail_to_pass: 1
pass_to_pass: 58
gold_files: [django/contrib/admin/options.py]
---

# django__django-12713

## 문제 요약
Django admin의 `ModelAdmin.formfield_for_manytomany()`에 `widget` 파라미터를 직접 넘기거나 `formfield_overrides`로 위젯을 지정해도 무시된다. 동일한 ForeignKey 버전(`formfield_for_foreignkey()`)은 사용자가 넘긴 위젯을 존중하는데, M2M 버전은 그렇지 않아 동작이 비대칭이다. 사용자는 M2M 필드에 대해서도 커스텀 위젯(예: `CheckboxSelectMultiple`) 지정이 먹히기를 기대했다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (사용자 제공 `kwargs['widget']`을 존중하지 않음)
- 서브시스템: django.contrib.admin (admin forms / widget 결정 로직)
- 증상 타입: silent-wrong (에러 없이 지정한 위젯이 무시되고 admin 기본 위젯으로 덮어써짐)
- 로컬라이제이션 신호: problem_statement가 함수명 `formfield_for_manytomany()`를 직접 지목하고, "formfield_for_foreignkey()와 다르다"고 명시 → 두 함수를 나란히 비교하면 바로 차이를 발견 가능

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py` : `ModelAdmin.formfield_for_manytomany()`
- 근본 원인: 함수가 `autocomplete_fields` / `raw_id_fields` / `filter_vertical` / `filter_horizontal` 멤버십을 검사해 무조건 `kwargs['widget']`을 자기 위젯(`AutocompleteSelectMultiple`, `ManyToManyRawIdWidget`, `FilteredSelectMultiple`)으로 덮어썼다. 호출자가 이미 `widget`을 채워 넣었어도(예: `formfield_overrides`가 주입한 위젯) 무조건 갈아치움.
- 수정 요지: 위젯 결정 블록 전체를 `if 'widget' not in kwargs:` 가드로 감쌌다. 즉 호출자가 위젯을 명시하지 않은 경우에만 admin이 필드 분류에 따라 위젯을 선택하고, 이미 위젯이 있으면 그대로 둔다. 이는 바로 아래 `queryset` 처리의 `if 'queryset' not in kwargs:` 패턴과 동일하며 `formfield_for_foreignkey()`의 동작과도 일치한다. 로직 자체(세 분기)는 변경 없이 들여쓰기만 한 단계 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_formfield_overrides_m2m_filter_widget` — `filter_vertical = ['members']`이면서 동시에 `formfield_overrides = {ManyToManyField: {'widget': forms.CheckboxSelectMultiple}}`를 지정한 `BandAdmin`을 만든다.
- 증명 방식: `ma.formfield_for_dbfield(Band._meta.get_field('members'), request=None)`로 필드를 생성한 뒤 `field.widget.widget`이 `CheckboxSelectMultiple` 인스턴스인지 단언한다. (admin이 `RelatedFieldWidgetWrapper`로 감싸므로 `.widget.widget`으로 내부 위젯 확인.) 버그 상태에서는 `filter_vertical` 분기가 `FilteredSelectMultiple`로 덮어써 단언 실패 → 픽스 후 `formfield_overrides`가 넣은 위젯이 살아남아 통과. 테스트는 `ManyToManyField` import도 추가한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement가 함수를 직접 명명하므로 `formfield_for_manytomany`를 grep → `options.py` 한 군데. 동일 클래스의 `formfield_for_foreignkey`와 diff하면 "위젯을 항상 덮어쓰는지 vs 가드하는지" 차이가 즉시 드러남.
- 함정/난이도: 단일 파일·소규모지만, 세 개의 `elif` 분기를 각각 따로 가드하려 들면 중복·실수 유발. 골드처럼 블록 전체를 한 `if 'widget' not in kwargs:`로 묶는 것이 정답. `queryset` 가드가 바로 아래 있어 패턴을 모방하면 안전.
- 우리 에이전트 관점: 막힐 지점은 "어디에 가드를 넣느냐"보다 테스트가 기대하는 위젯 접근 경로(`field.widget.widget`, 즉 wrapper 한 겹). 픽스만 맞으면 통과하나, 회귀로 PASS_TO_PASS 60개(autocomplete/raw_id/filtered 기존 동작)가 깨지지 않게 분기 로직 자체는 보존해야 함 — 들여쓰기만 추가하는 최소 변경이 핵심.
