// -----------------------------------------------------------------------------
// Reading and writing Godot text formats: dictionaries, colors, scenes
// (.tscn), resources (.tres) and ConfigFile (.cfg).
// -----------------------------------------------------------------------------
// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/**
 * Return the substring between `text[openBraceIndex]` (a '{') and its
 * matching closing '}', tracking nesting depth. Needed because
 * channel_defaults is a dict-of-dicts, unlike the flat dch_directory dict.
 *
 * @param {string} text
 * @param {number} openBraceIndex
 * @returns {string | null}
 */
function extractBalancedBraces(text, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') { depth++; }
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { return text.slice(openBraceIndex + 1, i); }
    }
  }
  return null;
}

/**
 * Scan a dictionary body (text already inside its outer '{'...'}') into an
 * ordered list of `{key, rawValue, childBody}` entries, one per top-level
 * `"key": value` pair - where `value` can be either a nested dict (in
 * which case `childBody` is that dict's own already-brace-stripped body
 * and `rawValue` is `null`) or any other GDScript literal (a number,
 * boolean, string, `Color(...)`, array, ...), kept verbatim as `rawValue`
 * with `childBody` `null`. Unlike extractTopLevelDictEntries (which only
 * recognizes entries whose value is itself a dict), this also captures
 * leaf entries - needed for `variables={...}`, where a key's value is
 * either a nested group or a plain default value.
 *
 * @param {string} dictBody
 * @returns {{key: string, rawValue: string|null, childBody: string|null}[]}
 */
function scanDictEntries(dictBody) {
  const entries = [];
  const keyPattern = /&?"([^"]+)"\s*:\s*/g;
  let match;
  while ((match = keyPattern.exec(dictBody)) !== null) {
    const valueStart = keyPattern.lastIndex;
    if (dictBody[valueStart] === '{') {
      const childBody = extractBalancedBraces(dictBody, valueStart);
      if (childBody === null) { break; } // unterminated - stop rather than misparse the rest
      entries.push({ key: match[1], rawValue: null, childBody });
      keyPattern.lastIndex = valueStart + childBody.length + 2; // past the matching '}'
      continue;
    }
    // Leaf value: scan forward to the next top-level ',' (or the end of
    // this dict body), respecting nested (), [], {} depth so a value like
    // Color(0.5, 0.5, 1, 1) or [1, 2] doesn't get cut short at its own commas.
    let depth = 0;
    let end = valueStart;
    while (end < dictBody.length) {
      const ch = dictBody[end];
      if (ch === '(' || ch === '[' || ch === '{') { depth++; }
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) { break; } // belongs to the enclosing dict, not this value
        depth--;
      } else if (ch === ',' && depth === 0) { break; }
      end++;
    }
    entries.push({ key: match[1], rawValue: dictBody.slice(valueStart, end).trim(), childBody: null });
    keyPattern.lastIndex = end;
  }
  return entries;
}

/**
 * Recursively parse a dictionary body into a path tree: each key maps to
 * either a leaf (`value` holds its raw default, `children` is `null`) or a
 * further nested Map (`value` is `null`, `children` holds the subtree) -
 * mirroring the dictionary's own nesting. Powers `{variable.path}`
 * autocomplete, one path segment at a time, the same way
 * createEmotionPathSuggestions walks a LayeredPortrait's node tree.
 *
 * @param {string} dictBody
 * @returns {Map<string, {value: string|null, children: Map|null}>}
 */
function parseNestedDictTree(dictBody) {
  const tree = new Map();
  for (const { key, rawValue, childBody } of scanDictEntries(dictBody)) {
    tree.set(key, childBody !== null
      ? { value: null, children: parseNestedDictTree(childBody) }
      : { value: rawValue, children: null });
  }
  return tree;
}

/**
 * Find the `res://` path of the script attached to a `.tscn` scene's root
 * node - used to resolve an autoload that points at a scene ("autoload
 * node") to the script whose members are reachable as `Name.member`.
 * Handles both the Godot 4 (`ExtResource("1_abc")`) and Godot 3
 * (`ExtResource( 1 )`) id formats. A root node with no script, or with a
 * built-in (SubResource) script, yields null.
 *
 * @param {string} text - raw .tscn file content
 * @returns {string | null}
 */
