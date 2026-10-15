# Copy & design craft: writing like the direct-response masters

Ask Counsel for copy, such as a flyer, ad, headline, blurb, sales letter or email, or work
on a page in DesignCraft, and it writes using the methods of the best direct-response
copywriters and designers. Name one ("write it like Drew Eric Whitman", "an Ogilvy
layout") and that master's methods come first.

## How it works

- **The knowledge is a neuron.** On first use Counsel creates **"Copy & Design
  Masters"** in your memory: one card for each master, design discipline or job (33 cards
  to start). It isn't loaded as your active neuron, so it never crowds your own memories. Open it
  like any neuron to read the cards, **edit them**, or **add your own** (your brand voice, a
  house style, a swipe file of ads you like). Your edits and additions are what Counsel
  uses. A later update to the built-in cards never overwrites a card you've edited. Each
  card carries a `seed:<hash>` tag of what was seeded; only a card whose text still matches that hash is refreshed.
- **Two or three cards per turn, chosen for the request.** `src/lib/copyCraft.ts` decides
  whether a turn is a copy or design job (`wantsCopyCraft`): a deliverable such as a flyer,
  poster, ad, headline, blurb, sales page, email, call to action or "DesignCraft"; a master's name;
  something selected in the DesignCraft window; or a short follow-up ("make it punchier") to
  a reply about copy. Then `rankCraftCards` picks the cards: any master you named (up to
  two), one playbook for the job, and the best-matching master or design card. With nothing
  specific it uses the flyer playbook + Whitman + Ogilvy's layout for a page, or the headline
  playbook + Whitman + Schwartz for other copy.
- **They ride in the turn context, fenced as data.** Most turns aren't copy turns, so the
  cards never touch the cached prompt prefix. The cards are user-editable text, so they go
  in a nonce fence through the same sanitizer as memories and can't pose as instructions or
  authorise a tool call. The section also says: write the words yourself, draft several
  headlines and use the best, build on the book's real facts, and **never invent
  testimonials, numbers, awards, deadlines or limits**. Use a `[placeholder]` instead.
  The DesignCraft line (send parts by role, pick a look) appears only when the craft tool is
  on the wire.
- **A page look to match: `direct`.** In DesignCraft, `look: "direct"` lays the page out
  as Ogilvy's direct-response ad. It isn't the default; Counsel picks it for "an ad that
  sells", "like Ogilvy", "direct response", "offer", "coupon" and similar requests. See [DESIGN-LOOKS.md](DESIGN-LOOKS.md).

Files: cards `src/lib/copyCraftCards.ts`, engine `src/lib/copyCraft.ts`, wiring
`buildChatSystemPrompt.ts` (the "COPY & DESIGN CRAFT" block), tests
`src/test/copyCraft.test.ts`.

## Why cards with explicit moves, not "write like X"

