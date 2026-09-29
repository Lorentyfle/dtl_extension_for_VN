// -----------------------------------------------------------------------------
// Dialogic variables (`{folder.variable}`) in a timeline: finding them
// under the cursor, their documentation and suggestions.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const expressions = require('../completion/expressions');
const sources = require('../completion/sources');

// =============================================================================
// CHARACTER NAME HELPERS
// =============================================================================
// A DTL character name is either a bare identifier, or a double/single-quoted
// string - the quoted form lets a name contain spaces or symbols that
// wouldn't otherwise be valid (e.g. join "John Smith" left). Mirrors the
// equivalent alternation in dtl.tmLanguage.json's #commands/#dialogue rules,
// so the editor and the syntax highlighting agree on what counts as a name.

/**
 * Find the Dialogic variable (from project.godot's `variables={...}`)
 * under the cursor inside a `{...}` block, e.g. hovering `test` in
 * `{variable.test}`. The hovered segment decides how much of the path is
 * shown - hovering `variable` describes the whole group instead. Autoload
 * references like `{Global.hearts}` are handled by
 * findAutoloadReferenceAtPosition instead.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{markdown: vscode.MarkdownString, range: vscode.Range} | null}
 */
function findVariableAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  const blockPattern = /\{([^{}]*)\}/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(line)) !== null) {
    const innerStart = blockMatch.index + 1;
    const innerEnd = innerStart + blockMatch[1].length;
    if (position.character < innerStart || position.character > innerEnd) { continue; }

    const segmentPattern = /[^.\s]+/g;
    const pathSegments = [];
    let segmentMatch;
    while ((segmentMatch = segmentPattern.exec(blockMatch[1])) !== null) {
      pathSegments.push(segmentMatch[0]);
      const segmentStart = innerStart + segmentMatch.index;
      const segmentEnd = segmentStart + segmentMatch[0].length;
      if (position.character < segmentStart || position.character > segmentEnd) { continue; }

      let level = state.cachedVariablesTree;
      let entry = null;
      for (const segment of pathSegments) {
        entry = level && level.get(segment);
        if (!entry) { return null; }
        level = entry.children;
      }
      return {
        markdown: createVariableDocumentation(pathSegments.join('.'), entry),
        range: new vscode.Range(position.line, segmentStart, position.line, segmentEnd),
      };
    }
    return null;
  }
  return null;
}

/**
 * Best-effort GDScript type name for a raw default value from
 * project.godot, e.g. `1` -> int, `1.0` -> float, `"x"` -> String.
 *
 * @param {string} rawValue
 * @returns {string | null}
 */
