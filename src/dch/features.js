// -----------------------------------------------------------------------------
// Support for .dch files: completion, hover and problems.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const events = require('../docs/events');
const dchKeys = require('../docs/dch-keys');
const resources = require('../godot/resources');
const gdscript = require('../godot/gdscript');
const syntax = require('../timeline/syntax');
const timelineMoods = require('../timeline/moods');
const project = require('../project');
const dchParse = require('./parse');
const problems = require('../diagnostics/index');
const completionItems = require('../completion/items');

// =============================================================================
// DIALOGIC CHARACTER FILES (.dch)
// =============================================================================
// A .dch file is Godot's var_to_str() of inst_to_dict(DialogicCharacter):
// a GDScript-literal dictionary. These describe its keys, per nesting level,
// for autocomplete and hover. Taken from Dialogic's own DialogicCharacter
// resource (addons/dialogic/Resources/character.gd) and character editor.

/**
 * The `@export` variables of a portrait scene's root script - what its
 * `export_overrides` can set. Empty if the scene or script can't be read.
 *
 * @param {string} scenePath - res:// .tscn path
 * @returns {Promise<Map<string, GdVariableInfo>>}
 */
async function readPortraitSceneExports(scenePath) {
  try {
    const sceneText = Buffer.from(await vscode.workspace.fs.readFile(project.resolveResourcePath(scenePath))).toString('utf8');
    const scriptPath = resources.extractSceneRootScriptPath(sceneText);
    if (!scriptPath || !scriptPath.endsWith('.gd')) { return new Map(); }
    const scriptText = Buffer.from(await vscode.workspace.fs.readFile(project.resolveResourcePath(scriptPath))).toString('utf8');
    const exports = new Map();
    for (const [name, info] of gdscript.parseGdScript(scriptText).variables) {
      if (info.isExported) { exports.set(name, info); }
    }
    return exports;
  } catch (error) {
    return new Map();
  }
}

/**
 * An `export_overrides` value for an `@export` variable, as Dialogic stores
 * it: a GDScript expression inside a string, e.g. `"true"`, `"1.0"`,
 * `"\"text\""`. Uses the variable's own default when it has one.
 *
 * @param {GdVariableInfo} info
 * @returns {string} the .dch literal
 */
function exportOverrideValue(info) {
  const quote = expression => `"${expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (info.defaultValue) { return quote(info.defaultValue); }
  const type = (info.type || '').trim();
  if (type === 'bool') { return quote('false'); }
  if (type === 'int') { return quote('0'); }
  if (type === 'float') { return quote('0.0'); }
  if (type === 'String' || type === 'StringName') { return quote('""'); }
  if (type === 'Color') { return quote('Color(1, 1, 1, 1)'); }
  if (type === 'Vector2') { return quote('Vector2(0, 0)'); }
  return '""';
}

/**
 * Moods (portrait names) a character is given in the project's timelines -
 * `join Name (mood)`, `update Name (mood)`, `Name (mood): text` - with where
 * they're used. Open timelines are read live, the others from disk.
 *
 * @param {string} characterName
 * @returns {Promise<Map<string, string[]>>} mood -> "timeline:line" places
 */
async function collectTimelineMoodUsage(characterName) {
  const usage = new Map();
  if (!state.projectRootUri) { return usage; }
  const pattern = new RegExp(`^\\s*(?:(?:join|update)\\s+)?(${syntax.CHARACTER_NAME_SOURCE})\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\)`, 'u');
  let uris = [];
  try { uris = await vscode.workspace.findFiles('**/*.dtl', '**/{.git,.godot,node_modules}/**'); } catch (error) { return usage; }
  for (const uri of uris) {
    const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === uri.fsPath);
    let text;
    try { text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch (error) { continue; }
    const name = uri.fsPath.replace(/\\/g, '/').split('/').pop();
    text.split(/\r?\n/).forEach((line, index) => {
      const match = line.match(pattern);
      if (!match || syntax.stripCharacterNameQuotes(match[1]) !== characterName) { return; }
      if (!usage.has(match[2])) { usage.set(match[2], []); }
      usage.get(match[2]).push(`${name}:${index + 1}`);
    });
  }
  return usage;
}

/**
 * Snippet of a whole new portrait, in the file's own key style (`&"key"`
 * or `"key"`), with the cursor on its image path.
 *
 * @param {string|null} name - null for a placeholder name to type
 * @param {string} keyPrefix - "&" or ""
 * @returns {vscode.SnippetString}
 */
function portraitSnippet(name, keyPrefix) {
  const k = key => `${keyPrefix}"${key}"`;
  const nameText = name === null ? '${1:NewPortrait}' : completionItems.escapeSnippetText(name);
  const image = name === null ? '2' : '1';
  return new vscode.SnippetString(
    `${keyPrefix}"${nameText}": {\n${k('export_overrides')}: {\n${k('image')}: "\\\\"res://\${${image}}\\\\""\n},\n`
    + `${k('mirror')}: false,\n${k('offset')}: Vector2(0, 0),\n${k('scale')}: 1.0,\n${k('scene')}: ""\n}`
  );
}

