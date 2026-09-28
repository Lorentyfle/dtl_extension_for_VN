# DTL Reader

**VS Code language support for [Dialogic 2](https://github.com/dialogic-godot/dialogic): timelines (`.dtl`) and characters (`.dch`).**

Write your Dialogic timelines outside the Godot editor with syntax highlighting, context-aware autocomplete, documentation on hover, error checking against your Godot project, an outline, a live preview of BBCode effects, and tools to translate your story.

![A short screen recording scrolling through a highlighted `.dtl` file, showing the DTL Dark theme in action.](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/what_dtl_looks_like.gif)

- [Features at a glance](#features-at-a-glance)
- [With or without a Godot project](#with-or-without-a-godot-project)
- [Writing timelines](#writing-timelines)
- [Characters, moods and portraits](#characters-moods-and-portraits)
- [Variables and autoloads](#variables-and-autoloads)
- [Text effects](#text-effects)
- [BBCode](#bbcode)
- [Glossary](#glossary)
- [Navigation and outline](#navigation-and-outline)
- [Error checking](#error-checking)
- [Translation](#translation)
- [Character files (.dch)](#character-files-dch)
- [Themes](#themes)
- [Settings](#settings)
- [Commands](#commands)
- [Getting started](#getting-started)

## Features at a glance

| | |
|---|---|
| **Highlighting** | Dialogue, narration, choices, every Dialogic event, `{variables}`, BBCode, translation ids, signal dictionaries, autoload references |
| **Autocomplete** | Events, characters, moods, positions, animations, `res://` paths, labels and other timelines, `{variables}`, autoloads, text effects, BBCode tags, glossary words |
| **Hover documentation** | Events and their parameters, text effects, BBCode tags, glossary words, characters (with their translated names), moods, LayeredPortrait layers, variables, autoload members, labels |
| **Navigation** | Ctrl+Click on a `jump` (also into another timeline), Find All References and Rename for labels, jump counts above labels, Outline view in three styles |
| **Error checking** | Missing labels and timelines, unknown characters, moods and variables, unclosed BBCode tags - each one configurable |
| **BBCode preview** | `[color]`, `[rainbow]`, `[fade]`, `[b][i]`... show their effect right in the editor, in any combination |
| **Translation** | Translations next to the original text, a side-by-side Translation View for one or several languages, written into Dialogic's CSV |
| **Character files** | `.dch` highlighting, autocomplete of every key and value Dialogic uses, color picker, portraits suggested from your timelines |

Everything is read live from your Godot project (`project.godot`, `.dch`, `.tscn`, `.gd` and the translation CSVs), and updates as soon as those files change.

## With or without a Godot project

DTL Reader works in two ways, depending on whether it finds your Godot project's `project.godot` in the opened folder:

| | With `project.godot` | Without - each file on its own |
|---|---|---|
| Highlighting, themes, BBCode preview, outline | yes | yes |
| Events, parameters, BBCode, text effects: autocomplete and documentation | yes | yes |
| Characters, moods, `{variables}`, audio channels, `res://` paths | the project's (with their documentation) | the ones the timeline already uses |
| Labels: jumps, Ctrl+Click, references, rename | every timeline, including `jump Timeline/label` | inside the timeline |
| Autoloads (`do Global.foo()`...) | yes | - |
| Glossary colors and hovers | yes | - |
| Error checking | everything | missing labels and unclosed BBCode (nothing to check the rest against) |
| Translation (mode, Translation View, hovers) | yes | - (it needs the project's CSV files) |
| `.dch` files | everything | keys, values and documentation of the file itself |

Open the folder containing `project.godot` (or a parent folder of it) to get everything.

## Writing timelines

Suggestions appear where they make sense, and only there - no list pops up while you write a sentence:

- **Events** at the start of a line (`join`, `jump`, `set`, `if`...) and **bracket events** after `[` (`[wait]`, `[signal]`, `[background]`...), each with a short description in the list.
- **Event parameters** inside brackets, and their **values** when they're known: animations (`Bounce In`, `Slide To Left`...), transitions, easing, `move_trans`...
- **Characters** after `join`/`update`/`leave` and at the start of a dialogue line. Names with spaces are quoted automatically (`"John Smith"`).
- **Positions and transforms**: `left`, `center`..., `pos=`, `size=`, `rot=`.
- **Audio channels** after `audio`, from your Dialogic audio settings.
- **`res://` paths**, filtered to what each command accepts: audio files for `[voice path=""]` and `audio music ""`, images and videos for `[background arg=""]`, scenes for `[background scene=""]`, images for `[img]`, fonts for `[font=]`. Godot's `.import` and `.uid` files are never suggested.
- **Labels** after `jump`, **other timelines** (`jump chapter2/`), then that timeline's labels.
- **Words already used** in the timeline while you write dialogue (can be turned off).

![DTL autocomplete](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/demo_autocomplete.gif)

Hover any event, parameter or position to read its documentation. Indentation follows `if`/`elif`/`else` blocks and choices when you press Enter.

## Characters, moods and portraits

- **Moods**: typing `Laripo (` - as a speaker, or after `join`/`update` - suggests that character's portraits, read from their `.dch` file.
- **LayeredPortrait**: `[extra_data="set ..."]` suggests the layers of the portrait scene, one level at a time (`set Head/` lists `Head`'s children).
- **Hover a character** to see their display name in their color, nicknames and description.
- **Hover a mood** to see whether it's the default portrait, its scene or image, its layers, and the character's other moods.
- **Hover a layer** in `extra_data` to see its node type and the **Editor Description** you wrote on that node in Godot.

![Character moods](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/demo_dtl.gif)

## Variables and autoloads

- **Dialogic variables**: `{` suggests the variables of your project, folder by folder (`{chapter.` lists `chapter`'s variables). Hover one to see its default value and type.
- **Expressions** on `set`, `if` and `elif` lines follow Dialogic's syntax: `{variables}` are suggested without typing the `{`, `set {x} ` suggests `=`, `+=`, `-=`, `*=`, `/=`, then values fitting the variable (`true`/`false`, a random number...), and after a value come the comparisons and `and`/`or` (or `+ - * / %` in a `set`).
- **Autoloads** (scripts and scenes from Project Settings > Autoload) after `do`, `if`, `elif`, in `set` values and inside `{}`: their functions, variables, constants and enums (`VnLibrary.TimeId.CHAP2_R1`), with the `##` documentation comments of your GDScript code on hover. `do` only suggests functions, since it can only call one.
- Autoloads, enums, constants and properties each get their own color, inside `{}` too.
- Autoloads from addons (like Dialogic's own `Dialogic`) are hidden by default, as they expose hundreds of members - see `dtlReader.includeAddonAutoloads`.

## Text effects

Dialogic's own commands inside text - what happens when the reveal reaches them - are suggested after `[` and documented on hover:

| | |
|---|---|
| `[pause=x]` `[speed=x]` `[lspeed=x]` | pause, change the reveal speed or the letter speed |
| `[portrait=name]` `[mood=name]` `[extra_data=value]` | change the speaker's portrait, typing sound mood or portrait data mid-sentence - the values are suggested from the speaker |
| `[signal=arg]` | emit `Dialogic.text_signal` at that exact moment |
| `[aa]` `[ns]` `[nrs]` `[input]` | auto-advance, no skipping, no reveal skipping, wait for input |
| `[n]` `[n+]` | start a new text box (or continue in it) |
| `[if {condition} yes/no]` | conditional text |
| `<Hey!/Hello!/Hi!>` | random selection |

An unknown `[portrait=...]` is reported like an unknown mood.

## BBCode

- **Autocomplete**: `[` inside dialogue, narration and choices suggests Dialogic's commands first, then the most used Godot BBCode tags (the others appear as you type). `[/` suggests closing the tags still open on the line.
- **Documentation** of every Godot BBCode tag on hover, with a link to Godot's documentation.
- **Preview**: the text inside the tags shows what they do:

| Tag | In the editor |
|---|---|
| `[b]` `[i]` `[u]` `[s]` | bold, italic, underline, strikethrough |
| `[color=red]` `[color=#ff00ff80]` | the real color (Godot color names or hex) |
| `[bgcolor=]` / `[fgcolor=]` | a background / hidden text ("redacted") |
| `[outline_size]` + `[outline_color]` | an outline |
| `[rainbow]` / `[fade]` | a rainbow / letters fading out, following their parameters |
| `[wave]` `[shake]` `[tornado]` `[pulse]` | a stand-in for the animation: wavy, dotted or dashed underline, dimmed |
| `[url]` / `[hint=]` / `[img]` | a link / the hint on hover / the image on hover |
| `[char=2665]` | the character itself (♥) |

Tags can be nested and combined in any way (`[b][i][rainbow][wave]...`). Hex colors get a **color picker**.

## Glossary

The words of your Dialogic glossaries (listed in Dialogic's Glossary settings) are recognized in dialogue, narration and choices, the way Dialogic finds them in the game: whole words, the entry's name and alternatives, with its case sensitivity - and their translated forms in translation mode. They get their glossary color with a dotted underline, hovering one shows its title, text and extra info - translated in translation mode - and Ctrl+click opens its entry in the glossary file. Glossary words are also suggested first while writing dialogue.

## Navigation and outline

- **Ctrl+Click** (or F12) a `jump` target to go to its label - `jump OtherTimeline/label` opens the other timeline. Ctrl+Click a glossary word to open its glossary entry.
- **Find All References** (Shift+F12) on a label or a jump lists every jump to it, in every timeline. **Rename** (F2) renames a label and every jump to it at once.
- Above each label, **"N jumps here"** (click to list them) - or "no jump here" for the labels nothing leads to.
- **Document a label** with `##` comment lines right above it: the documentation shows when hovering the label or a `jump` to it, and in the `jump` suggestions.
- **Outline** view, breadcrumbs and Go to Symbol (Ctrl+Shift+O), in three styles (`dtlReader.outline.style`):
  - `flow` - the flow of time: each label with its conditions, choices and jumps, each jump saying where it leads (back, ahead, another timeline);
  - `indentation` - the structure by indentation only;
  - `dialogic` - only the labels.

![Navigation and diagnostics](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/navigation_and_warnings.gif)

## Error checking

Checked against your Godot project as you type. Each check can be set to error, warning, information, hint or hidden (**DTL Reader > Diagnostics**), and the Problems view shows which setting controls each one.

| Check | Default |
|---|---|
| `jump` to a label or timeline that doesn't exist (Dialogic would skip it) | error |
| `jump` ending with a `#id:` (Dialogic would search for a label including it) | error |
| `join`/`update`/`leave` with an unknown character | error |
| `Name: text` whose speaker isn't a character (Dialogic shows the whole line as narration) | warning |
| A `(mood)` the character doesn't have | error |
| A `{variable}` that is neither a Dialogic variable nor an autoload member | error |
| A BBCode tag without its closing tag | warning |
| A line not translated yet (in translation mode) | hint |
| `.dch`: a default portrait or a portrait scene that doesn't exist | error |

Nothing is reported about characters, variables or timelines when your project doesn't declare them.

## Translation

DTL Reader works with the translation CSV files Dialogic generates (**Update CSV files** in Dialogic's Translation settings), so translation needs the Godot project. After adding a new language, open Godot and click **Collect translation** so the game can use it.

- **Hover a line's `#id:`** to see it in every language. Hover a character to see their translated names, and a glossary word in translation mode to see its translated entry.
- **Translation View** - **DTL: Open Translation View**, or the globe button at the top right of a timeline, a character (`.dch`) or a glossary (`.tres`): for a timeline, the whole timeline as a translation sheet beside it, with each line's original text and an editable line for each language you pick (one or several, to translate or to compare). Type freely, then save with **Ctrl+S** to write every change into the CSV. Both editors scroll together; the view's own globe button changes its languages. From a `.dch` file it lists every character's name and nicknames, from a glossary every entry's name, alternatives, text and extra; from anywhere else, it asks what to translate - the characters, a glossary or any timeline.
- **Translation mode** - set `dtlReader.translation.language` (or run **DTL: Select Translation Language**): each translatable line shows its translation at its end, untranslated lines are marked, **DTL: Translate Line** (lightbulb or right-click) translates the current line, and **DTL: Go to Next Untranslated Line** finds the next one.

## Character files (.dch)

Dialogic character files get their own support:

- **Highlighting** of keys, strings, numbers and Godot values (`Color(...)`, `Vector2(...)`).
- **Autocomplete of the keys** Dialogic uses at each level: the character (`display_name`, `nicknames`, `color`, `default_portrait`...), each portrait (`scene`, `export_overrides`, `scale`, `offset`, `mirror`, `ignore_char_scale`, `sound_mood`), `export_overrides` (the `@export` variables of the portrait scene's script), `custom_info` (`style`, typing sounds) and each typing sound mood. Keys already set are not suggested again.
- **Autocomplete of the values**: the file's portraits for `default_portrait`, scenes for `scene`, images for `image`, sound files and folders for `sound_path`, the sound moods for `sound_mood`, the three typing sound modes, `true`/`false`, and default values for everything else.
- **New portraits from your timelines**: inside `portraits`, the moods your timelines use for this character but that aren't defined yet are suggested as complete portraits. A whole new character is suggested in an empty file.
- **Color picker** on `Color(...)` values.
- **Hover** documentation for every key, and hovering a portrait shows it like in a timeline.
- **Errors** for a default portrait or a portrait scene that doesn't exist.

## Themes

Four themes made for DTL (they also color the rest of VS Code):

- DTL Dark
- DTL Light
- DTL Dracula (based on Derek S. extension)
- DTL Godot-like

## Settings

**File > Preferences > Settings > Extensions > DTL Reader**, or search `@ext:lorentyfle.dtl-reader`.

| Setting | Default | |
|---|---|---|
| `dtlReader.outline.style` | `flow` | Outline style: `flow`, `indentation` or `dialogic` |
| `dtlReader.preview.bbcodeEffects` | on | Show BBCode effects in the editor |
| `dtlReader.preview.glossary` | on | Color glossary words in the text |
| `dtlReader.codeLens.labelReferences` | on | Show "N jumps here" above labels |
| `dtlReader.includeAddonAutoloads` | off | Also suggest autoloads declared by addons |
| `dtlReader.completion.dialogueWords` | on | Suggest words already used while writing dialogue |
| `dtlReader.completion.bbcode` | `common` | BBCode tags to suggest after `[`: `common`, `all` or `off` |
| `dtlReader.diagnostics.*` | see [Error checking](#error-checking) | Severity of each check, or `off` |
| `dtlReader.translation.language` | empty | Translation mode language (e.g. `fr`) |
| `dtlReader.translation.showInline` | on | In translation mode, show translations at the end of the lines |
| `dtlReader.translation.globeButton` | `dialogic` | Where the translation globe button shows: `dialogic` files, `everywhere` or `off` |

## Commands

From the Command Palette (Ctrl+Shift+P):

| Command | |
|---|---|
| **DTL: Open Translation View** | Open the current timeline's Translation View |
| **DTL: Change Translation View Languages** | Pick other languages for the open Translation View |
| **DTL: Translate Line** | Translate the current line |
| **DTL: Go to Next Untranslated Line** | Jump to the next line to translate |
| **DTL: Select Translation Language** | Choose (or turn off) the translation mode language |

## Getting started

Install the extension and open the folder of your Godot project (the one containing `project.godot`) - or any folder, see [With or without a Godot project](#with-or-without-a-godot-project). Open any `.dtl` file - the extension activates automatically. A minimal timeline looks like this:

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

Issues and pull requests are welcome at the [GitHub repository](https://github.com/Lorentyfle/dtl_extension_for_VN). The `test-room/` folder is a small fake Godot project with a timeline touching every feature - open it as a workspace to try everything (see its `README.md`).

## Credits

Built for [Dialogic 2](https://github.com/dialogic-godot/dialogic).

A big thank you to the Dialogic developers and contributors for creating and maintaining such a powerful extension.

## License

See `LICENSE`, bundled with the extension package.
