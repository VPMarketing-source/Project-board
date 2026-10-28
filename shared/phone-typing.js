/* =========================================================================
   Project Clarity — typing on a phone

   The on-screen keyboard takes about half a phone's screen. Two things made
   that worse:

     • the top bar (#pc-nav, fixed), the sync badge and the announcement
       (#pc-announce, sticky) stayed pinned, eating into the half that was
       left
     • typing further down a day cell let the caret slide under the keyboard

   While a phone is typing (an editable has focus and the keyboard has
   shrunk the visible area), <html> gets .is-typing, and the CSS below lets
   the bar and the announcement scroll away instead of pinning — no layout
   shift, they just stop following you — and empty room is added below the
   page so even its last lines can scroll up. After each keystroke, caret
   move or keyboard resize, the page scrolls just enough to keep the caret
   above the keyboard.

   Layout only. It never touches content, saving or sync. Phones only
   (<= 720px wide); desktop never gets .is-typing.
   ========================================================================= */
(function () {
  'use strict';

  const vv = window.visualViewport;
  if (!vv) return;

  const style = document.createElement('style');
  style.textContent = `
    html.is-typing #pc-nav,
    html.is-typing #planner-sync-indicator { position: absolute !important; }
    html.is-typing #pc-announce,
    html.is-typing .site-shell { position: static; }
    /* Room to scroll the last lines of the page up above the keyboard. */
    html.is-typing body::after { content: ""; display: block; height: 60vh; }
  `;
  document.head.appendChild(style);

  const narrow = () => window.matchMedia('(max-width: 720px)').matches;
  function editing() {
    const a = document.activeElement;
    return !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' ||
      (a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit)$/.test(a.type)));
  }
  // The keyboard shrinks the visual viewport but not the layout viewport.
  const keyboardOpen = () => vv.height < window.innerHeight * 0.8;

  function update() {
    document.documentElement.classList.toggle('is-typing', narrow() && editing() && keyboardOpen());
  }

  // Where the caret is, in client coordinates. A collapsed caret at the
  // start of an empty line has no rect, so fall back to its line's element.
  function caretRect() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    if (rects.length) return rects[rects.length - 1];
    let node = sel.focusNode;
    if (node && node.nodeType !== 1) node = node.parentElement;
    return node ? node.getBoundingClientRect() : null;
  }

  // Keep the caret inside the visible strip above the keyboard, with a
  // little room below it so the next line shows too.
  function keepCaretVisible() {
    if (!narrow() || !editing() || !keyboardOpen()) return;
    const r = caretRect();
    if (!r || (!r.height && !r.top)) return;
    const top = vv.offsetTop + 24;
    const bottom = vv.offsetTop + vv.height - 56;
    if (r.bottom > bottom) window.scrollBy(0, r.bottom - bottom);
    else if (r.top < top) window.scrollBy(0, r.top - top);
  }

  let queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); keepCaretVisible(); });
  }

  document.addEventListener('focusin', soon);
  document.addEventListener('focusout', () => setTimeout(update, 50));
  document.addEventListener('input', soon);
  document.addEventListener('selectionchange', () => { if (editing()) soon(); });
  vv.addEventListener('resize', soon);
})();