/**
 * The keys that make sense at a given .dch dictionary path, with their
 * docs: the character's own keys at the top, a portrait's keys inside
 * `portraits` > name, and the portrait scene's `@export` variables inside
 * `export_overrides` (plus `image`, for Dialogic's default portrait
 * scene). Nothing for levels whose keys are free (portrait names,
 * custom_info).
 *
 * @param {string[]} path
 * @param {string} text - the whole document, to find the portrait's scene
 * @returns {Promise<Record<string, {type: string, value: string, doc: string}>>}
 */
async function dchKeysForPath(path, text) {
  if (path.length === 0) { return dchKeys.DCH_CHARACTER_KEYS; }
  if (path.length === 2 && path[0] === 'portraits') { return dchKeys.DCH_PORTRAIT_KEYS; }
  if (path.length === 1 && path[0] === 'custom_info') { return dchKeys.DCH_CUSTOM_INFO_KEYS; }
  if (path.length === 3 && path[0] === 'custom_info' && path[1] === 'sound_moods') { return dchKeys.DCH_SOUND_MOOD_KEYS; }
  if (path.length === 3 && path[0] === 'portraits' && path[2] === 'export_overrides') {
    const keys = { 'image': { type: 'String', value: '"\\"res://\\""', doc: dchKeys.DCH_IMAGE_OVERRIDE_DOC } };
    const portrait = dchParse.parseDchPortraits(text).get(path[1]);
    if (portrait && portrait.scene) {
      for (const [name, info] of await readPortraitSceneExports(portrait.scene)) {
        keys[name] = { type: info.type || 'Variant', value: exportOverrideValue(info), doc: info.doc || `\`@export\` variable of \`${portrait.scene}\`'s root script.` };
      }
    }
    return keys;
  }
  return {};
}

/**
 * Completion items for a .dch document: keys for the current dictionary
 * level (see dchKeysForPath), and values for known keys - portrait names
 * for `default_portrait`, `.tscn` scenes for `scene`, images for the
 * `image` override, true/false, and ready-made Color()/Vector2() literals.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.CompletionItem[]>}
 */
