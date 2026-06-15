---
instance_id: django__django-11333
repo: django/django
base_commit: 55b68de643b5c2d5f0a8ea7587ab3b2966021ccc
version: 3.0
difficulty: 15 min - 1 hour
created_at: 2019-05-06T21:00:53Z
fail_to_pass: 1
pass_to_pass: 2
gold_files: [django/urls/base.py, django/urls/resolvers.py]
---

# django__django-11333

## 문제 요약
`django.urls.resolvers.get_resolver`는 `functools.lru_cache`로 결과를 메모이즈하는데, 캐시 키가 인자값 그대로다. `set_urlconf`(요청 처리 시 `BaseHandler.get_response`에서 호출) 전후로 `reverse` 등이 `get_resolver`를 한 번은 `None`으로, 한 번은 `settings.ROOT_URLCONF`로 호출하면 동일한 URLconf인데도 서로 다른 캐시 키가 되어 `URLResolver`가 두 번 생성된다. 라우트가 많은 앱에서 비싼 `URLResolver._populate`가 중복 실행되고 캐시가 이중으로 저장되는 낭비가 발생한다. 사용자는 `None`과 `ROOT_URLCONF`가 같은 캐시 객체를 공유하길 기대한다.

## 유형 분류
- 버그 카테고리: logic (캐시 키 정규화 누락) / 성능 최적화
- 서브시스템: django URL routing / resolver 캐싱
- 증상 타입: silent-wrong (기능은 정상, URLResolver 중복 생성 + `_populate` 중복 실행으로 인한 성능/메모리 낭비)
- 로컬라이제이션 신호: problem_statement가 `get_resolver`, `lru_cache`, `settings.ROOT_URLCONF`, "look up settings.ROOT_URLCONF before the memoized function call"을 직접 지목 → `django/urls/resolvers.py`의 `get_resolver`가 정확한 타깃

## 골드패치 분석
- 건드린 파일/함수:
  - `django/urls/resolvers.py:get_resolver` (+ 신규 `_get_cached_resolver`)
  - `django/urls/base.py:clear_url_caches`
- 근본 원인: `@functools.lru_cache`가 `get_resolver` 본문 **위**에 붙어 있어, `urlconf=None`을 `settings.ROOT_URLCONF`로 치환하는 정규화가 캐시 조회 **후**에 일어났다. 따라서 `None`과 `ROOT_URLCONF`가 별개 캐시 엔트리가 됨.
- 수정 요지:
  - `get_resolver`에서 `lru_cache` 데코레이터를 제거하고, 먼저 `urlconf is None`이면 `settings.ROOT_URLCONF`로 치환한 뒤 정규화된 값으로 새 캐시 함수 `_get_cached_resolver(urlconf)`를 호출.
  - `_get_cached_resolver`에 `@functools.lru_cache(maxsize=None)`를 붙이고 `URLResolver(RegexPattern(r'^/'), urlconf)`를 생성. 이제 캐시 키가 정규화된 urlconf라 `None`/`ROOT_URLCONF`가 동일 엔트리를 공유.
  - `clear_url_caches`에서 `get_resolver.cache_clear()` → `_get_cached_resolver.cache_clear()`로 변경. (이제 캐시는 내부 함수에 있으므로)

## 검증 (test_patch)
- FAIL_TO_PASS: `test_resolver_cache_default__root_urlconf` — `@override_settings(ROOT_URLCONF='urlpatterns.path_urls')` 하에서
  - `assertIs(get_resolver(), get_resolver('urlpatterns.path_urls'))`: 인자 없이 호출(=None→ROOT_URLCONF 치환)과 명시적 ROOT_URLCONF 호출이 **동일 객체**여야 한다.
  - `assertIsNot(get_resolver(), get_resolver('urlpatterns.path_dynamic_urls'))`: 다른 urlconf는 여전히 별개 객체여야 한다(캐시가 과도하게 합쳐지지 않음을 보장).
- 픽스 증명: 정규화 전 캐시 구조에선 `None`과 문자열 키가 다른 `URLResolver`를 반환해 `assertIs`가 실패. 정규화 후 호출 구조에선 같은 캐시 엔트리를 반환해 통과. `assertIsNot`은 정상 경로가 깨지지 않았음을 잡는 페어드 컨트롤.

## 공략 포인트 (뭘 조져야)
- localization 전략: `get_resolver` 정의로 직행. `lru_cache` + `urlconf is None` 치환 순서의 모순이 핵심. problem_statement가 해법까지 거의 명시.
- 함정/난이도 메모:
  - 데코레이터를 제거하면서 캐시를 잃지 않도록 정규화된 키로 호출하는 내부 헬퍼를 분리하는 게 정석. 단순히 본문에서 치환만 추가하면 캐시는 여전히 원래 인자 기준이라 무효.
  - **멀티파일**: `clear_url_caches`(base.py)가 `get_resolver.cache_clear()`를 직접 호출하므로, 캐시를 `_get_cached_resolver`로 옮기면 여기 import와 호출도 같이 고쳐야 한다. 안 고치면 `get_resolver`가 더 이상 `cache_clear` 속성을 갖지 않아 `AttributeError` 회귀.
  - `_get_cached_resolver`를 `base.py`의 import 라인에 추가하는 것까지 잊지 말 것.
- 우리 에이전트 관점: 단일 함수 본문만 보면 "치환을 위로 옮기면 끝"으로 오판하기 쉽다. 캐시 의미를 보존하려면 헬퍼 분리가 필요하고, `cache_clear` 호출처(다른 파일)까지 추적하는 cross-file 의존 탐색이 막힐 만한 지점.
