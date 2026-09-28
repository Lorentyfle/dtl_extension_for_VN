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
  section declaring a global script, `Global`, and an autoload node
  (scene), `SoundManager`.
- `scripts/Global.gd` - a fake autoload script with a handful of `##`-
  documented functions (one deliberately undocumented, one `_`-prefixed to
  confirm it's excluded, one with a multi-line signature), plus variables,
  constants, a named enum (`State`) and an unnamed one, for `do`/`if`/
  `elif` `Global.member` and `{Global.property}` autocomplete and hover.
- `scripts/SoundManager.tscn` + `scripts/SoundManager.gd` - an autoload
  that points at a scene: its members come from the root node's script.
- `scripts/Global.gd.uid`, `assets/bg.png.import` - Godot metadata files,
  which must NOT show up in `res://` path autocomplete.
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
- `timelines/chapter2.dtl` - a second timeline (registered in
  `directories/dtl_directory`) for cross-timeline `jump chapter2/label`.
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
- **Autoload autocomplete**: type `do ` - `Global` and `SoundManager`
  should appear; `do Global.` lists only functions, `if Global.` lists
  functions, variables, constants and `State`, `if Global.State.` lists
  its values, and `TestCharacter: {Global.` lists variables/constants.
  Inside `do Global.has_achievement("` nothing should be suggested.
- **`set` values**: after `set {Global.state} = `, `Global` should be
  suggested, and `Global.State.` should list the enum's values. The
  right-hand side should show 3 different colors (autoload, enum, value).
- **Variable hover**: hover `test` in `{variable.test}` - it should show
  `Default value: 1` (int); hovering `variable` lists the whole group.
- **Signal dictionary colors**: both `[signal ...]` lines with a `{...}`
  argument should color keys, strings, `false` and numbers differently.
- **Filtered paths**: `[voice path="` should only offer the `.ogg` files,
  `[background scene="` only `.tscn` files.
- **Mood / layer hover**: hover `LayeredPortrait` or `Default` in a
  `(mood)` tag, then `Head` and `LeftEye` in `extra_data="set Head/LeftEye"`
  (LeftEye has an Editor Description in the .tscn).
- **Label doc**: hover `loop_start` in `jump loop_start` - the `##` lines
  above `label loop_start` should show.
- **Unknown names**: the timeline should have no errors. Type
  `join Nobody left`, `Ghost: hi`, `join TestCharacter (Angry) left` or
  `{nope}` - each should get an error or warning.
- **Autoload colors in `{}`**: `{Global.hearts}` should be colored like
  `Global.hearts` on an `if` line; `{variable.test}` should not change.
- **Outline**: open the Outline view - `loop_start` should list the
  `while` block and both choices with their jumps. Setting
  `dtlReader.outline.showFlow` to false leaves only the labels.
- **Cross-timeline jumps**: Ctrl+click `chapter2` or `intro` in
  `jump chapter2/intro` - it should open `chapter2.dtl`. Type
  `jump chapter2/` - `intro` and `Ending With Spaces` should be suggested.
  Change it to `jump chapter2/nope` or `jump chapter9/intro` - error.
- **No stray suggestions in dialogue**: typing `.` or a space at the end
  of a dialogue sentence should NOT open a suggestion list.
- **BBCode**: in dialogue type `[co` - `code` and `color` should appear;
  after `[b][i]Hi [/`, `/i` then `/b` should be suggested. Hover
  `[wave` or `[/b]` for their Godot documentation.
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
