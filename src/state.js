// -----------------------------------------------------------------------------
// The project data shared by the modules: read from the Godot project by
// project.js (and a few feature modules), then read everywhere. One object,
// so every module sees the current value of each field.
// -----------------------------------------------------------------------------
const state = {
  /** Character names found in project.godot. @type {string[]} */
  cachedCharacterNames: [],

  /** Character name -> `res://` `.dch` path, from project.godot. @type {Map<string, string>} */
  cachedCharacterPaths: new Map(),

  /** Audio channel/kind names found in project.godot's audio/channel_defaults. @type {string[]} */
  cachedAudioChannels: [],

  /** Folder containing project.godot, i.e. the Godot project root. @type {vscode.Uri | null} */
  projectRootUri: null,

  /** Every workspace file, expressed as a `res://`-relative path from the project root. @type {string[]} */
  cachedResourcePaths: [],

  /**
   * Per character, every mood declared in their `.dch` file's "portraits"
   * dict, mapped to that mood's parsed LayeredPortrait node tree - or
   * `null` for a plain single-image mood (no "scene" key), which has no
   * node tree to offer. Powers both the `(mood)` tag autocomplete and the
   * `extra_data="set ..."` node-path autocomplete.
   *
   * @type {Map<string, Map<string, Map<string, string[]> | null>>}
   */
  cachedCharacterMoods: new Map(),

  /**
   * project.godot's `[dialogic]` `variables={...}` dictionary, parsed into a
   * path tree: each segment maps to either a leaf (its default value, as raw
   * GDScript text - a number, boolean, string, Color(...), etc.) or a Map of
   * further child segments, mirroring the dictionary's own nesting. Powers
   * `{variable.path}` autocomplete.
   *
   * @type {Map<string, {value: string|null, children: Map|null}>}
   */
  cachedVariablesTree: new Map(),

  /**
   * Per character, the documentation-relevant fields declared in their
   * `.dch` file - display_name, nicknames, description, and color - used to
   * build the hover shown when hovering a character name. A character with
   * none of these fields declared simply has no hover.
   *
   * @type {Map<string, {displayName: string|null, nicknames: string[], description: string|null, color: string|null}>}
   */
  cachedCharacterInfo: new Map(),

  /**
   * Per autoload name (from project.godot's `[autoload]` section), the
   * public top-level symbols of its script (see parseGdScript) - plus where
   * that script came from. An autoload can point either straight at a `.gd`
   * script, or at a `.tscn` scene ("autoload node"), in which case the
   * scene's root node script is used, since that's the node Dialogic reaches
   * as `Name`. Powers `Name.member` autocomplete and hover after `do`, `if`
   * and `elif`, and inside `{Name.property}` variable blocks.
   *
   * Only autoloads are included - not every `class_name` script - because
   * that's all Dialogic can actually resolve by name at runtime. Autoloads
   * declared by addons (`res://addons/...`, e.g. Dialogic's own `Dialogic`
   * singleton with its hundreds of members) are skipped unless the
   * `dtlReader.includeAddonAutoloads` setting is on.
   *
   * @type {Map<string, GdScriptSymbols & {scriptPath: string, scenePath: string|null}>}
   */
  cachedAutoloadSymbols: new Map(),

  /**
   * Every autoload name declared in project.godot - including the addon
   * ones left out of cachedAutoloadSymbols - so `{Dialogic.x}`-style
   * references are never reported as unknown variables just because their
   * members aren't loaded.
   *
   * @type {Set<string>}
   */
  cachedAutoloadNames: new Set(),

  /**
   * Per character, per mood, the portrait settings from the `.dch` file
   * (see parseDchPortraits) plus, for a scene-backed mood, the scene's node
   * types/descriptions (see parseTscnNodeInfo). Powers the mood and
   * LayeredPortrait layer hovers.
   *
   * @type {Map<string, Map<string, DchPortraitInfo & {nodes: Map<string, {type: string|null, description: string|null}>|null}>>}
   */
  cachedPortraitDetails: new Map(),

  /** Per character, the names of their typing sound moods (custom_info > sound_moods), for [mood=...]. @type {Map<string, string[]>} */
  cachedCharacterSoundMoods: new Map(),

  /**
   * What project.godot actually declares, so diagnostics only report an
   * unknown character/variable when there's a real list to check against:
   * `characters` is true when `directories/dch_directory` exists, `variables`
   * when `[dialogic]` has a `variables={...}` entry, `timelines` when
   * `directories/dtl_directory` exists.
   *
   * @type {{characters: boolean, variables: boolean, timelines: boolean}}
   */
  declaredProjectData: { characters: false, variables: false, timelines: false },

  /**
   * Timeline identifier -> `res://` path, from project.godot's
   * `directories/dtl_directory` - how Dialogic names a timeline in
   * `jump Timeline/label` (the file name, or a short unique path when two
   * timelines share one).
   *
   * @type {Map<string, string>}
   */
  cachedTimelinePaths: new Map(),

  /**
   * Every registered timeline's lines as last read from disk, by identifier -
   * to know where each label is jumped to from and which characters and
   * moods the timelines use. See currentTimelineLines for the live view.
   *
   * @type {Map<string, string[]>}
   */
  cachedTimelineLines: new Map(),

  /**
   * Every string literal of the project's own scripts (`.gd` files outside
   * `res://addons/dialogic/`), so a label, character or portrait that a script
   * names - `Dialogic.start("chapter1", "intro")` - isn't reported unused.
   *
   * @type {Set<string>}
   */
  cachedScriptStrings: new Set(),

  /**
   * Diagnostic collection used to warn about `jump` targets that have no
   * matching `label` declaration in the same document.
   *
   * @type {vscode.DiagnosticCollection}
   */
  diagnosticCollection: undefined,

  /** Every locale column found in the CSVs. @type {string[]} */
  cachedTranslationLocales: [],

  /** Every Dialogic translation CSV found. @type {vscode.Uri[]} */
  cachedTranslationFiles: [],

  /** project.godot's `dialogic/translation/original_locale`, the language timelines are written in. @type {string|null} */
  translationOriginalLocale: null,

  /** Decoration showing a line's translation after it. @type {vscode.TextEditorDecorationType | null} */
  translationDecorationType: null,

  /** @type {TranslationViewFileSystem | null} */
  translationViewFileSystem: null,

  /** Where the last languages picked for the Translation View are remembered (per workspace). @type {vscode.Memento | null} */
  translationViewMemento: null,

  /** Shows a [char=...] tag's character after it. @type {vscode.TextEditorDecorationType | null} */
  bbcodeCharDecorationType: null,

  /**
   * @typedef {{
   *   key: string, name: string, alternatives: string[], title: string, text: string, extra: string,
   *   color: string|null, caseSensitive: boolean|null, file: string,
   *   glossaryId: string|null, entryId: string|null
   * }} GlossaryEntry
   */

  /** Every enabled glossary entry of the project. @type {GlossaryEntry[]} */
  cachedGlossaryEntries: [],

  /** The glossary files listed in project.godot. @type {string[]} */
  cachedGlossaryFiles: [],

  /** What glossaryPatterns were built for ("<language>|<translations version>"). @type {string|null} */
  glossaryPatternsKey: null,

  /** Bumped whenever the translation CSVs are re-read, so glossary patterns follow them. @type {number} */
  translationsVersion: 0,

  /**
   * What a timeline itself declares or uses, for autocomplete without a
   * project. Set by the completion provider before each request (null when
   * there is a project).
   *
   * @type {{characters: Set<string>, moods: Map<string, Set<string>>, variables: Map, audio: Set<string>, paths: Set<string>} | null}
   */
  isolatedDocumentData: null,

  /** @type {vscode.OutputChannel | null} */
  godotOutputChannel: null,
};

module.exports = state;
