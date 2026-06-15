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
---

# django__django-13089

## 문제 요약
DB 캐시 백엔드에서 `_cull` 도중 `'NoneType' object is not subscriptable` 에러가 산발적으로 발생한다. `cache_key_culling_sql()`을 실행한 뒤 `cursor.fetchone()[0]`을 바로 인덱싱하는데, 컬링 대상 행이 없으면 `fetchone()`이 `None`을 반환해서 `[0]` 접근이 터진다. 사용자는 캐시 set이 조용히 동작하길 기대했지만 빈 결과셋일 때 크래시가 난다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (None-check 빠짐)
- 서브시스템: django core cache / database backend (`django.core.cache.backends.db`)
- 증상 타입: 예외 (`TypeError: 'NoneType' object is not subscriptable`) / 산발적 크래시
- 로컬라이제이션 신호: problem_statement에 파일·라인·백트레이스가 그대로 명시됨 — `backends/db.py:277 → _cull`, 그리고 문제 코드 `cursor.fetchone()[0]`까지 인용. 거의 핀포인트로 골드 파일·함수를 지목.

## 골드패치 분석
- 건드린 파일/함수: `django/core/cache/backends/db.py` : `BaseDatabaseCache._cull`
- 근본 원인: `cache_key_culling_sql()` 쿼리가 컬링 기준이 될 cache_key를 못 찾으면(저장된 레코드가 0개에 가깝거나 max_entries 조건상 자를 행이 없을 때) `cursor.fetchone()`이 `None`을 반환한다. 기존 코드는 결과를 곧바로 `[0]`으로 첨자 접근해서 `None[0]`에서 `TypeError` 발생.
- 수정 요지: `fetchone()` 결과를 `last_cache_key` 변수로 받고, `if last_cache_key:`로 가드한 뒤에만 `DELETE FROM ... WHERE cache_key < %s` 를 `last_cache_key[0]`으로 실행하도록 변경. 즉 빈 결과셋이면 DELETE 자체를 건너뛴다. 로직 변경 없이 None 분기만 추가한 최소 수정.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_cull_delete_when_store_empty` (DBCacheTests / DBCacheWithTimeZoneTests). `_max_entries`를 `-1`로 강제해 첫 레코드 저장 시점부터 `_cull`이 DELETE 경로를 타도록 만든 뒤, set이 예외 없이 성공하고 `has_key('force_cull_delete')`가 `True`인지 확인한다.
- 증명 방식: `_max_entries = -1`이면 저장 직후 컬링이 트리거되지만 사실상 자를 대상 행이 없어 `fetchone()`이 `None`을 돌려주는 상황을 재현. 픽스 전에는 `_cull`에서 TypeError로 set 실패 → 패치 후에는 DELETE를 스킵하고 정상 저장되어 `has_key`가 True. 같은 테스트가 LocMem/FileBased 백엔드에서는 PASS_TO_PASS로 들어가 있어(이미 통과) DB 백엔드 한정 회귀임을 드러낸다.

## 공략 포인트 (뭘 조져야)
- 로컬라이제이션 전략: problem_statement가 파일/라인/메서드/문제 코드까지 다 줬으므로 `_cull` 메서드의 `cursor.fetchone()[0]` 라인을 바로 찾으면 된다. grep 키워드: `cache_key_culling_sql`, `fetchone()[0]`.
- 함정/난이도: 단일 파일·단일 함수, 5분짜리 None-guard. 함정은 (1) `cull_num`이나 컬링 알고리즘 자체를 손대려는 과잉수정, (2) DELETE 쿼리 문자열 포매팅(`%s` vs `%%s` 이스케이프)을 잘못 건드려 SQL이 깨지는 것 — 골드는 쿼리 형태를 그대로 유지하고 None 분기만 추가했다.
- 우리 에이전트 관점: 막힐 지점은 거의 없음. 위험은 재현 테스트를 직접 못 짜는 경우(`_max_entries = -1` 트릭을 떠올려야 함)지만, 픽스 자체는 None-check 추가라 명확. 오히려 "왜 fetchone이 None이냐"를 길게 파다 시간 낭비하지 말고 방어적 가드로 끝내는 게 정답.
