// A check of each feature that the other suites don't cover, on test-room
// as it is: hover, outline, semantic tokens, colors, code lens, references,
// rename, completion, .dch support, glossary and translation.

const vscode = require('vscode');
const { check, suite, start, open, sleep, waitFor, fs } = require('../../harness');

/** The position of `text` (its `offset`-th character) in a document. */
function find(document, text, offset = 0) {
  const index = document.getText().indexOf(text);
  if (index === -1) { throw new Error(`"${text}" not found in ${document.uri.path}`); }
  return document.positionAt(index + offset);
}

const hoverText = async (uri, position) => {
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position) || [];
  return hovers.map(hover => hover.contents.map(content => content.value || String(content)).join('\n')).join('\n');
};
const completionLabels = async (uri, position, trigger) => {
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, position, trigger);
  return list.items.filter(item => item.kind !== vscode.CompletionItemKind.Text).map(item => (typeof item.label === 'string' ? item.label : item.label.label));
};

exports.run = suite(async () => {
  const { at, internals } = await start();
  const timelineUri = at('timelines', 'test_timeline.dtl');
  const timeline = await open(timelineUri);
  await sleep(500);

  // ---- Hover
  let text = await hoverText(timelineUri, find(timeline, 'join TestCharacter', 1));
  check('hover: an event', /join/.test(text) && /Syntax/.test(text), text);
  text = await hoverText(timelineUri, find(timeline, 'join TestCharacter', 7));
  check('hover: a character (display name from its .dch)', /Super John/.test(text), text);
  text = await hoverText(timelineUri, find(timeline, '(LayeredPortrait) left', 3));
  check('hover: a mood', /LayeredPortrait/.test(text), text);
  text = await hoverText(timelineUri, find(timeline, 'do Global.has_achievement', 12));
  check('hover: an autoload function (its signature)', /has_achievement/.test(text), text);
  text = await hoverText(timelineUri, find(timeline, '{variable.test}', 11));
  check('hover: a Dialogic variable', /test/.test(text), text);
  text = await hoverText(timelineUri, find(timeline, '[wave', 2));
  check('hover: a BBCode tag', /wave/i.test(text), text);
  text = await hoverText(timelineUri, find(timeline, '[pause=', 2));
  check('hover: a text effect', /pause/i.test(text), text);
  text = await hoverText(timelineUri, find(timeline, 'jump loop_start', 7));
  check('hover: a jump shows the label\'s ## doc', /Loops back here/.test(text), text);

  // ---- Outline, semantic tokens, colors, code lens
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', timelineUri) || [];
  const flat = [];
  const walk = list => list.forEach(symbol => { flat.push(symbol.name); walk(symbol.children || []); });
  walk(symbols);
  check('outline: labels listed', flat.includes('loop_start') && flat.includes('forgotten'), flat);
  let tokens = null;
  try { tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', timelineUri); } catch (error) { tokens = { error: error.message }; }
  check('semantic tokens: autoload references colored', !!tokens && !!tokens.data && tokens.data.length > 0, tokens && (tokens.error || tokens.data.length));
  const dchUri = at('characters', 'TestCharacter.dch');
  await vscode.workspace.openTextDocument(dchUri);
  let dchColors;
  try { dchColors = await vscode.commands.executeCommand('vscode.executeDocumentColorProvider', dchUri) || []; } catch (error) { dchColors = error.message; }
  check('colors: Color(...) in a .dch', Array.isArray(dchColors) && dchColors.length > 0, dchColors);
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', timelineUri) || [];
  check('code lens: "N jumps here" above labels', lenses.some(lens => lens.command && /jumps? here/.test(lens.command.title)), lenses.map(lens => lens.command && lens.command.title));

  // ---- References and rename
  const labelPosition = find(timeline, 'label loop_start', 6);
  const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', timelineUri, labelPosition) || [];
  check('references: the jumps to a label, in every timeline', references.length >= 2 && references.some(reference => reference.uri.path.endsWith('chapter2.dtl')), references.map(reference => `${reference.uri.path.split('/').pop()}:${reference.range.start.line}`));
  const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', timelineUri, labelPosition, 'loop_again');
  const renamed = rename ? rename.entries().reduce((count, [, edits]) => count + edits.length, 0) : 0;
  check('rename: a label and every jump to it', renamed >= 3, renamed);

  // ---- Completion
  const scratchUri = at('timelines', 'scratch.dtl');
  fs.writeFileSync(scratchUri.fsPath, 'jo\nTestCharacter (\n[\nTestCharacter: {\njump \naudio \n');
  const scratch = await open(scratchUri);
  await sleep(500);
  let labels = await completionLabels(scratchUri, new vscode.Position(0, 2));
  check('completion: events at the start of a line', labels.includes('join'), labels);
  labels = await completionLabels(scratchUri, new vscode.Position(1, 15), '(');
  check('completion: moods after "Name ("', labels.includes('Default') && labels.includes('LayeredPortrait'), labels);
  labels = await completionLabels(scratchUri, new vscode.Position(2, 1), '[');
  check('completion: bracket events after "["', labels.includes('wait') && labels.includes('background'), labels);
  labels = await completionLabels(scratchUri, new vscode.Position(3, 16), '{');
  check('completion: variables after "{"', labels.some(label => label.startsWith('variable')) && labels.some(label => label.startsWith('chapter')), labels);
  labels = await completionLabels(scratchUri, new vscode.Position(4, 5), ' ');
  check('completion: other timelines after "jump "', labels.includes('chapter2/') && labels.includes('test_timeline/'), labels);
  labels = await completionLabels(scratchUri, new vscode.Position(5, 6), ' ');
  check('completion: audio channels after "audio "', labels.includes('music'), labels);
  check('scratch file untouched by completion', scratch.getText().startsWith('jo\n'), scratch.getText().slice(0, 20));

  // ---- .dch files
  const dch = await open(dchUri);
  text = await hoverText(dchUri, find(dch, 'display_name', 1));
  check('dch hover: a key', /display_name/.test(text), text);
  const emptyDchUri = at('characters', 'Empty.dch');
  fs.writeFileSync(emptyDchUri.fsPath, '');
  await open(emptyDchUri);
  labels = await completionLabels(emptyDchUri, new vscode.Position(0, 0));
  check('dch completion: a whole character in an empty file', labels.includes('Dialogic character'), labels);

  // ---- Glossary
  await open(timelineUri);
  text = await hoverText(timelineUri, find(timeline, 'out of mana', 7));
  check('glossary: hover on a glossary word', /Mana/.test(text), text);
  const glossaryTarget = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', timelineUri, find(timeline, 'out of mana', 8)) || [];
  check('glossary: Ctrl+Click opens its entry', glossaryTarget.some(target => (target.targetUri || target.uri).path.endsWith('.tres')), glossaryTarget.length);

  // ---- Translation
  await vscode.workspace.getConfiguration('dtlReader').update('translation.language', 'fr', vscode.ConfigurationTarget.Workspace);
  await sleep(800);
  text = await hoverText(timelineUri, find(timeline, '#id:greeting', 2));
  check('translation: hovering an #id shows its translations', /Bonjour/.test(text), text);
  await waitFor(() => vscode.languages.getDiagnostics(timelineUri).some(diagnostic => diagnostic.code === 'missingTranslation'));
  const missing = vscode.languages.getDiagnostics(timelineUri).filter(diagnostic => diagnostic.code === 'missingTranslation').map(diagnostic => timeline.lineAt(diagnostic.range.start.line).text);
  check('translation: an untranslated line is marked', missing.some(line => /choice_goodbye/.test(line)), missing);
  // The command asks which languages to show; open the view it would open.
  const view = await vscode.workspace.openTextDocument(internals.translationViewUri({ source: 'timeline', uri: timelineUri }, ['fr']));
  await vscode.window.showTextDocument(view);
  check('translation view: opens beside the timeline', !!view && view.uri.scheme === 'dtl-translation' && /Bonjour/.test(view.getText()), view && view.uri.toString());
  if (view) {
    // Translate "Say goodbye" and save: it's written into Dialogic's CSV.
    const lines = view.getText().split(/\r?\n/);
    const original = lines.findIndex(line => line.includes('Say goodbye'));
    const slot = lines.findIndex((line, index) => index > original && /^\s*fr\b/.test(line));
    check('translation view: a line to type the French translation in', original !== -1 && slot !== -1, lines.slice(Math.max(0, original - 2), original + 4));
    if (slot !== -1) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(view.uri, view.lineAt(slot).range, `${lines[slot]}Dire au revoir`);
      await vscode.workspace.applyEdit(edit);
      await view.save();
      await sleep(800);
      const csv = fs.readFileSync(at('translations', 'dialogic_timeline_translations.csv').fsPath, 'utf8');
      check('translation view: saving writes the CSV', /Choice\/choice_goodbye\/text,Say goodbye,Dire au revoir/.test(csv), csv.split(/\r?\n/).find(line => line.includes('choice_goodbye')));
    }
  }
  await vscode.workspace.getConfiguration('dtlReader').update('translation.language', undefined, vscode.ConfigurationTarget.Workspace);
});
