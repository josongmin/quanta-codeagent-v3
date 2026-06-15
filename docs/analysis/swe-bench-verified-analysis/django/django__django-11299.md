---
instance_id: django__django-11299
repo: django/django
base_commit: 6866c91b638de5368c18713fa851bfe56253ea55
version: 3.0
difficulty: <15 min fix
created_at: 2019-04-28T11:15:08Z
fail_to_pass: 1
pass_to_pass: 103
gold_files: [django/db/models/sql/query.py]
---

# django__django-11299

## 문제 요약
`CheckConstraint`의 check가 OR와 AND가 섞인 `Q` 객체일 때(`Q(a, b) | Q(c)`), 생성되는 CHECK SQL에 컬럼이 테이블 한정 형태(`"my_table"."my_field"`)로 들어간다. SQLite/Oracle에서 마이그레이션은 임시 테이블을 만든 뒤 원본을 drop하고 이름을 바꿔치기하는데, 이때 CHECK 안에 박힌 옛 테이블명(`new__app_testconstraint.field_1`) 때문에 "no such column" 스키마 오류로 실패한다. 기대 동작은 컬럼이 한정자 없이 `"field_1"`처럼 단순 형태(SimpleCol)로 렌더링되어 테이블 rename에도 깨지지 않는 것이다.

## 유형 분류
- 버그 카테고리: logic / edge-case (AND+OR 혼합 분기에서 플래그 전파 누락)
- 서브시스템: django ORM query 빌더 (sql/query.py의 `_add_q` / `build_where`)
- 증상 타입: 잘못된 SQL 생성 → 마이그레이션 실행 시 크래시(malformed schema)
- 로컬라이제이션 신호: problem_statement이 "AND clause는 `Col`, OR clause는 `SimpleCol`을 쓴다"고 직접 진단. 즉 `simple_col` 플래그가 재귀 분기 중 한쪽으로만 전달되고 nested `Q`(Node) 가지로는 누락되는 지점을 찾으면 됨.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/sql/query.py` : `Query._add_q`
- 근본 원인: `build_where`는 `simple_col=True`로 `_add_q`를 호출해 한정자 없는 `SimpleCol`을 쓰게 한다. 그런데 `_add_q`가 자식을 순회하다 자식이 또 `Node`(중첩 `Q`)인 경우 재귀 호출에서 `simple_col` 인자를 넘기지 않아 기본값 `False`로 떨어졌다. 그 결과 중첩 가지의 컬럼만 테이블 한정 `Col`로 렌더링되어 SQL이 비대칭으로 깨졌다.
- 수정 요지: `_add_q`의 자식이 `Node`일 때의 재귀 호출 끝에 `simple_col` 인자 하나를 추가로 전달(`self._add_q(child, ..., split_subq, simple_col)`). 단 한 줄. 이로써 모든 깊이의 가지가 동일하게 `SimpleCol`/`Col` 정책을 상속받아 일관된 컬럼 형태로 렌더링된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_simplecol_query (queries.test_query.TestQuery)`
- 증명 방식: `build_where(Q(num__gt=2, name__isnull=False) | Q(num__lt=F('id')))`를 호출해 AND+OR 혼합 트리를 만든 뒤, 각 lookup의 lhs/rhs가 `SimpleCol` 인스턴스인지 단언한다(`num_gt_lookup.lhs`, `name_isnull_lookup.lhs`, `num_lt_lookup.lhs/rhs`). 패치 전에는 중첩 AND 가지(`children[0]`)가 `Col`로 떨어져 단언이 실패한다.
- 추가로 `test_add_or_constraint`(migrations.test_operations)가 실제 `CheckConstraint(check=Q(...)|Q(...))`로 마이그레이션을 돌려 IntegrityError가 정상 발생하는지(즉 제약이 올바른 컬럼명으로 적용되는지)로 end-to-end 회귀를 막는다.

## 공략 포인트 (뭘 조져야)
- 어디부터: `build_where` → `_add_q`의 시그니처와 `simple_col` 파라미터 흐름을 따라간다. problem_statement이 `Col` vs `SimpleCol`을 명시하므로 두 클래스를 grep해 어디서 분기되는지가 첫 단서.
- 함정/난이도: `_add_q`는 자식 분기가 두 갈래(자식이 `Node`면 재귀 `_add_q`, 아니면 `build_filter`)다. `build_filter` 쪽은 이미 `simple_col`을 받지만 재귀 쪽만 누락. 한 갈래만 보고 "정상 전달됨"이라 오판하기 쉬움. 멀티파일 아님(프로덕션 변경은 1파일 1줄).
- 우리 에이전트 관점: 1줄 픽스라 코드량은 작지만, 인자 전파 누락은 정적으로 눈에 안 띈다. AND+OR 혼합이라는 재현 조건을 만들어 실제 SQL/트리를 관찰하지 않으면 root cause를 못 짚을 위험. 증상(마이그레이션 크래시)과 원인(query 빌더 재귀 인자)이 멀리 떨어져 있어 로컬라이제이션이 핵심 난관.
