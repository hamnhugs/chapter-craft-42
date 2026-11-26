import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CALENDAR_ACTIONS, CALENDAR_TOOL, CALENDAR_TOOL_DEFINITIONS, executeCalendarTool } from "@/lib/calendarTool";
import { setLink } from "@/lib/equilibriumLink";
import { computeToolGates, availableToolNames, CALENDAR_TOOL_NAME, type ToolGateInput } from "@/lib/toolAvailability";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";
import { BRANCH_PERMISSIONS } from "@/lib/toolPermissions";

// The chat manages the calendar through ONE verb that turns an action into one
// call to Equilibrium's API. These pin the three things that would hurt if
// they drifted: what goes over the wire, what stops a write, and that the
// verb is on the roster only while a calendar is linked.

const LINK = { url: "https://eq.example", key: "eq_testkey12345" };
type Call = { method: string; path: string; body: any; auth: string | null };
let calls: Call[] = [];
let answers: Record<string, { status?: number; json: unknown }> = {};

function answer(key: string, json: unknown, status = 200) {
  answers[key] = { status, json };
}

beforeEach(() => {
  calls = [];
  answers = {};
  localStorage.clear();
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const path = String(url).replace(`${LINK.url}/api/v1`, "");
    const method = init.method || "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization ?? null });
    const a = answers[`${method} ${path}`] ?? answers[`${method} ${path.split("?")[0]}`] ?? { json: { health: 70, label: "Steady" } };
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLink(null);
});

const TASK = { id: "t1", title: "Write chapter", status: "pending", date: "2026-11-26", estimated_minutes: 45, spent_minutes: 0, priority: "high", block_id: "b1", recovery: null, miss_reason: null, category: 10, goal_id: null };
const TODAY = {
  date: "2026-11-26", weekday: "Thursday", today: "2026-11-26", time_now: "14:05",
  blocks: [{ id: "b1", title: "Deep work", kind: "work", category: 10, mantra: null, start: 840, end: 930, start_time: "14:00", end_time: "15:30", skipped: false, moved: false, tasks: [TASK] }],
  loose_tasks: [], running: null, whats_important_now: { task: TASK, why: "It is the top task of the block that is running." },
  behind: [], health: { health: 72, label: "Steady" }, nudges: [],
};

