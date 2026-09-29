// -----------------------------------------------------------------------------
// Quick fixes adding an unknown character or variable to project.godot.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const resources = require('../godot/resources');
const settings = require('../godot/project-settings');
const syntax = require('../timeline/syntax');
const project = require('../project');
const quickFixes = require('./index');

// =============================================================================
// QUICK FIXES
// =============================================================================
// Lightbulb fixes (Ctrl+.) for the problems DTL Reader reports: the closest
// existing names for a typo, creating what's missing (a label, a portrait),
// and removing or closing what's wrong (a jump's #id, an unclosed BBCode
// tag). Each fix re-reads the line its diagnostic points at rather than
// storing data on the diagnostic, so it always matches the current text.

/**
 * The types a Dialogic variable can have (those of Dialogic's variable
 * editor), each with the default value a new variable gets.
 *
 * @type {{type: string, label: string, value: string}[]}
 */
const DIALOGIC_VARIABLE_TYPES = [
  { type: 'String', label: 'a text', value: '""' },
  { type: 'int', label: 'a whole number', value: '0' },
  { type: 'float', label: 'a decimal number', value: '0.0' },
  { type: 'bool', label: 'a bool', value: 'false' },
];

/**
 * The type a new Dialogic variable most likely has, from how the line
 * uses it: `set {x} = 2` or `if {x} > 1` an int, `= 1.5` a float, `==
 * true` a bool - a text otherwise (Dialogic's own default).
 *
 * @param {string} lineText
 * @param {string} path - e.g. "chapter.flag"
 * @returns {string} one of DIALOGIC_VARIABLE_TYPES' types
 */
function inferVariableType(lineText, path) {
  const escaped = path.replace(/\./g, '\\.');
  const match = lineText.match(new RegExp(`\\{${escaped}\\}\\s*(?:==|!=|<=|>=|[-+*/]?=|<|>)\\s*(.+)$`));
  const value = match ? match[1].split(/\s+(?:and|or)\s+/)[0].trim() : '';
  if (/^-?\d+$/.test(value)) { return 'int'; }
  if (/^-?\d*\.\d+$/.test(value)) { return 'float'; }
  if (/^(?:true|false)$/.test(value)) { return 'bool'; }
  return 'String';
}

/**
 * An edit adding a Dialogic variable to project.godot's `variables`,
 * creating its folders as needed (`{chapter1.met_john}` adds `met_john` to
 * the `chapter1` folder, creating it if it doesn't exist).
 *
 * @param {string} text - project.godot
 * @param {string[]} segments - the variable path
 * @param {string} value - its default, a Godot literal
 * @param {string} eol
 * @returns {{start: number, end: number, text: string} | null} null if it can't be added (a variable where a folder is needed)
 */
function createAddVariableEdit(text, segments, value, eol) {
  let openIndex = settings.findDialogicSettingDict(text, 'variables');
  if (openIndex === -1) { return null; }
  for (let i = 0; i < segments.length; i++) {
    const dict = resources.scanGodotDict(text, openIndex);
    if (!dict) { return null; }
    const valueIndex = dict.entries.get(segments[i]);
    if (valueIndex === undefined) {
      let entry = value;
      for (let j = segments.length - 1; j > i; j--) { entry = `{${eol}${resources.godotString(segments[j])}: ${entry}${eol}}`; }
      return resources.appendGodotDictEntry(text, openIndex, `${resources.godotString(segments[i])}: ${entry}`, eol);
    }
    if (i === segments.length - 1 || text[valueIndex] !== '{') { return null; } // exists already, or isn't a folder
    openIndex = valueIndex;
  }
  return null;
}

/**
 * The text of a new .dch character file, as Dialogic writes it, with the
 * given portraits (image portraits to fill in) - the first one being the
 * default.
 *
 * @param {string} name
 * @param {string[]} moods
 * @param {string} eol
 * @returns {string}
 */
function newCharacterFileText(name, moods, eol) {
  const k = key => `&"${key}"`;
  const portraits = moods.map(mood => [
    `&${resources.godotString(mood)}: {`,
    `${k('export_overrides')}: {`,
    `${k('image')}: "\\"res://\\""`,
    '},',
    `${k('mirror')}: false,`,
    `${k('offset')}: Vector2(0, 0),`,
    `${k('scale')}: 1.0,`,
    `${k('scene')}: ""`,
    '}',
  ].join(eol));
  return [
    '{',
    `${k('@path')}: "res://addons/dialogic/Resources/character.gd",`,
    `${k('@subpath')}: NodePath(""),`,
    `${k('color')}: Color(1, 1, 1, 1),`,
    `${k('custom_info')}: {},`,
    `${k('default_portrait')}: ${resources.godotString(moods[0] || '')},`,
    `${k('description')}: "",`,
    `${k('display_name')}: ${resources.godotString(name)},`,
    `${k('mirror')}: false,`,
    `${k('nicknames')}: [],`,
    `${k('offset')}: Vector2(0, 0),`,
    portraits.length ? `${k('portraits')}: {${eol}${portraits.join(`,${eol}`)}${eol}},` : `${k('portraits')}: {},`,
    `${k('scale')}: 1.0`,
    '}',
    '',
  ].join(eol);
}

