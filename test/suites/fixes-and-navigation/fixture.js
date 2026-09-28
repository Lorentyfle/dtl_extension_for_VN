// Adds to the copy of test-room: a timeline full of problems to fix
// (timelines/qf.dtl - the suite relies on its line numbers), and characters
// in other folders, to rank where a new character goes.

const fs = require('fs');
const path = require('path');

const PROBLEMS = [
  'label start',                               // 0
  'jump strat',                                // 1 misspelled label
  'jump missing_one',                          // 2 missing label
  'jump chapter2/nowhere',                     // 3 missing label in another timeline
  'jump chaptr2/',                             // 4 misspelled timeline
  'jump start #id:abc',                        // 5 translation id on a jump
  'join TestCharactr left',                    // 6 misspelled character
  'TestCharacter (Defualt): Hi',               // 7 misspelled mood
  'TestCharacter: Hi [portrait=Defaul]',       // 8 misspelled portrait
  'TestCharacter: [b]bold text #id:x1',        // 9 unclosed [b]
  '- Choice [i]x | [if {chapter} == 1]',       // 10 unclosed [i] in a choice
  'set {chapte} = 2',                          // 11 misspelled variable
  '"John Smith": hello',                       // 12 quoted character
  'TestCharacter: {Global.hearts}',            // 13 autoload variable
  'do Global.apply_tint()',                    // 14 autoload function
  'if Global.state == Global.State.TALKING',   // 15 autoload enum value
  '[background arg="res://assets/bg.png"]',    // 16 res:// path
  'TestCharacter (LayeredPortrait): ok',       // 17 existing mood
  'if {variable.nw} == true',                  // 18 new variable in a folder (bool)
  'TestCharacter: {newfolder.deep.x}',         // 19 new variable in new folders
  'Laripo (happy): hello',                     // 20 new character with a mood
  'Orphan: hi',                                // 21 character with an unregistered .dch
];

exports.prepare = root => {
  const at = (...parts) => path.join(root, ...parts);
  fs.writeFileSync(at('timelines', 'qf.dtl'), PROBLEMS.join('\n') + '\n');
  for (const folder of [['cast', 'side'], ['cast', 'chapter2'], ['timelines', 'other'], ['timelines', 'chapter2']]) {
    fs.mkdirSync(at(...folder), { recursive: true });
  }
  const character = fs.readFileSync(at('characters', 'TestCharacter2.dch'));
  fs.writeFileSync(at('cast', 'side', 'Sider.dch'), character);
  fs.writeFileSync(at('cast', 'chapter2', 'Chap.dch'), character);
  fs.writeFileSync(at('characters', 'Orphan.dch'), character); // not registered
  fs.writeFileSync(at('timelines', 'other', 'o.dtl'), 'Sider: hi\nNewcomer: yo\n');
  fs.writeFileSync(at('timelines', 'chapter2', 'c.dtl'), 'Sider: hi\nNewbie2: yo\n');
  const project = fs.readFileSync(at('project.godot'), 'utf8');
  const eol = project.includes('\r\n') ? '\r\n' : '\n';
  const last = '"John Smith": "res://characters/JohnSmith.dch"';
  if (!project.includes(last)) { throw new Error('test-room/project.godot changed: update this fixture'); }
  fs.writeFileSync(at('project.godot'), project.replace(last,
    `${last},${eol}"Sider": "res://cast/side/Sider.dch",${eol}"Chap": "res://cast/chapter2/Chap.dch"`));
};
