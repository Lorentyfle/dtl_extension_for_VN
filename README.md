# DTL Reader

Syntax highlighting, autocomplete, and IDE tooling for **DTL** (`.dtl`) files - the timeline format used by the [Dialogic 2](https://github.com/dialogic-godot/dialogic) addon for writing visual novel dialogue in Godot.

![A short screen recording scrolling through a highlighted `.dtl` file, showing the DTL Dark theme in action.](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/what_dtl_looks_like.gif)

## Features

- **Syntax highlighting** for characters, dialogue, narration, choices, commands, `{variables}`, and `[balises]`, via a dedicated TextMate grammar and the bundled "DTL Dark" theme.

![A sample timeline with the DTL Dark theme applied, showing several distinct colors (character names, dialogue, commands).](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/classic_commands_for_dtl.png)


![A sample timeline with the DTL Dark theme applied, showing several distinct colors for choices.](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/test_choice.png)

- **Autocomplete** for:
  - Character names, read live from `project.godot`.
  - Commands (`label`, `jump`, `set`, `join`, `update`, `leave`, `do`, ...) and their bracket-style counterparts (`[wait]`, `[signal]`, `[background]`, ...).
  - Parameters inside `[...]` brackets, including join/update/leave's own trailing options bracket.
  - Known parameter **values**, e.g. `animation=` or `transition=` suggest their real option names.
  - Audio channel names, read live from `project.godot`.
  - `res://` resource paths for `[voice path=...]`, `[background arg=...]`/`[background scene=...]`, and `audio KIND "..."`, read live from the Godot project's files.
  - `jump` targets, based on `label`s already declared in the file.
  - Word-based suggestions inside dialogue text, similar to plain `.txt` editing.

- **Mood/emotion highlighting**: an optional `(mood)` tag right after a character name - `join John (default) left`, `update John (sad) center`, or a dialogue speaker like `John (angry): ...` - is colored as emotion. `extra_data="set Emotion/Happy"` gets the same treatment on its value as it affects LayeredSprite which is used for LayeredPortraits.

![Autocomplete dropdown popping up over a partially-typed `join` command, showing character names.](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/join_character.gif)

- **Hover documentation** on commands, brackets, parameters, and position keywords - each shows its syntax, description, parameters, and an example.


- **Diagnostics** for unresolved `jump` targets and unclosed `[balise]` tags.

- **Go to Definition**: Ctrl+Click (or F12) a `jump NAME` to land on its matching `label NAME`.
![A short clip of Ctrl+Click jumping from a `jump` line to its `label`.](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/jump_demogif.gif)

## Installation

1. Install **DTL Reader** from the VS Code Marketplace, or install the `.vsix` manually via *Extensions → ... → Install from VSIX*.
2. Open the Command Palette (`Ctrl+Shift+P`) → **Preferences: Color Theme** → pick one of the bundled themes for full color support:
   - **DTL Dark** - the default, also themes the general VS Code UI.
   - **DTL Light** - an Atom One Light-inspired palette.
   - **DTL Dracula** - palette based on the Dracula theme, credit to Derek S. for the color choices.
   - **DTL Godot-like** - inspired by the Godot 4 script editor's default look.

## Getting Started

Open any `.dtl` file - the extension activates automatically. A minimal timeline looks like this:

```dtl
join Laripo left
Laripo: Hello there! [b]Welcome[/b] to the documentation.

- Ask about the weather | #id:choice_weather
- Leave                 | #id:choice_leave

label ending
[end_timeline]
```
![Direct conversion to dtl](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/direct_conversion_from_readme.png)

## Design Philosophy

A few intentional choices differ from writing directly in the Godot/Dialogic editor:

- Apostrophes (`'`) are **not** treated as string delimiters, since they're used for plain English contractions (`don't`, `it's`). Highlighting them as strings would make dialogue nearly unreadable.
- Labels and character names must **not** contain spaces or brackets.
- BBCode-style balise nesting (`[i][b]...[/b][/i]`) is combined and colored correctly up to 2 nested tags. Beyond that, only the innermost tag's style is shown - this is a display limitation of the extension, not of Dialogic itself, which supports arbitrary nesting.

## Known Limitations

See [CHANGELOG.md](./CHANGELOG.md) for the current list of open bugs and missing features.

## Contributing

Issues and pull requests are welcome at the [GitHub repository](https://github.com/Lorentyfle/dtl_extension_for_VN).

## License

See `LICENSE`, bundled with the extension package.
