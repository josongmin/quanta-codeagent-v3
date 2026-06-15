---
instance_id: django__django-13089
repo: django/django
base_commit: 27c09043da52ca1f02605bf28600bfd5ace95ae4
version: "3.2"
difficulty: <15 min fix
created_at: 2020-06-20T07:36:10Z
fail_to_pass: 2
pass_to_pass: 352
gold_files: [django/core/cache/backends/db.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-13089

## 문제 요약
DB 캐시 백엔드(`django.core.cache.backends.db`)의 `_cull` 도중 `'NoneType' object is not subscriptable` 에러가 산발적으로 발생한다. `connection.ops.cache_key_culling_sql() % table`을 실행한 뒤 곧바로 `cursor.fetchone()[0]`을 인덱싱해서 컬링 기준 `cache_key`를 얻는데, 컬링 대상 행이 없으면 `fetchone()`이 `None`을 반환하여 `None[0]`에서 `TypeError`로 터진다. 사용자가 직접 native 백트레이스(`base.py:143 → ... → db.py:277 → _cull`)와 문제 코드 라인까지 인용했고, "데이터가 있는지 체크하면 충분할 것 같다, easy pick"이라고 픽스 방향까지 명시했다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈가 파일(`backends/db.py`), 라인(277), 메서드(`_cull`), 정확한 결함 표현식(`cursor.fetchone()[0]`)을 모두 직접 지목했다. grep `cache_key_culling_sql` 한 방이면 끝. 탐색 노력 거의 0.
- **S (Repair Strategy) = S1 (Direct-Map/template).** 정형 결함클래스인 None-가드 누락에 템플릿 매칭된다. 이슈가 사실상 픽스를 명세("a simple check to see if it contains data")했고, 수정은 fetch 결과를 받아 truthy 가드 뒤에서만 첨자 접근/DELETE를 수행하는 기계적 변경이다. 추론으로 올바른 조건식을 합성할 필요(S2)도, 후보 생성·테스트 반복(S3/S4)도 없다 — None 분기 하나만 추가하면 결정적으로 옳다.
- **K (Knowledge) = K-Gen (General).** "fetchone()이 빈 결과셋에서 None을 반환한다"는 DB-API 2.0의 일반 상식이면 충분. django ORM 내부지식·query compiler·migrations 같은 도메인 깊이가 필요 없다. 컬링 알고리즘 자체를 이해할 필요도 없고, 단지 "fetch가 None일 수 있다"만 알면 된다.
- **primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적 None-가드(S1)인 전형. T-LocTrivial과 경계지만, 픽스가 단순 한 줄 치환이 아니라 fetch 결과를 변수로 추출→가드→조건부 DELETE로 소폭 재구조화하므로 "완전 자명"보다는 DirectMap이 정확하다.

## 난이도 티어
**T2 (쉬움).** 공식 라벨도 `<15 min fix`로 일치하며, 구조적 피처가 이를 뒷받침한다: 단일 파일(1), 단일 함수(`_cull`), 순증 효과적으로 ~3줄, `has-repro`(native 백트레이스 + 문제 코드 인용 — 가장 강한 easiness 신호, 해결률 ~87%), K-Gen. 이슈가 픽스를 거의 적어주는 수준이라 T1 후보지만 T2로 두는 이유는: (1) 픽스가 단순 상수/기본값 변경이 아니라 fetch 결과를 변수로 추출하고 조건부로 DELETE를 건너뛰는 가벼운 제어흐름 변경이고, (2) `pass_to_pass`가 352개로 광범위(`regression-trap`) — 같은 `_cull`이 LocMem/FileBased 등 다른 백엔드에서 테스트되므로 쿼리 문자열 포매팅이나 컬링 로직을 잘못 건드리면 다수 인접 테스트가 깨진다. localize 자명함이 시간라벨을 끌어내리지만 regression 표면이 넓어 T1까지 내리진 않는다.

## 골드패치 분석
- **건드린 파일·함수:** `django/core/cache/backends/db.py` 의 `BaseDatabaseCache._cull`.
- **근본 원인:** `cache_key_culling_sql() % table` 쿼리가 컬링 기준이 될 `cache_key`를 못 찾는 경우(저장 레코드가 매우 적거나 `_max_entries` 조건상 잘라낼 행이 사실상 없을 때) `cursor.fetchone()`이 `None`을 반환한다. 기존 코드는 이 결과를 곧바로 `[0]`으로 첨자 접근(`[cursor.fetchone()[0]]`)했기 때문에 `None[0]`에서 `TypeError: 'NoneType' object is not subscriptable`이 발생하고, 이게 `_base_set` → `set` 경로를 타고 캐시 저장 전체를 실패시킨다.
- **수정 요지:** `fetchone()` 결과를 `last_cache_key` 지역변수로 받고 `if last_cache_key:` 가드를 둔 뒤에만 `DELETE FROM %s WHERE cache_key < %%s` 를 `[last_cache_key[0]]`로 실행한다. 빈 결과셋이면 DELETE 자체를 스킵 — 자를 행이 없으니 의미상으로도 올바른 no-op. 쿼리 문자열 형태(`%s` 테이블 보간, `%%s` 파라미터 이스케이프)는 그대로 보존하고 None 분기만 추가한 최소 수정.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작 (2건):** `test_cull_delete_when_store_empty` — `DBCacheTests`와 `DBCacheWithTimeZoneTests` 두 클래스. `cull_cache._max_entries = -1`로 강제해 첫 레코드 저장 시점부터 `_cull`이 DELETE 경로를 타게 만든 뒤, `cull_cache.set('force_cull_delete', ...)`이 예외 없이 성공하고 `has_key('force_cull_delete')`가 `True`인지 단언한다. `finally`로 `_max_entries`를 복원해 테스트 격리를 지킨다.
- **픽스 증명:** `_max_entries = -1`이면 저장 직후 컬링이 트리거되지만 자를 대상 행이 없어 `fetchone()`이 `None`을 돌려준다. 패치 전에는 `_cull`에서 `TypeError` → `set` 실패 → `has_key` 단언 도달조차 못 함. 패치 후에는 DELETE를 스킵하고 정상 저장되어 `has_key`가 `True`. 결함 트리거 조건(`-1`)을 직접 만들어 가드의 효과를 관찰하는 강한 테스트다.
- **overfit 관점:** S1 None-가드라 overfit 위험 낮음. 가드는 `fetchone()`이 None인 모든 경우를 일반적으로 커버하므로 테스트의 특정 입력(`-1`)에만 맞춘 special-case가 아니다. `overfit-risk` 플래그를 달지 않은 이유.
- **regression 관점:** `regression-trap` 플래그 — `pass_to_pass`가 352개로 넓다. 특히 `test_cull`, `test_zero_cull`(DBCache/DBCacheWithTimeZone) 같은 기존 컬링 테스트가 P2P에 있어 가드 추가가 정상 컬링 흐름을 깨지 않음을 보장해야 한다. 또 같은 `test_cull_delete_when_store_empty`가 LocMem/FileBased 백엔드에서는 P2P(이미 통과)로 들어가 있어, 이 버그가 DB 백엔드 한정 회귀임을 드러낸다.

## 모범답안 (오라클 기반)
1. **localize 경로:** problem_statement가 백트레이스(`db.py:277 → _cull`) + 정확한 결함 코드(`cursor.fetchone()[0]`)를 그대로 줬다. `cache_key_culling_sql` 또는 `fetchone()[0]`로 grep → `BaseDatabaseCache._cull` 단일 후보. 탐색 사실상 불필요(L0).
2. **픽스 (왜 올바른 일반화인가):** `fetchone()` 결과를 변수로 받아 truthy 가드 후에만 첨자 접근/DELETE한다. DB-API에서 `fetchone()`은 결과 행이 없으면 None을 반환하므로, "자를 행이 없으면 DELETE를 건너뛴다"는 의미상 정확한 처리다. 특정 테스트 입력이 아니라 None 반환이라는 *원인 자체*를 막으므로 overfit이 아닌 올바른 일반화.
3. **regression 안전:** `test_cull`/`test_zero_cull`(정상 컬링)을 안 깨야 한다 — 가드는 결과가 truthy인 정상 경로에서 기존 동작과 byte-identical(같은 DELETE 실행)이고 None일 때만 분기하므로 안전. 쿼리 문자열의 `%s`/`%%s` 보간을 보존해 SQL 파라미터화도 유지.
4. **함정 회피:** 오라클 없는 에이전트의 오류 지점은 (1) "왜 fetchone이 None이냐"를 컬링 알고리즘·`cull_num`까지 파고들며 과잉수정 — 방어적 None-가드로 끝내는 게 정답. (2) DELETE 문자열을 손대다 `%%s` 이스케이프를 깨 SQL이 망가지는 것 — 골드는 쿼리 형태를 그대로 두고 분기만 추가. (3) 재현 테스트를 직접 짜야 할 때 `_max_entries = -1`로 강제 컬링 트리거하는 트릭을 떠올리지 못하는 것 — 단, 픽스 자체는 테스트 없이도 명확하므로 막히지 않는다.
