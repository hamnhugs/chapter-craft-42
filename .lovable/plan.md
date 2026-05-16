# Restore Auto Chapterizer

The `AutoChapterize` component was removed from the codebase. It still exists in git history (latest version at commit `dea6e8b`, 890 lines, last touched 2026-05-07). I'll restore it and re-wire the tab.

## Steps

1. **Recover the component** — write `src/components/AutoChapterize.tsx` from the saved git version (890 lines, all logic intact: TOC mode, anchor detection, PDF outline parsing, etc.).

2. **Add a "Chapterize" tab** to `src/pages/Index.tsx`:
   - Add `{ id: "chapterize", icon: "auto_fix_high", label: "Chapterize" }` to the `tabs` array (placed between Reader and Chat).
   - Add the render branch: `activeTab === "chapterize" ? <AutoChapterize /> : ...`.
   - Import `AutoChapterize`.

3. **Extend the tab union type** in `src/context/AppContext.tsx`:
   - Add `"chapterize"` to the `activeTab` literal union (and the `setActiveTab` signature).

4. **Verify** — read the restored file to confirm imports resolve against current `useApp`, `addChapter`, etc. (no schema changes expected; `chapters` table is unchanged).

## Notes
- No DB migration needed.
- No new dependencies.
- All existing tabs and features remain untouched.
