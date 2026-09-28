// -----------------------------------------------------------------------------
// Godot's BBCode tags, as documented for hover and completion.
// -----------------------------------------------------------------------------
// =============================================================================
// GODOT BBCODE DOCUMENTATION
// =============================================================================
// Every BBCode tag Godot 4's RichTextLabel understands, which is what
// Dialogic renders dialogue/narration/choice text with. Descriptions follow
// the official "BBCode in RichTextLabel" page (GODOT_BBCODE_DOCS_URL).
//
// Same shape as DTL_ENTRIES (so createDocumentation renders both), plus:
// - selfClosing: the tag has no [/name] closer (e.g. [br], [lb]) - never
//   flagged as an unclosed balise, and inserted without one.
// - snippet: custom completion insert text (after the already-typed '['),
//   for tags whose value is part of the opening tag, e.g. [color=red].

/** @type {string} */
const GODOT_BBCODE_DOCS_URL = 'https://docs.godotengine.org/en/stable/tutorials/ui/bbcode_in_richtextlabel.html';

const DTL_BBCODES = [
  // --- Text style -----------------------------------------------------------
  {
    name: 'b',
    syntax: '[b]{text}[/b]',
    description: 'Makes {text} use the bold (or bold italics) font of the RichTextLabel.',
    example: 'Laripo: This is [b]important[/b].'
  },
  {
    name: 'i',
    syntax: '[i]{text}[/i]',
    description: 'Makes {text} use the italics (or bold italics) font of the RichTextLabel.',
    example: 'Laripo: This is [i]interesting[/i].'
  },
  {
    name: 'u',
    syntax: '[u]{text}[/u]',
    description: 'Makes {text} underlined.',
    example: 'Laripo: This is [u]underlined[/u].'
  },
  {
    name: 's',
    syntax: '[s]{text}[/s]',
    description: 'Makes {text} strikethrough.',
    example: 'Laripo: This is [s]struck out[/s].'
  },
  {
    name: 'code',
    syntax: '[code]{text}[/code]',
    description: 'Makes {text} use the mono font of the RichTextLabel. BBCode tags inside [code] are not parsed.',
    example: 'Laripo: Type [code]git status[/code] to check.'
  },
  {
    name: 'color',
    syntax: '[color={code/name}]{text}[/color]',
    description: 'Changes the color of {text}. Accepts a color name (e.g. `red`, `aqua`) or a hexadecimal code (`#ff00ff`, `#ff00ff80` with alpha).',
    example: 'Laripo: The [color=red]red[/color] button.',
    snippet: 'color=${1:red}]$0[/color]'
  },
  {
    name: 'bgcolor',
    syntax: '[bgcolor={code/name}]{text}[/bgcolor]',
    description: 'Draws a background color behind {text}. Accepts a color name or a hexadecimal code.',
    example: 'Laripo: [bgcolor=yellow]Highlighted[/bgcolor] text.',
    snippet: 'bgcolor=${1:yellow}]$0[/bgcolor]'
  },
  {
    name: 'fgcolor',
    syntax: '[fgcolor={code/name}]{text}[/fgcolor]',
    description: 'Draws a foreground color in front of {text}, which can be used to "redact" it by using an opaque color.',
    example: 'Laripo: The password is [fgcolor=black]hunter2[/fgcolor].',
    snippet: 'fgcolor=${1:black}]$0[/fgcolor]'
  },
  {
    name: 'outline_size',
    syntax: '[outline_size={size}]{text}[/outline_size]',
    description: 'Uses a custom font outline size for {text}, in pixels.',
    example: '[outline_size=4]Outlined[/outline_size]',
    snippet: 'outline_size=${1:4}]$0[/outline_size]'
  },
  {
    name: 'outline_color',
    syntax: '[outline_color={code/name}]{text}[/outline_color]',
    description: 'Uses a custom font outline color for {text}. Accepts a color name or a hexadecimal code.',
    example: '[outline_size=4][outline_color=black]Outlined[/outline_color][/outline_size]',
    snippet: 'outline_color=${1:black}]$0[/outline_color]'
  },
  {
    name: 'font',
    syntax: '[font={path} {options}]{text}[/font]',
    description: 'Makes {text} use a font resource from the {path}. Options can also be passed without a path to customize the current font.',
    example: '[font=res://fonts/Handwriting.ttf]Dear diary...[/font]',
    snippet: 'font=${1:res://}]$0[/font]',
    variables: {
      'name': 'Path to the font resource (alternative to `[font={path}]`).',
      'size': 'Custom font size.',
      'glyph_spacing': 'Extra spacing for each glyph.',
      'space_spacing': 'Extra spacing for the space character.',
      'top_spacing': 'Extra spacing at the top of the line.',
      'bottom_spacing': 'Extra spacing at the bottom of the line.',
      'embolden': 'Font embolden strength. If not 0, emboldens the font outlines.',
      'face_index': 'Active face index for TrueType / OpenType collections.',
      'slant': 'Font slant (horizontal skew) - positive values slant to the right.',
      'opentype_variation': 'List of OpenType variation tags, e.g. `wght=600,wdth=100`.',
      'opentype_features': 'List of OpenType feature tags, e.g. `calt=0,zero=1`.',
    }
  },
  {
    name: 'font_size',
    syntax: '[font_size={size}]{text}[/font_size]',
    description: 'Uses a custom font size for {text}.',
    example: 'Laripo: [font_size=40]HEY![/font_size]',
    snippet: 'font_size=${1:24}]$0[/font_size]'
  },
  {
    name: 'opentype_features',
    syntax: '[opentype_features={list}]{text}[/opentype_features]',
    description: 'Enables custom OpenType font features for {text}. Features must be provided as a comma-separated list, e.g. `calt=0,zero=1`.',
    example: '[opentype_features=zero=1]0123[/opentype_features]',
    snippet: 'opentype_features=${1:calt=0}]$0[/opentype_features]'
  },
  {
    name: 'lang',
    syntax: '[lang={code}]{text}[/lang]',
    description: 'Overrides the language for {text} set by the BiDi > Language property in RichTextLabel.',
    example: '[lang=fr]Bonjour[/lang]',
    snippet: 'lang=${1:en}]$0[/lang]'
  },
  {
    name: 'char',
    syntax: '[char={codepoint}]',
    description: 'Adds a Unicode character with its hexadecimal UTF-32 {codepoint}.',
    example: '[char=2665]',
    snippet: 'char=${1:2665}]',
    selfClosing: true
  },
  // --- Links, images, tooltips ---------------------------------------------
  {
    name: 'url',
    syntax: '[url]{link}[/url] or [url={link}]{text}[/url]',
    description: 'Creates a hyperlink (underlined and clickable text). Clicking it emits RichTextLabel\'s `meta_clicked` signal - opening the link has to be handled by the game code.',
    example: 'Laripo: See the [url=https://docs.dialogic.pro]docs[/url].'
  },
  {
    name: 'hint',
    syntax: '[hint={tooltip text}]{text}[/hint]',
    description: 'Creates a tooltip hint that is displayed when hovering the text with the mouse. Tooltip text should be quoted if it contains spaces.',
    example: 'Laripo: I love [hint="A lot of cheese."]fondue[/hint].',
    snippet: 'hint="${1:tooltip}"]$0[/hint]'
  },
  {
    name: 'img',
    syntax: '[img {options}]{path}[/img]',
    description: 'Inserts an image from the {path} (can be any valid Texture2D resource). The shorthand `[img={width}x{height}]` also resizes it.',
    example: '[img width=32]res://icons/heart.png[/img]',
    variables: {
      'width': 'Target width in pixels (or percent of the control width with a `%` suffix). Keeps the aspect ratio if only one of width/height is given.',
      'height': 'Target height in pixels (or percent with a `%` suffix).',
      'region': 'Region of the texture to display, as `x,y,width,height`.',
      'color': 'Color the image is multiplied (tinted) by.',
      'tooltip': 'Tooltip shown when hovering the image.',
      'pad': 'If true, pads the image to keep its size when it fails to load.',
    }
  },
  // --- Paragraphs and alignment --------------------------------------------
  {
    name: 'p',
    syntax: '[p {options}]{text}[/p]',
    description: 'Adds a new paragraph with {text}. Supports configuration options.',
    example: '[p align=center]Chapter One[/p]',
    variables: {
      'align': 'Text horizontal alignment: `left` (`l`), `center` (`c`), `right` (`r`), or `fill` (`f`).',
      'bidi_override': 'Structured text override (also `st`): `default`, `uri`, `file`, `email`, `list`, `none`, or `custom`.',
      'direction': 'Base BiDi direction (also `dir`): `ltr`, `rtl`, `auto`, or `inherit`.',
      'language': 'Locale override for this paragraph (also `lang`), e.g. `en` or `ja`.',
      'tab_stops': 'List of floating-point numbers, e.g. `10.0,30.0`: overrides the default tab stops.',
      'justification_flags': 'Justification flags (also `jst`), e.g. `kashida,word,trim,after_last_tab`.',
    }
  },
  {
    name: 'center',
    syntax: '[center]{text}[/center]',
    description: 'Makes {text} horizontally centered. Same as `[p align=center]`.',
    example: '[center]THE END[/center]'
  },
  {
    name: 'left',
    syntax: '[left]{text}[/left]',
    description: 'Makes {text} horizontally left-aligned. Same as `[p align=left]`.',
    example: '[left]Left-aligned[/left]'
  },
  {
    name: 'right',
    syntax: '[right]{text}[/right]',
    description: 'Makes {text} horizontally right-aligned. Same as `[p align=right]`.',
    example: '[right]Right-aligned[/right]'
  },
  {
    name: 'fill',
    syntax: '[fill]{text}[/fill]',
    description: 'Makes {text} fill the full width of the RichTextLabel. Same as `[p align=fill]`.',
    example: '[fill]Justified text[/fill]'
  },
  {
    name: 'indent',
    syntax: '[indent]{text}[/indent]',
    description: 'Indents {text} once. The indentation width is the same as with `[ul]` or `[ol]`, but without a bullet point.',
    example: '[indent]Indented quote.[/indent]'
  },
  {
    name: 'dropcap',
    syntax: '[dropcap {options}]{text}[/dropcap]',
    description: 'Uses a different font size and color for {text}, while making the tag\'s contents span multiple lines if it\'s large enough. A drop cap is typically one uppercase character, but it can contain several characters.',
    example: '[dropcap font_size=48 margins=0,-5,5,0]O[/dropcap]nce upon a time...',
    variables: {
      'font': 'Path to the font resource used for the drop cap.',
      'font_size': 'Font size of the drop cap.',
      'color': 'Color of the drop cap.',
      'outline_size': 'Outline size of the drop cap.',
      'outline_color': 'Outline color of the drop cap.',
      'margins': 'Margins around the drop cap, as `left,top,right,bottom` in pixels.',
    }
  },
  // --- Lists and tables -----------------------------------------------------
  {
    name: 'ul',
    syntax: '[ul bullet={bullet}]{items}[/ul]',
    description: 'Adds an unordered list. List {items} must be provided by putting one item per line of text. The bullet point can be customized using the `bullet` parameter.',
    example: '[ul]Apples\nPears[/ul]',
    variables: {
      'bullet': 'Custom bullet character(s), e.g. `*` or `-`. Defaults to `•`.',
    }
  },
  {
    name: 'ol',
    syntax: '[ol type={type}]{items}[/ol]',
    description: 'Adds an ordered (numbered) list of the given {type}. List {items} must be provided by putting one item per line of text.',
    example: '[ol type=1]First\nSecond[/ol]',
    variables: {
      'type': 'Numbering style: `1` (numbers), `a` (lowercase letters), `A` (uppercase letters), `i` (lowercase roman numerals), `I` (uppercase roman numerals).',
    }
  },
  {
    name: 'table',
    syntax: '[table={columns},{inline_align}]{cells}[/table]',
    description: 'Creates a table with the {columns} number of columns. Use `[cell]` to define table cells. {inline_align} is optional (`top`, `center`, `baseline`, `bottom`).',
    example: '[table=2][cell]Name[/cell][cell]HP[/cell][/table]',
    snippet: 'table=${1:2}]$0[/table]'
  },
  {
    name: 'cell',
    syntax: '[cell {options}]{text}[/cell]',
    description: 'Adds a cell with {text} to the table. If a ratio is provided (e.g. `[cell=2]`), the cell will try to expand to the specified ratio relative to other cells.',
    example: '[cell border=#ffffff40 padding=2,2,2,2]Name[/cell]',
    variables: {
      'expand': 'Expansion ratio of the cell relative to other cells (same as `[cell={ratio}]`).',
      'border': 'Cell border color.',
      'bg': 'Cell background color. Two comma-separated colors alternate odd/even rows.',
      'padding': 'Cell padding, as `left,top,right,bottom` in pixels.',
    }
  },
  // --- Text effects -----------------------------------------------------------
  {
    name: 'pulse',
    syntax: '[pulse freq=1.0 color=#ffffff40 ease=-2.0]{text}[/pulse]',
    description: 'Creates an animated pulsing effect that multiplies each character\'s opacity and color. It can be used to bring attention to specific text.',
    example: 'Laripo: [pulse]Look here![/pulse]',
    variables: {
      'freq': 'Number of pulses per second.',
      'color': 'Target color multiplier at the peak of the pulse.',
      'ease': 'Easing exponent (negative values ease in and out).',
    }
  },
  {
    name: 'wave',
    syntax: '[wave amp=50.0 freq=5.0 connected=1]{text}[/wave]',
    description: 'Makes the text go up and down.',
    example: 'Laripo: [wave amp=25 freq=5]Wheee![/wave]',
    variables: {
      'amp': 'Amplitude: how high and low the effect goes.',
      'freq': 'Frequency: how fast the text goes up and down.',
      'connected': '`1` (default) keeps glyph clusters (e.g. ligatures) together; `0` animates each glyph independently.',
    }
  },
  {
    name: 'tornado',
    syntax: '[tornado radius=10.0 freq=1.0 connected=1]{text}[/tornado]',
    description: 'Makes the text move around in a circle.',
    example: 'Laripo: [tornado radius=5 freq=2]I\'m dizzy...[/tornado]',
    variables: {
      'radius': 'Radius of the circle that controls the offset.',
      'freq': 'How fast the text moves in a circle.',
      'connected': '`1` (default) keeps glyph clusters (e.g. ligatures) together; `0` animates each glyph independently.',
    }
  },
  {
    name: 'shake',
    syntax: '[shake rate=20.0 level=5 connected=1]{text}[/shake]',
    description: 'Makes the text shake.',
    example: 'Laripo: [shake rate=20 level=10]I-it\'s cold![/shake]',
    variables: {
      'rate': 'How fast the text shakes.',
      'level': 'How far the text is offset from its origin.',
      'connected': '`1` (default) keeps glyph clusters (e.g. ligatures) together; `0` animates each glyph independently.',
    }
  },
  {
    name: 'fade',
    syntax: '[fade start=4 length=14]{text}[/fade]',
    description: 'Creates a static fade effect that multiplies each character\'s opacity.',
    example: '[fade start=0 length=10]Fading away...[/fade]',
    variables: {
      'start': 'Starting position of the falloff relative to where the fade command is inserted.',
      'length': 'Number of characters over which the fade out takes place.',
    }
  },
  {
    name: 'rainbow',
    syntax: '[rainbow freq=1.0 sat=0.8 val=0.8 speed=1.0]{text}[/rainbow]',
    description: 'Gives the text a rainbow color that changes over time.',
    example: 'Laripo: [rainbow]Fabulous![/rainbow]',
    variables: {
      'freq': 'Number of letters the rainbow extends over before it repeats itself.',
      'sat': 'Saturation of the rainbow.',
      'val': 'Value (brightness) of the rainbow.',
      'speed': 'Number of full rainbow cycles per second. Negative values make the rainbow go backwards.',
    }
  },
  // --- Escapes and control characters (no closing tag) --------------------------
  {
    name: 'br',
    syntax: '[br]',
    description: 'Adds a line break in the text, without adding a new paragraph.',
    example: 'Laripo: First line[br]Second line',
    selfClosing: true
  },
  {
    name: 'hr',
    syntax: '[hr {options}]',
    description: 'Adds a horizontal rule (separator line).',
    example: '[hr width=50% color=#ffffff80]',
    selfClosing: true,
    variables: {
      'width': 'Width of the rule in pixels (or percent with a `%` suffix).',
      'height': 'Thickness of the rule in pixels.',
      'color': 'Color of the rule.',
      'align': 'Horizontal alignment: `left`, `center`, or `right`.',
    }
  },
  { name: 'lb', syntax: '[lb]', description: 'Adds `[`. Used to escape BBCode markup.', example: '[lb]b[rb]text[lb]/b[rb]', selfClosing: true },
  { name: 'rb', syntax: '[rb]', description: 'Adds `]`. Used to escape BBCode markup.', example: '[lb]b[rb]text[lb]/b[rb]', selfClosing: true },
  { name: 'lrm', syntax: '[lrm]', description: 'Adds a left-to-right mark (LRM, U+200E): a zero-width character that affects BiDi text ordering.', example: '[lrm]', selfClosing: true },
  { name: 'rlm', syntax: '[rlm]', description: 'Adds a right-to-left mark (RLM, U+200F): a zero-width character that affects BiDi text ordering.', example: '[rlm]', selfClosing: true },
  { name: 'lre', syntax: '[lre]', description: 'Adds a left-to-right embedding control character (LRE, U+202A).', example: '[lre]', selfClosing: true },
  { name: 'rle', syntax: '[rle]', description: 'Adds a right-to-left embedding control character (RLE, U+202B).', example: '[rle]', selfClosing: true },
  { name: 'lro', syntax: '[lro]', description: 'Adds a left-to-right override control character (LRO, U+202D).', example: '[lro]', selfClosing: true },
  { name: 'rlo', syntax: '[rlo]', description: 'Adds a right-to-left override control character (RLO, U+202E).', example: '[rlo]', selfClosing: true },
  { name: 'pdf', syntax: '[pdf]', description: 'Adds a pop directional formatting control character (PDF, U+202C).', example: '[pdf]', selfClosing: true },
  { name: 'alm', syntax: '[alm]', description: 'Adds an Arabic letter mark (ALM, U+061C).', example: '[alm]', selfClosing: true },
  { name: 'lri', syntax: '[lri]', description: 'Adds a left-to-right isolate control character (LRI, U+2066).', example: '[lri]', selfClosing: true },
  { name: 'rli', syntax: '[rli]', description: 'Adds a right-to-left isolate control character (RLI, U+2067).', example: '[rli]', selfClosing: true },
  { name: 'fsi', syntax: '[fsi]', description: 'Adds a first strong isolate control character (FSI, U+2068).', example: '[fsi]', selfClosing: true },
  { name: 'pdi', syntax: '[pdi]', description: 'Adds a pop directional isolate control character (PDI, U+2069).', example: '[pdi]', selfClosing: true },
  { name: 'zwj', syntax: '[zwj]', description: 'Adds a zero-width joiner (U+200D): joins the characters on either side into a single glyph when the font supports it.', example: '[zwj]', selfClosing: true },
  { name: 'zwnj', syntax: '[zwnj]', description: 'Adds a zero-width non-joiner (U+200C): prevents the characters on either side from being joined.', example: '[zwnj]', selfClosing: true },
  { name: 'wj', syntax: '[wj]', description: 'Adds a word joiner (U+2060): prevents a line break between the characters on either side.', example: '[wj]', selfClosing: true },
  { name: 'shy', syntax: '[shy]', description: 'Adds a soft hyphen (U+00AD): an invisible hyphen shown only if the word is broken across lines there.', example: 'extra[shy]ordinary', selfClosing: true },
].map(entry => ({ ...entry, type: 'bbcode', docsUrl: GODOT_BBCODE_DOCS_URL }));

