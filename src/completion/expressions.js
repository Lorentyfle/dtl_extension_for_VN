// -----------------------------------------------------------------------------
// Suggestions in set/if/elif/do expressions: {}, autoloads and their
// members, operators and values.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const autoloads = require('../timeline/autoloads');
const variables = require('../timeline/variables');

// =============================================================================
// GLOBAL SCRIPT (AUTOLOAD) HELPERS
// =============================================================================

/**
 * Matches the start of a line up to where a GDScript-style expression
 * begins - i.e. where an autoload reference like `Global.foo()` or
 * `Global.State.IDLE` could meaningfully appear:
 * - after `do`, `if` or `elif` (group 1 is the keyword);
 * - after the assignment operator of `set {variable} = ` (also `+=`,
 *   `-=`, `*=`, `/=`), where group 1 is undefined.
 * Requires whitespace after the keyword (or the `=`, for set) so
 * still-typing the keyword itself (e.g. text ending in exactly "do") isn't
 * mistaken for an already-complete keyword with an empty expression.
 *
 * @type {RegExp}
 */
const EXPRESSION_START_PATTERN = /^\s*(?:(do|if|elif)\s+|set\s+\{[^}]*\}\s*[-+*/]?=\s*)/;

/**
 * True when `text` - either what's been typed so far on a line, or a full
 * line - has reached an expression (see EXPRESSION_START_PATTERN).
 *
 * @param {string} text
 * @returns {boolean}
 */
function isGlobalScriptExpressionLine(text) {
  return EXPRESSION_START_PATTERN.test(text);
}

/**
 * True when `text` ends inside a still-open `"..."` or `'...'` string
 * literal (escaped quotes are skipped), e.g. `Global.foo("intro`.
 *
 * @param {string} text
 * @returns {boolean}
 */
function endsInsideStringLiteral(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; }
      else if (ch === quote) { quote = null; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }
  return quote !== null;
}

/**
 * Completion item for an autoload name itself (before its `.`), e.g.
 * `Global` in `do Global.`. Inserts a trailing `.` and re-triggers
 * suggestions, so its members show up immediately.
 *
 * @param {string} name
 * @returns {vscode.CompletionItem}
 */
function createGlobalNameCompletion(name) {
  const symbols = state.cachedAutoloadSymbols.get(name);
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
  item.detail = symbols && symbols.scenePath ? 'Dialogic autoload node' : 'Dialogic autoload script';
  if (symbols) { item.documentation = autoloads.createAutoloadDocumentation(name, symbols); }
  item.insertText = new vscode.SnippetString(`${name}.$0`);
  item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL autoload members' };
  return item;
}

/**
 * Completion item kind, sort group, and insert behavior for each kind of
 * autoload member. Functions sort first, since calling one is the most
 * common reason to reach into an autoload from a timeline.
 */
const AUTOLOAD_MEMBER_KINDS = {
  function: { itemKind: vscode.CompletionItemKind.Method, sortGroup: '0' },
  variable: { itemKind: vscode.CompletionItemKind.Field, sortGroup: '1' },
  constant: { itemKind: vscode.CompletionItemKind.Constant, sortGroup: '2' },
  enum: { itemKind: vscode.CompletionItemKind.Enum, sortGroup: '3' },
};

/**
 * Completion item for one member of an autoload (function, variable,
 * constant or enum). Its GDScript `##` doc comment (if any) becomes the
 * completion's own documentation, matching what the hover shows. A
 * function inserts `name(|)`; an enum inserts `Name.` and re-triggers so
 * its values show up next.
 *
 * @param {string} globalName
 * @param {string} name
 * @param {'function'|'variable'|'constant'|'enum'} kind
 * @param {object} info
 * @returns {vscode.CompletionItem}
 */
function createAutoloadMemberCompletion(globalName, name, kind, info) {
  const { itemKind, sortGroup } = AUTOLOAD_MEMBER_KINDS[kind];
  const item = new vscode.CompletionItem(name, itemKind);
  item.detail = autoloads.formatAutoloadMemberSignature(globalName, name, kind, info);
  item.documentation = new vscode.MarkdownString(info.doc || autoloads.NO_GD_DOC_MESSAGE);
  item.sortText = `${sortGroup}_${name}`;
  if (kind === 'function') {
    item.insertText = new vscode.SnippetString(`${name}($0)`);
  } else if (kind === 'enum') {
    item.insertText = new vscode.SnippetString(`${name}.$0`);
    item.command = { command: 'editor.action.triggerSuggest', title: 'Show DTL enum values' };
  }
  return item;
}

