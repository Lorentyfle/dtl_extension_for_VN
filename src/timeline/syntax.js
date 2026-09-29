// -----------------------------------------------------------------------------
// What a timeline line is, the way Dialogic reads it: character names,
// speakers, labels, jumps, dialogue and narration, BBCode tags, and the
// event index of each line.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const events = require('../docs/events');
const bbcode = require('../docs/bbcode');
const textEffects = require('../docs/text-effects');

// =============================================================================
// CHARACTER NAME HELPERS
// =============================================================================
// A DTL character name is either a bare identifier, or a double/single-quoted
// string - the quoted form lets a name contain spaces or symbols that
// wouldn't otherwise be valid (e.g. join "John Smith" left). Mirrors the
// equivalent alternation in dtl.tmLanguage.json's #commands/#dialogue rules,
// so the editor and the syntax highlighting agree on what counts as a name.

/**
 * Regex source fragment (for building a `RegExp` dynamically) matching a
 * character name in either its bare or quoted form. Quotes are included in
 * the match; use `stripCharacterNameQuotes()` to get the plain name.
 *
 * @type {string}
 */
const CHARACTER_NAME_SOURCE = '(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\'|[\\p{L}_][\\p{L}0-9_]*)';

/**
 * Strip a leading/trailing matching quote pair from a matched character
 * name token, if present, so it can be looked up against
 * cachedCharacterNames/cachedCharacterMoods (which store plain names).
 *
 * @param {string} token
 * @returns {string}
 */
function stripCharacterNameQuotes(token) {
  const quote = token[0];
  if ((quote === '"' || quote === "'") && token.length >= 2 && token[token.length - 1] === quote) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Split a join/leave/update argument string into tokens the same way
 * `.split(/\s+/)` would - including a trailing empty-string token when the
 * text ends in whitespace, meaning "nothing typed yet for the next slot" -
 * except a double- or single-quoted run (even mid-typing, still missing its
 * closing quote) is always kept together as one token, so a character name
 * like "John Smith" isn't split into two.
 *
 * @param {string} argumentsText
 * @returns {string[]}
 */
function splitCommandArguments(argumentsText) {
  const tokens = [];
  let index = 0;
  while (index < argumentsText.length) {
    if (/\s/.test(argumentsText[index])) {
      index++;
      continue;
    }
    const quoteChar = (argumentsText[index] === '"' || argumentsText[index] === "'") ? argumentsText[index] : null;
    if (quoteChar) {
      let end = index + 1;
      while (end < argumentsText.length && argumentsText[end] !== quoteChar) { end++; }
      if (end < argumentsText.length) { end++; } // include the closing quote, if one was typed
      tokens.push(argumentsText.slice(index, end));
      index = end;
    } else {
      let end = index;
      while (end < argumentsText.length && !/\s/.test(argumentsText[end])) { end++; }
      tokens.push(argumentsText.slice(index, end));
      index = end;
    }
  }
  if (/\s$/.test(argumentsText)) { tokens.push(''); }
  return tokens;
}

/**
 * Plain-text prefix to filter character names against, extracted from the
 * token currently being typed in a character-name slot - stripping a
 * leading (and matching trailing, if already typed) quote so `"Joh` and
 * `Joh` both filter the same way.
 *
 * @param {string} token
 * @returns {string}
 */
function extractCharacterNamePrefix(token) {
  const quote = token[0];
  if (quote === '"' || quote === "'") {
    let inner = token.slice(1);
    if (inner.endsWith(quote)) { inner = inner.slice(0, -1); }
    return inner;
  }
  return token;
}

/**
 * Find the character name (bare or quoted) under the cursor on a line,
 * if any - either a join/update/leave argument, or a dialogue speaker.
 * Scans every name-shaped match on the line rather than relying on VS
 * Code's default word-range detection, since a quoted name's range
 * (quotes and internal spaces included) isn't a "word" by that definition.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{name: string, range: vscode.Range} | null}
 */
function findCharacterNameAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  const nameRe = new RegExp(CHARACTER_NAME_SOURCE, 'gu');
  let match;
  while ((match = nameRe.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character < start || position.character > end) { continue; }
    const before = line.slice(0, start);
    const after = line.slice(end);
    const isSpeaker = /^\s*$/.test(before) && /^\s*(?:\([\p{L}_][\p{L}0-9_]*\)\s*)?:/u.test(after);
    const isCommandArgument = /^\s*(?:join|update|leave)\s+$/.test(before);
    if (isSpeaker || isCommandArgument) {
      return { name: stripCharacterNameQuotes(match[0]), range: new vscode.Range(position.line, start, position.line, end) };
    }
  }
  return null;
}

