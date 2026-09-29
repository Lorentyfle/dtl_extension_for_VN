// -----------------------------------------------------------------------------
// Translations: Dialogic's CSV files, translation mode, hovers and
// commands.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const project = require('../project');
const problems = require('../diagnostics/index');

// =============================================================================
// TRANSLATIONS
// =============================================================================
// Dialogic translates timelines through CSV files it generates ("Update CSV
// files" in its Translation settings): first column `keys`, then one column
// per locale. A key is `<event name>/<translation id>/<property>`, where the
// id is the `#id:...` Dialogic appends to each translatable line, e.g.
// `Text/greeting/text` for `Laripo: Hello! #id:greeting`. The CSVs are named
// `dialogic_timeline_translations.csv` (one per project) or
// `dialogic_<timeline>_translation.csv` (one per timeline).
//
// With `dtlReader.translation.language` set (e.g. "fr"), each translatable
// line shows its translation right after it, missing ones can be reported,
// and "DTL: Translate line" writes a translation back into the CSV - so a
// translator can work in the timeline itself, next to the original text.

/** Translation key -> locale -> text, from every Dialogic translation CSV. @type {Map<string, Map<string, string>>} */
let cachedTranslations = new Map();

/** Translation key -> the CSV file it's in. @type {Map<string, vscode.Uri>} */
let cachedTranslationFileOfKey = new Map();

/**
 * The first locale column of the translation CSVs. Dialogic always writes
 * the original language there (`keys,en,...`), so it's the fallback when
 * project.godot doesn't set `translation/original_locale` (Godot leaves a
 * setting out of project.godot while it has its default value).
 *
 * @type {string|null}
 */
let cachedCsvOriginalLocale = null;

/**
 * The language the timelines are written in: project.godot's setting, else
 * the CSVs' first locale column (see cachedCsvOriginalLocale).
 *
 * @returns {string | null}
 */
function getOriginalLocale() {
  return state.translationOriginalLocale || cachedCsvOriginalLocale || null;
}

/**
 * Parse CSV text (RFC 4180 style, as Godot and Dialogic write it: fields
 * quoted when they contain a comma, quote or line break, quotes doubled).
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') { i++; }
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Write rows back as CSV, quoting only the fields that need it.
 *
 * @param {string[][]} rows
 * @param {string} eol
 * @returns {string}
 */
