// Adds to the copy of test-room: timelines with unreachable events, a
// script starting a timeline at a label, a custom event, a fake Dialogic
// test scene, and a user folder only these tests use (for Play in Godot).

const fs = require('fs');
const path = require('path');

const FLOW = [
  'label start',
  'if {chapter} == 1',
  '\tjump target',
  '[end_timeline]',
  'TestCharacter: never',
  'label dead_label',
  'TestCharacter: also dead',
  'label target',
  'TestCharacter: reached',
  '[end_timeline]',
  'label from_script',
  'TestCharacter: started from a script',
];

const DYNAMIC = [
  'jump {chapter}',
  'TestCharacter: dead code',
  'label maybe',
  'TestCharacter: a computed jump may lead here',
];

const CUSTOM = [
  '[screen_shake strength=2 wait=true]',
  '[scr',
  '[screen_shake ', // the trailing space matters: parameters are suggested after it
  '[screen_shake wait=',
  '[screen_shake mode=',
];

const STARTER = [
  'extends Node',
  '',
  'func _ready() -> void:',
  '\tDialogic.start("flow", "from_script")',
];

exports.prepare = root => {
  const at = (...parts) => path.join(root, ...parts);
  fs.mkdirSync(at('addons', 'dialogic', 'Editor', 'TimelineEditor'), { recursive: true });
  fs.writeFileSync(at('addons', 'dialogic', 'Editor', 'TimelineEditor', 'test_timeline_scene.tscn'), '');
  fs.writeFileSync(at('timelines', 'flow.dtl'), FLOW.join('\n') + '\n');
  fs.writeFileSync(at('timelines', 'dynamic.dtl'), DYNAMIC.join('\n') + '\n');
  fs.writeFileSync(at('timelines', 'custom.dtl'), CUSTOM.join('\n') + '\n');
  fs.writeFileSync(at('scripts', 'starter.gd'), STARTER.join('\n') + '\n');
  // The custom event is test-room's own (addons/dialogic_additions/ScreenShake/).

  let project = fs.readFileSync(at('project.godot'), 'utf8');
  const eol = project.includes('\r\n') ? '\r\n' : '\n';
  const replace = (from, to) => {
    if (!project.includes(from)) { throw new Error(`test-room/project.godot changed (no ${from}): update this fixture`); }
    project = project.replace(from, to);
  };
  const lastTimeline = '"chapter2": "res://timelines/chapter2.dtl"';
  replace(lastTimeline, [lastTimeline, '"flow": "res://timelines/flow.dtl"', '"dynamic": "res://timelines/dynamic.dtl"', '"custom": "res://timelines/custom.dtl"'].join(`,${eol}`));
  const name = 'config/name="DTL Reader Test Room"';
  replace(name, [name, 'config/use_custom_user_dir=true', 'config/custom_user_dir_name="dtl_reader_test_run"'].join(eol));
  fs.writeFileSync(at('project.godot'), project);
};
