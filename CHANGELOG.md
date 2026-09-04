# Changelog

## [Planned]
- Missing feature: suggestion for paths.
- Missing feature: No suggestion for [] part for join, update and leave (should use documentation already written). as it is used this way: `join character position [animation="" extra_data=""]`
- Missing feature: Make the extra_data become fully functionnal. [VERY COMPLEX, nice but not necessary]
- Bug: Make in sort if, else, elif, while, - choice, increase the tabulation by one.
- Bug: the color of the choice continues even after the | where it should stop.
- Bug: Accents are not counted as possible character name. Of example: Léa.
- Bug: if `[wait]` is inside dialogue text it will not have good color.
## [0.1.0] - 2026-09-03
- Syntax highlight for the important commands.
## [0.1.1] - 2026-09-03
- Suggestion of character names.
- Most of the balises missed are now highlighted.
- Bug correction.
## [0.1.2] - 2026-09-03
- Add while to the commands.
- Documentation shown for dialogic commands.
- Recognize text_input command.
- Autocomplete working for commands and characters + specific join | leave and update have personalize autocomplete.
## [0.1.3] - 2026-09-04
- Vscode suggestion similar to txt for dialogue text.
- ctrl+click on the jump label moves toward the position of the label.
## [0.1.4] - 2026-09-04
- Non stated character names as dialogue text.
- Markdown balises highlight. (temporary)
## [0.1.5] - 2026-09-04
- BBCode balises highlight.
- Add documentation and suggestion for each of the possible entries for [] dialogic entries (hoover + autocomplete).
- Bug: after a dialogic command, like label, do, set, return, if, else, elif, default autocomplete like dialogue text should be shown. Currently only character are suggested which should only be for join, update and leave.
- Bug: Choices do not have default autocomplete like dialogue text but only character are suggested.
- Make in sort tabulation level is kept when typing enter.
- jump should have suggestion based on already written labels in the file.
## [0.1.6] - 2026-09-04
- audio autocomplete should be personalized as kind can be found in project.godot.
