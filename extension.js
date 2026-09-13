// extension.js
// -----------------------------------------------------------------------------
// DTL language support for Dialogic 2 Timeline (.dtl) files.
//
// Provides:
// - Character autocomplete from project.godot
// - Command autocomplete
// - Contextual character/position autocomplete for join/leave/update
// - Word-based autocomplete for spoken dialogue text (named or narration)
// - Parameter-name autocomplete + hover docs inside bracket commands
// - Hover documentation for commands and balises
// - Go to Definition for `jump NAME` -> `label NAME`
// - Diagnostics: unresolved `jump` targets, unclosed [balise] tags
// -----------------------------------------------------------------------------

const vscode = require('vscode');

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

/**
 * Find the `Global.function_name` call under the cursor on a `do`/`if`/
 * `elif` line, if any, resolved against cachedAutoloadFunctions. Used by
 * the hover provider - isGlobalScriptExpressionLine is defined further
 * down alongside the completion logic that shares this same line shape.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{globalName: string, functionName: string, info: {params: string, returnType: string|null, doc: string}, range: vscode.Range} | null}
 */
function findGlobalFunctionCallAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  if (!isGlobalScriptExpressionLine(line)) { return null; }
  const callPattern = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = callPattern.exec(line)) !== null) {
    const [, globalName, functionName] = match;
    const funcStart = match.index + globalName.length + 1;
    const funcEnd = funcStart + functionName.length;
    if (position.character < funcStart || position.character > funcEnd) { continue; }
    const functions = cachedAutoloadFunctions.get(globalName);
    const info = functions && functions.get(functionName);
    if (!info) { return null; }
    return { globalName, functionName, info, range: new vscode.Range(position.line, funcStart, position.line, funcEnd) };
  }
  return null;
}

// =============================================================================
// DTL DOCUMENTATION
// =============================================================================
const DTL_ENTRIES = [
  {
    name: 'label',
    type: 'command',
    syntax: 'label NAME',
    description: 'Create a label on the timeline that can be reached with a jump command. A good use of label would be for a scene change or loop.',
    example: 'label Laripo_starts_reading_the_documentation'
  },
  {
    name: 'jump',
    type: 'command',
    syntax: 'jump NAME',
    description: 'Jumps to a given label written after.',
    example: 'jump Laripo_starts_reading_the_documentation'
  },
  {
    name: 'return',
    type: 'command',
    syntax: 'return',
    description: 'Returns to the latest jump event or end the timeline (if no jump happened before).',
    example: 'return'
  },
  {
    name: 'set',
    type: 'command',
    syntax: 'set {variable} = variable_to_set',
    description: 'Command that sets a variable from Dialogic or a global variable towards a given value. Increments can also be accepted.',
    example: 'set {chapter} = 4'
  },
  {
    name: 'join',
    type: 'command',
    syntax: 'join character position [...]',
    description: 'Make a character join on a given position with a given extra information. The variables given are the one set inside the [].',
    example: 'join Laripo center [extra_data="set Emotion/Happy"]',
    transform_command: {
      // transform command are given to entries that possess it. It is here for the documentation, but those are entries after the character name and before the [].
      'pos': 'Position of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%. The position is relative to the viewport and defines the portrait origin, usually its bottom center.',
      'size': 'Size of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%.',
      'rot': 'Rotation of the character in degrees. The portrait rotates around its origin, usually its bottom center.',
    },
    variables: {
      // variable_name : documentation
      'animation': 'Name of the animation to play when the character joins.',
      'length': 'Length of the animation in seconds. Only used when an animation is set.',
      'wait': 'Whether to wait for the animation to finish before continuing. Only used when an animation is set.',
      'mirrored': 'Whether to mirror the character sprite horizontally.',
      'z_index': "Controls the character draw order. Higher values appear in front of lower values. This uses Dialogic's character sorting rather than Godot's z-index.",
      'extra_data': "Additional data passed to the character portrait. For LayeredSprite2D portraits, this can be used to change elements, for example: set Arm/Happy. The path after \"set \" is autocompleted from the character's LayeredPortrait scene.",
    }
  },
  {
    name: 'update',
    type: 'command',
    syntax: 'update character position [...]',
    description: 'Update a joined character on a given position with a given extra information. The variables given are the one set inside the [].',
    example: 'update Laripo center [extra_data="set Emotion/Happy"]',
    transform_command: {
      // transform command are given to entries that possess it. It is here for the documentation, but those are entries after the character name and before the [].
      'pos': 'Position of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%. The position is relative to the viewport and defines the portrait origin, usually its bottom center.',
      'size': 'Size of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%.',
      'rot': 'Rotation of the character in degrees. The portrait rotates around its origin, usually its bottom center.',
    },
    variables: {
      // variable_name : documentation
      'animation': 'Name of the animation to play while updating the character.',
      'length': 'Length of the animation in seconds. Only used when an animation is set.',
      'wait': 'Whether to wait for the animation to finish before continuing. Only used when an animation is set.',
      'mirrored': 'Whether to mirror the character sprite horizontally.',
      'z_index': "Controls the character draw order. Higher values appear in front of lower values. This uses Dialogic’s character sorting rather than Godot's z-index.",
      'fade': 'Name of the crossfade animation used when changing the character portrait. If omitted, the default portrait fade is used.',
      'move_time': 'Duration of the position transition in seconds.',
      'move_trans': 'Transition type used when moving the character to a new position.',
      'repeat': 'Number of times to repeat the animation. Only used with move_time or move_trans.',
      'move_ease': 'Easing used when moving the character to a new position.',
      'fade_length': 'Duration of the portrait fade in seconds.',
      'extra_data': "Additional data passed to the character portrait. For LayeredSprite2D portraits, this can be used to change elements, for example: set Arm/Happy. The path after \"set \" is autocompleted from the character's LayeredPortrait scene.",    }
  },
  {
    name: 'leave',
    type: 'command',
    syntax: 'leave character [...]',
    description: 'Make a character leave the scene with a given extra information. The variables given are the one set inside the []. If one write `leave --All--` all joined characters will leave.',
    example: 'leave Laripo [animation="Slide To Left"]',
    variables: {
      // variable_name : documentation
      'animation': 'Name of the animation to play when the character leaves.',
      'length': 'Length of the animation in seconds. Only used when an animation is set.',
      'wait': 'Whether to wait for the animation to finish before continuing. Only used when an animation is set.',
    }
  },
  {
    name: 'do',
    type: 'command',
    syntax: 'do Global.function()',
    description: 'Run a given function on a global script.',
    example: 'do VnLibrary.apply_emotions()'
  },
  {
    name: 'wait',
    type: 'bracket',
    syntax: '[wait ...]',
    description: 'Pauses the progress of the timeline for a given amount of time.',
    example: '[wait 1.5] [wait time="1.0"]',
    variables: {
      // variable_name : documentation
      'time': 'Duration of the wait in seconds.',
      'hide_text': 'Whether to hide the text while waiting.',
      'skippable': 'Whether the wait can be skipped by the player.',
    }
  },
  {
    name: 'wait_input',
    type: 'bracket',
    syntax: '[wait_input ...]',
    description: 'Waits for user input before continuing the timeline.',
    example: '[wait_input]',
    variables: {
      // variable_name : documentation
      "hide_text":"Whether to hide the text while waiting for input."
    }
  },
  {
    name: 'audio',
    type: 'command',
    syntax: 'audio KIND "path"',
    description: 'Adds an audio event, kind is the kind of audio used, for example music. It was set inside Dialogic.',
    example: 'audio music "res://assets/ost/my_music.mp3"'
  },
  {
    name: 'voice',
    type: 'bracket',
    syntax: '[voice ...]',
    description: 'Adds a voice event.',
    example: '[voice path="res://assets/voices/Laripo_dialogueID_666.mp3"]',
    variables: {
      // variable_name : documentation
      'path': 'Path to the voice audio file.',
      'volume': 'Volume adjustment for the voice audio.',
      'bus': 'Audio bus used to play the voice audio.',
    }
  },
  {
    name: 'clear',
    type: 'bracket',
    syntax: '[clear ...]',
    description: 'Clears the relevant dialogue/display state.',
    example: '[clear time="1.0"]',
    variables: {
      // variable_name : documentation
      "time":"Duration of the fade in seconds. Set to 0 for an instant clear.",
      "step":"Wether to clear each element one after another. The order is Textbox, Portraits, Backgrounds, Audio, then Styles. (true by default)",
      "text":"Wether to clear the text (true by default)",
      "portraits":"Wether to clear the portraits (true by default)",
      "music":"Wether to clear the audio (true by default)",
      "background":"Wether to clear the background (true by default)",
      "position":"Wether to clear character position (true by default)",
      "style":"Wether to clear the style (true by default)",
    }
  },
  {
    name: 'background',
    type: 'bracket',
    syntax: '[background ...]',
    description: 'Changes the background.',
    example: '[background arg="res://assets/sprite/new_background.png" fade="0.0"]',
    variables: {
      // variable_name : documentation
      'arg': 'Background to display. This can be an image path, a color, or another string argument.',
      'scene': 'Path to the background scene.',
      'transition': 'Transition used when changing the background.',
      'fade': 'Duration of the background fade in seconds.',
      'wait': 'Whether to wait for the transition to finish before continuing.',
    }
  },
  {
    name: 'style',
    type: 'bracket',
    syntax: '[style ...]',
    description: 'Changes the dialogic style used. The name needs to correspond to a setup style loaded in the extension.',
    example: '[style name="default"]',
    variables: {
      // variable_name : documentation
      "name":"Name of the style to use."
    }
  },
  {
    name: 'signal',
    type: 'bracket',
    syntax: '[signal ...]',
    description: 'Send a dialogic signal with given arguments.',
    example: '[signal arg_type="dict" arg="{\"Amount\":100,\"Effect\":\"Rain\",\"Nature\":\"meteo\",\"Windx\":20.0,\"Windy\":1.0}"]',
    variables: {
      // variable_name : documentation
      'arg_type': 'Type of the argument sent with the Dialogic signal.',
      'arg': 'Argument sent with the Dialogic signal.',
    }
  },
  {
    name: 'text_input',
    type: 'bracket',
    syntax: '[text_input ...]',
    description: 'Make a text input prompt appear that would save the data in a variable.',
    example: '[text_input text="Solve: 4x - 67 = 0" var="_butterfly_effect.part1.introduction.answer_equation1" placeholder="No idea" allow_empty="true"]',
    variables: {
      // variable_name : documentation
      'text': 'Text displayed above the text input.',
      'var': 'Variable where the entered text will be stored.',
      'placeholder': 'Text displayed in the input field when it is empty.',
      'default': 'Default value used when no text is entered.',
      'allow_empty': 'Whether the input can be submitted without any text.',
    }
  },
  {
    name: 'end_timeline',
    type: 'bracket',
    syntax: '[end_timeline]',
    description: 'Ends the current timeline.',
    example: '[end_timeline]',
    variables: {
    }
  },
  {
    name: 'b',
    type: 'bracket',
    syntax: '[b] ... [/b]',
    description: 'BBCode-style balise: wraps the enclosed dialogue/narration/choice text in bold.',
    example: 'Laripo: This is [b]important[/b].'
  },
  {
    name: 'i',
    type: 'bracket',
    syntax: '[i] ... [/i]',
    description: 'BBCode-style balise: wraps the enclosed dialogue/narration/choice text in italics.',
    example: 'Laripo: This is [i]interesting[/i].'
  },
  {
    name: 'u',
    type: 'bracket',
    syntax: '[u] ... [/u]',
    description: 'BBCode-style balise: wraps the enclosed dialogue/narration/choice text in an underline.',
    example: 'Laripo: This is [u]underlined[/u].'
  },
  {
    name: 's',
    type: 'bracket',
    syntax: '[s] ... [/s]',
    description: 'BBCode-style balise: wraps the enclosed dialogue/narration/choice text in a strikethrough.',
    example: 'Laripo: This is [s]struck out[/s].'
  }
];
// =============================================================================
// POSITIONS
// =============================================================================
const DTL_POSITIONS = [
  {
    name: 'left',
    description: 'Place the character on the left side.'
  },
  {
    name: 'right',
    description: 'Place the character on the right side.'
  },
  {
    name: 'center',
    description: 'Place the character in the center.'
  },
  {
    name: 'leftmost',
    description: 'Place the character at the far left.'
  },
  {
    name: 'rightmost',
    description: 'Place the character at the far right.'
  }
];
// =============================================================================
// CHARACTER / BACKGROUND ANIMATION
// =============================================================================
const DTL_ANIMATION_JOIN = [
  "Bounce In",
  "Fade In Down",
  "Fade In",
  "Fade In Up",
  "Instant In",
  "Slide In Down",
  "Slide From Left",
  "Slide From Right",
  "Slide In Up",
  "Zoom Center In",
  "Zoom In",
];
const DTL_ANIMATION_LEAVE = [
  "Bounce Out",
  "Fade Out Up",
  "Fade Out",
  "Fade Out Down",
  "Instant Out",
  "Slide Out Up",
  "Slide To Left",
  "Slide To Right",
  "Slide Out Down",
  "Zoom Center Out",
  "Zoom Out",
];
const DTL_TRANSITION = [
  "Push Down",
  "Push Left",
  "Push Right",
  "Push Up",
  "Simple Fade",
  "Swipe Diagonal Up Left",
  "Swipe Left To Right",
  "Swipe Right To Left"
];
const DTL_ANIMATION_UPDATE = [
  "Bounce",
  "Heartbeat",
  "Shake X",
  "Shake Y",
  "Tada",
];
const DTL_MOVE_EASE = [
  "In",
  "Out",
  "In_Out",
  "Out_In",
];
const DTL_MOVE_TRANS = [
  "Linear",
  "Sine",
  "Quint",
  "Quart",
  "Quad",
  "Expo",
  "Elastic",
  "Cubic",
  "Circ",
  "Bounce",
  "Back",
  "Spring",
];

