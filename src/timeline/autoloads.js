// -----------------------------------------------------------------------------
// Autoload references (`Global.member`) in a timeline: finding them under
// the cursor, and their documentation.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const variables = require('./variables');
const expressions = require('../completion/expressions');

// =============================================================================
// CHARACTER NAME HELPERS
// =============================================================================
// A DTL character name is either a bare identifier, or a double/single-quoted
// string - the quoted form lets a name contain spaces or symbols that
// wouldn't otherwise be valid (e.g. join "John Smith" left). Mirrors the
// equivalent alternation in dtl.tmLanguage.json's #commands/#dialogue rules,
// so the editor and the syntax highlighting agree on what counts as a name.

/**
 * Locate the autoload reference under the cursor, if any - the autoload
 * name itself (`Global`), one of its members (`Global.apply_tint`,
 * `Global.max_hp`, `Global.State`), or a named enum's value
 * (`Global.State.IDLE`) - resolved against cachedAutoloadSymbols. Only
 * looked for where Dialogic actually evaluates such references: a
 * `do`/`if`/`elif` expression, or inside a `{...}` variable block
 * (isGlobalScriptExpressionLine is defined further down alongside the
 * completion logic that shares this same line shape). Shared by the hover
 * and Go to Definition.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{
 *   globalName: string,
 *   symbols: GdScriptSymbols & {scriptPath: string, scenePath: string|null},
 *   part: 'global'|'member'|'value',
 *   memberName: string,
 *   subName: string|undefined,
 *   range: vscode.Range
 * } | null}
 */
function locateAutoloadReferenceAtPosition(document, position) {
  const line = document.lineAt(position.line).text;
  const isExpressionLine = expressions.isGlobalScriptExpressionLine(line);
  const referencePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g;
  let match;
  while ((match = referencePattern.exec(line)) !== null) {
    const [, globalName, memberName, subName] = match;
    const symbols = state.cachedAutoloadSymbols.get(globalName);
    if (!symbols) { continue; }
    if (!isExpressionLine && !variables.isInsideVariableBlock(line, match.index)) { continue; }

    const globalStart = match.index;
    const memberStart = globalStart + globalName.length + 1;
    const subStart = memberStart + memberName.length + 1;
    const rangeOf = (start, name) => new vscode.Range(position.line, start, position.line, start + name.length);
    const covers = (start, name) => position.character >= start && position.character <= start + name.length;
    const reference = { globalName, symbols, memberName, subName };

    if (covers(globalStart, globalName)) { return { ...reference, part: 'global', range: rangeOf(globalStart, globalName) }; }
    if (covers(memberStart, memberName)) { return { ...reference, part: 'member', range: rangeOf(memberStart, memberName) }; }
    if (subName && covers(subStart, subName)) { return { ...reference, part: 'value', range: rangeOf(subStart, subName) }; }
  }
  return null;
}

/**
 * Hover documentation for the autoload reference under the cursor (see
 * locateAutoloadReferenceAtPosition).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{markdown: vscode.MarkdownString, range: vscode.Range} | null}
 */
function findAutoloadReferenceAtPosition(document, position) {
  const reference = locateAutoloadReferenceAtPosition(document, position);
  if (!reference) { return null; }
  const { globalName, memberName, subName, symbols, range } = reference;
  if (reference.part === 'global') {
    return { markdown: createAutoloadDocumentation(globalName, symbols), range };
  }
  if (reference.part === 'member') {
    const markdown = createAutoloadMemberDocumentation(globalName, memberName, symbols);
    return markdown ? { markdown, range } : null;
  }
  const enumInfo = symbols.enums.get(memberName);
  const valueInfo = enumInfo && enumInfo.values.find(value => value.name === subName);
  return valueInfo ? { markdown: createEnumValueDocumentation(globalName, memberName, valueInfo), range } : null;
}

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/** Shown in place of a missing `##` documentation comment. @type {string} */
const NO_GD_DOC_MESSAGE = '_No `##` documentation comment found above this symbol in its script._';

/**
 * One-line GDScript-style signature of an autoload member, e.g.
 * `func Global.apply_tint(color: Color) -> void` or `var Global.hp: int = 10`.
 * Shared by the hover (as its code block title) and the completion detail.
 *
 * @param {string} globalName
 * @param {string} memberName
 * @param {'function'|'variable'|'constant'|'enum'} kind
 * @param {object} info - the member's entry from GdScriptSymbols
 * @returns {string}
 */
