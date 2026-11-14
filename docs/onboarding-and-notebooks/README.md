# Onboarding and nested notebooks

Built on `new1`, 13 Nov 2026. Two pieces of work that meet on the Notebooks
tab: a first-run experience hosted by Bookworm, and notebooks that can sit
inside notebooks.

## Onboarding

### What a new user sees

1. **Setup helper, three screens** (`SetupWizard.tsx`). Bookworm says hello and
   lists the three things it takes to get going; the second screen connects an
   AI (the only real setup there is); the third sends them to the Library to
   add a first book. It was four screens and toured the tabs; the tab tour is
   gone and the model picker folded into the AI screen as an optional
   disclosure.
2. **Getting-started ring** in the top bar (`onboarding/GettingStarted.tsx`).
   Four steps: connect an AI, add a book, ask Counsel, open a notebook. Each
   ticks itself off from what the user has really done and is a button that
   goes to where it happens. It stays until all four are done or it is hidden.
3. **Tab tours** (`onboarding/WormCoach.tsx`). The first time each tab is
   opened, Bookworm explains it in one to three short steps, with a ring round
   the control a step is about. Tabs covered: Library, Counsel, Read,
   Notebooks, an open notebook, Settings. The Read tour waits until a book is
   open.

Copy for the tours is in `src/lib/onboardingTips.ts`; state and the decisions
(who is new, which tour is due, what the list shows) are in
`src/lib/onboarding.ts`.

### Who gets it

Only accounts that sign in for the first time after this ships. Anyone who
already has an AI key or has been through the setup helper is marked as a
veteran and sees nothing new. **Settings → Account → Bookworm's tips →
Replay** turns it all back on for any account.

State is kept in `localStorage` per account (`cc_onboarding_v1:<user id>`), so
a second device shows the tours again. That was chosen over a database column
to avoid a migration.

### What the research said, and what it changed

