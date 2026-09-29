// -----------------------------------------------------------------------------
// Problems in a timeline: jumps to nowhere, unclosed BBCode, unknown
// characters, moods and variables.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const autoloads = require('../timeline/autoloads');
const project = require('../project');
const problems = require('./index');

// =============================================================================
// LABEL / JUMP HELPERS
// =============================================================================

/**
 * Flag `jump` targets that don't exist. Dialogic doesn't stop on these:
 * it prints "[Dialogic] Label '...' not found for jump" and simply goes
 * on with the next event, so the jump silently never happens - hence an
 * Error, not a Warning.
 * - `jump label` must match a label of this timeline;
 * - `jump Timeline/label` (or `jump Timeline/`) must name a timeline of
 *   project.godot's `directories/dtl_directory`, and the label must exist
 *   there - only checked when project.godot declares that directory;
 * - a target containing `{...}` is resolved from a variable at runtime,
 *   so it's never flagged.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnresolvedJumpDiagnostics(document) {
  const localLabels = syntax.collectDocumentLabels(document);
  const diagnostics = [];
  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.lineAt(line).text;
    const jump = syntax.parseJumpLine(lineText);
    if (!jump) { continue; }
    if (jump.translationIdStart !== -1) {
      problems.pushDiagnostic(diagnostics, 'jumpTranslationId',
        new vscode.Range(line, jump.translationIdStart, line, lineText.trimEnd().length),
        `A jump can't have a translation id: Dialogic would look for a label named "${lineText.slice(jump.labelStart).trim()}". Remove the #id part.`);
    }
    if (jump.target.includes('{')) { continue; }
    if (jump.timeline === null) {
      if (!localLabels.has(jump.label)) {
        problems.pushDiagnostic(diagnostics, 'unresolvedJump',
          new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length),
          `No "label ${jump.label}" in this timeline - Dialogic will print an error and skip this jump.`);
      }
      continue;
    }
    if (!state.projectRootUri || !state.declaredProjectData.timelines) { continue; }
    const labels = project.getTimelineLabels(jump.timeline);
    if (!labels) {
      problems.pushDiagnostic(diagnostics, 'unresolvedJump',
        new vscode.Range(line, jump.targetStart, line, jump.targetStart + jump.timeline.length),
        `No timeline "${jump.timeline}" in this project (project.godot's directories/dtl_directory).`);
    } else if (jump.label && !labels.has(jump.label)) {
      problems.pushDiagnostic(diagnostics, 'unresolvedJump',
        new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length),
        `No "label ${jump.label}" in the timeline "${jump.timeline}" - Dialogic will print an error and skip this jump.`);
    }
  }
  return diagnostics;
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
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!syntax.isPlayerFacingTextLine(text)) {
      continue;
    }
    // One whole-line warning per line is enough, even if several tags are broken.
    const tagName = syntax.findUnclosedTag(text);
    if (tagName) {
      problems.pushDiagnostic(diagnostics, 'unclosedBBCode',
        new vscode.Range(line, 0, line, text.length),
        `"[${tagName}]" has no matching "[/${tagName}]" on this line - the balise is unclosed.`);
    }
  }
  return diagnostics;
}

/**
 * Report characters and moods that don't exist in the Godot project:
 * - `join`/`update`/`leave` naming a character missing from
 *   project.godot's `directories/dch_directory` (an Error - Dialogic can't
 *   run that event);
 * - a dialogue line whose speaker isn't a known character (a Warning -
 *   Dialogic then shows the whole line, "Name:" included, as narration);
 * - a `(mood)` that the character's `.dch` file doesn't declare.
 * Nothing is reported unless project.godot actually declares a character
 * list, so a timeline opened outside a Godot project stays quiet.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnknownCharacterDiagnostics(document) {
  if (!state.projectRootUri || !state.declaredProjectData.characters) { return []; }
  const knownCharacters = new Set(state.cachedCharacterNames);
  const diagnostics = [];
  const commandPattern = new RegExp(`^(\\s*(?:join|update|leave)\\s+)(${syntax.CHARACTER_NAME_SOURCE})(\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\))?`, 'u');
  const speakerPattern = new RegExp(`^(\\s*)(${syntax.CHARACTER_NAME_SOURCE})(\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\))?(?=\\s*:)`, 'u');
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const commandMatch = text.match(commandPattern);
    const speakerMatch = commandMatch ? null : text.match(speakerPattern);
    const match = commandMatch || speakerMatch;
    if (!match) { continue; }
    const name = syntax.stripCharacterNameQuotes(match[2]);
    if (speakerMatch && syntax.RESERVED_LINE_KEYWORDS.has(name)) { continue; }
    const nameStart = match[1].length;
    if (!knownCharacters.has(name)) {
      problems.pushDiagnostic(diagnostics, commandMatch ? 'unknownCharacter' : 'unknownSpeaker',
        new vscode.Range(line, nameStart, line, nameStart + match[2].length),
        commandMatch
          ? `"${name}" is not a Dialogic character of this project (not in project.godot's directories/dch_directory).`
          : `"${name}" is not a Dialogic character of this project - Dialogic will show this whole line, "${name}:" included, as narration.`);
      continue;
    }
    const moods = state.cachedCharacterMoods.get(name);
    if (speakerMatch && moods && moods.size > 0) {
      const portraitPattern = /\[portrait=([^\]\s]+)\]/g;
      let portraitMatch;
      while ((portraitMatch = portraitPattern.exec(text)) !== null) {
        if (moods.has(portraitMatch[1])) { continue; }
        const start = portraitMatch.index + '[portrait='.length;
        problems.pushDiagnostic(diagnostics, 'unknownMood', new vscode.Range(line, start, line, start + portraitMatch[1].length),
          `"${portraitMatch[1]}" is not a portrait of ${name}. Available: ${[...moods.keys()].join(', ')}.`);
      }
    }
    const mood = match[4];
    if (mood && moods && moods.size > 0 && !moods.has(mood)) {
      const moodStart = nameStart + match[2].length + match[3].indexOf(mood);
      problems.pushDiagnostic(diagnostics, 'unknownMood',
        new vscode.Range(line, moodStart, line, moodStart + mood.length),
        `"${mood}" is not a portrait of ${name}. Available: ${[...moods.keys()].join(', ')}.`);
    }
  }
  return diagnostics;
}

/**
 * Report `{variable.path}` references that don't exist: neither a Dialogic
 * variable declared in project.godot's `variables={...}`, nor an autoload
 * (`{Global.hearts}`, checked member by member when its script is loaded).
 * Only plain dotted paths are checked - anything else inside braces (a
 * signal's `{"key": ...}` dictionary, an expression) is left alone - and
 * nothing is reported unless project.godot declares a variables list.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnknownVariableDiagnostics(document) {
  if (!state.projectRootUri || !state.declaredProjectData.variables) { return []; }
  const diagnostics = [];
  const blockPattern = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (/^\s*#/.test(text)) { continue; }
    blockPattern.lastIndex = 0;
    let match;
    while ((match = blockPattern.exec(text)) !== null) {
      const problem = describeUnknownVariablePath(match[1].split('.'));
      if (!problem) { continue; }
      const start = match.index + 1;
      problems.pushDiagnostic(diagnostics, 'unknownVariable',
        new vscode.Range(line, start, line, start + match[1].length),
        problem);
    }
  }
  return diagnostics;
}

/**
 * Check one `{a.b.c}` path against the Dialogic variables tree and the
 * autoloads. Returns an explanation if it doesn't exist, or null if it
 * does (or can't be checked, e.g. an addon autoload whose script isn't
 * loaded).
 *
 * @param {string[]} segments
 * @returns {string | null}
 */
