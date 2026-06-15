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
primary_type: T-LocTrivial
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-17029

## 문제 요약
`Apps.clear_cache()`는 docstring상 "Clear all internal caches, for methods that alter the app registry"라고 명시하지만, 실제로는 `get_swappable_settings_name`의 `functools.lru_cache` 캐시를 비우지 않는다. django-stubs는 연속 mypy 실행 사이 app registry 상태를 리셋하려고 `clear_cache()`를 호출하는데, 이 swappable settings name 캐시가 살아남아 이전 상태가 다음 실행으로 새어나간다. problem_statement는 원인(`get_swappable_settings_name`이 `functools._lru_cache_wrapper`인데 clear에서 누락됨)과 수정안(`self.get_swappable_settings_name.cache_clear()` 한 줄 추가)까지 직접 제시한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: problem_statement가 파일(`django/apps/registry.py`)·메서드(`clear_cache`)·추가할 정확한 코드 라인까지 명시. `git grep "def clear_cache"` 한 방으로 직행. 탐색 비용 사실상 0.
- **S1 (Direct-Map)**: 정형 결함클래스 "cache invalidation 항목 누락". 이슈가 픽스를 그대로 적어줌 — 기존 `*.cache_clear()` 호출 블록에 누락된 wrapper 하나의 `cache_clear()`를 기계적으로 추가하는 템플릿 매칭. 추론으로 식·조건을 합성할 필요(S2) 없음, 후보 다수 탐색(S3) 없음.
- **K-Domain**: `get_swappable_settings_name`이 `@functools.lru_cache(maxsize=None)`로 데코레이트된 *메서드*이고 `cache_clear()`가 wrapper에 붙는다는 점, 그리고 이것이 "registry를 변경하는 메서드의 내부 캐시" 계약에 포함된다는 점은 django apps registry 캐시 구조 지식에 의존. 다만 이슈가 이미 떠먹여주므로 지식 병목은 약하다(라벨링상 K-Domain이되 dominant 난이도 요인은 아님).
- **primary type = T-LocTrivial**: L0 + S1. 찾으면 끝, 픽스 자명. 루브릭의 "찾으면 끝, 픽스 자명(대개 존나쉬움)" 정의에 정확히 부합.
- **왜 이 strategy인가(APR 관점)**: 결함이 "한 항목이 invalidation 리스트에서 빠진" 정형 omission 패턴이라, TBar/PAR식 fix-template("같은 클래스의 lru_cache 데코 메서드 전부에 대해 clear_cache에서 cache_clear 호출이 존재해야 한다")에 1:1 매칭된다. 올바른 식 합성도, 테스트 피드백 반복 수렴도 필요 없는 deterministic single-edit이므로 S1.

## 난이도 티어
- **T1 (존나쉬움)**. 루브릭 T1 프로파일 "L0 + S1, 1파일 ≲10줄, has-repro, K-Gen. 이슈가 픽스를 거의 적어줌"과 거의 완전 일치(지식축만 명목상 K-Domain).
- 이 티어로 미는 구조적 피처:
  - **파일/줄수**: gold patch = 1파일·1라인 추가. ICLR 2024 구조컷 "1파일·<5줄 ≈ 48% solve"의 최저 난이도 구간.
  - **localize 직접성(L0)**: 이슈가 심볼·메서드·라인을 지목 → localization 에러(실패의 ~51%) 위험 소거.
  - **has-repro**: problem_statement에 재현 시나리오(django-stubs PR 링크 + "이 캐시가 안 비워진다")와 명시적 수정 제안 존재. ORACLE-SWE상 가장 강한 easiness 신호.
  - **P2P trap(약하게 존재)**: PASS_TO_PASS 43개로 apps registry 동작 전반을 안 깨야 한다는 점은 regression-trap이지만, 추가가 한 줄 cache_clear라 인접 동작에 부작용이 없어 실질 위험은 낮음.
- **공식 라벨과의 정합**: 공식 `<15 min fix`와 일치. 재조정 불필요 — localize·overfit 위험이 모두 낮아 시간라벨이 에이전트 난이도와 어긋나지 않는 드문 케이스.

