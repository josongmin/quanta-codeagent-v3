---
instance_id: django__django-15103
repo: django/django
base_commit: dd528cb2cefc0db8b91a7ff0a2bc87305b976597
version: 4.1
difficulty: 15 min - 1 hour
created_at: 2021-11-19T15:57:54Z
fail_to_pass: 2
pass_to_pass: 17
gold_files: [django/template/defaultfilters.py, django/utils/html.py]
---

# django__django-15103

## 문제 요약
`json_script`는 값을 JSON 인코딩해서 `<script type="application/json">` 태그로 감싸주는 유틸/템플릿 필터인데, `element_id` 인자가 필수로 되어 있다. 사용자는 `<template>` 안에 `<script>`를 넣는 경우처럼 id가 필요 없는 use-case가 있어서 id 없이도 쓰고 싶어 한다. 보안상으로도 다른 이유로도 id가 필수일 근거가 없으니 optional로 만들어 달라는 요청이다.

## 유형 분류
- 버그 카테고리: API-contract (필수 인자를 optional로 완화하는 enhancement)
- 서브시스템: django utils.html / template default filters
- 증상 타입: 잘못된 API 제약 (id 생략 시 호출/렌더 불가)
- 로컬라이제이션 신호: problem_statement에 함수명 `json_script`와 인자명 `element_id`가 그대로 명시 → `django/utils/html.py`의 실제 구현과 이를 노출하는 `django/template/defaultfilters.py`의 필터 래퍼 두 곳을 바로 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/utils/html.py:json_script`, `django/template/defaultfilters.py:json_script`
- 근본 원인: 시그니처가 `json_script(value, element_id)`로 `element_id`가 위치 필수 인자였고, 본문도 `'<script id="{}" ...>'`처럼 id를 항상 포맷에 넣어 생략을 허용하지 않았다.
- 수정 요지:
  - `utils/html.py`: 시그니처를 `element_id=None`으로 변경. `if element_id:`이면 기존 `id="{}"` 템플릿 + `(element_id, mark_safe(json_str))` 인자를, 아니면 id 없는 `'<script type="application/json">{}</script>'` 템플릿 + `(mark_safe(json_str),)`만 사용하도록 분기. 마지막에 `format_html(template, *args)`로 통일.
  - `template/defaultfilters.py`: 필터 래퍼 시그니처도 `json_script(value, element_id=None)`로 맞추고, docstring을 "(with an optional id)"로 갱신. 내부는 그대로 `_json_script` 위임.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_json_script_without_id` (utils_tests.test_html): `json_script({'key': 'value'})`를 id 없이 호출해 `<script type="application/json">{"key": "value"}</script>`가 나오는지 `assertHTMLEqual`로 확인.
  - `test_without_id` (template_tests.filter_tests.test_json_script): 템플릿 `{{ value|json_script }}`(id 인자 없이)를 렌더해 `<script type="application/json">{}</script>` 출력 확인.
- 어떻게 픽스를 증명하나: id 인자 없이 호출했을 때 (1) 호출 자체가 TypeError 없이 동작하고 (2) 출력 태그에 `id` 속성이 빠진 형태가 나오는지를 본다. 픽스 전에는 인자 부족으로 호출 실패 → FAIL.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 `json_script`/`element_id`를 직접 거명하므로 `grep -rn "def json_script"`로 바로 두 정의(utils/html.py 실구현 + defaultfilters.py 필터)에 도달.
- 함정/난이도 메모: 멀티파일 수정이 핵심. utils만 고치고 템플릿 필터 래퍼를 빼먹으면 `{{ value|json_script }}` 케이스(FAIL_TO_PASS 한 건)가 그대로 깨진다. 또 `if element_id:` 분기를 두지 않고 빈 문자열을 그냥 포맷하면 `id=""`가 남아 기대 출력과 불일치.
- 우리 에이전트 관점: 난이도 자체는 낮지만, "두 군데 동일 함수가 존재한다"는 점을 놓치기 쉽다. utils 한 곳만 패치하고 종료하면 템플릿 테스트에서 막힌다. 기존 PASS_TO_PASS의 `test_json_script`(id 있는 케이스)가 회귀하지 않도록 분기 안에서 기존 템플릿/인자 순서를 그대로 유지하는 게 안전 포인트.
