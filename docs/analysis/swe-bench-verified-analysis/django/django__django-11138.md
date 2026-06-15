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
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-11138

## 문제 요약
`USE_TZ=True`이고 DATABASES 항목에 per-database `TIME_ZONE`(예: `Europe/Paris`)을 지정해도, date 계열 lookup(`__date` 등)을 만들 때 Django가 이 DB 타임존을 무시하고 항상 `UTC`에서 변환을 수행한다. MySQL의 경우 생성 SQL이 `DATE(CONVERT_TZ(field, 'UTC', 'Europe/Paris'))`로 나와, DB가 이미 Paris 로컬 시각으로 저장하고 있는데도 UTC→Paris 변환을 강제한다. 사용자는 (1) 변환이 DB 타임존(tz2)→앱 타임존(tz1)으로 가야 하고, (2) tz1==tz2이면 `CONVERT_TZ` 자체가 불필요(또한 MySQL tz 테이블 없이도 동작)하길 기대한다. problem_statement에 재현 셸 세션과 정확한 소스 라인(`mysql/operations.py`의 'UTC' 강제 지점)까지 첨부되어 있다.

## 유형 (정형화)

3축 점수:
- **L = L3 (Multi-site).** 근본 원인 지점은 핀포인트(이슈가 `CONVERT_TZ(..., 'UTC', ...)`와 파일/라인을 직접 지목)지만, 올바른 픽스는 MySQL/Oracle/SQLite 세 백엔드 4개 파일에 **조율되어 함께** 들어가야 한다. 특히 SQLite는 `operations.py`의 SQL 빌더와 `base.py`의 Python 콜백+`create_function` arity가 한 묶음으로 같이 바뀌지 않으면 런타임 인자 개수 불일치가 난다. 한 곳만 고치면 FAIL_TO_PASS가 안 풀리거나(테스트는 SQLite로 돌므로 MySQL만 고치면 무의미) P2P가 깨진다 → 단일-지점 결함이 아니라 multi-site 조율.
- **S = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 가드 추가가 아니다. (a) 출발 타임존을 `'UTC'` 상수에서 `self.connection.timezone_name`이라는 새 SSOT 파라미터로 끌어올리고, (b) SQLite에서는 그 conn 타임존을 SQL 호출 경계 너머 Python 콜백까지 **새 인자로 관통**시키기 위해 `_convert_tzname_to_sql`→`_convert_tznames_to_sql`(반환값 1→2개), 콜백 시그니처(`conn_tzname` 추가), `create_function` arity(2→3, 3→4)를 일관되게 재배선해야 한다 — 이것이 S6(파라미터 도입+lifecycle 재배치)다. 그 위에 "출발==목적지면 변환 생략"이라는 올바른 조건식(`connection.timezone_name != tzname`)을 불변식으로 합성하는 부분이 S2다.
- **K = K-Domain.** 일반 파이썬 추론으로 안 된다. django DB-backend 내부(`connection.timezone_name` 캐시드 프로퍼티, USE_TZ 시맨틱), MySQL `CONVERT_TZ`, Oracle `FROM_TZ ... AT TIME ZONE ... CAST AS TIMESTAMP`, SQLite의 user-defined function 등록 메커니즘을 알아야 세 백엔드 각각의 관용구로 같은 의미를 표현할 수 있다.

**primary type = T-DesignRefactor.** L3가 강해 T-DiffuseLoc도 후보지만, 진짜 어려움이 "어디인지 찾기"에 있지 않다(이슈가 root를 핀포인트). 난점은 한 개념(출발 타임존 파라미터화 + 동일-tz 단락)을 세 백엔드에 **조율된 구조 변경**으로 전파하는 데 있으므로 S6-dominant인 T-DesignRefactor가 맞다.

## 난이도 티어
**T5 (어려움).** 이 티어로 미는 구조적 피처:
- **patch scope**: 4파일·다중 헌크(루브릭 구조컷에서 ≥3파일은 solve <10% 구간). 세 백엔드가 서로 다른 관용구라 패턴 복붙이 안 되고 각각 번역이 필요.
- **localize 직접성과의 비대칭**: root는 L0-급으로 명확한데 fix는 L3 multi-site. has-repro라는 강한 easiness 신호가 있어도 그게 "한 줄"로 안 끝나는 게 함정.
- **regression-trap**: P2P 73개, 그중 `NewDatabaseTests`/`LegacyDatabaseTests` 다수가 동일 datetime 경로를 탄다. SQLite arity를 한 군데라도 누락하면 이 대량 P2P가 통째로 깨진다.
- **도메인**: K-Domain(타임존 변환 SQL/UDF 내부).

