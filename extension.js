// extension.js
// -----------------------------------------------------------------------------
// Adds autocomplete for character names inside .dtl files.
//
// Character names are read from the Godot project's `project.godot` file,
// specifically from the `directories/dch_directory` dictionary under the
// `[dialogic]` section:
//
//   [dialogic]
//   directories/dch_directory={
//   "John":"res://path_to_dch_file.dch",
//   "Frodon":"res://path_to_dch_file.dch",
//   }
//
// Each key ("John", "Frodon", ...) is offered as a completion anywhere in a
// .dtl file, since character names are used both on speaker lines
// ("John: Hello!") and as arguments to join/update/leave commands.
// -----------------------------------------------------------------------------

const vscode = require('vscode');
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
    example: '[signal arg_type="dict" arg="{"Amount":100,"Effect":"Rain","Nature":"meteo","Windx":20.0,"Windy":1.0}"]'
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
const DTL_CHARACTER_COMMANDS = [
  'join',
  'leave',
  'update'
];


const hoverProvider = vscode.languages.registerHoverProvider('dtl', {
  provideHover(document, position) {
    const line = document.lineAt(position.line).text;
    // ---------------------------------------------------------
    // Normal commands: label / jump / etc.
    // ---------------------------------------------------------
    const wordRange = document.getWordRangeAtPosition(position);
    if (wordRange) {
      const word = document.getText(wordRange);
      const entry = DTL_ENTRIES.find(
        (entry) => entry.name === word
      );
      if (entry) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${entry.name}**\n\n`);
        markdown.appendMarkdown(`${entry.description}\n\n`);
        markdown.appendMarkdown(`**Syntax:** \`${entry.syntax}\`\n\n`);
        if (entry.example) {
          markdown.appendMarkdown('**Example:**\n\n');
          markdown.appendCodeblock(entry.example, 'dtl');
        }
        return new vscode.Hover(markdown, wordRange);
      }
    }
    // ---------------------------------------------------------
    // Bracket commands: [wait], [audio], [voice], etc.
    // ---------------------------------------------------------
    const bracketRegex = /\[([A-Za-z_][A-Za-z0-9_]*)/g;
    let match;
    while ((match = bracketRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (
        position.character >= start &&
        position.character <= end
      ) {
        const commandName = match[1];
        const entry = DTL_ENTRIES.find(
          (entry) => entry.name === commandName
        );
        if (!entry) {
          return undefined;
        }
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**[${entry.name}]**\n\n`);
        markdown.appendMarkdown(`${entry.description}\n\n`);
        markdown.appendMarkdown(`**Syntax:** \`${entry.syntax}\`\n\n`);
        if (entry.example) {
          markdown.appendMarkdown('**Example:**\n\n');
          markdown.appendCodeblock(entry.example, 'dtl');
        }
        const range = new vscode.Range(
          position.line,
          start,
          position.line,
          end
        );
        return new vscode.Hover(markdown, range);
      }
    }

    return undefined;
  }
});

context.subscriptions.push(hoverProvider);

