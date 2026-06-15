---
instance_id: django__django-15741
repo: django/django
base_commit: 8c0886b068ba4e224dd78104b93c9638b860b398
version: 4.2
difficulty: <15 min fix
created_at: 2022-05-28T09:52:42Z
fail_to_pass: 2
pass_to_pass: 104
gold_files: [django/utils/formats.py]
---

# django__django-15741

## 문제 요약
`django.utils.formats.get_format`이 lazy string(예: `_('Y-m-d')`)을 `format_type`으로 받으면 깨진다. 템플릿에서 `some_date|date:_('Y-m-d')`처럼 lazy 번역 문자열을 포맷으로 넘기면 `TypeError: getattr(): attribute name must be string` 예외가 난다. 사용자는 lazy 문자열도 일반 str처럼 동작하길 기대했다. 이전 커밋 659d2421c7adb(#20296 수정)이 회귀를 유발했다.

## 유형 분류
- 버그 카테고리: regression / 누락처리 (lazy 객체를 str로 강제 변환하지 않음)
- 서브시스템: django i18n / formats (locale 포맷 조회) + template date filter
- 증상 타입: 예외 (TypeError) — lazy proxy를 `getattr`의 attribute name으로 직접 사용
- 로컬라이제이션 신호: problem_statement가 `django.utils.formats.get_format`을 명시하고, 회귀 유발 커밋(#20296)과 `getattr()` 에러 메시지를 직접 지목 → 곧바로 `formats.py:get_format`으로 연결됨

## 골드패치 분석
- 건드린 파일/함수: `django/utils/formats.py:get_format`
- 근본 원인: `get_format`은 `format_type`을 `_format_cache`의 캐시 키 및 `getattr(module, format_type)` 조회에 사용한다. lazy 번역 객체(`__proxy__`)가 들어오면 str이 아니므로 `getattr`이 attribute name 타입 검사에서 `TypeError`를 낸다. #20296 수정 과정에서 format_type을 str로 정규화하던 경로가 사라져 회귀가 발생.
- 수정 요지: `use_l10n`/`lang` 결정 직후, `cache_key` 생성 전에 `format_type = str(format_type)  # format_type may be lazy.` 한 줄을 추가해 lazy proxy를 즉시 평가/문자열화한다. 이후 캐시 키와 getattr 모두 정상 str을 사용하게 되어 예외가 사라지고 캐싱도 일관되게 동작한다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작:
  - `i18n.tests.FormattingTests.test_get_format_lazy_format`: `get_format(gettext_lazy("DATE_FORMAT"))`이 `"N j, Y"`를 반환.
  - `template_tests.filter_tests.test_date.DateTests.test_date_lazy`: 템플릿 `{{ t|date:_("H:i") }}`가 `time(0,0)`에 대해 `"00:00"` 출력.
- 테스트가 어떻게 픽스를 증명하는지: lazy 객체를 format_type으로 직접 넘긴다(재현 입력). 픽스 전이면 `str()` 변환이 없어 `getattr` TypeError로 죽지만, `str(format_type)` 추가 후에는 `"DATE_FORMAT"` / `"H:i"`로 평가되어 정상 포맷 조회 → 기대 출력(`"N j, Y"`, `"00:00"`)이 나온다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 `formats.get_format`과 `getattr` TypeError를 직접 명시 → `django/utils/formats.py`의 `get_format` 함수 한 곳만 보면 된다. 단일 파일/단일 함수 수정.
- 함정/난이도 메모: 증상이 `date` 템플릿 필터에서 보이지만 실제 픽스 위치는 필터가 아니라 그 아래 `get_format`이다. 필터 쪽(`template/defaultfilters.py`)을 고치려 하면 헛다리. lazy 객체는 `==`/캐시 키로도 위험하므로 단순히 getattr 직전이 아니라 cache_key 생성 전에 변환해야 캐시 일관성까지 챙겨진다.
- 우리 에이전트 관점: 한 줄 픽스라 난이도는 낮으나, "어디에 str() 변환을 넣을지"를 cache_key 라인 이전으로 정확히 잡아야 함. getattr 직전에만 넣으면 캐시 키에 여전히 lazy 객체가 들어가 미묘한 캐시 키 불일치가 남을 수 있다. lazy/`__proxy__` 개념을 이해하고 근본 원인을 잡는지가 관건.
