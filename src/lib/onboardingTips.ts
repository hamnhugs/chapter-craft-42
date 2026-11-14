// What Bookworm says the first time each tab is opened.
//
// The rules these are written to (docs/onboarding-and-notebooks.md):
//   · three steps at most — completion falls off a cliff after four
//   · each step is one thing you can do right now, on this screen
//   · a step may point at a real control (`target`, a CSS selector); when the
//     control isn't on screen the step still reads on its own
//
// `target` uses `data-tour` hooks so a restyle can't silently break a tour.

import type { TipId } from "@/lib/onboarding";

export interface TipStep {
  title: string;
  body: string;
  /** CSS selector of the control this step is about. */
  target?: string;
}

export interface TabTip {
  /** Screen-reader name for the tour. */
  name: string;
  steps: TipStep[];
}

export const tourTarget = (name: string) => `[data-tour="${name}"]`;

export const TAB_TIPS: Record<TipId, TabTip> = {
  library: {
    name: "Library tour",
    steps: [
      {
        title: "Your books live here",
        body: "Press Add books and pick a PDF or EPUB. Dropping a file anywhere on this page works too, and so does pasting a YouTube link.",
        target: tourTarget("add-books"),
      },
      {
        title: "Tap a card",
        body: "A book's card opens it for reading, hands it to Counsel, or puts it on a shelf.",
      },
    ],
  },
  chat: {
    name: "Counsel tour",
    steps: [
      {
        title: "Ask me anything",
        body: "Type a question here, about a book or about anything else. I read your books so the answers can point to the page.",
        target: tourTarget("composer"),
      },
      {
        title: "I take notes as we go",
        body: "What's worth keeping is saved to this notebook. Tap + to bring in another, or Just chat to keep nothing.",
        target: tourTarget("counsel-notebooks"),
      },
    ],
  },
  viewer: {
    name: "Read tour",
    steps: [
      {
        title: "Your reading desk",
        body: "I keep your place. Whenever you come back, this book opens at the page you left.",
      },
      {
        title: "Select any passage",
        body: "Drag across some text to highlight it, ask me about it, or save it as a note.",
      },
      {
        title: "Jump around",
        body: "Contents lists the chapters. Tap one to go straight there.",
        target: tourTarget("reader-contents"),
      },
    ],
  },
  wikis: {
    name: "Notebooks tour",
    steps: [
      {
        title: "One notebook per subject",
        body: "A book, a project, a question you're chasing. Press New to start one. I fill it as we talk.",
        target: tourTarget("new-notebook"),
      },
      {
        title: "Notebooks go inside notebooks",
        body: "Open a notebook's ⋯ menu and choose New notebook inside to keep related ones together.",
        target: tourTarget("notebook-row-menu"),
      },
      {
        title: "Find any note",
        body: "Search looks through every notebook at once, by name and by what the notes say.",
        target: tourTarget("notebook-search"),
      },
    ],
  },
  wiki: {
    name: "Notebook tour",
    steps: [
      {
        title: "Notes that know their page",
        body: "Each note links back to the page it came from. Tap a note to read it, edit it, or jump to the source.",
      },
      {
        title: "Three questions a day",
        body: "Daily recall asks you about three notes, so what you read stays with you.",
        target: tourTarget("daily-recall"),
      },
    ],
  },
  settings: {
    name: "Settings tour",
    steps: [
      {
        title: "Nothing here is required",
        body: "AI keys, models, voices and themes are all here when you want them. To see my tips again, go to Account and press Replay.",
      },
    ],
  },
};
