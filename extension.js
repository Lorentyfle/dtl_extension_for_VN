// extension.js
// -----------------------------------------------------------------------------
// DTL language support for Dialogic 2 Timeline (.dtl) files.
//
// Provides:
// - Character autocomplete from project.godot
// - Command autocomplete
// - Contextual character/position autocomplete for join/leave/update
// - Hover documentation for commands
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
    example: '[wait 1.5] [wait time="1.0"]'
  },
  {
    name: 'wait_input',
    type: 'bracket',
    syntax: '[wait_input ...]',
    description: 'Waits for user input before continuing the timeline.',
    example: '[wait_input]'
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
    example: '[voice path="res://assets/voices/Laripo_dialogueID_666.mp3"]'
  },
  {
    name: 'clear',
    type: 'bracket',
    syntax: '[clear ...]',
    description: 'Clears the relevant dialogue/display state.',
    example: '[clear time="1.0"]'
  },
  {
    name: 'background',
    type: 'bracket',
    syntax: '[background ...]',
    description: 'Changes the background.',
    example: '[background arg="res://assets/sprite/new_background.png" fade="0.0"]'
  },
  {
    name: 'style',
    type: 'bracket',
    syntax: '[style ...]',
    description: 'Changes the dialogic style used. The name needs to correspond to a setup style loaded in the extension.',
    example: '[style name="default"]'
  },
  {
    name: 'signal',
    type: 'bracket',
    syntax: '[signal ...]',
    description: 'Send a dialogic signal with given arguments.',
    example: '[signal arg_type="dict" arg="{\"Amount\":100,\"Effect\":\"Rain\",\"Nature\":\"meteo\",\"Windx\":20.0,\"Windy\":1.0}"]'
  },
  {
    name: 'text_input',
    type: 'bracket',
    syntax: '[text_input ...]',
    description: 'Make a text input prompt appear that would save the data in a variable.',
    example: '[text_input text="Solve: 4x - 67 = 0" var="_butterfly_effect.part1.introduction.answer_equation1" placeholder="No idea" allow_empty="true"]'
  },
  {
    name: 'end_timeline',
    type: 'bracket',
    syntax: '[end_timeline]',
    description: 'Ends the current timeline.',
    example: '[end_timeline]'
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
            if (
              (command === 'join' ||
               command === 'update') &&
              argumentsParts.length === 2
            ) {
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
            const prefix =
              bracketMatch[1] || '';
            for (
              const entry of DTL_ENTRIES
            ) {
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
          // NORMAL COMMANDS
          // =========================================================================
          const commandMatch = beforeCursor.match(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)$/);
          if (commandMatch) {
            const prefix = commandMatch[1].toLowerCase();
            for ( const entry of DTL_ENTRIES) {
              if (entry.type !== 'command') {
                continue;
              }
              if (
                !entry.name
                  .toLowerCase()
                  .startsWith(prefix)
              ) {
                continue;
              }
              items.push(
                createCommandCompletion(entry)
              );
            }
            return items;
          }
          // =========================================================================
          // CHARACTER COMPLETION
          //
          // Keep the original behavior:
          // character names can be suggested anywhere.
          // =========================================================================
          for (const name of cachedCharacterNames) {items.push(createCharacterCompletion(name));}
          return items;
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