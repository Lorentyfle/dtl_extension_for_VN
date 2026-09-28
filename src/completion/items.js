// -----------------------------------------------------------------------------
// Building suggestions: events, parameters and values, paths, labels,
// characters, text effects, BBCode, words...
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const events = require('../docs/events');
const bbcode = require('../docs/bbcode');
const textEffects = require('../docs/text-effects');
const syntax = require('../timeline/syntax');
const timelineMoods = require('../timeline/moods');
const documentation = require('../documentation');
const sources = require('./sources');

// =============================================================================
// DIALOGIC TEXT EFFECTS AND MODIFIERS
// =============================================================================
// Dialogic's own commands inside text (not Godot BBCode): effects happen
// when the reveal reaches them ([pause=0.5], [portrait=happy], [aa]...),
// modifiers change the text before it's shown ([if ...], <a/b>). From
// Dialogic's Text/Character/Core modules (_get_text_effects,
// _get_text_modifiers) and docs.dialogic.pro/text-effects.html.

/**
 * Completion item for a Dialogic text effect after `[` - the same event
 * icon as Dialogic's commands, since both are Dialogic's own.
 *
 * @param {object} entry - one of DTL_TEXT_EFFECTS
 * @param {vscode.Range} range - the typed name plus an auto-closed "]"
 * @returns {vscode.CompletionItem}
 */
function createTextEffectCompletion(entry, range) {
  const item = new vscode.CompletionItem({ label: entry.name, description: documentation.summarizeDescription(entry.description) }, vscode.CompletionItemKind.Event);
  item.detail = `Dialogic text effect - ${entry.syntax}`;
  item.documentation = documentation.createDocumentation(entry);
  item.sortText = `0b_${entry.name}`;
  item.insertText = new vscode.SnippetString(entry.snippet);
  item.range = range;
  if (entry.valueFrom) { item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' }; }
  return item;
}

/**
 * Values for `[portrait=`, `[mood=` and `[extra_data=` in a dialogue line:
 * the speaker's portraits, typing sound moods, or LayeredPortrait layers
 * (of the line's mood, else of whichever portrait has layers).
 *
 * @param {string} line
 * @param {string} effectName
 * @param {string} typedValue
 * @returns {vscode.CompletionItem[]}
 */
function createTextEffectValueSuggestions(line, effectName, typedValue) {
  const speaker = syntax.findLineSpeaker(line);
  if (!speaker) { return []; }
  const entry = textEffects.DTL_TEXT_EFFECTS.find(candidate => candidate.name === effectName);
  const item = (label, detail, kind) => {
    const completion = new vscode.CompletionItem(label, kind);
    completion.detail = detail;
    return completion;
  };
  if (entry.valueFrom === 'portraits') {
    const moods = sources.completionCharacterMoods(speaker.name);
    return moods ? [...moods.keys()].filter(mood => mood.toLowerCase().startsWith(typedValue.toLowerCase())).map(mood => item(mood, `Portrait of ${speaker.name}`, vscode.CompletionItemKind.EnumMember)) : [];
  }
  if (entry.valueFrom === 'soundMoods') {
    return (state.cachedCharacterSoundMoods.get(speaker.name) || []).filter(mood => mood.toLowerCase().startsWith(typedValue.toLowerCase())).map(mood => item(mood, `Typing sound mood of ${speaker.name}`, vscode.CompletionItemKind.EnumMember));
  }
  if (entry.valueFrom === 'layers') {
    if (!/^set\s/.test(typedValue)) {
      return 'set '.startsWith(typedValue) ? [Object.assign(item('set', 'Switch a LayeredPortrait layer: set Layer/Child', vscode.CompletionItemKind.Keyword), { insertText: 'set ', command: { command: 'editor.action.triggerSuggest', title: 'Suggest layers' } })] : [];
    }
    return timelineMoods.createEmotionPathSuggestions(`join ${/\s/.test(speaker.name) ? `"${speaker.name}"` : speaker.name}${speaker.mood ? ` (${speaker.mood})` : ''} center`, typedValue);
  }
  return [];
}

/**
 * Look up a bracket command (DTL_ENTRIES, type "bracket") or Godot BBCode
 * tag (DTL_BBCODES) by name - DTL's own commands win if a name is shared.
 *
 * @param {string} name
 * @returns {object | undefined}
 */
function findBracketOrBbcodeEntry(name) {
  return events.DTL_ENTRIES.find(entry => entry.name === name && entry.type === 'bracket')
    || bbcode.DTL_BBCODES.find(entry => entry.name === name);
}

// =============================================================================
// CHARACTER / BACKGROUND ANIMATION
// =============================================================================

/**
 * Completion item for a known attribute VALUE, e.g. "Bounce In" for
 * `animation=`. Values with spaces need quoting; if the person already
 * typed the opening quote themselves, only the bare value is inserted so
 * the quote isn't duplicated.
 *
 * @param {string} value
 * @param {boolean} alreadyQuoted
 * @returns {vscode.CompletionItem}
 */
function createValueCompletion(value, alreadyQuoted) {
  const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember);
  item.detail = 'DTL value';
  item.insertText = alreadyQuoted ? value : `"${value}"`;
  return item;
}

