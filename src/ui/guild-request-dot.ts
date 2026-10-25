/**
 * A red dot on the way to a guild's join requests while any wait: the Guilds button, the chat button, the Guild
 * channel and its Requests tab. Only a President or Vice President is ever sent requests, so only they see it.
 * Targets are looked up on each render, as the Guilds button is built after chat.
 */
export function createGuildRequestDot(targets: readonly { find: () => HTMLElement | null | undefined; className: string }[]) {
  const dots = new Map<HTMLElement, HTMLElement>();
  let shown = false;
  return {
    render(waiting: number) {
      const show = waiting > 0;
      for (const target of targets) {
        const element = target.find();
        if (!element || dots.has(element)) continue;
        const dot = element.ownerDocument.createElement("span");
        dot.className = target.className;
        dot.hidden = true;
        dot.setAttribute("aria-hidden", "true");
        element.classList.add("has-guild-request-dot");
        element.append(dot);
        dots.set(element, dot);
        shown = !show;
      }
      if (show === shown) return;
      shown = show;
      for (const dot of dots.values()) dot.hidden = !show;
    },
  };
}
