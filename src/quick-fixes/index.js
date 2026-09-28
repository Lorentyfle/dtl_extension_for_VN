// -----------------------------------------------------------------------------
// Quick fixes (Ctrl+.) for the problems DTL Reader reports.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const events = require('../docs/events');
const resources = require('../godot/resources');
const syntax = require('../timeline/syntax');
const variables = require('../timeline/variables');
const project = require('../project');
const dchParse = require('../dch/parse');
const spelling = require('../util/spelling');
const addToProject = require('./project-godot');
const labelReferences = require('../features/label-references');

// =============================================================================
// QUICK FIXES
// =============================================================================
// Lightbulb fixes (Ctrl+.) for the problems DTL Reader reports: the closest
// existing names for a typo, creating what's missing (a label, a portrait),
// and removing or closing what's wrong (a jump's #id, an unclosed BBCode
// tag). Each fix re-reads the line its diagnostic points at rather than
// storing data on the diagnostic, so it always matches the current text.

/**
 * @param {vscode.TextDocument} document
 * @returns {string}
 */
function documentEol(document) {
  return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/**
 * A quick fix replacing `range` with `text`.
 *
 * @param {string} title
 * @param {vscode.Uri} uri
 * @param {vscode.Range} range
 * @param {string} text
 * @param {vscode.Diagnostic} diagnostic
 * @param {boolean} [isPreferred] - the fix applied by "Auto Fix" (Shift+Alt+.)
 * @returns {vscode.CodeAction}
 */
function createReplaceFix(title, uri, range, text, diagnostic, isPreferred = false) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(uri, range, text);
  action.diagnostics = [diagnostic];
  action.isPreferred = isPreferred;
  return action;
}

/**
 * "Change to ..." fixes for a misspelled name: its closest candidates,
 * replacing the diagnostic's range. Only the closest one is preferred,
 * and only when it's the single suggestion.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @param {string} typed
 * @param {Iterable<string>} candidates
 * @param {(name: string) => string} [format] - how the name is written
 * @returns {vscode.CodeAction[]}
 */
function createDidYouMeanFixes(document, diagnostic, typed, candidates, format = name => name) {
  const names = spelling.findSimilarNames(typed, candidates);
  return names.map(name => createReplaceFix(`Change to "${name}"`, document.uri, diagnostic.range, format(name), diagnostic, names.length === 1));
}

/**
 * Where text appended to a document goes, and how it must start: after a
 * blank line, whether or not the file ends with a newline.
 *
 * @param {vscode.TextDocument} document
 * @returns {{position: vscode.Position, prefix: string, firstLine: number}} firstLine: the first line of the appended text once inserted
 */
function appendPoint(document) {
  const eol = documentEol(document);
  const lastLine = document.lineAt(document.lineCount - 1);
  const endsWithNewline = lastLine.text.trim() === '';
  const previousBlank = endsWithNewline && (document.lineCount < 2 || document.lineAt(document.lineCount - 2).text.trim() === '');
  if (!endsWithNewline) { return { position: lastLine.range.end, prefix: eol + eol, firstLine: lastLine.lineNumber + 2 }; }
  if (previousBlank) { return { position: lastLine.range.end, prefix: '', firstLine: lastLine.lineNumber }; }
  return { position: lastLine.range.end, prefix: eol, firstLine: lastLine.lineNumber + 1 };
}

/**
 * Whether a timeline's last event already stops the flow (`[end_timeline]`,
 * `jump`, `return`), so nothing written after it runs by falling through.
 *
 * @param {vscode.TextDocument} document
 * @returns {boolean}
 */
function timelineEndsFlow(document) {
  for (let line = document.lineCount - 1; line >= 0; line--) {
    const text = document.lineAt(line).text;
    if (text.trim() === '' || text.trim().startsWith('#')) { continue; }
    // Only at the top level: an indented one (in an if or a choice) can be
    // skipped, and the flow then goes on past it.
    return /^(?:\[end_timeline\]|jump\b|return\b)/.test(text);
  }
  return true; // an empty timeline
}

/**
 * "Create label X" for a jump to a missing label: appended at the end of
 * the target timeline (this one, or the other timeline of `jump
 * Other/label`). An `[end_timeline]` is added before it when the timeline
 * didn't end its flow, so what gets written under the new label doesn't
 * run for everyone reaching the end. The other timeline is opened on the
 * new label.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @param {NonNullable<ReturnType<typeof parseJumpLine>>} jump
 * @returns {Promise<vscode.CodeAction | null>}
 */
