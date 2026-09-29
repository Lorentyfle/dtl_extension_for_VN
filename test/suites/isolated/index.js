// Without project.godot, a timeline is on its own: only what can be known
// from the file itself is checked and suggested.

const vscode = require('vscode');
const { check, suite, open, sleep, waitFor } = require('../../harness');

const completionLabels = async (uri, position, trigger) => {
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, position, trigger);
  return list.items.filter(item => item.kind !== vscode.CompletionItemKind.Text).map(item => (typeof item.label === 'string' ? item.label : item.label.label));
};

exports.run = suite(async () => {
  const extension = vscode.extensions.all.find(candidate => candidate.id === 'lorentyfle.dtl-reader');
  await extension.activate();
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'timelines', 'alone.dtl');
  const document = await open(uri);
  await waitFor(() => vscode.languages.getDiagnostics(uri).length > 0);
  await sleep(1000);

  const codes = vscode.languages.getDiagnostics(uri).map(diagnostic => `${diagnostic.range.start.line}:${diagnostic.code}`).sort();
  check('checked: a missing label and an unclosed BBCode tag', codes.includes('3:unresolvedJump') && codes.includes('4:unclosedBBCode'), codes);
  check('not checked: characters and variables (nothing to check them against)', !codes.some(code => /unknown/.test(code)), codes);
  check('not checked: translations (they need the project\'s CSV)', !codes.some(code => /Translation/.test(code)), codes);

  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(8, 0), 'La');
  await vscode.workspace.applyEdit(edit);
  let labels = await completionLabels(uri, new vscode.Position(8, 2));
  check('completion: the characters the timeline already uses', labels.includes('Laripo') && !labels.includes('TestCharacter'), labels);
  const edit2 = new vscode.WorkspaceEdit();
  edit2.replace(uri, document.lineAt(8).range, 'Laripo (');
  await vscode.workspace.applyEdit(edit2);
  labels = await completionLabels(uri, new vscode.Position(8, 8), '(');
  check('completion: the moods the timeline already gives them', labels.includes('happy'), labels);
  const edit3 = new vscode.WorkspaceEdit();
  edit3.replace(uri, document.lineAt(8).range, 'jump ');
  await vscode.workspace.applyEdit(edit3);
  labels = await completionLabels(uri, new vscode.Position(8, 5), ' ');
  check('completion: the timeline\'s own labels after "jump "', labels.includes('start') && !labels.some(label => label.endsWith('/')), labels);

  const targets = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, new vscode.Position(7, 6)) || [];
  check('Ctrl+Click: a jump to its label', targets.length === 1 && (targets[0].targetRange || targets[0].range).start.line === 6, targets.length);
});