function describeUnknownVariablePath(segments) {
  const path = segments.join('.');
  if (state.cachedVariablesTree.has(segments[0])) {
    let level = state.cachedVariablesTree;
    for (let i = 0; i < segments.length; i++) {
      const entry = level && level.get(segments[i]);
      if (!entry) { return `"{${path}}" is not a Dialogic variable: "${segments.slice(0, i).join('.')}" has no "${segments[i]}".`; }
      level = entry.children;
    }
    return null;
  }
  if (state.cachedAutoloadNames.has(segments[0])) {
    const symbols = state.cachedAutoloadSymbols.get(segments[0]);
    if (!symbols || segments.length < 2) { return null; } // not loaded (addon) - can't check
    const member = autoloads.findAutoloadMember(symbols, segments[1]);
    if (!member) { return `"${segments[1]}" is not a variable, constant or enum of the autoload ${segments[0]}.`; }
    if (member.kind === 'enum' && segments.length >= 3 && !member.info.values.some(value => value.name === segments[2])) {
      return `"${segments[2]}" is not a value of ${segments[0]}.${segments[1]}.`;
    }
    return null;
  }
  return `"{${path}}" is not a Dialogic variable of this project (not in project.godot's variables) nor an autoload.`;
}

Object.assign(module.exports, {
  findUnresolvedJumpDiagnostics,
  findUnclosedBaliseDiagnostics,
  findUnknownCharacterDiagnostics,
  findUnknownVariableDiagnostics,
});
