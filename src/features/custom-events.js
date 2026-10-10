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
  await refreshIds();   // after the events: ids replace their suggestions
}

// =============================================================================
// PROJECT IDS (ids.json): suggestions and unknown ids
// =============================================================================
// A project can list the ids its timelines may use in a JSON file
// (`dtlReader.idsFile`, `res://dialogic/ids.json` by default):
//   { "values": { "cg.id": ["beach", ...], "achievement.name": [...] } }
// Each "shortcode.param" key gets those values as suggestions after
// `[shortcode param="`, and a value not in the list is reported
// (`dtlReader.diagnostics.unknownId`). Works for built-in and custom events.
// Quick fixes: the closest ids, or adding the id to the file (its "values",
// and "requested" so the tool writing the file can create the entry).

/** "shortcode.param" -> the ids allowed there. @type {Map<string, Set<string>>} */
const cachedIds = new Map();
/** Suggestions replaced by the ids file, to put back on the next refresh: "shortcode.param" -> previous values (or undefined). */
let overriddenSuggestions = new Map();

/**
 * Read the ids file into cachedIds and the value suggestions (replacing
 * what the event declared for those parameters).
 */
async function refreshIds() {
  for (const [key, previous] of overriddenSuggestions) {
    const [shortcode, param] = key.split('.');
    const values = events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[shortcode];
    if (!values) { continue; }
    if (previous === undefined) { delete values[param]; } else { values[param] = previous; }
  }
  overriddenSuggestions = new Map();
  cachedIds.clear();
  if (!state.projectRootUri) { return; }
  const resPath = vscode.workspace.getConfiguration('dtlReader').get('idsFile', 'res://dialogic/ids.json');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(project.resolveResourcePath(resPath))).toString('utf8'));
  } catch (error) { return; } // no ids file: nothing to suggest or check
  const values = parsed && typeof parsed.values === 'object' ? parsed.values : {};
  for (const key of Object.keys(values)) {
    if (!Array.isArray(values[key]) || !key.includes('.')) { continue; }
    const ids = values[key].map(String);
    cachedIds.set(key, new Set(ids));
    const [shortcode, param] = key.split('.');
    const suggestions = events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[shortcode] || (events.DTL_ATTRIBUTE_VALUE_SUGGESTIONS[shortcode] = {});
    overriddenSuggestions.set(key, suggestions[param]);
    suggestions[param] = ids;
  }
}

/**
 * Unknown ids in a timeline: `[shortcode param="value"]` where
 * "shortcode.param" is in the ids file and the value is not.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findUnknownIdDiagnostics(document) {
  const diagnostics = [];
  if (cachedIds.size === 0) { return diagnostics; }
  const problems = require('../diagnostics/index');
  const eventPattern = /^\s*\[([A-Za-z_][A-Za-z0-9_]*)\b([^\]]*)/;
  const paramPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = eventPattern.exec(text);
    if (!match) { continue; }
    const paramsStart = text.indexOf(match[2], match.index + 1 + match[1].length);
    paramPattern.lastIndex = 0;
    let param;
    while ((param = paramPattern.exec(match[2])) !== null) {
      const ids = cachedIds.get(`${match[1]}.${param[1]}`);
      if (!ids || param[2] === '' || ids.has(param[2]) || param[2].startsWith('{')) { continue; }
      const start = paramsStart + param.index + param[0].indexOf('"') + 1;
      problems.pushDiagnostic(diagnostics, 'unknownId', new vscode.Range(line, start, line, start + param[2].length),
        `Unknown ${match[1]} ${param[1]} "${param[2]}": not in the project's ids (${vscode.workspace.getConfiguration('dtlReader').get('idsFile', 'res://dialogic/ids.json')}).`);
    }
  }
  return diagnostics;
}

/**
 * The "shortcode.param" key and the typed id of an unknownId diagnostic,
 * re-read from its line (null if the line changed).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {{key: string, id: string} | null}
 */
function findIdAt(document, diagnostic) {
  const text = document.lineAt(diagnostic.range.start.line).text;
  const match = /^\s*\[([A-Za-z_][A-Za-z0-9_]*)\b/.exec(text);
  if (!match) { return null; }
  const before = text.slice(0, diagnostic.range.start.character);
  const param = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"$/.exec(before);
  if (!param) { return null; }
  return { key: `${match[1]}.${param[1]}`, id: document.getText(diagnostic.range) };
}

/**
 * Adds [param id] to "values" (the warning goes away) and "requested" (the
 * tool that writes the ids file - e.g. Laripo's IDs tab - can create the real
 * entry) of the project's ids file, for [param key].
 *
 * @param {string} key - "shortcode.param"
 * @param {string} id
 */
async function addProjectId(key, id) {
  const resPath = vscode.workspace.getConfiguration('dtlReader').get('idsFile', 'res://dialogic/ids.json');
  const uri = project.resolveResourcePath(resPath);
  let parsed = {};
  try { parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')); } catch (error) { parsed = {}; }
  if (typeof parsed !== 'object' || parsed === null) { parsed = {}; }
  for (const part of ['values', 'requested']) {
    if (typeof parsed[part] !== 'object' || parsed[part] === null) { parsed[part] = {}; }
    const list = Array.isArray(parsed[part][key]) ? parsed[part][key] : [];
    if (!list.includes(id)) { list.push(id); }
    parsed[part][key] = list;
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(parsed, null, '\t'), 'utf8'));
  await refreshIds();
  require('../diagnostics/index').refreshAllDiagnostics();
  vscode.window.setStatusBarMessage(`DTL Reader: "${id}" added to ${resPath} (requested: create its entry in your tool).`, 5000);
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
  findUnknownIdDiagnostics,
  findIdAt,
  addProjectId,
  updateCustomEventDecorations,
  resetCustomEventDecoration,
});
