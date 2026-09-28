// -----------------------------------------------------------------------------
// Colors for autoload references (semantic tokens).
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const autoloads = require('../timeline/autoloads');

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
      if (state.cachedVariablesTree.has(segments[0]) || !state.cachedAutoloadNames.has(segments[0])) { continue; }
      let column = match.index + 1;
      builder.push(line, column, segments[0].length, 0);
      const symbols = state.cachedAutoloadSymbols.get(segments[0]);
      if (!symbols || segments.length < 2) { continue; }
      column += segments[0].length + 1;
      const member = autoloads.findAutoloadMember(symbols, segments[1]);
      if (!member) { continue; }
      builder.push(line, column, segments[1].length, SEMANTIC_TOKENS_LEGEND.tokenTypes.indexOf(memberTokenType[member.kind]));
      if (member.kind === 'enum' && segments.length >= 3) {
        builder.push(line, column + segments[1].length + 1, segments[2].length, SEMANTIC_TOKENS_LEGEND.tokenTypes.indexOf('enumMember'));
      }
    }
  }
  return builder.build();
}

Object.assign(module.exports, {
  SEMANTIC_TOKENS_LEGEND,
  provideAutoloadSemanticTokens,
});
