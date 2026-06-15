---
instance_id: django__django-13821
repo: django/django
base_commit: e64c1d8055a3e476122633da141f16b50f0c4a2d
version: "3.2"
difficulty: <15 min fix
created_at: 2020-12-29T15:16:10Z
fail_to_pass: 1
pass_to_pass: 14
gold_files: [django/db/backends/sqlite3/base.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [overfit-risk]
---

# django__django-13821

## 문제 요약
Django가 지원하는 SQLite 최소 버전 하한을 3.8.3에서 3.9.0으로 올리는 작업이다. 표현식 인덱스(#26167)와 `SQLITE_ENABLE_JSON1` 컴파일 옵션이 SQLite 3.9.0+에서만 동작하고, 3.9.0은 2015년 10월 릴리스라 GEOS 라이브러리와 동일한 "릴리스 후 약 5년 지원" 정책에 부합한다. 기능 버그라기보다 의도적인 하한선 상향(deprecation/floor-bump)이며, 이슈 본문이 목표 버전 숫자("3.9.0")를 그대로 명세한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement에 "Drop support for SQLite < 3.9.0", "SQLite", "SQLITE_ENABLE_JSON1"이 박혀 있어 `check_sqlite_version` 버전 게이트가 사실상 직접 지목된다. `grep "sqlite_version_info"` 한 방이면 `django/db/backends/sqlite3/base.py:check_sqlite_version`이 거의 유일 후보. 탐색 노력 0에 가까움.
- **S (Repair Strategy) = S1 (Direct-Map / template).** 이슈가 목표 상수(3.9.0)를 직접 명세하므로 픽스가 기계적이다. 정형 결함클래스 "상수/임계값 변경(threshold bump)" 템플릿에 그대로 매칭 — 비교 튜플 `(3,8,3)→(3,9,0)` 교체 + 에러 메시지 문자열 동기화. 추론으로 식을 합성할 필요(S2)도, 후보를 테스트로 수렴(S3/S4)할 필요도, 스펙을 재구성(S5)할 필요도 없다. 이슈 본문 자체가 스펙이다.
- **K (Knowledge) = K-Gen (General).** SQLite 버전 튜플 비교는 일반 파이썬 추론으로 충분하다. django ORM/query-compiler 같은 깊은 프레임워크 내부지식이 병목이 아니며(K-Domain 아님), 공개 시그니처/리턴형 계약을 맞춰야 하는 것(K-API)도 아니다. `check_sqlite_version`은 내부 부팅 가드일 뿐 공개 API가 아니다.
- **primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 S1 기계적 상수/메시지 변경이다. T-LocTrivial과의 경계가 가깝지만, 단순 한 줄이 아니라 임계값과 에러 메시지 문자열 **두 군데를 정합되게** 갱신해야 하는 "쌍 변경"이라 순수 trivial보다 DirectMap(가드/기본값/상수 매핑)에 더 정확히 들어맞는다.

왜 S1인가(APR 관점): PAR/TBar류 template-based repair에서 "literal/constant mutation"은 가장 단순한 변환 카테고리다. 여기서는 fix ingredient(목표 상수 `(3,9,0)`)가 이슈 텍스트에서 그대로 주어지므로 fix-space 탐색이 필요 없고, SemFix/Angelix식 제약합성도 불필요하다. 즉 "어떤 식을 만들지"가 아니라 "주어진 값으로 갈아끼우기"가 본질이다.

## 난이도 티어
**tier = T2 (쉬움).** 공식 라벨도 "<15 min fix"로 일치한다.

이 티어로 미는 구조적 피처:
- **파일/줄 수**: gold patch는 1파일(`sqlite3/base.py`) 단일 함수, 실효 변경 ≲3줄. 1파일·소규모 = ICLR 2024 컷에서 가장 쉬운 구간(1파일 <5줄 ≈ 48% solve).
- **localize 직접성**: L0 — 이슈가 심볼과 목표 상수를 동시에 명세. 탐색 비용 거의 0.
- **repro**: 명시적 재현 스택트레이스는 없으나(has-repro 아님), 이슈 본문이 목표를 정량 명세해 사실상 재현 불필요.
- **도메인/추론**: K-Gen, S1 — 의미 추론·도메인지식 모두 비병목.
- **P2P trap**: 14개 PASS_TO_PASS가 모두 sqlite backend 테스트로 동일 모듈 인접 동작이지만, 변경이 버전 가드 상수에 국한되어 이들을 깨뜨릴 인과 경로가 없다. regression trap 약함.

T1이 아니라 T2인 이유: T1은 "순수 한 줄·이슈가 픽스를 거의 그대로 적어줌"인데, 본 건은 임계값과 에러 메시지를 정합되게 갱신하는 두 지점 변경이라 한 군데만 고치면 `assertRaisesMessage` 정확매칭에서 깨진다. 이 사소한 쌍-변경 함정이 순수 T1보다 약간 위(T2)로 민다. T3 이상이 아닌 이유: 실질 추론(S2)·약한 localize·underspecified가 전부 부재하다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/backends/sqlite3/base.py` 의 `check_sqlite_version()`.
- **근본 원인**: 게이트가 `Database.sqlite_version_info < (3, 8, 3)`로만 거른다. 3.8.3~3.8.x 버전이 통과되지만 이들은 표현식 인덱스(#26167)와 `SQLITE_ENABLE_JSON1`을 지원하지 못한다. 즉 부팅 시 검증 하한(floor)이 실제 기능 요구사항보다 낮게 잡혀 있어, 미지원 SQLite가 통과한 뒤 표현식 인덱스/JSON1 사용 시점에 런타임 실패로 늦게 터질 수 있다.
- **수정 요지**: 비교 임계값을 `(3, 8, 3)` → `(3, 9, 0)`으로 올리고, `ImproperlyConfigured` 에러 메시지 문자열을 `'SQLite 3.8.3 or later is required ...'` → `'SQLite 3.9.0 or later is required (found %s).'`로 동기화한다. 로직 구조(조건 분기, raise, 모듈 로드 시 `check_sqlite_version()` 호출)는 불변이고 상수·메시지만 갱신된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_check_sqlite_version (backends.sqlite.tests.Tests)`.
- **동작**: 테스트는 `mock.patch.object`로 `dbapi2.sqlite_version_info`를 `(3, 8, 11, 1)`, `sqlite_version`을 `'3.8.11.1'`로 주입한 뒤 `check_sqlite_version()`을 호출하고, `assertRaisesMessage(ImproperlyConfigured, 'SQLite 3.9.0 or later is required (found 3.8.11.1).')`로 정확 메시지를 검증한다. 픽스 전: 3.8.11.1은 옛 floor `(3,8,3)`보다 높아 raise 자체가 안 나거나, 나더라도 옛 메시지("3.8.3")라 정확매칭 실패. 픽스 후: 새 floor `(3,9,0)` 아래라 raise되고 메시지가 정확히 일치 → 통과. (기존 3.8.2 케이스를 3.8.11.1로 교체한 것이 새 임계값을 직접 반영.)
- **overfit 관점 (flag: overfit-risk)**: FAIL_TO_PASS가 단 1개이고, 검증 입력이 `(3,8,11,1)` 단일 경계점뿐이다. 에러 메시지 문자열을 정확히 `3.9.0`으로 하드코딩만 맞춰도 통과하므로, 임계값 비교 로직을 잘못 건드려도(예: `<=` 오용, 또는 floor를 3.9.0이 아닌 임의 값으로) 이 한 점만 통과시키는 special-case 픽스가 이론상 가능하다. 다만 이슈가 목표 상수를 명세하므로 올바른 일반화(정확히 `(3,9,0)`)로 수렴하기 쉬워 실질 overfit 가능성은 낮다.
- **regression 관점**: 14개 PASS_TO_PASS는 escaping/aggregation/schema/threading 등 sqlite backend 동작인데, 모두 실제 설치된 SQLite(>3.9.0)에서 도는 정상 경로라 floor 상향에 영향받지 않는다. 변경 범위가 가드 상수에 국한되어 회귀 위험 거의 없음.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "Drop support for SQLite < 3.9.0" + "SQLite"를 신호로 잡고 `grep -rn "sqlite_version_info"` 또는 `grep "3.8.3"` → `django/db/backends/sqlite3/base.py:check_sqlite_version`이 유일 후보로 즉시 수렴. 부팅 시 모듈 로드에서 `check_sqlite_version()`이 호출되는 단일 게이트임을 확인.
2. **픽스와 올바른 일반화**: 비교 임계값을 `(3, 8, 3)` → `(3, 9, 0)`으로 바꾸고, 에러 메시지의 "3.8.3"을 "3.9.0"으로 동기화. 이게 overfit이 아닌 이유 — 목표 상수가 이슈에서 명세된 도메인 사실(표현식 인덱스/JSON1이 3.9.0+ 필요)에서 나오므로 테스트의 단일 경계점에 맞춘 게 아니라 실제 요구 floor를 반영한다. 비교 연산자(`<`)와 라이즈 타입(`ImproperlyConfigured`)은 그대로 유지해 의미 보존.
3. **regression 안전**: 14개 P2P는 정상 SQLite 버전에서 도는 backend 기능 테스트라 floor 상향과 직교한다. 비교 연산자·예외 타입·`check_sqlite_version()` 호출 위치를 건드리지 않아 인접 동작 무손상. `features.py`의 다른 버전 게이트나 docs는 이 테스트와 무관하므로 손대지 않는다(과잉수정 회피).
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) 임계값만 바꾸고 에러 메시지의 "3.8.3"을 방치 → `assertRaisesMessage` 정확 문자열 매칭에서 실패. 반드시 상수와 메시지를 **쌍으로** 갱신할 것. (b) 메시지 포맷(`(found %s)` + `Database.sqlite_version`)을 임의로 바꾸면 기대 문자열 `'... (found 3.8.11.1).'`과 불일치. 골드의 포맷·구두점을 정확히 유지. (c) docs(`docs/ref/databases.txt`)나 `features.py`까지 광범위 수정하는 과잉수정은 테스트 통과에 불필요하고 회귀 표면만 키운다 — 변경을 `check_sqlite_version` 단일 함수로 한정.