function formatAutoloadMemberSignature(globalName, memberName, kind, info) {
  const qualifiedName = `${globalName}.${memberName}`;
  switch (kind) {
    case 'function':
      return `${info.isStatic ? 'static ' : ''}func ${qualifiedName}(${info.params})${info.returnType ? ' -> ' + info.returnType : ''}`;
    case 'variable':
      return `${info.isStatic ? 'static ' : ''}var ${qualifiedName}${info.type ? ': ' + info.type : ''}${info.defaultValue !== null ? ' = ' + info.defaultValue : ''}`;
    case 'constant':
      return `const ${qualifiedName}${info.type ? ': ' + info.type : ''} = ${info.value}`;
    case 'enum':
      return `enum ${qualifiedName} { ${info.values.map(value => `${value.name} = ${value.value}`).join(', ')} }`;
  }
  return qualifiedName;
}

/**
 * Find a member on an autoload by name, whatever its kind.
 *
 * @param {GdScriptSymbols} symbols
 * @param {string} memberName
 * @returns {{kind: 'function'|'variable'|'constant'|'enum', info: object} | null}
 */
function findAutoloadMember(symbols, memberName) {
  if (symbols.functions.has(memberName)) { return { kind: 'function', info: symbols.functions.get(memberName) }; }
  if (symbols.variables.has(memberName)) { return { kind: 'variable', info: symbols.variables.get(memberName) }; }
  if (symbols.constants.has(memberName)) { return { kind: 'constant', info: symbols.constants.get(memberName) }; }
  if (symbols.enums.has(memberName)) { return { kind: 'enum', info: symbols.enums.get(memberName) }; }
  return null;
}

/**
 * Build the hover shown for an autoload member (`Global.apply_tint`,
 * `Global.max_hp`, `Global.State`, ...) - its signature as the title,
 * followed by its GDScript `##` documentation comment, if any. An enum
 * additionally lists each of its values with their own docs.
 *
 * @param {string} globalName
 * @param {string} memberName
 * @param {GdScriptSymbols} symbols
 * @returns {vscode.MarkdownString | null} null if no such member exists
 */
function createAutoloadMemberDocumentation(globalName, memberName, symbols) {
  const member = findAutoloadMember(symbols, memberName);
  if (!member) { return null; }
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(formatAutoloadMemberSignature(globalName, memberName, member.kind, member.info), 'gdscript');
  markdown.appendMarkdown(member.info.doc || NO_GD_DOC_MESSAGE);
  if (member.kind === 'enum' && member.info.values.length > 0) {
    markdown.appendMarkdown('\n\n**Values:**\n\n');
    for (const value of member.info.values) {
      markdown.appendMarkdown(`- \`${value.name}\` = \`${value.value}\`${value.doc ? ': ' + value.doc : ''}\n`);
    }
  }
  return markdown;
}

/**
 * Build the hover shown for a named enum's value, e.g. `Global.State.IDLE`.
 *
 * @param {string} globalName
 * @param {string} enumName
 * @param {GdEnumValueInfo} valueInfo
 * @returns {vscode.MarkdownString}
 */
function createEnumValueDocumentation(globalName, enumName, valueInfo) {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(`${globalName}.${enumName}.${valueInfo.name} = ${valueInfo.value}`, 'gdscript');
  markdown.appendMarkdown(valueInfo.doc || NO_GD_DOC_MESSAGE);
  return markdown;
}

/**
 * Build the hover shown for an autoload name itself, e.g. `Global` in
 * `do Global.foo()`: where it's declared (script, and scene for an
 * autoload node), the script's own `##` class documentation, and a count
 * of what it exposes.
 *
 * @param {string} globalName
 * @param {GdScriptSymbols & {scriptPath: string, scenePath: string|null}} symbols
 * @returns {vscode.MarkdownString}
 */
function createAutoloadDocumentation(globalName, symbols) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${globalName}** _(${symbols.scenePath ? 'autoload node' : 'autoload script'})_\n\n`);
  if (symbols.scenePath) {
    markdown.appendMarkdown(`Scene: \`${symbols.scenePath}\`\n\n`);
  }
  markdown.appendMarkdown(`Script: \`${symbols.scriptPath}\`\n\n`);
  if (symbols.doc) {
    markdown.appendMarkdown(`${symbols.doc}\n\n`);
  }
  const counts = [
    [symbols.functions.size, 'function'],
    [symbols.variables.size, 'variable'],
    [symbols.constants.size, 'constant'],
    [symbols.enums.size, 'enum'],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}${count > 1 ? 's' : ''}`);
  if (counts.length > 0) {
    markdown.appendMarkdown(`_${counts.join(', ')}_`);
  }
  return markdown;
}

Object.assign(module.exports, {
  locateAutoloadReferenceAtPosition,
  findAutoloadReferenceAtPosition,
  NO_GD_DOC_MESSAGE,
  formatAutoloadMemberSignature,
  findAutoloadMember,
  createAutoloadDocumentation,
});
