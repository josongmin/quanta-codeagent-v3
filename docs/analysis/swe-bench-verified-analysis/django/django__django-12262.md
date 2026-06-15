---
instance_id: django__django-12262
repo: django/django
base_commit: 69331bb851c34f05bc77e9fc24020fe6908b9cd5
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-12-30T13:13:59Z
fail_to_pass: 4
pass_to_pass: 18
gold_files: [django/template/library.py]
---

# django__django-12262

## 문제 요약
`@register.simple_tag` / `@register.inclusion_tag`로 만든 커스텀 템플릿 태그가 keyword-only 인자(`*, kwarg=...`)를 받을 때, 템플릿에서 그 키워드를 실제로 넘기면 `'tag' received unexpected keyword argument 'kwarg'`라는 TemplateSyntaxError가 부당하게 발생한다. 사용자는 keyword-only 인자가 정상 전달되기를 기대했다. 또한 같은 키워드를 두 번 넘기면 "multiple values for keyword argument" 대신 위의 "unexpected keyword argument" 메시지가 잘못 나온다.

## 유형 분류
- 버그 카테고리: logic / edge-case (keyword-only 인자 미고려)
- 서브시스템: django template / custom template tag 인자 파싱 (`parse_bits`)
- 증상 타입: 예외 (잘못된 TemplateSyntaxError) + 잘못된 에러 메시지
- 로컬라이제이션 신호: problem_statement에 "the offending line is from 2.0"과 "unexpected keyword argument" 에러 문구가 명시 → 이 문구를 grep하면 곧장 `django/template/library.py`의 `parse_bits`로 수렴

## 골드패치 분석
- 건드린 파일/함수: `django/template/library.py:parse_bits`
- 근본 원인: kwarg가 추출된 뒤 "예상치 못한 키워드인지" 판정할 때 조건이 `param not in params and param not in unhandled_kwargs and varkw is None`였다. `unhandled_kwargs`는 루프가 돌면서 이미 소비된 항목이 제거되는 가변 집합이라, keyword-only 인자(특히 기본값이 있어 `params`에 없는 경우)를 정확히 표현하지 못한다. 결과적으로 유효한 keyword-only 인자가 "unexpected"로 오판되고, 중복 전달도 같은 분기로 빠져 잘못된 메시지를 낸다.
- 수정 요지: 조건을 `param not in params and param not in kwonly and varkw is None`으로 변경. 즉 keyword-only 인자 목록(`kwonly`, getfullargspec 기반)을 기준으로 삼아, keyword-only 인자는 `params`에 없어도 "unexpected"로 처리하지 않는다. 이로써 중복 전달 케이스는 이 분기를 통과해 뒤쪽의 "multiple values" 처리로 흘러가 올바른 메시지가 나온다.

## 검증 (test_patch)
- FAIL_TO_PASS: `SimpleTagTests.test_simple_tags/test_simple_tag_errors`, `InclusionTagTests.test_inclusion_tags/test_inclusion_tag_errors`
- 테스트가 증명하는 방식:
  - 정상 경로: `{% simple_keyword_only_default kwarg=37 %}` → `Expected result: 37` (이전엔 unexpected 예외). inclusion 쪽도 새 태그 `inclusion_keyword_only_default(*, kwarg=42)`를 등록해 `kwarg=37` 전달 시 정상 렌더 확인.
  - 에러 경로: `kwarg=42 kwarg=37`처럼 동일 키워드 중복 전달 시 `received multiple values for keyword argument 'kwarg'` 메시지가 나오는지 검증 (simple/inclusion, default 있는/없는 keyword-only 모두).

## 공략 포인트 (뭘 조져야)
- 어디부터: 에러 문구 `"received unexpected keyword argument"`를 전역 grep → `django/template/library.py`의 `parse_bits` 단일 함수로 즉시 로컬라이즈. 단일 파일/단일 라인 수정.
- 함정/난이도 메모: `unhandled_kwargs`와 `kwonly`가 둘 다 함수 상단에서 만들어지는 비슷한 이름이라, 정확히 `kwonly`로 바꿔야 한다는 통찰이 핵심. `unhandled_kwargs`는 루프 중 소비되며 변하는 집합이라 "현재 남은 것" 의미가 강해 헷갈리기 쉽다. 또 default 유무(`kwonly_defaults`)에 따라 `params` 포함 여부가 달라지는 점을 이해해야 정상/중복 두 케이스가 한 번에 풀린다.
- 우리 에이전트 관점: 로컬라이제이션은 쉽지만, 한 글자(`unhandled_kwargs`→`kwonly`)만 바꾸는 미세 수정이라 "왜 unexpected와 multiple-values 두 증상이 같은 조건에서 갈리는지"를 정확히 추론하지 못하면 과도한 리팩터(별도 if 추가 등)로 빠질 위험. 골드는 최소 변경임을 인지하는 게 관건.
