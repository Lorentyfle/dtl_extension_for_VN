// -----------------------------------------------------------------------------
// Dialogic's events: their documentation (for hover and completion),
// positions, animations and transitions, and the values and res:// file
// types their parameters accept.
// -----------------------------------------------------------------------------
// =============================================================================
// DTL DOCUMENTATION
// =============================================================================

const DTL_ENTRIES = [
  {
    name: 'label',
    type: 'command',
    syntax: 'label NAME',
    description: 'Create a label on the timeline that can be reached with a jump command. A good use of label would be for a scene change or loop.',
    example: 'label Laripo_starts_reading_the_documentation'
  },
  {
    name: 'jump',
    type: 'command',
    syntax: 'jump NAME',
    description: 'Jumps to a given label written after.',
    example: 'jump Laripo_starts_reading_the_documentation'
  },
  {
    name: 'return',
    type: 'command',
    syntax: 'return',
    description: 'Returns to the latest jump event or end the timeline (if no jump happened before).',
    example: 'return'
  },
  {
    name: 'set',
    type: 'command',
    syntax: 'set {variable} = variable_to_set',
    description: 'Command that sets a variable from Dialogic or a global variable towards a given value. Increments can also be accepted.',
    example: 'set {chapter} = 4'
  },
  {
    name: 'join',
    type: 'command',
    syntax: 'join character position [...]',
    description: 'Make a character join on a given position with a given extra information. The variables given are the one set inside the [].',
    example: 'join Laripo center [extra_data="set Emotion/Happy"]',
    transform_command: {
      // transform command are given to entries that possess it. It is here for the documentation, but those are entries after the character name and before the [].
      'pos': 'Position of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%. The position is relative to the viewport and defines the portrait origin, usually its bottom center.',
      'size': 'Size of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%.',
      'rot': 'Rotation of the character in degrees. The portrait rotates around its origin, usually its bottom center.',
    },
    variables: {
      // variable_name : documentation
      'animation': 'Name of the animation to play when the character joins.',
      'length': 'Length of the animation in seconds. Only used when an animation is set.',
      'wait': 'Whether to wait for the animation to finish before continuing. Only used when an animation is set.',
      'mirrored': 'Whether to mirror the character sprite horizontally.',
      'z_index': "Controls the character draw order. Higher values appear in front of lower values. This uses Dialogic's character sorting rather than Godot's z-index.",
      'extra_data': "Additional data passed to the character portrait. For LayeredSprite2D portraits, this can be used to change elements, for example: set Arm/Happy. The path after \"set \" is autocompleted from the character's LayeredPortrait scene.",
    }
  },
  {
    name: 'update',
    type: 'command',
    syntax: 'update character position [...]',
    description: 'Update a joined character on a given position with a given extra information. The variables given are the one set inside the [].',
    example: 'update Laripo center [extra_data="set Emotion/Happy"]',
    transform_command: {
      // transform command are given to entries that possess it. It is here for the documentation, but those are entries after the character name and before the [].
      'pos': 'Position of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%. The position is relative to the viewport and defines the portrait origin, usually its bottom center.',
      'size': 'Size of the character. X and Y can be specified as relative values, percentages, or pixels, for example: x0.5 y1 or x100px y1%.',
      'rot': 'Rotation of the character in degrees. The portrait rotates around its origin, usually its bottom center.',
    },
    variables: {
      // variable_name : documentation
      'animation': 'Name of the animation to play while updating the character.',
      'length': 'Length of the animation in seconds. Only used when an animation is set.',
      'wait': 'Whether to wait for the animation to finish before continuing. Only used when an animation is set.',
      'mirrored': 'Whether to mirror the character sprite horizontally.',
      'z_index': "Controls the character draw order. Higher values appear in front of lower values. This uses Dialogic’s character sorting rather than Godot's z-index.",
      'fade': 'Name of the crossfade animation used when changing the character portrait. If omitted, the default portrait fade is used.',
      'move_time': 'Duration of the position transition in seconds.',
      'move_trans': 'Transition type used when moving the character to a new position.',
      'repeat': 'Number of times to repeat the animation. Only used with move_time or move_trans.',
      'move_ease': 'Easing used when moving the character to a new position.',
      'fade_length': 'Duration of the portrait fade in seconds.',
      'extra_data': "Additional data passed to the character portrait. For LayeredSprite2D portraits, this can be used to change elements, for example: set Arm/Happy. The path after \"set \" is autocompleted from the character's LayeredPortrait scene.",    }
  },
  {
    name: 'leave',
    type: 'command',
    syntax: 'leave character [...]',
    description: 'Make a character leave the scene with a given extra information. The variables given are the one set inside the []. If one write `leave --All--` all joined characters will leave.',
    example: 'leave Laripo [animation="Slide To Left"]',
    variables: {
      // variable_name : documentation
      'animation': 'Name of the animation to play when the character leaves.',
      'length': 'Length of the animation in seconds. Only used when an animation is set.',
      'wait': 'Whether to wait for the animation to finish before continuing. Only used when an animation is set.',
    }
  },
  {
    name: 'do',
    type: 'command',
    syntax: 'do Global.function()',
    description: 'Run a given function on a global script.',
    example: 'do VnLibrary.apply_emotions()'
  },
  {
    name: 'wait',
    type: 'bracket',
    syntax: '[wait ...]',
    description: 'Pauses the progress of the timeline for a given amount of time.',
    example: '[wait 1.5] [wait time="1.0"]',
    variables: {
      // variable_name : documentation
      'time': 'Duration of the wait in seconds.',
      'hide_text': 'Whether to hide the text while waiting.',
      'skippable': 'Whether the wait can be skipped by the player.',
    }
  },
  {
    name: 'wait_input',
    type: 'bracket',
    syntax: '[wait_input ...]',
    description: 'Waits for user input before continuing the timeline.',
    example: '[wait_input]',
    variables: {
      // variable_name : documentation
      "hide_text":"Whether to hide the text while waiting for input."
    }
  },
  {
    name: 'audio',
    type: 'command',
    syntax: 'audio KIND "path"',
    description: 'Adds an audio event, kind is the kind of audio used, for example music. It was set inside Dialogic.',
    example: 'audio music "res://assets/ost/my_music.mp3"'
  },
  {
    name: 'voice',
    type: 'bracket',
    syntax: '[voice ...]',
    description: 'Adds a voice event.',
    example: '[voice path="res://assets/voices/Laripo_dialogueID_666.mp3"]',
    variables: {
      // variable_name : documentation
      'path': 'Path to the voice audio file.',
      'volume': 'Volume adjustment for the voice audio.',
      'bus': 'Audio bus used to play the voice audio.',
    }
  },
  {
    name: 'clear',
    type: 'bracket',
    syntax: '[clear ...]',
    description: 'Clears the relevant dialogue/display state.',
    example: '[clear time="1.0"]',
    variables: {
      // variable_name : documentation
      "time":"Duration of the fade in seconds. Set to 0 for an instant clear.",
      "step":"Wether to clear each element one after another. The order is Textbox, Portraits, Backgrounds, Audio, then Styles. (true by default)",
      "text":"Wether to clear the text (true by default)",
      "portraits":"Wether to clear the portraits (true by default)",
      "music":"Wether to clear the audio (true by default)",
      "background":"Wether to clear the background (true by default)",
      "position":"Wether to clear character position (true by default)",
      "style":"Wether to clear the style (true by default)",
    }
  },
  {
    name: 'background',
    type: 'bracket',
    syntax: '[background ...]',
    description: 'Changes the background.',
    example: '[background arg="res://assets/sprite/new_background.png" fade="0.0"]',
    variables: {
      // variable_name : documentation
      'arg': 'Background to display. This can be an image path, a color, or another string argument.',
      'scene': 'Path to the background scene.',
      'transition': 'Transition used when changing the background.',
      'fade': 'Duration of the background fade in seconds.',
      'wait': 'Whether to wait for the transition to finish before continuing.',
    }
  },
  {
    name: 'style',
    type: 'bracket',
    syntax: '[style ...]',
    description: 'Changes the dialogic style used. The name needs to correspond to a setup style loaded in the extension.',
    example: '[style name="default"]',
    variables: {
      // variable_name : documentation
      "name":"Name of the style to use."
    }
  },
  {
    name: 'signal',
    type: 'bracket',
    syntax: '[signal ...]',
    description: 'Send a dialogic signal with given arguments.',
    example: '[signal arg_type="dict" arg="{\"Amount\":100,\"Effect\":\"Rain\",\"Nature\":\"meteo\",\"Windx\":20.0,\"Windy\":1.0}"]',
    variables: {
      // variable_name : documentation
      'arg_type': 'Type of the argument sent with the Dialogic signal.',
      'arg': 'Argument sent with the Dialogic signal.',
    }
  },
  {
    name: 'text_input',
    type: 'bracket',
    syntax: '[text_input ...]',
    description: 'Make a text input prompt appear that would save the data in a variable.',
    example: '[text_input text="Solve: 4x - 67 = 0" var="_butterfly_effect.part1.introduction.answer_equation1" placeholder="No idea" allow_empty="true"]',
    variables: {
      // variable_name : documentation
      'text': 'Text displayed above the text input.',
      'var': 'Variable where the entered text will be stored.',
      'placeholder': 'Text displayed in the input field when it is empty.',
      'default': 'Default value used when no text is entered.',
      'allow_empty': 'Whether the input can be submitted without any text.',
    }
  },
  {
    name: 'end_timeline',
    type: 'bracket',
    syntax: '[end_timeline]',
    description: 'Ends the current timeline.',
    example: '[end_timeline]',
    variables: {
    }
  }
];

