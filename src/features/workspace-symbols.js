// -----------------------------------------------------------------------------
// Go to Symbol in Workspace (Ctrl+T).
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const project = require('../project');

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
 * The timelines to search. With a project: the ones already read (open
 * editors live, the others as last read from disk) - Go to Symbol asks
 * again on every key typed, so nothing is re-read from disk. Without one:
 * every .dtl file of the folder.
 *
 * @returns {Promise<{uri: vscode.Uri, identifier: string|null, lines: string[]}[]>}
 */
async function listTimelines() {
  if (!state.projectRootUri) { return project.readAllTimelines(); }
  return [...project.currentTimelineLines()].map(([key, lines]) => {
    const resPath = state.cachedTimelinePaths.get(key);
    return resPath
      ? { uri: project.resolveResourcePath(resPath), identifier: key, lines }
      : { uri: vscode.Uri.parse(key), identifier: null, lines }; // open, not registered yet
  });
}

/**
 * @param {string} query
 * @returns {Promise<vscode.SymbolInformation[]>}
 */
async function provideWorkspaceSymbols(query) {
  const symbols = [];
  for (const timeline of await listTimelines()) {
    const fileName = timeline.uri.path.split('/').pop().replace(/\.dtl$/i, '');
    const container = timeline.identifier || fileName;
    if (matchesSymbolQuery(query, container)) {
      symbols.push(new vscode.SymbolInformation(container, vscode.SymbolKind.File, 'timeline', new vscode.Location(timeline.uri, new vscode.Position(0, 0))));
    }
    timeline.lines.forEach((text, line) => {
      const label = syntax.parseLabelLine(text);
      if (!label || !matchesSymbolQuery(query, label.name)) { return; }
      const range = new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length);
      symbols.push(new vscode.SymbolInformation(label.name, vscode.SymbolKind.Module, container, new vscode.Location(timeline.uri, range)));
    });
  }
  if (state.projectRootUri) {
    for (const [name, dchPath] of state.cachedCharacterPaths) {
      if (!matchesSymbolQuery(query, name)) { continue; }
      symbols.push(new vscode.SymbolInformation(name, vscode.SymbolKind.Class, 'character', new vscode.Location(project.resolveResourcePath(dchPath), new vscode.Position(0, 0))));
    }
  }
  return symbols;
}

Object.assign(module.exports, {
  provideWorkspaceSymbols,
});