// =============================================================================
// DIALOGIC TEXT EFFECTS AND MODIFIERS
// =============================================================================
// Dialogic's own commands inside text (not Godot BBCode): effects happen
// when the reveal reaches them ([pause=0.5], [portrait=happy], [aa]...),
// modifiers change the text before it's shown ([if ...], <a/b>). From
// Dialogic's Text/Character/Core modules (_get_text_effects,
// _get_text_modifiers) and docs.dialogic.pro/text-effects.html.

/**
 * The speaker of a dialogue line and their mood tag, if any.
 *
 * @param {string} text
 * @returns {{name: string, mood: string|null} | null}
 */
function findLineSpeaker(text) {
  const match = text.match(new RegExp(`^\\s*(${CHARACTER_NAME_SOURCE})\\s*(?:\\(([\\p{L}_][\\p{L}0-9_]*)\\))?\\s*:`, 'u'));
  if (!match) { return null; }
  const name = stripCharacterNameQuotes(match[1]);
  return RESERVED_LINE_KEYWORDS.has(name) ? null : { name, mood: match[2] || null };
}

// =============================================================================
// COMPLETION ITEM HELPERS
// =============================================================================

/**
 * True when `beforeCursor` sits inside spoken/narrated text - either after
 * a `Character:` prefix, or on a bare narration line with no character
 * name at all (Dialogic treats plain text with no prefix as dialogue too,
 * spoken by a nameless narrator). Also false while inside an open
 * `{variable}` block, which has its own completions.
 *
 * @param {string} beforeCursor
 * @returns {boolean}
 */
function isInsideDialogueText(beforeCursor) {
  const colonMatch = beforeCursor.match(new RegExp(`^\\s*${CHARACTER_NAME_SOURCE}\\s*:`, 'u'));

  let textStart;
  if (colonMatch) {
    textStart = colonMatch[0].length;
  } else if (isBareNarrationLine(beforeCursor)) {
    textStart = 0;
  } else {
    return false;
  }

  const spokenPart = beforeCursor.slice(textStart);
  const lastOpenBrace = spokenPart.lastIndexOf('{');
  const lastCloseBrace = spokenPart.lastIndexOf('}');
  // If the last '{' comes after the last '}', we are inside an open
  // {variable} block and should not offer word suggestions there.
  return lastOpenBrace <= lastCloseBrace;
}

/**
 * The event a line is, when it's a bracket event - `[wait 1]`,
 * `[background arg="..."]`, a custom event - recognized the way Dialogic
 * does: `[name ` or `[name]` with the name of a known event. Any other line
 * starting with `[` (`[b]Hello[/b] there`, `[pause=1]...`) is text.
 *
 * @param {string} text - a line, or the start of one
 * @returns {string | null} the event's name
 */
function bracketEventName(text) {
  const match = text.match(/^\s*\[([A-Za-z_][A-Za-z0-9_]*)(?=[ \]])/);
  return match && isBracketEventName(match[1]) ? match[1] : null;
}

/**
 * Whether `name` is a bracket event: one of Dialogic's (`wait`, `clear`...)
 * or one of the project's custom events (added to DTL_ENTRIES).
 *
 * @param {string} name
 * @returns {boolean}
 */
function isBracketEventName(name) {
  return RESERVED_BRACKET_NAMES.has(name) || events.DTL_ENTRIES.some(entry => entry.type === 'bracket' && entry.name === name);
}

/**
 * A line with no `Character:` prefix still counts as spoken/narrated text
 * in Dialogic, unless it's actually something else: blank, a comment, a
 * choice, a bracket event (see bracketEventName), or a flow/command
 * keyword line.
 * Mirrors the `#narration` rule in the TextMate grammar so the editor and
 * the syntax highlighting agree on what counts as dialogue text.
 *
 * Known limitation: a line whose very first word happens to match a
 * keyword (e.g. spoken text that starts with the word "return") is
 * ambiguous with an actual command and is treated as a command line here,
 * same as in the grammar - this mirrors a real ambiguity in the language
 * itself, not something introduced by this check.
 *
 * @param {string} beforeCursor
 * @returns {boolean}
 */