/**
 * Build completions for the members of one autoload, filtered by the
 * member-name prefix typed so far.
 *
 * @param {string} globalName
 * @param {GdScriptSymbols} symbols
 * @param {string} prefix - lowercase member-name prefix typed so far
 * @param {{functions?: boolean, values?: boolean}} [include] - which member
 *   groups to offer: `functions` (default true) and `values` - variables,
 *   constants and enums (default true)
 * @returns {vscode.CompletionItem[]}
 */
function createAutoloadMemberSuggestions(globalName, symbols, prefix, include = {}) {
  const { functions = true, values = true } = include;
  const groups = [];
  if (functions) { groups.push(['function', symbols.functions]); }
  if (values) { groups.push(['variable', symbols.variables], ['constant', symbols.constants], ['enum', symbols.enums]); }
  const items = [];
  for (const [kind, members] of groups) {
    for (const [name, info] of members) {
      if (name.toLowerCase().startsWith(prefix)) {
        items.push(createAutoloadMemberCompletion(globalName, name, kind, info));
      }
    }
  }
  return items;
}

/**
 * Build completions for a named enum's values, e.g. `IDLE` after
 * `Global.State.`.
 *
 * @param {GdScriptSymbols} symbols
 * @param {string} enumName
 * @param {string} prefix - lowercase value-name prefix typed so far
 * @returns {vscode.CompletionItem[]}
 */
function createEnumValueSuggestions(symbols, enumName, prefix) {
  const enumInfo = symbols.enums.get(enumName);
  if (!enumInfo) { return []; }
  return enumInfo.values
    .filter(value => value.name.toLowerCase().startsWith(prefix))
    .map(value => {
      const item = new vscode.CompletionItem(value.name, vscode.CompletionItemKind.EnumMember);
      item.detail = `${enumName}.${value.name} = ${value.value}`;
      if (value.doc) { item.documentation = new vscode.MarkdownString(value.doc); }
      return item;
    });
}

/** Operators, as Dialogic's conditions (Godot Expression) and set events accept them. */
const CONDITION_OPERATORS = [
  ['==', 'is equal to'], ['!=', 'is not equal to'], ['>', 'is greater than'], ['<', 'is less than'],
  ['>=', 'is greater than or equal to'], ['<=', 'is less than or equal to'],
  ['and', 'both conditions must be true'], ['or', 'at least one condition must be true'],
];

const ARITHMETIC_OPERATORS = [['+', 'plus (or joins two texts)'], ['-', 'minus'], ['*', 'times'], ['/', 'divided by'], ['%', 'remainder of the division']];

const SET_OPERATORS = [
  ['=', 'Set: the variable becomes the value.'], ['+=', 'Add the value to the variable.'], ['-=', 'Subtract the value from the variable.'],
  ['*=', 'Multiply the variable by the value.'], ['/=', 'Divide the variable by the value.'],
];

/**
 * Completion items for operators. Each inserts itself plus a space and
 * re-opens the suggestions, ready for the next operand.
 *
 * @param {[string, string][]} operators
 * @param {string} group - for sorting
 * @returns {vscode.CompletionItem[]}
 */
function createOperatorItems(operators, group) {
  return operators.map(([operator, doc], index) => {
    const item = new vscode.CompletionItem({ label: operator, description: doc }, /^[a-z]/.test(operator) ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Operator);
    item.insertText = `${operator} `;
    item.sortText = `${group}_${String(index).padStart(2, '0')}`;
    item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest the next value' };
    return item;
  });
}

/**
 * The `{}` suggestion where a variable can go (a set target, an if/elif
 * operand): it inserts the braces - around what was typed, if anything -
 * and reopens the suggestions inside them, where the variables are listed
 * folder by folder.
 *
 * @param {string} typed - the name typed so far
 * @param {vscode.Range} range - that name
 * @returns {vscode.CompletionItem}
 */
function createVariableBracesItem(typed, range) {
  const item = new vscode.CompletionItem({ label: '{}', description: 'a variable' }, vscode.CompletionItemKind.Variable);
  item.detail = 'Dialogic variable - {folder.variable}, or {Autoload.variable}';
  item.documentation = new vscode.MarkdownString('Inserts `{}` and suggests the variables inside it, folder by folder (`{chapter.` lists `chapter`\'s variables), then the autoloads\' variables.');
  item.insertText = new vscode.SnippetString(`{${typed.replace(/[$}\\]/g, '\\$&')}$0}`);
  item.filterText = typed || '{';
  item.range = range;
  item.sortText = '0_{}';
  item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest variables' };
  return item;
}

