// A timeline on its own: the copy of test-room without its project.godot,
// plus a timeline with problems only it can know about.

const fs = require('fs');
const path = require('path');

const LINES = [
  'join Laripo left',                 // 0
  'Laripo (happy): Hello!',           // 1
  'Nobody: I am not a character',     // 2 unknown speaker - can't be checked without a project
  'jump nowhere',                     // 3 missing label - checked
  'Laripo: [b]unclosed',              // 4 unclosed BBCode - checked
  'set {secret} = 1',                 // 5 unknown variable - can't be checked
  'label start',                      // 6
  'jump start',                       // 7
  '',                                 // 8 (completion is asked here)
];

exports.LINES = LINES;
exports.prepare = root => {
  fs.rmSync(path.join(root, 'project.godot'));
  fs.writeFileSync(path.join(root, 'timelines', 'alone.dtl'), LINES.join('\n') + '\n');
};