async function provideDchCompletions(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const scan = dchParse.scanDch(text, offset);
  const top = scan.stack[scan.stack.length - 1];
  const line = document.lineAt(position.line).text;
  const closingQuote = line[position.character] === '"' ? 1 : 0;
  const items = [];
  const useStringNames = /&"/.test(text) || /^\s*(?:\{\s*\})?\s*$/.test(text);
  const keyPrefix = useStringNames ? '&' : '';

  // A new, empty .dch file (or an empty "{}"): offer a whole character.
  if (/^\s*(?:\{\s*\})?\s*$/.test(text)) {
    const k = key => `${keyPrefix}"${key}"`;
    const item = new vscode.CompletionItem({ label: 'Dialogic character', description: 'every key, with defaults' }, vscode.CompletionItemKind.Snippet);
    item.documentation = new vscode.MarkdownString('A complete character, as Dialogic writes it, with one portrait to fill in.');
    item.insertText = new vscode.SnippetString(
      `{\n${k('@path')}: "res://addons/dialogic/Resources/character.gd",\n${k('@subpath')}: NodePath(""),\n`
      + `${k('color')}: Color(1, 1, 1, 1),\n${k('custom_info')}: {},\n${k('default_portrait')}: "\${2:Default}",\n`
      + `${k('description')}: "\${3}",\n${k('display_name')}: "\${1:Name}",\n${k('mirror')}: false,\n${k('nicknames')}: [],\n`
      + `${k('offset')}: Vector2(0, 0),\n${k('portraits')}: {\n${keyPrefix}"\${2:Default}": {\n${k('export_overrides')}: {\n`
      + `${k('image')}: "\\\\"res://\${4}\\\\""\n},\n${k('mirror')}: false,\n${k('offset')}: Vector2(0, 0),\n${k('scale')}: 1.0,\n${k('scene')}: ""\n}\n},\n`
      + `${k('scale')}: 1.0\n}\n`
    );
    item.range = new vscode.Range(new vscode.Position(0, 0), document.positionAt(text.length));
    return [item];
  }
  if (!top) { return []; }
  const path = scan.stack.map(container => container.key).slice(1);

  if (scan.state === 'key' && top.kind === 'dict') {
    const keys = await dchKeysForPath(path, text);
    const bareTyped = scan.openString ? '' : (line.slice(0, position.character).match(/&?[A-Za-z_@]*$/) || [''])[0];
    const typedStart = scan.openString ? document.positionAt(scan.openString.start) : new vscode.Position(position.line, position.character - bareTyped.length);
    const range = new vscode.Range(typedStart, new vscode.Position(position.line, position.character + (scan.openString ? closingQuote : 0)));
    // VS Code filters on the typed text, so match its shape: `&"disp` or `"disp` vs a bare `disp`.
    const quotedFilter = !!scan.openString || bareTyped.startsWith('&');
    // Keys already set in this dictionary - before AND after the cursor. The
    // half-typed key is cut out first, so its open quote doesn't swallow the
    // rest of the file when scanning.
    const withoutTyped = text.slice(0, document.offsetAt(typedStart)) + text.slice(offset + (scan.openString ? closingQuote : 0));
    const samePath = tokenPath => tokenPath.length === path.length && tokenPath.every((segment, i) => segment === path[i]);
    const existingKeys = new Set([...top.keys, ...dchParse.scanDch(withoutTyped).keyTokens.filter(token => samePath(token.path)).map(token => token.name)]);
    top.keys = existingKeys;
    for (const [name, info] of Object.entries(keys)) {
      if (top.keys.has(name)) { continue; } // already set in this dictionary
      const item = new vscode.CompletionItem({ label: name, description: info.type }, vscode.CompletionItemKind.Property);
      item.documentation = new vscode.MarkdownString(info.doc);
      item.filterText = quotedFilter ? `${useStringNames ? '&' : ''}"${name}"` : name;
      item.insertText = new vscode.SnippetString(`${useStringNames ? '&' : ''}"${name}": \${1:${info.value.replace(/[$}\\]/g, '\\$&')}}`);
      item.range = range;
      item.sortText = name.startsWith('@') ? `2_${name}` : `1_${name}`;
      items.push(item);
    }
    // Inside `portraits`: the moods the timelines give this character but
    // this file doesn't define yet, as whole portraits - plus a blank one.
    if (path.length === 1 && path[0] === 'portraits') {
      const character = project.findCharacterForDocument(document);
      if (character) {
        for (const [mood, places] of await collectTimelineMoodUsage(character)) {
          if (top.keys.has(mood)) { continue; }
          const item = new vscode.CompletionItem({ label: mood, description: `used in ${places.length} timeline line(s)` }, vscode.CompletionItemKind.EnumMember);
          item.documentation = new vscode.MarkdownString(`\`(${mood})\` is used for **${character}** in timelines but has no portrait yet:\n\n${places.slice(0, 8).map(place => `- ${place}`).join('\n')}${places.length > 8 ? '\n- ...' : ''}`);
          item.filterText = quotedFilter ? `${keyPrefix}"${mood}"` : mood;
          item.insertText = portraitSnippet(mood, keyPrefix);
          item.range = range;
          item.sortText = `0_${mood}`;
          items.push(item);
        }
      }
      const item = new vscode.CompletionItem({ label: 'New portrait', description: 'image portrait' }, vscode.CompletionItemKind.Snippet);
      item.filterText = quotedFilter ? `${keyPrefix}"` : 'portrait';
      item.insertText = portraitSnippet(null, keyPrefix);
      item.range = range;
      item.sortText = '3_new';
      items.push(item);
    }
    // Inside `sound_moods`: a whole new sound mood.
    if (path.length === 2 && path[0] === 'custom_info' && path[1] === 'sound_moods') {
      const k = key => `${keyPrefix}"${key}"`;
      const item = new vscode.CompletionItem({ label: 'New sound mood', description: 'typing sounds' }, vscode.CompletionItemKind.Snippet);
      item.filterText = quotedFilter ? `${keyPrefix}"` : 'sound';
      item.insertText = new vscode.SnippetString(
        `${keyPrefix}"\${1:Mood}": {\n${k('mode')}: 0,\n${k('name')}: "\${1:Mood}",\n${k('pitch_base')}: 1.0,\n${k('pitch_variance')}: 0.0,\n`
        + `${k('skip_characters')}: 0,\n${k('sound_path')}: "res://\${2}",\n${k('volume_base')}: 0.0,\n${k('volume_variance')}: 0.0\n}`
      );
      item.range = range;
      items.push(item);
    }
    return items;
  }

  if (scan.state !== 'value' || !scan.pendingKey) { return []; }
  const key = scan.pendingKey;
  const valueStartPosition = scan.openString
    ? document.positionAt(scan.openString.start)
    : document.positionAt(scan.valueStart + (text.slice(scan.valueStart, offset).match(/^\s*/) || [''])[0].length);
  const range = new vscode.Range(valueStartPosition, new vscode.Position(position.line, position.character + (scan.openString ? closingQuote : 0)));
  const typed = scan.openString ? scan.openString.text : text.slice(document.offsetAt(valueStartPosition), offset);
  const addValue = (label, insert, detail, kind = vscode.CompletionItemKind.Value) => {
    const item = new vscode.CompletionItem(label, kind);
    item.insertText = insert;
    item.filterText = typeof insert === 'string' ? insert : label;
    item.detail = detail;
    item.range = range;
    items.push(item);
  };

  if (path.length === 0 && key === 'default_portrait') {
    for (const mood of dchParse.parseDchPortraits(text).keys()) { addValue(mood, `"${mood}"`, 'Portrait of this character', vscode.CompletionItemKind.EnumMember); }
  } else if ((key === 'sound_mood' && path.length === 2 && path[0] === 'portraits') || (key === 'sound_mood_default' && path.length === 1 && path[0] === 'custom_info')) {
    for (const mood of dchParse.parseDchSoundMoods(text)) { addValue(mood, `"${mood}"`, 'Sound mood of this character', vscode.CompletionItemKind.EnumMember); }
  } else if (key === 'mode' && path.length === 3 && path[1] === 'sound_moods') {
    for (const [value, name, doc] of dchKeys.DCH_SOUND_MODES) { addValue(`${value} - ${name}`, value, doc, vscode.CompletionItemKind.EnumMember); }
  } else if (key === 'sound_path' && path.length === 3 && path[1] === 'sound_moods') {
    const audioFiles = state.cachedResourcePaths.filter(resPath => events.RESOURCE_EXTENSIONS.audio.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()));
    const folders = [...new Set(audioFiles.map(resPath => resPath.slice(0, resPath.lastIndexOf('/'))))];
    for (const folder of folders) {
      if (folder.toLowerCase().startsWith(typed.toLowerCase())) { addValue(`${folder}/`, `"${folder}"`, 'Folder of sounds (picked at random)', vscode.CompletionItemKind.Folder); }
    }
    for (const resPath of audioFiles) {
      if (resPath.toLowerCase().startsWith(typed.toLowerCase())) { addValue(resPath, `"${resPath}"`, 'Sound file', vscode.CompletionItemKind.File); }
    }
  } else if (key === 'scene' && path.length === 2 && path[0] === 'portraits') {
    for (const resPath of state.cachedResourcePaths) {
      if (events.RESOURCE_EXTENSIONS.scene.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()) && resPath.toLowerCase().startsWith(typed.toLowerCase())) {
        addValue(resPath, `"${resPath}"`, 'Portrait scene', vscode.CompletionItemKind.File);
      }
    }
  } else if (key === 'image' && path.length === 3 && path[2] === 'export_overrides') {
    const typedPath = typed.replace(/^\\?"?/, '');
    for (const resPath of state.cachedResourcePaths) {
      if (events.RESOURCE_EXTENSIONS.image.includes(resPath.slice(resPath.lastIndexOf('.') + 1).toLowerCase()) && resPath.toLowerCase().startsWith(typedPath.toLowerCase())) {
        addValue(resPath, `"\\"${resPath}\\""`, 'Portrait image', vscode.CompletionItemKind.File);
      }
    }
  } else {
    const keyInfo = (await dchKeysForPath(path, text))[key];
    if (!keyInfo) { return []; }
    if (keyInfo.type === 'bool') {
      addValue('true', 'true', 'bool', vscode.CompletionItemKind.Keyword);
      addValue('false', 'false', 'bool', vscode.CompletionItemKind.Keyword);
    } else if (!scan.openString) {
      addValue(keyInfo.value, keyInfo.value, `${keyInfo.type} (default)`);
    }
  }
  return items;
}

