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
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-11333

## 문제 요약
`django.urls.resolvers.get_resolver`는 `functools.lru_cache`로 결과를 메모이즈하는데, 캐시 키가 인자값 그대로다. `set_urlconf`(요청 처리 시 `BaseHandler.get_response`에서 호출) 전후로 `reverse` 등이 `get_resolver`를 한 번은 `None`으로, 한 번은 `settings.ROOT_URLCONF`로 호출하면 동일한 URLconf인데도 서로 다른 캐시 키가 되어 `URLResolver`가 두 번 생성된다. 라우트가 많은 앱에서 비싼 `URLResolver._populate`가 중복 실행되고 캐시가 이중으로 저장되는 낭비가 발생한다. 사용자는 `None`과 `ROOT_URLCONF`가 같은 캐시 객체를 공유하길 기대한다. problem_statement가 해법("look up settings.ROOT_URLCONF before the memoized function call")까지 거의 적어준 최적화 이슈다.

## 유형 (정형화)

**3축 점수**

- **L = L3 (Multi-site)** — 근거: 진짜 픽스는 `resolvers.py`의 `get_resolver` 한 곳이 아니라, 캐시를 내부 헬퍼로 옮기면서 `base.py:clear_url_caches`의 `get_resolver.cache_clear()` 호출도 **함께** 바뀌어야 정합성이 유지된다(2파일 조율). 문제 지목 자체는 L0급으로 명확하지만, 정답 패치의 구조상 수정이 ≥2 파일/함수에 걸쳐 동시에 바뀌어야 하므로 localize 축은 L3로 잡는다. (단일 심볼 지목과 멀티사이트 조율을 분리: 지목은 쉬워도 수정 site는 분산.)
- **S = S2 (Constraint-Reasoning) +S6 (Design-Refactor)** — 근거: 고칠 지점은 자명하지만, "데코레이터를 그냥 위로 올린다"로는 안 풀린다. 캐시 키는 **정규화된 urlconf**여야 하고, 동시에 lru_cache의 메모이제이션 의미는 **보존**되어야 한다는 불변식을 따져 올바른 구조(정규화 후 캐시 함수 호출)를 합성해야 한다(S2). 그 합성의 형태가 함수를 둘로 쪼개는 작은 구조 변경(public `get_resolver` = 정규화 래퍼 / `_get_cached_resolver` = 캐시 본체)이라 S6를 보조로 단다. 테스트를 마구 돌려 수렴하는 G&V가 아니라 "생각으로" 푸는 의미론적 수리다.
- **K = K-Domain** — 근거: `set_urlconf`/`get_urlconf`/`BaseHandler.get_response`의 호출 타이밍, `URLResolver._populate`의 비용 구조, `clear_url_caches`가 어떤 캐시들을 비우는지 등 django URL routing 내부 지식을 알아야 "왜 None과 ROOT_URLCONF가 갈라지는지", "캐시를 어디로 옮겨야 안전한지"를 이해할 수 있다. 일반 파이썬 추론만으로는 cross-file 캐시 무효화 함정을 못 본다.

**primary type = T-ConstraintReason** — 근거: 위치는 problem_statement가 직접 지목하므로 T-DiffuseLoc 아님. 픽스가 None가드/상수변경 같은 기계적 템플릿이 아니라(따라서 T-DirectMap 아님), lru_cache 키 정규화 + 캐시 의미 보존이라는 불변식을 추론으로 합성해야 하는 S2가 dominant라 T-ConstraintReason. 보조 구조변경(S6)이 있지만 그 변경의 본질은 "올바른 조건/식을 어디서 평가하느냐"의 의미론적 추론이라 design-refactor를 primary로 올리지 않는다.

**왜 이 repair strategy인가 (APR 관점)** — 이 결함은 GenProg식 generate-and-validate로 풀면 overfit 위험이 크다. 단순히 `get_resolver` 본문 첫 줄에 `if urlconf is None: urlconf = settings.ROOT_URLCONF`를 끼워 넣으면 lru_cache의 키는 여전히 **원래 인자**(None vs 문자열)라 캐시는 안 합쳐지고 FAIL_TO_PASS의 `assertIs`가 통과하지 못한다 — 즉 "그럴듯하지만 틀린" plausible patch가 자연스럽게 나온다. 올바른 해는 SemFix/Angelix 계열의 의미론적 추론: "캐시 키 = 정규화된 urlconf"라는 불변식을 명세로 잡고, 그 불변식이 성립하도록 정규화를 캐시 경계 **바깥**으로, 캐싱을 정규화된 값에 대해 평가되도록 코드를 재배치(S6)한다. 테스트 피드백 루프보다 "캐시 데코레이터가 어떤 값에 키를 매기는가"라는 인과 추론이 풀이를 지배한다.

