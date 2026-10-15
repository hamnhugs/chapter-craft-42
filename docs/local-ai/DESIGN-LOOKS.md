# Page looks: how Counsel designs in DesignCraft

Asked for a flyer, poster or cover, Counsel puts the words and the picture on the
page by **role** (headline, subhead, image, body, caption, footer) and picks a
**look**. The look is a designer's recipe, written down in
`scripts/local-ai/design-looks.mjs`. It sets the fonts, the type scale, the grid,
a palette taken from the picture, and the details pros add: full-bleed photos,
fades under type, colour blocks, rules and tracked small caps. The bridge measures,
places and checks everything. The model never handles coordinates.

| Look | What it is | For |
|---|---|---|
| `editorial` (default) | warm paper, a big Playfair Display Black headline flush left, framed photo, hairline rules, italic caption | articles, newsletters, most flyers |
| `bold` | the photo bleeds off the top into a deep colour block, huge Anton caps, an accent rule, a tracked label | events, promos |
| `cinematic` | the photo fills the page and fades to near-black, with spaced Cinzel capitals centred and a credit line | book covers, movie-style posters |
| `swiss` | a six-column grid, a giant tight Inter Tight Black headline, the photo across four columns, small text in two, one accent, a heavy foot rule | modern, business, talks |
| `classic` | cream stock, a double rule border, everything centred in Cormorant/EB Garamond, a rule–diamond–rule ornament | literary, invitations, awards |
| `minimal` | wide margins, Inter Light, a small off-centre photo, one accent dot | calm, premium |
| `split` | photo on one half, a colour panel on the other with DM Serif Display | announcements, launches |
| `pop` | the picture's most vivid colour as the field, Archivo Black caps, a tilted rounded photo with a shadow, a pill tag | kids, sales, fun |
| `direct` | Ogilvy's direct-response ad: the photo bleeds across the top, a selling caption under it, a Libre Baskerville headline *below* the picture (upper and lower case, dark on light), an italic deck, Lora body in 1–3 columns, and a ruled response box with the call to action at the foot | ads that sell, offers, book promotions, advertorials |

From the chat: `craft send {app: designcraft, look: "cinematic"}` restyles the whole
page, and a look can also ride along with any part. "Make it look amazing" is now
treated as a clear request: the tool card no longer counts taste as a reason to ask.
The result always carries `look` and `looks` (every look and what it is for), so the model can offer another one.
Hand-set changes such as "make the headline red" are kept in the part's name
(`Headline · color #E63946`), and every later layout keeps them.

New page sizes besides DesignCraft's own: `Poster` (18×24 in), `Square`, `Story`
(9:16), `Instagram` (4:5) and `Book` / `Book cover` (6×9 in).

## Why it's built this way (the research)