/**
 * Build completion items for an attribute's VALUE (the part after '='), if
 * `entryName`/`attributeName` has a known suggestion list registered in
 * DTL_ATTRIBUTE_VALUE_SUGGESTIONS.
 *
 * @param {string} entryName - DTL_ENTRIES name the attribute belongs to (e.g. "join")
 * @param {string} attributeName - e.g. "animation"
 * @param {string} typedValue - raw text typed so far after '=' (quote included, if any)
 * @param {vscode.Position} position - cursor position, for path suggestions' replace range
 * @returns {vscode.CompletionItem[]}
 */
function createAttributeValueSuggestions(entryName, attributeName, typedValue, position) {
  const values = events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[entryName] && events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[entryName][attributeName];
  if (values) {
    const alreadyQuoted = typedValue.startsWith('"');
    const prefix = (alreadyQuoted ? typedValue.slice(1) : typedValue).toLowerCase();
    return values
      .filter(value => value.toLowerCase().startsWith(prefix))
      .map(value => createValueCompletion(value, alreadyQuoted));
  }
  const pathExtensions = events.DTL_PATH_ATTRIBUTES[entryName] && events.DTL_PATH_ATTRIBUTES[entryName][attributeName];
  if (pathExtensions) {
    return createPathSuggestions(typedValue, position, pathExtensions);
  }
  return [];
}

/**
 * Completion item for a Godot `res://` resource path.
 *
 * @param {string} path - e.g. "res://assets/ost/my_music.mp3"
 * @param {boolean} quote - wrap the inserted path in quotes (none typed yet)
 * @param {vscode.Range} range - the whole path typed so far, so accepting
 *   replaces it instead of only its last "word" (VS Code's default word
 *   stops at '/' and ':', which duplicated the "res://" part)
 * @returns {vscode.CompletionItem}
 */
function createPathCompletion(path, quote, range) {
  const item = new vscode.CompletionItem(path, vscode.CompletionItemKind.File);
  item.detail = 'Godot resource path';
  item.insertText = quote ? `"${path}"` : path;
  item.filterText = quote ? `"${path}"` : path;
  item.range = range;
  return item;
}

/**
 * Build completion items for a `res://` path value, filtered by whatever
 * has been typed so far after the opening quote (if any), and - when
 * `extensions` is given - to only the files a command can actually use
 * (see RESOURCE_EXTENSIONS). Backed by cachedResourcePaths, refreshed
 * alongside project.godot.
 *
 * @param {string} typedValue - raw text typed so far for the value (opening quote included, if any)
 * @param {vscode.Position} position - cursor position (the end of typedValue)
 * @param {string[]} [extensions] - allowed file extensions, lowercase, no dot
 * @param {{quote?: boolean}} [options] - `quote: false` never wraps the
 *   path in quotes, for values that aren't quoted (e.g. `[img]path[/img]`)
 * @returns {vscode.CompletionItem[]}
 */
function createPathSuggestions(typedValue, position, extensions, options = {}) {
  const alreadyQuoted = typedValue.startsWith('"');
  const typedPath = alreadyQuoted ? typedValue.slice(1) : typedValue;
  const prefix = typedPath.toLowerCase();
  const quote = options.quote !== false && !alreadyQuoted;
  const range = new vscode.Range(position.line, position.character - typedPath.length,position.line, position.character);
  return sources.completionResourcePaths()
    .filter(path => path.toLowerCase().startsWith(prefix))
    .filter(path => !extensions || extensions.includes(path.slice(path.lastIndexOf('.') + 1).toLowerCase()))
    .map(path => createPathCompletion(path, quote, range));
}

// =============================================================================
// COMPLETION ITEM HELPERS
// =============================================================================

/**
 * Completion item for a Dialogic command/event (`join`, `[wait]`, ...).
 * Uses the Event kind (lightning-bolt icon) - Dialogic calls these
 * "events" itself - so in a `[` list they're told apart at a glance from
 * Godot BBCode tags, which keep the Keyword icon.
 *
 * @param {object} entry - one of DTL_ENTRIES
 * @returns {vscode.CompletionItem}
 */
