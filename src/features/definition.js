// -----------------------------------------------------------------------------
// Go to Definition (Ctrl+Click).
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const syntax = require('../timeline/syntax');
const autoloads = require('../timeline/autoloads');
const timelineMoods = require('../timeline/moods');
const project = require('../project');
const dchParse = require('../dch/parse');
const glossaryFeature = require('./glossary');

// =============================================================================
// GO TO DEFINITION
// =============================================================================
// Ctrl+Click / F12 in a timeline: a jump leads to its label, a character to
// their .dch file, a mood to its portrait there, a `res://` path to its file,
// an autoload reference to its script (on the member's line) and a glossary
// word to its entry. In a .dch file: paths, and `default_portrait` to that
// portrait. Each result is a link, so the whole name (quotes, spaces, the
// full path) is underlined, not only the word under the mouse.

/**
 * A definition link from `originRange` to a place in a file.
 *
 * @param {vscode.Range} originRange
 * @param {vscode.Uri} uri
 * @param {vscode.Range} [targetRange] - defaults to the start of the file
 * @returns {vscode.LocationLink[]}
 */
function definitionLink(originRange, uri, targetRange = new vscode.Range(0, 0, 0, 0)) {
  return [{ originSelectionRange: originRange, targetUri: uri, targetRange, targetSelectionRange: targetRange }];
}

/**
 * The `res://` path under the cursor, if any - in quotes, in a `[img]`
 * tag, or inside a .dch image override (`"\"res://...\""`).
 *
 * @param {string} line
 * @param {number} character
 * @returns {{path: string, start: number, end: number} | null}
 */
function findResourcePathAtPosition(line, character) {
  const pattern = /res:\/\/[^"'\s[\]\\]+/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const end = match.index + match[0].length;
    if (character >= match.index && character <= end) { return { path: match[0], start: match.index, end }; }
  }
  return null;
}

/**
 * Definition of a `res://` path: the file, when it exists in the project.
 *
 * @param {number} line
 * @param {{path: string, start: number, end: number}} resource
 * @returns {vscode.LocationLink[] | undefined}
 */
function resourceDefinition(line, resource) {
  if (!state.projectRootUri) { return undefined; }
  if (state.cachedResourcePaths.length > 0 && !state.cachedResourcePaths.includes(resource.path)) { return undefined; }
  return definitionLink(new vscode.Range(line, resource.start, line, resource.end), project.resolveResourcePath(resource.path));
}

/**
 * The portrait name of a `[portrait=name]` text effect under the cursor,
 * with the line's speaker.
 *
 * @param {string} line
 * @param {number} character
 * @returns {{characterName: string, mood: string, range: {start: number, end: number}} | null}
 */
function findPortraitEffectAtPosition(line, character) {
  const speaker = syntax.findLineSpeaker(line);
  if (!speaker) { return null; }
  const pattern = /\[portrait=([^\]\s]+)\]/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const start = match.index + '[portrait='.length;
    const end = start + match[1].length;
    if (character >= start && character <= end) { return { characterName: speaker.name, mood: match[1], range: { start, end } }; }
  }
  return null;
}

/**
 * Definition of a mood: its portrait in the character's .dch file.
 *
 * @param {vscode.Range} originRange
 * @param {string} characterName
 * @param {string} mood
 * @returns {Promise<vscode.LocationLink[] | undefined>}
 */
