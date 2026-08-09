/* =========================================================================
   Project Clarity — planner text tools

   Extracted verbatim from clients/vpm.html so every space that renders the
   planner calendar gets the same behaviour:
     1. a floating text-formatting toolbar (bold/italic/colour, checkbox
        todos, lists, section fills, notes) shown on selection in any
        [contenteditable] region, and
     2. Cmd/Ctrl+Z undo/redo history for those custom DOM edits.

   Both are self-contained IIFEs using document-level event delegation, so
   load order relative to calendar.js does not matter.
   ========================================================================= */

  /* =====================================================================
     Floating text-formatting toolbar — appears when the user selects
     text inside any contenteditable element on the page (day cells,
     week notes, key dates, etc.). Bold, italic, underline, and a
     curated swatch of colors. Uses document.execCommand for simplicity;
     the contenteditable rich-text writes survive localStorage since we
     store innerHTML.
     ===================================================================== */
  (function initFormatToolbar() {
    const COLORS = ['#11131a', '#2960ff', '#ef4444', '#16a34a', '#a86b14', '#6c6f7a'];
    // Light tints for full-width section backgrounds (Morning, Work, etc.).
    const FILLS  = ['#fef9c3', '#dcfce7', '#dbeafe', '#fee2e2', '#ede9fe', '#ffedd5'];
    const bar = document.createElement('div');
    bar.className = 'fmt-toolbar';
    bar.innerHTML = `
      <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><span class="fmt-b">B</span></button>
      <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><span class="fmt-i">I</span></button>
      <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><span class="fmt-u">U</span></button>
      <button type="button" data-cmd="strikeThrough" title="Strikethrough"><span class="fmt-s">S</span></button>
      <button type="button" data-action="clear-format" title="Remove formatting">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 7h9"/>
          <path d="M10.5 7v8"/>
          <line x1="4.5" y1="19" x2="18.5" y2="5"/>
        </svg>
      </button>
      <span class="fmt-sep"></span>
      <button type="button" data-action="checkbox" title="Checkbox todo">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3"/>
          <polyline points="8 12 11 15 16 9"/>
        </svg>
      </button>
      <button type="button" data-cmd="insertUnorderedList" title="Bullet list">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"></line><line x1="9" y1="12" x2="20" y2="12"></line><line x1="9" y1="18" x2="20" y2="18"></line><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none"></circle></svg>
      </button>
      <span class="fmt-sep"></span>
      <button type="button" data-action="font-smaller" title="Smaller text"><span style="font-size:9px;font-weight:700;letter-spacing:0">A−</span></button>
      <button type="button" data-action="font-larger"  title="Larger text"><span style="font-size:14px;font-weight:700;letter-spacing:0">A+</span></button>
      <span class="fmt-sep"></span>
      <button type="button" data-action="add-note" title="Add a note to the selected text">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="9" y1="13" x2="15" y2="13"/>
          <line x1="9" y1="17" x2="13" y2="17"/>
        </svg>
      </button>
      <span class="fmt-sep"></span>
      ${COLORS.map((c) => `<button type="button" class="fmt-swatch" data-color="${c}" style="background:${c}" title="Text colour: ${c}"></button>`).join('')}
      <span class="fmt-sep"></span>
      <span class="fmt-fill-icon" title="Section background — fills the whole line, not just the text">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="currentColor" opacity="0.85"></rect></svg>
      </span>
      ${FILLS.map((f) => `<button type="button" class="fmt-fill" data-fill="${f}" style="background:${f}" title="Section background"></button>`).join('')}
      <button type="button" class="fmt-fill fmt-fill-none" data-fill="" title="Remove section background">⊘</button>
    `;
    document.body.appendChild(bar);

    let savedRange = null;

    function inEditable() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      let node = range.commonAncestorContainer;
      if (node.nodeType === 3) node = node.parentElement;
      const ce = node.closest('[contenteditable="true"]');
      return ce ? range : null;
    }

    function positionBar(range) {
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const margin = 8;
      const barW = bar.offsetWidth;
      const barH = bar.offsetHeight;

      // Vertical: prefer above; flip below if no room at the top of the viewport.
      let top;
      if (rect.top - barH - margin < margin) {
        top = rect.bottom + window.scrollY + margin;
      } else {
        top = rect.top + window.scrollY - barH - margin;
      }

      // Horizontal: center on selection, clamp to viewport edges.
      let left = rect.left + window.scrollX + rect.width / 2 - barW / 2;
      const minLeft = window.scrollX + margin;
      const maxLeft = window.scrollX + document.documentElement.clientWidth - barW - margin;
      left = Math.max(minLeft, Math.min(left, maxLeft));

      bar.style.top  = top + 'px';
      bar.style.left = left + 'px';
    }

    function updateBar() {
      const range = inEditable();
      if (!range) {
        bar.classList.remove('is-open');
        return;
      }
      savedRange = range.cloneRange();
      bar.classList.add('is-open');
      positionBar(range);
    }

    document.addEventListener('mouseup', () => setTimeout(updateBar, 0));
    document.addEventListener('keyup', updateBar);
    document.addEventListener('selectionchange', updateBar);

    bar.addEventListener('mousedown', (e) => {
      // Prevent the click from collapsing the selection before we act
      e.preventDefault();
    });
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
      if (btn.dataset.cmd) {
        document.execCommand(btn.dataset.cmd, false, null);
      } else if (btn.dataset.color) {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('foreColor', false, btn.dataset.color);
      } else if (btn.dataset.fill !== undefined) {
        applySectionFill(btn.dataset.fill);
      } else if (btn.dataset.action === 'clear-format') {
        clearFormatting();
      } else if (btn.dataset.action === 'add-note') {
        wrapSelectionAsNote();
      } else if (btn.dataset.action === 'font-smaller') {
        adjustFontSize(-1);
      } else if (btn.dataset.action === 'font-larger') {
        adjustFontSize(+1);
      } else if (btn.dataset.action === 'checkbox') {
        insertCheckbox();
      }
      // Re-fire whatever input listener the surrounding editor wired up so the
      // change is persisted to localStorage.
      const ce = window.getSelection().anchorNode &&
                 (window.getSelection().anchorNode.nodeType === 3
                    ? window.getSelection().anchorNode.parentElement
                    : window.getSelection().anchorNode)
                  .closest('[contenteditable="true"]');
      if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Remove ALL formatting from the selection: inline styles (bold, italic,
    // underline, strikethrough, colour, size) via removeFormat, PLUS block
    // formatting — checkbox todos and bullet/numbered lists are flattened
    // back to plain lines. The text itself is always preserved. Annotations
    // (notes) are left alone; they have their own Remove control.
    function clearFormatting() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      let probe = range.commonAncestorContainer;
      if (probe.nodeType === 3) probe = probe.parentElement;
      const ce = probe && probe.closest && probe.closest('[contenteditable="true"]');
      if (!ce) return;

      // Capture block-level formatted elements the selection touches BEFORE we
      // mutate anything (removeFormat can reshuffle inline nodes).
      const blocks = [];
      ce.querySelectorAll('.pc-todo, ul, ol').forEach((el) => {
        try { if (range.intersectsNode(el)) blocks.push(el); } catch (_) {}
      });

      // 1. Inline styles.
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('removeFormat', false, null);

      // 2. Flatten checkbox todos and lists to plain <div> lines.
      blocks.forEach((el) => {
        if (!el.isConnected) return;
        if (el.classList && el.classList.contains('pc-todo')) {
          const t = el.querySelector('.pc-todo-text');
          const line = document.createElement('div');
          line.innerHTML = t ? t.innerHTML : el.textContent;
          el.replaceWith(line);
        } else { // UL / OL
          const frag = document.createDocumentFragment();
          el.querySelectorAll(':scope > li').forEach((li) => {
            const line = document.createElement('div');
            line.innerHTML = li.innerHTML;
            frag.appendChild(line);
          });
          if (frag.childNodes.length) el.replaceWith(frag);
          else el.remove();
        }
      });

      fireInputFor(ce);
    }

    // Apply (or clear) a FULL-WIDTH background to the block LINE(S) the
    // selection covers — a "section" colour, not a text highlight. Passing ''
    // removes it. The day cells nest lines inside larger container <div>s, so
    // we must colour the individual line blocks and never a wrapper (which
    // would shade far more than the user selected).
    function applySectionFill(color) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      let probe = range.commonAncestorContainer;
      if (probe.nodeType === 3) probe = probe.parentElement;
      const ce = probe && probe.closest && probe.closest('[contenteditable="true"]');
      if (!ce) return;

      const LINE = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE)$/;
      // True overlap with an element's contents (strict, so a selection that
      // merely ends at a block's boundary doesn't count it).
      function hits(el) {
        const er = document.createRange();
        er.selectNodeContents(el);
        try {
          return range.compareBoundaryPoints(Range.END_TO_START, er) < 0
              && range.compareBoundaryPoints(Range.START_TO_END, er) > 0;
        } catch (_) { return false; }
      }
      // A "line" is a checkbox todo, or a block that does NOT itself contain
      // another block line with text — i.e. a leaf line, never a wrapper.
      function isLine(el) {
        if (el.classList && el.classList.contains('pc-todo')) return true;
        if (!LINE.test(el.tagName)) return false;
        const inner = el.querySelectorAll('div,p,li,h1,h2,h3,h4,h5,h6,.pc-todo');
        for (let i = 0; i < inner.length; i++) {
          if (inner[i].textContent && inner[i].textContent.trim()) return false;
        }
        return true;
      }

      if (color) {
        let cand = [];
        ce.querySelectorAll('div,p,li,h1,h2,h3,h4,h5,h6,.pc-todo').forEach((el) => {
          if (hits(el) && isLine(el)) cand.push(el);
        });
        // Keep only outermost lines (drop inner blocks inside a chosen todo).
        cand = cand.filter((el) => !cand.some((o) => o !== el && o.contains(el)));
        if (!cand.length) {
          const b = probe.closest && probe.closest('.pc-todo,div,p,li,h1,h2,h3,h4,h5,h6');
          if (b && b !== ce && ce.contains(b)) cand = [b];
        }
        cand.forEach((el) => { el.classList.add('pc-section'); el.style.backgroundColor = color; });
      } else {
        // Clear every overlapping section fill, including legacy wrappers that
        // spanned too much and any ancestor wrapper of the selection.
        const targets = new Set();
        ce.querySelectorAll('.pc-section').forEach((el) => { if (hits(el)) targets.add(el); });
        let a = probe;
        while (a && a !== ce) { if (a.classList && a.classList.contains('pc-section')) targets.add(a); a = a.parentNode; }
        targets.forEach((el) => {
          el.classList.remove('pc-section');
          el.style.backgroundColor = '';
          if (!el.getAttribute('class')) el.removeAttribute('class');
          if (!el.getAttribute('style')) el.removeAttribute('style');
        });
      }
      fireInputFor(ce);
    }

    // ── Annotation popup ────────────────────────────────────────────
    const pop = document.createElement('div');
    pop.className = 'note-popup';
    pop.style.display = 'none';
    pop.innerHTML = `
      <div class="note-popup-head">
        <span class="note-popup-title">Note</span>
        <span class="note-popup-kbd">⌘↵ save · esc close</span>
      </div>
      <textarea placeholder="Write a note for the highlighted text…"></textarea>
      <div class="note-popup-actions">
        <button type="button" class="note-popup-remove">Remove</button>
        <button type="button" class="note-popup-save">Done</button>
      </div>
    `;
    document.body.appendChild(pop);
    let activeSpan = null;

    function fireInputFor(el) {
      const ce = el && el.closest && el.closest('[contenteditable="true"]');
      if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function unwrap(span) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    }

    function openPopupFor(span) {
      if (typeof hideHint === 'function') hideHint();
      if (activeSpan && activeSpan !== span) activeSpan.classList.remove('is-active');
      activeSpan = span;
      span.classList.add('is-active');
      const ta = pop.querySelector('textarea');
      ta.value = span.getAttribute('data-note') || '';
      const rect = span.getBoundingClientRect();
      pop.style.display = 'block';
      // Position below the span; flip above if near the bottom of the viewport.
      const popH = pop.offsetHeight || 140;
      const room = window.innerHeight - rect.bottom;
      const top = (room < popH + 16 ? rect.top - popH - 6 : rect.bottom + 6) + window.scrollY;
      const left = Math.max(8, Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - pop.offsetWidth - 8));
      pop.style.top = top + 'px';
      pop.style.left = left + 'px';
      setTimeout(() => ta.focus(), 0);
    }

    function closePopup() {
      pop.style.display = 'none';
      const span = activeSpan;
      activeSpan = null;
      if (!span) return;
      span.classList.remove('is-active');
      // A freshly-created highlight that never received any text: remove it so
      // we don't leave an empty, note-less highlight behind (e.g. on Esc).
      if (!span.getAttribute('data-note')) {
        const ce = span.closest('[contenteditable="true"]');
        unwrap(span);
        if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    function wrapSelectionAsNote() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);

      // If selection is inside an existing annotated span, just open it.
      let parent = range.commonAncestorContainer;
      if (parent.nodeType === 3) parent = parent.parentElement;
      const existing = parent && parent.closest && parent.closest('.annotated');
      if (existing) { openPopupFor(existing); return; }

      if (sel.isCollapsed) return;

      const span = document.createElement('span');
      span.className = 'annotated';
      span.setAttribute('data-note', '');
      try {
        range.surroundContents(span);
      } catch (_) {
        // Selection crosses element boundaries — fall back to extract + insert
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
      }
      fireInputFor(span);
      sel.removeAllRanges();
      openPopupFor(span);
    }

    // Convert the current selection (or current line) into an Apple Notes-
    // style checkbox todo.
    function buildTodo(textHtml) {
      const todo = document.createElement('div');
      todo.className = 'pc-todo';
      todo.innerHTML =
        '<input type="checkbox" class="pc-todo-box" contenteditable="false">' +
        '<span class="pc-todo-text">' + (textHtml || '​') + '</span>';
      return todo;
    }
    function insertCheckbox() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      let probe = range.commonAncestorContainer;
      if (probe.nodeType === 3) probe = probe.parentElement;
      const ce = probe && probe.closest && probe.closest('[contenteditable="true"]');
      if (!ce) return;

      // If we're already inside a todo, do nothing (clicking the button
      // again on the same line shouldn't nest).
      if (probe.closest('.pc-todo')) return;

      let textHtml = '';
      if (!sel.isCollapsed) {
        const frag = range.extractContents();
        const tmp = document.createElement('div');
        tmp.appendChild(frag);
        textHtml = tmp.innerHTML;
      }
      const todo = buildTodo(textHtml);
      range.insertNode(todo);

      // Place cursor at end of the text span
      const textSpan = todo.querySelector('.pc-todo-text');
      const newRange = document.createRange();
      newRange.selectNodeContents(textSpan);
      newRange.collapse(false);
      sel.removeAllRanges();
      sel.addRange(newRange);

      ce.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Toggle checked state on click — keep the `checked` attribute in sync
    // so the saved innerHTML preserves the state across reload/sync.
    document.addEventListener('change', (e) => {
      const box = e.target;
      if (!box.classList || !box.classList.contains('pc-todo-box')) return;
      const todo = box.closest('.pc-todo');
      if (!todo) return;
      if (box.checked) {
        box.setAttribute('checked', '');
        todo.classList.add('is-checked');
      } else {
        box.removeAttribute('checked');
        todo.classList.remove('is-checked');
      }
      const ce = todo.closest('[contenteditable="true"]');
      if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // On load (and any subsequent re-render), make sure todos whose stored
    // HTML has `checked` are visually checked via the .is-checked class.
    function hydrateTodos(root) {
      (root || document).querySelectorAll('.pc-todo').forEach((todo) => {
        const box = todo.querySelector('.pc-todo-box');
        if (box && box.hasAttribute('checked')) {
          box.checked = true;
          todo.classList.add('is-checked');
        }
      });
    }
    hydrateTodos();
    new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) {
            if (n.classList && n.classList.contains('pc-todo')) hydrateTodos(n.parentNode);
            else if (n.querySelector && n.querySelector('.pc-todo')) hydrateTodos(n);
          }
        });
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Pressing Enter at the end of a todo creates a new empty todo below;
    // pressing Enter on an empty todo exits the list back to a plain line.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      let node = sel.anchorNode;
      if (node && node.nodeType === 3) node = node.parentNode;
      const todo = node && node.closest && node.closest('.pc-todo');
      if (!todo) return;
      const textSpan = todo.querySelector('.pc-todo-text');
      const txt = (textSpan.textContent || '').replace(/​/g, '').trim();
      e.preventDefault();
      const ce = todo.closest('[contenteditable="true"]');
      if (!txt) {
        // Empty todo → replace with a blank paragraph so user can keep typing
        const empty = document.createElement('div');
        empty.innerHTML = '<br>';
        todo.parentNode.replaceChild(empty, todo);
        const r = document.createRange();
        r.setStart(empty, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        // Insert a fresh empty todo below
        const fresh = buildTodo('');
        todo.parentNode.insertBefore(fresh, todo.nextSibling);
        const r = document.createRange();
        r.selectNodeContents(fresh.querySelector('.pc-todo-text'));
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Step through preset font sizes for the current selection.
    const FONT_SIZES = [10, 12, 13, 14, 16, 18, 22, 28];
    function adjustFontSize(direction) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      // Detect current size from the selection's parent element
      let probe = range.commonAncestorContainer;
      if (probe.nodeType === 3) probe = probe.parentElement;
      const current = parseFloat(window.getComputedStyle(probe).fontSize) || 14;
      // Find nearest preset, then step
      let idx = FONT_SIZES.findIndex((s) => s >= Math.round(current));
      if (idx === -1) idx = FONT_SIZES.length - 1;
      const newIdx = Math.max(0, Math.min(FONT_SIZES.length - 1, idx + direction));
      const newSize = FONT_SIZES[newIdx];
      const span = document.createElement('span');
      span.style.fontSize = newSize + 'px';
      try {
        range.surroundContents(span);
      } catch (_) {
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
      }
      // Google Sheets / Docs paste wraps text in spans + td with explicit
      // font-size (often in pt). Strip any inline font-size on descendants
      // AND ancestor table cells inside this editable so the wrapper's
      // value actually wins.
      span.querySelectorAll('[style*="font-size"]').forEach((el) => {
        el.style.fontSize = '';
        if (!el.getAttribute('style')) el.removeAttribute('style');
      });
      const ce = span.closest('[contenteditable="true"]');
      let anc = span.parentElement;
      while (anc && anc !== ce) {
        if (anc.style && anc.style.fontSize) {
          anc.style.fontSize = '';
          if (!anc.getAttribute('style')) anc.removeAttribute('style');
        }
        anc = anc.parentElement;
      }
      fireInputFor(span);
      // Re-select the resized text so user can keep stepping
      const newRange = document.createRange();
      newRange.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }

    // Click an annotated span to view/edit its note
    document.addEventListener('click', (e) => {
      const span = e.target.closest && e.target.closest('.annotated');
      if (span) {
        e.preventDefault();
        openPopupFor(span);
        return;
      }
      // Ignore clicks that originated inside the formatting toolbar —
      // the Note button there just OPENED the popup; don't immediately
      // close it.
      if (e.target.closest && e.target.closest('.fmt-toolbar')) return;
      if (pop.style.display === 'block' && !pop.contains(e.target)) {
        // Click outside popup — auto-save
        commitPopup();
      }
    });

    // Hover card: previews the note and gives big, reliable Edit / Remove
    // buttons. Clicking the thin highlighted text inside an editable region
    // is fiddly, so the card is the primary way to act on a note. A short
    // hide delay lets the pointer travel from the text onto the card.
    let hintEl = null, hintSpan = null, hintHideTimer = null;
    function hideHint() {
      clearTimeout(hintHideTimer);
      if (hintEl) { hintEl.remove(); hintEl = null; hintSpan = null; }
    }
    function scheduleHideHint() {
      clearTimeout(hintHideTimer);
      hintHideTimer = setTimeout(hideHint, 240);
    }
    function showHint(span) {
      if (span === activeSpan) return;                 // editor already open
      if (hintSpan === span && hintEl) { clearTimeout(hintHideTimer); return; }
      hideHint();
      hintSpan = span;
      const note = span.getAttribute('data-note');
      hintEl = document.createElement('div');
      hintEl.className = 'note-hint';
      const txt = document.createElement('div');
      txt.className = 'note-hint-text';
      txt.textContent = note || 'Empty note';
      const actions = document.createElement('div');
      actions.className = 'note-hint-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button'; editBtn.className = 'note-hint-edit'; editBtn.textContent = 'Edit';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button'; removeBtn.className = 'note-hint-remove'; removeBtn.textContent = 'Remove';
      actions.appendChild(editBtn); actions.appendChild(removeBtn);
      hintEl.appendChild(txt); hintEl.appendChild(actions);
      document.body.appendChild(hintEl);
      hintEl.addEventListener('mouseenter', () => clearTimeout(hintHideTimer));
      hintEl.addEventListener('mouseleave', scheduleHideHint);
      editBtn.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const s = hintSpan; hideHint(); openPopupFor(s);
      });
      removeBtn.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const s = hintSpan; hideHint();
        const ce = s.closest('[contenteditable="true"]');
        unwrap(s);
        if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const rect = span.getBoundingClientRect();
      const tH = hintEl.offsetHeight;
      const tW = hintEl.offsetWidth;
      const top = (window.innerHeight - rect.bottom < tH + 16)
        ? rect.top + window.scrollY - tH - 6
        : rect.bottom + window.scrollY + 6;
      const left = Math.max(8, Math.min(rect.left + window.scrollX,
        window.scrollX + document.documentElement.clientWidth - tW - 8));
      hintEl.style.top = top + 'px';
      hintEl.style.left = left + 'px';
    }
    document.addEventListener('mouseover', (e) => {
      const span = e.target.closest && e.target.closest('.annotated');
      if (span) { clearTimeout(hintHideTimer); showHint(span); }
    });
    document.addEventListener('mouseout', (e) => {
      const span = e.target.closest && e.target.closest('.annotated');
      if (!span) return;
      const to = e.relatedTarget;
      if (to && to.closest && (to.closest('.note-hint') || to.closest('.annotated'))) return;
      scheduleHideHint();
    });

    function commitPopup() {
      if (!activeSpan) { closePopup(); return; }
      const val = pop.querySelector('textarea').value.trim();
      const ce = activeSpan.closest('[contenteditable="true"]');
      if (!val) {
        unwrap(activeSpan);
      } else {
        activeSpan.setAttribute('data-note', val);
        activeSpan.removeAttribute('title'); // custom tooltip handles preview
      }
      if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
      closePopup();
    }

    pop.querySelector('.note-popup-save').addEventListener('click', commitPopup);
    pop.querySelector('.note-popup-remove').addEventListener('click', () => {
      if (!activeSpan) { closePopup(); return; }
      const ce = activeSpan.closest('[contenteditable="true"]');
      unwrap(activeSpan);
      if (ce) ce.dispatchEvent(new Event('input', { bubbles: true }));
      closePopup();
    });
    pop.querySelector('textarea').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitPopup(); }
      if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
    });
  })();

  /* =====================================================================
     Undo / redo for every contenteditable region. The planner's custom
     operations (notes, checkboxes, clear-formatting, font size) mutate the
     DOM directly, which the browser's native undo cannot track — so we keep
     a small per-field innerHTML history and handle Cmd/Ctrl+Z ourselves
     (add Shift, or use Ctrl+Y, to redo). We only act when a planner text
     field is focused, so the money spreadsheet keeps its own undo button.
     ===================================================================== */
  (function initUndoHistory() {
    const HISTORY = new WeakMap();   // editable -> { stack:[html], i, t }
    const MAX = 120;
    const DEBOUNCE = 350;

    function histFor(ce) {
      let h = HISTORY.get(ce);
      if (!h) { h = { stack: [ce.innerHTML], i: 0, t: null }; HISTORY.set(ce, h); }
      return h;
    }
    function snapshot(ce) {
      const h = histFor(ce);
      const html = ce.innerHTML;
      if (h.stack[h.i] === html) return;
      h.stack = h.stack.slice(0, h.i + 1);
      h.stack.push(html);
      if (h.stack.length > MAX) h.stack.shift();
      h.i = h.stack.length - 1;
    }
    function scheduleSnapshot(ce) {
      const h = histFor(ce);
      clearTimeout(h.t);
      h.t = setTimeout(() => snapshot(ce), DEBOUNCE);
    }
    function restore(ce, html) {
      ce.innerHTML = html;
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      try {
        const r = document.createRange();
        r.selectNodeContents(ce); r.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      } catch (_) {}
    }
    function undo(ce) {
      const h = histFor(ce);
      clearTimeout(h.t);
      if (h.stack[h.i] !== ce.innerHTML) snapshot(ce);   // capture latest edit first
      if (h.i > 0) { h.i--; restore(ce, h.stack[h.i]); return true; }
      return false;
    }
    function redo(ce) {
      const h = histFor(ce);
      if (h.i < h.stack.length - 1) { h.i++; restore(ce, h.stack[h.i]); return true; }
      return false;
    }

    // Seed the pre-edit state on focus and before the first keystroke, so the
    // earliest change in a field is always undoable.
    document.addEventListener('focusin', (e) => {
      const ce = e.target.closest && e.target.closest('[contenteditable="true"]');
      if (ce) histFor(ce);
    });
    document.addEventListener('beforeinput', (e) => {
      const ce = e.target.closest && e.target.closest('[contenteditable="true"]');
      if (ce) histFor(ce);
    }, true);
    document.addEventListener('input', (e) => {
      const ce = e.target.closest && e.target.closest('[contenteditable="true"]');
      if (ce) scheduleSnapshot(ce);
    });
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // native undo in fields
      const ce = ae && ae.closest && ae.closest('[contenteditable="true"]');
      if (!ce) return;                                    // not in a planner field — leave Ctrl+Z alone
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(ce); }
      else if (k === 'z') { e.preventDefault(); undo(ce); }
    }, true);
  })();