공식 라벨 `1-4 hours`(T4 prior에 해당)와 비교하면 한 단계 올렸다. 공식 라벨은 "오라클을 가진 개발자의 구현 시간"이라 root가 핀포인트인 이 문제는 사람에게 1-4시간이 맞지만, **에이전트 관점에서는 multi-site 조율 누락 위험과 SQLite arity 일관성 트랩이 시간라벨에 안 잡힌다**. cross-file 조율 실패와 P2P 회귀 고위험을 반영해 T5로 재조정.

## 골드패치 분석
- **건드린 파일·함수**:
  - `mysql/operations.py:_convert_field_to_tz`
  - `oracle/operations.py:_convert_field_to_tz`
  - `sqlite3/operations.py:_convert_tzname_to_sql`→`_convert_tznames_to_sql` (+ `datetime_cast_date_sql`/`datetime_cast_time_sql`/`datetime_extract_sql`/`datetime_trunc_sql` 4개 빌더)
  - `sqlite3/base.py:get_new_connection`의 `create_function` 등록 4건 + `_sqlite_datetime_parse` 및 `_sqlite_datetime_cast_date`/`_cast_time`/`_extract`/`_trunc` 콜백
- **근본 원인**: 모든 백엔드가 저장된 datetime의 **출발 타임존을 `'UTC'`로 하드코딩**했다. 실제 출발 타임존은 `self.connection.timezone_name`(= per-DB `TIME_ZONE`, 미설정 시 UTC)이어야 한다. 또한 출발==목적지일 때도 무조건 변환을 수행해 불필요하고(MySQL은 tz 테이블 의존이라 실패 유발) 의미상 틀린 SQL을 만들었다.
- **수정 요지**:
  - MySQL: `if settings.USE_TZ and self.connection.timezone_name != tzname:` 가드로 바꾸고 `CONVERT_TZ(%s, '%s', '%s')`의 출발 인자를 `self.connection.timezone_name`으로. 같으면 `field_name` 원본 반환.
  - Oracle: `FROM_TZ(%s, '0:00')`의 `'0:00'`(=UTC) 자리를 `self.connection.timezone_name`으로 교체하고, `connection.timezone_name != tzname`일 때만 `CAST((FROM_TZ ... AT TIME ZONE ...) AS TIMESTAMP)`를 적용, 같으면 `field_name` 반환.
  - SQLite: 변환을 Python으로 하므로 conn 타임존을 SQL 호출에 실어 보내야 함. `_convert_tznames_to_sql`가 `(tzname, conn_tzname)` 두 SQL 토큰(USE_TZ off면 `'NULL','NULL'`)을 반환하도록 바꾸고 4개 빌더가 `*self._convert_tznames_to_sql(tzname)`로 언팩. 대응해 `create_function`을 `django_datetime_cast_date`/`cast_time` arity 2→3, `django_datetime_extract`/`trunc` arity 3→4로 재등록.
  - `_sqlite_datetime_parse(dt, tzname, conn_tzname)`: `conn_tzname`이 있으면 typecast된 naive dt에 `dt.replace(tzinfo=pytz.timezone(conn_tzname))`로 출발 tzinfo를 부여한 뒤, `tzname is not None and tzname != conn_tzname`일 때만 `timezone.localtime(dt, pytz.timezone(tzname))`로 목적지 타임존 변환.

## 검증 (test_patch)
- **FAIL_TO_PASS (1)**: `test_query_convert_timezones (timezones.tests.NewDatabaseTests)`. 새로 모듈 레벨로 승격된 `override_database_connection_timezone` 컨텍스트매니저로 `connection.settings_dict['TIME_ZONE']`를 바꾸고 캐시드 프로퍼티 `connection.timezone`/`timezone_name`을 무효화한다.
  - **케이스1 (동일 tz)**: DB tz == 현재 tz(`Africa/Nairobi`/EAT)에서 `dt=23:10` 이벤트 생성 후 `dt__date=event_datetime.date()` 필터 → 변환 없이 같은 날짜로 매칭되어야 함. **단락(short-circuit) 로직 증명**.
  - **케이스2 (상이 tz)**: DB tz(`Asia/Bangkok`/ICT)≠현재 tz(EAT)에서 `dt=03:10 ICT`(EAT 기준 -4h → 전날) 이벤트를 만들고 `dt__date=2016-01-01`로 필터 → DB tz→앱 tz 변환이 실제로 일어나 전날로 떨어져야 매칭. **출발 타임존 파라미터화 + 변환 방향 증명**. UTC 하드코딩이면 출발 가정이 틀려 오프셋/날짜가 어긋나 실패.
