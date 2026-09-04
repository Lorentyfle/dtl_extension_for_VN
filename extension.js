// extension.js
// -----------------------------------------------------------------------------
// DTL language support for Dialogic 2 Timeline (.dtl) files.
//
// Provides:
// - Character autocomplete from project.godot
// - Command autocomplete
// - Contextual character/position autocomplete for join/leave/update
// - Word-based autocomplete for spoken dialogue text (named or narration)
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
    description: 'Make a character join on a given position with a given extra information.',
    example: 'join Laripo center [extra_data="set Emotion/Happy"]'
  },
  {
    name: 'update',
    type: 'command',
    syntax: 'update character position [...]',
    description: 'Update a joined character on a given position with a given extra information.',
    example: 'update Laripo center [extra_data="set Emotion/Happy"]'
  },
  {
    name: 'leave',
    type: 'command',
    syntax: 'leave character [...]',
    description: 'Make a character leave the scene with a given extra information.',
    example: 'leave Laripo [animation="Slide To Left"]'
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
    syntax: '[b] ... [\\b]',
    description: 'BBCode-style balise: wraps the enclosed dialogue/narration/choice text in bold. Note the closing tag uses a backslash, not a forward slash.',
    example: 'Laripo: This is [b]important[\\b].'
  },
  {
    name: 'i',
    type: 'bracket',
    syntax: '[i] ... [\\i]',
    description: 'BBCode-style balise: wraps the enclosed dialogue/narration/choice text in italics. Note the closing tag uses a backslash, not a forward slash.',
    example: 'Laripo: This is [i]interesting[\\i].'
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
// CHARACTER CACHE
// =============================================================================

/**
 * Character names found in project.godot.
 *
 * @type {string[]}
 */
let cachedCharacterNames = [];

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

  const sectionMatch = text.match(
    /\[dialogic\]([\s\S]*?)(\n\[|$)/
  );

  if (!sectionMatch) {
    return [];
  }

  const dialogicSection = sectionMatch[1];

  const dictionaryMatch = dialogicSection.match(/directories\/dch_directory\s*=\s*\{([\s\S]*?)\}/);
  if (!dictionaryMatch) {
    return [];
  }
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
  const colonMatch = beforeCursor.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:/);

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
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lineText)) {
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

/**
 * Scan dialogue/narration/choice lines for a BBCode-style balise such as
 * `[b]` or `[MyEffect]` that has no matching `[\name]` closer on the same
 * line. Reserved bracket commands like `[wait]` are skipped since they
 * aren't balises. A broken balise flags the whole line (rather than just
 * the tag) so it's easy to spot at a glance, mirroring the grammar's own
 * end-of-line fallback for the same unclosed-tag case.
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
  refreshCharacterNames();
  // ---------------------------------------------------------------------------
  // Watch project.godot
  // ---------------------------------------------------------------------------
  const watcher = vscode.workspace.createFileSystemWatcher('**/project.godot');
  watcher.onDidChange(refreshCharacterNames);
  watcher.onDidCreate(refreshCharacterNames);
  watcher.onDidDelete(refreshCharacterNames);
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
                return undefined;
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
            // ---------------------------------------------------------------
            // No argument yet
            //
            // join |
            // leave |
            // update |
            // ---------------------------------------------------------------
            if (argumentsText === '') {
              for (
                const name of cachedCharacterNames
              ) {
                items.push(
                  createCharacterCompletion(name)
                );
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
              const prefix =
                argumentsParts[0]
                  .toLowerCase();
              for (
                const name of cachedCharacterNames
              ) {

                if (
                  !name
                    .toLowerCase()
                    .startsWith(prefix)
                ) {
                  continue;
                }

                items.push(
                  createCharacterCompletion(name)
                );
              }

              return items;
            }


            // ---------------------------------------------------------------
            // Position
            //
            // join Laripo |
            // update Laripo |
            //
            // leave does NOT have a position.
            // ---------------------------------------------------------------
            if ((command === 'join' || command === 'update') && argumentsParts.length === 2) {
              const prefix = argumentsParts[1].toLowerCase();
              for (const position of DTL_POSITIONS) {
                if (
                  !position.name
                    .toLowerCase()
                    .startsWith(prefix)
                ) {
                  continue;
                }

                items.push(
                  createPositionCompletion(
                    position
                  )
                );
              }
              return items;
            }
          }
          // =========================================================================
          // BRACKET COMMANDS
          // =========================================================================
          const bracketMatch =
            beforeCursor.match(
              /\[([A-Za-z_][A-Za-z0-9_]*)?$/
            );
          if (bracketMatch) {
            const prefix = bracketMatch[1] || '';
            for ( const entry of DTL_ENTRIES ) {
              if (entry.type !== 'bracket') {
                continue;
              }
              if (
                !entry.name
                  .startsWith(prefix)
              ) {
                continue;
              }
              const item =
                createCommandCompletion(entry);
              items.push(item);
            }
            return items;
          }
          // =========================================================================
          // NORMAL COMMANDS + Dialogue characters.
          // =========================================================================
          if (/^\s*[A-Za-z_][A-Za-z0-9_]*$/.test(beforeCursor)) {
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
          return items
          }
        }
    );
  context.subscriptions.push(completionProvider);
}
// =============================================================================
// DEACTIVATE
// =============================================================================

function deactivate() {}

module.exports = { activate, deactivate };
