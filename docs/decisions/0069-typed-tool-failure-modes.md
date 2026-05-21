# ADR-0069: typed per-failure-mode tool results — discriminated `ToolFailure` 유니온 (Cursor `EditResult`/`ShellResult` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: `cursor-3.2-absorption`(on-disk audit), ToolResult absorb #1(`structured`/`deferred`), ADR-0002 §5.2(evidence 표면).

## 맥락

오늘 도구 실패는 `ToolResult{ ok:false, output:string }` → `DispatchResult{ ok:false, block, preview }` 로 평탄화된다. 모델은 실패 KIND를 알려면 `output` 문자열을 정규식으로 다시 파싱해야 한다. Cursor는 `EditResult`/`ShellResult`를 **discriminated failure union**으로 반환해 모델이 실패 종류(`file_not_found` vs `permission_denied{is_readonly}` vs `rejected{reason}` vs generic `error`)로 분기하게 하고, `model_visible_error`와 `client_visible_error`를 분리한다.

## 결정

ADDITIVE·DEFAULT-OFF 레이어로 typed failure를 추가한다.

- `src/tool/types.ts`: `export type ToolFailure` 추가 — `not_found{path?}` | `permission_denied{path?, isReadonly?}` | `rejected{reason}` | `timeout{timeoutMs?}` | `error{modelVisibleError?, clientVisibleError?}`. 리터럴 `mode`가 discriminant. v3 도구가 실제로 실패하는 방식에 맞춰 선정(read 미존재 파일·edit `old_string not found`·scripted_replace `pattern not found` → `not_found`; FsJail/권한 거부 → `permission_denied`; HITL/plan deny → `rejected`). `ToolResult`에 `failure?: ToolFailure` 추가.
- `src/agent/dispatch-types.ts`: `DispatchResult`에 `failure?: ToolFailure`(`@/tool`에서 import).
- `src/agent/dispatch.ts`: ToolResult→DispatchResult 정규화에서 `result.failure`가 있을 때만 통과(없으면 omit). `ok`/`block`/`preview` 파생 무변경.

## 근거

- **isReadonly 분리**: read-only 모드라서 거부된 호출(쓰기 허용 시 성공)과 진짜 권한 거부를 구분 — Cursor `is_readonly`. 모델이 "모드를 바꾸면 되는지" vs "포기해야 하는지" 분기 가능.
- **model-visible vs client-visible**: `error` 변종에서 모델에 안전한 텍스트와 UI/operator용 상세를 분리. 모델 컨텍스트 오염 없이 운영 디버깅 정보 보존.
- **ToolEvent 변종 아님**: `failure`는 터미널 `result`의 OPTIONAL 필드로만 — 새 이벤트 타입을 추가하면 `event.type` switch 하는 기존 호출부의 narrowing이 깨진다(deferred 흡수와 동일 회피).

## 대안

- **ToolResult.output에 prefix 태그**: 기각 — 문자열 파싱 재도입, 타입 안전 0.
- **새 `ToolFailureEvent` 변종**: 기각 — 기존 `progress|result` narrowing 회귀.
- **`ok`를 enum으로 교체**: 기각 — non-additive, 모든 기존 테스트 깨짐.

## 결과·트레이드오프

- **얻은 것**: 모델이 실패 KIND로 분기 가능. exhaustive `never` switch로 새 변종 추가 시 컴파일 강제. 10 unit green / 32 expects.
- **비용**: 도구가 `failure`를 채워야 효과 발생(현재는 seam만 추가, 도구 측 채택은 후속).

## 한계 (LIMITATIONS)

- (a) 빌트인 도구는 아직 `failure`를 채우지 않음 — seam만 wired. 채택은 점진적.
- (b) gate 단계 deny(`dispatch-helpers.ts#deny`)는 아직 `failure` 미부착(다른 트랙 소유 파일) — 후속.

## 불변식 영향

- **byte-identical default-OFF**: 도구가 `failure`를 omit하면 `DispatchResult`도 omit(`exactOptionalPropertyTypes`: `undefined` 미할당). `ok`/`output`/`block`/`preview` 의미 무변경. 기존 테스트 전부 무수정 통과.
- **ADDITIVE only**: `ok`/`output` 의미 불변 — `failure`는 `output`을 **대체하지 않고 보강**(`ok===false`일 때만 유효).
- **슬라이스 격리 유지**: `@/tool`이 discriminant 소유, `@/agent`가 import.