/**
 * A `<name>.dch` file the project already has but doesn't register, if any.
 *
 * @param {string} name
 * @returns {string | null} its res:// path
 */
function findUnregisteredCharacterFile(name) {
  const fileName = `/${name}.dch`.toLowerCase();
  const registered = new Set([...state.cachedCharacterPaths.values()].map(resPath => resPath.toLowerCase()));
  return state.cachedResourcePaths.find(resPath => resPath.toLowerCase().endsWith(fileName) && !registered.has(resPath.toLowerCase())) || null;
}

/** @param {string} resPath @returns {string} its folder, without the trailing "/" */
const resFolderOf = resPath => resPath.slice(0, resPath.lastIndexOf('/'));

/**
 * The folders a new character of this timeline could go in, best first,
 * each with why it's suggested:
 * 1. a character folder named like one of this timeline's folders
 *    (`timelines/chapter2/market.dtl` -> `characters/chapter2`), for
 *    projects organized by chapter or route;
 * 2. the folders of the characters this timeline already uses - a new
 *    character most likely belongs with the rest of the scene's cast;
 * 3. the folders of the project's other characters, most used first;
 * 4. with no characters yet: a `characters` folder beside the timelines
 *    folder (`res://story/timelines/` -> `res://story/characters`), the
 *    timeline's own folder, and `res://characters`.
 *
 * @param {vscode.TextDocument} document - the timeline
 * @returns {{folder: string, reason: string}[]}
 */
