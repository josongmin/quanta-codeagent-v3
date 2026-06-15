---
instance_id: django__django-14404
repo: django/django
base_commit: de32fe83a2e4a20887972c69a0693b94eb25a88b
version: "4.0"
difficulty: <15 min fix
created_at: 2021-05-17T11:24:06Z
fail_to_pass: 2
pass_to_pass: 323
gold_files: [django/contrib/admin/sites.py]
---

# django__django-14404

## 문제 요약
admin 사이트의 `catch_all_view()`는 `APPEND_SLASH=True`이고 URL이 슬래시로 안 끝날 때 슬래시를 붙인 영구 리다이렉트(301)를 보낸다. 그런데 리다이렉트 목적지를 `request.path_info` 기반으로 만들기 때문에 스크립트 이름(`SCRIPT_NAME` / `FORCE_SCRIPT_NAME`)이 잘려나간다. 사용자는 `/prefix/admin/...` 처럼 prefix가 보존된 URL로 리다이렉트되길 기대했지만, 실제로는 prefix가 빠진 `/admin/...`로 리다이렉트돼 깨진다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (스크립트 prefix 환경 미고려)
- 서브시스템: django.contrib.admin 사이트 라우팅 (catch_all_view 리다이렉트)
- 증상 타입: 잘못된 출력 (잘못된 Location 헤더로 301 리다이렉트)
- 로컬라이제이션 신호: problem_statement가 함수명 `catch_all_view()`와 정확한 문구 `'%s/' % request.path_info`를 직접 지목하고, 대안으로 `request.path`를 명시 — 거의 핀포인트로 골드 파일(`sites.py`)과 라인을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/sites.py` : `AdminSite.catch_all_view()`
- 근본 원인: `request.path_info`는 스크립트 이름(WSGI `SCRIPT_NAME`)을 제외한 경로다. 반면 `request.path`는 스크립트 이름을 포함한 전체 경로다. 리다이렉트 응답에는 클라이언트가 접근한 전체 경로(prefix 포함)를 돌려줘야 하는데, path_info를 쓰면 prefix가 소실된다.
- 수정 요지: `resolve()`로 URL 매칭을 시도할 때는 여전히 `'%s/' % request.path_info`를 쓴다 (URLconf 매칭은 prefix 없는 경로 기준이라야 정상). 그러나 실제 `HttpResponsePermanentRedirect(...)`로 돌려줄 목적지만 `'%s/' % request.path`로 바꿔 스크립트 prefix를 보존한다. 기존에 두 군데서 재사용하던 지역변수 `path`를 제거하고, 매칭용과 리다이렉트용 경로를 분리한 것이 핵심.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: `tests/admin_views/tests.py`의 `AdminSiteFinalCatchAllPatternTests`에 두 케이스 추가.
  - `test_missing_slash_append_slash_true_script_name`: 요청에 `SCRIPT_NAME='/prefix/'`를 넘긴 경우.
  - `test_missing_slash_append_slash_true_force_script_name`: `@override_settings(FORCE_SCRIPT_NAME='/prefix/')` 적용한 경우.
- 테스트가 어떻게 픽스를 증명하는지: 슬래시 없는 admin changelist URL(`known_url[:-1]`)로 GET 하고, 응답이 `'/prefix' + known_url` (prefix가 보존된 슬래시 포함 URL)로 status 301 리다이렉트되는지 `assertRedirects(..., fetch_redirect_response=False)`로 검증한다. 버그 상태에서는 prefix가 빠진 경로로 리다이렉트돼 assertion이 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 `catch_all_view`와 `request.path_info` vs `request.path`를 명시하므로, `django/contrib/admin/sites.py`에서 `catch_all_view` 한 함수만 보면 된다. 거의 localization이 공짜.
- 함정/난이도 메모: `path_info`를 전부 `path`로 바꾸면 안 된다는 게 핵심 함정. `resolve()` 호출에는 prefix 없는 `request.path_info`를 그대로 둬야 URLconf 매칭이 성립한다 (urlpatterns는 SCRIPT_NAME을 stripped된 기준으로 작성됨). 오직 클라이언트로 돌려주는 리다이렉트 Location만 `request.path`여야 한다. 단일 파일, 단일 함수 수정.
- 우리 에이전트 관점: 단서가 강해서 막힐 일은 적지만, `path` 지역변수를 둘 다 한꺼번에 치환하는 과수정(resolve 인자까지 바꿈)을 하면 prefix 환경에서 매칭이 깨지는 회귀를 낳을 수 있다. `path_info`(매칭)와 `path`(리다이렉트)의 의미 차이를 정확히 이해하고 두 용처를 분리하는 것이 정답.
