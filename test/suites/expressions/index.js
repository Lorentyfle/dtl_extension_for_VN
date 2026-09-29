const vscode = require('vscode');
const { check, info, suite, start, open } = require('../../harness');
const { LINES: EXPR } = require('./fixture');
const label = item => (typeof item.label === 'string' ? item.label : item.label.label);

exports.run = suite(async () => {
  {
    const { at: file } = await start();
    const uri = file('timelines', 'expr.dtl');
    await open(uri);
    // Only our own provider's items (VS Code adds word-based ones otherwise).
    const at = async (line, trigger) => {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(line, EXPR[line].length), trigger);
      return list.items.filter(item => item.kind !== vscode.CompletionItemKind.Text).map(item => ({ label: label(item), insert: item.insertText && (item.insertText.value || item.insertText) }));
    };
    const labels = async (line, trigger) => (await at(line, trigger)).map(item => item.label).sort();

    const condition = ['Global', 'SoundManager', 'false', 'not', 'true', '{}'].sort();
    let got = await labels(0, ' ');
    check('if -> true, false, not, classes, {}', JSON.stringify(got) === JSON.stringify(condition), got);
    got = await labels(1, ' ');
    check('elif -> true, false, not, classes, {}', JSON.stringify(got) === JSON.stringify(condition), got);
    got = await labels(2, ' ');
    check('set -> classes, {}', JSON.stringify(got) === JSON.stringify(['Global', 'SoundManager', '{}'].sort()), got);
    const setItems = await at(2, ' ');
    check('set: class inserted as {Class.', setItems.find(i => i.label === 'Global').insert === '{Global.$0}', setItems);
    check('set: {} inserted with the cursor inside', setItems.find(i => i.label === '{}').insert === '{$0}', setItems);
    got = await labels(3, '{');
    check('set { -> variable folders and autoloads', ['variable', 'Mamamya', 'chapter', 'Global'].every(name => got.some(l => l.startsWith(name))), got);
    const inBraces = await at(3, '{');
    check('set { -> a folder inserts its dot', inBraces.find(i => i.label === 'variable').insert === 'variable.', inBraces);
    check('set { -> a variable inserts no dot', !String(inBraces.find(i => i.label === 'chapter').insert || 'chapter').endsWith('.'), inBraces);
    check('set { -> an autoload inserts its dot', inBraces.find(i => i.label === 'Global').insert === 'Global.$0', inBraces);
    got = await labels(4, '.');
    check('set {Global. -> its members', got.some(l => l.startsWith('hearts')) && got.some(l => l.startsWith('state')), got);
    got = await labels(8, '.');
    check('set {variable. -> the folder\'s variables', ['test', 'Ttttt', 'Floating'].every(name => got.some(l => l.startsWith(name))), got);
    got = await labels(5, ' ');
    check('set value: no list of every variable', !got.some(l => /^\{.+\}$/.test(l)) && got.includes('{}'), got);
    info('set value suggestions: ' + JSON.stringify(got));
    got = await labels(6, ' ');
    check('if {x} == -> true, false, not, classes, {}', JSON.stringify(got) === JSON.stringify(condition), got);
    got = await labels(9, ' ');
    check('if ... and -> true, false, not, classes, {}', JSON.stringify(got) === JSON.stringify(condition), got);
    const typed = await at(7);
    check('if cha -> {} wraps what was typed', typed.some(i => i.label === '{}' && i.insert === '{cha$0}'), typed);
  }
});
