# Codex Thread UI Action to Persistence Mapping

Overview router: [README.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/README.md)

관련 owner:
- [thread-ui-and-fork-surface-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/thread-ui-and-fork-surface-audit.md)
- [storage-and-db-audit.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/storage-and-db-audit.md)
- [inferred-internal-architecture.md](/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/thread-management/inferred-internal-architecture.md)

이 문서는 sidebar/context-menu action이 local state에 어떤 read/write를 일으키는 것이 가장 그럴듯한지 정리한다.

표기:
- `[FACT]`: 현재 UI observation, local DB/file snapshot, visible schema에서 직접 확인된 사실
- `[STRONG-INFERENCE]`: 직접 사실을 가장 잘 설명하는 구조 추론
- `[SOTA-INFERENCE]`: 일반적인 desktop agent/local control-plane 패턴과 현재 evidence를 합친 합리적 추론

주의:
- 이 문서는 write-path hypothesis 문서다.
- 실제 source implementation trace를 본 것이 아니므로 1:1 write guarantee를 주장하지 않는다.

---

## 1. Executive summary

1. `Copy session ID`, `Copy working directory`, `Open in Finder`는 이미 존재하는 thread metadata read path일 가능성이 높다. `[STRONG-INFERENCE]`
2. `Rename chat`, `Archive chat`는 `threads` row mutation 성격이 가장 강하다. `[FACT]` + `[STRONG-INFERENCE]`
3. `Fork into local`, `Fork into new worktree`는 child thread row + lineage edge write를 동반하는 구조가 가장 자연스럽다. `[FACT]` + `[SOTA-INFERENCE]`
4. `Pin chat`, `Mark as unread`는 현재 관측한 `threads` schema에 직접 필드가 안 보여, 별도 metadata rail일 가능성이 높다. `[FACT]` + `[SOTA-INFERENCE]`

---

## 2. Direct anchors

### 2.1 UI actions

직접 보인 action:

- `Pin chat` `[FACT]`
- `Rename chat` `[FACT]`
- `Archive chat` `[FACT]`
- `Mark as unread` `[FACT]`
- `Open in Finder` `[FACT]`
- `Copy working directory` `[FACT]`
- `Copy session ID` `[FACT]`
- `Copy deeplink` `[FACT]`
- `Fork into local` `[FACT]`
- `Fork into new worktree` `[FACT]`
- `Open in new window` `[FACT]`

### 2.2 Relevant visible fields

- `threads.id`, `cwd`, `title`, `preview`, `archived`, `archived_at`, `git_sha`, `git_branch`, `rollout_path` `[FACT]`
- `thread_spawn_edges(parent_thread_id, child_thread_id, status)` `[FACT]`
- `session_index.jsonl` rows with `id`, `thread_name`, `updated_at` `[FACT]`

### 2.3 Default title/preview behavior snapshot

최근 thread sample에서는 `title`, `first_user_message`, `preview`가 동일하거나 첫 user message에서 직접 파생된 형태로 보였다. `[FACT]`

가장 설명력 높은 해석:
- explicit rename 전에는 sidebar title/preview가 first user message bootstrap을 따를 가능성이 높다 `[STRONG-INFERENCE]`

---

## 3. Mapping table

