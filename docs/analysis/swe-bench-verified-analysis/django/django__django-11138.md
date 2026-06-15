---
instance_id: django__django-11138
repo: django/django
base_commit: c84b91b7603e488f7171fdff8f08368ef3d6b856
version: 3.0
difficulty: 1-4 hours
created_at: 2019-03-28T13:11:56Z
fail_to_pass: 1
pass_to_pass: 73
gold_files: [django/db/backends/mysql/operations.py, django/db/backends/oracle/operations.py, django/db/backends/sqlite3/base.py, django/db/backends/sqlite3/operations.py]
---

# django__django-11138

## 문제 요약
`USE_TZ=True`이고 DATABASES 항목에 per-database `TIME_ZONE`(예: `Europe/Paris`)을 지정해도, date 계열 lookup(`__date` 등)을 만들 때 Django가 이 DB 타임존을 무시하고 항상 `UTC`에서 변환을 수행한다. MySQL의 경우 생성 SQL이 `CONVERT_TZ(field, 'UTC', 'Europe/Paris')`로 나와, DB가 이미 Paris 로컬 시각으로 저장하고 있는데도 UTC→Paris 변환을 강제한다. 사용자는 (1) 변환이 DB 타임존(tz2)→앱 타임존(tz1)으로 가야 하고, (2) tz1==tz2이면 `CONVERT_TZ` 자체가 불필요(또한 MySQL tz 테이블 없이도 동작)하길 기대한다.

## 유형 분류
- 버그 카테고리: logic / 누락처리 (하드코딩된 'UTC' 가정 + 동일 타임존 단락 누락)
- 서브시스템: django DB backends — datetime/timezone 변환 SQL 생성 (mysql/oracle/sqlite3 operations)
- 증상 타입: silent-wrong (예외 없이 잘못된 lookup 결과; date lookup이 `False` 반환)
- 로컬라이제이션 신호: problem_statement가 변환 SQL `CONVERT_TZ(..., 'UTC', ...)`와 정확한 소스 라인(`mysql/operations.py`의 'UTC' 강제 지점)을 직접 지목 → backend operations의 `_convert_field_to_tz` 류가 즉시 후보.

## 골드패치 분석
- 건드린 파일/함수:
  - `mysql/operations.py:_convert_field_to_tz`
  - `oracle/operations.py:_convert_field_to_tz`
  - `sqlite3/operations.py:_convert_tzname_to_sql`→`_convert_tznames_to_sql` (+ 4개 datetime_* SQL 빌더)
  - `sqlite3/base.py:_sqlite_datetime_parse` 및 `_sqlite_datetime_*` 콜백 + `create_function` 등록 arity
- 근본 원인: 모든 백엔드가 저장된 datetime의 출발 타임존을 `'UTC'`로 하드코딩했다. 실제 출발 타임존은 `self.connection.timezone_name`(= per-DB `TIME_ZONE`, 미설정 시 UTC)이어야 한다. 또한 출발==목적지일 때 무조건 변환을 수행해 불필요하고(MySQL은 tz 테이블 의존) 오류를 유발했다.
- 수정 요지:
  - MySQL/Oracle: `'UTC'` 자리를 `self.connection.timezone_name`으로 교체하고, `connection.timezone_name != tzname`일 때만 `CONVERT_TZ`/`FROM_TZ ... AT TIME ZONE`을 적용, 같으면 `field_name`을 그대로 반환.
  - SQLite: 순수 Python으로 변환하므로 conn 타임존을 SQL로 넘겨야 함. `_convert_tznames_to_sql`가 `(tzname, conn_tzname)` 두 값을 반환하도록 바꾸고, `django_datetime_*` 함수들의 인자 수를 +1(arity 3/4)로 재등록.
  - `_sqlite_datetime_parse(dt, tzname, conn_tzname)`: `conn_tzname`이 있으면 naive dt에 그 tzinfo를 부여한 뒤, `tzname != conn_tzname`일 때만 `timezone.localtime`으로 목적지 타임존으로 변환.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_query_convert_timezones (timezones.tests.NewDatabaseTests)`.
- 새 `override_database_connection_timezone` 컨텍스트매니저(인스턴스 메서드에서 모듈 레벨로 승격)로 `connection.settings_dict['TIME_ZONE']`를 바꾸고 캐시된 `connection.timezone`/`timezone_name`을 무효화.
- 케이스1: DB tz == 현재 tz(`Africa/Nairobi`/EAT)에서 `dt=23:10`인 이벤트 생성 후 `dt__date=event.date()` 필터 → 변환 없이 매칭(같은 날짜). 단락 로직이 동작함을 증명.
- 케이스2: DB tz(`Asia/Bangkok`/ICT)≠현재 tz에서 `dt=03:10 ICT`(= EAT 기준 -4h → 전날) 이벤트를 만들고 `dt__date=2016-01-01`로 필터 → DB tz→앱 tz 변환이 실제로 일어나 전날로 떨어져야 매칭. UTC 하드코딩 시 변환 방향/오프셋이 틀려 실패.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 `CONVERT_TZ(..., 'UTC', ...)`와 파일/라인을 명시하므로 `grep "'UTC'"` 혹은 `_convert_field_to_tz` 진입이 빠르다. 핵심 SSOT는 `connection.timezone_name`.
- 함정/난이도: 멀티파일(3개 백엔드)이고 SQLite는 SQL이 아니라 Python 콜백이라 수정 패턴이 다르다 — `create_function`의 arity와 콜백 시그니처, 그리고 빌더의 placeholder 개수까지 일관되게 +1 해야 한다(하나라도 빠지면 인자 개수 불일치 런타임 에러). `tzname != conn_tzname` 단락 조건을 빠뜨리면 케이스1 회귀.
- 우리 에이전트 관점: MySQL 한 줄만 고치고 끝내기 쉬움(테스트는 SQLite로 돌아가므로 SQLite를 안 고치면 FAIL_TO_PASS 실패). SQLite 경로의 4-군데 동시 arity 변경을 누락하면 PASS_TO_PASS(NewDatabaseTests 대거)까지 깨질 수 있어, "동일 타임존이면 변환 생략" + "출발 타임존 파라미터화" 두 불변식을 세 백엔드에 모두 전파하는 게 관건.