function createCommandCompletion(entry) {
  const item = new vscode.CompletionItem({ label: entry.name, description: documentation.summarizeDescription(entry.description) }, vscode.CompletionItemKind.Event);
  item.detail = entry.syntax;
  item.documentation = documentation.createDocumentation(entry);
  return item;
}

function createPositionCompletion(position) {
  const item = new vscode.CompletionItem(position.name,vscode.CompletionItemKind.EnumMember);
  item.detail = 'DTL character position';
  item.documentation =
    new vscode.MarkdownString(position.description);
  return item;
}

/**
 * Completion item for a character name. Names that aren't valid bare
 * identifiers (contain a space or other symbol) are inserted pre-quoted -
 * double quotes by default, or single quotes if the name itself contains a
 * `"` - since a bare insertion would otherwise produce invalid DTL.
 *
 * @param {string} name
 * @param {vscode.Range} [range] - explicit range to replace, needed when the
 *   text already typed includes a quote or spaces that VS Code's default
 *   word-boundary detection wouldn't select as part of the same edit.
 * @returns {vscode.CompletionItem}
 */
function createCharacterCompletion(name, range) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
  item.detail = 'Dialogic character (from project.godot)';
  const written = syntax.formatCharacterName(name);
  if (written !== name) {
    item.insertText = written;
    item.detail += ' - name contains spaces/symbols, quoted automatically';
  }
  if (range) { item.range = range; }
  return item;
}

/**
 * Isolate the `key=value` (or bare `key`) token currently being typed
 * inside a `[...]` bracket's argument text, e.g. the last token in
 * `time=1.5 fade` is `fade`.
 *
 * A plain `lastIndexOf(' ')` split breaks as soon as a value itself
 * contains a space - e.g. `extra_data="set ` has a space *inside* the
 * open quote, so naively splitting on the last space would throw away
 * `extra_data="` and see only `` (or a stray word), leaving `set ...`
 * value completions (like the emotion node-path autocomplete) with
 * nothing to work from. This instead checks whether an odd number of `"`
 * puts us inside an open string, and if so, keeps the whole
 * `key="partial value` back to that key's `=`.
 *
 * @param {string} argumentsText - bracket content typed so far (no brackets)
 * @returns {string}
 */