/**
 * The BBCode tags offered right after a bare `[` - the ones used most in
 * dialogue. Every other tag (alignment, lists, tables, BiDi control
 * characters...) is still suggested, but only once a letter of its name
 * has been typed, so a bare `[` doesn't bury Dialogic's own commands
 * under ~50 BBCode tags.
 *
 * @type {Set<string>}
 */
const COMMON_BBCODE_NAMES = new Set([
  'b', 'i', 'u', 's', 'color', 'font_size', 'center', 'url', 'img',
  'wave', 'shake', 'rainbow', 'pulse', 'tornado', 'fade', 'br',
]);

// =============================================================================
// DIALOGIC TEXT EFFECTS AND MODIFIERS
// =============================================================================
// Dialogic's own commands inside text (not Godot BBCode): effects happen
// when the reveal reaches them ([pause=0.5], [portrait=happy], [aa]...),
// modifiers change the text before it's shown ([if ...], <a/b>). From
// Dialogic's Text/Character/Core modules (_get_text_effects,
// _get_text_modifiers) and docs.dialogic.pro/text-effects.html.

/**
 * BBCode tags that have no `[/name]` closer, so they're never flagged as
 * unclosed balises by findUnclosedBaliseDiagnostics.
 *
 * @type {Set<string>}
 */
const SELF_CLOSING_BBCODE_NAMES = new Set(DTL_BBCODES.filter(entry => entry.selfClosing).map(entry => entry.name));

Object.assign(module.exports, {
  DTL_BBCODES,
  COMMON_BBCODE_NAMES,
  SELF_CLOSING_BBCODE_NAMES,
});