function serializeCsv(rows, eol) {
  const quote = field => /[",\r\n]/.test(field) || /^\s|\s$/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
  return rows.map(row => row.map(quote).join(',')).join(eol) + eol;
}

/**
 * Re-read every Dialogic translation CSV of the project.
 */
async function refreshTranslations() {
  const translations = new Map();
  const fileOfKey = new Map();
  const locales = new Set();
  const files = [];
  let firstLocale = null;
  if (state.projectRootUri) {
    try {
      const uris = await vscode.workspace.findFiles('**/dialogic_*.csv', '**/{.git,.godot,node_modules}/**');
      for (const uri of uris) {
        const rows = parseCsv(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
        if (rows.length === 0 || rows[0][0] !== 'keys') { continue; } // not a translation CSV
        files.push(uri);
        const header = rows[0];
        if (!firstLocale && header[1]) { firstLocale = header[1]; }
        header.slice(1).forEach(locale => { if (locale) { locales.add(locale); } });
        for (const row of rows.slice(1)) {
          const key = row[0];
          if (!key) { continue; }
          const byLocale = translations.get(key) || new Map();
          header.forEach((locale, column) => { if (column > 0 && locale && row[column]) { byLocale.set(locale, row[column]); } });
          translations.set(key, byLocale);
          if (!fileOfKey.has(key)) { fileOfKey.set(key, uri); }
        }
      }
    } catch (error) {
      console.error('DTL Reader: could not read the Dialogic translation CSV files', error);
    }
  }
  cachedTranslations = translations;
  cachedTranslationFileOfKey = fileOfKey;
  state.cachedTranslationLocales = [...locales];
  state.cachedTranslationFiles = files;
  cachedCsvOriginalLocale = firstLocale;
  state.translationsVersion++;
  updateAllTranslationDecorations();
  if (state.translationViewFileSystem) { state.translationViewFileSystem.refresh(); }
}

/**
 * The language being translated to (`dtlReader.translation.language`), or
 * null when translation mode is off.
 *
 * @returns {string | null}
 */
function getTranslationLanguage() {
  if (!state.projectRootUri) { return null; } // translations live in the project's CSVs
  const language = vscode.workspace.getConfiguration('dtlReader').get('translation.language', '');
  return language ? language.trim() : null;
}

/**
 * If `text` is a translatable line with a translation id, which CSV key it
 * uses and its original text: a dialogue/narration line
 * (`Text/<id>/text`), a choice (`Choice/<id>/text`), a label's display
 * name (`Label/<id>/display_name`) or a text input's prompt
 * (`Text Input/<id>/text`).
 *
 * @param {string} text - one line
 * @returns {{key: string, original: string, idStart: number, idEnd: number} | null}
 */
function parseTranslatableLine(text) {
  const idMatch = text.match(/#id:(\S+)\s*$/);
  if (!idMatch) { return null; }
  const id = idMatch[1];
  const idStart = idMatch.index;
  const idEnd = idStart + idMatch[0].trimEnd().length;
  const body = text.slice(0, idStart).replace(/\s+$/, '');
  const trimmed = body.trim();
  if (trimmed === '') { return null; }
  const entry = (key, original) => ({ key, original, idStart, idEnd });

  const label = syntax.parseLabelLine(text);
  if (label) { return label.displayName ? entry(`Label/${id}/display_name`, label.displayName) : null; }
  if (/^-\s/.test(trimmed)) { return entry(`Choice/${id}/text`, trimmed.slice(1).split('|')[0].trim()); }
  const textInputMatch = trimmed.match(/^\[text_input\b[^\]]*?\btext="([^"]*)"/);
  if (textInputMatch) { return entry(`Text Input/${id}/text`, textInputMatch[1]); }
  if (!syntax.isPlayerFacingTextLine(body)) { return null; }
  const speakerMatch = body.match(new RegExp(`^\\s*${syntax.CHARACTER_NAME_SOURCE}\\s*(?:\\([^)]*\\))?\\s*:\\s*`, 'u'));
  return entry(`Text/${id}/text`, speakerMatch ? body.slice(speakerMatch[0].length).trim() : trimmed);
}

/**
 * @param {string} key
 * @param {string} locale
 * @returns {string} empty if not translated
 */
function getTranslation(key, locale) {
  const byLocale = cachedTranslations.get(key);
  return (byLocale && byLocale.get(locale)) || '';
}

/**
 * Show each translatable line's translation in the current language right
 * after the line, in the editor (or "not translated" when missing).
 *
 * @param {vscode.TextEditor} editor
 */
function updateTranslationDecorations(editor) {
  if (!state.translationDecorationType || !editor || editor.document.languageId !== 'dtl') { return; }
  const language = getTranslationLanguage();
  const showInline = vscode.workspace.getConfiguration('dtlReader').get('translation.showInline', true);
  if (!language || !showInline) {
    editor.setDecorations(state.translationDecorationType, []);
    return;
  }
  const decorations = [];
  const document = editor.document;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const entry = parseTranslatableLine(text);
    if (!entry) { continue; }
    const translation = getTranslation(entry.key, language);
    decorations.push({
      range: new vscode.Range(line, text.length, line, text.length),
      renderOptions: {
        after: {
          contentText: translation ? `   ${language}: ${translation}` : `   ${language}: not translated yet`,
          color: new vscode.ThemeColor(translation ? 'editorCodeLens.foreground' : 'editorWarning.foreground'),
          fontStyle: 'italic',
        },
      },
    });
  }
  editor.setDecorations(state.translationDecorationType, decorations);
}

/**
 * Show the translations at the end of the lines in every visible editor
 * (see updateTranslationDecorations).
 */
function updateAllTranslationDecorations() {
  if (!state.translationDecorationType) { return; }
  vscode.window.visibleTextEditors.forEach(updateTranslationDecorations);
}

/**
 * Report translatable lines that have no translation in the current
 * language yet (`dtlReader.diagnostics.missingTranslation`, a Hint by
 * default). Only while a translation language is set and translation CSVs
 * exist.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function findMissingTranslationDiagnostics(document) {
  const language = getTranslationLanguage();
  if (!language || state.cachedTranslationFiles.length === 0) { return []; }
  const diagnostics = [];
  for (let line = 0; line < document.lineCount; line++) {
    const entry = parseTranslatableLine(document.lineAt(line).text);
    if (!entry || getTranslation(entry.key, language)) { continue; }
    problems.pushDiagnostic(diagnostics, 'missingTranslation',
      new vscode.Range(line, entry.idStart, line, entry.idEnd),
      `Not translated to "${language}" yet - use the quick fix or "DTL: Translate Line".`);
  }
  return diagnostics;
}

/**
 * Hover on a line's `#id:...`: its translation key and the text in every
 * language of the CSVs, the original first.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.Hover | undefined}
 */
function provideTranslationHover(document, position) {
  if (!state.projectRootUri) { return undefined; }
  const entry = parseTranslatableLine(document.lineAt(position.line).text);
  if (!entry || position.character < entry.idStart || position.character > entry.idEnd) { return undefined; }
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**Translation** \`${entry.key}\`\n\n`);
  const escape = text => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const locales = [...state.cachedTranslationLocales].sort((a, b) => (a === getOriginalLocale() ? -1 : b === getOriginalLocale() ? 1 : 0));
  if (locales.length === 0) {
    markdown.appendMarkdown(state.cachedTranslationFiles.length === 0
      ? '_No Dialogic translation CSV found. Enable translation in Dialogic\'s settings and click "Update CSV files"._'
      : '_This line is not in the translation CSVs yet - "Update CSV files" in Dialogic adds it._');
    return new vscode.Hover(markdown);
  }
  markdown.appendMarkdown('| Locale | Text |\n|---|---|\n');
  for (const locale of locales) {
    const text = locale === getOriginalLocale() && !getTranslation(entry.key, locale) ? entry.original : getTranslation(entry.key, locale);
    markdown.appendMarkdown(`| ${locale}${locale === getOriginalLocale() ? ' (original)' : ''} | ${text ? escape(text) : '_not translated_'} |\n`);
  }
  return new vscode.Hover(markdown, new vscode.Range(position.line, entry.idStart, position.line, entry.idEnd));
}

