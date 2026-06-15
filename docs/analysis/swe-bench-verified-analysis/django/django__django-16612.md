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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-API
flags: [has-repro, regression-trap]
---

# django__django-16612

## 문제 요약
`AdminSite.catch_all_view()`가 `APPEND_SLASH=True`로 trailing slash를 붙여 301 리다이렉트할 때 쿼리스트링을 버린다. `/admin/auth/foo?id=123` 요청은 `/admin/auth/foo/?id=123`로 가야 하는데 실제로는 `/admin/auth/foo/`로 리다이렉트되어 `id=123`이 통째로 사라진다. #31747에서 `catch_all_view`를 도입(regression ba31b0103442ac891fb3cb98f316781254e366c3)하며 리다이렉트 URL을 `"%s/" % request.path`로 직접 조립한 것이 원인. `request.path`는 path-만(쿼리스트링·SCRIPT_NAME 미포함) 속성이라 쿼리 데이터가 silent하게 유실된다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 파일(`django/contrib/admin/sites.py`), 함수(`catch_all_view`), 정확한 라인(`return HttpResponsePermanentRedirect("%s/" % request.path)`), GitHub 영구링크(L456)까지 직접 지목한다. grep 한 방, 탐색 노력 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 보조)**: hints_text가 픽스를 사실상 명세한다("Using get_full_path() should fix the issue") — `request.path` → `request.get_full_path(force_append_slash=True)` 한 줄 치환의 정형 결함(누락 데이터 복원)이라 S1이 dominant. 다만 "왜 `?%s % QUERY_STRING` 수동 조립이 아니라 `force_append_slash` 인자여야 하는가"(빈 쿼리·SCRIPT_NAME 불변식)를 따져야 올바른 식으로 수렴하므로 S2가 얇게 보조로 붙는다(많이 시도하는 G&V가 아니라 불변식 추론).
- **K (Knowledge) = K-API**: 일반 파이썬 추론만으론 부족하고, Django `HttpRequest`의 공개 API 계약 — `get_full_path()`가 path+query를 반환하고 `force_append_slash` 키워드 인자를 받으며 SCRIPT_NAME 접두까지 처리한다는 사실 — 을 알아야 한 줄로 정답에 닿는다. ORM 깊은 도메인은 아니지만 명백히 framework API 계약 의존.
- **Primary type = T-DirectMap**: 위치가 L0로 자명하고 픽스가 S1 기계적 치환(누락 필드 복원). T-LocTrivial이 아닌 이유는 픽스가 "자명"이라기보다 정확한 API(`force_append_slash` 인자)를 골라야 해서 약간의 K-API가 필요하기 때문. T-DomainBound도 아닌 이유는 병목이 도메인 call-chain이 아니라 단일 API 시그니처라서.

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨은 "15 min - 1 hour"(prior로 T3 근처)이지만 구조적 피처는 T2로 민다:
- **파일/줄수**: 단일 파일·단일 함수·1줄 치환(gold = 1 hunk, net +2/-1). 1파일·<5줄 컷(≈48% solve)에 정확히 든다.
- **localize 직접성 = L0**: 이슈가 파일·함수·문제 라인·문제 코드를 다 적어줘 localization 에러(실패의 ~51%) 위험이 사실상 0.
- **has-repro**: problem_statement에 구체 URL/expected/actual + 원인 라인까지 있고 hints_text에 diff 형태 패치 제안까지 있다 — 가장 강한 easiness 신호.
- **P2P trap (regression-trap)**: P2P가 335개로 넓고, 특히 `AdminSiteFinalCatchAllPatternTests`의 force_script_name·non_staff·without_final_catch_all 같은 인접 리다이렉트 동작을 안 깨야 한다. 이 한 가지가 T1로 떨어지지 않게 막는 유일한 상향 요인(수동 쿼리 조립으로 풀면 이들이 깨짐).
- 공식 라벨이 더 높게 보이는 이유는 "개발자 구현시간"에 회귀 테스트 4종 작성 비용이 포함되기 때문이지, 에이전트의 픽스 도출 난이도는 아니다.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/admin/sites.py` → `AdminSite.catch_all_view(self, request, url)`.
- **근본 원인**: `should_append_slash` 분기 안에서 리다이렉트 대상을 `"%s/" % request.path`로 손수 조립. `request.path`는 path 컴포넌트만 담고 `request.META['QUERY_STRING']`(쿼리)과 SCRIPT_NAME prefix를 포함하지 않아, slash는 붙되 쿼리스트링이 유실된다.
- **수정 요지**: 직접 문자열 조립을 `request.get_full_path(force_append_slash=True)`로 교체.
  ```python
  -                    return HttpResponsePermanentRedirect("%s/" % request.path)
  +                    return HttpResponsePermanentRedirect(
  +                        request.get_full_path(force_append_slash=True)
  +                    )
  ```
  `get_full_path()`는 path + 쿼리스트링을 합쳐 반환하고 SCRIPT_NAME 접두를 처리하며, `force_append_slash=True`가 trailing slash를 안전하게(빈 쿼리/이미 slash 있는 경우 모두) 강제한다. `getattr(match.func, "should_append_slash", True)` 분기 자체는 그대로 유지 — 픽스는 URL 조립부 한 줄에 국한된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_missing_slash_append_slash_true_query_string`: slash 없는 changelist URL에 `?id=1`을 붙여 GET → `f"{known_url}?id=1"`로 301 리다이렉트(쿼리 보존) 검증.
  - `test_missing_slash_append_slash_true_script_name_query_string`: 같은 시나리오에 `SCRIPT_NAME="/prefix/"` 추가 → `f"/prefix{known_url}?id=1"`로 리다이렉트되어 prefix와 쿼리 둘 다 보존 검증.