## 난이도 티어

**Tier = T4 (약간 어려움).** 공식 difficulty 라벨은 `15 min - 1 hour`(개발자 구현시간 기준, 대략 T3 prior).

**T4로 미는 구조적 피처:**
- **멀티사이트 cross-file 조율(L3)**: 골드패치는 2파일(`resolvers.py` + `base.py`)을 함께 고친다. 캐시를 `_get_cached_resolver`로 옮기면 `get_resolver`는 더 이상 `cache_clear` 속성을 갖지 않으므로, `base.py:clear_url_caches`의 `get_resolver.cache_clear()`를 `_get_cached_resolver.cache_clear()`로 바꾸고 import 라인에 `_get_cached_resolver`를 추가하지 않으면 `AttributeError` 회귀가 난다. 이 의존은 FAIL_TO_PASS 테스트에는 잡히지 않는(테스트는 `clear_url_caches`를 안 부름) **숨은 cross-file trap**이라 에이전트가 놓치기 쉽다.
- **overfit 유발 구조**: 위에서 본 "본문 첫 줄에 치환만 추가" 오답이 가장 그럴듯한 first attempt다. 픽스의 정답 형태(함수 2분할)가 S2/S6 추론을 요구.
- **도메인 지식(K-Domain)**: lru_cache가 정규화 전후 어디서 키를 매기는지, set_urlconf 타이밍 등 django routing 내부를 알아야 근본원인이 보임.

**공식 라벨과 다른 이유**: 개발자에겐 15분~1시간짜리(원인 이해하면 패치는 작음)지만, 에이전트 관점에선 (1) cross-file 캐시 무효화 함정이 회귀로 직결되고 (2) 가장 자연스러운 패치가 FAIL_TO_PASS를 못 넘기는 plausible-but-wrong 함정이라 T3가 아니라 T4로 올린다. 시간라벨은 localize 어려움과 overfit 위험을 못 잡는다(루브릭 §6-Tier 주석과 일치).

## 골드패치 분석
- **건드린 파일/함수**:
  - `django/urls/resolvers.py` — `get_resolver`에서 `@functools.lru_cache(maxsize=None)` 제거, 신규 `_get_cached_resolver`(lru_cache 적용)로 캐시 본체 분리.
  - `django/urls/base.py` — `clear_url_caches`의 `get_resolver.cache_clear()` → `_get_cached_resolver.cache_clear()`, import 라인에 `_get_cached_resolver` 추가.
- **근본 원인**: `@functools.lru_cache`가 `get_resolver` 본문 **위**에 붙어 있어, `urlconf=None`을 `settings.ROOT_URLCONF`로 치환하는 정규화가 캐시 조회 **후**에 일어났다. 따라서 캐시 키가 `None`과 `'<ROOT_URLCONF>'`로 갈라져 동일 URLconf인데도 별개 `URLResolver`가 생성·`_populate` 중복 실행된다.
- **수정 요지**:
  - `get_resolver(urlconf=None)`: 데코레이터 제거 → 먼저 `if urlconf is None: urlconf = settings.ROOT_URLCONF`로 정규화한 뒤 `return _get_cached_resolver(urlconf)`. (정규화가 캐시 경계 바깥으로 이동)
  - `_get_cached_resolver(urlconf=None)`: `@functools.lru_cache(maxsize=None)`를 달고 `return URLResolver(RegexPattern(r'^/'), urlconf)`. 이제 캐시 키가 정규화된 urlconf라 `None`/`ROOT_URLCONF`가 동일 엔트리 공유.
  - `clear_url_caches`: 캐시가 내부 함수로 이동했으므로 `_get_cached_resolver.cache_clear()` 호출 + import 갱신.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `test_resolver_cache_default__root_urlconf` — `@override_settings(ROOT_URLCONF='urlpatterns.path_urls')` 하에서
  - `assertIs(get_resolver(), get_resolver('urlpatterns.path_urls'))`: 인자 없는 호출(None→ROOT_URLCONF 치환)과 명시적 ROOT_URLCONF 호출이 **동일 객체**여야 한다. → 정규화가 캐시 경계 안으로 들어왔음을 증명.
  - `assertIsNot(get_resolver(), get_resolver('urlpatterns.path_dynamic_urls'))`: 다른 urlconf는 여전히 **별개 객체**여야 한다. → 캐시가 과도하게 합쳐지지 않았음을 잡는 페어드 컨트롤.