| Finding | Source | What it changed |
|---|---|---|
| People who read a tutorial did no better than people who skipped it (91% vs 94% task success). Contextual help beats up-front tours. | [NN/g, mobile tutorials](https://www.nngroup.com/articles/mobile-tutorials/), [NN/g, onboarding](https://www.nngroup.com/articles/mobile-app-onboarding/) | The tab tour left the setup helper. Each tab is explained when it is opened, and the card blocks nothing: no scrim, the page stays live. |
| 3-step tours are finished by about 72% of people, 4-step by 74%, 7-step by 16%. | [Chameleon benchmark](https://www.chameleon.io/blog/mastering-product-tours) (vendor data) | Setup helper cut from four screens to three. Every tab tour is capped at three steps, enforced by a test. |
| Tours people start themselves are finished 2–3× as often as ones that start on their own. | [Chameleon benchmark report](https://www.chameleon.io/blog/chameleon-benchmark-report) | The getting-started list is a ring the user opens, not a panel that opens on them. |
| A progress indicator raised completion 12% and cut dismissals 20%. | Chameleon, 2019 report | Dots on the helper and on every multi-step tour; the ring fills as steps complete. |
| Checklists work because an open list wants closing; time to first value under five minutes is the usual target for self-serve products. | Vendor guides ([Appcues](https://www.appcues.com/blog/user-onboarding-guide), [Userpilot](https://userpilot.com/blog/user-onboarding/)) — practitioner opinion, not studies | The four-step list, and a last helper screen whose only button is "Add my first book". |

The NN/g findings are from their own usability studies. The completion
numbers are one vendor's product data, repeated by other vendors; treat them
as direction, not measurement.

### How it is built

- **No library.** The tour card is an `<aside>` fixed above the dock (or under
  the app bar when the control it points at is in the lower half of the
  window). The ring is a fixed box drawn over the target's measured rectangle
  and re-measured on scroll, resize and a 250 ms tick while a tour is up.
- **Why not CSS anchor positioning.** It would do the ring without script,
  and it is the current way to do this. Firefox and Safari shipped it only
  recently and sources disagree on exactly which versions; the Android
  WebView the app also runs in trails Chrome. A measured box works in all of
  them today.
- **Targets are `data-tour` attributes**, not class names, so a restyle can't
  silently break a tour. A step whose target isn't on screen still reads on
  its own; it just has no ring.
- **Bookworm is the Counsel sprite** (`BookWorm.tsx`), reused through
  `onboarding/WormSays.tsx`. It already stops animating when settled and
  honours reduced motion; the card and ring animations are switched off under
  `prefers-reduced-motion` too.
- The card is not `role="dialog"`: it takes no focus, and the themes style
  every `[role=dialog]` as a modal panel.

## Notebooks inside notebooks

### What changed

- A notebook can be kept inside another, **three levels deep at most**.
- The Notebooks list is a **tree sorted by name**. An arrow folds what is
  inside a notebook; what is folded is remembered on this browser. Each row
  says how many notes it has, how many notebooks are inside it, how many notes
  are due for review, and whether Counsel is using it.
- The row's ⋯ menu has **New notebook inside…** and **Rename, recolor or
  move…**. Moving is the "Keep it inside" picker in the edit dialog; places a
  notebook can't go (itself, its own contents, anything that would be a fourth
  level) are listed but disabled.
- **Search finds notebooks by name** from the first letter, shown with where
  they sit ("Programming craft › Pragmatic Programmer"), above the note
  results, which still start at three letters.
- **Jump back in**: the last four notebooks opened, as a row above the list.
  It appears once there are six or more notebooks and at least two have been
  opened.
- An open notebook shows **where it sits** (a "Notebooks › Stoics ›" trail
  above its name) and **what is inside it** (a row of chips, plus a + to add
  one).
- The ⌘K notebook switcher shows a nested notebook with its path.
- **Deleting a notebook never deletes the notebooks inside it.** They move up
  to where the deleted one was, and the confirmation says so.

### What the research said

| Finding | Source | What it changed |
|---|---|---|
| More than three levels is a warning sign; cap depth and give search as the way out. | [Deep-branching nav anti-pattern](https://skill-wiki.github.io/atom/frontend-design/anti-pattern-deep-branching-nav) | Three levels, enforced. Search matches notebook names. |
| Expanding a tree pushes what you wanted out of view. | [Coding Horror, Trees, TreeViews and UI](https://blog.codinghorror.com/trees-treeviews-and-ui/) | Folding is remembered, with Collapse all / Expand all. Jump back in skips the tree. |
| Breadcrumbs supplement navigation; they don't replace it. | [Setproduct, breadcrumbs](https://www.setproduct.com/blog/breadcrumbs-ui-design) | The trail on an open notebook is in addition to the back arrow. |
| Trees are harder on touch screens. | [Justinmind](https://justinmind.com/blog/3-modern-alternatives-to-tree-navigation) | The fold arrow is its own 44 px target. Moving is a picker, not drag and drop. |

These are design write-ups and one engineering blog, not controlled studies.
Nothing useful came back on recents or pinned rows; Jump back in is there on
the strength of how common it is, not on evidence.

The list used to be ordered by when Counsel last loaded each notebook. It is
now by name, because a list you find things in by position has to keep its
positions.

### How it is stored

The parent is one tag on the notebook: `in:<parent id>`, in the `wikis.tags`
column that has existed since the first migration and that nothing else
writes. **No migration and no server work.** All of the tree logic is in
`src/lib/notebookTree.ts` and is pure.

Because a tag can't refuse bad data the way a foreign key would, the tree
builder is defensive: a parent that no longer exists, a notebook inside
itself, or two inside each other all degrade to the top level. A notebook is
never hidden. `src/test/notebookTree.test.ts` covers each case.

If nesting ever needs to be queried on the server, the move to a real
`parent_id` column touches `parentIdOf` and `withParent` and nothing else.

Counsel does not know about nesting. Loading a notebook loads that notebook,
not what is inside it.

## How it was checked

- `npx tsc -p tsconfig.app.json --noEmit` — clean.
- `npx vitest run` — 118 files, 2,649 tests pass (21 new).
- `npx vite build` — builds.
- Looked at in headless Chromium through two new dev-only lab routes, at
  956×506, 476×506 and 360×740 (touch):
  - `#/arena-lab?onboarding` — the shell as a new account meets it
    (`&step=1` opens the helper on a later screen, `&tips` skips it).
  - `#/arena-lab?notebooks` — the list and an open notebook over a tree held
    in memory (`&flat`, `&empty`, `&tips`). Creating inside, moving, deleting
    a parent and searching were all driven end to end there.
- Screenshots are in `shots/`.

**Not run:**

- Nothing was done in a signed-in session against the live backend. The
  tag write goes through the same `updateWiki` call rename already uses, but
  it has not been exercised against the real database.
- The "connected" state of the AI screen and the model picker inside it (they
  need a real key).
- The Read tour and the open-notebook tour with real content on screen. Their
  first steps were seen; the rings on Contents and Daily recall were not.
- The Settings tour and the Replay button were not clicked through.
- A real phone.
