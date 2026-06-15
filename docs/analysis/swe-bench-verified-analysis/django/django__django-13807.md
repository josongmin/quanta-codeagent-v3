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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13807

## 문제 요약
테이블/컬럼 이름이 SQL 예약어(예: `order`, `select`, `where`)인 모델을 SQLite에서 `loaddata`로 로드하면 크래시한다. `check_constraints`가 `PRAGMA foreign_key_check(order)` 같은 SQL을 식별자 인용 없이 문자열 보간으로 만들어서 `sqlite3.OperationalError: near "order": syntax error`가 난다. 기대 동작은 예약어 식별자도 정상적으로 인용되어 제약 검사가 SQL 문법상 성립하는 것. problem_statement에 네이티브 스택트레이스 + 파일/라인/함수 + 근본원인("missing back ticks around %s")까지 모두 적혀 있다.

## 유형 (정형화)
- **L0 (Pinpointed)** — 이슈가 파일·라인·함수·심볼을 직접 지목한다: `django/db/backends/sqlite3/base.py` line 327, `check_constraints`, `PRAGMA foreign_key_check(%s)`. `'PRAGMA foreign_key_check'` grep 한 방이면 진입 끝. 탐색 노력 사실상 0.
- **S1 (Direct-Map / template)** — 결함 클래스가 정형(식별자 인용 누락)이고, 이슈가 픽스를 사실상 명세한다(hints에 "wrap table_name in connection.ops.quote_name"이 명시). 추론으로 식·조건을 합성할 게 없다. `% table_name` → `% self.ops.quote_name(table_name)` 기계적 치환. 식별자가 보간되는 모든 자리를 동일 변환으로 감싸는 템플릿 매칭(PAR/TBar 계열의 "wrap-in-sanitizer" 패턴).
- **K-Domain (Domain-bound)** — 일반 파이썬 지식으론 부족하다. 올바른 인용 도구가 `self.ops.quote_name`(DatabaseOperations의 backend별 식별자 quoting 계약)이라는 django DB-backend 내부 지식이 병목. "백틱을 직접 붙인다"는 순진한 접근(hints에서 기여자가 실제로 제안)은 SQLite quoting 규약상 틀렸고, backend-agnostic한 `quote_name`을 써야 한다는 걸 알아야 한다.
- **primary type = T-DirectMap** — 위치가 L0로 자명하고 픽스가 S1 기계적이다. T-LocTrivial이 아닌 이유는 K-Gen이 아니라 K-Domain(올바른 인용 API가 무엇인지)이 살짝 걸리고, 같은 함수 내 인용 누락 지점이 4군데로 분산돼 "체크 하나 추가"보다 손이 더 가기 때문이다. 그래도 dominant 신호는 "위치 명확 + 기계적 가드/sanitize"이므로 T-DirectMap.

왜 S2/S5가 아닌가: 올바른 조건식을 불변식 추론으로 합성할 게 없고(S2 아님), 의도가 코드·이슈로 완전히 결정돼 스펙 재구성이 불필요하다(S5 아님). 이슈가 픽스 함수명까지 지정하므로 generate-&-validate 반복도 불필요(S3/S4 아님).

## 난이도 티어
**T2 (쉬움).** 공식 라벨 `<15 min fix`와 일치 — prior를 그대로 채택.

이 티어로 미는 구조적 피처:
- **1파일·작은 헌크**: gold patch는 `sqlite3/base.py` 단일 파일, `check_constraints` 단일 함수, 인용 추가만(로직/쿼리 구조 불변). 1파일·소규모 = 고-solve 구간.
- **has-repro**: 네이티브 `sqlite3.OperationalError` 스택트레이스 + 라인번호 동반 → 가장 강한 easiness 신호(repro 있으면 해결률 ~87%).
- **localize 직접성 L0**: 파일/함수/심볼 직접 지목이라 localization 실패(전체 실패의 ~51%) 리스크가 거의 0.

T1로 안 내려가는 이유: (a) 인용 누락 지점이 한 곳이 아니라 같은 함수 내 4개 식별자(테이블 2회 + pk컬럼 + fk컬럼)라, "첫 PRAGMA만 고치면 끝"이 아니다 — 조기 종료 시 테스트가 컬럼 인용 누락으로 재실패한다. (b) 올바른 도구가 `self.ops.quote_name`이라는 K-Domain 의존이 K-Gen 순수 추론을 넘어선다. T3 이상으로 안 올라가는 이유: 실질 추론(S2)도, 약한 localize(L1+)도, refactor(S6)도 없다. 따라서 T2가 정확.

(공식 difficulty 라벨과 tier 불일치 없음.)