/**
 * Suggestions on a `set` line before its operator (see Dialogic's set
 * event: `set {variable} <operator> value`): `{}` and the autoloads
 * (inserted as `{Autoload.`) for the variable to set, then the operators
 * `=`, `+=`, `-=`, `*=`, `/=`.
 *
 * @param {string} beforeCursor
 * @param {vscode.Position} position
 * @returns {vscode.CompletionItem[] | null} null if not a set target
 */
function createSetTargetSuggestions(beforeCursor, position) {
  const setMatch = beforeCursor.match(/^\s*set\s+(.*)$/);
  if (!setMatch || isGlobalScriptExpressionLine(beforeCursor)) { return null; }
  const rest = setMatch[1];
  const targetMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (targetMatch) {
    // Only `{}` and the autoloads - the variables themselves come once
    // inside the braces, folder by folder, instead of all at once here.
    const typed = targetMatch[1] || '';
    const range = new vscode.Range(position.line, position.character - typed.length, position.line, position.character);
    const items = [createVariableBracesItem(typed, range)];
    for (const name of state.cachedAutoloadSymbols.keys()) {
      if (!name.toLowerCase().startsWith(typed.toLowerCase())) { continue; }
      // A set target is always a {variable}: {Autoload.variable}.
      const item = createGlobalNameCompletion(name);
      item.insertText = new vscode.SnippetString(`{${name}.$0}`);
      item.filterText = name;
      item.range = range;
      items.push(item);
    }
    return items;
  }
  if (/^\{[^}]*\}\s+$/.test(rest)) {
    return SET_OPERATORS.map(([operator, doc], index) => {
      const item = createOperatorItems([[operator, doc]], `0${index}`)[0];
      item.documentation = new vscode.MarkdownString(`${doc}\n\n\`set {variable} ${operator} value\``);
      return item;
    });
  }
  return null;
}

/**
 * Value suggestions after `set {variable} = `, from the variable's type:
 * true/false for a bool, a random number for a number, "" for a text.
 *
 * @param {string} beforeCursor
 * @returns {vscode.CompletionItem[]}
 */
function createSetValueItems(beforeCursor) {
  const targetMatch = beforeCursor.match(/^\s*set\s+\{([^}]*)\}/);
  if (!targetMatch) { return []; }
  const segments = targetMatch[1].split('.');
  let level = state.cachedVariablesTree;
  let entry = null;
  for (const segment of segments) { entry = level && level.get(segment); if (!entry) { break; } level = entry.children; }
  let type = entry && !entry.children ? variables.inferGdValueType(entry.value) : null;
  if (!type && state.cachedAutoloadSymbols.has(segments[0]) && segments.length === 2) {
    const info = state.cachedAutoloadSymbols.get(segments[0]).variables.get(segments[1]);
    type = info ? (info.type || variables.inferGdValueType(info.defaultValue || '')) : null;
  }
  const items = [];
  const add = (label, insert, doc, kind) => {
    const item = new vscode.CompletionItem({ label, description: doc }, kind);
    item.insertText = insert;
    item.sortText = `0_${label}`;
    items.push(item);
  };
  if (type === 'bool') {
    add('true', 'true', 'bool', vscode.CompletionItemKind.Keyword);
    add('false', 'false', 'bool', vscode.CompletionItemKind.Keyword);
  } else if (type === 'int' || type === 'float') {
    add('random number', new vscode.SnippetString('range(${1:1}, ${2:10}).pick_random()'), 'Dialogic\'s random number: range(min, max).pick_random()', vscode.CompletionItemKind.Snippet);
  } else if (type === 'String') {
    add('"text"', new vscode.SnippetString('"$1"'), 'a text value', vscode.CompletionItemKind.Snippet);
  }
  return items;
}

/**
 * Build completions for an expression - after `do`/`if`/`elif`,
 * or on the right-hand side of `set {variable} = ...` (see
 * EXPRESSION_START_PATTERN): either autoload names, a specific autoload's
 * members (once `Name.` has been typed), or a named enum's values (once
 * `Name.Enum.` has been typed), e.g.
 * `set {VnLibrary.current_vn_time} = VnLibrary.TimeId.CHAP2_R1`.
 *
 * Kept deliberately narrow, so the list only opens where an autoload
 * reference can actually go:
 * - never inside a string literal, e.g. `Global.foo("intro`;
 * - `do` only runs a method, so it offers autoload names only as its
 *   first token, and only functions as members;
 * - `if`/`elif` conditions and `set` values can use anything, so
 *   they offer every member - but a bare name list is only popped open by
 *   a trigger character (space, `=`, ...) right after the keyword/`=` or after
 *   `and`/`or`/`not`, not after every space in the expression; typing a
 *   letter still suggests matching names anywhere.
 *
 * @param {string} beforeCursor
 * @param {string|null} triggerCharacter - the character that auto-opened
 *   the suggest widget, or null if the person typed a word / asked
 *   explicitly (Ctrl+Space)
 * @returns {vscode.CompletionItem[]}
 */
