# Tests

The tests run DTL Reader in a real VS Code, on a copy of [`test-room/`](../test-room/) - a small fake Godot project - and check what it does through VS Code's own commands: the diagnostics it reports, the quick fixes and suggestions it offers, where Ctrl+Click leads, what it writes.

## Running them

```bash
npm test
```

Without Node.js installed, VS Code's own Node can run them (Windows, from Git Bash):

```bash
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" test/run.js
```

- `test/run.js expressions` runs only that suite.
- `DTL_TEST_VERBOSE=1` prints every check, not only the failed ones.
- `VSCODE_PATH=...` picks the VS Code executable. Otherwise, the one of `@vscode/test-electron` when it's installed (as in CI), else the usual install location.

Each suite opens its own VS Code window, with every other extension disabled and a throw-away user profile, and closes it when it's done. The whole run takes about a minute.

## The suites

| Suite | What it checks |
|---|---|
| `fixes-and-navigation` | Quick fixes (typos, missing labels and portraits, adding characters and variables to project.godot, the folder a new character goes in), Ctrl+Click, Go to Symbol in Workspace |
| `project-checks` | Unreachable events and labels, unused characters and portraits, custom events, block snippets, Play in Godot (with a stand-in for Godot), the event index of each line |
| `expressions` | Suggestions on `set`, `if` and `elif` lines |
| `features` | One check of each other feature: hover, outline, semantic tokens, colors, code lens, references, rename, completion, `.dch` files, glossary, translation (including a Translation View edit saved into the CSV) |
| `isolated` | A timeline without `project.godot`: what is still checked and suggested |

## Writing one

A suite is a folder of `test/suites/` with:

- `fixture.js` (optional) - `exports.prepare = root => { ... }` adds the files the suite needs to its copy of `test-room/`. Keep `test-room/` itself for manual testing: a suite adds its own problem files instead of changing the shared ones.
- `index.js` - runs inside VS Code:

```js
const vscode = require('vscode');
const { check, suite, start, open } = require('../../harness');

exports.run = suite(async () => {
  const { at } = await start();
  const uri = at('timelines', 'test_timeline.dtl');
  await open(uri);
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(5, 2));
  check('join has a hover', hovers.length > 0, hovers);
});
```

`check(name, condition, found)` records a result - `found` is shown when it fails. `start()` waits until the project has been read. `ext.exports.forTests` gives a few internal functions to test directly (see the end of `activate` in `src/extension.js`).