function extractSceneRootScriptPath(text) {
  const scriptResources = new Map();
  const extResourcePattern = /\[ext_resource\b([^\]]*)\]/g;
  let match;
  while ((match = extResourcePattern.exec(text)) !== null) {
    const attributes = match[1];
    const typeMatch = attributes.match(/\btype="([^"]+)"/);
    const pathMatch = attributes.match(/\bpath="([^"]+)"/);
    const idMatch = attributes.match(/\bid=(?:"([^"]+)"|(\d+))/);
    if (typeMatch && typeMatch[1] === 'Script' && pathMatch && idMatch) {
      scriptResources.set(idMatch[1] || idMatch[2], pathMatch[1]);
    }
  }
  // The root is the only [node] without a parent= attribute.
  const rootMatch = text.match(/\[node\b(?![^\]]*\bparent=)[^\]]*\]([\s\S]*?)(?=\r?\n\[|$)/);
  if (!rootMatch) { return null; }
  const scriptMatch = rootMatch[1].match(/^\s*script\s*=\s*ExtResource\(\s*"?([^")\s]+)"?\s*\)/m);
  return scriptMatch ? (scriptResources.get(scriptMatch[1]) || null) : null;
}

/**
 * Split a dictionary body (the text already inside its outer '{'...'}')
 * into its top-level `"key": { ... }` entries, ignoring anything nested
 * deeper. Generic enough to reuse for any GDScript-ish nested dictionary;
 * currently only used by parseDchPortraits for the mood -> portrait dict.
 *
 * @param {string} dictBody
 * @returns {{key: string, body: string}[]}
 */
function extractTopLevelDictEntries(dictBody) {
  const entries = [];
  const keyPattern = /&?"([^"]+)"\s*:\s*\{/g;
  let match;
  while ((match = keyPattern.exec(dictBody)) !== null) {
    const openBraceIndex = match.index + match[0].length - 1;
    const body = extractBalancedBraces(dictBody, openBraceIndex);
    if (body === null) { continue; }
    entries.push({ key: match[1], body });
    keyPattern.lastIndex = openBraceIndex + body.length + 2; // skip past this nested block entirely
  }
  return entries;
}

/**
 * Parse a Godot `Color(r, g, b[, a])` literal (components 0-1) into a CSS
 * `rgba(...)` string. Returns `null` if the text doesn't look like one.
 *
 * @param {string} rawValue - e.g. "Color(0.58, 0.39, 0.78, 1)"
 * @returns {string | null}
 */
