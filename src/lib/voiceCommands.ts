// Hands-free voice commands: turns one spoken utterance into an app action
// BEFORE it would go to the chat model. Pure (no DOM) so it's unit-tested;
// lib/voiceControl.ts carries the commands out.
//
// Matching rules:
//   • Whole-utterance matches only, after stripping a wake word ("bookworm",
//     "wormy") and politeness ("please", "can you"). "What's on the next
//     page?" is a question for the model, not a page turn — only the bare
//     imperative "next page" turns it.
//   • Speech-to-text spellings are expected: "council" for Counsel, "book
//     worm", "warmy", number words ("page twenty three").
//   • "bookworm go to sleep" / "bookworm sleep" / "wormy sleep" end
//     hands-free. A wake word is required so "I should go to sleep" doesn't.

export type VoiceTab = "library" | "viewer" | "chat" | "wiki" | "wikis" | "settings" | "admin";
export type Ordinal = number | "last";
export type TextUnit = "phrase" | "sentence" | "paragraph" | "page";

export type VoiceCommand =
  | { kind: "sleep" }
  | { kind: "help" }
  | { kind: "where" }
  | { kind: "tab"; tab: VoiceTab }
  | { kind: "back" }
  | { kind: "page"; to: "next" | "prev" | "first" | "last" }
  | { kind: "page"; to: "number"; n: number }
  | { kind: "pageBy"; delta: number }
  | { kind: "chapter"; to: "next" | "prev" | "first" | "last" | "current" }
  | { kind: "chapter"; to: "number"; n: number }
  | { kind: "chapter"; to: "name"; name: string }
  | { kind: "zoom"; to: "in" | "out" | "fit" }
  | { kind: "focus"; on: boolean }
  | { kind: "screenshot"; target: "page" }
  | { kind: "screenshot"; target: "image"; which: Ordinal | "all" | null }
  | {
      kind: "save";
      unit: TextUnit;
      which?: Ordinal;
      says?: string;
      from?: string;
      to?: string;
      asCard: boolean;
    }
  | { kind: "openBook"; title: string }
  | { kind: "click"; label: string }
  | { kind: "scroll"; dir: "up" | "down" | "top" | "bottom" }
  | { kind: "type"; text: string }
  | { kind: "key"; key: "Enter" | "Escape" }
  | { kind: "multi"; commands: VoiceCommand[] };

const WAKE = "(?:book ?worm|bookworms|wormy|warmy|wormie|worm|bookie)";
const WAKE_RE = new RegExp(`^(?:(?:hey|ok|okay|yo|alright|hi)\\s+)?${WAKE}\\s*`);
const POLITE_RE =
  /^(?:please|can you|could you|would you|will you|can we|lets|let us|i want to|i wanna|i d like to|id like to|i would like to|go ahead and|now)\s+/;
const TRAILING_RE = /\s+(?:please|for me|now|thanks|thank you|bookworm|book worm|wormy)$/;

/** Lowercase, drop punctuation/apostrophes, collapse spaces. */
export function normalizeSpeech(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Numbers ────────────────────────────────────────────────────────────────
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6, "7th": 7, "8th": 8, "9th": 9, "10th": 10,
};

/** "23", "twenty three", "one hundred and five", "a hundred" → number. */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const words = t.split(" ").filter((w) => w && w !== "and");
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  let any = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // "to"/"too"/"for"/"won" only count as numbers when they're the whole thing.
    if ((w === "to" || w === "too" || w === "for" || w === "won" || w === "oh") && words.length > 1) return null;
    if (w in UNITS) { current += UNITS[w]; any = true; }
    else if (w in TENS) { current += TENS[w]; any = true; }
    else if (w === "hundred") { current = (current || 1) * 100; any = true; }
    else if (w === "thousand") { total += (current || 1) * 1000; current = 0; any = true; }
    else if (w === "a" && i === 0 && (words[1] === "hundred" || words[1] === "thousand")) continue;
    else if (/^\d+$/.test(w)) { current += Number(w); any = true; }
    else return null;
  }
  return any ? total + current : null;
}