| UI action | Directly visible basis | Most plausible primary surface | Secondary/side surfaces | Confidence |
| --- | --- | --- | --- | --- |
| `Pin chat` | action exists, but no `threads.pinned` visible | separate UI preference/metadata rail outside observed `threads` columns | possibly list-order cache or another local table/file | `[SOTA-INFERENCE]` |
| `Rename chat` | `threads.title` exists; `session_index.thread_name` exists | update `threads.title` | refresh `session_index.jsonl.thread_name`, maybe `preview` unchanged | `[STRONG-INFERENCE]` |
| `Archive chat` | `threads.archived`, `threads.archived_at` exist | update `threads.archived` and maybe `archived_at` | sidebar filtering/index refresh, archived rollout remains addressable | `[STRONG-INFERENCE]` |
| `Mark as unread` | action exists; no unread field in `threads` visible | separate read-state metadata rail | maybe inbox/read-state surface, not proven | `[SOTA-INFERENCE]` |
| `Open in Finder` | `threads.cwd` exists | read `threads.cwd` | none or minimal UI analytics/logging | `[STRONG-INFERENCE]` |
| `Copy working directory` | `threads.cwd` exists | read `threads.cwd` | clipboard side effect only | `[STRONG-INFERENCE]` |
| `Copy session ID` | `threads.id`, `session_index.id` exist | read thread/session ID | clipboard side effect only | `[STRONG-INFERENCE]` |
| `Copy deeplink` | action exists, thread is addressable | read `threads.id` plus hidden deeplink resolver metadata | maybe `thread_source` or app route state | `[SOTA-INFERENCE]` |
| `Fork into local` | `thread_spawn_edges` exists, thread rows exist | create child `threads` row + create `thread_spawn_edges` row | same `cwd`, same repo lineage, new rollout path | `[SOTA-INFERENCE]` |
| `Fork into new worktree` | distinct action from local fork; `cwd`/git fields exist | create child `threads` row + edge row | new worktree path in `cwd`, likely changed `git_branch`/`git_sha` | `[SOTA-INFERENCE]` |
| `Open in new window` | action exists, thread is addressable | no canonical thread mutation required | UI/view-state only, maybe window session metadata | `[SOTA-INFERENCE]` |

---

## 4. Action-by-action notes

## 4.1 `Rename chat`

strongest anchor:
- `threads.title` is a first-class field `[FACT]`
- `session_index.jsonl.thread_name` also exists `[FACT]`

best-fit write path:
1. mutate canonical title in `threads` `[STRONG-INFERENCE]`
2. refresh lightweight index/export row in `session_index.jsonl` `[SOTA-INFERENCE]`

## 4.2 `Archive chat`

strongest anchor:
- `threads.archived` and `archived_at` exist `[FACT]`

best-fit write path:
1. set `archived=1` and possibly `archived_at` `[STRONG-INFERENCE]`
2. hide/move row in sidebar list `[SOTA-INFERENCE]`

## 4.3 `Fork into local`

strongest anchor:
- `thread_spawn_edges` stores parent-child relationships with `open/closed` status `[FACT]`

best-fit write path:
1. allocate child thread ID `[SOTA-INFERENCE]`
2. insert child `threads` row `[SOTA-INFERENCE]`
3. insert lineage edge row `[STRONG-INFERENCE]`
4. preserve same `cwd` or repo root `[SOTA-INFERENCE]`

## 4.4 `Fork into new worktree`

strongest anchor:
- distinct action exists `[FACT]`
- `threads.cwd`, `git_branch`, `git_sha` fields exist `[FACT]`

best-fit write path:
1. perform local fork steps `[SOTA-INFERENCE]`
2. provision or bind separate git worktree `[SOTA-INFERENCE]`
3. set child `cwd` to new worktree path `[SOTA-INFERENCE]`
4. persist child lineage edge the same way or similarly to local fork `[SOTA-INFERENCE]`

## 4.5 `Pin chat` and `Mark as unread`

strongest anchor:
- actions exist `[FACT]`
- observed `threads` schema has no obvious `pinned`/`unread` field `[FACT]`

best-fit interpretation:
- these are likely stored in a separate UI metadata rail not captured in the currently inspected columns `[SOTA-INFERENCE]`

---

## 5. Runtime actions outside the menu

menu 바깥에서도 같은 thread object에 대해 아래 write가 일어나는 것이 가장 자연스럽다.

| Runtime event | Most plausible write set | Why |
| --- | --- | --- |
| new thread creation | insert `threads` row, append `session_index.jsonl`, create rollout JSONL path | current snapshot has all three rail types |
| send message / receive response | update `threads.updated_at_*`, maybe `preview`, append rollout JSONL, append logs row | `threads`, archived rollout JSONL, logs DB all exist |
| subagent spawn | create child lineage relation, maybe child thread row or sibling runtime state | `thread_spawn_edges` with open/closed status exists |
| dynamic tool injection | update `thread_dynamic_tools` rows | per-thread tool rows exist |

모두 `[STRONG-INFERENCE]` 또는 `[SOTA-INFERENCE]`.

---

## 6. Non-claims

이 문서가 주장하지 않는 것:

- every UI action writes only one surface
- `Pin chat` and `Mark as unread` exact field location
- deeplink resolver exact implementation
- every local fork and worktree fork sharing exactly one code path
- rename always mutating both SQLite and JSONL synchronously
