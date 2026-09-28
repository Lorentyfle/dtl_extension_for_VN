// -----------------------------------------------------------------------------
// The Translation View: a timeline, the characters or a glossary as an
// editable translation sheet, saved into the CSV files.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const project = require('../project');
const dchParse = require('../dch/parse');
const csvTranslations = require('./translations');
const glossaryFeature = require('../features/glossary');

// =============================================================================
// TRANSLATION VIEW
// =============================================================================
// An editor, opened next to a timeline, listing every translatable line as
// its original text plus an editable translation line - saving it (Ctrl+S)
// writes the translations into Dialogic's CSV. It isn't a file on disk: it
// lives in a virtual file system under the `dtl-translation:` scheme, whose
// readFile builds the text from the timeline and the CSV (buildTranslationView)
// and whose writeFile parses it back (parseTranslationView) and writes the
// changed translations (writeTranslations). Each block looks like:
//
//   [Text/greeting/text]  line 7 - TestCharacter
//   en: Hello! [b]Welcome[/b] to the room.
//   fr: Bonjour ! [b]Bienvenue[/b] dans la salle.
//
// The `[key]` header says which CSV row the block is; only the line of the
// language being translated is read back, the original one is a reference.

/** @type {string} */
const TRANSLATION_VIEW_SCHEME = 'dtl-translation';

/**
 * URI of the Translation View of a timeline in one or more languages. The
 * path is what the tab shows ("test_timeline (fr, ja).dtltr"); the query
 * carries the timeline's URI and the languages, so reading/writing needs
 * no other state - and the languages never depend on the settings.
 *
 * @param {vscode.Uri} timelineUri
 * @param {string[]} languages
 * @returns {vscode.Uri}
 */
function translationViewUri(target, languages) {
  // A plain Uri is a timeline (the original, and most common, source).
  const source = target instanceof Object && target.source ? target : { source: 'timeline', uri: target };
  const params = { source: source.source, languages: languages.join(',') };
  let name;
  if (source.source === 'characters') {
    name = 'Characters';
    if (source.focus) { params.focus = source.focus; }
  } else if (source.source === 'glossary') {
    name = `${source.file.split('/').pop().replace(/\.tres$/i, '')} glossary`;
    params.glossary = source.file;
  } else {
    name = source.uri.path.split('/').pop().replace(/\.dtl$/i, '');
    params.timeline = source.uri.toString();
  }
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return vscode.Uri.from({ scheme: TRANSLATION_VIEW_SCHEME, path: `/${name} (${languages.join(', ')}).dtltr`, query });
}

/**
 * @param {vscode.Uri} uri - a Translation View URI
 * @returns {{timelineUri: vscode.Uri, languages: string[]}}
 */
function parseTranslationViewUri(uri) {
  const params = {};
  for (const part of uri.query.split('&')) {
    const [name, value = ''] = part.split('=');
    params[name] = decodeURIComponent(value);
  }
  const languages = (params.languages || params.language || '').split(',').map(language => language.trim()).filter(Boolean);
  const source = params.source || 'timeline';
  return {
    source,
    timelineUri: source === 'timeline' && params.timeline ? vscode.Uri.parse(params.timeline) : null,
    glossary: params.glossary || null,
    focus: params.focus || null,
    languages,
  };
}

/**
 * The same view source, as translationViewUri expects it.
 *
 * @param {ReturnType<typeof parseTranslationViewUri>} parsed
 */
function translationViewTarget(parsed) {
  if (parsed.source === 'characters') { return { source: 'characters', focus: parsed.focus }; }
  if (parsed.source === 'glossary') { return { source: 'glossary', file: parsed.glossary }; }
  return { source: 'timeline', uri: parsed.timelineUri };
}

/**
 * What a Translation View lists, whatever its source: a title, notes for
 * the header, and one item per translatable text - its CSV key, original
 * text, and where it comes from.
 *
 * - timeline: every line with a translation id (see parseTranslatableLine);
 * - characters: every character's name and nicknames (keys
 *   Character/<id>/name and /nicknames, nicknames comma-separated), the
 *   focused character first;
 * - glossary: every entry's name, alternatives, text and extra (keys
 *   Glossary/<glossary id>/<entry id>/<property>) - the properties Dialogic
 *   exports to its CSV.
 *
 * @param {ReturnType<typeof parseTranslationViewUri>} parsed
 * @returns {Promise<{title: string, notes: string[], items: {key: string, original: string, header: string}[]}>}
 */
