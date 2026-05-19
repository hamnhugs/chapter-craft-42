## Memory System Guide Page

Add a dedicated route and page that explains the wiki memory system in plain language, linked from the Wikis library.

### 1. New Route: `/memory-guide`

Add a new route in `App.tsx` (HashRouter) for `/memory-guide`. Render it inside `ProtectedRoute` so it requires auth, but render it *outside* the main `AppProvider`/`ChatProvider` shell since it is a standalone informational page. Include a simple back-navigation header.

### 2. New Page: `src/pages/MemoryGuide.tsx`

Create a clean, editorial-style page that explains the five memory layers using everyday analogies:

- **Working Memory** → "Your desk" — temporary, holds what you're actively looking at right now. Clears when you leave.
- **Episodic Memory** → "A diary" — a log of every conversation you've had with the AI. Lets you pick up where you left off.
- **Semantic Memory** → "A filing cabinet with webs" — facts, concepts, and people stored as cards that are linked together. The AI can jump from card to card to answer questions.
- **Procedural Memory** → "Recipe cards" — step-by-step instructions and how-to knowledge.
- **Consolidation / Sleep Cycle** → "Night cleanup crew" — a background process that finds lonely cards, links them to neighbors, and resolves contradictions so the wiki stays tidy.

Also explain in simple terms:
- What a **wiki** is (a themed bucket for your cards)
- What **entries** are (individual cards with facts)
- What the **memory graph** is (the web of links between cards)
- What **conflicts** are (when two cards disagree)
- What **vibrancy** means (how recently/often a card was used — popular cards stay bright)

Tone: friendly, encouraging, no jargon. Use short paragraphs and visual sections.

### 3. Link from `WikiLibrary.tsx`

Insert a small text link in the Wikis page header area (next to the "New Wiki" button, or below the quote line) labeled "How the memory system works". Use React Router `<Link to="/memory-guide">`.

### 4. Design

- Match the app's editorial aesthetic: warm cream/amber tones, `font-headline` for section titles, `font-body` for body text.
- Use the existing color tokens (surface-container, primary-container, etc.).
- Add a simple sticky top bar with a back arrow and "Back to Wikis" link.

### Technical notes
- No backend changes needed.
- No new dependencies needed.
- Keep the page static/read-only; no state or data fetching.