/**
 * Known value suggestions for specific attribute names, scoped per
 * DTL_ENTRIES name so e.g. join's `animation=` offers DTL_ANIMATION_JOIN
 * while leave's `animation=` offers DTL_ANIMATION_LEAVE instead.
 *
 * @type {Record<string, Record<string, string[]>>}
 */
const DTL_ATTRIBUTE_VALUE_SUGGESTIONS = {
  join: { animation: DTL_ANIMATION_JOIN },
  update: { animation: DTL_ANIMATION_UPDATE, move_trans: DTL_MOVE_TRANS, move_ease: DTL_MOVE_EASE },
  leave: { animation: DTL_ANIMATION_LEAVE },
  background: { transition: DTL_TRANSITION },
};

/**
 * Bracket-command attributes whose value is a Godot `res://` resource path,
 * e.g. `[voice path="res://..."]`. Keyed the same way as
 * DTL_ATTRIBUTE_VALUE_SUGGESTIONS (entry name -> list of attribute names),
 * so createAttributeValueSuggestions can fall back to path suggestions
 * when no fixed enum of values applies.
 *
 * @type {Record<string, string[]>}
 */
const DTL_PATH_ATTRIBUTES = {
  voice: ['path'],
  background: ['arg', 'scene'],
};

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
 * @returns {vscode.CompletionItem[]}
 */
function createAttributeValueSuggestions(entryName, attributeName, typedValue) {
  const values = DTL_ATTRIBUTE_VALUE_SUGGESTIONS[entryName] && DTL_ATTRIBUTE_VALUE_SUGGESTIONS[entryName][attributeName];
  if (values) {
    const alreadyQuoted = typedValue.startsWith('"');
    const prefix = (alreadyQuoted ? typedValue.slice(1) : typedValue).toLowerCase();
    return values
      .filter(value => value.toLowerCase().startsWith(prefix))
      .map(value => createValueCompletion(value, alreadyQuoted));
  }
  const pathAttributes = DTL_PATH_ATTRIBUTES[entryName];
  if (pathAttributes && pathAttributes.includes(attributeName)) {
    return createPathSuggestions(typedValue);
  }
  return [];
}

/**
 * Completion item for a Godot `res://` resource path.
 *
 * @param {string} path - e.g. "res://assets/ost/my_music.mp3"
 * @param {boolean} alreadyQuoted
 * @returns {vscode.CompletionItem}
 */
function createPathCompletion(path, alreadyQuoted) {
  const item = new vscode.CompletionItem(path, vscode.CompletionItemKind.File);
  item.detail = 'Godot resource path';
  item.insertText = alreadyQuoted ? path : `"${path}"`;
  return item;
}

/**
 * Build completion items for a `res://` path attribute, filtered by
 * whatever has been typed so far after the opening quote (if any).
 * Backed by cachedResourcePaths, refreshed alongside project.godot.
 *
 * @param {string} typedValue - raw text typed so far after '=' (quote included, if any)
 * @returns {vscode.CompletionItem[]}
 */
function createPathSuggestions(typedValue) {
  const alreadyQuoted = typedValue.startsWith('"');
  const prefix = (alreadyQuoted ? typedValue.slice(1) : typedValue).toLowerCase();
  return cachedResourcePaths
    .filter(path => path.toLowerCase().startsWith(prefix))
    .map(path => createPathCompletion(path, alreadyQuoted));
}

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/** Character names found in project.godot. @type {string[]} */
let cachedCharacterNames = [];

/** Audio channel/kind names found in project.godot's audio/channel_defaults. @type {string[]} */
let cachedAudioChannels = [];

/** Folder containing project.godot, i.e. the Godot project root. @type {vscode.Uri | null} */
let projectRootUri = null;

/** Every workspace file, expressed as a `res://`-relative path from the project root. @type {string[]} */
let cachedResourcePaths = [];

/**
 * Per character, every mood declared in their `.dch` file's "portraits"
 * dict, mapped to that mood's parsed LayeredPortrait node tree - or
 * `null` for a plain single-image mood (no "scene" key), which has no
 * node tree to offer. Powers both the `(mood)` tag autocomplete and the
 * `extra_data="set ..."` node-path autocomplete.
 *
 * @type {Map<string, Map<string, Map<string, string[]> | null>>}
 */
let cachedCharacterMoods = new Map();

/**
 * project.godot's `[dialogic]` `variables={...}` dictionary, parsed into a
 * path tree: each segment maps to either a leaf (its default value, as raw
 * GDScript text - a number, boolean, string, Color(...), etc.) or a Map of
 * further child segments, mirroring the dictionary's own nesting. Powers
 * `{variable.path}` autocomplete.
 *
 * @type {Map<string, {value: string|null, children: Map|null}>}
 */
let cachedVariablesTree = new Map();

/**
 * Per character, the documentation-relevant fields declared in their
 * `.dch` file - display_name, nicknames, description, and color - used to
 * build the hover shown when hovering a character name. A character with
 * none of these fields declared simply has no hover.
 *
 * @type {Map<string, {displayName: string|null, nicknames: string[], description: string|null, color: string|null}>}
 */
let cachedCharacterInfo = new Map();

/**
 * Per autoload/global-script name (from project.godot's `[autoload]`
 * section), the top-level functions declared in that `.gd` script - name
 * -> {params, returnType, doc}, where `doc` is the GDScript `##`
 * documentation comment directly above the function, if any. Powers
 * `Global.function_name(...)` autocomplete and hover after `do`, `if`, and
 * `elif`. An autoload whose script isn't a `.gd` file (e.g. a singleton
 * scene) simply has no entry here.
 *
 * @type {Map<string, Map<string, {params: string, returnType: string|null, doc: string}>>}
 */
let cachedAutoloadFunctions = new Map();

function extractCharacterNames(text) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return []; }
  const dictionaryMatch = sectionMatch[1].match(/directories\/dch_directory\s*=\s*\{([\s\S]*?)\}/);
  if (!dictionaryMatch) { return []; }
  const keyPattern = /"([^"]+)"\s*:\s*"[^"]*"/g;
  const names = [];
  let match;
  while ((match = keyPattern.exec(dictionaryMatch[1])) !== null) { names.push(match[1]); }
  return names;
}

/**
 * Extract audio channel names from `audio/channel_defaults = { ... }`.
 * Each top-level key (e.g. "music", "loopSFX") is what `audio KIND "path"`
 * expects as its first argument. Only top-level keys are followed directly
 * by a nested "{" - the inner keys (audio_bus, fade_length, loop, volume)
 * are followed by a plain value instead, so no bracket-depth tracking is
 * needed to tell them apart once the outer dict body is isolated.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractAudioChannels(text) {
  const headerMatch = text.match(/audio\/channel_defaults\s*=\s*\{/);
  if (!headerMatch) { return []; }

  const openBraceIndex = headerMatch.index + headerMatch[0].length - 1;
  const body = extractBalancedBraces(text, openBraceIndex);
  if (body === null) { return []; }

  const keyPattern = /"([^"]*)"\s*:\s*\{/g;
  const names = [];
  let match;
  while ((match = keyPattern.exec(body)) !== null) { names.push(match[1]); }
  return names;
}

/**
 * Return the substring between `text[openBraceIndex]` (a '{') and its
 * matching closing '}', tracking nesting depth. Needed because
 * channel_defaults is a dict-of-dicts, unlike the flat dch_directory dict.
 *
 * @param {string} text
 * @param {number} openBraceIndex
 * @returns {string | null}
 */
function extractBalancedBraces(text, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') { depth++; }
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { return text.slice(openBraceIndex + 1, i); }
    }
  }
  return null;
}

/**
 * Scan a dictionary body (text already inside its outer '{'...'}') into an
 * ordered list of `{key, rawValue, childBody}` entries, one per top-level
 * `"key": value` pair - where `value` can be either a nested dict (in
 * which case `childBody` is that dict's own already-brace-stripped body
 * and `rawValue` is `null`) or any other GDScript literal (a number,
 * boolean, string, `Color(...)`, array, ...), kept verbatim as `rawValue`
 * with `childBody` `null`. Unlike extractTopLevelDictEntries (which only
 * recognizes entries whose value is itself a dict), this also captures
 * leaf entries - needed for `variables={...}`, where a key's value is
 * either a nested group or a plain default value.
 *
 * @param {string} dictBody
 * @returns {{key: string, rawValue: string|null, childBody: string|null}[]}
 */
