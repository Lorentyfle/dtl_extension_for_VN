# DTL Reader

**VS Code language support for [Dialogic 2](https://github.com/dialogic-godot/dialogic) `.dtl` timelines.**

Syntax highlighting, autocomplete and useful IDE features for writing Dialogic timelines outside the Godot editor.

![A short screen recording scrolling through a highlighted `.dtl` file, showing the DTL Dark theme in action.](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/what_dtl_looks_like.gif)

## Features

### DTL syntax highlighting

Full syntax highlighting for Dialogic's timeline text format, including dialogue, choices, events, shortcodes, text effects, variables and more.

![DTL syntax highlighting](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/dtl_highlight.png)

### Context-aware autocomplete

Suggestions are available where they are useful, including:

- Dialogic events and their parameters
- `[]` text effects and shortcodes
- Character names
- Portraits and moods
- Position and transform values such as `pos=`, `size=` and `rot=`
- Animation names and animation parameters
- Audio resources and audio settings
- Godot `res://` and `user://` paths
- Layered Portrait `extra_data`
- Labels and jump targets

![DTL autocomplete](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/demo_autocomplete.gif)

### Character moods

Autocomplete for character moods works with both Dialogic's normal mood system and Layered Portraits.

![DTL autocomplete](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/demo_dtl.gif)

### Navigation & diagnostics

DTL Reader understands the relationship between `jump` and `label`.

- **Ctrl+Click** (or F12) a `jump` target to go to its label.
- Get a warning when a `jump` points to a label that does not exist in the current timeline.
- Get a warning when a BBCode tag is not properly closed.

![Navigation and diagnostics](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/navigation_and_warnings.gif)

## Themes

Includes four themes made for DTL:

- DTL Dark
- DTL Light
- DTL Dracula (based on Derek S. extension)
- DTL Godot-like

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

## Requirements

- **Visual Studio Code** 1.85+
- **Godot** 4.7.2+
- **Dialogic 2** 2.0-Alpha-20+

## Design Philosophy

A few intentional choices differ from writing directly in the Godot/Dialogic editor:

- Apostrophes (`'`) are **not** treated as string delimiters, since they're used for plain English contractions (`don't`, `it's`). Highlighting them as strings would make dialogue nearly unreadable.
- Labels and character names must **not** contain spaces or brackets.

## Contributing

Issues and pull requests are welcome at the [GitHub repository](https://github.com/Lorentyfle/dtl_extension_for_VN).

## Credits

Built for [Dialogic 2](https://github.com/dialogic-godot/dialogic).

A big thank you to the Dialogic developers and contributors for creating and maintaining such a powerful extension.

## License

See `LICENSE`, bundled with the extension package.