function rankCharacterFolders(document) {
  const candidates = new Map();
  const add = (folder, score, reason) => {
    const current = candidates.get(folder);
    if (!current || current.score < score) { candidates.set(folder, { score, reason }); }
  };
  const countFolders = names => {
    const counts = new Map();
    for (const name of names) {
      const folder = resFolderOf(state.cachedCharacterPaths.get(name));
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
    return counts;
  };
  const allCounts = countFolders(state.cachedCharacterPaths.keys());
  const timelinePath = project.toResPath(document.uri);
  const timelineFolders = timelinePath ? resFolderOf(timelinePath).replace(/^res:\/\//, '').split('/').filter(Boolean) : [];

  for (const folder of allCounts.keys()) {
    const folderName = folder.slice(folder.lastIndexOf('/') + 1);
    if (timelineFolders.some(segment => segment.toLowerCase() === folderName.toLowerCase())) {
      add(folder, 4000, `named like this timeline's folder "${folderName}"`);
    }
  }
  const castNames = new Set();
  for (let line = 0; line < document.lineCount; line++) {
    const name = syntax.findLineCharacter(document.lineAt(line).text);
    if (name && state.cachedCharacterPaths.has(name)) { castNames.add(name); }
  }
  for (const [folder, count] of countFolders(castNames)) {
    const inFolder = [...castNames].filter(name => resFolderOf(state.cachedCharacterPaths.get(name)) === folder);
    const shown = inFolder.slice(0, 3).join(', ') + (inFolder.length > 3 ? '...' : '');
    add(folder, 3000 + count, `with ${shown}, who ${count > 1 ? 'are' : 'is'} in this timeline`);
  }
  const total = state.cachedCharacterPaths.size;
  for (const [folder, count] of allCounts) {
    add(folder, 2000 + count, `where ${count} of the project's ${total} characters ${count > 1 ? 'are' : 'is'}`);
  }
  if (timelinePath) {
    const timelineFolder = resFolderOf(timelinePath);
    const beside = timelineFolder.match(/^(.*)\/timelines?(?:\/|$)/i);
    if (beside) { add(`${beside[1]}/characters`, 1000, 'beside the timelines folder'); }
    add(timelineFolder, 500, "this timeline's folder");
  }
  add('res://characters', 100, 'a characters folder at the root of the project');
  return [...candidates].sort((a, b) => b[1].score - a[1].score).map(([folder, { reason }]) => ({ folder, reason }));
}

/**
 * A quick fix applying `edit`, then saving `saveUris` (so the project is
 * re-read from disk and the problem goes away).
 *
 * @param {string} title
 * @param {vscode.WorkspaceEdit} edit
 * @param {vscode.Uri[]} saveUris
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction}
 */
function createSavedEditFix(title, edit, saveUris, diagnostic) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.edit = edit;
  action.diagnostics = [diagnostic];
  action.command = { command: 'dtlReader.saveAndRefresh', title: 'Save', arguments: splitFilesToSave(saveUris) };
  return action;
}

/**
 * Which of the files a quick fix changes can be saved with it: not those
 * already open with unsaved changes of their own, which saving would
 * write too - those are left for the person to save.
 *
 * @param {vscode.Uri[]} uris - checked before the fix is applied
 * @returns {[vscode.Uri[], vscode.Uri[]]} [to save, left unsaved]
 */
function splitFilesToSave(uris) {
  const isDirty = uri => vscode.workspace.textDocuments.some(document => document.isDirty && project.normalizeFsPath(document.uri.fsPath || '') === project.normalizeFsPath(uri.fsPath));
  return [uris.filter(uri => !isDirty(uri)), uris.filter(isDirty)];
}

/**
 * Save the given files (after a quick fix changed them) and re-read the
 * project. An internal command, not in the Command Palette.
 *
 * @param {vscode.Uri[]} uris
 * @param {vscode.Uri[]} [leftUnsaved] - changed too, but they had unsaved changes already
 */
async function saveAndRefreshCommand(uris, leftUnsaved = []) {
  for (const uri of uris || []) {
    const document = vscode.workspace.textDocuments.find(candidate => project.normalizeFsPath(candidate.uri.fsPath || '') === project.normalizeFsPath(uri.fsPath));
    if (document && document.isDirty) { await document.save(); }
  }
  if (leftUnsaved.length > 0) {
    const names = leftUnsaved.map(uri => uri.path.split('/').pop()).join(', ');
    vscode.window.showInformationMessage(`${names} had unsaved changes, so it was changed but not saved - save it to apply the fix.`);
  }
  await project.refreshProjectGodotData();
}

/**
 * "Add the variable to project.godot" for an unknown `{variable}`, one fix
 * per Dialogic variable type - the type the line suggests first. Not for
 * an autoload member, which lives in its script.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction[]>}
 */
async function createAddVariableFixes(document, diagnostic) {
  if (!state.projectRootUri) { return []; }
  const path = document.getText(diagnostic.range);
  const segments = path.split('.');
  if (state.cachedAutoloadNames.has(segments[0])) { return []; }
  let projectDocument;
  try { projectDocument = await vscode.workspace.openTextDocument(project.projectGodotUri()); } catch (error) { return []; }
  const text = projectDocument.getText();
  const likely = inferVariableType(document.lineAt(diagnostic.range.start.line).text, path);
  const types = [...DIALOGIC_VARIABLE_TYPES].sort((a, b) => (b.type === likely) - (a.type === likely));
  const fixes = [];
  for (const { label, value } of types) {
    const change = createAddVariableEdit(text, segments, value, quickFixes.documentEol(projectDocument));
    if (!change) { return []; }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(projectDocument.uri, new vscode.Range(projectDocument.positionAt(change.start), projectDocument.positionAt(change.end)), change.text);
    fixes.push(createSavedEditFix(`Add the variable "${path}" to project.godot as ${label} (${value})`, edit, [projectDocument.uri], diagnostic));
  }
  return fixes;
}

/**
 * The edit registering a character in project.godot's
 * `directories/dch_directory` - and, for a new file, creating its .dch
 * (with `mood`, if any, as its default portrait) - with the files to save.
 *
 * @param {string} name
 * @param {string} resPath - the .dch file
 * @param {boolean} exists - the .dch file is already there
 * @param {string|null} mood
 * @returns {Promise<{edit: vscode.WorkspaceEdit, saveUris: vscode.Uri[]} | null>}
 */
async function createAddCharacterEdit(name, resPath, exists, mood) {
  let projectDocument;
  try { projectDocument = await vscode.workspace.openTextDocument(project.projectGodotUri()); } catch (error) { return null; }
  const text = projectDocument.getText();
  const eol = quickFixes.documentEol(projectDocument);
  const openIndex = settings.findDialogicSettingDict(text, 'directories/dch_directory');
  if (openIndex === -1) { return null; }
  const change = resources.appendGodotDictEntry(text, openIndex, `${resources.godotString(name)}: ${resources.godotString(resPath)}`, eol);
  if (!change) { return null; }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(projectDocument.uri, new vscode.Range(projectDocument.positionAt(change.start), projectDocument.positionAt(change.end)), change.text);
  const saveUris = [projectDocument.uri];
  if (!exists) {
    const dchUri = project.resolveResourcePath(resPath);
    edit.createFile(dchUri, { ignoreIfExists: true });
    edit.insert(dchUri, new vscode.Position(0, 0), newCharacterFileText(name, mood ? [mood] : [], eol));
    saveUris.push(dchUri);
  }
  return { edit, saveUris };
}

/**
 * "Add the character to project.godot" for an unknown character. When the
 * project already has an unregistered `<name>.dch`, it's registered
 * directly; otherwise the fix asks which folder the new .dch goes in (see
 * addCharacterCommand).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Promise<vscode.CodeAction | null>}
 */
async function createAddCharacterFix(document, diagnostic) {
  if (!state.projectRootUri || !state.declaredProjectData.characters) { return null; }
  const name = syntax.stripCharacterNameQuotes(document.getText(diagnostic.range));
  if (!name || /[\\/:*?"<>|]/.test(name)) { return null; } // not a valid file name
  const existing = findUnregisteredCharacterFile(name);
  if (existing) {
    const change = await createAddCharacterEdit(name, existing, true, null);
    return change ? createSavedEditFix(`Add the character "${name}" (${existing}) to project.godot`, change.edit, change.saveUris, diagnostic) : null;
  }
  const mood = (document.lineAt(diagnostic.range.start.line).text.slice(diagnostic.range.end.character).match(/^\s*\(([\p{L}_][\p{L}0-9_]*)\)/u) || [])[1] || null;
  const action = new vscode.CodeAction(`Add the character "${name}" to project.godot, with a new ${name}.dch...`, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.command = { command: 'dtlReader.addCharacter', title: action.title, arguments: [{ name, mood, timeline: document.uri.toString() }] };
  return action;
}

/**
 * Ask where a new character's .dch file goes - the folders of
 * rankCharacterFolders, best first, or any other folder of the project -
 * then create it, register it in project.godot and save both. An internal
 * command, run by the "Add the character" quick fix.
 *
 * @param {{name: string, mood: string|null, timeline: string, folder?: string}} args - `folder` skips the question
 */
async function addCharacterCommand(args) {
  if (!state.projectRootUri || !args) { return; }
  const { name, mood } = args;
  let folder = args.folder;
  if (!folder) {
    const timelineUri = vscode.Uri.parse(args.timeline);
    const timeline = vscode.workspace.textDocuments.find(document => document.uri.toString() === timelineUri.toString())
      || await vscode.workspace.openTextDocument(timelineUri);
    const other = { label: '$(folder-opened) Other folder...', detail: 'Choose any folder of the project' };
    const items = rankCharacterFolders(timeline).map(({ folder: candidate, reason }) => ({
      label: `$(folder) ${candidate}/`,
      description: state.cachedResourcePaths.some(resPath => resPath.startsWith(`${candidate}/`)) ? '' : 'new folder',
      detail: reason,
      folder: candidate,
    }));
    const picked = await vscode.window.showQuickPick([...items, other], {
      title: `Where should ${name}.dch go?`,
      placeHolder: 'Folder of the new character file - the most likely first',
      matchOnDetail: true,
    });
    if (!picked) { return; }
    if (picked === other) {
      const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        defaultUri: project.resolveResourcePath(items[0].folder),
        openLabel: `Put ${name}.dch here`,
      });
      if (!chosen || !chosen[0]) { return; }
      folder = project.toResPath(chosen[0]) || (project.normalizeFsPath(chosen[0].fsPath) === project.normalizeFsPath(state.projectRootUri.fsPath) ? 'res://' : null);
      if (!folder) {
        vscode.window.showErrorMessage(`${name}.dch must be inside the Godot project (${state.projectRootUri.fsPath}).`);
        return;
      }
    } else {
      folder = picked.folder;
    }
  }
  // The file name is the character's identifier for Dialogic, so it's
  // always `<name>.dch`, whatever the folder.
  const resPath = `${folder.replace(/\/+$/, '')}/${name}.dch`.replace(/^res:\/(?!\/)/, 'res://');
  if (state.cachedResourcePaths.some(existing => existing.toLowerCase() === resPath.toLowerCase())) {
    vscode.window.showErrorMessage(`${resPath} already exists.`);
    return;
  }
  const change = await createAddCharacterEdit(name, resPath, false, mood);
  if (!change) { return; }
  const [save, leftUnsaved] = splitFilesToSave(change.saveUris);
  await vscode.workspace.applyEdit(change.edit);
  await saveAndRefreshCommand(save, leftUnsaved);
}

Object.assign(module.exports, {
  rankCharacterFolders,
  saveAndRefreshCommand,
  createAddVariableFixes,
  createAddCharacterFix,
  addCharacterCommand,
});