describe("the calendar tool", () => {
  it("is one registered chat tool whose enum lists every action it runs", () => {
    const def = CHAT_TOOL_DEFINITIONS.find((d: any) => d.function.name === CALENDAR_TOOL) as any;
    expect(def).toBeTruthy();
    expect(def).toBe(CALENDAR_TOOL_DEFINITIONS[0]);
    expect(def.function.parameters.properties.action.enum).toEqual([...CALENDAR_ACTIONS]);
    expect(CALENDAR_TOOL_NAME).toBe(CALENDAR_TOOL);
  });

  it("with no calendar linked it says how to link one and calls nothing", async () => {
    const out = await executeCalendarTool({ action: "today" }, {});
    expect(out.event.ok).toBe(false);
    expect((out.result as any).error).toContain("Settings → Account → Equilibrium");
    expect((out.result as any).retriable).toBe(false);
    expect(calls).toEqual([]);
  });

  it("'today' sends the linked key and returns the day in spoken shape, with ids", async () => {
    setLink(LINK);
    calls = [];
    answer("GET /today", TODAY);
    const out = await executeCalendarTool({ action: "today" }, {});
    expect(calls[0]).toMatchObject({ method: "GET", path: "/today", auth: `Bearer ${LINK.key}` });
    const r = out.result as any;
    expect(r.time_now).toBe("14:05");
    expect(r.blocks[0]).toMatchObject({ id: "b1", time: "14:00–15:30", category: "Business & Career Objectives" });
    expect(r.blocks[0].tasks[0]).toMatchObject({ id: "t1", minutes: 45, status: "pending" });
    expect(r.whats_important_now.task.id).toBe("t1");
    expect(out.event).toMatchObject({ ok: true, summary: "Thursday: 1 blocks, 1 tasks" });
  });

  it("add_task maps minutes and 'tomorrow' onto the API's names", async () => {
    setLink(LINK);
    calls = [];
    answer("POST /tasks", { ...TASK, id: "t2", title: "Call the bank", date: "2026-11-27", estimated_minutes: 20 }, 201);
    const out = await executeCalendarTool({ action: "add_task", title: " Call the bank ", date: "Tomorrow", minutes: 20, priority: "high", category: 9 }, {});
    expect(calls[0]).toMatchObject({ method: "POST", path: "/tasks", body: { title: "Call the bank", date: "tomorrow", estimated_minutes: 20, priority: "high", category: 9 } });
    expect(out.event.ok).toBe(true);
    expect((out.result as any).task.id).toBe("t2");
  });

  it("update_task marks a miss with its reason and reports where recovery put it", async () => {
    setLink(LINK);
    calls = [];
    answer("PATCH /tasks/t1", { task: { ...TASK, status: "missed", recovery: { date: "2026-11-28", blockId: "r5" } }, recovery: { rolled_to: { date: "2026-11-28", blockId: "r5" }, let_go: false, overload: [] }, coach: [] });
    const out = await executeCalendarTool({ action: "update_task", task_id: "t1", status: "missed", reason: "Ran out of time" }, {});
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/tasks/t1", body: { status: "missed", reason: "Ran out of time" } });
    expect((out.result as any).rolled_to_recovery_on).toBe("2026-11-28");
  });

  it("update_task with block_id 'none' takes the task out of its block", async () => {
    setLink(LINK);
    calls = [];
    answer("PATCH /tasks/t1", { task: { ...TASK, block_id: null }, recovery: { rolled_to: null, let_go: false, overload: [] }, coach: [] });
    await executeCalendarTool({ action: "update_task", task_id: "t1", block_id: "none", date: "friday" }, {});
    expect(calls[0].body).toEqual({ date: "friday", block_id: null });
  });

  it("change_day changes one day only, by date and block in the address", async () => {
    setLink(LINK);
    calls = [];
    answer("PATCH /calendar/today/b1", { ...TODAY, blocks: [{ ...TODAY.blocks[0], start_time: "16:00", end_time: "17:30", moved: true }] });
    const out = await executeCalendarTool({ action: "change_day", block_id: "b1", start: "16:00", end: "17:30" }, {});
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/calendar/today/b1", body: { start: "16:00", end: "17:30" } });
    expect((out.result as any).blocks[0]).toMatchObject({ time: "16:00–17:30", changed_for_this_day: true });
  });

  it("add_block needs a day and both times before anything is sent", async () => {
    setLink(LINK);
    calls = [];
    const out = await executeCalendarTool({ action: "add_block", title: "Gym", day: "monday", start: "07:00" }, {});
    expect(out.event.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("deleting asks first: nothing is sent without confirm:true", async () => {
    setLink(LINK);
    calls = [];
    for (const args of [{ action: "delete_task", task_id: "t1" }, { action: "delete_block", block_id: "b1", confirm: "yes" }]) {
      const out = await executeCalendarTool(args, {});
      expect(out.event.ok).toBe(false);
      expect((out.result as any).error).toContain("confirm:true");
    }
    expect(calls).toEqual([]);
    answer("DELETE /tasks/t1", { deleted: true, task: TASK });
    const ok = await executeCalendarTool({ action: "delete_task", task_id: "t1", confirm: true }, {});
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/tasks/t1" });
    expect(ok.event.ok).toBe(true);
  });

  it("with 'Change your calendar' off it still looks but changes nothing", async () => {
    expect(Object.keys(BRANCH_PERMISSIONS)).toContain("change_calendar");
    setLink(LINK);
    calls = [];
    answer("GET /today", TODAY);
    const off = { change_calendar: false };
    expect((await executeCalendarTool({ action: "today" }, off)).event.ok).toBe(true);
    const n = calls.length;
    for (const action of ["add_task", "update_task", "delete_task", "add_block", "update_block", "delete_block", "change_day", "add_goal", "update_goal"]) {
      const out = await executeCalendarTool({ action, title: "x", task_id: "t1", block_id: "b1", goal_id: "g1", confirm: true, category: 2, status: "done", day: "monday", start: "09:00", end: "10:00" }, off);
      expect(out.event.ok, action).toBe(false);
      expect((out.result as any).retriable, action).toBe(false);
    }
    expect(calls.length).toBe(n);
  });

  it("passes Equilibrium's own refusal back, and marks a bad request as fixable", async () => {
    setLink(LINK);
    calls = [];
    answer("POST /tasks", { error: "That block is on Mondays, and 2026-11-26 is a Thursday." }, 400);
    const out = await executeCalendarTool({ action: "add_task", title: "x", block_id: "b9" }, {});
    expect(out.result).toMatchObject({ error: "That block is on Mondays, and 2026-11-26 is a Thursday.", retriable: true });
    answer("GET /today", { error: "Unknown API key." }, 401);
    const bad = await executeCalendarTool({ action: "today" }, {});
    expect((bad.result as any).retriable).toBe(false);
    expect((bad.result as any).error).toContain("link code");
  });
});

describe("the calendar tool is offered only while a calendar is linked", () => {
  const base: ToolGateInput = {
    toolNames: [CALENDAR_TOOL, "list_wikis"], leanMode: "full", permissions: {},
    forgeOptIn: false, runOptIn: false, foundryReady: false,
    forgeProgramOptIn: false, runProgramOptIn: false, programReady: false,
    providerSupportsTools: true, imageTurnDisablesTools: false,
  };
  it("unlinked: withheld, with the control that links one", () => {
    const gates = computeToolGates(base);
    expect(availableToolNames(gates)).toEqual(["list_wikis"]);
    expect(gates.get(CALENDAR_TOOL)).toMatchObject({ code: "off_calendar_unlinked", fixTarget: "settings_account" });
    expect(gates.get(CALENDAR_TOOL)!.fix).toContain("Settings → Account → Equilibrium");
  });
  it("linked: on the roster, and switching 'Change your calendar' off does not remove it", () => {
    const gates = computeToolGates({ ...base, calendarLinked: true, permissions: { change_calendar: false } });
    expect(availableToolNames(gates)).toContain(CALENDAR_TOOL);
  });
});
