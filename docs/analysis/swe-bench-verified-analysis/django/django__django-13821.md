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
---

# django__django-13821

## 문제 요약
Django가 지원하는 SQLite 최소 버전을 3.8.3에서 3.9.0으로 올리는 작업이다. 표현식 인덱스(#26167)와 `SQLITE_ENABLE_JSON1` 컴파일 옵션이 SQLite 3.9.0+에서만 동작하고, 3.9.0은 2015년 10월 릴리스라 GEOS 라이브러리와 동일한 "릴리스 후 약 5년 지원" 정책에 부합한다. 기능 버그라기보다 의도적인 하한선 상향(deprecation/floor-bump)이다.

## 유형 분류
- 버그 카테고리: validation (지원 버전 하한 검증 상향)
- 서브시스템: django DB backend / sqlite3 (`django.db.backends.sqlite3`)
- 증상 타입: 잘못된 동작(낮은 버전 SQLite를 통과시켜 이후 표현식 인덱스/JSON1 사용 시 런타임 실패 가능)
- 로컬라이제이션 신호: problem_statement에 "Drop support for SQLite < 3.9.0", "SQLITE_ENABLE_JSON1", "Indexes on expressions"가 명시 → SQLite 버전 게이트 코드(`check_sqlite_version`)를 직접 지목한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/sqlite3/base.py:check_sqlite_version`
- 근본 원인: 함수가 `Database.sqlite_version_info < (3, 8, 3)` 조건으로만 거르고 있어, 3.8.3~3.8.x 버전이 통과되지만 이들은 표현식 인덱스/JSON1을 지원하지 못한다. 즉 floor가 실제 기능 요구사항보다 낮게 잡혀 있었다.
- 수정 요지: 비교 임계값을 `(3, 8, 3)` → `(3, 9, 0)`으로 올리고, 에러 메시지 문자열을 `'SQLite 3.8.3 or later is required ...'` → `'SQLite 3.9.0 or later is required (found %s).'`로 변경한다. 로직 구조(조건 분기, `ImproperlyConfigured` raise, 모듈 로드 시 `check_sqlite_version()` 호출)는 동일하고 상수와 메시지만 갱신된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_check_sqlite_version (backends.sqlite.tests.Tests)`
- 테스트 방식: `mock.patch.object`로 `dbapi2.sqlite_version_info`를 `(3, 8, 11, 1)`, `sqlite_version`을 `'3.8.11.1'`로 가짜 주입한 뒤 `check_sqlite_version()`을 호출하고, `assertRaisesMessage(ImproperlyConfigured, 'SQLite 3.9.0 or later is required (found 3.8.11.1).')`로 기대 메시지를 검증한다. 픽스 전에는 3.8.11.1이 새 floor(3,9,0) 아래임에도 통과하거나 옛 메시지(3.8.3)를 내어 실패하고, 픽스 후에는 정확히 3.9.0 메시지로 raise되어 통과한다. (기존 테스트의 3.8.2 케이스가 3.8.11.1로 교체된 점도 새 임계값을 반영.)

## 공략 포인트 (뭘 조져야)
- localization: problem_statement의 버전 숫자("3.9.0")와 "SQLite"로 코드를 grep하면 `check_sqlite_version`이 거의 유일한 후보다. 단일 파일·단일 함수라 탐색 난이도는 매우 낮다.
- 함정/난이도: 코드 한 줄 + 메시지 문자열 두 군데가 정합해야 한다. 임계값만 바꾸고 메시지의 "3.8.3"을 그대로 두면 테스트의 `assertRaisesMessage`가 정확 문자열 매칭에서 실패한다. 멀티파일 아님. docs(`docs/ref/databases.txt` 등)나 `features.py`의 다른 버전 게이트는 이 테스트 통과에 불필요(과잉수정 주의).
- 우리 에이전트 관점: 막힐 지점은 거의 없으나, 에러 메시지 문자열을 임계값과 함께 갱신하는 "쌍 변경"을 놓치는 실수만 피하면 된다. 비교 튜플 `(3, 9, 0)` 형태와 메시지 포맷(`%s`로 `sqlite_version` 출력)을 골드와 정확히 일치시키는 것이 핵심.
