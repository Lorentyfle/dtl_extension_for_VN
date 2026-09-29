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
// values to DTL_ATTRIBUTE_VALUE_SUGGESTIONS), so completion, parameters,
// values and hover treat it exactly like a built-in event.

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
 * @returns {{entry: object, values: Record<string, string[]>} | null} null if it isn't a shortcode event
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
    customEventNames.push(parsed.entry.name);
  }
}

Object.assign(module.exports, {
  parseCustomEventScript,
  refreshCustomEvents,
});