// =============================================================================
// POSITIONS
// =============================================================================

const DTL_POSITIONS = [
  {
    name: 'left',
    description: 'Place the character on the left side.'
  },
  {
    name: 'right',
    description: 'Place the character on the right side.'
  },
  {
    name: 'center',
    description: 'Place the character in the center.'
  },
  {
    name: 'leftmost',
    description: 'Place the character at the far left.'
  },
  {
    name: 'rightmost',
    description: 'Place the character at the far right.'
  }
];

// =============================================================================
// CHARACTER / BACKGROUND ANIMATION
// =============================================================================

const DTL_ANIMATION_JOIN = [
  "Bounce In",
  "Fade In Down",
  "Fade In",
  "Fade In Up",
  "Instant In",
  "Slide In Down",
  "Slide From Left",
  "Slide From Right",
  "Slide In Up",
  "Zoom Center In",
  "Zoom In",
];

const DTL_ANIMATION_LEAVE = [
  "Bounce Out",
  "Fade Out Up",
  "Fade Out",
  "Fade Out Down",
  "Instant Out",
  "Slide Out Up",
  "Slide To Left",
  "Slide To Right",
  "Slide Out Down",
  "Zoom Center Out",
  "Zoom Out",
];

const DTL_TRANSITION = [
  "Push Down",
  "Push Left",
  "Push Right",
  "Push Up",
  "Simple Fade",
  "Swipe Diagonal Up Left",
  "Swipe Left To Right",
  "Swipe Right To Left"
];