/**
 * Translation works on the Godot project's CSV files, so without a
 * project.godot it's off. Returns true (after telling the person why)
 * when there's no project.
 *
 * @returns {boolean}
 */
function translationUnavailable() {
  if (state.projectRootUri) { return false; }
  vscode.window.showInformationMessage('DTL Reader: translating needs the Godot project - open the folder containing project.godot (with Dialogic\'s translation enabled).');
  return true;
}

/**
 * Pick the language to translate to, among the CSVs' locale columns (or a
 * new one), and save it as `dtlReader.translation.language`.
 *
 * @returns {Promise<string | null>} the chosen locale, or null if cancelled / turned off
 */
async function selectTranslationLanguage() {
  if (translationUnavailable()) { return null; }
  const current = getTranslationLanguage();
  const items = state.cachedTranslationLocales
    .filter(locale => locale !== getOriginalLocale())
    .map(locale => ({ label: locale, description: locale === current ? 'current' : '' }));
  items.push({ label: '$(add) Other language...', description: 'type a locale code, e.g. fr or pt_BR', other: true });
  if (current) { items.push({ label: '$(close) Turn translation mode off', off: true }); }
  const picked = await vscode.window.showQuickPick(items, { title: 'DTL: Translation language', placeHolder: getOriginalLocale() ? `Timelines are written in "${getOriginalLocale()}"` : 'Language to translate the timelines to' });
  if (!picked) { return null; }
  let language = picked.off ? '' : picked.label;
  if (picked.other) {
    language = (await vscode.window.showInputBox({ title: 'DTL: Translation language', prompt: 'Locale code, as used by Godot and the CSV column (e.g. fr, ja, pt_BR)' }) || '').trim();
    if (!language) { return null; }
  }
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('dtlReader').update('translation.language', language, target);
  return language || null;
}

/**
 * The CSV a new translation of `key` should go to: the one that already
 * has the key, else this timeline's own CSV (per-timeline mode), else the
 * project's timeline CSV (per-project mode).
 *
 * @param {string} key
 * @param {vscode.TextDocument} document
 * @returns {vscode.Uri | null}
 */
