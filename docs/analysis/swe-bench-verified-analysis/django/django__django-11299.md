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
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L2
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-11299

## 문제 요약
`CheckConstraint`의 check가 OR와 AND가 섞인 `Q` 객체일 때(`Q(a, b) | Q(c)`), 생성되는 CHECK SQL에 컬럼이 테이블 한정 형태(`"my_table"."my_field"`)로 들어간다. SQLite/Oracle에서 마이그레이션은 임시 테이블(`new__app_testconstraint`)을 만든 뒤 원본을 drop하고 이름을 바꿔치기하는데, 이때 CHECK 안에 박힌 옛 임시 테이블명(`new__app_testconstraint.field_1`) 때문에 rename 후 "no such column" malformed schema 오류로 마이그레이션이 실패한다. 기대 동작은 컬럼이 한정자 없이 `"field_1"` 형태(`SimpleCol`)로 렌더링되어 테이블 rename에도 깨지지 않는 것이다. problem_statement에 재현 모델/마이그레이션/실제 깨진 SQL과 기대 SQL이 모두 첨부되어 있다(has-repro).

## 유형 (정형화)
- **L (Localization) = L2 (Diffuse)** — 증상(마이그레이션 crash, malformed schema)과 근본원인(query 빌더의 재귀 인자 전파 누락)이 서브시스템 경계를 넘어 멀리 떨어져 있다. 이슈는 `Col` vs `SimpleCol`이라는 강한 단서를 주지만, 거기서 `build_where → _add_q`의 재귀 분기 중 **어느 한 갈래에서만** `simple_col`이 떨어지는 지점까지 데이터플로우를 추적해야 한다. 직접 심볼 지목(L0)이 아니라 두 클래스를 grep한 뒤 호출그래프를 따라가야 하므로 L2.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1)** — 픽스 자체는 인자 하나 추가로 기계적(S1스러움)이지만, "왜 nested `Node` 가지만 누락되는가", "`simple_col` 정책이 모든 깊이의 가지에 균일하게 상속돼야 한다"는 **불변식을 추론으로 세워야** 올바른 위치/인자를 특정할 수 있다. 단순 None가드/상수교체 템플릿이 아니라 재귀 불변식(자식이 Node든 leaf든 동일 정책 전파) 추론이 본질이라 dominant는 S2, 실제 편집의 기계성은 S1로 보조.
- **K (Knowledge) = K-Domain** — django ORM의 `Q`/`Node` 트리, `WhereNode` 빌드, `Col`/`SimpleCol`의 차이(테이블 한정 vs 비한정), `CheckConstraint`가 `build_where(simple_col=True)`를 쓰는 이유(테이블 rename 안전성)를 알아야 픽스가 옳음을 판단할 수 있다. 일반 파이썬 추론만으론 부족.
- **primary type = T-DiffuseLoc** — 편집은 1줄로 자명하지만 진짜 난점이 "어디인지 찾기"(증상↔원인 거리 + 비대칭 재귀 분기)에 있다. 픽스가 한 줄이라 T-DirectMap/T-ConstraintReason처럼 보이나, L2 localize 비용이 dominant라 T-DiffuseLoc로 분류.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 `<15 min fix`(개발자 기준 T1~T2급)지만 에이전트 난이도로 상향한다:
- **localize 직접성이 낮음(L2)** — 프로덕션 변경은 1파일 1줄이지만, 그 1줄을 짚으려면 마이그레이션 crash → schema_editor → CHECK SQL 생성 → `build_where` → `_add_q` 재귀 → `simple_col` 전파의 깊은 call-chain을 역추적해야 한다. 공식 시간라벨은 "구현시간"만 재고 이 localize 비용을 안 잡는다.
- **도메인 지식 게이트(K-Domain)** — `Col`/`SimpleCol` 의미 차이를 모르면 픽스가 옳은지 판단 불가.
- **재현조건 합성 필요** — AND+OR **혼합** 트리에서만 발생. 단순 OR나 단순 AND로는 버그가 안 나와, 비대칭 케이스를 만들어 트리를 관찰하지 않으면 root cause를 놓친다.
- **regression-trap(넓은 P2P)** — PASS_TO_PASS 103개 중 다수가 `_add_q`/`build_where`를 직접 타는 쿼리/마이그레이션 테스트(`test_complex_query`, `test_foreign_key*`, `test_negated_nullable`, 다수 `OperationTests`)라, 인자 전파를 잘못 건드리면 기존 비-simple_col 경로(일반 쿼리)가 깨진다.
하향(T3)이 아닌 이유: has-repro가 강한 easiness 신호이긴 하나, L2 + K-Domain + 넓은 regression 표면이 결합돼 G&V로 막 때려선 안 풀리고 정확한 한 지점을 추론으로 짚어야 하므로 T4 유지.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/models/sql/query.py` : `Query._add_q` (단일 헌크, 1줄)
- **근본 원인:** `CheckConstraint`는 컬럼이 테이블명에 묶이면 안 되므로 `build_where(..., simple_col=True)`로 비한정 `SimpleCol`을 쓰게 한다. `_add_q`는 자식을 순회하며 자식이 또 `Node`(중첩 `Q`)이면 **자기 자신을 재귀 호출**하고, leaf이면 `build_filter`를 호출한다. `build_filter`는 이미 `simple_col`을 인자로 받지만, **재귀 `_add_q(child, ...)` 호출에서 `simple_col` 인자를 누락**해 기본값 `False`로 떨어졌다. 그 결과 중첩 가지(예: OR의 한쪽 AND 묶음)의 컬럼만 테이블 한정 `Col`로 렌더링되어, OR/AND 혼합 시 SQL이 `("table"."field" ... OR "field" ...)`처럼 비대칭으로 깨졌다.
- **수정 요지:** 재귀 호출 인자 리스트 끝에 `simple_col` 하나 추가 — `self._add_q(child, used_aliases, branch_negated, current_negated, allow_joins, split_subq, simple_col)`. 이로써 모든 깊이의 가지가 동일한 `simple_col` 정책을 상속받아 leaf(`build_filter`)와 일관된 컬럼 형태로 렌더링된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_simplecol_query (queries.test_query.TestQuery)` — `query.build_where(Q(num__gt=2, name__isnull=False) | Q(num__lt=F('id')))`로 **AND+OR 혼합** 트리를 만든 뒤, 중첩 AND 가지(`where.children[0].children`)의 `GreaterThan.lhs`/`IsNull.lhs`와 OR 가지(`where.children[1]`)의 `LessThan.lhs`/`rhs`가 전부 `SimpleCol` 인스턴스인지 단언한다. 패치 전에는 nested 가지(`children[0]`)가 `Col`로 떨어져 `assertIsInstance(..., SimpleCol)`이 실패한다 → 픽스가 인자 전파를 복구해야만 통과.
- **픽스 증명:** 테스트가 **트리 노드 타입을 직접 관찰**하므로 SQL 문자열 우연일치가 아니라 빌더 정책 상속을 정밀하게 검증한다. 또한 test_patch에 포함된 `test_add_or_constraint`(migrations.test_operations)는 실제 `CheckConstraint(check=Q(pink__gt=2, weight__gt=2) | Q(weight__lt=0))`로 `database_forwards`를 돌려 IntegrityError가 정상 발생하는지로 end-to-end를 막는다(이 테스트는 P2P에도 등재되어 회귀 가드 역할).
- **overfit 관점:** `test_simplecol_query`는 lhs와 rhs 양쪽, AND 가지와 OR 가지 양쪽을 모두 단언해 special-case로 통과시키기 어렵다. nested 가지에 simple_col을 못 넘기면 반드시 빨개지므로 overfit-risk 낮음(플래그 미부여).
- **regression 관점:** P2P 103개에 `test_complex_query`, `test_simple_query`, `test_foreign_key*`, `test_negated_nullable` 등 `_add_q`/`build_where`의 **비-simple_col(일반 쿼리)** 경로가 광범위하게 깔려 있어, 인자를 잘못 전파하면(예: 항상 True로 강제) 일반 쿼리의 테이블 한정 `Col` 렌더링이 깨진다. 골드는 호출자가 넘긴 `simple_col` 값을 **그대로 위임**하므로 이 경로들을 보존한다 → regression-trap.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 (a) "AND clause는 `Col`, OR clause는 `SimpleCol`을 쓴다"고 직접 진단하고 (b) 깨진/기대 SQL을 나란히 첨부했다. `Col`/`SimpleCol`을 grep → 둘이 갈리는 지점이 `build_where(simple_col=True)`임을 확인 → `build_where`가 `_add_q`를 호출하고 `_add_q`가 자식 분기(Node면 재귀 `_add_q`, leaf면 `build_filter`)를 가짐을 본다. 두 갈래의 인자 시그니처를 대조하면 `build_filter`는 `simple_col`을 받는데 재귀 `_add_q`는 안 받는 **비대칭**이 즉시 드러난다.
2. **픽스와 일반화 근거:** 재귀 `_add_q` 호출에 `simple_col`을 추가. 이게 올바른 일반화인 이유 — 버그는 "OR/AND 혼합"이라는 특정 입력이 아니라 **임의 깊이의 중첩 `Q`**에서 정책이 안 내려가는 구조적 결함이다. 호출자의 `simple_col`을 leaf와 nested 가지에 **동일하게** 위임하므로 깊이 3, 4 이상 어떤 중첩에서도 일관된다. 특정 SQL 문자열을 패치하거나 CHECK 렌더 단계에서 테이블 prefix를 후처리로 떼는 식의 국소 땜질(overfit)이 아님.
3. **regression 안전:** 골드는 `simple_col` 상수를 박지 않고 **인자를 그대로 전달**한다. 따라서 일반 쿼리 경로(`simple_col=False`)는 여전히 테이블 한정 `Col`을 받아 `test_complex_query`/`test_foreign_key*`/`test_negated_nullable` 등 P2P가 보존된다. "항상 SimpleCol을 쓰게" 강제하면 JOIN/FK 쿼리에서 컬럼 모호성이 생겨 이 P2P들이 깨진다 — 반드시 위임이어야 한다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (i) `_add_q`의 **leaf 갈래(`build_filter`)만 보고** "simple_col 정상 전달됨"이라 오판하고 재귀 갈래를 놓침; (ii) 증상이 마이그레이션 crash라 schema_editor/CHECK SQL 생성 쪽을 고치려다 잘못된 레이어를 건드림; (iii) 재현을 단순 OR나 단순 AND로만 해 버그를 못 띄움(반드시 AND+OR **혼합** 트리 필요). 회피법: `Col`/`SimpleCol` 단서로 빌더 레이어를 고정하고, AND+OR 혼합 입력으로 `build_where` 결과 트리를 직접 덤프해 nested 가지만 `Col`인 비대칭을 눈으로 확인한 뒤, 인자 전파를 호출자 값 위임으로 고친다.
