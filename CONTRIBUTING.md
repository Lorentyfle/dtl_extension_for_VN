# Contributing to DTL Reader

Thanks for helping! Issues and pull requests are welcome at the [GitHub repository](https://github.com/Lorentyfle/dtl_extension_for_VN).

- [Getting started](#getting-started)
- [How the code is organized](#how-the-code-is-organized)
- [Conventions](#conventions)
- [Testing](#testing)
- [Releasing](#releasing)

## Getting started

The extension is plain JavaScript - no build step, no runtime dependency. You only need [VS Code](https://code.visualstudio.com/), and [Node.js](https://nodejs.org/) for `npm` (not even that, see [Testing](#testing)).

```bash
git clone https://github.com/Lorentyfle/dtl_extension_for_VN
cd dtl_extension_for_VN
npm install
```

Open the folder in VS Code and press **F5** (**Run Extension (test-room)**): a second VS Code window opens on [`test-room/`](test-room/), a small fake Godot project, with the extension loaded from your working copy. [`test-room/README.md`](test-room/README.md) lists what to try for each feature. After a change, reload that window (**Developer: Reload Window**).

## How the code is organized

`package.json` declares everything VS Code shows without running code: the languages, grammars (`syntaxes/`), themes (`themes/`), settings, commands and menus. Everything else is in `src/`:

| | |
|---|---|
| `extension.js` | `activate()`: creates the shared editor objects, registers every provider and command, and watches the project's files. No feature logic. |
| `state.js` | The project data the modules share (characters, variables, autoloads, timelines, translations...), as one object. |
| `project.js` | Reads the Godot project - `project.godot` and everything it points to - into `state`, keeps it up to date, and finds files in it. |
| `docs/` | Dialogic's events, BBCode tags, text effects and `.dch` keys, with their documentation. Mostly data. |
| `godot/` | Reading and writing Godot's text formats: dictionaries, `.tscn`, `.tres`, ConfigFile, project settings, GDScript members. |
| `timeline/` | What a timeline line is, the way Dialogic reads it (`syntax.js`), and the references it can contain: autoloads, variables, moods. |
| `completion/` | The completion provider (`index.js`) and what it builds suggestions from. |
| `diagnostics/` | The problems reported (`index.js`: severities, re-checking), by kind. |
| `quick-fixes/` | The lightbulb fixes (`index.js`), and those adding to `project.godot`. |
| `translation/` | Dialogic's translation CSV files, translation mode, and the Translation View. |
| `dch/` | Character files: reading them, and their completion, hover and problems. |
| `features/` | One module per remaining feature: hover, Go to Definition, outline, colors, BBCode preview, glossary, custom events, Play in Godot... |

Every module starts with a comment saying what it's for, and every function has a JSDoc comment. Most features follow the same path: `project.js` reads the project into `state`; a provider (hover, completion, diagnostics...) reads `state` and the document; when a project file changes, a watcher in `extension.js` re-reads the project and the open documents are checked again.

## Conventions

- **Modules import each other as namespaces**, `const syntax = require('../timeline/syntax')`, and call `syntax.parseJumpLine(...)`. Modules require each other in cycles (the project refresh re-checks the diagnostics, which read the project...), so a module never destructures an import, and adds its exports with `Object.assign(module.exports, { ... })` at its end instead of replacing `module.exports` - that way every namespace is complete by the time anything is called.
- **Shared data lives in `state`**, and only data more than one module uses. What a single module needs stays a `let` in that module.
- **Nothing is computed while a module loads** that needs another module - only inside functions.
- **Follow Dialogic.** When DTL Reader recognizes, checks or counts something (an event, a label, a line's event index...), it does it the way Dialogic's own code does, and the comment says where that comes from. When Dialogic changes, those are the places to update.
- **Everything is configurable and quiet by default when unsure.** A new check gets a `dtlReader.diagnostics.*` setting, and reports nothing when the project doesn't declare what it would check against.
- **Style**: 2-space indentation, single quotes, semicolons, LF line endings. Match the code around your change.
- **User-facing text** (messages, settings, README, CHANGELOG) says what the feature does for someone writing a timeline, in plain words.

## Testing

```bash
npm test
```

The tests run the extension in a real VS Code, on copies of `test-room/`, and check what it does through VS Code's own commands. See [`test/README.md`](test/README.md) to run a single suite, see every check, or write a new one. CI runs them on Linux and Windows for every pull request.

No Node.js? VS Code's own can run them (Windows, from Git Bash):

```bash
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" test/run.js
```

A change comes with a test of what it changes, and `npm test` passing. For something the tests can't reach (a decoration's look, a picker the user answers), say in the pull request how you checked it by hand in `test-room/`.

## Releasing

1. Update the version in `package.json` and `package-lock.json` (both `version` fields at the top).
2. Add the version's section at the top of `CHANGELOG.md`: what changed, for someone using the extension.
3. Update `README.md` and `test-room/README.md` for new or changed features.
4. Run `npm test`.
5. Build the package: `npx vsce package` (or, without Node.js, `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" node_modules/@vscode/vsce/vsce package --no-dependencies`), and install the `.vsix` to try it once (**Extensions: Install from VSIX...**).
6. Publish with `npx vsce publish`, and tag the commit (`git tag v2.0.0`).
