# "Play Hooky?" — the new Getting Started tutorial

## What you'll see
- In the **Vault**, a small hand-drawn fishing line drops from the top corner with a worm on a hook. A pencil-sketched note beside it says **"Want to play hooky?"** with a scribbled arrow pointing at the worm.
- The worm gently sways on its own. Tap or click it and it wiggles, squirms and bounces (with a little splash of pencil lines), then the tutorial opens.
- Everyone can use it any time — the worm stays in the Vault for all users. New users see it open automatically the first time, replacing the current setup walkthrough.
- Name: **"Play Hooky — Easy Peezy Getting Started"** (short label: "Play Hooky").

## The tutorial (6 short, skippable steps)
Each step has a pencil-sketch illustration with light animation, a one-line headline, two lines of plain explanation, and Back / Next / Skip. A progress row of little worms fills in as you go.
1. **Welcome** — the worm wriggles off the hook and waves. "Easy peezy, lemon squeezy."
2. **The Vault** — books dropping onto a sketched shelf. "Drop a PDF or EPUB here."
3. **Read** — a page with a highlighter sweeping a sentence. "Open a book, highlight what matters."
4. **Talk to the AI** — speech bubbles popping between worm and book. "Ask anything about your books."
5. **Neurons (your brain)** — little sparks linking notes together. "Your notes, organized and remembered."
6. **Connect your AI** — keeps the existing AI-key connection step, so nothing from today's setup is lost. Ends with a "Upload my first book" button that takes you straight to the upload spot.

## Behavior
- Still waits for the privacy acceptance before opening.
- Remembers if you finished or skipped; never auto-opens twice.
- Settings' "Run setup" button opens the new tutorial instead.
- Respects reduced-motion settings (shows still drawings instead of animations).
- Matches the current theme colors.

## Technical details
- New `HookyWorm` (hook + line + pencil note, SVG + CSS keyframes) placed in the Vault header area; new `HookyTutorial` dialog with inline SVG illustrations animated via CSS/framer-free keyframes added to `index.css` using theme tokens.
- Reuse SetupWizard's AI-key step as step 6; SetupWizard's auto-open moves to the new tutorial (same done-flag key so existing users aren't re-prompted). `openSetupWizard` re-exported to open the new tutorial.
- No backend changes.
