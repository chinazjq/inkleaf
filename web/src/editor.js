// CodeMirror 6 Markdown editor wrapper and scroll-sync helper.
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const setSearchMatchesEffect = StateEffect.define();
const searchHitMark = Decoration.mark({ class: 'cm-find-hit' });
const searchHitActiveMark = Decoration.mark({ class: 'cm-find-hit-active' });

const searchHighlightField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) {
      value = value.map(tr.changes);
    }
    for (const eff of tr.effects) {
      if (eff.is(setSearchMatchesEffect)) {
        const { matches, activeIndex } = eff.value;
        if (!matches.length) return Decoration.none;
        const decos = matches.map((m, idx) =>
          (idx === activeIndex ? searchHitActiveMark : searchHitMark).range(m.from, m.to),
        );
        return Decoration.set(decos, true);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const inkleafEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    fontSize: 'var(--editor-size, 15px)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
    lineHeight: '1.7',
    padding: '28px 20px 30vh',
    fontFamily: 'var(--mono)',
  },
  '.cm-content': {
    maxWidth: 'var(--measure)',
    margin: '0 auto',
    padding: '0 12px',
    caretColor: 'var(--heading)',
    fontFamily: 'var(--mono)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    borderRight: 'none',
    paddingRight: '8px',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '3ch',
    fontSize: '12px',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--hover) 55%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--heading)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--heading)',
    borderLeftWidth: '2px',
  },
  '.cm-find-hit': {
    backgroundColor: 'var(--find)',
    borderRadius: '2px',
  },
  '.cm-find-hit-active': {
    backgroundColor: 'var(--find-current)',
    color: '#000',
    borderRadius: '2px',
  },
});

const inkleafHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--heading)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--heading)', fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: [tags.link, tags.url], color: 'var(--link)', textDecoration: 'underline' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.typeName, tags.tagName], color: 'var(--hl-keyword)' },
  { tag: [tags.string, tags.inserted], color: 'var(--hl-string)' },
  { tag: [tags.number, tags.atom, tags.bool], color: 'var(--hl-number)' },
  { tag: [tags.comment, tags.quote, tags.meta, tags.processingInstruction], color: 'var(--hl-comment)' },
  { tag: tags.monospace, color: 'var(--hl-title)' },
]);

export function createEditor(container, { initialContent = '', onChange, onScroll } = {}) {
  let suppressChange = false;
  let lastMatches = [];
  const readOnlyComp = new Compartment();

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      dropCursor(),
      history(),
      indentOnInput(),
      bracketMatching(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(inkleafHighlight),
      inkleafEditorTheme,
      searchHighlightField,
      readOnlyComp.of(EditorState.readOnly.of(false)),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressChange && onChange) {
          onChange(update.state.doc.toString());
        }
      }),
    ],
  });

  const view = new EditorView({ state, parent: container });

  function getScrollInfo() {
    const sc = view.scrollDOM;
    const block = view.lineBlockAtHeight(sc.scrollTop);
    const topLine = view.state.doc.lineAt(block.from).number;
    return {
      scrollTop: sc.scrollTop,
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
      topLine,
    };
  }

  const scroller = view.scrollDOM;
  const scrollHandler = () => {
    if (onScroll) onScroll(getScrollInfo());
  };
  scroller.addEventListener('scroll', scrollHandler, { passive: true });

  return {
    getValue: () => view.state.doc.toString(),
    getSelectionText() {
      const sel = view.state.selection.main;
      return sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to);
    },
    setValueSilent(text) {
      const current = view.state.doc.toString();
      if (current === text) return;
      suppressChange = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
      } finally {
        suppressChange = false;
      }
    },
    setFontSize(px) {
      container.style.setProperty('--editor-size', Math.max(12, Math.min(22, px - 1)) + 'px');
    },
    findMatches(query, { max = 1000 } = {}) {
      lastMatches = [];
      if (!query) {
        view.dispatch({ effects: setSearchMatchesEffect.of({ matches: [], activeIndex: -1 }) });
        return { count: 0, capped: false, firstIndex: 0 };
      }
      const docText = view.state.doc.toString();
      const hay = docText.toLowerCase();
      const needle = query.toLowerCase();
      let capped = false;
      let i = hay.indexOf(needle);
      while (i >= 0) {
        const to = Math.min(docText.length, i + query.length);
        lastMatches.push({ from: i, to });
        if (lastMatches.length >= max) {
          capped = true;
          break;
        }
        i = hay.indexOf(needle, i + needle.length);
      }
      const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
      const firstVisible = lastMatches.findIndex((m) => m.from >= topPos);
      return {
        count: lastMatches.length,
        capped,
        firstIndex: firstVisible < 0 ? 0 : firstVisible,
      };
    },
    highlightMatch(activeIndex, jump = true) {
      const active = activeIndex >= 0 && activeIndex < lastMatches.length ? lastMatches[activeIndex] : null;
      const effects = [setSearchMatchesEffect.of({ matches: lastMatches, activeIndex })];
      if (jump && active) {
        effects.push(EditorView.scrollIntoView(active.from, { y: 'center' }));
      }
      view.dispatch({ effects });
    },
    clearSearch() {
      lastMatches = [];
      view.dispatch({ effects: setSearchMatchesEffect.of({ matches: [], activeIndex: -1 }) });
    },
    focus() {
      view.focus();
    },
    getScrollInfo,
    destroy() {
      scroller.removeEventListener('scroll', scrollHandler);
      view.destroy();
    },
  };
}

/**
 * Computes a target preview scrollTop from the editor's scroll position by mapping
 * Markdown heading line numbers to rendered heading offsets, falling back to scroll ratio.
 */
export function computePreviewScrollTop(scrollInfo, sourceText, previewEl, previewScroller) {
  const maxPreview = Math.max(0, previewScroller.scrollHeight - previewScroller.clientHeight);
  if (maxPreview <= 0) return 0;

  const lines = String(sourceText || '').split(/\r?\n/);
  const headingLines = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^\s{0,3}#{1,6}\s+/.test(line)) {
      headingLines.push(i + 1);
    }
  }

  const domHeadings = Array.from(previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  if (headingLines.length >= 2 && headingLines.length === domHeadings.length) {
    const scRect = previewScroller.getBoundingClientRect();
    const anchors = headingLines.map((ln, idx) => ({
      line: ln,
      top: Math.max(0, domHeadings[idx].getBoundingClientRect().top - scRect.top + previewScroller.scrollTop - 24),
    }));
    anchors.unshift({ line: 1, top: 0 });
    anchors.push({ line: lines.length + 1, top: maxPreview });

    const cur = scrollInfo.topLine || 1;
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      if (cur >= a.line && cur <= b.line) {
        const span = Math.max(1, b.line - a.line);
        const ratio = (cur - a.line) / span;
        return a.top + ratio * (b.top - a.top);
      }
    }
  }

  const maxEditor = Math.max(1, scrollInfo.scrollHeight - scrollInfo.clientHeight);
  const ratio = Math.min(1, Math.max(0, scrollInfo.scrollTop / maxEditor));
  return ratio * maxPreview;
}
