---
instance_id: django__django-12039
repo: django/django
base_commit: 58c1acb1d6054dfec29d0f30b1033bae6ef62aec
version: "3.1"
difficulty: 15 min - 1 hour
created_at: 2019-11-06T21:14:34Z
fail_to_pass: 1
pass_to_pass: 11
gold_files: [django/db/backends/ddl_references.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-12039

## 문제 요약
`Index`로 인덱스를 만들 때 생성되는 `CREATE INDEX` SQL의 공백 처리가 부정확하다. 내림차순(`fields=['-name']`)에서는 `("name"DESC)`처럼 컬럼명과 `DESC` 사이에 공백이 없고, opclasses를 명시적 정렬 없이 쓰면(`opclasses=['text_pattern_ops']`) `("name" text_pattern_ops )`처럼 끝에 불필요한 공백이 붙는다. 사용자는 `("name" DESC)` / `("name" text_pattern_ops)`처럼 정상 공백을 기대한다. 에러는 아니지만(valid SQL) 비표준 문법이라 향후 DB 버전에서 깨질 수 있다는 게 수리 동기. problem_statement가 근본 원인(`col_suffixes`가 오름차순일 때 빈 문자열을 담음)까지 직접 명시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 파일·라인을 직접 지목한다 — `django.db.backends.ddl_references.Columns`와 `ddl_references.py#L87`을 본문에 박아주고, "`col_suffixes`가 오름차순일 때 빈 리스트가 아니라 빈 문자열을 담는다"라는 인과까지 적어준다. grep 한 방, 탐색 노력 사실상 0.
- **S (Repair Strategy) = S1 Direct-Map (+S2 Constraint-Reasoning)**: 픽스 형태가 정형 결함클래스(empty-string/falsy 가드 누락)에 템플릿 매칭된다 — "suffix가 truthy일 때만 공백 끼워 결합"은 None/빈값 가드 추가의 기계적 변형이라 dominant는 S1. 다만 *순수* 템플릿이 아닌 이유는, DESC 케이스(공백 누락)와 opclass-오름차순 케이스(trailing space)가 **정반대 증상**인데 둘이 같은 한 줄 truthy-게이팅으로 동시 해결됨을 추론해야 하고, 빈 문자열을 "suffix 없음"으로 의미 재해석하는 작은 판단이 필요하다 — 그래서 보조 S2.
- **K (Knowledge) = K-Domain**: django schema-editor/DDL 생성 파이프라인 내부 지식이 병목. `Index.create_sql` → `IndexColumns`/`Columns.__str__` → `col_suffixes`의 의미(오름차순=`''`, 내림차순=`'DESC'`)를 알아야 픽스가 옳은지 판정 가능. 일반 파이썬 추론만으로는 "빈 문자열이 들어온다"를 모름.
- **Primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 가드 추가(S1)이므로 루브릭상 "위치 명확 + S1 기계적 픽스"인 T-DirectMap이 정확히 부합. T-LocTrivial이 아닌 이유는 픽스가 완전 자명하진 않고(이중 사이트 + falsy 의미 재해석) K-Domain 의존이 있기 때문. T-ConstraintReason은 S2가 dominant일 때라 보조에 그치는 본 건엔 과대평가.
- **APR 관점 근거**: 이 결함은 PAR/TBar류 fix-pattern("missing-null/empty guard")에 직접 매핑된다. 이슈가 사실상 픽스를 명세(suffix 비었을 때 붙이지 마라)하므로 generate-&-validate로 후보를 탐색할 필요가 없고, 의미 합성(SemFix류)도 최소 — 그래서 S3/S4가 아니라 S1이 dominant.

## 난이도 티어
**Tier = T2 (쉬움)**.
- 이 티어로 미는 구조적 피처: (1) **gold patch = 1파일**(`ddl_references.py`)에 2헌크/작은 변경 — 파일수·줄수 컷에서 가장 쉬운 구간(1파일·소규모 ≈ 높은 solve). (2) **L0 직접 localize** — problem_statement가 파일·라인·근본원인을 다 줘서 탐색 노력 거의 없음. (3) **has-repro에 준함** — 재현 SQL 출력(`("name"DESC)` vs `("name" DESC)`)을 본문이 그대로 보여줌. (4) 픽스가 S1 기계적 가드.
- T1로 내리지 않는 이유: 픽스가 *한* 사이트가 아니라 `Columns.__str__`와 `IndexColumns.__str__` **두 내부 `col_str`을 모두** 고쳐야 하고(cross-file-dep 성격의 멀티사이트 조율), 빈 문자열을 falsy로 재해석하는 K-Domain 판단이 끼어 "이슈가 픽스를 거의 적어줌"의 자명함 임계를 살짝 넘는다.
- T3 이상으로 올리지 않는 이유: 실질 constraint 추론·spec inference·diffuse localize·overfit 고위험이 없다. P2P가 11개로 회귀면을 넓혀 약한 regression-trap이 있으나 모두 같은 파일 동작이라 "넓은 P2P trap"(T4 신호)에는 못 미침.
- 공식 라벨(`15 min - 1 hour`)과의 정합: 대체로 일치(T2~약한 T3 경계). 공식 라벨은 개발자 구현시간 기준인데, 본 건은 localize가 공짜라 에이전트 난이도가 라벨보다 오히려 낮을 수 있다 — 유일한 상향 요인은 "두 사이트 모두 고쳐야 함"을 놓치는 partial-fix 함정.

## 골드패치 분석
- **건드린 파일·함수**:
  - `django/db/backends/ddl_references.py` — `Columns.__str__` 내부 `col_str` (정렬 suffix 경로)
  - `django/db/backends/ddl_references.py` — `IndexColumns.__str__` 내부 `col_str` (opclasses 경로)
- **근본 원인**: 정렬 suffix를 `self.quote_name(column) + self.col_suffixes[idx]`로 **단순 문자열 연결**해 왔다. 오름차순일 때 `col_suffixes`는 빈 리스트가 아니라 빈 문자열(`''`)을 담는다. 그래서 (1) `Columns` 경로에서 `DESC` suffix가 컬럼명에 바로 붙어 `"name"DESC`(연결 사이 공백 없음)가 되고, (2) `IndexColumns`(opclasses) 경로에서는 #30903 fix가 `'{} {}'.format(col, self.col_suffixes[idx])`로 무조건 결합해 빈 suffix를 붙여 `text_pattern_ops ` 뒤에 trailing space가 남는다. #30903이 "suffix는 오름차순이면 비어있다"고 잘못 가정한 게 직접 원인.
- **수정 요지**:
  - `Columns.col_str`: 먼저 `col = self.quote_name(column)`로 시작 → `suffix = self.col_suffixes[idx]` 추출 → **`if suffix:`일 때만** `col = '{} {}'.format(col, suffix)`로 단일 공백 포함 결합. `IndexError`면 `pass`하고 `col`(컬럼만) 반환. 즉 `+` 직접연결을 truthy-게이팅된 `'{} {}'.format`으로 교체.
  - `IndexColumns.col_str`: opclass를 `col = '{} {}'.format(self.quote_name(column), self.opclasses[idx])`로 붙인 뒤, 동일하게 `suffix = self.col_suffixes[idx]`를 `if suffix:`로 게이팅 — 빈 문자열이면 결합 안 해 trailing space 제거.
  - 핵심: **빈 문자열을 "suffix 없음"으로 취급**하고, truthy일 때만 정확히 한 칸 공백을 끼워 넣는다. DESC 공백 누락과 opclass trailing space라는 정반대 두 증상이 같은 게이팅으로 동시 해결.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개, 정확)**: `test_descending_columns_list_sql (indexes.tests.SchemaIndexesTests)` — `Index(fields=['-headline'], name='whitespace_idx')`의 `str(index.create_sql(Article, editor))`에 `'(%s DESC)' % editor.quote_name('headline')`가 `assertIn`으로 포함되는지 검사. 즉 `"headline" DESC`처럼 공백이 반드시 들어가야 통과. 픽스 전엔 `"headline"DESC`라 실패 → 픽스 후 truthy-게이팅이 단일 공백을 삽입해 통과 = 픽스 증명.
