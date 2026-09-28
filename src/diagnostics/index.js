// -----------------------------------------------------------------------------
// The problems DTL Reader reports: severity settings, and re-checking the
// open documents.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const dch = require('../dch/features');
const timelineChecks = require('./timeline');
const flow = require('./flow');
const usage = require('./usage');
const csvTranslations = require('../translation/translations');

// =============================================================================
// BALISE HELPERS
// =============================================================================

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
 * Re-run diagnostics for every open `.dtl` document - after project.godot
 * (or a character/script) changed, since that changes what's "unknown".
 */
function refreshAllDiagnostics() {
  if (!state.diagnosticCollection) { return; }
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
    state.diagnosticCollection.set(document.uri, [...dch.findDchDiagnostics(document), ...usage.findUnusedCharacterDiagnostics(document)]);
    return;
  }
  if (document.languageId !== 'dtl') {
    return;
  }

  const diagnostics = [
    ...timelineChecks.findUnresolvedJumpDiagnostics(document),
    ...timelineChecks.findUnclosedBaliseDiagnostics(document),
    ...timelineChecks.findUnknownCharacterDiagnostics(document),
    ...timelineChecks.findUnknownVariableDiagnostics(document),
    ...csvTranslations.findMissingTranslationDiagnostics(document),
    ...flow.findUnreachableDiagnostics(document)
  ];

  state.diagnosticCollection.set(document.uri, diagnostics);
}

Object.assign(module.exports, {
  pushDiagnostic,
  refreshAllDiagnostics,
  updateDiagnostics,
});
