---
instance_id: django__django-17029
repo: django/django
base_commit: 953f29f700a60fc09b08b2c2270c12c447490c6a
version: 5.0
difficulty: <15 min fix
created_at: 2023-06-29T13:18:26Z
fail_to_pass: 1
pass_to_pass: 43
gold_files: [django/apps/registry.py]
---

# django__django-17029

## 문제 요약
`Apps.clear_cache()`는 docstring상 "app registry를 변경하는 메서드들이 쓰는 모든 내부 캐시를 비운다"고 명시돼 있는데, 실제로는 `get_swappable_settings_name`의 `functools.lru_cache` 캐시를 비우지 않는다. django-stubs는 mypy 연속 실행 사이 상태를 리셋하려고 `clear_cache()`를 호출하는데, 이 캐시가 살아남아 이전 상태가 새 다 보였다. 사용자는 `clear_cache()`가 swappable settings name 캐시까지 깨끗하게 비워주길 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (cache invalidation 항목 누락)
- 서브시스템: django apps registry (`django/apps/registry.py`)
- 증상 타입: silent-wrong (예외 없이 stale 캐시가 남음)
- 로컬라이제이션 신호: problem_statement가 파일·메서드·수정안까지 명시 — `apps.clear_cache()`(=`django/apps/registry.py`의 `Apps.clear_cache`)에 `self.get_swappable_settings_name.cache_clear()`를 추가하라고 직접 지목.

## 골드패치 분석
- 건드린 파일/함수: `django/apps/registry.py`:`Apps.clear_cache`
- 근본 원인: `get_swappable_settings_name`은 `@functools.lru_cache(maxsize=None)`로 감싸진 메서드인데, `clear_cache()`가 `get_models.cache_clear()` 등 다른 캐시들만 비우고 이 lru_cache wrapper의 `cache_clear()`는 호출하지 않았다. registry가 변경돼도 swappable 설정 매핑이 이전 값으로 고정돼 남았다.
- 수정 요지: `clear_cache()` 본문 맨 앞(기존 `get_models.cache_clear()` 호출 직전)에 `self.get_swappable_settings_name.cache_clear()` 한 줄을 추가. 이로써 docstring의 "모든 내부 캐시 비움" 계약을 실제로 만족시킨다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_clear_cache (apps.tests.AppsTests.test_clear_cache)`
- 테스트가 어떻게 픽스를 증명하는지: `@override_settings(INSTALLED_APPS=SOME_INSTALLED_APPS)` 하에서 먼저 `apps.get_swappable_settings_name("admin.LogEntry")`와 `apps.get_models()`를 호출해 두 lru_cache를 채운다. 그 뒤 `apps.clear_cache()`를 호출하고, `get_swappable_settings_name.cache_info().currsize == 0` 과 `get_models.cache_info().currsize == 0` 을 단언한다. 픽스 전이라면 swappable 캐시 currsize가 0이 아니어서 첫 단언에서 실패한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 파일·함수·수정 라인까지 다 줬으므로 `git grep "def clear_cache"` → `django/apps/registry.py` 직행. 같은 클래스 안에서 `@functools.lru_cache`로 데코레이트된 메서드 전체(`get_models`, `get_swappable_settings_name`)를 훑어 `cache_clear()` 호출 누락 여부를 대조하면 끝.
- 함정/난이도 메모: 단일 파일, 단일 라인 추가. 난이도 거의 없음. 유일한 주의점은 추가 위치 — 다른 `*.cache_clear()` 호출들과 같은 블록 안에 넣어야 의미가 맞다(골드는 `get_models.cache_clear()` 직전에 배치). lru_cache 데코레이트 메서드를 빠짐없이 식별하는 것이 핵심.
- 우리 에이전트 관점: 막힐 지점이 거의 없는 trivial 케이스. 리스크는 과잉수정 — 골드는 한 줄만 추가하므로, 굳이 캐시 관리 구조를 리팩터링하거나 다른 메서드까지 손대면 PASS_TO_PASS(42개) 회귀 위험만 키운다. "지목된 한 줄만 추가"가 정답.
