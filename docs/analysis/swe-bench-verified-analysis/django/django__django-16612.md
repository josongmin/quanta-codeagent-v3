---
instance_id: django__django-16612
repo: django/django
base_commit: 55bcbd8d172b689811fae17cde2f09218dd74e9c
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-03-02T19:06:12Z
fail_to_pass: 2
pass_to_pass: 335
gold_files: [django/contrib/admin/sites.py]
---

# django__django-16612

## 문제 요약
`AdminSite.catch_all_view()`가 `APPEND_SLASH=True`로 trailing slash를 붙여 301 리다이렉트할 때 쿼리스트링을 버린다. 예를 들어 `/admin/auth/foo?id=123` 요청은 `/admin/auth/foo/?id=123`로 가야 하는데 실제로는 `/admin/auth/foo/`로 리다이렉트되어 `id=123`이 사라진다. #31747에서 catch_all_view를 도입하는 과정(regression ba31b01)에서 발생한 회귀다.

## 유형 분류
- 버그 카테고리: regression / 누락처리 (쿼리스트링 누락)
- 서브시스템: django.contrib.admin (admin site URL dispatch / redirect)
- 증상 타입: silent-wrong (잘못된 리다이렉트 URL — 예외 없이 쿼리 데이터 유실)
- 로컬라이제이션 신호: problem_statement가 파일·라인·문제 코드(`return HttpResponsePermanentRedirect("%s/" % request.path)`)와 함수명(`catch_all_view`)을 명시적으로 지목한다. `request.path`는 쿼리스트링을 포함하지 않는 속성이라는 점이 핵심 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/sites.py` : `AdminSite.catch_all_view`
- 근본 원인: 리다이렉트 대상 URL을 `"%s/" % request.path`로 직접 조립했는데, `request.path`는 쿼리스트링(`request.META['QUERY_STRING']`)을 포함하지 않으므로 `?id=123`이 통째로 누락된다. slash 부착 로직을 손수 문자열로 구성한 것이 화근.
- 수정 요지: 직접 문자열 조립 대신 `request.get_full_path(force_append_slash=True)`로 교체. `get_full_path`는 path + 쿼리스트링을 함께 반환하고 SCRIPT_NAME 접두까지 처리하며, `force_append_slash=True` 인자로 trailing slash를 안전하게 강제한다. should_append_slash 분기 자체는 그대로 유지.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_missing_slash_append_slash_true_query_string`: slash 없는 changelist URL에 `?id=1`을 붙여 GET → `{known_url}?id=1`로 301 리다이렉트되어야 함(쿼리 보존).
  - `test_missing_slash_append_slash_true_script_name_query_string`: 같은 시나리오에 `SCRIPT_NAME="/prefix/"`를 추가 → `/prefix{known_url}?id=1`로 리다이렉트되어 prefix와 쿼리 둘 다 보존되어야 함.
- 증명 방식: 픽스 전에는 `request.path`만 써서 `?id=1`이 빠지므로 assertRedirects의 기대 target과 불일치해 실패. `get_full_path(force_append_slash=True)`로 바꾸면 쿼리·SCRIPT_NAME 모두 포함된 정확한 URL이 나와 통과. 추가된 non_staff/without_final_catch_all 쿼리 테스트는 PASS_TO_PASS에 들어가 인접 동작 비회귀를 함께 보증한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 파일·함수·라인을 다 줬으므로 `sites.py`의 `catch_all_view` 안 `HttpResponsePermanentRedirect` 호출 한 군데만 보면 된다. 거의 순수 localization 문제.
- 함정/난이도 메모: 안일하게 `"%s/?%s" % (request.path, request.META['QUERY_STRING'])`로 직접 붙이고 싶어지는데, 그러면 쿼리스트링이 비었을 때 빈 `?`가 붙고 SCRIPT_NAME 처리가 누락된다. 정답은 `get_full_path(force_append_slash=True)`라는 기존 API를 재사용하는 것 — Django 내부에 이미 force_append_slash 인자가 있다는 걸 알아야 깔끔하게 풀린다. 단일 파일, 단일 라인 수정.
- 우리 에이전트 관점: 막힐 포인트는 거의 없다. 위험은 over-engineering(직접 쿼리 조립)로 SCRIPT_NAME 케이스를 깨거나, 회귀 테스트를 등록할 위치(`AdminSiteFinalCatchAllPatternTests`)를 못 찾는 것 정도. `get_full_path`의 `force_append_slash` 파라미터 존재를 모르면 차선책으로 빠지기 쉽다.