function getCurrentBracketToken(argumentsText) {
  const insideOpenString = (argumentsText.match(/"/g) || []).length % 2 === 1;
  if (insideOpenString) {
    const lastQuoteIndex = argumentsText.lastIndexOf('"');
    const beforeQuote = argumentsText.slice(0, lastQuoteIndex);
    const lastSpaceBeforeQuote = beforeQuote.lastIndexOf(' ');
    const keyPart = beforeQuote.slice(lastSpaceBeforeQuote + 1);
    const valuePart = argumentsText.slice(lastQuoteIndex);
    return keyPart + valuePart;
  }
  const lastSpaceIndex = argumentsText.lastIndexOf(' ');
  return argumentsText.slice(lastSpaceIndex + 1);
}

/**
 * Completion item for a bracket command's parameter name, e.g. `time` in
 * `[wait time=1.5]`. Inserts `name=` (via a snippet) so the cursor lands
 * right after the `=`, ready for the value.
 *
 * @param {string} name
 * @param {string} doc
 * @returns {vscode.CompletionItem}
 */
function createAttributeCompletion(name, doc) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
  item.detail = 'DTL bracket parameter';
  item.documentation = new vscode.MarkdownString(doc);
  item.insertText = new vscode.SnippetString(`${name}=$0`);
  item.command = {
    command: 'editor.action.triggerSuggest',
    title: 'Show DTL value suggestions'
  };
  return item;
}

/**
 * Collect every unique "word" (letters, apostrophes, hyphens - so accented
 * names and contractions like "don't" work too) already used anywhere in
 * the document. Used to power VS Code-style word-based suggestions for
 * spoken dialogue text.
 *
 * @param {vscode.TextDocument} document
 * @returns {string[]}
 */
function collectDocumentWords(document) {
  const wordPattern = /[\p{L}][\p{L}'\u2019-]*/gu;
  const words = new Set();
  const text = document.getText();
  let match;
  while ((match = wordPattern.exec(text)) !== null) {
    if (match[0].length > 1) {
      words.add(match[0]);
    }
  }
  return Array.from(words);
}

/**
 * Build Text completion items from words already used in the document,
 * filtered by whatever word fragment is currently being typed.
 *
 * @param {vscode.TextDocument} document
 * @param {string} beforeCursor
 * @returns {vscode.CompletionItem[]}
 */
function createWordSuggestions(document, beforeCursor) {
  const prefixMatch = beforeCursor.match(/[\p{L}'\u2019-]*$/u);
  const prefix = (prefixMatch ? prefixMatch[0] : '').toLowerCase();

  const items = createGlossaryWordSuggestions(prefix);
  const glossaryWords = new Set(items.map(item => item.label.label));
  for (const word of collectDocumentWords(document)) {
    if (prefix && !word.toLowerCase().startsWith(prefix)) {
      continue;
    }
    if (glossaryWords.has(word)) { continue; }
    items.push(new vscode.CompletionItem(word, vscode.CompletionItemKind.Text));
  }
  return items;
}

// =============================================================================
// LABEL / JUMP HELPERS
// =============================================================================

/**
 * Completion item for a label, after `jump `.
 *
 * @param {string} name
 * @param {DtlLabelInfo} labelInfo
 * @param {vscode.Range} range - the label text typed so far (labels can contain spaces)
 * @param {string|null} timeline - the timeline it belongs to, if not this one
 * @returns {vscode.CompletionItem}
 */
function createLabelCompletion(name, labelInfo, range, timeline) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
  item.detail = timeline ? `DTL label of ${timeline}` : 'DTL label (jump target)';
  if (labelInfo) { item.documentation = documentation.createLabelDocumentation(name, labelInfo, timeline); }
  item.range = range;
  return item;
}

/**
 * Completion item for another timeline, after `jump `. Inserts `Name/` and
 * re-triggers suggestions so its labels show up next.
 *
 * @param {string} identifier
 * @param {vscode.Range} range
 * @returns {vscode.CompletionItem}
 */
function createTimelineCompletion(identifier, range) {
  const item = new vscode.CompletionItem(`${identifier}/`, vscode.CompletionItemKind.File);
  item.detail = `Dialogic timeline - ${state.cachedTimelinePaths.get(identifier)}`;
  item.documentation = new vscode.MarkdownString(`Jump to another timeline: \`${identifier}/\` starts it from the beginning, \`${identifier}/label\` from one of its labels.`);
  item.range = range;
  item.sortText = `1_${identifier}`;
  item.command = { command: 'editor.action.triggerSuggest', title: 'Show the timeline labels' };
  return item;
}

// =============================================================================
// AUDIO HELPERS
// =============================================================================

function createAudioKindCompletion(name) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
  item.detail = 'Dialogic audio channel (from project.godot)';
  return item;
}

function createAudioPathCompletion() {
  const item = new vscode.CompletionItem('""', vscode.CompletionItemKind.Snippet);
  item.detail = 'Audio file path';
  item.insertText = new vscode.SnippetString('"$0"');
  item.documentation = new vscode.MarkdownString('Path to the audio file, e.g. `res://assets/ost/my_music.mp3`.');
  return item;
}

// =============================================================================
// BALISE HELPERS
// =============================================================================

/**
 * True when `textBeforeBracket` (a line up to a just-typed `[`) is inside
 * player-facing text - dialogue, narration or a choice - i.e. where a
 * Godot BBCode tag makes sense, as opposed to a standalone `[command]` line.
 *
 * @param {string} textBeforeBracket
 * @returns {boolean}
 */
function isInPlayerFacingText(textBeforeBracket) {
  return /^\s*-\s/.test(textBeforeBracket) || syntax.isInsideDialogueText(textBeforeBracket);
}

/**
 * Completion item for a Godot BBCode tag, typed after `[`. Inserts the
 * whole tag as a snippet - `b]|[/b]` for a paired tag, `br]` for a
 * self-closing one, or the entry's own `snippet` for tags taking a value
 * (`color=red]|[/color]`) - with the cursor landing between the tags.
 *
 * @param {object} entry - one of DTL_BBCODES
 * @param {vscode.Range} range - the tag name typed so far, plus an
 *   auto-closed `]` right after the cursor if there is one
 * @returns {vscode.CompletionItem}
 */
function createBbcodeCompletion(entry, range) {
  const item = new vscode.CompletionItem({ label: entry.name, description: documentation.summarizeDescription(entry.description) }, vscode.CompletionItemKind.Keyword);
  item.detail = `Godot BBCode - ${entry.syntax}`;
  item.documentation = documentation.createDocumentation(entry);
  item.sortText = `1_${entry.name}`;
  item.insertText = new vscode.SnippetString(
    entry.snippet || (entry.selfClosing ? `${entry.name}]` : `${entry.name}]$0[/${entry.name}]`)
  );
  item.range = range;
  return item;
}

/**
 * Build completions for a closing tag being typed (`[/`), offering the
 * tags still open earlier on the line - innermost first, so the tag that
 * should be closed next is the default pick.
 *
 * @param {string} textBeforeTag - the line up to the `[/` being typed
 * @param {string} prefix - tag name typed so far after `[/`
 * @param {string} line - the full line
 * @param {vscode.Position} position
 * @returns {vscode.CompletionItem[]}
 */
function createClosingTagSuggestions(textBeforeTag, prefix, line, position) {
  const openTags = [];
  const tagPattern = /\[(\/)?([A-Za-z_][A-Za-z0-9_]*)(?:[=\s][^\]]*)?\]/g;
  let match;
  while ((match = tagPattern.exec(textBeforeTag)) !== null) {
    const [, isClosing, name] = match;
    if (syntax.RESERVED_BRACKET_NAMES.has(name) || bbcode.SELF_CLOSING_BBCODE_NAMES.has(name) || textEffects.TEXT_EFFECT_NAMES.has(name)) { continue; }
    if (!isClosing) {
      openTags.push(name);
    } else {
      const openIndex = openTags.lastIndexOf(name);
      if (openIndex !== -1) { openTags.splice(openIndex, 1); }
    }
  }
  const nameStart = position.character - prefix.length;
  const replaceEnd = line[position.character] === ']' ? position.character + 1 : position.character;
  const range = new vscode.Range(position.line, nameStart, position.line, replaceEnd);
  const seen = new Set();
  const items = [];
  openTags.reverse().forEach((name, index) => {
    if (seen.has(name) || !name.toLowerCase().startsWith(prefix.toLowerCase())) { return; }
    seen.add(name);
    const item = new vscode.CompletionItem(`/${name}`, vscode.CompletionItemKind.Keyword);
    item.detail = `Close [${name}]`;
    item.filterText = name;
    item.insertText = `${name}]`;
    item.range = range;
    item.sortText = String(index).padStart(3, '0');
    items.push(item);
  });
  return items;
}

// =============================================================================
// DIALOGIC CHARACTER FILES (.dch)
// =============================================================================
// A .dch file is Godot's var_to_str() of inst_to_dict(DialogicCharacter):
// a GDScript-literal dictionary. These describe its keys, per nesting level,
// for autocomplete and hover. Taken from Dialogic's own DialogicCharacter
// resource (addons/dialogic/Resources/character.gd) and character editor.

/** Escape literal text for a snippet (VS Code snippets treat $ } \ specially). */
const escapeSnippetText = text => text.replace(/[$}\\]/g, '\\$&');

