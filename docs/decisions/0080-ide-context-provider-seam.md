# ADR-0080 — IDE context provider seam

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0030 (mid-turn steering — same per-turn seam location), ADR-0075 (pre-compact HITL — boundary-callback discipline), ADR-0034 (session jsonl envelope — future event slot), `src/agent/prompt.ts` `escapeReminderBoundary` (reminder-boundary defang)

## 맥락

v3 루프는 **IDE 상태를 모른다**: 사용자가 지금 무엇을 편집 중인지, 어떤 탭이 열려있는지, 무엇을 선택했는지, IDE diagnostic이 무엇을 호소하는지 — 어떤 신호도 없다. 모델은 매 턴 동일한 정적 system prompt + 누적 transcript + 트레일링 `<system-reminder>`만 본다.

미래의 VS Code extension(또는 MCP-bridged IDE host) 가 이 데이터를 제공할 수 있어야 하는데, 현재 코드베이스에는 그 신호를 받을 **seam**이 없다. 동시에 다음 안티-패턴은 **모두 거부**한다:

1. **추측/휴리스틱**: `cwd` 또는 git status로부터 "지금 보고 있을 법한 파일"을 추정 — 사용자 의도와 어긋날 위험. v3 invariants는 **휴리스틱 금지**.
2. **폴백**: provider 부재 시 "기본 IDE 상태"를 합성 — 부재 = 신호 없음 = 아무것도 렌더링 안 함. 폴백 금지.
3. **open shape**: provider가 임의 키-밸류 dict를 던지게 허용 — 호스트가 ad-hoc 데이터를 밀어넣는 통로가 된다.
4. **시스템 측 컨텍스트 위치**: IDE 상태를 `<system-reminder>` 안에 넣음 — IDE 상태는 사용자 환경의 사실이지 harness reminder가 아니므로 trust attribution이 흐려진다.

또한 **prompt-injection** 표면이 새로 생긴다: 파일 내용은 사용자 제어 가능하므로 선택 텍스트/진단 메시지/탭 경로 안에 `</system-reminder>` 가 있으면 harness reminder 블록을 종료시켜 system-attributed 명령어를 위조할 수 있다. 이미 존재하는 `escapeReminderBoundary` 헬퍼를 반드시 통과시켜야 한다.

## 결정

### D1. 닫힌 `IdeSnapshot` shape + 닫힌 `IdeContextProvider` 포트

신규 모듈 `src/agent/ide-context.ts`:

```ts
interface IdeSnapshot {
  readonly activeFile?: { readonly path: string; readonly line?: number }
  readonly openTabs?: ReadonlyArray<{ readonly path: string; readonly dirty?: boolean }>
  readonly selection?: {
    readonly path: string
    readonly range: readonly [start: number, end: number]
    readonly text: string
  }
  readonly diagnostics?: ReadonlyArray<{
    readonly path: string
    readonly severity: "error" | "warning"
    readonly line: number
    readonly message: string
  }>
}

interface IdeContextProvider {
  snapshot(signal: AbortSignal): Promise<IdeSnapshot | null>
}
```

모든 필드 optional이지만 **shape는 닫혔다**. 호스트가 ad-hoc 키를 추가할 통로 없음. `null` 반환은 "IDE 미연결" 의 닫힌 신호이며 폴백 트리거가 아니다.

### D2. `AgentConfig.ideContextProvider` — default-OFF 와이어

`src/agent/types.ts` 에 `ideContextProvider?: IdeContextProvider` 추가. 부재 ⇒ 루프는 provider를 호출하지 않고 `ideSnapshot` 변수 자체가 `undefined` ⇒ `buildTurnContext` 호출에서 키 자체가 spread 되지 않음 ⇒ 렌더링/메시지 spliing 코드는 도달되지 않음 ⇒ **byte-identical** 레거시 경로. RFC §1.2 default-OFF.

### D3. Turn-entry capture (한 번/턴, NOT per same-turn retry)

`src/agent/loop.ts runAgentInner` 의 턴 루프 진입부에서 ONCE 캡처:

```ts
let ideSnapshot: IdeSnapshot | null | undefined
if (cfg.ideContextProvider !== undefined) {
  try {
    ideSnapshot = await cfg.ideContextProvider.snapshot(cfg.signal)
  } catch (e) {
    stream.emit({ type: "error", message: `ide-context provider failed: ${e.message}` })
    ideSnapshot = null
  }
}
```

캡처 위치 선택 이유:
- Same-turn retry (백오프/PTL 압축/output-limit nudge/malformed/empty) 마다 다시 캡처하면 모델이 같은 턴 안에서 IDE 상태가 "흔들리는" 것을 보게 됨. 턴 진입 시 한 번 잡아 같은 턴의 모든 retry에 동일 스냅샷을 전달.
- AbortSignal은 턴 외부의 `cfg.signal` 을 그대로 전달 — provider가 cancellation을 honor 할 책임을 갖는다 (turn-internal signal은 없음; 압축 등은 동기적 throttle).

### D4. Provider 실패 = 경계, 폴백 아님

