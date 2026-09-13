# DTL Reader test room

A self-contained fake Godot project - not tied to your real one - for testing
every DTL Reader feature without risking real project data.

## Setup

1. Open this `test-room/` folder itself as a VS Code workspace (not a
   subfolder of it - the extension looks for `project.godot` at the
   workspace root or below).
2. Make sure the DTL Reader extension is installed and active.
3. Pick a bundled theme: `Ctrl+Shift+P` -> **Preferences: Color Theme** ->
   `DTL Dark` / `DTL Light` / `DTL Dracula` / `DTL Godot-like`.
4. Open `timelines/test_timeline.dtl`.

## What's in here

- `project.godot` - fake `[dialogic]` section declaring two characters
  (`TestCharacter`, `John Smith`), two audio channels (`music`, `sound`),
  and a `variables={...}` dictionary (`variable.test`/`Ttttt`/`Floating`,
  `Mamamya`) for `{variable.path}` autocomplete - plus an `[autoload]`
  section declaring one global script, `Global`.
- `scripts/Global.gd` - a fake autoload script with a handful of `##`-
  documented functions (and one deliberately undocumented, and one
  `_`-prefixed to confirm it's excluded), for `do`/`if`/`elif`
  `Global.function_name(...)` autocomplete and hover.
- `characters/TestCharacter.dch` - one plain portrait (`Default`, no scene)
  and one scene-backed portrait (`LayeredPortrait`), plus `display_name`,
  `nicknames`, `description`, and `color` for the character hover.
- `characters/TestCharacterPortrait.tscn` - the `LayeredPortrait` scene's
  node tree: `Body` and `Head` under the root, `LeftEye`/`RightEye` under
  `Head`. This is what `extra_data="set ..."` autocompletes against.
- `characters/JohnSmith.dch` - a second character, `John Smith`, whose name
  contains a space - for testing the quoted-character-name feature.
- `assets/theme.ogg`, `assets/voice_line.ogg`, `assets/bg.png` - empty
  placeholder files so `res://` path autocomplete has real files to offer.
- `timelines/test_timeline.dtl` - one file touching every language
  construct: comments, translation ids, `join`/`update`/`leave --All--`,
  transforms (`pos`/`size`), mood tags, `extra_data`, dialogue, narration,
  choices with conditions, `{variables}`, all four BBCode balises plus a
  custom one, every bracket command (`wait`, `wait_input`, `signal`,
  `voice`, `audio`, `clear`, `background`, `style`, `text_input`,
  `end_timeline`), flow control (`set`/`if`/`elif`/`else`/`while`),
  `label`/`jump`, a quoted character name (`"John Smith"`), and a
  single-quoted attribute value (`[wait time='1.5']`).

## Manual checks

- **Syntax highlighting**: every construct above should be colored, not
  left in the default foreground color, under each of the 4 themes.
- **Character/audio autocomplete**: on a blank line type `join ` or
  `audio ` - `TestCharacter` / `music` and `sound` should appear.
- **Mood autocomplete**: type `TestCharacter (` (as a dialogue speaker, or
  after `join`/`update`) - both `Default` and `LayeredPortrait` should
  appear.
- **`extra_data` node-path autocomplete** (the reported bug): on the
  `join`/`update` lines that use `(LayeredPortrait)` or `(Default)`, clear
  the existing `extra_data="set ..."` value and retype it - typing
  `extra_data="set ` should suggest `Body` and `Head`; typing
  `extra_data="set Head/` should then suggest `LeftEye` and `RightEye`.
  If nothing appears, open **Help > Toggle Developer Tools > Console**
  (or the "DTL Reader" entry in the Output panel) and look for a
  `DTL Reader:` error - the extension now logs why a mood's scene
  couldn't be read/parsed instead of failing silently.
- **`res://` path autocomplete**: inside `[voice path="`,
  `[background arg="`, or after `audio music "` - the placeholder files
  under `assets/` should be suggested.
- **Hover documentation**: hover over `join`, `[wait]`, `time=` inside
  `[wait ...]`, `pos=` on the `update` line, and `left`/`center`-style
  position keywords.
- **Go to Definition**: Ctrl+click `loop_start` in `jump loop_start` - it
  should jump to `label loop_start`.
- **Diagnostics**: temporarily rename `label loop_start` to something else
  - `jump loop_start` should get a warning. Temporarily remove a closing
  `[/b]` - the narration/dialogue line should get an "unclosed balise"
  warning.
- **Quoted character names**: on a blank line type `join "John` - `John
  Smith` should be suggested and inserted fully quoted. Same for typing
  `"Joh` at the start of a line for a dialogue speaker. The resulting
  `"John Smith": ...` line should highlight the whole quoted name as a
  character, exactly like the bare `TestCharacter` lines do.
- **Single-quote strings**: `[wait time='1.5' skippable='true']` in the
  sample timeline should highlight `'1.5'`/`'true'` as strings, the same
  as double-quoted values elsewhere.
- **`{variable.path}` autocomplete**: on the `set {variable.test} = 2`
  line, clear the path and retype it - typing `{` alone should suggest
  `variable` and `Mamamya` (with `Mamamya`'s detail showing its default
  `":OO"`); typing `{variable.` should then suggest `test`, `Ttttt`, and
  `Floating`, each showing its own default value. This also works inside
  plain dialogue text, e.g. retyping `{Mamamya}` on the line below it.
- **Character hover documentation**: hover over `TestCharacter` anywhere
  it appears (the `join` line or a dialogue speaker line) - the hover
  should show "Super John" as a colored title (purple, from the declared
  `Color(0.58, 0.39, 0.78, 1)`), "Also known as: X, John 2", and the
  description "This is John, the hero". Hovering `"John Smith"` should
  show no hover, since `JohnSmith.dch` doesn't declare any of these
  fields - confirming the feature degrades gracefully rather than showing
  an empty box.
- **Global script function autocomplete**: on the `do Global.apply_tint()`
  line, clear the call and retype it - typing `do ` alone should suggest
  `Global`; typing `do Global.` should then suggest `apply_tint`,
  `has_achievement`, `random_greeting`, and `undocumented_function`, each
  showing its parameters/return type and (except the last) its `##` doc
  comment. `_ready` should never appear. The same `Global.` completions
  should also work mid-expression on the `if`/`elif` lines below it, e.g.
  clearing and retyping `Global.has` inside
  `if Global.has_achievement("intro_complete")`.
- **Global script function hover**: hover over `apply_tint` or
  `has_achievement` on the `do`/`if` lines - the hover should show the
  function's signature and its `##` documentation comment. Hovering
  `Global.apply_tint` written as plain narration text (not after
  `do`/`if`/`elif`) should show no hover, confirming the feature is
  correctly scoped to those lines.
