# DTL Reader

**VS Code language support for [Dialogic 2](https://github.com/dialogic-godot/dialogic): timelines (`.dtl`) and characters (`.dch`).**

Write your Dialogic timelines outside the Godot editor with syntax highlighting, context-aware autocomplete, documentation on hover, error checking against your Godot project, an outline, a live preview of BBCode effects, and tools to translate your story.

![A short screen recording scrolling through a highlighted `.dtl` file, showing the DTL Dark theme in action.](https://raw.githubusercontent.com/Lorentyfle/dtl_extension_for_VN/main/assets/what_dtl_looks_like.gif)

- [Features at a glance](#features-at-a-glance)
- [With or without a Godot project](#with-or-without-a-godot-project)
- [Writing timelines](#writing-timelines)
- [Characters, moods and portraits](#characters-moods-and-portraits)
- [Variables and autoloads](#variables-and-autoloads)
- [Custom events](#custom-events)
- [Text effects](#text-effects)
- [BBCode](#bbcode)
- [Glossary](#glossary)
- [Navigation and outline](#navigation-and-outline)
- [Error checking](#error-checking)
- [Translation](#translation)
- [Character files (.dch)](#character-files-dch)
- [Playing a timeline](#playing-a-timeline)
- [Themes](#themes)
- [Settings](#settings)
- [Commands](#commands)
- [Getting started](#getting-started)

## Features at a glance

| | |
|---|---|
| **Highlighting** | Dialogue, narration, choices, every Dialogic event, `{variables}`, BBCode, translation ids, signal dictionaries, autoload references |
| **Autocomplete** | Events (your custom ones too), characters, moods, positions, animations, `res://` paths, labels and other timelines, `{variables}`, autoloads, text effects, BBCode tags, glossary words, whole blocks (choice, condition, loop...) |
| **Hover documentation** | Events and their parameters, text effects, BBCode tags, glossary words, characters (with their translated names), moods, LayeredPortrait layers, variables, autoload members, labels |
| **Navigation** | Ctrl+Click on a `jump`, a character, a mood, a `res://` path, an autoload member or a glossary word; Go to Symbol in Workspace (Ctrl+T) for labels, timelines and characters; Find All References and Rename for labels, jump counts above labels, Outline view in three styles |
| **Error checking** | Missing labels and timelines, unknown characters, moods and variables, unclosed BBCode tags, events that never run, unused characters and portraits - each one configurable, most with a quick fix |
| **Play in Godot** | Run the timeline in your game with one click - or from the cursor's line - like Dialogic's own play buttons |
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
| Ctrl+Click on characters, moods, `res://` paths | yes | - |
| Autoloads (`do Global.foo()`...) | yes | - |
| Glossary colors and hovers | yes | - |
| Error checking | everything | missing labels and unclosed BBCode (nothing to check the rest against) |
| Translation (mode, Translation View, hovers) | yes | - (it needs the project's CSV files) |
| Custom events, unused characters and portraits, Play in Godot | yes | - |
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
- **Whole blocks** on an empty line, with the events: `choice` (two choices and what follows each), `if` (if / else, or if / elif / else), `loop` (a label and a condition jumping back to it - Dialogic has no `while`), `scene` (join, a line, leave) and `text_input` (a question and a check of the answer). Their character placeholders list your characters.

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
- **Expressions** on `set`, `if` and `elif` lines follow Dialogic's syntax, with a short list where a value starts: after `if`, `elif`, `and`/`or` or a comparison, `{}`, the autoloads, `true`, `false` and `not`; after `set`, `{}` and the autoloads (`{VnManager.current_vn_time}`). Picking `{}` opens the variables inside it, folder by folder (`{_tmp_var.random_var.rdm_var1}`). `set {x} ` suggests `=`, `+=`, `-=`, `*=`, `/=`, then values fitting the variable (`true`/`false`, a random number...), and after a value come the comparisons and `and`/`or` (or `+ - * / %` in a `set`).
- **Autoloads** (scripts and scenes from Project Settings > Autoload) after `do`, `if`, `elif`, in `set` values and inside `{}`: their functions, variables, constants and enums (`VnLibrary.TimeId.CHAP2_R1`), with the `##` documentation comments of your GDScript code on hover. `do` only suggests functions, since it can only call one.
- Autoloads, enums, constants and properties each get their own color, inside `{}` too.
- Autoloads from addons (like Dialogic's own `Dialogic`) are hidden by default, as they expose hundreds of members - see `dtlReader.includeAddonAutoloads`.

## Custom events

The events you add to Dialogic yourself - scripts extending `DialogicEvent` in Dialogic's extensions folder (**Project Settings > Dialogic > Extensions folder**, `res://addons/dialogic_additions/` by default) - work like the built-in ones: `[` suggests them, `[my_event ` suggests their parameters, and hovering shows their `event_name`, `event_description` and the `##` comment of each property a parameter sets, with its type and default. A `bool` parameter suggests `true`/`false`, and the `suggestions` of `get_shortcode_parameters()` are suggested as values.

```gdscript
## How strong the shake is.
@export var strength: float = 1.0

func get_shortcode() -> String:
	return "screen_shake"

func get_shortcode_parameters() -> Dictionary:
	return {
		"strength": {"property": "strength", "default": 1.0},
	}
```

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

- **Ctrl+Click** (or F12) to open what a name refers to:
  - a `jump` target: its label - `jump OtherTimeline/label` opens the other timeline;
  - a character (speaker or `join`/`update`/`leave`): their `.dch` file;
  - a mood - `(happy)` or `[portrait=happy]`: that portrait in the character's `.dch` file;
  - a `res://` path: the file;
  - an autoload (`Global`, `Global.apply_tint`, `Global.State.IDLE`, also inside `{}`): its script, on that member's line;
  - a glossary word: its glossary entry.
  In a `.dch` file, Ctrl+Click a `res://` path, or the `default_portrait` value to go to that portrait.
- **Go to Symbol in Workspace** (Ctrl+T) finds any label of any timeline, a timeline, or a character.
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
| Events that never run: after a top-level `[end_timeline]`, `jump` or `return`, until the next label a jump leads to (shown faded) | hint |
| A label nothing leads to: no `jump` to it in any timeline, no script naming it (`Dialogic.start("chapter1", "intro")`), and the timeline stops right before it | warning |
| `.dch`: a character no timeline uses | hint |
| `.dch`: a portrait no timeline uses, other than the default one (shown faded) | hint |

Nothing is reported about characters, variables or timelines when your project doesn't declare them. A `jump {variable}` could lead to any label, so labels aren't reported in a timeline it may jump to.

**Quick fixes** (the lightbulb, or Ctrl+.):

| Problem | Fixes |
|---|---|
| A misspelled label, timeline, character, mood, `{variable}`, `default_portrait` or portrait scene | **Change to "..."** - the closest existing names (a swapped letter or a wrong case counts as a typo) |
| An unknown character | **Add the character to project.godot** - registered in Dialogic's character directory, with a new `Name.dch` file (its portrait is the mood the line gives them, if any), in the folder you pick - or the existing `Name.dch` if the project already has one |
| An unknown `{variable}` | **Add the variable to project.godot** - in Dialogic's variables, creating its folders (`{chapter1.met_john}`), as any of Dialogic's types: a text (`""`), a whole number (`0`), a decimal number (`0.0`) or a bool (`false`). The type fitting how the line uses it comes first |
| `jump` to a missing label | **Create "label ..."** at the end of the timeline it points to, after an `[end_timeline]` if the timeline didn't end there |
| A `(mood)` the character doesn't have | **Add the portrait** to the character's `.dch` file, then opens it on the new portrait's image path |
| A `jump` with a `#id:` | **Remove the translation id** |
| An unclosed BBCode tag | **Close [tag]** at the end of the line's text (before the `#id:` and a choice's condition) |

For a new character, the folders most likely to fit come first, each saying why:

1. a character folder named like the timeline's folder (`timelines/chapter2/market.dtl` suggests `characters/chapter2/`);
2. the folder of the characters this timeline already uses - a new character usually belongs with the scene's cast;
3. the project's other character folders, the most used first;
4. with no character yet, a `characters` folder beside your timelines folder, or the timeline's own folder.

Press Enter for the first one, or pick **Other folder...** for any folder of the project. The file is always named after the character, since Dialogic uses the file name as the character's identifier.

The fixes adding to project.godot save it right away. If the Godot editor is open, reload the project there afterwards (**Project > Reload Current Project**), so Godot doesn't write its older settings over them.

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
- **Unused**: a hint when no timeline uses the character, and portraits no timeline uses are faded.

## Playing a timeline

The **play** button at the top right of a timeline (or **DTL: Play Timeline in Godot**, also in the right-click menu) runs it in your game, the way Dialogic's own play button does: the timeline is saved, set as the one to play in Dialogic's editor settings, and Godot starts Dialogic's test scene on it. Godot's output goes to the **DTL Reader: Godot** output panel.

**Play from this line** - **Ctrl+Shift+F6** (Cmd+Shift+F6 on macOS), Alt+click on the play button, or **DTL: Play Timeline from This Line** in the right-click menu - starts the timeline at the event of the cursor's line, like Dialogic's own "Play from here": the events above are skipped, to test a condition or a variable change without replaying the whole timeline.

It uses the Godot executable set in `dtlReader.godotPath`, else the one of the [godot-tools](https://marketplace.visualstudio.com/items?itemName=geequlim.godot-tools) extension, else `godot` from the PATH. `dtlReader.playButton` hides the button.

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
| `dtlReader.godotPath` | empty | The Godot 4 executable for **Play Timeline in Godot** (empty: godot-tools' one, else `godot` from the PATH) |
| `dtlReader.playButton` | on | Show the play button at the top right of a timeline |

## Commands

From the Command Palette (Ctrl+Shift+P):

| Command | |
|---|---|
| **DTL: Open Translation View** | Open the current timeline's Translation View |
| **DTL: Change Translation View Languages** | Pick other languages for the open Translation View |
| **DTL: Translate Line** | Translate the current line |
| **DTL: Go to Next Untranslated Line** | Jump to the next line to translate |
| **DTL: Select Translation Language** | Choose (or turn off) the translation mode language |
| **DTL: Play Timeline in Godot** | Run the current timeline in Godot, with Dialogic's test scene |
| **DTL: Play Timeline from This Line** | The same, starting at the cursor's line (Ctrl+Shift+F6) |

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