async function createMissingLabelFix(document, diagnostic, jump) {
  if (labelReferences.validateLabelName(jump.label)) { return null; }
  let target = document;
  if (jump.timeline !== null) {
    const resPath = state.cachedTimelinePaths.get(jump.timeline);
    if (!resPath) { return null; }
    try { target = await vscode.workspace.openTextDocument(project.resolveResourcePath(resPath)); } catch (error) { return null; }
  }
  const eol = documentEol(target);
  const { position, prefix, firstLine } = appendPoint(target);
  const endTimeline = timelineEndsFlow(target) ? '' : `[end_timeline]${eol}${eol}`;
  const labelLine = firstLine + (endTimeline ? 2 : 0);
  const action = new vscode.CodeAction(
    jump.timeline === null ? `Create "label ${jump.label}" at the end of this timeline` : `Create "label ${jump.label}" at the end of ${jump.timeline}`,
    vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.insert(target.uri, position, `${prefix}${endTimeline}label ${jump.label}${eol}`);
  action.diagnostics = [diagnostic];
  if (jump.timeline !== null) {
    const labelEnd = new vscode.Position(labelLine, `label ${jump.label}`.length);
    action.command = { command: 'vscode.open', title: 'Open the label', arguments: [target.uri, { selection: new vscode.Range(labelEnd, labelEnd) }] };
  }
  return action;
}

/**
 * Quick fixes for an unresolved jump: the closest labels (or timelines,
 * when the timeline part is wrong), and creating the missing label.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function createUnresolvedJumpFixes(document, diagnostic) {
  const jump = syntax.parseJumpLine(document.lineAt(diagnostic.range.start.line).text);
  if (!jump) { return []; }
  if (jump.timeline !== null && diagnostic.range.start.character < jump.labelStart) {
    return createDidYouMeanFixes(document, diagnostic, jump.timeline, state.cachedTimelinePaths.keys());
  }
  const target = project.resolveJumpTarget(document, jump);
  const fixes = target ? createDidYouMeanFixes(document, diagnostic, jump.label, target.labels.keys()) : [];
  const create = await createMissingLabelFix(document, diagnostic, jump);
  if (create) { fixes.push(create); }
  return fixes;
}

/**
 * "Remove the translation id" for a jump ending with `#id:...`.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction[]}
 */
function createJumpTranslationIdFixes(document, diagnostic) {
  const line = diagnostic.range.start.line;
  const text = document.lineAt(line).text;
  const idStart = text.indexOf('#id:');
  if (idStart === -1) { return []; }
  const start = text.slice(0, idStart).trimEnd().length;
  return [createReplaceFix('Remove the translation id', document.uri, new vscode.Range(line, start, line, text.length), '', diagnostic, true)];
}

/**
 * An edit adding a new image portrait to a .dch file's `portraits`, written
 * the way Dialogic writes it (in the file's own `&"key"` or `"key"` style),
 * and where its image path is to be typed once inserted.
 *
 * @param {vscode.TextDocument} dchDocument
 * @param {string} mood
 * @returns {{range: vscode.Range, text: string, imagePosition: vscode.Position} | null} null if the file has no `portraits`
 */
function createAddPortraitEdit(dchDocument, mood) {
  const text = dchDocument.getText();
  const header = text.match(/&?"portraits"\s*:\s*\{/);
  if (!header) { return null; }
  const openIndex = header.index + header[0].length - 1;
  const body = resources.extractBalancedBraces(text, openIndex);
  if (body === null) { return null; }
  const eol = documentEol(dchDocument);
  const keyPrefix = /&"/.test(text) ? '&' : '';
  const k = key => `${keyPrefix}"${key}"`;
  const name = mood.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const portrait = [
    `${keyPrefix}"${name}": {`,
    `${k('export_overrides')}: {`,
    `${k('image')}: "\\"res://\\""`,
    '},',
    `${k('mirror')}: false,`,
    `${k('offset')}: Vector2(0, 0),`,
    `${k('scale')}: 1.0,`,
    `${k('scene')}: ""`,
    '}',
  ].join(eol);
  const content = body.trimEnd();
  const start = openIndex + 1 + (content ? content.length : 0);
  const end = content ? start : openIndex + 1 + body.length;
  const inserted = content ? `,${eol}${portrait}` : `${eol}${portrait}${eol}`;
  // Where `res://` ends in the image line, in the edited file.
  const before = (text.slice(0, start) + inserted.slice(0, inserted.indexOf('res://') + 'res://'.length)).split('\n');
  const imagePosition = new vscode.Position(before.length - 1, before[before.length - 1].length);
  return { range: new vscode.Range(dchDocument.positionAt(start), dchDocument.positionAt(end)), text: inserted, imagePosition };
}

/**
 * Quick fixes for an unknown mood: the character's closest portraits, and
 * adding the mood to their .dch file as a new image portrait (then opened
 * on its image path).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function createUnknownMoodFixes(document, diagnostic) {
  const character = syntax.findLineCharacter(document.lineAt(diagnostic.range.start.line).text);
  const moods = character && state.cachedCharacterMoods.get(character);
  if (!moods) { return []; }
  const mood = document.getText(diagnostic.range);
  const fixes = createDidYouMeanFixes(document, diagnostic, mood, moods.keys());
  const dchPath = state.cachedCharacterPaths.get(character);
  if (!dchPath || !/^[\p{L}_][\p{L}0-9_]*$/u.test(mood)) { return fixes; }
  let dchDocument;
  try { dchDocument = await vscode.workspace.openTextDocument(project.resolveResourcePath(dchPath)); } catch (error) { return fixes; }
  const edit = createAddPortraitEdit(dchDocument, mood);
  if (!edit) { return fixes; }
  const action = new vscode.CodeAction(`Add the portrait "${mood}" to ${character}`, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(dchDocument.uri, edit.range, edit.text);
  action.diagnostics = [diagnostic];
  action.command = { command: 'vscode.open', title: 'Open the portrait', arguments: [dchDocument.uri, { selection: new vscode.Range(edit.imagePosition, edit.imagePosition) }] };
  fixes.push(action);
  return fixes;
}

/**
 * "Close [tag]" for an unclosed BBCode tag: its closing tag at the end of
 * the line's text - before a translation id, and before a choice's `|`
 * condition.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction[]}
 */
function createUnclosedTagFixes(document, diagnostic) {
  const line = diagnostic.range.start.line;
  const text = document.lineAt(line).text;
  const tagName = syntax.findUnclosedTag(text);
  if (!tagName) { return []; }
  let end = text.indexOf('#id:') === -1 ? text.length : text.indexOf('#id:');
  if (/^\s*-\s/.test(text) && text.lastIndexOf('|', end) !== -1) { end = text.lastIndexOf('|', end); }
  end = text.slice(0, end).trimEnd().length;
  return [createReplaceFix(`Close [${tagName}] at the end of the line`, document.uri, new vscode.Range(line, end, line, end), `[/${tagName}]`, diagnostic, true)];
}

/**
 * Quick fixes for every DTL Reader diagnostic in the range the lightbulb
 * was asked for. Translation fixes have their own provider
 * (provideTranslationCodeActions).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Range} range
 * @param {vscode.CodeActionContext} context
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function provideDiagnosticCodeActions(document, range, context) {
  const fixes = [];
  for (const diagnostic of context.diagnostics) {
    if (diagnostic.source !== 'DTL Reader') { continue; }
    const typed = document.getText(diagnostic.range);
    switch (diagnostic.code) {
      case 'unresolvedJump':
        fixes.push(...await createUnresolvedJumpFixes(document, diagnostic));
        break;
      case 'jumpTranslationId':
        fixes.push(...createJumpTranslationIdFixes(document, diagnostic));
        break;
      case 'unknownCharacter':
      case 'unknownSpeaker': {
        fixes.push(...createDidYouMeanFixes(document, diagnostic, syntax.stripCharacterNameQuotes(typed), state.cachedCharacterNames, syntax.formatCharacterName));
        const add = await addToProject.createAddCharacterFix(document, diagnostic);
        if (add) { fixes.push(add); }
        break;
      }
      case 'unknownMood':
        fixes.push(...await createUnknownMoodFixes(document, diagnostic));
        break;
      case 'unknownVariable': {
        fixes.push(...createDidYouMeanFixes(document, diagnostic, typed, variables.collectVariableReferencePaths()));
        fixes.push(...await addToProject.createAddVariableFixes(document, diagnostic));
        break;
      }
      case 'unclosedBBCode':
        fixes.push(...createUnclosedTagFixes(document, diagnostic));
        break;
      case 'dchDefaultPortrait':
        fixes.push(...createDidYouMeanFixes(document, diagnostic, typed, dchParse.parseDchPortraits(document.getText()).keys()));
        break;
      case 'dchMissingScene':
        fixes.push(...createDidYouMeanFixes(document, diagnostic, typed,
          state.cachedResourcePaths.filter(resPath => events.RESOURCE_EXTENSIONS.scene.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()))));
        break;
    }
  }
  return fixes;
}

Object.assign(module.exports, {
  documentEol,
  provideDiagnosticCodeActions,
});
