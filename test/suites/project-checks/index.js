const vscode = require('vscode');
const { check, info, sleep, suite, path, fs } = require('../../harness');
const diagsOf = uri => vscode.languages.getDiagnostics(uri).map(d => ({ code: d.code, from: d.range.start.line, to: d.range.end.line, tags: d.tags || [], message: d.message }));
const labelsAt = async (uri, line, character) => {
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(line, character));
  return list.items.map(item => (typeof item.label === 'string' ? item.label : item.label.label));
};

exports.run = suite(async () => {
  {
    const ext = vscode.extensions.all.find(e => e.id === 'lorentyfle.dtl-reader');
    await ext.activate();
    const t = ext.exports.forTests;
    const root = vscode.workspace.workspaceFolders[0].uri;
    const at = (...parts) => vscode.Uri.joinPath(root, ...parts);
    const open = async uri => { const doc = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(doc); return doc; };

    // Wait for the project to load (custom events come last).
    const customUri = at('timelines', 'custom.dtl');
    await open(customUri);
    // Word-based suggestions would find "screen_shake" in the file itself, so
    // wait on the project data instead.
    for (let i = 0; i < 100 && !t.scriptStrings().has('from_script'); i++) { await sleep(200); }
    await sleep(1000);
    check('project loaded: script strings include from_script', t.scriptStrings().has('from_script'), t.resourcePaths().length);
    const probe = new vscode.WorkspaceEdit();
    const customDoc = await vscode.workspace.openTextDocument(customUri);
    probe.insert(customUri, new vscode.Position(customDoc.lineCount, 0), '[wait \n');
    await vscode.workspace.applyEdit(probe);
    info('[wait  completion: ' + JSON.stringify(await labelsAt(customUri, customDoc.lineCount - 2, 6)));
    info('[screen_shake  completion: ' + JSON.stringify(await labelsAt(customUri, 2, 14)) + ' line=' + JSON.stringify(customDoc.lineAt(2).text));

    // ---- Unreachable code and labels
    const flowUri = at('timelines', 'flow.dtl');
    await open(flowUri);
    await sleep(800);
    let d = diagsOf(flowUri);
    const code = d.filter(x => x.code === 'unreachableCode');
    check('flow: one dead region, lines 4-6', code.length === 1 && code[0].from === 4 && code[0].to === 6, d);
    check('flow: dead region is faded', code.length === 1 && code[0].tags.includes(vscode.DiagnosticTag.Unnecessary), d);
    const unreachableLabels = d.filter(x => x.code === 'unreachableLabel');
    check('flow: dead_label reported', unreachableLabels.length === 1 && unreachableLabels[0].from === 5, d);
    check('flow: target (jumped to) and from_script (script) not reported', !d.some(x => x.from >= 7), d);

    // A timeline not registered yet (new, not indexed by Dialogic) counts too.
    const freshUri = at('timelines', 'fresh.dtl');
    fs.writeFileSync(freshUri.fsPath, 'jump flow/dead_label\n');
    await open(freshUri);
    await sleep(800);
    d = diagsOf(flowUri);
    check('unregistered open timeline: its jump makes dead_label reachable', !d.some(x => x.code === 'unreachableLabel' && x.from === 5), d);

    // Create label: an indented jump at the end doesn't end the flow.
    const endsUri = at('timelines', 'ends.dtl');
    fs.writeFileSync(endsUri.fsPath, 'if {chapter} == 2\n\tjump nowhere\n');
    const endsDoc = await open(endsUri);
    await sleep(800);
    const endsDiag = vscode.languages.getDiagnostics(endsUri).find(x => x.code === 'unresolvedJump');
    const endsActions = endsDiag ? await vscode.commands.executeCommand('vscode.executeCodeActionProvider', endsUri, endsDiag.range) : [];
    const create = (endsActions || []).find(a => a.title.startsWith('Create "label nowhere"'));
    if (create) { await vscode.workspace.applyEdit(create.edit); }
    check('create label after an indented jump adds [end_timeline]', endsDoc.getText() === 'if {chapter} == 2\n\tjump nowhere\n\n[end_timeline]\n\nlabel nowhere\n', endsDoc.getText());

    // Add variable: a project.godot with unsaved changes isn't saved by the fix.
    const projectUri = at('project.godot');
    const projectDoc = await vscode.workspace.openTextDocument(projectUri);
    const unsaved = new vscode.WorkspaceEdit();
    unsaved.insert(projectUri, new vscode.Position(0, 0), '; my unsaved note\n');
    await vscode.workspace.applyEdit(unsaved);
    const varDoc = await open(freshUri);
    const varEdit = new vscode.WorkspaceEdit();
    varEdit.insert(freshUri, new vscode.Position(varDoc.lineCount, 0), 'set {brand_new} = 1\n');
    await vscode.workspace.applyEdit(varEdit);
    await sleep(800);
    const varDiag = vscode.languages.getDiagnostics(freshUri).find(x => x.code === 'unknownVariable');
    const varActions = varDiag ? await vscode.commands.executeCommand('vscode.executeCodeActionProvider', freshUri, varDiag.range) : [];
    const addVar = (varActions || []).find(a => a.title === 'Add the variable "brand_new" to project.godot as a whole number (0)');
    if (addVar) {
      await vscode.workspace.applyEdit(addVar.edit);
      await vscode.commands.executeCommand(addVar.command.command, ...addVar.command.arguments);
    }
    const onDisk = fs.readFileSync(projectUri.fsPath, 'utf8');
    check('add variable: dirty project.godot changed in the editor', !!addVar && projectDoc.getText().includes('"brand_new": 0') && projectDoc.isDirty, [!!addVar, projectDoc.isDirty]);
    check('add variable: dirty project.godot not saved (the unsaved note stays unsaved)', !onDisk.includes('my unsaved note') && !onDisk.includes('brand_new'), onDisk.slice(0, 200));
    await vscode.window.showTextDocument(projectDoc);
    await vscode.commands.executeCommand('workbench.action.files.revert');

    const dynamicUri = at('timelines', 'dynamic.dtl');
    await open(dynamicUri);
    await sleep(800);
    d = diagsOf(dynamicUri);
    check('dynamic: code after jump {x} is dead until the label', d.some(x => x.code === 'unreachableCode' && x.from === 1 && x.to === 1), d);
    check('dynamic: label not reported (a computed jump may lead there)', !d.some(x => x.code === 'unreachableLabel'), d);

    const testUri = at('timelines', 'test_timeline.dtl');
    await open(testUri);
    await sleep(800);
    d = diagsOf(testUri).filter(x => x.code === 'unreachableCode' || x.code === 'unreachableLabel');
    info('test_timeline flow diagnostics: ' + JSON.stringify(d));
    const chapterUri = at('timelines', 'chapter2.dtl');
    await open(chapterUri);
    await sleep(800);
    d = diagsOf(chapterUri).filter(x => x.code === 'unreachableCode' || x.code === 'unreachableLabel');
    info('chapter2 flow diagnostics: ' + JSON.stringify(d));

    // ---- Unused characters and portraits
    const char2Uri = at('characters', 'TestCharacter2.dch');
    await open(char2Uri);
    await sleep(800);
    d = diagsOf(char2Uri);
    check('TestCharacter2: used, no unusedCharacter', !d.some(x => x.code === 'unusedCharacter'), d);
    check('TestCharacter2: LayeredPortrait unused (faded), Default is the implicit default', d.filter(x => x.code === 'unusedPortrait').length === 1 && /LayeredPortrait/.test(d.find(x => x.code === 'unusedPortrait').message) && d.find(x => x.code === 'unusedPortrait').tags.includes(vscode.DiagnosticTag.Unnecessary), d);
    const char1Uri = at('characters', 'TestCharacter.dch');
    await open(char1Uri);
    await sleep(800);
    d = diagsOf(char1Uri);
    check('TestCharacter: every portrait used', !d.some(x => x.code === 'unusedPortrait' || x.code === 'unusedCharacter'), d);
    const char3Uri = at('characters', 'Test Character3.dch');
    await open(char3Uri);
    await sleep(800);
    d = diagsOf(char3Uri);
    info('Test Character3: ' + JSON.stringify(d.map(x => x.code)));
    // Using a portrait live removes the report.
    const flowDoc = await open(flowUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(flowUri, new vscode.Position(flowDoc.lineCount, 0), 'TestCharacter2 (LayeredPortrait): now used\n');
    await vscode.workspace.applyEdit(edit);
    await sleep(800);
    check('TestCharacter2: LayeredPortrait used live -> not reported', !diagsOf(char2Uri).some(x => x.code === 'unusedPortrait'), diagsOf(char2Uri));

    // ---- Custom events
    let items = await labelsAt(customUri, 1, 4);
    check('custom event suggested after [scr', items.includes('screen_shake'), items);
    items = await labelsAt(customUri, 2, 14);
    check('custom event parameters', ['strength', 'wait', 'mode'].every(name => items.includes(name)), items);
    items = await labelsAt(customUri, 3, 19);
    check('bool parameter values', items.includes('true') && items.includes('false'), items);
    items = await labelsAt(customUri, 4, 19);
    check('suggested parameter values', items.includes('soft') && items.includes('hard'), items);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', customUri, new vscode.Position(0, 4)) || [];
    const hoverText = hovers.map(h => h.contents.map(c => c.value || '').join('')).join('');
    check('custom event hover', /Screen Shake/.test(hoverText) && /Shakes the whole screen/.test(hoverText) && /How strong the shake is/.test(hoverText) && /event_screen_shake\.gd/.test(hoverText) && /\[screen_shake strength=1\.0\]/.test(hoverText), hoverText);
    check('parameter doc has type and default, not the ### title', /How strong the shake is\. \(`float`, default `1\.0`\)/.test(hoverText) && !/Settings/.test(hoverText), hoverText);

    // ---- Block snippets
    const snippetUri = at('timelines', 'custom.dtl');
    const snippetDoc = await open(snippetUri);
    const e2 = new vscode.WorkspaceEdit();
    e2.insert(snippetUri, new vscode.Position(snippetDoc.lineCount, 0), 'cho\nTestCharacter: I have a cho\n');
    await vscode.workspace.applyEdit(e2);
    const choLine = snippetDoc.lineCount - 3;
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', snippetUri, new vscode.Position(choLine, 3));
    const choice = list.items.find(item => item.kind === vscode.CompletionItemKind.Snippet && (item.label.label || item.label) === 'choice');
    check('block snippet "choice" at line start', !!choice, list.items.map(i => i.label.label || i.label));
    check('choice snippet offers the characters', choice && /\$\{2\|[^}]*TestCharacter[^}]*\|\}/.test(choice.insertText.value), choice && choice.insertText.value);
    items = await labelsAt(snippetUri, choLine + 1, 'TestCharacter: I have a cho'.length);
    check('no block snippet inside dialogue', !items.includes('choice'), items);

    // ---- Play in Godot
    // Godot's data folder, and its own folder in it, on each platform.
    const os = require('os');
    const [dataDir, godotDir] = process.platform === 'win32' ? [process.env.APPDATA, 'Godot']
      : process.platform === 'darwin' ? [path.join(os.homedir(), 'Library', 'Application Support'), 'Godot']
      : [process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'godot'];
    const userDir = t.godotUserDataDir(fs.readFileSync(path.join(root.fsPath, 'project.godot'), 'utf8'));
    check('user dir from custom_user_dir_name', userDir === path.join(dataDir, 'dtl_reader_test_run'), userDir);
    check('user dir for a plain project', t.godotUserDataDir('[application]\nconfig/name="My: Game"\n') === path.join(dataDir, godotDir, 'app_userdata', 'My_ Game'), t.godotUserDataDir('[application]\nconfig/name="My: Game"\n'));
    const cfg = t.setConfigFileValues('[DES]\n\nplay_from_index=12\nlast_timeline="x"\n\n[Other]\n\na=1\n', 'DES', { current_timeline_path: '"res://t.dtl"', play_from_index: '-1' });
    check('config file: keys set, others kept', cfg === '[DES]\n\nplay_from_index=-1\nlast_timeline="x"\ncurrent_timeline_path="res://t.dtl"\n\n[Other]\n\na=1\n', cfg);
    check('config file: new file', t.setConfigFileValues('', 'DES', { a: '1' }) === '[DES]\n\na=1\n', t.setConfigFileValues('', 'DES', { a: '1' }));
    // Run the command with a stand-in executable that just exits.
    const standIn = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe') : '/usr/bin/true';
    await vscode.workspace.getConfiguration('dtlReader').update('godotPath', standIn, vscode.ConfigurationTarget.Global);
    await open(flowUri);
    await vscode.commands.executeCommand('dtlReader.playTimeline', flowUri);
    await sleep(1500);
    const settingsFile = path.join(userDir, 'dialogic', 'editor_settings.cfg');
    const written = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
    check('play: Dialogic editor settings written', written.includes('current_timeline_path="res://timelines/flow.dtl"') && written.includes('play_from_index=-1'), written);
    check('play: unsaved timeline saved first', !vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === flowUri.fsPath).isDirty, null);
    // ---- Play from this line: Dialogic's event index of each line
    const sample = [
      'join A left',        // 0 -> 0
      'A: hi',              // 1 -> 1
      '',                   // 2 -> 2 (the next event)
      '# comment',          // 3 -> 2 (comments are events)
      'if {x} == 1',        // 4 -> 3
      '\tA: yes',           // 5 -> 4
      '\tset {x} = 2',      // 6 -> 5
      'else',               // 7 -> 6 (Dialogic indexes it before the end branch it adds)
      '\tA: no',            // 8 -> 8
      '- Choice',           // 9 -> 9
      '\tA: chose',         // 10 -> 11
      '[wait time=1',       // 11 -> 12 (a shortcode goes on until "]")
      ' hide_text=true]',   // 12 -> 13
      'A: multi \\',        // 13 -> 14 (a text ending with \ goes on)
      'line two',           // 14 -> 14
      'label end',          // 15 -> 15
      'if {x} == 2',        // 16 -> 16
      'A: after empty if',  // 17 -> 17 (then +1: the empty if's end branch)
      'iffy text',          // 18 -> 19 (not a condition)
      'A: last',            // 19 -> 20
      '[b]Hello[/b] there', // 20 -> 21 (BBCode starting a text is not a shortcode)
      'A: next',            // 21 -> 22
      '[screen_shake strength=2', // 22 -> 23 (a custom event is a shortcode)
      ' wait=true]',        // 23 -> 23
      'A: after',           // 24 -> 24
    ];
    const expected = [0, 1, 2, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 14, 15, 16, 17, 19, 20, 21, 22, 23, 23, 24];
    const indices = t.computeDialogicEventIndices(sample);
    check('event index of each line, like Dialogic', JSON.stringify(indices) === JSON.stringify(expected), indices);

    const flowDocument = await open(flowUri);
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(8, 0, 8, 0); // "TestCharacter: reached"
    const expectedIndex = t.computeDialogicEventIndices(flowDocument.getText().split(/\r?\n/))[8];
    await vscode.commands.executeCommand('dtlReader.playTimelineFromLine');
    await sleep(1500);
    const fromLine = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
    check('play from line: play_from_index written', fromLine.includes(`play_from_index=${expectedIndex}`) && expectedIndex > 0, [expectedIndex, fromLine]);
    await vscode.commands.executeCommand('dtlReader.playTimeline', flowUri);
    await sleep(1500);
    check('play (whole): play_from_index back to -1', fs.readFileSync(settingsFile, 'utf8').includes('play_from_index=-1'), fs.readFileSync(settingsFile, 'utf8'));

    await vscode.workspace.getConfiguration('dtlReader').update('godotPath', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(userDir, { recursive: true, force: true });
    check('play: test user dir cleaned up', !fs.existsSync(userDir), userDir);
  }
});
