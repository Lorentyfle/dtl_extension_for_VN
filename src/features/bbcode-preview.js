// -----------------------------------------------------------------------------
// Showing BBCode effects in the editor.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const project = require('../project');
const translationView = require('../translation/view');
const glossaryFeature = require('./glossary');

// =============================================================================
// BBCODE PREVIEW (editor decorations)
// =============================================================================
// Shows what Godot BBCode tags do, right in the editor, as far as a code
// editor can: [color=red] text is red, [rainbow] text is a rainbow, [fade]
// fades out, [b][i] is bold italic, [wave] gets a wavy underline, etc.
// Animations can't run in the editor, so animated effects get a static
// stand-in (wavy/dotted/dashed underline, dimming).
//
// How: each text line is scanned for BBCode tags, openers are paired with
// their closers (nesting-aware), then for every character the effects of
// all the tags around it are merged, outermost first (colors: innermost
// wins; bold/italic/underlines: add up; opacity: multiplies). Runs of
// characters with the same merged style become one range, and each unique
// style gets one cached decoration type - so any combination and any
// nesting depth works without listing combinations by hand.

/**
 * Godot's named colors that differ from the CSS ones of the same name
 * (Godot follows X11): everything else Godot names is also a CSS color.
 *
 * @type {Record<string, string>}
 */
const GODOT_COLOR_OVERRIDES = {
  green: '#00ff00', gray: '#bebebe', grey: '#bebebe', maroon: '#b03060', purple: '#a020f0',
  webgreen: '#008000', webgray: '#808080', webgrey: '#808080', webmaroon: '#800000', webpurple: '#800080',
  transparent: 'transparent',
};

/**
 * Convert a BBCode color value (a Godot color name like `red` or
 * `light_blue`, or a hex code with or without `#`: RGB, RGBA, RRGGBB,
 * RRGGBBAA) to a CSS color, or null if it isn't one.
 *
 * @param {string} value
 * @returns {string | null}
 */
