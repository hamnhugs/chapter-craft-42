// "Stop hands-free", said out loud.
//
// The fast path for ending a hands-free session by voice: a plain spoken
// command is recognised right here, on the device, before anything is sent to
// a model. That matters because the moment someone needs this is the moment
// they have been interrupted on the go — a model round trip (seconds, and a
// working connection) is exactly what they cannot wait for.
//
// Deliberately narrow: the WHOLE utterance has to be the command, give or
// take politeness. "How do I stop hands-free from timing out?" is a question
// and goes to the model as usual. Looser phrasings ("hang on, someone's at
// the door") also go to the model, which has the `end_hands_free` tool for
// exactly that — so a miss here costs a couple of seconds, never the feature.

/** Words that carry no meaning in a spoken command. */
const FILLER = new RegExp(
  "\\b(?:please|hey|hi|ok|okay|alright|all right|so|now|right now|for now|for a (?:bit|moment|minute|second|sec)|" +
  "thanks|thank you|counsel|bookworm|can you|could you|would you|will you|" +
  "i need you to|i want you to|i need to|i want to|i have to|i gotta|let s|lets|just|go ahead and)\\b",
  "g",
);

const VERB = "(?:stop|end|exit|quit|close|cancel|leave|finish|pause|kill|disable|deactivate|turn off|switch off|shut off)";
// What speech recognition actually writes for "hands-free": hyphens are
// normalised to spaces below, and "hand free" / "handsfree" both show up.
const MODE = "(?:hands? ?free|voice|listening|conversation|talking)(?: mode| chat| conversation| session)?";
const MIC = "(?:the |your )?(?:mic|microphone)";
const THE = "(?:the |this |my |our )?";

const COMMANDS: RegExp[] = [
  // stop hands free · end the hands free mode · turn off voice mode · exit voice chat
  new RegExp(`^${VERB} ${THE}(?:${MODE}|${MIC})$`),
  // turn hands free off · switch the mic off
  new RegExp(`^(?:turn|switch|shut) ${THE}(?:${MODE}|${MIC}) off$`),
  // hands free off · voice mode off · mic off
  new RegExp(`^${THE}(?:${MODE}|${MIC}) off$`),
  // stop listening · stop listening to me · quit listening
  /^(?:stop|quit|end|pause) listening(?: to me)?$/,
];

/** True when the utterance is nothing but a request to end hands-free. */
export function isStopHandsFreeCommand(utterance: string): boolean {
  const text = String(utterance || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // punctuation and the hyphen in "hands-free"
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 80) return false;
  const core = text.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (!core) return false;
  return COMMANDS.some((re) => re.test(core));
}

/** What the app says once the mic is closed — the user may not be looking. */
export const HANDS_FREE_OFF_NOTICE = "Hands-free is off. Tap the mic when you need me.";
