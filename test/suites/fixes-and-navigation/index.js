const vscode = require('vscode');
const { check, info, sleep, suite, path, fs } = require('../../harness');

async function actionsAt(uri, line) {
  const diags = vscode.languages.getDiagnostics(uri).filter(d => d.range.start.line === line);
  const range = diags.length ? diags[0].range : new vscode.Range(line, 0, line, 0);
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, range) || [];
  return actions;
}
const titles = actions => actions.map(a => a.title);

async function defAt(uri, line, character) {
  const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, new vscode.Position(line, character)) || [];
  return result.map(r => ({
    file: path.basename((r.targetUri || r.uri).fsPath),
    line: (r.targetSelectionRange || r.range).start.line,
    char: (r.targetSelectionRange || r.range).start.character,
    origin: r.originSelectionRange ? [r.originSelectionRange.start.character, r.originSelectionRange.end.character] : null,
  }));
}

exports.run = suite(async () => {
  {
    const ext = vscode.extensions.all.find(e => e.id === 'lorentyfle.dtl-reader');
    await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri;
    const uri = vscode.Uri.joinPath(root, 'timelines', 'qf.dtl');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    for (let i = 0; i < 50 && vscode.languages.getDiagnostics(uri).filter(d => d.code === 'unknownVariable').length === 0; i++) { await sleep(200); }
    // Project data loads asynchronously - poke diagnostics once it's in.
    await sleep(1500);
    const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(doc.lineCount, 0), ''); await vscode.workspace.applyEdit(edit);
    await sleep(500);
    info('' + vscode.languages.getDiagnostics(uri).map(d => `${d.range.start.line}:${d.code}`).join(', '));

    let t = titles(await actionsAt(uri, 1));
    check('jump strat -> Change to "start"', t.includes('Change to "start"'), t);
    check('jump strat -> create label', t.some(x => x.startsWith('Create "label strat"')), t);
    t = titles(await actionsAt(uri, 3));
    check('jump chapter2/nowhere -> create in chapter2', t.includes('Create "label nowhere" at the end of chapter2'), t);
    t = titles(await actionsAt(uri, 4));
    check('jump chaptr2/ -> Change to "chapter2"', t.includes('Change to "chapter2"'), t);
    t = titles(await actionsAt(uri, 5));
    check('jump #id -> remove', t.includes('Remove the translation id'), t);
    t = titles(await actionsAt(uri, 6));
    check('join TestCharactr -> TestCharacter', t.includes('Change to "TestCharacter"'), t);
    t = titles(await actionsAt(uri, 7));
    check('(Defualt) -> Default', t.includes('Change to "Default"'), t);
    check('(Defualt) -> add portrait', t.includes('Add the portrait "Defualt" to TestCharacter'), t);
    t = titles(await actionsAt(uri, 8));
    check('[portrait=Defaul] -> Default', t.includes('Change to "Default"'), t);
    t = titles(await actionsAt(uri, 9));
    check('[b] unclosed -> close', t.includes('Close [b] at the end of the line'), t);
    t = titles(await actionsAt(uri, 10));
    check('choice [i] unclosed -> close', t.includes('Close [i] at the end of the line'), t);
    t = titles(await actionsAt(uri, 11));
    check('{chapte} -> chapter', t.includes('Change to "chapter"'), t);

    // Apply fixes and check the text.
    const apply = async (line, title) => {
      const action = (await actionsAt(uri, line)).find(a => a.title === title);
      if (!action) { return false; }
      if (action.edit) { await vscode.workspace.applyEdit(action.edit); }
      if (action.command) { await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments || [])); }
      return true;
    };
    await apply(9, 'Close [b] at the end of the line');
    check('close [b] text', doc.lineAt(9).text === 'TestCharacter: [b]bold text[/b] #id:x1', doc.lineAt(9).text);
    await vscode.window.showTextDocument(doc);
    await apply(10, 'Close [i] at the end of the line');
    check('close [i] text', doc.lineAt(10).text === '- Choice [i]x[/i] | [if {chapter} == 1]', doc.lineAt(10).text);
    await vscode.window.showTextDocument(doc);
    await apply(5, 'Remove the translation id');
    check('remove #id text', doc.lineAt(5).text === 'jump start', doc.lineAt(5).text);
    await vscode.window.showTextDocument(doc);
    await apply(2, 'Create "label missing_one" at the end of this timeline');
    const tail = doc.getText().split('\n').slice(-5);
    check('create label local', /\[end_timeline\]\n\nlabel missing_one\n$/.test(doc.getText()), tail);
    await vscode.window.showTextDocument(doc);
    await apply(7, 'Add the portrait "Defualt" to TestCharacter');
    const dch = vscode.workspace.textDocuments.find(d => d.uri.fsPath.endsWith('TestCharacter.dch'));
    const dchText = dch ? dch.getText() : '';
    check('portrait added', dchText.includes('&"Defualt": {'), dchText);
    const active = vscode.window.activeTextEditor;
    check('dch opened at image path', active && active.document === dch && active.document.lineAt(active.selection.active.line).text.slice(0, active.selection.active.character).endsWith('res://'),
      active && [active.document.uri.fsPath, active.selection.active.line, active.selection.active.character]);
    // The .dch must still parse: count braces.
    check('dch braces balanced', (dchText.match(/\{/g) || []).length === (dchText.match(/\}/g) || []).length, dchText);
    await vscode.window.showTextDocument(doc);
    await apply(3, 'Create "label nowhere" at the end of chapter2');
    const ch2 = vscode.workspace.textDocuments.find(d => d.uri.fsPath.endsWith('chapter2.dtl'));
    check('create label chapter2', ch2 && /label nowhere\r?\n$/.test(ch2.getText()), ch2 && ch2.getText().slice(-80));
    const activeCh2 = vscode.window.activeTextEditor;
    check('chapter2 opened on label', activeCh2 && activeCh2.document === ch2 && activeCh2.document.lineAt(activeCh2.selection.active.line).text === 'label nowhere', activeCh2 && activeCh2.document.lineAt(activeCh2.selection.active.line).text);
    await vscode.window.showTextDocument(doc);

    // Definitions.
    let d = await defAt(uri, 6, 8); // join TestCharactr (unknown) - nothing
    check('def unknown character: none', d.length === 0, d);
    d = await defAt(uri, 12, 3); // "John Smith"
    check('def quoted character -> JohnSmith.dch', d.length === 1 && d[0].file === 'JohnSmith.dch' && d[0].origin[0] === 0 && d[0].origin[1] === 12, d);
    d = await defAt(uri, 17, 17); // (LayeredPortrait)
    check('def mood -> portrait key', d.length === 1 && d[0].file === 'TestCharacter.dch' && d[0].line > 0, d);
    d = await defAt(uri, 13, 3); // TestCharacter speaker
    check('def speaker -> TestCharacter.dch', d.length === 1 && d[0].file === 'TestCharacter.dch', d);
    d = await defAt(uri, 14, 12); // Global.apply_tint
    check('def autoload function -> Global.gd line 28', d.length === 1 && d[0].file === 'Global.gd' && d[0].line === 28, d);
    d = await defAt(uri, 14, 5); // Global
    check('def autoload -> Global.gd top', d.length === 1 && d[0].file === 'Global.gd' && d[0].line === 0, d);
    d = await defAt(uri, 15, 33); // Global.State.TALKING -> TALKING
    check('def enum value -> Global.gd line 5', d.length === 1 && d[0].file === 'Global.gd' && d[0].line === 5 && d[0].char > 0, d);
    d = await defAt(uri, 13, 20); // {Global.hearts}
    check('def autoload var in braces', d.length === 1 && d[0].file === 'Global.gd', d);
    d = await defAt(uri, 16, 25); // res://assets/bg.png
    check('def res path -> bg.png', d.length === 1 && d[0].file === 'bg.png' && d[0].origin[0] === 17, d);
    d = await defAt(uri, 0, 8);
    check('def on label line: none', d.length === 0, d);
    // jump start still works (line 5 now "jump start")
    d = await defAt(uri, 5, 7);
    check('def jump -> label start', d.length === 1 && d[0].file === 'qf.dtl' && d[0].line === 0, d);

    // dch definitions.
    const dchUri = vscode.Uri.joinPath(root, 'characters', 'TestCharacter.dch');
    const dchDoc = await vscode.workspace.openTextDocument(dchUri);
    const defaultLine = dchDoc.getText().split('\n').findIndex(l => l.includes('default_portrait'));
    const defaultCol = dchDoc.lineAt(defaultLine).text.indexOf('Default') + 2;
    d = await defAt(dchUri, defaultLine, defaultCol);
    check('dch default_portrait -> portrait', d.length === 1 && d[0].file === 'TestCharacter.dch' && d[0].line > defaultLine, d);
    const sceneLine = dchDoc.getText().split('\n').findIndex(l => l.includes('res://characters/TestCharacterPortrait.tscn'));
    d = await defAt(dchUri, sceneLine, dchDoc.lineAt(sceneLine).text.indexOf('res://') + 3);
    check('dch scene path -> tscn', d.length === 1 && d[0].file === 'TestCharacterPortrait.tscn', d);

    // Workspace symbols.
    const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'Ending') || [];
    check('workspace symbol label', symbols.some(s => s.name === 'Ending With Spaces' && s.containerName === 'chapter2'), symbols.map(s => s.name));
    const symbols2 = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'john') || [];
    check('workspace symbol character', symbols2.some(s => s.name === 'John Smith' && s.containerName === 'character'), symbols2.map(s => s.name));

    // Hover on autoload still works after refactor.
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(14, 12)) || [];
    check('hover autoload member still works', hovers.some(h => h.contents.some(c => (c.value || '').includes('apply_tint'))), hovers.length);

    // Add to project.godot.
    await vscode.window.showTextDocument(doc);
    t = titles(await actionsAt(uri, 6));
    check('join TestCharactr -> add character', t.includes('Add the character "TestCharactr" to project.godot, with a new TestCharactr.dch...'), t);
    t = titles(await actionsAt(uri, 21));
    check('unregistered Orphan.dch -> register directly', t.includes('Add the character "Orphan" (res://characters/Orphan.dch) to project.godot'), t);

    // Folder ranking, read directly; creation through the command's `folder` argument.
    const { rankCharacterFolders } = ext.exports.forTests;
    const ranked = async relative => rankCharacterFolders(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ...relative))).map(c => `${c.folder} | ${c.reason}`);
    let folders = await ranked(['timelines', 'other', 'o.dtl']);
    check('ranking: this timeline\'s cast first', folders[0] === 'res://cast/side | with Sider, who is in this timeline', folders);
    check('ranking: then most used project folder', folders[1] === 'res://characters | where 4 of the project\'s 6 characters are', folders);
    check('ranking: then the other character folders', folders[2] === 'res://cast/chapter2 | where 1 of the project\'s 6 characters is', folders);
    check('ranking: then the timeline folder', folders.includes('res://timelines/other | this timeline\'s folder'), folders);
    folders = await ranked(['timelines', 'chapter2', 'c.dtl']);
    check('ranking: folder named like the timeline folder first', folders[0] === 'res://cast/chapter2 | named like this timeline\'s folder "chapter2"', folders);
    check('ranking: then this timeline\'s cast', folders[1] === 'res://cast/side | with Sider, who is in this timeline', folders);
    folders = await ranked(['timelines', 'qf.dtl']);
    check('ranking: qf.dtl cast in res://characters', folders[0].startsWith('res://characters | with TestCharacter, John Smith'), folders);
    const otherUri = vscode.Uri.joinPath(root, 'timelines', 'other', 'o.dtl');
    await vscode.commands.executeCommand('dtlReader.addCharacter', { name: 'Newcomer', mood: null, timeline: otherUri.toString(), folder: 'res://cast/side' });
    await sleep(300);
    check('Newcomer.dch created in cast/side', fs.existsSync(path.join(root.fsPath, 'cast', 'side', 'Newcomer.dch')), null);
    await vscode.window.showTextDocument(doc);
    const addTitles = (name, order) => order.map(key => ({
      text: `Add the variable "${name}" to project.godot as a text ("")`,
      int: `Add the variable "${name}" to project.godot as a whole number (0)`,
      float: `Add the variable "${name}" to project.godot as a decimal number (0.0)`,
      bool: `Add the variable "${name}" to project.godot as a bool (false)`,
    })[key]);
    const addsOf = list => list.filter(x => x.startsWith('Add the variable'));
    t = titles(await actionsAt(uri, 11));
    check('{chapte} = 2 -> 4 types, int first', JSON.stringify(addsOf(t)) === JSON.stringify(addTitles('chapte', ['int', 'text', 'float', 'bool'])), addsOf(t));
    check('{chapte} did-you-mean comes before adds', t.indexOf('Change to "chapter"') !== -1 && t.indexOf('Change to "chapter"') < t.indexOf(addsOf(t)[0]), t);
    t = titles(await actionsAt(uri, 18));
    check('{variable.nw} == true -> bool first', JSON.stringify(addsOf(t)) === JSON.stringify(addTitles('variable.nw', ['bool', 'text', 'int', 'float'])), addsOf(t));
    t = titles(await actionsAt(uri, 19));
    check('{newfolder.deep.x} in text -> text first', JSON.stringify(addsOf(t)) === JSON.stringify(addTitles('newfolder.deep.x', ['text', 'int', 'float', 'bool'])), addsOf(t));
    t = titles(await actionsAt(uri, 13));
    check('no add for autoload member', !t.some(x => x.startsWith('Add the variable')), t);

    const projectUri = vscode.Uri.joinPath(root, 'project.godot');
    const readProject = () => fs.readFileSync(projectUri.fsPath, 'utf8').split('\r\n').join('\n');
    await apply(11, addTitles('chapte', ['float'])[0]);
    await sleep(300);
    check('chapte written as float and saved', /"answer": "",\n"chapte": 0\.0\n\}/.test(readProject()), readProject().slice(readProject().indexOf('variables')));
    await apply(18, addTitles('variable.nw', ['bool'])[0]);
    await sleep(300);
    check('variable.nw inside folder', /"Floating": 1\.0,\n"nw": false\n\}/.test(readProject()), readProject().slice(readProject().indexOf('variables')));
    await apply(19, addTitles('newfolder.deep.x', ['text'])[0]);
    await sleep(300);
    check('new nested folders', readProject().includes('"newfolder": {\n"deep": {\n"x": ""\n}\n}'), readProject().slice(readProject().indexOf('variables')));

    const laripoAction = (await actionsAt(uri, 20)).find(a => a.title === 'Add the character "Laripo" to project.godot, with a new Laripo.dch...');
    check('Laripo action carries its mood', laripoAction && laripoAction.command.arguments[0].mood === 'happy', laripoAction && laripoAction.command);
    await vscode.commands.executeCommand('dtlReader.addCharacter', { ...laripoAction.command.arguments[0], folder: 'res://characters' });
    await sleep(500);
    check('Laripo registered', readProject().includes('"Laripo": "res://characters/Laripo.dch"\n}'), readProject().slice(readProject().indexOf('dch_directory'), readProject().indexOf('dch_directory') + 400));
    const laripoPath = path.join(root.fsPath, 'characters', 'Laripo.dch');
    const laripo = fs.existsSync(laripoPath) ? fs.readFileSync(laripoPath, 'utf8').split('\r\n').join('\n') : '';
    check('Laripo.dch created with happy portrait', laripo.includes('&"display_name": "Laripo"') && laripo.includes('&"default_portrait": "happy"') && laripo.includes('&"happy": {'), laripo);
    await sleep(1500);
    const after = vscode.languages.getDiagnostics(uri).map(d => `${d.range.start.line}:${d.code}`);
    check('diagnostics gone for added things', !after.some(x => /^(11|18|19|20):/.test(x)), after);
  }
});
