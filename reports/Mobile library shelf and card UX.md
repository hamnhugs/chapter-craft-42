# Pin the add button, tame the tap

Both Library problems have well-supported fixes, and the second one is mostly a code defect, not a design question. For shelves, keep the scrolling deck-tab row as a shortcut to a few shelves, move "New shelf" out of the scroller so it is pinned at the row's edge, and add an always-visible "All shelves" control that opens a vertical, filterable list in a bottom sheet. Every design-system and usability source read treats a horizontal row as acceptable only for a small prioritised set, and no leading reading or media app reviewed uses one long row as the only route to a collection or puts "create" at the end of it. For cards, the popup opens during scrolling because the book card is a Radix `DropdownMenu` trigger, which opens on `pointerdown` for touch and is modal by default. That combination fires at finger contact and then sets `pointer-events: none` on the body and locks scroll. Switching to a click-triggered, non-modal layer removes both the accidental opening and the blocking. Guidance from Apple, NN/g and Baymard goes further and says a single tap should perform the primary action (Read) with secondary actions on a visible control, but no study compares that against a tap-to-choose popup. The main limits of this research are that Material 3's guideline pages could not be read, single-tap behaviour in most apps is undocumented, and several iOS behaviours need testing on a real phone.

## A scrolling tab row serves the first few shelves, not the twentieth

The research agrees on what a horizontally scrolling row is good for. People swipe such rows readily, but they are poor at revealing what is off-screen and poor for reaching deep items. NN/g's carousel guidance says users should reach the last item in **3–4 swipes**, that users often stop after 3–4 pages, and that "if you have a high number of items, use a list view instead" ([NN/g](https://www.nngroup.com/articles/mobile-carousels/)). Its 2024 tabs article, last reviewed in September 2026, says overflowed tabs become a carousel where hidden tabs are less discoverable and cost more interaction, and gives no maximum beyond "the fewer tabs, the better" ([NN/g](https://www.nngroup.com/articles/tabs-used-right/)). Baymard, updated July 2026, found test participants missing horizontal tabs even while looking for them, and says tabs should not require horizontal scrolling to reveal ([Baymard](https://baymard.com/research-articles/avoid-horizontal-tabs)). Apple's Human Interface Guidelines say an overflow "More" tab "makes it harder for people to reach and notice content on tabs that are hidden" and recommend **about five segments on iPhone** for a segmented control ([Apple HIG, Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars.md); [Apple HIG, Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls.md)).

With roughly three deck tabs visible at phone width, the 3–4 swipe rule puts anything past about the ninth to twelfth shelf out of practical reach. That figure is an inference from NN/g's rule, not a measured threshold. The same logic explains the add button: a control placed after every shelf inherits the worst position in the row.

