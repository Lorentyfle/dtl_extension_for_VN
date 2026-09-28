// Adds to the copy of test-room: timelines/expr.dtl, one unfinished
// set/if/elif line per case (the suite asks for suggestions at the end of
// each line, by index).

const fs = require('fs');
const path = require('path');

const LINES = [
  'if ',                       // 0
  'elif ',                     // 1
  'set ',                      // 2
  'set {',                     // 3
  'set {Global.',              // 4
  'set {variable.test} = ',    // 5
  'if {chapter} == ',          // 6
  'if cha',                    // 7
  'set {variable.',            // 8
  'if {chapter} == 1 and ',    // 9
];

exports.LINES = LINES;
exports.prepare = root => {
  fs.writeFileSync(path.join(root, 'timelines', 'expr.dtl'), LINES.join('\n') + '\n');
};