async function portraitDefinition(originRange, characterName, mood) {
  const dchPath = state.cachedCharacterPaths.get(characterName);
  if (!dchPath) { return undefined; }
  try {
    const dchDocument = await vscode.workspace.openTextDocument(project.resolveResourcePath(dchPath));
    const range = dchParse.findDchPortraitRange(dchDocument, mood);
    return range ? definitionLink(originRange, dchDocument.uri, range) : undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Definition of an autoload reference: the autoload's script (or scene),
 * on the member's declaration line - for an enum value, the value's own
 * line inside the enum.
 *
 * @param {NonNullable<ReturnType<typeof locateAutoloadReferenceAtPosition>>} reference
 * @returns {Promise<vscode.LocationLink[] | undefined>}
 */
async function autoloadDefinition(reference) {
  const { symbols, part, memberName, subName, range } = reference;
  if (part === 'global') {
    return definitionLink(range, project.resolveResourcePath(symbols.scenePath || symbols.scriptPath));
  }
  const member = autoloads.findAutoloadMember(symbols, memberName);
  if (!member || typeof member.info.line !== 'number') { return undefined; }
  const uri = project.resolveResourcePath(symbols.scriptPath);
  let line = member.info.line;
  let character = 0;
  try {
    const script = await vscode.workspace.openTextDocument(uri);
    const name = part === 'value' ? subName : memberName;
    const namePattern = new RegExp(`\\b${name}\\b`);
    // An enum value may sit on a later line than `enum Name {`.
    for (let candidate = line; candidate < Math.min(script.lineCount, line + (part === 'value' ? 200 : 1)); candidate++) {
      const found = script.lineAt(candidate).text.search(namePattern);
      if (found !== -1) { line = candidate; character = found; break; }
    }
    const nameRange = new vscode.Range(line, character, line, character + name.length);
    return definitionLink(range, uri, nameRange);
  } catch (error) {
    return definitionLink(range, uri, new vscode.Range(line, 0, line, 0));
  }
}

/**
 * Definition of a `jump` target: the label (in this timeline or another
 * one), or the other timeline itself for its `Timeline/` part.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {NonNullable<ReturnType<typeof parseJumpLine>>} jump
 * @returns {vscode.LocationLink[] | undefined}
 */
function jumpDefinition(document, position, jump) {
  if (jump.target.includes('{') || position.character < jump.targetStart) { return undefined; }
  const target = project.resolveJumpTarget(document, jump);
  if (!target) { return undefined; }
  const line = position.line;
  // On the timeline part, or `jump Timeline/` with no label: open the
  // timeline itself.
  if (position.character < jump.labelStart || !jump.label) {
    return definitionLink(new vscode.Range(line, jump.targetStart, line, jump.labelStart - (jump.timeline === null ? 0 : 1)), target.uri);
  }
  const labelInfo = target.labels.get(jump.label);
  if (!labelInfo) { return undefined; }
  const labelRange = new vscode.Range(labelInfo.line, labelInfo.nameStart, labelInfo.line, labelInfo.nameStart + jump.label.length);
  return definitionLink(new vscode.Range(line, jump.labelStart, line, jump.labelStart + jump.label.length), target.uri, labelRange);
}

/**
 * Go to Definition (Ctrl+Click / F12) in a timeline.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<vscode.LocationLink[] | vscode.Location | undefined>}
 */
async function provideTimelineDefinition(document, position) {
  const line = position.line;
  const text = document.lineAt(line).text;
  // Only a real `jump` command line (anchored to line start), not the word
  // "jump" inside a comment or spoken dialogue text.
  const jump = syntax.parseJumpLine(text);
  if (jump) { return jumpDefinition(document, position, jump); }
  const resource = findResourcePathAtPosition(text, position.character);
  if (resource) { return resourceDefinition(line, resource); }
  const mood = timelineMoods.findMoodTagAtPosition(text, position.character) || findPortraitEffectAtPosition(text, position.character);
  if (mood) { return portraitDefinition(new vscode.Range(line, mood.range.start, line, mood.range.end), mood.characterName, mood.mood); }
  const character = syntax.findCharacterNameAtPosition(document, position);
  if (character) {
    const dchPath = state.cachedCharacterPaths.get(character.name);
    return dchPath && state.projectRootUri ? definitionLink(character.range, project.resolveResourcePath(dchPath)) : undefined;
  }
  const autoload = autoloads.locateAutoloadReferenceAtPosition(document, position);
  if (autoload) { return autoloadDefinition(autoload); }
  // Anywhere else in text: a glossary word leads to its entry.
  return glossaryFeature.provideGlossaryDefinition(document, position);
}

/**
 * Go to Definition in a .dch file: a `res://` path to its file, and the
 * `default_portrait` value to that portrait.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.LocationLink[] | undefined}
 */
function provideDchDefinition(document, position) {
  const line = position.line;
  const text = document.lineAt(line).text;
  const resource = findResourcePathAtPosition(text, position.character);
  if (resource) { return resourceDefinition(line, resource); }
  const defaultMatch = text.match(/^(\s*&?"default_portrait"\s*:\s*")([^"]+)"/);
  if (!defaultMatch) { return undefined; }
  const start = defaultMatch[1].length;
  const end = start + defaultMatch[2].length;
  if (position.character < start || position.character > end) { return undefined; }
  const range = dchParse.findDchPortraitRange(document, defaultMatch[2]);
  return range ? definitionLink(new vscode.Range(line, start, line, end), document.uri, range) : undefined;
}

Object.assign(module.exports, {
  provideTimelineDefinition,
  provideDchDefinition,
});