## 골드패치 분석
- **건드린 파일·함수**: `django/apps/registry.py` → `Apps.clear_cache`
- **근본 원인**: `Apps` 클래스의 `get_swappable_settings_name`은 `@functools.lru_cache(maxsize=None)`로 감싸진 메서드라 자체 캐시를 보유한다. 그러나 `clear_cache()`는 `get_models.cache_clear()`(및 expire 로직)만 호출하고 이 wrapper의 `cache_clear()`를 호출하지 않았다. 결과적으로 INSTALLED_APPS/registry가 바뀌어도 swappable settings name 매핑이 이전 값으로 고정돼 남아, docstring이 약속한 "모든 내부 캐시 비움" 계약을 위반했다.
- **수정 요지**: `clear_cache()` 본문 맨 앞, 기존 `self.get_models.cache_clear()` 직전에 `self.get_swappable_settings_name.cache_clear()` 한 줄 추가. 이로써 registry를 변경하는 메서드가 의존하는 lru_cache 전체가 일관되게 invalidate된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_clear_cache (apps.tests.AppsTests.test_clear_cache)`
- **동작/픽스 증명**: `@override_settings(INSTALLED_APPS=SOME_INSTALLED_APPS)` 하에서 `apps.get_swappable_settings_name("admin.LogEntry")`와 `apps.get_models()`를 호출해 두 lru_cache를 채운다. 그 뒤 `apps.clear_cache()`를 호출하고 `get_swappable_settings_name.cache_info().currsize == 0`, `get_models.cache_info().currsize == 0`을 단언한다. 픽스 전에는 첫 단언에서 swappable 캐시 currsize가 0이 아니어서 실패 → 한 줄 추가 후 통과. `cache_info().currsize`를 직접 관찰하므로 캐시가 실제로 비워졌다는 effect를 확인하는 강한 단언이다.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇지만, 검사 대상이 "currsize==0"이라는 캐시 상태 불변식 자체라 special-case 우회가 불가능(캐시를 진짜 비우지 않으면 통과 못 함). S1 정형 픽스라 overfit-risk 플래그는 부여하지 않는다.
- **regression 관점**: PASS_TO_PASS 43개(get_app_config/get_model/get_models/relabeling/namespace package 처리 등 apps registry 전반)를 안 깨야 한다. 추가가 멱등한 `cache_clear()` 한 줄이고 호출 시점도 다른 cache_clear들과 같은 블록이라 인접 동작에 부작용 없음 → regression-trap은 명목상 존재하나 실질 위험 낮음.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement가 "`apps.clear_cache()`가 `get_swappable_settings_name`(functools._lru_cache_wrapper) 캐시를 안 비운다"고 직접 지목 → `git grep "def clear_cache"` → `django/apps/registry.py`의 `Apps.clear_cache` 직행. 같은 클래스에서 `@functools.lru_cache`로 데코된 메서드(`get_models`, `get_swappable_settings_name`)를 훑어 `clear_cache()` 내 `cache_clear()` 호출 목록과 대조하면 누락이 즉시 드러난다.
2. **픽스와 올바른 일반화**: `clear_cache()`에 `self.get_swappable_settings_name.cache_clear()` 추가. 이것이 overfit이 아닌 이유 — 픽스가 테스트의 특정 입력("admin.LogEntry")에 맞춘 게 아니라 "registry 변경 시 비워져야 할 내부 캐시 집합"이라는 docstring 계약을 충족시키는 구조적 완성이다. lru_cache wrapper 전체에 일반적으로 성립.
3. **regression 안전**: PASS_TO_PASS 43개 중 특히 `get_models`/`get_app_config`/`relabeling` 등이 깨지면 안 된다. `cache_clear()`는 캐시를 비우기만 할 뿐 매핑 로직을 바꾸지 않고 멱등하므로, 다음 접근에서 정상 재계산되어 기존 동작 보존. 다른 cache_clear들과 같은 블록에 배치해 일관성 유지.
4. **함정 회피**: 오라클 없는 에이전트의 유일한 실수 가능성은 **과잉수정**이다. 캐시 관리 구조를 리팩터링하거나, lru_cache를 다른 무효화 메커니즘으로 교체하거나, 인접 메서드까지 손대면 PASS_TO_PASS 회귀만 키운다. 또 하나의 미묘한 지점은 **추가 위치** — `get_swappable_settings_name`이 *메서드*에 붙은 lru_cache라 `self.<method>.cache_clear()` 형태여야 하고(전역 함수 캐시와 혼동 금지), 골드처럼 다른 `*.cache_clear()` 호출과 같은 블록에 둬야 의미가 맞다. "지목된 한 줄만 추가"가 정답.