## 골드패치 분석
- **건드린 파일·함수**: `django/db/backends/sqlite3/base.py` → `DatabaseWrapper.check_constraints`
- **근본 원인**: 함수가 식별자(테이블명/컬럼명)를 `'PRAGMA foreign_key_check(%s)' % table_name`처럼 raw 문자열 보간으로 SQL에 끼워넣는다. 이름이 예약어이거나 특수문자를 포함하면 SQL 파서가 식별자로 인식하지 못해 syntax error. SQLite 식별자는 인용해야 안전하다.
- **수정 요지**: 보간되는 모든 식별자를 `self.ops.quote_name(...)`로 감싼다. 정확히 3개 SQL의 4개 보간 자리:
  1. `'PRAGMA foreign_key_check(%s)' % table_name` → `% self.ops.quote_name(table_name)`
  2. `'PRAGMA foreign_key_list(%s)' % table_name` → `% self.ops.quote_name(table_name)`
  3. 위반 행 조회 `'SELECT %s, %s FROM %s WHERE rowid = %%s'`의 `primary_key_column_name`, `column_name`, `table_name` 세 식별자를 각각 `self.ops.quote_name(...)`로 인용.

  쿼리 구조·로직은 불변이고, `%%s` rowid 파라미터(값 바인딩, `(rowid,)`)는 식별자가 아니므로 그대로 둔다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_check_constraints_sql_keywords (backends.tests.FkConstraintsTests)`
- **동작**: 테스트는 새 모델 `SQLKeywordsModel`을 추가하고 식별자를 전부 예약어로 깐다 — `db_table = 'order'`, `id`의 `db_column='select'`, FK `reporter`의 `db_column='where'`. 객체를 만들고 `connection.constraint_checks_disabled()` 안에서 `reporter_id = 30`(존재하지 않는 FK)으로 저장한 뒤 `connection.check_constraints(table_names=['order'])`를 호출한다.
- **픽스 증명**: 픽스 전엔 `PRAGMA foreign_key_check(order)`가 인용 누락으로 `OperationalError: near "order": syntax error`. 픽스 후엔 식별자가 인용되어 SQL이 성립하고, FK 위반이 정상 감지되어 기대대로 `assertRaises(IntegrityError)`를 만족한다. 즉 예약어 식별자에서도 제약 검사 SQL 전 경로가 문법적으로 성립함을 증명.
- **overfit 관점**: 테스트가 테이블명(`order`)뿐 아니라 컬럼명(`select`/`where`)까지 예약어로 깔아, gold patch의 4개 인용 자리 중 테이블 2곳 + pk/fk 컬럼 2곳을 모두 강제로 친다. 따라서 "첫 PRAGMA만 인용"하는 부분 픽스는 컬럼 인용 누락에서 `SELECT select, where FROM order ...`가 다시 터져 실패 — 테스트가 부분 픽스를 걸러낸다. FAIL_TO_PASS가 1개뿐이라 얇아 보이지만, 입력 설계가 모든 인용 경로를 커버해 S1으로선 overfit 여지가 낮다(그래서 `overfit-risk` 플래그는 미부여).
- **regression 관점**: PASS_TO_PASS 38개 중 `test_check_constraints`, `test_disable_constraint_checks_*`, `test_integrity_checks_on_*` 등 동일 `check_constraints` 경로를 일반 식별자로 타는 인접 테스트가 다수다. `quote_name`이 일반 식별자도 무해하게 인용하므로 이 동작들이 깨지지 않아야 한다 → `regression-trap` 플래그.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 스택트레이스가 `sqlite3/base.py` line 411 → 호출원 `check_constraints` line 327을 직접 가리키고, 본문이 근본원인("missing back ticks around %s in `PRAGMA foreign_key_check(%s)`")까지 적었다. `grep "PRAGMA foreign_key_check"` 또는 함수명 `check_constraints`로 즉시 진입. (L0)
2. **픽스와 일반화 근거**: 보간되는 **모든** 식별자를 `self.ops.quote_name(...)`로 감싼다. 백틱을 손으로 붙이지 않는 이유 — quoting 규약은 backend별이고 `quote_name`이 그 계약을 캡슐화하므로 올바른 일반화다(특정 예약어 화이트리스트나 `order`만 특수처리하면 overfit/CEGIS 함정). 한 자리가 아니라 같은 함수 내 4개 보간 자리를 모두 동일 변환으로 처리해야 결함 클래스(임의 예약어/특수문자 식별자) 전체를 닫는다.
3. **regression 안전**: PASS_TO_PASS의 `test_check_constraints`, `test_disable_constraint_checks_*`, `test_integrity_checks_on_creation/update` 등 일반 식별자로 `check_constraints`를 타는 38개를 깨면 안 된다. `quote_name`은 정상 식별자도 무해하게 인용(예: `order` → `"order"`)하므로 안전. 또한 `%%s` rowid 값 바인딩을 식별자 인용으로 잘못 건드리면 파라미터 escaping(`test_parameter_escaping`)이 깨지므로 손대지 않는다.
4. **함정 회피**: 오라클 없는 에이전트의 전형적 실패 두 가지 — (a) **부분 픽스**: 이슈가 강조한 `foreign_key_check` 한 줄만 고치고 종료하면, 같은 함수의 `foreign_key_list`와 `SELECT %s, %s FROM %s` 컬럼/테이블 인용 누락에서 재크래시. 테스트가 컬럼명까지 예약어라 부분 픽스를 잡아낸다 → 함수 전체의 raw 보간 자리를 전수 스캔할 것. (b) **잘못된 도구**: hints에서 실제 기여자가 제안한 "백틱 직접 추가"는 backend-비일반적이라 오답. `self.ops.quote_name`을 써야 한다(K-Domain).
