# Changelog
## [1.0.8]
- Outline for `.dtl` files (Outline view, breadcrumbs, sticky scroll, Ctrl+Shift+O): one entry per `label`, with its display name or `##` documentation next to it. Each label also lists its flow, nested like the timeline: `if`/`elif`/`else`/`while` blocks, choices, and `jump`/`return`/`[end_timeline]`. The new `dtlReader.outline.showFlow` setting turns that off to only list the labels.
- Jumps to another timeline, `jump Timeline/label` and `jump Timeline/` (its start), as Dialogic allows. Timelines come from project.godot's `directories/dtl_directory`:
    - Autocomplete: `jump ` suggests this timeline's labels and the other timelines, `jump Timeline/` suggests that timeline's labels.
    - Ctrl+click on the timeline opens it, on the label goes to it.
    - Hover shows the other timeline's labels, and the label's `##` documentation.
- A `jump` to a missing label is now an error, not a warning: Dialogic prints "Label not found" at runtime and silently skips the jump. A missing timeline or a missing label in another timeline is an error too. A `jump {variable}` is never flagged, since Dialogic resolves it at runtime.
- Bug: `jump Timeline/label` was flagged as a missing label.
- Labels follow Dialogic's syntax: the name can contain spaces, and `label Name (Display Name)` is supported (colored, shown in hovers and the outline).
## [1.0.7]
- Bug: in DTL Dracula, autoload properties (e.g. `VnLibrary.Stat_dict`) had the same color as plain text; they're now orange. In DTL Godot-like they're a more visible blue.
- Autoload references inside `{}` (e.g. `{VnManager.current_vn_time}`) are now colored like everywhere else (autoload, then property, enum or value). Only real autoloads are colored this way, so Dialogic variable folders like `{chapter.value}` are unaffected. The DTL themes turn on VS Code's semantic highlighting for this.
- When project.godot is found, errors and warnings for things that don't exist in the project:
    - `join`/`update`/`leave` with an unknown character.
    - A dialogue line whose speaker is not a known character (a warning, since Dialogic then shows the whole line as narration).
    - A `(mood)` the character doesn't have.
    - A `{variable}` that is neither a Dialogic variable of project.godot nor an autoload, or an autoload member that doesn't exist (`{Global.nope}`).
    - Nothing is reported if project.godot has no character list / no variables list, and addon autoloads that aren't loaded are never reported.