async function collectTranslationViewItems(parsed) {
  const idHint = '"Update CSV files" in Dialogic\'s translation settings adds them.';
  if (parsed.source === 'characters') {
    const names = [...state.cachedCharacterPaths.keys()].sort((a, b) => (a === parsed.focus ? -1 : b === parsed.focus ? 1 : 0));
    const items = [];
    let withoutId = 0;
    for (const name of names) {
      let info;
      try { info = dchParse.parseDchCharacterInfo(await project.readDocumentText(project.resolveResourcePath(state.cachedCharacterPaths.get(name)))); } catch (error) { continue; }
      if (!info.translationId) { withoutId++; continue; }
      items.push({ key: `Character/${info.translationId}/name`, original: info.displayName || name, header: `${name} - name` });
      if (info.nicknames.length > 0) { items.push({ key: `Character/${info.translationId}/nicknames`, original: info.nicknames.join(', '), header: `${name} - nicknames (comma-separated)` }); }
    }
    return { title: 'the characters', notes: withoutId > 0 ? [`${withoutId} character(s) have no translation id yet - ${idHint}`] : [], items };
  }
  if (parsed.source === 'glossary') {
    let entries = [];
    try { entries = glossaryFeature.parseGlossaryResource(await project.readDocumentText(project.resolveResourcePath(parsed.glossary)), parsed.glossary); } catch (error) { entries = []; }
    const items = [];
    let withoutId = 0;
    for (const entry of entries) {
      if (!entry.glossaryId || !entry.entryId) { withoutId++; continue; }
      const base = `Glossary/${entry.glossaryId}/${entry.entryId}`;
      const properties = [['name', entry.name], ['alternatives', entry.alternatives.join(', ')], ['text', entry.text], ['extra', entry.extra]];
      for (const [property, original] of properties) {
        if (original) { items.push({ key: `${base}/${property}`, original, header: `${entry.name} - ${property}${property === 'alternatives' ? ' (comma-separated)' : ''}` }); }
      }
    }
    return { title: `the glossary ${parsed.glossary}`, notes: withoutId > 0 ? [`${withoutId} entr(ies) have no translation id yet - ${idHint}`] : [], items };
  }
  const timelineText = await readTimelineText(parsed.timelineUri);
  const withoutId = timelineText.split(/\r?\n/).filter(text => syntax.isPlayerFacingTextLine(text) && !/#id:\S+\s*$/.test(text)).length;
  return {
    title: parsed.timelineUri.path.split('/').pop(),
    notes: withoutId > 0 ? [`${withoutId} line(s) of the timeline have no translation id yet - ${idHint}`] : [],
    items: collectTranslatableLines(timelineText).map(({ line, text, entry }) => ({ key: entry.key, original: entry.original, header: `line ${line + 1} - ${describeTranslatableLine(text, entry.key)}` })),
  };
}

/**
 * A timeline's current text: from its editor if it's open (so unsaved
 * edits are included), else from disk.
 *
 * @param {vscode.Uri} timelineUri
 * @returns {Promise<string>}
 */
async function readTimelineText(timelineUri) {
  const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === timelineUri.toString());
  if (open) { return open.getText(); }
  return Buffer.from(await vscode.workspace.fs.readFile(timelineUri)).toString('utf8');
}

/**
 * Who/what a translatable line is, for the block header: the speaker of a
 * dialogue line, "narration", "choice", "label ...", "text input".
 *
 * @param {string} text - the timeline line
 * @param {string} key
 * @returns {string}
 */
function describeTranslatableLine(text, key) {
  if (key.startsWith('Choice/')) { return 'choice'; }
  if (key.startsWith('Label/')) { const label = syntax.parseLabelLine(text); return label ? `label ${label.name}` : 'label'; }
  if (key.startsWith('Text Input/')) { return 'text input'; }
  const speakerMatch = text.match(new RegExp(`^\\s*(${syntax.CHARACTER_NAME_SOURCE})\\s*(?:\\([^)]*\\))?\\s*:`, 'u'));
  return speakerMatch ? syntax.stripCharacterNameQuotes(speakerMatch[1]) : 'narration';
}