function scanDictEntries(dictBody) {
  const entries = [];
  const keyPattern = /&?"([^"]+)"\s*:\s*/g;
  let match;
  while ((match = keyPattern.exec(dictBody)) !== null) {
    const valueStart = keyPattern.lastIndex;
    if (dictBody[valueStart] === '{') {
      const childBody = extractBalancedBraces(dictBody, valueStart);
      if (childBody === null) { break; } // unterminated - stop rather than misparse the rest
      entries.push({ key: match[1], rawValue: null, childBody });
      keyPattern.lastIndex = valueStart + childBody.length + 2; // past the matching '}'
      continue;
    }
    // Leaf value: scan forward to the next top-level ',' (or the end of
    // this dict body), respecting nested (), [], {} depth so a value like
    // Color(0.5, 0.5, 1, 1) or [1, 2] doesn't get cut short at its own commas.
    let depth = 0;
    let end = valueStart;
    while (end < dictBody.length) {
      const ch = dictBody[end];
      if (ch === '(' || ch === '[' || ch === '{') { depth++; }
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) { break; } // belongs to the enclosing dict, not this value
        depth--;
      } else if (ch === ',' && depth === 0) { break; }
      end++;
    }
    entries.push({ key: match[1], rawValue: dictBody.slice(valueStart, end).trim(), childBody: null });
    keyPattern.lastIndex = end;
  }
  return entries;
}

/**
 * Recursively parse a dictionary body into a path tree: each key maps to
 * either a leaf (`value` holds its raw default, `children` is `null`) or a
 * further nested Map (`value` is `null`, `children` holds the subtree) -
 * mirroring the dictionary's own nesting. Powers `{variable.path}`
 * autocomplete, one path segment at a time, the same way
 * createEmotionPathSuggestions walks a LayeredPortrait's node tree.
 *
 * @param {string} dictBody
 * @returns {Map<string, {value: string|null, children: Map|null}>}
 */
function parseNestedDictTree(dictBody) {
  const tree = new Map();
  for (const { key, rawValue, childBody } of scanDictEntries(dictBody)) {
    tree.set(key, childBody !== null
      ? { value: null, children: parseNestedDictTree(childBody) }
      : { value: rawValue, children: null });
  }
  return tree;
}

/**
 * Extract project.godot's `[dialogic]` `variables={...}` dictionary into a
 * path tree (see parseNestedDictTree). Empty if no variables are declared.
 *
 * @param {string} text - raw project.godot content
 * @returns {Map<string, {value: string|null, children: Map|null}>}
 */
function extractVariablesTree(text) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const headerMatch = sectionMatch[1].match(/variables\s*=\s*\{/);
  if (!headerMatch) { return new Map(); }
  const openBraceIndex = headerMatch.index + headerMatch[0].length - 1;
  const body = extractBalancedBraces(sectionMatch[1], openBraceIndex);
  if (body === null) { return new Map(); }
  return parseNestedDictTree(body);
}

/**
 * Resolve a `res://`-style path to a filesystem Uri, relative to the
 * Godot project root (projectRootUri).
 *
 * @param {string} resPath - e.g. "res://dialogic/character/night/John.dch"
 * @returns {vscode.Uri}
 */
function resolveResourcePath(resPath) {
  return vscode.Uri.joinPath(projectRootUri, resPath.replace(/^res:\/\//, ''));
}

/**
 * Extract character name -> `res://` `.dch` path from project.godot's
 * `directories/dch_directory` dict, e.g. `{"John": "res://.../John.dch"}`.
 * Companion to extractCharacterNames, which only keeps the keys.
 *
 * @param {string} text - raw project.godot content
 * @returns {Map<string, string>}
 */
function extractCharacterPaths(text) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const dictionaryMatch = sectionMatch[1].match(/directories\/dch_directory\s*=\s*\{([\s\S]*?)\}/);
  if (!dictionaryMatch) { return new Map(); }
  const entryPattern = /"([^"]+)"\s*:\s*"([^"]*)"/g;
  const paths = new Map();
  let match;
  while ((match = entryPattern.exec(dictionaryMatch[1])) !== null) { paths.set(match[1], match[2]); }
  return paths;
}

/**
 * Extract autoload/global-script name -> `res://` script path from
 * project.godot's `[autoload]` section, e.g. `Global="*res://global.gd"`.
 * The optional leading `*` (marks it enabled in-editor) is ignored either
 * way. Entries pointing at a `.tscn` (a singleton scene rather than a
 * plain script) are kept too - refreshAutoloadFunctions filters those out
 * before trying to parse them as GDScript.
 *
 * @param {string} text - raw project.godot content
 * @returns {Map<string, string>}
 */
function extractAutoloadPaths(text) {
  const sectionMatch = text.match(/(?:^|\n)\[autoload\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const entryPattern = /(?:^|\n)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"\*?(res:\/\/[^"]+)"/g;
  const paths = new Map();
  let match;
  while ((match = entryPattern.exec(sectionMatch[1])) !== null) { paths.set(match[1], match[2]); }
  return paths;
}

/**
 * Scan a single line starting at `openParenIndex` (must point at a '(')
 * for its matching ')', tracking nested `()`/`[]`/`{}` depth so a
 * parameter's default value - e.g. `Color(1, 1, 1, 1)` or `[1, 2]` -
 * doesn't prematurely end the scan at its own closing character.
 * Multi-line function signatures aren't supported: the closing ')' must
 * be on the same line, or this returns -1.
 *
 * @param {string} line
 * @param {number} openParenIndex
 * @returns {number} index of the matching ')', or -1 if not found on this line
 */
function findMatchingParenOnLine(line, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth++; }
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && ch === ')') { return i; }
    }
  }
  return -1;
}

/**
 * Parse a GDScript file's top-level `func` declarations into a name ->
 * {params, returnType, doc} map, where `doc` is the GDScript
 * documentation-comment convention: consecutive `##`-prefixed lines
 * directly above the function (see
 * https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_documentation_comments.html).
 * Indented (nested/inner) functions are skipped, since only top-level
 * methods are callable as `Global.function_name(...)`; functions whose
 * name starts with `_` are skipped too, since that's GDScript's own
 * convention for "not meant to be called from outside" (this also
 * excludes engine lifecycle callbacks like `_ready`/`_process`, which
 * wouldn't make sense to call from dialogue anyway). Multi-line function
 * signatures aren't supported (see findMatchingParenOnLine); such a
 * function is simply skipped rather than misparsed.
 *
 * @param {string} text - raw .gd file content
 * @returns {Map<string, {params: string, returnType: string|null, doc: string}>}
 */
function parseGdScriptFunctions(text) {
  const functions = new Map();
  let pendingDocLines = [];
  for (const line of text.split(/\r?\n/)) {
    const docMatch = line.match(/^##\s?(.*)$/);
    if (docMatch) {
      pendingDocLines.push(docMatch[1]);
      continue;
    }
    const headerMatch = line.match(/^(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (headerMatch) {
      const name = headerMatch[1];
      const openParenIndex = headerMatch.index + headerMatch[0].length - 1;
      const closeParenIndex = findMatchingParenOnLine(line, openParenIndex);
      if (closeParenIndex !== -1 && !name.startsWith('_')) {
        const returnMatch = line.slice(closeParenIndex + 1).match(/^\s*->\s*([A-Za-z_][A-Za-z0-9_.]*)/);
        functions.set(name, {
          params: line.slice(openParenIndex + 1, closeParenIndex).trim(),
          returnType: returnMatch ? returnMatch[1] : null,
          doc: pendingDocLines.join('\n').trim(),
        });
      }
      pendingDocLines = [];
      continue;
    }
    // Any other non-blank, non-comment line breaks the doc-comment chain -
    // a `##` block only documents the symbol directly below it.
    if (line.trim() !== '' && !line.trim().startsWith('#')) {
      pendingDocLines = [];
    }
  }
  return functions;
}

/**
 * Split a dictionary body (the text already inside its outer '{'...'}')
 * into its top-level `"key": { ... }` entries, ignoring anything nested
 * deeper. Generic enough to reuse for any GDScript-ish nested dictionary;
 * currently only used by parseDchPortraits for the mood -> portrait dict.
 *
 * @param {string} dictBody
 * @returns {{key: string, body: string}[]}
 */
function extractTopLevelDictEntries(dictBody) {
  const entries = [];
  const keyPattern = /&?"([^"]+)"\s*:\s*\{/g;
  let match;
  while ((match = keyPattern.exec(dictBody)) !== null) {
    const openBraceIndex = match.index + match[0].length - 1;
    const body = extractBalancedBraces(dictBody, openBraceIndex);
    if (body === null) { continue; }
    entries.push({ key: match[1], body });
    keyPattern.lastIndex = openBraceIndex + body.length + 2; // skip past this nested block entirely
  }
  return entries;
}

/**
 * Parse a `.dch` character file's `"portraits"` dictionary into mood name
 * -> declared scene `res://` path (or `null` for a plain/single-image
 * portrait with no `"scene"` key). The file uses GDScript-ish resource
 * syntax (`&"key": value` dictionaries), so this walks brace-balanced
 * blocks rather than treating it as JSON.
 *
 * @param {string} text - raw .dch file content
 * @returns {Map<string, string|null>}
 */
function parseDchPortraits(text) {
  const portraits = new Map();
  const portraitsHeaderMatch = text.match(/&?"portraits"\s*:\s*\{/);
  if (!portraitsHeaderMatch) { return portraits; }
  const openBraceIndex = portraitsHeaderMatch.index + portraitsHeaderMatch[0].length - 1;
  const body = extractBalancedBraces(text, openBraceIndex);
  if (body === null) { return portraits; }

  for (const { key, body: moodBody } of extractTopLevelDictEntries(body)) {
    const sceneMatch = moodBody.match(/&?"scene"\s*:\s*"([^"]*)"/);
    portraits.set(key, sceneMatch ? sceneMatch[1] : null);
  }
  return portraits;
}

/**
 * Parse a Godot `Color(r, g, b[, a])` literal (components 0-1) into a CSS
 * `rgba(...)` string. Returns `null` if the text doesn't look like one.
 *
 * @param {string} rawValue - e.g. "Color(0.58, 0.39, 0.78, 1)"
 * @returns {string | null}
 */
function parseGodotColor(rawValue) {
  const match = rawValue.match(/Color\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!match) { return null; }
  const [, r, g, b, a] = match;
  const to255 = component => Math.round(parseFloat(component) * 255);
  const alpha = a !== undefined ? parseFloat(a) : 1;
  return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha})`;
}

/**
 * Escape text for safe embedding inside SVG/XML markup (used when
 * rendering a character's display name as an inline SVG image).
 *
 * @param {string} text
 * @returns {string}
 */
function escapeXmlText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Parse a `.dch` character file's documentation-relevant fields - used to
 * build the hover shown when hovering that character's name. Any field
 * that isn't declared is simply left `null`/empty; a character with none
 * of these declared just has no hover.
 *
 * @param {string} text - raw .dch file content
 * @returns {{displayName: string|null, nicknames: string[], description: string|null, color: string|null}}
 */
function parseDchCharacterInfo(text) {
  const displayNameMatch = text.match(/&?"display_name"\s*:\s*"([^"]*)"/);
  const descriptionMatch = text.match(/&?"description"\s*:\s*"([^"]*)"/);
  const colorMatch = text.match(/&?"color"\s*:\s*(Color\([^)]*\))/);

  const nicknames = [];
  const nicknamesMatch = text.match(/&?"nicknames"\s*:\s*\[([^\]]*)\]/);
  if (nicknamesMatch) {
    const itemPattern = /"([^"]*)"/g;
    let match;
    while ((match = itemPattern.exec(nicknamesMatch[1])) !== null) { nicknames.push(match[1]); }
  }

  return {
    displayName: displayNameMatch ? displayNameMatch[1] : null,
    nicknames,
    description: descriptionMatch ? descriptionMatch[1] : null,
    color: colorMatch ? parseGodotColor(colorMatch[1]) : null,
  };
}

/**
 * Render `text` as a small inline SVG image, colored with `cssColor`, as
 * Markdown image syntax. VS Code's hover Markdown has no syntax of its own
 * for colored text, but does render inline images - an SVG data URI is the
 * standard workaround, used here to show a character's display name in
 * their declared `color` like a colored title.
 *
 * @param {string} text
 * @param {string} cssColor - e.g. "rgba(148, 99, 199, 1)"
 * @returns {string} Markdown image syntax
 */
function createColoredTitleMarkdown(text, cssColor) {
  const escaped = escapeXmlText(text);
  const width = Math.max(40, text.length * 9 + 10);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22">`
    + `<text x="0" y="16" font-family="sans-serif" font-size="15" font-weight="bold" fill="${cssColor}">${escaped}</text>`
    + `</svg>`;
  const base64 = Buffer.from(svg).toString('base64');
  return `![${escaped}](data:image/svg+xml;base64,${base64})`;
}

