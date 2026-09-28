# Changelog
## [1.4.0]
- Dialogic's own text effects and modifiers, inside dialogue, narration and choices:
    - Autocomplete after `[` (with Dialogic's commands, before the BBCode tags) and documentation on hover: `[pause=x]`, `[speed=x]`, `[lspeed=x]`, `[signal=arg]`, `[portrait=name]`, `[mood=name]`, `[extra_data=value]`, `[aa]`, `[ns]`, `[nrs]`, `[input]`, `[n]`, `[n+]` and conditional text `[if {condition} yes/no]`.
    - Values from the speaker: their portraits for `[portrait=`, their typing sound moods for `[mood=`, their LayeredPortrait layers for `[extra_data=set `.
    - Their own color, and the random selection modifier `<Hey!/Hello!/Hi!>` too.
    - An unknown `[portrait=...]` is reported like an unknown mood. Text effects are never reported as unclosed BBCode.
- Labels: Find All References (Shift+F12) on a label or a jump lists every jump to it, including `jump ThisTimeline/label` from other timelines. Rename (F2) renames the label and every jump to it, in every timeline, refusing names Dialogic would misread or that already exist. "N jumps here" above each label (setting `dtlReader.codeLens.labelReferences`) - "no jump here" also shows the labels nothing leads to.
- Glossary: the entries of the glossaries listed in project.godot are recognized in dialogue, narration and choices like Dialogic does (whole words, name and alternatives, case sensitivity):
    - The words get their glossary color with a dotted underline (setting `dtlReader.preview.glossary`).
    - Hovering one shows its title, text and extra info (translated in translation mode) and where it comes from.
    - Glossary words are suggested first while writing dialogue.
- Character names: the character hover shows the translations of their name and nicknames from Dialogic's character translation CSV.
## [1.3.1]
- Better autocomplete for `.dch` character files:
    - `custom_info` keys Dialogic uses (`style`, `sound_mood_default`, `sound_moods`) and every key of a typing sound mood (`sound_path`, `mode`, `pitch_base`, `pitch_variance`, `volume_base`, `volume_variance`, `skip_characters`), with documentation. The portrait key `sound_mood` too.
    - Values: the file's sound moods for `sound_mood`/`sound_mood_default`, the three modes (`0` INTERRUPT, `1` OVERLAP, `2` AWAIT) for `mode`, sound files and folders for `sound_path`.
    - Inside `portraits`, the moods your timelines use for this character but that the file doesn't define yet are suggested as complete portraits (with where they're used), plus a "New portrait" and a "New sound mood" snippet.
    - A complete character is suggested in an empty `.dch` file.
    - `export_overrides` values follow the `@export` variable's type (`"true"`, `"0.0"`, `"\"\""`...) or its default value.
    - Bug: keys set after the cursor in the same block were suggested again.
- Color picker: on `Color(...)` values in `.dch` files, and on `#hex` colors of BBCode tags (`[color=#ff0000]`, `[bgcolor=]`, `[pulse color=]`...) in timelines.
- README rewritten to describe everything DTL Reader can do, with a table of every setting and command.
## [1.3.0]
- BBCode preview: the text inside Godot BBCode tags shows their effect right in the editor, in timelines and in the Translation View:
    - `[b]`, `[i]`, `[u]`, `[s]`: bold, italic, underline, strikethrough.
    - `[color=...]`: the real color (Godot color names like `red`, `aqua`, `light_blue`, or `#hex`). `[bgcolor=...]`: a background. `[fgcolor=...]`: "redacted" (text hidden in that color).
    - `[outline_size]` + `[outline_color]`: an outline around the letters.
    - `[rainbow]`: a rainbow across the letters (using its `freq`, `sat` and `val`). `[fade]`: the letters fade out where Godot fades them (`start`, `length`).
    - Animated effects get a static stand-in: `[wave]` wavy underline, `[shake]` dotted underline with spaced letters, `[tornado]` dashed underline, `[pulse]` dimmed.
    - `[url]`: link color and underline. `[hint=...]`: dotted underline, with the hint on hover. `[img]res://...[/img]`: the image on hover. `[char=2665]`: shows the character (♥).
    - Tags combine and nest freely (`[b][i][rainbow][wave]...`): bold/italic/underlines add up, the innermost color or background wins, opacity multiplies.
    - Can be turned off with `dtlReader.preview.bbcodeEffects`.
