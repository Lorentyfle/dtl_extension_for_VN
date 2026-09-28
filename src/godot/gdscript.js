// -----------------------------------------------------------------------------
// Reading the public members of a GDScript file, with their `##` docs.
// -----------------------------------------------------------------------------
// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/**
 * @typedef {{params: string, returnType: string|null, doc: string, isStatic: boolean, line: number}} GdFunctionInfo
 * @typedef {{type: string|null, defaultValue: string|null, doc: string, isStatic: boolean, isExported: boolean, line: number}} GdVariableInfo
 * @typedef {{type: string|null, value: string, doc: string, line: number}} GdConstantInfo
 * @typedef {{name: string, value: string, doc: string}} GdEnumValueInfo
 * @typedef {{values: GdEnumValueInfo[], doc: string, line: number}} GdEnumInfo
 * @typedef {{
 *   doc: string,
 *   functions: Map<string, GdFunctionInfo>,
 *   variables: Map<string, GdVariableInfo>,
 *   constants: Map<string, GdConstantInfo>,
 *   enums: Map<string, GdEnumInfo>
 * }} GdScriptSymbols
 */

/**
 * Strip a trailing `# comment` from one line of GDScript, ignoring any `#`
 * that sits inside a string literal (e.g. `const TAG = "#hero"`).
 *
 * @param {string} line
 * @returns {string}
 */
function stripGdComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { i++; }
      else if (ch === quote) { quote = null; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Starting at `lines[startIndex]`, join as many lines as needed (comments
 * stripped) for the bracket opened at `openIndex` of the first line to be
 * closed again, tracking nested `()`/`[]`/`{}` depth so e.g. a parameter's
 * default value `Color(1, 1, 1, 1)` doesn't end the scan early. Lets
 * multi-line function signatures and multi-line enums be parsed the same
 * way as single-line ones.
 *
 * @param {string[]} lines
 * @param {number} startIndex
 * @param {number} openIndex - index of the opening bracket in the first (comment-stripped) line
 * @returns {{text: string, closeIndex: number, lastLineIndex: number} | null}
 *   the joined text, the index of the matching closer inside it, and the
 *   last line index consumed - or null if never closed (within 50 lines).
 */
function joinUntilBracketCloses(lines, startIndex, openIndex) {
  let text = '';
  let depth = 0;
  for (let lineIndex = startIndex; lineIndex < lines.length && lineIndex < startIndex + 50; lineIndex++) {
    const offset = text.length;
    text += stripGdComment(lines[lineIndex]) + '\n';
    for (let i = lineIndex === startIndex ? openIndex : offset; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') { depth++; }
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { return { text, closeIndex: i, lastLineIndex: lineIndex }; }
      }
    }
  }
  return null;
}

/**
 * Split an enum body (text between its braces) into its values, resolving
 * GDScript's implicit numbering (each value is the previous one + 1,
 * starting at 0). A `##` comment line inside the body documents the value
 * directly below it, same as for top-level members.
 *
 * @param {string[]} bodyLines - raw lines of the enum body (braces excluded)
 * @returns {GdEnumValueInfo[]}
 */
function parseGdEnumBody(bodyLines) {
  const values = [];
  let nextValue = 0;
  let pendingDoc = [];
  for (const rawLine of bodyLines) {
    const docMatch = rawLine.match(/^\s*##\s?(.*)$/);
    if (docMatch) {
      pendingDoc.push(docMatch[1]);
      continue;
    }
    for (const item of stripGdComment(rawLine).split(',')) {
      const itemMatch = item.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(.+))?$/);
      if (!itemMatch) { continue; }
      let value;
      if (itemMatch[2] !== undefined) {
        value = itemMatch[2].trim();
        const numeric = Number(value);
        nextValue = Number.isInteger(numeric) ? numeric + 1 : null;
      } else {
        value = nextValue === null ? '?' : String(nextValue);
        if (nextValue !== null) { nextValue++; }
      }
      values.push({ name: itemMatch[1], value, doc: pendingDoc.join('\n').trim() });
      pendingDoc = [];
    }
  }
  return values;
}

/**
 * Parse a GDScript file's public top-level symbols: functions, variables
 * (`var`, including `@export`/`@onready`/`static` ones), constants, and
 * enums - plus the script's own class documentation. Each symbol's `doc`
 * follows GDScript's documentation-comment convention: consecutive
 * `##`-prefixed lines directly above it (see
 * https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_documentation_comments.html);
 * the script's own doc is the `##` block after `extends`/`class_name`,
 * before any member.
 *
 * Indented lines (function bodies, inner classes) are skipped, since only
 * top-level members are reachable as `Global.member`. Names starting with
 * `_` are skipped too, since that's GDScript's own "private" convention
 * (this also excludes engine callbacks like `_ready`). An unnamed
 * `enum { A, B }` declares plain constants, so its values are listed as
 * constants rather than as an enum.
 *
 * @param {string} text - raw .gd file content
 * @returns {GdScriptSymbols}
 */