`provider.snapshot()` 이 reject/throw ⇒
1. `stream.emit({type:"error", message: "ide-context provider failed: …"})` 로 관측면에 surface.
2. `ideSnapshot` 을 `null` 로 강제 ⇒ 이 턴은 IDE 블록 없이 진행.

이것은 **fallback** (잃어버린 데이터를 합성) 이 아니라 **boundary** (외부 시스템 실패를 ageent runtime이 흡수). IDE bug가 턴을 abort 시키면 사용자 작업이 망가지므로, 관측면 + null로의 graceful degrade가 정답.

### D5. 렌더링: deterministic format, 사용자 측에 prepend

`renderIdeContext(snapshot: IdeSnapshot | null): string`:

```
<ide-context>
## Active file: <path>:<line?>
## Open tabs:
- <path> [dirty]
- <path>
## Selection in <path> [start:end]:
<escaped text>
## Diagnostics:
- error <path>:<line> — <message>
- warning <path>:<line> — <message>
</ide-context>
```

- `null` ⇒ `""` (empty string, caller 가 prepend 안 함).
- 모든 필드가 absent/빈 배열 ⇒ `""`.
- 섹션은 해당 필드가 있고 (배열의 경우) 비어있지 않을 때만 렌더링.
- 모든 사용자-공급 텍스트 fragment (paths, selection text, diagnostic messages, tab paths) 가 `escapeReminderBoundary` 를 통과 — `</system-reminder>` 위조 차단.

`buildTurnContext` 의 메시지 조립 부에서, 렌더링된 블록을 **마지막 user 메시지의 첫 text block 앞에 prepend** (`${ideBlock}\n${originalText}`). user 메시지가 없는 (불가능하지만 안전망) 케이스는 새 user 메시지를 append. 호출자의 `baseMessages` 배열은 mutate 안 함 (얕은 복사 + 슬롯 교체 패턴).

**왜 user 측에 prepend 인가**: IDE 상태는 *user의 환경 사실* — system reminder 안에 넣으면 (a) trust attribution이 흐려지고, (b) cached prefix 패턴이 깨지지 않더라도 모델이 "안전/honesty 레이어가 IDE를 주장한다" 고 오해할 수 있다. user side 는 자연스러운 위치이며, 트레일링 `<system-reminder>` 보다 **앞** 에 위치 (`<ide-context>` user 메시지 < `<system-reminder>` user 메시지).

### D6. Cache prefix 무변경

System prompt (cached prefix) 는 건드리지 않는다. IDE 블록은 user 메시지 본문의 per-turn dynamic 영역이라 prefix cache hit율에 영향 없음. OpenAI/Anthropic 양쪽의 자동/명시 prefix-cache 가 그대로 작동.

## 결과

### Positive

- IDE host (VS Code extension, MCP IDE bridge, 다른 surface) 가 추가 코어 변경 없이 turn-by-turn 에디터 상태를 모델에 보낼 수 있는 **단일 진입점** 확보.
- 폴백/휴리스틱 0개. provider 없음 = 신호 없음 = byte-identical default-OFF.
- Prompt-injection 표면이 기존 `escapeReminderBoundary` 와 동일 디펜스로 처리됨 (uniform defense).
- 닫힌 shape: 호스트가 ad-hoc 키를 밀어넣을 통로 없음.

### Negative / 트레이드오프

- Per-turn provider call 1회 추가 — IDE host 가 slow 하면 턴 시작이 지연됨. provider 가 `cfg.signal` 을 honor 하므로 사용자 abort 는 즉시 효과.
- 향후 file body inlining (e.g. "이 파일 전체를 컨텍스트에 넣어달라") 는 token budget 의 별도 정책이 필요 — 본 ADR 의 scope 외.
- Subagent 와의 상호작용 미배선: subagent runner 는 자체 `runAgent` 호출을 갖지만 IDE provider 를 자동으로 상속시키지 않는다 — 의도적 (subagent 는 격리된 sub-conversation 이며 IDE 컨텍스트가 자동으로 흘러가면 안 됨).

### Negative invariant (회귀 방지)

- IDE 상태를 `<system-reminder>` 안에 넣지 말 것 (trust boundary).
- Provider 부재 시 IDE 블록을 *추정*하지 말 것 (no heuristic).
- `IdeSnapshot` shape 에 임의 키를 추가하지 말 것 (closed shape).
- Same-turn retry 마다 다시 `snapshot()` 호출하지 말 것 (한 턴 = 한 스냅샷).

## Test coverage

- `tests/unit/agent/ide-context-render.test.ts` (15 tests): null/empty/individual fields/all fields together/`<system-reminder>` 위조 방어 (selection text/diagnostic message/path/SHOUTED case).
- `tests/integration/ide-context-provider-wire.test.ts` (6 tests): default-OFF byte-identical, provider snapshot ⇒ user 메시지 prepend, 시스템 리마인더 tail 보다 앞에 위치, system-reminder 안에는 IDE 블록 없음, null snapshot 무렌더, provider throw ⇒ error event + 턴 진행.