const provider = vscode.languages.registerCompletionItemProvider('dtl', {
  provideCompletionItems(document, position) {
    const line = document.lineAt(position.line).text;
    const beforeCursor = line.substring(0, position.character);
    const items = [];

        // ---------------------------------------------------------
    // Existing character suggestions
    // ---------------------------------------------------------
    for (const name of cachedCharacterNames) {
      const item = new vscode.CompletionItem(
        name,
        vscode.CompletionItemKind.EnumMember
      );
      item.detail = 'DTL character (from project.godot)';
      items.push(item);
    }
    // ---------------------------------------------------------
    // Bracket commands
    //
    // Suggest only when the user has just opened a bracket or
    // is typing the name of a bracket command.
    // ---------------------------------------------------------
    const bracketMatch = beforeCursor.match(
      /\[([A-Za-z_][A-Za-z0-9_]*)?$/
    );
    if (bracketMatch) {
      const prefix = bracketMatch[1] || '';
      for (const entry of DTL_ENTRIES) {
        if (entry.type !== 'bracket') {
          continue;
        }
        if (!entry.name.startsWith(prefix)) {
          continue;
        }
        const item = new vscode.CompletionItem(
          entry.name,
          vscode.CompletionItemKind.Keyword
        );
        item.detail = entry.syntax;
        item.documentation = new vscode.MarkdownString(
          `${entry.description}\n\n` +
          (entry.example
            ? `**Example:**\n\n\`\`\`dtl\n${entry.example}\n\`\`\``
            : '')
        );
        // Replace the text after "[" rather than inserting another
        // complete command somewhere else.
        item.insertText = entry.name;
        items.push(item);
      }
    }
    // ---------------------------------------------------------
    // JOIN / LEAVE / UPDATE
    // ---------------------------------------------------------
    const CharactercommandMatch = beforeCursor.match(
      /^\s*(join|leave|update)\s+(.*)$/
    );
    if (CharactercommandMatch) {
      const command = CharactercommandMatch[1];
      const argumentsText = CharactercommandMatch[2];
      const argumentsParts = argumentsText.split(/\s+/);
      // -------------------------------------------------------
      // Character
      //
      // join |
      // leave |
      // update |
      // -------------------------------------------------------
      if (
        argumentsParts.length === 1 &&
        argumentsParts[0] === ''
      ) {
        for (const name of cachedCharacterNames) {
          const item = new vscode.CompletionItem(
            name,
            vscode.CompletionItemKind.EnumMember
          );

          item.detail = 'DTL character';

          items.push(item);
        }

        return items;
      }

      // -------------------------------------------------------
      // JOIN / UPDATE position
      //
      // join Alice |
      // update Alice |
      // -------------------------------------------------------

      if (
        (command === 'join' || command === 'update') &&
        argumentsParts.length === 2 &&
        argumentsParts[1] === ''
      ) {
        for (const position of DTL_POSITIONS) {
          const item = new vscode.CompletionItem(
            position,
            vscode.CompletionItemKind.EnumMember
          );

          item.detail = 'DTL character position';

          items.push(item);
        }

        return items;
      }

      // -------------------------------------------------------
      // Partial character name
      //
      // join Al|
      // -------------------------------------------------------

      if (argumentsParts.length === 1) {
        const prefix = argumentsParts[0];

        for (const name of cachedCharacterNames) {
          if (!name.toLowerCase().startsWith(prefix.toLowerCase())) {
            continue;
          }

          const item = new vscode.CompletionItem(
            name,
            vscode.CompletionItemKind.EnumMember
          );

          item.detail = 'DTL character';

          items.push(item);
        }

        return items;
      }

      // -------------------------------------------------------
      // Partial position
      //
      // join Alice le|
      // update Alice ce|
      // -------------------------------------------------------
      if (
        (command === 'join' || command === 'update') &&
        argumentsParts.length === 2
      ) {
        const prefix = argumentsParts[1];

        for (const position of DTL_POSITIONS) {
          if (!position.toLowerCase().startsWith(prefix.toLowerCase())) {
            continue;
          }

          const item = new vscode.CompletionItem(
            position,
            vscode.CompletionItemKind.EnumMember
          );

          item.detail = 'DTL character position';

          items.push(item);
        }

        return items;
      }
    }
    // ---------------------------------------------------------
    // Normal DTL commands
    // ---------------------------------------------------------
    const commandMatch = beforeCursor.match(
      /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)$/
    );
    if (commandMatch) {
      const prefix = commandMatch[1];
      for (const entry of DTL_ENTRIES) {
        if (entry.type !== 'command') {
          continue;
        }
        if (!entry.name.startsWith(prefix)) {
          continue;
        }
        const item = new vscode.CompletionItem(
          entry.name,
          vscode.CompletionItemKind.Keyword
        );
        item.detail = entry.syntax;
        item.documentation = new vscode.MarkdownString(
          `${entry.description}\n\n` +
          (entry.example
            ? `**Example:**\n\n\`\`\`dtl\n${entry.example}\n\`\`\``
            : '')
        );
        items.push(item);
      }
    }

    return items;
  }
});

context.subscriptions.push(provider);



/**
 * In-memory cache of character names found in the workspace's project.godot.
 * Rebuilt only when project.godot changes, so completion requests stay fast
 * (no disk read on every keystroke).
 * @type {string[]}
 */
let cachedCharacterNames = [];

/**
 * Extracts character names from a project.godot file's contents.
 *
 * @param {string} text - Full contents of project.godot.
 * @returns {string[]} Character names (the dictionary keys), in file order.
 */
function extractCharacterNames(text) {
  // Isolate the [dialogic] section: everything from its header up to the
  // next "[section]" header, or to the end of the file.
  const sectionMatch = text.match(/\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) {
    return [];
  }
  const dialogicSection = sectionMatch[1];

  // Pull out the dch_directory dictionary body: everything between its { }.
  const dictionaryMatch = dialogicSection.match(
    /directories\/dch_directory\s*=\s*\{([\s\S]*?)\}/
  );
  if (!dictionaryMatch) {
    return [];
  }
  const dictionaryBody = dictionaryMatch[1];

  // Each entry looks like "Name":"res://some/path.dch" — we only need the key.
  const keyPattern = /"([^"]+)"\s*:\s*"[^"]*"/g;
  const names = [];
  let match;
  while ((match = keyPattern.exec(dictionaryBody)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Finds project.godot in the current workspace and refreshes
 * `cachedCharacterNames` from it. Safe to call repeatedly; leaves the cache
 * empty if no project.godot exists or it has no character dictionary yet.
 */
async function refreshCharacterNames() {
  const matches = await vscode.workspace.findFiles('**/project.godot', '**/.godot/**', 1);
  if (matches.length === 0) {
    cachedCharacterNames = [];
    return;
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(matches[0]);
    cachedCharacterNames = extractCharacterNames(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    // A missing/unreadable project.godot shouldn't break the extension —
    // just fall back to no suggestions.
    console.error('DTL Reader: could not read project.godot', error);
    cachedCharacterNames = [];
  }
}

/**
 * Entry point called once by VS Code when the extension activates.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Build the initial cache right away.
  refreshCharacterNames();

  // Keep the cache in sync whenever project.godot is created, edited, or
  // deleted, so newly added characters show up without a reload.
  const watcher = vscode.workspace.createFileSystemWatcher('**/project.godot');
  watcher.onDidChange(refreshCharacterNames);
  watcher.onDidCreate(refreshCharacterNames);
  watcher.onDidDelete(refreshCharacterNames);
  context.subscriptions.push(watcher);

  // Offer character names as completions anywhere in a .dtl file; VS Code
  // filters the list against whatever the user has already typed.
  const provider = vscode.languages.registerCompletionItemProvider('dtl', {
    provideCompletionItems() {
      return cachedCharacterNames.map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
        item.detail = 'Dialogic character (read from project.godot)';
        return item;
      });
    },
  });
  context.subscriptions.push(provider);
}

function deactivate() {}

module.exports = { activate, deactivate };
