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

- `project.godot` - fake `[dialogic]` section declaring one character
  (`TestCharacter`) and two audio channels (`music`, `sound`).
- `characters/TestCharacter.dch` - one plain portrait (`Default`, no scene)
  and one scene-backed portrait (`LayeredPortrait`).
- `characters/TestCharacterPortrait.tscn` - the `LayeredPortrait` scene's
  node tree: `Body` and `Head` under the root, `LeftEye`/`RightEye` under
  `Head`. This is what `extra_data="set ..."` autocompletes against.
- `assets/theme.ogg`, `assets/voice_line.ogg`, `assets/bg.png` - empty
  placeholder files so `res://` path autocomplete has real files to offer.
- `timelines/test_timeline.dtl` - one file touching every language
  construct: comments, translation ids, `join`/`update`/`leave --All--`,
  transforms (`pos`/`size`), mood tags, `extra_data`, dialogue, narration,
  choices with conditions, `{variables}`, all four BBCode balises plus a
  custom one, every bracket command (`wait`, `wait_input`, `signal`,
  `voice`, `audio`, `clear`, `background`, `style`, `text_input`,
  `end_timeline`), flow control (`set`/`if`/`elif`/`else`/`while`), and
  `label`/`jump`.

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