function parseOrdinal(s: string): Ordinal | null {
  const t = s.trim();
  if (t === "last" || t === "final" || t === "bottom") return "last";
  if (t in ORDINALS) return ORDINALS[t];
  const m = t.match(/^(?:number|no|#)\s+(.+)$/);
  const n = parseNumber(m ? m[1] : t);
  return n && n > 0 ? n : null;
}

// ── Tabs ───────────────────────────────────────────────────────────────────
const TAB_WORDS: [RegExp, VoiceTab][] = [
  [/^(?:vault|library|bookshelf|book shelf|shelves|shelf|bookcase)$/, "library"],
  [/^(?:read|reader|reading|read along|book reader)$/, "viewer"],
  [/^(?:counsel|council|counselor|counsellor|cancel|chat|conversation|consul)$/, "chat"],
  [/^(?:notebook|my notebook|notes|my notes|neuron|neurons|newron|nuron|wiki)$/, "wiki"],
  [/^(?:notebooks|all notebooks|my notebooks|brain|brains|the brain|wikis|wiki library)$/, "wikis"],
  [/^(?:settings|setting|preferences|options)$/, "settings"],
  [/^(?:admin|admin panel)$/, "admin"],
];

function tabFor(name: string): VoiceTab | null {
  const n = name.replace(/^(?:the|my)\s+/, "").replace(/\s+(?:tab|page|screen|panel|view|section)$/, "").trim();
  for (const [re, tab] of TAB_WORDS) if (re.test(n)) return tab;
  return null;
}

// ── Parsing ────────────────────────────────────────────────────────────────
const IMAGE_WORD = "(?:image|images|picture|pictures|photo|photos|figure|figures|chart|charts|graph|graphs|diagram|diagrams|illustration|illustrations|drawing|drawings|pic|pics|map|maps|graphic|graphics|infographic|table|tables)";
const SHOT_VERB = "(?:take|grab|get|make|capture|snap|save|clip|copy|screenshot|screen shot|screen grab|screengrab|snapshot)";

function parseScreenshot(t: string): VoiceCommand | null {
  const mentionsShot = /\b(?:screenshot|screen shot|screen grab|screengrab|snapshot|snap)\b/.test(t);
  const imageMatch = t.match(new RegExp(`\\b${IMAGE_WORD}\\b`));
  const isPageShot = /\b(?:the|this|whole|entire|full)\s+(?:whole\s+|entire\s+)?page\b/.test(t) || /\bpage\s+(?:as\s+)?(?:an?\s+)?(?:image|picture|screenshot)\b/.test(t);
  if (isPageShot && (mentionsShot || /^(?:take|capture|save|grab|snap)\b/.test(t)) && /\b(?:screenshot|screen shot|snapshot|picture|image|capture|snap|grab)\b/.test(t)) {
    // "take a picture of the page", "screenshot this page", "save the page as an image"
    if (!/\b(?:paragraph|sentence|text)\b/.test(t)) return { kind: "screenshot", target: "page" };
  }
  if (imageMatch && new RegExp(`^(?:${SHOT_VERB})\\b`).test(t)) {
    const plural = /s$/.test(imageMatch[0]) && !/^(?:pics|graphics)$/.test(imageMatch[0]) || /\b(?:all|every|each|both)\b/.test(t);
    let which: Ordinal | "all" | null = plural ? "all" : null;
    const ord = t.match(new RegExp(`\\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|bottom|top)\\s+(?:\\w+\\s+)?${IMAGE_WORD}\\b`));
    if (ord) which = ord[1] === "top" ? 1 : parseOrdinal(ord[1]);
    const num = t.match(new RegExp(`\\b${IMAGE_WORD}\\s+(?:number\\s+)?([a-z0-9 ]+?)$`));
    if (num) { const n = parseNumber(num[1]); if (n) which = n; }
    return { kind: "screenshot", target: "image", which };
  }
  if (mentionsShot && /^(?:take\s+(?:a\s+)?)?(?:screenshot|screen shot|screen grab|screengrab|snapshot)(?:\s+(?:of\s+)?(?:it|this|that|here))?$/.test(t)) {
    return { kind: "screenshot", target: "page" };
  }
  return null;
}

const SAVE_VERB = "(?:save|highlight|mark|keep|clip|bookmark|capture|remember|store|underline)";
const UNIT_WORD = "(?:paragraph|paragraphs|sentence|sentences|line|lines|part|bit|passage|section|quote|piece|text|words|phrase)";
const SAYS = "(?:that|which|where)?\\s*(?:says|said|starts with|starting with|begins with|beginning with|about|containing|contains|mentioning|mentions|talks about|talking about|with the words|with|on)";

function unitOf(w: string): TextUnit {
  if (/^paragraph|^passage|^section/.test(w)) return "paragraph";
  if (/^words|^phrase/.test(w)) return "phrase";
  return "sentence";
}

function parseSave(t: string): VoiceCommand | null {
  const m0 = t.match(new RegExp(`^${SAVE_VERB}\\s+(.+)$`));
  if (!m0) return null;
  let rest = m0[1];
  let asCard = false;
  const cardTail = rest.match(/\s+(?:as\s+(?:a\s+)?(?:card|quote|note)|to\s+(?:my\s+|the\s+)?(?:notebook|notes|neuron|brain|cards?)|in\s+(?:my\s+|the\s+)?(?:notebook|neuron))$/);
  if (cardTail) { asCard = true; rest = rest.slice(0, cardTail.index).trim(); }
  rest = rest.replace(/\s+(?:in\s+(?:the\s+)?book|on\s+(?:this|the)\s+page|here)$/, "").trim();

  // "save this page", "highlight the whole page"
  if (/^(?:this|the|the whole|the entire|this whole|this entire|whole|entire|all of the|all the)\s*page$|^everything(?: on (?:the|this) page)?$/.test(rest)) {
    return { kind: "save", unit: "page", asCard };
  }
  // "save from X to Y"
  const range = rest.match(/^(?:the\s+(?:part|bit|text|section)\s+)?from\s+(.+?)\s+(?:to|through|until|till|up to|all the way to)\s+(.+)$/);
  if (range) return { kind: "save", unit: "phrase", from: range[1], to: range[2], asCard };
  // "save the second paragraph", "highlight the last sentence", "save paragraph 3"
  const ord = rest.match(new RegExp(`^(?:the\\s+|this\\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|top|bottom)\\s+(${UNIT_WORD})$`));
  if (ord) {
    const which = ord[1] === "top" ? 1 : parseOrdinal(ord[1]);
    if (which) return { kind: "save", unit: unitOf(ord[2]), which, asCard };
  }
  const numbered = rest.match(new RegExp(`^(?:the\\s+)?(${UNIT_WORD})\\s+(?:number\\s+)?([a-z0-9 ]+)$`));
  if (numbered) {
    const n = parseNumber(numbered[2]);
    if (n) return { kind: "save", unit: unitOf(numbered[1]), which: n, asCard };
  }
  // "save the paragraph that says X", "highlight the sentence about X"
  const says = rest.match(new RegExp(`^(?:the\\s+|this\\s+|that\\s+)?(${UNIT_WORD})\\s+${SAYS}\\s+(.+)$`));
  if (says && says[2].split(" ").length >= 1) return { kind: "save", unit: unitOf(says[1]), says: says[2], asCard };
  // "highlight where it says X", "save the words X", "highlight X" (3+ words)
  const where = rest.match(/^(?:where\s+it\s+says|where\s+they\s+say|the\s+(?:words|phrase|line)|the\s+part|the\s+bit)\s+(.+)$/);
  if (where) return { kind: "save", unit: /^the\s+(?:part|bit|line)/.test(rest) ? "sentence" : "phrase", says: where[1], asCard };
  if (asCard && /^(?:this|that|it)$/.test(rest)) return { kind: "save", unit: "page", asCard };
  return null;
}

function parsePage(t: string): VoiceCommand | null {
  if (/^(?:(?:go to|turn to|flip to|go)\s+)?(?:the\s+)?next page$|^(?:turn|flip)(?: the)? page(?: over)?$|^page (?:forward|ahead)$|^(?:forward|ahead) (?:a|one) page$|^next one$/.test(t)) {
    return { kind: "page", to: "next" };
  }
  if (/^(?:(?:go to|turn to|flip to|go)\s+)?(?:the\s+)?(?:previous|prior|preceding) page$|^(?:go\s+|turn\s+|flip\s+)?back\s+(?:a|one)\s+page$|^page back$|^(?:go\s+)?back a page$/.test(t)) {
    return { kind: "page", to: "prev" };
  }
  if (/^(?:go to\s+)?(?:the\s+)?(?:first page|beginning of (?:the|this) book|start of (?:the|this) book|front of (?:the|this) book)$/.test(t)) return { kind: "page", to: "first" };
  if (/^(?:go to\s+)?(?:the\s+)?(?:last page|final page|end of (?:the|this) book|back of (?:the|this) book)$/.test(t)) return { kind: "page", to: "last" };
  const by = t.match(/^(?:go\s+|skip\s+|jump\s+|flip\s+|turn\s+)?(forward|ahead|back|backward|backwards)\s+([a-z0-9 ]+?)\s+pages$/)
    || t.match(/^(?:skip|jump|flip)\s+([a-z0-9 ]+?)\s+pages(?:\s+(forward|ahead|back|backward|backwards))?$/);
  if (by) {
    const dirWord = /^(forward|ahead|back|backward|backwards)$/.test(by[1]) ? by[1] : by[2] || "forward";
    const nWord = dirWord === by[1] ? by[2] : by[1];
    const n = parseNumber(nWord);
    if (n) return { kind: "pageBy", delta: /^back/.test(dirWord) ? -n : n };
  }
  const to = t.match(/^(?:(?:go|turn|flip|jump|skip|take me|open|show(?: me)?)\s+(?:to\s+)?)?page\s+(?:number\s+)?([a-z0-9 ]+)$/);
  if (to) {
    const n = parseNumber(to[1]);
    if (n) return { kind: "page", to: "number", n };
  }
  return null;
}

function parseChapter(t: string): VoiceCommand | null {
  if (/^(?:go to\s+|skip to\s+|jump to\s+)?(?:the\s+)?next (?:chapter|section)$|^(?:skip|jump)(?: ahead)? (?:a|one) (?:chapter|section)$/.test(t)) return { kind: "chapter", to: "next" };
  if (/^(?:go to\s+|go back to\s+|jump to\s+)?(?:the\s+)?(?:previous|prior|preceding) (?:chapter|section)$|^(?:go\s+)?back (?:a|one) (?:chapter|section)$/.test(t)) return { kind: "chapter", to: "prev" };
  if (/^(?:go to\s+|jump to\s+)?(?:the\s+)?first (?:chapter|section)$/.test(t)) return { kind: "chapter", to: "first" };
  if (/^(?:go to\s+|jump to\s+)?(?:the\s+)?(?:last|final) (?:chapter|section)$/.test(t)) return { kind: "chapter", to: "last" };
  if (/^(?:go\s+(?:back\s+)?to\s+)?(?:the\s+)?(?:start|beginning|top) of (?:the|this) (?:chapter|section)$|^(?:restart|start) (?:the|this) chapter(?: over)?$/.test(t)) return { kind: "chapter", to: "current" };
  const m = t.match(/^(?:(?:go|turn|flip|jump|skip|take me|open|show(?: me)?|read)\s+(?:to\s+)?)?(?:the\s+)?(?:chapter|section)\s+(.+)$/);
  if (m) {
    const arg = m[1].replace(/^(?:number|called|named|titled|about|on)\s+/, "").trim();
    const n = /^(?:called|named|titled|about|on)\s/.test(m[1]) ? null : parseNumber(arg);
    if (n) return { kind: "chapter", to: "number", n };
    if (arg) return { kind: "chapter", to: "name", name: arg };
  }
  const named = t.match(/^(?:go to|jump to|take me to|open|show me)\s+(?:the\s+)?(?:chapter|section)\s+(?:called|named|titled|about|on)\s+(.+)$/);
  if (named) return { kind: "chapter", to: "name", name: named[1] };
  return null;
}

function parseOne(t: string, raw: string): VoiceCommand | null {
  if (!t) return null;

  if (/^(?:what can i say|what can you do|voice commands|list (?:the )?commands|help|what are the commands)$/.test(t)) return { kind: "help" };
  if (/^(?:what page (?:am i on|is this|are we on)|where am i|which page (?:am i on|is this)|what chapter (?:am i in|is this|are we in))$/.test(t)) return { kind: "where" };

  const page = parsePage(t);
  if (page) return page;
  const chapter = parseChapter(t);
  if (chapter) return chapter;

  if (/^zoom in$|^(?:make (?:it|the page|the text) )?(?:bigger|larger)$/.test(t)) return { kind: "zoom", to: "in" };
  if (/^zoom out$|^(?:make (?:it|the page|the text) )?smaller$/.test(t)) return { kind: "zoom", to: "out" };
  if (/^(?:fit (?:to )?(?:the )?(?:width|page|screen)|fit (?:the )?page(?: to (?:the )?(?:width|screen))?|reset (?:the )?zoom)$/.test(t)) return { kind: "zoom", to: "fit" };
  if (/^(?:(?:enter|go into|turn on|start|open)\s+)?(?:focus mode|full ?screen(?: mode)?)$|^focus$/.test(t)) return { kind: "focus", on: true };
  if (/^(?:exit|leave|close|turn off|stop|end|get out of)\s+(?:focus(?: mode)?|full ?screen(?: mode)?)$/.test(t)) return { kind: "focus", on: false };

  const shot = parseScreenshot(t);
  if (shot) return shot;
  const save = parseSave(t);
  if (save) return save;

  if (/^(?:scroll|page) down$|^scroll(?: down)? (?:a bit|more)$/.test(t)) return { kind: "scroll", dir: "down" };
  if (/^(?:scroll|page) up$|^scroll up (?:a bit|more)$/.test(t)) return { kind: "scroll", dir: "up" };
  if (/^scroll (?:all the way )?(?:to )?(?:the )?top$|^(?:go )?(?:to )?(?:the )?top of (?:the )?(?:page|screen|list)$/.test(t)) return { kind: "scroll", dir: "top" };
  if (/^scroll (?:all the way )?(?:to )?(?:the )?bottom$|^(?:go )?(?:to )?(?:the )?bottom of (?:the )?(?:page|screen|list)$/.test(t)) return { kind: "scroll", dir: "bottom" };

  if (/^(?:press|hit|push|tap)\s+(?:the\s+)?(?:enter|return)(?:\s+key)?$|^submit(?: it)?$/.test(t)) return { kind: "key", key: "Enter" };
  if (/^(?:press|hit|push|tap)\s+(?:the\s+)?(?:escape|esc)(?:\s+key)?$|^(?:close|dismiss)\s+(?:this|that|it|the\s+(?:dialog|popup|pop up|menu|window|box))$|^never ?mind$/.test(t)) return { kind: "key", key: "Escape" };

  const typed = raw.match(/^\W*(?:(?:hey|ok|okay)\s+)?(?:book\s?worm|wormy)?[\s,.!]*(?:please\s+)?type(?:\s+in|\s+out)?\s+([\s\S]+?)[.!]?$/i);
  if (typed && /^type\b/.test(t)) return { kind: "type", text: typed[1].trim() };

  // Tabs: "go to the read tab", "open counsel", "switch to the vault", "brain"
  const nav = t.match(/^(?:(?:go|switch|change|jump|head|navigate|move|flip)(?:\s+(?:back|over))?\s+(?:to|into)\s+|take me (?:back )?to\s+|bring me to\s+|bring up\s+|open(?: up)?\s+|show(?: me)?\s+|back to\s+)?(?:the\s+|my\s+)?(.+?)$/);
  if (nav) {
    const tab = tabFor(nav[1]);
    // A bare word ("read", "brain") counts only with a nav verb or "tab" —
    // otherwise "read" alone might be a request to the model.
    const hasVerbOrTab = nav[1] !== t || /\b(?:tab|page|screen|panel|view)$/.test(t);
    if (tab && (hasVerbOrTab || ["vault", "counsel", "council", "notebook", "notebooks", "neuron", "brain", "settings"].includes(t))) return { kind: "tab", tab };
  }
  if (/^go back$|^back$/.test(t)) return { kind: "back" };

  const open = t.match(/^(?:open|read|start reading|load|pull up)\s+(?:the\s+)?(?:book|pdf|document)\s+(?:called\s+|named\s+|titled\s+)?(.+)$/);
  if (open) return { kind: "openBook", title: open[1] };

  const click = t.match(/^(?:click|press|tap|hit|push|select|choose|pick|toggle|check|uncheck|activate)(?:\s+on)?\s+(?:the\s+)?(.+?)(?:\s+(?:button|tab|option|link|menu item|icon|box|checkbox|switch|toggle))?$/);
  if (click && click[1]) return { kind: "click", label: click[1] };

  const openAny = t.match(/^(?:open|show me|pull up)\s+(?:the\s+)?(.+)$/);
  if (openAny) return { kind: "openBook", title: openAny[1] };
  return null;
}

/** Strip wake words / politeness / trailing filler. */
export function stripFiller(t: string): string {
  let s = t;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(WAKE_RE, "").replace(POLITE_RE, "").replace(TRAILING_RE, "").trim();
    if (s === before) break;
  }
  return s;
}

export function isSleepCommand(text: string): boolean {
  const t = normalizeSpeech(text);
  if (t.split(" ").length > 7) return false;
  return new RegExp(`^(?:(?:hey|ok|okay|alright)\\s+)?${WAKE}\\s+(?:please\\s+)?(?:go\\s+(?:to\\s+|back\\s+to\\s+)?)?sleep(?:\\s+now)?(?:\\s+please)?$`).test(t)
    || new RegExp(`^(?:go\\s+to\\s+)?sleep\\s+${WAKE}$|^(?:good ?night|nighty night)\\s+${WAKE}$`).test(t);
}

/** Parse one utterance. null → not a command; send it to the model. */
export function parseVoiceCommand(text: string): VoiceCommand | null {
  if (isSleepCommand(text)) return { kind: "sleep" };
  const norm = normalizeSpeech(text);
  const t = stripFiller(norm);
  // Raw text without the wake word, for "type …" (keeps the user's casing).
  const one = parseOne(t, text.trim());
  if (one) return one;
  // "go to the read tab and turn to page five" — every part must parse.
  const parts = t.split(/\s+(?:and then|then|and also|and)\s+/).map((p) => stripFiller(p)).filter(Boolean);
  if (parts.length > 1 && parts.length <= 4) {
    const cmds = parts.map((p) => parseOne(p, p));
    if (cmds.every((c): c is VoiceCommand => !!c && c.kind !== "type")) return { kind: "multi", commands: cmds };
  }
  return null;
}
