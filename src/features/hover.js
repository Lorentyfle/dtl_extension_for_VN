// -----------------------------------------------------------------------------
// The timeline hover provider.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const events = require('../docs/events');
const bbcode = require('../docs/bbcode');
const textEffects = require('../docs/text-effects');
const syntax = require('../timeline/syntax');
const autoloads = require('../timeline/autoloads');
const variables = require('../timeline/variables');
const timelineMoods = require('../timeline/moods');
const documentation = require('../documentation');
const project = require('../project');
const completionItems = require('../completion/items');
const bbcodePreview = require('./bbcode-preview');

// =============================================================================
// HOVER (timelines)
// =============================================================================

/**
 * Hover documentation in a timeline: bracket events and their parameters,
 * text effects and BBCode tags, commands, characters, moods and portrait
 * layers, variables, autoload members, labels and positions. Glossary and
 * translation hovers have their own providers.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.Hover | undefined}
 */
function provideTimelineHover(document, position) {
  const line = document.lineAt(position.line).text;
  // -------------------------------------------------------------------
  // Bracket commands
  //
  // [wait]
  // [audio]
  // [voice]
  // [b] ... [/b]   <- Godot BBCode tags, opening or closing
  // -------------------------------------------------------------------
  const isCharacterCommandLine = /^\s*(?:join|update|leave)\b/.test(line);
  const bracketRegex =
    /\[\/?([A-Za-z_][A-Za-z0-9_]*\+?)/g;
  let match;
  while (
    (match = bracketRegex.exec(line)) !== null
  ) {
    const start = match.index;
    const end =
      start + match[0].length;
    if (
      position.character >= start &&
      position.character <= end
    ) {
      const commandName = match[1];
      // In text, "[signal=..." is the text effect, not the [signal ...] event.
      const inText = !isCharacterCommandLine && (syntax.isPlayerFacingTextLine(line) || /^\s*-\s/.test(line) || bbcodePreview.bbcodePreviewStart(document, line) !== -1);
      const effectEntry = inText && /^[=\]]/.test(line.slice(end)) ? textEffects.DTL_TEXT_EFFECTS.find(candidate => candidate.name === commandName) : undefined;
      // join/update/leave's own [options] bracket holds attribute
      // names (e.g. "[fade=..."), never BBCode, so a same-named
      // BBCode tag (like [fade]) mustn't shadow them there.
      const entry = effectEntry ||
        events.DTL_ENTRIES.find(
          entry =>
            entry.name === commandName
        ) || (isCharacterCommandLine ? undefined
          : (syntax.isPlayerFacingTextLine(line) || /^\s*-\s/.test(line) ? textEffects.DTL_TEXT_EFFECTS.find(entry => entry.name === commandName) : undefined)
            || bbcode.DTL_BBCODES.find(entry => entry.name === commandName));
      if (!entry) {
        // Not a real bracket command - this is just an attribute
        // name that happens to sit directly against '[' (e.g.
        // join/update/leave's first inline option, "[fade=...]").
        // Stop scanning and let the parameter-hover logic below
        // handle it instead of giving up on hover entirely.
        break;
      }
      const range =
        new vscode.Range(
          position.line,
          start,
          position.line,
          end
        );
      return new vscode.Hover(
        documentation.createDocumentation(entry),
        range
      );
    }
  }
  // -------------------------------------------------------------------
  // Bracket command PARAMETERS
  //
  // [wait time=1.5]
  //        ^^^^ hovering this
  // -------------------------------------------------------------------
  const paramWordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (paramWordRange) {
    const paramName = document.getText(paramWordRange);
    const afterParam = line.substring(paramWordRange.end.character);
    if (/^\s*=/.test(afterParam)) {
      const beforeParam = line.substring(0, paramWordRange.start.character);
      const enclosingBracketMatch = beforeParam.match(/\[([A-Za-z_][A-Za-z0-9_]*)\s+[^\]]*$/);
      if (enclosingBracketMatch) {
        const enclosingEntry = completionItems.findBracketOrBbcodeEntry(enclosingBracketMatch[1]);
        if (enclosingEntry && enclosingEntry.variables && enclosingEntry.variables[paramName]) {
          const markdown = new vscode.MarkdownString();
          markdown.appendMarkdown(`**${paramName}** _(parameter of \`[${enclosingEntry.name}]\`)_\n\n`);
          markdown.appendMarkdown(enclosingEntry.variables[paramName]);
          return new vscode.Hover(markdown, paramWordRange);
        }
      } else {
        // join/update/leave's own trailing [options] bracket has no
        // command name inside it (e.g. "join Laripo center
        // [extra_data=...]"), so it needs its own lookup against the
        // enclosing command's `variables` instead.
        const trailingBracketMatch = beforeParam.match(/^\s*(join|update|leave)\b[^[]*\[[^\]]*$/);
        if (trailingBracketMatch) {
          const commandEntry = events.DTL_ENTRIES.find(
            candidate => candidate.name === trailingBracketMatch[1] && candidate.type === 'command'
          );
          if (commandEntry && commandEntry.variables && commandEntry.variables[paramName]) {
            const markdown = new vscode.MarkdownString();
            markdown.appendMarkdown(`**${paramName}** _(parameter of \`${commandEntry.name}\`)_\n\n`);
            markdown.appendMarkdown(commandEntry.variables[paramName]);
            return new vscode.Hover(markdown, paramWordRange);
          }
        } else {
          // pos=/size=/rot= transform tokens sit between the
          // character/position slot and the bracket, e.g.
          // "join Laripo pos=x0.3 size=y1 [...]".
          const transformMatch = beforeParam.match(
            /^\s*(join|update)\b\s+\S+(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s*$/
          );
          if (transformMatch) {
            const commandEntry = events.DTL_ENTRIES.find(
              candidate => candidate.name === transformMatch[1] && candidate.type === 'command'
            );
            if (commandEntry && commandEntry.transform_command && commandEntry.transform_command[paramName]) {
              const markdown = new vscode.MarkdownString();
              markdown.appendMarkdown(`**${paramName}** _(transform parameter of \`${commandEntry.name}\`)_\n\n`);
              markdown.appendMarkdown(commandEntry.transform_command[paramName]);
              return new vscode.Hover(markdown, paramWordRange);
            }
          }
        }
      }
    }
  }
  // -------------------------------------------------------------------
  // Position keywords
  //
  // join Laripo center|
  //             ^^^^^^ hovering this
  // -------------------------------------------------------------------
  const positionWordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (positionWordRange) {
    const positionWord = document.getText(positionWordRange);
    const positionEntry = events.DTL_POSITIONS.find(position => position.name === positionWord);
    if (positionEntry) {
      const beforePosition = line.substring(0, positionWordRange.start.character);
      // Only the first token after "join <character>" / "update
      // <character>" is really this position argument, so this
      // stays scoped to that slot rather than any stray word that
      // happens to match a position name (e.g. inside dialogue text).
      if (/^\s*(join|update)\b\s+\S+\s*$/.test(beforePosition)) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${positionEntry.name}** _(DTL character position)_\n\n`);
        markdown.appendMarkdown(positionEntry.description);
        return new vscode.Hover(markdown, positionWordRange);
      }
    }
  }
  // -------------------------------------------------------------------
  // Character names
  //
  // join John left       "John Smith": Hello
  //      ^^^^                ^^^^^^^^^^^^ hovering either
  // -------------------------------------------------------------------
  const characterHit = syntax.findCharacterNameAtPosition(document, position);
  if (characterHit) {
    const info = state.cachedCharacterInfo.get(characterHit.name);
    if (info && (info.displayName || info.nicknames.length > 0 || info.description || info.color || info.translationId)) {
      return new vscode.Hover(documentation.createCharacterDocumentation(characterHit.name, info), characterHit.range);
    }
  }
  // -------------------------------------------------------------------
  // Autoload scripts / nodes and their members
  //
  // do Global.apply_tint()      if Global.state == Global.State.IDLE
  //    ^^^^^^ ^^^^^^^^^^           {Global.max_hp}       ^^^^ hovering any part
  // -------------------------------------------------------------------
  const autoloadHit = autoloads.findAutoloadReferenceAtPosition(document, position);
  if (autoloadHit) {
    return new vscode.Hover(autoloadHit.markdown, autoloadHit.range);
  }
  // -------------------------------------------------------------------
  // Dialogic variables
  //
  // {variable.test}      set {chapter} = 1
  //           ^^^^            ^^^^^^^ hovering either
  // -------------------------------------------------------------------
  const variableHit = variables.findVariableAtPosition(document, position);
  if (variableHit) {
    return new vscode.Hover(variableHit.markdown, variableHit.range);
  }
  // -------------------------------------------------------------------
  // Moods / portraits and LayeredPortrait layers
  //
  // join John (happy) left [extra_data="set Head/LeftEye"]
  //            ^^^^^                         ^^^^ ^^^^^^^ hovering any
  // -------------------------------------------------------------------
  const moodHit = timelineMoods.findMoodTagAtPosition(line, position.character);
  if (moodHit) {
    const markdown = timelineMoods.createMoodDocumentation(moodHit.characterName, moodHit.mood);
    if (markdown) {
      return new vscode.Hover(markdown, new vscode.Range(position.line, moodHit.range.start, position.line, moodHit.range.end));
    }
  }
  const layerHit = timelineMoods.findLayerDocumentationAtPosition(line, position.character);
  if (layerHit) {
    return new vscode.Hover(layerHit.markdown, new vscode.Range(position.line, layerHit.range.start, position.line, layerHit.range.end));
  }
  // -------------------------------------------------------------------
  // Labels - on `label NAME` or `jump NAME`
  // -------------------------------------------------------------------
  const labelLine = syntax.parseLabelLine(line);
  if (labelLine && position.character >= labelLine.nameStart && position.character <= labelLine.nameStart + labelLine.name.length) {
    const labelInfo = syntax.collectDocumentLabels(document).get(labelLine.name);
    if (labelInfo) {
      return new vscode.Hover(documentation.createLabelDocumentation(labelLine.name, labelInfo), new vscode.Range(position.line, labelLine.nameStart, position.line, labelLine.nameStart + labelLine.name.length));
    }
  }
  const jump = syntax.parseJumpLine(line);
  if (jump && !jump.target.includes('{')) {
    const labelEnd = jump.labelStart + jump.label.length;
    if (jump.timeline !== null && position.character >= jump.targetStart && position.character < jump.labelStart) {
      const labels = project.getTimelineLabels(jump.timeline);
      if (labels) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${jump.timeline}** _(Dialogic timeline)_\n\n\`${state.cachedTimelinePaths.get(jump.timeline)}\`\n\n`);
        markdown.appendMarkdown(labels.size > 0 ? `Labels: ${[...labels.keys()].map(name => `\`${name}\``).join(', ')}` : '_No labels._');
        return new vscode.Hover(markdown, new vscode.Range(position.line, jump.targetStart, position.line, jump.labelStart - 1));
      }
    } else if (jump.label && position.character >= jump.labelStart && position.character <= labelEnd) {
      const target = project.resolveJumpTarget(document, jump);
      const labelInfo = target && target.labels.get(jump.label);
      if (labelInfo) {
        return new vscode.Hover(documentation.createLabelDocumentation(jump.label, labelInfo, target.timeline), new vscode.Range(position.line, jump.labelStart, position.line, labelEnd));
      }
    }
  }
  // -------------------------------------------------------------------
  // Normal commands
  //
  // label
  // jump
  // join
  // update
  // leave
  // -------------------------------------------------------------------
  const wordRange =
    document.getWordRangeAtPosition(
      position
    );

  if (!wordRange) {
    return undefined;
  }

  const word =
    document.getText(wordRange);

  const entry =
    events.DTL_ENTRIES.find(
      entry => entry.name === word
    );

  if (!entry) {
    return undefined;
  }

  return new vscode.Hover(
    documentation.createDocumentation(entry),
    wordRange
  );
}

Object.assign(module.exports, {
  provideTimelineHover,
});