/** Line breaks inside a translation are shown as a literal "\n", so each translation stays on one line. */
const escapeViewText = text => text.replace(/\r?\n/g, '\\n');

const unescapeViewText = text => text.replace(/\\n/g, '\n');

/**
 * The translatable lines of a timeline, in order.
 *
 * @param {string} timelineText
 * @returns {{line: number, text: string, entry: {key: string, original: string}}[]}
 */
function collectTranslatableLines(timelineText) {
  const result = [];
  timelineText.split(/\r?\n/).forEach((text, line) => {
    const entry = csvTranslations.parseTranslatableLine(text);
    if (entry) { result.push({ line, text, entry }); }
  });
  return result;
}

/**
 * Build the Translation View text of a timeline in one or more languages:
 * per translatable line, its original text then one line per language.
 *
 * @param {vscode.Uri} timelineUri
 * @param {string[]} languages
 * @returns {Promise<string>}
 */
async function buildTranslationView(parsed) {
  const { languages } = parsed;
  const { title, notes, items } = await collectTranslationViewItems(parsed);
  const original = csvTranslations.getOriginalLocale() || 'original';
  const progress = languages.map(language => `${language} ${items.filter(item => csvTranslations.getTranslation(item.key, language)).length}/${items.length}`).join(', ');
  const lines = [
    `# Translation of ${title} - ${progress} translated.`,
    `# Write the translations after ${languages.map(language => `"${language}:"`).join(', ')} and save (Ctrl+S) to put them in Dialogic's CSV.`,
    `# The "${original}:" lines are the original text, for reference: editing them changes nothing. Unchanged lines are never rewritten.`,
    '# To show other languages, use the globe button at the top right of this editor.',
  ];
  for (const note of notes) { lines.push(`# ${note}`); }
  if (state.cachedTranslationFiles.length === 0) {
    lines.push('# No Dialogic translation CSV found yet - saving will fail until "Update CSV files" has been run in Dialogic.');
  }
  for (const item of items) {
    lines.push('');
    lines.push(`[${item.key}]  ${item.header}`);
    lines.push(`${original}: ${escapeViewText(item.original)}`);
    for (const language of languages) {
      lines.push(`${language}: ${escapeViewText(csvTranslations.getTranslation(item.key, language))}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Read the translations back from a Translation View's text: for each
 * `[key]` block, the text after each "<language>:" (the first one per
 * language counts). A block or a language line deleted by accident is
 * simply left out, so nothing is erased.
 *
 * @param {string} text
 * @param {string[]} languages
 * @returns {Map<string, Map<string, string>>} key -> language -> translation
 */
function parseTranslationView(text, languages) {
  const translations = new Map();
  let currentKey = null;
  for (const line of text.split(/\r?\n/)) {
    const headerMatch = line.match(/^\[([^\]]+)\]/);
    if (headerMatch) {
      currentKey = headerMatch[1];
      continue;
    }
    if (!currentKey) { continue; }
    const language = languages.find(candidate => line.startsWith(`${candidate}:`));
    if (!language) { continue; }
    const byLanguage = translations.get(currentKey) || new Map();
    if (!byLanguage.has(language)) {
      byLanguage.set(language, unescapeViewText(line.slice(language.length + 1).replace(/^ /, '').replace(/\s+$/, '')));
    }
    translations.set(currentKey, byLanguage);
  }
  return translations;
}

/**
 * The virtual file system behind Translation Views. Only the files VS
 * Code opens exist (there are no directories); reading builds the text,
 * writing saves the translations that changed.
 */
class TranslationViewFileSystem {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    /** @type {vscode.Event<vscode.FileChangeEvent[]>} */
    this.onDidChangeFile = this._emitter.event;
    /** Per view URI, when its content last changed - VS Code compares it to detect outside changes. @type {Map<string, number>} */
    this._mtimes = new Map();
    this._suppressRefresh = false;
  }

  watch() { return new vscode.Disposable(() => {}); }

  async stat(uri) {
    const content = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: this._mtimes.get(uri.toString()) || 1, size: content.byteLength };
  }

  async readFile(uri) {
    try {
      return Buffer.from(await buildTranslationView(parseTranslationViewUri(uri)), 'utf8');
    } catch (error) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async writeFile(uri, content) {
    const parsed = parseTranslationViewUri(uri);
    const written = parseTranslationView(Buffer.from(content).toString('utf8'), parsed.languages);
    const changes = [];
    for (const item of (await collectTranslationViewItems(parsed)).items) {
      const byLanguage = written.get(item.key);
      if (!byLanguage) { continue; }
      for (const [language, translation] of byLanguage) {
        if (translation !== csvTranslations.getTranslation(item.key, language)) {
          changes.push({ key: item.key, original: item.original, translation, language });
        }
      }
    }
    this._suppressRefresh = true;
    try {
      const count = await csvTranslations.writeTranslations(changes, null, parsed.timelineUri || vscode.Uri.file(''));
      this._mtimes.set(uri.toString(), Date.now());
      const touched = [...new Set(changes.map(change => change.language))].join(', ');
      vscode.window.setStatusBarMessage(count > 0 ? `DTL Reader: ${count} translation(s) saved (${touched})` : 'DTL Reader: no translation changed', 4000);
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(`DTL Reader: ${error.message}`);
    } finally {
      this._suppressRefresh = false;
    }
  }

  /**
   * Tell VS Code every open Translation View (optionally only those of one
   * timeline) changed, so the ones without unsaved edits reload.
   *
   * @param {vscode.Uri} [timelineUri]
   */
  refresh(timelineUri) {
    if (this._suppressRefresh) { return; }
    const events = [];
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== TRANSLATION_VIEW_SCHEME) { continue; }
      const viewTimeline = parseTranslationViewUri(document.uri).timelineUri;
      if (timelineUri && (!viewTimeline || viewTimeline.toString() !== timelineUri.toString())) { continue; }
      this._mtimes.set(document.uri.toString(), Date.now());
      events.push({ type: vscode.FileChangeType.Changed, uri: document.uri });
    }
    if (events.length > 0) { this._emitter.fire(events); }
  }

  readDirectory() { return []; }
  createDirectory() { throw vscode.FileSystemError.NoPermissions('Translation Views have no directories.'); }
  delete() { throw vscode.FileSystemError.NoPermissions('Close the Translation View instead.'); }
  rename() { throw vscode.FileSystemError.NoPermissions('Translation Views cannot be renamed.'); }
}

/**
 * Whether the translation globe button shows for a file
 * (`dtlReader.translation.globeButton`): "everywhere", "off", or
 * "dialogic" - only files with something to translate: timelines,
 * characters, the glossaries listed in project.godot and Dialogic's
 * translation CSVs. Never without a project.godot: translation works on
 * the project's CSV files.
 *
 * @param {vscode.TextEditor | undefined} editor
 * @returns {boolean}
 */
function shouldShowTranslationGlobe(editor) {
  const mode = vscode.workspace.getConfiguration('dtlReader').get('translation.globeButton', 'dialogic');
  if (mode === 'off' || !editor || !state.projectRootUri) { return false; } // no project, no translation
  if (mode === 'everywhere') { return true; }
  const document = editor.document;
  if (document.uri.scheme === TRANSLATION_VIEW_SCHEME) { return false; } // it has its own globe
  if (document.languageId === 'dtl' || document.languageId === 'dch') { return true; }
  const fileName = (document.uri.fsPath || '').replace(/\\/g, '/').split('/').pop() || '';
  if (/^dialogic_.*\.csv$/i.test(fileName)) { return true; }
  if (/\.tres$/i.test(fileName)) {
    const resPath = project.toResPath(document.uri);
    return !!resPath && state.cachedGlossaryFiles.some(file => file.toLowerCase() === resPath.toLowerCase());
  }
  return false;
}

/** Tell VS Code (context key `dtlReader.showTranslationGlobe`) whether to show the globe for the active editor. */
function updateTranslationGlobeContext() {
  vscode.commands.executeCommand('setContext', 'dtlReader.showTranslationGlobe', shouldShowTranslationGlobe(vscode.window.activeTextEditor));
}

/**
 * Ask which languages to show in a Translation View: every locale of the
 * CSVs (except the original), several at once, plus "Other language..." to
 * start a new one. Pre-selects the last choice (or the translation mode
 * language). Doesn't touch any setting.
 *
 * @param {string[]} [current] - languages to pre-select
 * @returns {Promise<string[] | null>} null if cancelled
 */
async function pickTranslationViewLanguages(current) {
  const original = csvTranslations.getOriginalLocale();
  const csvTargets = state.cachedTranslationLocales.filter(locale => locale && locale !== original);
  // Pre-select only languages of this project: the view's own, the last
  // ones picked in this workspace, else the translation-mode language -
  // but that setting may come from another project (User settings), so it
  // only counts if this project's CSV actually has it.
  const settingLanguage = csvTranslations.getTranslationLanguage();
  const remembered = current
    || (state.translationViewMemento && state.translationViewMemento.get('translationView.languages'))
    || (settingLanguage && csvTargets.includes(settingLanguage) ? [settingLanguage] : []);
  const locales = [...new Set([...csvTargets, ...remembered])].filter(locale => locale && locale !== original);
  const items = locales.map(locale => ({ label: locale, picked: remembered.includes(locale) }));
  items.push({ label: '$(add) Other language...', description: 'a locale code not in the CSV yet, e.g. de or pt_BR', other: true });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'DTL: Translation View languages',
    placeHolder: locales.length === 0
      ? `This project's translations only have the original language${original ? ` ("${original}")` : ''} - pick "Other language..." to add one`
      : `Pick the languages to show${original ? ` (the timelines are written in "${original}")` : ''} - each gets an editable line under every original line`,
  });
  if (!picked) { return null; }
  const languages = picked.filter(item => !item.other).map(item => item.label);
  if (picked.some(item => item.other)) {
    const typed = (await vscode.window.showInputBox({ title: 'DTL: Other language', prompt: 'Locale code(s), comma-separated (e.g. de, pt_BR)' }) || '').split(',').map(code => code.trim()).filter(Boolean);
    languages.push(...typed.filter(code => !languages.includes(code)));
  }
  const valid = languages.filter(language => language !== csvTranslations.getOriginalLocale());
  if (valid.length === 0) {
    vscode.window.showInformationMessage('DTL Reader: pick at least one language to translate to.');
    return null;
  }
  if (state.translationViewMemento) { await state.translationViewMemento.update('translationView.languages', valid); }
  return valid;
}

/**
 * Which Translation View source the active file points to: its timeline,
 * the characters (from a .dch file, that character first), its glossary
 * (from a glossary .tres listed in project.godot) - else ask.
 *
 * @returns {Promise<object | null>}
 */
async function pickTranslationViewSource() {
  const editor = vscode.window.activeTextEditor;
  const document = editor && editor.document;
  if (document && document.languageId === 'dtl' && document.uri.scheme !== TRANSLATION_VIEW_SCHEME) {
    return { source: 'timeline', uri: document.uri };
  }
  if (document && document.languageId === 'dch') {
    return { source: 'characters', focus: project.findCharacterForDocument(document) };
  }
  const resPath = document ? project.toResPath(document.uri) : null;
  if (resPath && state.cachedGlossaryFiles.some(file => file.toLowerCase() === resPath.toLowerCase())) {
    return { source: 'glossary', file: state.cachedGlossaryFiles.find(file => file.toLowerCase() === resPath.toLowerCase()) };
  }
  const items = [
    { label: 'Characters and glossaries', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(person) Characters', description: 'every character\'s name and nicknames', target: { source: 'characters' } },
  ];
  for (const file of state.cachedGlossaryFiles) { items.push({ label: `$(book) ${file.split('/').pop()}`, description: `glossary - ${file}`, target: { source: 'glossary', file } }); }
  let timelineUris = [];
  try { timelineUris = (await vscode.workspace.findFiles('**/*.dtl', '**/{.git,.godot,node_modules}/**')).filter(uri => /\.dtl$/i.test(uri.fsPath)); } catch (error) { timelineUris = []; }
  if (timelineUris.length > 0) {
    items.push({ label: 'Timelines', kind: vscode.QuickPickItemKind.Separator });
    timelineUris
      .map(uri => ({ uri, resPath: project.toResPath(uri) || uri.fsPath }))
      .sort((a, b) => a.resPath.localeCompare(b.resPath))
      .forEach(({ uri, resPath }) => items.push({ label: `$(file) ${uri.fsPath.replace(/\\/g, '/').split('/').pop().replace(/\.dtl$/i, '')}`, description: resPath, target: { source: 'timeline', uri } }));
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'DTL: What to translate', placeHolder: 'The characters, a glossary or a timeline', matchOnDescription: true });
  return picked && picked.target ? picked.target : null;
}

