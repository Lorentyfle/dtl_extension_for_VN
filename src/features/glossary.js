// -----------------------------------------------------------------------------
// Dialogic glossaries: words colored in text, hover, Ctrl+Click, suggestions.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const resources = require('../godot/resources');
const documentation = require('../documentation');
const project = require('../project');
const csvTranslations = require('../translation/translations');
const translationView = require('../translation/view');
const bbcodePreview = require('./bbcode-preview');

// =============================================================================
// GLOSSARY
// =============================================================================
// Dialogic's glossaries (.tres DialogicGlossary resources listed in
// project.godot's `dialogic/glossary/glossary_files`): words that get a
// colored link in the game's text, with a title, a text and extra info.
// Here, those words get their color with a dotted underline in dialogue,
// narration and choices, and hovering one shows the entry.

/** project.godot's `dialogic/glossary/default_color` (Godot's POWDER_BLUE by default), as CSS. @type {string} */
let glossaryDefaultColor = 'rgba(176, 224, 230, 1)';

/** project.godot's `dialogic/glossary/default_case_sensitive` (true by default). @type {boolean} */
let glossaryDefaultCaseSensitive = true;

/** One regular expression per entry (its name and alternatives, plus their translation in translation mode). @type {{entry: GlossaryEntry, pattern: RegExp}[]} */
let glossaryPatterns = [];

/**
 * The glossary patterns for the current translation language: like
 * Dialogic in a translated game, an entry is also recognized by its
 * translated name and alternatives (CSV keys .../name and .../alternatives,
 * comma-separated).
 *
 * @returns {{entry: GlossaryEntry, pattern: RegExp}[]}
 */
function getGlossaryPatterns() {
  const language = csvTranslations.getTranslationLanguage() || '';
  const key = `${language}|${state.translationsVersion}`;
  if (key === state.glossaryPatternsKey) { return glossaryPatterns; }
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  glossaryPatterns = state.cachedGlossaryEntries.filter(entry => entry.name).map(entry => {
    const words = [entry.name, ...entry.alternatives];
    if (language && entry.glossaryId && entry.entryId) {
      const base = `Glossary/${entry.glossaryId}/${entry.entryId}`;
      words.push(csvTranslations.getTranslation(`${base}/name`, language), ...csvTranslations.getTranslation(`${base}/alternatives`, language).split(',').map(word => word.trim()));
    }
    const unique = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRegex);
    const caseSensitive = entry.caseSensitive === null ? glossaryDefaultCaseSensitive : entry.caseSensitive;
    // Whole words, like Dialogic's (?<=\W|^)(?<!\\)(word)(?!])(?=\W|$)
    return { entry, pattern: new RegExp(`(?<![\\p{L}\\p{N}_\\\\])(?:${unique.join('|')})(?![\\p{L}\\p{N}_\\]])`, caseSensitive ? 'gu' : 'giu') };
  });
  state.glossaryPatternsKey = key;
  return glossaryPatterns;
}

/**
 * Parse a DialogicGlossary `.tres` file into its entries. Its `entries`
 * dictionary maps each entry name to the entry (a dictionary), and each
 * alternative word to the entry's name (a plain string) - only the
 * dictionaries are entries.
 *
 * @param {string} text - raw .tres content
 * @param {string} file - its res:// path
 * @returns {GlossaryEntry[]}
 */
