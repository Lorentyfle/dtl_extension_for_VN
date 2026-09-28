// -----------------------------------------------------------------------------
// Dialogic's text effects and modifiers ([pause], [speed], [portrait]...),
// as documented for hover and completion.
// -----------------------------------------------------------------------------
// =============================================================================
// DIALOGIC TEXT EFFECTS AND MODIFIERS
// =============================================================================
// Dialogic's own commands inside text (not Godot BBCode): effects happen
// when the reveal reaches them ([pause=0.5], [portrait=happy], [aa]...),
// modifiers change the text before it's shown ([if ...], <a/b>). From
// Dialogic's Text/Character/Core modules (_get_text_effects,
// _get_text_modifiers) and docs.dialogic.pro/text-effects.html.

/** @type {string} */
const DIALOGIC_TEXT_EFFECTS_DOCS_URL = 'https://docs.dialogic.pro/text-effects.html';

/**
 * Same shape as DTL_BBCODES entries (rendered by createDocumentation), plus
 * `snippet`: the completion insert text after the typed `[`, and
 * `valueFrom`: where `[name=` values are suggested from.
 */
const DTL_TEXT_EFFECTS = [
  { name: 'pause', syntax: '[pause=x] / [pause=x!] / [pause]', snippet: 'pause=${1:0.5}]', description: 'Pauses the reveal for x seconds (0.5 by default). The pause is multiplied by the current speed multiplier and the text speed setting, unless it ends with "!".', example: 'Laripo: Well...[pause=0.8] I guess so.' },
  { name: 'speed', syntax: '[speed=x] / [speed]', snippet: 'speed=${1:2}]', description: 'Sets the temporary speed multiplier to x (1 if no x is given). It multiplies pauses and letter speed: a bigger number is a slower reveal, 0 is instant.', example: 'Laripo: [speed=3]S-l-o-w-l-y[speed] and normal again.' },
  { name: 'lspeed', syntax: '[lspeed=x] / [lspeed=x!] / [lspeed]', snippet: 'lspeed=${1:0.05}]', description: 'Sets the letter speed to x seconds per letter, or back to the default if no x is given. Multiplied by the speed multiplier and the text speed setting, unless it ends with "!".', example: 'Laripo: [lspeed=0.2]Dramatic.' },
  { name: 'signal', syntax: '[signal=argument]', snippet: 'signal=${1:argument}]', description: 'Emits `Dialogic.text_signal` with the given argument when the reveal reaches it - to make something happen at an exact moment of the text.', example: 'Laripo: And then... [signal=thunder]BOOM!' },
  { name: 'portrait', syntax: '[portrait=name]', snippet: 'portrait=${1}]', valueFrom: 'portraits', description: 'Changes the speaker\'s portrait to the one with the given name, mid-sentence.', example: 'Laripo: I\'m fine. [portrait=sad]Really.' },
  { name: 'mood', syntax: '[mood=name]', snippet: 'mood=${1}]', valueFrom: 'soundMoods', description: 'Changes the speaker\'s typing sound mood to the one with the given name (from the character\'s typing sounds settings).', example: 'Laripo: [mood=angry]WHAT?!' },
  { name: 'extra_data', syntax: '[extra_data=value]', snippet: 'extra_data=${1}]', valueFrom: 'layers', description: 'Changes the extra data of the speaker\'s portrait, e.g. `set Head/Happy` to switch a LayeredPortrait layer.', example: 'Laripo: [extra_data=set Mouth/Smile]Hehe.' },
  { name: 'aa', syntax: '[aa] / [aa=x] / [aa=x?]', snippet: 'aa]', description: 'Enables Auto-Advance for this text event. With x, overrides the delay before advancing (x seconds; "?" makes it absolute).', example: 'Laripo: This line goes on by itself.[aa]' },
  { name: 'ns', syntax: '[ns] / [ns=x]', snippet: 'ns]', description: 'For this text event, disables text skipping and manual advance, and enables Auto-Advance (x overrides its delay).', example: 'Laripo: You can\'t skip this.[ns]' },
  { name: 'nrs', syntax: '[nrs]', snippet: 'nrs]', description: 'For this text event, prevents the player from skipping the reveal of the text (it can still be advanced once revealed).', example: 'Laripo: Read every letter.[nrs]' },
  { name: 'input', syntax: '[input]', snippet: 'input]', description: 'Waits for any input when reached. Unlike [n+], it doesn\'t split the text into sections, so it can be skipped.', example: 'Laripo: Wait for it...[input] there.' },
  { name: 'n', syntax: '[n]', snippet: 'n]', description: 'Visually starts a new text box, like a new text event: the player has to advance (or Auto-Advance does). The text before it is cleared.', example: 'Laripo: First box.[n]Second box.' },
  { name: 'n+', syntax: '[n+]', snippet: 'n+]', description: 'Like [n], but the next part is added after the current text instead of replacing it.', example: 'Laripo: First part...[n+] and the rest.' },
  { name: 'if', syntax: '[if {condition} text if true/text if false]', snippet: 'if {${1:variable}} ${2:text if true}/${3:text if false}]', description: 'Conditional text (a text modifier): shows the first text if the condition is true, else the text after "/" (optional). Saves a whole condition event for a word or a sentence.', example: 'Laripo: [if {KeyCollected} You have a key./You don\'t have any key.]' },
].map(entry => ({ ...entry, type: 'text_effect', docsUrl: DIALOGIC_TEXT_EFFECTS_DOCS_URL, docsLabel: 'Dialogic documentation' }));

/** Names of the text effects that take no closer and aren't BBCode. @type {Set<string>} */
const TEXT_EFFECT_NAMES = new Set(DTL_TEXT_EFFECTS.map(entry => entry.name));

Object.assign(module.exports, {
  DTL_TEXT_EFFECTS,
  TEXT_EFFECT_NAMES,
});