function createGlobalScriptSuggestions(beforeCursor, triggerCharacter) {
  const keywordMatch = beforeCursor.match(EXPRESSION_START_PATTERN);
  if (!keywordMatch) { return []; }
  const isDo = keywordMatch[1] === 'do';
  const expression = beforeCursor.slice(keywordMatch[0].length);
  if (endsInsideStringLiteral(expression)) { return []; }

  const memberMatch = expression.match(/([A-Za-z_][A-Za-z0-9_]*)\.(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (memberMatch) {
    const [, globalName, enumName, typedMember] = memberMatch;
    const symbols = state.cachedAutoloadSymbols.get(globalName);
    if (!symbols) { return []; }
    const prefix = (typedMember || '').toLowerCase();
    if (enumName) {
      return isDo ? [] : createEnumValueSuggestions(symbols, enumName, prefix);
    }
    return createAutoloadMemberSuggestions(globalName, symbols, prefix, { values: !isDo });
  }

  if (isDo && !/^[A-Za-z_][A-Za-z0-9_]*$|^$/.test(expression)) { return []; }
  const isSet = keywordMatch[1] === undefined;

  // Right after a complete value ({variable}, number, text, true/false,
  // a call...): what can follow it - comparisons and and/or in a
  // condition, arithmetic in a set value.
  const afterOperand = !isDo && /(?:\}|\)|\]|\d|"|'|\btrue|\bfalse|[A-Za-z_][A-Za-z0-9_]*)\s+$/.test(expression)
    && !/(?:\b(?:and|or|not|in)|[=!<>+\-*/%(,&|])\s*$/.test(expression);
  if (afterOperand) {
    return isSet ? createOperatorItems(ARITHMETIC_OPERATORS, '0') : createOperatorItems(CONDITION_OPERATORS, '0');
  }

  const nameMatch = expression.match(/(?:^|[\s(=!<>+\-*/%,&|])([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (!nameMatch) { return []; }
  const typedName = nameMatch[1] || '';
  if (triggerCharacter && typedName === '') {
    const beforeName = expression.trimEnd();
    // Pop the list open only where a value is expected: the start, after
    // and/or/not, an operator, "(" or ",".
    if (beforeName !== '' && !/(?:\b(?:and|or|not|in)|&&|\|\||[!=<>+\-*/%(,])$/.test(beforeName)) { return []; }
  }
  const prefix = typedName.toLowerCase();
  const items = [];
  for (const name of state.cachedAutoloadSymbols.keys()) {
    if (name.toLowerCase().startsWith(prefix)) {
      items.push(createGlobalNameCompletion(name));
    }
  }
  if (isDo) { return items; }
  // One `{}` rather than every variable: inside the braces, the variables
  // are suggested folder by folder.
  const cursor = beforeCursor.length;
  items.push(createVariableBracesItem(typedName, new vscode.Range(0, cursor - typedName.length, 0, cursor)));
  if (isSet && expression.trim() === '') { items.push(...createSetValueItems(beforeCursor)); }
  for (const [keyword, doc] of [['not', 'negates the condition after it'], ['true', 'bool'], ['false', 'bool']]) {
    if (keyword.startsWith(prefix) && (keyword !== 'not' || !isSet)) {
      const item = new vscode.CompletionItem({ label: keyword, description: doc }, vscode.CompletionItemKind.Keyword);
      item.sortText = `4_${keyword}`;
      items.push(item);
    }
  }
  // true/false can come both from the set target's type and as keywords.
  const seen = new Set();
  return items.filter(item => {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    if (seen.has(label)) { return false; }
    seen.add(label);
    return true;
  });
}

Object.assign(module.exports, {
  isGlobalScriptExpressionLine,
  createGlobalNameCompletion,
  createAutoloadMemberSuggestions,
  createEnumValueSuggestions,
  createSetTargetSuggestions,
  createGlobalScriptSuggestions,
});