/**
 * "DTL: Open Translation View" - asks which languages to show (see
 * pickTranslationViewLanguages) and opens the Translation View of the
 * active timeline, of the characters (from a .dch file) or of a glossary
 * (from its .tres file) - or asks which one - beside the current editor.
 */
async function openTranslationViewCommand() {
  if (csvTranslations.translationUnavailable()) { return; }
  const target = await pickTranslationViewSource();
  if (!target) { return; }
  const languages = await pickTranslationViewLanguages();
  if (!languages) { return; }
  const document = await vscode.workspace.openTextDocument(translationViewUri(target, languages));
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

/**
 * "DTL: Change Translation View Languages" - from a Translation View, pick
 * other languages and replace it with a view of the same timeline in
 * those languages, in the same place. The old tab is closed unless it has
 * unsaved edits (then both stay open, so nothing is lost).
 */
async function changeTranslationViewLanguagesCommand() {
  if (csvTranslations.translationUnavailable()) { return; }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== TRANSLATION_VIEW_SCHEME) { return; }
  const oldDocument = editor.document;
  const parsed = parseTranslationViewUri(oldDocument.uri);
  const languages = await pickTranslationViewLanguages(parsed.languages);
  if (!languages) { return; }
  const document = await vscode.workspace.openTextDocument(translationViewUri(translationViewTarget(parsed), languages));
  await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preview: false });
  if (!oldDocument.isDirty && vscode.window.tabGroups) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input && tab.input.uri && tab.input.uri.toString() === oldDocument.uri.toString()) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }
}

