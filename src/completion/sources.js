// -----------------------------------------------------------------------------
// Where suggestions come from: the project, or - without project.godot -
// the timeline itself.
// -----------------------------------------------------------------------------
const state = require('../state');
const syntax = require('../timeline/syntax');

// =============================================================================
// ISOLATED MODE (no project.godot)
// =============================================================================
// With a Godot project, autocomplete knows the project's characters,
// moods, variables, audio channels and files. Without one, a timeline is
// on its own: autocomplete then offers what the timeline itself already
// uses - its speakers and joined characters, their (mood) tags, its
// {variables}, its audio channels and its res:// paths - so it stays
// useful while never pretending to know the project.

/**
 * Scan a timeline for its own characters, moods, variables, audio
 * channels and res:// paths.
 *
 * @param {vscode.TextDocument} document
 * @param {number} [skipLine] - the line being typed: a half-written name or path there isn't something the timeline uses yet
 */
function collectIsolatedDocumentData(document, skipLine) {
  const data = { characters: new Set(), moods: new Map(), variables: new Map(), audio: new Set(), paths: new Set() };
  const commandPattern = new RegExp(`^\\s*(?:join|update|leave)\\s+(${syntax.CHARACTER_NAME_SOURCE})(?:\\s*\\(([\\p{L}_][\\p{L}0-9_]*)\\))?`, 'u');
  const addMood = (name, mood) => {
    if (!mood) { return; }
    if (!data.moods.has(name)) { data.moods.set(name, new Set()); }
    data.moods.get(name).add(mood);
  };
  for (let line = 0; line < document.lineCount; line++) {
    if (line === skipLine) { continue; }
    const text = document.lineAt(line).text;
    const command = text.match(commandPattern);
    if (command) {
      const name = syntax.stripCharacterNameQuotes(command[1]);
      if (name !== '--All--') { data.characters.add(name); addMood(name, command[2]); }
    } else {
      const speaker = syntax.findLineSpeaker(text);
      if (speaker) { data.characters.add(speaker.name); addMood(speaker.name, speaker.mood); }
    }
    const audio = text.match(/^\s*audio\s+([^\s"]+)/);
    if (audio) { data.audio.add(audio[1]); }
    for (const match of text.matchAll(/res:\/\/[^"'\s\]]+/g)) { data.paths.add(match[0]); }
    for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g)) {
      let level = data.variables;
      const segments = match[1].split('.');
      segments.forEach((segment, index) => {
        const isLeaf = index === segments.length - 1;
        if (!level.has(segment)) { level.set(segment, { value: null, children: isLeaf ? null : new Map() }); }
        const entry = level.get(segment);
        if (!isLeaf && !entry.children) { entry.children = new Map(); } // also used as a folder
        level = entry.children;
      });
    }
  }
  return data;
}

/** Characters for autocomplete: the project's, else the timeline's own. @returns {string[]} */
function completionCharacterNames() {
  return state.projectRootUri || !state.isolatedDocumentData ? state.cachedCharacterNames : [...state.isolatedDocumentData.characters];
}

/** A character's moods for autocomplete: the project's (mood -> LayeredPortrait tree), else the ones the timeline gives them. */
function completionCharacterMoods(name) {
  if (state.projectRootUri || !state.isolatedDocumentData) { return state.cachedCharacterMoods.get(name); }
  const moods = state.isolatedDocumentData.moods.get(name);
  return moods ? new Map([...moods].map(mood => [mood, null])) : undefined;
}

/** Variables tree for autocomplete: project.godot's, else the {variables} the timeline uses. */
function completionVariablesTree() {
  return state.projectRootUri || !state.isolatedDocumentData ? state.cachedVariablesTree : state.isolatedDocumentData.variables;
}

/** Audio channels for autocomplete: the project's, else the ones the timeline uses. @returns {string[]} */
function completionAudioChannels() {
  return state.projectRootUri || !state.isolatedDocumentData ? state.cachedAudioChannels : [...state.isolatedDocumentData.audio];
}

/** res:// paths for autocomplete: the project's files, else the paths the timeline already uses. @returns {string[]} */
function completionResourcePaths() {
  return state.projectRootUri || !state.isolatedDocumentData ? state.cachedResourcePaths : [...state.isolatedDocumentData.paths];
}

Object.assign(module.exports, {
  collectIsolatedDocumentData,
  completionCharacterNames,
  completionCharacterMoods,
  completionVariablesTree,
  completionAudioChannels,
  completionResourcePaths,
});