- **overfit 관점**: FAIL_TO_PASS는 1개지만 두 케이스(동일/상이 tz)를 동시에 요구해 special-case 통과가 어렵다 — "항상 변환"으로는 케이스1이, "변환 안 함"으로는 케이스2가 깨진다. 즉 단락 조건과 출발 파라미터화 **둘 다** 있어야만 통과하므로 overfit-risk는 낮은 편(그래서 플래그에서 overfit-risk 제외).
- **regression 관점**: P2P 73개 중 `NewDatabaseTests`의 datetime 경로(예: `test_query_datetime_lookups`, `test_aware_datetime_in_other_timezone`, `test_query_datetimes_in_other_timezone`)가 동일 빌더/콜백을 탄다. SQLite arity나 빌더 placeholder를 하나라도 어긋나게 두면 이들이 인자 개수 불일치로 무더기 실패 → regression-trap.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `WHERE DATE(CONVERT_TZ(..., 'UTC', 'Europe/Paris'))`와 `mysql/operations.py`의 'UTC' 강제 라인을 직접 인용 → `_convert_field_to_tz`로 즉시 진입. 단, 제목이 "MySQL, SQLite, and Oracle"을 명시하고 FAIL_TO_PASS가 SQLite에서 도는 점을 보고 **세 백엔드 모두**가 같은 'UTC' 하드코딩을 공유함을 확인(`grep "'UTC'"`/`'0:00'`/`_convert_field_to_tz`/`_convert_tzname_to_sql`). SSOT는 `connection.timezone_name`.
2. **픽스와 올바른 일반화 이유**: 'UTC' 상수를 `self.connection.timezone_name`으로 치환(출발 타임존을 설정에서 읽도록)하고 `connection.timezone_name != tzname` 단락을 추가. 이게 overfit이 아니라 올바른 일반화인 이유 — 이슈 본문이 인용한 doc 계약("USE_TZ면 DB가 tz 미지원 시 이 옵션의 로컬 타임으로 읽고/쓰기")을 코드로 충실히 구현한 것이고, 미설정 시 `timezone_name`이 UTC로 떨어져 **기존 동작과 byte-호환**(legacy 경로 불변)이기 때문. 두 케이스(동일/상이 tz)를 양방향으로 만족시킨다.
3. **regression 안전**: `USE_TZ=False` 경로(`_convert_tznames_to_sql`가 `'NULL','NULL'`, MySQL/Oracle 가드 false)는 그대로 둬 `LegacyDatabaseTests` 전부 불변. `NewDatabaseTests`의 datetime lookup P2P들이 안 깨지려면 SQLite의 **빌더 placeholder 수 = 콜백 시그니처 인자 수 = `create_function` arity** 세 곳을 정확히 동시에 +1 해야 한다. 미설정 DB의 `timezone_name`==UTC라 변환 결과가 종전과 같아 `..._in_other_timezone` 류도 안전.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) **MySQL 한 줄만 고치고 종료**: 이슈가 MySQL을 전면에 내세우지만 테스트는 SQLite로 돌아 FAIL_TO_PASS가 안 풀린다(반드시 SQLite까지). (b) **SQLite arity 비일관**: 빌더만 고치고 `create_function`/콜백 시그니처를 안 맞추면 `_sqlite_datetime_*` 호출이 TypeError로 P2P 대량 회귀. (c) **단락 조건 누락**: `!= tzname` 없이 출발만 파라미터화하면 케이스1(동일 tz)에서 불필요 변환으로 실패(MySQL은 tz 테이블 없으면 NULL). (d) **Oracle FROM_TZ '0:00' 간과**: Oracle은 'UTC' 문자열이 아니라 `'0:00'` offset 리터럴이라 단순 grep "'UTC'"로는 안 잡힘 — 세 백엔드 각각의 관용구를 의미 기준으로 추적해야 함.