- **픽스 증명**: 정규화 전 구조에선 `None` 키와 문자열 키가 다른 `URLResolver`를 반환해 `assertIs`가 실패. 정규화 후 호출 구조에선 같은 캐시 엔트리를 반환해 `assertIs` 통과, `assertIsNot`은 그대로 유지.
- **overfit 관점**: FAIL_TO_PASS가 단 1개지만 `assertIs`(병합 확인)와 `assertIsNot`(과병합 방지)를 한 테스트에 묶어 둔 덕에 "모든 urlconf를 한 객체로 캐싱" 같은 게으른 overfit은 `assertIsNot`에서 걸린다. 다만 캐시 무효화(`clear_url_caches`) 경로는 이 테스트가 안 건드리므로, 그쪽 회귀는 test_patch만으로는 못 잡는다 → `cross-file-dep`/`regression-trap` 플래그의 근거.
- **regression 관점**: PASS_TO_PASS(2개, `RegexPatternTests.test_str` / `RoutePatternTests.test_str`)는 resolver 캐시와 무관한 패턴 str 동작으로, 본 변경이 이를 깨면 안 된다. 진짜 regression-trap은 P2P가 아니라 P2P가 **커버하지 못하는** `clear_url_caches` 경로다.

## 모범답안 (오라클 기반)

1. **localize 경로**: problem_statement가 `get_resolver`, `functools.lru_cache`, `settings.ROOT_URLCONF`, 그리고 "look up settings.ROOT_URLCONF before the memoized function call"을 직접 지목 → `django/urls/resolvers.py:get_resolver` 정의로 직행. 거기서 `@lru_cache`가 본문 위에 있고 `urlconf is None` 치환이 본문 안에 있다는 **순서 모순**을 즉시 포착. 이어서 "이 함수가 가진 `cache_clear`를 누가 부르나?"를 grep → `base.py:clear_url_caches`로 cross-file 의존을 선제적으로 발견(여기가 핵심 추가 탐색).

2. **픽스 (왜 올바른 일반화)**: 캐시 키 불변식을 "정규화된 urlconf"로 못박고, 정규화 래퍼(`get_resolver`)와 캐시 본체(`_get_cached_resolver`)로 분리. 이게 overfit이 아닌 올바른 일반화인 이유: 단순 "본문 첫 줄 치환"은 lru_cache 키가 여전히 원래 인자라 `assertIs`를 못 넘기는 거짓 해다. 함수 분할은 `None`/`ROOT_URLCONF`뿐 아니라 **앞으로 동일 urlconf를 가리키는 모든 표현**을 한 엔트리로 모으는 일반 해라, 특정 테스트 입력에 끼워 맞춘 special-case가 아니다.

3. **regression 안전**: 캐시를 내부 함수로 옮긴 순간 `get_resolver.cache_clear`가 사라지므로 `clear_url_caches`를 `_get_cached_resolver.cache_clear()`로 같이 고치고 import를 추가해야 한다. 안 그러면 `AttributeError` 회귀. PASS_TO_PASS 2개(패턴 str)는 캐시와 무관해 그대로 통과해야 하며, `assertIsNot`로 "다른 urlconf는 별개"라는 정상 동작이 유지됨을 확인.

4. **함정 회피**: 오라클 없는 에이전트의 주된 실패 두 가지 — (a) **plausible-but-wrong**: `get_resolver` 본문에 치환만 추가하고 lru_cache는 그대로 둬서 캐시 병합이 안 일어남(FAIL_TO_PASS 실패). 회피법 = "lru_cache가 어떤 값에 키를 매기는가"를 명시적으로 따져 정규화를 캐시 경계 바깥으로 빼낼 것. (b) **cross-file 누락**: `resolvers.py`만 고치고 `base.py:clear_url_caches`를 안 고쳐 `AttributeError` 회귀. 회피법 = 캐시 데코레이터를 옮기기 전에 `get_resolver.cache_clear`/`get_resolver`의 호출처를 repo 전역 grep해 의존 사이트를 먼저 수집(collect-then-edit)한 뒤 함께 수정.