/**
 * Hover for a .dch key: what it does (character, portrait and
 * export_overrides keys). Hovering a portrait's name inside `portraits`
 * shows that mood's documentation, same as hovering it in a timeline.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.Hover | undefined>}
 */
async function provideDchHover(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const token = dchParse.scanDch(text).keyTokens.find(candidate => offset >= candidate.start && offset <= candidate.end);
  if (!token) { return undefined; }
  const range = new vscode.Range(document.positionAt(token.start), document.positionAt(token.end));
  if (token.path.length === 1 && token.path[0] === 'portraits') {
    const character = project.findCharacterForDocument(document);
    const markdown = character ? timelineMoods.createMoodDocumentation(character, token.name) : null;
    return markdown ? new vscode.Hover(markdown, range) : undefined;
  }
  const info = (await dchKeysForPath(token.path, text))[token.name];
  if (!info) { return undefined; }
  const where = token.path.length === 0 ? 'character'
    : token.path[0] === 'custom_info' ? (token.path.length === 3 ? 'typing sound mood' : 'custom info')
    : token.path[2] === 'export_overrides' ? 'portrait scene override' : 'portrait';
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${token.name}**: \`${info.type}\` _(${where})_\n\n${info.doc}\n\n`);
  markdown.appendMarkdown(`[Dialogic documentation](${dchKeys.DIALOGIC_CHARACTER_DOCS_URL})`);
  return new vscode.Hover(markdown, range);
}

