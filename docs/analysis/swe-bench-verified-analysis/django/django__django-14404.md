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
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-14404

## 문제 요약
admin 사이트의 `AdminSite.catch_all_view()`는 `APPEND_SLASH=True`이고 요청 URL이 슬래시로 안 끝날 때, 슬래시를 붙인 영구 리다이렉트(301)를 보낸다. 그런데 리다이렉트 목적지(Location 헤더)를 `'%s/' % request.path_info`로 만들기 때문에 스크립트 이름(WSGI `SCRIPT_NAME` / `FORCE_SCRIPT_NAME`)이 잘려나간다. prefix 환경(`/prefix/admin/...`)에서 사용자는 prefix가 보존된 URL로 리다이렉트되길 기대하지만, 실제로는 prefix가 빠진 `/admin/.../`로 리다이렉트돼 라우팅이 깨진다. problem_statement가 증상·함수·잘못된 표현식·올바른 대안(`request.path`)까지 직접 적어준다.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement가 함수명 `catch_all_view`와 정확한 표현식 `'%s/' % request.path_info`를 직접 인용하고, 대안으로 `request.path`를 명시한다. grep 한 방으로 `django/contrib/admin/sites.py`의 정확한 라인에 도달. 탐색 비용 사실상 0.
- **S2 (Constraint-Reasoning)** — 고칠 지점은 자명하지만, **두 용처를 구별하는 추론**이 핵심이다. 같은 함수 안에서 `request.path_info`가 `resolve()` 매칭용(prefix stripped 기준)과 리다이렉트 Location용(prefix 보존 필요) 두 군데 쓰이는데, 후자만 `request.path`로 바꿔야 한다. "어느 쪽이 어떤 불변식을 만족해야 하나(URLconf는 SCRIPT_NAME-stripped 경로로 매칭 / Location은 클라이언트가 접근한 전체 경로)"를 따져 식을 합성하는 SemFix류 의미추론. 후보를 막 시도하는 G&V가 아니라 "생각으로" 푸는 결정론적 픽스라 S3/S4 아님.
- **K-Domain** — `request.path` vs `request.path_info`의 WSGI 의미 차이, `SCRIPT_NAME`/`FORCE_SCRIPT_NAME` 환경, URLconf가 SCRIPT_NAME-stripped 경로 기준으로 매칭된다는 점은 django/WSGI 내부 도메인 지식이다. 일반 파이썬 추론(K-Gen)만으로는 "왜 path_info를 path로 바꾸면 안 되는 자리가 있는지"를 알 수 없다.

**primary type = T-ConstraintReason**: 위치는 명확(L0)하나 진짜 난점이 "올바른 식·조건을 추론으로 합성"(S2 — 두 path 표현식의 분리)에 있으므로 T-DirectMap(기계적 가드/상수 치환)이 아니라 T-ConstraintReason이 dominant. naive한 sed식 일괄 치환은 회귀를 낳으므로 단순 Direct-Map으로 분류하면 함정을 못 담는다.

## 난이도 티어
**T3 (중간).** 공식 라벨은 `<15 min fix`(T1~T2 prior)지만, 한 단계 올려 T3로 본다. 근거:
- **파일/줄수는 T1급**: 1파일 단일 함수, 실질 2줄(지역변수 `path` 제거 + 2개 표현식 인라인화). patch scope만 보면 존나쉬움.
- **has-repro 신호**: problem_statement가 증상·잘못된 표현식·올바른 값을 다 적어줘 localize는 공짜(L0). 이건 easiness 방향 신호.
- **그러나 S2 분리 추론 + P2P trap이 티어를 끌어올린다**: `path_info`를 전부 `path`로 일괄 치환하는 자연스러운 과수정이 `resolve()` 매칭을 깬다 — 즉 픽스가 "한 줄 치환"이 아니라 "두 용처 중 하나만"이라는 제약 추론을 요구한다(S2). 동시에 PASS_TO_PASS 323개 중 `test_missing_slash_append_slash_true*`, `test_known_url_missing_slash_*`, `test_non_admin_url_shares_url_prefix` 등 catch_all 리다이렉트/매칭 경로 다수가 인접 동작으로 걸려 있어(regression-trap), 과수정 시 즉시 다수 P2P가 깨진다.
- 공식 시간라벨은 "개발자가 정답을 아는 상태의 구현시간"이라 이 분리 추론·overfit 함정을 못 잡는다. 그래서 prior(<15min)와 달리 T3로 재조정.

