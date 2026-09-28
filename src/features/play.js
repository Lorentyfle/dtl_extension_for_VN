// -----------------------------------------------------------------------------
// Playing a timeline in Godot, like Dialogic's own play buttons.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('../state');
const resources = require('../godot/resources');
const syntax = require('../timeline/syntax');
const project = require('../project');

// =============================================================================
// PLAY IN GODOT
// =============================================================================
// Plays a timeline the way Dialogic's own "Play timeline" button does: it
// writes the timeline in Dialogic's editor settings
// (`user://dialogic/editor_settings.cfg`, section [DES]:
// `current_timeline_path`, `play_from_index`), then runs Dialogic's test
// scene, which starts that timeline.

/**
 * The project's `user://` folder, as Godot computes it: `app_userdata/<name>`
 * in Godot's data folder, or `<custom name>` directly in the OS data folder
 * with `application/config/use_custom_user_dir`.
 *
 * @param {string} projectText - project.godot
 * @returns {string | null}
 */
function godotUserDataDir(projectText) {
  const os = require('os');
  const path = require('path');
  const application = (projectText.match(/(?:^|\n)\[application\]([\s\S]*?)(?:\n\[|$)/) || [])[1] || '';
  const setting = key => ((application.match(new RegExp(`(?:^|\\n)config/${key}\\s*=\\s*(.+)`)) || [])[1] || '').trim().replace(/^"|"$/g, '');
  const safe = name => name.replace(/[:/\\?*"|%<>]/g, '_');
  const name = safe(setting('name') || '[unnamed project]');
  const custom = setting('use_custom_user_dir') === 'true' ? safe(setting('custom_user_dir_name')) : '';
  let dataDir;
  if (process.platform === 'win32') { dataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); }
  else if (process.platform === 'darwin') { dataDir = path.join(os.homedir(), 'Library', 'Application Support'); }
  else { dataDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'); }
  if (custom) { return path.join(dataDir, custom); }
  return path.join(dataDir, process.platform === 'win32' || process.platform === 'darwin' ? 'Godot' : 'godot', 'app_userdata', name);
}

/**
 * The Godot executable: `dtlReader.godotPath`, else the godot-tools
 * extension's `godotTools.editorPath.godot4`, else `godot` on the PATH.
 *
 * @returns {string}
 */
function findGodotExecutable() {
  const own = vscode.workspace.getConfiguration('dtlReader').get('godotPath', '');
  if (own) { return own; }
  const godotTools = vscode.workspace.getConfiguration('godotTools').get('editorPath.godot4', '');
  return godotTools || 'godot';
}

/**
 * DTL: Play Timeline in Godot - save the timeline, point Dialogic's test
 * scene at it, and run the project's Godot on that scene. Godot's output
 * goes to the "DTL Reader: Godot" output channel.
 *
 * @param {vscode.Uri} [uri] - from the editor title button; else the active editor
 */
async function playTimelineCommand(uri) {
  const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
  if (!target) { return; }
  await playTimeline(await vscode.workspace.openTextDocument(target), -1);
}

/**
 * DTL: Play Timeline from This Line - like Dialogic's "Play from here":
 * the timeline starts at the event of the cursor's line, skipping the
 * events above it - to test a condition or a variable change without
 * replaying the whole timeline first.
 *
 * @param {vscode.Uri} [uri] - from a menu; else the active editor
 */
async function playTimelineFromLineCommand(uri) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || (uri && editor.document.uri.toString() !== uri.toString())) {
    vscode.window.showErrorMessage('Put the cursor on the line to play from, in the timeline.');
    return;
  }
  const line = editor.selection.active.line;
  const index = syntax.computeDialogicEventIndices(syntax.documentLines(editor.document))[line];
  await playTimeline(editor.document, index, line);
}

/**
 * Save a timeline, point Dialogic's test scene at it (from event
 * `fromIndex`, -1 for the start), and run the project's Godot on that scene.
 *
 * @param {vscode.TextDocument} document
 * @param {number} fromIndex
 * @param {number} [fromLine] - shown in the output
 */
async function playTimeline(document, fromIndex, fromLine) {
  if (document.languageId !== 'dtl') { vscode.window.showErrorMessage('Only a timeline (.dtl) can be played.'); return; }
  if (!state.projectRootUri) { vscode.window.showErrorMessage('Playing a timeline needs its Godot project: open the folder containing project.godot.'); return; }
  const resPath = project.toResPath(document.uri);
  if (!resPath) { vscode.window.showErrorMessage('This timeline is not inside the Godot project.'); return; }
  const scene = state.cachedResourcePaths.find(candidate => candidate.endsWith('/Editor/TimelineEditor/test_timeline_scene.tscn'));
  if (!scene) { vscode.window.showErrorMessage('Dialogic\'s test scene (addons/dialogic/Editor/TimelineEditor/test_timeline_scene.tscn) was not found - is Dialogic installed in this project?'); return; }
  if (document.isDirty) { await document.save(); }

  const fs = require('fs');
  const path = require('path');
  const projectText = Buffer.from(await vscode.workspace.fs.readFile(project.projectGodotUri())).toString('utf8');
  const userDir = godotUserDataDir(projectText);
  const settingsFile = path.join(userDir, 'dialogic', 'editor_settings.cfg');
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const current = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
    fs.writeFileSync(settingsFile, resources.setConfigFileValues(current, 'DES', { current_timeline_path: resources.godotString(resPath), play_from_index: String(fromIndex) }));
  } catch (error) {
    vscode.window.showErrorMessage(`Could not write Dialogic's editor settings (${settingsFile}): ${error.message}`);
    return;
  }

  if (!state.godotOutputChannel) { state.godotOutputChannel = vscode.window.createOutputChannel('DTL Reader: Godot'); }
  const executable = findGodotExecutable();
  const args = ['--path', state.projectRootUri.fsPath, scene];
  const from = fromIndex < 0 ? '' : `, from line ${fromLine + 1} (event ${fromIndex})`;
  state.godotOutputChannel.appendLine(`> ${executable} ${args.join(' ')}   (${resPath}${from})`);
  const child = require('child_process').spawn(executable, args, { cwd: state.projectRootUri.fsPath });
  child.stdout.on('data', data => state.godotOutputChannel.append(data.toString()));
  child.stderr.on('data', data => state.godotOutputChannel.append(data.toString()));
  child.on('exit', code => state.godotOutputChannel.appendLine(`> Godot exited (${code})`));
  child.on('error', async error => {
    state.godotOutputChannel.appendLine(`> ${error.message}`);
    const choice = await vscode.window.showErrorMessage(`Could not start Godot ("${executable}"). Set the path to your Godot 4 executable.`, 'Set Godot path');
    if (choice) { vscode.commands.executeCommand('workbench.action.openSettings', 'dtlReader.godotPath'); }
  });
}

Object.assign(module.exports, {
  godotUserDataDir,
  findGodotExecutable,
  playTimelineCommand,
  playTimelineFromLineCommand,
});
