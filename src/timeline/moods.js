// -----------------------------------------------------------------------------
// Moods and portraits (`Name (mood)`, `[extra_data="set Layer"]`):
// suggestions, documentation and finding them under the cursor.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const resources = require('../godot/resources');
const syntax = require('./syntax');
const sources = require('../completion/sources');

// =============================================================================
// MOOD / EMOTION HELPERS
// =============================================================================

/**
 * Detect a `(mood` being typed right after a character name - either as a
 * dialogue speaker's mood tag (`John (happy`) or after join/update's
 * character argument (`join John (happy`).
 *
 * @param {string} beforeCursor
 * @returns {{character: string, typedMood: string} | null}
 */
function detectMoodContext(beforeCursor) {
  const dialogueMatch = beforeCursor.match(new RegExp(`^\\s*(${syntax.CHARACTER_NAME_SOURCE})\\s*\\(([\\p{L}_][\\p{L}0-9_]*)?$`, 'u'));
  if (dialogueMatch) {
    const character = syntax.stripCharacterNameQuotes(dialogueMatch[1]);
    if (!syntax.RESERVED_LINE_KEYWORDS.has(character)) {
      return { character, typedMood: dialogueMatch[2] || '' };
    }
  }
  const commandMatch = beforeCursor.match(new RegExp(`^\\s*(?:join|update)\\s+(${syntax.CHARACTER_NAME_SOURCE})\\s*\\(([\\p{L}_][\\p{L}0-9_]*)?$`, 'u'));
  if (commandMatch) {
    return { character: syntax.stripCharacterNameQuotes(commandMatch[1]), typedMood: commandMatch[2] || '' };
  }
  return null;
}

/**
 * Completion item for a mood name, e.g. `happy` in `John (happy):`.
 *
 * @param {string} name
 * @param {boolean} hasSceneTree - true if this mood is a LayeredPortrait
 *   backed by a parsed .tscn scene (vs. a plain single-image portrait)
 * @returns {vscode.CompletionItem}
 */
function createMoodCompletion(name, hasSceneTree) {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
  item.detail = hasSceneTree ? 'DTL mood (LayeredPortrait)' : 'DTL mood';
  return item;
}

/**
 * Build `(mood)` completions for a character, from cachedCharacterMoods.
 *
 * @param {string} character
 * @param {string} typedMood - mood text typed so far
 * @returns {vscode.CompletionItem[]}
 */
function createMoodSuggestions(character, typedMood) {
  const moods = sources.completionCharacterMoods(character);
  if (!moods) { return []; }
  const prefix = typedMood.toLowerCase();
  const items = [];
  for (const [moodName, tree] of moods) {
    if (moodName.toLowerCase().startsWith(prefix)) {
      items.push(createMoodCompletion(moodName, !!tree));
    }
  }
  return items;
}

/**
 * Find the character named on a `join`/`update` line, resolve their mood
 * (from a `(mood)` tag if present and it has a scene, else whichever
 * portrait does have a scene - `leave` is excluded since its `variables`
 * don't include `extra_data` at all), and return that mood's parsed
 * LayeredPortrait node tree, if any.
 *
 * @param {string} lineText
 * @returns {Map<string, string[]> | null}
 */
function findMoodTreeForLine(lineText) {
  const layeredMood = findLayeredMoodForLine(lineText);
  return layeredMood ? state.cachedCharacterMoods.get(layeredMood.character).get(layeredMood.mood) : null;
}

/**
 * Same resolution as findMoodTreeForLine, but returning which character
 * and mood were picked - needed to also look up that mood's
 * cachedPortraitDetails (node types/descriptions) for the hover.
 *
 * @param {string} lineText
 * @returns {{character: string, mood: string} | null}
 */
function findLayeredMoodForLine(lineText) {
  const commandMatch = lineText.match(new RegExp(`^\\s*(?:join|update)\\s+(${syntax.CHARACTER_NAME_SOURCE})`, 'u'));
  if (!commandMatch) { return null; }
  const character = syntax.stripCharacterNameQuotes(commandMatch[1]);
  const moods = state.cachedCharacterMoods.get(character);
  if (!moods) { return null; }

  const moodTagMatch = lineText.match(new RegExp(`^\\s*(?:join|update)\\s+${syntax.CHARACTER_NAME_SOURCE}\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\)`, 'u'));
  if (moodTagMatch && moods.get(moodTagMatch[1])) {
    return { character, mood: moodTagMatch[1] };
  }
  // No usable mood tag typed yet - fall back to whichever portrait does
  // have a scene, since that's the only one extra_data's node path could
  // possibly refer to.
  for (const [mood, tree] of moods) {
    if (tree) { return { character, mood }; }
  }
  return null;
}