function findTranslationFileFor(key, document) {
  if (cachedTranslationFileOfKey.has(key)) { return cachedTranslationFileOfKey.get(key); }
  const byName = name => state.cachedTranslationFiles.find(uri => uri.fsPath.replace(/\\/g, '/').split('/').pop().toLowerCase() === name.toLowerCase());
  // Characters: Dialogic keeps them in one project-wide CSV.
  if (key.startsWith('Character/')) { return byName('dialogic_character_translations.csv') || null; }
  // Glossaries: the CSV that already has this glossary's keys, else the project-wide one.
  if (key.startsWith('Glossary/')) {
    const prefix = key.split('/').slice(0, 2).join('/') + '/';
    for (const [existingKey, uri] of cachedTranslationFileOfKey) { if (existingKey.startsWith(prefix)) { return uri; } }
    return byName('dialogic_glossary_translations.csv') || null;
  }
  const timelineName = ((document && document.uri && document.uri.fsPath) || '').replace(/\\/g, '/').split('/').pop().replace(/\.dtl$/i, '');
  return byName(`dialogic_${timelineName}_translation.csv`) || byName('dialogic_timeline_translations.csv') || null;
}

/**
 * Write a batch of translations into Dialogic's CSV files, one read and
 * one write per file: each translation goes to the CSV that already has
 * its key, else to this timeline's CSV (see findTranslationFileFor). The
 * locale column and/or the key's row are added if missing (a new row also
 * gets the original text in the original-locale column), and the file's
 * line endings are kept.
 *
 * Throws an Error with a readable message instead of writing anything if
 * a translation has no CSV to go to, or a target CSV has unsaved changes
 * in an editor.
 *
 * @param {{key: string, original: string, translation: string, language?: string}[]} entries
 * @param {string|null} language - locale of the entries that don't set their own `language`
 * @param {vscode.Uri} timelineUri - the timeline the entries come from
 * @returns {Promise<number>} how many translations were written
 */
async function writeTranslations(entries, language, timelineUri) {
  if (entries.length === 0) { return 0; }
  const byFile = new Map();
  for (const entry of entries) {
    const uri = findTranslationFileFor(entry.key, { uri: timelineUri });
    if (!uri) {
      const what = entry.key.startsWith('Character/') ? 'characters' : entry.key.startsWith('Glossary/') ? 'glossaries' : 'this timeline';
      throw new Error(`No Dialogic translation CSV found for ${what}. Enable translation in Dialogic's settings and click "Update CSV files" first.`);
    }
    if (!byFile.has(uri.fsPath)) { byFile.set(uri.fsPath, { uri, entries: [] }); }
    byFile.get(uri.fsPath).entries.push(entry);
  }
  for (const { uri } of byFile.values()) {
    const openCsv = vscode.workspace.textDocuments.find(candidate => project.normalizeFsPath(candidate.uri.fsPath || '') === project.normalizeFsPath(uri.fsPath));
    if (openCsv && openCsv.isDirty) {
      throw new Error(`${uri.fsPath} has unsaved changes - save or revert it before translating here.`);
    }
  }
  for (const { uri, entries: fileEntries } of byFile.values()) {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const rows = parseCsv(text);
    if (rows.length === 0) { rows.push(['keys']); }
    const header = rows[0];
    const columnOf = locale => {
      let column = header.indexOf(locale);
      if (column === -1) {
        header.push(locale);
        column = header.length - 1;
      }
      return column;
    };
    const originalColumn = getOriginalLocale() ? header.indexOf(getOriginalLocale()) : -1;
    for (const entry of fileEntries) {
      const column = columnOf(entry.language || language);
      let row = rows.find((candidate, index) => index > 0 && candidate[0] === entry.key);
      if (!row) {
        row = [entry.key];
        if (originalColumn > 0) { row[originalColumn] = entry.original; }
        rows.push(row);
      }
      row[column] = entry.translation;
    }
    for (const candidate of rows) {
      while (candidate.length < header.length) { candidate.push(''); }
      for (let i = 0; i < candidate.length; i++) { if (candidate[i] === undefined) { candidate[i] = ''; } }
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeCsv(rows, eol), 'utf8'));
  }
  await refreshTranslations();
  problems.refreshAllDiagnostics();
  return entries.length;
}