function isBareNarrationLine(beforeCursor) {
  if (/^\s*$/.test(beforeCursor)) {
    return false; // nothing typed yet on this line
  }
  if (/^\s*#/.test(beforeCursor)) {
    return false; // comment
  }
  if (/^\s*-\s/.test(beforeCursor)) {
    return false; // choice
  }
  if (bracketEventName(beforeCursor)) {
    return false; // a bracket event, e.g. [wait 1] - not "[b]Hello[/b]", which is text
  }
  if (/^\s*(if|else|elif|set|label|jump|join|leave|update|audio|do|return)\b/.test(beforeCursor)) {
    return false; // flow/command keyword line
  }
  return true;
}

/**
 * True when a full line of source is player-facing text: a `Character:`
 * dialogue line, a `- choice` line, or a bare narration line. Balises are
 * only meaningful on these lines, so diagnostics are scoped to them.
 *
 * @param {string} lineText
 * @returns {boolean}
 */
function isPlayerFacingTextLine(lineText) {
  if (new RegExp(`^\\s*${CHARACTER_NAME_SOURCE}\\s*:`, 'u').test(lineText)) {
    return true; // Character: ... (bare or quoted name)
  }
  if (/^\s*-\s/.test(lineText)) {
    return true; // choice
  }
  return isBareNarrationLine(lineText);
}

// =============================================================================
// LABEL / JUMP HELPERS
// =============================================================================

/**
 * Parse a `label` line the way Dialogic does (`label +(?<name>[^(]+)
 * (\((?<display_name>.+)\))?`): the name is everything up to an optional
 * `(Display Name)`, so it may contain spaces. A label is translatable (its
 * display name), so like Dialogic, everything from `#id:` on (its
 * translation id) is cut off before parsing.
 *
 * @param {string} text - one line
 * @returns {{name: string, displayName: string|null, nameStart: number} | null}
 */