function parseGlossaryResource(text, file) {
  const resourceSection = text.slice(Math.max(0, text.indexOf('[resource]')));
  if (/(?:^|\n)enabled\s*=\s*false/.test(resourceSection)) { return []; }
  const glossaryIdMatch = resourceSection.match(/(?:^|\n)_translation_id\s*=\s*"([^"]*)"/);
  const headerMatch = resourceSection.match(/(?:^|\n)entries\s*=\s*\{/);
  if (!headerMatch) { return []; }
  const body = resources.extractBalancedBraces(resourceSection, headerMatch.index + headerMatch[0].length - 1);
  if (body === null) { return []; }
  const entries = [];
  for (const { key, childBody } of resources.scanDictEntries(body)) {
    if (childBody === null) { continue; } // an alternative -> entry name alias
    const fields = new Map(resources.scanDictEntries(childBody).map(field => [field.key, field.rawValue]));
    if (fields.get('enabled') === 'false') { continue; }
    const caseSensitive = fields.get('case_sensitive');
    entries.push({
      key,
      name: resources.gdLiteralToText(fields.get('name')) || key,
      alternatives: resources.gdArrayToStrings(fields.get('alternatives')),
      title: resources.gdLiteralToText(fields.get('title')),
      text: resources.gdLiteralToText(fields.get('text')),
      extra: resources.gdLiteralToText(fields.get('extra')),
      color: fields.get('color') ? resources.parseGodotColor(fields.get('color')) : null,
      caseSensitive: caseSensitive === 'true' ? true : caseSensitive === 'false' ? false : null,
      file,
      glossaryId: glossaryIdMatch ? glossaryIdMatch[1] : null,
      entryId: fields.has('_translation_id') ? resources.gdLiteralToText(fields.get('_translation_id')) : null,
    });
  }
  return entries;
}

/**
 * Re-read the glossary settings and files listed in project.godot.
 *
 * @param {string} dialogicSection - project.godot's [dialogic] section text
 */
async function refreshGlossaries(dialogicSection) {
  const filesMatch = dialogicSection.match(/(?:^|\n)glossary\/glossary_files\s*=\s*([^\n]*)/);
  const colorMatch = dialogicSection.match(/(?:^|\n)glossary\/default_color\s*=\s*(Color\([^)]*\))/);
  const caseMatch = dialogicSection.match(/(?:^|\n)glossary\/default_case_sensitive\s*=\s*(true|false)/);
  glossaryDefaultColor = (colorMatch && resources.parseGodotColor(colorMatch[1])) || 'rgba(176, 224, 230, 1)';
  glossaryDefaultCaseSensitive = caseMatch ? caseMatch[1] === 'true' : true;
  const entries = [];
  for (const file of resources.gdArrayToStrings(filesMatch ? filesMatch[1] : '')) {
    try {
      entries.push(...parseGlossaryResource(Buffer.from(await vscode.workspace.fs.readFile(project.resolveResourcePath(file))).toString('utf8'), file));
    } catch (error) {
      console.error(`DTL Reader: glossary "${file}" (from project.godot) could not be read.`, error);
    }
  }
  state.cachedGlossaryEntries = entries;
  state.cachedGlossaryFiles = resources.gdArrayToStrings(filesMatch ? filesMatch[1] : '');
  state.glossaryPatternsKey = null; // rebuilt on next use
}

/**
 * Glossary words of one line: which entry, and where - only in its
 * player-facing text, never inside a `[tag]` or a `{variable}`.
 *
 * @param {vscode.TextDocument} document
 * @param {string} text
 * @returns {{entry: GlossaryEntry, start: number, end: number}[]}
 */
function findGlossaryWords(document, text) {
  const patterns = getGlossaryPatterns();
  if (patterns.length === 0) { return []; }
  const from = bbcodePreview.bbcodePreviewStart(document, text);
  if (from === -1) { return []; }
  const blocked = new Array(text.length).fill(false);
  const blockPattern = /\[[^\]]*\]|\{[^}]*\}|#id:\S+/g;
  let block;
  while ((block = blockPattern.exec(text)) !== null) { for (let i = block.index; i < block.index + block[0].length; i++) { blocked[i] = true; } }
  const found = [];
  const taken = new Array(text.length).fill(false);
  for (const { entry, pattern } of patterns) {
    pattern.lastIndex = from;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      let free = true;
      for (let i = start; i < end; i++) { if (blocked[i] || taken[i]) { free = false; break; } }
      if (!free) { continue; }
      for (let i = start; i < end; i++) { taken[i] = true; }
      found.push({ entry, start, end });
    }
  }
  return found;
}

/**
 * Hover on a glossary word: its title, text and extra info (translated in
 * translation mode), and the glossary it comes from.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.Hover | undefined}
 */