/**
 * Write one translation (see writeTranslations), showing any problem as an
 * error message.
 *
 * @param {{key: string, original: string}} entry
 * @param {string} language
 * @param {string} translation
 * @param {vscode.TextDocument} document
 * @returns {Promise<boolean>} whether it was written
 */
async function writeTranslation(entry, language, translation, document) {
  try {
    await writeTranslations([{ ...entry, translation }], language, document.uri);
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(`DTL Reader: ${error.message}`);
    return false;
  }
}

/**
 * "DTL: Translate Line" - asks for the translation of a line in the
 * current language (showing the original), and writes it to the CSV.
 *
 * @param {vscode.Uri} [uri] - given by the quick fix
 * @param {number} [line] - given by the quick fix
 */
async function translateLineCommand(uri, line) {
  if (translationUnavailable()) { return; }
  const editor = vscode.window.activeTextEditor;
  // From the quick fix: (uri, line). From the editor context menu: (uri).
  // From the Command Palette: nothing - use the active editor's cursor.
  const document = uri && uri.fsPath
    ? vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === uri.fsPath) || await vscode.workspace.openTextDocument(uri)
    : editor && editor.document;
  if (!document || document.languageId !== 'dtl') { return; }
  const lineNumber = typeof line === 'number' ? line : editor.selection.active.line;
  const entry = parseTranslatableLine(document.lineAt(lineNumber).text);
  if (!entry) {
    vscode.window.showInformationMessage('DTL Reader: this line has no translation id (#id:...). "Update CSV files" in Dialogic\'s translation settings adds them.');
    return;
  }
  const language = getTranslationLanguage() || await selectTranslationLanguage();
  if (!language) { return; }
  const translation = await vscode.window.showInputBox({
    title: `Translate to ${language}`,
    prompt: `${getOriginalLocale() || 'Original'}: ${entry.original}`,
    value: getTranslation(entry.key, language),
    placeHolder: entry.original,
    ignoreFocusOut: true,
  });
  if (translation === undefined) { return; }
  if (await writeTranslation(entry, language, translation, document)) {
    vscode.window.setStatusBarMessage(`DTL Reader: ${entry.key} translated to ${language}`, 3000);
  }
}

/**
 * "DTL: Go to Next Untranslated Line" - moves the cursor to the next
 * translatable line with no translation in the current language,
 * wrapping around the end of the timeline.
 */
async function nextUntranslatedCommand() {
  if (translationUnavailable()) { return; }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'dtl') { return; }
  const language = getTranslationLanguage() || await selectTranslationLanguage();
  if (!language) { return; }
  const document = editor.document;
  const start = editor.selection.active.line;
  for (let offset = 1; offset <= document.lineCount; offset++) {
    const line = (start + offset) % document.lineCount;
    const entry = parseTranslatableLine(document.lineAt(line).text);
    if (entry && !getTranslation(entry.key, language)) {
      const position = new vscode.Position(line, entry.idStart);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
  }
  vscode.window.showInformationMessage(`DTL Reader: every translatable line of this timeline is translated to "${language}".`);
}

/**
 * Lightbulb action on a translatable line: "Translate to <language>".
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Range} range
 * @returns {vscode.CodeAction[]}
 */
function provideTranslationCodeActions(document, range) {
  if (!state.projectRootUri) { return []; }
  const entry = parseTranslatableLine(document.lineAt(range.start.line).text);
  if (!entry) { return []; }
  const language = getTranslationLanguage();
  const action = new vscode.CodeAction(language ? `Translate to ${language}` : 'Translate this line...', vscode.CodeActionKind.QuickFix);
  action.command = { command: 'dtlReader.translateLine', title: action.title, arguments: [document.uri, range.start.line] };
  return [action];
}

Object.assign(module.exports, {
  getOriginalLocale,
  refreshTranslations,
  getTranslationLanguage,
  parseTranslatableLine,
  getTranslation,
  updateTranslationDecorations,
  updateAllTranslationDecorations,
  findMissingTranslationDiagnostics,
  provideTranslationHover,
  translationUnavailable,
  selectTranslationLanguage,
  writeTranslations,
  translateLineCommand,
  nextUntranslatedCommand,
  provideTranslationCodeActions,
});
