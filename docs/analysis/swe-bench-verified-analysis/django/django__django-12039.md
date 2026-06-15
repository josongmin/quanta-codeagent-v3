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
---

# django__django-12039

## 문제 요약
`Index`로 인덱스를 만들 때 생성되는 `CREATE INDEX` SQL의 공백 처리가 부정확하다. 내림차순(`fields=['-name']`)에서는 `("name"DESC)`처럼 컬럼명과 `DESC` 사이에 공백이 없고, opclasses를 명시적 정렬 없이 쓰면(`opclasses=['text_pattern_ops']`) `("name" text_pattern_ops )`처럼 끝에 불필요한 공백이 붙는다. 사용자는 `("name" DESC)` / `("name" text_pattern_ops)`처럼 정상 공백을 기대한다. 에러는 아니지만 비표준 문법이라 향후 DB 버전에서 깨질 수 있다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (빈 문자열 suffix 처리 누락)
- 서브시스템: django DB backends — DDL 참조/스키마 SQL 생성 (`ddl_references.Columns` / `IndexColumns`)
- 증상 타입: 잘못된 출력 (malformed-but-valid SQL 문자열)
- 로컬라이제이션 신호: problem_statement가 직접 `django.db.backends.ddl_references.Columns`와 L87을 지목하고, "col_suffixes가 오름차순일 때 비어 있을 거라 가정했지만 실제로는 빈 문자열을 담는다"라고 근본 원인까지 명시.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/db/backends/ddl_references.py` — `Columns.__str__`의 내부 `col_str`
  - `django/db/backends/ddl_references.py` — `IndexColumns.__str__`의 내부 `col_str` (opclasses 경로)
- 근본 원인: 정렬 suffix를 `self.quote_name(column) + self.col_suffixes[idx]`로 단순 문자열 연결해 왔다. 오름차순일 때 `col_suffixes`는 비어 있지 않고 빈 문자열(`''`)을 담는다. 그래서 (1) `DESC` suffix는 컬럼명에 바로 붙어 `"name"DESC`가 되고(연결 사이 공백 없음), (2) opclasses 경로에서는 빈 suffix를 `'{} {}'.format`으로 붙여 뒤에 trailing space가 남는다. #30903 fix가 "suffix가 항상 비어있다"고 잘못 가정한 것.
- 수정 요지:
  - `Columns.col_str`: 먼저 `col = self.quote_name(column)`로 시작하고, `suffix = self.col_suffixes[idx]`를 꺼내 **suffix가 truthy일 때만** `'{} {}'.format(col, suffix)`로 공백 포함 결합. `IndexError`면 그냥 컬럼만 반환.
  - `IndexColumns.col_str`: opclass를 붙인 뒤 동일하게 `suffix`를 truthy 검사로 게이팅해 빈 문자열이면 trailing space를 만들지 않음.
  - 즉 빈 문자열을 "suffix 없음"으로 취급하고, 있을 때만 단일 공백을 끼워 넣는 게 핵심.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_descending_columns_list_sql` — `Index(fields=['-headline'])`의 `create_sql` 문자열에 `(%s DESC) % quote_name('headline')`가 포함되는지 검사. 즉 `"headline" DESC`처럼 공백이 들어가야 통과.
- PASS_TO_PASS로 회귀 방어: `test_columns_list_sql`(정렬 없는 단순 컬럼), `test_ops_class_columns_lists_sql`(opclass + 오름차순 → trailing space 없음 `text_pattern_ops)`), `test_ops_class_descending_columns_list_sql`(opclass + DESC → `text_pattern_ops DESC`).
- 증명 방식: 실제 인덱스를 만들어 `str(index.create_sql(Article, editor))` 결과 SQL 문자열에 정확한 공백 패턴이 `assertIn`으로 들어있는지 확인. 입력(`-headline` / `headline`+opclass) → 기대 출력(올바른 공백 SQL).

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 파일과 라인까지 줘서 localization은 거의 공짜. `ddl_references.py`의 `Columns.__str__` / `IndexColumns.__str__` 내부 `col_str`만 보면 됨.
- 함정/난이도 메모:
  - `col_suffixes`가 빈 리스트가 아니라 **빈 문자열을 담은 리스트**라는 점이 핵심 — `except IndexError`만으로는 빈 문자열 케이스를 못 거른다. truthy 체크를 추가해야 함.
  - 두 클래스(`Columns`, `IndexColumns`)를 **모두** 고쳐야 함. 한쪽만 고치면 opclass 경로의 trailing space가 남는다 (멀티-함수, 단일 파일).
  - DESC 케이스(공백 추가)와 opclass-오름차순 케이스(공백 제거)는 정반대 증상이지만 같은 truthy-게이팅 한 줄로 둘 다 해결된다는 점을 놓치기 쉽다.
- 우리 에이전트 관점: 막힐 만한 지점은 `test_descending_columns_list_sql` 하나만 보고 DESC 공백만 고친 뒤 opclass 경로(`IndexColumns`)를 빠뜨리는 것. PASS_TO_PASS의 opclass 테스트까지 함께 봐야 양쪽 수정이 필요함을 인지할 수 있다. SQLite 등 백엔드별 quote_name 차이는 테스트가 `editor.quote_name`로 흡수하므로 신경 쓸 필요 없음.