- **PASS_TO_PASS 회귀 방어 (11개)**: 같은 test_patch가 추가/유지하는 `test_columns_list_sql`(정렬 없는 단순 컬럼 — trailing space 없어야), `test_index_together`/`test_index_together_single_list`, `test_create_index_ignores_opclasses`, partial-index 5종(`test_partial_index`, `test_is_null_condition`, `test_boolean_restriction_partial`, `test_integer_restriction_partial`, `test_multiple_conditions`), `test_index_name`/`test_index_name_hash`. 인접 SQL 생성 동작이 안 깨졌음을 보장.
- **overfit 관점**: FAIL_TO_PASS가 1개로 얇아 *원리상* DESC 케이스만 특수처리하는 overfit 패치(예: `if suffix == 'DESC'`)도 단일 테스트는 통과시킬 수 있어 보인다. 그러나 test_patch가 함께 넣은 opclass 테스트(`test_ops_class_columns_lists_sql` → `text_pattern_ops)`, `test_ops_class_descending_columns_list_sql` → `text_pattern_ops DESC`)와 PASS_TO_PASS의 `test_columns_list_sql`이 truthy-게이팅(일반해)을 강제 — DESC만 특수처리하면 opclass 오름차순 trailing space를 못 잡아 회귀. 따라서 overfit-risk는 존재하나 테스트가 일반화를 압박해 실질 낮음.
- **regression-trap**: P2P 11개가 인덱스 SQL 생성면을 넓게 덮어, `Columns` 한쪽만 고치고 `IndexColumns`를 빠뜨리면 opclass 경로 회귀로 잡힌다. flag `regression-trap`/`cross-file-dep`(같은 파일 2사이트 조율) 근거.

