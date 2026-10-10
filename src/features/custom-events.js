// -----------------------------------------------------------------------------
// The project's own Dialogic events, from its extensions folder.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const events = require('../docs/events');
const resources = require('../godot/resources');
const gdscript = require('../godot/gdscript');
const project = require('../project');

// =============================================================================
// CUSTOM EVENTS
// =============================================================================
// Dialogic events the project adds itself: scripts extending DialogicEvent
// in Dialogic's extensions folder (project setting `dialogic/extensions_folder`,
// `res://addons/dialogic_additions/` by default). A shortcode event -
// `get_shortcode()` returning its name and `get_shortcode_parameters()` its
// parameters - is written `[name param=value]` in a timeline, like the
// built-in bracket events. Each one found is added to DTL_ENTRIES (and its
// values to DTL_ATTRIBUTE_VALUE_SUGGESTIONS, its file parameters to
// DTL_PATH_ATTRIBUTES), so completion, parameters, values, `res://` paths and
// hover treat it exactly like a built-in event.

/** Names of the custom events currently in DTL_ENTRIES. @type {string[]} */
let customEventNames = [];

/**
 * Parse a custom event script into a DTL_ENTRIES entry (plus its parameter
 * values), from what Dialogic reads: `event_name`, `event_description`,
 * `get_shortcode()` and `get_shortcode_parameters()` - each parameter
 * documented by the `##` comment of the property it sets, with its type
 * and default.
 *
 * @param {string} text - the .gd file
 * @param {string} resPath - where it is, shown in the documentation
 * @returns {{entry: object, values: Record<string, string[]>, paths: Record<string, string[]>} | null} null if it isn't a shortcode event (paths: file parameters -> allowed extensions)
 */
