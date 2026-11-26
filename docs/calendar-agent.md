# Chat manages the calendar

2026-11-26 · branch `new1`

The calendar is Equilibrium, Manny's separate calendar app (`~/Work/program-launchpad`). Bookworm
Studio was already linked to it so the worm could wear its health number. The same link now gives
Chat one tool, `calendar`, that looks at the calendar and changes it.

## What Chat can do

| Ask | Action | Notes |
| --- | --- | --- |
| "What's on today?", "What should I do now?" | `today` | The date, the time now, each block with its tasks, what is running, What's Important Now, what is behind, health. Also where the ids come from. |
| "What does my week look like?" | `week` | Any day in the week. |
| "Add 'call the bank' tomorrow, 20 minutes" | `add_task` | In a block (`block_id`) or loose on the day. |
| "Start it", "I'm done", "I didn't get to it" | `update_task` + `status` | `started`, `paused`, `done`, `missed` (with a reason), `dropped` (let go), `back`. A miss rolls to a recovery block there, and the result says where. |
| "Move it to Friday", "make it 45 minutes" | `update_task` | `date`, `block_id` (`none` = loose), `title`, `minutes`, `priority`. |
| "Push my writing block to 4 today", "skip the gym today" | `change_day` | One day only. `restore: true` puts it back. |
| "Add a gym block Mondays 7 to 8" | `add_block` | Repeats weekly. Can carry the tasks it makes each week. |
| "Make that block end at 8:30 every week" | `update_block` | Every week from now on. |
| "Delete that block / task" | `delete_block`, `delete_task` | Needs `confirm: true`, after the person says yes. |
| "What are my goals?", "Add a goal" | `goals`, `add_goal`, `update_goal` | Ten categories of life, by number. |
| "How is my balance?", "How am I doing?" | `balance`, `stats` | Hours per category this week; health and the last 28 days. |

## Decisions worth keeping

- **One verb, fifteen actions.** `calendar` with an `action` enum, for the reason in
  `toolRosterBudget.test.ts`: sibling verbs cost every other tool some accuracy. The budget went
  86 → 87.
- **Only on the roster while a calendar is linked.** `off_calendar_unlinked` in
  `toolAvailability.ts` withholds it otherwise, and the tool panel says how to link one. Everyone
  who never links a calendar has the roster they had before. The prompt line is gated the same way.
- **Looking is free; changing has one switch.** Settings → AI permissions → Calendar → *Change your
  calendar* (`change_calendar`, a branch permission, default on). Off, the tool still looks.
- **Nothing about the schedule is worked out here.** Each action is one call to Equilibrium's API
  (`docs/api.md` there) with the key inside the link code. Recovery, the coach and health are
  Equilibrium's rules; the tool reports what it answered, trimmed to ids and what a person would
  say out loud. Equilibrium's own refusals ("That block is on Mondays…") go back to the model as
  they are, marked fixable.
- **Dates and times are resolved over there.** The tool passes "today", "tomorrow" or a day's name
  through; Equilibrium knows the person's time zone.
- **The worm refreshes after any change**, so finishing a task in Chat shows on the worm.
- **The link is per device** (`localStorage`), as before. A second device needs the code pasted
  there too.

## Where

| Piece | File |
| --- | --- |
| Definition and executor | `src/lib/calendarTool.ts` |
| The API call, the linked/not hook | `src/lib/equilibriumLink.ts` (`callEquilibrium`, `useEquilibriumLinked`) |
| Registration and dispatch | `src/lib/chatTools.ts` |
| Roster gate | `src/lib/toolAvailability.ts`, `ChatContext.tsx`, `ToolStatusPanel.tsx` |
| Permission | `src/lib/toolPermissions.ts` |
| Prompt line | `src/lib/buildChatSystemPrompt.ts` (`calendarLine`) |
| Tests | `src/test/calendarTool.test.ts` |

## Not checked

- A real model choosing and filling the tool in a signed-in chat. The executor was run against a
  real Equilibrium server with every action; the model's side was not.
- Voice (hands-free) turns, and a real phone.