## 모범답안 (오라클 기반)
1. **Localize 경로**: problem_statement가 `django.db.backends.ddl_references.Columns`와 `#L87`, 그리고 "오름차순 `col_suffixes`가 빈 문자열을 담는다"는 근본원인까지 명시 → 곧장 `ddl_references.py`를 열어 `Columns.__str__`의 `col_str`을 확인. 추가로 #30903이 "부분 수정"이라 언급했으므로 같은 파일에서 opclasses를 다루는 `IndexColumns.__str__`도 함께 스캔 — 두 번째 사이트를 여기서 발견하는 게 분기점.
2. **픽스와 왜 올바른 일반화인가**: 양 `col_str`에서 suffix를 `if suffix:` (truthy)로 게이팅하고 truthy일 때만 `'{} {}'.format(col, suffix)`. 이게 옳은 일반화인 이유 — 결함의 진짜 불변식은 "suffix가 **의미 있는 토큰일 때만** 컬럼 뒤에 정확히 한 칸 공백을 둔다"이다. 빈 문자열은 "정렬 없음"을 뜻하므로 결합 대상에서 빠져야 한다. `if suffix == 'DESC'` 같은 값 특수화가 아니라 falsy 게이팅이라, ASC(`''`)/DESC/opclass-with-or-without-order 모든 조합을 한 규칙으로 커버 → overfit 아님.
3. **Regression 안전**: 깨지면 안 되는 P2P — `test_columns_list_sql`(정렬 없는 단순 컬럼은 `(%s)`만, 군더더기 공백 0), opclass·partial-index·index_together 계열 전부. truthy 게이팅은 suffix가 비었을 때 *기존 컬럼-only 출력*을 정확히 보존하므로 ASC/단순 경로 byte-identical, opclass 경로는 trailing space만 제거 — 인접 동작 불변.
4. **함정 회피**: 오라클 없는 에이전트의 최빈 실패는 **FAIL_TO_PASS(`test_descending_columns_list_sql`) 하나만 보고 `Columns`의 DESC 공백만 고친 뒤 `IndexColumns`(opclass 경로)를 빠뜨리는 partial fix**다. 회피법 — (a) problem_statement의 "#30903에서 부분 수정됐고 opclasses 사용 시 새 quirk(trailing space)가 생겼다"는 문장을 픽스 범위 신호로 읽어 두 번째 증상을 명시적으로 타게팅, (b) 같은 파일에서 `col_suffixes`를 소비하는 모든 `col_str`을 grep해 두 사이트를 동시 수정, (c) `if suffix == 'DESC'` 같은 값-특수화를 피하고 falsy 게이팅으로 일반화. 백엔드별 `quote_name` 차이는 테스트가 `editor.quote_name`으로 흡수하므로 신경 쓸 필요 없다.