- `##` comment lines directly above a `label` are its documentation: shown when hovering the label or a `jump` to it, and in the `jump` suggestions.
- Hover documentation for moods/portraits: which character it belongs to, whether it's the default portrait, its scene or image, non-default mirror/offset/scale, its LayeredPortrait layers, and the character's other moods.
- Hover documentation for LayeredPortrait layers in `extra_data="set Head/LeftEye"`: the node's type, its "Editor Description" from Godot, and its child layers.
## [1.0.6]
- Addition of hover documentation for Dialogic variables inside `{}`: shows the variable's default value and type (from project.godot), or the content of a variable group.
- Autocomplete and hover for autoloads now also work in `set` values and `while` conditions, e.g. `set {VnLibrary.current_vn_time} = VnLibrary.TimeId.CHAP2_R1`.
- Better colors for autoload references: the autoload, a nested enum (`TimeId`), a constant or enum value (`CHAP2_R1`), a property and a function all get their own color. `[if ...]` conditions of choices use them too.
- Bug: `==` inside `[if ...]` made the word before it colored as an attribute name.
- Path suggestions only show files that fit the command: audio files for `[voice path=""]` and `audio KIND ""`, images/videos for `[background arg=""]`, scenes for `[background scene=""]`, images for `[img]...[/img]` and fonts for `[font=...]`. `audio KIND ` now directly suggests the audio files instead of an empty `""`.
- Bug: accepting a path after typing part of it (e.g. `"res://ass`) duplicated the `res://` part.
- BBCode suggestions (still only inside dialogue, narration and choices): a bare `[` now shows Dialogic's commands first, then only the most common BBCode tags. The rest appear once a letter of their name is typed.
- Suggestions for Dialogic commands and BBCode tags now show a short description on the same row, so what each one does is visible directly in the list. The full documentation is still in the details panel (Ctrl+Space).
- Dialogic commands and BBCode tags now have different icons in the suggestion list (a lightning bolt for Dialogic events, the keyword icon for BBCode), so they can be told apart at a glance after `[`.
- Signal dictionary arguments (`arg="{"type":"dice","s":false}"`) are colored like JSON: keys, strings, numbers, booleans and punctuation, whether the inner quotes are escaped or not.
## [1.0.5]
- Addition of suggestion and documentation for autoload nodes: an autoload pointing at a `.tscn` scene now uses its root node's script.
- Addition of Godot variables (`var`, including `@export`/`@onready`), enums and constants to suggestion and documentation, for both autoload nodes and autoload scripts. `Global.State.` suggests the enum's values, and `{Global.property}` is suggested inside `{}` too. Multi-line function signatures are now supported.
- For path suggestions, `.import` and `.uid` files are no longer suggested.
- Addition of documentation and suggestion for all the BBCodes available in Godot's RichTextLabel (hover on `[tag]` or `[/tag]`, with a link to the Godot documentation). BBCodes are only suggested inside dialogue, narration and choices, `[/` suggests closing the tags still open on the line, and self-closing tags like `[br]` are no longer flagged as unclosed.
- Bug: far too many suggestions for autoloads. Inside a string or a function argument (e.g. `Global.has_achievement("intro`) every character and word of the file was suggested; now nothing is. `do` only suggests functions, and autoload names only pop up right after `do`/`if`/`elif`/`and`/`or`/`not` (typing a letter still suggests them anywhere). Autoloads declared by addons (e.g. Dialogic's own `Dialogic` singleton) are hidden unless the new `dtlReader.includeAddonAutoloads` setting is on. The unused `class_name` scanning was removed, since Dialogic can only reach autoloads.
- Bug: typing `.` (or a space, or `'`) while writing dialogue no longer opens a list of every word in the file. Word suggestions only show while typing a word; `.` only suggests after a variable or an autoload.
## [1.0.4]
- If no nicknames are given, make the nickname lines absent.
- Minor correction for theme colors.
## [1.0.3]
- Addition of suggestion and documentation for autoload script (functions only) used from Godot scripts.
## [1.0.2]
- Addition of suggestions for dialogic variables inside {}.
- Addition of documentation for characters using .dch file of the dialogic character (to push people to document their characters while working on a project).
## [1.0.1]
- Remove the Design Philosophy category and implement back both of them inside the editor for a more user friendly approach.
    - ' can also be used for strings and if the character name is in between "" or '' it needs to count it as a character.
    - To let characters with spaces or strange symbols have their names counted. Make the autocomplete smart enough to do it on its own.
## [1.0.0] - 2026-09-06
- Update the README for full release with description of all new features and updates all pictures using test room for it.
## [0.1.11] - 2026-09-05
- Bug: The extra_data set does not work, there is no suggestion after writing `[extra_data="set ]`.
- Test room updated to be more global.
## [0.1.10] - 2026-09-05
- Bug: `leave --All--` had lost its color - `keyword.control.command.dtl` (matched first) always won the tie for where `leave` starts, consuming just the word `leave` and leaving the old `^\s*leave\s+(--All--)` rule's line-start anchor unable to ever fire again. Rewritten as a lookbehind so it no longer needs that anchor.
- Bug: pressing Enter after `if`/`elif`/`else`/`while`/`- choice` didn't increase indentation - `while` was missing from `indentationRules.increaseIndentPattern` (only listed in the separate `onEnterRules`), and there was no `decreaseIndentPattern` at all, so `elif`/`else` never snapped back to their matching `if`'s indent. Both are now unified into one pattern (also tolerant of a trailing `# comment` after the colon), matching how Python blocks behave.
- **Emotion/mood autocomplete**: typing `John (` (as a dialogue speaker, or after `join`/`update`) now suggests that character's moods, read from their `.dch` file's `portraits` dictionary (resolved via `project.godot`'s `directories/dch_directory`). Moods backed by a LayeredPortrait `scene` additionally power `extra_data="set ..."` autocomplete, which walks that scene's `.tscn` node tree one path segment at a time (e.g. `set Body/` suggests `Body`'s children).
## [0.1.9] - 2026-09-05
- Autocomplete for `res://` resource paths: `[voice path="..."]`, `[background arg="..." scene="..."]`, and `audio KIND "..."` now suggest real files from the Godot project, read live from the project.godot folder (same refresh mechanism as character names).
- Mood/emotion highlighting: `join John (default) left`, `update John (sad) center`, and a dialogue speaker's `John (angry): ...` all color the `(mood)` tag with a new shared "emotion" scope.
- `extra_data="set Emotion/Happy"` now colors the `Emotion/Happy` part with that same emotion scope, so it visually matches the `(mood)` tags above - the literal `"set "` stays a dim string color.
- The bundled DTL Dark theme now styles the general VS Code UI (activity bar, sidebar, status bar, tabs, panels, buttons, lists, scrollbars, git decorations) instead of only the editor's text colors.
- Three new bundled themes, all following the same DTL scope structure as DTL Dark: **DTL Light** (Atom One Light-inspired), **DTL Dracula** (palette based on the Dracula theme, credited to Derek S.), and **DTL Godot-like** (inspired by the Godot 4 script editor's default look).
## [0.1.8] - 2026-09-04
- Bug: hovering an option that sits directly against `[` (e.g. `[fade` as the first inline option of join/update/leave) now shows its documentation instead of silently doing nothing.
- Bug: position keywords (`left`, `right`, `center`, `leftmost`, `rightmost`) now show hover documentation when used as join/update's position argument.
- Autocomplete for known attribute VALUES: `animation=` (join, update, leave) and `transition=` (background) now suggest their real option names (e.g. `"Bounce In"`), not just the attribute name itself. `move_trans=`/`move_ease=` (update) got the same treatment.
- README written.
## [0.1.7] - 2026-09-04
- Autocomplete and hover documentation for the `[...]` options bracket of join, update and leave (was previously unsupported, only the bracket-style commands like `[wait]` had it).
- Autocomplete and hover documentation for join/update's transform commands (`pos`, `size`, `rot`) typed between the character/position and the `[...]` bracket.
- Bug: accented characters (e.g. `Léa`) are now recognized as valid character names, both in syntax highlighting and in the extension's own line-detection logic.
- Bug: the choice color now stops right after the `|` instead of continuing into the conditions/`#id:` that follow.
- Bug: bracket commands (`[wait]`, `[signal ...]`, `[audio ...]`, `[voice ...]`, `[clear ...]`, `[background ...]`, `[style ...]`, `[text_input ...]`, `[end_timeline]`) now get their proper color when used inside dialogue, narration, or choice text, instead of falling back to the generic bracket color.
## [0.1.6] - 2026-09-04
- audio autocomplete should be personalized as kind can be found in project.godot.
## [0.1.5] - 2026-09-04
- BBCode balises highlight.
- Add documentation and suggestion for each of the possible entries for [] dialogic entries (hoover + autocomplete).
- Bug: after a dialogic command, like label, do, set, return, if, else, elif, default autocomplete like dialogue text should be shown. Currently only character are suggested which should only be for join, update and leave.
- Bug: Choices do not have default autocomplete like dialogue text but only character are suggested.
- Make in sort tabulation level is kept when typing enter.
- jump should have suggestion based on already written labels in the file.
## [0.1.4] - 2026-09-04
- Non stated character names as dialogue text.
- Markdown balises highlight. (temporary)
## [0.1.3] - 2026-09-04
- Vscode suggestion similar to txt for dialogue text.
- ctrl+click on the jump label moves toward the position of the label.
## [0.1.2] - 2026-09-03
- Add while to the commands.
- Documentation shown for dialogic commands.
- Recognize text_input command.
- Autocomplete working for commands and characters + specific join | leave and update have personalize autocomplete.
## [0.1.1] - 2026-09-03
- Suggestion of character names.
- Most of the balises missed are now highlighted.
- Bug correction.
## [0.1.0] - 2026-09-03
- Syntax highlight for the important commands.