/**
 * Build the hover shown for a character name, from their `.dch`-declared
 * display_name/nicknames/description/color. The title uses display_name
 * if declared (falling back to however the name was written in the .dtl
 * file), colored via createColoredTitleMarkdown if a color was declared.
 *
 * @param {string} rawName - the name as written at the hovered position
 * @param {{displayName: string|null, nicknames: string[], description: string|null, color: string|null}} info
 * @returns {vscode.MarkdownString}
 */
function createCharacterDocumentation(rawName, info) {
  const markdown = new vscode.MarkdownString();
  const title = info.displayName || rawName;
  if (info.color) {
    markdown.appendMarkdown(createColoredTitleMarkdown(title, info.color) + '\n\n');
  } else {
    markdown.appendMarkdown(`**${title}**\n\n`);
  }
  if (info.nicknames.length > 0) {
    markdown.appendMarkdown(`_Also known as: ${info.nicknames.join(', ')}_\n\n`);
  }
  if (info.description) {
    markdown.appendMarkdown(info.description);
  }
  return markdown;
}

/**
 * Build the hover shown for a `Global.function_name` call - its signature
 * (parameters and return type, from the .gd file itself) as the title,
 * followed by its GDScript `##` documentation comment, if any.
 *
 * @param {string} globalName
 * @param {string} functionName
 * @param {{params: string, returnType: string|null, doc: string}} info
 * @returns {vscode.MarkdownString}
 */
function createGlobalFunctionDocumentation(globalName, functionName, info) {
  const markdown = new vscode.MarkdownString();
  const returnPart = info.returnType ? ` -> ${info.returnType}` : '';
  markdown.appendCodeblock(`${globalName}.${functionName}(${info.params})${returnPart}`, 'gdscript');
  if (info.doc) {
    markdown.appendMarkdown(info.doc);
  } else {
    markdown.appendMarkdown('_No `##` documentation comment found above this function in its script._');
  }
  return markdown;
}

/**
 * Parse a LayeredPortrait `.tscn` scene into a parent-path -> child-names
 * map, e.g. `tree.get(".")` is the scene root's direct children,
 * `tree.get("Head/Left_Eye")` is that node's children. Godot writes each
 * node's full parent path (not just its immediate parent's name) in its
 * `parent="..."` attribute, so that value can be used directly as the map
 * key with no path-walking needed. The scene root itself never has a
 * `parent=` attribute, so it's naturally never suggested - no special
 * "skip the CanvasGroup" case required.
 *
 * Assumes `name=` appears before `parent=` on the same `[node ...]` line,
 * which matches Godot's own attribute ordering.
 *
 * @param {string} text - raw .tscn file content
 * @returns {Map<string, string[]>}
 */
function parseTscnNodeTree(text) {
  const childrenByParent = new Map();
  const nodePattern = /\[node\s+name="([^"]+)"[^\]]*?\bparent="([^"]*)"[^\]]*\]/g;
  let match;
  while ((match = nodePattern.exec(text)) !== null) {
    const [, name, parent] = match;
    if (!childrenByParent.has(parent)) { childrenByParent.set(parent, []); }
    childrenByParent.get(parent).push(name);
  }
  return childrenByParent;
}

/**
 * Re-read project.godot and refresh both caches from a single file read.
 */
async function refreshProjectGodotData() {
  const matches = await vscode.workspace.findFiles('**/project.godot', '**/.godot/**', 1);
  if (matches.length === 0) {
    cachedCharacterNames = [];
    cachedAudioChannels = [];
    cachedCharacterMoods = new Map();
    cachedVariablesTree = new Map();
    cachedCharacterInfo = new Map();
    cachedAutoloadFunctions = new Map();
    projectRootUri = null;
    cachedResourcePaths = [];
    return;
  }
  projectRootUri = vscode.Uri.joinPath(matches[0], '..');
  try {
    const bytes = await vscode.workspace.fs.readFile(matches[0]);
    const text = Buffer.from(bytes).toString('utf8');
    cachedCharacterNames = extractCharacterNames(text);
    cachedAudioChannels = extractAudioChannels(text);
    cachedVariablesTree = extractVariablesTree(text);
    await refreshCharacterMoods(extractCharacterPaths(text));
    await refreshAutoloadFunctions(extractAutoloadPaths(text));
  } catch (error) {
    console.error('DTL Reader: could not read project.godot', error);
    cachedCharacterNames = [];
    cachedAudioChannels = [];
    cachedCharacterMoods = new Map();
    cachedVariablesTree = new Map();
    cachedCharacterInfo = new Map();
    cachedAutoloadFunctions = new Map();
  }
  await refreshResourcePaths();
}

/**
 * For every declared autoload (project.godot's `[autoload]` section)
 * whose script is a `.gd` file, read it and parse its top-level functions
 * (see parseGdScriptFunctions), so `do`/`if`/`elif` can autocomplete
 * `Global.function_name(...)` calls with hover-ready documentation,
 * without touching disk on every keystroke. An autoload whose script
 * isn't a `.gd` file (a singleton scene), or is unreadable, is simply
 * left out rather than failing the whole refresh.
 *
 * @param {Map<string, string>} autoloadPaths - name -> res:// script path
 */
async function refreshAutoloadFunctions(autoloadPaths) {
  const functionsByGlobal = new Map();
  for (const [name, path] of autoloadPaths) {
    if (!path.toLowerCase().endsWith('.gd')) { continue; } // e.g. a singleton scene, not a script
    try {
      const bytes = await vscode.workspace.fs.readFile(resolveResourcePath(path));
      functionsByGlobal.set(name, parseGdScriptFunctions(Buffer.from(bytes).toString('utf8')));
    } catch (error) {
      console.error(`DTL Reader: autoload "${name}" declares script "${path}" but it could not be read - its functions will be unavailable for do/if/elif autocomplete.`, error);
    }
  }
  cachedAutoloadFunctions = functionsByGlobal;
}

/**
 * For every known character, read their `.dch` file and (for moods backed
 * by a LayeredPortrait scene) that scene's `.tscn` file, so `(mood)` tags
 * and `extra_data="set ..."` node paths can be autocompleted without
 * touching disk on every keystroke. Populates cachedCharacterMoods and
 * cachedCharacterInfo (display_name/nicknames/description/color, for the
 * character hover) from the same file read. A character with an
 * unreadable or malformed `.dch` file is simply left out rather than
 * failing the whole refresh.
 *
 * @param {Map<string, string>} characterPaths - name -> res:// .dch path
 */
async function refreshCharacterMoods(characterPaths) {
  const moodsByCharacter = new Map();
  const infoByCharacter = new Map();
  for (const [name, dchPath] of characterPaths) {
    try {
      const dchBytes = await vscode.workspace.fs.readFile(resolveResourcePath(dchPath));
      const dchText = Buffer.from(dchBytes).toString('utf8');
      const portraits = parseDchPortraits(dchText);
      infoByCharacter.set(name, parseDchCharacterInfo(dchText));

      const moods = new Map();
      for (const [moodName, scenePath] of portraits) {
        if (!scenePath) {
          moods.set(moodName, null);
          continue;
        }
        try {
          const tscnBytes = await vscode.workspace.fs.readFile(resolveResourcePath(scenePath));
          moods.set(moodName, parseTscnNodeTree(Buffer.from(tscnBytes).toString('utf8')));
        } catch (error) {
          console.error(`DTL Reader: mood "${moodName}" for "${name}" declares scene "${scenePath}" but it could not be read - extra_data node-path autocomplete will be unavailable for this mood.`, error);
          moods.set(moodName, null); // scene referenced but unreadable - mood name still valid
        }
      }
      moodsByCharacter.set(name, moods);
    } catch (error) {
      console.error(`DTL Reader: character "${name}" declares .dch path "${dchPath}" but it could not be read or parsed - no mood data or hover documentation for this character.`, error);
    }
  }
  cachedCharacterMoods = moodsByCharacter;
  cachedCharacterInfo = infoByCharacter;
}

/**
 * Re-list every file under the Godot project root and cache each one as a
 * `res://`-relative path, for the `[voice path="..."]` / `[background
 * arg="..."]`-style path autocomplete. No-op if project.godot hasn't been
 * found yet.
 */
async function refreshResourcePaths() {
  if (!projectRootUri) {
    cachedResourcePaths = [];
    return;
  }
  try {
    const files = await vscode.workspace.findFiles('**/*', '**/{.git,.godot,node_modules}/**');
    const rootPath = projectRootUri.fsPath.replace(/\\/g, '/');
    cachedResourcePaths = files
      .map(uri => uri.fsPath.replace(/\\/g, '/'))
      .filter(fsPath => fsPath.startsWith(rootPath))
      .map(fsPath => 'res://' + fsPath.slice(rootPath.length).replace(/^\/+/, ''));
  } catch (error) {
    console.error('DTL Reader: could not list project resource files', error);
    cachedResourcePaths = [];
  }
}