function parseCustomEventScript(text, resPath) {
  if (!/^\s*extends\s+DialogicEvent\b/m.test(text)) { return null; }
  const shortcode = (text.match(/func\s+get_shortcode\s*\([^)]*\)[^:\n]*:\s*(?:#[^\n]*)?\n\s*return\s+["']([A-Za-z_][A-Za-z0-9_]*)["']/) || [])[1];
  if (!shortcode) { return null; }
  const eventName = (text.match(/\bevent_name\s*=\s*["']([^"'\n]*)["']/) || [])[1] || shortcode;
  const description = (text.match(/\bevent_description\s*=\s*["']([^"'\n]*)["']/) || [])[1] || '';
  const symbols = gdscript.parseGdScript(text);
  const variables = {};
  const values = {};
  const defaults = {};
  const paths = {};
  // File parameters: the extensions of their `ValueType.FILE` editor field's
  // file_filter ("*.png, *.jpg; Images"), when there is one.
  const fileFilters = {};
  for (const edit of text.matchAll(/add_(?:header|body)_edit\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,\s*ValueType\.FILE\b([^\n]*)/g)) {
    const filter = (edit[2].match(/["']file_filter["']\s*:\s*["']([^"']*)["']/) || [])[1] || '';
    fileFilters[edit[1]] = [...filter.matchAll(/\*\.([A-Za-z0-9]+)/g)].map(match => match[1].toLowerCase());
  }
  const header = text.match(/func\s+get_shortcode_parameters\s*\([^)]*\)[^:\n]*:/);
  const openIndex = header ? text.indexOf('{', header.index + header[0].length) : -1;
  const body = openIndex === -1 ? null : resources.extractBalancedBraces(text, openIndex);
  for (const { key, body: parameter } of body ? resources.extractTopLevelDictEntries(body) : []) {
    const property = (parameter.match(/["']property["']\s*:\s*["']([^"']+)["']/) || [])[1] || key;
    const defaultValue = ((parameter.match(/["']default["']\s*:\s*([^,}\n]+)/) || [])[1] || '').trim();
    const info = symbols.variables.get(property);
    // A `### Section` title above the first property isn't its documentation.
    const doc = info && info.doc ? info.doc.split('\n').filter(line => !line.startsWith('#')).join(' ').trim() : '';
    const type = info && info.type ? info.type : '';
    const details = [type && `\`${type}\``, defaultValue && `default \`${defaultValue}\``].filter(Boolean).join(', ');
    variables[key] = `${doc || `Sets \`${property}\`.`}${details ? ` (${details})` : ''}`;
    defaults[key] = defaultValue;
    const suggested = [...parameter.matchAll(/["']value["']\s*:\s*([^,}\n]+)/g)].map(match => match[1].trim().replace(/^["']|["']$/g, ''));
    // `"ext_file": true` (or a FILE editor field): a `res://` path.
    if (/["']ext_file["']\s*:\s*true/.test(parameter) || property in fileFilters) {
      paths[key] = fileFilters[property] && fileFilters[property].length > 0 ? fileFilters[property] : Object.values(events.RESOURCE_EXTENSIONS).flat();
    }
    if (suggested.length > 0) { values[key] = suggested; }
    else if (type === 'bool' || /^(?:true|false)$/.test(defaultValue) || (info && /^(?:true|false)$/.test(info.defaultValue || ''))) { values[key] = ['true', 'false']; }
  }
  const firstParameter = Object.keys(variables)[0];
  // The example sets the first parameter to a suggested value, else its default.
  const exampleValue = firstParameter && (values[firstParameter] ? values[firstParameter][0] : (defaults[firstParameter] || '""'));
  return {
    entry: {
      name: shortcode,
      type: 'bracket',
      syntax: `[${shortcode} ...]`,
      description: `${eventName !== shortcode ? `${eventName}: ` : ''}${description || 'A custom Dialogic event.'}\n\n_Custom event, from \`${resPath}\`._`,
      example: firstParameter ? `[${shortcode} ${firstParameter}=${exampleValue}]` : `[${shortcode}]`,
      variables,
      custom: true,
    },
    values,
    paths,
  };
}

/**
 * Re-read the custom events of the project's Dialogic extensions folder
 * into DTL_ENTRIES, replacing the previous ones. A built-in event of the
 * same name wins.
 *
 * @param {string} dialogicSection - project.godot's [dialogic] section
 */
async function refreshCustomEvents(dialogicSection) {
  for (const name of customEventNames) {
    const index = events.DTL_ENTRIES.findIndex(entry => entry.custom && entry.name === name);
    if (index !== -1) { events.DTL_ENTRIES.splice(index, 1); }
    delete events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[name];
    delete events.DTL_PATH_ATTRIBUTES[name];
  }
  customEventNames = [];
  if (!state.projectRootUri) { return; }
  const folderMatch = dialogicSection.match(/(?:^|\n)extensions_folder\s*=\s*"([^"]*)"/);
  const folder = (folderMatch ? folderMatch[1] : 'res://addons/dialogic_additions/').replace(/\/?$/, '/');
  for (const resPath of state.cachedResourcePaths) {
    if (!resPath.startsWith(folder) || !resPath.toLowerCase().endsWith('.gd')) { continue; }
    let parsed;
    try { parsed = parseCustomEventScript(Buffer.from(await vscode.workspace.fs.readFile(project.resolveResourcePath(resPath))).toString('utf8'), resPath); } catch (error) { continue; }
    if (!parsed || events.DTL_ENTRIES.some(entry => entry.name === parsed.entry.name)) { continue; }
    events.DTL_ENTRIES.push(parsed.entry);
    if (Object.keys(parsed.values).length > 0) { events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[parsed.entry.name] = parsed.values; }
    if (Object.keys(parsed.paths).length > 0) { events.DTL_PATH_ATTRIBUTES[parsed.entry.name] = parsed.paths; }
    customEventNames.push(parsed.entry.name);
  }
  await refreshIds(dialogicSection);   // after the events: ids join their suggestions (path: project.godot's ids_file)
}

// =============================================================================
// PROJECT IDS (ids file): suggestions and unknown ids
// =============================================================================
// A project can list the ids its timelines may use in a JSON file. Where it
// is: project.godot's `dialogic/ids_file` ([dialogic] section, `ids_file=`),
// `res://dialogic/ids.json` when not set - the tool writing the file (e.g.
// Laripo's Characters dock > IDs tab) writes that setting too:
//   { "values": { "cg.id": ["beach", ...], "achievement.name": [...] },
//     "titles": { "cg.id": { "beach": "Beach at night" } } }
// Each "shortcode.param" key gets those ids as suggestions after
// `[shortcode param="` (with the event's own suggested values, and the title
// as detail), and a value not in the list is reported
// (`dtlReader.diagnostics.unknownId`), also when the list is still empty.
// Quick fixes: the closest ids, or adding the id to the file's "requested"
// (and "values"), so the tool writing the file can create the entry.

/** Where the ids file is when project.godot doesn't say. */
const DEFAULT_IDS_FILE = 'res://dialogic/ids.json';
/** The ids file of the project (from project.godot, refreshed with it). */
let idsResPath = DEFAULT_IDS_FILE;
/** "shortcode.param" -> the ids allowed there. @type {Map<string, Set<string>>} */
const cachedIds = new Map();
/** "shortcode.param" -> id -> its title (completion detail). @type {Map<string, Map<string, string>>} */
const cachedIdTitles = new Map();
/** Suggestions changed by the ids file, to put back on the next refresh: "shortcode.param" -> previous values (or undefined). */
let overriddenSuggestions = new Map();

/**
 * The ids file's res:// path: `ids_file` of project.godot's [dialogic]
 * section, else res://dialogic/ids.json.
 *
 * @param {string} dialogicSection - project.godot's [dialogic] section
 * @returns {string}
 */
function idsFileFromProject(dialogicSection) {
  const match = (dialogicSection || '').match(/(?:^|\n)ids_file\s*=\s*"([^"]*)"/);
  return match && match[1].startsWith('res://') ? match[1] : DEFAULT_IDS_FILE;
}

/** The ids file in use (res:// path). */
function idsFile() {
  return idsResPath;
}

/**
 * Read the ids file into cachedIds and the value suggestions: the ids are
 * added to what the event itself suggests for that parameter (never replace
 * it: an empty list must not hide the event's own values).
 *
 * @param {string} [dialogicSection] - project.godot's [dialogic] section (omitted: keep the path known)
 */
async function refreshIds(dialogicSection) {
  if (dialogicSection !== undefined) { idsResPath = idsFileFromProject(dialogicSection); }
  for (const [key, previous] of overriddenSuggestions) {
    const [shortcode, param] = key.split('.');
    const values = events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[shortcode];
    if (!values) { continue; }
    if (previous === undefined) { delete values[param]; } else { values[param] = previous; }
  }
  overriddenSuggestions = new Map();
  cachedIds.clear();
  cachedIdTitles.clear();
  if (!state.projectRootUri) { return; }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(project.resolveResourcePath(idsResPath))).toString('utf8'));
  } catch (error) { return; } // no ids file (or not JSON): nothing to suggest or check
  const values = parsed && typeof parsed.values === 'object' && parsed.values !== null ? parsed.values : {};
  const titles = parsed && typeof parsed.titles === 'object' && parsed.titles !== null ? parsed.titles : {};
  for (const key of Object.keys(values)) {
    if (!Array.isArray(values[key]) || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { continue; }
    const ids = values[key].map(String).filter(id => id !== '');
    cachedIds.set(key, new Set(ids));
    const keyTitles = new Map();
    if (titles[key] && typeof titles[key] === 'object') {
      for (const id of ids) {
        if (titles[key][id]) { keyTitles.set(id, String(titles[key][id])); }
      }
    }
    cachedIdTitles.set(key, keyTitles);
    const [shortcode, param] = key.split('.');
    const suggestions = events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[shortcode] || (events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[shortcode] = {});
    const own = suggestions[param];
    overriddenSuggestions.set(key, own);
    suggestions[param] = [...new Set([...ids, ...(own || [])])];
  }
}

/**
 * The title of [param id] for "shortcode.param" in the ids file ('' if none).
 *
 * @param {string} shortcode
 * @param {string} param
 * @param {string} id
 * @returns {string}
 */
function idTitle(shortcode, param, id) {
  const titles = cachedIdTitles.get(`${shortcode}.${param}`);
  return titles ? titles.get(id) || '' : '';
}

/**
 * Unknown ids in a timeline: `[shortcode param="value"]` (the event at the
 * start of its line) where "shortcode.param" is in the ids file and the value
 * is not - also when that list is still empty.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnknownIdDiagnostics(document) {
  const diagnostics = [];
  if (cachedIds.size === 0) { return diagnostics; }
  const problems = require('../diagnostics/index');
  for (let line = 0; line < document.lineCount; line++) {
    for (const found of idsOnLine(document.lineAt(line).text)) {
      const ids = cachedIds.get(found.key);
      if (!ids || found.id === '' || ids.has(found.id) || found.id.startsWith('{')) { continue; }
      const message = ids.size === 0
        ? `No ${found.key} ids in the project's ids file yet (${idsResPath}): "${found.id}" is unknown.`
        : `Unknown ${found.key} "${found.id}": not in the project's ids file (${idsResPath}).`;
      problems.pushDiagnostic(diagnostics, 'unknownId', new vscode.Range(line, found.start, line, found.start + found.id.length), message);
    }
  }
  return diagnostics;
}

/**
 * The `param="value"` of the event starting [param text]: [{key, id, start}]
 * (key "shortcode.param", start: column of the value).
 *
 * @param {string} text - one line
 * @returns {{key: string, id: string, start: number}[]}
 */
function idsOnLine(text) {
  const out = [];
  const match = /^(\s*\[)([A-Za-z_][A-Za-z0-9_]*)\b([^\]]*)/.exec(text);
  if (!match) { return out; }
  const paramsStart = match[1].length + match[2].length;
  const paramPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g;
  let param;
  while ((param = paramPattern.exec(match[3])) !== null) {
    out.push({ key: `${match[2]}.${param[1]}`, id: param[2], start: paramsStart + param.index + param[0].indexOf('"') + 1 });
  }
  return out;
}

/**
 * The "shortcode.param" key and the typed id of an unknownId diagnostic,
 * read again from its line (null if the line changed since).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {{key: string, id: string} | null}
 */
function findIdAt(document, diagnostic) {
  const start = diagnostic.range.start.character;
  const found = idsOnLine(document.lineAt(diagnostic.range.start.line).text).find(entry => entry.start === start);
  return found ? { key: found.key, id: found.id } : null;
}

/**
 * Adds [param id] to "values" (the warning goes away) and "requested" (the
 * tool that writes the ids file - e.g. Laripo's IDs tab - creates the real
 * entry) of the project's ids file, for [param key].
 *
 * @param {string} key - "shortcode.param"
 * @param {string} id
 */
async function addProjectId(key, id) {
  const uri = project.resolveResourcePath(idsResPath);
  let parsed = {};
  try { parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')); } catch (error) { parsed = {}; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { parsed = {}; }
  for (const part of ['values', 'requested']) {
    if (typeof parsed[part] !== 'object' || parsed[part] === null || Array.isArray(parsed[part])) { parsed[part] = {}; }
    const list = Array.isArray(parsed[part][key]) ? parsed[part][key] : [];
    if (!list.includes(id)) { list.push(id); }
    parsed[part][key] = list;
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(parsed, null, '\t'), 'utf8'));
  await refreshIds();
  require('../diagnostics/index').refreshAllDiagnostics();
  vscode.window.setStatusBarMessage(`DTL Reader: "${id}" added to ${idsResPath} (requested: create its entry in your tool).`, 5000);
}

/**
 * True if [param uri] is the project's ids file (it is re-read when it changes).
 *
 * @param {vscode.Uri} uri
 * @returns {boolean}
 */
function isIdsFile(uri) {
  if (!state.projectRootUri) { return false; }
  return uri.toString().toLowerCase() === project.resolveResourcePath(idsResPath).toString().toLowerCase();
}

// =============================================================================
// CUSTOM EVENT COLOR
// =============================================================================
// The project's own events (`[cg ...]`, `[achievement ...]`) get their own
// look so they stand out from Dialogic's built-in ones:
// `dtlReader.customEvents.highlight`, `.color`, `.fontStyle`.

let customEventDecorationType = null;

/** The decoration, made from the current settings (re-made when they change). */
function customEventDecoration() {
  if (!customEventDecorationType) {
    const config = vscode.workspace.getConfiguration('dtlReader');
    const style = config.get('customEvents.fontStyle', 'italic');
    customEventDecorationType = vscode.window.createTextEditorDecorationType({
      color: config.get('customEvents.color', '#D7A6FF'),
      fontStyle: style.includes('italic') ? 'italic' : undefined,
      fontWeight: style.includes('bold') ? 'bold' : undefined,
      textDecoration: style.includes('underline') ? 'underline' : undefined,
    });
  }
  return customEventDecorationType;
}

/** The settings changed: the decoration is made again on the next update. */
function resetCustomEventDecoration() {
  if (customEventDecorationType) { customEventDecorationType.dispose(); }
  customEventDecorationType = null;
}

/**
 * Color the names of the project's custom events in an editor.
 *
 * @param {vscode.TextEditor} editor
 */
function updateCustomEventDecorations(editor) {
  if (!editor || editor.document.languageId !== 'dtl') { return; }
  const enabled = vscode.workspace.getConfiguration('dtlReader').get('customEvents.highlight', true);
  const ranges = [];
  if (enabled && customEventNames.length > 0) {
    const names = new Set(customEventNames);
    const pattern = /^(\s*\[)([A-Za-z_][A-Za-z0-9_]*)/;
    for (let line = 0; line < editor.document.lineCount; line++) {
      const match = pattern.exec(editor.document.lineAt(line).text);
      if (match && names.has(match[2])) {
        ranges.push(new vscode.Range(line, match[1].length, line, match[1].length + match[2].length));
      }
    }
  }
  editor.setDecorations(customEventDecoration(), ranges);
}

Object.assign(module.exports, {
  parseCustomEventScript,
  refreshCustomEvents,
  refreshIds,
  cachedIds,
  idsFile,
  idsFileFromProject,
  idTitle,
  isIdsFile,
  findUnknownIdDiagnostics,
  findIdAt,
  addProjectId,
  updateCustomEventDecorations,
  resetCustomEventDecoration,
});
