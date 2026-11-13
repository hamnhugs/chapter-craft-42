# Arena update — plain chat, card library, Store, automatic intake

November 2026, branch `new1`. What changed, what has to happen on the server
before the paid parts work, and the bug audit that went with it.

## What is different for a user

| Area | Before | Now |
|---|---|---|
| Navigation | Top bar on desktop, side rail on tablet, bottom bar + "More" sheet on phone | One bottom dock everywhere: **Store · Library · Counsel · Read · Notebooks**. Settings, Admin and sign-out are icons in the top bar, next to the coin wallet. Counsel is the home tab. |
| Chat | Always tied to a notebook; "My notes" was created and loaded whether you wanted it or not | **Just chat**: unload every notebook (the chip row above the chat, or ⌘K → Just chat). Nothing is read from or saved to notes until you load one again. |
| API key | Chat refused to send without one | With no key, replies run on **Bookworm AI** and spend coins. A key is still supported and costs no coins. |
| Uploading a book | Named after the file; no cover; tagging was a button | Title is worked out (PDF metadata → page-one heading for opaque file names → cleaned file name); page one becomes the cover; chapters are detected; the book is categorised and tagged. Nothing to do by hand. |
| Library | Shelves grid | **Cards** (default): each book is a card with a tier (by length), a level (by how far you have read), and a time-to-read badge. "Reading now" is a hand of cards on top. Tap a card for its **profile**: stats, summary, chapters, shelves, and every action. Shelves / List / Showcase / Mind map are still one tap away. |
| Store | A pricing dialog, switched off | A Store tab: coin wallet, daily free coins, coin packs (Stripe), Bookworm AI model choice, Pro passes bought with coins. |

Tiers: Leaflet (<80 pages), Volume (80+), Tome (300+), Opus (600+). Levels:
ten, one per tenth of the book read; a finished book is MAX.

Books uploaded before this change get their cover the first time they are
opened in the reader. Their titles are not touched.

## Server work that is NOT done yet

The client is complete and degrades cleanly without any of this (the Store
says coins are not switched on; a keyless chat turn explains that Bookworm AI
is not deployed). To turn the paid parts on, in Lovable:

1. **Apply the migration** `supabase/migrations/20261112120000_coins.sql`
   (wallets, ledger, passes, and the `my_entitlements` update).
2. **Deploy the edge functions**: `coin-chat` and `claim-coins` (new),
   `create-checkout`, `auto-structure`, `describe-figures` (changed).
3. **Secrets** the functions read: `LOVABLE_API_KEY` (already used by other
   functions) and `STRIPE_SECRET_KEY` (needed for coin packs).

Book covers and titles need **no** server change: covers are stored beside
each book's file in the existing private `book-pdfs` bucket.

### Numbers you may want to change

| What | Where | Value |
|---|---|---|
| Welcome coins | `my_wallet()` in the migration | 100 |
| Daily coins | `claim_daily_coins()` | 10 |
| Pass prices | `buy_pass()` | 7 days = 400, 30 days = 1,200 |
| Coin packs | `supabase/functions/_shared/coin-packs.ts` | 500 / $2.99 · 1,200 / $5.99 · 2,800 / $11.99 · 6,500 / $24.99 |
| Coins per 1K tokens | `RATES` in `coin-chat` | Swift 0.2 in / 1.5 out · Sage 0.3 in / 2 out |

`src/lib/coins.ts` holds display copies of the last three. They only label
the shelf; the server values are what is charged.

The rates are a first guess, not a costed price list. Check them against what
the AI gateway actually bills before selling packs — and note the welcome and
daily grants are free usage for every new account.

### Open access

`OPEN_ACCESS` (`src/lib/openAccess.ts`) is still `true`, so everything in Pro
is free and the Store shows passes as "included for everyone". Coins and
Bookworm AI work either way. Turning billing back on is still that one flag
plus `app_open_access()` in the database, as before.

## How it was checked

- `npx tsc -p tsconfig.app.json --noEmit` — clean (it had 6 errors before).
- `npx vitest run` — 114 files, 2,630 tests pass (28 new).
- `npx vite build` — builds.
- `deno check` on the five edge functions touched — clean.
- The coins migration was applied twice (it is re-runnable) to a throwaway
  Postgres from the Supabase image and exercised as `authenticated`,
  `service_role` and `anon`: welcome grant once, daily claim once a day, a
  purchase credited once when replayed, a metered debit clamps at zero, a
  pass extends rather than overlaps, a pass makes `my_entitlements` report
  Pro, clients cannot write a wallet or call `coin_apply`, and each user sees
  only their own rows.
- The dock, Store, card collection and book profile were looked at in a real
  browser at 956×506, 1280×900 and 390×800 through `#/arena-lab` (dev only;
  `#/arena-lab?deck` for the collection).

**Not run:** anything against the live backend. No real upload, chat turn,
Stripe checkout or coin debit has been exercised end to end — `coin-chat`,
`claim-coins` and the checkout change are type-checked and reviewed only, and
the upload path (title, cover, tagging) is unit-tested for its title logic but
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

- **Figure extraction without your own key** still needs a real plan or pass
  even during open access. That looks deliberate (it spends the app's AI
  credits in volume), so the gate was kept and only taught about passes.
- **Stripe lookups are by email, first match, 100 sessions.** A customer with
  two Stripe customer records for one email, or more than 100 checkouts, can
  have a purchase missed by `check-subscription` / `claim-coins`. Needs
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
