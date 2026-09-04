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
      'pos':'Position can be specified like this: x0.5 y1, x100px y1% By default x and y are interpreted as relative to the viewport size, meaning 0.5 means half the width/height of the window. Position defines the ORIGIN of the portrait (usually the bottom center). When first joining a character, the position, size and rotation will be copied from the first portrait preset found. This means if you just want to vary the position along the x axis, a simple pos=x0.3 is usually enough and all the other values will be correct by default.',
      'size':'Size can be specified like this: x0.5 y1, x100px y1% By default x and y are interpreted as relative to the viewport size, meaning 0.5 means half the width/height of the window. Position defines the ORIGIN of the portrait (usually the bottom center). When first joining a character, the position, size and rotation will be copied from the first portrait preset found. This means if you just want to vary the size along the x axis, a simple size=x0.3 is usually enough and all the other values will be correct by default.',
      'rot':"Rotation is given in degrees. The portrait rotates around it's origin (usually the bottom center)!",
    },
    variables: {
      // variable_name : documentation
      'animation':'What is the animation followed by the character joining in (dtl_animation_join)',
      'length':'Time in seconds of the animation. CAN ONLY BE SET WITH animation.',
      'wait':"Await for the animation to finish before doing anything else. CAN ONLY BE SET WITH animation.",
      'mirrored':"Is the sprite mirrored along the x axis?",
      'z_index':"Modify the z_index of the sprite, higher z_index means more in front, lower means more in the back. It is not using godot's z-index and instead sorting the characters manually!",
      'extra_data':"Supplementary data to pass to the joining of the character. IF you have a LayeredSprite2D then you change the elements of the sprite by doing: set Arm/Happy set Emotion/Angry.",
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
      'pos':'Position can be specified like this: x0.5 y1, x100px y1% By default x and y are interpreted as relative to the viewport size, meaning 0.5 means half the width/height of the window. Position defines the ORIGIN of the portrait (usually the bottom center). When first joining a character, the position, size and rotation will be copied from the first portrait preset found. This means if you just want to vary the position along the x axis, a simple pos=x0.3 is usually enough and all the other values will be correct by default.',
      'size':'Size can be specified like this: x0.5 y1, x100px y1% By default x and y are interpreted as relative to the viewport size, meaning 0.5 means half the width/height of the window. Position defines the ORIGIN of the portrait (usually the bottom center). When first joining a character, the position, size and rotation will be copied from the first portrait preset found. This means if you just want to vary the size along the x axis, a simple size=x0.3 is usually enough and all the other values will be correct by default.',
      'rot':"Rotation is given in degrees. The portrait rotates around it's origin (usually the bottom center)!",
    },
    variables: {
      // variable_name : documentation
      'animation':'What is the animation of the character while being displayed (dtl_animation_update).',
      'length':'Time length of the animation. CAN ONLY BE SET WITH animation.',
      'wait':"Await for the animation to finish before doing anything else. CAN ONLY BE SET WITH animation.",
      'mirrored':"Is the sprite mirrored along the x axis?",
      'z_index':"Modify the z_index of the sprite, higher z_index means more in front, lower means more in the back. It is not using godot's z-index and instead sorting the characters manually!",
      'fade':'The fade setting (Only relevant if the portrait changes) defines the Crossfade animation that is used to fade from the last portrait to the next. If none is given it will fall back to a default that can be set in Setting>Portraits.',
      'move_time': "On Update events that change the position you can set the time (in seconds), transition and easing used to tween from the old to the new position.",
      'move_trans': "On Update events that change the position you can set the time (in seconds), transition and easing used to tween from the old to the new position.",
      'repeat':"The animation repeat setting allows repeating the animation multiple times. CAN ONLY BE SET WITH move_trans or move_time.",
      'move_ease':"On Update events that change the position you can set the time (in seconds), transition and easing used to tween from the old to the new position.",
      'fade_length':"Defines the length of the fade in seconds.",
      'extra_data':"Supplementary data to pass to the joining of the character. IF you have a LayeredSprite2D then you change the elements of the sprite by doing: set Arm/Happy set Emotion/Angry.",
    }
  },
  {
    name: 'leave',
    type: 'command',
    syntax: 'leave character [...]',
    description: 'Make a character leave the scene with a given extra information. The variables given are the one set inside the []. If one write `leave --All--` all joined characters will leave.',
    example: 'leave Laripo [animation="Slide To Left"]',
    variables: {
      // variable_name : documentation
      'animation':'What is the animation followed by the character leaving the scene (dtl_animation_leave)',
      'length':'Time length of the animation. CAN ONLY BE SET WITH animation.',
      'wait':"Await for the animation to finish before doing anything else. CAN ONLY BE SET WITH animation.",
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
      'time':'Time waited in second.',
      'hide_text':'Is the text hidden during that time?',
      'skippable':'Can this waiting period be skipped?'
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
      "hide_text":"Is the text hidden while waiting for user input?"
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
      "path":"Path to access the voice audio file.",
      "volume":"Path to access the manual tweaking of the volume of the given voice file.",
      "bus":"On which bus the voice audio will be played on."
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
      "time":"How much in the past should the memory be forgotten.",
      "step":"I have no idea what it does yet. (true by default)", // TODO: ASK WHAT THIS DOES!
      "text":"Is the text cleared? (true by default)",
      "portraits":"Are the portraits cleared? (true by default)",
      "music":"Is the audio cleared? (true by default)",
      "background":"Is the background cleared? (true by default)",
      "position":"Are the character positions cleared? (true by default)",
      "style":"Is the style cleared? (true by default)",
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
      "arg":"Path to the background used. Here an image, a color or an argument (a string).",
      "scene":"Path to the background used. Here a scene.",
      "transition":"What kind of transition is used.",
      "fade":"How long will the image fade.",
      "wait":"Wait for the fade to finish?"
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
      "name":"Name of the style used."
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
      "arg_type":"What is the expected format of the argument sent with the Dialogic signal?",
      "arg":"Argument sent with the Dialogic signal."
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
      "text":"Text shown for entering the text input.",
      "var" :"Variable that will store the result of the input.",
      "placeholder":"Text shown inside the textbox if nothing is filled.",
      "default":"Text outputed if nothing is filled.",
      "allow_empty":"Can this text be submitted empty?"
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
  if (!values) {
    return [];
  }
  const alreadyQuoted = typedValue.startsWith('"');
  const prefix = (alreadyQuoted ? typedValue.slice(1) : typedValue).toLowerCase();
  return values
    .filter(value => value.toLowerCase().startsWith(prefix))
    .map(value => createValueCompletion(value, alreadyQuoted));
}

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/** Character names found in project.godot. @type {string[]} */
let cachedCharacterNames = [];

/** Audio channel/kind names found in project.godot's audio/channel_defaults. @type {string[]} */
let cachedAudioChannels = [];

function extractCharacterNames(text) {
  const sectionMatch = text.match(/\[dialogic\]([\s\S]*?)(\n\[|$)/);
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
 * Re-read project.godot and refresh both caches from a single file read.
 */
async function refreshProjectGodotData() {
  const matches = await vscode.workspace.findFiles('**/project.godot', '**/.godot/**', 1);
  if (matches.length === 0) {
    cachedCharacterNames = [];
    cachedAudioChannels = [];
    return;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(matches[0]);
    const text = Buffer.from(bytes).toString('utf8');
    cachedCharacterNames = extractCharacterNames(text);
    cachedAudioChannels = extractAudioChannels(text);
  } catch (error) {
    console.error('DTL Reader: could not read project.godot', error);
    cachedCharacterNames = [];
    cachedAudioChannels = [];
  }
}

/**
 * Diagnostic collection used to warn about `jump` targets that have no
 * matching `label` declaration in the same document.
 *
 * @type {vscode.DiagnosticCollection}
 */
let diagnosticCollection;

/**
 * Extract character names from project.godot.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractCharacterNames(text) {
  const sectionMatch = text.match(/\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) {return [];}
  const dialogicSection = sectionMatch[1];
  const dictionaryMatch = dialogicSection.match(/directories\/dch_directory\s*=\s*\{([\s\S]*?)\}/);
  if (!dictionaryMatch) {return [];}
  const dictionaryBody = dictionaryMatch[1];
  const keyPattern = /"([^"]+)"\s*:\s*"[^"]*"/g;
  const names = [];
  let match;
  while ((match = keyPattern.exec(dictionaryBody)) !== null) {names.push(match[1]);}
  return names;
}
/**
 * Refresh the character cache.
 */
async function refreshCharacterNames() {
  const matches = await vscode.workspace.findFiles(
    '**/project.godot',
    '**/.godot/**',
    1
  );
  if (matches.length === 0) {
    cachedCharacterNames = [];
    return;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(matches[0]);
    cachedCharacterNames =
      extractCharacterNames(
        Buffer.from(bytes).toString('utf8')
      );

  } catch (error) {

    console.error(
      'DTL Reader: could not read project.godot',
      error
    );

    cachedCharacterNames = [];
  }
}
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
function createCharacterCompletion(name) {
  const item = new vscode.CompletionItem(name,vscode.CompletionItemKind.EnumMember);
  item.detail = 'Dialogic character (from project.godot)';
  return item;
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
  const colonMatch = beforeCursor.match(/^\s*[\p{L}_][\p{L}0-9_]*\s*:/u);

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
  if (/^\s*[\p{L}_][\p{L}0-9_]*\s*:/u.test(lineText)) {
    return true; // Character: ...
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
            const hasOpenBracket = argumentsText.includes('[');
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
              // Split arguments
              // ---------------------------------------------------------------
              const argumentsParts = argumentsText.split(/\s+/);
              // ---------------------------------------------------------------
              // Character is currently being typed
              //
              // join Lar|
              // leave Lar|
              // update Lar|
              // ---------------------------------------------------------------
              if (argumentsParts.length === 1) {
                const prefix = argumentsParts[0].toLowerCase();
                for (const name of cachedCharacterNames) {
                  if (!name.toLowerCase().startsWith(prefix)) {
                    continue;
                  }
                  items.push(createCharacterCompletion(name));
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
              const lastSpaceIndex = bracketArgumentsText.lastIndexOf(' ');
              const currentToken = bracketArgumentsText.slice(lastSpaceIndex + 1);
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
                // this attribute (animation, move_trans, move_ease, ...) if any.
                const equalsIndex = currentToken.indexOf('=');
                const attributeName = currentToken.slice(0, equalsIndex);
                const typedValue = currentToken.slice(equalsIndex + 1);
                items.push(...createAttributeValueSuggestions(commandEntry.name, attributeName, typedValue));
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
                const lastSpaceIndex = afterCommandName.lastIndexOf(' ');
                const currentToken = afterCommandName.slice(lastSpaceIndex + 1);
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
            // Kind fully typed, waiting for the path: "audio music |"
            if (argumentsParts.length === 2 && argumentsParts[1] === '') {
              items.push(createAudioPathCompletion());
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
    , ' ', '[','=');
  context.subscriptions.push(completionProvider);
}
// =============================================================================
// DEACTIVATE
// =============================================================================
function deactivate() {}

module.exports = { activate, deactivate };