- Models imitate a named writer's *implicit* style poorly, even with samples
  ([LLMs Still Struggle to Imitate the Implicit Writing Styles…, EMNLP Findings 2025](https://aclanthology.org/2025.findings-emnlp.532.pdf)).
  Expert personas help writing tasks only modestly and can hurt accuracy
  ([arXiv 2603.18507](https://arxiv.org/html/2603.18507v1);
  [arXiv 2605.29420](https://arxiv.org/html/2605.29420v1)). What transfers is each master's
  *method*: the checks and moves they used. That's what a card holds.
- Injected skills help most at 2–3 and fall off at four or more
  ([SkillsBench, arXiv 2602.12670](https://arxiv.org/abs/2602.12670)), the same limit
  the Tool Foundry uses. A 4B local model also has little prompt room. Cards are kept under
  about 1,100 characters each.
- Keeping the knowledge in a neuron, not in code, follows the app's own memory design:
  the user can see, correct and extend what the assistant knows.

## Who is in it, and what was taken from each

Copywriters:

| Card | The method in brief |
|---|---|
| **Drew Eric Whitman**, *Ca$hvertising* | Life-Force 8 desires; benefits not features; extreme specificity; mental movies; ego morphing; fear only when real and solvable; 22 headline starters; 12 ways into the body copy ([Shortform](https://www.shortform.com/blog/cashvertising-by-drew-eric-whitman/), [Aure's Notes 1](https://auresnotes.com/summary-cashvertising-drew-eric-whitman/), [2](https://auresnotes.com/summary-cashvertising-drew-eric-whitman/2/)) |
| **Eugene Schwartz**, *Breakthrough Advertising* | Copy channels desire, can't create it; five awareness levels → headline strategy; five stages of market sophistication (claim → bigger claim → mechanism → better mechanism → identification) |
| **David Ogilvy** | Headlines read 5× more than body copy; benefit + news; research for the fact that sells; captions; respect for the reader ([Antoine Buteau's notes](https://www.antoinebuteau.com/lessons-from-david-ogilvy/)) |
| **Claude Hopkins**, *Scientific Advertising* | Reason-why; specifics are believed; the preemptive claim (Schlitz); samples; test everything ([Schlitz story](https://oncopy.substack.com/p/how-claude-hopkins-saved-schlitz)) |
| **John Caples**, *Tested Advertising Methods* | Self-interest > news > curiosity (only with self-interest); "They laughed when I sat down at the piano" |
| **Robert Collier** | Enter the conversation already in the reader's mind; the six-part letter |
| **Victor Schwab** | Attention → advantage → proof → persuasion → action ([review](https://brandknewmag.com/?p=11659)) |
| **Joseph Sugarman** | The slippery slide; seeds of curiosity; admit the flaw; psychological triggers ([list](https://swipefile.com/joe-sugarman-triggers)) |
| **Gary Halbert** | The starving crowd; the A-pile; one-to-one tone; P.S. |
| **Gary Bencivenga** | Proof is persuasion; the persuasion equation; fascinations ([bullets](https://www.verygoodcopy.com/bencivenga-bullets)) |
| **John Carlton** | Conversational voice; the story-benefit-curiosity hook |
| **Dan Kennedy** | Always an offer, a reason to act now, clear instructions, tracking, follow-up |
| **Clayton Makepeace** | Dominant resident emotion; dimensionalized benefits ([AWAI](https://www.awai.com/2005/04/banishing-writers-block/)) |
| **Bill Bernbach / DDB** | Honest, witty, one idea in picture + headline; turn the weakness into the reason |
| **Rosser Reeves** | The USP's three parts |
| **Herschell Gordon Lewis** | The great motivators; clarity; overcoming skepticism ([directmail.com](https://www.directmail.com/articles/article2.aspx)) |
| **Masterson & Forde**, *Great Leads* | The Rule of One; six lead types by awareness |
| **Albuquerque, Brown, Georgi, Hormozi** | One Belief + the reader's silent questions; big idea; unique mechanism; value equation ([Hormozi summary](https://www.supersummary.com/100m-offers/summary/)) |
| **Joanna Wiebe & Harry Dry** | Voice-of-customer mining ([Copyhackers](https://copyhackers.com/write-copy-amazon-review-mining/)); visualize / falsify / nobody-else-can-say-it ([Upgrow](https://upgrow.io/blog/harry-dry-copywriting-3-rules)) |

Design for persuasion:

| Card | The method in brief |
|---|---|
| **Ogilvy layout** | Picture → caption → headline below → body → response; editorial look; serif body, no reverse type ([swipefile](https://swipefile.com/make-ads-like-ogilvy-cheat-sheet)) |
| **Siegfried Vögele**, Dialogue Method | Eye-camera reading order (pictures, big type, highlights, signature, P.S.); readers' silent questions; filters vs amplifiers ([SOFII tag](https://sofii.org/tags/siegfried%20v%C3%B6gele), [Horizont](https://www.horizont.net/marketing/nachrichten/-10-Jahre-Siegfried-Voegele-Institut-Verfechter-des-klassischen-Werbebriefs-108045)) |
| **Sales letter formatting** | Pre-head, Johnson box, short paragraphs, story-telling subheads, offer box, P.S. ([Johnson box](https://wikipedia.com/wiki/Johnson_Box)) |
| **Helmut Krone / DDB art direction** | Restraint, white space, one image, plain type ([Design Observer](https://conference.designobserver.com/article.php?id=4657)) |
| **Poster masters** | Saul Bass's "symbolize and summarize"; Cassandre; Swiss grid |
| **Colin Wheildon**, *Type & Layout* | Serif body, no reverse text, lower-case headlines, black headlines; flagged as methodologically disputed ([summary](https://cuttingedgepr.com/articles/serif-typefaces-best-for-body-copy-of-printed-publications/), [critique](https://alexpoole.info/blog/which-are-more-legible-serif-or-sans-serif-typefaces/)) |
| **Where eyes go** | Faces and gaze direction ([baby-ad eye tracking](https://www.neurosciencemarketing.com/blog/articles/baby-heat-maps.htm)); F and layer-cake scanning ([NN/g](https://nngroup.com/articles/text-scanning-patterns-eyetracking/)); Z for posters; attention ratio 1:1 |

Playbooks for the jobs people ask for: flyers and posters (the copy part by part in
DesignCraft's roles), print and social ads, book covers and blurbs, sales letters and
landing pages, emails, headlines, and offers/proof/close (with the honesty rule).

**Source quality.** Most of what's online about these books is secondary summaries.
The cards keep to points several sources agree on, or points from the books' well-known
contents, and hedge the rest. Numbers that couldn't be confirmed (Ogilvy's exact readership
percentages, Whitman's full list of 41) are left out. Wheildon's findings are labelled as
disputed.

## Does it help? (A/B on the local model)

`results/2026-10-14-copy-craft-ab.txt`, raw replies in `results/copy-craft-ab/`. Qwen3-4B,
the same three requests with and without the cards:
- **Better copy.** The flyer headline went from "Read. Discover. Win! Summer Reading Club for
  Kids 8–12" to "Read 10 Books. Win a Prize. Free.", with scannable benefit bullets and a
  footer that says what to do. The Whitman ad opened "AT LAST: …", aimed at Life-Force 8
  desires and ended on a specific call to action. Blurbs gained a hook line, stakes and comps.
- **Invented proof was the problem.** With the cards, a 4B model at first wrote fake review
  quotes from fake authors and "over 20,000 founders". Without them, it signed the ad
  "— Drew Eric Whitman". The honesty rule now has its own last line and the
  cards say "proof only from the user". Blurbs went to 2/2 clean, with a
  `[Review quote from a real reader]` slot. The ad keeps the slot 4/4 with no invented
  names, statistics or guarantees, but 2/4 still add an unattributed sample quote under it.
  **Check quotes before publishing** when chatting on a small local model.

## Testing it

```bash
npx vitest run src/test/copyCraft.test.ts        # gating, ranking, the neuron merge, fencing
```

For the `direct` look, see DESIGN-LOOKS.md (gallery) and the design eval in CRAFTS.md.