The row itself is still defensible. Baymard found horizontal scrolling of homogeneous swatch rows "performed best for most participants", provided the last visible item is **deliberately cut off** to signal more. Small "+7"-style counters were overlooked ([Baymard](https://baymard.com/blog/mobile-interactive-color-swatches)). NN/g calls cut-off content "a strong carousel cue" and dots weak ones ([NN/g](https://www.nngroup.com/articles/mobile-carousels/)). No source measured edge fades against cut-off items, so a fade is a supplement at best. All of this evidence is qualitative and mostly from e-commerce. No study of chip or tab rows in personal libraries was found.

Leading apps point the same way. Among those reviewed, the horizontal row holds a small fixed set of types or pins, and the unbounded set of user collections lives in a vertical list or grid. Three apps independently cap a pinned area and list the rest: Apple Music allows **six pins** in iOS 26 ([MacRumors](https://www.macrumors.com/how-to/use-ios-new-music-pins-feature/)), Spotify is reported to allow four ([Spotify Community](https://community.spotify.com/t5/Your-Library/New-Your-Library-view-iOS-amp-Android/td-p/5196161)), and Google Photos' October 2026 redesign opens Collections with an editable Pinned section followed by carousels that each carry a "View all" link ([9to5Google](https://9to5google.com/2026/10/26/google-photos-collections-redesign/)). Libby gives tags their own top-level screen ([Libby Help](https://help.libbyapp.com/6011.htm)). Play Books and Kobo put shelves and collections in a dedicated list ([Google Play Help](https://support.google.com/googleplay/answer/9402600); [Kobo Help](https://help.kobo.com/hc/en-us/articles/360017865173-Organize-your-eBooks-and-audiobooks-on-your-Kobo-Books-app-for-iOS)).

The deck-tab metaphor comes from Clash Royale, which has a fixed **10 deck slots** ([Supercell](https://supercell.com/en/games/clashroyale/blog/release-notes/summer-update-is-here-2)). A fixed-slot game never has to solve "find one among dozens" and has no "add deck" button to place. Both Library problems follow from applying that design to an unlimited number of shelves.

## Pin "New shelf" outside the scroller and add an "All shelves" sheet

**Create belongs at a fixed position.** Material documents the floating action button's first use case as "create new item" ([Android Developers](https://developer.android.com/develop/ui/compose/components/fab)). Apple places Add and Compose in persistent toolbars and says not to mix actions into a control that represents selection ([Apple HIG, Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields.md); [Apple HIG, Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls.md)). In every app sourced, create sits in a fixed spot: a "+" in the top bar in Apple Music ([MacRumors](https://www.macrumors.com/how-to/ios-use-folders-manage-apple-music-playlists/)), "Create New" at the head of the Play Books shelves list ([Google Play Help](https://support.google.com/googleplay/answer/9402600)), "Add Collection" in Kobo ([Kobo Help](https://help.kobo.com/hc/en-us/articles/360017865173-Organize-your-eBooks-and-audiobooks-on-your-Kobo-Books-app-for-iOS)), and a floating button in YouTube Music ([9to5Google](https://9to5google.com/2023/01/10/youtube-music-library-redesign-final/)). No design-system text addresses a pinned add button beside a scrolling tab row specifically, so the placement below is reasoned from these rules.

The recommendation is a compact "+" pinned at the trailing edge of the row, outside the scroll container and visually distinct from the tabs. A floating action button is the weaker choice here: it is reserved for a screen's single primary action, and Spotify's 2025 move of Create into the bottom bar drew sustained complaints about accidental taps ([Spotify Community](https://community.spotify.com/t5/Implemented-Ideas/Mobile-Get-rid-of-Create-button-on-mobile-navigation-bar/idi-p/6453037)). Size the button at **44×44 CSS px**, which meets Apple's hit-region figure and the WCAG 2.2 enhanced target size. The WCAG AA floor is 24×24 ([Apple HIG, Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons.md); [W3C](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)).

**Add a second path to the full set.** Next to the pinned "+", place an "All shelves" button that opens a bottom sheet listing every shelf vertically, with "New shelf" repeated as its first row. This is Apple's "More" pattern with its documented cost reduced, because the row's shelves are duplicated in the sheet, not relocated. Baymard observed the same duplication working at Target ([Baymard](https://baymard.com/blog/promoting-product-filters)). The sheet should follow these rules:

| Rule | Source |
|---|---|
| Visible Close button; do not rely on the grab handle | [NN/g](https://www.nngroup.com/articles/bottom-sheet/) |
| Phone Back gesture closes the sheet | [NN/g](https://www.nngroup.com/articles/bottom-sheet/) |
| Swipe down to dismiss, grabber shown, medium height first | [Apple HIG, Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets.md) |
| One sheet at a time, never stacked | [Apple HIG, Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets.md) |
| Inline filter field that filters as the person types | [Apple HIG, Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields.md) |

No authoritative count exists for when to add the filter field. Showing it once the list exceeds roughly one sheet-height of rows, around 10–20 shelves, is a judgement call. NN/g warns against sheets for lengthy content, so many dozens of shelves would justify a full page instead.

**Keep likely targets in the visible slots.** NN/g says to put high-use items first ([NN/g](https://www.nngroup.com/articles/tabs-used-right/)). Automatic most-recent ordering moves tabs around, which works against muscle memory. User pinning has direct Apple precedent ("let people customize the tab bar") and matches the Apple Music and Google Photos redesigns ([Apple HIG, Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars.md)). Marvel Snap's January 2026 change, which previews deck contents in the deck selector to make "picking a deck easier and faster", suggests a small cover or count on each tab also helps people tell shelves apart ([Marvel Snap](https://marvelsnap.com/?p=91750)).

### Building the row and the sheet

Every CSS piece needed is supported in current mobile Chrome and Safari: scroll snap, `scroll-margin`, `scrollbar-width: none` (Safari 18.2+, with the `::-webkit-scrollbar` rule for older versions) and `mask-image` for fades ([BCD scroll-snap-type](https://github.com/mdn/browser-compat-data/blob/main/css/properties/scroll-snap-type.json); [BCD scrollbar-width](https://github.com/mdn/browser-compat-data/blob/main/css/properties/scrollbar-width.json); [BCD mask-image](https://github.com/mdn/browser-compat-data/blob/main/css/properties/mask-image.json)). The simplest robust layout takes the buttons out of the scroller entirely, so they are untouched by snapping and fading:

```tsx
<div className="flex items-center gap-2">
  <div role="tablist" className="cc-deck-tabs flex-1 min-w-0 overflow-x-auto snap-x snap-proximity">
    {/* shelf tabs, each snap-start */}
  </div>
  <button aria-label="All shelves" className="size-11 shrink-0">…</button>
  <button aria-label="New shelf" className="size-11 shrink-0">+</button>
</div>
```

`position: sticky; right: 0` inside the scroller is the alternative. No source documents it failing on iOS, but none confirms it either, and a mask on the scroller would also fade the sticky button. Treat it as untested.

To bring the active tab into view, compute the offset and call `scrollTo` on the row, not `scrollIntoView`:

```ts
row.scrollTo({ left: tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2, behavior: "smooth" });
```

WebKit bug reports describe smooth `scrollIntoView` inside a scroll-snap container snapping back on iOS, with `scrollTo` reported as the workaround ([WebKit bug 245722](https://bugs.webkit.org/show_bug.cgi?id=245722); [WebKit bug 262287](https://bugs.webkit.org/show_bug.cgi?id=262287)). These bug pages were seen only as search summaries and their current status is unverified. Note also that `overscroll-behavior` has no effect in Safari on a row that does not actually overflow ([BCD overscroll-behavior](https://github.com/mdn/browser-compat-data/blob/main/css/properties/overscroll-behavior.json)).

For the sheet, **Vaul is no longer a safe choice**. Its README says the repo is unmaintained and its last release was December 2024 ([Vaul](https://github.com/emilkowalski/vaul); [npm](https://registry.npmjs.org/vaul)). shadcn/ui's Drawer now uses Base UI instead ([shadcn/ui](https://ui.shadcn.com/docs/components/base/drawer)). Base UI's Drawer offers snap points, a three-way `modal` prop and a virtual-keyboard helper ([Base UI](https://base-ui.com/react/components/drawer)). Its React 18 compatibility was not verified, so check `peerDependencies` first. The no-new-dependency route is the Radix `Dialog` already installed, fixed to the bottom of the screen. It gives focus handling and outside or Escape dismissal but no drag gesture.

The keyboard is the main hazard for the filter field. On iOS Safari and Chrome for Android 108+, the on-screen keyboard resizes only the visual viewport, so a `position: fixed; bottom: 0` sheet and `dvh` units do not move out of its way ([Chrome for Developers](https://developer.chrome.com/blog/viewport-resize-behavior)). Size the sheet from `window.visualViewport`, which both engines support ([BCD VisualViewport](https://github.com/mdn/browser-compat-data/blob/main/api/VisualViewport.json)), or use Base UI's `Drawer.VirtualKeyboardProvider`. Putting the field at the top of the sheet and not auto-focusing it on open avoids most of the problem.

## The popup opens on finger contact and then freezes the page

The book card in `/home/hamnhugs/Work/chapter-craft-42/src/components/LibraryDeck.tsx` (lines 138–208) wraps the whole card button in a Radix `DropdownMenuTrigger`. Radix's source shows that trigger opening on `onPointerDown` with no pointer-type check ([Radix dropdown-menu.tsx](https://github.com/radix-ui/primitives/blob/main/packages/react/dropdown-menu/src/dropdown-menu.tsx)). `pointerdown` fires when the finger lands, before the browser has decided whether the gesture is a tap or a scroll. Radix's own `Select` component avoids exactly this: it opens on pointerdown for mouse only, with the source comment that touch "would open the menu on scroll" ([Radix select.tsx](https://github.com/radix-ui/primitives/blob/main/packages/react/select/src/select.tsx)).

The blocking comes from the default `modal = true`. A modal Radix menu traps focus, wraps content in `react-remove-scroll`, and sets `body.style.pointerEvents = 'none'`. The source states the consequence: "users will need to click twice on outside elements" ([Radix menu.tsx](https://github.com/radix-ui/primitives/blob/main/packages/react/menu/src/menu.tsx); [Radix dismissable-layer.tsx](https://github.com/radix-ui/primitives/blob/main/packages/react/dismissable-layer/src/dismissable-layer.tsx)). Radix `Popover`, by contrast, opens on `click` and defaults to non-modal ([Radix popover.tsx](https://github.com/radix-ui/primitives/blob/main/packages/react/popover/src/popover.tsx)). This was read from Radix's main branch, not the installed 2.1.15 tag, though both defaults are long-standing.

`click` is the right event because the browser withholds it when a touch becomes a scroll, signalling `pointercancel` instead ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)). WebKit tests also assert no click is delivered for a tap that interrupts momentum scrolling ([WebKit](https://webkit.googlesource.com/WebKit/+/43711d90c99db109e366d04cd30de99d008948e6/LayoutTests/fast/scrolling/ios/click-events-during-momentum-scroll-in-overflow.html)). Activating on the up-event is also what WCAG 2.2's pointer cancellation criterion asks for ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html)). Chrome for Android's behaviour for a tap that stops a fling was not confirmed.

Three fixes are available, from most to least complete:

| Fix | Stops opening while scrolling | Stops blocking | Change |
|---|---|---|---|
| Replace the card menu with Radix `Popover` | Yes | Yes | Swap primitive; lose menu keyboard roving |
| Keep `DropdownMenu`, controlled, `modal={false}`, open on click | Yes | Yes | A few lines |
| `modal={false}` only | No | Yes | One prop |

The middle option keeps the current styling and menu semantics:

```tsx
const [open, setOpen] = useState(false);
<DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
  <DropdownMenuTrigger asChild>
    <button
      onPointerDown={(e) => e.preventDefault()}  // skips Radix's pointerdown open
      onClick={() => setOpen((o) => !o)}
      style={{ touchAction: "manipulation" }}
    >…</button>
  </DropdownMenuTrigger>
```

A community discussion reports the same technique working ([Radix discussion 3104](https://github.com/radix-ui/primitives/discussions/3104)). Two follow-on behaviours need a decision. A non-modal layer lets an outside tap both dismiss the menu and activate what is under the finger, so decide whether tapping another card should only dismiss. A non-modal menu also stays anchored while the page scrolls; add a scroll listener that closes it if that looks wrong. As a further guard for slow flings on Android, ignore card clicks within about 150 ms of the last scroll event. That figure is a judgement, not a sourced value.

## Guidance says one tap should read the book

Fixing the trigger removes the symptom. The design guidance questions whether the chooser should exist on tap at all. Apple says to "present content modally only when there's a clear benefit" and to avoid popovers in compact views ([Apple HIG, Modality](https://developer.apple.com/design/human-interface-guidelines/modality); [Apple HIG, Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers)). NN/g reserves modals for critical warnings and required input, and its November 2025 contextual-menu guidelines say not to hide "essential, high-frequency actions behind an extra tap" and to avoid menus for one or very few actions ([NN/g](https://www.nngroup.com/articles/modal-nonmodal-dialog/); [NN/g](https://www.nngroup.com/articles/contextual-menus-guidelines/)). Baymard calls an intent-confirming step "a tax that's levied on all users" and names reversibility the ideal strategy, noting that for navigation the Back button is a free undo ([Baymard](https://baymard.com/blog/handling-accidental-taps-on-touch-devices)).

Applied here, a tap on a card opens the book, and Info moves to a small visible button on the card. Long press can duplicate the secondary actions but cannot be the only route. Apple says context-menu items must also be available in the main interface ([Apple HIG, Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)), iOS Safari does not fire `contextmenu` ([BCD Element](https://github.com/mdn/browser-compat-data/blob/main/api/Element.json)), and Radix's own long press is a 700 ms timer ([Radix context-menu.tsx](https://github.com/radix-ui/primitives/blob/main/packages/react/context-menu/src/context-menu.tsx)).

Three cautions apply before adopting direct open. First, **the evidence is guidance, not measurement**: no study comparing "tap opens item" with "tap opens a chooser" was found, and single-tap behaviour in Kindle, Apple Books, Kobo and most other apps could not be sourced. Where secondary actions are documented, they sit on long press or a "more" button. Second, **direct open is only safe if Back restores the Library exactly**, meaning the same shelf tab, scroll position and row offset. Otherwise an accidental open costs more than today's popup. This is an inference from the Back-button guidance. Third, **the card has a third action in shelf-filling mode**: "Add to shelf" appears alongside Info and Read when a shelf is open. Tap-to-toggle with a visible check mark fits that mode better than either a chooser or direct open.

If a chooser is kept, the sources favour a small non-modal bottom sheet over a floating popup at phone width.

## Which newer platform features to use now

Most of the 2025–2026 CSS additions are optional for these two fixes. The table shows what is safe on phones today. Version data is from MDN's browser-compat-data, read 13 November 2026.

| Feature | iOS Safari | Chrome | Verdict |
|---|---|---|---|
| `@starting-style` entry animations | 17.5 | 117 | Use freely |
| Same-document View Transitions | 18.0 | 111 | Use freely |
| Native `popover` attribute | 17 | 114 | Usable; non-blocking by design |
| Anchor positioning | 26.0 | 125 | Needs fallback for iOS 18 |
| Scroll-driven animations (edge fades) | 26.0 | 115 | Needs fallback for iOS 18 |
| `scrollend` event | 26.2 | 114 | Needs timeout fallback |
| `<dialog closedby>` | Not in stable | 134 | Do not rely on |
| Scroll-state queries, CSS carousel buttons | No | 133 / 135 | Android-only enhancement |

Sources: [BCD @starting-style](https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/starting-style.json); [BCD view-transition-name](https://github.com/mdn/browser-compat-data/blob/main/css/properties/view-transition-name.json); [BCD global attributes](https://github.com/mdn/browser-compat-data/blob/main/html/global_attributes.json); [BCD anchor-name](https://github.com/mdn/browser-compat-data/blob/main/css/properties/anchor-name.json); [BCD animation-timeline](https://github.com/mdn/browser-compat-data/blob/main/css/properties/animation-timeline.json); [BCD Element](https://github.com/mdn/browser-compat-data/blob/main/api/Element.json); [BCD dialog](https://github.com/mdn/browser-compat-data/blob/main/html/elements/dialog.json); [BCD @container](https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/container.json); [Chrome for Developers](https://developer.chrome.com/blog/carousels-with-css).

Radix's existing positioning works on every iOS version, so CSS anchor positioning adds nothing here. The share of this app's users on iOS 18 or older is unknown, and that share decides how far the iOS 26+ features can be trusted.

## Conclusion

The two problems share a cause: a pattern built for a small fixed set (ten deck slots, a card that cannot be "opened") was applied to an unbounded shelf list and to books that have an obvious primary action. The fixes therefore do not require abandoning the deck look. The row stays as a pinned-first shortcut, and the list, the add button and the tap behaviour take over the jobs the row and popup were never suited to.

The order of work matters. The controlled, click-triggered, non-modal menu is a few lines and removes the worst symptom immediately, so it should ship first. The pinned "+" and "All shelves" sheet follow. Whether tap should read directly is the one decision the evidence leans on but does not settle, and it depends on Back restoring the Library exactly. Three items need a real phone before they are trusted: the tab-centring scroll on iOS, the sheet's behaviour with the keyboard open, and whether Chrome for Android still delivers a click for a tap that stops a slow fling.
