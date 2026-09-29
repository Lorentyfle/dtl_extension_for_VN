// -----------------------------------------------------------------------------
// Reading Dialogic character files (.dch).
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const resources = require('../godot/resources');

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/**
 * @typedef {{
 *   scene: string|null,
 *   image: string|null,
 *   mirror: boolean,
 *   offset: string|null,
 *   scale: string|null
 * }} DchPortraitInfo
 */

/**
 * Parse a `.dch` character file's `"portraits"` dictionary into mood name
 * -> its declared settings: the LayeredPortrait/custom `scene` `res://`
 * path (null for a plain single-image portrait), the `image` set in its
 * `export_overrides` (if any), and its mirror/offset/scale. The file uses
 * GDScript-ish resource syntax (`&"key": value` dictionaries), so this
 * walks brace-balanced blocks rather than treating it as JSON.
 *
 * @param {string} text - raw .dch file content
 * @returns {Map<string, DchPortraitInfo>}
 */
function parseDchPortraits(text) {
  const portraits = new Map();
  const portraitsHeaderMatch = text.match(/&?"portraits"\s*:\s*\{/);
  if (!portraitsHeaderMatch) { return portraits; }
  const openBraceIndex = portraitsHeaderMatch.index + portraitsHeaderMatch[0].length - 1;
  const body = resources.extractBalancedBraces(text, openBraceIndex);
  if (body === null) { return portraits; }

  for (const { key, body: moodBody } of resources.extractTopLevelDictEntries(body)) {
    const sceneMatch = moodBody.match(/&?"scene"\s*:\s*"([^"]*)"/);
    // export_overrides values are GDScript literals stored as strings, so
    // an image path looks like "\"res://...png\"" - quotes are optional.
    const imageMatch = moodBody.match(/&?"image"\s*:\s*"(?:\\")?([^"\\]*)/);
    const mirrorMatch = moodBody.match(/&?"mirror"\s*:\s*(true|false)/);
    const offsetMatch = moodBody.match(/&?"offset"\s*:\s*(Vector2i?\([^)]*\))/);
    const scaleMatch = moodBody.match(/&?"scale"\s*:\s*([\d.]+)/);
    portraits.set(key, {
      scene: sceneMatch && sceneMatch[1] ? sceneMatch[1] : null,
      image: imageMatch && imageMatch[1] ? imageMatch[1] : null,
      mirror: !!mirrorMatch && mirrorMatch[1] === 'true',
      offset: offsetMatch ? offsetMatch[1] : null,
      scale: scaleMatch ? scaleMatch[1] : null,
    });
  }
  return portraits;
}

/**
 * Parse a `.dch` character file's documentation-relevant fields - used to
 * build the hover shown when hovering that character's name. Any field
 * that isn't declared is simply left `null`/empty; a character with none
 * of these declared just has no hover.
 *
 * @param {string} text - raw .dch file content
 * @returns {{displayName: string|null, nicknames: string[], description: string|null, color: string|null, defaultPortrait: string|null}}
 */
function parseDchCharacterInfo(text) {
  const displayNameMatch = text.match(/&?"display_name"\s*:\s*"([^"]*)"/);
  const defaultPortraitMatch = text.match(/&?"default_portrait"\s*:\s*"([^"]*)"/);
  const translationIdMatch = text.match(/&?"_translation_id"\s*:\s*"([^"]*)"/);
  const descriptionMatch = text.match(/&?"description"\s*:\s*"([^"]*)"/);
  const colorMatch = text.match(/&?"color"\s*:\s*(Color\([^)]*\))/);

  const nicknames = [];
  const nicknamesMatch = text.match(/&?"nicknames"\s*:\s*\[([^\]]*)\]/);
  if (nicknamesMatch) {
    const itemPattern = /"([^"]*)"/g;
    let match;
    while ((match = itemPattern.exec(nicknamesMatch[1])) !== null) {
      const nickname = match[1].trim();
      if (nickname !== '') { nicknames.push(nickname); } // skip blanks, e.g. a stray [""]
    }
  }

  return {
    displayName: displayNameMatch ? displayNameMatch[1] : null,
    nicknames,
    description: descriptionMatch ? descriptionMatch[1] : null,
    color: colorMatch ? resources.parseGodotColor(colorMatch[1]) : null,
    defaultPortrait: defaultPortraitMatch && defaultPortraitMatch[1] ? defaultPortraitMatch[1] : null,
    translationId: translationIdMatch && translationIdMatch[1] ? translationIdMatch[1] : null,
  };
}