## [1.2.2]
- Bug: a BBCode tag with parameters lost its color: `[shake level=1]...[/shake]`, `[color=red]...[/color]`, `[wave amp=50 freq=5]...[/wave]` and every other tag taking a value were colored like a plain `[option]` instead of like `[shake]...[/shake]`. They now get the effect color, with their parameters colored inside the tag (names, `=`, strings, numbers and `true`/`false`). Dialogic's own text effects without a closer (`[pause=1.5]`, `[speed=2]`...) are unchanged.
- Bug: a BBCode tag with parameters that is never closed (`[shake level=1]` without `[/shake]`) is now reported by the unclosed BBCode check too.
## [1.2.1]
- The Translation View can show several languages at once: every translatable line gets its original text and one editable line per language, so you can translate into several languages, or check the other translations, side by side.
- The languages are picked when opening the view (a multi-select list of every language in the CSV, plus "Other language..." for a new one), not in the settings. The last choice is remembered per workspace.
- A globe button in the Translation View's title bar changes its languages: the view is replaced in place (the old tab is kept only if it has unsaved edits).
- Saving writes the changed lines of every language at once. Lines left unchanged are never rewritten, so looking at another language is safe.
- Bug: the language picker could pre-select a language the project doesn't have (e.g. `fr` from the translation mode setting set for another project). Only the project's own languages are pre-selected now: its CSV's, or the ones last picked in this workspace.
- Bug: when project.godot doesn't set `translation/original_locale` (Godot leaves it out while it's at its default), the original language wasn't known, so it could be offered as a language to translate to. It's now taken from the CSV's first language column, which is always the original in Dialogic's CSVs.
## [1.2.0]
- Translation View: "DTL: Open Translation View" (or the globe button at the top right of a timeline) opens, beside the timeline, an editor listing every translatable line of the timeline with its original text and an editable line for the translation language. Type the translations there like in any file (search, multi-cursor, copy/paste...) and save with Ctrl+S: every changed translation is written into Dialogic's CSV at once.
    - Each block shows its CSV key, the timeline line and who says it (speaker, narration, choice, label, text input).
    - The original line is only a reference: editing it changes nothing. A line break in a translation is written `\n`.
    - Moving the cursor in the timeline scrolls the view to that line's block, and the other way round.
    - The view reloads when the timeline is saved or the CSV changes (unless it has unsaved edits).
    - If the translations can't be saved (no CSV yet, or the CSV has unsaved changes in an editor), the save fails with the reason and nothing is lost.
## [1.1.0]
- New setting `dtlReader.outline.style` to choose how the Outline view, breadcrumbs and Go to Symbol show a timeline:
    - `flow` (default): the flow of time. Each label is a section with its `if`/`elif`/`else`/`while` blocks and choices nested by indentation, and every `jump`/`return`/`[end_timeline]` says where it leads: back to an earlier line (a loop), ahead, to another timeline, or a runtime `{variable}` target. A label indented inside a choice or condition now stays inside it.
    - `indentation`: the timeline's structure by indentation only. Labels, blocks and choices are nested under the block they're indented in, and labels are plain entries rather than sections. No jumps.
    - `dialogic`: only the labels, like Dialogic organizes a timeline.
- `dtlReader.outline.showFlow` is replaced by `outline.style` (turning it off still gives the `dialogic` style if no style is chosen).
## [1.0.10]
- `.dch` files now use the same Dialogic icon as `.dtl` files.
- Settings (File > Preferences > Settings > Extensions > DTL Reader), in 4 sections:
    - General: `includeAddonAutoloads`, `outline.showFlow` (already there).
    - Autocomplete: `completion.dialogueWords` (word suggestions while writing dialogue, on/off) and `completion.bbcode` (`common`, `all` or `off`).
    - Diagnostics: every check has its own severity (`error`, `warning`, `information`, `hint` or `off` to hide it): unresolved jump, jump with a translation id, unknown character, unknown speaker, unknown mood, unknown variable, unclosed BBCode, missing translation, and the two `.dch` checks. The Problems view shows each diagnostic's setting name as its code.
    - Translation: `translation.language` and `translation.showInline`.
- Translation mode, to translate the timelines in the timelines themselves. Set `dtlReader.translation.language` (e.g. `fr`), or use "DTL: Select Translation Language":
    - Each translatable line (dialogue, narration, choice, label display name, text input, with its `#id:`) shows its translation at the end of the line, or "not translated yet".
    - "DTL: Translate Line" (Command Palette, right-click menu, or the lightbulb quick fix) asks for the translation, showing the original text, and writes it into Dialogic's translation CSV (`dialogic_timeline_translations.csv` or `dialogic_<timeline>_translation.csv`). It adds the language column or the line's row if they're missing.
    - "DTL: Go to Next Untranslated Line".
    - Untranslated lines are marked with a hint (`diagnostics.missingTranslation`).
    - Hovering a line's `#id:` shows its text in every language of the CSV, even without translation mode.
## [1.0.9]
- Bug: a label's translation id (`label choice A1 #id:cc3`) was read as part of its name, so `jump` suggested and inserted `choice A1 #id:cc3`. Like Dialogic, everything from `#id:` on is now ignored in a label, and colored as a translation id.
- A `jump` with a `#id:` is now an error: a jump isn't translatable, so Dialogic doesn't cut the id off and would look for a label named `choice A1 #id:cc3`.
- Support for Dialogic character files (`.dch`), as their own "Dialogic Character" language:
    - Syntax highlighting.
    - Autocomplete of the keys that make sense where the cursor is: the character's keys (`display_name`, `nicknames`, `color`, `default_portrait`, `portraits`...), a portrait's keys (`scene`, `export_overrides`, `scale`, `offset`, `mirror`, `ignore_char_scale`), and in `export_overrides` the `image` of the default portrait plus the `@export` variables of the portrait scene's script. Keys already set are not suggested again.
    - Autocomplete of values: the file's portraits for `default_portrait`, `.tscn` scenes for `scene`, images for `image` (written as Dialogic expects, `"\"res://...\""`), `true`/`false`, and default `Color(...)`/`Vector2(...)` values.
    - Hover documentation for every key, and for a portrait name (same as hovering the mood in a timeline).
    - Errors for a `default_portrait` that isn't one of the portraits, and a portrait `scene` that doesn't exist in the project.
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