function parseGodotColor(rawValue) {
  const match = rawValue.match(/Color\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!match) { return null; }
  const [, r, g, b, a] = match;
  const to255 = component => Math.round(parseFloat(component) * 255);
  const alpha = a !== undefined ? parseFloat(a) : 1;
  return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha})`;
}

/**
 * Parse a LayeredPortrait `.tscn` scene into a parent-path -> child-names
 * map, e.g. `tree.get(".")` is the scene root's direct children,
 * `tree.get("Head/Left_Eye")` is that node's children. Godot writes each
 * node's full parent path (not just its immediate parent's name) in its
 * `parent="..."` attribute, so that value can be used directly as the map
 * key with no path-walking needed. The scene root itself never has a
 * `parent=` attribute, so it's naturally never suggested - no special
 * "skip the CanvasGroup" case required.
 *
 * Assumes `name=` appears before `parent=` on the same `[node ...]` line,
 * which matches Godot's own attribute ordering.
 *
 * @param {string} text - raw .tscn file content
 * @returns {Map<string, string[]>}
 */
function parseTscnNodeTree(text) {
  const childrenByParent = new Map();
  const nodePattern = /\[node\s+name="([^"]+)"[^\]]*?\bparent="([^"]*)"[^\]]*\]/g;
  let match;
  while ((match = nodePattern.exec(text)) !== null) {
    const [, name, parent] = match;
    if (!childrenByParent.has(parent)) { childrenByParent.set(parent, []); }
    childrenByParent.get(parent).push(name);
  }
  return childrenByParent;
}

/**
 * Parse a LayeredPortrait `.tscn` scene into node path (relative to the
 * scene root, the same shape `extra_data="set ..."` uses, e.g.
 * "Head/LeftEye") -> that node's type and `editor_description` - the
 * "Editor Description" field of the node's inspector, which is where a
 * layer can be documented from inside Godot. The root node itself is
 * skipped, same as in parseTscnNodeTree.
 *
 * @param {string} text - raw .tscn file content
 * @returns {Map<string, {type: string|null, description: string|null}>}
 */
function parseTscnNodeInfo(text) {
  const nodes = new Map();
  const headerPattern = /\[node\b([^\]]*)\]/g;
  let match;
  while ((match = headerPattern.exec(text)) !== null) {
    const attributes = match[1];
    const nameMatch = attributes.match(/\bname="([^"]+)"/);
    const parentMatch = attributes.match(/\bparent="([^"]*)"/);
    if (!nameMatch || !parentMatch) { continue; } // the scene root has no parent=
    const typeMatch = attributes.match(/\btype="([^"]+)"/);
    const bodyEnd = text.indexOf('\n[', headerPattern.lastIndex);
    const body = text.slice(headerPattern.lastIndex, bodyEnd === -1 ? text.length : bodyEnd);
    const descriptionMatch = body.match(/^editor_description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
    nodes.set(childNodePath(parentMatch[1], nameMatch[1]), {
      type: typeMatch ? typeMatch[1] : null,
      description: descriptionMatch ? descriptionMatch[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1') : null,
    });
  }
  return nodes;
}

// =============================================================================
// MOOD / EMOTION HELPERS
// =============================================================================

/**
 * The full path of a tree node, in the same "parent/child" shape Godot
 * itself uses for `parent="..."` attributes - i.e. how a node's own path
 * looks when used to look up ITS children.
 *
 * @param {string} parentPath - "." for the scene root
 * @param {string} name
 * @returns {string}
 */
function childNodePath(parentPath, name) {
  return parentPath === '.' ? name : `${parentPath}/${name}`;
}

// =============================================================================
// GLOSSARY
// =============================================================================
// Dialogic's glossaries (.tres DialogicGlossary resources listed in
// project.godot's `dialogic/glossary/glossary_files`): words that get a
// colored link in the game's text, with a title, a text and extra info.
// Here, those words get their color with a dotted underline in dialogue,
// narration and choices, and hovering one shows the entry.

/**
 * Read a GDScript literal value as text: a quoted string (unescaped), or
 * the raw value otherwise.
 *
 * @param {string|null} raw
 * @returns {string}
 */
function gdLiteralToText(raw) {
  if (raw === null || raw === undefined) { return ''; }
  const match = raw.match(/^&?"((?:[^"\\]|\\.)*)"$/);
  return match ? match[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(.)/g, '$1') : raw;
}

/**
 * The strings of a GDScript array literal - `["a", "b"]` or
 * `PackedStringArray("a", "b")`.
 *
 * @param {string|null} raw
 * @returns {string[]}
 */
function gdArrayToStrings(raw) {
  if (!raw) { return []; }
  const strings = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) { strings.push(match[1].replace(/\\(.)/g, '$1')); }
  return strings;
}

// =============================================================================
// PLAY IN GODOT
// =============================================================================
// Plays a timeline the way Dialogic's own "Play timeline" button does: it
// writes the timeline in Dialogic's editor settings
// (`user://dialogic/editor_settings.cfg`, section [DES]:
// `current_timeline_path`, `play_from_index`), then runs Dialogic's test
// scene, which starts that timeline.

/**
 * Set keys of one section of a Godot ConfigFile text, keeping everything
 * else as it is.
 *
 * @param {string} text - the file ('' for a new one)
 * @param {string} section
 * @param {Record<string, string>} values - key -> Godot literal
 * @returns {string}
 */