- **Models are bad at coordinates.** On content-aware layout, even GPT-5 fails to keep
  text off the important parts of an image. A base Qwen-7B gets alignment 0.32 and a
  collision rate of 0.69 on CGL, and RL fine-tuning only gets that to 0.60 and 0.43
  ([LLMs as Layout Designers, arXiv 2509.16891](https://arxiv.org/html/2509.16891)). A
  4B local model can't hold a type scale either. So the model chooses and writes, and
  code places. This is the slot-then-check shape of
  [PosterMELD (arXiv 2608.02218)](https://arxiv.org/pdf/2608.02218), and of how
  [Canva's Magic Design](https://www.canva.com/help/use-magic-design/) adapts templates
  to content instead of drawing from scratch.
- **Style knowledge is written down from real designs, not left to the model's
  general taste.** VLMs' idea of a style is "overly broad", while designers' is concrete
  shape and colour choices
  ([PRISM, arXiv 2601.11747](https://arxiv.org/abs/2601.11747)). Each look here is one
  such concrete recipe.
- **Check the rendered result.** Open-loop generators leave rendering artefacts.
  [DesignAsCode (arXiv 2602.17690)](https://arxiv.org/abs/2602.17690) adds a
  visual reflect step. Here the check is DesignCraft's own line breaks. Text is set,
  DesignCraft's line count is read back (it kerns, and the estimate doesn't), the page is
  planned again on the real count, and anything cut off is grown. The plan itself is
  checked for type off the page, type colliding, type on a picture without a fade, low
  contrast and type below 6.5 pt (`planIssues`).
- **Hierarchy comes from scale contrast, not from more fonts.** Guides agree on one
  dominant element, a headline about 3-4× body size or more, and one or two families
  ([4OVER4 hierarchy guide](https://www.4over4.com/guide/guide-to-hierarchy-in-graphic-design),
  [Made Good Designs](https://madegooddesigns.com/poster-design-principles/)). Every
  look pairs one display face with one text face. Headlines are fitted as large as the
  measure allows without breaking a word (`fitSize`, measured from the font files' own
  advance widths). Display type gets tight leading (0.9-1.05) and tight or negative
  tracking. Small labels get wide tracking (+160 to +380) in caps.
- **Thumbnail-first, bold type.** 2026 cover trends: titles take most of the cover
  (sometimes 70-80%), condensed faces suit thrillers, and pale, bland type is out
  ([Damonza 2026](https://damonza.com/6-book-cover-design-trends-for-2026/),
  [Greenleaf 2026](https://greenleafbookgroup.com/learning-center/book-creation/2026-cover-design-trends)).
  This is what `cinematic` and `bold` do.
- **Swiss / International style.** It uses an asymmetric grid, flush-left ragged-right
  sans and objective photography
  ([overview](https://ecampusontario.pressbooks.pub/graphicdesign/chapter/1-6-its/)).
  That is the `swiss` look.
- **Colour from the picture.** The method is k-means over the picture's pixels in a
  perceptual space, with the accent taken as the most chromatic group, as KDE's
  ImageColors does ([D29637](https://phabricator.kde.org/D29637)). The palette is in
  OKLab/OKLCH. The near-black and the paper keep a trace of the picture's own hue, so
  they belong with it. The accent comes in a light version for dark grounds and a dark
  one for light grounds, and text colours are pushed until they pass WCAG contrast
  (`readableOn`).
- **Crops keep the subject.** Full-bleed pictures are cropped toward where the eye
  goes (sharp's attention strategy, mapped to DesignCraft's nine reference points).
  So the cat's face stays in a wide crop, not its middle.
- **Copy that runs long** steps the type down, headlines faster than text, until it
  fits (`SQUEEZE` in `planLook`). It never lets type collide.

- **The direct-response ad** (`direct`, 2026-10-14). Ogilvy put the picture first because
  that's where the eye lands. Under it goes a caption that sells, since captions are read more than body
  copy, then the headline *below* the picture, then body copy in a serif, then the
  response device at the foot, where the eye ends. Ads that look like editorial pages get
  read. Wheildon's tests (disputed, but standard in direct response) favour a serif body,
  dark type on light, and lower-case headlines over all caps. With no picture, the type and the response box form one block
  centred a little high. The call to action is set in Inter because Lora has no arrows.
  Renders: `results/design-looks/plan-direct.png`, `plan-direct-nopicture.png`. Why and
  who: [COPY-CRAFT.md](COPY-CRAFT.md).

## Fonts

`scripts/local-ai/install-design-fonts.sh` (run by `install-crafts.sh`) puts 20 SIL OFL
Google Fonts families into `~/.local/share/fonts/chapter-craft` as static TTFs, one per
weight, about 85 files. DesignCraft reads that folder in the window and headless.
Without them the looks fall back to the bundled Source Sans 3 and still lay out.

## Templates, and pointing the AI at things

A page you like can be saved as a template: the whole page, with its pictures and a
screenshot. A template can start the next document, with the new words fitted into the
same frames. To point Counsel at something, click it in the DesignCraft window, or
shift-click several, before asking ("make this bigger"). The selection rides along with
the message. How both work: [CRAFTS.md](CRAFTS.md), section "Templates, and selecting
for the AI".

## Seeing and testing the looks

```bash
# Every look, same content, private headless DesignCraft → PNGs (never touches an open window)
node scripts/local-ai/design-looks-gallery.mjs <picture> <outdir> [Letter|A4|WxH] [looks,…]
GALLERY_CONTENT='{"headline":"…","subhead":"…","body":"…","footer":"…"}' node scripts/local-ai/design-looks-gallery.mjs …

npx vitest run src/test/designLooks.test.ts    # every look × 6 page sizes × with/without a picture
# The flyer session + "make it look amazing" + "now as a movie poster" through a real model: see CRAFTS.md
```

Sample renders are in `results/design-looks/`.