function parseGdScript(text) {
  const symbols = { doc: '', functions: new Map(), variables: new Map(), constants: new Map(), enums: new Map() };
  const lines = text.split(/\r?\n/);
  let pendingDocLines = [];
  let seenMember = false;
  // An `@export...` annotation, possibly on its own line above the var.
  let pendingExport = false;
  const takeDoc = () => {
    const doc = pendingDocLines.join('\n').trim();
    pendingDocLines = [];
    return doc;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const docMatch = rawLine.match(/^##\s?(.*)$/);
    if (docMatch) {
      pendingDocLines.push(docMatch[1]);
      continue;
    }
    if (rawLine.trim() === '') {
      // A `##` block followed by a blank line before any member has been
      // declared is the script's own doc (e.g. right after `extends Node`).
      if (!seenMember && !symbols.doc && pendingDocLines.length > 0) { symbols.doc = takeDoc(); }
      continue;
    }
    if (/^\s/.test(rawLine)) {
      pendingDocLines = []; // indented: a function body or inner class member
      continue;
    }
    if (rawLine.startsWith('#')) {
      continue; // a plain comment doesn't break the `##` chain
    }

    // Leading annotations (`@export`, `@onready`, `@export_range(0, 10)`,
    // ...) are dropped - an annotation-only line keeps the `##` chain intact.
    let code = stripGdComment(rawLine).trim();
    let annotationMatch;
    while ((annotationMatch = code.match(/^@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s*/))) {
      if (annotationMatch[0].startsWith('@export')) { pendingExport = true; }
      code = code.slice(annotationMatch[0].length);
    }
    if (code === '') { continue; }
    const isExported = pendingExport;
    pendingExport = false;

    if (/^(?:extends|class_name)\b/.test(code)) {
      if (pendingDocLines.length > 0 && !symbols.doc) { symbols.doc = takeDoc(); }
      continue;
    }

    const funcMatch = code.match(/^(static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (funcMatch) {
      seenMember = true;
      const doc = takeDoc();
      const name = funcMatch[2];
      const declarationLine = i;
      const lineOffset = stripGdComment(rawLine).indexOf(funcMatch[0]);
      const openIndex = lineOffset + funcMatch[0].length - 1;
      const joined = joinUntilBracketCloses(lines, i, openIndex);
      if (!joined) { continue; }
      i = joined.lastLineIndex;
      if (name.startsWith('_')) { continue; }
      const params = joined.text.slice(openIndex + 1, joined.closeIndex).replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
      const returnMatch = joined.text.slice(joined.closeIndex + 1).match(/^\s*->\s*([A-Za-z_][A-Za-z0-9_.\[\], ]*?)\s*:/);
      symbols.functions.set(name, { params, returnType: returnMatch ? returnMatch[1] : null, doc, isStatic: !!funcMatch[1], line: declarationLine });
      continue;
    }

    const varMatch = code.match(/^(static\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
    if (varMatch) {
      seenMember = true;
      const doc = takeDoc();
      if (varMatch[2].startsWith('_')) { continue; }
      // A trailing ':' opens a setter/getter block - not part of the value.
      const rest = varMatch[3].replace(/:\s*$/, '').trim();
      const typedMatch = rest.match(/^(?::\s*([^=]+?))?\s*(?::?=\s*(.*))?$/);
      symbols.variables.set(varMatch[2], {
        type: typedMatch && typedMatch[1] ? typedMatch[1].trim() : null,
        defaultValue: typedMatch && typedMatch[2] ? typedMatch[2].trim() : null,
        doc,
        isStatic: !!varMatch[1],
        isExported,
        line: i,
      });
      continue;
    }

    const constMatch = code.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*:?=\s*(.*)$/);
    if (constMatch) {
      seenMember = true;
      const doc = takeDoc();
      if (constMatch[1].startsWith('_')) { continue; }
      symbols.constants.set(constMatch[1], { type: constMatch[2] ? constMatch[2].trim() : null, value: constMatch[3].trim(), doc, line: i });
      continue;
    }

    const enumMatch = code.match(/^enum\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\{/);
    if (enumMatch) {
      seenMember = true;
      const doc = takeDoc();
      const declarationLine = i;
      const openIndex = stripGdComment(rawLine).indexOf('{');
      const joined = joinUntilBracketCloses(lines, i, openIndex);
      if (!joined) { continue; }
      // Re-split the raw (comment-intact) lines so `##` value docs survive.
      const rawBody = lines.slice(i, joined.lastLineIndex + 1).join('\n');
      const bodyStart = rawBody.indexOf('{') + 1;
      const bodyEnd = rawBody.lastIndexOf('}');
      const values = parseGdEnumBody(rawBody.slice(bodyStart, bodyEnd).split('\n'))
        .filter(value => !value.name.startsWith('_'));
      i = joined.lastLineIndex;
      const enumName = enumMatch[1];
      if (enumName) {
        if (!enumName.startsWith('_')) { symbols.enums.set(enumName, { values, doc, line: declarationLine }); }
      } else {
        for (const value of values) {
          symbols.constants.set(value.name, { type: 'int', value: value.value, doc: value.doc || doc, line: declarationLine });
        }
      }
      continue;
    }

    // Anything else (signal, class, a stray statement...) breaks the chain.
    seenMember = true;
    pendingDocLines = [];
  }
  return symbols;
}

Object.assign(module.exports, {
  parseGdScript,
});
