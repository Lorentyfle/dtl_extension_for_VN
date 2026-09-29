// -----------------------------------------------------------------------------
// Reading the Godot project (project.godot and everything it points to)
// into state, keeping it up to date, and finding files in it.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('./state');
const resources = require('./godot/resources');
const settings = require('./godot/project-settings');
const gdscript = require('./godot/gdscript');
const syntax = require('./timeline/syntax');
const dchParse = require('./dch/parse');
const problems = require('./diagnostics/index');
const csvTranslations = require('./translation/translations');
const translationView = require('./translation/view');
const bbcodePreview = require('./features/bbcode-preview');
const glossaryFeature = require('./features/glossary');
const customEvents = require('./features/custom-events');

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/**
 * Per timeline identifier, its labels as last read from disk (see
 * getTimelineLabels, which prefers an open editor's live text).
 *
 * @type {Map<string, Map<string, DtlLabelInfo>>}
 */
let cachedTimelineLabels = new Map();

/**
 * Resolve a `res://`-style path to a filesystem Uri, relative to the
 * Godot project root (projectRootUri).
 *
 * @param {string} resPath - e.g. "res://dialogic/character/night/John.dch"
 * @returns {vscode.Uri}
 */
function resolveResourcePath(resPath) {
  return vscode.Uri.joinPath(state.projectRootUri, resPath.replace(/^res:\/\//, ''));
}

/**
 * Re-read every registered timeline's labels from disk, for cross-timeline
 * `jump Timeline/label` completion, hover and diagnostics. An unreadable
 * timeline just has no labels.
 */
async function refreshTimelineLabels() {
  const labelsByTimeline = new Map();
  const linesByTimeline = new Map();
  for (const [identifier, resPath] of state.cachedTimelinePaths) {
    try {
      const bytes = await vscode.workspace.fs.readFile(resolveResourcePath(resPath));
      const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
      labelsByTimeline.set(identifier, syntax.collectLabelsFromLines(lines));
      linesByTimeline.set(identifier, lines);
    } catch (error) {
      console.error(`DTL Reader: timeline "${identifier}" declares "${resPath}" but it could not be read - its labels are unavailable for jump.`, error);
    }
  }
  cachedTimelineLabels = labelsByTimeline;
  state.cachedTimelineLines = linesByTimeline;
}

/**
 * Every timeline's lines: the registered ones by identifier - read live
 * from their editor if open (so unsaved edits count), else as last read
 * from disk (cachedTimelineLines) - plus the open timelines not registered
 * yet (a new one Dialogic hasn't indexed), by timelineKey.
 *
 * @returns {Map<string, string[]>}
 */
function currentTimelineLines() {
  return problems.oncePerRound('timelineLines', () => {
    const result = new Map(state.cachedTimelineLines);
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === 'dtl') { result.set(timelineKey(document), syntax.documentLines(document)); }
    }
    return result;
  });
}

/**
 * A timeline's key in currentTimelineLines: its identifier, or its URI
 * while it isn't registered.
 *
 * @param {vscode.TextDocument} document
 * @returns {string}
 */
function timelineKey(document) {
  return findTimelineIdentifier(document) || document.uri.toString();
}

/** The project refresh running, if any. @type {Promise<void> | null} */
let projectRefresh = null;

/** A refresh was asked for while one was running. */
let projectRefreshPending = false;

/**
 * Re-read the Godot project (see readProjectGodotData). Refreshes never
 * overlap: one asked for while another runs (several file watchers firing
 * at once, a quick fix saving files...) runs once right after it, so the
 * caches always end up from a single, complete read.
 *
 * @returns {Promise<void>} resolves once the project is up to date
 */
function refreshProjectGodotData() {
  if (projectRefresh) {
    projectRefreshPending = true;
    return projectRefresh;
  }
  projectRefresh = (async () => {
    try {
      do {
        projectRefreshPending = false;
        await readProjectGodotData();
      } while (projectRefreshPending);
    } finally {
      projectRefresh = null;
    }
  })();
  return projectRefresh;
}