function bbcodeColorToCss(value) {
  if (!value) { return null; }
  const text = value.trim().replace(/^["']|["']$/g, '');
  const hex = text.replace(/^#/, '');
  if (/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) && (text.startsWith('#') || /\d/.test(hex))) {
    return `#${hex}`;
  }
  const name = text.toLowerCase().replace(/[\s_\-'.]/g, '');
  if (!/^[a-z]+$/.test(name)) { return null; }
  return GODOT_COLOR_OVERRIDES[name] || name;
}

/**
 * Parse a tag's parameter text: `=red` gives value "red"; ` level=5 rate=20`
 * gives params {level: "5", rate: "20"}; quotes are removed.
 *
 * @param {string} text - everything between the tag name and `]`
 * @returns {{value: string|null, params: Record<string, string>}}
 */
function parseBbcodeParams(text) {
  const unquote = raw => raw.replace(/^"(.*)"$|^'(.*)'$/, (m, a, b) => (a !== undefined ? a : b));
  const result = { value: null, params: {} };
  if (!text) { return result; }
  let rest = text;
  const valueMatch = rest.match(/^=\s*("[^"]*"|'[^']*'|[^\s\]]*)/);
  if (valueMatch) {
    result.value = unquote(valueMatch[1]);
    rest = rest.slice(valueMatch[0].length);
  }
  const paramPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s\]]*)/g;
  let match;
  while ((match = paramPattern.exec(rest)) !== null) { result.params[match[1]] = unquote(match[2]); }
  return result;
}

/** HSV (0-1 each) to a CSS hex color. */
function hsvToCss(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  const toHex = x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Rounding steps, so per-letter effects (rainbow hue, fade opacity) share a few decoration types. */
const RAINBOW_STEPS = 24;

const FADE_STEPS = 10;

/**
 * How one BBCode tag changes the characters inside it, given the tag's
 * parameters and the character's index inside the tag (for per-letter
 * effects). Each field is merged by mergeBbcodeStyle.
 *
 * @type {Record<string, (params: {value: string|null, params: Record<string, string>}, index: number) => object>}
 */
const BBCODE_EFFECTS = {
  b: () => ({ bold: true }),
  i: () => ({ italic: true }),
  u: () => ({ lines: ['underline'] }),
  s: () => ({ lines: ['line-through'] }),
  color: ({ value }) => ({ color: bbcodeColorToCss(value) }),
  bgcolor: ({ value }) => ({ background: bbcodeColorToCss(value) }),
  fgcolor: ({ value }) => { const color = bbcodeColorToCss(value); return { color, background: color }; },
  outline_color: ({ value }) => ({ outlineColor: bbcodeColorToCss(value) }),
  outline_size: ({ value }) => ({ outlineSize: Math.min(3, Math.max(0, parseFloat(value) || 0)) }),
  url: () => ({ color: 'var(--vscode-textLink-foreground)', lines: ['underline'] }),
  hint: () => ({ lines: ['underline'], lineStyle: 'dotted' }),
  wave: () => ({ lines: ['underline'], lineStyle: 'wavy' }),
  shake: () => ({ lines: ['underline'], lineStyle: 'dotted', spacing: 0.5 }),
  tornado: () => ({ lines: ['underline'], lineStyle: 'dashed' }),
  pulse: () => ({ opacity: 0.7 }),
  rainbow: ({ params }, index) => {
    const freq = parseFloat(params.freq) || 1;
    const sat = params.sat !== undefined ? parseFloat(params.sat) : 0.8;
    const val = params.val !== undefined ? parseFloat(params.val) : 0.8;
    const hue = Math.round(((index * 0.05 * freq) % 1) * RAINBOW_STEPS) / RAINBOW_STEPS;
    return { color: hsvToCss(hue, sat, val) };
  },
  fade: ({ params }, index) => {
    const start = params.start !== undefined ? parseFloat(params.start) : 4;
    const length = params.length !== undefined ? parseFloat(params.length) : 14;
    const alpha = 1 - Math.min(1, Math.max(0, (index - start) / Math.max(1, length)));
    return { opacity: Math.max(0.1, Math.round(alpha * FADE_STEPS) / FADE_STEPS) };
  },
};

/**
 * Merge an effect into a style, the way nested tags combine: colors and
 * backgrounds of an inner tag replace the outer ones, bold/italic and the
 * underline/strikethrough lines add up, opacity multiplies.
 *
 * @param {object} style
 * @param {object} effect
 * @returns {object}
 */
function mergeBbcodeStyle(style, effect) {
  const merged = { ...style };
  for (const [key, value] of Object.entries(effect)) {
    if (value === null || value === undefined) { continue; }
    if (key === 'lines') { merged.lines = [...new Set([...(merged.lines || []), ...value])]; }
    else if (key === 'opacity') { merged.opacity = Math.round((merged.opacity === undefined ? 1 : merged.opacity) * value * 100) / 100; }
    else { merged[key] = value; }
  }
  return merged;
}

/**
 * The decoration options (VS Code's DecorationRenderOptions) of a merged
 * style. The outline has no dedicated option, so it's drawn with a CSS
 * text-shadow appended to text-decoration - the usual way to reach CSS the
 * API doesn't expose.
 *
 * @param {object} style
 * @returns {vscode.DecorationRenderOptions}
 */
function bbcodeStyleToDecoration(style) {
  const options = {};
  if (style.bold) { options.fontWeight = 'bold'; }
  if (style.italic) { options.fontStyle = 'italic'; }
  if (style.color) { options.color = style.color; }
  if (style.background) { options.backgroundColor = style.background; }
  // Never fully invisible - the text still has to be readable and editable.
  if (style.opacity !== undefined && style.opacity < 1) { options.opacity = String(Math.max(0.15, style.opacity)); }
  if (style.spacing) { options.letterSpacing = `${style.spacing}px`; }
  let textDecoration = style.lines && style.lines.length > 0 ? `${style.lines.join(' ')}${style.lineStyle ? ' ' + style.lineStyle : ''}` : '';
  if (style.outlineSize) {
    const color = style.outlineColor || '#000000';
    const size = style.outlineSize > 1 ? 1 : 0.5;
    const shadow = [[-size, 0], [size, 0], [0, -size], [0, size]].map(([x, y]) => `${x}px ${y}px 0 ${color}`).join(', ');
    textDecoration = `${textDecoration || 'none'}; text-shadow: ${shadow}`;
  }
  if (textDecoration) { options.textDecoration = textDecoration; }
  return options;
}

/**
 * Find the BBCode tag pairs of one line: each opener of a previewable tag
 * with its matching closer (nesting-aware, by name), and the self-closing
 * `[char=...]` tags. Tags without a closer on the line are ignored, like
 * the syntax highlighting does.
 *
 * @param {string} text - one line
 * @param {number} from - where the player-facing text starts on the line
 * @returns {{pairs: {name: string, params: object, contentStart: number, contentEnd: number}[], tagSpans: [number, number][], chars: {start: number, end: number, codepoint: number}[]}}
 */
function findBbcodePairs(text, from) {
  const tagPattern = /\[(\/)?([A-Za-z_][A-Za-z0-9_]*)((?:=|\s)[^\]]*)?\]/g;
  tagPattern.lastIndex = from;
  const open = [];
  const pairs = [];
  const tagSpans = [];
  const chars = [];
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const [whole, closing, name, paramText] = match;
    const start = match.index;
    const end = start + whole.length;
    if (!closing && name === 'char') {
      const codepoint = parseInt(parseBbcodeParams(paramText).value || '', 16);
      if (Number.isFinite(codepoint)) { chars.push({ start, end, codepoint }); }
      continue;
    }
    if (!BBCODE_EFFECTS[name] && name !== 'img') { continue; }
    tagSpans.push([start, end]);
    if (!closing) {
      open.push({ name, params: parseBbcodeParams(paramText), contentStart: end });
    } else {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].name === name) {
          pairs.push({ ...open[i], contentEnd: start });
          open.splice(i, 1);
          break;
        }
      }
    }
  }
  // Unclosed openers aren't tags Godot would apply to anything - don't gray them out as markup.
  const pairedSpans = tagSpans.filter(([start, end]) => pairs.some(pair => pair.contentStart === end || pair.contentEnd === start));
  return { pairs: pairs.sort((a, b) => a.contentStart - b.contentStart), tagSpans: pairedSpans, chars };
}

