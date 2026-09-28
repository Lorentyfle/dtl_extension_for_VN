// -----------------------------------------------------------------------------
// Whole blocks suggested on an empty line (choice, if, loop...).
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const syntax = require('../timeline/syntax');
const sources = require('./sources');

// =============================================================================
// BLOCK SNIPPETS
// =============================================================================
// Ready-made blocks, suggested with the events at the start of a line (so
// never while writing dialogue): a choice, a condition, a loop, a small
// scene, a question. Character placeholders offer the project's characters.

/**
 * @returns {vscode.CompletionItem[]}
 */
function createBlockSnippets() {
  const names = sources.completionCharacterNames();
  const character = index => (names.length > 0
    ? `\${${index}|${names.map(name => syntax.formatCharacterName(name).replace(/[,|$}\\]/g, '\\$&')).join(',')}|}`
    : `\${${index}:Character}`);
  const blocks = [
    ['choice', 'Choice block', 'Two choices, each with what follows it.',
      `- \${1:First choice}\n\t${character(2)}: \${3:...}\n- \${4:Second choice}\n\t$2: \${5:...}`],
    ['if', 'Condition block (if / else)', 'Different events depending on a condition.',
      'if {${1:variable}} == ${2:true}\n\t${3}\nelse\n\t${0}'],
    ['if', 'Condition block (if / elif / else)', 'Three branches depending on conditions.',
      'if {${1:variable}} == ${2:1}\n\t${3}\nelif {$1} == ${4:2}\n\t${5}\nelse\n\t${0}'],
    ['loop', 'Loop (label + jump back)', 'Dialogic has no while: a loop is a label, and a condition jumping back to it.',
      'set {${1:counter}} = 0\nlabel ${2:loop_start}\n${3}\nset {$1} += 1\nif {$1} < ${4:3}\n\tjump $2'],
    ['scene', 'Scene (join, talk, leave)', 'A character comes in, says something and leaves.',
      `join ${character(1)} \${2|left,center,right|}\n$1: \${3:Hello!}\nleave $1`],
    ['text_input', 'Question (text input + condition)', 'Ask the player something, then react to the answer.',
      '[text_input text="${1:What is your name?}" var="${2:player_name}"]\nif {$2} == "${3}"\n\t${0}'],
  ];
  return blocks.map(([keyword, label, doc, body]) => {
    const item = new vscode.CompletionItem({ label: keyword, description: label }, vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString(body);
    item.documentation = new vscode.MarkdownString(doc).appendCodeblock(body.replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, '$1').replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{?\d+\}?/g, ''), 'dtl');
    item.sortText = `2_${keyword}_${label}`;
    return item;
  });
}

Object.assign(module.exports, {
  createBlockSnippets,
});