/**
 * Re-read project.godot and everything it points to (characters, timelines,
 * autoloads, glossaries, translations, custom events...), then re-check
 * every open document. Use refreshProjectGodotData, which never runs two
 * of these at once.
 */
async function readProjectGodotData() {
  const matches = await vscode.workspace.findFiles('**/project.godot', '**/.godot/**', 1);
  if (matches.length === 0) {
    state.cachedCharacterNames = [];
    state.cachedAudioChannels = [];
    state.cachedCharacterMoods = new Map();
    state.cachedVariablesTree = new Map();
    state.cachedCharacterInfo = new Map();
    state.cachedAutoloadSymbols = new Map();
    state.cachedAutoloadNames = new Set();
    state.cachedPortraitDetails = new Map();
    state.cachedTimelinePaths = new Map();
    cachedTimelineLabels = new Map();
    state.cachedTimelineLines = new Map();
    state.cachedScriptStrings = new Set();
    await customEvents.refreshCustomEvents('');
    state.cachedGlossaryEntries = [];
    state.cachedGlossaryFiles = [];
    state.glossaryPatternsKey = null;
    state.declaredProjectData = { characters: false, variables: false, timelines: false };
    state.projectRootUri = null;
    state.cachedResourcePaths = [];
    problems.refreshAllDiagnostics();
    return;
  }
  state.projectRootUri = vscode.Uri.joinPath(matches[0], '..');
  let dialogicSection = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(matches[0]);
    const text = Buffer.from(bytes).toString('utf8');
    state.cachedCharacterNames = settings.extractCharacterNames(text);
    state.cachedAudioChannels = settings.extractAudioChannels(text);
    state.cachedVariablesTree = settings.extractVariablesTree(text);
    dialogicSection = (text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/) || [])[1] || '';
    state.declaredProjectData = {
      characters: /directories\/dch_directory\s*=/.test(dialogicSection),
      variables: /(?:^|\n)variables\s*=/.test(dialogicSection),
      timelines: /directories\/dtl_directory\s*=/.test(dialogicSection),
    };
    state.cachedTimelinePaths = settings.extractDialogicDirectory(text, 'dtl');
    await glossaryFeature.refreshGlossaries(dialogicSection);
    const originalLocaleMatch = dialogicSection.match(/(?:^|\n)translation\/original_locale\s*=\s*"([^"]*)"/);
    state.translationOriginalLocale = originalLocaleMatch ? originalLocaleMatch[1] : null;
    await refreshTimelineLabels();
    state.cachedCharacterPaths = settings.extractCharacterPaths(text);
    await refreshCharacterMoods(state.cachedCharacterPaths);
    const autoloadPaths = settings.extractAutoloadPaths(text);
    state.cachedAutoloadNames = new Set(autoloadPaths.keys());
    await refreshAutoloadSymbols(autoloadPaths);
  } catch (error) {
    console.error('DTL Reader: could not read project.godot', error);
    state.cachedCharacterNames = [];
    state.cachedAudioChannels = [];
    state.cachedCharacterMoods = new Map();
    state.cachedVariablesTree = new Map();
    state.cachedCharacterInfo = new Map();
    state.cachedAutoloadSymbols = new Map();
    state.cachedAutoloadNames = new Set();
    state.cachedPortraitDetails = new Map();
    state.cachedTimelinePaths = new Map();
    cachedTimelineLabels = new Map();
    state.declaredProjectData = { characters: false, variables: false, timelines: false };
  }
  await refreshResourcePaths();
  await refreshScriptStrings();
  await customEvents.refreshCustomEvents(dialogicSection);
  await csvTranslations.refreshTranslations();
  problems.refreshAllDiagnostics();
  if (state.bbcodeCharDecorationType) { bbcodePreview.scheduleBbcodePreview(); } // glossary colors may have changed
  if (state.translationDecorationType) { translationView.updateTranslationGlobeContext(); } // the glossary list may have changed
}