/**
 * Where a line's previewable text starts, or -1 if the line has none:
 * after the speaker of a dialogue line, the whole line for narration and
 * choices; in a Translation View, after a "fr:"-style prefix.
 *
 * @param {vscode.TextDocument} document
 * @param {string} text
 * @returns {number}
 */
function bbcodePreviewStart(document, text) {
  if (document.uri.scheme === translationView.TRANSLATION_VIEW_SCHEME) {
    const localeMatch = text.match(/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*:/);
    return localeMatch ? localeMatch[0].length : -1;
  }
  // A narration line can start with a BBCode tag ("[b]Hello[/b]"), which
  // isPlayerFacingTextLine treats as a bracket command line - it's text
  // unless that first tag is one of Dialogic's own commands.
  const leadingTag = text.match(/^\s*\[\/?([A-Za-z_][A-Za-z0-9_]*)/);
  if (leadingTag) { return syntax.RESERVED_BRACKET_NAMES.has(leadingTag[1]) ? -1 : 0; }
  if (!syntax.isPlayerFacingTextLine(text)) { return -1; }
  const speakerMatch = text.match(new RegExp(`^\\s*${syntax.CHARACTER_NAME_SOURCE}\\s*(?:\\([^)]*\\))?\\s*:`, 'u'));
  return speakerMatch ? speakerMatch[0].length : 0;
}

/** Decoration type per unique merged style (JSON key). @type {Map<string, vscode.TextEditorDecorationType>} */
const bbcodeDecorationTypes = new Map();

/**
 * @param {string} key
 * @param {object} style
 * @returns {vscode.TextEditorDecorationType}
 */
function getBbcodeDecorationType(key, style) {
  if (!bbcodeDecorationTypes.has(key)) {
    bbcodeDecorationTypes.set(key, vscode.window.createTextEditorDecorationType(bbcodeStyleToDecoration(style)));
  }
  return bbcodeDecorationTypes.get(key);
}

/**
 * Compute the BBCode preview of a whole document: per decoration type,
 * the ranges (with hover messages for [hint] and [img]), plus the
 * [char=...] previews.
 *
 * @param {vscode.TextDocument} document
 * @returns {{byType: Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>, chars: vscode.DecorationOptions[]}}
 */
function computeBbcodePreview(document) {
  const byType = new Map();
  const charDecorations = [];
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!text.includes('[')) { continue; }
    const from = bbcodePreviewStart(document, text);
    if (from === -1) { continue; }
    const { pairs, tagSpans, chars } = findBbcodePairs(text, from);
    for (const char of chars) {
      charDecorations.push({
        range: new vscode.Range(line, char.start, line, char.end),
        renderOptions: { after: { contentText: ` ${String.fromCodePoint(char.codepoint)}`, color: new vscode.ThemeColor('editorCodeLens.foreground') } },
      });
    }
    if (pairs.length === 0) { continue; }

    const isTagChar = new Array(text.length).fill(false);
    for (const [start, end] of tagSpans) { for (let i = start; i < end; i++) { isTagChar[i] = true; } }
    // Per pair, the index of each of its content characters, not counting
    // nested tags - what per-letter effects (rainbow, fade) count with.
    const indexInPair = pairs.map(pair => {
      const indexes = new Map();
      let count = 0;
      for (let i = pair.contentStart; i < pair.contentEnd; i++) { if (!isTagChar[i]) { indexes.set(i, count++); } }
      return indexes;
    });

    let runStart = -1;
    let runKey = null;
    let runStyle = null;
    let runHover = null;
    const flush = end => {
      if (runKey === null || runStart === -1) { return; }
      const type = getBbcodeDecorationType(runKey, runStyle);
      if (!byType.has(type)) { byType.set(type, []); }
      const decoration = { range: new vscode.Range(line, runStart, line, end) };
      if (runHover) { decoration.hoverMessage = runHover; }
      byType.get(type).push(decoration);
    };
    for (let i = from; i <= text.length; i++) {
      let style = null;
      let hover = null;
      if (i < text.length && !isTagChar[i]) {
        pairs.forEach((pair, pairIndex) => {
          if (i < pair.contentStart || i >= pair.contentEnd) { return; }
          if (pair.name === 'img') {
            const imagePath = text.slice(pair.contentStart, pair.contentEnd).trim();
            if (state.projectRootUri && /^res:\/\//.test(imagePath)) {
              hover = new vscode.MarkdownString(`![${imagePath}](${project.resolveResourcePath(imagePath).toString()}|height=128)\n\n\`${imagePath}\``);
            }
            return;
          }
          style = mergeBbcodeStyle(style || {}, BBCODE_EFFECTS[pair.name](pair.params, indexInPair[pairIndex].get(i) || 0));
          if (pair.name === 'hint' && pair.params.value) { hover = new vscode.MarkdownString(`**Hint:** ${pair.params.value}`); }
        });
      }
      const key = style && Object.keys(bbcodeStyleToDecoration(style)).length > 0 ? JSON.stringify(style) : null;
      const hoverKey = hover ? hover.value : null;
      if (key !== runKey || hoverKey !== (runHover ? runHover.value : null)) {
        flush(i);
        runStart = i;
        runKey = key;
        runStyle = style;
        runHover = hover;
      }
    }
    flush(text.length);
  }
  return { byType, chars: charDecorations };
}