function provideGlossaryHover(document, position) {
  const text = document.lineAt(position.line).text;
  const hit = findGlossaryWords(document, text).find(word => position.character >= word.start && position.character <= word.end);
  if (!hit) { return undefined; }
  const { entry } = hit;
  const language = csvTranslations.getTranslationLanguage();
  const translated = property => {
    if (!language || !entry.glossaryId || !entry.entryId) { return ''; }
    return csvTranslations.getTranslation(`Glossary/${entry.glossaryId}/${entry.entryId}/${property}`, language);
  };
  const markdown = new vscode.MarkdownString();
  const title = translated('title') || (language ? translated('name') : '') || entry.title || entry.name;
  markdown.appendMarkdown(entry.color || glossaryDefaultColor ? `${documentation.createColoredTitleMarkdown(title, entry.color || glossaryDefaultColor)}\n\n` : `**${title}**\n\n`);
  const body = translated('text') || entry.text;
  if (body) { markdown.appendMarkdown(`${body}\n\n`); }
  const extra = translated('extra') || entry.extra;
  if (extra) { markdown.appendMarkdown(`_${extra}_\n\n`); }
  const words = [entry.name, ...entry.alternatives].filter(word => word !== title);
  markdown.appendMarkdown(`Glossary \`${entry.file}\`${words.length > 0 ? ` - also written: ${words.map(word => `\`${word}\``).join(', ')}` : ''}`);
  return new vscode.Hover(markdown, new vscode.Range(position.line, hit.start, position.line, hit.end));
}

/**
 * Go to Definition (Ctrl+click) on a glossary word: the entry in its
 * glossary `.tres` file - the line of its key in the `entries` dictionary.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.Location | undefined>}
 */
async function provideGlossaryDefinition(document, position) {
  const hit = findGlossaryWords(document, document.lineAt(position.line).text)
    .find(word => position.character >= word.start && position.character <= word.end);
  if (!hit || !state.projectRootUri) { return undefined; }
  const uri = project.resolveResourcePath(hit.entry.file);
  let text;
  try { text = await project.readDocumentText(uri); } catch (error) { return undefined; }
  const entriesStart = Math.max(0, text.search(/(?:^|\n)entries\s*=\s*\{/));
  const escapedKey = hit.entry.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\\\"');
  const keyMatch = new RegExp(`&?"${escapedKey}"\\s*:\\s*\\{`).exec(text.slice(entriesStart));
  const offset = keyMatch ? entriesStart + keyMatch.index + (keyMatch[0].startsWith('&') ? 1 : 0) : 0;
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) || []).length;
  const character = offset - (before.lastIndexOf('\n') + 1);
  return new vscode.Location(uri, new vscode.Position(line, character));
}

/** Decoration type per glossary color. @type {Map<string, vscode.TextEditorDecorationType>} */
const glossaryDecorationTypes = new Map();

/**
 * Color the glossary words of an editor (`dtlReader.preview.glossary`),
 * like Dialogic does in the game, with a dotted underline to show they
 * can be hovered.
 *
 * @param {vscode.TextEditor} editor
 */
function updateGlossaryDecorations(editor) {
  if (!editor) { return; }
  const document = editor.document;
  const applies = document.languageId === 'dtl' || document.uri.scheme === translationView.TRANSLATION_VIEW_SCHEME;
  const enabled = applies && vscode.workspace.getConfiguration('dtlReader').get('preview.glossary', true);
  const byColor = new Map();
  if (enabled) {
    for (let line = 0; line < document.lineCount; line++) {
      for (const word of findGlossaryWords(document, document.lineAt(line).text)) {
        const color = word.entry.color || glossaryDefaultColor;
        if (!byColor.has(color)) { byColor.set(color, []); }
        byColor.get(color).push(new vscode.Range(line, word.start, line, word.end));
      }
    }
  }
  for (const color of byColor.keys()) {
    if (!glossaryDecorationTypes.has(color)) {
      glossaryDecorationTypes.set(color, vscode.window.createTextEditorDecorationType({ color, textDecoration: 'underline dotted' }));
    }
  }
  for (const [color, type] of glossaryDecorationTypes) { editor.setDecorations(type, byColor.get(color) || []); }
}

Object.assign(module.exports, {
  parseGlossaryResource,
  refreshGlossaries,
  provideGlossaryHover,
  provideGlossaryDefinition,
  glossaryDecorationTypes,
  updateGlossaryDecorations,
});
