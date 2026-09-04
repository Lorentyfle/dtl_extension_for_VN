# Changelog

## [Unreleased]
- Missing feature: suggestion for paths.
- Missing feature: Make the extra_data become fully functionnal. [VERY COMPLEX, nice but not necessary]
- Bug: Make in sort if, else, elif, while, - choice, increase the tabulation by one.
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