/**
 * Paint (or clear) the BBCode preview of one editor
 * (`dtlReader.preview.bbcodeEffects`).
 *
 * @param {vscode.TextEditor} editor
 */
function updateBbcodePreview(editor) {
  if (!editor || !state.bbcodeCharDecorationType) { return; }
  const document = editor.document;
  const applies = document.languageId === 'dtl' || document.uri.scheme === translationView.TRANSLATION_VIEW_SCHEME;
  const enabled = applies && vscode.workspace.getConfiguration('dtlReader').get('preview.bbcodeEffects', true);
  const { byType, chars } = enabled ? computeBbcodePreview(document) : { byType: new Map(), chars: [] };
  for (const type of bbcodeDecorationTypes.values()) { editor.setDecorations(type, byType.get(type) || []); }
  editor.setDecorations(state.bbcodeCharDecorationType, chars);
}

/** Pending preview refreshes, per document, so typing doesn't recompute on every keystroke. @type {Map<string, NodeJS.Timeout>} */
const bbcodePreviewTimers = new Map();

/**
 * @param {vscode.TextDocument} [document] - only its editors, or every visible editor
 */
function scheduleBbcodePreview(document) {
  const key = document ? document.uri.toString() : '*';
  clearTimeout(bbcodePreviewTimers.get(key));
  bbcodePreviewTimers.set(key, setTimeout(() => {
    bbcodePreviewTimers.delete(key);
    vscode.window.visibleTextEditors
      .filter(editor => !document || editor.document === document)
      .forEach(editor => { updateBbcodePreview(editor); glossaryFeature.updateGlossaryDecorations(editor); });
  }, document ? 150 : 0));
}

Object.assign(module.exports, {
  bbcodePreviewStart,
  bbcodeDecorationTypes,
  scheduleBbcodePreview,
});