/**
 * Diagnostic collection used to warn about `jump` targets that have no
 * matching `label` declaration in the same document.
 *
 * @type {vscode.DiagnosticCollection}
 */
let diagnosticCollection;

// =============================================================================
// MARKDOWN DOCUMENTATION HELPER
// =============================================================================
function createDocumentation(entry) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${entry.name}**\n\n`);
  markdown.appendMarkdown(`${entry.description}\n\n`);
  markdown.appendMarkdown(`**Syntax:** \`${entry.syntax}\`\n\n`);
  if (entry.variables && Object.keys(entry.variables).length > 0) {
    markdown.appendMarkdown('**Parameters:**\n\n');
    for (const [name, doc] of Object.entries(entry.variables)) {
      markdown.appendMarkdown(`- \`${name}\`: ${doc}\n`);
    }
    markdown.appendMarkdown('\n');
  }
  if (entry.example) {
    markdown.appendMarkdown('**Example:**\n\n');
    markdown.appendCodeblock(entry.example,'dtl');
  }
  return markdown;
}
// =============================================================================
// COMPLETION ITEM HELPERS
// =============================================================================
function createCommandCompletion(entry) {
  const item = new vscode.CompletionItem(entry.name,vscode.CompletionItemKind.Keyword);
  item.detail = entry.syntax;
  item.documentation = createDocumentation(entry);
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
  const needsQuoting = /[^\p{L}0-9_]/u.test(name);
  if (needsQuoting) {
    const quote = name.includes('"') ? "'" : '"';
    item.insertText = `${quote}${name}${quote}`;
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
 * A line with no `Character:` prefix still counts as spoken/narrated text
 * in Dialogic, unless it's actually something else: blank, a comment, a
 * choice, a standalone bracket command, or a flow/command keyword line.
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
  if (/^\s*\[/.test(beforeCursor)) {
    return false; // standalone bracket command, e.g. [wait 1]
  }
  if (/^\s*(if|else|elif|set|label|jump|while|join|leave|update|audio|do|return)\b/.test(beforeCursor)) {
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

  const items = [];
  for (const word of collectDocumentWords(document)) {
    if (prefix && !word.toLowerCase().startsWith(prefix)) {
      continue;
    }
    items.push(new vscode.CompletionItem(word, vscode.CompletionItemKind.Text));
  }
  return items;
}

// =============================================================================
// LABEL / JUMP HELPERS
// =============================================================================

/**
 * Find the `label NAME` declaration matching a jump target.
 *
 * @param {vscode.TextDocument} document
 * @param {string} labelName
 * @returns {vscode.Location | undefined}
 */
function findLabelLocation(document, labelName) {
  const labelDeclaration = new RegExp(`^\\s*label\\s+(${labelName})\\b`);
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = labelDeclaration.exec(text);
    if (match) {
      const nameStart = match.index + match[0].length - match[1].length;
      return new vscode.Location(document.uri, new vscode.Position(line, nameStart));
    }
  }
  return undefined;
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

/**
 * Scan every `jump NAME` line and flag targets with no matching `label
 * NAME` anywhere in the same file, so a broken jump shows up as a warning
 * even when it can't be resolved by "Go to Definition".
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnresolvedJumpDiagnostics(document) {
  const declaredLabels = new Set();
  for (let line = 0; line < document.lineCount; line++) {
    const match = document.lineAt(line).text.match(/^\s*label\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (match) {
      declaredLabels.add(match[1]);
    }
  }

  const diagnostics = [];
  // Anchored to the start of the line (ignoring leading whitespace): a real
  // `jump` command is always its own line, never embedded inside a `#`
  // comment or inside spoken dialogue text, so this naturally excludes both.
  const jumpLinePattern = /^\s*jump\s+([A-Za-z_][A-Za-z0-9_]*)/;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = text.match(jumpLinePattern);
    if (!match) {
      continue;
    }
    const targetName = match[1];
    if (declaredLabels.has(targetName)) {
      continue;
    }
    const nameStart = match[0].length - targetName.length;
    const range = new vscode.Range(line, nameStart, line, nameStart + targetName.length);
    diagnostics.push(new vscode.Diagnostic(
      range,
      `No "label ${targetName}" found in this file, so ctrl+click can't jump there.`,
      vscode.DiagnosticSeverity.Warning
    ));
  }

  return diagnostics;
}

function createLabelCompletion(name) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
  item.detail = 'DTL label (jump target)';
  return item;
}

/**
 * Collect every label name declared via `label NAME` in the document.
 * Powers `jump` autocomplete.
 *
 * @param {vscode.TextDocument} document
 * @returns {string[]}
 */
function collectDocumentLabels(document) {
  const labelPattern = /^\s*label\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const labels = new Set();
  for (let line = 0; line < document.lineCount; line++) {
    const match = document.lineAt(line).text.match(labelPattern);
    if (match) { labels.add(match[1]); }
  }
  return Array.from(labels);
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
  'if', 'else', 'elif', 'set', 'label', 'jump', 'while', 'join', 'update', 'leave', 'audio', 'do', 'return'
]);

/**
 * Detect a `(mood` being typed right after a character name - either as a
 * dialogue speaker's mood tag (`John (happy`) or after join/update's
 * character argument (`join John (happy`).
 *
 * @param {string} beforeCursor
 * @returns {{character: string, typedMood: string} | null}
 */
function detectMoodContext(beforeCursor) {
  const dialogueMatch = beforeCursor.match(new RegExp(`^\\s*(${CHARACTER_NAME_SOURCE})\\s*\\(([\\p{L}_][\\p{L}0-9_]*)?$`, 'u'));
  if (dialogueMatch) {
    const character = stripCharacterNameQuotes(dialogueMatch[1]);
    if (!RESERVED_LINE_KEYWORDS.has(character)) {
      return { character, typedMood: dialogueMatch[2] || '' };
    }
  }
  const commandMatch = beforeCursor.match(new RegExp(`^\\s*(?:join|update)\\s+(${CHARACTER_NAME_SOURCE})\\s*\\(([\\p{L}_][\\p{L}0-9_]*)?$`, 'u'));
  if (commandMatch) {
    return { character: stripCharacterNameQuotes(commandMatch[1]), typedMood: commandMatch[2] || '' };
  }
  return null;
}

/**
 * Completion item for a mood name, e.g. `happy` in `John (happy):`.
 *
 * @param {string} name
 * @param {boolean} hasSceneTree - true if this mood is a LayeredPortrait
 *   backed by a parsed .tscn scene (vs. a plain single-image portrait)
 * @returns {vscode.CompletionItem}
 */
function createMoodCompletion(name, hasSceneTree) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
  item.detail = hasSceneTree ? 'DTL mood (LayeredPortrait)' : 'DTL mood';
  return item;
}

/**
 * Build `(mood)` completions for a character, from cachedCharacterMoods.
 *
 * @param {string} character
 * @param {string} typedMood - mood text typed so far
 * @returns {vscode.CompletionItem[]}
 */
function createMoodSuggestions(character, typedMood) {
  const moods = cachedCharacterMoods.get(character);
  if (!moods) { return []; }
  const prefix = typedMood.toLowerCase();
  const items = [];
  for (const [moodName, tree] of moods) {
    if (moodName.toLowerCase().startsWith(prefix)) {
      items.push(createMoodCompletion(moodName, !!tree));
    }
  }
  return items;
}

/**
 * Find the character named on a `join`/`update` line, resolve their mood
 * (from a `(mood)` tag if present and it has a scene, else whichever
 * portrait does have a scene - `leave` is excluded since its `variables`
 * don't include `extra_data` at all), and return that mood's parsed
 * LayeredPortrait node tree, if any.
 *
 * @param {string} lineText
 * @returns {Map<string, string[]> | null}
 */
function findMoodTreeForLine(lineText) {
  const commandMatch = lineText.match(new RegExp(`^\\s*(?:join|update)\\s+(${CHARACTER_NAME_SOURCE})`, 'u'));
  if (!commandMatch) { return null; }
  const moods = cachedCharacterMoods.get(stripCharacterNameQuotes(commandMatch[1]));
  if (!moods) { return null; }

  const moodTagMatch = lineText.match(new RegExp(`^\\s*(?:join|update)\\s+${CHARACTER_NAME_SOURCE}\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\)`, 'u'));
  if (moodTagMatch && moods.get(moodTagMatch[1])) {
    return moods.get(moodTagMatch[1]);
  }
  // No usable mood tag typed yet - fall back to whichever portrait does
  // have a scene, since that's the only one extra_data's node path could
  // possibly refer to.
  for (const tree of moods.values()) {
    if (tree) { return tree; }
  }
  return null;
}

/**
 * The full path of a tree node, in the same "parent/child" shape Godot
 * itself uses for `parent="..."` attributes - i.e. how a node's own path
 * looks when used to look up ITS children.
 *
 * @param {string} parentPath - "." for the scene root
 * @param {string} name
 * @returns {string}
 */
function childNodePath(parentPath, name) {
  return parentPath === '.' ? name : `${parentPath}/${name}`;
}

/**
 * Completion item for one segment of an `extra_data="set ..."` node path.
 * Nodes with children of their own re-trigger suggestions once '/' is
 * typed, via the Folder kind plus a re-trigger command.
 *
 * @param {string} name
 * @param {boolean} hasChildren
 * @returns {vscode.CompletionItem}
 */
function createEmotionNodeCompletion(name, hasChildren) {
  const item = new vscode.CompletionItem(name, hasChildren ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.EnumMember);
  item.detail = 'LayeredPortrait node';
  if (hasChildren) {
    item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL child nodes' };
  }
  return item;
}

/**
 * Build `extra_data="set ..."` node-path completions for the character
 * (and mood, if typed) on the given line, walking the parsed
 * LayeredPortrait node tree one path segment at a time - typing
 * `Head/Left_Eye/` lists that node's children, matching how the tree
 * itself is nested.
 *
 * @param {string} lineText - full text of the current line
 * @param {string} typedValue - raw text typed so far after `extra_data=` (quote included, if any)
 * @returns {vscode.CompletionItem[]}
 */
function createEmotionPathSuggestions(lineText, typedValue) {
  const afterQuote = typedValue.startsWith('"') ? typedValue.slice(1) : typedValue;
  // Only "set <path>" values carry a node path - anything else (or "set "
  // not typed yet) has nothing to suggest.
  const setMatch = afterQuote.match(/^set\s+(.*)$/);
  if (!setMatch) { return []; }
  const typedPath = setMatch[1];

  const tree = findMoodTreeForLine(lineText);
  if (!tree) { return []; }

  const lastSlash = typedPath.lastIndexOf('/');
  const parentPath = lastSlash === -1 ? '.' : (typedPath.slice(0, lastSlash) || '.');
  const prefix = (lastSlash === -1 ? typedPath : typedPath.slice(lastSlash + 1)).toLowerCase();

  const children = tree.get(parentPath) || [];
  return children
    .filter(name => name.toLowerCase().startsWith(prefix))
    .map(name => createEmotionNodeCompletion(name, tree.has(childNodePath(parentPath, name))));
}

// =============================================================================
// VARIABLE HELPERS
// =============================================================================

/**
 * Completion item for one segment of a `{variable.path}` reference, from
 * project.godot's `variables={...}`. A group (has children) re-triggers
 * suggestions once '.' is typed, via the Folder kind plus a re-trigger
 * command, the same way a LayeredPortrait node with children does.
 *
 * @param {string} name
 * @param {{value: string|null, children: Map|null}} entry
 * @returns {vscode.CompletionItem}
 */
function createVariableCompletion(name, entry) {
  const hasChildren = !!entry.children;
  const item = new vscode.CompletionItem(name, hasChildren ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Variable);
  item.detail = hasChildren ? 'Dialogic variable group' : `Dialogic variable - default: ${entry.value}`;
  if (hasChildren) {
    item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL child variables' };
  }
  return item;
}

/**
 * Build `{variable.path}` completions from cachedVariablesTree, walking
 * one path segment at a time - typing `variable.` lists `variable`'s
 * children, mirroring how extra_data's LayeredPortrait node paths work.
 *
 * @param {string} typedPath - text typed so far inside the currently open '{'
 * @returns {vscode.CompletionItem[]}
 */
function createVariableSuggestions(typedPath) {
  const lastDot = typedPath.lastIndexOf('.');
  const parentSegments = lastDot === -1 ? [] : typedPath.slice(0, lastDot).split('.');
  const prefix = (lastDot === -1 ? typedPath : typedPath.slice(lastDot + 1)).toLowerCase();

  let level = cachedVariablesTree;
  for (const segment of parentSegments) {
    const entry = level.get(segment);
    if (!entry || !entry.children) { return []; } // unknown group, or a leaf - nothing further to suggest
    level = entry.children;
  }

  const items = [];
  for (const [name, entry] of level) {
    if (name.toLowerCase().startsWith(prefix)) {
      items.push(createVariableCompletion(name, entry));
    }
  }
  return items;
}

// =============================================================================
// GLOBAL SCRIPT (AUTOLOAD) FUNCTION HELPERS
// =============================================================================

/**
 * True when `text` - either what's been typed so far on a line, or a full
 * line - starts a `do`/`if`/`elif` expression, i.e. is where a
 * `Global.function_name(...)` call could meaningfully appear. Requires the
 * keyword to already be followed by whitespace, not just present, so
 * still-typing the keyword itself (e.g. text ending in exactly "do") isn't
 * mistaken for an already-complete keyword with an empty expression.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isGlobalScriptExpressionLine(text) {
  return /^\s*(?:do|if|elif)\s/.test(text);
}

/**
 * Completion item for an autoload/global-script name itself (before its
 * `.`), e.g. `Global` in `do Global.`. Inserts a trailing `.` and
 * re-triggers suggestions, so its functions show up immediately.
 *
 * @param {string} name
 * @returns {vscode.CompletionItem}
 */
function createGlobalNameCompletion(name) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
  item.detail = 'Dialogic global script (autoload)';
  item.insertText = new vscode.SnippetString(`${name}.$0`);
  item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL global functions' };
  return item;
}