/**
 * For every declared autoload (project.godot's `[autoload]` section), read
 * its script and parse its public top-level symbols (see parseGdScript),
 * so `do`/`if`/`elif` and `{...}` can autocomplete `Name.member` with
 * hover-ready documentation, without touching disk on every keystroke.
 * An autoload pointing at a `.tscn` scene (an "autoload node") uses the
 * scene root's script instead (see extractSceneRootScriptPath). Addon
 * autoloads are skipped unless `dtlReader.includeAddonAutoloads` is on.
 * An autoload whose script is missing or unreadable is simply left out
 * rather than failing the whole refresh.
 *
 * @param {Map<string, string>} autoloadPaths - name -> res:// script or scene path
 */
async function refreshAutoloadSymbols(autoloadPaths) {
  const includeAddons = vscode.workspace.getConfiguration('dtlReader').get('includeAddonAutoloads', false);
  const symbolsByGlobal = new Map();
  for (const [name, path] of autoloadPaths) {
    if (!includeAddons && /^res:\/\/addons\//i.test(path)) { continue; }
    try {
      let scriptPath = path;
      let scenePath = null;
      if (path.toLowerCase().endsWith('.tscn')) {
        const sceneBytes = await vscode.workspace.fs.readFile(resolveResourcePath(path));
        scenePath = path;
        scriptPath = resources.extractSceneRootScriptPath(Buffer.from(sceneBytes).toString('utf8'));
        if (!scriptPath) { continue; } // root node has no (external) script - nothing to expose
      }
      if (!scriptPath.toLowerCase().endsWith('.gd')) { continue; } // e.g. a binary .scn, or a C# script
      const bytes = await vscode.workspace.fs.readFile(resolveResourcePath(scriptPath));
      symbolsByGlobal.set(name, { ...gdscript.parseGdScript(Buffer.from(bytes).toString('utf8')), scriptPath, scenePath });
    } catch (error) {
      console.error(`DTL Reader: autoload "${name}" declares "${path}" but it (or its root script) could not be read - its members will be unavailable for do/if/elif and {...} autocomplete.`, error);
    }
  }
  state.cachedAutoloadSymbols = symbolsByGlobal;
}

/**
 * For every known character, read their `.dch` file and (for moods backed
 * by a LayeredPortrait scene) that scene's `.tscn` file, so `(mood)` tags
 * and `extra_data="set ..."` node paths can be autocompleted without
 * touching disk on every keystroke. Populates cachedCharacterMoods and
 * cachedCharacterInfo (display_name/nicknames/description/color, for the
 * character hover) from the same file read. A character with an
 * unreadable or malformed `.dch` file is simply left out rather than
 * failing the whole refresh.
 *
 * @param {Map<string, string>} characterPaths - name -> res:// .dch path
 */
async function refreshCharacterMoods(characterPaths) {
  const moodsByCharacter = new Map();
  const infoByCharacter = new Map();
  const detailsByCharacter = new Map();
  const soundMoodsByCharacter = new Map();
  for (const [name, dchPath] of characterPaths) {
    try {
      const dchBytes = await vscode.workspace.fs.readFile(resolveResourcePath(dchPath));
      const dchText = Buffer.from(dchBytes).toString('utf8');
      const portraits = dchParse.parseDchPortraits(dchText);
      infoByCharacter.set(name, dchParse.parseDchCharacterInfo(dchText));
      soundMoodsByCharacter.set(name, dchParse.parseDchSoundMoods(dchText));

      const moods = new Map();
      const details = new Map();
      for (const [moodName, portrait] of portraits) {
        details.set(moodName, { ...portrait, nodes: null });
        if (!portrait.scene) {
          moods.set(moodName, null);
          continue;
        }
        try {
          const tscnBytes = await vscode.workspace.fs.readFile(resolveResourcePath(portrait.scene));
          const tscnText = Buffer.from(tscnBytes).toString('utf8');
          moods.set(moodName, resources.parseTscnNodeTree(tscnText));
          details.get(moodName).nodes = resources.parseTscnNodeInfo(tscnText);
        } catch (error) {
          console.error(`DTL Reader: mood "${moodName}" for "${name}" declares scene "${portrait.scene}" but it could not be read - extra_data node-path autocomplete will be unavailable for this mood.`, error);
          moods.set(moodName, null); // scene referenced but unreadable - mood name still valid
        }
      }
      moodsByCharacter.set(name, moods);
      detailsByCharacter.set(name, details);
    } catch (error) {
      console.error(`DTL Reader: character "${name}" declares .dch path "${dchPath}" but it could not be read or parsed - no mood data or hover documentation for this character.`, error);
    }
  }
  state.cachedCharacterMoods = moodsByCharacter;
  state.cachedCharacterInfo = infoByCharacter;
  state.cachedPortraitDetails = detailsByCharacter;
  state.cachedCharacterSoundMoods = soundMoodsByCharacter;
}

/**
 * Godot's own sidecar metadata files - `.import` (import settings next to
 * every imported asset) and `.uid` (Godot 4.4+ resource UIDs next to every
 * script/shader) - which are never valid targets for a `res://` path in a
 * timeline, and would otherwise double or triple the path suggestions.
 *
 * @type {RegExp}
 */
const GODOT_METADATA_FILE_PATTERN = /\.(?:import|uid)$/i;

/**
 * Re-list every file under the Godot project root and cache each one as a
 * `res://`-relative path, for the `[voice path="..."]` / `[background
 * arg="..."]`-style path autocomplete. No-op if project.godot hasn't been
 * found yet.
 */
async function refreshResourcePaths() {
  if (!state.projectRootUri) {
    state.cachedResourcePaths = [];
    return;
  }
  try {
    const files = await vscode.workspace.findFiles('**/*', '**/{.git,.godot,node_modules}/**');
    const rootPath = state.projectRootUri.fsPath.replace(/\\/g, '/');
    state.cachedResourcePaths = files
      .map(uri => uri.fsPath.replace(/\\/g, '/'))
      .filter(fsPath => fsPath.startsWith(rootPath))
      .filter(fsPath => !GODOT_METADATA_FILE_PATTERN.test(fsPath))
      .map(fsPath => 'res://' + fsPath.slice(rootPath.length).replace(/^\/+/, ''));
  } catch (error) {
    console.error('DTL Reader: could not list project resource files', error);
    state.cachedResourcePaths = [];
  }
}

// =============================================================================
// LABEL / JUMP HELPERS
// =============================================================================

/**
 * Normalize a filesystem path for comparison (Windows paths are
 * case-insensitive and may use either slash).
 *
 * @param {string} fsPath
 * @returns {string}
 */
function normalizeFsPath(fsPath) {
  return fsPath.replace(/\\/g, '/').toLowerCase();
}

/**
 * The Dialogic timeline identifier of a document (its key in
 * project.godot's `directories/dtl_directory`), if it's a registered
 * timeline.
 *
 * @param {vscode.TextDocument} document
 * @returns {string | null}
 */
function findTimelineIdentifier(document) {
  if (!state.projectRootUri) { return null; }
  const documentPath = normalizeFsPath(document.uri.fsPath || '');
  for (const [identifier, resPath] of state.cachedTimelinePaths) {
    if (normalizeFsPath(resolveResourcePath(resPath).fsPath) === documentPath) { return identifier; }
  }
  return null;
}

/**
 * Labels of a timeline, by identifier - read live from its editor if it's
 * open (so unsaved edits count), else from cachedTimelineLabels.
 *
 * @param {string} identifier
 * @returns {Map<string, DtlLabelInfo> | null} null if the timeline is unknown
 */
function getTimelineLabels(identifier) {
  const resPath = state.cachedTimelinePaths.get(identifier);
  if (!resPath) { return null; }
  const timelinePath = normalizeFsPath(resolveResourcePath(resPath).fsPath);
  const openDocument = vscode.workspace.textDocuments.find(document => document.uri && document.uri.fsPath && normalizeFsPath(document.uri.fsPath) === timelinePath);
  if (openDocument) { return syntax.collectDocumentLabels(openDocument); }
  return cachedTimelineLabels.get(identifier) || new Map();
}

/**
 * Resolve a parsed jump to the labels it targets: this document's own,
 * or another registered timeline's.
 *
 * @param {vscode.TextDocument} document
 * @param {ReturnType<typeof parseJumpLine>} jump
 * @returns {{labels: Map<string, DtlLabelInfo>, uri: vscode.Uri, timeline: string|null} | null}
 */
function resolveJumpTarget(document, jump) {
  if (jump.timeline === null) {
    return { labels: syntax.collectDocumentLabels(document), uri: document.uri, timeline: null };
  }
  const labels = getTimelineLabels(jump.timeline);
  if (!labels) { return null; }
  return { labels, uri: resolveResourcePath(state.cachedTimelinePaths.get(jump.timeline)), timeline: jump.timeline };
}

// =============================================================================
// DIALOGIC CHARACTER FILES (.dch)
// =============================================================================
// A .dch file is Godot's var_to_str() of inst_to_dict(DialogicCharacter):
// a GDScript-literal dictionary. These describe its keys, per nesting level,
// for autocomplete and hover. Taken from Dialogic's own DialogicCharacter
// resource (addons/dialogic/Resources/character.gd) and character editor.

/**
 * The character a .dch document belongs to (its name in project.godot's
 * `directories/dch_directory`), if it's registered.
 *
 * @param {vscode.TextDocument} document
 * @returns {string | null}
 */
function findCharacterForDocument(document) {
  if (!state.projectRootUri) { return null; }
  const documentPath = normalizeFsPath(document.uri.fsPath || '');
  for (const [name, resPath] of state.cachedCharacterPaths) {
    if (normalizeFsPath(resolveResourcePath(resPath).fsPath) === documentPath) { return name; }
  }
  return null;
}

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

/**
 * A file's current text: from its editor if it's open, else from disk.
 *
 * @param {vscode.Uri} uri
 * @returns {Promise<string>}
 */
async function readDocumentText(uri) {
  const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath && normalizeFsPath(document.uri.fsPath) === normalizeFsPath(uri.fsPath));
  return open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

/**
 * "DTL: Open Translation View" - asks which languages to show (see
 * pickTranslationViewLanguages) and opens the active timeline's
 * Translation View beside it.
 */
/**
 * The res:// path of a file, if it's inside the Godot project.
 *
 * @param {vscode.Uri} uri
 * @returns {string | null}
 */
function toResPath(uri) {
  if (!state.projectRootUri || !uri.fsPath) { return null; }
  const root = normalizeFsPath(state.projectRootUri.fsPath).replace(/\/+$/, '');
  const file = normalizeFsPath(uri.fsPath);
  if (!file.startsWith(root + '/')) { return null; }
  const relative = uri.fsPath.replace(/\\/g, '/').slice(root.length + 1);
  return `res://${relative}`;
}

// =============================================================================
// LABEL REFERENCES, RENAME AND CODE LENS
// =============================================================================
// Every place that jumps to a label: `jump name` in its own timeline, and
// `jump Timeline/name` in any timeline. Powers Find All References
// (Shift+F12), Rename (F2) and the "N jumps here" link above each label.

/**
 * Every timeline of the workspace with its current text (open editors'
 * live text, else the file on disk) and its Dialogic identifier.
 *
 * @param {vscode.TextDocument} [current] - always included, even if not found by the search
 * @returns {Promise<{uri: vscode.Uri, identifier: string|null, lines: string[]}[]>}
 */
async function readAllTimelines(current) {
  // Without a project, a timeline is on its own: other files can't be
  // reached (no timeline directory), so only the current one is read.
  if (!state.projectRootUri && current) {
    return [{ uri: current.uri, identifier: null, lines: current.getText().split(/\r?\n/) }];
  }
  let uris = [];
  try { uris = (await vscode.workspace.findFiles('**/*.dtl', '**/{.git,.godot,node_modules}/**')).filter(uri => /\.dtl$/i.test(uri.fsPath)); } catch (error) { uris = []; }
  if (current && !uris.some(uri => normalizeFsPath(uri.fsPath) === normalizeFsPath(current.uri.fsPath || ''))) { uris.push(current.uri); }
  const timelines = [];
  for (const uri of uris) {
    try {
      const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath && normalizeFsPath(document.uri.fsPath) === normalizeFsPath(uri.fsPath));
      const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const identifier = findTimelineIdentifier({ uri });
      timelines.push({ uri: open ? open.uri : uri, identifier, lines: text.split(/\r?\n/) });
    } catch (error) {
      // unreadable timeline - skip it
    }
  }
  return timelines;
}

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