function setConfigFileValues(text, section, values) {
  const lines = text.split(/\r?\n/);
  let start = lines.findIndex(line => line.trim() === `[${section}]`);
  if (start === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') { lines.pop(); }
    if (lines.length > 0) { lines.push(''); }
    lines.push(`[${section}]`, '');
    start = lines.length - 2;
  }
  let end = lines.findIndex((line, index) => index > start && /^\[.*\]\s*$/.test(line.trim()));
  if (end === -1) { end = lines.length; }
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line, i) => i > start && i < end && line.startsWith(`${key}=`));
    if (index !== -1) { lines[index] = `${key}=${value}`; continue; }
    // After the section's last key - keeping the blank line Godot writes
    // under the section title.
    let insertAt = end;
    while (insertAt > start + 2 && lines[insertAt - 1].trim() === '') { insertAt--; }
    if (insertAt === start + 1) { lines.splice(insertAt++, 0, ''); end++; }
    lines.splice(insertAt, 0, `${key}=${value}`);
    end++;
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

// =============================================================================
// QUICK FIXES
// =============================================================================
// Lightbulb fixes (Ctrl+.) for the problems DTL Reader reports: the closest
// existing names for a typo, creating what's missing (a label, a portrait),
// and removing or closing what's wrong (a jump's #id, an unclosed BBCode
// tag). Each fix re-reads the line its diagnostic points at rather than
// storing data on the diagnostic, so it always matches the current text.

// -----------------------------------------------------------------------------
// Adding what's missing to project.godot
// -----------------------------------------------------------------------------
// An unknown character or variable may be a typo - or something new that
// the project doesn't have yet. These fixes write it where Dialogic keeps
// it, in project.godot's [dialogic] section: `variables` (the Dialogic
// variables, a nested dictionary of folders) and `directories/dch_directory`
// (character identifier -> .dch file, the identifier being the file name).
// The changed files are saved right away, so the project is re-read and
// the problem goes away.

/**
 * A string literal for a Godot dictionary key or value.
 *
 * @param {string} text
 * @returns {string}
 */
function godotString(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The index just past a string literal starting at `start` (a `"`).
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function skipGodotString(text, start) {
  let end = start + 1;
  while (end < text.length && text[end] !== '"') { end += text[end] === '\\' ? 2 : 1; }
  return end + 1;
}

/**
 * Walk the dictionary opening at `openIndex` (a `{`): where each of its own
 * keys' values starts, and where it closes. Strings are skipped whole, so
 * braces inside them don't count.
 *
 * @param {string} text
 * @param {number} openIndex
 * @returns {{entries: Map<string, number>, closeIndex: number} | null} null if it never closes
 */
function scanGodotDict(text, openIndex) {
  const entries = new Map();
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipGodotString(text, i);
      const colon = depth === 1 ? text.slice(end).match(/^\s*:\s*/) : null;
      if (colon) {
        let key = text.slice(i + 1, end - 1);
        try { key = JSON.parse(text.slice(i, end)); } catch (error) { /* an escape JSON doesn't know - keep it raw */ }
        entries.set(key, end + colon[0].length);
      }
      i = end - 1;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { return { entries, closeIndex: i }; }
    }
  }
  return null;
}

/**
 * The text of an edit adding one `key: value` entry at the end of the
 * dictionary opening at `openIndex`, one entry per line like Godot writes
 * them (a trailing comma already there is kept).
 *
 * @param {string} text
 * @param {number} openIndex
 * @param {string} entry - `"key": value`
 * @param {string} eol
 * @returns {{start: number, end: number, text: string} | null}
 */
function appendGodotDictEntry(text, openIndex, entry, eol) {
  const dict = scanGodotDict(text, openIndex);
  if (!dict) { return null; }
  const content = text.slice(openIndex + 1, dict.closeIndex).trimEnd();
  if (content.trim() === '') { return { start: openIndex + 1, end: dict.closeIndex, text: `${eol}${entry}${eol}` }; }
  const start = openIndex + 1 + content.length;
  return { start, end: start, text: `${content.endsWith(',') ? '' : ','}${eol}${entry}` };
}

Object.assign(module.exports, {
  extractBalancedBraces,
  scanDictEntries,
  parseNestedDictTree,
  extractSceneRootScriptPath,
  extractTopLevelDictEntries,
  parseGodotColor,
  parseTscnNodeTree,
  parseTscnNodeInfo,
  childNodePath,
  gdLiteralToText,
  gdArrayToStrings,
  setConfigFileValues,
  godotString,
  scanGodotDict,
  appendGodotDictEntry,
});