const DTL_ANIMATION_UPDATE = [
  "Bounce",
  "Heartbeat",
  "Shake X",
  "Shake Y",
  "Tada",
];

const DTL_MOVE_EASE = [
  "In",
  "Out",
  "In_Out",
  "Out_In",
];

const DTL_MOVE_TRANS = [
  "Linear",
  "Sine",
  "Quint",
  "Quart",
  "Quad",
  "Expo",
  "Elastic",
  "Cubic",
  "Circ",
  "Bounce",
  "Back",
  "Spring",
];

/**
 * Known value suggestions for specific attribute names, scoped per
 * DTL_ENTRIES name so e.g. join's `animation=` offers DTL_ANIMATION_JOIN
 * while leave's `animation=` offers DTL_ANIMATION_LEAVE instead.
 *
 * @type {Record<string, Record<string, string[]>>}
 */
const DTL_ATTRIBUTE_VALUE_SUGGESTIONS = {
  join: { animation: DTL_ANIMATION_JOIN },
  update: { animation: DTL_ANIMATION_UPDATE, move_trans: DTL_MOVE_TRANS, move_ease: DTL_MOVE_EASE },
  leave: { animation: DTL_ANIMATION_LEAVE },
  background: { transition: DTL_TRANSITION },
};

/**
 * File extensions (lowercase, no dot) Godot can load for each kind of
 * resource a timeline can point at, used to only suggest `res://` paths
 * that actually make sense for the command being written - e.g. audio
 * files for `[voice path="`, never a `.gd` script or a `.dch` character.
 *
 * @type {Record<string, string[]>}
 */
const RESOURCE_EXTENSIONS = {
  audio: ['ogg', 'wav', 'mp3'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'tga', 'exr', 'hdr', 'dds', 'ktx'],
  video: ['ogv'],
  scene: ['tscn', 'scn'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'fnt', 'font', 'pfb', 'pfm'],
};

/**
 * Bracket-command attributes whose value is a Godot `res://` resource path,
 * e.g. `[voice path="res://..."]`, mapped to the file extensions that make
 * sense there. Keyed the same way as DTL_ATTRIBUTE_VALUE_SUGGESTIONS
 * (entry name -> attribute name -> ...), so createAttributeValueSuggestions
 * can fall back to path suggestions when no fixed enum of values applies.
 *
 * @type {Record<string, Record<string, string[]>>}
 */
const DTL_PATH_ATTRIBUTES = {
  voice: { path: RESOURCE_EXTENSIONS.audio },
  // The default background scene displays `arg` as an image or a video.
  background: { arg: [...RESOURCE_EXTENSIONS.image, ...RESOURCE_EXTENSIONS.video], scene: RESOURCE_EXTENSIONS.scene },
};

Object.assign(module.exports, {
  DTL_ENTRIES,
  DTL_POSITIONS,
  DTL_ATTRIBUTE_VALUE_SUGGESTIONS,
  RESOURCE_EXTENSIONS,
  DTL_PATH_ATTRIBUTES,
});
