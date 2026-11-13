# Arena update — plain chat, card library, automatic intake

November 2026, branch `new1`. What changed, what has to happen on the server,
and the bug audit that went with it.

> **13 Nov: the Store was removed.** The Store tab, coins, the wallet, Bookworm
> AI (keyless chat paid in coins) and coin-bought Pro passes are all gone —
> they added more to learn than they were worth. Chat needs your own API key
> again, as it did before. See "Server work" for the clean-up that leaves.

## What is different for a user

| Area | Before | Now |
|---|---|---|
| Navigation | Top bar on desktop, side rail on tablet, bottom bar + "More" sheet on phone | One bottom dock everywhere: **Library · Counsel · Read · Notebooks**. Settings, Admin and sign-out are icons in the top bar. Counsel is the home tab. |
| Chat | Always tied to a notebook; "My notes" was created and loaded whether you wanted it or not | **Just chat**: unload every notebook (the chip row above the chat, or ⌘K → Just chat). Nothing is read from or saved to notes until you load one again. |
| Uploading a book | Named after the file; no cover; tagging was a button | Title is worked out (PDF metadata → page-one heading for opaque file names → cleaned file name); page one becomes the cover; chapters are detected; the book is categorised and tagged. Nothing to do by hand. |
| Library | Shelves grid | **Cards** (default): each book is a card with a tier (by length), a level (by how far you have read), and a time-to-read badge. "Reading now" is a hand of cards on top. Tap a card for its **profile**: stats, summary, chapters, shelves, and every action. Shelves / List / Showcase / Mind map are still one tap away. |

Tiers: Leaflet (<80 pages), Volume (80+), Tome (300+), Opus (600+). Levels:
ten, one per tenth of the book read; a finished book is MAX.

Books uploaded before this change get their cover the first time they are
opened in the reader. Their titles are not touched.

## Server work

The coins backend was applied on 13 Nov and now has to come back out. In
Lovable:

1. **Apply the migration** `supabase/migrations/20261113120000_remove_coins.sql`.
   It drops the wallet, passes and coin functions and restores
   `my_entitlements()`. If anyone bought a coin pack with real money, the
   ledger is kept as `coin_ledger_archive` so the purchase can be refunded;
   otherwise it is dropped too.
2. **Delete the edge functions** `coin-chat` and `claim-coins` (their code is
   gone from the repo), and **redeploy** `create-checkout` (plans only again),
   `auto-structure` and `describe-figures`.

Until step 1 runs nothing breaks: the app no longer calls any of it.

Book covers and titles need **no** server change: covers are stored beside
each book's file in the existing private `book-pdfs` bucket.

`OPEN_ACCESS` (`src/lib/openAccess.ts`) is still `true`, so everything in Pro
is free. The pricing dialog and Stripe plans are untouched and still dormant
behind that flag.

## How it was checked

- `npx tsc -p tsconfig.app.json --noEmit` — clean (it had 6 errors before).
- `npx vitest run` — 114 files, 2,630 tests pass (28 new).
- `npx vite build` — builds.
- `deno check` on the five edge functions touched — clean.
- The dock, card collection and book profile were looked at in a real
  browser at 956×506, 1280×900 and 390×800 through `#/arena-lab` (dev only;
  `#/arena-lab?deck` for the collection).

**Not run:** anything against the live backend. No real upload, chat turn,
Stripe checkout has been exercised end to end, the remove-coins migration has
not been run against a database, and the upload path (title, cover, tagging) is unit-tested for its title logic but
has not been driven with a real file in a signed-in session.

## Bug audit

Fixed in this change:

| # | Bug | Effect | Fix |
|---|---|---|---|
| 1 | `auto-structure` checked `subscribers.subscribed` only | During open access the app queued chapter detection for everyone and the server answered 402 to everyone but admins and subscribers — automatic chapters silently never happened | Functions ask `my_entitlements()` / `app_open_access()` through `_shared/entitled.ts` |
| 2 | An empty notebook scope meant "search everything" | With no notebook resolved, retrieval and `search_wiki` fell through to an unscoped query | Plain chat is explicit: searches answer empty and say why |
| 3 | Re-uploading a file reset the book's title | A book you had renamed went back to its file name when you replaced the file | A re-upload keeps the existing title |
| 4 | Send callback closed over stale settings | Toggling the Program Foundry switches, the image models, prompt routing or "plain on recall" did not take effect until something else rebuilt the callback | Added the ten missing dependencies |
| 5 | Checkout opened with `window.open` after an `await` | Safari and every iOS browser block that as a popup: the button spun and nothing opened | Falls back to navigating in the same tab |
| 6 | A tab left open across a deploy | The first lazy screen opened hit a missing chunk and showed "Something went wrong"; "Try again" could not recover | The error boundary reloads once for stale-chunk errors |
| 7 | Upload rows read "Uploading (try 0/3)" while converting an EPUB | The step name was stored but never shown | Shows the step |
| 8 | Reader chips and the read-along bar used phone offsets only below `md` | With a dock on every size they would have been covered | Positioned off the dock's real height |
| 9 | 6 TypeScript errors (`voiceTap.ts`, `oklch.test.ts`) | `tsc` could not be used as a gate | Typed correctly |
| 10 | Nothing wrote `cover_image_url` | Every book wore a generated placeholder | Covers are captured at upload |

Found and left alone (say if you want them done):

- **Figure extraction without your own key** still needs a real plan
  even during open access. That looks deliberate (it spends the app's AI
  credits in volume), so the gate was kept.
- **Stripe lookups are by email, first match, 100 sessions.** A customer with
  two Stripe customer records for one email, or more than 100 checkouts, can
  have a purchase missed by `check-subscription`. Needs
  pagination and a stored customer id.
- **`localStorage` is read unguarded in ~90 places.** A browser with storage
  blocked throws on some of them at render. Rare (sign-in needs storage too).
- **Upload row ids** are `name-size-mtime`: uploading the same file twice
  shows two rows that update together. Cosmetic.
- **Lint:** about 1,400 `no-explicit-any` and a dozen `prefer-const` /
  `no-useless-escape`; none is a behaviour bug. The remaining hook-dependency
  warnings were read one by one and are intentional.
- **Bundle:** the main chunk is 1.9 MB (584 KB gzipped). Not new.
- **Prompt routing** rides on the notes retrieval call, so it does not run on
  a plain-chat turn.
- **"Have I had a notebook" is remembered per device.** Delete every notebook,
  then sign in on a new device, and "My notes" is created there once more.

This was a targeted audit — type errors, lint findings, the build, and a close
read of the upload, chat-send, billing and navigation paths — not a line by
line review of all 92,000 lines.