/**
 * Completion item for a function on an autoload/global script, e.g.
 * `apply_tint` in `do Global.apply_tint()`. Its GDScript `##` doc comment
 * (if any) becomes the completion's own documentation, matching what the
 * hover shows for the same function.
 *
 * @param {string} name
 * @param {{params: string, returnType: string|null, doc: string}} info
 * @returns {vscode.CompletionItem}
 */
function createGlobalFunctionCompletion(name, info) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
  item.detail = `(${info.params})${info.returnType ? ' -> ' + info.returnType : ''}`;
  item.documentation = new vscode.MarkdownString(info.doc || '_No `##` documentation comment found above this function._');
  item.insertText = new vscode.SnippetString(`${name}($0)`);
  return item;
}

/**
 * Build completions for a `do`/`if`/`elif` expression's `Global.` member
 * access: either the autoload names themselves (nothing typed yet, or a
 * partial name with no `.`), or a specific autoload's function names
 * (once `Name.` has been typed) - usable anywhere in the expression, not
 * just right after the keyword, since a condition can combine a Global
 * call with variables/operators (`if {chapter} == 1 and Global.foo()`).
 *
 * @param {string} beforeCursor
 * @returns {vscode.CompletionItem[] | null} null if this position isn't a
 *   Global-reference spot at all, so the caller can fall through to other
 *   completion paths instead of suppressing everything.
 */