function parseLabelLine(text) {
  const match = text.split('#id:')[0].match(/^(\s*label\s+)([^(\r\n]*?)\s*(?:\((.*)\))?\s*$/);
  if (!match || match[2].trim() === '') { return null; }
  return { name: match[2].trim(), displayName: match[3] ? match[3].trim() : null, nameStart: match[1].length };
}

/**
 * Parse a `jump` line the way Dialogic does (`jump (?<timeline>.*\/)?
 * (?<label>.*)?`): `jump label` stays in this timeline, `jump
 * Timeline/label` goes to a label of another timeline, and `jump
 * Timeline/` to its start. The timeline part is everything up to the LAST
 * `/`, since a timeline identifier can itself be a short path
 * ("chapter1/intro") when two timelines share a file name.
 *
 * A jump is NOT translatable, so Dialogic doesn't cut a ` #id:...` off it:
 * `jump Other/choice A1 #id:cc3` looks for a label literally named
 * "choice A1 #id:cc3". The target here stops before `#id:` (so the rest
 * of the extension still resolves the intended label), and
 * `translationIdStart` tells findUnresolvedJumpDiagnostics to flag it.
 *
 * @param {string} text - one line
 * @returns {{target: string, timeline: string|null, label: string, targetStart: number, labelStart: number, translationIdStart: number} | null}
 */
function parseJumpLine(text) {
  const idIndex = text.indexOf('#id:');
  const match = (idIndex === -1 ? text : text.slice(0, idIndex)).match(/^(\s*jump\s+)(.*?)\s*$/);
  if (!match || match[2] === '') { return null; }
  const target = match[2];
  const targetStart = match[1].length;
  const translationIdStart = idIndex;
  const lastSlash = target.lastIndexOf('/');
  if (lastSlash === -1) {
    return { target, timeline: null, label: target, targetStart, labelStart: targetStart, translationIdStart };
  }
  return {
    target,
    timeline: target.slice(0, lastSlash),
    label: target.slice(lastSlash + 1).trim(),
    targetStart,
    labelStart: targetStart + lastSlash + 1,
    translationIdStart,
  };
}

/**
 * @typedef {{line: number, nameStart: number, displayName: string|null, doc: string}} DtlLabelInfo
 */

/**
 * Collect every label of a timeline with its documentation: the
 * consecutive `##` comment lines directly above it (same convention as
 * GDScript documentation comments - a plain `#` comment doesn't count).
 *
 * @param {string[]} lines
 * @returns {Map<string, DtlLabelInfo>}
 */
function collectLabelsFromLines(lines) {
  const labels = new Map();
  for (let line = 0; line < lines.length; line++) {
    const label = parseLabelLine(lines[line]);
    if (!label || labels.has(label.name)) { continue; }
    const docLines = [];
    for (let above = line - 1; above >= 0; above--) {
      const docMatch = lines[above].match(/^\s*##\s?(.*)$/);
      if (!docMatch) { break; }
      docLines.unshift(docMatch[1]);
    }
    labels.set(label.name, { line, nameStart: label.nameStart, displayName: label.displayName, doc: docLines.join('\n').trim() });
  }
  return labels;
}

/**
 * @param {vscode.TextDocument} document
 * @returns {string[]}
 */
function documentLines(document) {
  const lines = [];
  for (let line = 0; line < document.lineCount; line++) { lines.push(document.lineAt(line).text); }
  return lines;
}

/**
 * @param {vscode.TextDocument} document
 * @returns {Map<string, DtlLabelInfo>}
 */
function collectDocumentLabels(document) {
  return collectLabelsFromLines(documentLines(document));
}

/**
 * Reserved bracket command names that are NOT balises, even though they
 * share the bare `[name]` shape (e.g. `[wait]`, `[end_timeline]`). Mirrors
 * the negative lookahead in the grammar's `#balises` rule.
 *
 * @type {Set<string>}
 */
const RESERVED_BRACKET_NAMES = new Set([
  'wait', 'wait_input', 'audio', 'voice', 'clear',
  'background', 'style', 'signal', 'text_input', 'end_timeline'
]);

// =============================================================================
// MOOD / EMOTION HELPERS
// =============================================================================

/**
 * Line-start keywords that are never a character name, even though they
 * can be immediately followed by '(' in valid DTL (e.g. a boolean
 * expression like `if (x)`). Keeps detectMoodContext from mistaking that
 * for a `Character (mood)` tag.
 *
 * @type {Set<string>}
 */
const RESERVED_LINE_KEYWORDS = new Set([
  'if', 'else', 'elif', 'set', 'label', 'jump', 'join', 'update', 'leave', 'audio', 'do', 'return'
]);

// =============================================================================
// PLAY IN GODOT
// =============================================================================
// Plays a timeline the way Dialogic's own "Play timeline" button does: it
// writes the timeline in Dialogic's editor settings
// (`user://dialogic/editor_settings.cfg`, section [DES]:
// `current_timeline_path`, `play_from_index`), then runs Dialogic's test
// scene, which starts that timeline.

/**
 * The index of the Dialogic event each line of a timeline belongs to - the
 * `play_from_index` Dialogic's own "Play from here" uses. Mirrors
 * DialogicTimeline.process(): every non-empty line is an event (comments
 * included), a text line ending with `\` and a `[shortcode` not closed by
 * `]` go on over the next lines, and Dialogic inserts an invisible "end
 * branch" event after each if/elif/else/choice block - when the
 * indentation goes back, and after a block left empty. An empty line
 * belongs to the event after it.
 *
 * @param {string[]} lines
 * @returns {number[]} event index, by line
 */
function computeDialogicEventIndices(lines) {
  const indices = [];
  let count = 0;
  let previousIndent = '';
  let indentFormat = '';
  let previousWasOpener = false;
  const stripLeft = text => text.replace(/^[\x00-\x20]+/, ''); // Godot's strip_edges(true, false)
  for (let line = 0; line < lines.length; line++) {
    indices[line] = count;
    const stripped = stripLeft(lines[line]);
    if (stripped === '') { continue; }
    const indent = lines[line].slice(0, lines[line].length - stripped.length);
    if (indent && !indentFormat) { indentFormat = indent; }
    if (indent.length < previousIndent.length && indentFormat) {
      count += Math.floor(previousIndent.length / indentFormat.length) - Math.floor(indent.length / indentFormat.length);
    }
    if (previousWasOpener && indent.length <= previousIndent.length) { count++; }
    previousIndent = indent;
    // An event may continue over the next lines (until an empty line).
    const isShortcode = !!bracketEventName(stripped); // `[b]Hi[/b]` starting a text is not one
    // Dialogic's condition event: "if"/"elif" alone or followed by a space, or anything starting with "else".
    const isCondition = /^(?:(?:if|elif)(?: |$)|else)/.test(stripped);
    const keyword = (stripped.match(/^([a-z_]+)(?: |$)/) || [])[1];
    const isText = !isShortcode && !isCondition && !/^[#-]/.test(stripped) && !(keyword && RESERVED_LINE_KEYWORDS.has(keyword));
    let content = stripped;
    const isFull = () => (isShortcode ? content.split('#id:')[0].trim().endsWith(']') : !(isText && content.endsWith('\\')));
    while (!isFull() && line + 1 < lines.length) {
      line++;
      indices[line] = count; // the empty line ending it included, like Dialogic
      const next = stripLeft(lines[line]);
      if (next === '') { break; }
      content += '\n' + next;
    }
    count++;
    previousWasOpener = isCondition || stripped.startsWith('-');
  }
  return indices;
}

// =============================================================================
// SPELLING SUGGESTIONS
// =============================================================================

/**
 * A character name as it must be written in a timeline: quoted when it
 * contains spaces or symbols (same rule as createCharacterCompletion).
 *
 * @param {string} name
 * @returns {string}
 */
function formatCharacterName(name) {
  if (!/[^\p{L}0-9_]/u.test(name)) { return name; }
  const quote = name.includes('"') ? "'" : '"';
  return `${quote}${name}${quote}`;
}

// =============================================================================
// QUICK FIXES
// =============================================================================
// Lightbulb fixes (Ctrl+.) for the problems DTL Reader reports: the closest
// existing names for a typo, creating what's missing (a label, a portrait),
// and removing or closing what's wrong (a jump's #id, an unclosed BBCode
// tag). Each fix re-reads the line its diagnostic points at rather than
// storing data on the diagnostic, so it always matches the current text.

/**
 * The character a timeline line is about: its speaker, or the character
 * of a join/update/leave.
 *
 * @param {string} text
 * @returns {string | null}
 */
function findLineCharacter(text) {
  const match = text.match(new RegExp(`^\\s*(?:(?:join|update|leave)\\s+)?(${CHARACTER_NAME_SOURCE})`, 'u'));
  if (!match) { return null; }
  const name = stripCharacterNameQuotes(match[1]);
  return RESERVED_LINE_KEYWORDS.has(name) ? null : name;
}

/**
 * The first BBCode tag of a line that has no closing tag on it, if any -
 * the same rule as findUnclosedBaliseDiagnostics.
 *
 * @param {string} text
 * @returns {string | null} the tag name
 */
function findUnclosedTag(text) {
  // `[name]`, or `[name=value]` / `[name key=value ...]` (group 2 set).
  const openTagPattern = /\[([A-Za-z_][A-Za-z0-9_]*)([=\s][^\]]*)?\]/g;
  let match;
  while ((match = openTagPattern.exec(text)) !== null) {
    const tagName = match[1];
    if (RESERVED_BRACKET_NAMES.has(tagName) || bbcode.SELF_CLOSING_BBCODE_NAMES.has(tagName) || textEffects.TEXT_EFFECT_NAMES.has(tagName)) {
      continue; // a DTL command, a Dialogic text effect ([aa], [n]...) or a BBCode tag like [br] - none has a closer
    }
    // With parameters, only real Godot BBCode tags need a closer - Dialogic's
    // own text effects ([pause=1.5], [speed=2], [portrait=happy]...) don't.
    if (match[2] !== undefined && !bbcode.DTL_BBCODES.some(entry => entry.name === tagName)) {
      continue;
    }
    if (!text.includes(`[/${tagName}]`)) { return tagName; }
  }
  return null;
}

Object.assign(module.exports, {
  bracketEventName,
  CHARACTER_NAME_SOURCE,
  stripCharacterNameQuotes,
  splitCommandArguments,
  extractCharacterNamePrefix,
  findCharacterNameAtPosition,
  findLineSpeaker,
  isInsideDialogueText,
  isPlayerFacingTextLine,
  parseLabelLine,
  parseJumpLine,
  collectLabelsFromLines,
  documentLines,
  collectDocumentLabels,
  RESERVED_BRACKET_NAMES,
  RESERVED_LINE_KEYWORDS,
  computeDialogicEventIndices,
  formatCharacterName,
  findLineCharacter,
  findUnclosedTag,
});
