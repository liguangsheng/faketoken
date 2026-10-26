import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// Enough to page through; past it the count reads "2000+" and the rest of the
// body is left unmarked rather than stalling the tab.
export const MAX_HITS = 2000;

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Painted through the CSS Custom Highlight API: the text is never rewrapped in
// marks, which on a multi-megabyte body would mean rebuilding the whole DOM on
// every keystroke. Browsers without it still get the count and the jumps.
const registry = (): HighlightRegistry | undefined =>
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : undefined;

/** The nearest ancestor that scrolls, or null for the page itself. */
const scrollParent = (node: Element | null): Element | null => {
  for (let el = node?.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
};

// A chunk below the fold is not laid out (content-visibility), so its text has
// no position until it is: bring the element in first, then centre the match.
const reveal = (range: Range) => {
  const host = range.startContainer.parentElement;
  if (!host) return;
  host.scrollIntoView({ block: "nearest" });
  requestAnimationFrame(() => {
    const rect = range.getBoundingClientRect();
    const parent = scrollParent(host);
    if (parent) {
      const box = parent.getBoundingClientRect();
      parent.scrollTop += rect.top - box.top - box.height / 2 + rect.height / 2;
    } else {
      window.scrollBy({ top: rect.top - window.innerHeight / 2 + rect.height / 2 });
    }
  });
};

/**
 * Finds a query in the text under root, marks every hit and steps through
 * them. `version` is whatever changes when the text under root does: a new
 * body, a different view, a part unfolded to show a hit.
 */
export function useTextSearch(root: RefObject<HTMLElement | null>, query: string, version: unknown) {
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const hits = useRef<Range[]>([]);
  // Read by step, which must not wait for a render to know where it is.
  const at = useRef(0);
  at.current = current;

  useEffect(() => {
    const highlights = registry();
    highlights?.delete("log-search");
    highlights?.delete("log-search-current");
    hits.current = [];
    const el = root.current;
    if (!el || !query) {
      setCount(0);
      setCurrent(0);
      return;
    }

    const pattern = new RegExp(escapeRegExp(query), "gi");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const found: Range[] = [];
    for (let node = walker.nextNode(); node && found.length < MAX_HITS; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m && found.length < MAX_HITS; m = pattern.exec(text)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        found.push(range);
      }
    }
    hits.current = found;
    setCount(found.length);
    setCurrent(0);
    if (highlights && found.length) highlights.set("log-search", new Highlight(...found));
    if (found.length) reveal(found[0]);
  }, [root, query, version]);

  useEffect(() => {
    const range = hits.current[current];
    const highlights = registry();
    highlights?.delete("log-search-current");
    if (range && highlights) highlights.set("log-search-current", new Highlight(range));
  }, [current, count]);

  // Leaving the drawer must not leave marks behind on whatever opens next.
  useEffect(
    () => () => {
      registry()?.delete("log-search");
      registry()?.delete("log-search-current");
    },
    [],
  );

  const step = useCallback((delta: number) => {
    const n = hits.current.length;
    if (!n) return;
    const next = (at.current + delta + n) % n;
    setCurrent(next);
    reveal(hits.current[next]);
  }, []);

  return { count, current, next: () => step(1), prev: () => step(-1) };
}
