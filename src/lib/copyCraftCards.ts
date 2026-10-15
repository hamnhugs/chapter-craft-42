// Copy & Design Masters: the seed cards for the copy-craft skill.
//
// Each card distils one master's working method, one design discipline or one
// job (a flyer, a blurb, a sales letter) into moves a model can apply. They
// are seeded into the user's "Copy & Design Masters" neuron, where they can be
// read, edited or added to like any memory. copyCraft.ts ranks them per turn.
//
// Why explicit moves and not "write like X": models are poor at imitating a
// writer's implicit style from a name or a few samples (EMNLP Findings 2025,
// "LLMs Still Struggle to Imitate the Implicit Writing Styles…"), and expert
// personas help writing tasks only modestly (arXiv 2603.18507). Concrete,
// checkable techniques are what transfer. Research notes and sources:
// docs/local-ai/COPY-CRAFT.md.
//
// Keep each body under ~1,100 characters: two or three ride in a local
// model's prompt at once (SkillsBench: injected skills peak at 2–3).

export type CraftCardKind = "master" | "design" | "playbook";

export interface CraftCard {
  /** Stable id; also the seed tag, so an edited card is never overwritten. */
  key: string;
  kind: CraftCardKind;
  title: string;
  /** Names a user might say ("whitman", "cashvertising"). Any one in the
   *  request puts this card first. */
  names: string[];
  /** Words that describe when the card helps. Only used for ranking. */
  when: string;
  body: string;
}

