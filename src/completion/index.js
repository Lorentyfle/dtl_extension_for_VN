// -----------------------------------------------------------------------------
// The timeline completion provider.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const events = require('../docs/events');
const bbcode = require('../docs/bbcode');
const textEffects = require('../docs/text-effects');
const syntax = require('../timeline/syntax');
const variables = require('../timeline/variables');
const timelineMoods = require('../timeline/moods');
const project = require('../project');
const completionItems = require('./items');
const expressions = require('./expressions');
const sources = require('./sources');
const snippets = require('./snippets');

// =============================================================================
// COMPLETION (timelines)
// =============================================================================

/**
 * Suggestions in a timeline, depending on where the cursor is: events and
 * characters at the start of a line, their parameters and values inside
 * brackets, moods, labels and timelines after `jump`, variables, autoloads
 * and operators in expressions, text effects and BBCode in text, words
 * already used while writing dialogue... Each context returns as soon as it
 * recognizes the cursor's position, so nothing unrelated is suggested.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {vscode.CancellationToken} token
 * @param {vscode.CompletionContext} context
 * @returns {vscode.CompletionItem[] | vscode.CompletionList}
 */
function provideTimelineCompletions(document, position, token, context) {
  state.isolatedDocumentData = state.projectRootUri ? null : sources.collectIsolatedDocumentData(document, position.line);
  const line = document.lineAt(position.line).text;
  const beforeCursor = line.substring(0,position.character);
  const items = [];
  // The character that auto-opened the suggest widget (one of the
  // trigger characters registered below), or null when the person
  // is typing a word or asked explicitly with Ctrl+Space. Contexts
  // that only make sense for a specific trigger (e.g. '.' after an
  // autoload name) check this, so e.g. a '.' ending a dialogue
  // sentence doesn't pop up a list of every word in the file.
  const triggerCharacter = context && context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
    ? context.triggerCharacter
    : null;
  // ===================================================================
  // VARIABLE PATH: "{variable.te" anywhere - dialogue text, a
  // bracket option's value, or a bare "set {...}" line. Checked
  // first since it can appear inside any of those other contexts,
  // and its own "{" would otherwise just be stray text to them.
  // ===================================================================
  const openBraceIndex = beforeCursor.lastIndexOf('{');
  const closeBraceIndex = beforeCursor.lastIndexOf('}');
  if (openBraceIndex > closeBraceIndex) {
    return variables.createVariableSuggestions(beforeCursor.slice(openBraceIndex + 1));
  }
  // ===================================================================
  // AUTOLOADS: "do Global." / "if Global." / "elif Global." -
  // either the autoload name itself, or a member once "Name." has
  // been typed. Usable anywhere in the expression (not just right
  // after the keyword), since if/elif conditions can combine an
  // autoload reference with variables/operators. Always returns
  // here (even an empty list) - nothing else below applies to an
  // expression line, and falling through used to dump every
  // character name and dialogue word into the list instead.
  // ===================================================================
  const setTargetItems = expressions.createSetTargetSuggestions(beforeCursor, position);
  if (setTargetItems) {
    return setTargetItems;
  }
  if (expressions.isGlobalScriptExpressionLine(beforeCursor)) {
    return expressions.createGlobalScriptSuggestions(beforeCursor, triggerCharacter).map(item => {
      // Ranges are built on line 0 inside the helper - move them to this line.
      if (item.range && item.range.start.line === 0 && position.line !== 0) {
        item.range = new vscode.Range(position.line, item.range.start.character, position.line, item.range.end.character);
      }
      return item;
    });
  }
  // ===================================================================
  // MOOD TAG: "John (happy" or "join John (happy" - checked first
  // since the JOIN/LEAVE/UPDATE block below would otherwise treat
  // the '(' as a stray token and return an empty list before this
  // ever gets a chance to run.
  // ===================================================================
  const moodContext = timelineMoods.detectMoodContext(beforeCursor);
  if (moodContext) {
    return timelineMoods.createMoodSuggestions(moodContext.character, moodContext.typedMood);
  }
  // ===================================================================
  // JOIN / LEAVE / UPDATE
  // ===================================================================
  const characterCommandMatch = beforeCursor.match(/^\s*(join|leave|update)(?:\s+(.*))?$/);
  if (characterCommandMatch) {
    const command = characterCommandMatch[1];
    const argumentsText = characterCommandMatch[2] || '';
    // Once a '[' has been typed, we are past the character/position
    // slot entirely and inside the trailing options bracket instead -
    // that case is handled below by the dedicated bracket handler, so
    // this block does nothing (and, importantly, does NOT return).
    // A '[' inside an already-closed quoted character name (rare,
    // but names can contain almost anything) doesn't count, so
    // completed quoted spans are stripped before checking.
    const hasOpenBracket = argumentsText.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '').includes('[');
    if (!hasOpenBracket) {
      // ---------------------------------------------------------------
      // No argument yet
      //
      // join |
      // leave |
      // update |
      // ---------------------------------------------------------------
      if (argumentsText === '') {
        for (const name of sources.completionCharacterNames()) {
          items.push(completionItems.createCharacterCompletion(name));
        }
        return items;
      }
      // ---------------------------------------------------------------
      // Split arguments - quote-aware, so a name like "John Smith"
      // stays one token instead of being split on its inner space.
      // ---------------------------------------------------------------
      const argumentsParts = syntax.splitCommandArguments(argumentsText);
      // ---------------------------------------------------------------
      // Character is currently being typed
      //
      // join Lar|
      // leave Lar|
      // update Lar|
      // join "John |                     <- quoted name in progress
      // ---------------------------------------------------------------
      if (argumentsParts.length === 1) {
        const currentToken = argumentsParts[0];
        const prefix = syntax.extractCharacterNamePrefix(currentToken).toLowerCase();
        // Replace the whole typed token (quote included) rather than
        // just appending, since a quote or an internal space isn't
        // part of VS Code's default "word" and wouldn't otherwise be
        // covered by the edit.
        const tokenStartChar = beforeCursor.length - currentToken.length;
        const range = new vscode.Range(position.line, tokenStartChar, position.line, position.character);
        for (const name of sources.completionCharacterNames()) {
          if (!name.toLowerCase().startsWith(prefix)) {
            continue;
          }
          items.push(completionItems.createCharacterCompletion(name, range));
        }
        return items;
      }
      // ---------------------------------------------------------------
      // Position / transform arguments (join & update only; leave
      // does NOT have a position).
      //
      // join Laripo |                    <- plain position keyword
      // join Laripo pos=x0.3 size=y1 |    <- transform_command keys
      //
      // A plain position keyword (center, left, ...) can only be the
      // first token; transform_command keys (pos/size/rot, defined
      // per-entry in DTL_ENTRIES) can instead be used, one or more,
      // as an alternative. Once a plain position keyword has been
      // used, this slot is considered complete.
      // ---------------------------------------------------------------
      if (command === 'join' || command === 'update') {
        const typedTokens = argumentsParts.slice(1, -1);
        const currentToken = argumentsParts[argumentsParts.length - 1];
        const usedPlainPosition = typedTokens.some(
          token => events.DTL_POSITIONS.some(position => position.name === token)
        );
        if (!usedPlainPosition && !currentToken.includes('=')) {
          const prefix = currentToken.toLowerCase();
          if (argumentsParts.length === 2) {
            for (const position of events.DTL_POSITIONS) {
              if (position.name.toLowerCase().startsWith(prefix)) {
                items.push(completionItems.createPositionCompletion(position));
              }
            }
          }
          const commandEntry = events.DTL_ENTRIES.find(
            entry => entry.name === command && entry.type === 'command'
          );
          if (commandEntry && commandEntry.transform_command) {
            const usedTransformKeys = new Set(typedTokens.map(token => token.split('=')[0]));
            for (const [key, doc] of Object.entries(commandEntry.transform_command)) {
              if (usedTransformKeys.has(key)) {
                continue; // already set once on this line
              }
              if (!key.toLowerCase().startsWith(prefix)) {
                continue;
              }
              items.push(completionItems.createAttributeCompletion(key, doc));
            }
          }
          return items;
        }
      }
    }
  }
  // =========================================================================
  // JOIN / LEAVE / UPDATE - trailing [options] bracket
  //
  // join Laripo center [extra_data="..." |
  // leave Laripo [an|
  //
  // Reuses each command's own `variables` documentation (already
  // written in DTL_ENTRIES) instead of leaving this bracket
  // unsupported, the way the generic "[wait ...]"-style bracket
  // commands already are below.
  // =========================================================================
  const trailingOptionsMatch = beforeCursor.match(/^\s*(join|update|leave)\b[^[]*\[([^\]]*)$/);
  if (trailingOptionsMatch) {
    const commandEntry = events.DTL_ENTRIES.find(
      entry => entry.name === trailingOptionsMatch[1] && entry.type === 'command'
    );
    if (commandEntry && commandEntry.variables) {
      const bracketArgumentsText = trailingOptionsMatch[2];
      const currentToken = completionItems.getCurrentBracketToken(bracketArgumentsText);
      // Only suggest a parameter NAME while not already mid-value.
      if (!currentToken.includes('=')) {
        const prefix = currentToken.toLowerCase();
        const usedAttributes = new Set(bracketArgumentsText.match(/[A-Za-z_][A-Za-z0-9_]*(?==)/g) || []);
        for (const attributeName of Object.keys(commandEntry.variables)) {
          if (usedAttributes.has(attributeName)) {
            continue; // already set once on this line
          }
          if (!attributeName.toLowerCase().startsWith(prefix)) {
            continue;
          }
          items.push(completionItems.createAttributeCompletion(attributeName, commandEntry.variables[attributeName]));
        }
      } else {
        // Mid-value, e.g. "animation=Bou|" - offer known values for
        // this attribute (animation, move_trans, move_ease, ...) if
        // any. extra_data gets its own LayeredPortrait node-path
        // logic instead, since its values aren't a fixed enum.
        const equalsIndex = currentToken.indexOf('=');
        const attributeName = currentToken.slice(0, equalsIndex);
        const typedValue = currentToken.slice(equalsIndex + 1);
        if (attributeName === 'extra_data') {
          items.push(...timelineMoods.createEmotionPathSuggestions(line, typedValue));
        } else {
          items.push(...completionItems.createAttributeValueSuggestions(commandEntry.name, attributeName, typedValue, position));
        }
      }
      return items;
    }
  }
  // =========================================================================
  // BRACKET COMMANDS
  // Inside dialogue/narration text and choices, Godot BBCode tags are
  // offered after Dialogic's own commands. To keep the list short, a
  // bare "[" only offers the common tags
  // (COMMON_BBCODE_NAMES); the rest show up once a letter of their
  // name is typed - the list is marked incomplete so VS Code asks
  // again on every keystroke instead of only filtering the first one.
  // =========================================================================
  const imagePathMatch = beforeCursor.match(/\[img\b[^\]]*\]([^\[\]]*)$/);
  if (imagePathMatch) {
    return completionItems.createPathSuggestions(imagePathMatch[1], position, events.RESOURCE_EXTENSIONS.image, { quote: false });
  }
  const fontPathMatch = beforeCursor.match(/\[font(?:\s[^\]]*?\bname)?=("?[^\s\]"]*)$/);
  if (fontPathMatch) {
    return completionItems.createPathSuggestions(fontPathMatch[1], position, events.RESOURCE_EXTENSIONS.font, { quote: false });
  }
  // Values of Dialogic text effects: [portrait=... [mood=... [extra_data=...
  const effectValueMatch = beforeCursor.match(/\[(portrait|mood|extra_data)=([^\]]*)$/);
  if (effectValueMatch && completionItems.isInPlayerFacingText(beforeCursor.slice(0, effectValueMatch.index))) {
    return completionItems.createTextEffectValueSuggestions(line, effectValueMatch[1], effectValueMatch[2]);
  }
  const closingTagMatch = beforeCursor.match(/\[\/([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (closingTagMatch) {
    return completionItems.createClosingTagSuggestions(beforeCursor.slice(0, closingTagMatch.index), closingTagMatch[1] || '', line, position);
  }
  const bracketMatch = beforeCursor.match(/\[([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (bracketMatch) {
    const prefix = bracketMatch[1] || '';
    for ( const entry of events.DTL_ENTRIES ) {
      if (entry.type !== 'bracket') {
        continue;
      }
      if (
        !entry.name.startsWith(prefix)
      ) {
        continue;
      }
      const item = completionItems.createCommandCompletion(entry);
      item.sortText = `0_${entry.name}`;
      items.push(item);
    }
    // BBCode only makes sense inside dialogue/narration text and
    // choices - a standalone "[" line is a Dialogic event.
    const bbcodeMode = vscode.workspace.getConfiguration('dtlReader').get('completion.bbcode', 'common');
    if (!completionItems.isInPlayerFacingText(beforeCursor.slice(0, bracketMatch.index))) {
      return items;
    }
    if (bbcodeMode === 'off') {
      const effectRange = new vscode.Range(position.line, bracketMatch.index + 1, position.line, line[position.character] === ']' ? position.character + 1 : position.character);
      for (const entry of textEffects.DTL_TEXT_EFFECTS) {
        if (entry.name.startsWith(prefix)) { items.push(completionItems.createTextEffectCompletion(entry, effectRange)); }
      }
      return items;
    }
    const showAllBbcodes = prefix !== '' || bbcodeMode === 'all';
    // Replace an auto-closed "]" right after the cursor, since
    // the BBCode snippet brings its own.
    const nameStart = bracketMatch.index + 1;
    const replaceEnd = line[position.character] === ']' ? position.character + 1 : position.character;
    const range = new vscode.Range(position.line, nameStart, position.line, replaceEnd);
    // Dialogic's own text effects come right after its commands.
    for (const entry of textEffects.DTL_TEXT_EFFECTS) {
      if (entry.name.startsWith(prefix)) { items.push(completionItems.createTextEffectCompletion(entry, range)); }
    }
    for (const entry of bbcode.DTL_BBCODES) {
      if (!showAllBbcodes && !bbcode.COMMON_BBCODE_NAMES.has(entry.name)) { continue; }
      if (entry.name.startsWith(prefix)) {
        items.push(completionItems.createBbcodeCompletion(entry, range));
      }
    }
    return new vscode.CompletionList(items, !showAllBbcodes);
  }
  // =========================================================================
  // BRACKET COMMAND PARAMETERS (e.g. inside `[wait time=1.5 |`)
  // =========================================================================
  const openBracketIndex = beforeCursor.lastIndexOf('[');
  if (openBracketIndex !== -1 && !beforeCursor.slice(openBracketIndex).includes(']')) {
    const bracketContent = beforeCursor.slice(openBracketIndex + 1);
    const commandNameMatch = bracketContent.match(/^([A-Za-z_][A-Za-z0-9_]*)\s/);
    if (commandNameMatch) {
      const bracketEntry = completionItems.findBracketOrBbcodeEntry(commandNameMatch[1]);
      if (bracketEntry && bracketEntry.variables) {
        const afterCommandName = bracketContent.slice(commandNameMatch[0].length);
        const currentToken = completionItems.getCurrentBracketToken(afterCommandName);
        // Only suggest a parameter NAME while not already mid-value
        // (i.e. the token being typed has no '=' in it yet).
        if (!currentToken.includes('=')) {
          const prefix = currentToken.toLowerCase();
          const usedAttributes = new Set(afterCommandName.match(/[A-Za-z_][A-Za-z0-9_]*(?==)/g) || []);
          for (const attributeName of Object.keys(bracketEntry.variables)) {
            if (usedAttributes.has(attributeName)) {
              continue; // already set once on this line
            }
            if (!attributeName.toLowerCase().startsWith(prefix)) {
              continue;
            }
            items.push(completionItems.createAttributeCompletion(attributeName, bracketEntry.variables[attributeName]));
          }
          return items;
        }
        // Mid-value, e.g. "[background transition=Push|" - offer
        // known values for this attribute (transition, ...) if any.
        const equalsIndex = currentToken.indexOf('=');
        const attributeName = currentToken.slice(0, equalsIndex);
        const typedValue = currentToken.slice(equalsIndex + 1);
        const valueSuggestions = completionItems.createAttributeValueSuggestions(bracketEntry.name, attributeName, typedValue, position);
        if (valueSuggestions.length > 0) {
          items.push(...valueSuggestions);
          return items;
        }
      }
    }
  }
  // ===================================================================
  // AUDIO
  // ===================================================================
  const audioCommandMatch = beforeCursor.match(/^\s*audio(?:\s+(.*))?$/);
  if (audioCommandMatch) {
    const argumentsText = audioCommandMatch[1] || '';
    if (argumentsText === '') {
      for (const kind of sources.completionAudioChannels()) { items.push(completionItems.createAudioKindCompletion(kind)); }
      return items;
    }
    const argumentsParts = argumentsText.split(/\s+/);
    // Kind is being typed: "audio mu|"
    if (argumentsParts.length === 1) {
      const prefix = argumentsParts[0].toLowerCase();
      for (const kind of sources.completionAudioChannels()) {
        if (kind.toLowerCase().startsWith(prefix)) { items.push(completionItems.createAudioKindCompletion(kind)); }
      }
      return items;
    }
    // Kind fully typed, waiting for or typing the path:
    // "audio music |" or "audio music "res:/|" - only audio files
    // are offered. The typed value is everything after the kind
    // (not just the next whitespace-separated token), so a path
    // containing spaces still filters correctly.
    if (argumentsParts.length >= 2) {
      const typedValue = argumentsText.replace(/^\S+\s+/, '');
      if (/^"[^"]*"/.test(typedValue)) {
        return items; // path already written and closed
      }
      items.push(...completionItems.createPathSuggestions(typedValue, position, events.RESOURCE_EXTENSIONS.audio));
      if (typedValue === '' && items.length === 0) {
        items.push(completionItems.createAudioPathCompletion()); // no audio file in the project yet
      }
      return items;
    }
  }
  // ===================================================================
  // JUMP
  // ===================================================================
  // "jump |" offers this timeline's labels and the other timelines
  // ("Name/"); "jump Name/|" offers that timeline's labels.
  const jumpCommandMatch = beforeCursor.match(/^\s*jump\s+([^#]*)$/);
  if (jumpCommandMatch) {
    const typed = jumpCommandMatch[1];
    const lastSlash = typed.lastIndexOf('/');
    if (lastSlash !== -1) {
      const timeline = typed.slice(0, lastSlash);
      const labelPrefix = typed.slice(lastSlash + 1);
      const labels = project.getTimelineLabels(timeline);
      if (!labels) { return items; }
      const range = new vscode.Range(position.line, position.character - labelPrefix.length, position.line, position.character);
      for (const [label, info] of labels) {
        if (label.toLowerCase().startsWith(labelPrefix.toLowerCase())) {
          items.push(completionItems.createLabelCompletion(label, info, range, timeline));
        }
      }
      return items;
    }
    const range = new vscode.Range(position.line, position.character - typed.length, position.line, position.character);
    const prefix = typed.toLowerCase();
    for (const [label, info] of syntax.collectDocumentLabels(document)) {
      if (label.toLowerCase().startsWith(prefix)) {
        const item = completionItems.createLabelCompletion(label, info, range, null);
        item.sortText = `0_${label}`;
        items.push(item);
      }
    }
    const currentTimeline = project.findTimelineIdentifier(document);
    for (const identifier of state.cachedTimelinePaths.keys()) {
      if (identifier !== currentTimeline && identifier.toLowerCase().startsWith(prefix)) {
        items.push(completionItems.createTimelineCompletion(identifier, range));
      }
    }
    return items;
  }
  // =========================================================================
  // QUOTED SPEAKER NAME IN PROGRESS - "Joh or 'Joh at the start of a
  // line. Handled separately from the bare-identifier case below
  // since a quote isn't a "word" character and, left unhandled here,
  // isBareNarrationLine() would otherwise treat this as dialogue
  // text being typed rather than a still-open speaker name.
  // =========================================================================
  const quotedSpeakerMatch = beforeCursor.match(/^\s*("[^"\r\n]*|'[^'\r\n]*)$/);
  if (quotedSpeakerMatch) {
    const token = quotedSpeakerMatch[1];
    const prefix = syntax.extractCharacterNamePrefix(token).toLowerCase();
    const tokenStartChar = beforeCursor.length - token.length;
    const range = new vscode.Range(position.line, tokenStartChar, position.line, position.character);
    for (const name of sources.completionCharacterNames()) {
      if (name.toLowerCase().startsWith(prefix)) {
        items.push(completionItems.createCharacterCompletion(name, range));
      }
    }
    return items;
  }
  // =========================================================================
  // NORMAL COMMANDS + Dialogue characters.
  // =========================================================================
  if (/^\s*[\p{L}_][\p{L}0-9_]*$/u.test(beforeCursor)) {
    const prefix = beforeCursor.trim().toLowerCase();
    // Characters
    for (const name of sources.completionCharacterNames()) {
      if (name.toLowerCase().startsWith(prefix)) {
        items.push(completionItems.createCharacterCompletion(name));
      }
    }
    // Commands
    for (const entry of events.DTL_ENTRIES) {
      if (entry.type !== 'command') {continue;}
      if (entry.name.toLowerCase().startsWith(prefix)) {
        items.push(completionItems.createCommandCompletion(entry));
      }
    }
    // Whole blocks (choice, condition, loop...), only on an empty line
    // being started - not in front of existing text.
    if (line.slice(position.character).trim() === '') {
      items.push(...snippets.createBlockSnippets().filter(item => item.label.label.startsWith(prefix)));
    }
    return items;
  }
  // =========================================================================
  // DIALOGUE TEXT (word-based suggestions, VS Code "txt" style)
  // Only while a word is being typed: a trigger character here
  // (a '.' or ' ' ending a sentence, a "'" in "don't", ...) isn't
  // the start of anything worth suggesting.
  // =========================================================================
  if (syntax.isInsideDialogueText(beforeCursor)) {
    const wordsEnabled = vscode.workspace.getConfiguration('dtlReader').get('completion.dialogueWords', true);
    return triggerCharacter || !wordsEnabled ? [] : completionItems.createWordSuggestions(document, beforeCursor);
  }
  /// Fall back
  if (triggerCharacter) {
    return [];
  }
  for (const name of sources.completionCharacterNames()) {
    items.push(completionItems.createCharacterCompletion(name));
  }
  if (vscode.workspace.getConfiguration('dtlReader').get('completion.dialogueWords', true)) {
    items.push(...completionItems.createWordSuggestions(document, beforeCursor));
  }
  return items;
}

Object.assign(module.exports, {
  provideTimelineCompletions,
});