/** Set while one editor scrolls the other, so the other's own move doesn't bounce back. */
let syncingTranslationScroll = false;

/**
 * Keep a timeline and its Translation View on the same line: moving the
 * cursor in one scrolls the other to the matching block / line.
 *
 * @param {vscode.TextEditorSelectionChangeEvent} event
 */
function syncTranslationScroll(event) {
  if (syncingTranslationScroll) { return; }
  const editor = event.textEditor;
  const document = editor.document;
  const cursorLine = editor.selection.active.line;
  let key = null;
  let targets = [];
  let findLine = null;

  if (document.languageId === 'dtl' && document.uri.scheme !== TRANSLATION_VIEW_SCHEME) {
    const entry = csvTranslations.parseTranslatableLine(document.lineAt(cursorLine).text);
    if (!entry) { return; }
    key = entry.key;
    targets = vscode.window.visibleTextEditors.filter(other => {
      if (other.document.uri.scheme !== TRANSLATION_VIEW_SCHEME) { return false; }
      const viewTimeline = parseTranslationViewUri(other.document.uri).timelineUri;
      return !!viewTimeline && viewTimeline.toString() === document.uri.toString();
    });
    findLine = other => {
      for (let line = 0; line < other.document.lineCount; line++) {
        if (other.document.lineAt(line).text.startsWith(`[${key}]`)) { return line; }
      }
      return -1;
    };
  } else if (document.uri.scheme === TRANSLATION_VIEW_SCHEME) {
    for (let line = cursorLine; line >= 0 && !key; line--) {
      const headerMatch = document.lineAt(line).text.match(/^\[([^\]]+)\]/);
      if (headerMatch) { key = headerMatch[1]; }
    }
    if (!key) { return; }
    const viewTimeline = parseTranslationViewUri(document.uri).timelineUri;
    if (!viewTimeline) { return; } // character / glossary views have no single file to follow
    const timelineUri = viewTimeline.toString();
    targets = vscode.window.visibleTextEditors.filter(other => other.document.uri.toString() === timelineUri);
    findLine = other => {
      for (let line = 0; line < other.document.lineCount; line++) {
        const entry = csvTranslations.parseTranslatableLine(other.document.lineAt(line).text);
        if (entry && entry.key === key) { return line; }
      }
      return -1;
    };
  } else {
    return;
  }

  syncingTranslationScroll = true;
  try {
    for (const other of targets) {
      const line = findLine(other);
      if (line !== -1) { other.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport); }
    }
  } finally {
    setTimeout(() => { syncingTranslationScroll = false; }, 50);
  }
}

Object.assign(module.exports, {
  TRANSLATION_VIEW_SCHEME,
  translationViewUri,
  TranslationViewFileSystem,
  updateTranslationGlobeContext,
  openTranslationViewCommand,
  changeTranslationViewLanguagesCommand,
  syncTranslationScroll,
});
