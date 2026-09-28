// -----------------------------------------------------------------------------
// Reading project.godot's [dialogic] and [autoload] settings.
// -----------------------------------------------------------------------------
const resources = require('./resources');

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

function extractCharacterNames(text) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return []; }
  const dictionaryMatch = sectionMatch[1].match(/directories\/dch_directory\s*=\s*\{([\s\S]*?)\}/);
  if (!dictionaryMatch) { return []; }
  const keyPattern = /"([^"]+)"\s*:\s*"[^"]*"/g;
  const names = [];
  let match;
  while ((match = keyPattern.exec(dictionaryMatch[1])) !== null) { names.push(match[1]); }
  return names;
}

/**
 * Extract audio channel names from `audio/channel_defaults = { ... }`.
 * Each top-level key (e.g. "music", "loopSFX") is what `audio KIND "path"`
 * expects as its first argument. Only top-level keys are followed directly
 * by a nested "{" - the inner keys (audio_bus, fade_length, loop, volume)
 * are followed by a plain value instead, so no bracket-depth tracking is
 * needed to tell them apart once the outer dict body is isolated.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractAudioChannels(text) {
  const headerMatch = text.match(/audio\/channel_defaults\s*=\s*\{/);
  if (!headerMatch) { return []; }

  const openBraceIndex = headerMatch.index + headerMatch[0].length - 1;
  const body = resources.extractBalancedBraces(text, openBraceIndex);
  if (body === null) { return []; }

  const keyPattern = /"([^"]*)"\s*:\s*\{/g;
  const names = [];
  let match;
  while ((match = keyPattern.exec(body)) !== null) { names.push(match[1]); }
  return names;
}

/**
 * Extract project.godot's `[dialogic]` `variables={...}` dictionary into a
 * path tree (see parseNestedDictTree). Empty if no variables are declared.
 *
 * @param {string} text - raw project.godot content
 * @returns {Map<string, {value: string|null, children: Map|null}>}
 */
function extractVariablesTree(text) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const headerMatch = sectionMatch[1].match(/variables\s*=\s*\{/);
  if (!headerMatch) { return new Map(); }
  const openBraceIndex = headerMatch.index + headerMatch[0].length - 1;
  const body = resources.extractBalancedBraces(sectionMatch[1], openBraceIndex);
  if (body === null) { return new Map(); }
  return resources.parseNestedDictTree(body);
}

/**
 * Extract character name -> `res://` `.dch` path from project.godot's
 * `directories/dch_directory` dict, e.g. `{"John": "res://.../John.dch"}`.
 * Companion to extractCharacterNames, which only keeps the keys.
 *
 * @param {string} text - raw project.godot content
 * @returns {Map<string, string>}
 */
function extractCharacterPaths(text) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const dictionaryMatch = sectionMatch[1].match(/directories\/dch_directory\s*=\s*\{([\s\S]*?)\}/);
  if (!dictionaryMatch) { return new Map(); }
  const entryPattern = /"([^"]+)"\s*:\s*"([^"]*)"/g;
  const paths = new Map();
  let match;
  while ((match = entryPattern.exec(dictionaryMatch[1])) !== null) { paths.set(match[1], match[2]); }
  return paths;
}

/**
 * Extract one of the `[dialogic]` `directories/<extension>_directory`
 * dicts (identifier -> `res://` path), e.g. `dtl` for timelines. Same
 * shape as the `dch` one extractCharacterPaths reads.
 *
 * @param {string} text - raw project.godot content
 * @param {string} extension - e.g. "dtl"
 * @returns {Map<string, string>}
 */
function extractDialogicDirectory(text, extension) {
  const sectionMatch = text.match(/(?:^|\n)\[dialogic\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const dictionaryMatch = sectionMatch[1].match(new RegExp(`directories\\/${extension}_directory\\s*=\\s*\\{([\\s\\S]*?)\\}`));
  if (!dictionaryMatch) { return new Map(); }
  const entryPattern = /"([^"]+)"\s*:\s*"([^"]*)"/g;
  const paths = new Map();
  let match;
  while ((match = entryPattern.exec(dictionaryMatch[1])) !== null) { paths.set(match[1], match[2]); }
  return paths;
}

/**
 * Extract autoload/global-script name -> `res://` script path from
 * project.godot's `[autoload]` section, e.g. `Global="*res://global.gd"`.
 * The optional leading `*` (marks it enabled in-editor) is ignored either
 * way. Entries pointing at a `.tscn` (a singleton scene rather than a
 * plain script) are kept too - refreshAutoloadSymbols resolves those to
 * their root node's script.
 *
 * @param {string} text - raw project.godot content
 * @returns {Map<string, string>}
 */
function extractAutoloadPaths(text) {
  const sectionMatch = text.match(/(?:^|\n)\[autoload\]([\s\S]*?)(\n\[|$)/);
  if (!sectionMatch) { return new Map(); }
  const entryPattern = /(?:^|\n)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"\*?(res:\/\/[^"]+)"/g;
  const paths = new Map();
  let match;
  while ((match = entryPattern.exec(sectionMatch[1])) !== null) { paths.set(match[1], match[2]); }
  return paths;
}

// =============================================================================
// QUICK FIXES
// =============================================================================
// Lightbulb fixes (Ctrl+.) for the problems DTL Reader reports: the closest
// existing names for a typo, creating what's missing (a label, a portrait),
// and removing or closing what's wrong (a jump's #id, an unclosed BBCode
// tag). Each fix re-reads the line its diagnostic points at rather than
// storing data on the diagnostic, so it always matches the current text.

/**
 * Where a `[dialogic]` setting's dictionary opens in project.godot, e.g.
 * `variables` or `directories/dch_directory`.
 *
 * @param {string} text - project.godot
 * @param {string} setting
 * @returns {number} the index of its `{`, or -1
 */
function findDialogicSettingDict(text, setting) {
  const section = /(?:^|\n)\[dialogic\][^\n]*\n/.exec(text);
  if (!section) { return -1; }
  const sectionStart = section.index + section[0].length;
  const nextSection = text.slice(sectionStart).search(/\n\[/);
  const sectionEnd = nextSection === -1 ? text.length : sectionStart + nextSection;
  const escaped = setting.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const header = new RegExp(`(?:^|\\n)${escaped}\\s*=\\s*\\{`).exec(text.slice(sectionStart, sectionEnd));
  return header ? sectionStart + header.index + header[0].length - 1 : -1;
}

Object.assign(module.exports, {
  extractCharacterNames,
  extractAudioChannels,
  extractVariablesTree,
  extractCharacterPaths,
  extractDialogicDirectory,
  extractAutoloadPaths,
  findDialogicSettingDict,
});