export const COPY_CRAFT_CARDS: CraftCard[] = [
  // ── Copywriters ────────────────────────────────────────────────────────────
  {
    key: "whitman",
    kind: "master",
    title: "Drew Eric Whitman — Ca$hvertising",
    names: ["whitman", "drew eric", "cashvertising", "ca$hvertising", "life-force", "lf8"],
    when: "persuasion psychology desire emotion benefits fear headline ad flyer sales copy offer",
    body: `Sell to the Life-Force 8, the wants people are born with: survival and a longer life; food and drink; freedom from fear, pain and danger; sex; comfort; to be superior and win; to protect loved ones; social approval. Find which one your product serves and lead with it.
- Benefits, not features: "turns at 2,800 rpm" → "so you sink a screw in one push".
- Extreme specificity beats claims: "12 kinds of screws, 15 kinds of nails", "cuts your bill by $38 a month".
- Mental movies: sensory adjectives and a scene the reader steps into ("cold, sweating bottle").
- Ego morphing: show the person the reader wants to become using it.
- Fear works only when the threat is real, your fix is specific, it works, and the reader believes they can do it. Never invent a threat.
- Headline starters that test well: FREE, NEW, AT LAST, ANNOUNCING, WARNING, HOW, WHICH OF, IF YOU, STARTING TODAY.
- First line continues the headline's thought, asks a question, or tells a short dramatic story.
- Bandwagon and authority only from numbers and experts the user gave you; a guarantee only if they offer one; make acting easy.`,
  },
  {
    key: "schwartz",
    kind: "master",
    title: "Eugene Schwartz — Breakthrough Advertising",
    names: ["schwartz", "eugene", "breakthrough advertising", "awareness", "sophistication"],
    when: "awareness market sophistication headline strategy big idea mechanism desire positioning",
    body: `Copy can't create desire; it channels a desire that already exists onto your product. First pick the desire, then match the reader's awareness:
- Most aware (knows and wants it): headline = the product name, the offer and the price.
- Product aware (knows it, not sold yet): sharpen the benefit, add proof, remove risk.
- Solution aware (wants the result, doesn't know you): headline = the desire or the result, then reveal you.
- Problem aware (feels the pain): name the problem in their words, then the way out.
- Unaware: open with the reader's identity or a story, never the product.
Market sophistication (how many claims they've already heard): 1 first in market → say the claim plainly. 2 → make it bigger or faster. 3 → introduce a new mechanism (how it works, named). 4 → elaborate the mechanism, make it easier or quicker. 5 → jaded market: sell identification with the reader, not a claim.
Build belief step by step from things the reader already accepts (gradualization), and intensify by making the result vivid, specific and near.`,
  },
  {
    key: "ogilvy-copy",
    kind: "master",
    title: "David Ogilvy — headlines and copy",
    names: ["ogilvy", "david ogilvy", "confessions of an advertising man"],
    when: "headline body copy long copy research brand print ad editorial benefit news",
    body: `"Five times as many people read the headline as read the body copy." Spend most of your effort there.
- Headline: promise a benefit, add news if there is any ("new", "now", "introducing"), name the product, and say it to the reader you want ("To mothers of bed-wetters"). Long headlines that say something beat short clever ones. No puns or riddles that need the body to make sense.
- Research the product until you find the fact that sells (the Rolls-Royce clock you can hear at 60 mph). Facts and specifics persuade; adjectives don't.
- Body copy: write like a friend talking to one person. Short first paragraph (about 11 words). Testimonials from real people. Useful advice and service. Long copy sells when every line earns its place.
- Captions are read more than body copy: put a selling sentence under every picture.
- "The consumer isn't a moron; she is your wife." Respect the reader; don't shout.
- Big idea test: would it make you gasp? Is it unique? Could it run for 30 years?`,
  },
  {
    key: "hopkins",
    kind: "master",
    title: "Claude Hopkins — Scientific Advertising",
    names: ["hopkins", "claude hopkins", "scientific advertising", "reason why", "schlitz"],
    when: "reason why specificity preemptive claim test sample proof facts",
    body: `Advertising is salesmanship in print: judge it by sales, test it, and say why.
- Reason-why copy: every claim comes with the reason it's true.
- Specific claims are believed; general ones are discounted. "Platitudes roll off the reader like water from a duck." Say "reduces cost by 25%", not "the best".
- The preemptive claim (Schlitz beer): describe the care that goes into your product, the pure water from deep wells, bottles washed with live steam, even if every competitor does it too. The first to say it owns it.
- Headlines select the reader; address only the people you can sell.
- Offer a sample or a free first step; let the product sell itself.
- Write to one typical buyer as if they were in front of you. No boasting; serve.
- Test everything (keyed coupons). Opinions don't count; results do.`,
  },
  {
    key: "caples",
    kind: "master",
    title: "John Caples — Tested Advertising Methods",
    names: ["caples", "john caples", "tested advertising", "they laughed when i sat down"],
    when: "headline test self-interest news curiosity story opening",
    body: `The headline is the ad. Caples tested which headlines pulled and found:
1. Self-interest wins: promise the reader something they want ("How to…", "Free…", "Now you can…").
2. News next: "New", "Announcing", "At last", a discovery.
3. Curiosity works only when combined with self-interest. Curiosity alone fails.
Classics to model: "They Laughed When I Sat Down at the Piano — But When I Started to Play!" (a before/after story with a social win) and "Do You Make These Mistakes in English?" (a question the reader must answer for themselves).
- Be specific and believable; specific numbers outpull round ones.
- Use the words people use; avoid brag and cleverness.
- The first paragraph must deliver on the headline immediately.
- Write several headlines, then pick the one with the clearest self-interest. When you can, test two.`,
  },
  {
    key: "collier",
    kind: "master",
    title: "Robert Collier — The Robert Collier Letter Book",
    names: ["collier", "robert collier", "letter book", "conversation in the mind"],
    when: "sales letter structure opening close penalty motivation conversation",
    body: `"Enter the conversation already going on in the reader's mind." Open with what they're already thinking or worried about today, not with you.
Collier's letter in six moves:
1. Opening: catch attention with their interest.
2. Description: make them see it.
3. Motivation: why they want it, in emotional terms.
4. Proof or guarantee: why it's safe to believe.
5. Penalty: what they lose by not acting now.
6. Close: one clear, easy action, with a reason to do it today.
Write warmly and personally, to one reader. Use stories and images. Tie your offer to the news and the season the reader is living in.`,
  },
  {
    key: "schwab",
    kind: "master",
    title: "Victor Schwab — How to Write a Good Advertisement",
    names: ["schwab", "victor schwab", "how to win friends"],
    when: "ad structure attention advantage prove persuade action headline book ad",
    body: `Schwab wrote the ad that sold "How to Win Friends and Influence People". His five steps for any ad:
1. Get attention: the headline offers an advantage the reader wants.
2. Show people an advantage: the benefit, in their life.
3. Prove it: facts, demonstrations, testimonials, guarantees.
4. Persuade people to grasp it: make them picture having it and what they lose without it.
5. Ask for action: say exactly what to do, now.
Headlines that worked for him: "How to…", a question the reader answers "yes" to, a promise of a gain or of avoiding a loss. People want gains (health, money, time, popularity, comfort, pride) and fear losses. Lead with the gain, back it with the loss.`,
  },
  {
    key: "sugarman",
    kind: "master",
    title: "Joseph Sugarman — The Adweek Copywriting Handbook",
    names: ["sugarman", "joe sugarman", "joseph sugarman", "slippery slide", "blublocker", "triggers"],
    when: "flow readability first sentence curiosity honesty flaw objection triggers storytelling",
    body: `The slippery slide: every element exists to get the next one read. The headline sells the subhead, the subhead sells the first sentence, the first sentence sells the second.
- First sentence: very short and easy ("It's easy." "Fact."). Short first paragraphs.
- Seeds of curiosity at the end of paragraphs: "But there's more." "Let me explain." "Here's why."
- Raise the reader's biggest objection yourself, then answer it. Admit a real flaw; honesty makes the rest believable.
- Sell the concept, not the product; tell a story.
- Ownership: make them picture holding and using it.
- Triggers that move people: specificity, credibility and authority, proof of value and a logical justification for an emotional buy, a satisfaction guarantee, urgency, exclusivity, the desire to belong or to collect, curiosity, simplicity, and hope.
- Match the tone to the nature of the product: playful for toys, serious for health.`,
  },
  {
    key: "halbert",
    kind: "master",
    title: "Gary Halbert — The Boron Letters",
    names: ["halbert", "gary halbert", "boron", "starving crowd", "a-pile"],
    when: "personal letter tone audience market envelope short sentences offer",
    body: `"The most important advantage is a starving crowd." Who you write to matters more than how well. Find people who already want it badly.
- Get into the A-pile: make it look personal, not like an ad. A real name, a plain envelope, one-to-one tone ("Dear Friend").
- Write like you talk. Short words, short sentences, short paragraphs. Read it aloud; fix anything that trips.
- Lead with the reader's own interest; specifics and a story beat adjectives.
- A damaging admission ("This isn't for everyone…") builds trust.
- Tell them exactly what to do, why it's a good deal, and why now.
- P.S.: restate the offer and the deadline; many people read it first.
- Practice: copy great ads out by hand to get their rhythm.`,
  },
  {
    key: "bencivenga",
    kind: "master",
    title: "Gary Bencivenga — proof, believability, fascinations",
    names: ["bencivenga", "gary bencivenga", "fascinations", "persuasion equation"],
    when: "proof believability bullets fascinations claims credibility skeptical",
    body: `People don't doubt that a benefit would be nice; they doubt that it's true. Persuasion is proof.
The equation he's known for: urgent problem + unique promise + unquestionable proof + user-friendly proposition = persuasion.
- Lead with the most believable form of your biggest claim.
- Proof stack: specific numbers, named sources, demonstrations, before/after, third-party quotes, a guarantee strong enough to be its own proof.
- Fascinations (bullets) tease a specific benefit without giving the secret away:
  "The 3-word phrase that ends an argument in 10 seconds (page 47)"
  "Why the healthiest food in your fridge may be the one you throw away"
- Each bullet: specific, curious, benefit-driven, believable. Vary the openings.
- Cut any claim you can't prove; one doubtful line poisons the rest.`,
  },
  {
    key: "carlton",
    kind: "master",
    title: "John Carlton — the Simple Writing System",
    names: ["carlton", "john carlton", "one-legged golfer"],
    when: "conversational voice story hook specifics sales letter headline",
    body: `Write like you'd talk to a friend across a table, then sharpen it. Hype is weak; specifics are strong.
- A great hook packs story, benefit and curiosity into one line: "Amazing Secret Discovered by One-Legged Golfer Adds 50 Yards to Your Drives, Wipes 9 Strokes Off Your Score Almost Overnight!"
- Know your market better than they know themselves: their words, their fears, their fantasies.
- Structure: hook → story that proves it → what it is and what it does → proof → the offer → guarantee → close with a deadline.
- Kill clichés and corporate words; use concrete nouns and active verbs.
- Answer the reader's "so what?" after every claim.`,
  },
  {
    key: "kennedy",
    kind: "master",
    title: "Dan Kennedy — No B.S. direct marketing",
    names: ["kennedy", "dan kennedy", "no b.s.", "magnetic marketing"],
    when: "offer deadline call to action direct response tracking lead generation follow up",
    body: `Direct-response rules for any piece:
1. Always make an offer: something specific to do now.
2. Give a reason to respond right now: a real deadline or limit, and say why it exists.
3. Clear instructions: exactly how to respond, step by step.
4. Make it trackable (code, link, number).
5. Follow up; most people don't respond the first time.
Message–market–media match: the right message for the right people in the right place.
Lead with the problem the reader feels, agitate it honestly, then solve it. Use a "reason why" for everything: the price, the bonus, the deadline. Results rule: judge copy by response, not by how pretty it is.`,
  },
  {
    key: "makepeace",
    kind: "master",
    title: "Clayton Makepeace — emotion and dimensionalized benefits",
    names: ["makepeace", "clayton makepeace", "dominant resident emotion"],
    when: "emotion feeling benefits vivid fundraising health finance",
    body: `Find the dominant resident emotion: the feeling already strongest in your reader about this topic (fear for their savings, anger at being misled, longing for energy). Write to that feeling first; facts come second.
Dimensionalize every benefit: feature → what it does → what that means in their life, made visible.
  "Lower blood pressure" → "…so you can chase your grandkids around the yard without your heart pounding in your ears."
- Paint pictures; one vivid scene beats three abstract benefits.
- Speak conversationally, one person to one person.
- Frame the offer so saying yes feels obvious: the value, the cost of waiting, the guarantee.`,
  },
  {
    key: "bernbach",
    kind: "master",
    title: "Bill Bernbach & DDB — honest, witty, one idea",
    names: ["bernbach", "ddb", "doyle dane bernbach", "think small", "lemon", "avis", "koenig"],
    when: "creative brand wit honesty self-deprecating concept image and headline together",
    body: `"The truth isn't the truth until people believe you." DDB's work (VW "Think Small" and "Lemon", Avis "We Try Harder") won by being honest and human.
- One idea, carried by the picture and the headline together; neither makes full sense alone. A tiny car in white space + "Think small."
- Admit the weakness and turn it into the reason to buy ("We're No.2. We try harder.").
- Wit that sells the product, not wit for its own sake.
- Talk to the reader as an intelligent adult; no hype words.
- Plain body copy full of specific facts in a dry, friendly voice.`,
  },
  {
    key: "reeves",
    kind: "master",
    title: "Rosser Reeves — the Unique Selling Proposition",
    names: ["reeves", "rosser reeves", "usp", "unique selling proposition"],
    when: "positioning differentiation slogan tagline unique",
    body: `A USP has three parts:
1. A proposition: "Buy this and you get this specific benefit."
2. Unique: one the competition doesn't or can't make.
3. Strong enough to move people to act.
"Melts in your mouth, not in your hand." Say it simply and repeat it. If a reader can't tell you from the others, they have no reason to choose you.
Test: could a competitor sign this sentence? Then it's not your USP.`,
  },
  {
    key: "lewis",
    kind: "master",
    title: "Herschell Gordon Lewis — direct mail copy",
    names: ["herschell", "gordon lewis", "lewis"],
    when: "direct mail motivators skepticism clarity you",
    body: `The great motivators: fear, exclusivity, guilt, greed, and the need for approval. Find the one that fits the reader and the offer honestly.
- Clarity beats cleverness. If the reader has to work it out, you've lost them.
- "You" is the most important word; write about the reader, not about "we".
- Specifics outpull generalities; make every claim provable.
- Overcome skepticism: name sources, show numbers, add a guarantee, don't overclaim.
- Start fast; cut the warm-up paragraph.`,
  },
  {
    key: "masterson-forde",
    kind: "master",
    title: "Michael Masterson & John Forde — Great Leads",
    names: ["masterson", "forde", "great leads", "rule of one", "mark ford"],
    when: "lead opening first paragraph big idea type of lead",
    body: `The Rule of One: one big idea, one core emotion, one story, one desired action.
Pick the lead by how aware the reader is (most → least):
1. Offer lead: the deal itself (for people who already want it).
2. Promise lead: the biggest benefit, boldly.
3. Problem–solution lead: name their pain, promise relief.
4. Big secret lead: a hidden method or fact they can learn here.
5. Proclamation lead: a startling, provable statement or prediction.
6. Story lead: a narrative that pulls the cold reader in.
The less aware the reader, the more indirect the lead.`,
  },
  {
    key: "modern-dr",
    kind: "master",
    title: "Modern direct response — Albuquerque, Brown, Georgi, Hormozi",
    names: ["albuquerque", "16-word", "todd brown", "big idea", "unique mechanism", "georgi", "rmbc", "hormozi", "value equation", "grand slam offer"],
    when: "big idea unique mechanism one belief offer value guarantee bonuses vsl landing",
    body: `- One Belief (Evaldo Albuquerque): the whole piece exists to install one sentence: "[new opportunity] is the key to [desire], and it's attainable only through [new mechanism]." Then answer the reader's silent questions: How is this different? Why should I care? Why believe you? What's in it for me? Why now? How does it work? What do I do next? What if it doesn't work?
- Big idea (Todd Brown): a fresh idea the market hasn't heard lets you skip hype.
- Unique mechanism: name WHY the problem exists and HOW your solution works differently.
- Value equation (Alex Hormozi): value = (dream outcome × perceived likelihood) ÷ (time delay × effort). Raise the top with proof and guarantees; shrink the bottom with speed and done-for-you.
- Stack the offer: solve each sub-problem with a named bonus; add a strong guarantee, real scarcity and urgency.`,
  },
  {
    key: "voc",
    kind: "master",
    title: "Joanna Wiebe & Harry Dry — customer words, three tests",
    names: ["wiebe", "copyhackers", "voice of customer", "harry dry", "marketing examples"],
    when: "landing page website copy customer language reviews clarity test specific",
    body: `Voice of customer (Joanna Wiebe): the best lines come from customers. Mine reviews, emails and interviews for repeated phrases about the pain, the hoped-for result and the hesitation; use their exact words in headlines and bullets. Don't summarize while listening.
Harry Dry's three tests for every line:
1. Can I visualize it? ("1,000 songs in your pocket" beats "innovative storage").
2. Can I falsify it? (a claim that could be proven wrong: "365-day returns", not "best quality").
3. Can nobody else say it? If a competitor could paste it, rewrite.
Three no's = rubbish; three yes's = you're onto something.
Clarity first: a visitor should know what it is, who it's for and what to do within five seconds.`,
  },

  // ── Design for persuasion ──────────────────────────────────────────────────
  {
    key: "ogilvy-layout",
    kind: "design",
    title: "Ogilvy layout — the editorial ad",
    names: ["ogilvy layout", "ogilvy", "editorial layout", "advertorial"],
    when: "layout print ad advertorial magazine page picture caption headline body columns drop cap",
    body: `The classic order, top to bottom: picture → caption → headline → body copy → logo/response.
- One big photograph (often the top two-thirds), real and with story appeal; photos beat drawings.
- A caption under the picture that sells: captions are read more than body copy.
- Headline BELOW the picture, in upper and lower case (all caps is harder to read), dark type on a light ground.
- Body copy in a readable serif, never under 14 pt (smaller is hard to read), in columns about 40 characters wide; a drop cap at the start; short first paragraph; subheads every few paragraphs; a few key lines in bold or italic.
- Make it look editorial, like a page of the magazine, not like an ad; editorial layouts get more readers.
- No reversed (white-on-black) body text and no text set over busy pictures.
- Logo or signature and the response device at the bottom right, where the eye ends.`,
  },
  {
    key: "voegele",
    kind: "design",
    title: "Siegfried Vögele — the Dialogue Method for letters and mail",
    names: ["vögele", "vogele", "voegele", "dialogue method"],
    when: "direct mail letter brochure scanning reading path p.s. signature response device",
    body: `Vögele filmed readers' eyes with an eye camera. Readers decide in seconds, reading in a fixed order: pictures and big type first, then highlighted words, the signature and the P.S., and only then the body. They hold a silent dialogue: every unanswered question is a "filter" that makes them stop; every answer is an "amplifier" that keeps them going.
Design the short reading route so a 20-second scan answers: Who is this from? What's in it for me? What do I do?
- Put a picture of the product or a person in use where the eye lands first.
- Headline and subheads carry the whole argument on their own.
- Highlight (bold or underline) the 3–5 phrases that answer "what's in it for me", not random words.
- A real signature and a P.S. that restates the main benefit and the offer.
- Response device: easy, pre-filled, one obvious action.`,
  },
  {
    key: "dr-letter-format",
    kind: "design",
    title: "Sales letter and long-form page formatting",
    names: ["johnson box", "sales letter", "long form", "long-form", "squeeze page"],
    when: "sales letter long form landing page formatting subheads bullets p.s. johnson box",
    body: `Long copy is read when it's easy to read:
- Pre-head (who it's for) → big headline → deck/subhead → lead.
- Johnson box: a short boxed summary of the offer above the salutation (letters).
- Short paragraphs (1–4 lines); one idea each. Subheads every 3–5 paragraphs that tell the story on their own.
- Bullets for benefits and fascinations; indent and vary their openings.
- One column of text at reading width (about 45–75 characters); generous leading.
- Emphasis sparingly: bold or underline a few key phrases; never whole paragraphs.
- Proof near claims: testimonials (real, attributed) beside the claim they back.
- Offer box: what you get, the value, the price, the guarantee seal, one big button or coupon.
- Sign-off with a name, then P.S. (restate the benefit and the deadline), optionally P.P.S. (the guarantee or a bonus).`,
  },
  {
    key: "krone-restraint",
    kind: "design",
    title: "Helmut Krone & DDB art direction — restraint and white space",
    names: ["krone", "helmut krone", "think small", "white space"],
    when: "minimal white space layout single image clean type brand ad",
    body: `Krone's VW ads used a plain template (big image on top, centred headline, three columns of copy below) and made it striking by restraint.
- One image, one idea. White space makes the subject important (a tiny car in a white page).
- One typeface family, plain and legible (Futura for VW); no decoration.
- Headline short, set modestly; let the picture and the words create the idea together.
- Body copy in tidy columns, the brand quietly at the end.
- Every element must earn its place: remove until removing more would break the idea.`,
  },
  {
    key: "poster-masters",
    kind: "design",
    title: "Poster masters — Bass, Cassandre, the Swiss",
    names: ["saul bass", "bass", "cassandre", "swiss style", "poster design", "vignelli"],
    when: "poster billboard cover symbol image distance bold single idea",
    body: `A poster is read in a glance, from a distance.
- Saul Bass: "symbolize and summarize". Reduce the story to one strong symbol (the jagged arm, the cut-up body) in flat colour.
- Cassandre: the poster is a means of communication, a message first; bold geometry, one focal image, lettering built into the design.
- Swiss / International style (Vignelli, Müller-Brockmann): a grid, very few typefaces, big type size contrast, flush-left ragged-right sans, objective photography.
Rules of thumb: one focal point; headline readable from across a room (aim for about 7 words or fewer); the subject and the words never compete; strong figure–ground contrast; the date, place and action in one compact block.`,
  },
  {
    key: "type-readability",
    kind: "design",
    title: "Type for reading — Wheildon's findings and their limits",
    names: ["wheildon", "type & layout", "readability", "typography"],
    when: "typography font serif sans body text reverse type capitals colour legibility",
    body: `Colin Wheildon tested readers' comprehension in print. His findings (disputed on method, but widely used in direct response):
- Body text in serif was understood far better than sans in his tests; online, a clean sans is fine at good size.
- Reverse body text (light on dark) cut comprehension sharply; keep long text dark on light.
- All-caps headlines were less legible than upper and lower case.
- Black headlines out-read brightly coloured ones; colour is for accents, not for reading.
- Headlines should not interrupt the reading path (no headline the eye must jump back up to reach).
Practical: two typefaces at most (a display face and a text face), one dominant size contrast (headline 3–4× the body), line length 45–75 characters, leading about 1.3–1.5 for text.`,
  },
  {
    key: "eye-paths",
    kind: "design",
    title: "Where eyes go — faces, gaze and scanning",
    names: ["eye tracking", "f-pattern", "z-pattern", "gaze"],
    when: "attention eye tracking face gaze scanning web page layout hierarchy",
    body: `- Faces grab attention first. If the person in the picture looks at the headline or the product, readers look there too (eye-tracking of baby ads: a face looking out held the eye; turned toward the copy, it sent readers to the copy).
- On screens people scan in an F (top line, then down the left) or a "layer cake" (headings only, then the body under the heading that interests them). So headings and the first words of each line must carry the message.
- Single-message pages (posters, ads) are read in a Z: top left → top right → diagonal → bottom right. Put the logo or call to action where the Z ends.
- Size, contrast and isolation create the order; decide the first, second and third things the eye should see.
- Landing pages: one goal per page (an "attention ratio" of 1:1), the CTA visible without scrolling and repeated after the proof.`,
  },

  // ── Playbooks for jobs people ask for ─────────────────────────────────────
  {
    key: "play-flyer",
    kind: "playbook",
    title: "Playbook — flyers and posters that pull",
    names: [],
    when: "flyer poster event promo announcement sign handout leaflet designcraft page",
    body: `Copy for a flyer or poster, part by part:
- [headline] the benefit or the event in 3–8 strong words; a promise or news, not a label ("Summer Reading Club" → "Read 10 Books This Summer. Win a Kindle.").
- [subhead] who it's for and the key detail: date, place, price, or the second benefit.
- [body] 2–4 short lines or bullets: what they get, specific and visual. Proof only if the user gave it (a real quote, a real number).
- [footer] the action and the details: what to do, where, by when ("Sign up at the front desk by June 1 · Free").
- [caption] a selling sentence under the picture, if there is one.
- [image] one picture showing people enjoying the result, or the thing itself; a face looking toward the headline helps.
Pick the style for the job: bold for events and promos, cinematic for books and films, editorial for information, pop for kids and sales, classic for invitations. Keep total copy short enough to read in 5 seconds.`,
  },
  {
    key: "play-ad",
    kind: "playbook",
    title: "Playbook — print and social ads",
    names: [],
    when: "ad advert advertisement social media facebook instagram print magazine ad campaign",
    body: `1. Pick the one reader and their awareness level (unaware → story or identity; problem aware → name the problem; most aware → the offer).
2. Write 10 headlines in different shapes: how-to, question, news, specific number, testimonial, "warning", before/after. Keep the one with the clearest self-interest that's specific and believable.
3. Body: 40–120 words. Hook line that continues the headline → the benefit, dimensionalized → one proof → the offer → one action.
4. Visual: one picture that makes the promise visible; caption that sells. Picture and headline form one idea.
5. Social: the first 6–8 words and the image do all the work; front-load the benefit; one clear CTA.
6. Check: Can I visualize it? Can I falsify it? Could a competitor say it?`,
  },
  {
    key: "play-book",
    kind: "playbook",
    title: "Playbook — book covers, blurbs and book promotion",
    names: [],
    when: "book cover blurb back cover description amazon author novel launch promotion reader",
    body: `Back-cover / store description:
1. Hook line (bold): the premise in one tension-filled sentence.
2. Who + wants + what stands in the way + what's at stake if they fail (fiction); or the problem + the promise + why this author (non-fiction).
3. 2–3 short paragraphs; end on a question or a turn, not a summary.
4. Proof: only a review quote or credential the user gave you, else a [Review quote] slot; comps ("for readers of…").
5. Call to action: "Read it today", "Scroll up and grab your copy".
Cover copy: title huge and readable as a thumbnail; one tagline of 4–9 words that promises the experience ("Some secrets refuse to stay buried."); author name large if known.
Book ads: lead with the reader's feeling ("If you loved…", "The thriller you won't put down") + one gripping line from the book + the cover.`,
  },
  {
    key: "play-letter",
    kind: "playbook",
    title: "Playbook — sales letters and landing pages",
    names: [],
    when: "sales letter sales page landing page long copy vsl webinar launch product page",
    body: `Skeleton (match length to price and awareness):
1. Headline: the big promise or the big idea, specific and believable. Pre-head names the reader.
2. Lead: one of offer / promise / problem / secret / proclamation / story.
3. The problem and why the usual fixes fail (the mechanism of the problem).
4. The solution and how it works differently (the unique mechanism).
5. Proof: story, numbers, demonstrations, real testimonials.
6. Benefits as fascination bullets.
7. The offer: what they get, bonuses, value vs. price, reason why the price.
8. Guarantee that removes the risk.
9. Urgency with a real reason; the close with one action.
10. Sign-off, P.S. restating the promise and deadline.
Every section ends with a reason to read the next one.`,
  },
  {
    key: "play-email",
    kind: "playbook",
    title: "Playbook — emails and newsletters",
    names: [],
    when: "email newsletter subject line campaign sequence welcome launch",
    body: `- Subject line: specific and curious, or a plain benefit; 3–7 words; sound like a person ("Quick question about your book").
- Preview text continues the subject; never wasted on "View in browser".
- One email = one idea = one action. The link early and again at the end.
- Open with a story, a surprising fact, or the reader's situation, never "I hope this finds you well".
- Short paragraphs, plain words, a real name in the sign-off, and a P.S. that restates the one action.
- Sequences: welcome (deliver the promise) → value → story → offer → reminder with a real deadline.`,
  },
  {
    key: "play-headlines",
    kind: "playbook",
    title: "Playbook — writing and choosing headlines",
    names: [],
    when: "headline title tagline slogan hook subject line name",
    body: `Write many, choose one. Shapes to try:
- How to [get result] [without pain]  ·  How I [result] in [time]
- [Number] ways/secrets/mistakes…  ·  Do you make these mistakes in…?
- At last / Announcing / New: [news]  ·  Warning: [danger] for [reader]
- Who else wants [result]?  ·  If you [situation], read this
- They [doubted] when I [did X], but when I [result]…
- Give me [time] and I'll give you [result]
Check with the 4 U's (urgent, unique, ultra-specific, useful) and Dry's three tests. Prefer self-interest over cleverness; specifics over adjectives; the reader's words over yours. For a page, the headline must make sense without the picture and work with it.`,
  },
  {
    key: "play-offer",
    kind: "playbook",
    title: "Playbook — offers, proof and the close",
    names: [],
    when: "offer price discount guarantee call to action cta close proof testimonial urgency scarcity",
    body: `- Offer: name it; list what they get; show value against price; give a reason why the price is what it is.
- Risk reversal: a specific guarantee ("Read it. If it doesn't change how you write in 30 days, email me for every penny back.").
- Proof hierarchy: demonstration > specific results > named testimonials > statistics > expert endorsement > your own claims.
- Urgency and scarcity only when they're real: a true deadline or a true limit, with the reason.
- CTA: a verb + the benefit ("Start my free chapter", not "Submit"); one primary action; repeat it.
- Lower the first step (free sample, first chapter, quiz) for cold readers.
Honesty rule: never invent testimonials, numbers, awards, deadlines or limits. If the user hasn't given them, use clear placeholders like [real customer quote] and say so.`,
  },
];

export const COPY_CRAFT_BY_KEY = new Map(COPY_CRAFT_CARDS.map((c) => [c.key, c]));
