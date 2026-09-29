// -----------------------------------------------------------------------------
// Events that never run, and labels nothing leads to.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const project = require('../project');
const problems = require('./index');

// =============================================================================
// UNREACHABLE EVENTS AND LABELS
// =============================================================================
// Dialogic runs a timeline from top to bottom; labels are only markers that
// the flow runs through. So after a top-level `[end_timeline]`, `jump` or
// `return`, the events that follow never run - until a label, which a jump
// may lead to. A label that nothing jumps to (in any timeline), that no
// script starts the timeline at, and that the flow can't run into, never
// runs either.

/**
 * The labels of a timeline that something may jump to: the jumps of every
 * timeline (`jump label` in its own, `jump Timeline/label` anywhere), plus
 * every string a script names. Null when a jump's target is computed
 * (`jump {variable}`), since it could then be any label.
 *
 * @param {vscode.TextDocument} document
 * @returns {Set<string> | null}
 */
function collectJumpedLabels(document) {
  const identifier = project.findTimelineIdentifier(document); // null while unregistered: only its own jumps reach it
  const ownKey = project.timelineKey(document);
  const labels = new Set(state.cachedScriptStrings);
  for (const [timeline, lines] of project.currentTimelineLines()) {
    const isThis = timeline === ownKey;
    for (const text of lines) {
      const jump = syntax.parseJumpLine(text);
      if (!jump || !jump.label) { continue; }
      if (jump.target.includes('{')) {
        const targetsThis = jump.timeline === null ? isThis : (jump.timeline.includes('{') || jump.timeline === identifier);
        if (targetsThis) { return null; }
        continue;
      }
      if (jump.timeline === null ? isThis : jump.timeline === identifier) { labels.add(jump.label); }
    }
  }
  return labels;
}

/**
 * Report events that never run (faded) and labels nothing leads to.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnreachableDiagnostics(document) {
  const diagnostics = [];
  let jumped;
  const isJumpedTo = name => {
    if (jumped === undefined) { jumped = collectJumpedLabels(document); }
    return jumped === null || jumped.has(name);
  };
  let reachable = true;
  let endedBy = '';
  let deadStart = -1;
  let deadEnd = -1;
  const closeDeadRegion = () => {
    if (deadStart === -1) { return; }
    const diagnostic = problems.pushDiagnostic(diagnostics, 'unreachableCode',
      new vscode.Range(deadStart, 0, deadEnd, document.lineAt(deadEnd).text.length),
      `This never runs: the timeline stops at the "${endedBy}" above, and no label leads here.`);
    if (diagnostic) { diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]; }
    deadStart = -1;
  };
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { continue; }
    const label = syntax.parseLabelLine(text);
    if (label && !reachable) {
      if (isJumpedTo(label.name)) {
        closeDeadRegion();
        reachable = true;
        continue;
      }
      problems.pushDiagnostic(diagnostics, 'unreachableLabel',
        new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length),
        `Nothing leads to "label ${label.name}": no jump to it, no script naming it, and the timeline stops at the "${endedBy}" above - it never runs.`);
    }
    if (!reachable) {
      if (deadStart === -1) { deadStart = line; }
      deadEnd = line;
      continue;
    }
    const stop = /^(\[end_timeline\]|jump\b|return\b)/.exec(text);
    if (stop) {
      reachable = false;
      endedBy = stop[1] === 'jump' ? trimmed.split('#id:')[0].trim() : stop[1];
    }
  }
  closeDeadRegion();
  return diagnostics;
}

Object.assign(module.exports, {
  findUnreachableDiagnostics,
});
