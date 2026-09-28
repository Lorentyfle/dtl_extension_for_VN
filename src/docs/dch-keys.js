// -----------------------------------------------------------------------------
// The keys of a Dialogic character file (.dch), with their documentation.
// -----------------------------------------------------------------------------
// =============================================================================
// DIALOGIC CHARACTER FILES (.dch)
// =============================================================================
// A .dch file is Godot's var_to_str() of inst_to_dict(DialogicCharacter):
// a GDScript-literal dictionary. These describe its keys, per nesting level,
// for autocomplete and hover. Taken from Dialogic's own DialogicCharacter
// resource (addons/dialogic/Resources/character.gd) and character editor.

/** @type {string} */
const DIALOGIC_CHARACTER_DOCS_URL = 'https://docs.dialogic.pro/characters-and-portraits.html';

/**
 * Top-level keys of a .dch file.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_CHARACTER_KEYS = {
  'display_name': { type: 'String', value: '""', doc: 'Name shown in the dialogue name label. Can contain spaces and use variables, e.g. `{player_name}`.' },
  'nicknames': { type: 'Array', value: '[""]', doc: 'Other names the character is recognized by: writing any of them in dialogue text is colored/linked to this character, like its display name.' },
  'color': { type: 'Color', value: 'Color(1, 1, 1, 1)', doc: 'Color of the character\'s name label, and of its name when it appears in text (if enabled in the Text settings).' },
  'description': { type: 'String', value: '""', doc: 'Free notes about the character, for the writers only - never shown in game. Shown by DTL Reader when hovering the character in a timeline.' },
  'scale': { type: 'float', value: '1.0', doc: 'Scale applied to all of the character\'s portraits (a portrait can opt out with `ignore_char_scale`).' },
  'offset': { type: 'Vector2', value: 'Vector2(0, 0)', doc: 'Offset in pixels applied to all of the character\'s portraits, on top of each portrait\'s own offset.' },
  'mirror': { type: 'bool', value: 'false', doc: 'Mirrors all of the character\'s portraits horizontally.' },
  'default_portrait': { type: 'String', value: '""', doc: 'Portrait used when none is given, e.g. `join Laripo left` without a `(mood)`. Must be one of the `portraits` keys.' },
  'portraits': { type: 'Dictionary', value: '{}', doc: 'Every portrait (mood) of the character, by name. The names are what `(mood)` tags use in timelines, e.g. `join Laripo (happy) left`.' },
  'custom_info': { type: 'Dictionary', value: '{}', doc: 'Extra data used by Dialogic modules and your own code (e.g. the typing sound settings, a custom style), edited in the character editor\'s other tabs.' },
  '@path': { type: 'String', value: '"res://addons/dialogic/Resources/character.gd"', doc: 'Written by Godot\'s `inst_to_dict()`: the script this dictionary is an instance of. Leave it as is.' },
  '@subpath': { type: 'NodePath', value: 'NodePath("")', doc: 'Written by Godot\'s `inst_to_dict()`. Leave it as is.' },
};

/**
 * Keys of one portrait inside `portraits`.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_PORTRAIT_KEYS = {
  'scene': { type: 'String', value: '""', doc: 'Portrait scene (`.tscn`) to display, e.g. a LayeredPortrait. Leave empty to use Dialogic\'s default portrait scene, which shows the `image` set in `export_overrides`.' },
  'export_overrides': { type: 'Dictionary', value: '{}', doc: 'Values for the portrait scene\'s `@export` variables, e.g. `image` for the default scene. Each value is a GDScript expression stored as a string, so a path is written `"\\"res://...png\\""`.' },
  'scale': { type: 'float', value: '1.0', doc: 'Scale of this portrait, multiplied with the character\'s `scale` (unless `ignore_char_scale` is on).' },
  'offset': { type: 'Vector2', value: 'Vector2(0, 0)', doc: 'Offset in pixels of this portrait, added to the character\'s `offset`.' },
  'mirror': { type: 'bool', value: 'false', doc: 'Mirrors this portrait horizontally (combined with the character\'s `mirror`).' },
  'ignore_char_scale': { type: 'bool', value: 'false', doc: 'If true, this portrait ignores the character\'s `scale` and only uses its own.' },
  'sound_mood': { type: 'String', value: '""', doc: 'Typing sound mood used while this portrait is shown - one of the `custom_info` > `sound_moods` names. Empty uses `sound_mood_default`.' },
};

/**
 * Keys of `custom_info` that Dialogic's own modules use (Style and Text
 * modules' character settings). Other keys can be added freely by your own
 * code.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_CUSTOM_INFO_KEYS = {
  'style': { type: 'String', value: '""', doc: 'Name of the Dialogic style (Layout) used while this character speaks. Empty keeps the current style.' },
  'sound_mood_default': { type: 'String', value: '""', doc: 'Typing sound mood used by default - one of the `sound_moods` names. A portrait can use another one with its own `sound_mood`.' },
  'sound_moods': { type: 'Dictionary', value: '{}', doc: 'Typing sound moods of this character, by name: which sounds play while its text is typed, and how.' },
};

/**
 * Keys of one typing sound mood, inside `custom_info` > `sound_moods`.
 *
 * @type {Record<string, {type: string, value: string, doc: string}>}
 */
const DCH_SOUND_MOOD_KEYS = {
  'name': { type: 'String', value: '""', doc: 'Name of this sound mood - the same as its key in `sound_moods`.' },
  'sound_path': { type: 'String', value: '""', doc: 'A sound file, or a folder whose sounds are picked at random, played while the text is typed.' },
  'mode': { type: 'int', value: '0', doc: 'How a new sound plays over the previous one: `0` INTERRUPT (stops it), `1` OVERLAP (plays on top), `2` AWAIT (waits for it to end).' },
  'pitch_base': { type: 'float', value: '1.0', doc: 'Base pitch of the sounds.' },
  'pitch_variance': { type: 'float', value: '0.0', doc: 'Random pitch variation added to `pitch_base` for each sound.' },
  'volume_base': { type: 'float', value: '0.0', doc: 'Base volume of the sounds, in dB.' },
  'volume_variance': { type: 'float', value: '0.0', doc: 'Random volume variation added to `volume_base` for each sound, in dB.' },
  'skip_characters': { type: 'int', value: '0', doc: 'Number of characters skipped between two sounds (0 = a sound on every character).' },
};

/** The `mode` values of a typing sound mood (Dialogic's DialogicNode_TypeSounds.Modes). */
const DCH_SOUND_MODES = [
  ['0', 'INTERRUPT', 'A new sound stops the one playing.'],
  ['1', 'OVERLAP', 'A new sound plays on top of the one playing.'],
  ['2', 'AWAIT', 'A new sound waits for the one playing to end.'],
];

/** Doc of the `image` override of Dialogic's default portrait scene. @type {string} */
const DCH_IMAGE_OVERRIDE_DOC = 'Image shown by Dialogic\'s default portrait scene (used when the portrait has no `scene`). Written as a quoted path inside the string: `"\\"res://portraits/happy.png\\""`.';

Object.assign(module.exports, {
  DIALOGIC_CHARACTER_DOCS_URL,
  DCH_CHARACTER_KEYS,
  DCH_PORTRAIT_KEYS,
  DCH_CUSTOM_INFO_KEYS,
  DCH_SOUND_MOOD_KEYS,
  DCH_SOUND_MODES,
  DCH_IMAGE_OVERRIDE_DOC,
});