/**
 * Diagnostics for a .dch document: a `default_portrait` that isn't one of
 * its `portraits`, and a portrait `scene` that doesn't exist in the
 * project (only checked once the project's files are known).
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findDchDiagnostics(document) {
  const text = document.getText();
  const diagnostics = [];
  const portraits = dchParse.parseDchPortraits(text);
  const defaultMatch = text.match(/&?"default_portrait"\s*:\s*"([^"]*)"/);
  if (defaultMatch && defaultMatch[1] && portraits.size > 0 && !portraits.has(defaultMatch[1])) {
    const start = defaultMatch.index + defaultMatch[0].length - defaultMatch[1].length - 1;
    problems.pushDiagnostic(diagnostics, 'dchDefaultPortrait',
      new vscode.Range(document.positionAt(start), document.positionAt(start + defaultMatch[1].length)),
      `"${defaultMatch[1]}" is not one of this character's portraits (${[...portraits.keys()].join(', ')}).`);
  }
  if (state.projectRootUri && state.cachedResourcePaths.length > 0) {
    const scenePattern = /&?"scene"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = scenePattern.exec(text)) !== null) {
      if (state.cachedResourcePaths.includes(match[1])) { continue; }
      const start = match.index + match[0].length - match[1].length - 1;
      problems.pushDiagnostic(diagnostics, 'dchMissingScene',
        new vscode.Range(document.positionAt(start), document.positionAt(start + match[1].length)),
        `"${match[1]}" doesn't exist in this project.`);
    }
  }
  return diagnostics;
}

Object.assign(module.exports, {
  provideDchCompletions,
  provideDchHover,
  findDchDiagnostics,
});