/**
 * Re-read every string literal of the project's own scripts into
 * cachedScriptStrings (Dialogic's own addon is left out).
 */
async function refreshScriptStrings() {
  scriptStringsByFile.clear();
  for (const resPath of state.cachedResourcePaths) {
    if (isOwnScript(resPath)) { scriptStringsByFile.set(resPath, readScriptStrings(await readScriptText(resPath))); }
  }
  state.cachedScriptStrings = new Set([...scriptStringsByFile.values()].flatMap(strings => [...strings]));
}

/** The string literals of each of the project's own scripts, by res:// path. @type {Map<string, Set<string>>} */
const scriptStringsByFile = new Map();

/** A script of the project itself - not of Dialogic's addon. @param {string} resPath */
const isOwnScript = resPath => resPath.toLowerCase().endsWith('.gd') && !resPath.startsWith('res://addons/dialogic/');

/** @param {string} resPath @returns {Promise<string>} '' if unreadable */
async function readScriptText(resPath) {
  try { return Buffer.from(await vscode.workspace.fs.readFile(resolveResourcePath(resPath))).toString('utf8'); } catch (error) { return ''; }
}

/** @param {string} text - a GDScript file @returns {Set<string>} its string literals */
function readScriptStrings(text) {
  const strings = new Set();
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) { strings.add(match[1] !== undefined ? match[1] : match[2]); }
  return strings;
}