/**
 * Find the `(mood)` tag under the cursor - after a dialogue speaker
 * (`John (happy):`) or join/update's character (`join John (happy)`).
 *
 * @param {string} line
 * @param {number} character - cursor column
 * @returns {{characterName: string, mood: string, range: {start: number, end: number}} | null}
 */
function findMoodTagAtPosition(line, character) {
  const tagMatch = line.match(new RegExp(`^(\\s*(?:(?:join|update)\\s+)?(${syntax.CHARACTER_NAME_SOURCE})\\s*\\()([\\p{L}_][\\p{L}0-9_]*)\\)`, 'u'));
  if (!tagMatch) { return null; }
  const characterName = syntax.stripCharacterNameQuotes(tagMatch[2]);
  if (syntax.RESERVED_LINE_KEYWORDS.has(characterName)) { return null; }
  const start = tagMatch[1].length;
  const end = start + tagMatch[3].length;
  if (character < start || character > end) { return null; }
  return { characterName, mood: tagMatch[3], range: { start, end } };
}

/**
 * Build the hover shown for a mood/portrait tag: which character it
 * belongs to, whether it's their default portrait, what it displays (a
 * LayeredPortrait/custom scene with its top-level layers, or a single
 * image), and any non-default mirror/offset/scale - plus every other mood
 * that character has, for reference.
 *
 * @param {string} characterName
 * @param {string} mood
 * @returns {vscode.MarkdownString | null} null if the character is unknown
 */
