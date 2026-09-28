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
// - Hover documentation for commands and Godot BBCode tags
// - Autoload (script or scene) member autocomplete + hover docs: functions,
//   variables, constants and enums, in do/if/elif and {...}
// - Go to Definition for jumps, characters, moods, res:// paths, autoload
//   members and glossary words; Go to Symbol in Workspace
// - Diagnostics (unresolved jumps, unknown characters/moods/variables,
//   unclosed BBCode tags, unreachable events, unused portraits...) with
//   quick fixes
// - Custom Dialogic events, block snippets, Play Timeline in Godot
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
 * Locate the autoload reference under the cursor, if any - the autoload
 * name itself (`Global`), one of its members (`Global.apply_tint`,
 * `Global.max_hp`, `Global.State`), or a named enum's value
 * (`Global.State.IDLE`) - resolved against cachedAutoloadSymbols. Only
 * looked for where Dialogic actually evaluates such references: a
 * `do`/`if`/`elif` expression, or inside a `{...}` variable block
 * (isGlobalScriptExpressionLine is defined further down alongside the
 * completion logic that shares this same line shape). Shared by the hover
 * and Go to Definition.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{
 *   globalName: string,
 *   symbols: GdScriptSymbols & {scriptPath: string, scenePath: string|null},
 *   part: 'global'|'member'|'value',
 *   memberName: string,
 *   subName: string|undefined,
 *   range: vscode.Range
 * } | null}
 */
function locateAutoloadReferenceAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  const isExpressionLine = isGlobalScriptExpressionLine(line);
  const referencePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g;
  let match;
  while ((match = referencePattern.exec(line)) !== null) {
    const [, globalName, memberName, subName] = match;
    const symbols = cachedAutoloadSymbols.get(globalName);
    if (!symbols) { continue; }
    if (!isExpressionLine && !isInsideVariableBlock(line, match.index)) { continue; }

    const globalStart = match.index;
    const memberStart = globalStart + globalName.length + 1;
    const subStart = memberStart + memberName.length + 1;
    const rangeOf = (start, name) => new vscode.Range(position.line, start, position.line, start + name.length);
    const covers = (start, name) => position.character >= start && position.character <= start + name.length;
    const reference = { globalName, symbols, memberName, subName };

    if (covers(globalStart, globalName)) { return { ...reference, part: 'global', range: rangeOf(globalStart, globalName) }; }
    if (covers(memberStart, memberName)) { return { ...reference, part: 'member', range: rangeOf(memberStart, memberName) }; }
    if (subName && covers(subStart, subName)) { return { ...reference, part: 'value', range: rangeOf(subStart, subName) }; }
  }
  return null;
}

/**
 * Hover documentation for the autoload reference under the cursor (see
 * locateAutoloadReferenceAtPosition).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{markdown: vscode.MarkdownString, range: vscode.Range} | null}
 */
function findAutoloadReferenceAtPosition(document, position) {
  const reference = locateAutoloadReferenceAtPosition(document, position);
  if (!reference) { return null; }
  const { globalName, memberName, subName, symbols, range } = reference;
  if (reference.part === 'global') {
    return { markdown: createAutoloadDocumentation(globalName, symbols), range };
  }
  if (reference.part === 'member') {
    const markdown = createAutoloadMemberDocumentation(globalName, memberName, symbols);
    return markdown ? { markdown, range } : null;
  }
  const enumInfo = symbols.enums.get(memberName);
  const valueInfo = enumInfo && enumInfo.values.find(value => value.name === subName);
  return valueInfo ? { markdown: createEnumValueDocumentation(globalName, memberName, valueInfo), range } : null;
}

/**
 * Find the Dialogic variable (from project.godot's `variables={...}`)
 * under the cursor inside a `{...}` block, e.g. hovering `test` in
 * `{variable.test}`. The hovered segment decides how much of the path is
 * shown - hovering `variable` describes the whole group instead. Autoload
 * references like `{Global.hearts}` are handled by
 * findAutoloadReferenceAtPosition instead.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{markdown: vscode.MarkdownString, range: vscode.Range} | null}
 */
function findVariableAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  const blockPattern = /\{([^{}]*)\}/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(line)) !== null) {
    const innerStart = blockMatch.index + 1;
    const innerEnd = innerStart + blockMatch[1].length;
    if (position.character < innerStart || position.character > innerEnd) { continue; }

    const segmentPattern = /[^.\s]+/g;
    const pathSegments = [];
    let segmentMatch;
    while ((segmentMatch = segmentPattern.exec(blockMatch[1])) !== null) {
      pathSegments.push(segmentMatch[0]);
      const segmentStart = innerStart + segmentMatch.index;
      const segmentEnd = segmentStart + segmentMatch[0].length;
      if (position.character < segmentStart || position.character > segmentEnd) { continue; }

      let level = cachedVariablesTree;
      let entry = null;
      for (const segment of pathSegments) {
        entry = level && level.get(segment);
        if (!entry) { return null; }
        level = entry.children;
      }
      return {
        markdown: createVariableDocumentation(pathSegments.join('.'), entry),
        range: new vscode.Range(position.line, segmentStart, position.line, segmentEnd),
      };
    }
    return null;
  }
  return null;
}

/**
 * Best-effort GDScript type name for a raw default value from
 * project.godot, e.g. `1` -> int, `1.0` -> float, `"x"` -> String.
 *
 * @param {string} rawValue
 * @returns {string | null}
 */
function inferGdValueType(rawValue) {
  if (rawValue === null || rawValue === undefined) { return null; }
  if (/^-?\d+$/.test(rawValue)) { return 'int'; }
  if (/^-?(?:\d+\.\d*|\.\d+)(?:e-?\d+)?$/i.test(rawValue)) { return 'float'; }
  if (rawValue === 'true' || rawValue === 'false') { return 'bool'; }
  if (/^&?"/.test(rawValue)) { return 'String'; }
  if (rawValue.startsWith('[')) { return 'Array'; }
  if (rawValue.startsWith('{')) { return 'Dictionary'; }
  const constructorMatch = rawValue.match(/^([A-Z][A-Za-z0-9]*)\(/);
  return constructorMatch ? constructorMatch[1] : null;
}

/**
 * Build the hover shown for a Dialogic variable: its full path, its
 * default value and type (as declared in project.godot) - or, for a
 * variable group, the list of what it contains.
 *
 * @param {string} path - e.g. "variable.test"
 * @param {{value: string|null, children: Map|null}} entry
 * @returns {vscode.MarkdownString}
 */
function createVariableDocumentation(path, entry) {
  const markdown = new vscode.MarkdownString();
  if (entry.children) {
    markdown.appendMarkdown(`**{${path}}** _(Dialogic variable group)_\n\n`);
    for (const [name, child] of entry.children) {
      markdown.appendMarkdown(child.children
        ? `- \`${name}\` _(group, ${child.children.size} entries)_\n`
        : `- \`${name}\` = \`${child.value}\`\n`);
    }
    return markdown;
  }
  const type = inferGdValueType(entry.value);
  markdown.appendMarkdown(`**{${path}}** _(Dialogic variable${type ? ', ' + type : ''})_\n\n`);
  markdown.appendMarkdown(`Default value: \`${entry.value}\``);
  return markdown;
}

/**
 * True when `index` on `line` sits inside an open `{...}` variable block.
 *
 * @param {string} line
 * @param {number} index
 * @returns {boolean}
 */
function isInsideVariableBlock(line, index) {
  const before = line.slice(0, index);
  return before.lastIndexOf('{') > before.lastIndexOf('}');
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
  }
];
// =============================================================================
// GODOT BBCODE DOCUMENTATION
// =============================================================================
// Every BBCode tag Godot 4's RichTextLabel understands, which is what
// Dialogic renders dialogue/narration/choice text with. Descriptions follow
// the official "BBCode in RichTextLabel" page (GODOT_BBCODE_DOCS_URL).
//
// Same shape as DTL_ENTRIES (so createDocumentation renders both), plus:
// - selfClosing: the tag has no [/name] closer (e.g. [br], [lb]) - never
//   flagged as an unclosed balise, and inserted without one.
// - snippet: custom completion insert text (after the already-typed '['),
//   for tags whose value is part of the opening tag, e.g. [color=red].

/** @type {string} */
const GODOT_BBCODE_DOCS_URL = 'https://docs.godotengine.org/en/stable/tutorials/ui/bbcode_in_richtextlabel.html';

const DTL_BBCODES = [
  // --- Text style -----------------------------------------------------------
  {
    name: 'b',
    syntax: '[b]{text}[/b]',
    description: 'Makes {text} use the bold (or bold italics) font of the RichTextLabel.',
    example: 'Laripo: This is [b]important[/b].'
  },
  {
    name: 'i',
    syntax: '[i]{text}[/i]',
    description: 'Makes {text} use the italics (or bold italics) font of the RichTextLabel.',
    example: 'Laripo: This is [i]interesting[/i].'
  },
  {
    name: 'u',
    syntax: '[u]{text}[/u]',
    description: 'Makes {text} underlined.',
    example: 'Laripo: This is [u]underlined[/u].'
  },
  {
    name: 's',
    syntax: '[s]{text}[/s]',
    description: 'Makes {text} strikethrough.',
    example: 'Laripo: This is [s]struck out[/s].'
  },
  {
    name: 'code',
    syntax: '[code]{text}[/code]',
    description: 'Makes {text} use the mono font of the RichTextLabel. BBCode tags inside [code] are not parsed.',
    example: 'Laripo: Type [code]git status[/code] to check.'
  },
  {
    name: 'color',
    syntax: '[color={code/name}]{text}[/color]',
    description: 'Changes the color of {text}. Accepts a color name (e.g. `red`, `aqua`) or a hexadecimal code (`#ff00ff`, `#ff00ff80` with alpha).',
    example: 'Laripo: The [color=red]red[/color] button.',
    snippet: 'color=${1:red}]$0[/color]'
  },
  {
    name: 'bgcolor',
    syntax: '[bgcolor={code/name}]{text}[/bgcolor]',
    description: 'Draws a background color behind {text}. Accepts a color name or a hexadecimal code.',
    example: 'Laripo: [bgcolor=yellow]Highlighted[/bgcolor] text.',
    snippet: 'bgcolor=${1:yellow}]$0[/bgcolor]'
  },
  {
    name: 'fgcolor',
    syntax: '[fgcolor={code/name}]{text}[/fgcolor]',
    description: 'Draws a foreground color in front of {text}, which can be used to "redact" it by using an opaque color.',
    example: 'Laripo: The password is [fgcolor=black]hunter2[/fgcolor].',
    snippet: 'fgcolor=${1:black}]$0[/fgcolor]'
  },
  {
    name: 'outline_size',
    syntax: '[outline_size={size}]{text}[/outline_size]',
    description: 'Uses a custom font outline size for {text}, in pixels.',
    example: '[outline_size=4]Outlined[/outline_size]',
    snippet: 'outline_size=${1:4}]$0[/outline_size]'
  },
  {
    name: 'outline_color',
    syntax: '[outline_color={code/name}]{text}[/outline_color]',
    description: 'Uses a custom font outline color for {text}. Accepts a color name or a hexadecimal code.',
    example: '[outline_size=4][outline_color=black]Outlined[/outline_color][/outline_size]',
    snippet: 'outline_color=${1:black}]$0[/outline_color]'
  },
  {
    name: 'font',
    syntax: '[font={path} {options}]{text}[/font]',
    description: 'Makes {text} use a font resource from the {path}. Options can also be passed without a path to customize the current font.',
    example: '[font=res://fonts/Handwriting.ttf]Dear diary...[/font]',
    snippet: 'font=${1:res://}]$0[/font]',
    variables: {
      'name': 'Path to the font resource (alternative to `[font={path}]`).',
      'size': 'Custom font size.',
      'glyph_spacing': 'Extra spacing for each glyph.',
      'space_spacing': 'Extra spacing for the space character.',
      'top_spacing': 'Extra spacing at the top of the line.',
      'bottom_spacing': 'Extra spacing at the bottom of the line.',
      'embolden': 'Font embolden strength. If not 0, emboldens the font outlines.',
      'face_index': 'Active face index for TrueType / OpenType collections.',
      'slant': 'Font slant (horizontal skew) - positive values slant to the right.',
      'opentype_variation': 'List of OpenType variation tags, e.g. `wght=600,wdth=100`.',
      'opentype_features': 'List of OpenType feature tags, e.g. `calt=0,zero=1`.',
    }
  },
  {
    name: 'font_size',
    syntax: '[font_size={size}]{text}[/font_size]',
    description: 'Uses a custom font size for {text}.',
    example: 'Laripo: [font_size=40]HEY![/font_size]',
    snippet: 'font_size=${1:24}]$0[/font_size]'
  },
  {
    name: 'opentype_features',
    syntax: '[opentype_features={list}]{text}[/opentype_features]',
    description: 'Enables custom OpenType font features for {text}. Features must be provided as a comma-separated list, e.g. `calt=0,zero=1`.',
    example: '[opentype_features=zero=1]0123[/opentype_features]',
    snippet: 'opentype_features=${1:calt=0}]$0[/opentype_features]'
  },
  {
    name: 'lang',
    syntax: '[lang={code}]{text}[/lang]',
    description: 'Overrides the language for {text} set by the BiDi > Language property in RichTextLabel.',
    example: '[lang=fr]Bonjour[/lang]',
    snippet: 'lang=${1:en}]$0[/lang]'
  },
  {
    name: 'char',
    syntax: '[char={codepoint}]',
    description: 'Adds a Unicode character with its hexadecimal UTF-32 {codepoint}.',
    example: '[char=2665]',
    snippet: 'char=${1:2665}]',
    selfClosing: true
  },
  // --- Links, images, tooltips ---------------------------------------------
  {
    name: 'url',
    syntax: '[url]{link}[/url] or [url={link}]{text}[/url]',
    description: 'Creates a hyperlink (underlined and clickable text). Clicking it emits RichTextLabel\'s `meta_clicked` signal - opening the link has to be handled by the game code.',
    example: 'Laripo: See the [url=https://docs.dialogic.pro]docs[/url].'
  },
  {
    name: 'hint',
    syntax: '[hint={tooltip text}]{text}[/hint]',
    description: 'Creates a tooltip hint that is displayed when hovering the text with the mouse. Tooltip text should be quoted if it contains spaces.',
    example: 'Laripo: I love [hint="A lot of cheese."]fondue[/hint].',
    snippet: 'hint="${1:tooltip}"]$0[/hint]'
  },
  {
    name: 'img',
    syntax: '[img {options}]{path}[/img]',
    description: 'Inserts an image from the {path} (can be any valid Texture2D resource). The shorthand `[img={width}x{height}]` also resizes it.',
    example: '[img width=32]res://icons/heart.png[/img]',
    variables: {
      'width': 'Target width in pixels (or percent of the control width with a `%` suffix). Keeps the aspect ratio if only one of width/height is given.',
      'height': 'Target height in pixels (or percent with a `%` suffix).',
      'region': 'Region of the texture to display, as `x,y,width,height`.',
      'color': 'Color the image is multiplied (tinted) by.',
      'tooltip': 'Tooltip shown when hovering the image.',
      'pad': 'If true, pads the image to keep its size when it fails to load.',
    }
  },
  // --- Paragraphs and alignment --------------------------------------------
  {
    name: 'p',
    syntax: '[p {options}]{text}[/p]',
    description: 'Adds a new paragraph with {text}. Supports configuration options.',
    example: '[p align=center]Chapter One[/p]',
    variables: {
      'align': 'Text horizontal alignment: `left` (`l`), `center` (`c`), `right` (`r`), or `fill` (`f`).',
      'bidi_override': 'Structured text override (also `st`): `default`, `uri`, `file`, `email`, `list`, `none`, or `custom`.',
      'direction': 'Base BiDi direction (also `dir`): `ltr`, `rtl`, `auto`, or `inherit`.',
      'language': 'Locale override for this paragraph (also `lang`), e.g. `en` or `ja`.',
      'tab_stops': 'List of floating-point numbers, e.g. `10.0,30.0`: overrides the default tab stops.',
      'justification_flags': 'Justification flags (also `jst`), e.g. `kashida,word,trim,after_last_tab`.',
    }
  },
  {
    name: 'center',
    syntax: '[center]{text}[/center]',
    description: 'Makes {text} horizontally centered. Same as `[p align=center]`.',
    example: '[center]THE END[/center]'
  },
  {
    name: 'left',
    syntax: '[left]{text}[/left]',
    description: 'Makes {text} horizontally left-aligned. Same as `[p align=left]`.',
    example: '[left]Left-aligned[/left]'
  },
  {
    name: 'right',
    syntax: '[right]{text}[/right]',
    description: 'Makes {text} horizontally right-aligned. Same as `[p align=right]`.',
    example: '[right]Right-aligned[/right]'
  },
  {
    name: 'fill',
    syntax: '[fill]{text}[/fill]',
    description: 'Makes {text} fill the full width of the RichTextLabel. Same as `[p align=fill]`.',
    example: '[fill]Justified text[/fill]'
  },
  {
    name: 'indent',
    syntax: '[indent]{text}[/indent]',
    description: 'Indents {text} once. The indentation width is the same as with `[ul]` or `[ol]`, but without a bullet point.',
    example: '[indent]Indented quote.[/indent]'
  },
  {
    name: 'dropcap',
    syntax: '[dropcap {options}]{text}[/dropcap]',
    description: 'Uses a different font size and color for {text}, while making the tag\'s contents span multiple lines if it\'s large enough. A drop cap is typically one uppercase character, but it can contain several characters.',
    example: '[dropcap font_size=48 margins=0,-5,5,0]O[/dropcap]nce upon a time...',
    variables: {
      'font': 'Path to the font resource used for the drop cap.',
      'font_size': 'Font size of the drop cap.',
      'color': 'Color of the drop cap.',
      'outline_size': 'Outline size of the drop cap.',
      'outline_color': 'Outline color of the drop cap.',
      'margins': 'Margins around the drop cap, as `left,top,right,bottom` in pixels.',
    }
  },
  // --- Lists and tables -----------------------------------------------------
  {
    name: 'ul',
    syntax: '[ul bullet={bullet}]{items}[/ul]',
    description: 'Adds an unordered list. List {items} must be provided by putting one item per line of text. The bullet point can be customized using the `bullet` parameter.',
    example: '[ul]Apples\nPears[/ul]',
    variables: {
      'bullet': 'Custom bullet character(s), e.g. `*` or `-`. Defaults to `•`.',
    }
  },
  {
    name: 'ol',
    syntax: '[ol type={type}]{items}[/ol]',
    description: 'Adds an ordered (numbered) list of the given {type}. List {items} must be provided by putting one item per line of text.',
    example: '[ol type=1]First\nSecond[/ol]',
    variables: {
      'type': 'Numbering style: `1` (numbers), `a` (lowercase letters), `A` (uppercase letters), `i` (lowercase roman numerals), `I` (uppercase roman numerals).',
    }
  },
  {
    name: 'table',
    syntax: '[table={columns},{inline_align}]{cells}[/table]',
    description: 'Creates a table with the {columns} number of columns. Use `[cell]` to define table cells. {inline_align} is optional (`top`, `center`, `baseline`, `bottom`).',
    example: '[table=2][cell]Name[/cell][cell]HP[/cell][/table]',
    snippet: 'table=${1:2}]$0[/table]'
  },
  {
    name: 'cell',
    syntax: '[cell {options}]{text}[/cell]',
    description: 'Adds a cell with {text} to the table. If a ratio is provided (e.g. `[cell=2]`), the cell will try to expand to the specified ratio relative to other cells.',
    example: '[cell border=#ffffff40 padding=2,2,2,2]Name[/cell]',
    variables: {
      'expand': 'Expansion ratio of the cell relative to other cells (same as `[cell={ratio}]`).',
      'border': 'Cell border color.',
      'bg': 'Cell background color. Two comma-separated colors alternate odd/even rows.',
      'padding': 'Cell padding, as `left,top,right,bottom` in pixels.',
    }
  },
  // --- Text effects -----------------------------------------------------------
  {
    name: 'pulse',
    syntax: '[pulse freq=1.0 color=#ffffff40 ease=-2.0]{text}[/pulse]',
    description: 'Creates an animated pulsing effect that multiplies each character\'s opacity and color. It can be used to bring attention to specific text.',
    example: 'Laripo: [pulse]Look here![/pulse]',
    variables: {
      'freq': 'Number of pulses per second.',
      'color': 'Target color multiplier at the peak of the pulse.',
      'ease': 'Easing exponent (negative values ease in and out).',
    }
  },
  {
    name: 'wave',
    syntax: '[wave amp=50.0 freq=5.0 connected=1]{text}[/wave]',
    description: 'Makes the text go up and down.',
    example: 'Laripo: [wave amp=25 freq=5]Wheee![/wave]',
    variables: {
      'amp': 'Amplitude: how high and low the effect goes.',
      'freq': 'Frequency: how fast the text goes up and down.',
      'connected': '`1` (default) keeps glyph clusters (e.g. ligatures) together; `0` animates each glyph independently.',
    }
  },
  {
    name: 'tornado',
    syntax: '[tornado radius=10.0 freq=1.0 connected=1]{text}[/tornado]',
    description: 'Makes the text move around in a circle.',
    example: 'Laripo: [tornado radius=5 freq=2]I\'m dizzy...[/tornado]',
    variables: {
      'radius': 'Radius of the circle that controls the offset.',
      'freq': 'How fast the text moves in a circle.',
      'connected': '`1` (default) keeps glyph clusters (e.g. ligatures) together; `0` animates each glyph independently.',
    }
  },
  {
    name: 'shake',
    syntax: '[shake rate=20.0 level=5 connected=1]{text}[/shake]',
    description: 'Makes the text shake.',
    example: 'Laripo: [shake rate=20 level=10]I-it\'s cold![/shake]',
    variables: {
      'rate': 'How fast the text shakes.',
      'level': 'How far the text is offset from its origin.',
      'connected': '`1` (default) keeps glyph clusters (e.g. ligatures) together; `0` animates each glyph independently.',
    }
  },
  {
    name: 'fade',
    syntax: '[fade start=4 length=14]{text}[/fade]',
    description: 'Creates a static fade effect that multiplies each character\'s opacity.',
    example: '[fade start=0 length=10]Fading away...[/fade]',
    variables: {
      'start': 'Starting position of the falloff relative to where the fade command is inserted.',
      'length': 'Number of characters over which the fade out takes place.',
    }
  },
  {
    name: 'rainbow',
    syntax: '[rainbow freq=1.0 sat=0.8 val=0.8 speed=1.0]{text}[/rainbow]',
    description: 'Gives the text a rainbow color that changes over time.',
    example: 'Laripo: [rainbow]Fabulous![/rainbow]',
    variables: {
      'freq': 'Number of letters the rainbow extends over before it repeats itself.',
      'sat': 'Saturation of the rainbow.',
      'val': 'Value (brightness) of the rainbow.',
      'speed': 'Number of full rainbow cycles per second. Negative values make the rainbow go backwards.',
    }
  },
  // --- Escapes and control characters (no closing tag) --------------------------
  {
    name: 'br',
    syntax: '[br]',
    description: 'Adds a line break in the text, without adding a new paragraph.',
    example: 'Laripo: First line[br]Second line',
    selfClosing: true
  },
  {
    name: 'hr',
    syntax: '[hr {options}]',
    description: 'Adds a horizontal rule (separator line).',
    example: '[hr width=50% color=#ffffff80]',
    selfClosing: true,
    variables: {
      'width': 'Width of the rule in pixels (or percent with a `%` suffix).',
      'height': 'Thickness of the rule in pixels.',
      'color': 'Color of the rule.',
      'align': 'Horizontal alignment: `left`, `center`, or `right`.',
    }
  },
  { name: 'lb', syntax: '[lb]', description: 'Adds `[`. Used to escape BBCode markup.', example: '[lb]b[rb]text[lb]/b[rb]', selfClosing: true },
  { name: 'rb', syntax: '[rb]', description: 'Adds `]`. Used to escape BBCode markup.', example: '[lb]b[rb]text[lb]/b[rb]', selfClosing: true },
  { name: 'lrm', syntax: '[lrm]', description: 'Adds a left-to-right mark (LRM, U+200E): a zero-width character that affects BiDi text ordering.', example: '[lrm]', selfClosing: true },
  { name: 'rlm', syntax: '[rlm]', description: 'Adds a right-to-left mark (RLM, U+200F): a zero-width character that affects BiDi text ordering.', example: '[rlm]', selfClosing: true },
  { name: 'lre', syntax: '[lre]', description: 'Adds a left-to-right embedding control character (LRE, U+202A).', example: '[lre]', selfClosing: true },
  { name: 'rle', syntax: '[rle]', description: 'Adds a right-to-left embedding control character (RLE, U+202B).', example: '[rle]', selfClosing: true },
  { name: 'lro', syntax: '[lro]', description: 'Adds a left-to-right override control character (LRO, U+202D).', example: '[lro]', selfClosing: true },
  { name: 'rlo', syntax: '[rlo]', description: 'Adds a right-to-left override control character (RLO, U+202E).', example: '[rlo]', selfClosing: true },
  { name: 'pdf', syntax: '[pdf]', description: 'Adds a pop directional formatting control character (PDF, U+202C).', example: '[pdf]', selfClosing: true },
  { name: 'alm', syntax: '[alm]', description: 'Adds an Arabic letter mark (ALM, U+061C).', example: '[alm]', selfClosing: true },
  { name: 'lri', syntax: '[lri]', description: 'Adds a left-to-right isolate control character (LRI, U+2066).', example: '[lri]', selfClosing: true },
  { name: 'rli', syntax: '[rli]', description: 'Adds a right-to-left isolate control character (RLI, U+2067).', example: '[rli]', selfClosing: true },
  { name: 'fsi', syntax: '[fsi]', description: 'Adds a first strong isolate control character (FSI, U+2068).', example: '[fsi]', selfClosing: true },
  { name: 'pdi', syntax: '[pdi]', description: 'Adds a pop directional isolate control character (PDI, U+2069).', example: '[pdi]', selfClosing: true },
  { name: 'zwj', syntax: '[zwj]', description: 'Adds a zero-width joiner (U+200D): joins the characters on either side into a single glyph when the font supports it.', example: '[zwj]', selfClosing: true },
  { name: 'zwnj', syntax: '[zwnj]', description: 'Adds a zero-width non-joiner (U+200C): prevents the characters on either side from being joined.', example: '[zwnj]', selfClosing: true },
  { name: 'wj', syntax: '[wj]', description: 'Adds a word joiner (U+2060): prevents a line break between the characters on either side.', example: '[wj]', selfClosing: true },
  { name: 'shy', syntax: '[shy]', description: 'Adds a soft hyphen (U+00AD): an invisible hyphen shown only if the word is broken across lines there.', example: 'extra[shy]ordinary', selfClosing: true },
].map(entry => ({ ...entry, type: 'bbcode', docsUrl: GODOT_BBCODE_DOCS_URL }));

/**
 * The BBCode tags offered right after a bare `[` - the ones used most in
 * dialogue. Every other tag (alignment, lists, tables, BiDi control
 * characters...) is still suggested, but only once a letter of its name
 * has been typed, so a bare `[` doesn't bury Dialogic's own commands
 * under ~50 BBCode tags.
 *
 * @type {Set<string>}
 */
const COMMON_BBCODE_NAMES = new Set([
  'b', 'i', 'u', 's', 'color', 'font_size', 'center', 'url', 'img',
  'wave', 'shake', 'rainbow', 'pulse', 'tornado', 'fade', 'br',
]);

// =============================================================================
// DIALOGIC TEXT EFFECTS AND MODIFIERS
// =============================================================================
// Dialogic's own commands inside text (not Godot BBCode): effects happen
// when the reveal reaches them ([pause=0.5], [portrait=happy], [aa]...),
// modifiers change the text before it's shown ([if ...], <a/b>). From
// Dialogic's Text/Character/Core modules (_get_text_effects,
// _get_text_modifiers) and docs.dialogic.pro/text-effects.html.

/** @type {string} */
const DIALOGIC_TEXT_EFFECTS_DOCS_URL = 'https://docs.dialogic.pro/text-effects.html';

/**
 * Same shape as DTL_BBCODES entries (rendered by createDocumentation), plus
 * `snippet`: the completion insert text after the typed `[`, and
 * `valueFrom`: where `[name=` values are suggested from.
 */
const DTL_TEXT_EFFECTS = [
  { name: 'pause', syntax: '[pause=x] / [pause=x!] / [pause]', snippet: 'pause=${1:0.5}]', description: 'Pauses the reveal for x seconds (0.5 by default). The pause is multiplied by the current speed multiplier and the text speed setting, unless it ends with "!".', example: 'Laripo: Well...[pause=0.8] I guess so.' },
  { name: 'speed', syntax: '[speed=x] / [speed]', snippet: 'speed=${1:2}]', description: 'Sets the temporary speed multiplier to x (1 if no x is given). It multiplies pauses and letter speed: a bigger number is a slower reveal, 0 is instant.', example: 'Laripo: [speed=3]S-l-o-w-l-y[speed] and normal again.' },
  { name: 'lspeed', syntax: '[lspeed=x] / [lspeed=x!] / [lspeed]', snippet: 'lspeed=${1:0.05}]', description: 'Sets the letter speed to x seconds per letter, or back to the default if no x is given. Multiplied by the speed multiplier and the text speed setting, unless it ends with "!".', example: 'Laripo: [lspeed=0.2]Dramatic.' },
  { name: 'signal', syntax: '[signal=argument]', snippet: 'signal=${1:argument}]', description: 'Emits `Dialogic.text_signal` with the given argument when the reveal reaches it - to make something happen at an exact moment of the text.', example: 'Laripo: And then... [signal=thunder]BOOM!' },
  { name: 'portrait', syntax: '[portrait=name]', snippet: 'portrait=${1}]', valueFrom: 'portraits', description: 'Changes the speaker\'s portrait to the one with the given name, mid-sentence.', example: 'Laripo: I\'m fine. [portrait=sad]Really.' },
  { name: 'mood', syntax: '[mood=name]', snippet: 'mood=${1}]', valueFrom: 'soundMoods', description: 'Changes the speaker\'s typing sound mood to the one with the given name (from the character\'s typing sounds settings).', example: 'Laripo: [mood=angry]WHAT?!' },
  { name: 'extra_data', syntax: '[extra_data=value]', snippet: 'extra_data=${1}]', valueFrom: 'layers', description: 'Changes the extra data of the speaker\'s portrait, e.g. `set Head/Happy` to switch a LayeredPortrait layer.', example: 'Laripo: [extra_data=set Mouth/Smile]Hehe.' },
  { name: 'aa', syntax: '[aa] / [aa=x] / [aa=x?]', snippet: 'aa]', description: 'Enables Auto-Advance for this text event. With x, overrides the delay before advancing (x seconds; "?" makes it absolute).', example: 'Laripo: This line goes on by itself.[aa]' },
  { name: 'ns', syntax: '[ns] / [ns=x]', snippet: 'ns]', description: 'For this text event, disables text skipping and manual advance, and enables Auto-Advance (x overrides its delay).', example: 'Laripo: You can\'t skip this.[ns]' },
  { name: 'nrs', syntax: '[nrs]', snippet: 'nrs]', description: 'For this text event, prevents the player from skipping the reveal of the text (it can still be advanced once revealed).', example: 'Laripo: Read every letter.[nrs]' },
  { name: 'input', syntax: '[input]', snippet: 'input]', description: 'Waits for any input when reached. Unlike [n+], it doesn\'t split the text into sections, so it can be skipped.', example: 'Laripo: Wait for it...[input] there.' },
  { name: 'n', syntax: '[n]', snippet: 'n]', description: 'Visually starts a new text box, like a new text event: the player has to advance (or Auto-Advance does). The text before it is cleared.', example: 'Laripo: First box.[n]Second box.' },
  { name: 'n+', syntax: '[n+]', snippet: 'n+]', description: 'Like [n], but the next part is added after the current text instead of replacing it.', example: 'Laripo: First part...[n+] and the rest.' },
  { name: 'if', syntax: '[if {condition} text if true/text if false]', snippet: 'if {${1:variable}} ${2:text if true}/${3:text if false}]', description: 'Conditional text (a text modifier): shows the first text if the condition is true, else the text after "/" (optional). Saves a whole condition event for a word or a sentence.', example: 'Laripo: [if {KeyCollected} You have a key./You don\'t have any key.]' },
].map(entry => ({ ...entry, type: 'text_effect', docsUrl: DIALOGIC_TEXT_EFFECTS_DOCS_URL, docsLabel: 'Dialogic documentation' }));

/** Names of the text effects that take no closer and aren't BBCode. @type {Set<string>} */
const TEXT_EFFECT_NAMES = new Set(DTL_TEXT_EFFECTS.map(entry => entry.name));

/**
 * Completion item for a Dialogic text effect after `[` - the same event
 * icon as Dialogic's commands, since both are Dialogic's own.
 *
 * @param {object} entry - one of DTL_TEXT_EFFECTS
 * @param {vscode.Range} range - the typed name plus an auto-closed "]"
 * @returns {vscode.CompletionItem}
 */
function createTextEffectCompletion(entry, range) {
  const item = new vscode.CompletionItem({ label: entry.name, description: summarizeDescription(entry.description) }, vscode.CompletionItemKind.Event);
  item.detail = `Dialogic text effect - ${entry.syntax}`;
  item.documentation = createDocumentation(entry);
  item.sortText = `0b_${entry.name}`;
  item.insertText = new vscode.SnippetString(entry.snippet);
  item.range = range;
  if (entry.valueFrom) { item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' }; }
  return item;
}

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
  const speaker = findLineSpeaker(line);
  if (!speaker) { return []; }
  const entry = DTL_TEXT_EFFECTS.find(candidate => candidate.name === effectName);
  const item = (label, detail, kind) => {
    const completion = new vscode.CompletionItem(label, kind);
    completion.detail = detail;
    return completion;
  };
  if (entry.valueFrom === 'portraits') {
    const moods = completionCharacterMoods(speaker.name);
    return moods ? [...moods.keys()].filter(mood => mood.toLowerCase().startsWith(typedValue.toLowerCase())).map(mood => item(mood, `Portrait of ${speaker.name}`, vscode.CompletionItemKind.EnumMember)) : [];
  }
  if (entry.valueFrom === 'soundMoods') {
    return (cachedCharacterSoundMoods.get(speaker.name) || []).filter(mood => mood.toLowerCase().startsWith(typedValue.toLowerCase())).map(mood => item(mood, `Typing sound mood of ${speaker.name}`, vscode.CompletionItemKind.EnumMember));
  }
  if (entry.valueFrom === 'layers') {
    if (!/^set\s/.test(typedValue)) {
      return 'set '.startsWith(typedValue) ? [Object.assign(item('set', 'Switch a LayeredPortrait layer: set Layer/Child', vscode.CompletionItemKind.Keyword), { insertText: 'set ', command: { command: 'editor.action.triggerSuggest', title: 'Suggest layers' } })] : [];
    }
    return createEmotionPathSuggestions(`join ${/\s/.test(speaker.name) ? `"${speaker.name}"` : speaker.name}${speaker.mood ? ` (${speaker.mood})` : ''} center`, typedValue);
  }
  return [];
}

/**
 * BBCode tags that have no `[/name]` closer, so they're never flagged as
 * unclosed balises by findUnclosedBaliseDiagnostics.
 *
 * @type {Set<string>}
 */
const SELF_CLOSING_BBCODE_NAMES = new Set(DTL_BBCODES.filter(entry => entry.selfClosing).map(entry => entry.name));

/**
 * Look up a bracket command (DTL_ENTRIES, type "bracket") or Godot BBCode
 * tag (DTL_BBCODES) by name - DTL's own commands win if a name is shared.
 *
 * @param {string} name
 * @returns {object | undefined}
 */
function findBracketOrBbcodeEntry(name) {
  return DTL_ENTRIES.find(entry => entry.name === name && entry.type === 'bracket')
    || DTL_BBCODES.find(entry => entry.name === name);
}
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
 * File extensions (lowercase, no dot) Godot can load for each kind of
 * resource a timeline can point at, used to only suggest `res://` paths
 * that actually make sense for the command being written - e.g. audio
 * files for `[voice path="`, never a `.gd` script or a `.dch` character.
 *
 * @type {Record<string, string[]>}
 */
const RESOURCE_EXTENSIONS = {
  audio: ['ogg', 'wav', 'mp3'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'tga', 'exr', 'hdr', 'dds', 'ktx'],
  video: ['ogv'],
  scene: ['tscn', 'scn'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'fnt', 'font', 'pfb', 'pfm'],
};

/**
 * Bracket-command attributes whose value is a Godot `res://` resource path,
 * e.g. `[voice path="res://..."]`, mapped to the file extensions that make
 * sense there. Keyed the same way as DTL_ATTRIBUTE_VALUE_SUGGESTIONS
 * (entry name -> attribute name -> ...), so createAttributeValueSuggestions
 * can fall back to path suggestions when no fixed enum of values applies.
 *
 * @type {Record<string, Record<string, string[]>>}
 */
const DTL_PATH_ATTRIBUTES = {
  voice: { path: RESOURCE_EXTENSIONS.audio },
  // The default background scene displays `arg` as an image or a video.
  background: { arg: [...RESOURCE_EXTENSIONS.image, ...RESOURCE_EXTENSIONS.video], scene: RESOURCE_EXTENSIONS.scene },
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
 * @param {vscode.Position} position - cursor position, for path suggestions' replace range
 * @returns {vscode.CompletionItem[]}
 */
function createAttributeValueSuggestions(entryName, attributeName, typedValue, position) {
  const values = DTL_ATTRIBUTE_VALUE_SUGGESTIONS[entryName] && DTL_ATTRIBUTE_VALUE_SUGGESTIONS[entryName][attributeName];
  if (values) {
    const alreadyQuoted = typedValue.startsWith('"');
    const prefix = (alreadyQuoted ? typedValue.slice(1) : typedValue).toLowerCase();
    return values
      .filter(value => value.toLowerCase().startsWith(prefix))
      .map(value => createValueCompletion(value, alreadyQuoted));
  }
  const pathExtensions = DTL_PATH_ATTRIBUTES[entryName] && DTL_PATH_ATTRIBUTES[entryName][attributeName];
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
  return completionResourcePaths()
    .filter(path => path.toLowerCase().startsWith(prefix))
    .filter(path => !extensions || extensions.includes(path.slice(path.lastIndexOf('.') + 1).toLowerCase()))
    .map(path => createPathCompletion(path, quote, range));
}

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/** Character names found in project.godot. @type {string[]} */
let cachedCharacterNames = [];

/** Character name -> `res://` `.dch` path, from project.godot. @type {Map<string, string>} */
let cachedCharacterPaths = new Map();

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
 * Per autoload name (from project.godot's `[autoload]` section), the
 * public top-level symbols of its script (see parseGdScript) - plus where
 * that script came from. An autoload can point either straight at a `.gd`
 * script, or at a `.tscn` scene ("autoload node"), in which case the
 * scene's root node script is used, since that's the node Dialogic reaches
 * as `Name`. Powers `Name.member` autocomplete and hover after `do`, `if`
 * and `elif`, and inside `{Name.property}` variable blocks.
 *
 * Only autoloads are included - not every `class_name` script - because
 * that's all Dialogic can actually resolve by name at runtime. Autoloads
 * declared by addons (`res://addons/...`, e.g. Dialogic's own `Dialogic`
 * singleton with its hundreds of members) are skipped unless the
 * `dtlReader.includeAddonAutoloads` setting is on.
 *
 * @type {Map<string, GdScriptSymbols & {scriptPath: string, scenePath: string|null}>}
 */
let cachedAutoloadSymbols = new Map();

/**
 * Every autoload name declared in project.godot - including the addon
 * ones left out of cachedAutoloadSymbols - so `{Dialogic.x}`-style
 * references are never reported as unknown variables just because their
 * members aren't loaded.
 *
 * @type {Set<string>}
 */
let cachedAutoloadNames = new Set();

/**
 * Per character, per mood, the portrait settings from the `.dch` file
 * (see parseDchPortraits) plus, for a scene-backed mood, the scene's node
 * types/descriptions (see parseTscnNodeInfo). Powers the mood and
 * LayeredPortrait layer hovers.
 *
 * @type {Map<string, Map<string, DchPortraitInfo & {nodes: Map<string, {type: string|null, description: string|null}>|null}>>}
 */
let cachedPortraitDetails = new Map();

/** Per character, the names of their typing sound moods (custom_info > sound_moods), for [mood=...]. @type {Map<string, string[]>} */
let cachedCharacterSoundMoods = new Map();

/**
 * What project.godot actually declares, so diagnostics only report an
 * unknown character/variable when there's a real list to check against:
 * `characters` is true when `directories/dch_directory` exists, `variables`
 * when `[dialogic]` has a `variables={...}` entry, `timelines` when
 * `directories/dtl_directory` exists.
 *
 * @type {{characters: boolean, variables: boolean, timelines: boolean}}
 */
let declaredProjectData = { characters: false, variables: false, timelines: false };

/**
 * Timeline identifier -> `res://` path, from project.godot's
 * `directories/dtl_directory` - how Dialogic names a timeline in
 * `jump Timeline/label` (the file name, or a short unique path when two
 * timelines share one).
 *
 * @type {Map<string, string>}
 */
let cachedTimelinePaths = new Map();

/**
 * Per timeline identifier, its labels as last read from disk (see
 * getTimelineLabels, which prefers an open editor's live text).
 *
 * @type {Map<string, Map<string, DtlLabelInfo>>}
 */
let cachedTimelineLabels = new Map();

/**
 * Every registered timeline's lines as last read from disk, by identifier -
 * to know where each label is jumped to from and which characters and
 * moods the timelines use. See currentTimelineLines for the live view.
 *
 * @type {Map<string, string[]>}
 */
let cachedTimelineLines = new Map();

/**
 * Every string literal of the project's own scripts (`.gd` files outside
 * `res://addons/dialogic/`), so a label, character or portrait that a script
 * names - `Dialogic.start("chapter1", "intro")` - isn't reported unused.
 *
 * @type {Set<string>}
 */
let cachedScriptStrings = new Set();

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
 * Extract one of the `[dialogic]` `directories/<extension>_directory`
 * dicts (identifier -> `res://` path), e.g. `dtl` for timelines. Same
 * shape as the `dch` one extractCharacterPaths reads.
 *
 * @param {string} text - raw project.godot content
 * @param {string} extension - e.g. "dtl"
 * @returns {Map<string, string>}
 */
function extractDialogicDirectory(text, extension) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const dictionaryMatch = sectionMatch[1].match(new RegExp(`directories\\/${extension}_directory\\s*=\\s*\\{([\\s\\S]*?)\\}`));
  if (!dictionaryMatch) { return new Map(); }
  const entryPattern = /"([^"]+)"\s*:\s*"([^"]*)"/g;
  const paths = new Map();
  let match;
  while ((match = entryPattern.exec(dictionaryMatch[1])) !== null) { paths.set(match[1], match[2]); }
  return paths;
}

/**
 * Re-read every registered timeline's labels from disk, for cross-timeline
 * `jump Timeline/label` completion, hover and diagnostics. An unreadable
 * timeline just has no labels.
 */
async function refreshTimelineLabels() {
  const labelsByTimeline = new Map();
  const linesByTimeline = new Map();
  for (const [identifier, resPath] of cachedTimelinePaths) {
    try {
      const bytes = await vscode.workspace.fs.readFile(resolveResourcePath(resPath));
      const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
      labelsByTimeline.set(identifier, collectLabelsFromLines(lines));
      linesByTimeline.set(identifier, lines);
    } catch (error) {
      console.error(`DTL Reader: timeline "${identifier}" declares "${resPath}" but it could not be read - its labels are unavailable for jump.`, error);
    }
  }
  cachedTimelineLabels = labelsByTimeline;
  cachedTimelineLines = linesByTimeline;
}

/**
 * Every timeline's lines: the registered ones by identifier - read live
 * from their editor if open (so unsaved edits count), else as last read
 * from disk (cachedTimelineLines) - plus the open timelines not registered
 * yet (a new one Dialogic hasn't indexed), by timelineKey.
 *
 * @returns {Map<string, string[]>}
 */
function currentTimelineLines() {
  const result = new Map(cachedTimelineLines);
  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === 'dtl') { result.set(timelineKey(document), documentLines(document)); }
  }
  return result;
}

/**
 * A timeline's key in currentTimelineLines: its identifier, or its URI
 * while it isn't registered.
 *
 * @param {vscode.TextDocument} document
 * @returns {string}
 */
function timelineKey(document) {
  return findTimelineIdentifier(document) || document.uri.toString();
}

/**
 * Extract autoload/global-script name -> `res://` script path from
 * project.godot's `[autoload]` section, e.g. `Global="*res://global.gd"`.
 * The optional leading `*` (marks it enabled in-editor) is ignored either
 * way. Entries pointing at a `.tscn` (a singleton scene rather than a
 * plain script) are kept too - refreshAutoloadSymbols resolves those to
 * their root node's script.
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
 * @typedef {{params: string, returnType: string|null, doc: string, isStatic: boolean, line: number}} GdFunctionInfo
 * @typedef {{type: string|null, defaultValue: string|null, doc: string, isStatic: boolean, isExported: boolean, line: number}} GdVariableInfo
 * @typedef {{type: string|null, value: string, doc: string, line: number}} GdConstantInfo
 * @typedef {{name: string, value: string, doc: string}} GdEnumValueInfo
 * @typedef {{values: GdEnumValueInfo[], doc: string, line: number}} GdEnumInfo
 * @typedef {{
 *   doc: string,
 *   functions: Map<string, GdFunctionInfo>,
 *   variables: Map<string, GdVariableInfo>,
 *   constants: Map<string, GdConstantInfo>,
 *   enums: Map<string, GdEnumInfo>
 * }} GdScriptSymbols
 */

/**
 * Strip a trailing `# comment` from one line of GDScript, ignoring any `#`
 * that sits inside a string literal (e.g. `const TAG = "#hero"`).
 *
 * @param {string} line
 * @returns {string}
 */
function stripGdComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { i++; }
      else if (ch === quote) { quote = null; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Starting at `lines[startIndex]`, join as many lines as needed (comments
 * stripped) for the bracket opened at `openIndex` of the first line to be
 * closed again, tracking nested `()`/`[]`/`{}` depth so e.g. a parameter's
 * default value `Color(1, 1, 1, 1)` doesn't end the scan early. Lets
 * multi-line function signatures and multi-line enums be parsed the same
 * way as single-line ones.
 *
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {number} openIndex - index of the opening bracket in the first (comment-stripped) line
 * @returns {{text: string, closeIndex: number, lastLineIndex: number} | null}
 *   the joined text, the index of the matching closer inside it, and the
 *   last line index consumed - or null if never closed (within 50 lines).
 */
function joinUntilBracketCloses(lines, startIndex, openIndex) {
  let text = '';
  let depth = 0;
  for (let lineIndex = startIndex; lineIndex < lines.length && lineIndex < startIndex + 50; lineIndex++) {
    const offset = text.length;
    text += stripGdComment(lines[lineIndex]) + '\n';
    for (let i = lineIndex === startIndex ? openIndex : offset; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') { depth++; }
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { return { text, closeIndex: i, lastLineIndex: lineIndex }; }
      }
    }
  }
  return null;
}

/**
 * Split an enum body (text between its braces) into its values, resolving
 * GDScript's implicit numbering (each value is the previous one + 1,
 * starting at 0). A `##` comment line inside the body documents the value
 * directly below it, same as for top-level members.
 *
 * @param {string[]} bodyLines - raw lines of the enum body (braces excluded)
 * @returns {GdEnumValueInfo[]}
 */
function parseGdEnumBody(bodyLines) {
  const values = [];
  let nextValue = 0;
  let pendingDoc = [];
  for (const rawLine of bodyLines) {
    const docMatch = rawLine.match(/^\s*##\s?(.*)$/);
    if (docMatch) {
      pendingDoc.push(docMatch[1]);
      continue;
    }
    for (const item of stripGdComment(rawLine).split(',')) {
      const itemMatch = item.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(.+))?$/);
      if (!itemMatch) { continue; }
      let value;
      if (itemMatch[2] !== undefined) {
        value = itemMatch[2].trim();
        const numeric = Number(value);
        nextValue = Number.isInteger(numeric) ? numeric + 1 : null;
      } else {
        value = nextValue === null ? '?' : String(nextValue);
        if (nextValue !== null) { nextValue++; }
      }
      values.push({ name: itemMatch[1], value, doc: pendingDoc.join('\n').trim() });
      pendingDoc = [];
    }
  }
  return values;
}

/**
 * Parse a GDScript file's public top-level symbols: functions, variables
 * (`var`, including `@export`/`@onready`/`static` ones), constants, and
 * enums - plus the script's own class documentation. Each symbol's `doc`
 * follows GDScript's documentation-comment convention: consecutive
 * `##`-prefixed lines directly above it (see
 * https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_documentation_comments.html);
 * the script's own doc is the `##` block after `extends`/`class_name`,
 * before any member.
 *
 * Indented lines (function bodies, inner classes) are skipped, since only
 * top-level members are reachable as `Global.member`. Names starting with
 * `_` are skipped too, since that's GDScript's own "private" convention
 * (this also excludes engine callbacks like `_ready`). An unnamed
 * `enum { A, B }` declares plain constants, so its values are listed as
 * constants rather than as an enum.
 *
 * @param {string} text - raw .gd file content
 * @returns {GdScriptSymbols}
 */
function parseGdScript(text) {
  const symbols = { doc: '', functions: new Map(), variables: new Map(), constants: new Map(), enums: new Map() };
  const lines = text.split(/\r?\n/);
  let pendingDocLines = [];
  let seenMember = false;
  // An `@export...` annotation, possibly on its own line above the var.
  let pendingExport = false;
  const takeDoc = () => {
    const doc = pendingDocLines.join('\n').trim();
    pendingDocLines = [];
    return doc;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const docMatch = rawLine.match(/^##\s?(.*)$/);
    if (docMatch) {
      pendingDocLines.push(docMatch[1]);
      continue;
    }
    if (rawLine.trim() === '') {
      // A `##` block followed by a blank line before any member has been
      // declared is the script's own doc (e.g. right after `extends Node`).
      if (!seenMember && !symbols.doc && pendingDocLines.length > 0) { symbols.doc = takeDoc(); }
      continue;
    }
    if (/^\s/.test(rawLine)) {
      pendingDocLines = []; // indented: a function body or inner class member
      continue;
    }
    if (rawLine.startsWith('#')) {
      continue; // a plain comment doesn't break the `##` chain
    }

    // Leading annotations (`@export`, `@onready`, `@export_range(0, 10)`,
    // ...) are dropped - an annotation-only line keeps the `##` chain intact.
    let code = stripGdComment(rawLine).trim();
    let annotationMatch;
    while ((annotationMatch = code.match(/^@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s*/))) {
      if (annotationMatch[0].startsWith('@export')) { pendingExport = true; }
      code = code.slice(annotationMatch[0].length);
    }
    if (code === '') { continue; }
    const isExported = pendingExport;
    pendingExport = false;

    if (/^(?:extends|class_name)\b/.test(code)) {
      if (pendingDocLines.length > 0 && !symbols.doc) { symbols.doc = takeDoc(); }
      continue;
    }

    const funcMatch = code.match(/^(static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (funcMatch) {
      seenMember = true;
      const doc = takeDoc();
      const name = funcMatch[2];
      const declarationLine = i;
      const lineOffset = stripGdComment(rawLine).indexOf(funcMatch[0]);
      const openIndex = lineOffset + funcMatch[0].length - 1;
      const joined = joinUntilBracketCloses(lines, i, openIndex);
      if (!joined) { continue; }
      i = joined.lastLineIndex;
      if (name.startsWith('_')) { continue; }
      const params = joined.text.slice(openIndex + 1, joined.closeIndex).replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
      const returnMatch = joined.text.slice(joined.closeIndex + 1).match(/^\s*->\s*([A-Za-z_][A-Za-z0-9_.\[\], ]*?)\s*:/);
      symbols.functions.set(name, { params, returnType: returnMatch ? returnMatch[1] : null, doc, isStatic: !!funcMatch[1], line: declarationLine });
      continue;
    }

    const varMatch = code.match(/^(static\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
    if (varMatch) {
      seenMember = true;
      const doc = takeDoc();
      if (varMatch[2].startsWith('_')) { continue; }
      // A trailing ':' opens a setter/getter block - not part of the value.
      const rest = varMatch[3].replace(/:\s*$/, '').trim();
      const typedMatch = rest.match(/^(?::\s*([^=]+?))?\s*(?::?=\s*(.*))?$/);
      symbols.variables.set(varMatch[2], {
        type: typedMatch && typedMatch[1] ? typedMatch[1].trim() : null,
        defaultValue: typedMatch && typedMatch[2] ? typedMatch[2].trim() : null,
        doc,
        isStatic: !!varMatch[1],
        isExported,
        line: i,
      });
      continue;
    }

    const constMatch = code.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*:?=\s*(.*)$/);
    if (constMatch) {
      seenMember = true;
      const doc = takeDoc();
      if (constMatch[1].startsWith('_')) { continue; }
      symbols.constants.set(constMatch[1], { type: constMatch[2] ? constMatch[2].trim() : null, value: constMatch[3].trim(), doc, line: i });
      continue;
    }

    const enumMatch = code.match(/^enum\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\{/);
    if (enumMatch) {
      seenMember = true;
      const doc = takeDoc();
      const declarationLine = i;
      const openIndex = stripGdComment(rawLine).indexOf('{');
      const joined = joinUntilBracketCloses(lines, i, openIndex);
      if (!joined) { continue; }
      // Re-split the raw (comment-intact) lines so `##` value docs survive.
      const rawBody = lines.slice(i, joined.lastLineIndex + 1).join('\n');
      const bodyStart = rawBody.indexOf('{') + 1;
      const bodyEnd = rawBody.lastIndexOf('}');
      const values = parseGdEnumBody(rawBody.slice(bodyStart, bodyEnd).split('\n'))
        .filter(value => !value.name.startsWith('_'));
      i = joined.lastLineIndex;
      const enumName = enumMatch[1];
      if (enumName) {
        if (!enumName.startsWith('_')) { symbols.enums.set(enumName, { values, doc, line: declarationLine }); }
      } else {
        for (const value of values) {
          symbols.constants.set(value.name, { type: 'int', value: value.value, doc: value.doc || doc, line: declarationLine });
        }
      }
      continue;
    }

    // Anything else (signal, class, a stray statement...) breaks the chain.
    seenMember = true;
    pendingDocLines = [];
  }
  return symbols;
}

/**
 * Find the `res://` path of the script attached to a `.tscn` scene's root
 * node - used to resolve an autoload that points at a scene ("autoload
 * node") to the script whose members are reachable as `Name.member`.
 * Handles both the Godot 4 (`ExtResource("1_abc")`) and Godot 3
 * (`ExtResource( 1 )`) id formats. A root node with no script, or with a
 * built-in (SubResource) script, yields null.
 *
 * @param {string} text - raw .tscn file content
 * @returns {string | null}
 */
function extractSceneRootScriptPath(text) {
  const scriptResources = new Map();
  const extResourcePattern = /\[ext_resource\b([^\]]*)\]/g;
  let match;
  while ((match = extResourcePattern.exec(text)) !== null) {
    const attributes = match[1];
    const typeMatch = attributes.match(/\btype="([^"]+)"/);
    const pathMatch = attributes.match(/\bpath="([^"]+)"/);
    const idMatch = attributes.match(/\bid=(?:"([^"]+)"|(\d+))/);
    if (typeMatch && typeMatch[1] === 'Script' && pathMatch && idMatch) {
      scriptResources.set(idMatch[1] || idMatch[2], pathMatch[1]);
    }
  }
  // The root is the only [node] without a parent= attribute.
  const rootMatch = text.match(/\[node\b(?![^\]]*\bparent=)[^\]]*\]([\s\S]*?)(?=\r?\n\[|$)/);
  if (!rootMatch) { return null; }
  const scriptMatch = rootMatch[1].match(/^\s*script\s*=\s*ExtResource\(\s*"?([^")\s]+)"?\s*\)/m);
  return scriptMatch ? (scriptResources.get(scriptMatch[1]) || null) : null;
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
 * @typedef {{
 *   scene: string|null,
 *   image: string|null,
 *   mirror: boolean,
 *   offset: string|null,
 *   scale: string|null
 * }} DchPortraitInfo
 */

/**
 * Parse a `.dch` character file's `"portraits"` dictionary into mood name
 * -> its declared settings: the LayeredPortrait/custom `scene` `res://`
 * path (null for a plain single-image portrait), the `image` set in its
 * `export_overrides` (if any), and its mirror/offset/scale. The file uses
 * GDScript-ish resource syntax (`&"key": value` dictionaries), so this
 * walks brace-balanced blocks rather than treating it as JSON.
 *
 * @param {string} text - raw .dch file content
 * @returns {Map<string, DchPortraitInfo>}
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
    // export_overrides values are GDScript literals stored as strings, so
    // an image path looks like "\"res://...png\"" - quotes are optional.
    const imageMatch = moodBody.match(/&?"image"\s*:\s*"(?:\\")?([^"\\]*)/);
    const mirrorMatch = moodBody.match(/&?"mirror"\s*:\s*(true|false)/);
    const offsetMatch = moodBody.match(/&?"offset"\s*:\s*(Vector2i?\([^)]*\))/);
    const scaleMatch = moodBody.match(/&?"scale"\s*:\s*([\d.]+)/);
    portraits.set(key, {
      scene: sceneMatch && sceneMatch[1] ? sceneMatch[1] : null,
      image: imageMatch && imageMatch[1] ? imageMatch[1] : null,
      mirror: !!mirrorMatch && mirrorMatch[1] === 'true',
      offset: offsetMatch ? offsetMatch[1] : null,
      scale: scaleMatch ? scaleMatch[1] : null,
    });
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
 * @returns {{displayName: string|null, nicknames: string[], description: string|null, color: string|null, defaultPortrait: string|null}}
 */
function parseDchCharacterInfo(text) {
  const displayNameMatch = text.match(/&?"display_name"\s*:\s*"([^"]*)"/);
  const defaultPortraitMatch = text.match(/&?"default_portrait"\s*:\s*"([^"]*)"/);
  const translationIdMatch = text.match(/&?"_translation_id"\s*:\s*"([^"]*)"/);
  const descriptionMatch = text.match(/&?"description"\s*:\s*"([^"]*)"/);
  const colorMatch = text.match(/&?"color"\s*:\s*(Color\([^)]*\))/);

  const nicknames = [];
  const nicknamesMatch = text.match(/&?"nicknames"\s*:\s*\[([^\]]*)\]/);
  if (nicknamesMatch) {
    const itemPattern = /"([^"]*)"/g;
    let match;
    while ((match = itemPattern.exec(nicknamesMatch[1])) !== null) {
      const nickname = match[1].trim();
      if (nickname !== '') { nicknames.push(nickname); } // skip blanks, e.g. a stray [""]
    }
  }

  return {
    displayName: displayNameMatch ? displayNameMatch[1] : null,
    nicknames,
    description: descriptionMatch ? descriptionMatch[1] : null,
    color: colorMatch ? parseGodotColor(colorMatch[1]) : null,
    defaultPortrait: defaultPortraitMatch && defaultPortraitMatch[1] ? defaultPortraitMatch[1] : null,
    translationId: translationIdMatch && translationIdMatch[1] ? translationIdMatch[1] : null,
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
  // Dialogic translates the name and nicknames with the keys
  // Character/<translation id>/name and .../nicknames (", "-separated).
  if (info.translationId) {
    const locales = cachedTranslationLocales.filter(locale => locale !== getOriginalLocale());
    const rows = locales.map(locale => {
      const name = getTranslation(`Character/${info.translationId}/name`, locale);
      const nicknames = getTranslation(`Character/${info.translationId}/nicknames`, locale);
      return name || nicknames ? `| ${locale} | ${name || '_not translated_'} | ${nicknames || ''} |` : null;
    }).filter(Boolean);
    if (rows.length > 0) {
      markdown.appendMarkdown(`\n\n**Translations**\n\n| Locale | Name | Nicknames |\n|---|---|---|\n${rows.join('\n')}\n`);
    }
  }
  return markdown;
}

/** Shown in place of a missing `##` documentation comment. @type {string} */
const NO_GD_DOC_MESSAGE = '_No `##` documentation comment found above this symbol in its script._';

/**
 * One-line GDScript-style signature of an autoload member, e.g.
 * `func Global.apply_tint(color: Color) -> void` or `var Global.hp: int = 10`.
 * Shared by the hover (as its code block title) and the completion detail.
 *
 * @param {string} globalName
 * @param {string} memberName
 * @param {'function'|'variable'|'constant'|'enum'} kind
 * @param {object} info - the member's entry from GdScriptSymbols
 * @returns {string}
 */
function formatAutoloadMemberSignature(globalName, memberName, kind, info) {
  const qualifiedName = `${globalName}.${memberName}`;
  switch (kind) {
    case 'function':
      return `${info.isStatic ? 'static ' : ''}func ${qualifiedName}(${info.params})${info.returnType ? ' -> ' + info.returnType : ''}`;
    case 'variable':
      return `${info.isStatic ? 'static ' : ''}var ${qualifiedName}${info.type ? ': ' + info.type : ''}${info.defaultValue !== null ? ' = ' + info.defaultValue : ''}`;
    case 'constant':
      return `const ${qualifiedName}${info.type ? ': ' + info.type : ''} = ${info.value}`;
    case 'enum':
      return `enum ${qualifiedName} { ${info.values.map(value => `${value.name} = ${value.value}`).join(', ')} }`;
  }
  return qualifiedName;
}

/**
 * Find a member on an autoload by name, whatever its kind.
 *
 * @param {GdScriptSymbols} symbols
 * @param {string} memberName
 * @returns {{kind: 'function'|'variable'|'constant'|'enum', info: object} | null}
 */
function findAutoloadMember(symbols, memberName) {
  if (symbols.functions.has(memberName)) { return { kind: 'function', info: symbols.functions.get(memberName) }; }
  if (symbols.variables.has(memberName)) { return { kind: 'variable', info: symbols.variables.get(memberName) }; }
  if (symbols.constants.has(memberName)) { return { kind: 'constant', info: symbols.constants.get(memberName) }; }
  if (symbols.enums.has(memberName)) { return { kind: 'enum', info: symbols.enums.get(memberName) }; }
  return null;
}

/**
 * Build the hover shown for an autoload member (`Global.apply_tint`,
 * `Global.max_hp`, `Global.State`, ...) - its signature as the title,
 * followed by its GDScript `##` documentation comment, if any. An enum
 * additionally lists each of its values with their own docs.
 *
 * @param {string} globalName
 * @param {string} memberName
 * @param {GdScriptSymbols} symbols
 * @returns {vscode.MarkdownString | null} null if no such member exists
 */
function createAutoloadMemberDocumentation(globalName, memberName, symbols) {
  const member = findAutoloadMember(symbols, memberName);
  if (!member) { return null; }
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(formatAutoloadMemberSignature(globalName, memberName, member.kind, member.info), 'gdscript');
  markdown.appendMarkdown(member.info.doc || NO_GD_DOC_MESSAGE);
  if (member.kind === 'enum' && member.info.values.length > 0) {
    markdown.appendMarkdown('\n\n**Values:**\n\n');
    for (const value of member.info.values) {
      markdown.appendMarkdown(`- \`${value.name}\` = \`${value.value}\`${value.doc ? ': ' + value.doc : ''}\n`);
    }
  }
  return markdown;
}

/**
 * Build the hover shown for a named enum's value, e.g. `Global.State.IDLE`.
 *
 * @param {string} globalName
 * @param {string} enumName
 * @param {GdEnumValueInfo} valueInfo
 * @returns {vscode.MarkdownString}
 */
function createEnumValueDocumentation(globalName, enumName, valueInfo) {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(`${globalName}.${enumName}.${valueInfo.name} = ${valueInfo.value}`, 'gdscript');
  markdown.appendMarkdown(valueInfo.doc || NO_GD_DOC_MESSAGE);
  return markdown;
}

/**
 * Build the hover shown for an autoload name itself, e.g. `Global` in
 * `do Global.foo()`: where it's declared (script, and scene for an
 * autoload node), the script's own `##` class documentation, and a count
 * of what it exposes.
 *
 * @param {string} globalName
 * @param {GdScriptSymbols & {scriptPath: string, scenePath: string|null}} symbols
 * @returns {vscode.MarkdownString}
 */
function createAutoloadDocumentation(globalName, symbols) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${globalName}** _(${symbols.scenePath ? 'autoload node' : 'autoload script'})_\n\n`);
  if (symbols.scenePath) {
    markdown.appendMarkdown(`Scene: \`${symbols.scenePath}\`\n\n`);
  }
  markdown.appendMarkdown(`Script: \`${symbols.scriptPath}\`\n\n`);
  if (symbols.doc) {
    markdown.appendMarkdown(`${symbols.doc}\n\n`);
  }
  const counts = [
    [symbols.functions.size, 'function'],
    [symbols.variables.size, 'variable'],
    [symbols.constants.size, 'constant'],
    [symbols.enums.size, 'enum'],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}${count > 1 ? 's' : ''}`);
  if (counts.length > 0) {
    markdown.appendMarkdown(`_${counts.join(', ')}_`);
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
 * Parse a LayeredPortrait `.tscn` scene into node path (relative to the
 * scene root, the same shape `extra_data="set ..."` uses, e.g.
 * "Head/LeftEye") -> that node's type and `editor_description` - the
 * "Editor Description" field of the node's inspector, which is where a
 * layer can be documented from inside Godot. The root node itself is
 * skipped, same as in parseTscnNodeTree.
 *
 * @param {string} text - raw .tscn file content
 * @returns {Map<string, {type: string|null, description: string|null}>}
 */
function parseTscnNodeInfo(text) {
  const nodes = new Map();
  const headerPattern = /\[node\b([^\]]*)\]/g;
  let match;
  while ((match = headerPattern.exec(text)) !== null) {
    const attributes = match[1];
    const nameMatch = attributes.match(/\bname="([^"]+)"/);
    const parentMatch = attributes.match(/\bparent="([^"]*)"/);
    if (!nameMatch || !parentMatch) { continue; } // the scene root has no parent=
    const typeMatch = attributes.match(/\btype="([^"]+)"/);
    const bodyEnd = text.indexOf('\n[', headerPattern.lastIndex);
    const body = text.slice(headerPattern.lastIndex, bodyEnd === -1 ? text.length : bodyEnd);
    const descriptionMatch = body.match(/^editor_description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
    nodes.set(childNodePath(parentMatch[1], nameMatch[1]), {
      type: typeMatch ? typeMatch[1] : null,
      description: descriptionMatch ? descriptionMatch[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1') : null,
    });
  }
  return nodes;
}

/** The project refresh running, if any. @type {Promise<void> | null} */
let projectRefresh = null;
/** A refresh was asked for while one was running. */
let projectRefreshPending = false;

/**
 * Re-read the Godot project (see readProjectGodotData). Refreshes never
 * overlap: one asked for while another runs (several file watchers firing
 * at once, a quick fix saving files...) runs once right after it, so the
 * caches always end up from a single, complete read.
 *
 * @returns {Promise<void>} resolves once the project is up to date
 */
function refreshProjectGodotData() {
  if (projectRefresh) {
    projectRefreshPending = true;
    return projectRefresh;
  }
  projectRefresh = (async () => {
    try {
      do {
        projectRefreshPending = false;
        await readProjectGodotData();
      } while (projectRefreshPending);
    } finally {
      projectRefresh = null;
    }
  })();
  return projectRefresh;
}

/**
 * Re-read project.godot and everything it points to (characters, timelines,
 * autoloads, glossaries, translations, custom events...), then re-check
 * every open document. Use refreshProjectGodotData, which never runs two
 * of these at once.
 */
async function readProjectGodotData() {
  const matches = await vscode.workspace.findFiles('**/project.godot', '**/.godot/**', 1);
  if (matches.length === 0) {
    cachedCharacterNames = [];
    cachedAudioChannels = [];
    cachedCharacterMoods = new Map();
    cachedVariablesTree = new Map();
    cachedCharacterInfo = new Map();
    cachedAutoloadSymbols = new Map();
    cachedAutoloadNames = new Set();
    cachedPortraitDetails = new Map();
    cachedTimelinePaths = new Map();
    cachedTimelineLabels = new Map();
    cachedTimelineLines = new Map();
    cachedScriptStrings = new Set();
    await refreshCustomEvents('');
    cachedGlossaryEntries = [];
    cachedGlossaryFiles = [];
    glossaryPatternsKey = null;
    declaredProjectData = { characters: false, variables: false, timelines: false };
    projectRootUri = null;
    cachedResourcePaths = [];
    refreshAllDiagnostics();
    return;
  }
  projectRootUri = vscode.Uri.joinPath(matches[0], '..');
  let dialogicSection = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(matches[0]);
    const text = Buffer.from(bytes).toString('utf8');
    cachedCharacterNames = extractCharacterNames(text);
    cachedAudioChannels = extractAudioChannels(text);
    cachedVariablesTree = extractVariablesTree(text);
    dialogicSection = (text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/) || [])[1] || '';
    declaredProjectData = {
      characters: /directories\/dch_directory\s*=/.test(dialogicSection),
      variables: /(?:^|\n)variables\s*=/.test(dialogicSection),
      timelines: /directories\/dtl_directory\s*=/.test(dialogicSection),
    };
    cachedTimelinePaths = extractDialogicDirectory(text, 'dtl');
    await refreshGlossaries(dialogicSection);
    const originalLocaleMatch = dialogicSection.match(/(?:^|\n)translation\/original_locale\s*=\s*"([^"]*)"/);
    translationOriginalLocale = originalLocaleMatch ? originalLocaleMatch[1] : null;
    await refreshTimelineLabels();
    cachedCharacterPaths = extractCharacterPaths(text);
    await refreshCharacterMoods(cachedCharacterPaths);
    const autoloadPaths = extractAutoloadPaths(text);
    cachedAutoloadNames = new Set(autoloadPaths.keys());
    await refreshAutoloadSymbols(autoloadPaths);
  } catch (error) {
    console.error('DTL Reader: could not read project.godot', error);
    cachedCharacterNames = [];
    cachedAudioChannels = [];
    cachedCharacterMoods = new Map();
    cachedVariablesTree = new Map();
    cachedCharacterInfo = new Map();
    cachedAutoloadSymbols = new Map();
    cachedAutoloadNames = new Set();
    cachedPortraitDetails = new Map();
    cachedTimelinePaths = new Map();
    cachedTimelineLabels = new Map();
    declaredProjectData = { characters: false, variables: false, timelines: false };
  }
  await refreshResourcePaths();
  await refreshScriptStrings();
  await refreshCustomEvents(dialogicSection);
  await refreshTranslations();
  refreshAllDiagnostics();
  if (bbcodeCharDecorationType) { scheduleBbcodePreview(); } // glossary colors may have changed
  if (translationDecorationType) { updateTranslationGlobeContext(); } // the glossary list may have changed
}

/**
 * For every declared autoload (project.godot's `[autoload]` section), read
 * its script and parse its public top-level symbols (see parseGdScript),
 * so `do`/`if`/`elif` and `{...}` can autocomplete `Name.member` with
 * hover-ready documentation, without touching disk on every keystroke.
 * An autoload pointing at a `.tscn` scene (an "autoload node") uses the
 * scene root's script instead (see extractSceneRootScriptPath). Addon
 * autoloads are skipped unless `dtlReader.includeAddonAutoloads` is on.
 * An autoload whose script is missing or unreadable is simply left out
 * rather than failing the whole refresh.
 *
 * @param {Map<string, string>} autoloadPaths - name -> res:// script or scene path
 */
async function refreshAutoloadSymbols(autoloadPaths) {
  const includeAddons = vscode.workspace.getConfiguration('dtlReader').get('includeAddonAutoloads', false);
  const symbolsByGlobal = new Map();
  for (const [name, path] of autoloadPaths) {
    if (!includeAddons && /^res:\/\/addons\//i.test(path)) { continue; }
    try {
      let scriptPath = path;
      let scenePath = null;
      if (path.toLowerCase().endsWith('.tscn')) {
        const sceneBytes = await vscode.workspace.fs.readFile(resolveResourcePath(path));
        scenePath = path;
        scriptPath = extractSceneRootScriptPath(Buffer.from(sceneBytes).toString('utf8'));
        if (!scriptPath) { continue; } // root node has no (external) script - nothing to expose
      }
      if (!scriptPath.toLowerCase().endsWith('.gd')) { continue; } // e.g. a binary .scn, or a C# script
      const bytes = await vscode.workspace.fs.readFile(resolveResourcePath(scriptPath));
      symbolsByGlobal.set(name, { ...parseGdScript(Buffer.from(bytes).toString('utf8')), scriptPath, scenePath });
    } catch (error) {
      console.error(`DTL Reader: autoload "${name}" declares "${path}" but it (or its root script) could not be read - its members will be unavailable for do/if/elif and {...} autocomplete.`, error);
    }
  }
  cachedAutoloadSymbols = symbolsByGlobal;
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
  const detailsByCharacter = new Map();
  const soundMoodsByCharacter = new Map();
  for (const [name, dchPath] of characterPaths) {
    try {
      const dchBytes = await vscode.workspace.fs.readFile(resolveResourcePath(dchPath));
      const dchText = Buffer.from(dchBytes).toString('utf8');
      const portraits = parseDchPortraits(dchText);
      infoByCharacter.set(name, parseDchCharacterInfo(dchText));
      soundMoodsByCharacter.set(name, parseDchSoundMoods(dchText));

      const moods = new Map();
      const details = new Map();
      for (const [moodName, portrait] of portraits) {
        details.set(moodName, { ...portrait, nodes: null });
        if (!portrait.scene) {
          moods.set(moodName, null);
          continue;
        }
        try {
          const tscnBytes = await vscode.workspace.fs.readFile(resolveResourcePath(portrait.scene));
          const tscnText = Buffer.from(tscnBytes).toString('utf8');
          moods.set(moodName, parseTscnNodeTree(tscnText));
          details.get(moodName).nodes = parseTscnNodeInfo(tscnText);
        } catch (error) {
          console.error(`DTL Reader: mood "${moodName}" for "${name}" declares scene "${portrait.scene}" but it could not be read - extra_data node-path autocomplete will be unavailable for this mood.`, error);
          moods.set(moodName, null); // scene referenced but unreadable - mood name still valid
        }
      }
      moodsByCharacter.set(name, moods);
      detailsByCharacter.set(name, details);
    } catch (error) {
      console.error(`DTL Reader: character "${name}" declares .dch path "${dchPath}" but it could not be read or parsed - no mood data or hover documentation for this character.`, error);
    }
  }
  cachedCharacterMoods = moodsByCharacter;
  cachedCharacterInfo = infoByCharacter;
  cachedPortraitDetails = detailsByCharacter;
  cachedCharacterSoundMoods = soundMoodsByCharacter;
}

/**
 * Godot's own sidecar metadata files - `.import` (import settings next to
 * every imported asset) and `.uid` (Godot 4.4+ resource UIDs next to every
 * script/shader) - which are never valid targets for a `res://` path in a
 * timeline, and would otherwise double or triple the path suggestions.
 *
 * @type {RegExp}
 */
const GODOT_METADATA_FILE_PATTERN = /\.(?:import|uid)$/i;

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
      .filter(fsPath => !GODOT_METADATA_FILE_PATTERN.test(fsPath))
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
  if (entry.docsUrl) {
    markdown.appendMarkdown(`[${entry.docsLabel || 'Godot documentation'}](${entry.docsUrl})`);
  }
  return markdown;
}
// =============================================================================
// COMPLETION ITEM HELPERS
// =============================================================================

/**
 * Shorten an entry's description to its first sentence (at most ~60
 * characters, Markdown backticks and {placeholders} stripped), for use as
 * a completion label's `description`. VS Code shows that on the same row
 * as the suggestion itself, so what a command or BBCode tag does is
 * visible while scrolling the list - without having to open the details
 * side panel (Ctrl+Space), which still shows the full documentation.
 *
 * @param {string} description
 * @returns {string}
 */
function summarizeDescription(description) {
  const plain = description.replace(/`/g, '').replace(/\{(\w+)\}/g, '$1');
  const firstSentence = plain.match(/^.*?[.!?](?=\s|$)/);
  const summary = firstSentence ? firstSentence[0] : plain;
  return summary.length > 60 ? summary.slice(0, 57).trimEnd() + '...' : summary;
}
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
  const item = new vscode.CompletionItem({ label: entry.name, description: summarizeDescription(entry.description) }, vscode.CompletionItemKind.Event);
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
  const written = formatCharacterName(name);
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
 * Normalize a filesystem path for comparison (Windows paths are
 * case-insensitive and may use either slash).
 *
 * @param {string} fsPath
 * @returns {string}
 */
function normalizeFsPath(fsPath) {
  return fsPath.replace(/\\/g, '/').toLowerCase();
}

/**
 * The Dialogic timeline identifier of a document (its key in
 * project.godot's `directories/dtl_directory`), if it's a registered
 * timeline.
 *
 * @param {vscode.TextDocument} document
 * @returns {string | null}
 */
function findTimelineIdentifier(document) {
  if (!projectRootUri) { return null; }
  const documentPath = normalizeFsPath(document.uri.fsPath || '');
  for (const [identifier, resPath] of cachedTimelinePaths) {
    if (normalizeFsPath(resolveResourcePath(resPath).fsPath) === documentPath) { return identifier; }
  }
  return null;
}

/**
 * Labels of a timeline, by identifier - read live from its editor if it's
 * open (so unsaved edits count), else from cachedTimelineLabels.
 *
 * @param {string} identifier
 * @returns {Map<string, DtlLabelInfo> | null} null if the timeline is unknown
 */
function getTimelineLabels(identifier) {
  const resPath = cachedTimelinePaths.get(identifier);
  if (!resPath) { return null; }
  const timelinePath = normalizeFsPath(resolveResourcePath(resPath).fsPath);
  const openDocument = vscode.workspace.textDocuments.find(document => document.uri && document.uri.fsPath && normalizeFsPath(document.uri.fsPath) === timelinePath);
  if (openDocument) { return collectDocumentLabels(openDocument); }
  return cachedTimelineLabels.get(identifier) || new Map();
}

/**
 * Resolve a parsed jump to the labels it targets: this document's own,
 * or another registered timeline's.
 *
 * @param {vscode.TextDocument} document
 * @param {ReturnType<typeof parseJumpLine>} jump
 * @returns {{labels: Map<string, DtlLabelInfo>, uri: vscode.Uri, timeline: string|null} | null}
 */
function resolveJumpTarget(document, jump) {
  if (jump.timeline === null) {
    return { labels: collectDocumentLabels(document), uri: document.uri, timeline: null };
  }
  const labels = getTimelineLabels(jump.timeline);
  if (!labels) { return null; }
  return { labels, uri: resolveResourcePath(cachedTimelinePaths.get(jump.timeline)), timeline: jump.timeline };
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
 * Flag `jump` targets that don't exist. Dialogic doesn't stop on these:
 * it prints "[Dialogic] Label '...' not found for jump" and simply goes
 * on with the next event, so the jump silently never happens - hence an
 * Error, not a Warning.
 * - `jump label` must match a label of this timeline;
 * - `jump Timeline/label` (or `jump Timeline/`) must name a timeline of
 *   project.godot's `directories/dtl_directory`, and the label must exist
 *   there - only checked when project.godot declares that directory;
 * - a target containing `{...}` is resolved from a variable at runtime,
 *   so it's never flagged.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnresolvedJumpDiagnostics(document) {
  const localLabels = collectDocumentLabels(document);
  const diagnostics = [];
  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.lineAt(line).text;
    const jump = parseJumpLine(lineText);
    if (!jump) { continue; }
    if (jump.translationIdStart !== -1) {
      pushDiagnostic(diagnostics, 'jumpTranslationId',
        new vscode.Range(line, jump.translationIdStart, line, lineText.trimEnd().length),
        `A jump can't have a translation id: Dialogic would look for a label named "${lineText.slice(jump.labelStart).trim()}". Remove the #id part.`);
    }
    if (jump.target.includes('{')) { continue; }
    if (jump.timeline === null) {
      if (!localLabels.has(jump.label)) {
        pushDiagnostic(diagnostics, 'unresolvedJump',
          new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length),
          `No "label ${jump.label}" in this timeline - Dialogic will print an error and skip this jump.`);
      }
      continue;
    }
    if (!projectRootUri || !declaredProjectData.timelines) { continue; }
    const labels = getTimelineLabels(jump.timeline);
    if (!labels) {
      pushDiagnostic(diagnostics, 'unresolvedJump',
        new vscode.Range(line, jump.targetStart, line, jump.targetStart + jump.timeline.length),
        `No timeline "${jump.timeline}" in this project (project.godot's directories/dtl_directory).`);
    } else if (jump.label && !labels.has(jump.label)) {
      pushDiagnostic(diagnostics, 'unresolvedJump',
        new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length),
        `No "label ${jump.label}" in the timeline "${jump.timeline}" - Dialogic will print an error and skip this jump.`);
    }
  }
  return diagnostics;
}

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
  if (labelInfo) { item.documentation = createLabelDocumentation(name, labelInfo, timeline); }
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
  item.detail = `Dialogic timeline - ${cachedTimelinePaths.get(identifier)}`;
  item.documentation = new vscode.MarkdownString(`Jump to another timeline: \`${identifier}/\` starts it from the beginning, \`${identifier}/label\` from one of its labels.`);
  item.range = range;
  item.sortText = `1_${identifier}`;
  item.command = { command: 'editor.action.triggerSuggest', title: 'Show the timeline labels' };
  return item;
}

/**
 * Build the hover shown for a label, on either its `label NAME`
 * declaration or a `jump` pointing at it.
 *
 * @param {string} name
 * @param {DtlLabelInfo} labelInfo
 * @param {string|null} [timeline] - the timeline it belongs to, if not the hovered one
 * @returns {vscode.MarkdownString}
 */
function createLabelDocumentation(name, labelInfo, timeline) {
  const markdown = new vscode.MarkdownString();
  const where = timeline ? `${timeline}, line ${labelInfo.line + 1}` : `line ${labelInfo.line + 1}`;
  markdown.appendMarkdown(`**label ${name}**${labelInfo.displayName ? ` - ${labelInfo.displayName}` : ''} _(${where})_\n\n`);
  markdown.appendMarkdown(labelInfo.doc || '_No `##` comment above this label. Write one or more `## ...` lines right above it to document it._');
  return markdown;
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
  'if', 'else', 'elif', 'set', 'label', 'jump', 'join', 'update', 'leave', 'audio', 'do', 'return'
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
  const moods = completionCharacterMoods(character);
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
  const layeredMood = findLayeredMoodForLine(lineText);
  return layeredMood ? cachedCharacterMoods.get(layeredMood.character).get(layeredMood.mood) : null;
}

/**
 * Same resolution as findMoodTreeForLine, but returning which character
 * and mood were picked - needed to also look up that mood's
 * cachedPortraitDetails (node types/descriptions) for the hover.
 *
 * @param {string} lineText
 * @returns {{character: string, mood: string} | null}
 */
function findLayeredMoodForLine(lineText) {
  const commandMatch = lineText.match(new RegExp(`^\\s*(?:join|update)\\s+(${CHARACTER_NAME_SOURCE})`, 'u'));
  if (!commandMatch) { return null; }
  const character = stripCharacterNameQuotes(commandMatch[1]);
  const moods = cachedCharacterMoods.get(character);
  if (!moods) { return null; }

  const moodTagMatch = lineText.match(new RegExp(`^\\s*(?:join|update)\\s+${CHARACTER_NAME_SOURCE}\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\)`, 'u'));
  if (moodTagMatch && moods.get(moodTagMatch[1])) {
    return { character, mood: moodTagMatch[1] };
  }
  // No usable mood tag typed yet - fall back to whichever portrait does
  // have a scene, since that's the only one extra_data's node path could
  // possibly refer to.
  for (const [mood, tree] of moods) {
    if (tree) { return { character, mood }; }
  }
  return null;
}

/**
 * Find the `(mood)` tag under the cursor - after a dialogue speaker
 * (`John (happy):`) or join/update's character (`join John (happy)`).
 *
 * @param {string} line
 * @param {number} character - cursor column
 * @returns {{characterName: string, mood: string, range: {start: number, end: number}} | null}
 */
function findMoodTagAtPosition(line, character) {
  const tagMatch = line.match(new RegExp(`^(\\s*(?:(?:join|update)\\s+)?(${CHARACTER_NAME_SOURCE})\\s*\\()([\\p{L}_][\\p{L}0-9_]*)\\)`, 'u'));
  if (!tagMatch) { return null; }
  const characterName = stripCharacterNameQuotes(tagMatch[2]);
  if (RESERVED_LINE_KEYWORDS.has(characterName)) { return null; }
  const start = tagMatch[1].length;
  const end = start + tagMatch[3].length;
  if (character < start || character > end) { return null; }
  return { characterName, mood: tagMatch[3], range: { start, end } };
}

/**
 * Build the hover shown for a mood/portrait tag: which character it
 * belongs to, whether it's their default portrait, what it displays (a
 * LayeredPortrait/custom scene with its top-level layers, or a single
 * image), and any non-default mirror/offset/scale - plus every other mood
 * that character has, for reference.
 *
 * @param {string} characterName
 * @param {string} mood
 * @returns {vscode.MarkdownString | null} null if the character is unknown
 */
function createMoodDocumentation(characterName, mood) {
  const details = cachedPortraitDetails.get(characterName);
  if (!details) { return null; }
  const info = cachedCharacterInfo.get(characterName) || {};
  const portrait = details.get(mood);
  const markdown = new vscode.MarkdownString();
  const displayName = info.displayName || characterName;
  if (!portrait) {
    markdown.appendMarkdown(`**${mood}** _(unknown mood of ${displayName})_\n\n`);
  } else {
    const isDefault = info.defaultPortrait === mood;
    const kind = portrait.scene ? (portrait.nodes && portrait.nodes.size > 0 ? 'LayeredPortrait' : 'custom scene portrait') : 'portrait';
    markdown.appendMarkdown(`**${mood}** _(${kind} of ${displayName}${isDefault ? ', default' : ''})_\n\n`);
    if (portrait.scene) { markdown.appendMarkdown(`Scene: \`${portrait.scene}\`\n\n`); }
    if (portrait.image) { markdown.appendMarkdown(`Image: \`${portrait.image}\`\n\n`); }
    const tweaks = [];
    if (portrait.mirror) { tweaks.push('mirrored'); }
    if (portrait.scale && Number(portrait.scale) !== 1) { tweaks.push(`scale ${portrait.scale}`); }
    if (portrait.offset && !/^Vector2i?\(\s*0(?:\.0)?\s*,\s*0(?:\.0)?\s*\)$/.test(portrait.offset)) { tweaks.push(`offset ${portrait.offset}`); }
    if (tweaks.length > 0) { markdown.appendMarkdown(`_${tweaks.join(', ')}_\n\n`); }
    const tree = (cachedCharacterMoods.get(characterName) || new Map()).get(mood);
    const layers = tree ? tree.get('.') || [] : [];
    if (layers.length > 0) {
      markdown.appendMarkdown(`**Layers** (for \`extra_data="set ..."\`): ${layers.map(layer => `\`${layer}\``).join(', ')}\n\n`);
    }
  }
  const otherMoods = [...details.keys()].filter(name => name !== mood);
  if (otherMoods.length > 0) {
    markdown.appendMarkdown(`Other moods: ${otherMoods.map(name => `\`${name}\``).join(', ')}`);
  }
  return markdown;
}

/**
 * Find the LayeredPortrait layer under the cursor inside an
 * `extra_data="set Head/LeftEye"` value, and document it: its full path,
 * node type, the `editor_description` written for it in Godot, and its
 * child layers. Hovering `Head` documents `Head`, hovering `LeftEye`
 * documents `Head/LeftEye`.
 *
 * @param {string} line
 * @param {number} character - cursor column
 * @returns {{markdown: vscode.MarkdownString, range: {start: number, end: number}} | null}
 */
function findLayerDocumentationAtPosition(line, character) {
  const valueMatch = line.match(/\bextra_data\s*=\s*"set\s+([^"]*)"/);
  if (!valueMatch) { return null; }
  const valueStart = valueMatch.index + valueMatch[0].length - 1 - valueMatch[1].length;
  const segmentPattern = /[^/]+/g;
  const segments = [];
  let segmentMatch;
  while ((segmentMatch = segmentPattern.exec(valueMatch[1])) !== null) {
    segments.push(segmentMatch[0]);
    const start = valueStart + segmentMatch.index;
    const end = start + segmentMatch[0].length;
    if (character < start || character > end) { continue; }

    const layeredMood = findLayeredMoodForLine(line);
    if (!layeredMood) { return null; }
    const tree = cachedCharacterMoods.get(layeredMood.character).get(layeredMood.mood);
    const details = cachedPortraitDetails.get(layeredMood.character).get(layeredMood.mood);
    const path = segments.join('/');
    const node = details && details.nodes ? details.nodes.get(path) : null;
    const markdown = new vscode.MarkdownString();
    if (!node) {
      markdown.appendMarkdown(`**${path}** _(no such layer in ${layeredMood.character}'s "${layeredMood.mood}" portrait)_`);
      return { markdown, range: { start, end } };
    }
    markdown.appendMarkdown(`**${path}** _(${node.type ? node.type + ' ' : ''}layer of ${layeredMood.character}'s "${layeredMood.mood}" portrait)_\n\n`);
    markdown.appendMarkdown(node.description ? `${node.description}\n\n` : '_No Editor Description set on this node in Godot._\n\n');
    const children = tree ? tree.get(path) || [] : [];
    if (children.length > 0) {
      markdown.appendMarkdown(`Children: ${children.map(child => `\`${child}\``).join(', ')}`);
    }
    return { markdown, range: { start, end } };
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
  item.detail = hasChildren ? 'Dialogic variable group' : entry.value === null ? 'Variable used in this timeline' : `Dialogic variable - default: ${entry.value}`;
  if (hasChildren) {
    // Straight into the group: `chapter` -> `chapter.`, with its variables.
    item.insertText = `${name}.`;
    item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL child variables' };
  }
  return item;
}

/**
 * Build `{variable.path}` completions from cachedVariablesTree, walking
 * one path segment at a time - typing `variable.` lists `variable`'s
 * children, mirroring how extra_data's LayeredPortrait node paths work.
 *
 * Dialogic also resolves `{Autoload.property}` against autoloads, so the
 * top level lists autoload names too, and `{Global.` lists that
 * autoload's variables, constants and enums (not its functions - a `{...}`
 * block reads a value, it doesn't call anything). A Dialogic variable
 * group with the same name as an autoload wins, same as in Dialogic.
 *
 * @param {string} typedPath - text typed so far inside the currently open '{'
 * @returns {vscode.CompletionItem[]}
 */
function createVariableSuggestions(typedPath) {
  const lastDot = typedPath.lastIndexOf('.');
  const parentSegments = lastDot === -1 ? [] : typedPath.slice(0, lastDot).split('.');
  const prefix = (lastDot === -1 ? typedPath : typedPath.slice(lastDot + 1)).toLowerCase();

  const variablesTree = completionVariablesTree();
  if (parentSegments.length > 0 && !variablesTree.has(parentSegments[0])) {
    const symbols = cachedAutoloadSymbols.get(parentSegments[0]);
    if (!symbols) { return []; }
    if (parentSegments.length === 1) {
      return createAutoloadMemberSuggestions(parentSegments[0], symbols, prefix, { functions: false });
    }
    if (parentSegments.length === 2) {
      return createEnumValueSuggestions(symbols, parentSegments[1], prefix);
    }
    return [];
  }

  let level = variablesTree;
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
  if (parentSegments.length === 0) {
    for (const name of cachedAutoloadSymbols.keys()) {
      if (!variablesTree.has(name) && name.toLowerCase().startsWith(prefix)) {
        items.push(createGlobalNameCompletion(name));
      }
    }
  }
  return items;
}

// =============================================================================
// GLOBAL SCRIPT (AUTOLOAD) HELPERS
// =============================================================================

/**
 * Matches the start of a line up to where a GDScript-style expression
 * begins - i.e. where an autoload reference like `Global.foo()` or
 * `Global.State.IDLE` could meaningfully appear:
 * - after `do`, `if` or `elif` (group 1 is the keyword);
 * - after the assignment operator of `set {variable} = ` (also `+=`,
 *   `-=`, `*=`, `/=`), where group 1 is undefined.
 * Requires whitespace after the keyword (or the `=`, for set) so
 * still-typing the keyword itself (e.g. text ending in exactly "do") isn't
 * mistaken for an already-complete keyword with an empty expression.
 *
 * @type {RegExp}
 */
const EXPRESSION_START_PATTERN = /^\s*(?:(do|if|elif)\s+|set\s+\{[^}]*\}\s*[-+*/]?=\s*)/;

/**
 * True when `text` - either what's been typed so far on a line, or a full
 * line - has reached an expression (see EXPRESSION_START_PATTERN).
 *
 * @param {string} text
 * @returns {boolean}
 */
function isGlobalScriptExpressionLine(text) {
  return EXPRESSION_START_PATTERN.test(text);
}

/**
 * True when `text` ends inside a still-open `"..."` or `'...'` string
 * literal (escaped quotes are skipped), e.g. `Global.foo("intro`.
 *
 * @param {string} text
 * @returns {boolean}
 */
function endsInsideStringLiteral(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; }
      else if (ch === quote) { quote = null; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }
  return quote !== null;
}

/**
 * Completion item for an autoload name itself (before its `.`), e.g.
 * `Global` in `do Global.`. Inserts a trailing `.` and re-triggers
 * suggestions, so its members show up immediately.
 *
 * @param {string} name
 * @returns {vscode.CompletionItem}
 */
function createGlobalNameCompletion(name) {
  const symbols = cachedAutoloadSymbols.get(name);
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
  item.detail = symbols && symbols.scenePath ? 'Dialogic autoload node' : 'Dialogic autoload script';
  if (symbols) { item.documentation = createAutoloadDocumentation(name, symbols); }
  item.insertText = new vscode.SnippetString(`${name}.$0`);
  item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL autoload members' };
  return item;
}

/**
 * Completion item kind, sort group, and insert behavior for each kind of
 * autoload member. Functions sort first, since calling one is the most
 * common reason to reach into an autoload from a timeline.
 */
const AUTOLOAD_MEMBER_KINDS = {
  function: { itemKind: vscode.CompletionItemKind.Method, sortGroup: '0' },
  variable: { itemKind: vscode.CompletionItemKind.Field, sortGroup: '1' },
  constant: { itemKind: vscode.CompletionItemKind.Constant, sortGroup: '2' },
  enum: { itemKind: vscode.CompletionItemKind.Enum, sortGroup: '3' },
};

/**
 * Completion item for one member of an autoload (function, variable,
 * constant or enum). Its GDScript `##` doc comment (if any) becomes the
 * completion's own documentation, matching what the hover shows. A
 * function inserts `name(|)`; an enum inserts `Name.` and re-triggers so
 * its values show up next.
 *
 * @param {string} globalName
 * @param {string} name
 * @param {'function'|'variable'|'constant'|'enum'} kind
 * @param {object} info
 * @returns {vscode.CompletionItem}
 */
function createAutoloadMemberCompletion(globalName, name, kind, info) {
  const { itemKind, sortGroup } = AUTOLOAD_MEMBER_KINDS[kind];
  const item = new vscode.CompletionItem(name, itemKind);
  item.detail = formatAutoloadMemberSignature(globalName, name, kind, info);
  item.documentation = new vscode.MarkdownString(info.doc || NO_GD_DOC_MESSAGE);
  item.sortText = `${sortGroup}_${name}`;
  if (kind === 'function') {
    item.insertText = new vscode.SnippetString(`${name}($0)`);
  } else if (kind === 'enum') {
    item.insertText = new vscode.SnippetString(`${name}.$0`);
    item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL enum values' };
  }
  return item;
}

/**
 * Build completions for the members of one autoload, filtered by the
 * member-name prefix typed so far.
 *
 * @param {string} globalName
 * @param {GdScriptSymbols} symbols
 * @param {string} prefix - lowercase member-name prefix typed so far
 * @param {{functions?: boolean, values?: boolean}} [include] - which member
 *   groups to offer: `functions` (default true) and `values` - variables,
 *   constants and enums (default true)
 * @returns {vscode.CompletionItem[]}
 */
function createAutoloadMemberSuggestions(globalName, symbols, prefix, include = {}) {
  const { functions = true, values = true } = include;
  const groups = [];
  if (functions) { groups.push(['function', symbols.functions]); }
  if (values) { groups.push(['variable', symbols.variables], ['constant', symbols.constants], ['enum', symbols.enums]); }
  const items = [];
  for (const [kind, members] of groups) {
    for (const [name, info] of members) {
      if (name.toLowerCase().startsWith(prefix)) {
        items.push(createAutoloadMemberCompletion(globalName, name, kind, info));
      }
    }
  }
  return items;
}

/**
 * Build completions for a named enum's values, e.g. `IDLE` after
 * `Global.State.`.
 *
 * @param {GdScriptSymbols} symbols
 * @param {string} enumName
 * @param {string} prefix - lowercase value-name prefix typed so far
 * @returns {vscode.CompletionItem[]}
 */
function createEnumValueSuggestions(symbols, enumName, prefix) {
  const enumInfo = symbols.enums.get(enumName);
  if (!enumInfo) { return []; }
  return enumInfo.values
    .filter(value => value.name.toLowerCase().startsWith(prefix))
    .map(value => {
      const item = new vscode.CompletionItem(value.name, vscode.CompletionItemKind.EnumMember);
      item.detail = `${enumName}.${value.name} = ${value.value}`;
      if (value.doc) { item.documentation = new vscode.MarkdownString(value.doc); }
      return item;
    });
}

/**
 * Every Dialogic variable of project.godot as a full path ("chapter",
 * "variable.test"...), with its default value - folders are walked, only
 * values are listed.
 *
 * @returns {{path: string, value: string}[]}
 */
function collectVariableLeaves() {
  const leaves = [];
  const walk = (tree, prefix) => {
    for (const [name, entry] of tree) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (entry.children) { walk(entry.children, path); } else { leaves.push({ path, value: entry.value }); }
    }
  };
  walk(completionVariablesTree(), '');
  return leaves;
}

/** Operators, as Dialogic's conditions (Godot Expression) and set events accept them. */
const CONDITION_OPERATORS = [
  ['==', 'is equal to'], ['!=', 'is not equal to'], ['>', 'is greater than'], ['<', 'is less than'],
  ['>=', 'is greater than or equal to'], ['<=', 'is less than or equal to'],
  ['and', 'both conditions must be true'], ['or', 'at least one condition must be true'],
];
const ARITHMETIC_OPERATORS = [['+', 'plus (or joins two texts)'], ['-', 'minus'], ['*', 'times'], ['/', 'divided by'], ['%', 'remainder of the division']];
const SET_OPERATORS = [
  ['=', 'Set: the variable becomes the value.'], ['+=', 'Add the value to the variable.'], ['-=', 'Subtract the value from the variable.'],
  ['*=', 'Multiply the variable by the value.'], ['/=', 'Divide the variable by the value.'],
];

/**
 * Completion items for operators. Each inserts itself plus a space and
 * re-opens the suggestions, ready for the next operand.
 *
 * @param {[string, string][]} operators
 * @param {string} group - for sorting
 * @returns {vscode.CompletionItem[]}
 */
function createOperatorItems(operators, group) {
  return operators.map(([operator, doc], index) => {
    const item = new vscode.CompletionItem({ label: operator, description: doc }, /^[a-z]/.test(operator) ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Operator);
    item.insertText = `${operator} `;
    item.sortText = `${group}_${String(index).padStart(2, '0')}`;
    item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest the next value' };
    return item;
  });
}

/**
 * The `{}` suggestion where a variable can go (a set target, an if/elif
 * operand): it inserts the braces - around what was typed, if anything -
 * and reopens the suggestions inside them, where the variables are listed
 * folder by folder.
 *
 * @param {string} typed - the name typed so far
 * @param {vscode.Range} range - that name
 * @returns {vscode.CompletionItem}
 */
function createVariableBracesItem(typed, range) {
  const item = new vscode.CompletionItem({ label: '{}', description: 'a variable' }, vscode.CompletionItemKind.Variable);
  item.detail = 'Dialogic variable - {folder.variable}, or {Autoload.variable}';
  item.documentation = new vscode.MarkdownString('Inserts `{}` and suggests the variables inside it, folder by folder (`{chapter.` lists `chapter`\'s variables), then the autoloads\' variables.');
  item.insertText = new vscode.SnippetString(`{${typed.replace(/[$}\\]/g, '\\$&')}$0}`);
  item.filterText = typed || '{';
  item.range = range;
  item.sortText = '0_{}';
  item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest variables' };
  return item;
}

/**
 * Suggestions on a `set` line before its operator (see Dialogic's set
 * event: `set {variable} <operator> value`): `{}` and the autoloads
 * (inserted as `{Autoload.`) for the variable to set, then the operators
 * `=`, `+=`, `-=`, `*=`, `/=`.
 *
 * @param {string} beforeCursor
 * @param {vscode.Position} position
 * @returns {vscode.CompletionItem[] | null} null if not a set target
 */
function createSetTargetSuggestions(beforeCursor, position) {
  const setMatch = beforeCursor.match(/^\s*set\s+(.*)$/);
  if (!setMatch || isGlobalScriptExpressionLine(beforeCursor)) { return null; }
  const rest = setMatch[1];
  const targetMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (targetMatch) {
    // Only `{}` and the autoloads - the variables themselves come once
    // inside the braces, folder by folder, instead of all at once here.
    const typed = targetMatch[1] || '';
    const range = new vscode.Range(position.line, position.character - typed.length, position.line, position.character);
    const items = [createVariableBracesItem(typed, range)];
    for (const name of cachedAutoloadSymbols.keys()) {
      if (!name.toLowerCase().startsWith(typed.toLowerCase())) { continue; }
      // A set target is always a {variable}: {Autoload.variable}.
      const item = createGlobalNameCompletion(name);
      item.insertText = new vscode.SnippetString(`{${name}.$0}`);
      item.filterText = name;
      item.range = range;
      items.push(item);
    }
    return items;
  }
  if (/^\{[^}]*\}\s+$/.test(rest)) {
    return SET_OPERATORS.map(([operator, doc], index) => {
      const item = createOperatorItems([[operator, doc]], `0${index}`)[0];
      item.documentation = new vscode.MarkdownString(`${doc}\n\n\`set {variable} ${operator} value\``);
      return item;
    });
  }
  return null;
}

/**
 * Value suggestions after `set {variable} = `, from the variable's type:
 * true/false for a bool, a random number for a number, "" for a text.
 *
 * @param {string} beforeCursor
 * @returns {vscode.CompletionItem[]}
 */
function createSetValueItems(beforeCursor) {
  const targetMatch = beforeCursor.match(/^\s*set\s+\{([^}]*)\}/);
  if (!targetMatch) { return []; }
  const segments = targetMatch[1].split('.');
  let level = cachedVariablesTree;
  let entry = null;
  for (const segment of segments) { entry = level && level.get(segment); if (!entry) { break; } level = entry.children; }
  let type = entry && !entry.children ? inferGdValueType(entry.value) : null;
  if (!type && cachedAutoloadSymbols.has(segments[0]) && segments.length === 2) {
    const info = cachedAutoloadSymbols.get(segments[0]).variables.get(segments[1]);
    type = info ? (info.type || inferGdValueType(info.defaultValue || '')) : null;
  }
  const items = [];
  const add = (label, insert, doc, kind) => {
    const item = new vscode.CompletionItem({ label, description: doc }, kind);
    item.insertText = insert;
    item.sortText = `0_${label}`;
    items.push(item);
  };
  if (type === 'bool') {
    add('true', 'true', 'bool', vscode.CompletionItemKind.Keyword);
    add('false', 'false', 'bool', vscode.CompletionItemKind.Keyword);
  } else if (type === 'int' || type === 'float') {
    add('random number', new vscode.SnippetString('range(${1:1}, ${2:10}).pick_random()'), 'Dialogic\'s random number: range(min, max).pick_random()', vscode.CompletionItemKind.Snippet);
  } else if (type === 'String') {
    add('"text"', new vscode.SnippetString('"$1"'), 'a text value', vscode.CompletionItemKind.Snippet);
  }
  return items;
}

/**
 * Build completions for an expression - after `do`/`if`/`elif`,
 * or on the right-hand side of `set {variable} = ...` (see
 * EXPRESSION_START_PATTERN): either autoload names, a specific autoload's
 * members (once `Name.` has been typed), or a named enum's values (once
 * `Name.Enum.` has been typed), e.g.
 * `set {VnLibrary.current_vn_time} = VnLibrary.TimeId.CHAP2_R1`.
 *
 * Kept deliberately narrow, so the list only opens where an autoload
 * reference can actually go:
 * - never inside a string literal, e.g. `Global.foo("intro`;
 * - `do` only runs a method, so it offers autoload names only as its
 *   first token, and only functions as members;
 * - `if`/`elif` conditions and `set` values can use anything, so
 *   they offer every member - but a bare name list is only popped open by
 *   a trigger character (space, `=`, ...) right after the keyword/`=` or after
 *   `and`/`or`/`not`, not after every space in the expression; typing a
 *   letter still suggests matching names anywhere.
 *
 * @param {string} beforeCursor
 * @param {string|null} triggerCharacter - the character that auto-opened
 *   the suggest widget, or null if the person typed a word / asked
 *   explicitly (Ctrl+Space)
 * @returns {vscode.CompletionItem[]}
 */
function createGlobalScriptSuggestions(beforeCursor, triggerCharacter) {
  const keywordMatch = beforeCursor.match(EXPRESSION_START_PATTERN);
  if (!keywordMatch) { return []; }
  const isDo = keywordMatch[1] === 'do';
  const expression = beforeCursor.slice(keywordMatch[0].length);
  if (endsInsideStringLiteral(expression)) { return []; }

  const memberMatch = expression.match(/([A-Za-z_][A-Za-z0-9_]*)\.(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (memberMatch) {
    const [, globalName, enumName, typedMember] = memberMatch;
    const symbols = cachedAutoloadSymbols.get(globalName);
    if (!symbols) { return []; }
    const prefix = (typedMember || '').toLowerCase();
    if (enumName) {
      return isDo ? [] : createEnumValueSuggestions(symbols, enumName, prefix);
    }
    return createAutoloadMemberSuggestions(globalName, symbols, prefix, { values: !isDo });
  }

  if (isDo && !/^[A-Za-z_][A-Za-z0-9_]*$|^$/.test(expression)) { return []; }
  const isSet = keywordMatch[1] === undefined;

  // Right after a complete value ({variable}, number, text, true/false,
  // a call...): what can follow it - comparisons and and/or in a
  // condition, arithmetic in a set value.
  const afterOperand = !isDo && /(?:\}|\)|\]|\d|"|'|\btrue|\bfalse|[A-Za-z_][A-Za-z0-9_]*)\s+$/.test(expression)
    && !/(?:\b(?:and|or|not|in)|[=!<>+\-*/%(,&|])\s*$/.test(expression);
  if (afterOperand) {
    return isSet ? createOperatorItems(ARITHMETIC_OPERATORS, '0') : createOperatorItems(CONDITION_OPERATORS, '0');
  }

  const nameMatch = expression.match(/(?:^|[\s(=!<>+\-*/%,&|])([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (!nameMatch) { return []; }
  const typedName = nameMatch[1] || '';
  if (triggerCharacter && typedName === '') {
    const beforeName = expression.trimEnd();
    // Pop the list open only where a value is expected: the start, after
    // and/or/not, an operator, "(" or ",".
    if (beforeName !== '' && !/(?:\b(?:and|or|not|in)|&&|\|\||[!=<>+\-*/%(,])$/.test(beforeName)) { return []; }
  }
  const prefix = typedName.toLowerCase();
  const items = [];
  for (const name of cachedAutoloadSymbols.keys()) {
    if (name.toLowerCase().startsWith(prefix)) {
      items.push(createGlobalNameCompletion(name));
    }
  }
  if (isDo) { return items; }
  // One `{}` rather than every variable: inside the braces, the variables
  // are suggested folder by folder.
  const cursor = beforeCursor.length;
  items.push(createVariableBracesItem(typedName, new vscode.Range(0, cursor - typedName.length, 0, cursor)));
  if (isSet && expression.trim() === '') { items.push(...createSetValueItems(beforeCursor)); }
  for (const [keyword, doc] of [['not', 'negates the condition after it'], ['true', 'bool'], ['false', 'bool']]) {
    if (keyword.startsWith(prefix) && (keyword !== 'not' || !isSet)) {
      const item = new vscode.CompletionItem({ label: keyword, description: doc }, vscode.CompletionItemKind.Keyword);
      item.sortText = `4_${keyword}`;
      items.push(item);
    }
  }
  // true/false can come both from the set target's type and as keywords.
  const seen = new Set();
  return items.filter(item => {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    if (seen.has(label)) { return false; }
    seen.add(label);
    return true;
  });
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
  return /^\s*-\s/.test(textBeforeBracket) || isInsideDialogueText(textBeforeBracket);
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
  const item = new vscode.CompletionItem({ label: entry.name, description: summarizeDescription(entry.description) }, vscode.CompletionItemKind.Keyword);
  item.detail = `Godot BBCode - ${entry.syntax}`;
  item.documentation = createDocumentation(entry);
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
    if (RESERVED_BRACKET_NAMES.has(name) || SELF_CLOSING_BBCODE_NAMES.has(name) || TEXT_EFFECT_NAMES.has(name)) { continue; }
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
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!isPlayerFacingTextLine(text)) {
      continue;
    }
    // One whole-line warning per line is enough, even if several tags are broken.
    const tagName = findUnclosedTag(text);
    if (tagName) {
      pushDiagnostic(diagnostics, 'unclosedBBCode',
        new vscode.Range(line, 0, line, text.length),
        `"[${tagName}]" has no matching "[/${tagName}]" on this line - the balise is unclosed.`);
    }
  }
  return diagnostics;
}

/**
 * Default severity of every diagnostic check, by its setting name
 * (`dtlReader.diagnostics.<check>`). Each can be changed to "error",
 * "warning", "information", "hint", or "off" to hide it.
 *
 * @type {Record<string, string>}
 */
const DIAGNOSTIC_DEFAULT_LEVELS = {
  unresolvedJump: 'error',
  jumpTranslationId: 'error',
  unclosedBBCode: 'warning',
  unknownCharacter: 'error',
  unknownSpeaker: 'warning',
  unknownMood: 'error',
  unknownVariable: 'error',
  missingTranslation: 'hint',
  dchDefaultPortrait: 'error',
  dchMissingScene: 'error',
  unreachableCode: 'hint',
  unreachableLabel: 'warning',
  unusedCharacter: 'hint',
  unusedPortrait: 'hint',
};

/** @type {Record<string, vscode.DiagnosticSeverity>} */
const DIAGNOSTIC_SEVERITY_BY_LEVEL = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/**
 * Add a diagnostic for `check` with the severity the person configured
 * for it (`dtlReader.diagnostics.<check>`), or nothing if it's "off". The
 * check name is set as the diagnostic's code, so the Problems view shows
 * which setting controls it.
 *
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {string} check - a key of DIAGNOSTIC_DEFAULT_LEVELS
 * @param {vscode.Range} range
 * @param {string} message
 * @returns {vscode.Diagnostic | undefined} the diagnostic added, if the check isn't "off"
 */
function pushDiagnostic(diagnostics, check, range, message) {
  const level = vscode.workspace.getConfiguration('dtlReader').get(`diagnostics.${check}`, DIAGNOSTIC_DEFAULT_LEVELS[check]);
  const severity = DIAGNOSTIC_SEVERITY_BY_LEVEL[level];
  if (severity === undefined) { return undefined; } // "off"
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = 'DTL Reader';
  diagnostic.code = check;
  diagnostics.push(diagnostic);
  return diagnostic;
}

/**
 * Report characters and moods that don't exist in the Godot project:
 * - `join`/`update`/`leave` naming a character missing from
 *   project.godot's `directories/dch_directory` (an Error - Dialogic can't
 *   run that event);
 * - a dialogue line whose speaker isn't a known character (a Warning -
 *   Dialogic then shows the whole line, "Name:" included, as narration);
 * - a `(mood)` that the character's `.dch` file doesn't declare.
 * Nothing is reported unless project.godot actually declares a character
 * list, so a timeline opened outside a Godot project stays quiet.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnknownCharacterDiagnostics(document) {
  if (!projectRootUri || !declaredProjectData.characters) { return []; }
  const knownCharacters = new Set(cachedCharacterNames);
  const diagnostics = [];
  const commandPattern = new RegExp(`^(\\s*(?:join|update|leave)\\s+)(${CHARACTER_NAME_SOURCE})(\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\))?`, 'u');
  const speakerPattern = new RegExp(`^(\\s*)(${CHARACTER_NAME_SOURCE})(\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\))?(?=\\s*:)`, 'u');
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const commandMatch = text.match(commandPattern);
    const speakerMatch = commandMatch ? null : text.match(speakerPattern);
    const match = commandMatch || speakerMatch;
    if (!match) { continue; }
    const name = stripCharacterNameQuotes(match[2]);
    if (speakerMatch && RESERVED_LINE_KEYWORDS.has(name)) { continue; }
    const nameStart = match[1].length;
    if (!knownCharacters.has(name)) {
      pushDiagnostic(diagnostics, commandMatch ? 'unknownCharacter' : 'unknownSpeaker',
        new vscode.Range(line, nameStart, line, nameStart + match[2].length),
        commandMatch
          ? `"${name}" is not a Dialogic character of this project (not in project.godot's directories/dch_directory).`
          : `"${name}" is not a Dialogic character of this project - Dialogic will show this whole line, "${name}:" included, as narration.`);
      continue;
    }
    const moods = cachedCharacterMoods.get(name);
    if (speakerMatch && moods && moods.size > 0) {
      const portraitPattern = /\[portrait=([^\]\s]+)\]/g;
      let portraitMatch;
      while ((portraitMatch = portraitPattern.exec(text)) !== null) {
        if (moods.has(portraitMatch[1])) { continue; }
        const start = portraitMatch.index + '[portrait='.length;
        pushDiagnostic(diagnostics, 'unknownMood', new vscode.Range(line, start, line, start + portraitMatch[1].length),
          `"${portraitMatch[1]}" is not a portrait of ${name}. Available: ${[...moods.keys()].join(', ')}.`);
      }
    }
    const mood = match[4];
    if (mood && moods && moods.size > 0 && !moods.has(mood)) {
      const moodStart = nameStart + match[2].length + match[3].indexOf(mood);
      pushDiagnostic(diagnostics, 'unknownMood',
        new vscode.Range(line, moodStart, line, moodStart + mood.length),
        `"${mood}" is not a portrait of ${name}. Available: ${[...moods.keys()].join(', ')}.`);
    }
  }
  return diagnostics;
}

/**
 * Report `{variable.path}` references that don't exist: neither a Dialogic
 * variable declared in project.godot's `variables={...}`, nor an autoload
 * (`{Global.hearts}`, checked member by member when its script is loaded).
 * Only plain dotted paths are checked - anything else inside braces (a
 * signal's `{"key": ...}` dictionary, an expression) is left alone - and
 * nothing is reported unless project.godot declares a variables list.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnknownVariableDiagnostics(document) {
  if (!projectRootUri || !declaredProjectData.variables) { return []; }
  const diagnostics = [];
  const blockPattern = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (/^\s*#/.test(text)) { continue; }
    blockPattern.lastIndex = 0;
    let match;
    while ((match = blockPattern.exec(text)) !== null) {
      const problem = describeUnknownVariablePath(match[1].split('.'));
      if (!problem) { continue; }
      const start = match.index + 1;
      pushDiagnostic(diagnostics, 'unknownVariable',
        new vscode.Range(line, start, line, start + match[1].length),
        problem);
    }
  }
  return diagnostics;
}

/**
 * Check one `{a.b.c}` path against the Dialogic variables tree and the
 * autoloads. Returns an explanation if it doesn't exist, or null if it
 * does (or can't be checked, e.g. an addon autoload whose script isn't
 * loaded).
 *
 * @param {string[]} segments
 * @returns {string | null}
 */
function describeUnknownVariablePath(segments) {
  const path = segments.join('.');
  if (cachedVariablesTree.has(segments[0])) {
    let level = cachedVariablesTree;
    for (let i = 0; i < segments.length; i++) {
      const entry = level && level.get(segments[i]);
      if (!entry) { return `"{${path}}" is not a Dialogic variable: "${segments.slice(0, i).join('.')}" has no "${segments[i]}".`; }
      level = entry.children;
    }
    return null;
  }
  if (cachedAutoloadNames.has(segments[0])) {
    const symbols = cachedAutoloadSymbols.get(segments[0]);
    if (!symbols || segments.length < 2) { return null; } // not loaded (addon) - can't check
    const member = findAutoloadMember(symbols, segments[1]);
    if (!member) { return `"${segments[1]}" is not a variable, constant or enum of the autoload ${segments[0]}.`; }
    if (member.kind === 'enum' && segments.length >= 3 && !member.info.values.some(value => value.name === segments[2])) {
      return `"${segments[2]}" is not a value of ${segments[0]}.${segments[1]}.`;
    }
    return null;
  }
  return `"{${path}}" is not a Dialogic variable of this project (not in project.godot's variables) nor an autoload.`;
}

/**
 * Re-run diagnostics for every open `.dtl` document - after project.godot
 * (or a character/script) changed, since that changes what's "unknown".
 */
function refreshAllDiagnostics() {
  if (!diagnosticCollection) { return; }
  vscode.workspace.textDocuments.forEach(updateDiagnostics);
}

/**
 * Re-scan a `.dtl` document for every diagnostic this extension knows how
 * to produce (unresolved jumps, unclosed balises, unknown characters,
 * moods and variables) and publish the merged result.
 *
 * @param {vscode.TextDocument} document
 */
function updateDiagnostics(document) {
  if (document.languageId === 'dch') {
    diagnosticCollection.set(document.uri, [...findDchDiagnostics(document), ...findUnusedCharacterDiagnostics(document)]);
    return;
  }
  if (document.languageId !== 'dtl') {
    return;
  }

  const diagnostics = [
    ...findUnresolvedJumpDiagnostics(document),
    ...findUnclosedBaliseDiagnostics(document),
    ...findUnknownCharacterDiagnostics(document),
    ...findUnknownVariableDiagnostics(document),
    ...findMissingTranslationDiagnostics(document),
    ...findUnreachableDiagnostics(document)
  ];

  diagnosticCollection.set(document.uri, diagnostics);
}

// =============================================================================
// OUTLINE (document symbols)
// =============================================================================

/**
 * The outline style (`dtlReader.outline.style`): "flow", "indentation" or
 * "dialogic". The older boolean `dtlReader.outline.showFlow` is still
 * honored when it was turned off and no style was chosen explicitly.
 *
 * @returns {'flow'|'indentation'|'dialogic'}
 */
function getOutlineStyle() {
  const config = vscode.workspace.getConfiguration('dtlReader');
  const styleSetting = config.inspect('outline.style');
  const styleSet = styleSetting && (styleSetting.globalValue !== undefined || styleSetting.workspaceValue !== undefined || styleSetting.workspaceFolderValue !== undefined);
  if (!styleSet && config.get('outline.showFlow', true) === false) { return 'dialogic'; }
  const style = config.get('outline.style', 'flow');
  return ['flow', 'indentation', 'dialogic'].includes(style) ? style : 'flow';
}

/**
 * Where a `jump` leads, relative to the jump itself, for the "flow" outline:
 * back up to an earlier label (a loop), forward to a later one, to another
 * timeline, or somewhere only known at runtime (`{variable}`).
 *
 * @param {string} target - the jump's target text
 * @param {number} line - the jump's line
 * @param {Map<string, DtlLabelInfo>} labels - this timeline's labels
 * @returns {string}
 */
function describeJumpDirection(target, line, labels) {
  if (target.includes('{')) { return '? runtime target'; }
  const jump = parseJumpLine(`jump ${target}`);
  if (!jump) { return ''; }
  if (jump.timeline !== null) { return `-> timeline ${jump.timeline}`; }
  const label = labels.get(jump.label);
  if (!label) { return '! missing label'; }
  return label.line < line ? `^ back to line ${label.line + 1}` : `v ahead to line ${label.line + 1}`;
}

/**
 * Build the outline of a timeline - what the Outline view, breadcrumbs,
 * sticky scroll and "Go to Symbol" (Ctrl+Shift+O) show - in one of three
 * styles (`dtlReader.outline.style`):
 *
 * - "flow" (default): the flow of time. One entry per `label`, as Dialogic
 *   organizes a timeline, each spanning until the next label, listing the
 *   timeline's branching nested by indentation - `if`/`elif`/`else`/
 *   blocks and choices - and the events that leave the current
 *   flow (`jump`, `return`, `[end_timeline]`), each jump saying where it
 *   leads (back, ahead, another timeline).
 * - "indentation": the timeline's structure by indentation only - labels,
 *   `if`/`elif`/`else` blocks and choices, each nested under the
 *   block it's indented in, and labels being plain entries rather than
 *   sections. No jumps.
 * - "dialogic": only the labels, like Dialogic's own timeline organization.
 *
 * Lines before the first label sit at the top level. Dialogue lines,
 * joins, etc. are always left out to keep it readable.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.DocumentSymbol[]}
 */
function provideTimelineOutline(document) {
  const style = getOutlineStyle();
  const showFlow = style !== 'dialogic';
  const labelsAreSections = style !== 'indentation';
  const showJumps = style === 'flow';
  const lines = documentLines(document);
  const labelDocs = collectLabelsFromLines(lines);
  const rootSymbols = [];
  let currentLabel = null;
  // Open flow blocks (if/elif/else/choice), innermost last.
  let openBlocks = [];
  let lastContentLine = 0;

  const lineRange = (line, start = 0) => new vscode.Range(line, start, line, lines[line].length);
  const closeBlocksFrom = indent => {
    while (openBlocks.length > 0 && openBlocks[openBlocks.length - 1].indent >= indent) {
      const block = openBlocks.pop();
      block.symbol.range = new vscode.Range(block.symbol.range.start, new vscode.Position(lastContentLine, lines[lastContentLine].length));
    }
  };
  const addSymbol = symbol => {
    const parent = openBlocks.length > 0 ? openBlocks[openBlocks.length - 1].symbol : currentLabel;
    (parent ? parent.children : rootSymbols).push(symbol);
  };
  const closeLabel = () => {
    if (!currentLabel) { return; }
    currentLabel.range = new vscode.Range(currentLabel.range.start, new vscode.Position(lastContentLine, lines[lastContentLine].length));
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { continue; }
    const indent = text.length - text.trimStart().length;
    closeBlocksFrom(indent);

    const label = parseLabelLine(text);
    if (label) {
      const info = labelDocs.get(label.name);
      const symbol = new vscode.DocumentSymbol(
        label.name,
        label.displayName || (info && info.doc ? info.doc.split('\n')[0] : ''),
        vscode.SymbolKind.Module,
        lineRange(line),
        new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length)
      );
      // A label indented inside a choice/condition stays an entry of that
      // block, so the block's structure isn't broken up by it.
      if (labelsAreSections && indent === 0) {
        closeBlocksFrom(0);
        closeLabel();
        currentLabel = symbol;
        rootSymbols.push(currentLabel);
      } else {
        addSymbol(symbol); // just an entry, nested in whatever block it's indented in
      }
      lastContentLine = line;
      continue;
    }
    lastContentLine = line;
    if (!showFlow) { continue; }

    const flowMatch = trimmed.match(/^(if|elif|else)\b\s*(.*?)\s*:?\s*$/);
    const choiceMatch = trimmed.match(/^-\s+(.*)$/);
    const jumpMatch = trimmed.match(/^(jump)\s+(.*)$|^(return)\b|^(\[end_timeline\])/);
    if (flowMatch) {
      const symbol = new vscode.DocumentSymbol(`${flowMatch[1]}${flowMatch[2] ? ' ' + flowMatch[2] : ''}`, '', vscode.SymbolKind.Operator, lineRange(line, indent), lineRange(line, indent));
      addSymbol(symbol);
      openBlocks.push({ indent, symbol });
    } else if (choiceMatch) {
      const choiceText = choiceMatch[1].split(/\s*\|/)[0].replace(/\s*#id:\S+/, '').trim() || '(choice)';
      const symbol = new vscode.DocumentSymbol(choiceText, 'choice', vscode.SymbolKind.EnumMember, lineRange(line, indent), lineRange(line, indent));
      addSymbol(symbol);
      openBlocks.push({ indent, symbol });
    } else if (jumpMatch && showJumps) {
      const name = jumpMatch[1] ? `jump ${jumpMatch[2].split('#id:')[0].trim()}` : (jumpMatch[3] || jumpMatch[4]);
      const detail = jumpMatch[1]
        ? describeJumpDirection(jumpMatch[2].split('#id:')[0].trim(), line, labelDocs)
        : jumpMatch[3] ? '<- back to the last jump' : 'end';
      addSymbol(new vscode.DocumentSymbol(name, detail, vscode.SymbolKind.Event, lineRange(line, indent), lineRange(line, indent)));
    }
  }
  closeBlocksFrom(0);
  closeLabel();
  return rootSymbols;
}

// =============================================================================
// SEMANTIC TOKENS (autoload references inside {...})
// =============================================================================

/**
 * Token types this extension reports. Mapped back to the same TextMate
 * scopes the grammar uses for `Global.State.IDLE` outside braces (see
 * package.json's semanticTokenScopes), so both look the same.
 *
 * @type {vscode.SemanticTokensLegend}
 */
const SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend(['class', 'property', 'enum', 'enumMember', 'function']);

/**
 * Inside `{...}`, the grammar can't tell `{Global.hearts}` (an autoload
 * property) from `{chapter.value}` (a Dialogic variable folder) - they
 * have the same shape. The extension knows the autoload names, so it
 * marks just those references with semantic tokens: the autoload as a
 * class, then its member as property/enum/constant, and an enum's value.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.SemanticTokens}
 */
function provideAutoloadSemanticTokens(document) {
  const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);
  const blockPattern = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;
  const memberTokenType = { function: 'function', variable: 'property', constant: 'enumMember', enum: 'enum' };
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    blockPattern.lastIndex = 0;
    let match;
    while ((match = blockPattern.exec(text)) !== null) {
      const segments = match[1].split('.');
      if (cachedVariablesTree.has(segments[0]) || !cachedAutoloadNames.has(segments[0])) { continue; }
      let column = match.index + 1;
      builder.push(line, column, segments[0].length, 0);
      const symbols = cachedAutoloadSymbols.get(segments[0]);
      if (!symbols || segments.length < 2) { continue; }
      column += segments[0].length + 1;
      const member = findAutoloadMember(symbols, segments[1]);
      if (!member) { continue; }
      builder.push(line, column, segments[1].length, SEMANTIC_TOKENS_LEGEND.tokenTypes.indexOf(memberTokenType[member.kind]));
      if (member.kind === 'enum' && segments.length >= 3) {
        builder.push(line, column + segments[1].length + 1, segments[2].length, SEMANTIC_TOKENS_LEGEND.tokenTypes.indexOf('enumMember'));
      }
    }
  }
  return builder.build();
}

// =============================================================================
// DIALOGIC CHARACTER FILES (.dch)
// =============================================================================
// A .dch file is Godot's var_to_str() of inst_to_dict(DialogicCharacter):
// a GDScript-literal dictionary. These describe its keys, per nesting level,
// for autocomplete and hover. Taken from Dialogic's own DialogicCharacter
// resource (addons/dialogic/Resources/character.gd) and character editor.

/** @type {string} */
const DIALOGIC_CHARACTER_DOCS_URL = 'https://docs.dialogic.pro/characters-and-portraits.html';

/**
 * Top-level keys of a .dch file.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_CHARACTER_KEYS = {
  'display_name': { type: 'String', value: '""', doc: 'Name shown in the dialogue name label. Can contain spaces and use variables, e.g. `{player_name}`.' },
  'nicknames': { type: 'Array', value: '[""]', doc: 'Other names the character is recognized by: writing any of them in dialogue text is colored/linked to this character, like its display name.' },
  'color': { type: 'Color', value: 'Color(1, 1, 1, 1)', doc: 'Color of the character\'s name label, and of its name when it appears in text (if enabled in the Text settings).' },
  'description': { type: 'String', value: '""', doc: 'Free notes about the character, for the writers only - never shown in game. Shown by DTL Reader when hovering the character in a timeline.' },
  'scale': { type: 'float', value: '1.0', doc: 'Scale applied to all of the character\'s portraits (a portrait can opt out with `ignore_char_scale`).' },
  'offset': { type: 'Vector2', value: 'Vector2(0, 0)', doc: 'Offset in pixels applied to all of the character\'s portraits, on top of each portrait\'s own offset.' },
  'mirror': { type: 'bool', value: 'false', doc: 'Mirrors all of the character\'s portraits horizontally.' },
  'default_portrait': { type: 'String', value: '""', doc: 'Portrait used when none is given, e.g. `join Laripo left` without a `(mood)`. Must be one of the `portraits` keys.' },
  'portraits': { type: 'Dictionary', value: '{}', doc: 'Every portrait (mood) of the character, by name. The names are what `(mood)` tags use in timelines, e.g. `join Laripo (happy) left`.' },
  'custom_info': { type: 'Dictionary', value: '{}', doc: 'Extra data used by Dialogic modules and your own code (e.g. the typing sound settings, a custom style), edited in the character editor\'s other tabs.' },
  '@path': { type: 'String', value: '"res://addons/dialogic/Resources/character.gd"', doc: 'Written by Godot\'s `inst_to_dict()`: the script this dictionary is an instance of. Leave it as is.' },
  '@subpath': { type: 'NodePath', value: 'NodePath("")', doc: 'Written by Godot\'s `inst_to_dict()`. Leave it as is.' },
};

/**
 * Keys of one portrait inside `portraits`.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_PORTRAIT_KEYS = {
  'scene': { type: 'String', value: '""', doc: 'Portrait scene (`.tscn`) to display, e.g. a LayeredPortrait. Leave empty to use Dialogic\'s default portrait scene, which shows the `image` set in `export_overrides`.' },
  'export_overrides': { type: 'Dictionary', value: '{}', doc: 'Values for the portrait scene\'s `@export` variables, e.g. `image` for the default scene. Each value is a GDScript expression stored as a string, so a path is written `"\\"res://...png\\""`.' },
  'scale': { type: 'float', value: '1.0', doc: 'Scale of this portrait, multiplied with the character\'s `scale` (unless `ignore_char_scale` is on).' },
  'offset': { type: 'Vector2', value: 'Vector2(0, 0)', doc: 'Offset in pixels of this portrait, added to the character\'s `offset`.' },
  'mirror': { type: 'bool', value: 'false', doc: 'Mirrors this portrait horizontally (combined with the character\'s `mirror`).' },
  'ignore_char_scale': { type: 'bool', value: 'false', doc: 'If true, this portrait ignores the character\'s `scale` and only uses its own.' },
  'sound_mood': { type: 'String', value: '""', doc: 'Typing sound mood used while this portrait is shown - one of the `custom_info` > `sound_moods` names. Empty uses `sound_mood_default`.' },
};

/**
 * Keys of `custom_info` that Dialogic's own modules use (Style and Text
 * modules' character settings). Other keys can be added freely by your own
 * code.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_CUSTOM_INFO_KEYS = {
  'style': { type: 'String', value: '""', doc: 'Name of the Dialogic style (Layout) used while this character speaks. Empty keeps the current style.' },
  'sound_mood_default': { type: 'String', value: '""', doc: 'Typing sound mood used by default - one of the `sound_moods` names. A portrait can use another one with its own `sound_mood`.' },
  'sound_moods': { type: 'Dictionary', value: '{}', doc: 'Typing sound moods of this character, by name: which sounds play while its text is typed, and how.' },
};

/**
 * Keys of one typing sound mood, inside `custom_info` > `sound_moods`.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_SOUND_MOOD_KEYS = {
  'name': { type: 'String', value: '""', doc: 'Name of this sound mood - the same as its key in `sound_moods`.' },
  'sound_path': { type: 'String', value: '""', doc: 'A sound file, or a folder whose sounds are picked at random, played while the text is typed.' },
  'mode': { type: 'int', value: '0', doc: 'How a new sound plays over the previous one: `0` INTERRUPT (stops it), `1` OVERLAP (plays on top), `2` AWAIT (waits for it to end).' },
  'pitch_base': { type: 'float', value: '1.0', doc: 'Base pitch of the sounds.' },
  'pitch_variance': { type: 'float', value: '0.0', doc: 'Random pitch variation added to `pitch_base` for each sound.' },
  'volume_base': { type: 'float', value: '0.0', doc: 'Base volume of the sounds, in dB.' },
  'volume_variance': { type: 'float', value: '0.0', doc: 'Random volume variation added to `volume_base` for each sound, in dB.' },
  'skip_characters': { type: 'int', value: '0', doc: 'Number of characters skipped between two sounds (0 = a sound on every character).' },
};

/** The `mode` values of a typing sound mood (Dialogic's DialogicNode_TypeSounds.Modes). */
const DCH_SOUND_MODES = [
  ['0', 'INTERRUPT', 'A new sound stops the one playing.'],
  ['1', 'OVERLAP', 'A new sound plays on top of the one playing.'],
  ['2', 'AWAIT', 'A new sound waits for the one playing to end.'],
];

/** Doc of the `image` override of Dialogic's default portrait scene. @type {string} */
const DCH_IMAGE_OVERRIDE_DOC = 'Image shown by Dialogic\'s default portrait scene (used when the portrait has no `scene`). Written as a quoted path inside the string: `"\\"res://portraits/happy.png\\""`.';

/**
 * Walk a .dch document up to `stopOffset`, tracking which dictionary /
 * list the scanner is in (with the key each one is the value of), whether
 * a key or a value is expected next, and every key token seen with its
 * path - e.g. `portraits` > `Happy` > `scene`. Strings are skipped as a
 * whole (escapes included) so braces/colons inside them don't count.
 *
 * @param {string} text
 * @param {number} [stopOffset] - defaults to the whole text
 * @returns {{
 *   stack: {kind: 'dict'|'list', key: string|null, keys: Set<string>}[],
 *   state: 'key'|'value'|'after',
 *   pendingKey: string|null,
 *   valueStart: number,
 *   keyTokens: {name: string, start: number, end: number, path: string[]}[],
 *   openString: {start: number, text: string} | null
 * }}
 */
function scanDch(text, stopOffset = text.length) {
  const stack = [];
  const keyTokens = [];
  let state = 'value';
  let pendingKey = null;
  let lastString = null;
  let valueStart = 0;
  const pathOf = () => stack.map(container => container.key).slice(1);
  for (let i = 0; i < stopOffset; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i > 0 && text[i - 1] === '&' ? i - 1 : i;
      let end = i + 1;
      while (end < text.length && text[end] !== '"') { end += text[end] === '\\' ? 2 : 1; }
      if (end >= stopOffset) {
        return { stack, state, pendingKey, valueStart, keyTokens, openString: { start, text: text.slice(i + 1, stopOffset) } };
      }
      lastString = { value: text.slice(i + 1, end), start, end: end + 1 };
      i = end;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === '{' || ch === '[') {
      stack.push({ kind: ch === '{' ? 'dict' : 'list', key: pendingKey, keys: new Set() });
      pendingKey = null;
      state = ch === '{' ? 'key' : 'value';
      valueStart = i + 1;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      state = 'after';
    } else if (ch === ':' && top && top.kind === 'dict' && lastString) {
      pendingKey = lastString.value;
      top.keys.add(pendingKey);
      keyTokens.push({ name: lastString.value, start: lastString.start, end: lastString.end, path: pathOf() });
      state = 'value';
      valueStart = i + 1;
    } else if (ch === ',') {
      state = top && top.kind === 'dict' ? 'key' : 'value';
      if (top && top.kind === 'dict') { pendingKey = null; }
      valueStart = i + 1;
    }
  }
  return { stack, state, pendingKey, valueStart, keyTokens, openString: null };
}

/**
 * The character a .dch document belongs to (its name in project.godot's
 * `directories/dch_directory`), if it's registered.
 *
 * @param {vscode.TextDocument} document
 * @returns {string | null}
 */
function findCharacterForDocument(document) {
  if (!projectRootUri) { return null; }
  const documentPath = normalizeFsPath(document.uri.fsPath || '');
  for (const [name, resPath] of cachedCharacterPaths) {
    if (normalizeFsPath(resolveResourcePath(resPath).fsPath) === documentPath) { return name; }
  }
  return null;
}

/**
 * The `@export` variables of a portrait scene's root script - what its
 * `export_overrides` can set. Empty if the scene or script can't be read.
 *
 * @param {string} scenePath - res:// .tscn path
 * @returns {Promise<Map<string, GdVariableInfo>>}
 */
async function readPortraitSceneExports(scenePath) {
  try {
    const sceneText = Buffer.from(await vscode.workspace.fs.readFile(resolveResourcePath(scenePath))).toString('utf8');
    const scriptPath = extractSceneRootScriptPath(sceneText);
    if (!scriptPath || !scriptPath.endsWith('.gd')) { return new Map(); }
    const scriptText = Buffer.from(await vscode.workspace.fs.readFile(resolveResourcePath(scriptPath))).toString('utf8');
    const exports = new Map();
    for (const [name, info] of parseGdScript(scriptText).variables) {
      if (info.isExported) { exports.set(name, info); }
    }
    return exports;
  } catch (error) {
    return new Map();
  }
}

/**
 * An `export_overrides` value for an `@export` variable, as Dialogic stores
 * it: a GDScript expression inside a string, e.g. `"true"`, `"1.0"`,
 * `"\"text\""`. Uses the variable's own default when it has one.
 *
 * @param {GdVariableInfo} info
 * @returns {string} the .dch literal
 */
function exportOverrideValue(info) {
  const quote = expression => `"${expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (info.defaultValue) { return quote(info.defaultValue); }
  const type = (info.type || '').trim();
  if (type === 'bool') { return quote('false'); }
  if (type === 'int') { return quote('0'); }
  if (type === 'float') { return quote('0.0'); }
  if (type === 'String' || type === 'StringName') { return quote('""'); }
  if (type === 'Color') { return quote('Color(1, 1, 1, 1)'); }
  if (type === 'Vector2') { return quote('Vector2(0, 0)'); }
  return '""';
}

/**
 * The sound mood names declared in a .dch file (`custom_info` >
 * `sound_moods` keys).
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseDchSoundMoods(text) {
  return scanDch(text).keyTokens
    .filter(token => token.path.length === 2 && token.path[0] === 'custom_info' && token.path[1] === 'sound_moods')
    .map(token => token.name);
}

/**
 * Moods (portrait names) a character is given in the project's timelines -
 * `join Name (mood)`, `update Name (mood)`, `Name (mood): text` - with where
 * they're used. Open timelines are read live, the others from disk.
 *
 * @param {string} characterName
 * @returns {Promise<Map<string, string[]>>} mood -> "timeline:line" places
 */
async function collectTimelineMoodUsage(characterName) {
  const usage = new Map();
  if (!projectRootUri) { return usage; }
  const pattern = new RegExp(`^\\s*(?:(?:join|update)\\s+)?(${CHARACTER_NAME_SOURCE})\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\)`, 'u');
  let uris = [];
  try { uris = await vscode.workspace.findFiles('**/*.dtl', '**/{.git,.godot,node_modules}/**'); } catch (error) { return usage; }
  for (const uri of uris) {
    const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === uri.fsPath);
    let text;
    try { text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch (error) { continue; }
    const name = uri.fsPath.replace(/\\/g, '/').split('/').pop();
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(pattern);
      if (!match || stripCharacterNameQuotes(match[1]) !== characterName) { return; }
      if (!usage.has(match[2])) { usage.set(match[2], []); }
      usage.get(match[2]).push(`${name}:${index + 1}`);
    });
  }
  return usage;
}

/** Escape literal text for a snippet (VS Code snippets treat $ } \ specially). */
const escapeSnippetText = text => text.replace(/[$}\\]/g, '\\$&');

/**
 * Snippet of a whole new portrait, in the file's own key style (`&"key"`
 * or `"key"`), with the cursor on its image path.
 *
 * @param {string|null} name - null for a placeholder name to type
 * @param {string} keyPrefix - "&" or ""
 * @returns {vscode.SnippetString}
 */
function portraitSnippet(name, keyPrefix) {
  const k = key => `${keyPrefix}"${key}"`;
  const nameText = name === null ? '${1:NewPortrait}' : escapeSnippetText(name);
  const image = name === null ? '2' : '1';
  return new vscode.SnippetString(
    `${keyPrefix}"${nameText}": {\n${k('export_overrides')}: {\n${k('image')}: "\\\\"res://\${${image}}\\\\""\n},\n`
    + `${k('mirror')}: false,\n${k('offset')}: Vector2(0, 0),\n${k('scale')}: 1.0,\n${k('scene')}: ""\n}`
  );
}

/**
 * The keys that make sense at a given .dch dictionary path, with their
 * docs: the character's own keys at the top, a portrait's keys inside
 * `portraits` > name, and the portrait scene's `@export` variables inside
 * `export_overrides` (plus `image`, for Dialogic's default portrait
 * scene). Nothing for levels whose keys are free (portrait names,
 * custom_info).
 *
 * @param {string[]} path
 * @param {string} text - the whole document, to find the portrait's scene
 * @returns {Promise<Record<string, {type: string, value: string, doc: string}>>}
 */
async function dchKeysForPath(path, text) {
  if (path.length === 0) { return DCH_CHARACTER_KEYS; }
  if (path.length === 2 && path[0] === 'portraits') { return DCH_PORTRAIT_KEYS; }
  if (path.length === 1 && path[0] === 'custom_info') { return DCH_CUSTOM_INFO_KEYS; }
  if (path.length === 3 && path[0] === 'custom_info' && path[1] === 'sound_moods') { return DCH_SOUND_MOOD_KEYS; }
  if (path.length === 3 && path[0] === 'portraits' && path[2] === 'export_overrides') {
    const keys = { 'image': { type: 'String', value: '"\\"res://\\""', doc: DCH_IMAGE_OVERRIDE_DOC } };
    const portrait = parseDchPortraits(text).get(path[1]);
    if (portrait && portrait.scene) {
      for (const [name, info] of await readPortraitSceneExports(portrait.scene)) {
        keys[name] = { type: info.type || 'Variant', value: exportOverrideValue(info), doc: info.doc || `\`@export\` variable of \`${portrait.scene}\`'s root script.` };
      }
    }
    return keys;
  }
  return {};
}

/**
 * Completion items for a .dch document: keys for the current dictionary
 * level (see dchKeysForPath), and values for known keys - portrait names
 * for `default_portrait`, `.tscn` scenes for `scene`, images for the
 * `image` override, true/false, and ready-made Color()/Vector2() literals.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.CompletionItem[]>}
 */
async function provideDchCompletions(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const scan = scanDch(text, offset);
  const top = scan.stack[scan.stack.length - 1];
  const line = document.lineAt(position.line).text;
  const closingQuote = line[position.character] === '"' ? 1 : 0;
  const items = [];
  const useStringNames = /&"/.test(text) || /^\s*(?:\{\s*\})?\s*$/.test(text);
  const keyPrefix = useStringNames ? '&' : '';

  // A new, empty .dch file (or an empty "{}"): offer a whole character.
  if (/^\s*(?:\{\s*\})?\s*$/.test(text)) {
    const k = key => `${keyPrefix}"${key}"`;
    const item = new vscode.CompletionItem({ label: 'Dialogic character', description: 'every key, with defaults' }, vscode.CompletionItemKind.Snippet);
    item.documentation = new vscode.MarkdownString('A complete character, as Dialogic writes it, with one portrait to fill in.');
    item.insertText = new vscode.SnippetString(
      `{\n${k('@path')}: "res://addons/dialogic/Resources/character.gd",\n${k('@subpath')}: NodePath(""),\n`
      + `${k('color')}: Color(1, 1, 1, 1),\n${k('custom_info')}: {},\n${k('default_portrait')}: "\${2:Default}",\n`
      + `${k('description')}: "\${3}",\n${k('display_name')}: "\${1:Name}",\n${k('mirror')}: false,\n${k('nicknames')}: [],\n`
      + `${k('offset')}: Vector2(0, 0),\n${k('portraits')}: {\n${keyPrefix}"\${2:Default}": {\n${k('export_overrides')}: {\n`
      + `${k('image')}: "\\\\"res://\${4}\\\\""\n},\n${k('mirror')}: false,\n${k('offset')}: Vector2(0, 0),\n${k('scale')}: 1.0,\n${k('scene')}: ""\n}\n},\n`
      + `${k('scale')}: 1.0\n}\n`
    );
    item.range = new vscode.Range(new vscode.Position(0, 0), document.positionAt(text.length));
    return [item];
  }
  if (!top) { return []; }
  const path = scan.stack.map(container => container.key).slice(1);

  if (scan.state === 'key' && top.kind === 'dict') {
    const keys = await dchKeysForPath(path, text);
    const bareTyped = scan.openString ? '' : (line.slice(0, position.character).match(/&?[A-Za-z_@]*$/) || [''])[0];
    const typedStart = scan.openString ? document.positionAt(scan.openString.start) : new vscode.Position(position.line, position.character - bareTyped.length);
    const range = new vscode.Range(typedStart, new vscode.Position(position.line, position.character + (scan.openString ? closingQuote : 0)));
    // VS Code filters on the typed text, so match its shape: `&"disp` or `"disp` vs a bare `disp`.
    const quotedFilter = !!scan.openString || bareTyped.startsWith('&');
    // Keys already set in this dictionary - before AND after the cursor. The
    // half-typed key is cut out first, so its open quote doesn't swallow the
    // rest of the file when scanning.
    const withoutTyped = text.slice(0, document.offsetAt(typedStart)) + text.slice(offset + (scan.openString ? closingQuote : 0));
    const samePath = tokenPath => tokenPath.length === path.length && tokenPath.every((segment, i) => segment === path[i]);
    const existingKeys = new Set([...top.keys, ...scanDch(withoutTyped).keyTokens.filter(token => samePath(token.path)).map(token => token.name)]);
    top.keys = existingKeys;
    for (const [name, info] of Object.entries(keys)) {
      if (top.keys.has(name)) { continue; } // already set in this dictionary
      const item = new vscode.CompletionItem({ label: name, description: info.type }, vscode.CompletionItemKind.Property);
      item.documentation = new vscode.MarkdownString(info.doc);
      item.filterText = quotedFilter ? `${useStringNames ? '&' : ''}"${name}"` : name;
      item.insertText = new vscode.SnippetString(`${useStringNames ? '&' : ''}"${name}": \${1:${info.value.replace(/[$}\\]/g, '\\$&')}}`);
      item.range = range;
      item.sortText = name.startsWith('@') ? `2_${name}` : `1_${name}`;
      items.push(item);
    }
    // Inside `portraits`: the moods the timelines give this character but
    // this file doesn't define yet, as whole portraits - plus a blank one.
    if (path.length === 1 && path[0] === 'portraits') {
      const character = findCharacterForDocument(document);
      if (character) {
        for (const [mood, places] of await collectTimelineMoodUsage(character)) {
          if (top.keys.has(mood)) { continue; }
          const item = new vscode.CompletionItem({ label: mood, description: `used in ${places.length} timeline line(s)` }, vscode.CompletionItemKind.EnumMember);
          item.documentation = new vscode.MarkdownString(`\`(${mood})\` is used for **${character}** in timelines but has no portrait yet:\n\n${places.slice(0, 8).map(place => `- ${place}`).join('\n')}${places.length > 8 ? '\n- ...' : ''}`);
          item.filterText = quotedFilter ? `${keyPrefix}"${mood}"` : mood;
          item.insertText = portraitSnippet(mood, keyPrefix);
          item.range = range;
          item.sortText = `0_${mood}`;
          items.push(item);
        }
      }
      const item = new vscode.CompletionItem({ label: 'New portrait', description: 'image portrait' }, vscode.CompletionItemKind.Snippet);
      item.filterText = quotedFilter ? `${keyPrefix}"` : 'portrait';
      item.insertText = portraitSnippet(null, keyPrefix);
      item.range = range;
      item.sortText = '3_new';
      items.push(item);
    }
    // Inside `sound_moods`: a whole new sound mood.
    if (path.length === 2 && path[0] === 'custom_info' && path[1] === 'sound_moods') {
      const k = key => `${keyPrefix}"${key}"`;
      const item = new vscode.CompletionItem({ label: 'New sound mood', description: 'typing sounds' }, vscode.CompletionItemKind.Snippet);
      item.filterText = quotedFilter ? `${keyPrefix}"` : 'sound';
      item.insertText = new vscode.SnippetString(
        `${keyPrefix}"\${1:Mood}": {\n${k('mode')}: 0,\n${k('name')}: "\${1:Mood}",\n${k('pitch_base')}: 1.0,\n${k('pitch_variance')}: 0.0,\n`
        + `${k('skip_characters')}: 0,\n${k('sound_path')}: "res://\${2}",\n${k('volume_base')}: 0.0,\n${k('volume_variance')}: 0.0\n}`
      );
      item.range = range;
      items.push(item);
    }
    return items;
  }

  if (scan.state !== 'value' || !scan.pendingKey) { return []; }
  const key = scan.pendingKey;
  const valueStartPosition = scan.openString
    ? document.positionAt(scan.openString.start)
    : document.positionAt(scan.valueStart + (text.slice(scan.valueStart, offset).match(/^\s*/) || [''])[0].length);
  const range = new vscode.Range(valueStartPosition, new vscode.Position(position.line, position.character + (scan.openString ? closingQuote : 0)));
  const typed = scan.openString ? scan.openString.text : text.slice(document.offsetAt(valueStartPosition), offset);
  const addValue = (label, insert, detail, kind = vscode.CompletionItemKind.Value) => {
    const item = new vscode.CompletionItem(label, kind);
    item.insertText = insert;
    item.filterText = typeof insert === 'string' ? insert : label;
    item.detail = detail;
    item.range = range;
    items.push(item);
  };

  if (path.length === 0 && key === 'default_portrait') {
    for (const mood of parseDchPortraits(text).keys()) { addValue(mood, `"${mood}"`, 'Portrait of this character', vscode.CompletionItemKind.EnumMember); }
  } else if ((key === 'sound_mood' && path.length === 2 && path[0] === 'portraits') || (key === 'sound_mood_default' && path.length === 1 && path[0] === 'custom_info')) {
    for (const mood of parseDchSoundMoods(text)) { addValue(mood, `"${mood}"`, 'Sound mood of this character', vscode.CompletionItemKind.EnumMember); }
  } else if (key === 'mode' && path.length === 3 && path[1] === 'sound_moods') {
    for (const [value, name, doc] of DCH_SOUND_MODES) { addValue(`${value} - ${name}`, value, doc, vscode.CompletionItemKind.EnumMember); }
  } else if (key === 'sound_path' && path.length === 3 && path[1] === 'sound_moods') {
    const audioFiles = cachedResourcePaths.filter(resPath => RESOURCE_EXTENSIONS.audio.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()));
    const folders = [...new Set(audioFiles.map(resPath => resPath.slice(0, resPath.lastIndexOf('/'))))];
    for (const folder of folders) {
      if (folder.toLowerCase().startsWith(typed.toLowerCase())) { addValue(`${folder}/`, `"${folder}"`, 'Folder of sounds (picked at random)', vscode.CompletionItemKind.Folder); }
    }
    for (const resPath of audioFiles) {
      if (resPath.toLowerCase().startsWith(typed.toLowerCase())) { addValue(resPath, `"${resPath}"`, 'Sound file', vscode.CompletionItemKind.File); }
    }
  } else if (key === 'scene' && path.length === 2 && path[0] === 'portraits') {
    for (const resPath of cachedResourcePaths) {
      if (RESOURCE_EXTENSIONS.scene.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()) && resPath.toLowerCase().startsWith(typed.toLowerCase())) {
        addValue(resPath, `"${resPath}"`, 'Portrait scene', vscode.CompletionItemKind.File);
      }
    }
  } else if (key === 'image' && path.length === 3 && path[2] === 'export_overrides') {
    const typedPath = typed.replace(/^\\?"?/, '');
    for (const resPath of cachedResourcePaths) {
      if (RESOURCE_EXTENSIONS.image.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()) && resPath.toLowerCase().startsWith(typedPath.toLowerCase())) {
        addValue(resPath, `"\\"${resPath}\\""`, 'Portrait image', vscode.CompletionItemKind.File);
      }
    }
  } else {
    const keyInfo = (await dchKeysForPath(path, text))[key];
    if (!keyInfo) { return []; }
    if (keyInfo.type === 'bool') {
      addValue('true', 'true', 'bool', vscode.CompletionItemKind.Keyword);
      addValue('false', 'false', 'bool', vscode.CompletionItemKind.Keyword);
    } else if (!scan.openString) {
      addValue(keyInfo.value, keyInfo.value, `${keyInfo.type} (default)`);
    }
  }
  return items;
}

/** Round a color component for writing it back (at most 3 decimals, no trailing zeros). */
const formatColorComponent = value => String(Math.round(value * 1000) / 1000);

/**
 * Color swatches (and the color picker) for a .dch file's
 * `Color(r, g, b[, a])` values, e.g. the character's name color.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.ColorInformation[]}
 */
function provideDchColors(document) {
  const text = document.getText();
  const pattern = /Color\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*)?\)/g;
  const colors = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [r, g, b, a] = match.slice(1).map(value => (value === undefined ? 1 : Math.min(1, Math.max(0, parseFloat(value)))));
    colors.push(new vscode.ColorInformation(new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length)), new vscode.Color(r, g, b, a)));
  }
  return colors;
}

/**
 * @param {vscode.Color} color
 * @returns {vscode.ColorPresentation[]}
 */
function provideDchColorPresentations(color) {
  const parts = [color.red, color.green, color.blue, color.alpha].map(formatColorComponent);
  return [new vscode.ColorPresentation(`Color(${parts.join(', ')})`)];
}

/**
 * Color swatches (and the picker) for the `#hex` colors of BBCode tags in a
 * timeline: `[color=#ff0000]`, `[bgcolor=...]`, `[outline_color=...]`,
 * `[pulse color=...]`, etc. Named colors (`red`) are left to the preview.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.ColorInformation[]}
 */
function provideTimelineColors(document) {
  const colors = [];
  const pattern = /\[[A-Za-z_]*(?:=|[^\]]*\bcolor=)(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4}))\b/g;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!text.includes('#')) { continue; }
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let hex = match[1].slice(1);
      if (hex.length <= 4) { hex = hex.split('').map(ch => ch + ch).join(''); }
      const [r, g, b, a] = [0, 2, 4, 6].map(i => (i < hex.length ? parseInt(hex.slice(i, i + 2), 16) / 255 : 1));
      const start = match.index + match[0].length - match[1].length;
      colors.push(new vscode.ColorInformation(new vscode.Range(line, start, line, start + match[1].length), new vscode.Color(r, g, b, a)));
    }
  }
  return colors;
}

/**
 * @param {vscode.Color} color
 * @returns {vscode.ColorPresentation[]}
 */
function provideTimelineColorPresentations(color) {
  const toHex = value => Math.round(value * 255).toString(16).padStart(2, '0');
  const hex = `#${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}${color.alpha < 1 ? toHex(color.alpha) : ''}`;
  return [new vscode.ColorPresentation(hex)];
}

/**
 * Hover for a .dch key: what it does (character, portrait and
 * export_overrides keys). Hovering a portrait's name inside `portraits`
 * shows that mood's documentation, same as hovering it in a timeline.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.Hover | undefined>}
 */
async function provideDchHover(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const token = scanDch(text).keyTokens.find(candidate => offset >= candidate.start && offset <= candidate.end);
  if (!token) { return undefined; }
  const range = new vscode.Range(document.positionAt(token.start), document.positionAt(token.end));
  if (token.path.length === 1 && token.path[0] === 'portraits') {
    const character = findCharacterForDocument(document);
    const markdown = character ? createMoodDocumentation(character, token.name) : null;
    return markdown ? new vscode.Hover(markdown, range) : undefined;
  }
  const info = (await dchKeysForPath(token.path, text))[token.name];
  if (!info) { return undefined; }
  const where = token.path.length === 0 ? 'character'
    : token.path[0] === 'custom_info' ? (token.path.length === 3 ? 'typing sound mood' : 'custom info')
    : token.path[2] === 'export_overrides' ? 'portrait scene override' : 'portrait';
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${token.name}**: \`${info.type}\` _(${where})_\n\n${info.doc}\n\n`);
  markdown.appendMarkdown(`[Dialogic documentation](${DIALOGIC_CHARACTER_DOCS_URL})`);
  return new vscode.Hover(markdown, range);
}

/**
 * Diagnostics for a .dch document: a `default_portrait` that isn't one of
 * its `portraits`, and a portrait `scene` that doesn't exist in the
 * project (only checked once the project's files are known).
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findDchDiagnostics(document) {
  const text = document.getText();
  const diagnostics = [];
  const portraits = parseDchPortraits(text);
  const defaultMatch = text.match(/&?"default_portrait"\s*:\s*"([^"]*)"/);
  if (defaultMatch && defaultMatch[1] && portraits.size > 0 && !portraits.has(defaultMatch[1])) {
    const start = defaultMatch.index + defaultMatch[0].length - defaultMatch[1].length - 1;
    pushDiagnostic(diagnostics, 'dchDefaultPortrait',
      new vscode.Range(document.positionAt(start), document.positionAt(start + defaultMatch[1].length)),
      `"${defaultMatch[1]}" is not one of this character's portraits (${[...portraits.keys()].join(', ')}).`);
  }
  if (projectRootUri && cachedResourcePaths.length > 0) {
    const scenePattern = /&?"scene"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = scenePattern.exec(text)) !== null) {
      if (cachedResourcePaths.includes(match[1])) { continue; }
      const start = match.index + match[0].length - match[1].length - 1;
      pushDiagnostic(diagnostics, 'dchMissingScene',
        new vscode.Range(document.positionAt(start), document.positionAt(start + match[1].length)),
        `"${match[1]}" doesn't exist in this project.`);
    }
  }
  return diagnostics;
}

// =============================================================================
// TRANSLATIONS
// =============================================================================
// Dialogic translates timelines through CSV files it generates ("Update CSV
// files" in its Translation settings): first column `keys`, then one column
// per locale. A key is `<event name>/<translation id>/<property>`, where the
// id is the `#id:...` Dialogic appends to each translatable line, e.g.
// `Text/greeting/text` for `Laripo: Hello! #id:greeting`. The CSVs are named
// `dialogic_timeline_translations.csv` (one per project) or
// `dialogic_<timeline>_translation.csv` (one per timeline).
//
// With `dtlReader.translation.language` set (e.g. "fr"), each translatable
// line shows its translation right after it, missing ones can be reported,
// and "DTL: Translate line" writes a translation back into the CSV - so a
// translator can work in the timeline itself, next to the original text.

/** Translation key -> locale -> text, from every Dialogic translation CSV. @type {Map<string, Map<string, string>>} */
let cachedTranslations = new Map();

/** Every locale column found in the CSVs. @type {string[]} */
let cachedTranslationLocales = [];

/** Translation key -> the CSV file it's in. @type {Map<string, vscode.Uri>} */
let cachedTranslationFileOfKey = new Map();

/** Every Dialogic translation CSV found. @type {vscode.Uri[]} */
let cachedTranslationFiles = [];

/** project.godot's `dialogic/translation/original_locale`, the language timelines are written in. @type {string|null} */
let translationOriginalLocale = null;

/**
 * The first locale column of the translation CSVs. Dialogic always writes
 * the original language there (`keys,en,...`), so it's the fallback when
 * project.godot doesn't set `translation/original_locale` (Godot leaves a
 * setting out of project.godot while it has its default value).
 *
 * @type {string|null}
 */
let cachedCsvOriginalLocale = null;

/**
 * The language the timelines are written in: project.godot's setting, else
 * the CSVs' first locale column (see cachedCsvOriginalLocale).
 *
 * @returns {string | null}
 */
function getOriginalLocale() {
  return translationOriginalLocale || cachedCsvOriginalLocale || null;
}

/** Decoration showing a line's translation after it. @type {vscode.TextEditorDecorationType | null} */
let translationDecorationType = null;

/**
 * Parse CSV text (RFC 4180 style, as Godot and Dialogic write it: fields
 * quoted when they contain a comma, quote or line break, quotes doubled).
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') { i++; }
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Write rows back as CSV, quoting only the fields that need it.
 *
 * @param {string[][]} rows
 * @param {string} eol
 * @returns {string}
 */
function serializeCsv(rows, eol) {
  const quote = field => /[",\r\n]/.test(field) || /^\s|\s$/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
  return rows.map(row => row.map(quote).join(',')).join(eol) + eol;
}

/**
 * Re-read every Dialogic translation CSV of the project.
 */
async function refreshTranslations() {
  const translations = new Map();
  const fileOfKey = new Map();
  const locales = new Set();
  const files = [];
  let firstLocale = null;
  if (projectRootUri) {
    try {
      const uris = await vscode.workspace.findFiles('**/dialogic_*.csv', '**/{.git,.godot,node_modules}/**');
      for (const uri of uris) {
        const rows = parseCsv(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
        if (rows.length === 0 || rows[0][0] !== 'keys') { continue; } // not a translation CSV
        files.push(uri);
        const header = rows[0];
        if (!firstLocale && header[1]) { firstLocale = header[1]; }
        header.slice(1).forEach(locale => { if (locale) { locales.add(locale); } });
        for (const row of rows.slice(1)) {
          const key = row[0];
          if (!key) { continue; }
          const byLocale = translations.get(key) || new Map();
          header.forEach((locale, column) => { if (column > 0 && locale && row[column]) { byLocale.set(locale, row[column]); } });
          translations.set(key, byLocale);
          if (!fileOfKey.has(key)) { fileOfKey.set(key, uri); }
        }
      }
    } catch (error) {
      console.error('DTL Reader: could not read the Dialogic translation CSV files', error);
    }
  }
  cachedTranslations = translations;
  cachedTranslationFileOfKey = fileOfKey;
  cachedTranslationLocales = [...locales];
  cachedTranslationFiles = files;
  cachedCsvOriginalLocale = firstLocale;
  translationsVersion++;
  updateAllTranslationDecorations();
  if (translationViewFileSystem) { translationViewFileSystem.refresh(); }
}

/**
 * The language being translated to (`dtlReader.translation.language`), or
 * null when translation mode is off.
 *
 * @returns {string | null}
 */
function getTranslationLanguage() {
  if (!projectRootUri) { return null; } // translations live in the project's CSVs
  const language = vscode.workspace.getConfiguration('dtlReader').get('translation.language', '');
  return language ? language.trim() : null;
}

/**
 * If `text` is a translatable line with a translation id, which CSV key it
 * uses and its original text: a dialogue/narration line
 * (`Text/<id>/text`), a choice (`Choice/<id>/text`), a label's display
 * name (`Label/<id>/display_name`) or a text input's prompt
 * (`Text Input/<id>/text`).
 *
 * @param {string} text - one line
 * @returns {{key: string, original: string, idStart: number, idEnd: number} | null}
 */
function parseTranslatableLine(text) {
  const idMatch = text.match(/#id:(\S+)\s*$/);
  if (!idMatch) { return null; }
  const id = idMatch[1];
  const idStart = idMatch.index;
  const idEnd = idStart + idMatch[0].trimEnd().length;
  const body = text.slice(0, idStart).replace(/\s+$/, '');
  const trimmed = body.trim();
  if (trimmed === '') { return null; }
  const entry = (key, original) => ({ key, original, idStart, idEnd });

  const label = parseLabelLine(text);
  if (label) { return label.displayName ? entry(`Label/${id}/display_name`, label.displayName) : null; }
  if (/^-\s/.test(trimmed)) { return entry(`Choice/${id}/text`, trimmed.slice(1).split('|')[0].trim()); }
  const textInputMatch = trimmed.match(/^\[text_input\b[^\]]*?\btext="([^"]*)"/);
  if (textInputMatch) { return entry(`Text Input/${id}/text`, textInputMatch[1]); }
  if (!isPlayerFacingTextLine(body)) { return null; }
  const speakerMatch = body.match(new RegExp(`^\\s*${CHARACTER_NAME_SOURCE}\\s*(?:\\([^)]*\\))?\\s*:\\s*`, 'u'));
  return entry(`Text/${id}/text`, speakerMatch ? body.slice(speakerMatch[0].length).trim() : trimmed);
}

/**
 * @param {string} key
 * @param {string} locale
 * @returns {string} empty if not translated
 */
function getTranslation(key, locale) {
  const byLocale = cachedTranslations.get(key);
  return (byLocale && byLocale.get(locale)) || '';
}

/**
 * Show each translatable line's translation in the current language right
 * after the line, in the editor (or "not translated" when missing).
 *
 * @param {vscode.TextEditor} editor
 */
function updateTranslationDecorations(editor) {
  if (!translationDecorationType || !editor || editor.document.languageId !== 'dtl') { return; }
  const language = getTranslationLanguage();
  const showInline = vscode.workspace.getConfiguration('dtlReader').get('translation.showInline', true);
  if (!language || !showInline) {
    editor.setDecorations(translationDecorationType, []);
    return;
  }
  const decorations = [];
  const document = editor.document;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const entry = parseTranslatableLine(text);
    if (!entry) { continue; }
    const translation = getTranslation(entry.key, language);
    decorations.push({
      range: new vscode.Range(line, text.length, line, text.length),
      renderOptions: {
        after: {
          contentText: translation ? `   ${language}: ${translation}` : `   ${language}: not translated yet`,
          color: new vscode.ThemeColor(translation ? 'editorCodeLens.foreground' : 'editorWarning.foreground'),
          fontStyle: 'italic',
        },
      },
    });
  }
  editor.setDecorations(translationDecorationType, decorations);
}

function updateAllTranslationDecorations() {
  if (!translationDecorationType) { return; }
  vscode.window.visibleTextEditors.forEach(updateTranslationDecorations);
}

/**
 * Report translatable lines that have no translation in the current
 * language yet (`dtlReader.diagnostics.missingTranslation`, a Hint by
 * default). Only while a translation language is set and translation CSVs
 * exist.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findMissingTranslationDiagnostics(document) {
  const language = getTranslationLanguage();
  if (!language || cachedTranslationFiles.length === 0) { return []; }
  const diagnostics = [];
  for (let line = 0; line < document.lineCount; line++) {
    const entry = parseTranslatableLine(document.lineAt(line).text);
    if (!entry || getTranslation(entry.key, language)) { continue; }
    pushDiagnostic(diagnostics, 'missingTranslation',
      new vscode.Range(line, entry.idStart, line, entry.idEnd),
      `Not translated to "${language}" yet - use the quick fix or "DTL: Translate Line".`);
  }
  return diagnostics;
}

/**
 * Hover on a line's `#id:...`: its translation key and the text in every
 * language of the CSVs, the original first.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.Hover | undefined}
 */
function provideTranslationHover(document, position) {
  if (!projectRootUri) { return undefined; }
  const entry = parseTranslatableLine(document.lineAt(position.line).text);
  if (!entry || position.character < entry.idStart || position.character > entry.idEnd) { return undefined; }
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**Translation** \`${entry.key}\`\n\n`);
  const escape = text => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const locales = [...cachedTranslationLocales].sort((a, b) => (a === getOriginalLocale() ? -1 : b === getOriginalLocale() ? 1 : 0));
  if (locales.length === 0) {
    markdown.appendMarkdown(cachedTranslationFiles.length === 0
      ? '_No Dialogic translation CSV found. Enable translation in Dialogic\'s settings and click "Update CSV files"._'
      : '_This line is not in the translation CSVs yet - "Update CSV files" in Dialogic adds it._');
    return new vscode.Hover(markdown);
  }
  markdown.appendMarkdown('| Locale | Text |\n|---|---|\n');
  for (const locale of locales) {
    const text = locale === getOriginalLocale() && !getTranslation(entry.key, locale) ? entry.original : getTranslation(entry.key, locale);
    markdown.appendMarkdown(`| ${locale}${locale === getOriginalLocale() ? ' (original)' : ''} | ${text ? escape(text) : '_not translated_'} |\n`);
  }
  return new vscode.Hover(markdown, new vscode.Range(position.line, entry.idStart, position.line, entry.idEnd));
}

/**
 * Translation works on the Godot project's CSV files, so without a
 * project.godot it's off. Returns true (after telling the person why)
 * when there's no project.
 *
 * @returns {boolean}
 */
function translationUnavailable() {
  if (projectRootUri) { return false; }
  vscode.window.showInformationMessage('DTL Reader: translating needs the Godot project - open the folder containing project.godot (with Dialogic\'s translation enabled).');
  return true;
}

/**
 * Pick the language to translate to, among the CSVs' locale columns (or a
 * new one), and save it as `dtlReader.translation.language`.
 *
 * @returns {Promise<string | null>} the chosen locale, or null if cancelled / turned off
 */
async function selectTranslationLanguage() {
  if (translationUnavailable()) { return null; }
  const current = getTranslationLanguage();
  const items = cachedTranslationLocales
    .filter(locale => locale !== getOriginalLocale())
    .map(locale => ({ label: locale, description: locale === current ? 'current' : '' }));
  items.push({ label: '$(add) Other language...', description: 'type a locale code, e.g. fr or pt_BR', other: true });
  if (current) { items.push({ label: '$(close) Turn translation mode off', off: true }); }
  const picked = await vscode.window.showQuickPick(items, { title: 'DTL: Translation language', placeHolder: getOriginalLocale() ? `Timelines are written in "${getOriginalLocale()}"` : 'Language to translate the timelines to' });
  if (!picked) { return null; }
  let language = picked.off ? '' : picked.label;
  if (picked.other) {
    language = (await vscode.window.showInputBox({ title: 'DTL: Translation language', prompt: 'Locale code, as used by Godot and the CSV column (e.g. fr, ja, pt_BR)' }) || '').trim();
    if (!language) { return null; }
  }
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('dtlReader').update('translation.language', language, target);
  return language || null;
}

/**
 * The CSV a new translation of `key` should go to: the one that already
 * has the key, else this timeline's own CSV (per-timeline mode), else the
 * project's timeline CSV (per-project mode).
 *
 * @param {string} key
 * @param {vscode.TextDocument} document
 * @returns {vscode.Uri | null}
 */
function findTranslationFileFor(key, document) {
  if (cachedTranslationFileOfKey.has(key)) { return cachedTranslationFileOfKey.get(key); }
  const byName = name => cachedTranslationFiles.find(uri => uri.fsPath.replace(/\\/g, '/').split('/').pop().toLowerCase() === name.toLowerCase());
  // Characters: Dialogic keeps them in one project-wide CSV.
  if (key.startsWith('Character/')) { return byName('dialogic_character_translations.csv') || null; }
  // Glossaries: the CSV that already has this glossary's keys, else the project-wide one.
  if (key.startsWith('Glossary/')) {
    const prefix = key.split('/').slice(0, 2).join('/') + '/';
    for (const [existingKey, uri] of cachedTranslationFileOfKey) { if (existingKey.startsWith(prefix)) { return uri; } }
    return byName('dialogic_glossary_translations.csv') || null;
  }
  const timelineName = ((document && document.uri && document.uri.fsPath) || '').replace(/\\/g, '/').split('/').pop().replace(/\.dtl$/i, '');
  return byName(`dialogic_${timelineName}_translation.csv`) || byName('dialogic_timeline_translations.csv') || null;
}

/**
 * Write a batch of translations into Dialogic's CSV files, one read and
 * one write per file: each translation goes to the CSV that already has
 * its key, else to this timeline's CSV (see findTranslationFileFor). The
 * locale column and/or the key's row are added if missing (a new row also
 * gets the original text in the original-locale column), and the file's
 * line endings are kept.
 *
 * Throws an Error with a readable message instead of writing anything if
 * a translation has no CSV to go to, or a target CSV has unsaved changes
 * in an editor.
 *
 * @param {{key: string, original: string, translation: string, language?: string}[]} entries
 * @param {string|null} language - locale of the entries that don't set their own `language`
 * @param {vscode.Uri} timelineUri - the timeline the entries come from
 * @returns {Promise<number>} how many translations were written
 */
async function writeTranslations(entries, language, timelineUri) {
  if (entries.length === 0) { return 0; }
  const byFile = new Map();
  for (const entry of entries) {
    const uri = findTranslationFileFor(entry.key, { uri: timelineUri });
    if (!uri) {
      const what = entry.key.startsWith('Character/') ? 'characters' : entry.key.startsWith('Glossary/') ? 'glossaries' : 'this timeline';
      throw new Error(`No Dialogic translation CSV found for ${what}. Enable translation in Dialogic's settings and click "Update CSV files" first.`);
    }
    if (!byFile.has(uri.fsPath)) { byFile.set(uri.fsPath, { uri, entries: [] }); }
    byFile.get(uri.fsPath).entries.push(entry);
  }
  for (const { uri } of byFile.values()) {
    const openCsv = vscode.workspace.textDocuments.find(candidate => normalizeFsPath(candidate.uri.fsPath || '') === normalizeFsPath(uri.fsPath));
    if (openCsv && openCsv.isDirty) {
      throw new Error(`${uri.fsPath} has unsaved changes - save or revert it before translating here.`);
    }
  }
  for (const { uri, entries: fileEntries } of byFile.values()) {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const rows = parseCsv(text);
    if (rows.length === 0) { rows.push(['keys']); }
    const header = rows[0];
    const columnOf = locale => {
      let column = header.indexOf(locale);
      if (column === -1) {
        header.push(locale);
        column = header.length - 1;
      }
      return column;
    };
    const originalColumn = getOriginalLocale() ? header.indexOf(getOriginalLocale()) : -1;
    for (const entry of fileEntries) {
      const column = columnOf(entry.language || language);
      let row = rows.find((candidate, index) => index > 0 && candidate[0] === entry.key);
      if (!row) {
        row = [entry.key];
        if (originalColumn > 0) { row[originalColumn] = entry.original; }
        rows.push(row);
      }
      row[column] = entry.translation;
    }
    for (const candidate of rows) {
      while (candidate.length < header.length) { candidate.push(''); }
      for (let i = 0; i < candidate.length; i++) { if (candidate[i] === undefined) { candidate[i] = ''; } }
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeCsv(rows, eol), 'utf8'));
  }
  await refreshTranslations();
  refreshAllDiagnostics();
  return entries.length;
}

/**
 * Write one translation (see writeTranslations), showing any problem as an
 * error message.
 *
 * @param {{key: string, original: string}} entry
 * @param {string} language
 * @param {string} translation
 * @param {vscode.TextDocument} document
 * @returns {Promise<boolean>} whether it was written
 */
async function writeTranslation(entry, language, translation, document) {
  try {
    await writeTranslations([{ ...entry, translation }], language, document.uri);
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(`DTL Reader: ${error.message}`);
    return false;
  }
}

/**
 * "DTL: Translate Line" - asks for the translation of a line in the
 * current language (showing the original), and writes it to the CSV.
 *
 * @param {vscode.Uri} [uri] - given by the quick fix
 * @param {number} [line] - given by the quick fix
 */
async function translateLineCommand(uri, line) {
  if (translationUnavailable()) { return; }
  const editor = vscode.window.activeTextEditor;
  // From the quick fix: (uri, line). From the editor context menu: (uri).
  // From the Command Palette: nothing - use the active editor's cursor.
  const document = uri && uri.fsPath
    ? vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === uri.fsPath) || await vscode.workspace.openTextDocument(uri)
    : editor && editor.document;
  if (!document || document.languageId !== 'dtl') { return; }
  const lineNumber = typeof line === 'number' ? line : editor.selection.active.line;
  const entry = parseTranslatableLine(document.lineAt(lineNumber).text);
  if (!entry) {
    vscode.window.showInformationMessage('DTL Reader: this line has no translation id (#id:...). "Update CSV files" in Dialogic\'s translation settings adds them.');
    return;
  }
  const language = getTranslationLanguage() || await selectTranslationLanguage();
  if (!language) { return; }
  const translation = await vscode.window.showInputBox({
    title: `Translate to ${language}`,
    prompt: `${getOriginalLocale() || 'Original'}: ${entry.original}`,
    value: getTranslation(entry.key, language),
    placeHolder: entry.original,
    ignoreFocusOut: true,
  });
  if (translation === undefined) { return; }
  if (await writeTranslation(entry, language, translation, document)) {
    vscode.window.setStatusBarMessage(`DTL Reader: ${entry.key} translated to ${language}`, 3000);
  }
}

/**
 * "DTL: Go to Next Untranslated Line" - moves the cursor to the next
 * translatable line with no translation in the current language,
 * wrapping around the end of the timeline.
 */
async function nextUntranslatedCommand() {
  if (translationUnavailable()) { return; }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'dtl') { return; }
  const language = getTranslationLanguage() || await selectTranslationLanguage();
  if (!language) { return; }
  const document = editor.document;
  const start = editor.selection.active.line;
  for (let offset = 1; offset <= document.lineCount; offset++) {
    const line = (start + offset) % document.lineCount;
    const entry = parseTranslatableLine(document.lineAt(line).text);
    if (entry && !getTranslation(entry.key, language)) {
      const position = new vscode.Position(line, entry.idStart);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
  }
  vscode.window.showInformationMessage(`DTL Reader: every translatable line of this timeline is translated to "${language}".`);
}

/**
 * Lightbulb action on a translatable line: "Translate to <language>".
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Range} range
 * @returns {vscode.CodeAction[]}
 */
function provideTranslationCodeActions(document, range) {
  if (!projectRootUri) { return []; }
  const entry = parseTranslatableLine(document.lineAt(range.start.line).text);
  if (!entry) { return []; }
  const language = getTranslationLanguage();
  const action = new vscode.CodeAction(language ? `Translate to ${language}` : 'Translate this line...', vscode.CodeActionKind.QuickFix);
  action.command = { command: 'dtlReader.translateLine', title: action.title, arguments: [document.uri, range.start.line] };
  return [action];
}

// =============================================================================
// TRANSLATION VIEW
// =============================================================================
// An editor, opened next to a timeline, listing every translatable line as
// its original text plus an editable translation line - saving it (Ctrl+S)
// writes the translations into Dialogic's CSV. It isn't a file on disk: it
// lives in a virtual file system under the `dtl-translation:` scheme, whose
// readFile builds the text from the timeline and the CSV (buildTranslationView)
// and whose writeFile parses it back (parseTranslationView) and writes the
// changed translations (writeTranslations). Each block looks like:
//
//   [Text/greeting/text]  line 7 - TestCharacter
//   en: Hello! [b]Welcome[/b] to the room.
//   fr: Bonjour ! [b]Bienvenue[/b] dans la salle.
//
// The `[key]` header says which CSV row the block is; only the line of the
// language being translated is read back, the original one is a reference.

/** @type {string} */
const TRANSLATION_VIEW_SCHEME = 'dtl-translation';

/**
 * URI of the Translation View of a timeline in one or more languages. The
 * path is what the tab shows ("test_timeline (fr, ja).dtltr"); the query
 * carries the timeline's URI and the languages, so reading/writing needs
 * no other state - and the languages never depend on the settings.
 *
 * @param {vscode.Uri} timelineUri
 * @param {string[]} languages
 * @returns {vscode.Uri}
 */
function translationViewUri(target, languages) {
  // A plain Uri is a timeline (the original, and most common, source).
  const source = target instanceof Object && target.source ? target : { source: 'timeline', uri: target };
  const params = { source: source.source, languages: languages.join(',') };
  let name;
  if (source.source === 'characters') {
    name = 'Characters';
    if (source.focus) { params.focus = source.focus; }
  } else if (source.source === 'glossary') {
    name = `${source.file.split('/').pop().replace(/\.tres$/i, '')} glossary`;
    params.glossary = source.file;
  } else {
    name = source.uri.path.split('/').pop().replace(/\.dtl$/i, '');
    params.timeline = source.uri.toString();
  }
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return vscode.Uri.from({ scheme: TRANSLATION_VIEW_SCHEME, path: `/${name} (${languages.join(', ')}).dtltr`, query });
}

/**
 * @param {vscode.Uri} uri - a Translation View URI
 * @returns {{timelineUri: vscode.Uri, languages: string[]}}
 */
function parseTranslationViewUri(uri) {
  const params = {};
  for (const part of uri.query.split('&')) {
    const [name, value = ''] = part.split('=');
    params[name] = decodeURIComponent(value);
  }
  const languages = (params.languages || params.language || '').split(',').map(language => language.trim()).filter(Boolean);
  const source = params.source || 'timeline';
  return {
    source,
    timelineUri: source === 'timeline' && params.timeline ? vscode.Uri.parse(params.timeline) : null,
    glossary: params.glossary || null,
    focus: params.focus || null,
    languages,
  };
}

/**
 * The same view source, as translationViewUri expects it.
 *
 * @param {ReturnType<typeof parseTranslationViewUri>} parsed
 */
function translationViewTarget(parsed) {
  if (parsed.source === 'characters') { return { source: 'characters', focus: parsed.focus }; }
  if (parsed.source === 'glossary') { return { source: 'glossary', file: parsed.glossary }; }
  return { source: 'timeline', uri: parsed.timelineUri };
}

/**
 * A file's current text: from its editor if it's open, else from disk.
 *
 * @param {vscode.Uri} uri
 * @returns {Promise<string>}
 */
async function readDocumentText(uri) {
  const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath && normalizeFsPath(document.uri.fsPath) === normalizeFsPath(uri.fsPath));
  return open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

/**
 * What a Translation View lists, whatever its source: a title, notes for
 * the header, and one item per translatable text - its CSV key, original
 * text, and where it comes from.
 *
 * - timeline: every line with a translation id (see parseTranslatableLine);
 * - characters: every character's name and nicknames (keys
 *   Character/<id>/name and /nicknames, nicknames comma-separated), the
 *   focused character first;
 * - glossary: every entry's name, alternatives, text and extra (keys
 *   Glossary/<glossary id>/<entry id>/<property>) - the properties Dialogic
 *   exports to its CSV.
 *
 * @param {ReturnType<typeof parseTranslationViewUri>} parsed
 * @returns {Promise<{title: string, notes: string[], items: {key: string, original: string, header: string}[]}>}
 */
async function collectTranslationViewItems(parsed) {
  const idHint = '"Update CSV files" in Dialogic\'s translation settings adds them.';
  if (parsed.source === 'characters') {
    const names = [...cachedCharacterPaths.keys()].sort((a, b) => (a === parsed.focus ? -1 : b === parsed.focus ? 1 : 0));
    const items = [];
    let withoutId = 0;
    for (const name of names) {
      let info;
      try { info = parseDchCharacterInfo(await readDocumentText(resolveResourcePath(cachedCharacterPaths.get(name)))); } catch (error) { continue; }
      if (!info.translationId) { withoutId++; continue; }
      items.push({ key: `Character/${info.translationId}/name`, original: info.displayName || name, header: `${name} - name` });
      if (info.nicknames.length > 0) { items.push({ key: `Character/${info.translationId}/nicknames`, original: info.nicknames.join(', '), header: `${name} - nicknames (comma-separated)` }); }
    }
    return { title: 'the characters', notes: withoutId > 0 ? [`${withoutId} character(s) have no translation id yet - ${idHint}`] : [], items };
  }
  if (parsed.source === 'glossary') {
    let entries = [];
    try { entries = parseGlossaryResource(await readDocumentText(resolveResourcePath(parsed.glossary)), parsed.glossary); } catch (error) { entries = []; }
    const items = [];
    let withoutId = 0;
    for (const entry of entries) {
      if (!entry.glossaryId || !entry.entryId) { withoutId++; continue; }
      const base = `Glossary/${entry.glossaryId}/${entry.entryId}`;
      const properties = [['name', entry.name], ['alternatives', entry.alternatives.join(', ')], ['text', entry.text], ['extra', entry.extra]];
      for (const [property, original] of properties) {
        if (original) { items.push({ key: `${base}/${property}`, original, header: `${entry.name} - ${property}${property === 'alternatives' ? ' (comma-separated)' : ''}` }); }
      }
    }
    return { title: `the glossary ${parsed.glossary}`, notes: withoutId > 0 ? [`${withoutId} entr(ies) have no translation id yet - ${idHint}`] : [], items };
  }
  const timelineText = await readTimelineText(parsed.timelineUri);
  const withoutId = timelineText.split(/\r?\n/).filter(text => isPlayerFacingTextLine(text) && !/#id:\S+\s*$/.test(text)).length;
  return {
    title: parsed.timelineUri.path.split('/').pop(),
    notes: withoutId > 0 ? [`${withoutId} line(s) of the timeline have no translation id yet - ${idHint}`] : [],
    items: collectTranslatableLines(timelineText).map(({ line, text, entry }) => ({ key: entry.key, original: entry.original, header: `line ${line + 1} - ${describeTranslatableLine(text, entry.key)}` })),
  };
}

/**
 * A timeline's current text: from its editor if it's open (so unsaved
 * edits are included), else from disk.
 *
 * @param {vscode.Uri} timelineUri
 * @returns {Promise<string>}
 */
async function readTimelineText(timelineUri) {
  const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === timelineUri.toString());
  if (open) { return open.getText(); }
  return Buffer.from(await vscode.workspace.fs.readFile(timelineUri)).toString('utf8');
}

/**
 * Who/what a translatable line is, for the block header: the speaker of a
 * dialogue line, "narration", "choice", "label ...", "text input".
 *
 * @param {string} text - the timeline line
 * @param {string} key
 * @returns {string}
 */
function describeTranslatableLine(text, key) {
  if (key.startsWith('Choice/')) { return 'choice'; }
  if (key.startsWith('Label/')) { const label = parseLabelLine(text); return label ? `label ${label.name}` : 'label'; }
  if (key.startsWith('Text Input/')) { return 'text input'; }
  const speakerMatch = text.match(new RegExp(`^\\s*(${CHARACTER_NAME_SOURCE})\\s*(?:\\([^)]*\\))?\\s*:`, 'u'));
  return speakerMatch ? stripCharacterNameQuotes(speakerMatch[1]) : 'narration';
}

/** Line breaks inside a translation are shown as a literal "\n", so each translation stays on one line. */
const escapeViewText = text => text.replace(/\r?\n/g, '\\n');
const unescapeViewText = text => text.replace(/\\n/g, '\n');

/**
 * The translatable lines of a timeline, in order.
 *
 * @param {string} timelineText
 * @returns {{line: number, text: string, entry: {key: string, original: string}}[]}
 */
function collectTranslatableLines(timelineText) {
  const result = [];
  timelineText.split(/\r?\n/).forEach((text, line) => {
    const entry = parseTranslatableLine(text);
    if (entry) { result.push({ line, text, entry }); }
  });
  return result;
}

/**
 * Build the Translation View text of a timeline in one or more languages:
 * per translatable line, its original text then one line per language.
 *
 * @param {vscode.Uri} timelineUri
 * @param {string[]} languages
 * @returns {Promise<string>}
 */
async function buildTranslationView(parsed) {
  const { languages } = parsed;
  const { title, notes, items } = await collectTranslationViewItems(parsed);
  const original = getOriginalLocale() || 'original';
  const progress = languages.map(language => `${language} ${items.filter(item => getTranslation(item.key, language)).length}/${items.length}`).join(', ');
  const lines = [
    `# Translation of ${title} - ${progress} translated.`,
    `# Write the translations after ${languages.map(language => `"${language}:"`).join(', ')} and save (Ctrl+S) to put them in Dialogic's CSV.`,
    `# The "${original}:" lines are the original text, for reference: editing them changes nothing. Unchanged lines are never rewritten.`,
    '# To show other languages, use the globe button at the top right of this editor.',
  ];
  for (const note of notes) { lines.push(`# ${note}`); }
  if (cachedTranslationFiles.length === 0) {
    lines.push('# No Dialogic translation CSV found yet - saving will fail until "Update CSV files" has been run in Dialogic.');
  }
  for (const item of items) {
    lines.push('');
    lines.push(`[${item.key}]  ${item.header}`);
    lines.push(`${original}: ${escapeViewText(item.original)}`);
    for (const language of languages) {
      lines.push(`${language}: ${escapeViewText(getTranslation(item.key, language))}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Read the translations back from a Translation View's text: for each
 * `[key]` block, the text after each "<language>:" (the first one per
 * language counts). A block or a language line deleted by accident is
 * simply left out, so nothing is erased.
 *
 * @param {string} text
 * @param {string[]} languages
 * @returns {Map<string, Map<string, string>>} key -> language -> translation
 */
function parseTranslationView(text, languages) {
  const translations = new Map();
  let currentKey = null;
  for (const line of text.split(/\r?\n/)) {
    const headerMatch = line.match(/^\[([^\]]+)\]/);
    if (headerMatch) {
      currentKey = headerMatch[1];
      continue;
    }
    if (!currentKey) { continue; }
    const language = languages.find(candidate => line.startsWith(`${candidate}:`));
    if (!language) { continue; }
    const byLanguage = translations.get(currentKey) || new Map();
    if (!byLanguage.has(language)) {
      byLanguage.set(language, unescapeViewText(line.slice(language.length + 1).replace(/^ /, '').replace(/\s+$/, '')));
    }
    translations.set(currentKey, byLanguage);
  }
  return translations;
}

/**
 * The virtual file system behind Translation Views. Only the files VS
 * Code opens exist (there are no directories); reading builds the text,
 * writing saves the translations that changed.
 */
class TranslationViewFileSystem {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    /** @type {vscode.Event<vscode.FileChangeEvent[]>} */
    this.onDidChangeFile = this._emitter.event;
    /** Per view URI, when its content last changed - VS Code compares it to detect outside changes. @type {Map<string, number>} */
    this._mtimes = new Map();
    this._suppressRefresh = false;
  }

  watch() { return new vscode.Disposable(() => {}); }

  async stat(uri) {
    const content = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: this._mtimes.get(uri.toString()) || 1, size: content.byteLength };
  }

  async readFile(uri) {
    try {
      return Buffer.from(await buildTranslationView(parseTranslationViewUri(uri)), 'utf8');
    } catch (error) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async writeFile(uri, content) {
    const parsed = parseTranslationViewUri(uri);
    const written = parseTranslationView(Buffer.from(content).toString('utf8'), parsed.languages);
    const changes = [];
    for (const item of (await collectTranslationViewItems(parsed)).items) {
      const byLanguage = written.get(item.key);
      if (!byLanguage) { continue; }
      for (const [language, translation] of byLanguage) {
        if (translation !== getTranslation(item.key, language)) {
          changes.push({ key: item.key, original: item.original, translation, language });
        }
      }
    }
    this._suppressRefresh = true;
    try {
      const count = await writeTranslations(changes, null, parsed.timelineUri || vscode.Uri.file(''));
      this._mtimes.set(uri.toString(), Date.now());
      const touched = [...new Set(changes.map(change => change.language))].join(', ');
      vscode.window.setStatusBarMessage(count > 0 ? `DTL Reader: ${count} translation(s) saved (${touched})` : 'DTL Reader: no translation changed', 4000);
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(`DTL Reader: ${error.message}`);
    } finally {
      this._suppressRefresh = false;
    }
  }

  /**
   * Tell VS Code every open Translation View (optionally only those of one
   * timeline) changed, so the ones without unsaved edits reload.
   *
   * @param {vscode.Uri} [timelineUri]
   */
  refresh(timelineUri) {
    if (this._suppressRefresh) { return; }
    const events = [];
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== TRANSLATION_VIEW_SCHEME) { continue; }
      const viewTimeline = parseTranslationViewUri(document.uri).timelineUri;
      if (timelineUri && (!viewTimeline || viewTimeline.toString() !== timelineUri.toString())) { continue; }
      this._mtimes.set(document.uri.toString(), Date.now());
      events.push({ type: vscode.FileChangeType.Changed, uri: document.uri });
    }
    if (events.length > 0) { this._emitter.fire(events); }
  }

  readDirectory() { return []; }
  createDirectory() { throw vscode.FileSystemError.NoPermissions('Translation Views have no directories.'); }
  delete() { throw vscode.FileSystemError.NoPermissions('Close the Translation View instead.'); }
  rename() { throw vscode.FileSystemError.NoPermissions('Translation Views cannot be renamed.'); }
}

/** @type {TranslationViewFileSystem | null} */
let translationViewFileSystem = null;

/**
 * Whether the translation globe button shows for a file
 * (`dtlReader.translation.globeButton`): "everywhere", "off", or
 * "dialogic" - only files with something to translate: timelines,
 * characters, the glossaries listed in project.godot and Dialogic's
 * translation CSVs. Never without a project.godot: translation works on
 * the project's CSV files.
 *
 * @param {vscode.TextEditor | undefined} editor
 * @returns {boolean}
 */
function shouldShowTranslationGlobe(editor) {
  const mode = vscode.workspace.getConfiguration('dtlReader').get('translation.globeButton', 'dialogic');
  if (mode === 'off' || !editor || !projectRootUri) { return false; } // no project, no translation
  if (mode === 'everywhere') { return true; }
  const document = editor.document;
  if (document.uri.scheme === TRANSLATION_VIEW_SCHEME) { return false; } // it has its own globe
  if (document.languageId === 'dtl' || document.languageId === 'dch') { return true; }
  const fileName = (document.uri.fsPath || '').replace(/\\/g, '/').split('/').pop() || '';
  if (/^dialogic_.*\.csv$/i.test(fileName)) { return true; }
  if (/\.tres$/i.test(fileName)) {
    const resPath = toResPath(document.uri);
    return !!resPath && cachedGlossaryFiles.some(file => file.toLowerCase() === resPath.toLowerCase());
  }
  return false;
}

/** Tell VS Code (context key `dtlReader.showTranslationGlobe`) whether to show the globe for the active editor. */
function updateTranslationGlobeContext() {
  vscode.commands.executeCommand('setContext', 'dtlReader.showTranslationGlobe', shouldShowTranslationGlobe(vscode.window.activeTextEditor));
}

/** Where the last languages picked for the Translation View are remembered (per workspace). @type {vscode.Memento | null} */
let translationViewMemento = null;

/**
 * Ask which languages to show in a Translation View: every locale of the
 * CSVs (except the original), several at once, plus "Other language..." to
 * start a new one. Pre-selects the last choice (or the translation mode
 * language). Doesn't touch any setting.
 *
 * @param {string[]} [current] - languages to pre-select
 * @returns {Promise<string[] | null>} null if cancelled
 */
async function pickTranslationViewLanguages(current) {
  const original = getOriginalLocale();
  const csvTargets = cachedTranslationLocales.filter(locale => locale && locale !== original);
  // Pre-select only languages of this project: the view's own, the last
  // ones picked in this workspace, else the translation-mode language -
  // but that setting may come from another project (User settings), so it
  // only counts if this project's CSV actually has it.
  const settingLanguage = getTranslationLanguage();
  const remembered = current
    || (translationViewMemento && translationViewMemento.get('translationView.languages'))
    || (settingLanguage && csvTargets.includes(settingLanguage) ? [settingLanguage] : []);
  const locales = [...new Set([...csvTargets, ...remembered])].filter(locale => locale && locale !== original);
  const items = locales.map(locale => ({ label: locale, picked: remembered.includes(locale) }));
  items.push({ label: '$(add) Other language...', description: 'a locale code not in the CSV yet, e.g. de or pt_BR', other: true });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'DTL: Translation View languages',
    placeHolder: locales.length === 0
      ? `This project's translations only have the original language${original ? ` ("${original}")` : ''} - pick "Other language..." to add one`
      : `Pick the languages to show${original ? ` (the timelines are written in "${original}")` : ''} - each gets an editable line under every original line`,
  });
  if (!picked) { return null; }
  const languages = picked.filter(item => !item.other).map(item => item.label);
  if (picked.some(item => item.other)) {
    const typed = (await vscode.window.showInputBox({ title: 'DTL: Other language', prompt: 'Locale code(s), comma-separated (e.g. de, pt_BR)' }) || '').split(',').map(code => code.trim()).filter(Boolean);
    languages.push(...typed.filter(code => !languages.includes(code)));
  }
  const valid = languages.filter(language => language !== getOriginalLocale());
  if (valid.length === 0) {
    vscode.window.showInformationMessage('DTL Reader: pick at least one language to translate to.');
    return null;
  }
  if (translationViewMemento) { await translationViewMemento.update('translationView.languages', valid); }
  return valid;
}

/**
 * "DTL: Open Translation View" - asks which languages to show (see
 * pickTranslationViewLanguages) and opens the active timeline's
 * Translation View beside it.
 */
/**
 * The res:// path of a file, if it's inside the Godot project.
 *
 * @param {vscode.Uri} uri
 * @returns {string | null}
 */
function toResPath(uri) {
  if (!projectRootUri || !uri.fsPath) { return null; }
  const root = normalizeFsPath(projectRootUri.fsPath).replace(/\/+$/, '');
  const file = normalizeFsPath(uri.fsPath);
  if (!file.startsWith(root + '/')) { return null; }
  const relative = uri.fsPath.replace(/\\/g, '/').slice(root.length + 1);
  return `res://${relative}`;
}

/**
 * Which Translation View source the active file points to: its timeline,
 * the characters (from a .dch file, that character first), its glossary
 * (from a glossary .tres listed in project.godot) - else ask.
 *
 * @returns {Promise<object | null>}
 */
async function pickTranslationViewSource() {
  const editor = vscode.window.activeTextEditor;
  const document = editor && editor.document;
  if (document && document.languageId === 'dtl' && document.uri.scheme !== TRANSLATION_VIEW_SCHEME) {
    return { source: 'timeline', uri: document.uri };
  }
  if (document && document.languageId === 'dch') {
    return { source: 'characters', focus: findCharacterForDocument(document) };
  }
  const resPath = document ? toResPath(document.uri) : null;
  if (resPath && cachedGlossaryFiles.some(file => file.toLowerCase() === resPath.toLowerCase())) {
    return { source: 'glossary', file: cachedGlossaryFiles.find(file => file.toLowerCase() === resPath.toLowerCase()) };
  }
  const items = [
    { label: 'Characters and glossaries', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(person) Characters', description: 'every character\'s name and nicknames', target: { source: 'characters' } },
  ];
  for (const file of cachedGlossaryFiles) { items.push({ label: `$(book) ${file.split('/').pop()}`, description: `glossary - ${file}`, target: { source: 'glossary', file } }); }
  let timelineUris = [];
  try { timelineUris = (await vscode.workspace.findFiles('**/*.dtl', '**/{.git,.godot,node_modules}/**')).filter(uri => /\.dtl$/i.test(uri.fsPath)); } catch (error) { timelineUris = []; }
  if (timelineUris.length > 0) {
    items.push({ label: 'Timelines', kind: vscode.QuickPickItemKind.Separator });
    timelineUris
      .map(uri => ({ uri, resPath: toResPath(uri) || uri.fsPath }))
      .sort((a, b) => a.resPath.localeCompare(b.resPath))
      .forEach(({ uri, resPath }) => items.push({ label: `$(file) ${uri.fsPath.replace(/\\/g, '/').split('/').pop().replace(/\.dtl$/i, '')}`, description: resPath, target: { source: 'timeline', uri } }));
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'DTL: What to translate', placeHolder: 'The characters, a glossary or a timeline', matchOnDescription: true });
  return picked && picked.target ? picked.target : null;
}

/**
 * "DTL: Open Translation View" - asks which languages to show (see
 * pickTranslationViewLanguages) and opens the Translation View of the
 * active timeline, of the characters (from a .dch file) or of a glossary
 * (from its .tres file) - or asks which one - beside the current editor.
 */
async function openTranslationViewCommand() {
  if (translationUnavailable()) { return; }
  const target = await pickTranslationViewSource();
  if (!target) { return; }
  const languages = await pickTranslationViewLanguages();
  if (!languages) { return; }
  const document = await vscode.workspace.openTextDocument(translationViewUri(target, languages));
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

/**
 * "DTL: Change Translation View Languages" - from a Translation View, pick
 * other languages and replace it with a view of the same timeline in
 * those languages, in the same place. The old tab is closed unless it has
 * unsaved edits (then both stay open, so nothing is lost).
 */
async function changeTranslationViewLanguagesCommand() {
  if (translationUnavailable()) { return; }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== TRANSLATION_VIEW_SCHEME) { return; }
  const oldDocument = editor.document;
  const parsed = parseTranslationViewUri(oldDocument.uri);
  const languages = await pickTranslationViewLanguages(parsed.languages);
  if (!languages) { return; }
  const document = await vscode.workspace.openTextDocument(translationViewUri(translationViewTarget(parsed), languages));
  await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preview: false });
  if (!oldDocument.isDirty && vscode.window.tabGroups) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input && tab.input.uri && tab.input.uri.toString() === oldDocument.uri.toString()) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }
}

/** Set while one editor scrolls the other, so the other's own move doesn't bounce back. */
let syncingTranslationScroll = false;

/**
 * Keep a timeline and its Translation View on the same line: moving the
 * cursor in one scrolls the other to the matching block / line.
 *
 * @param {vscode.TextEditorSelectionChangeEvent} event
 */
function syncTranslationScroll(event) {
  if (syncingTranslationScroll) { return; }
  const editor = event.textEditor;
  const document = editor.document;
  const cursorLine = editor.selection.active.line;
  let key = null;
  let targets = [];
  let findLine = null;

  if (document.languageId === 'dtl' && document.uri.scheme !== TRANSLATION_VIEW_SCHEME) {
    const entry = parseTranslatableLine(document.lineAt(cursorLine).text);
    if (!entry) { return; }
    key = entry.key;
    targets = vscode.window.visibleTextEditors.filter(other => {
      if (other.document.uri.scheme !== TRANSLATION_VIEW_SCHEME) { return false; }
      const viewTimeline = parseTranslationViewUri(other.document.uri).timelineUri;
      return !!viewTimeline && viewTimeline.toString() === document.uri.toString();
    });
    findLine = other => {
      for (let line = 0; line < other.document.lineCount; line++) {
        if (other.document.lineAt(line).text.startsWith(`[${key}]`)) { return line; }
      }
      return -1;
    };
  } else if (document.uri.scheme === TRANSLATION_VIEW_SCHEME) {
    for (let line = cursorLine; line >= 0 && !key; line--) {
      const headerMatch = document.lineAt(line).text.match(/^\[([^\]]+)\]/);
      if (headerMatch) { key = headerMatch[1]; }
    }
    if (!key) { return; }
    const viewTimeline = parseTranslationViewUri(document.uri).timelineUri;
    if (!viewTimeline) { return; } // character / glossary views have no single file to follow
    const timelineUri = viewTimeline.toString();
    targets = vscode.window.visibleTextEditors.filter(other => other.document.uri.toString() === timelineUri);
    findLine = other => {
      for (let line = 0; line < other.document.lineCount; line++) {
        const entry = parseTranslatableLine(other.document.lineAt(line).text);
        if (entry && entry.key === key) { return line; }
      }
      return -1;
    };
  } else {
    return;
  }

  syncingTranslationScroll = true;
  try {
    for (const other of targets) {
      const line = findLine(other);
      if (line !== -1) { other.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport); }
    }
  } finally {
    setTimeout(() => { syncingTranslationScroll = false; }, 50);
  }
}

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
  if (document.uri.scheme === TRANSLATION_VIEW_SCHEME) {
    const localeMatch = text.match(/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*:/);
    return localeMatch ? localeMatch[0].length : -1;
  }
  // A narration line can start with a BBCode tag ("[b]Hello[/b]"), which
  // isPlayerFacingTextLine treats as a bracket command line - it's text
  // unless that first tag is one of Dialogic's own commands.
  const leadingTag = text.match(/^\s*\[\/?([A-Za-z_][A-Za-z0-9_]*)/);
  if (leadingTag) { return RESERVED_BRACKET_NAMES.has(leadingTag[1]) ? -1 : 0; }
  if (!isPlayerFacingTextLine(text)) { return -1; }
  const speakerMatch = text.match(new RegExp(`^\\s*${CHARACTER_NAME_SOURCE}\\s*(?:\\([^)]*\\))?\\s*:`, 'u'));
  return speakerMatch ? speakerMatch[0].length : 0;
}

/** Decoration type per unique merged style (JSON key). @type {Map<string, vscode.TextEditorDecorationType>} */
const bbcodeDecorationTypes = new Map();

/** Shows a [char=...] tag's character after it. @type {vscode.TextEditorDecorationType | null} */
let bbcodeCharDecorationType = null;

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
            if (projectRootUri && /^res:\/\//.test(imagePath)) {
              hover = new vscode.MarkdownString(`![${imagePath}](${resolveResourcePath(imagePath).toString()}|height=128)\n\n\`${imagePath}\``);
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
  if (!editor || !bbcodeCharDecorationType) { return; }
  const document = editor.document;
  const applies = document.languageId === 'dtl' || document.uri.scheme === TRANSLATION_VIEW_SCHEME;
  const enabled = applies && vscode.workspace.getConfiguration('dtlReader').get('preview.bbcodeEffects', true);
  const { byType, chars } = enabled ? computeBbcodePreview(document) : { byType: new Map(), chars: [] };
  for (const type of bbcodeDecorationTypes.values()) { editor.setDecorations(type, byType.get(type) || []); }
  editor.setDecorations(bbcodeCharDecorationType, chars);
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
      .forEach(editor => { updateBbcodePreview(editor); updateGlossaryDecorations(editor); });
  }, document ? 150 : 0));
}

// =============================================================================
// LABEL REFERENCES, RENAME AND CODE LENS
// =============================================================================
// Every place that jumps to a label: `jump name` in its own timeline, and
// `jump Timeline/name` in any timeline. Powers Find All References
// (Shift+F12), Rename (F2) and the "N jumps here" link above each label.

/**
 * The label under the cursor, on its `label` line or as a `jump` target -
 * as the timeline file it's declared in, that timeline's identifier, its
 * name, and the range of the name under the cursor.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{uri: vscode.Uri, identifier: string|null, name: string, range: vscode.Range} | null}
 */
function resolveLabelAt(document, position) {
  const text = document.lineAt(position.line).text;
  const covers = (start, length) => position.character >= start && position.character <= start + length;
  const label = parseLabelLine(text);
  if (label && covers(label.nameStart, label.name.length)) {
    return { uri: document.uri, identifier: findTimelineIdentifier(document), name: label.name, range: new vscode.Range(position.line, label.nameStart, position.line, label.nameStart + label.name.length) };
  }
  const jump = parseJumpLine(text);
  if (!jump || !jump.label || jump.target.includes('{') || !covers(jump.labelStart, jump.label.length)) { return null; }
  const range = new vscode.Range(position.line, jump.labelStart, position.line, jump.labelStart + jump.label.length);
  if (jump.timeline === null) {
    return { uri: document.uri, identifier: findTimelineIdentifier(document), name: jump.label, range };
  }
  const resPath = cachedTimelinePaths.get(jump.timeline);
  return resPath ? { uri: resolveResourcePath(resPath), identifier: jump.timeline, name: jump.label, range } : null;
}

/**
 * Every timeline of the workspace with its current text (open editors'
 * live text, else the file on disk) and its Dialogic identifier.
 *
 * @param {vscode.TextDocument} [current] - always included, even if not found by the search
 * @returns {Promise<{uri: vscode.Uri, identifier: string|null, lines: string[]}[]>}
 */
async function readAllTimelines(current) {
  // Without a project, a timeline is on its own: other files can't be
  // reached (no timeline directory), so only the current one is read.
  if (!projectRootUri && current) {
    return [{ uri: current.uri, identifier: null, lines: current.getText().split(/\r?\n/) }];
  }
  let uris = [];
  try { uris = (await vscode.workspace.findFiles('**/*.dtl', '**/{.git,.godot,node_modules}/**')).filter(uri => /\.dtl$/i.test(uri.fsPath)); } catch (error) { uris = []; }
  if (current && !uris.some(uri => normalizeFsPath(uri.fsPath) === normalizeFsPath(current.uri.fsPath || ''))) { uris.push(current.uri); }
  const timelines = [];
  for (const uri of uris) {
    try {
      const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath && normalizeFsPath(document.uri.fsPath) === normalizeFsPath(uri.fsPath));
      const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const identifier = findTimelineIdentifier({ uri });
      timelines.push({ uri: open ? open.uri : uri, identifier, lines: text.split(/\r?\n/) });
    } catch (error) {
      // unreadable timeline - skip it
    }
  }
  return timelines;
}

/**
 * Where a label is declared and every jump to it, in every timeline.
 *
 * @param {{uri: vscode.Uri, identifier: string|null, name: string}} target
 * @param {{uri: vscode.Uri, identifier: string|null, lines: string[]}[]} timelines - from readAllTimelines
 * @returns {{declaration: vscode.Location|null, jumps: vscode.Location[]}}
 */
function findLabelLocations(target, timelines) {
  let declaration = null;
  const jumps = [];
  const targetPath = normalizeFsPath(target.uri.fsPath || '');
  for (const timeline of timelines) {
    const isTarget = normalizeFsPath(timeline.uri.fsPath || '') === targetPath;
    timeline.lines.forEach((text, line) => {
      if (isTarget && !declaration) {
        const label = parseLabelLine(text);
        if (label && label.name === target.name) {
          declaration = new vscode.Location(timeline.uri, new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length));
          return;
        }
      }
      const jump = parseJumpLine(text);
      if (!jump || jump.target.includes('{') || jump.label !== target.name) { return; }
      const pointsHere = jump.timeline === null ? isTarget : (target.identifier !== null && jump.timeline === target.identifier);
      if (pointsHere) {
        jumps.push(new vscode.Location(timeline.uri, new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length)));
      }
    });
  }
  return { declaration, jumps };
}

/**
 * Find All References (Shift+F12) on a label or a jump target.
 */
async function provideLabelReferences(document, position, context) {
  const target = resolveLabelAt(document, position);
  if (!target) { return undefined; }
  const { declaration, jumps } = findLabelLocations(target, await readAllTimelines(document));
  return context && context.includeDeclaration && declaration ? [declaration, ...jumps] : jumps;
}

/**
 * What a label may be renamed to, the way Dialogic parses labels and jumps:
 * not empty, and none of the characters that would end or split it -
 * "(" (display name), "/" (timeline separator), "#" (translation id or
 * comment), "{" "}" (variables).
 *
 * @param {string} name
 * @returns {string | null} why it's not valid, or null
 */
function validateLabelName(name) {
  if (!name.trim()) { return 'A label name can\'t be empty.'; }
  if (name !== name.trim()) { return 'A label name can\'t start or end with a space.'; }
  const bad = name.match(/[()/#{}\r\n]/);
  return bad ? `A label name can't contain "${bad[0]}" - Dialogic would read it as part of the syntax.` : null;
}

const labelRenameProvider = {
  prepareRename(document, position) {
    const target = resolveLabelAt(document, position);
    if (!target) { throw new Error('Only a label (on its "label" line or in a "jump") can be renamed here.'); }
    return { range: target.range, placeholder: target.name };
  },
  async provideRenameEdits(document, position, newName) {
    const target = resolveLabelAt(document, position);
    if (!target) { return undefined; }
    const problem = validateLabelName(newName);
    if (problem) { throw new Error(problem); }
    const timelines = await readAllTimelines(document);
    const { declaration, jumps } = findLabelLocations(target, timelines);
    if (newName !== target.name && findLabelLocations({ ...target, name: newName }, timelines).declaration) {
      throw new Error(`This timeline already has a label named "${newName}".`);
    }
    const edit = new vscode.WorkspaceEdit();
    for (const location of [declaration, ...jumps].filter(Boolean)) { edit.replace(location.uri, location.range, newName); }
    return edit;
  },
};

/**
 * "N jumps here" above each label (`dtlReader.codeLens.labelReferences`);
 * clicking it lists them (like Find All References).
 */
async function provideLabelCodeLenses(document) {
  if (!vscode.workspace.getConfiguration('dtlReader').get('codeLens.labelReferences', true)) { return []; }
  const labels = [];
  for (let line = 0; line < document.lineCount; line++) {
    const label = parseLabelLine(document.lineAt(line).text);
    if (label) { labels.push({ line, label }); }
  }
  if (labels.length === 0) { return []; }
  const timelines = await readAllTimelines(document);
  const identifier = findTimelineIdentifier(document);
  return labels.map(({ line, label }) => {
    const { jumps } = findLabelLocations({ uri: document.uri, identifier, name: label.name }, timelines);
    const position = new vscode.Position(line, label.nameStart);
    const title = jumps.length === 0 ? 'no jump here' : `${jumps.length} jump${jumps.length > 1 ? 's' : ''} here`;
    return new vscode.CodeLens(new vscode.Range(position, position), jumps.length === 0
      ? { title, command: '' }
      : { title, command: 'editor.action.showReferences', arguments: [document.uri, position, jumps] });
  });
}

// =============================================================================
// GLOSSARY
// =============================================================================
// Dialogic's glossaries (.tres DialogicGlossary resources listed in
// project.godot's `dialogic/glossary/glossary_files`): words that get a
// colored link in the game's text, with a title, a text and extra info.
// Here, those words get their color with a dotted underline in dialogue,
// narration and choices, and hovering one shows the entry.

/**
 * @typedef {{
 *   key: string, name: string, alternatives: string[], title: string, text: string, extra: string,
 *   color: string|null, caseSensitive: boolean|null, file: string,
 *   glossaryId: string|null, entryId: string|null
 * }} GlossaryEntry
 */

/** Every enabled glossary entry of the project. @type {GlossaryEntry[]} */
let cachedGlossaryEntries = [];

/** project.godot's `dialogic/glossary/default_color` (Godot's POWDER_BLUE by default), as CSS. @type {string} */
let glossaryDefaultColor = 'rgba(176, 224, 230, 1)';

/** project.godot's `dialogic/glossary/default_case_sensitive` (true by default). @type {boolean} */
let glossaryDefaultCaseSensitive = true;

/** The glossary files listed in project.godot. @type {string[]} */
let cachedGlossaryFiles = [];

/** One regular expression per entry (its name and alternatives, plus their translation in translation mode). @type {{entry: GlossaryEntry, pattern: RegExp}[]} */
let glossaryPatterns = [];

/** What glossaryPatterns were built for ("<language>|<translations version>"). @type {string|null} */
let glossaryPatternsKey = null;

/** Bumped whenever the translation CSVs are re-read, so glossary patterns follow them. @type {number} */
let translationsVersion = 0;

/**
 * The glossary patterns for the current translation language: like
 * Dialogic in a translated game, an entry is also recognized by its
 * translated name and alternatives (CSV keys .../name and .../alternatives,
 * comma-separated).
 *
 * @returns {{entry: GlossaryEntry, pattern: RegExp}[]}
 */
function getGlossaryPatterns() {
  const language = getTranslationLanguage() || '';
  const key = `${language}|${translationsVersion}`;
  if (key === glossaryPatternsKey) { return glossaryPatterns; }
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  glossaryPatterns = cachedGlossaryEntries.filter(entry => entry.name).map(entry => {
    const words = [entry.name, ...entry.alternatives];
    if (language && entry.glossaryId && entry.entryId) {
      const base = `Glossary/${entry.glossaryId}/${entry.entryId}`;
      words.push(getTranslation(`${base}/name`, language), ...getTranslation(`${base}/alternatives`, language).split(',').map(word => word.trim()));
    }
    const unique = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRegex);
    const caseSensitive = entry.caseSensitive === null ? glossaryDefaultCaseSensitive : entry.caseSensitive;
    // Whole words, like Dialogic's (?<=\W|^)(?<!\\)(word)(?!])(?=\W|$)
    return { entry, pattern: new RegExp(`(?<![\\p{L}\\p{N}_\\\\])(?:${unique.join('|')})(?![\\p{L}\\p{N}_\\]])`, caseSensitive ? 'gu' : 'giu') };
  });
  glossaryPatternsKey = key;
  return glossaryPatterns;
}

/**
 * Read a GDScript literal value as text: a quoted string (unescaped), or
 * the raw value otherwise.
 *
 * @param {string|null} raw
 * @returns {string}
 */
function gdLiteralToText(raw) {
  if (raw === null || raw === undefined) { return ''; }
  const match = raw.match(/^&?"((?:[^"\\]|\\.)*)"$/);
  return match ? match[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(.)/g, '$1') : raw;
}

/**
 * The strings of a GDScript array literal - `["a", "b"]` or
 * `PackedStringArray("a", "b")`.
 *
 * @param {string|null} raw
 * @returns {string[]}
 */
function gdArrayToStrings(raw) {
  if (!raw) { return []; }
  const strings = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) { strings.push(match[1].replace(/\\(.)/g, '$1')); }
  return strings;
}

/**
 * Parse a DialogicGlossary `.tres` file into its entries. Its `entries`
 * dictionary maps each entry name to the entry (a dictionary), and each
 * alternative word to the entry's name (a plain string) - only the
 * dictionaries are entries.
 *
 * @param {string} text - raw .tres content
 * @param {string} file - its res:// path
 * @returns {GlossaryEntry[]}
 */
function parseGlossaryResource(text, file) {
  const resourceSection = text.slice(Math.max(0, text.indexOf('[resource]')));
  if (/(?:^|\n)enabled\s*=\s*false/.test(resourceSection)) { return []; }
  const glossaryIdMatch = resourceSection.match(/(?:^|\n)_translation_id\s*=\s*"([^"]*)"/);
  const headerMatch = resourceSection.match(/(?:^|\n)entries\s*=\s*\{/);
  if (!headerMatch) { return []; }
  const body = extractBalancedBraces(resourceSection, headerMatch.index + headerMatch[0].length - 1);
  if (body === null) { return []; }
  const entries = [];
  for (const { key, childBody } of scanDictEntries(body)) {
    if (childBody === null) { continue; } // an alternative -> entry name alias
    const fields = new Map(scanDictEntries(childBody).map(field => [field.key, field.rawValue]));
    if (fields.get('enabled') === 'false') { continue; }
    const caseSensitive = fields.get('case_sensitive');
    entries.push({
      key,
      name: gdLiteralToText(fields.get('name')) || key,
      alternatives: gdArrayToStrings(fields.get('alternatives')),
      title: gdLiteralToText(fields.get('title')),
      text: gdLiteralToText(fields.get('text')),
      extra: gdLiteralToText(fields.get('extra')),
      color: fields.get('color') ? parseGodotColor(fields.get('color')) : null,
      caseSensitive: caseSensitive === 'true' ? true : caseSensitive === 'false' ? false : null,
      file,
      glossaryId: glossaryIdMatch ? glossaryIdMatch[1] : null,
      entryId: fields.has('_translation_id') ? gdLiteralToText(fields.get('_translation_id')) : null,
    });
  }
  return entries;
}

/**
 * Re-read the glossary settings and files listed in project.godot.
 *
 * @param {string} dialogicSection - project.godot's [dialogic] section text
 */
async function refreshGlossaries(dialogicSection) {
  const filesMatch = dialogicSection.match(/(?:^|\n)glossary\/glossary_files\s*=\s*([^\n]*)/);
  const colorMatch = dialogicSection.match(/(?:^|\n)glossary\/default_color\s*=\s*(Color\([^)]*\))/);
  const caseMatch = dialogicSection.match(/(?:^|\n)glossary\/default_case_sensitive\s*=\s*(true|false)/);
  glossaryDefaultColor = (colorMatch && parseGodotColor(colorMatch[1])) || 'rgba(176, 224, 230, 1)';
  glossaryDefaultCaseSensitive = caseMatch ? caseMatch[1] === 'true' : true;
  const entries = [];
  for (const file of gdArrayToStrings(filesMatch ? filesMatch[1] : '')) {
    try {
      entries.push(...parseGlossaryResource(Buffer.from(await vscode.workspace.fs.readFile(resolveResourcePath(file))).toString('utf8'), file));
    } catch (error) {
      console.error(`DTL Reader: glossary "${file}" (from project.godot) could not be read.`, error);
    }
  }
  cachedGlossaryEntries = entries;
  cachedGlossaryFiles = gdArrayToStrings(filesMatch ? filesMatch[1] : '');
  glossaryPatternsKey = null; // rebuilt on next use
}

/**
 * Glossary words of one line: which entry, and where - only in its
 * player-facing text, never inside a `[tag]` or a `{variable}`.
 *
 * @param {vscode.TextDocument} document
 * @param {string} text
 * @returns {{entry: GlossaryEntry, start: number, end: number}[]}
 */
function findGlossaryWords(document, text) {
  const patterns = getGlossaryPatterns();
  if (patterns.length === 0) { return []; }
  const from = bbcodePreviewStart(document, text);
  if (from === -1) { return []; }
  const blocked = new Array(text.length).fill(false);
  const blockPattern = /\[[^\]]*\]|\{[^}]*\}|#id:\S+/g;
  let block;
  while ((block = blockPattern.exec(text)) !== null) { for (let i = block.index; i < block.index + block[0].length; i++) { blocked[i] = true; } }
  const found = [];
  const taken = new Array(text.length).fill(false);
  for (const { entry, pattern } of patterns) {
    pattern.lastIndex = from;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      let free = true;
      for (let i = start; i < end; i++) { if (blocked[i] || taken[i]) { free = false; break; } }
      if (!free) { continue; }
      for (let i = start; i < end; i++) { taken[i] = true; }
      found.push({ entry, start, end });
    }
  }
  return found;
}

/**
 * Hover on a glossary word: its title, text and extra info (translated in
 * translation mode), and the glossary it comes from.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.Hover | undefined}
 */
function provideGlossaryHover(document, position) {
  const text = document.lineAt(position.line).text;
  const hit = findGlossaryWords(document, text).find(word => position.character >= word.start && position.character <= word.end);
  if (!hit) { return undefined; }
  const { entry } = hit;
  const language = getTranslationLanguage();
  const translated = property => {
    if (!language || !entry.glossaryId || !entry.entryId) { return ''; }
    return getTranslation(`Glossary/${entry.glossaryId}/${entry.entryId}/${property}`, language);
  };
  const markdown = new vscode.MarkdownString();
  const title = translated('title') || (language ? translated('name') : '') || entry.title || entry.name;
  markdown.appendMarkdown(entry.color || glossaryDefaultColor ? `${createColoredTitleMarkdown(title, entry.color || glossaryDefaultColor)}\n\n` : `**${title}**\n\n`);
  const body = translated('text') || entry.text;
  if (body) { markdown.appendMarkdown(`${body}\n\n`); }
  const extra = translated('extra') || entry.extra;
  if (extra) { markdown.appendMarkdown(`_${extra}_\n\n`); }
  const words = [entry.name, ...entry.alternatives].filter(word => word !== title);
  markdown.appendMarkdown(`Glossary \`${entry.file}\`${words.length > 0 ? ` - also written: ${words.map(word => `\`${word}\``).join(', ')}` : ''}`);
  return new vscode.Hover(markdown, new vscode.Range(position.line, hit.start, position.line, hit.end));
}

/**
 * Go to Definition (Ctrl+click) on a glossary word: the entry in its
 * glossary `.tres` file - the line of its key in the `entries` dictionary.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.Location | undefined>}
 */
async function provideGlossaryDefinition(document, position) {
  const hit = findGlossaryWords(document, document.lineAt(position.line).text)
    .find(word => position.character >= word.start && position.character <= word.end);
  if (!hit || !projectRootUri) { return undefined; }
  const uri = resolveResourcePath(hit.entry.file);
  let text;
  try { text = await readDocumentText(uri); } catch (error) { return undefined; }
  const entriesStart = Math.max(0, text.search(/(?:^|\n)entries\s*=\s*\{/));
  const escapedKey = hit.entry.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\\\"');
  const keyMatch = new RegExp(`&?"${escapedKey}"\\s*:\\s*\\{`).exec(text.slice(entriesStart));
  const offset = keyMatch ? entriesStart + keyMatch.index + (keyMatch[0].startsWith('&') ? 1 : 0) : 0;
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) || []).length;
  const character = offset - (before.lastIndexOf('\n') + 1);
  return new vscode.Location(uri, new vscode.Position(line, character));
}

/** Decoration type per glossary color. @type {Map<string, vscode.TextEditorDecorationType>} */
const glossaryDecorationTypes = new Map();

/**
 * Color the glossary words of an editor (`dtlReader.preview.glossary`),
 * like Dialogic does in the game, with a dotted underline to show they
 * can be hovered.
 *
 * @param {vscode.TextEditor} editor
 */
function updateGlossaryDecorations(editor) {
  if (!editor) { return; }
  const document = editor.document;
  const applies = document.languageId === 'dtl' || document.uri.scheme === TRANSLATION_VIEW_SCHEME;
  const enabled = applies && vscode.workspace.getConfiguration('dtlReader').get('preview.glossary', true);
  const byColor = new Map();
  if (enabled) {
    for (let line = 0; line < document.lineCount; line++) {
      for (const word of findGlossaryWords(document, document.lineAt(line).text)) {
        const color = word.entry.color || glossaryDefaultColor;
        if (!byColor.has(color)) { byColor.set(color, []); }
        byColor.get(color).push(new vscode.Range(line, word.start, line, word.end));
      }
    }
  }
  for (const color of byColor.keys()) {
    if (!glossaryDecorationTypes.has(color)) {
      glossaryDecorationTypes.set(color, vscode.window.createTextEditorDecorationType({ color, textDecoration: 'underline dotted' }));
    }
  }
  for (const [color, type] of glossaryDecorationTypes) { editor.setDecorations(type, byColor.get(color) || []); }
}

/**
 * Glossary words as suggestions while writing dialogue.
 *
 * @param {string} prefix - lowercase word fragment typed so far
 * @returns {vscode.CompletionItem[]}
 */
function createGlossaryWordSuggestions(prefix) {
  const items = [];
  for (const entry of cachedGlossaryEntries) {
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

// =============================================================================
// ISOLATED MODE (no project.godot)
// =============================================================================
// With a Godot project, autocomplete knows the project's characters,
// moods, variables, audio channels and files. Without one, a timeline is
// on its own: autocomplete then offers what the timeline itself already
// uses - its speakers and joined characters, their (mood) tags, its
// {variables}, its audio channels and its res:// paths - so it stays
// useful while never pretending to know the project.

/**
 * What a timeline itself declares or uses, for autocomplete without a
 * project. Set by the completion provider before each request (null when
 * there is a project).
 *
 * @type {{characters: Set<string>, moods: Map<string, Set<string>>, variables: Map, audio: Set<string>, paths: Set<string>} | null}
 */
let isolatedDocumentData = null;

/**
 * Scan a timeline for its own characters, moods, variables, audio
 * channels and res:// paths.
 *
 * @param {vscode.TextDocument} document
 * @param {number} [skipLine] - the line being typed: a half-written name or path there isn't something the timeline uses yet
 */
function collectIsolatedDocumentData(document, skipLine) {
  const data = { characters: new Set(), moods: new Map(), variables: new Map(), audio: new Set(), paths: new Set() };
  const commandPattern = new RegExp(`^\\s*(?:join|update|leave)\\s+(${CHARACTER_NAME_SOURCE})(?:\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\))?`, 'u');
  const addMood = (name, mood) => {
    if (!mood) { return; }
    if (!data.moods.has(name)) { data.moods.set(name, new Set()); }
    data.moods.get(name).add(mood);
  };
  for (let line = 0; line < document.lineCount; line++) {
    if (line === skipLine) { continue; }
    const text = document.lineAt(line).text;
    const command = text.match(commandPattern);
    if (command) {
      const name = stripCharacterNameQuotes(command[1]);
      if (name !== '--All--') { data.characters.add(name); addMood(name, command[2]); }
    } else {
      const speaker = findLineSpeaker(text);
      if (speaker) { data.characters.add(speaker.name); addMood(speaker.name, speaker.mood); }
    }
    const audio = text.match(/^\s*audio\s+([^\s"]+)/);
    if (audio) { data.audio.add(audio[1]); }
    for (const match of text.matchAll(/res:\/\/[^"'\s\]]+/g)) { data.paths.add(match[0]); }
    for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g)) {
      let level = data.variables;
      const segments = match[1].split('.');
      segments.forEach((segment, index) => {
        const isLeaf = index === segments.length - 1;
        if (!level.has(segment)) { level.set(segment, { value: null, children: isLeaf ? null : new Map() }); }
        const entry = level.get(segment);
        if (!isLeaf && !entry.children) { entry.children = new Map(); } // also used as a folder
        level = entry.children;
      });
    }
  }
  return data;
}

/** Characters for autocomplete: the project's, else the timeline's own. @returns {string[]} */
function completionCharacterNames() {
  return projectRootUri || !isolatedDocumentData ? cachedCharacterNames : [...isolatedDocumentData.characters];
}

/** A character's moods for autocomplete: the project's (mood -> LayeredPortrait tree), else the ones the timeline gives them. */
function completionCharacterMoods(name) {
  if (projectRootUri || !isolatedDocumentData) { return cachedCharacterMoods.get(name); }
  const moods = isolatedDocumentData.moods.get(name);
  return moods ? new Map([...moods].map(mood => [mood, null])) : undefined;
}

/** Variables tree for autocomplete: project.godot's, else the {variables} the timeline uses. */
function completionVariablesTree() {
  return projectRootUri || !isolatedDocumentData ? cachedVariablesTree : isolatedDocumentData.variables;
}

/** Audio channels for autocomplete: the project's, else the ones the timeline uses. @returns {string[]} */
function completionAudioChannels() {
  return projectRootUri || !isolatedDocumentData ? cachedAudioChannels : [...isolatedDocumentData.audio];
}

/** res:// paths for autocomplete: the project's files, else the paths the timeline already uses. @returns {string[]} */
function completionResourcePaths() {
  return projectRootUri || !isolatedDocumentData ? cachedResourcePaths : [...isolatedDocumentData.paths];
}

// =============================================================================
// CUSTOM EVENTS
// =============================================================================
// Dialogic events the project adds itself: scripts extending DialogicEvent
// in Dialogic's extensions folder (project setting `dialogic/extensions_folder`,
// `res://addons/dialogic_additions/` by default). A shortcode event -
// `get_shortcode()` returning its name and `get_shortcode_parameters()` its
// parameters - is written `[name param=value]` in a timeline, like the
// built-in bracket events. Each one found is added to DTL_ENTRIES (and its
// values to DTL_ATTRIBUTE_VALUE_SUGGESTIONS), so completion, parameters,
// values and hover treat it exactly like a built-in event.

/** Names of the custom events currently in DTL_ENTRIES. @type {string[]} */
let customEventNames = [];

/**
 * Parse a custom event script into a DTL_ENTRIES entry (plus its parameter
 * values), from what Dialogic reads: `event_name`, `event_description`,
 * `get_shortcode()` and `get_shortcode_parameters()` - each parameter
 * documented by the `##` comment of the property it sets, with its type
 * and default.
 *
 * @param {string} text - the .gd file
 * @param {string} resPath - where it is, shown in the documentation
 * @returns {{entry: object, values: Record<string, string[]>} | null} null if it isn't a shortcode event
 */
function parseCustomEventScript(text, resPath) {
  if (!/^\s*extends\s+DialogicEvent\b/m.test(text)) { return null; }
  const shortcode = (text.match(/func\s+get_shortcode\s*\([^)]*\)[^:\n]*:\s*(?:#[^\n]*)?\n\s*return\s+["']([A-Za-z_][A-Za-z0-9_]*)["']/) || [])[1];
  if (!shortcode) { return null; }
  const eventName = (text.match(/\bevent_name\s*=\s*["']([^"'\n]*)["']/) || [])[1] || shortcode;
  const description = (text.match(/\bevent_description\s*=\s*["']([^"'\n]*)["']/) || [])[1] || '';
  const symbols = parseGdScript(text);
  const variables = {};
  const values = {};
  const defaults = {};
  const header = text.match(/func\s+get_shortcode_parameters\s*\([^)]*\)[^:\n]*:/);
  const openIndex = header ? text.indexOf('{', header.index + header[0].length) : -1;
  const body = openIndex === -1 ? null : extractBalancedBraces(text, openIndex);
  for (const { key, body: parameter } of body ? extractTopLevelDictEntries(body) : []) {
    const property = (parameter.match(/["']property["']\s*:\s*["']([^"']+)["']/) || [])[1] || key;
    const defaultValue = ((parameter.match(/["']default["']\s*:\s*([^,}\n]+)/) || [])[1] || '').trim();
    const info = symbols.variables.get(property);
    // A `### Section` title above the first property isn't its documentation.
    const doc = info && info.doc ? info.doc.split('\n').filter(line => !line.startsWith('#')).join(' ').trim() : '';
    const type = info && info.type ? info.type : '';
    const details = [type && `\`${type}\``, defaultValue && `default \`${defaultValue}\``].filter(Boolean).join(', ');
    variables[key] = `${doc || `Sets \`${property}\`.`}${details ? ` (${details})` : ''}`;
    defaults[key] = defaultValue;
    const suggested = [...parameter.matchAll(/["']value["']\s*:\s*([^,}\n]+)/g)].map(match => match[1].trim().replace(/^["']|["']$/g, ''));
    if (suggested.length > 0) { values[key] = suggested; }
    else if (type === 'bool' || /^(?:true|false)$/.test(defaultValue) || (info && /^(?:true|false)$/.test(info.defaultValue || ''))) { values[key] = ['true', 'false']; }
  }
  const firstParameter = Object.keys(variables)[0];
  // The example sets the first parameter to a suggested value, else its default.
  const exampleValue = firstParameter && (values[firstParameter] ? values[firstParameter][0] : (defaults[firstParameter] || '""'));
  return {
    entry: {
      name: shortcode,
      type: 'bracket',
      syntax: `[${shortcode} ...]`,
      description: `${eventName !== shortcode ? `${eventName}: ` : ''}${description || 'A custom Dialogic event.'}\n\n_Custom event, from \`${resPath}\`._`,
      example: firstParameter ? `[${shortcode} ${firstParameter}=${exampleValue}]` : `[${shortcode}]`,
      variables,
      custom: true,
    },
    values,
  };
}

/**
 * Re-read the custom events of the project's Dialogic extensions folder
 * into DTL_ENTRIES, replacing the previous ones. A built-in event of the
 * same name wins.
 *
 * @param {string} dialogicSection - project.godot's [dialogic] section
 */
async function refreshCustomEvents(dialogicSection) {
  for (const name of customEventNames) {
    const index = DTL_ENTRIES.findIndex(entry => entry.custom && entry.name === name);
    if (index !== -1) { DTL_ENTRIES.splice(index, 1); }
    delete DTL_ATTRIBUTE_VALUE_SUGGESTIONS[name];
  }
  customEventNames = [];
  if (!projectRootUri) { return; }
  const folderMatch = dialogicSection.match(/(?:^|\n)extensions_folder\s*=\s*"([^"]*)"/);
  const folder = (folderMatch ? folderMatch[1] : 'res://addons/dialogic_additions/').replace(/\/?$/, '/');
  for (const resPath of cachedResourcePaths) {
    if (!resPath.startsWith(folder) || !resPath.toLowerCase().endsWith('.gd')) { continue; }
    let parsed;
    try { parsed = parseCustomEventScript(Buffer.from(await vscode.workspace.fs.readFile(resolveResourcePath(resPath))).toString('utf8'), resPath); } catch (error) { continue; }
    if (!parsed || DTL_ENTRIES.some(entry => entry.name === parsed.entry.name)) { continue; }
    DTL_ENTRIES.push(parsed.entry);
    if (Object.keys(parsed.values).length > 0) { DTL_ATTRIBUTE_VALUE_SUGGESTIONS[parsed.entry.name] = parsed.values; }
    customEventNames.push(parsed.entry.name);
  }
}

/**
 * Re-read every string literal of the project's own scripts into
 * cachedScriptStrings (Dialogic's own addon is left out).
 */
async function refreshScriptStrings() {
  const strings = new Set();
  for (const resPath of cachedResourcePaths) {
    if (!resPath.toLowerCase().endsWith('.gd') || resPath.startsWith('res://addons/dialogic/')) { continue; }
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(resolveResourcePath(resPath))).toString('utf8');
      for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) { strings.add(match[1] !== undefined ? match[1] : match[2]); }
    } catch (error) {
      // unreadable script - skip it
    }
  }
  cachedScriptStrings = strings;
}

// =============================================================================
// UNREACHABLE EVENTS AND LABELS
// =============================================================================
// Dialogic runs a timeline from top to bottom; labels are only markers that
// the flow runs through. So after a top-level `[end_timeline]`, `jump` or
// `return`, the events that follow never run - until a label, which a jump
// may lead to. A label that nothing jumps to (in any timeline), that no
// script starts the timeline at, and that the flow can't run into, never
// runs either.

/**
 * The labels of a timeline that something may jump to: the jumps of every
 * timeline (`jump label` in its own, `jump Timeline/label` anywhere), plus
 * every string a script names. Null when a jump's target is computed
 * (`jump {variable}`), since it could then be any label.
 *
 * @param {vscode.TextDocument} document
 * @returns {Set<string> | null}
 */
function collectJumpedLabels(document) {
  const identifier = findTimelineIdentifier(document); // null while unregistered: only its own jumps reach it
  const ownKey = timelineKey(document);
  const labels = new Set(cachedScriptStrings);
  for (const [timeline, lines] of currentTimelineLines()) {
    const isThis = timeline === ownKey;
    for (const text of lines) {
      const jump = parseJumpLine(text);
      if (!jump || !jump.label) { continue; }
      if (jump.target.includes('{')) {
        const targetsThis = jump.timeline === null ? isThis : (jump.timeline.includes('{') || jump.timeline === identifier);
        if (targetsThis) { return null; }
        continue;
      }
      if (jump.timeline === null ? isThis : jump.timeline === identifier) { labels.add(jump.label); }
    }
  }
  return labels;
}

/**
 * Report events that never run (faded) and labels nothing leads to.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnreachableDiagnostics(document) {
  const diagnostics = [];
  let jumped;
  const isJumpedTo = name => {
    if (jumped === undefined) { jumped = collectJumpedLabels(document); }
    return jumped === null || jumped.has(name);
  };
  let reachable = true;
  let endedBy = '';
  let deadStart = -1;
  let deadEnd = -1;
  const closeDeadRegion = () => {
    if (deadStart === -1) { return; }
    const diagnostic = pushDiagnostic(diagnostics, 'unreachableCode',
      new vscode.Range(deadStart, 0, deadEnd, document.lineAt(deadEnd).text.length),
      `This never runs: the timeline stops at the "${endedBy}" above, and no label leads here.`);
    if (diagnostic) { diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]; }
    deadStart = -1;
  };
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { continue; }
    const label = parseLabelLine(text);
    if (label && !reachable) {
      if (isJumpedTo(label.name)) {
        closeDeadRegion();
        reachable = true;
        continue;
      }
      pushDiagnostic(diagnostics, 'unreachableLabel',
        new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length),
        `Nothing leads to "label ${label.name}": no jump to it, no script naming it, and the timeline stops at the "${endedBy}" above - it never runs.`);
    }
    if (!reachable) {
      if (deadStart === -1) { deadStart = line; }
      deadEnd = line;
      continue;
    }
    const stop = /^(\[end_timeline\]|jump\b|return\b)/.exec(text);
    if (stop) {
      reachable = false;
      endedBy = stop[1] === 'jump' ? trimmed.split('#id:')[0].trim() : stop[1];
    }
  }
  closeDeadRegion();
  return diagnostics;
}

// =============================================================================
// UNUSED CHARACTERS AND PORTRAITS
// =============================================================================

/**
 * Which characters the project's timelines use, and with which portraits:
 * `join`/`update`/`leave`, speakers, `(mood)` tags and `[portrait=...]`.
 *
 * @returns {Map<string, Set<string>>} character -> moods used
 */
function collectCharacterUsage() {
  const usage = new Map();
  const use = (name, mood) => {
    if (!usage.has(name)) { usage.set(name, new Set()); }
    if (mood) { usage.get(name).add(mood); }
  };
  const linePattern = new RegExp(`^\\s*(?:(?:join|update|leave)\\s+)?(${CHARACTER_NAME_SOURCE})\\s*(?:\\(([\\p{L}_][\\p{L}0-9_]*)\\))?`, 'u');
  for (const lines of currentTimelineLines().values()) {
    for (const text of lines) {
      const isCommand = /^\s*(?:join|update|leave)\s/.test(text);
      const speaker = findLineSpeaker(text);
      if (!isCommand && !speaker) { continue; }
      const match = text.match(linePattern);
      if (!match) { continue; }
      const name = stripCharacterNameQuotes(match[1]);
      use(name, match[2]);
      if (speaker) {
        for (const portrait of text.matchAll(/\[portrait=([^\]\s]+)\]/g)) { use(name, portrait[1]); }
      }
    }
  }
  return usage;
}

/**
 * In a .dch file: the character no timeline uses, and the portraits no
 * timeline uses (faded) - except the default portrait, and names a script
 * mentions. Only checked once the project's timelines are known.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnusedCharacterDiagnostics(document) {
  const character = findCharacterForDocument(document);
  if (!character || !declaredProjectData.timelines || cachedTimelineLines.size === 0) { return []; }
  const diagnostics = [];
  const text = document.getText();
  const tokens = scanDch(text).keyTokens;
  const usage = collectCharacterUsage();
  const moods = usage.get(character);
  if (!moods && !cachedScriptStrings.has(character)) {
    const token = tokens.find(candidate => candidate.path.length === 0 && candidate.name === 'display_name') || tokens[0];
    const range = token ? new vscode.Range(document.positionAt(token.start), document.positionAt(token.end)) : new vscode.Range(0, 0, 0, 1);
    pushDiagnostic(diagnostics, 'unusedCharacter', range, `No timeline uses "${character}" (no join, update, leave or dialogue line).`);
    return diagnostics; // every portrait is unused then - no need to say it for each
  }
  const portraitTokens = tokens.filter(token => token.path.length === 1 && token.path[0] === 'portraits');
  // Without a default_portrait, a line without (mood) shows the first one.
  const defaultPortrait = (text.match(/&?"default_portrait"\s*:\s*"([^"]+)"/) || [])[1] || (portraitTokens[0] && portraitTokens[0].name);
  for (const token of portraitTokens) {
    if (token.name === defaultPortrait || (moods && moods.has(token.name)) || cachedScriptStrings.has(token.name)) { continue; }
    const diagnostic = pushDiagnostic(diagnostics, 'unusedPortrait',
      new vscode.Range(document.positionAt(token.start), document.positionAt(token.end)),
      `No timeline uses the portrait "${token.name}" of ${character} (as a (mood) or a [portrait=]).`);
    if (diagnostic) { diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]; }
  }
  return diagnostics;
}

// =============================================================================
// BLOCK SNIPPETS
// =============================================================================
// Ready-made blocks, suggested with the events at the start of a line (so
// never while writing dialogue): a choice, a condition, a loop, a small
// scene, a question. Character placeholders offer the project's characters.

/**
 * @returns {vscode.CompletionItem[]}
 */
function createBlockSnippets() {
  const names = completionCharacterNames();
  const character = index => (names.length > 0
    ? `\${${index}|${names.map(name => formatCharacterName(name).replace(/[,|$}\\]/g, '\\$&')).join(',')}|}`
    : `\${${index}:Character}`);
  const blocks = [
    ['choice', 'Choice block', 'Two choices, each with what follows it.',
      `- \${1:First choice}\n\t${character(2)}: \${3:...}\n- \${4:Second choice}\n\t$2: \${5:...}`],
    ['if', 'Condition block (if / else)', 'Different events depending on a condition.',
      'if {${1:variable}} == ${2:true}\n\t${3}\nelse\n\t${0}'],
    ['if', 'Condition block (if / elif / else)', 'Three branches depending on conditions.',
      'if {${1:variable}} == ${2:1}\n\t${3}\nelif {$1} == ${4:2}\n\t${5}\nelse\n\t${0}'],
    ['loop', 'Loop (label + jump back)', 'Dialogic has no while: a loop is a label, and a condition jumping back to it.',
      'set {${1:counter}} = 0\nlabel ${2:loop_start}\n${3}\nset {$1} += 1\nif {$1} < ${4:3}\n\tjump $2'],
    ['scene', 'Scene (join, talk, leave)', 'A character comes in, says something and leaves.',
      `join ${character(1)} \${2|left,center,right|}\n$1: \${3:Hello!}\nleave $1`],
    ['text_input', 'Question (text input + condition)', 'Ask the player something, then react to the answer.',
      '[text_input text="${1:What is your name?}" var="${2:player_name}"]\nif {$2} == "${3}"\n\t${0}'],
  ];
  return blocks.map(([keyword, label, doc, body]) => {
    const item = new vscode.CompletionItem({ label: keyword, description: label }, vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString(body);
    item.documentation = new vscode.MarkdownString(doc).appendCodeblock(body.replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, '$1').replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{?\d+\}?/g, ''), 'dtl');
    item.sortText = `2_${keyword}_${label}`;
    return item;
  });
}

// =============================================================================
// PLAY IN GODOT
// =============================================================================
// Plays a timeline the way Dialogic's own "Play timeline" button does: it
// writes the timeline in Dialogic's editor settings
// (`user://dialogic/editor_settings.cfg`, section [DES]:
// `current_timeline_path`, `play_from_index`), then runs Dialogic's test
// scene, which starts that timeline.

/** @type {vscode.OutputChannel | null} */
let godotOutputChannel = null;

/**
 * The project's `user://` folder, as Godot computes it: `app_userdata/<name>`
 * in Godot's data folder, or `<custom name>` directly in the OS data folder
 * with `application/config/use_custom_user_dir`.
 *
 * @param {string} projectText - project.godot
 * @returns {string | null}
 */
function godotUserDataDir(projectText) {
  const os = require('os');
  const path = require('path');
  const application = (projectText.match(/(?:^|\n)\[application\]([\s\S]*?)(?:\n\[|$)/) || [])[1] || '';
  const setting = key => ((application.match(new RegExp(`(?:^|\\n)config/${key}\\s*=\\s*(.+)`)) || [])[1] || '').trim().replace(/^"|"$/g, '');
  const safe = name => name.replace(/[:/\\?*"|%<>]/g, '_');
  const name = safe(setting('name') || '[unnamed project]');
  const custom = setting('use_custom_user_dir') === 'true' ? safe(setting('custom_user_dir_name')) : '';
  let dataDir;
  if (process.platform === 'win32') { dataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); }
  else if (process.platform === 'darwin') { dataDir = path.join(os.homedir(), 'Library', 'Application Support'); }
  else { dataDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'); }
  if (custom) { return path.join(dataDir, custom); }
  return path.join(dataDir, process.platform === 'win32' || process.platform === 'darwin' ? 'Godot' : 'godot', 'app_userdata', name);
}

/**
 * Set keys of one section of a Godot ConfigFile text, keeping everything
 * else as it is.
 *
 * @param {string} text - the file ('' for a new one)
 * @param {string} section
 * @param {Record<string, string>} values - key -> Godot literal
 * @returns {string}
 */
function setConfigFileValues(text, section, values) {
  const lines = text.split(/\r?\n/);
  let start = lines.findIndex(line => line.trim() === `[${section}]`);
  if (start === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') { lines.pop(); }
    if (lines.length > 0) { lines.push(''); }
    lines.push(`[${section}]`, '');
    start = lines.length - 2;
  }
  let end = lines.findIndex((line, index) => index > start && /^\[.*\]\s*$/.test(line.trim()));
  if (end === -1) { end = lines.length; }
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line, i) => i > start && i < end && line.startsWith(`${key}=`));
    if (index !== -1) { lines[index] = `${key}=${value}`; continue; }
    // After the section's last key - keeping the blank line Godot writes
    // under the section title.
    let insertAt = end;
    while (insertAt > start + 2 && lines[insertAt - 1].trim() === '') { insertAt--; }
    if (insertAt === start + 1) { lines.splice(insertAt++, 0, ''); end++; }
    lines.splice(insertAt, 0, `${key}=${value}`);
    end++;
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

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
  // Only a known shortcode event (built-in or custom) is one - `[b]Hi[/b]`
  // starting a narration line is text.
  const shortcodes = new Set([...RESERVED_BRACKET_NAMES, ...DTL_ENTRIES.filter(entry => entry.type === 'bracket').map(entry => entry.name)]);
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
    const shortcodeMatch = stripped.match(/^\[([A-Za-z_][A-Za-z0-9_]*)(?=[ \]])/); // Dialogic: begins with "[name " or "[name]"
    const isShortcode = !!shortcodeMatch && shortcodes.has(shortcodeMatch[1]);
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

/**
 * The Godot executable: `dtlReader.godotPath`, else the godot-tools
 * extension's `godotTools.editorPath.godot4`, else `godot` on the PATH.
 *
 * @returns {string}
 */
function findGodotExecutable() {
  const own = vscode.workspace.getConfiguration('dtlReader').get('godotPath', '');
  if (own) { return own; }
  const godotTools = vscode.workspace.getConfiguration('godotTools').get('editorPath.godot4', '');
  return godotTools || 'godot';
}

/**
 * DTL: Play Timeline in Godot - save the timeline, point Dialogic's test
 * scene at it, and run the project's Godot on that scene. Godot's output
 * goes to the "DTL Reader: Godot" output channel.
 *
 * @param {vscode.Uri} [uri] - from the editor title button; else the active editor
 */
async function playTimelineCommand(uri) {
  const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
  if (!target) { return; }
  await playTimeline(await vscode.workspace.openTextDocument(target), -1);
}

/**
 * DTL: Play Timeline from This Line - like Dialogic's "Play from here":
 * the timeline starts at the event of the cursor's line, skipping the
 * events above it - to test a condition or a variable change without
 * replaying the whole timeline first.
 *
 * @param {vscode.Uri} [uri] - from a menu; else the active editor
 */
async function playTimelineFromLineCommand(uri) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || (uri && editor.document.uri.toString() !== uri.toString())) {
    vscode.window.showErrorMessage('Put the cursor on the line to play from, in the timeline.');
    return;
  }
  const line = editor.selection.active.line;
  const index = computeDialogicEventIndices(documentLines(editor.document))[line];
  await playTimeline(editor.document, index, line);
}

/**
 * Save a timeline, point Dialogic's test scene at it (from event
 * `fromIndex`, -1 for the start), and run the project's Godot on that scene.
 *
 * @param {vscode.TextDocument} document
 * @param {number} fromIndex
 * @param {number} [fromLine] - shown in the output
 */
async function playTimeline(document, fromIndex, fromLine) {
  if (document.languageId !== 'dtl') { vscode.window.showErrorMessage('Only a timeline (.dtl) can be played.'); return; }
  if (!projectRootUri) { vscode.window.showErrorMessage('Playing a timeline needs its Godot project: open the folder containing project.godot.'); return; }
  const resPath = toResPath(document.uri);
  if (!resPath) { vscode.window.showErrorMessage('This timeline is not inside the Godot project.'); return; }
  const scene = cachedResourcePaths.find(candidate => candidate.endsWith('/Editor/TimelineEditor/test_timeline_scene.tscn'));
  if (!scene) { vscode.window.showErrorMessage('Dialogic\'s test scene (addons/dialogic/Editor/TimelineEditor/test_timeline_scene.tscn) was not found - is Dialogic installed in this project?'); return; }
  if (document.isDirty) { await document.save(); }

  const fs = require('fs');
  const path = require('path');
  const projectText = Buffer.from(await vscode.workspace.fs.readFile(projectGodotUri())).toString('utf8');
  const userDir = godotUserDataDir(projectText);
  const settingsFile = path.join(userDir, 'dialogic', 'editor_settings.cfg');
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const current = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
    fs.writeFileSync(settingsFile, setConfigFileValues(current, 'DES', { current_timeline_path: godotString(resPath), play_from_index: String(fromIndex) }));
  } catch (error) {
    vscode.window.showErrorMessage(`Could not write Dialogic's editor settings (${settingsFile}): ${error.message}`);
    return;
  }

  if (!godotOutputChannel) { godotOutputChannel = vscode.window.createOutputChannel('DTL Reader: Godot'); }
  const executable = findGodotExecutable();
  const args = ['--path', projectRootUri.fsPath, scene];
  const from = fromIndex < 0 ? '' : `, from line ${fromLine + 1} (event ${fromIndex})`;
  godotOutputChannel.appendLine(`> ${executable} ${args.join(' ')}   (${resPath}${from})`);
  const child = require('child_process').spawn(executable, args, { cwd: projectRootUri.fsPath });
  child.stdout.on('data', data => godotOutputChannel.append(data.toString()));
  child.stderr.on('data', data => godotOutputChannel.append(data.toString()));
  child.on('exit', code => godotOutputChannel.appendLine(`> Godot exited (${code})`));
  child.on('error', async error => {
    godotOutputChannel.appendLine(`> ${error.message}`);
    const choice = await vscode.window.showErrorMessage(`Could not start Godot ("${executable}"). Set the path to your Godot 4 executable.`, 'Set Godot path');
    if (choice) { vscode.commands.executeCommand('workbench.action.openSettings', 'dtlReader.godotPath'); }
  });
}

// =============================================================================
// SPELLING SUGGESTIONS
// =============================================================================

/**
 * Edit distance between two names: one insertion, deletion, substitution
 * or swap of two neighbouring letters per step ("strat" is one step from
 * "start"), ignoring case - so a name differing only by its case is at
 * distance 0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) { return 0; }
  let beforePrevious = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/**
 * The known names closest to a misspelled one, best first - only those
 * close enough to be a plausible typo: at most one edit per three letters
 * (at least one), case differences being free.
 *
 * @param {string} name - what was typed
 * @param {Iterable<string>} candidates
 * @param {number} [max]
 * @returns {string[]}
 */
function findSimilarNames(name, candidates, max = 3) {
  const limit = Math.max(1, Math.floor(name.length / 3));
  return [...new Set(candidates)]
    .filter(candidate => candidate !== name)
    .map(candidate => ({ candidate, distance: editDistance(name, candidate) }))
    .filter(entry => entry.distance <= limit)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, max)
    .map(entry => entry.candidate);
}

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
 * @param {vscode.TextDocument} document
 * @returns {string}
 */
function documentEol(document) {
  return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/**
 * A quick fix replacing `range` with `text`.
 *
 * @param {string} title
 * @param {vscode.Uri} uri
 * @param {vscode.Range} range
 * @param {string} text
 * @param {vscode.Diagnostic} diagnostic
 * @param {boolean} [isPreferred] - the fix applied by "Auto Fix" (Shift+Alt+.)
 * @returns {vscode.CodeAction}
 */
function createReplaceFix(title, uri, range, text, diagnostic, isPreferred = false) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(uri, range, text);
  action.diagnostics = [diagnostic];
  action.isPreferred = isPreferred;
  return action;
}

/**
 * "Change to ..." fixes for a misspelled name: its closest candidates,
 * replacing the diagnostic's range. Only the closest one is preferred,
 * and only when it's the single suggestion.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @param {string} typed
 * @param {Iterable<string>} candidates
 * @param {(name: string) => string} [format] - how the name is written
 * @returns {vscode.CodeAction[]}
 */
function createDidYouMeanFixes(document, diagnostic, typed, candidates, format = name => name) {
  const names = findSimilarNames(typed, candidates);
  return names.map(name => createReplaceFix(`Change to "${name}"`, document.uri, diagnostic.range, format(name), diagnostic, names.length === 1));
}

/**
 * Where text appended to a document goes, and how it must start: after a
 * blank line, whether or not the file ends with a newline.
 *
 * @param {vscode.TextDocument} document
 * @returns {{position: vscode.Position, prefix: string, firstLine: number}} firstLine: the first line of the appended text once inserted
 */
function appendPoint(document) {
  const eol = documentEol(document);
  const lastLine = document.lineAt(document.lineCount - 1);
  const endsWithNewline = lastLine.text.trim() === '';
  const previousBlank = endsWithNewline && (document.lineCount < 2 || document.lineAt(document.lineCount - 2).text.trim() === '');
  if (!endsWithNewline) { return { position: lastLine.range.end, prefix: eol + eol, firstLine: lastLine.lineNumber + 2 }; }
  if (previousBlank) { return { position: lastLine.range.end, prefix: '', firstLine: lastLine.lineNumber }; }
  return { position: lastLine.range.end, prefix: eol, firstLine: lastLine.lineNumber + 1 };
}

/**
 * Whether a timeline's last event already stops the flow (`[end_timeline]`,
 * `jump`, `return`), so nothing written after it runs by falling through.
 *
 * @param {vscode.TextDocument} document
 * @returns {boolean}
 */
function timelineEndsFlow(document) {
  for (let line = document.lineCount - 1; line >= 0; line--) {
    const text = document.lineAt(line).text;
    if (text.trim() === '' || text.trim().startsWith('#')) { continue; }
    // Only at the top level: an indented one (in an if or a choice) can be
    // skipped, and the flow then goes on past it.
    return /^(?:\[end_timeline\]|jump\b|return\b)/.test(text);
  }
  return true; // an empty timeline
}

/**
 * "Create label X" for a jump to a missing label: appended at the end of
 * the target timeline (this one, or the other timeline of `jump
 * Other/label`). An `[end_timeline]` is added before it when the timeline
 * didn't end its flow, so what gets written under the new label doesn't
 * run for everyone reaching the end. The other timeline is opened on the
 * new label.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @param {NonNullable<ReturnType<typeof parseJumpLine>>} jump
 * @returns {Promise<vscode.CodeAction | null>}
 */
async function createMissingLabelFix(document, diagnostic, jump) {
  if (validateLabelName(jump.label)) { return null; }
  let target = document;
  if (jump.timeline !== null) {
    const resPath = cachedTimelinePaths.get(jump.timeline);
    if (!resPath) { return null; }
    try { target = await vscode.workspace.openTextDocument(resolveResourcePath(resPath)); } catch (error) { return null; }
  }
  const eol = documentEol(target);
  const { position, prefix, firstLine } = appendPoint(target);
  const endTimeline = timelineEndsFlow(target) ? '' : `[end_timeline]${eol}${eol}`;
  const labelLine = firstLine + (endTimeline ? 2 : 0);
  const action = new vscode.CodeAction(
    jump.timeline === null ? `Create "label ${jump.label}" at the end of this timeline` : `Create "label ${jump.label}" at the end of ${jump.timeline}`,
    vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.insert(target.uri, position, `${prefix}${endTimeline}label ${jump.label}${eol}`);
  action.diagnostics = [diagnostic];
  if (jump.timeline !== null) {
    const labelEnd = new vscode.Position(labelLine, `label ${jump.label}`.length);
    action.command = { command: 'vscode.open', title: 'Open the label', arguments: [target.uri, { selection: new vscode.Range(labelEnd, labelEnd) }] };
  }
  return action;
}

/**
 * Quick fixes for an unresolved jump: the closest labels (or timelines,
 * when the timeline part is wrong), and creating the missing label.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function createUnresolvedJumpFixes(document, diagnostic) {
  const jump = parseJumpLine(document.lineAt(diagnostic.range.start.line).text);
  if (!jump) { return []; }
  if (jump.timeline !== null && diagnostic.range.start.character < jump.labelStart) {
    return createDidYouMeanFixes(document, diagnostic, jump.timeline, cachedTimelinePaths.keys());
  }
  const target = resolveJumpTarget(document, jump);
  const fixes = target ? createDidYouMeanFixes(document, diagnostic, jump.label, target.labels.keys()) : [];
  const create = await createMissingLabelFix(document, diagnostic, jump);
  if (create) { fixes.push(create); }
  return fixes;
}

/**
 * "Remove the translation id" for a jump ending with `#id:...`.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction[]}
 */
function createJumpTranslationIdFixes(document, diagnostic) {
  const line = diagnostic.range.start.line;
  const text = document.lineAt(line).text;
  const idStart = text.indexOf('#id:');
  if (idStart === -1) { return []; }
  const start = text.slice(0, idStart).trimEnd().length;
  return [createReplaceFix('Remove the translation id', document.uri, new vscode.Range(line, start, line, text.length), '', diagnostic, true)];
}

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
 * Find a portrait's name in a .dch file, as the range of its key.
 *
 * @param {vscode.TextDocument} dchDocument
 * @param {string} mood
 * @returns {vscode.Range | null}
 */
function findDchPortraitRange(dchDocument, mood) {
  const token = scanDch(dchDocument.getText()).keyTokens.find(candidate => candidate.path.length === 1 && candidate.path[0] === 'portraits' && candidate.name === mood);
  return token ? new vscode.Range(dchDocument.positionAt(token.start), dchDocument.positionAt(token.end)) : null;
}

/**
 * An edit adding a new image portrait to a .dch file's `portraits`, written
 * the way Dialogic writes it (in the file's own `&"key"` or `"key"` style),
 * and where its image path is to be typed once inserted.
 *
 * @param {vscode.TextDocument} dchDocument
 * @param {string} mood
 * @returns {{range: vscode.Range, text: string, imagePosition: vscode.Position} | null} null if the file has no `portraits`
 */
function createAddPortraitEdit(dchDocument, mood) {
  const text = dchDocument.getText();
  const header = text.match(/&?"portraits"\s*:\s*\{/);
  if (!header) { return null; }
  const openIndex = header.index + header[0].length - 1;
  const body = extractBalancedBraces(text, openIndex);
  if (body === null) { return null; }
  const eol = documentEol(dchDocument);
  const keyPrefix = /&"/.test(text) ? '&' : '';
  const k = key => `${keyPrefix}"${key}"`;
  const name = mood.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const portrait = [
    `${keyPrefix}"${name}": {`,
    `${k('export_overrides')}: {`,
    `${k('image')}: "\\"res://\\""`,
    '},',
    `${k('mirror')}: false,`,
    `${k('offset')}: Vector2(0, 0),`,
    `${k('scale')}: 1.0,`,
    `${k('scene')}: ""`,
    '}',
  ].join(eol);
  const content = body.trimEnd();
  const start = openIndex + 1 + (content ? content.length : 0);
  const end = content ? start : openIndex + 1 + body.length;
  const inserted = content ? `,${eol}${portrait}` : `${eol}${portrait}${eol}`;
  // Where `res://` ends in the image line, in the edited file.
  const before = (text.slice(0, start) + inserted.slice(0, inserted.indexOf('res://') + 'res://'.length)).split('\n');
  const imagePosition = new vscode.Position(before.length - 1, before[before.length - 1].length);
  return { range: new vscode.Range(dchDocument.positionAt(start), dchDocument.positionAt(end)), text: inserted, imagePosition };
}

/**
 * Quick fixes for an unknown mood: the character's closest portraits, and
 * adding the mood to their .dch file as a new image portrait (then opened
 * on its image path).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function createUnknownMoodFixes(document, diagnostic) {
  const character = findLineCharacter(document.lineAt(diagnostic.range.start.line).text);
  const moods = character && cachedCharacterMoods.get(character);
  if (!moods) { return []; }
  const mood = document.getText(diagnostic.range);
  const fixes = createDidYouMeanFixes(document, diagnostic, mood, moods.keys());
  const dchPath = cachedCharacterPaths.get(character);
  if (!dchPath || !/^[\p{L}_][\p{L}0-9_]*$/u.test(mood)) { return fixes; }
  let dchDocument;
  try { dchDocument = await vscode.workspace.openTextDocument(resolveResourcePath(dchPath)); } catch (error) { return fixes; }
  const edit = createAddPortraitEdit(dchDocument, mood);
  if (!edit) { return fixes; }
  const action = new vscode.CodeAction(`Add the portrait "${mood}" to ${character}`, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(dchDocument.uri, edit.range, edit.text);
  action.diagnostics = [diagnostic];
  action.command = { command: 'vscode.open', title: 'Open the portrait', arguments: [dchDocument.uri, { selection: new vscode.Range(edit.imagePosition, edit.imagePosition) }] };
  fixes.push(action);
  return fixes;
}

/**
 * Every `{path}` a timeline can reference: Dialogic variables and the
 * members of the loaded autoloads.
 *
 * @returns {string[]}
 */
function collectVariableReferencePaths() {
  const paths = collectVariableLeaves().map(leaf => leaf.path);
  for (const [globalName, symbols] of cachedAutoloadSymbols) {
    for (const members of [symbols.variables, symbols.constants, symbols.enums]) {
      for (const name of members.keys()) { paths.push(`${globalName}.${name}`); }
    }
  }
  return paths;
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
    if (RESERVED_BRACKET_NAMES.has(tagName) || SELF_CLOSING_BBCODE_NAMES.has(tagName) || TEXT_EFFECT_NAMES.has(tagName)) {
      continue; // a DTL command, a Dialogic text effect ([aa], [n]...) or a BBCode tag like [br] - none has a closer
    }
    // With parameters, only real Godot BBCode tags need a closer - Dialogic's
    // own text effects ([pause=1.5], [speed=2], [portrait=happy]...) don't.
    if (match[2] !== undefined && !DTL_BBCODES.some(entry => entry.name === tagName)) {
      continue;
    }
    if (!text.includes(`[/${tagName}]`)) { return tagName; }
  }
  return null;
}

/**
 * "Close [tag]" for an unclosed BBCode tag: its closing tag at the end of
 * the line's text - before a translation id, and before a choice's `|`
 * condition.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction[]}
 */
function createUnclosedTagFixes(document, diagnostic) {
  const line = diagnostic.range.start.line;
  const text = document.lineAt(line).text;
  const tagName = findUnclosedTag(text);
  if (!tagName) { return []; }
  let end = text.indexOf('#id:') === -1 ? text.length : text.indexOf('#id:');
  if (/^\s*-\s/.test(text) && text.lastIndexOf('|', end) !== -1) { end = text.lastIndexOf('|', end); }
  end = text.slice(0, end).trimEnd().length;
  return [createReplaceFix(`Close [${tagName}] at the end of the line`, document.uri, new vscode.Range(line, end, line, end), `[/${tagName}]`, diagnostic, true)];
}

// -----------------------------------------------------------------------------
// Adding what's missing to project.godot
// -----------------------------------------------------------------------------
// An unknown character or variable may be a typo - or something new that
// the project doesn't have yet. These fixes write it where Dialogic keeps
// it, in project.godot's [dialogic] section: `variables` (the Dialogic
// variables, a nested dictionary of folders) and `directories/dch_directory`
// (character identifier -> .dch file, the identifier being the file name).
// The changed files are saved right away, so the project is re-read and
// the problem goes away.

/**
 * A string literal for a Godot dictionary key or value.
 *
 * @param {string} text
 * @returns {string}
 */
function godotString(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The index just past a string literal starting at `start` (a `"`).
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function skipGodotString(text, start) {
  let end = start + 1;
  while (end < text.length && text[end] !== '"') { end += text[end] === '\\' ? 2 : 1; }
  return end + 1;
}

/**
 * Walk the dictionary opening at `openIndex` (a `{`): where each of its own
 * keys' values starts, and where it closes. Strings are skipped whole, so
 * braces inside them don't count.
 *
 * @param {string} text
 * @param {number} openIndex
 * @returns {{entries: Map<string, number>, closeIndex: number} | null} null if it never closes
 */
function scanGodotDict(text, openIndex) {
  const entries = new Map();
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipGodotString(text, i);
      const colon = depth === 1 ? text.slice(end).match(/^\s*:\s*/) : null;
      if (colon) {
        let key = text.slice(i + 1, end - 1);
        try { key = JSON.parse(text.slice(i, end)); } catch (error) { /* an escape JSON doesn't know - keep it raw */ }
        entries.set(key, end + colon[0].length);
      }
      i = end - 1;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { return { entries, closeIndex: i }; }
    }
  }
  return null;
}

/**
 * The text of an edit adding one `key: value` entry at the end of the
 * dictionary opening at `openIndex`, one entry per line like Godot writes
 * them (a trailing comma already there is kept).
 *
 * @param {string} text
 * @param {number} openIndex
 * @param {string} entry - `"key": value`
 * @param {string} eol
 * @returns {{start: number, end: number, text: string} | null}
 */
function appendGodotDictEntry(text, openIndex, entry, eol) {
  const dict = scanGodotDict(text, openIndex);
  if (!dict) { return null; }
  const content = text.slice(openIndex + 1, dict.closeIndex).trimEnd();
  if (content.trim() === '') { return { start: openIndex + 1, end: dict.closeIndex, text: `${eol}${entry}${eol}` }; }
  const start = openIndex + 1 + content.length;
  return { start, end: start, text: `${content.endsWith(',') ? '' : ','}${eol}${entry}` };
}

/**
 * Where a `[dialogic]` setting's dictionary opens in project.godot, e.g.
 * `variables` or `directories/dch_directory`.
 *
 * @param {string} text - project.godot
 * @param {string} setting
 * @returns {number} the index of its `{`, or -1
 */
function findDialogicSettingDict(text, setting) {
  const section = /(?:^|\n)\[dialogic\][^\n]*\n/.exec(text);
  if (!section) { return -1; }
  const sectionStart = section.index + section[0].length;
  const nextSection = text.slice(sectionStart).search(/\n\[/);
  const sectionEnd = nextSection === -1 ? text.length : sectionStart + nextSection;
  const escaped = setting.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const header = new RegExp(`(?:^|\\n)${escaped}\\s*=\\s*\\{`).exec(text.slice(sectionStart, sectionEnd));
  return header ? sectionStart + header.index + header[0].length - 1 : -1;
}

/**
 * The types a Dialogic variable can have (those of Dialogic's variable
 * editor), each with the default value a new variable gets.
 *
 * @type {{type: string, label: string, value: string}[]}
 */
const DIALOGIC_VARIABLE_TYPES = [
  { type: 'String', label: 'a text', value: '""' },
  { type: 'int', label: 'a whole number', value: '0' },
  { type: 'float', label: 'a decimal number', value: '0.0' },
  { type: 'bool', label: 'a bool', value: 'false' },
];

/**
 * The type a new Dialogic variable most likely has, from how the line
 * uses it: `set {x} = 2` or `if {x} > 1` an int, `= 1.5` a float, `==
 * true` a bool - a text otherwise (Dialogic's own default).
 *
 * @param {string} lineText
 * @param {string} path - e.g. "chapter.flag"
 * @returns {string} one of DIALOGIC_VARIABLE_TYPES' types
 */
function inferVariableType(lineText, path) {
  const escaped = path.replace(/\./g, '\\.');
  const match = lineText.match(new RegExp(`\\{${escaped}\\}\\s*(?:==|!=|<=|>=|[-+*/]?=|<|>)\\s*(.+)$`));
  const value = match ? match[1].split(/\s+(?:and|or)\s+/)[0].trim() : '';
  if (/^-?\d+$/.test(value)) { return 'int'; }
  if (/^-?\d*\.\d+$/.test(value)) { return 'float'; }
  if (/^(?:true|false)$/.test(value)) { return 'bool'; }
  return 'String';
}

/**
 * An edit adding a Dialogic variable to project.godot's `variables`,
 * creating its folders as needed (`{chapter1.met_john}` adds `met_john` to
 * the `chapter1` folder, creating it if it doesn't exist).
 *
 * @param {string} text - project.godot
 * @param {string[]} segments - the variable path
 * @param {string} value - its default, a Godot literal
 * @param {string} eol
 * @returns {{start: number, end: number, text: string} | null} null if it can't be added (a variable where a folder is needed)
 */
function createAddVariableEdit(text, segments, value, eol) {
  let openIndex = findDialogicSettingDict(text, 'variables');
  if (openIndex === -1) { return null; }
  for (let i = 0; i < segments.length; i++) {
    const dict = scanGodotDict(text, openIndex);
    if (!dict) { return null; }
    const valueIndex = dict.entries.get(segments[i]);
    if (valueIndex === undefined) {
      let entry = value;
      for (let j = segments.length - 1; j > i; j--) { entry = `{${eol}${godotString(segments[j])}: ${entry}${eol}}`; }
      return appendGodotDictEntry(text, openIndex, `${godotString(segments[i])}: ${entry}`, eol);
    }
    if (i === segments.length - 1 || text[valueIndex] !== '{') { return null; } // exists already, or isn't a folder
    openIndex = valueIndex;
  }
  return null;
}

/**
 * The text of a new .dch character file, as Dialogic writes it, with the
 * given portraits (image portraits to fill in) - the first one being the
 * default.
 *
 * @param {string} name
 * @param {string[]} moods
 * @param {string} eol
 * @returns {string}
 */
function newCharacterFileText(name, moods, eol) {
  const k = key => `&"${key}"`;
  const portraits = moods.map(mood => [
    `&${godotString(mood)}: {`,
    `${k('export_overrides')}: {`,
    `${k('image')}: "\\"res://\\""`,
    '},',
    `${k('mirror')}: false,`,
    `${k('offset')}: Vector2(0, 0),`,
    `${k('scale')}: 1.0,`,
    `${k('scene')}: ""`,
    '}',
  ].join(eol));
  return [
    '{',
    `${k('@path')}: "res://addons/dialogic/Resources/character.gd",`,
    `${k('@subpath')}: NodePath(""),`,
    `${k('color')}: Color(1, 1, 1, 1),`,
    `${k('custom_info')}: {},`,
    `${k('default_portrait')}: ${godotString(moods[0] || '')},`,
    `${k('description')}: "",`,
    `${k('display_name')}: ${godotString(name)},`,
    `${k('mirror')}: false,`,
    `${k('nicknames')}: [],`,
    `${k('offset')}: Vector2(0, 0),`,
    portraits.length ? `${k('portraits')}: {${eol}${portraits.join(`,${eol}`)}${eol}},` : `${k('portraits')}: {},`,
    `${k('scale')}: 1.0`,
    '}',
    '',
  ].join(eol);
}

/**
 * A `<name>.dch` file the project already has but doesn't register, if any.
 *
 * @param {string} name
 * @returns {string | null} its res:// path
 */
function findUnregisteredCharacterFile(name) {
  const fileName = `/${name}.dch`.toLowerCase();
  const registered = new Set([...cachedCharacterPaths.values()].map(resPath => resPath.toLowerCase()));
  return cachedResourcePaths.find(resPath => resPath.toLowerCase().endsWith(fileName) && !registered.has(resPath.toLowerCase())) || null;
}

/** @param {string} resPath @returns {string} its folder, without the trailing "/" */
const resFolderOf = resPath => resPath.slice(0, resPath.lastIndexOf('/'));

/**
 * The folders a new character of this timeline could go in, best first,
 * each with why it's suggested:
 * 1. a character folder named like one of this timeline's folders
 *    (`timelines/chapter2/market.dtl` -> `characters/chapter2`), for
 *    projects organized by chapter or route;
 * 2. the folders of the characters this timeline already uses - a new
 *    character most likely belongs with the rest of the scene's cast;
 * 3. the folders of the project's other characters, most used first;
 * 4. with no characters yet: a `characters` folder beside the timelines
 *    folder (`res://story/timelines/` -> `res://story/characters`), the
 *    timeline's own folder, and `res://characters`.
 *
 * @param {vscode.TextDocument} document - the timeline
 * @returns {{folder: string, reason: string}[]}
 */
function rankCharacterFolders(document) {
  const candidates = new Map();
  const add = (folder, score, reason) => {
    const current = candidates.get(folder);
    if (!current || current.score < score) { candidates.set(folder, { score, reason }); }
  };
  const countFolders = names => {
    const counts = new Map();
    for (const name of names) {
      const folder = resFolderOf(cachedCharacterPaths.get(name));
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
    return counts;
  };
  const allCounts = countFolders(cachedCharacterPaths.keys());
  const timelinePath = toResPath(document.uri);
  const timelineFolders = timelinePath ? resFolderOf(timelinePath).replace(/^res:\/\//, '').split('/').filter(Boolean) : [];

  for (const folder of allCounts.keys()) {
    const folderName = folder.slice(folder.lastIndexOf('/') + 1);
    if (timelineFolders.some(segment => segment.toLowerCase() === folderName.toLowerCase())) {
      add(folder, 4000, `named like this timeline's folder "${folderName}"`);
    }
  }
  const castNames = new Set();
  for (let line = 0; line < document.lineCount; line++) {
    const name = findLineCharacter(document.lineAt(line).text);
    if (name && cachedCharacterPaths.has(name)) { castNames.add(name); }
  }
  for (const [folder, count] of countFolders(castNames)) {
    const inFolder = [...castNames].filter(name => resFolderOf(cachedCharacterPaths.get(name)) === folder);
    const shown = inFolder.slice(0, 3).join(', ') + (inFolder.length > 3 ? '...' : '');
    add(folder, 3000 + count, `with ${shown}, who ${count > 1 ? 'are' : 'is'} in this timeline`);
  }
  const total = cachedCharacterPaths.size;
  for (const [folder, count] of allCounts) {
    add(folder, 2000 + count, `where ${count} of the project's ${total} characters ${count > 1 ? 'are' : 'is'}`);
  }
  if (timelinePath) {
    const timelineFolder = resFolderOf(timelinePath);
    const beside = timelineFolder.match(/^(.*)\/timelines?(?:\/|$)/i);
    if (beside) { add(`${beside[1]}/characters`, 1000, 'beside the timelines folder'); }
    add(timelineFolder, 500, "this timeline's folder");
  }
  add('res://characters', 100, 'a characters folder at the root of the project');
  return [...candidates].sort((a, b) => b[1].score - a[1].score).map(([folder, { reason }]) => ({ folder, reason }));
}

/** @returns {vscode.Uri} */
function projectGodotUri() {
  return vscode.Uri.joinPath(projectRootUri, 'project.godot');
}

/**
 * A quick fix applying `edit`, then saving `saveUris` (so the project is
 * re-read from disk and the problem goes away).
 *
 * @param {string} title
 * @param {vscode.WorkspaceEdit} edit
 * @param {vscode.Uri[]} saveUris
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction}
 */
function createSavedEditFix(title, edit, saveUris, diagnostic) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.command = { command: 'dtlReader.saveAndRefresh', title: 'Save', arguments: splitFilesToSave(saveUris) };
  return action;
}

/**
 * Which of the files a quick fix changes can be saved with it: not those
 * already open with unsaved changes of their own, which saving would
 * write too - those are left for the person to save.
 *
 * @param {vscode.Uri[]} uris - checked before the fix is applied
 * @returns {[vscode.Uri[], vscode.Uri[]]} [to save, left unsaved]
 */
function splitFilesToSave(uris) {
  const isDirty = uri => vscode.workspace.textDocuments.some(document => document.isDirty && normalizeFsPath(document.uri.fsPath || '') === normalizeFsPath(uri.fsPath));
  return [uris.filter(uri => !isDirty(uri)), uris.filter(isDirty)];
}

/**
 * Save the given files (after a quick fix changed them) and re-read the
 * project. An internal command, not in the Command Palette.
 *
 * @param {vscode.Uri[]} uris
 * @param {vscode.Uri[]} [leftUnsaved] - changed too, but they had unsaved changes already
 */
async function saveAndRefreshCommand(uris, leftUnsaved = []) {
  for (const uri of uris || []) {
    const document = vscode.workspace.textDocuments.find(candidate => normalizeFsPath(candidate.uri.fsPath || '') === normalizeFsPath(uri.fsPath));
    if (document && document.isDirty) { await document.save(); }
  }
  if (leftUnsaved.length > 0) {
    const names = leftUnsaved.map(uri => uri.path.split('/').pop()).join(', ');
    vscode.window.showInformationMessage(`${names} had unsaved changes, so it was changed but not saved - save it to apply the fix.`);
  }
  await refreshProjectGodotData();
}

/**
 * "Add the variable to project.godot" for an unknown `{variable}`, one fix
 * per Dialogic variable type - the type the line suggests first. Not for
 * an autoload member, which lives in its script.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function createAddVariableFixes(document, diagnostic) {
  if (!projectRootUri) { return []; }
  const path = document.getText(diagnostic.range);
  const segments = path.split('.');
  if (cachedAutoloadNames.has(segments[0])) { return []; }
  let projectDocument;
  try { projectDocument = await vscode.workspace.openTextDocument(projectGodotUri()); } catch (error) { return []; }
  const text = projectDocument.getText();
  const likely = inferVariableType(document.lineAt(diagnostic.range.start.line).text, path);
  const types = [...DIALOGIC_VARIABLE_TYPES].sort((a, b) => (b.type === likely) - (a.type === likely));
  const fixes = [];
  for (const { label, value } of types) {
    const change = createAddVariableEdit(text, segments, value, documentEol(projectDocument));
    if (!change) { return []; }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(projectDocument.uri, new vscode.Range(projectDocument.positionAt(change.start), projectDocument.positionAt(change.end)), change.text);
    fixes.push(createSavedEditFix(`Add the variable "${path}" to project.godot as ${label} (${value})`, edit, [projectDocument.uri], diagnostic));
  }
  return fixes;
}

/**
 * The edit registering a character in project.godot's
 * `directories/dch_directory` - and, for a new file, creating its .dch
 * (with `mood`, if any, as its default portrait) - with the files to save.
 *
 * @param {string} name
 * @param {string} resPath - the .dch file
 * @param {boolean} exists - the .dch file is already there
 * @param {string|null} mood
 * @returns {Promise<{edit: vscode.WorkspaceEdit, saveUris: vscode.Uri[]} | null>}
 */
async function createAddCharacterEdit(name, resPath, exists, mood) {
  let projectDocument;
  try { projectDocument = await vscode.workspace.openTextDocument(projectGodotUri()); } catch (error) { return null; }
  const text = projectDocument.getText();
  const eol = documentEol(projectDocument);
  const openIndex = findDialogicSettingDict(text, 'directories/dch_directory');
  if (openIndex === -1) { return null; }
  const change = appendGodotDictEntry(text, openIndex, `${godotString(name)}: ${godotString(resPath)}`, eol);
  if (!change) { return null; }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(projectDocument.uri, new vscode.Range(projectDocument.positionAt(change.start), projectDocument.positionAt(change.end)), change.text);
  const saveUris = [projectDocument.uri];
  if (!exists) {
    const dchUri = resolveResourcePath(resPath);
    edit.createFile(dchUri, { ignoreIfExists: true });
    edit.insert(dchUri, new vscode.Position(0, 0), newCharacterFileText(name, mood ? [mood] : [], eol));
    saveUris.push(dchUri);
  }
  return { edit, saveUris };
}

/**
 * "Add the character to project.godot" for an unknown character. When the
 * project already has an unregistered `<name>.dch`, it's registered
 * directly; otherwise the fix asks which folder the new .dch goes in (see
 * addCharacterCommand).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction | null>}
 */
async function createAddCharacterFix(document, diagnostic) {
  if (!projectRootUri || !declaredProjectData.characters) { return null; }
  const name = stripCharacterNameQuotes(document.getText(diagnostic.range));
  if (!name || /[\\/:*?"<>|]/.test(name)) { return null; } // not a valid file name
  const existing = findUnregisteredCharacterFile(name);
  if (existing) {
    const change = await createAddCharacterEdit(name, existing, true, null);
    return change ? createSavedEditFix(`Add the character "${name}" (${existing}) to project.godot`, change.edit, change.saveUris, diagnostic) : null;
  }
  const mood = (document.lineAt(diagnostic.range.start.line).text.slice(diagnostic.range.end.character).match(/^\s*\(([\p{L}_][\p{L}0-9_]*)\)/u) || [])[1] || null;
  const action = new vscode.CodeAction(`Add the character "${name}" to project.godot, with a new ${name}.dch...`, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.command = { command: 'dtlReader.addCharacter', title: action.title, arguments: [{ name, mood, timeline: document.uri.toString() }] };
  return action;
}

/**
 * Ask where a new character's .dch file goes - the folders of
 * rankCharacterFolders, best first, or any other folder of the project -
 * then create it, register it in project.godot and save both. An internal
 * command, run by the "Add the character" quick fix.
 *
 * @param {{name: string, mood: string|null, timeline: string, folder?: string}} args - `folder` skips the question
 */
async function addCharacterCommand(args) {
  if (!projectRootUri || !args) { return; }
  const { name, mood } = args;
  let folder = args.folder;
  if (!folder) {
    const timelineUri = vscode.Uri.parse(args.timeline);
    const timeline = vscode.workspace.textDocuments.find(document => document.uri.toString() === timelineUri.toString())
      || await vscode.workspace.openTextDocument(timelineUri);
    const other = { label: '$(folder-opened) Other folder...', detail: 'Choose any folder of the project' };
    const items = rankCharacterFolders(timeline).map(({ folder: candidate, reason }) => ({
      label: `$(folder) ${candidate}/`,
      description: cachedResourcePaths.some(resPath => resPath.startsWith(`${candidate}/`)) ? '' : 'new folder',
      detail: reason,
      folder: candidate,
    }));
    const picked = await vscode.window.showQuickPick([...items, other], {
      title: `Where should ${name}.dch go?`,
      placeHolder: 'Folder of the new character file - the most likely first',
      matchOnDetail: true,
    });
    if (!picked) { return; }
    if (picked === other) {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        defaultUri: resolveResourcePath(items[0].folder),
        openLabel: `Put ${name}.dch here`,
      });
      if (!chosen || !chosen[0]) { return; }
      folder = toResPath(chosen[0]) || (normalizeFsPath(chosen[0].fsPath) === normalizeFsPath(projectRootUri.fsPath) ? 'res://' : null);
      if (!folder) {
        vscode.window.showErrorMessage(`${name}.dch must be inside the Godot project (${projectRootUri.fsPath}).`);
        return;
      }
    } else {
      folder = picked.folder;
    }
  }
  // The file name is the character's identifier for Dialogic, so it's
  // always `<name>.dch`, whatever the folder.
  const resPath = `${folder.replace(/\/+$/, '')}/${name}.dch`.replace(/^res:\/(?!\/)/, 'res://');
  if (cachedResourcePaths.some(existing => existing.toLowerCase() === resPath.toLowerCase())) {
    vscode.window.showErrorMessage(`${resPath} already exists.`);
    return;
  }
  const change = await createAddCharacterEdit(name, resPath, false, mood);
  if (!change) { return; }
  const [save, leftUnsaved] = splitFilesToSave(change.saveUris);
  await vscode.workspace.applyEdit(change.edit);
  await saveAndRefreshCommand(save, leftUnsaved);
}

/**
 * Quick fixes for every DTL Reader diagnostic in the range the lightbulb
 * was asked for. Translation fixes have their own provider
 * (provideTranslationCodeActions).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Range} range
 * @param {vscode.CodeActionContext} context
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function provideDiagnosticCodeActions(document, range, context) {
  const fixes = [];
  for (const diagnostic of context.diagnostics) {
    if (diagnostic.source !== 'DTL Reader') { continue; }
    const typed = document.getText(diagnostic.range);
    switch (diagnostic.code) {
      case 'unresolvedJump':
        fixes.push(...await createUnresolvedJumpFixes(document, diagnostic));
        break;
      case 'jumpTranslationId':
        fixes.push(...createJumpTranslationIdFixes(document, diagnostic));
        break;
      case 'unknownCharacter':
      case 'unknownSpeaker': {
        fixes.push(...createDidYouMeanFixes(document, diagnostic, stripCharacterNameQuotes(typed), cachedCharacterNames, formatCharacterName));
        const add = await createAddCharacterFix(document, diagnostic);
        if (add) { fixes.push(add); }
        break;
      }
      case 'unknownMood':
        fixes.push(...await createUnknownMoodFixes(document, diagnostic));
        break;
      case 'unknownVariable': {
        fixes.push(...createDidYouMeanFixes(document, diagnostic, typed, collectVariableReferencePaths()));
        fixes.push(...await createAddVariableFixes(document, diagnostic));
        break;
      }
      case 'unclosedBBCode':
        fixes.push(...createUnclosedTagFixes(document, diagnostic));
        break;
      case 'dchDefaultPortrait':
        fixes.push(...createDidYouMeanFixes(document, diagnostic, typed, parseDchPortraits(document.getText()).keys()));
        break;
      case 'dchMissingScene':
        fixes.push(...createDidYouMeanFixes(document, diagnostic, typed,
          cachedResourcePaths.filter(resPath => RESOURCE_EXTENSIONS.scene.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()))));
        break;
    }
  }
  return fixes;
}

// =============================================================================
// GO TO DEFINITION
// =============================================================================
// Ctrl+Click / F12 in a timeline: a jump leads to its label, a character to
// their .dch file, a mood to its portrait there, a `res://` path to its file,
// an autoload reference to its script (on the member's line) and a glossary
// word to its entry. In a .dch file: paths, and `default_portrait` to that
// portrait. Each result is a link, so the whole name (quotes, spaces, the
// full path) is underlined, not only the word under the mouse.

/**
 * A definition link from `originRange` to a place in a file.
 *
 * @param {vscode.Range} originRange
 * @param {vscode.Uri} uri
 * @param {vscode.Range} [targetRange] - defaults to the start of the file
 * @returns {vscode.LocationLink[]}
 */
function definitionLink(originRange, uri, targetRange = new vscode.Range(0, 0, 0, 0)) {
  return [{ originSelectionRange: originRange, targetUri: uri, targetRange, targetSelectionRange: targetRange }];
}

/**
 * The `res://` path under the cursor, if any - in quotes, in a `[img]`
 * tag, or inside a .dch image override (`"\"res://...\""`).
 *
 * @param {string} line
 * @param {number} character
 * @returns {{path: string, start: number, end: number} | null}
 */
function findResourcePathAtPosition(line, character) {
  const pattern = /res:\/\/[^"'\s[\]\\]+/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const end = match.index + match[0].length;
    if (character >= match.index && character <= end) { return { path: match[0], start: match.index, end }; }
  }
  return null;
}

/**
 * Definition of a `res://` path: the file, when it exists in the project.
 *
 * @param {number} line
 * @param {{path: string, start: number, end: number}} resource
 * @returns {vscode.LocationLink[] | undefined}
 */
function resourceDefinition(line, resource) {
  if (!projectRootUri) { return undefined; }
  if (cachedResourcePaths.length > 0 && !cachedResourcePaths.includes(resource.path)) { return undefined; }
  return definitionLink(new vscode.Range(line, resource.start, line, resource.end), resolveResourcePath(resource.path));
}

/**
 * The portrait name of a `[portrait=name]` text effect under the cursor,
 * with the line's speaker.
 *
 * @param {string} line
 * @param {number} character
 * @returns {{characterName: string, mood: string, range: {start: number, end: number}} | null}
 */
function findPortraitEffectAtPosition(line, character) {
  const speaker = findLineSpeaker(line);
  if (!speaker) { return null; }
  const pattern = /\[portrait=([^\]\s]+)\]/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const start = match.index + '[portrait='.length;
    const end = start + match[1].length;
    if (character >= start && character <= end) { return { characterName: speaker.name, mood: match[1], range: { start, end } }; }
  }
  return null;
}

/**
 * Definition of a mood: its portrait in the character's .dch file.
 *
 * @param {vscode.Range} originRange
 * @param {string} characterName
 * @param {string} mood
 * @returns {Promise<vscode.LocationLink[] | undefined>}
 */
async function portraitDefinition(originRange, characterName, mood) {
  const dchPath = cachedCharacterPaths.get(characterName);
  if (!dchPath) { return undefined; }
  try {
    const dchDocument = await vscode.workspace.openTextDocument(resolveResourcePath(dchPath));
    const range = findDchPortraitRange(dchDocument, mood);
    return range ? definitionLink(originRange, dchDocument.uri, range) : undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Definition of an autoload reference: the autoload's script (or scene),
 * on the member's declaration line - for an enum value, the value's own
 * line inside the enum.
 *
 * @param {NonNullable<ReturnType<typeof locateAutoloadReferenceAtPosition>>} reference
 * @returns {Promise<vscode.LocationLink[] | undefined>}
 */
async function autoloadDefinition(reference) {
  const { symbols, part, memberName, subName, range } = reference;
  if (part === 'global') {
    return definitionLink(range, resolveResourcePath(symbols.scenePath || symbols.scriptPath));
  }
  const member = findAutoloadMember(symbols, memberName);
  if (!member || typeof member.info.line !== 'number') { return undefined; }
  const uri = resolveResourcePath(symbols.scriptPath);
  let line = member.info.line;
  let character = 0;
  try {
    const script = await vscode.workspace.openTextDocument(uri);
    const name = part === 'value' ? subName : memberName;
    const namePattern = new RegExp(`\\b${name}\\b`);
    // An enum value may sit on a later line than `enum Name {`.
    for (let candidate = line; candidate < Math.min(script.lineCount, line + (part === 'value' ? 200 : 1)); candidate++) {
      const found = script.lineAt(candidate).text.search(namePattern);
      if (found !== -1) { line = candidate; character = found; break; }
    }
    const nameRange = new vscode.Range(line, character, line, character + name.length);
    return definitionLink(range, uri, nameRange);
  } catch (error) {
    return definitionLink(range, uri, new vscode.Range(line, 0, line, 0));
  }
}

/**
 * Definition of a `jump` target: the label (in this timeline or another
 * one), or the other timeline itself for its `Timeline/` part.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {NonNullable<ReturnType<typeof parseJumpLine>>} jump
 * @returns {vscode.LocationLink[] | undefined}
 */
function jumpDefinition(document, position, jump) {
  if (jump.target.includes('{') || position.character < jump.targetStart) { return undefined; }
  const target = resolveJumpTarget(document, jump);
  if (!target) { return undefined; }
  const line = position.line;
  // On the timeline part, or `jump Timeline/` with no label: open the
  // timeline itself.
  if (position.character < jump.labelStart || !jump.label) {
    return definitionLink(new vscode.Range(line, jump.targetStart, line, jump.labelStart - (jump.timeline === null ? 0 : 1)), target.uri);
  }
  const labelInfo = target.labels.get(jump.label);
  if (!labelInfo) { return undefined; }
  const labelRange = new vscode.Range(labelInfo.line, labelInfo.nameStart, labelInfo.line, labelInfo.nameStart + jump.label.length);
  return definitionLink(new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length), target.uri, labelRange);
}

/**
 * Go to Definition (Ctrl+Click / F12) in a timeline.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.LocationLink[] | vscode.Location | undefined>}
 */
async function provideTimelineDefinition(document, position) {
  const line = position.line;
  const text = document.lineAt(line).text;
  // Only a real `jump` command line (anchored to line start), not the word
  // "jump" inside a comment or spoken dialogue text.
  const jump = parseJumpLine(text);
  if (jump) { return jumpDefinition(document, position, jump); }
  const resource = findResourcePathAtPosition(text, position.character);
  if (resource) { return resourceDefinition(line, resource); }
  const mood = findMoodTagAtPosition(text, position.character) || findPortraitEffectAtPosition(text, position.character);
  if (mood) { return portraitDefinition(new vscode.Range(line, mood.range.start, line, mood.range.end), mood.characterName, mood.mood); }
  const character = findCharacterNameAtPosition(document, position);
  if (character) {
    const dchPath = cachedCharacterPaths.get(character.name);
    return dchPath && projectRootUri ? definitionLink(character.range, resolveResourcePath(dchPath)) : undefined;
  }
  const autoload = locateAutoloadReferenceAtPosition(document, position);
  if (autoload) { return autoloadDefinition(autoload); }
  // Anywhere else in text: a glossary word leads to its entry.
  return provideGlossaryDefinition(document, position);
}

/**
 * Go to Definition in a .dch file: a `res://` path to its file, and the
 * `default_portrait` value to that portrait.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.LocationLink[] | undefined}
 */
function provideDchDefinition(document, position) {
  const line = position.line;
  const text = document.lineAt(line).text;
  const resource = findResourcePathAtPosition(text, position.character);
  if (resource) { return resourceDefinition(line, resource); }
  const defaultMatch = text.match(/^(\s*&?"default_portrait"\s*:\s*")([^"]+)"/);
  if (!defaultMatch) { return undefined; }
  const start = defaultMatch[1].length;
  const end = start + defaultMatch[2].length;
  if (position.character < start || position.character > end) { return undefined; }
  const range = findDchPortraitRange(document, defaultMatch[2]);
  return range ? definitionLink(new vscode.Range(line, start, line, end), document.uri, range) : undefined;
}

// =============================================================================
// WORKSPACE SYMBOLS
// =============================================================================
// Go to Symbol in Workspace (Ctrl+T): every timeline, every label of every
// timeline, and every character.

/**
 * Whether the letters of `query` appear in `name` in order (VS Code's own
 * loose matching, which it then ranks) - case-insensitive.
 *
 * @param {string} query
 * @param {string} name
 * @returns {boolean}
 */
function matchesSymbolQuery(query, name) {
  const lowerName = name.toLowerCase();
  let index = 0;
  for (const ch of query.toLowerCase()) {
    if (ch === ' ') { continue; }
    index = lowerName.indexOf(ch, index);
    if (index === -1) { return false; }
    index++;
  }
  return true;
}

/**
 * @param {string} query
 * @returns {Promise<vscode.SymbolInformation[]>}
 */
async function provideWorkspaceSymbols(query) {
  const symbols = [];
  for (const timeline of await readAllTimelines()) {
    const fileName = timeline.uri.path.split('/').pop().replace(/\.dtl$/i, '');
    const container = timeline.identifier || fileName;
    if (matchesSymbolQuery(query, container)) {
      symbols.push(new vscode.SymbolInformation(container, vscode.SymbolKind.File, 'timeline', new vscode.Location(timeline.uri, new vscode.Position(0, 0))));
    }
    timeline.lines.forEach((text, line) => {
      const label = parseLabelLine(text);
      if (!label || !matchesSymbolQuery(query, label.name)) { return; }
      const range = new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length);
      symbols.push(new vscode.SymbolInformation(label.name, vscode.SymbolKind.Module, container, new vscode.Location(timeline.uri, range)));
    });
  }
  if (projectRootUri) {
    for (const [name, dchPath] of cachedCharacterPaths) {
      if (!matchesSymbolQuery(query, name)) { continue; }
      symbols.push(new vscode.SymbolInformation(name, vscode.SymbolKind.Class, 'character', new vscode.Location(resolveResourcePath(dchPath), new vscode.Position(0, 0))));
    }
  }
  return symbols;
}

// =============================================================================
// ACTIVATE
// =============================================================================
function activate(context) {
  bbcodeCharDecorationType = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(bbcodeCharDecorationType, { dispose: () => bbcodeDecorationTypes.forEach(type => type.dispose()) });
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => scheduleBbcodePreview()),
    vscode.workspace.onDidChangeTextDocument(event => scheduleBbcodePreview(event.document)),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dtlReader.preview')) { scheduleBbcodePreview(); } })
  );
  scheduleBbcodePreview();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('dtl', { provideHover: provideGlossaryHover }),
    vscode.languages.registerHoverProvider('dtl-translation', { provideHover: provideGlossaryHover }),
    { dispose: () => glossaryDecorationTypes.forEach(type => type.dispose()) }
  );
  // Glossary files are .tres resources - a change to one listed in
  // project.godot re-reads the project (which re-reads the glossaries).
  const glossaryWatcher = vscode.workspace.createFileSystemWatcher('**/*.tres');
  const onGlossaryFile = uri => {
    const resPath = projectRootUri ? 'res://' + normalizeFsPath(uri.fsPath).slice(normalizeFsPath(projectRootUri.fsPath).length).replace(/^\/+/, '') : '';
    if (cachedGlossaryEntries.some(entry => entry.file.toLowerCase() === resPath)) { refreshProjectGodotData(); }
  };
  glossaryWatcher.onDidChange(onGlossaryFile);
  glossaryWatcher.onDidCreate(onGlossaryFile);
  context.subscriptions.push(glossaryWatcher);
  translationViewMemento = context.workspaceState || null;
  // Created before the first project refresh, which already paints it.
  translationDecorationType = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(translationDecorationType);
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
  // the do/if/elif Global.member autocomplete and hover - same
  // full-refresh-on-any-change approach as the .dch/.tscn watcher above
  // (which also covers autoload nodes, i.e. autoloads pointing at a scene).
  const scriptWatcher = vscode.workspace.createFileSystemWatcher('**/*.gd');
  scriptWatcher.onDidChange(refreshProjectGodotData);
  scriptWatcher.onDidCreate(refreshProjectGodotData);
  scriptWatcher.onDidDelete(refreshProjectGodotData);
  context.subscriptions.push(scriptWatcher);
  // Timelines feed cross-timeline `jump Timeline/label` - re-read their
  // labels when one changes on disk, then re-check every open timeline.
  const timelineWatcher = vscode.workspace.createFileSystemWatcher('**/*.dtl');
  const refreshTimelines = async () => { await refreshTimelineLabels(); refreshAllDiagnostics(); };
  timelineWatcher.onDidChange(refreshTimelines);
  timelineWatcher.onDidCreate(refreshTimelines);
  timelineWatcher.onDidDelete(refreshTimelines);
  context.subscriptions.push(timelineWatcher);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('dtlReader.includeAddonAutoloads')) { refreshProjectGodotData(); }
      if (event.affectsConfiguration('dtlReader')) {
        refreshAllDiagnostics();
        updateAllTranslationDecorations();
      }
    })
  );
  // ---------------------------------------------------------------------------
  // Translations: Dialogic's CSV files, commands, inline view, quick fix
  // ---------------------------------------------------------------------------
  const csvWatcher = vscode.workspace.createFileSystemWatcher('**/dialogic_*.csv');
  const refreshCsv = async () => { await refreshTranslations(); refreshAllDiagnostics(); };
  csvWatcher.onDidChange(refreshCsv);
  csvWatcher.onDidCreate(refreshCsv);
  csvWatcher.onDidDelete(refreshCsv);
  context.subscriptions.push(
    csvWatcher,
    vscode.commands.registerCommand('dtlReader.translateLine', translateLineCommand),
    vscode.commands.registerCommand('dtlReader.nextUntranslated', nextUntranslatedCommand),
    vscode.commands.registerCommand('dtlReader.selectTranslationLanguage', selectTranslationLanguage),
    vscode.commands.registerCommand('dtlReader.openTranslationView', openTranslationViewCommand),
    vscode.window.onDidChangeActiveTextEditor(updateTranslationGlobeContext),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dtlReader.translation.globeButton')) { updateTranslationGlobeContext(); } }),
    vscode.commands.registerCommand('dtlReader.changeTranslationViewLanguages', changeTranslationViewLanguagesCommand),
    vscode.workspace.registerFileSystemProvider(TRANSLATION_VIEW_SCHEME, translationViewFileSystem = new TranslationViewFileSystem()),
    vscode.window.onDidChangeTextEditorSelection(syncTranslationScroll),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (!translationViewFileSystem) { return; }
      if (document.languageId === 'dtl') { translationViewFileSystem.refresh(document.uri); }
      else if (document.languageId === 'dch' || /\.tres$/i.test(document.uri.fsPath || '')) { translationViewFileSystem.refresh(); }
    }),
    vscode.languages.registerHoverProvider('dtl', { provideHover: provideTranslationHover }),
    vscode.languages.registerCodeActionsProvider('dtl', { provideCodeActions: provideTranslationCodeActions }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.window.onDidChangeVisibleTextEditors(updateAllTranslationDecorations),
    vscode.workspace.onDidChangeTextDocument(event => {
      vscode.window.visibleTextEditors.filter(editor => editor.document === event.document).forEach(updateTranslationDecorations);
    })
  );
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
          // [b] ... [/b]   <- Godot BBCode tags, opening or closing
          // -------------------------------------------------------------------
          const isCharacterCommandLine = /^\s*(?:join|update|leave)\b/.test(line);
          const bracketRegex =
            /\[\/?([A-Za-z_][A-Za-z0-9_]*\+?)/g;
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
              // In text, "[signal=..." is the text effect, not the [signal ...] event.
              const inText = !isCharacterCommandLine && (isPlayerFacingTextLine(line) || /^\s*-\s/.test(line) || bbcodePreviewStart(document, line) !== -1);
              const effectEntry = inText && /^[=\]]/.test(line.slice(end)) ? DTL_TEXT_EFFECTS.find(candidate => candidate.name === commandName) : undefined;
              // join/update/leave's own [options] bracket holds attribute
              // names (e.g. "[fade=..."), never BBCode, so a same-named
              // BBCode tag (like [fade]) mustn't shadow them there.
              const entry = effectEntry ||
                DTL_ENTRIES.find(
                  entry =>
                    entry.name === commandName
                ) || (isCharacterCommandLine ? undefined
                  : (isPlayerFacingTextLine(line) || /^\s*-\s/.test(line) ? DTL_TEXT_EFFECTS.find(entry => entry.name === commandName) : undefined)
                    || DTL_BBCODES.find(entry => entry.name === commandName));
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
                const enclosingEntry = findBracketOrBbcodeEntry(enclosingBracketMatch[1]);
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
            if (info && (info.displayName || info.nicknames.length > 0 || info.description || info.color || info.translationId)) {
              return new vscode.Hover(createCharacterDocumentation(characterHit.name, info), characterHit.range);
            }
          }
          // -------------------------------------------------------------------
          // Autoload scripts / nodes and their members
          //
          // do Global.apply_tint()      if Global.state == Global.State.IDLE
          //    ^^^^^^ ^^^^^^^^^^           {Global.max_hp}       ^^^^ hovering any part
          // -------------------------------------------------------------------
          const autoloadHit = findAutoloadReferenceAtPosition(document, position);
          if (autoloadHit) {
            return new vscode.Hover(autoloadHit.markdown, autoloadHit.range);
          }
          // -------------------------------------------------------------------
          // Dialogic variables
          //
          // {variable.test}      set {chapter} = 1
          //           ^^^^            ^^^^^^^ hovering either
          // -------------------------------------------------------------------
          const variableHit = findVariableAtPosition(document, position);
          if (variableHit) {
            return new vscode.Hover(variableHit.markdown, variableHit.range);
          }
          // -------------------------------------------------------------------
          // Moods / portraits and LayeredPortrait layers
          //
          // join John (happy) left [extra_data="set Head/LeftEye"]
          //            ^^^^^                         ^^^^ ^^^^^^^ hovering any
          // -------------------------------------------------------------------
          const moodHit = findMoodTagAtPosition(line, position.character);
          if (moodHit) {
            const markdown = createMoodDocumentation(moodHit.characterName, moodHit.mood);
            if (markdown) {
              return new vscode.Hover(markdown, new vscode.Range(position.line, moodHit.range.start, position.line, moodHit.range.end));
            }
          }
          const layerHit = findLayerDocumentationAtPosition(line, position.character);
          if (layerHit) {
            return new vscode.Hover(layerHit.markdown, new vscode.Range(position.line, layerHit.range.start, position.line, layerHit.range.end));
          }
          // -------------------------------------------------------------------
          // Labels - on `label NAME` or `jump NAME`
          // -------------------------------------------------------------------
          const labelLine = parseLabelLine(line);
          if (labelLine && position.character >= labelLine.nameStart && position.character <= labelLine.nameStart + labelLine.name.length) {
            const labelInfo = collectDocumentLabels(document).get(labelLine.name);
            if (labelInfo) {
              return new vscode.Hover(createLabelDocumentation(labelLine.name, labelInfo), new vscode.Range(position.line, labelLine.nameStart, position.line, labelLine.nameStart + labelLine.name.length));
            }
          }
          const jump = parseJumpLine(line);
          if (jump && !jump.target.includes('{')) {
            const labelEnd = jump.labelStart + jump.label.length;
            if (jump.timeline !== null && position.character >= jump.targetStart && position.character < jump.labelStart) {
              const labels = getTimelineLabels(jump.timeline);
              if (labels) {
                const markdown = new vscode.MarkdownString();
                markdown.appendMarkdown(`**${jump.timeline}** _(Dialogic timeline)_\n\n\`${cachedTimelinePaths.get(jump.timeline)}\`\n\n`);
                markdown.appendMarkdown(labels.size > 0 ? `Labels: ${[...labels.keys()].map(name => `\`${name}\``).join(', ')}` : '_No labels._');
                return new vscode.Hover(markdown, new vscode.Range(position.line, jump.targetStart, position.line, jump.labelStart - 1));
              }
            } else if (jump.label && position.character >= jump.labelStart && position.character <= labelEnd) {
              const target = resolveJumpTarget(document, jump);
              const labelInfo = target && target.labels.get(jump.label);
              if (labelInfo) {
                return new vscode.Hover(createLabelDocumentation(jump.label, labelInfo, target.timeline), new vscode.Range(position.line, jump.labelStart, position.line, labelEnd));
              }
            }
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
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('dch', { provideCompletionItems: provideDchCompletions }, '"', ':', ' ', '/', '&'),
    vscode.languages.registerHoverProvider('dch', { provideHover: provideDchHover }),
    vscode.languages.registerColorProvider('dch', { provideDocumentColors: provideDchColors, provideColorPresentations: provideDchColorPresentations }),
    vscode.languages.registerColorProvider('dtl', { provideDocumentColors: provideTimelineColors, provideColorPresentations: provideTimelineColorPresentations })
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider('dtl', { provideDocumentSymbols: provideTimelineOutline }, { label: 'DTL' })
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider('dtl', { provideDocumentSemanticTokens: provideAutoloadSemanticTokens }, SEMANTIC_TOKENS_LEGEND)
  );
  // ===========================================================================
  // GO TO DEFINITION, QUICK FIXES AND WORKSPACE SYMBOLS
  // ===========================================================================
  const quickFixMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('dtl', { provideDefinition: provideTimelineDefinition }),
    vscode.languages.registerDefinitionProvider('dch', { provideDefinition: provideDchDefinition }),
    vscode.languages.registerCodeActionsProvider('dtl', { provideCodeActions: provideDiagnosticCodeActions }, quickFixMetadata),
    vscode.languages.registerCodeActionsProvider('dch', { provideCodeActions: provideDiagnosticCodeActions }, quickFixMetadata),
    vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols }),
    vscode.commands.registerCommand('dtlReader.saveAndRefresh', saveAndRefreshCommand),
    vscode.commands.registerCommand('dtlReader.addCharacter', addCharacterCommand),
    vscode.commands.registerCommand('dtlReader.playTimeline', playTimelineCommand),
    vscode.commands.registerCommand('dtlReader.playTimelineFromLine', playTimelineFromLineCommand),
    { dispose: () => { if (godotOutputChannel) { godotOutputChannel.dispose(); } } }
  );
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider('dtl', { provideReferences: provideLabelReferences }),
    vscode.languages.registerRenameProvider('dtl', labelRenameProvider),
    vscode.languages.registerCodeLensProvider('dtl', { provideCodeLenses: provideLabelCodeLenses })
  );
  // ===========================================================================
  // DIAGNOSTICS (unresolved `jump` targets, unclosed BBCode-style balises)
  // ===========================================================================
  diagnosticCollection = vscode.languages.createDiagnosticCollection('dtl');
  context.subscriptions.push(diagnosticCollection);
  vscode.workspace.textDocuments.forEach(updateDiagnostics);
  context.subscriptions.push(
    // A timeline opened (or closed) changes what the others jump to and
    // use - even one not registered yet - so all of them are re-checked.
    vscode.workspace.onDidOpenTextDocument(document => (document.languageId === 'dtl' ? refreshAllDiagnostics() : updateDiagnostics(document)))
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'dtl') { refreshAllDiagnostics(); }
      if (event.document.languageId === 'dch') { updateDiagnostics(event.document); }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.languageId === 'dtl') { refreshAllDiagnostics(); }
      diagnosticCollection.delete(document.uri); // after: the re-check mustn't bring it back
    })
  );
  // ===========================================================================
  // COMPLETION PROVIDER
  // ===========================================================================
  const completionProvider =
    vscode.languages.registerCompletionItemProvider('dtl',
      {
        provideCompletionItems(document, position, token, context) {
          isolatedDocumentData = projectRootUri ? null : collectIsolatedDocumentData(document, position.line);
          const line = document.lineAt(position.line).text;
          const beforeCursor = line.substring(0,position.character);
          const items = [];
          // The character that auto-opened the suggest widget (one of the
          // trigger characters registered below), or null when the person
          // is typing a word or asked explicitly with Ctrl+Space. Contexts
          // that only make sense for a specific trigger (e.g. '.' after an
          // autoload name) check this, so e.g. a '.' ending a dialogue
          // sentence doesn't pop up a list of every word in the file.
          const triggerCharacter = context && context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
            ? context.triggerCharacter
            : null;
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
          // AUTOLOADS: "do Global." / "if Global." / "elif Global." -
          // either the autoload name itself, or a member once "Name." has
          // been typed. Usable anywhere in the expression (not just right
          // after the keyword), since if/elif conditions can combine an
          // autoload reference with variables/operators. Always returns
          // here (even an empty list) - nothing else below applies to an
          // expression line, and falling through used to dump every
          // character name and dialogue word into the list instead.
          // ===================================================================
          const setTargetItems = createSetTargetSuggestions(beforeCursor, position);
          if (setTargetItems) {
            return setTargetItems;
          }
          if (isGlobalScriptExpressionLine(beforeCursor)) {
            return createGlobalScriptSuggestions(beforeCursor, triggerCharacter).map(item => {
              // Ranges are built on line 0 inside the helper - move them to this line.
              if (item.range && item.range.start.line === 0 && position.line !== 0) {
                item.range = new vscode.Range(position.line, item.range.start.character, position.line, item.range.end.character);
              }
              return item;
            });
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
                for (const name of completionCharacterNames()) {
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
                for (const name of completionCharacterNames()) {
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
                  items.push(...createAttributeValueSuggestions(commandEntry.name, attributeName, typedValue, position));
                }
              }
              return items;
            }
          }
          // =========================================================================
          // BRACKET COMMANDS
          // Inside dialogue/narration text and choices, Godot BBCode tags are
          // offered after Dialogic's own commands. To keep the list short, a
          // bare "[" only offers the common tags
          // (COMMON_BBCODE_NAMES); the rest show up once a letter of their
          // name is typed - the list is marked incomplete so VS Code asks
          // again on every keystroke instead of only filtering the first one.
          // =========================================================================
          const imagePathMatch = beforeCursor.match(/\[img\b[^\]]*\]([^\[\]]*)$/);
          if (imagePathMatch) {
            return createPathSuggestions(imagePathMatch[1], position, RESOURCE_EXTENSIONS.image, { quote: false });
          }
          const fontPathMatch = beforeCursor.match(/\[font(?:\s[^\]]*?\bname)?=("?[^\s\]"]*)$/);
          if (fontPathMatch) {
            return createPathSuggestions(fontPathMatch[1], position, RESOURCE_EXTENSIONS.font, { quote: false });
          }
          // Values of Dialogic text effects: [portrait=... [mood=... [extra_data=...
          const effectValueMatch = beforeCursor.match(/\[(portrait|mood|extra_data)=([^\]]*)$/);
          if (effectValueMatch && isInPlayerFacingText(beforeCursor.slice(0, effectValueMatch.index))) {
            return createTextEffectValueSuggestions(line, effectValueMatch[1], effectValueMatch[2]);
          }
          const closingTagMatch = beforeCursor.match(/\[\/([A-Za-z_][A-Za-z0-9_]*)?$/);
          if (closingTagMatch) {
            return createClosingTagSuggestions(beforeCursor.slice(0, closingTagMatch.index), closingTagMatch[1] || '', line, position);
          }
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
              item.sortText = `0_${entry.name}`;
              items.push(item);
            }
            // BBCode only makes sense inside dialogue/narration text and
            // choices - a standalone "[" line is a Dialogic event.
            const bbcodeMode = vscode.workspace.getConfiguration('dtlReader').get('completion.bbcode', 'common');
            if (!isInPlayerFacingText(beforeCursor.slice(0, bracketMatch.index))) {
              return items;
            }
            if (bbcodeMode === 'off') {
              const effectRange = new vscode.Range(position.line, bracketMatch.index + 1, position.line, line[position.character] === ']' ? position.character + 1 : position.character);
              for (const entry of DTL_TEXT_EFFECTS) {
                if (entry.name.startsWith(prefix)) { items.push(createTextEffectCompletion(entry, effectRange)); }
              }
              return items;
            }
            const showAllBbcodes = prefix !== '' || bbcodeMode === 'all';
            // Replace an auto-closed "]" right after the cursor, since
            // the BBCode snippet brings its own.
            const nameStart = bracketMatch.index + 1;
            const replaceEnd = line[position.character] === ']' ? position.character + 1 : position.character;
            const range = new vscode.Range(position.line, nameStart, position.line, replaceEnd);
            // Dialogic's own text effects come right after its commands.
            for (const entry of DTL_TEXT_EFFECTS) {
              if (entry.name.startsWith(prefix)) { items.push(createTextEffectCompletion(entry, range)); }
            }
            for (const entry of DTL_BBCODES) {
              if (!showAllBbcodes && !COMMON_BBCODE_NAMES.has(entry.name)) { continue; }
              if (entry.name.startsWith(prefix)) {
                items.push(createBbcodeCompletion(entry, range));
              }
            }
            return new vscode.CompletionList(items, !showAllBbcodes);
          }
          // =========================================================================
          // BRACKET COMMAND PARAMETERS (e.g. inside `[wait time=1.5 |`)
          // =========================================================================
          const openBracketIndex = beforeCursor.lastIndexOf('[');
          if (openBracketIndex !== -1 && !beforeCursor.slice(openBracketIndex).includes(']')) {
            const bracketContent = beforeCursor.slice(openBracketIndex + 1);
            const commandNameMatch = bracketContent.match(/^([A-Za-z_][A-Za-z0-9_]*)\s/);
            if (commandNameMatch) {
              const bracketEntry = findBracketOrBbcodeEntry(commandNameMatch[1]);
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
                const valueSuggestions = createAttributeValueSuggestions(bracketEntry.name, attributeName, typedValue, position);
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
              for (const kind of completionAudioChannels()) { items.push(createAudioKindCompletion(kind)); }
              return items;
            }
            const argumentsParts = argumentsText.split(/\s+/);
            // Kind is being typed: "audio mu|"
            if (argumentsParts.length === 1) {
              const prefix = argumentsParts[0].toLowerCase();
              for (const kind of completionAudioChannels()) {
                if (kind.toLowerCase().startsWith(prefix)) { items.push(createAudioKindCompletion(kind)); }
              }
              return items;
            }
            // Kind fully typed, waiting for or typing the path:
            // "audio music |" or "audio music "res:/|" - only audio files
            // are offered. The typed value is everything after the kind
            // (not just the next whitespace-separated token), so a path
            // containing spaces still filters correctly.
            if (argumentsParts.length >= 2) {
              const typedValue = argumentsText.replace(/^\S+\s+/, '');
              if (/^"[^"]*"/.test(typedValue)) {
                return items; // path already written and closed
              }
              items.push(...createPathSuggestions(typedValue, position, RESOURCE_EXTENSIONS.audio));
              if (typedValue === '' && items.length === 0) {
                items.push(createAudioPathCompletion()); // no audio file in the project yet
              }
              return items;
            }
          }
          // ===================================================================
          // JUMP
          // ===================================================================
          // "jump |" offers this timeline's labels and the other timelines
          // ("Name/"); "jump Name/|" offers that timeline's labels.
          const jumpCommandMatch = beforeCursor.match(/^\s*jump\s+([^#]*)$/);
          if (jumpCommandMatch) {
            const typed = jumpCommandMatch[1];
            const lastSlash = typed.lastIndexOf('/');
            if (lastSlash !== -1) {
              const timeline = typed.slice(0, lastSlash);
              const labelPrefix = typed.slice(lastSlash + 1);
              const labels = getTimelineLabels(timeline);
              if (!labels) { return items; }
              const range = new vscode.Range(position.line, position.character - labelPrefix.length, position.line, position.character);
              for (const [label, info] of labels) {
                if (label.toLowerCase().startsWith(labelPrefix.toLowerCase())) {
                  items.push(createLabelCompletion(label, info, range, timeline));
                }
              }
              return items;
            }
            const range = new vscode.Range(position.line, position.character - typed.length, position.line, position.character);
            const prefix = typed.toLowerCase();
            for (const [label, info] of collectDocumentLabels(document)) {
              if (label.toLowerCase().startsWith(prefix)) {
                const item = createLabelCompletion(label, info, range, null);
                item.sortText = `0_${label}`;
                items.push(item);
              }
            }
            const currentTimeline = findTimelineIdentifier(document);
            for (const identifier of cachedTimelinePaths.keys()) {
              if (identifier !== currentTimeline && identifier.toLowerCase().startsWith(prefix)) {
                items.push(createTimelineCompletion(identifier, range));
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
            for (const name of completionCharacterNames()) {
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
            for (const name of completionCharacterNames()) {
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
            // Whole blocks (choice, condition, loop...), only on an empty line
            // being started - not in front of existing text.
            if (line.slice(position.character).trim() === '') {
              items.push(...createBlockSnippets().filter(item => item.label.label.startsWith(prefix)));
            }
            return items;
          }
          // =========================================================================
          // DIALOGUE TEXT (word-based suggestions, VS Code "txt" style)
          // Only while a word is being typed: a trigger character here
          // (a '.' or ' ' ending a sentence, a "'" in "don't", ...) isn't
          // the start of anything worth suggesting.
          // =========================================================================
          if (isInsideDialogueText(beforeCursor)) {
            const wordsEnabled = vscode.workspace.getConfiguration('dtlReader').get('completion.dialogueWords', true);
            return triggerCharacter || !wordsEnabled ? [] : createWordSuggestions(document, beforeCursor);
          }
          /// Fall back
          if (triggerCharacter) {
            return [];
          }
          for (const name of completionCharacterNames()) {
            items.push(createCharacterCompletion(name));
          }
          if (vscode.workspace.getConfiguration('dtlReader').get('completion.dialogueWords', true)) {
            items.push(...createWordSuggestions(document, beforeCursor));
          }
          return items;
          }
        }
    , ' ', '[', '=', '(', '/', '"', "'", '{', '.');
  context.subscriptions.push(completionProvider);
  // Internals the test suite checks directly (`extension.exports`) - not an
  // API for other extensions.
  return { forTests: { rankCharacterFolders, godotUserDataDir, setConfigFileValues, parseCustomEventScript, findGodotExecutable, computeDialogicEventIndices, scriptStrings: () => cachedScriptStrings, resourcePaths: () => cachedResourcePaths } };
}
// =============================================================================
// DEACTIVATE
// =============================================================================
function deactivate() {}

module.exports = { activate, deactivate };
