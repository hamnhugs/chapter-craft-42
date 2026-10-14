/**
 * When the chat shows the DesignCraft template picker (TemplatePickerCard).
 *
 * The card appears when the craft tool lists templates (use_template with no
 * name), and also when the user's message plainly asks for their saved
 * templates but the reply neither listed nor used one — the picker is the
 * answer either way, so it doesn't depend on the model choosing to call.
 */

/** "Save this as a template", "turn page 2 into a template" — saving, not picking. */
const SAVING = /\b(save|store|keep|turn|make)\b[^.?!\n]{0,40}\b(as|into)\s+(a\s+|my\s+|the\s+)?(new\s+)?template\b/i;

/** Asks to see or pick from their saved templates. "Template" alone isn't
 *  enough: in a writing app "a query letter template" means something else, so
 *  it has to be theirs (my/our/saved), or about DesignCraft or a layout. */
const PICKING = [
  /\b(my|our|saved)\s+(\w+\s+){0,2}templates?\b/i,
  /\btemplates?\s+(i|we)\s+(saved|made)\b/i,
  /\b(designcraft|layouts?)\b[^.?!\n]{0,60}\btemplates?\b/i,
  /\btemplates?\b[^.?!\n]{0,60}\b(designcraft|layouts?)\b/i,
];

export function wantsTemplatePicker(text: string): boolean {
  const t = String(text || "");
  if (!/\btemplates?\b/i.test(t) || SAVING.test(t)) return false;
  // It names one ('Use my "Movie Night" template'): nothing to pick.
  if (/["“][^"”]{1,80}["”]\s+templates?\b/i.test(t)) return false;
  return PICKING.some((re) => re.test(t));
}

/** What the picker sends when a template is picked. */
export const useTemplateMessage = (name: string) => `Use my "${name}" template.`;
