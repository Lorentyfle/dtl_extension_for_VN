// -----------------------------------------------------------------------------
// The Outline view of a timeline.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const syntax = require('../timeline/syntax');

// =============================================================================
// OUTLINE (document symbols)
// =============================================================================

/**
 * The outline style (`dtlReader.outline.style`): "flow", "indentation" or
 * "dialogic". The older boolean `dtlReader.outline.showFlow` is still
 * honored when it was turned off and no style was chosen explicitly.
 *
 * @returns {'flow'|'indentation'|'dialogic'}
 */
function getOutlineStyle() {
  const config = vscode.workspace.getConfiguration('dtlReader');
  const styleSetting = config.inspect('outline.style');
  const styleSet = styleSetting && (styleSetting.globalValue !== undefined || styleSetting.workspaceValue !== undefined || styleSetting.workspaceFolderValue !== undefined);
  if (!styleSet && config.get('outline.showFlow', true) === false) { return 'dialogic'; }
  const style = config.get('outline.style', 'flow');
  return ['flow', 'indentation', 'dialogic'].includes(style) ? style : 'flow';
}

/**
 * Where a `jump` leads, relative to the jump itself, for the "flow" outline:
 * back up to an earlier label (a loop), forward to a later one, to another
 * timeline, or somewhere only known at runtime (`{variable}`).
 *
 * @param {string} target - the jump's target text
 * @param {number} line - the jump's line
 * @param {Map<string, DtlLabelInfo>} labels - this timeline's labels
 * @returns {string}
 */
function describeJumpDirection(target, line, labels) {
  if (target.includes('{')) { return '? runtime target'; }
  const jump = syntax.parseJumpLine(`jump ${target}`);
  if (!jump) { return ''; }
  if (jump.timeline !== null) { return `-> timeline ${jump.timeline}`; }
  const label = labels.get(jump.label);
  if (!label) { return '! missing label'; }
  return label.line < line ? `^ back to line ${label.line + 1}` : `v ahead to line ${label.line + 1}`;
}

/**
 * Build the outline of a timeline - what the Outline view, breadcrumbs,
 * sticky scroll and "Go to Symbol" (Ctrl+Shift+O) show - in one of three
 * styles (`dtlReader.outline.style`):
 *
 * - "flow" (default): the flow of time. One entry per `label`, as Dialogic
 *   organizes a timeline, each spanning until the next label, listing the
 *   timeline's branching nested by indentation - `if`/`elif`/`else`/
 *   blocks and choices - and the events that leave the current
 *   flow (`jump`, `return`, `[end_timeline]`), each jump saying where it
 *   leads (back, ahead, another timeline).
 * - "indentation": the timeline's structure by indentation only - labels,
 *   `if`/`elif`/`else` blocks and choices, each nested under the
 *   block it's indented in, and labels being plain entries rather than
 *   sections. No jumps.
 * - "dialogic": only the labels, like Dialogic's own timeline organization.
 *
 * Lines before the first label sit at the top level. Dialogue lines,
 * joins, etc. are always left out to keep it readable.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.DocumentSymbol[]}
 */
function provideTimelineOutline(document) {
  const style = getOutlineStyle();
  const showFlow = style !== 'dialogic';
  const labelsAreSections = style !== 'indentation';
  const showJumps = style === 'flow';
  const lines = syntax.documentLines(document);
  const labelDocs = syntax.collectLabelsFromLines(lines);
  const rootSymbols = [];
  let currentLabel = null;
  // Open flow blocks (if/elif/else/choice), innermost last.
  let openBlocks = [];
  let lastContentLine = 0;

  const lineRange = (line, start = 0) => new vscode.Range(line, start, line, lines[line].length);
  const closeBlocksFrom = indent => {
    while (openBlocks.length > 0 && openBlocks[openBlocks.length - 1].indent >= indent) {
      const block = openBlocks.pop();
      block.symbol.range = new vscode.Range(block.symbol.range.start, new vscode.Position(lastContentLine, lines[lastContentLine].length));
    }
  };
  const addSymbol = symbol => {
    const parent = openBlocks.length > 0 ? openBlocks[openBlocks.length - 1].symbol : currentLabel;
    (parent ? parent.children : rootSymbols).push(symbol);
  };
  const closeLabel = () => {
    if (!currentLabel) { return; }
    currentLabel.range = new vscode.Range(currentLabel.range.start, new vscode.Position(lastContentLine, lines[lastContentLine].length));
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { continue; }
    const indent = text.length - text.trimStart().length;
    closeBlocksFrom(indent);

    const label = syntax.parseLabelLine(text);
    if (label) {
      const info = labelDocs.get(label.name);
      const symbol = new vscode.DocumentSymbol(
        label.name,
        label.displayName || (info && info.doc ? info.doc.split('\n')[0] : ''),
        vscode.SymbolKind.Module,
        lineRange(line),
        new vscode.Range(line, label.nameStart, line, label.nameStart + label.name.length)
      );
      // A label indented inside a choice/condition stays an entry of that
      // block, so the block's structure isn't broken up by it.
      if (labelsAreSections && indent === 0) {
        closeBlocksFrom(0);
        closeLabel();
        currentLabel = symbol;
        rootSymbols.push(currentLabel);
      } else {
        addSymbol(symbol); // just an entry, nested in whatever block it's indented in
      }
      lastContentLine = line;
      continue;
    }
    lastContentLine = line;
    if (!showFlow) { continue; }

    const flowMatch = trimmed.match(/^(if|elif|else)\b\s*(.*?)\s*:?\s*$/);
    const choiceMatch = trimmed.match(/^-\s+(.*)$/);
    const jumpMatch = trimmed.match(/^(jump)\s+(.*)$|^(return)\b|^(\[end_timeline\])/);
    if (flowMatch) {
      const symbol = new vscode.DocumentSymbol(`${flowMatch[1]}${flowMatch[2] ? ' ' + flowMatch[2] : ''}`, '', vscode.SymbolKind.Operator, lineRange(line, indent), lineRange(line, indent));
      addSymbol(symbol);
      openBlocks.push({ indent, symbol });
    } else if (choiceMatch) {
      const choiceText = choiceMatch[1].split(/\s*\|/)[0].replace(/\s*#id:\S+/, '').trim() || '(choice)';
      const symbol = new vscode.DocumentSymbol(choiceText, 'choice', vscode.SymbolKind.EnumMember, lineRange(line, indent), lineRange(line, indent));
      addSymbol(symbol);
      openBlocks.push({ indent, symbol });
    } else if (jumpMatch && showJumps) {
      const name = jumpMatch[1] ? `jump ${jumpMatch[2].split('#id:')[0].trim()}` : (jumpMatch[3] || jumpMatch[4]);
      const detail = jumpMatch[1]
        ? describeJumpDirection(jumpMatch[2].split('#id:')[0].trim(), line, labelDocs)
        : jumpMatch[3] ? '<- back to the last jump' : 'end';
      addSymbol(new vscode.DocumentSymbol(name, detail, vscode.SymbolKind.Event, lineRange(line, indent), lineRange(line, indent)));
    }
  }
  closeBlocksFrom(0);
  closeLabel();
  return rootSymbols;
}

Object.assign(module.exports, {
  provideTimelineOutline,
});
