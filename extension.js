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
 * Find the autoload reference under the cursor, if any - the autoload name
 * itself (`Global`), one of its members (`Global.apply_tint`,
 * `Global.max_hp`, `Global.State`), or a named enum's value
 * (`Global.State.IDLE`) - resolved against cachedAutoloadSymbols. Only
 * looked for where Dialogic actually evaluates such references: a
 * `do`/`if`/`elif` expression, or inside a `{...}` variable block. Used by
 * the hover provider - isGlobalScriptExpressionLine is defined further
 * down alongside the completion logic that shares this same line shape.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{markdown: vscode.MarkdownString, range: vscode.Range} | null}
 */
function findAutoloadReferenceAtPosition(document, position) {
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

    if (covers(globalStart, globalName)) {
      return { markdown: createAutoloadDocumentation(globalName, symbols), range: rangeOf(globalStart, globalName) };
    }
    if (covers(memberStart, memberName)) {
      const markdown = createAutoloadMemberDocumentation(globalName, memberName, symbols);
      return markdown ? { markdown, range: rangeOf(memberStart, memberName) } : null;
    }
    if (subName && covers(subStart, subName)) {
      const enumInfo = symbols.enums.get(memberName);
      const valueInfo = enumInfo && enumInfo.values.find(value => value.name === subName);
      return valueInfo
        ? { markdown: createEnumValueDocumentation(globalName, memberName, valueInfo), range: rangeOf(subStart, subName) }
        : null;
    }
  }
  return null;
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
  return cachedResourcePaths
    .filter(path => path.toLowerCase().startsWith(prefix))
    .filter(path => !extensions || extensions.includes(path.slice(path.lastIndexOf('.') + 1).toLowerCase()))
    .map(path => createPathCompletion(path, quote, range));
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
  for (const [identifier, resPath] of cachedTimelinePaths) {
    try {
      const bytes = await vscode.workspace.fs.readFile(resolveResourcePath(resPath));
      labelsByTimeline.set(identifier, collectLabelsFromLines(Buffer.from(bytes).toString('utf8').split(/\r?\n/)));
    } catch (error) {
      console.error(`DTL Reader: timeline "${identifier}" declares "${resPath}" but it could not be read - its labels are unavailable for jump.`, error);
    }
  }
  cachedTimelineLabels = labelsByTimeline;
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
 * @typedef {{params: string, returnType: string|null, doc: string, isStatic: boolean}} GdFunctionInfo
 * @typedef {{type: string|null, defaultValue: string|null, doc: string, isStatic: boolean}} GdVariableInfo
 * @typedef {{type: string|null, value: string, doc: string}} GdConstantInfo
 * @typedef {{name: string, value: string, doc: string}} GdEnumValueInfo
 * @typedef {{values: GdEnumValueInfo[], doc: string}} GdEnumInfo
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
      code = code.slice(annotationMatch[0].length);
    }
    if (code === '') { continue; }

    if (/^(?:extends|class_name)\b/.test(code)) {
      if (pendingDocLines.length > 0 && !symbols.doc) { symbols.doc = takeDoc(); }
      continue;
    }

    const funcMatch = code.match(/^(static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (funcMatch) {
      seenMember = true;
      const doc = takeDoc();
      const name = funcMatch[2];
      const lineOffset = stripGdComment(rawLine).indexOf(funcMatch[0]);
      const openIndex = lineOffset + funcMatch[0].length - 1;
      const joined = joinUntilBracketCloses(lines, i, openIndex);
      if (!joined) { continue; }
      i = joined.lastLineIndex;
      if (name.startsWith('_')) { continue; }
      const params = joined.text.slice(openIndex + 1, joined.closeIndex).replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
      const returnMatch = joined.text.slice(joined.closeIndex + 1).match(/^\s*->\s*([A-Za-z_][A-Za-z0-9_.\[\], ]*?)\s*:/);
      symbols.functions.set(name, { params, returnType: returnMatch ? returnMatch[1] : null, doc, isStatic: !!funcMatch[1] });
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
      });
      continue;
    }

    const constMatch = code.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*:?=\s*(.*)$/);
    if (constMatch) {
      seenMember = true;
      const doc = takeDoc();
      if (constMatch[1].startsWith('_')) { continue; }
      symbols.constants.set(constMatch[1], { type: constMatch[2] ? constMatch[2].trim() : null, value: constMatch[3].trim(), doc });
      continue;
    }

    const enumMatch = code.match(/^enum\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\{/);
    if (enumMatch) {
      seenMember = true;
      const doc = takeDoc();
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
        if (!enumName.startsWith('_')) { symbols.enums.set(enumName, { values, doc }); }
      } else {
        for (const value of values) {
          symbols.constants.set(value.name, { type: 'int', value: value.value, doc: value.doc || doc });
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
    cachedAutoloadSymbols = new Map();
    cachedAutoloadNames = new Set();
    cachedPortraitDetails = new Map();
    cachedTimelinePaths = new Map();
    cachedTimelineLabels = new Map();
    declaredProjectData = { characters: false, variables: false, timelines: false };
    projectRootUri = null;
    cachedResourcePaths = [];
    refreshAllDiagnostics();
    return;
  }
  projectRootUri = vscode.Uri.joinPath(matches[0], '..');
  try {
    const bytes = await vscode.workspace.fs.readFile(matches[0]);
    const text = Buffer.from(bytes).toString('utf8');
    cachedCharacterNames = extractCharacterNames(text);
    cachedAudioChannels = extractAudioChannels(text);
    cachedVariablesTree = extractVariablesTree(text);
    const dialogicSection = (text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/) || [])[1] || '';
    declaredProjectData = {
      characters: /directories\/dch_directory\s*=/.test(dialogicSection),
      variables: /(?:^|\n)variables\s*=/.test(dialogicSection),
      timelines: /directories\/dtl_directory\s*=/.test(dialogicSection),
    };
    cachedTimelinePaths = extractDialogicDirectory(text, 'dtl');
    await refreshTimelineLabels();
    await refreshCharacterMoods(extractCharacterPaths(text));
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
  refreshAllDiagnostics();
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
  for (const [name, dchPath] of characterPaths) {
    try {
      const dchBytes = await vscode.workspace.fs.readFile(resolveResourcePath(dchPath));
      const dchText = Buffer.from(dchBytes).toString('utf8');
      const portraits = parseDchPortraits(dchText);
      infoByCharacter.set(name, parseDchCharacterInfo(dchText));

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
    markdown.appendMarkdown(`[Godot documentation](${entry.docsUrl})`);
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
 * Parse a `label` line the way Dialogic does (`label +(?<name>[^(]+)
 * (\((?<display_name>.+)\))?`): the name is everything up to an optional
 * `(Display Name)`, so it may contain spaces.
 *
 * @param {string} text - one line
 * @returns {{name: string, displayName: string|null, nameStart: number} | null}
 */
function parseLabelLine(text) {
  const match = text.match(/^(\s*label\s+)([^(\r\n]*?)\s*(?:\((.*)\))?\s*$/);
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
 * @param {string} text - one line
 * @returns {{target: string, timeline: string|null, label: string, targetStart: number, labelStart: number} | null}
 */
function parseJumpLine(text) {
  const match = text.match(/^(\s*jump\s+)(.*?)\s*$/);
  if (!match || match[2] === '') { return null; }
  const target = match[2];
  const targetStart = match[1].length;
  const lastSlash = target.lastIndexOf('/');
  if (lastSlash === -1) {
    return { target, timeline: null, label: target, targetStart, labelStart: targetStart };
  }
  return {
    target,
    timeline: target.slice(0, lastSlash),
    label: target.slice(lastSlash + 1).trim(),
    targetStart,
    labelStart: targetStart + lastSlash + 1,
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
    const jump = parseJumpLine(document.lineAt(line).text);
    if (!jump || jump.target.includes('{')) { continue; }
    if (jump.timeline === null) {
      if (!localLabels.has(jump.label)) {
        diagnostics.push(new vscode.Diagnostic(
          new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length),
          `No "label ${jump.label}" in this timeline - Dialogic will print an error and skip this jump.`,
          vscode.DiagnosticSeverity.Error
        ));
      }
      continue;
    }
    if (!projectRootUri || !declaredProjectData.timelines) { continue; }
    const labels = getTimelineLabels(jump.timeline);
    if (!labels) {
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(line, jump.targetStart, line, jump.targetStart + jump.timeline.length),
        `No timeline "${jump.timeline}" in this project (project.godot's directories/dtl_directory).`,
        vscode.DiagnosticSeverity.Error
      ));
    } else if (jump.label && !labels.has(jump.label)) {
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length),
        `No "label ${jump.label}" in the timeline "${jump.timeline}" - Dialogic will print an error and skip this jump.`,
        vscode.DiagnosticSeverity.Error
      ));
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

  if (parentSegments.length > 0 && !cachedVariablesTree.has(parentSegments[0])) {
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
  if (parentSegments.length === 0) {
    for (const name of cachedAutoloadSymbols.keys()) {
      if (!cachedVariablesTree.has(name) && name.toLowerCase().startsWith(prefix)) {
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
 * - after `do`, `if`, `elif` or `while` (group 1 is the keyword);
 * - after the assignment operator of `set {variable} = ` (also `+=`,
 *   `-=`, `*=`, `/=`), where group 1 is undefined.
 * Requires whitespace after the keyword (or the `=`, for set) so
 * still-typing the keyword itself (e.g. text ending in exactly "do") isn't
 * mistaken for an already-complete keyword with an empty expression.
 *
 * @type {RegExp}
 */
const EXPRESSION_START_PATTERN = /^\s*(?:(do|if|elif|while)\s+|set\s+\{[^}]*\}\s*[-+*/]?=\s*)/;

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
 * Build completions for an expression - after `do`/`if`/`elif`/`while`,
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
 * - `if`/`elif`/`while` conditions and `set` values can use anything, so
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
  const nameMatch = expression.match(/(?:^|[\s(=!<>+\-*/%,&|])([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (!nameMatch) { return []; }
  const typedName = nameMatch[1] || '';
  if (triggerCharacter && typedName === '') {
    const beforeName = expression.trimEnd();
    if (beforeName !== '' && !/(?:\b(?:and|or|not)|&&|\|\||!)$/.test(beforeName)) { return []; }
  }
  const prefix = typedName.toLowerCase();
  const items = [];
  for (const name of cachedAutoloadSymbols.keys()) {
    if (name.toLowerCase().startsWith(prefix)) {
      items.push(createGlobalNameCompletion(name));
    }
  }
  return items;
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
    if (RESERVED_BRACKET_NAMES.has(name) || SELF_CLOSING_BBCODE_NAMES.has(name)) { continue; }
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
      if (RESERVED_BRACKET_NAMES.has(tagName) || SELF_CLOSING_BBCODE_NAMES.has(tagName)) {
        continue; // a DTL command, or a BBCode tag like [br] that never has a closer
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
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(line, nameStart, line, nameStart + match[2].length),
        commandMatch
          ? `"${name}" is not a Dialogic character of this project (not in project.godot's directories/dch_directory).`
          : `"${name}" is not a Dialogic character of this project - Dialogic will show this whole line, "${name}:" included, as narration.`,
        commandMatch ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
      ));
      continue;
    }
    const mood = match[4];
    const moods = cachedCharacterMoods.get(name);
    if (mood && moods && moods.size > 0 && !moods.has(mood)) {
      const moodStart = nameStart + match[2].length + match[3].indexOf(mood);
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(line, moodStart, line, moodStart + mood.length),
        `"${mood}" is not a portrait of ${name}. Available: ${[...moods.keys()].join(', ')}.`,
        vscode.DiagnosticSeverity.Error
      ));
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
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(line, start, line, start + match[1].length),
        problem,
        vscode.DiagnosticSeverity.Error
      ));
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
  if (document.languageId !== 'dtl') {
    return;
  }

  const diagnostics = [
    ...findUnresolvedJumpDiagnostics(document),
    ...findUnclosedBaliseDiagnostics(document),
    ...findUnknownCharacterDiagnostics(document),
    ...findUnknownVariableDiagnostics(document)
  ];

  diagnosticCollection.set(document.uri, diagnostics);
}

// =============================================================================
// OUTLINE (document symbols)
// =============================================================================

/**
 * Build the outline of a timeline - what the Outline view, breadcrumbs,
 * sticky scroll and "Go to Symbol" (Ctrl+Shift+O) show.
 *
 * Top level: one entry per `label`, as Dialogic organizes a timeline -
 * each spanning until the next label (lines before the first label sit at
 * the top level directly). With `dtlReader.outline.showFlow` on (default),
 * each label also lists the timeline's flow, nested by indentation like
 * the timeline itself: `if`/`elif`/`else`/`while` blocks, choices, and the
 * events that leave the current flow (`jump`, `return`, `[end_timeline]`).
 * Dialogue lines, joins, etc. are left out to keep it readable.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.DocumentSymbol[]}
 */
function provideTimelineOutline(document) {
  const showFlow = vscode.workspace.getConfiguration('dtlReader').get('outline.showFlow', true);
  const lines = documentLines(document);
  const labelDocs = collectLabelsFromLines(lines);
  const rootSymbols = [];
  let currentLabel = null;
  // Open flow blocks (if/elif/else/while/choice), innermost last.
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
      closeBlocksFrom(0);
      closeLabel();
      const info = labelDocs.get(label.name);
      currentLabel = new vscode.DocumentSymbol(
        label.name,
        label.displayName || (info && info.doc ? info.doc.split('\n')[0] : ''),
        vscode.SymbolKind.Module,
        lineRange(line),
        new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length)
      );
      rootSymbols.push(currentLabel);
      lastContentLine = line;
      continue;
    }
    lastContentLine = line;
    if (!showFlow) { continue; }

    const flowMatch = trimmed.match(/^(if|elif|else|while)\b\s*(.*?)\s*:?\s*$/);
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
    } else if (jumpMatch) {
      const name = jumpMatch[1] ? `jump ${jumpMatch[2]}` : (jumpMatch[3] || jumpMatch[4]);
      addSymbol(new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Event, lineRange(line, indent), lineRange(line, indent)));
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
            /\[\/?([A-Za-z_][A-Za-z0-9_]*)/g;
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
              // join/update/leave's own [options] bracket holds attribute
              // names (e.g. "[fade=..."), never BBCode, so a same-named
              // BBCode tag (like [fade]) mustn't shadow them there.
              const entry =
                DTL_ENTRIES.find(
                  entry =>
                    entry.name === commandName
                ) || (isCharacterCommandLine ? undefined : DTL_BBCODES.find(entry => entry.name === commandName));
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
            if (info && (info.displayName || info.nicknames.length > 0 || info.description || info.color)) {
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
    vscode.languages.registerDocumentSymbolProvider('dtl', { provideDocumentSymbols: provideTimelineOutline }, { label: 'DTL' })
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider('dtl', { provideDocumentSemanticTokens: provideAutoloadSemanticTokens }, SEMANTIC_TOKENS_LEGEND)
  );
  // ===========================================================================
  // DEFINITION PROVIDER (ctrl+click / F12 on a `jump NAME` target)
  // ===========================================================================
  const definitionProvider =
    vscode.languages.registerDefinitionProvider(
      'dtl',
      {
        provideDefinition(document, position) {
          // Only a real `jump` command line (anchored to line start), not
          // the word "jump" inside a comment or spoken dialogue text.
          const jump = parseJumpLine(document.lineAt(position.line).text);
          if (!jump || jump.target.includes('{') || position.character < jump.targetStart) {
            return undefined;
          }
          const target = resolveJumpTarget(document, jump);
          if (!target) {
            return undefined;
          }
          // On the timeline part, or `jump Timeline/` with no label: open
          // the timeline itself.
          if (position.character < jump.labelStart || !jump.label) {
            return new vscode.Location(target.uri, new vscode.Position(0, 0));
          }
          const labelInfo = target.labels.get(jump.label);
          return labelInfo ? new vscode.Location(target.uri, new vscode.Position(labelInfo.line, labelInfo.nameStart)) : undefined;
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
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'dtl') { refreshAllDiagnostics(); }
    })
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
        provideCompletionItems(document, position, token, context) {
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
          if (isGlobalScriptExpressionLine(beforeCursor)) {
            return createGlobalScriptSuggestions(beforeCursor, triggerCharacter);
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
            if (!isInPlayerFacingText(beforeCursor.slice(0, bracketMatch.index))) {
              return items;
            }
            const showAllBbcodes = prefix !== '';
            // Replace an auto-closed "]" right after the cursor, since
            // the BBCode snippet brings its own.
            const nameStart = bracketMatch.index + 1;
            const replaceEnd = line[position.character] === ']' ? position.character + 1 : position.character;
            const range = new vscode.Range(position.line, nameStart, position.line, replaceEnd);
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
          const jumpCommandMatch = beforeCursor.match(/^\s*jump\s+(.*)$/);
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
          // Only while a word is being typed: a trigger character here
          // (a '.' or ' ' ending a sentence, a "'" in "don't", ...) isn't
          // the start of anything worth suggesting.
          // =========================================================================
          if (isInsideDialogueText(beforeCursor)) {
            return triggerCharacter ? [] : createWordSuggestions(document, beforeCursor);
          }
          /// Fall back
          if (triggerCharacter) {
            return [];
          }
          for (const name of cachedCharacterNames) {
            items.push(createCharacterCompletion(name));
          }
          items.push(...createWordSuggestions(document, beforeCursor));
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
