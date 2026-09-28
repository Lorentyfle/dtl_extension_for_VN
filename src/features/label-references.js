// -----------------------------------------------------------------------------
// Find All References, Rename and "N jumps here" for labels.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const project = require('../project');

// =============================================================================
// LABEL REFERENCES, RENAME AND CODE LENS
// =============================================================================
// Every place that jumps to a label: `jump name` in its own timeline, and
// `jump Timeline/name` in any timeline. Powers Find All References
// (Shift+F12), Rename (F2) and the "N jumps here" link above each label.

/**
 * The label under the cursor, on its `label` line or as a `jump` target -
 * as the timeline file it's declared in, that timeline's identifier, its
 * name, and the range of the name under the cursor.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{uri: vscode.Uri, identifier: string|null, name: string, range: vscode.Range} | null}
 */
function resolveLabelAt(document, position) {
  const text = document.lineAt(position.line).text;
  const covers = (start, length) => position.character >= start && position.character <= start + length;
  const label = syntax.parseLabelLine(text);
  if (label && covers(label.nameStart, label.name.length)) {
    return { uri: document.uri, identifier: project.findTimelineIdentifier(document), name: label.name, range: new vscode.Range(position.line, label.nameStart, position.line, label.nameStart + label.name.length) };
  }
  const jump = syntax.parseJumpLine(text);
  if (!jump || !jump.label || jump.target.includes('{') || !covers(jump.labelStart, jump.label.length)) { return null; }
  const range = new vscode.Range(position.line, jump.labelStart, position.line, jump.labelStart + jump.label.length);
  if (jump.timeline === null) {
    return { uri: document.uri, identifier: project.findTimelineIdentifier(document), name: jump.label, range };
  }
  const resPath = state.cachedTimelinePaths.get(jump.timeline);
  return resPath ? { uri: project.resolveResourcePath(resPath), identifier: jump.timeline, name: jump.label, range } : null;
}

/**
 * Where a label is declared and every jump to it, in every timeline.
 *
 * @param {{uri: vscode.Uri, identifier: string|null, name: string}} target
 * @param {{uri: vscode.Uri, identifier: string|null, lines: string[]}[]} timelines - from readAllTimelines
 * @returns {{declaration: vscode.Location|null, jumps: vscode.Location[]}}
 */
function findLabelLocations(target, timelines) {
  let declaration = null;
  const jumps = [];
  const targetPath = project.normalizeFsPath(target.uri.fsPath || '');
  for (const timeline of timelines) {
    const isTarget = project.normalizeFsPath(timeline.uri.fsPath || '') === targetPath;
    timeline.lines.forEach((text, line) => {
      if (isTarget && !declaration) {
        const label = syntax.parseLabelLine(text);
        if (label && label.name === target.name) {
          declaration = new vscode.Location(timeline.uri, new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length));
          return;
        }
      }
      const jump = syntax.parseJumpLine(text);
      if (!jump || jump.target.includes('{') || jump.label !== target.name) { return; }
      const pointsHere = jump.timeline === null ? isTarget : (target.identifier !== null && jump.timeline === target.identifier);
      if (pointsHere) {
        jumps.push(new vscode.Location(timeline.uri, new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length)));
      }
    });
  }
  return { declaration, jumps };
}

/**
 * Find All References (Shift+F12) on a label or a jump target.
 */
async function provideLabelReferences(document, position, context) {
  const target = resolveLabelAt(document, position);
  if (!target) { return undefined; }
  const { declaration, jumps } = findLabelLocations(target, await project.readAllTimelines(document));
  return context && context.includeDeclaration && declaration ? [declaration, ...jumps] : jumps;
}

/**
 * What a label may be renamed to, the way Dialogic parses labels and jumps:
 * not empty, and none of the characters that would end or split it -
 * "(" (display name), "/" (timeline separator), "#" (translation id or
 * comment), "{" "}" (variables).
 *
 * @param {string} name
 * @returns {string | null} why it's not valid, or null
 */
function validateLabelName(name) {
  if (!name.trim()) { return 'A label name can\'t be empty.'; }
  if (name !== name.trim()) { return 'A label name can\'t start or end with a space.'; }
  const bad = name.match(/[()/#{}\r\n]/);
  return bad ? `A label name can't contain "${bad[0]}" - Dialogic would read it as part of the syntax.` : null;
}

const labelRenameProvider = {
  prepareRename(document, position) {
    const target = resolveLabelAt(document, position);
    if (!target) { throw new Error('Only a label (on its "label" line or in a "jump") can be renamed here.'); }
    return { range: target.range, placeholder: target.name };
  },
  async provideRenameEdits(document, position, newName) {
    const target = resolveLabelAt(document, position);
    if (!target) { return undefined; }
    const problem = validateLabelName(newName);
    if (problem) { throw new Error(problem); }
    const timelines = await project.readAllTimelines(document);
    const { declaration, jumps } = findLabelLocations(target, timelines);
    if (newName !== target.name && findLabelLocations({ ...target, name: newName }, timelines).declaration) {
      throw new Error(`This timeline already has a label named "${newName}".`);
    }
    const edit = new vscode.WorkspaceEdit();
    for (const location of [declaration, ...jumps].filter(Boolean)) { edit.replace(location.uri, location.range, newName); }
    return edit;
  },
};

/**
 * "N jumps here" above each label (`dtlReader.codeLens.labelReferences`);
 * clicking it lists them (like Find All References).
 */
async function provideLabelCodeLenses(document) {
  if (!vscode.workspace.getConfiguration('dtlReader').get('codeLens.labelReferences', true)) { return []; }
  const labels = [];
  for (let line = 0; line < document.lineCount; line++) {
    const label = syntax.parseLabelLine(document.lineAt(line).text);
    if (label) { labels.push({ line, label }); }
  }
  if (labels.length === 0) { return []; }
  const timelines = await project.readAllTimelines(document);
  const identifier = project.findTimelineIdentifier(document);
  return labels.map(({ line, label }) => {
    const { jumps } = findLabelLocations({ uri: document.uri, identifier, name: label.name }, timelines);
    const position = new vscode.Position(line, label.nameStart);
    const title = jumps.length === 0 ? 'no jump here' : `${jumps.length} jump${jumps.length > 1 ? 's' : ''} here`;
    return new vscode.CodeLens(new vscode.Range(position, position), jumps.length === 0
      ? { title, command: '' }
      : { title, command: 'editor.action.showReferences', arguments: [document.uri, position, jumps] });
  });
}

Object.assign(module.exports, {
  provideLabelReferences,
  validateLabelName,
  labelRenameProvider,
  provideLabelCodeLenses,
});
