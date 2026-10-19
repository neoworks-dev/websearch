// HTMLRewriter keeps one end-tag handler per element: a second `onEndTag` call replaces the
// first. Every pass in this library needs several things to happen when an element closes (a
// field ends, a heading ends, the root ends), so they are gathered here and attached once.
//
// It relies on the order HTMLRewriter runs handlers in: for each element, in the order they
// were registered. `attach` registers a catch-all handler after all the others; it sees each
// element last and hands it everything the other handlers asked for.

export class EndTags {
  private pending: (() => void)[] = [];

  /**
   * Runs `then` when `element` closes. Returns false, and never runs it, for an element without
   * an end (`<br>`, `<img>`, `<x/>`), so a caller counting open elements doesn't count those.
   *
   * The element can't be read inside `then`: copy what is needed beforehand.
   */
  onClose(element: HTMLRewriterTypes.Element, then: () => void): boolean {
    if (element.selfClosing || !element.canHaveContent) return false;
    this.pending.push(then);
    return true;
  }

  /** Must be the last handler registered on `rewriter`. */
  attach(rewriter: HTMLRewriter): HTMLRewriter {
    return rewriter.on("*", {
      element: (element) => {
        if (this.pending.length === 0) return;
        // Innermost first: the handler registered last closed its part first.
        const handlers = this.pending.reverse();
        this.pending = [];
        element.onEndTag(() => {
          for (const handler of handlers) handler();
        });
      },
    });
  }
}
