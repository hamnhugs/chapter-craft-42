import { describe, it, expect } from "vitest";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";

/**
 * A budget, not a limit — and deliberately a failing test rather than a lint.
 *
 * Tool-selection accuracy is measured to degrade once a roster passes roughly
 * 30-50 tools (Anthropic's tool-search documentation states the threshold
 * outright; RAG-MCP, arXiv:2505.03275, measures selection collapsing as a pool
 * grows past ~100). This app is already past that, which is a genuine second
 * cause of "the AI won't use its tools" — independent of every gate.
 *
 * Deleting tools is NOT the fix: the chance-corrected end-to-end measurement
 * (arXiv:2605.24660) found adaptive shortlisting LOST to a fixed roster,
 * 71.7% against 73.3%, because presentation rate fell faster than selection
 * accuracy rose. And the vendor answer — keeping every tool in the request
 * with deferred loading plus a searchable catalog — is not available on
 * OpenRouter, Gemini or NVIDIA's OpenAI-compatible surfaces.
 *
 * So the honest control is this: growth must be a decision somebody makes on
 * purpose. Adding a tool means editing the number below and accepting that
 * every other tool got slightly harder to select. The two levers that DO work
 * without a provider feature are consolidating sibling tools into one verb and
 * rewriting descriptions — both of which are cheaper to reach for when the
 * build makes the cost visible.
 *
 * Self-built Foundry tools deliberately do NOT count: they are reached through
 * run_tool and never enter the roster, which is why the library can grow
 * without making everything else worse.
 */
// +5: the Program Foundry verbs (forge_program, run_program, list_programs,
// read_program, delete_program). A program is the VPS-executed sibling of a
// Foundry tool — a categorically new capability, not a sibling of an existing
// verb — so it earns roster slots the same way the Tool Foundry's did, and the
// same deliberate speed bump applies: every other tool got slightly harder to
// select, which the description quality of these five has to earn back.
//
// +2 (Card Catalog Stage 2): search_book_text and read_span — the two reading
// primitives the MEASURED E2 quote gap demands (catalog mode lost exact-quote
// retrieval 6/11 vs 8/11, every loss a deep-sentence seek a 5-round budget
// couldn't make; docs/stage2-card-pointers.md). Neither is a sibling of an
// existing verb: one finds exact wording, one dereferences a memory card's
// verified pointers. The cost is accepted against a hard check: the frozen E2
// set is rerun with these on the roster, and if the quote criteria still
// fail, they haven't earned their slots and the catalog default stays held.
//
// +4 (the library agent, docs/library-agent.md §2): set_loaded_books,
// manage_shelf, save_to_library, delete_book. The user asked for hands-free
// control of the library — loading shelves into the chat, making and filling
// shelves, saving what the assistant wrote as a book, deleting books — and
// none of it existed as a verb. Consolidation was applied first: no
// list_shelves (list_books grew a shelves array), one action-enum shelf verb
// instead of five siblings (sibling expansion is measured at −8 to −19 points
// of call accuracy; merging semantically overlapping tools at +5 to +22 —
// the research digest in docs/library-agent-research.md), and set_active_book
// kept as a READER verb rather than a second load verb. Four slots is the
// floor for four distinct objects (conversation focus · shelf · document ·
// book), each with a description written as documentation.
//
// +1 (the book Trash): restore_book. delete_book became a MOVE to the Trash
// rather than a permanent delete, which is only half a feature — an action
// the user can undo in the Vault but not by voice is not undoable in the
// conversation where they regretted it. It could not fold into delete_book
// as an action enum without the verb's own name lying about half its
// behaviour, and it is the cheapest kind of slot to add: one object, one
// intent, a description that names no sibling.
const ROSTER_BUDGET = 80;

describe("the tool roster stays within its stated budget", () => {
  it(`ships at most ${ROSTER_BUDGET} tools`, () => {
    expect(CHAT_TOOL_DEFINITIONS.length).toBeLessThanOrEqual(ROSTER_BUDGET);
  });

  it("every tool has a name and a description the model can act on", () => {
    for (const def of CHAT_TOOL_DEFINITIONS as ReadonlyArray<any>) {
      const fn = def?.function;
      expect(fn?.name, JSON.stringify(def).slice(0, 80)).toMatch(/^[a-z][a-z0-9_]*$/);
      // Short blurbs are the measured cheap lever on call rate; a stub is a
      // tool the model will not reach for.
      expect(String(fn?.description || "").length, fn?.name).toBeGreaterThan(40);
    }
  });

  it("no two tools share a name", () => {
    const names = (CHAT_TOOL_DEFINITIONS as ReadonlyArray<any>).map((d) => d.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
