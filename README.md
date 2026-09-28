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
- Godot `res://` paths, filtered to the files each command can use (audio, images, scenes, fonts)
- Layered Portrait `extra_data`
- Labels and jump targets
- Dialogic variables inside `{}`, with their default value on hover
- Autoload scripts and autoload nodes (scenes) after `do`, `if`, `elif` and `while`, in `set` values, and inside `{}`: their functions, variables, constants and enums, with their `##` documentation comments
- Every Godot BBCode tag (`[b]`, `[color=...]`, `[wave]`, `[br]`...) inside dialogue, narration and choices, plus the matching closing tag after `[/`

Autoloads declared by addons (under `res://addons/`, like Dialogic's own `Dialogic` singleton) are hidden by default. Turn on the `dtlReader.includeAddonAutoloads` setting to show them.

![DTL autocomplete](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/demo_autocomplete.gif)

### Character moods

Autocomplete for character moods works with both Dialogic's normal mood system and Layered Portraits.

![DTL autocomplete](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/demo_dtl.gif)

### Navigation & diagnostics

DTL Reader understands the relationship between `jump` and `label`.

- **Ctrl+Click** (or F12) a `jump` target to go to its label, including `jump OtherTimeline/label` in another timeline.
- See the timeline in the **Outline** view and the breadcrumbs, in the style you prefer (**DTL Reader > Outline: Style**): the flow of time (labels, choices, conditions and where each jump leads), the indentation structure, or only the labels like Dialogic.
- Get an error when a `jump` points to a label or timeline that does not exist.
- Get a warning when a BBCode tag is not properly closed.
- Get an error for characters, moods and `{variables}` that don't exist in the Godot project.
- Document a label with `##` comment lines right above it: the doc shows when hovering a `jump` to it.

### Translation mode

Translate your timelines without leaving them. Set **DTL Reader > Translation: Language** (e.g. `fr`), or run **DTL: Select Translation Language**:

- every translatable line (it has a `#id:`) shows its translation at the end of the line, or "not translated yet";
- **DTL: Translate Line** (Command Palette, right-click menu or the lightbulb) asks for the translation next to the original, and writes it in Dialogic's translation CSV;
- **DTL: Go to Next Untranslated Line** jumps to the next line left to translate;
- hover a line's `#id:` to see it in every language;
- **DTL: Open Translation View** (or the globe button at the top right of a timeline) opens the whole timeline as a translation sheet beside it: each line's original text with an editable line for each language you pick (one or several, to translate or compare them). Type, then save with **Ctrl+S** to write everything into the CSV. Both editors scroll together, and the globe button in the view changes its languages.

The CSV files are the ones Dialogic generates with **Update CSV files** in its Translation settings.

### Settings

Every warning and error can be set to error, warning, information, hint or hidden, one by one (**DTL Reader > Diagnostics**). You can also choose which BBCode tags are suggested, turn off word suggestions in dialogue, show only labels in the outline, and more.

### Dialogic character files (.dch)

`.dch` files get syntax highlighting, autocomplete of the keys and values Dialogic expects at each level (character, portrait, `export_overrides`), hover documentation for every key, and errors for a missing default portrait or portrait scene.

### Hover documentation

Hover a command, a BBCode tag, a character, a mood, a LayeredPortrait layer, a `{variable}` or an autoload member to see its documentation. It's read live from your Godot project: `.dch` files, `.tscn` scenes (the nodes' Editor Description), project.godot and `##` comments in scripts.

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

## Contributing

Issues and pull requests are welcome at the [GitHub repository](https://github.com/Lorentyfle/dtl_extension_for_VN).

## Credits

Built for [Dialogic 2](https://github.com/dialogic-godot/dialogic).

A big thank you to the Dialogic developers and contributors for creating and maintaining such a powerful extension.

## License

See `LICENSE`, bundled with the extension package.
