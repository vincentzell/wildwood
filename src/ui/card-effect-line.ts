/**
 * A card effect's text into an element, its "[40%×3]" stacking note dimmed so the total reads first
 * (card-text.ts cardEffectText). Plain text otherwise.
 */
export function fillCardEffect(element: HTMLElement, text: string) {
  const doc = element.ownerDocument;
  element.replaceChildren();
  let last = 0;
  for (const match of text.matchAll(/ \[[^\]]+×\d+\]/g)) {
    element.append(doc.createTextNode(text.slice(last, match.index)));
    const note = doc.createElement("span");
    note.className = "card-effect-stack";
    note.textContent = match[0];
    element.append(note);
    last = match.index! + match[0].length;
  }
  element.append(doc.createTextNode(text.slice(last)));
  return element;
}