function createMoodDocumentation(characterName, mood) {
  const details = state.cachedPortraitDetails.get(characterName);
  if (!details) { return null; }
  const info = state.cachedCharacterInfo.get(characterName) || {};
  const portrait = details.get(mood);
  const markdown = new vscode.MarkdownString();
  const displayName = info.displayName || characterName;
  if (!portrait) {
    markdown.appendMarkdown(`**${mood}** _(unknown mood of ${displayName})_\n\n`);
  } else {
    const isDefault = info.defaultPortrait === mood;
    const kind = portrait.scene ? (portrait.nodes && portrait.nodes.size > 0 ? 'LayeredPortrait' : 'custom scene portrait') : 'portrait';
    markdown.appendMarkdown(`**${mood}** _(${kind} of ${displayName}${isDefault ? ', default' : ''})_\n\n`);
    if (portrait.scene) { markdown.appendMarkdown(`Scene: \`${portrait.scene}\`\n\n`); }
    if (portrait.image) { markdown.appendMarkdown(`Image: \`${portrait.image}\`\n\n`); }
    const tweaks = [];
    if (portrait.mirror) { tweaks.push('mirrored'); }
    if (portrait.scale && Number(portrait.scale) !== 1) { tweaks.push(`scale ${portrait.scale}`); }
    if (portrait.offset && !/^Vector2i?\(\s*0(?:\.0)?\s*,\s*0(?:\.0)?\s*\)$/.test(portrait.offset)) { tweaks.push(`offset ${portrait.offset}`); }
    if (tweaks.length > 0) { markdown.appendMarkdown(`_${tweaks.join(', ')}_\n\n`); }
    const tree = (state.cachedCharacterMoods.get(characterName) || new Map()).get(mood);
    const layers = tree ? tree.get('.') || [] : [];
    if (layers.length > 0) {
      markdown.appendMarkdown(`**Layers** (for \`extra_data="set ..."\`): ${layers.map(layer => `\`${layer}\``).join(', ')}\n\n`);
    }
  }
  const otherMoods = [...details.keys()].filter(name => name !== mood);
  if (otherMoods.length > 0) {
    markdown.appendMarkdown(`Other moods: ${otherMoods.map(name => `\`${name}\``).join(', ')}`);
  }
  return markdown;
}

/**
 * Find the LayeredPortrait layer under the cursor inside an
 * `extra_data="set Head/LeftEye"` value, and document it: its full path,
 * node type, the `editor_description` written for it in Godot, and its
 * child layers. Hovering `Head` documents `Head`, hovering `LeftEye`
 * documents `Head/LeftEye`.
 *
 * @param {string} line
 * @param {number} character - cursor column
 * @returns {{markdown: vscode.MarkdownString, range: {start: number, end: number}} | null}
 */
function findLayerDocumentationAtPosition(line, character) {
  const valueMatch = line.match(/\bextra_data\s*=\s*"set\s+([^"]*)"/);
  if (!valueMatch) { return null; }
  const valueStart = valueMatch.index + valueMatch[0].length - 1 - valueMatch[1].length;
  const segmentPattern = /[^/]+/g;
  const segments = [];
  let segmentMatch;
  while ((segmentMatch = segmentPattern.exec(valueMatch[1])) !== null) {
    segments.push(segmentMatch[0]);
    const start = valueStart + segmentMatch.index;
    const end = start + segmentMatch[0].length;
    if (character < start || character > end) { continue; }

    const layeredMood = findLayeredMoodForLine(line);
    if (!layeredMood) { return null; }
    const tree = state.cachedCharacterMoods.get(layeredMood.character).get(layeredMood.mood);
    const details = state.cachedPortraitDetails.get(layeredMood.character).get(layeredMood.mood);
    const path = segments.join('/');
    const node = details && details.nodes ? details.nodes.get(path) : null;
    const markdown = new vscode.MarkdownString();
    if (!node) {
      markdown.appendMarkdown(`**${path}** _(no such layer in ${layeredMood.character}'s "${layeredMood.mood}" portrait)_`);
      return { markdown, range: { start, end } };
    }
    markdown.appendMarkdown(`**${path}** _(${node.type ? node.type + ' ' : ''}layer of ${layeredMood.character}'s "${layeredMood.mood}" portrait)_\n\n`);
    markdown.appendMarkdown(node.description ? `${node.description}\n\n` : '_No Editor Description set on this node in Godot._\n\n');
    const children = tree ? tree.get(path) || [] : [];
    if (children.length > 0) {
      markdown.appendMarkdown(`Children: ${children.map(child => `\`${child}\``).join(', ')}`);
    }
    return { markdown, range: { start, end } };
  }
  return null;
}

/**
 * Completion item for one segment of an `extra_data="set ..."` node path.
 * Nodes with children of their own re-trigger suggestions once '/' is
 * typed, via the Folder kind plus a re-trigger command.
 *
 * @param {string} name
 * @param {boolean} hasChildren
 * @returns {vscode.CompletionItem}
 */
function createEmotionNodeCompletion(name, hasChildren) {
  const item = new vscode.CompletionItem(name, hasChildren ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.EnumMember);
  item.detail = 'LayeredPortrait node';
  if (hasChildren) {
    item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL child nodes' };
  }
  return item;
}

/**
 * Build `extra_data="set ..."` node-path completions for the character
 * (and mood, if typed) on the given line, walking the parsed
 * LayeredPortrait node tree one path segment at a time - typing
 * `Head/Left_Eye/` lists that node's children, matching how the tree
 * itself is nested.
 *
 * @param {string} lineText - full text of the current line
 * @param {string} typedValue - raw text typed so far after `extra_data=` (quote included, if any)
 * @returns {vscode.CompletionItem[]}
 */
function createEmotionPathSuggestions(lineText, typedValue) {
  const afterQuote = typedValue.startsWith('"') ? typedValue.slice(1) : typedValue;
  // Only "set <path>" values carry a node path - anything else (or "set "
  // not typed yet) has nothing to suggest.
  const setMatch = afterQuote.match(/^set\s+(.*)$/);
  if (!setMatch) { return []; }
  const typedPath = setMatch[1];

  const tree = findMoodTreeForLine(lineText);
  if (!tree) { return []; }

  const lastSlash = typedPath.lastIndexOf('/');
  const parentPath = lastSlash === -1 ? '.' : (typedPath.slice(0, lastSlash) || '.');
  const prefix = (lastSlash === -1 ? typedPath : typedPath.slice(lastSlash + 1)).toLowerCase();

  const children = tree.get(parentPath) || [];
  return children
    .filter(name => name.toLowerCase().startsWith(prefix))
    .map(name => createEmotionNodeCompletion(name, tree.has(resources.childNodePath(parentPath, name))));
}

Object.assign(module.exports, {
  detectMoodContext,
  createMoodSuggestions,
  findMoodTagAtPosition,
  createMoodDocumentation,
  findLayerDocumentationAtPosition,
  createEmotionPathSuggestions,
});
