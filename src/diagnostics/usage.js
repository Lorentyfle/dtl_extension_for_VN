// -----------------------------------------------------------------------------
// Characters and portraits no timeline uses.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const project = require('../project');
const dchParse = require('../dch/parse');
const problems = require('./index');

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
  // The same for every .dch checked in a round - computed once.
  return problems.oncePerRound('characterUsage', () => {
    const usage = new Map();
    const use = (name, mood) => {
      if (!usage.has(name)) { usage.set(name, new Set()); }
      if (mood) { usage.get(name).add(mood); }
    };
    const linePattern = new RegExp(`^\\s*(?:(?:join|update|leave)\\s+)?(${syntax.CHARACTER_NAME_SOURCE})\\s*(?:\\(([\\p{L}_][\\p{L}0-9_]*)\\))?`, 'u');
    for (const lines of project.currentTimelineLines().values()) {
      for (const text of lines) {
        const isCommand = /^\s*(?:join|update|leave)\s/.test(text);
        const speaker = syntax.findLineSpeaker(text);
        if (!isCommand && !speaker) { continue; }
        const match = text.match(linePattern);
        if (!match) { continue; }
        const name = syntax.stripCharacterNameQuotes(match[1]);
        use(name, match[2]);
        if (speaker) {
          for (const portrait of text.matchAll(/\[portrait=([^\]\s]+)\]/g)) { use(name, portrait[1]); }
        }
      }
    }
    return usage;
  });
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
  const character = project.findCharacterForDocument(document);
  if (!character || !state.declaredProjectData.timelines || state.cachedTimelineLines.size === 0) { return []; }
  const diagnostics = [];
  const text = document.getText();
  const tokens = dchParse.scanDch(text).keyTokens;
  const usage = collectCharacterUsage();
  const moods = usage.get(character);
  if (!moods && !state.cachedScriptStrings.has(character)) {
    const token = tokens.find(candidate => candidate.path.length === 0 && candidate.name === 'display_name') || tokens[0];
    const range = token ? new vscode.Range(document.positionAt(token.start), document.positionAt(token.end)) : new vscode.Range(0, 0, 0, 1);
    problems.pushDiagnostic(diagnostics, 'unusedCharacter', range, `No timeline uses "${character}" (no join, update, leave or dialogue line).`);
    return diagnostics; // every portrait is unused then - no need to say it for each
  }
  const portraitTokens = tokens.filter(token => token.path.length === 1 && token.path[0] === 'portraits');
  // Without a default_portrait, a line without (mood) shows the first one.
  const defaultPortrait = (text.match(/&?"default_portrait"\s*:\s*"([^"]+)"/) || [])[1] || (portraitTokens[0] && portraitTokens[0].name);
  for (const token of portraitTokens) {
    if (token.name === defaultPortrait || (moods && moods.has(token.name)) || state.cachedScriptStrings.has(token.name)) { continue; }
    const diagnostic = problems.pushDiagnostic(diagnostics, 'unusedPortrait',
      new vscode.Range(document.positionAt(token.start), document.positionAt(token.end)),
      `No timeline uses the portrait "${token.name}" of ${character} (as a (mood) or a [portrait=]).`);
    if (diagnostic) { diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]; }
  }
  return diagnostics;
}

Object.assign(module.exports, {
  findUnusedCharacterDiagnostics,
});
