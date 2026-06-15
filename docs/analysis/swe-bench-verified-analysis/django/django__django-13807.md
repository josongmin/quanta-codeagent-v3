---
instance_id: django__django-13807
repo: django/django
base_commit: 89fc144dedc737a79929231438f035b1d4a993c9
version: 3.2
difficulty: <15 min fix
created_at: 2020-12-23T21:09:32Z
fail_to_pass: 1
pass_to_pass: 38
gold_files: [django/db/backends/sqlite3/base.py]
---

# django__django-13807

## 문제 요약
테이블 이름이 SQL 예약어(예: `order`)인 모델을 SQLite에서 `loaddata`로 로드하면 크래시한다. `check_constraints`가 `PRAGMA foreign_key_check(order)` 같은 SQL을 인용부호 없이 생성해서 `sqlite3.OperationalError: near "order": syntax error`가 발생한다. 사용자는 예약어 테이블/컬럼명도 정상적으로 fixture가 로드되길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (식별자 인용 누락)
- 서브시스템: django DB backend (sqlite3 base operations, 제약조건 검사)
- 증상 타입: 예외 / 크래시 (`OperationalError` syntax error)
- 로컬라이제이션 신호: problem_statement가 파일·라인·함수까지 명시 — `django/db/backends/sqlite3/base.py` line 327 `check_constraints`, 그리고 `PRAGMA foreign_key_check(%s)`에 백틱이 없다는 근본 원인까지 친절히 지목한다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/backends/sqlite3/base.py`:`DatabaseWrapper.check_constraints`
- 근본 원인: 함수가 `table_name`(및 파생 컬럼명들)을 `'PRAGMA foreign_key_check(%s)' % table_name`처럼 문자열 보간으로 그대로 끼워넣는다. 이름이 예약어이거나 특수문자를 가지면 SQL 문법 오류가 난다.
- 수정 요지: 보간되는 모든 식별자를 `self.ops.quote_name(...)`로 감싼다. 구체적으로 (1) `PRAGMA foreign_key_check(%s)`의 `table_name`, (2) `PRAGMA foreign_key_list(%s)`의 `table_name`, (3) 위반 행 조회 `SELECT %s, %s FROM %s WHERE rowid = %%s`의 `primary_key_column_name` / `column_name` / `table_name` 세 식별자를 모두 `quote_name`으로 인용한다. 로직·쿼리 구조는 그대로이고 인용만 추가됐다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_check_constraints_sql_keywords (backends.tests.FkConstraintsTests)`
- 테스트 모델 `SQLKeywordsModel`을 새로 추가하는데, `db_table = 'order'`(예약어 테이블명), `id`의 `db_column='select'`, FK `reporter`의 `db_column='where'`로 컬럼명까지 전부 예약어로 깐다. 테스트는 객체를 만들고 `constraint_checks_disabled()` 안에서 `reporter_id = 30`(존재하지 않는 FK)으로 저장한 뒤 `connection.check_constraints(table_names=['order'])`를 호출한다. 픽스 전엔 인용 누락으로 `OperationalError` syntax error가 났지만, 픽스 후엔 정상적으로 FK 위반을 감지해 기대대로 `IntegrityError`가 발생한다. 즉 예약어 식별자에서도 제약 검사 SQL이 문법적으로 성립함을 증명한다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일/라인/함수를 직접 지목하므로 `check_constraints` 안의 `PRAGMA foreign_key_check` 문자열을 grep해서 바로 진입. localization은 사실상 공짜다.
- 함정/난이도: 한 줄짜리로 보이지만 인용해야 할 식별자가 4종(테이블 2회 + pk컬럼 + fk컬럼)이라 `foreign_key_check` 한 군데만 고치면 `foreign_key_list`와 `SELECT` 구문에서 다시 터진다 — 같은 함수 내 세 SQL을 모두 손봐야 완전. `% table_name`을 `quote_name`으로 바꾸되 `%%s` rowid 파라미터 바인딩은 건드리면 안 됨.
- 우리 에이전트 관점: 픽스 자체는 쉽지만 "첫 PRAGMA만 고치고 끝"이라고 조기 종료하면 테스트(컬럼명도 예약어)가 컬럼 인용 누락으로 실패한다. 회귀 테스트 작성 시 테이블명뿐 아니라 컬럼명까지 예약어로 깔아야 모든 경로를 커버한다는 점을 놓치기 쉽다.