function createGlobalScriptSuggestions(beforeCursor) {
  const memberMatch = beforeCursor.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (memberMatch) {
    const [, globalName, typedFunction] = memberMatch;
    const functions = cachedAutoloadFunctions.get(globalName);
    if (!functions) { return null; }
    const prefix = (typedFunction || '').toLowerCase();
    const items = [];
    for (const [name, info] of functions) {
      if (name.toLowerCase().startsWith(prefix)) {
        items.push(createGlobalFunctionCompletion(name, info));
      }
    }
    return items;
  }
  const nameMatch = beforeCursor.match(/(?:^|[\s(=!<>+\-*/%,])([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (nameMatch) {
    const prefix = (nameMatch[1] || '').toLowerCase();
    const items = [];
    for (const name of cachedAutoloadFunctions.keys()) {
      if (name.toLowerCase().startsWith(prefix)) {
        items.push(createGlobalNameCompletion(name));
      }
    }
    return items;
  }
  return null;
}



// =============================================================================
// BALISE HELPERS
// =============================================================================


/**
 * Scan dialogue/narration/choice lines for a BBCode-style balise such as
 * `[b]` or `[MyEffect]` that has no matching `[/name]` closer on the same
 * line. Reserved bracket commands like `[wait]` are skipped since they
 * aren't balises. A broken balise flags the whole line (rather than just
 * the tag) so it's easy to spot at a glance - this whole-line warning is
 * intentionally the diagnostic's job alone: the grammar itself never
 * highlights past a missing closer (see the `#balises` lookahead), so the
 * two mechanisms don't overlap or conflict.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnclosedBaliseDiagnostics(document) {
  const diagnostics = [];
  const openTagPattern = /\[([A-Za-z_][A-Za-z0-9_]*)\]/g;

  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!isPlayerFacingTextLine(text)) {
      continue;
    }

    openTagPattern.lastIndex = 0;
    let match;
    while ((match = openTagPattern.exec(text)) !== null) {
      const tagName = match[1];
      if (RESERVED_BRACKET_NAMES.has(tagName)) {
        continue;
      }

      const closingTag = `[/${tagName}]`;
      if (text.includes(closingTag)) {
        continue; // properly closed
      }

      const range = new vscode.Range(line, 0, line, text.length);
      diagnostics.push(new vscode.Diagnostic(
        range,
        `"[${tagName}]" has no matching "${closingTag}" on this line - the balise is unclosed.`,
        vscode.DiagnosticSeverity.Warning
      ));
      break; // one whole-line warning per line is enough, even if several tags are broken
    }
  }

  return diagnostics;
}

/**
 * Re-scan a `.dtl` document for every diagnostic this extension knows how
 * to produce (unresolved jumps, unclosed balises) and publish the merged
 * result.
 *
 * @param {vscode.TextDocument} document
 */
function updateDiagnostics(document) {
  if (document.languageId !== 'dtl') {
    return;
  }

  const diagnostics = [
    ...findUnresolvedJumpDiagnostics(document),
    ...findUnclosedBaliseDiagnostics(document)
  ];

  diagnosticCollection.set(document.uri, diagnostics);
}

// =============================================================================
// ACTIVATE
// =============================================================================
function activate(context) {
  // ---------------------------------------------------------------------------
  // Initial character cache
  // ---------------------------------------------------------------------------
  refreshProjectGodotData();
  // ---------------------------------------------------------------------------
  // Watch project.godot
  // ---------------------------------------------------------------------------
  const watcher = vscode.workspace.createFileSystemWatcher('**/project.godot');
  watcher.onDidChange(refreshProjectGodotData);
  watcher.onDidCreate(refreshProjectGodotData);
  watcher.onDidDelete(refreshProjectGodotData);
  context.subscriptions.push(watcher);
  // Resource files only need a re-list on create/delete (a file's content
  // changing doesn't affect its res:// path), so change events are ignored
  // to avoid needless rescans while e.g. an image is being edited.
  const resourceWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  resourceWatcher.onDidCreate(refreshResourcePaths);
  resourceWatcher.onDidDelete(refreshResourcePaths);
  context.subscriptions.push(resourceWatcher);
  // .dch (character) and .tscn (LayeredPortrait scene) files feed the
  // (mood) and extra_data="set ..." autocomplete - a full project.godot
  // refresh is simple and cheap enough to just re-run on any of them
  // changing, rather than tracking per-character invalidation by hand.
  const moodWatcher = vscode.workspace.createFileSystemWatcher('**/*.{dch,tscn}');
  moodWatcher.onDidChange(refreshProjectGodotData);
  moodWatcher.onDidCreate(refreshProjectGodotData);
  moodWatcher.onDidDelete(refreshProjectGodotData);
  context.subscriptions.push(moodWatcher);
  // Autoload scripts (declared in project.godot's [autoload] section) feed
  // the do/if/elif Global.function() autocomplete and hover - same
  // full-refresh-on-any-change approach as the .dch/.tscn watcher above.
  const scriptWatcher = vscode.workspace.createFileSystemWatcher('**/*.gd');
  scriptWatcher.onDidChange(refreshProjectGodotData);
  scriptWatcher.onDidCreate(refreshProjectGodotData);
  scriptWatcher.onDidDelete(refreshProjectGodotData);
  context.subscriptions.push(scriptWatcher);
  // ===========================================================================
  // HOVER PROVIDER
  // ===========================================================================
  const hoverProvider =
    vscode.languages.registerHoverProvider(
      'dtl',
      {
        provideHover(document, position) {
          const line = document.lineAt(position.line).text;
          // -------------------------------------------------------------------
          // Bracket commands
          //
          // [wait]
          // [audio]
          // [voice]
          // -------------------------------------------------------------------
          const bracketRegex =
            /\[([A-Za-z_][A-Za-z0-9_]*)/g;
          let match;
          while (
            (match = bracketRegex.exec(line)) !== null
          ) {
            const start = match.index;
            const end =
              start + match[0].length;
            if (
              position.character >= start &&
              position.character <= end
            ) {
              const commandName = match[1];
              const entry =
                DTL_ENTRIES.find(
                  entry =>
                    entry.name === commandName
                );
              if (!entry) {
                // Not a real bracket command - this is just an attribute
                // name that happens to sit directly against '[' (e.g.
                // join/update/leave's first inline option, "[fade=...]").
                // Stop scanning and let the parameter-hover logic below
                // handle it instead of giving up on hover entirely.
                break;
              }
              const range =
                new vscode.Range(
                  position.line,
                  start,
                  position.line,
                  end
                );
              return new vscode.Hover(
                createDocumentation(entry),
                range
              );
            }
          }
          // -------------------------------------------------------------------
          // Bracket command PARAMETERS
          //
          // [wait time=1.5]
          //        ^^^^ hovering this
          // -------------------------------------------------------------------
          const paramWordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
          if (paramWordRange) {
            const paramName = document.getText(paramWordRange);
            const afterParam = line.substring(paramWordRange.end.character);
            if (/^\s*=/.test(afterParam)) {
              const beforeParam = line.substring(0, paramWordRange.start.character);
              const enclosingBracketMatch = beforeParam.match(/\[([A-Za-z_][A-Za-z0-9_]*)\s+[^\]]*$/);
              if (enclosingBracketMatch) {
                const enclosingEntry = DTL_ENTRIES.find(
                  candidate => candidate.name === enclosingBracketMatch[1] && candidate.type === 'bracket'
                );
                if (enclosingEntry && enclosingEntry.variables && enclosingEntry.variables[paramName]) {
                  const markdown = new vscode.MarkdownString();
                  markdown.appendMarkdown(`**${paramName}** _(parameter of \`[${enclosingEntry.name}]\`)_\n\n`);
                  markdown.appendMarkdown(enclosingEntry.variables[paramName]);
                  return new vscode.Hover(markdown, paramWordRange);
                }
              } else {
                // join/update/leave's own trailing [options] bracket has no
                // command name inside it (e.g. "join Laripo center
                // [extra_data=...]"), so it needs its own lookup against the
                // enclosing command's `variables` instead.
                const trailingBracketMatch = beforeParam.match(/^\s*(join|update|leave)\b[^[]*\[[^\]]*$/);
                if (trailingBracketMatch) {
                  const commandEntry = DTL_ENTRIES.find(
                    candidate => candidate.name === trailingBracketMatch[1] && candidate.type === 'command'
                  );
                  if (commandEntry && commandEntry.variables && commandEntry.variables[paramName]) {
                    const markdown = new vscode.MarkdownString();
                    markdown.appendMarkdown(`**${paramName}** _(parameter of \`${commandEntry.name}\`)_\n\n`);
                    markdown.appendMarkdown(commandEntry.variables[paramName]);
                    return new vscode.Hover(markdown, paramWordRange);
                  }
                } else {
                  // pos=/size=/rot= transform tokens sit between the
                  // character/position slot and the bracket, e.g.
                  // "join Laripo pos=x0.3 size=y1 [...]".
                  const transformMatch = beforeParam.match(
                    /^\s*(join|update)\b\s+\S+(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s*$/
                  );
                  if (transformMatch) {
                    const commandEntry = DTL_ENTRIES.find(
                      candidate => candidate.name === transformMatch[1] && candidate.type === 'command'
                    );
                    if (commandEntry && commandEntry.transform_command && commandEntry.transform_command[paramName]) {
                      const markdown = new vscode.MarkdownString();
                      markdown.appendMarkdown(`**${paramName}** _(transform parameter of \`${commandEntry.name}\`)_\n\n`);
                      markdown.appendMarkdown(commandEntry.transform_command[paramName]);
                      return new vscode.Hover(markdown, paramWordRange);
                    }
                  }
                }
              }
            }
          }
          // -------------------------------------------------------------------
          // Position keywords
          //
          // join Laripo center|
          //             ^^^^^^ hovering this
          // -------------------------------------------------------------------
          const positionWordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
          if (positionWordRange) {
            const positionWord = document.getText(positionWordRange);
            const positionEntry = DTL_POSITIONS.find(position => position.name === positionWord);
            if (positionEntry) {
              const beforePosition = line.substring(0, positionWordRange.start.character);
              // Only the first token after "join <character>" / "update
              // <character>" is really this position argument, so this
              // stays scoped to that slot rather than any stray word that
              // happens to match a position name (e.g. inside dialogue text).
              if (/^\s*(join|update)\b\s+\S+\s*$/.test(beforePosition)) {
                const markdown = new vscode.MarkdownString();
                markdown.appendMarkdown(`**${positionEntry.name}** _(DTL character position)_\n\n`);
                markdown.appendMarkdown(positionEntry.description);
                return new vscode.Hover(markdown, positionWordRange);
              }
            }
          }
          // -------------------------------------------------------------------
          // Character names
          //
          // join John left       "John Smith": Hello
          //      ^^^^                ^^^^^^^^^^^^ hovering either
          // -------------------------------------------------------------------
          const characterHit = findCharacterNameAtPosition(document, position);
          if (characterHit) {
            const info = cachedCharacterInfo.get(characterHit.name);
            if (info && (info.displayName || info.nicknames.length > 0 || info.description || info.color)) {
              return new vscode.Hover(createCharacterDocumentation(characterHit.name, info), characterHit.range);
            }
          }
          // -------------------------------------------------------------------
          // Global script functions
          //
          // do Global.apply_tint()      if Global.has_achievement("x")
          //           ^^^^^^^^^^                 ^^^^^^^^^^^^^^^^ hovering either
          // -------------------------------------------------------------------
          const globalFunctionHit = findGlobalFunctionCallAtPosition(document, position);
          if (globalFunctionHit) {
            return new vscode.Hover(
              createGlobalFunctionDocumentation(globalFunctionHit.globalName, globalFunctionHit.functionName, globalFunctionHit.info),
              globalFunctionHit.range
            );
          }
          // -------------------------------------------------------------------
          // Normal commands
          //
          // label
          // jump
          // join
          // update
          // leave
          // -------------------------------------------------------------------
          const wordRange =
            document.getWordRangeAtPosition(
              position
            );

          if (!wordRange) {
            return undefined;
          }

          const word =
            document.getText(wordRange);

          const entry =
            DTL_ENTRIES.find(
              entry => entry.name === word
            );

          if (!entry) {
            return undefined;
          }

          return new vscode.Hover(
            createDocumentation(entry),
            wordRange
          );
        }
      }
    );
  context.subscriptions.push(hoverProvider);
  // ===========================================================================
  // DEFINITION PROVIDER (ctrl+click / F12 on a `jump NAME` target)
  // ===========================================================================
  const definitionProvider =
    vscode.languages.registerDefinitionProvider(
      'dtl',
      {
        provideDefinition(document, position) {
          const wordRange =
            document.getWordRangeAtPosition(
              position,
              /[A-Za-z_][A-Za-z0-9_]*/
            );

          if (!wordRange) {
            return undefined;
          }

          const line = document.lineAt(position.line).text;
          const beforeWord = line.substring(0, wordRange.start.character);

          // Only resolve a definition when the line is a real `jump` command
          // (anchored to line start), not the word "jump" inside a comment
          // or inside spoken dialogue text.
          if (!/^\s*jump\s+$/.test(beforeWord)) {
            return undefined;
          }

          const labelName = document.getText(wordRange);
          return findLabelLocation(document, labelName);
        }
      }
    );
  context.subscriptions.push(definitionProvider);
  // ===========================================================================
  // DIAGNOSTICS (unresolved `jump` targets, unclosed BBCode-style balises)
  // ===========================================================================
  diagnosticCollection = vscode.languages.createDiagnosticCollection('dtl');
  context.subscriptions.push(diagnosticCollection);
  vscode.workspace.textDocuments.forEach(updateDiagnostics);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => updateDiagnostics(event.document))
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => diagnosticCollection.delete(document.uri))
  );
  // ===========================================================================
  // COMPLETION PROVIDER
  // ===========================================================================
  const completionProvider =
    vscode.languages.registerCompletionItemProvider('dtl',
      {
        provideCompletionItems(document, position) {
          const line = document.lineAt(position.line).text;
          const beforeCursor = line.substring(0,position.character);
          const items = [];
          // ===================================================================
          // VARIABLE PATH: "{variable.te" anywhere - dialogue text, a
          // bracket option's value, or a bare "set {...}" line. Checked
          // first since it can appear inside any of those other contexts,
          // and its own "{" would otherwise just be stray text to them.
          // ===================================================================
          const openBraceIndex = beforeCursor.lastIndexOf('{');
          const closeBraceIndex = beforeCursor.lastIndexOf('}');
          if (openBraceIndex > closeBraceIndex) {
            return createVariableSuggestions(beforeCursor.slice(openBraceIndex + 1));
          }
          // ===================================================================
          // GLOBAL SCRIPT FUNCTIONS: "do Global." / "if Global." /
          // "elif Global." - either the autoload name itself, or a function
          // name once "Name." has been typed. Usable anywhere in the
          // expression (not just right after the keyword), since if/elif
          // conditions can combine a Global call with variables/operators.
          // ===================================================================
          if (isGlobalScriptExpressionLine(beforeCursor)) {
            const globalItems = createGlobalScriptSuggestions(beforeCursor);
            if (globalItems !== null) {
              return globalItems;
            }
          }
          // ===================================================================
          // MOOD TAG: "John (happy" or "join John (happy" - checked first
          // since the JOIN/LEAVE/UPDATE block below would otherwise treat
          // the '(' as a stray token and return an empty list before this
          // ever gets a chance to run.
          // ===================================================================
          const moodContext = detectMoodContext(beforeCursor);
          if (moodContext) {
            return createMoodSuggestions(moodContext.character, moodContext.typedMood);
          }
          // ===================================================================
          // JOIN / LEAVE / UPDATE
          // ===================================================================
          const characterCommandMatch = beforeCursor.match(/^\s*(join|leave|update)(?:\s+(.*))?$/);
          if (characterCommandMatch) {
            const command = characterCommandMatch[1];
            const argumentsText = characterCommandMatch[2] || '';
            // Once a '[' has been typed, we are past the character/position
            // slot entirely and inside the trailing options bracket instead -
            // that case is handled below by the dedicated bracket handler, so
            // this block does nothing (and, importantly, does NOT return).
            // A '[' inside an already-closed quoted character name (rare,
            // but names can contain almost anything) doesn't count, so
            // completed quoted spans are stripped before checking.
            const hasOpenBracket = argumentsText.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '').includes('[');
            if (!hasOpenBracket) {
              // ---------------------------------------------------------------
              // No argument yet
              //
              // join |
              // leave |
              // update |
              // ---------------------------------------------------------------
              if (argumentsText === '') {
                for (const name of cachedCharacterNames) {
                  items.push(createCharacterCompletion(name));
                }
                return items;
              }
              // ---------------------------------------------------------------
              // Split arguments - quote-aware, so a name like "John Smith"
              // stays one token instead of being split on its inner space.
              // ---------------------------------------------------------------
              const argumentsParts = splitCommandArguments(argumentsText);
              // ---------------------------------------------------------------
              // Character is currently being typed
              //
              // join Lar|
              // leave Lar|
              // update Lar|
              // join "John |                     <- quoted name in progress
              // ---------------------------------------------------------------
              if (argumentsParts.length === 1) {
                const currentToken = argumentsParts[0];
                const prefix = extractCharacterNamePrefix(currentToken).toLowerCase();
                // Replace the whole typed token (quote included) rather than
                // just appending, since a quote or an internal space isn't
                // part of VS Code's default "word" and wouldn't otherwise be
                // covered by the edit.
                const tokenStartChar = beforeCursor.length - currentToken.length;
                const range = new vscode.Range(position.line, tokenStartChar, position.line, position.character);
                for (const name of cachedCharacterNames) {
                  if (!name.toLowerCase().startsWith(prefix)) {
                    continue;
                  }
                  items.push(createCharacterCompletion(name, range));
                }
                return items;
              }
              // ---------------------------------------------------------------
              // Position / transform arguments (join & update only; leave
              // does NOT have a position).
              //
              // join Laripo |                    <- plain position keyword
              // join Laripo pos=x0.3 size=y1 |    <- transform_command keys
              //
              // A plain position keyword (center, left, ...) can only be the
              // first token; transform_command keys (pos/size/rot, defined
              // per-entry in DTL_ENTRIES) can instead be used, one or more,
              // as an alternative. Once a plain position keyword has been
              // used, this slot is considered complete.
              // ---------------------------------------------------------------
              if (command === 'join' || command === 'update') {
                const typedTokens = argumentsParts.slice(1, -1);
                const currentToken = argumentsParts[argumentsParts.length - 1];
                const usedPlainPosition = typedTokens.some(
                  token => DTL_POSITIONS.some(position => position.name === token)
                );
                if (!usedPlainPosition && !currentToken.includes('=')) {
                  const prefix = currentToken.toLowerCase();
                  if (argumentsParts.length === 2) {
                    for (const position of DTL_POSITIONS) {
                      if (position.name.toLowerCase().startsWith(prefix)) {
                        items.push(createPositionCompletion(position));
                      }
                    }
                  }
                  const commandEntry = DTL_ENTRIES.find(
                    entry => entry.name === command && entry.type === 'command'
                  );
                  if (commandEntry && commandEntry.transform_command) {
                    const usedTransformKeys = new Set(typedTokens.map(token => token.split('=')[0]));
                    for (const [key, doc] of Object.entries(commandEntry.transform_command)) {
                      if (usedTransformKeys.has(key)) {
                        continue; // already set once on this line
                      }
                      if (!key.toLowerCase().startsWith(prefix)) {
                        continue;
                      }
                      items.push(createAttributeCompletion(key, doc));
                    }
                  }
                  return items;
                }
              }
            }
          }
          // =========================================================================
          // JOIN / LEAVE / UPDATE - trailing [options] bracket
          //
          // join Laripo center [extra_data="..." |
          // leave Laripo [an|
          //
          // Reuses each command's own `variables` documentation (already
          // written in DTL_ENTRIES) instead of leaving this bracket
          // unsupported, the way the generic "[wait ...]"-style bracket
          // commands already are below.
          // =========================================================================
          const trailingOptionsMatch = beforeCursor.match(/^\s*(join|update|leave)\b[^[]*\[([^\]]*)$/);
          if (trailingOptionsMatch) {
            const commandEntry = DTL_ENTRIES.find(
              entry => entry.name === trailingOptionsMatch[1] && entry.type === 'command'
            );
            if (commandEntry && commandEntry.variables) {
              const bracketArgumentsText = trailingOptionsMatch[2];
              const currentToken = getCurrentBracketToken(bracketArgumentsText);
              // Only suggest a parameter NAME while not already mid-value.
              if (!currentToken.includes('=')) {
                const prefix = currentToken.toLowerCase();
                const usedAttributes = new Set(bracketArgumentsText.match(/[A-Za-z_][A-Za-z0-9_]*(?==)/g) || []);
                for (const attributeName of Object.keys(commandEntry.variables)) {
                  if (usedAttributes.has(attributeName)) {
                    continue; // already set once on this line
                  }
                  if (!attributeName.toLowerCase().startsWith(prefix)) {
                    continue;
                  }
                  items.push(createAttributeCompletion(attributeName, commandEntry.variables[attributeName]));
                }
              } else {
                // Mid-value, e.g. "animation=Bou|" - offer known values for
                // this attribute (animation, move_trans, move_ease, ...) if
                // any. extra_data gets its own LayeredPortrait node-path
                // logic instead, since its values aren't a fixed enum.
                const equalsIndex = currentToken.indexOf('=');
                const attributeName = currentToken.slice(0, equalsIndex);
                const typedValue = currentToken.slice(equalsIndex + 1);
                if (attributeName === 'extra_data') {
                  items.push(...createEmotionPathSuggestions(line, typedValue));
                } else {
                  items.push(...createAttributeValueSuggestions(commandEntry.name, attributeName, typedValue));
                }
              }
              return items;
            }
          }
          // =========================================================================
          // BRACKET COMMANDS
          // =========================================================================
          const bracketMatch = beforeCursor.match(/\[([A-Za-z_][A-Za-z0-9_]*)?$/);
          if (bracketMatch) {
            const prefix = bracketMatch[1] || '';
            for ( const entry of DTL_ENTRIES ) {
              if (entry.type !== 'bracket') {
                continue;
              }
              if (
                !entry.name.startsWith(prefix)
              ) {
                continue;
              }
              const item = createCommandCompletion(entry);
              items.push(item);
            }
            return items;
          }
          // =========================================================================
          // BRACKET COMMAND PARAMETERS (e.g. inside `[wait time=1.5 |`)
          // =========================================================================
          const openBracketIndex = beforeCursor.lastIndexOf('[');
          if (openBracketIndex !== -1 && !beforeCursor.slice(openBracketIndex).includes(']')) {
            const bracketContent = beforeCursor.slice(openBracketIndex + 1);
            const commandNameMatch = bracketContent.match(/^([A-Za-z_][A-Za-z0-9_]*)\s/);
            if (commandNameMatch) {
              const bracketEntry = DTL_ENTRIES.find(
                candidate => candidate.name === commandNameMatch[1] && candidate.type === 'bracket'
              );
              if (bracketEntry && bracketEntry.variables) {
                const afterCommandName = bracketContent.slice(commandNameMatch[0].length);
                const currentToken = getCurrentBracketToken(afterCommandName);
                // Only suggest a parameter NAME while not already mid-value
                // (i.e. the token being typed has no '=' in it yet).
                if (!currentToken.includes('=')) {
                  const prefix = currentToken.toLowerCase();
                  const usedAttributes = new Set(afterCommandName.match(/[A-Za-z_][A-Za-z0-9_]*(?==)/g) || []);
                  for (const attributeName of Object.keys(bracketEntry.variables)) {
                    if (usedAttributes.has(attributeName)) {
                      continue; // already set once on this line
                    }
                    if (!attributeName.toLowerCase().startsWith(prefix)) {
                      continue;
                    }
                    items.push(createAttributeCompletion(attributeName, bracketEntry.variables[attributeName]));
                  }
                  return items;
                }
                // Mid-value, e.g. "[background transition=Push|" - offer
                // known values for this attribute (transition, ...) if any.
                const equalsIndex = currentToken.indexOf('=');
                const attributeName = currentToken.slice(0, equalsIndex);
                const typedValue = currentToken.slice(equalsIndex + 1);
                const valueSuggestions = createAttributeValueSuggestions(bracketEntry.name, attributeName, typedValue);
                if (valueSuggestions.length > 0) {
                  items.push(...valueSuggestions);
                  return items;
                }
              }
            }
          }
          // ===================================================================
          // AUDIO
          // ===================================================================
          const audioCommandMatch = beforeCursor.match(/^\s*audio(?:\s+(.*))?$/);
          if (audioCommandMatch) {
            const argumentsText = audioCommandMatch[1] || '';
            if (argumentsText === '') {
              for (const kind of cachedAudioChannels) { items.push(createAudioKindCompletion(kind)); }
              return items;
            }
            const argumentsParts = argumentsText.split(/\s+/);
            // Kind is being typed: "audio mu|"
            if (argumentsParts.length === 1) {
              const prefix = argumentsParts[0].toLowerCase();
              for (const kind of cachedAudioChannels) {
                if (kind.toLowerCase().startsWith(prefix)) { items.push(createAudioKindCompletion(kind)); }
              }
              return items;
            }
            // Kind fully typed, waiting for or typing the path:
            // "audio music |" or "audio music "res:/|"
            if (argumentsParts.length === 2) {
              const typedValue = argumentsParts[1];
              if (typedValue === '') {
                items.push(createAudioPathCompletion());
              } else {
                items.push(...createPathSuggestions(typedValue));
              }
              return items;
            }
          }
          // ===================================================================
          // JUMP
          // ===================================================================
          const jumpCommandMatch = beforeCursor.match(/^\s*jump\s+(.*)$/);
          if (jumpCommandMatch) {
            const prefix = jumpCommandMatch[1].toLowerCase();
            for (const label of collectDocumentLabels(document)) {
              if (!prefix || label.toLowerCase().startsWith(prefix)) {
                items.push(createLabelCompletion(label));
              }
            }
            return items;
          }
          // =========================================================================
          // QUOTED SPEAKER NAME IN PROGRESS - "Joh or 'Joh at the start of a
          // line. Handled separately from the bare-identifier case below
          // since a quote isn't a "word" character and, left unhandled here,
          // isBareNarrationLine() would otherwise treat this as dialogue
          // text being typed rather than a still-open speaker name.
          // =========================================================================
          const quotedSpeakerMatch = beforeCursor.match(/^\s*("[^"\r\n]*|'[^'\r\n]*)$/);
          if (quotedSpeakerMatch) {
            const token = quotedSpeakerMatch[1];
            const prefix = extractCharacterNamePrefix(token).toLowerCase();
            const tokenStartChar = beforeCursor.length - token.length;
            const range = new vscode.Range(position.line, tokenStartChar, position.line, position.character);
            for (const name of cachedCharacterNames) {
              if (name.toLowerCase().startsWith(prefix)) {
                items.push(createCharacterCompletion(name, range));
              }
            }
            return items;
          }
          // =========================================================================
          // NORMAL COMMANDS + Dialogue characters.
          // =========================================================================
          if (/^\s*[\p{L}_][\p{L}0-9_]*$/u.test(beforeCursor)) {
            const prefix = beforeCursor.trim().toLowerCase();
            // Characters
            for (const name of cachedCharacterNames) {
              if (name.toLowerCase().startsWith(prefix)) {
                items.push(createCharacterCompletion(name));
              }
            }
            // Commands
            for (const entry of DTL_ENTRIES) {
              if (entry.type !== 'command') {continue;}
              if (entry.name.toLowerCase().startsWith(prefix)) {
                items.push(createCommandCompletion(entry));
              }
            }
            return items;
          }
          // =========================================================================
          // DIALOGUE TEXT (word-based suggestions, VS Code "txt" style)
          // =========================================================================
          if (isInsideDialogueText(beforeCursor)) {
            return createWordSuggestions(document, beforeCursor);
          }
          /// Fall back
          for (const name of cachedCharacterNames) {
            items.push(createCharacterCompletion(name));
          }
          items.push(createWordSuggestions(document, beforeCursor));
          return items;
          }
        }
    , ' ', '[', '=', '(', '/', '"', "'", '{', '.');
  context.subscriptions.push(completionProvider);
}
// =============================================================================
// DEACTIVATE
// =============================================================================
function deactivate() {}

module.exports = { activate, deactivate };