/**
 * A .gd file was saved. An autoload's script or a custom event re-reads the
 * project (their members and parameters feed completion and hover); any
 * other script only updates its own string literals - not every script of
 * the project again.
 *
 * @param {vscode.Uri} uri
 */
async function onScriptChanged(uri) {
  const resPath = toResPath(uri);
  if (!resPath) { return; }
  const text = await readScriptText(resPath);
  const isAutoload = [...state.cachedAutoloadSymbols.values()].some(symbols => symbols.scriptPath === resPath);
  if (isAutoload || /^\s*extends\s+DialogicEvent\b/m.test(text)) {
    await refreshProjectGodotData();
    return;
  }
  if (!isOwnScript(resPath)) { return; }
  scriptStringsByFile.set(resPath, readScriptStrings(text));
  state.cachedScriptStrings = new Set([...scriptStringsByFile.values()].flatMap(strings => [...strings]));
  problems.refreshAllDiagnostics();
}

// =============================================================================
// QUICK FIXES
// =============================================================================
// Lightbulb fixes (Ctrl+.) for the problems DTL Reader reports: the closest
// existing names for a typo, creating what's missing (a label, a portrait),
// and removing or closing what's wrong (a jump's #id, an unclosed BBCode
// tag). Each fix re-reads the line its diagnostic points at rather than
// storing data on the diagnostic, so it always matches the current text.

/** @returns {vscode.Uri} */
function projectGodotUri() {
  return vscode.Uri.joinPath(state.projectRootUri, 'project.godot');
}

Object.assign(module.exports, {
  resolveResourcePath,
  refreshTimelineLabels,
  currentTimelineLines,
  timelineKey,
  refreshProjectGodotData,
  refreshResourcePaths,
  normalizeFsPath,
  findTimelineIdentifier,
  getTimelineLabels,
  resolveJumpTarget,
  findCharacterForDocument,
  readDocumentText,
  toResPath,
  readAllTimelines,
  projectGodotUri,
  onScriptChanged,
});
