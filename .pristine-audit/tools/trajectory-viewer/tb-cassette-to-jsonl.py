#!/usr/bin/env python3
"""Convert TB report cassettes (result.json → agent_result.metadata.trajectory)
into the trajectory-viewer's bench-trajectory.jsonl record format.

Usage: tb-cassette-to-jsonl.py <run-dir> [<run-dir> ...] > merged.jsonl
Each result.json becomes one viewer instance (instanceId = <run-name>/<task>),
each cassette entry becomes one turn-record; exec previews ride as tool_results
on the next record so the viewer's pairResults() attaches them.

Full-prompt reconstruction: the cassette records only actions/claims, so the
system prompt + instruction turn are rebuilt exactly as brain-mode.ts composes
them — request.system from /tmp/tb-prompts.json (buildSystemPrompt render;
selftest runs get the SELF_TEST_DISCIPLINE suffix, matching the systemSource
seam) and user[0] = TERMINAL_OPERATOR_GUIDE + "# Task" + metadata.instruction
(the brain's turnText). Regenerate /tmp/tb-prompts.json with:
  bun -e 'import {buildSystemPrompt} from "./src/agent/prompt"; ...'  (see git log)
"""
import json, sys, glob, os

PROMPTS = {}
if os.path.exists("/tmp/tb-prompts.json"):
    PROMPTS = json.load(open("/tmp/tb-prompts.json"))

def _blocks(content):
    """Normalize a Message.content (string | block[]) to a block list."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content or []

def emit_debug_dump(inst, task, dbg, reward):
    """Emit viewer records from a report.debug full-history dump (the REAL
    session transcript, no reconstruction): one record per assistant message,
    request.messages = everything before it, events = its own blocks."""
    system = dbg.get("system")
    msgs = []
    for m in dbg.get("messages", []):
        if m.get("role") != "assistant":
            msgs.append(m)
            continue
        events = []
        for b in _blocks(m.get("content")):
            t = b.get("type")
            if t == "text":
                events.append({"type": "text_delta", "content": b.get("text", "")})
            elif t == "thinking":
                events.append({"type": "thinking_delta", "content": b.get("thinking", "")})
            elif t == "tool_use":
                events.append({"type": "tool_use_start", "id": b.get("id"), "name": b.get("name")})
                events.append({"type": "tool_use_end", "id": b.get("id"), "input": b.get("input")})
        print(json.dumps({
            "metadata": {"instanceId": inst, "task": task, "reward": reward, "debugDump": True},
            "request": {"system": system, "messages": list(msgs)},
            "events": events}, ensure_ascii=False))
        msgs.append(m)

def emit(run_dir):
    run_name = os.path.basename(os.path.normpath(run_dir))
    for f in sorted(glob.glob(os.path.join(run_dir, "**", "result.json"), recursive=True)):
        j = json.load(open(f))
        task = j.get("task_name")
        if not task:
            continue
        traj = ((j.get("agent_result") or {}).get("metadata") or {}).get("trajectory") or []
        if not traj:
            continue
        reward = None
        rw = os.path.join(os.path.dirname(f), "verifier", "reward.txt")
        if os.path.exists(rw):
            reward = open(rw).read().strip()
        inst = f"{run_name}/{task}"
        md = (j.get("agent_result") or {}).get("metadata") or {}
        # Debug-tier runs (QUANTA_BENCH_RECORD_TRAJECTORY=debug) carry the REAL full
        # history on report.debug — emit that verbatim and skip reconstruction.
        dbg = md.get("debug")
        if dbg and dbg.get("messages"):
            emit_debug_dump(inst, task, dbg, reward=None if reward is None else reward)
            continue
        instruction = md.get("instruction") or j.get("task_id", {}).get("path", task)
        guide = PROMPTS.get("operatorGuide", "")
        turn_text = f"{guide}\n\n# Task\n{instruction}" if guide else instruction
        system = PROMPTS.get(
            "systemSelftest" if "selftest" in run_name else "systemDefault")
        msgs = [{"role": "user", "content": turn_text}]
        pending_result = None  # (tool_use_id, preview) to attach on the next record
        tn = 0
        for e in traj:
            if pending_result:
                msgs.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": pending_result[0],
                     "content": pending_result[1]}]})
                pending_result = None
            meta = {"instanceId": inst, "task": task, "reward": reward}
            if e.get("kind") == "exec":
                tn += 1
                tid = f"t{tn}"
                rec = {"metadata": meta,
                       "request": {"system": system, "messages": list(msgs)},
                       "events": [
                           {"type": "tool_use_start", "id": tid, "name": "container_exec"},
                           {"type": "tool_use_end", "id": tid, "input": {"cmd": e.get("cmd", "")}}]}
                ok = e.get("ok"); ec = e.get("exitCode")
                pending_result = (tid, f"[ok={ok} exit={ec}]\n{e.get('preview', '')}")
                msgs.append({"role": "assistant", "content": [
                    {"type": "tool_use", "id": tid, "name": "container_exec",
                     "input": {"cmd": e.get("cmd", "")}}]})
            else:  # text claim
                rec = {"metadata": meta,
                       "request": {"system": system, "messages": list(msgs)},
                       "events": [{"type": "text_delta", "content": e.get("text", "")}]}
                msgs.append({"role": "assistant", "content": e.get("text", "")})
            print(json.dumps(rec, ensure_ascii=False))

for d in sys.argv[1:]:
    emit(d)