- **픽스 증명**: 픽스 전에는 `request.path`만 써서 `?id=1`이 빠지고 SCRIPT_NAME도 누락되므로 `assertRedirects`의 기대 target과 불일치해 실패한다. `get_full_path(force_append_slash=True)`로 바꾸면 쿼리·SCRIPT_NAME 모두 포함된 정확한 URL이 나와 통과. 두 테스트가 "쿼리 보존"과 "쿼리+prefix 동시 보존"을 분리 검증해 단순 문자열 append로는 둘 다 만족 못 하게 설계됨.
- **overfit 관점**: test_patch는 F2P 2개 외에도 `test_missing_slash_append_slash_true_non_staff_user_query_string`(쿼리가 `%3Fid%3D1`로 인코딩되어 login next에 실리는지)과 `test_missing_slash_append_slash_true_query_without_final_catch_all_view`를 P2P로 함께 추가해, special-case 조립이 통과 못 하도록 입력공간을 넓혔다 — overfit 위험 낮음(그래서 overfit-risk 플래그 미부착).
- **regression 관점**: P2P 335개에 force_script_name·non_staff·unknown_url·without_final_catch_all 등 기존 리다이렉트 경로가 모두 들어 있어, 픽스가 이들 동작을 깨면 즉시 적발된다 → regression-trap 플래그.

## 모범답안 (오라클 기반)
1. **Localize 경로**: 이슈가 파일·함수·라인을 그대로 준다 → `django/contrib/admin/sites.py`의 `catch_all_view` 안 `HttpResponsePermanentRedirect("%s/" % request.path)` 한 줄로 직행. "왜 쿼리가 빠지나"의 핵심 단서는 이슈가 짚어준 `request.path`가 쿼리스트링 비포함 속성이라는 사실 — 추가 탐색 불필요.
2. **픽스와 일반화 근거**: `request.get_full_path(force_append_slash=True)`로 교체. 이게 올바른 일반화인 이유는 (a) `get_full_path`가 path+query를 SSOT로 조립해 모든 쿼리 형태를 자동 보존하고, (b) `force_append_slash=True`가 slash 강제 로직을 Django 내부 규약에 위임해 빈 쿼리("?만 붙는 버그")·이미-slash 케이스를 직접 분기 없이 처리하며, (c) SCRIPT_NAME/FORCE_SCRIPT_NAME prefix까지 같은 메서드가 책임지기 때문. 즉 "버그난 한 줄"을 이미 모든 엣지를 다루는 기존 공개 API로 대체하는 것이라 특정 테스트가 아니라 동작 클래스 전체를 고친다.
3. **regression 안전**: P2P 335개 중 `test_missing_slash_append_slash_true`(쿼리 없는 기본 경로), `..._force_script_name`, `..._script_name`, `..._non_staff_user`, `..._without_final_catch_all_view`, `..._false` 계열을 안 깨야 한다. `should_append_slash` 분기와 `raise Http404` 폴백을 건드리지 않고 URL 조립부만 교체하면 이들은 모두 보존된다 — `get_full_path`가 쿼리 없을 때 기존 `"%s/"` 결과와 동치(SCRIPT_NAME 정상 처리 포함)이기 때문.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 길은 `"%s/?%s" % (request.path, request.META['QUERY_STRING'])` 같은 수동 조립이다. 이러면 (i) 쿼리가 빈 경우 dangling `?`가 붙고, (ii) SCRIPT_NAME prefix가 누락되어 `..._script_name`/`..._force_script_name` P2P가 깨진다. 회피법은 "Django HttpRequest에 이미 force_append_slash를 받는 get_full_path가 있다"는 K-API를 떠올려 직접 조립 대신 기존 API 재사용으로 가는 것. 또 회귀 테스트 등록 위치(`tests/admin_views/tests.py`의 `AdminSiteFinalCatchAllPatternTests`)를 못 찾는 것도 부수 함정이나, 픽스 자체 정확성에는 영향 없다.