## 골드패치 분석
- **건드린 파일·함수**: `django/contrib/admin/sites.py` — `AdminSite.catch_all_view(self, request, url)`.
- **근본 원인**: `request.path_info`는 WSGI `SCRIPT_NAME`을 제외한 경로이고, `request.path`는 SCRIPT_NAME을 포함한 전체 경로다. 301 리다이렉트의 Location은 클라이언트가 실제로 접근한 전체 경로(prefix 포함)여야 하는데, 코드가 `path_info`로 만든 지역변수 `path`를 **매칭(`resolve`)에도, 리다이렉트(`HttpResponsePermanentRedirect`)에도** 둘 다 재사용해서 prefix가 소실됐다.
- **수정 요지**:
  - 지역변수 `path = '%s/' % request.path_info` 제거.
  - `resolve()` 인자는 `resolve('%s/' % request.path_info, urlconf)`로 인라인 유지 — URLconf는 SCRIPT_NAME-stripped 경로 기준이라 매칭은 `path_info`가 정답.
  - 리다이렉트만 `return HttpResponsePermanentRedirect('%s/' % request.path)`로 바꿔 prefix 보존.
  - 즉 "매칭용 경로(path_info)"와 "리다이렉트용 경로(path)"를 분리한 것이 핵심.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개)**: `tests/admin_views/tests.py`의 `AdminSiteFinalCatchAllPatternTests`에 추가.
  - `test_missing_slash_append_slash_true_script_name` — 요청에 `SCRIPT_NAME='/prefix/'`를 직접 넘김.
  - `test_missing_slash_append_slash_true_force_script_name` — `@override_settings(FORCE_SCRIPT_NAME='/prefix/')` 적용.
- **픽스 증명**: 두 테스트 모두 슬래시 없는 admin changelist URL(`known_url[:-1]`)로 GET 한 뒤, 응답이 `'/prefix' + known_url`(prefix 보존 + 슬래시 추가)로 `status_code=301` 리다이렉트되는지 `assertRedirects(..., fetch_redirect_response=False)`로 검증. 버그 상태에선 Location에 prefix가 빠져 assertion 실패 → 픽스 후 통과. 두 케이스가 `SCRIPT_NAME`(런타임)과 `FORCE_SCRIPT_NAME`(설정) 두 경로 모두를 커버한다.
- **overfit 관점**: FAIL_TO_PASS가 2개로 얇긴 하나, `request.path`는 두 prefix 소스(SCRIPT_NAME/FORCE_SCRIPT_NAME)를 동일하게 정규화하므로 special-case가 아닌 올바른 일반화다. special-case 픽스(예: `request.META`에서 prefix를 수동 prepend)는 두 케이스 모두 통과시키기 더 어렵고 부자연스러워 overfit 위험은 낮음. flag에 overfit-risk 미부여.
- **regression 관점**: PASS_TO_PASS 323개에 prefix 없는 기본 환경의 catch_all 동작(`test_missing_slash_append_slash_true`, `test_known_url_missing_slash_*`, `test_non_admin_url_shares_url_prefix` 등)이 대거 포함. prefix 없을 때 `request.path == request.path_info`라 골드 픽스는 기존 동작을 그대로 보존한다. 단, `path_info`를 `resolve` 인자에서까지 바꾸면 이 P2P들이 깨진다(regression-trap).

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement가 함수 `catch_all_view`와 표현식 `'%s/' % request.path_info`를 직접 인용 → `django/contrib/admin/sites.py`에서 `catch_all_view` 한 함수로 즉시 수렴(L0). 추가 탐색 불필요.

2. **픽스와 왜 올바른 일반화인가**: 함수 안에서 `path_info`가 두 번 쓰임을 인지하고, 의미를 분리한다. (a) `resolve()` 매칭은 URLconf 기준 = SCRIPT_NAME-stripped → `request.path_info` 유지. (b) 리다이렉트 Location은 클라이언트가 접근한 전체 경로 = prefix 포함 → `request.path`로 변경. `request.path`는 SCRIPT_NAME과 FORCE_SCRIPT_NAME을 동일 경로로 합쳐주는 django의 표준 속성이라, 두 prefix 소스를 한 줄로 일반화한다. prefix를 META에서 수동 조립하는 것보다 정확하고 하위호환적.

3. **regression 안전**: prefix가 없는 일반 배포에선 `request.path == request.path_info`라, 변경이 기존 동작을 byte-identical로 보존 → `test_missing_slash_append_slash_true`, `test_known_url_*`, 슬래시/404/non-staff 분기 등 catch_all 관련 P2P 전부 그대로 통과. `resolve()` 인자를 건드리지 않는 것이 이 안전성의 핵심 전제.

4. **함정 회피**: 오라클 없는 에이전트의 1순위 실패는 "problem_statement가 path_info→path라 했으니 함수 내 모든 path_info를 path로 치환"하는 과수정. 이러면 `resolve()`가 prefix 포함 경로로 매칭을 시도해 prefix 환경에서 매칭이 깨지고, 동시에 prefix 없는 환경의 매칭 관련 P2P도 회귀할 수 있다. 회피법: `path_info`(URLconf 매칭, prefix 없는 기준)와 `path`(클라이언트 반환, prefix 포함)의 WSGI 의미 차이를 명확히 하고, **오직 `HttpResponsePermanentRedirect` 인자만** 교체한다. test_patch에 SCRIPT_NAME/FORCE_SCRIPT_NAME 두 케이스가 있으니, 매칭은 그대로 두고 리다이렉트만 바꾼 픽스가 두 케이스 + 기존 P2P를 모두 만족함을 확인하면 된다.
