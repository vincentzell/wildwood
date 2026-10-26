/**
 * A modal dialog (the Trade Chrysanthemum, the Smith, the sellers, Ox, the mailbox) is drawn above everything in the
 * page, whatever its z-index. Something that opens over one (a prompt, the item window) moves inside the topmost
 * one so it shows on top, and back to where it came from when none is open.
 */
const homes = new WeakMap<Element, Element>();

export function raiseAboveModals(element: HTMLElement, root: Document = element.ownerDocument) {
  if (!homes.has(element) && element.parentElement) homes.set(element, element.parentElement);
  let host: Element | undefined;
  // A dialog already holding it still counts: a second prompt over the same window stays inside it, not behind it.
  try { host = [...root.querySelectorAll("dialog[open]")].filter(dialog => dialog.matches(":modal") && dialog !== element && !element.contains(dialog)).at(-1); }
  catch { /* no :modal: it stays where it is */ }
  host ??= homes.get(element) ?? root.body;
  if (element.parentElement !== host) host.append(element);
}
