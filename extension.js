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
        item.detail = 'DTL character (from project.godot)';
        return item;
      });
    },
  });
  context.subscriptions.push(provider);
}

function deactivate() {}

module.exports = { activate, deactivate };