// =============================================================================
// DIALOGIC CHARACTER FILES (.dch)
// =============================================================================
// A .dch file is Godot's var_to_str() of inst_to_dict(DialogicCharacter):
// a GDScript-literal dictionary. These describe its keys, per nesting level,
// for autocomplete and hover. Taken from Dialogic's own DialogicCharacter
// resource (addons/dialogic/Resources/character.gd) and character editor.

/**
 * Walk a .dch document up to `stopOffset`, tracking which dictionary /
 * list the scanner is in (with the key each one is the value of), whether
 * a key or a value is expected next, and every key token seen with its
 * path - e.g. `portraits` > `Happy` > `scene`. Strings are skipped as a
 * whole (escapes included) so braces/colons inside them don't count.
 *
 * @param {string} text
 * @param {number} [stopOffset] - defaults to the whole text
 * @returns {{
 *   stack: {kind: 'dict'|'list', key: string|null, keys: Set<string>}[],
 *   state: 'key'|'value'|'after',
 *   pendingKey: string|null,
 *   valueStart: number,
 *   keyTokens: {name: string, start: number, end: number, path: string[]}[],
 *   openString: {start: number, text: string} | null
 * }}
 */
function scanDch(text, stopOffset = text.length) {
  const stack = [];
  const keyTokens = [];
  let state = 'value';
  let pendingKey = null;
  let lastString = null;
  let valueStart = 0;
  const pathOf = () => stack.map(container => container.key).slice(1);
  for (let i = 0; i < stopOffset; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i > 0 && text[i - 1] === '&' ? i - 1 : i;
      let end = i + 1;
      while (end < text.length && text[end] !== '"') { end += text[end] === '\\' ? 2 : 1; }
      if (end >= stopOffset) {
        return { stack, state, pendingKey, valueStart, keyTokens, openString: { start, text: text.slice(i + 1, stopOffset) } };
      }
      lastString = { value: text.slice(i + 1, end), start, end: end + 1 };
      i = end;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === '{' || ch === '[') {
      stack.push({ kind: ch === '{' ? 'dict' : 'list', key: pendingKey, keys: new Set() });
      pendingKey = null;
      state = ch === '{' ? 'key' : 'value';
      valueStart = i + 1;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      state = 'after';
    } else if (ch === ':' && top && top.kind === 'dict' && lastString) {
      pendingKey = lastString.value;
      top.keys.add(pendingKey);
      keyTokens.push({ name: lastString.value, start: lastString.start, end: lastString.end, path: pathOf() });
      state = 'value';
      valueStart = i + 1;
    } else if (ch === ',') {
      state = top && top.kind === 'dict' ? 'key' : 'value';
      if (top && top.kind === 'dict') { pendingKey = null; }
      valueStart = i + 1;
    }
  }
  return { stack, state, pendingKey, valueStart, keyTokens, openString: null };
}

/**
 * The sound mood names declared in a .dch file (`custom_info` >
 * `sound_moods` keys).
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseDchSoundMoods(text) {
  return scanDch(text).keyTokens
    .filter(token => token.path.length === 2 && token.path[0] === 'custom_info' && token.path[1] === 'sound_moods')
    .map(token => token.name);
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
 * Find a portrait's name in a .dch file, as the range of its key.
 *
 * @param {vscode.TextDocument} dchDocument
 * @param {string} mood
 * @returns {vscode.Range | null}
 */
function findDchPortraitRange(dchDocument, mood) {
  const token = scanDch(dchDocument.getText()).keyTokens.find(candidate => candidate.path.length === 1 && candidate.path[0] === 'portraits' && candidate.name === mood);
  return token ? new vscode.Range(dchDocument.positionAt(token.start), dchDocument.positionAt(token.end)) : null;
}

Object.assign(module.exports, {
  parseDchPortraits,
  parseDchCharacterInfo,
  scanDch,
  parseDchSoundMoods,
  findDchPortraitRange,
});