// =============================================================================
// GLOSSARY
// =============================================================================
// Dialogic's glossaries (.tres DialogicGlossary resources listed in
// project.godot's `dialogic/glossary/glossary_files`): words that get a
// colored link in the game's text, with a title, a text and extra info.
// Here, those words get their color with a dotted underline in dialogue,
// narration and choices, and hovering one shows the entry.

/**
 * Glossary words as suggestions while writing dialogue.
 *
 * @param {string} prefix - lowercase word fragment typed so far
 * @returns {vscode.CompletionItem[]}
 */
function createGlossaryWordSuggestions(prefix) {
  const items = [];
  for (const entry of state.cachedGlossaryEntries) {
    for (const word of [entry.name, ...entry.alternatives]) {
      if (!word || (prefix && !word.toLowerCase().startsWith(prefix))) { continue; }
      const item = new vscode.CompletionItem({ label: word, description: 'glossary' }, vscode.CompletionItemKind.Reference);
      item.documentation = new vscode.MarkdownString(`**${entry.title || entry.name}**\n\n${entry.text}`);
      item.sortText = `0_${word}`;
      items.push(item);
    }
  }
  return items;
}

Object.assign(module.exports, {
  createTextEffectCompletion,
  createTextEffectValueSuggestions,
  findBracketOrBbcodeEntry,
  createAttributeValueSuggestions,
  createPathSuggestions,
  createCommandCompletion,
  createPositionCompletion,
  createCharacterCompletion,
  getCurrentBracketToken,
  createAttributeCompletion,
  createWordSuggestions,
  createLabelCompletion,
  createTimelineCompletion,
  createAudioKindCompletion,
  createAudioPathCompletion,
  isInPlayerFacingText,
  createBbcodeCompletion,
  createClosingTagSuggestions,
  escapeSnippetText,
});