function inferGdValueType(rawValue) {
  if (rawValue === null || rawValue === undefined) { return null; }
  if (/^-?\d+$/.test(rawValue)) { return 'int'; }
  if (/^-?(?:\d+\.\d*|\.\d+)(?:e-?\d+)?$/i.test(rawValue)) { return 'float'; }
  if (rawValue === 'true' || rawValue === 'false') { return 'bool'; }
  if (/^&?"/.test(rawValue)) { return 'String'; }
  if (rawValue.startsWith('[')) { return 'Array'; }
  if (rawValue.startsWith('{')) { return 'Dictionary'; }
  const constructorMatch = rawValue.match(/^([A-Z][A-Za-z0-9]*)\(/);
  return constructorMatch ? constructorMatch[1] : null;
}

/**
 * Build the hover shown for a Dialogic variable: its full path, its
 * default value and type (as declared in project.godot) - or, for a
 * variable group, the list of what it contains.
 *
 * @param {string} path - e.g. "variable.test"
 * @param {{value: string|null, children: Map|null}} entry
 * @returns {vscode.MarkdownString}
 */
function createVariableDocumentation(path, entry) {
  const markdown = new vscode.MarkdownString();
  if (entry.children) {
    markdown.appendMarkdown(`**{${path}}** _(Dialogic variable group)_\n\n`);
    for (const [name, child] of entry.children) {
      markdown.appendMarkdown(child.children
        ? `- \`${name}\` _(group, ${child.children.size} entries)_\n`
        : `- \`${name}\` = \`${child.value}\`\n`);
    }
    return markdown;
  }
  const type = inferGdValueType(entry.value);
  markdown.appendMarkdown(`**{${path}}** _(Dialogic variable${type ? ', ' + type : ''})_\n\n`);
  markdown.appendMarkdown(`Default value: \`${entry.value}\``);
  return markdown;
}

/**
 * True when `index` on `line` sits inside an open `{...}` variable block.
 *
 * @param {string} line
 * @param {number} index
 * @returns {boolean}
 */
function isInsideVariableBlock(line, index) {
  const before = line.slice(0, index);
  return before.lastIndexOf('{') > before.lastIndexOf('}');
}

// =============================================================================
// VARIABLE HELPERS
// =============================================================================

/**
 * Completion item for one segment of a `{variable.path}` reference, from
 * project.godot's `variables={...}`. A group (has children) re-triggers
 * suggestions once '.' is typed, via the Folder kind plus a re-trigger
 * command, the same way a LayeredPortrait node with children does.
 *
 * @param {string} name
 * @param {{value: string|null, children: Map|null}} entry
 * @returns {vscode.CompletionItem}
 */
function createVariableCompletion(name, entry) {
  const hasChildren = !!entry.children;
  const item = new vscode.CompletionItem(name, hasChildren ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Variable);
  item.detail = hasChildren ? 'Dialogic variable group' : entry.value === null ? 'Variable used in this timeline' : `Dialogic variable - default: ${entry.value}`;
  if (hasChildren) {
    // Straight into the group: `chapter` -> `chapter.`, with its variables.
    item.insertText = `${name}.`;
    item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL child variables' };
  }
  return item;
}

/**
 * Build `{variable.path}` completions from cachedVariablesTree, walking
 * one path segment at a time - typing `variable.` lists `variable`'s
 * children, mirroring how extra_data's LayeredPortrait node paths work.
 *
 * Dialogic also resolves `{Autoload.property}` against autoloads, so the
 * top level lists autoload names too, and `{Global.` lists that
 * autoload's variables, constants and enums (not its functions - a `{...}`
 * block reads a value, it doesn't call anything). A Dialogic variable
 * group with the same name as an autoload wins, same as in Dialogic.
 *
 * @param {string} typedPath - text typed so far inside the currently open '{'
 * @returns {vscode.CompletionItem[]}
 */
function createVariableSuggestions(typedPath) {
  const lastDot = typedPath.lastIndexOf('.');
  const parentSegments = lastDot === -1 ? [] : typedPath.slice(0, lastDot).split('.');
  const prefix = (lastDot === -1 ? typedPath : typedPath.slice(lastDot + 1)).toLowerCase();

  const variablesTree = sources.completionVariablesTree();
  if (parentSegments.length > 0 && !variablesTree.has(parentSegments[0])) {
    const symbols = state.cachedAutoloadSymbols.get(parentSegments[0]);
    if (!symbols) { return []; }
    if (parentSegments.length === 1) {
      return expressions.createAutoloadMemberSuggestions(parentSegments[0], symbols, prefix, { functions: false });
    }
    if (parentSegments.length === 2) {
      return expressions.createEnumValueSuggestions(symbols, parentSegments[1], prefix);
    }
    return [];
  }

  let level = variablesTree;
  for (const segment of parentSegments) {
    const entry = level.get(segment);
    if (!entry || !entry.children) { return []; } // unknown group, or a leaf - nothing further to suggest
    level = entry.children;
  }

  const items = [];
  for (const [name, entry] of level) {
    if (name.toLowerCase().startsWith(prefix)) {
      items.push(createVariableCompletion(name, entry));
    }
  }
  if (parentSegments.length === 0) {
    for (const name of state.cachedAutoloadSymbols.keys()) {
      if (!variablesTree.has(name) && name.toLowerCase().startsWith(prefix)) {
        items.push(expressions.createGlobalNameCompletion(name));
      }
    }
  }
  return items;
}

// =============================================================================
// GLOBAL SCRIPT (AUTOLOAD) HELPERS
// =============================================================================

/**
 * Every Dialogic variable of project.godot as a full path ("chapter",
 * "variable.test"...), with its default value - folders are walked, only
 * values are listed.
 *
 * @returns {{path: string, value: string}[]}
 */
function collectVariableLeaves() {
  const leaves = [];
  const walk = (tree, prefix) => {
    for (const [name, entry] of tree) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (entry.children) { walk(entry.children, path); } else { leaves.push({ path, value: entry.value }); }
    }
  };
  walk(sources.completionVariablesTree(), '');
  return leaves;
}

// =============================================================================
// QUICK FIXES
// =============================================================================
// Lightbulb fixes (Ctrl+.) for the problems DTL Reader reports: the closest
// existing names for a typo, creating what's missing (a label, a portrait),
// and removing or closing what's wrong (a jump's #id, an unclosed BBCode
// tag). Each fix re-reads the line its diagnostic points at rather than
// storing data on the diagnostic, so it always matches the current text.

/**
 * Every `{path}` a timeline can reference: Dialogic variables and the
 * members of the loaded autoloads.
 *
 * @returns {string[]}
 */
function collectVariableReferencePaths() {
  const paths = collectVariableLeaves().map(leaf => leaf.path);
  for (const [globalName, symbols] of state.cachedAutoloadSymbols) {
    for (const members of [symbols.variables, symbols.constants, symbols.enums]) {
      for (const name of members.keys()) { paths.push(`${globalName}.${name}`); }
    }
  }
  return paths;
}

Object.assign(module.exports, {
  findVariableAtPosition,
  inferGdValueType,
  isInsideVariableBlock,
  createVariableSuggestions,
  collectVariableReferencePaths,
});
