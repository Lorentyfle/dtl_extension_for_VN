#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Runs the test suites of test/suites/, each in its own VS Code window, on its
// own copy of test-room/ (so the tests never change test-room itself).
//
//   node test/run.js [suite ...]
//
// Without Node installed, VS Code's own can run it (Windows, Git Bash):
//   ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" test/run.js
//
// VS Code is taken from the VSCODE_PATH environment variable, else downloaded
// with @vscode/test-electron when it's installed (as in CI), else the usual
// install location. Each suite is a folder with:
//   fixture.js - optional, `prepare(root)` adds its files to the copy of test-room
//   index.js   - runs inside VS Code (see harness.js), with the extension loaded
// Exits with 1 if any check failed.
// -----------------------------------------------------------------------------

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const suitesDir = path.join(__dirname, 'suites');

/** The VS Code executable to test with. */
async function findVsCode() {
  if (process.env.VSCODE_PATH) { return process.env.VSCODE_PATH; }
  try {
    const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
    return await downloadAndUnzipVSCode('stable');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
  }
  const candidates = {
    win32: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'), 'C:\\Program Files\\Microsoft VS Code\\Code.exe'],
    darwin: ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron'],
    linux: ['/usr/share/code/code', '/usr/bin/code'],
  }[process.platform] || [];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) { throw new Error('VS Code not found - set VSCODE_PATH to its executable.'); }
  return found;
}

/** Run one suite; returns its result lines. */
function runSuite(vscodePath, name, temp) {
  const suiteDir = path.join(suitesDir, name);
  const workspace = path.join(temp, name, 'room');
  fs.cpSync(path.join(repo, 'test-room'), workspace, { recursive: true });
  const fixture = path.join(suiteDir, 'fixture.js');
  if (fs.existsSync(fixture)) { require(fixture).prepare(workspace); }
  const results = path.join(temp, name, 'results.txt');
  const env = { ...process.env, DTL_TEST_RESULTS: results };
  delete env.ELECTRON_RUN_AS_NODE; // this script may itself run on VS Code's Node
  const args = [
    `--user-data-dir=${path.join(temp, 'user-data')}`,
    `--extensions-dir=${path.join(temp, 'extensions')}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--extensionDevelopmentPath=${repo}`,
    `--extensionTestsPath=${path.join(suiteDir, 'index.js')}`,
    workspace,
  ];
  if (process.platform === 'linux') { args.unshift('--no-sandbox', '--disable-gpu'); }
  const run = spawnSync(vscodePath, args, { env, stdio: 'ignore', timeout: 5 * 60 * 1000 });
  const lines = fs.existsSync(results) ? fs.readFileSync(results, 'utf8').split('\n').filter(Boolean) : [];
  if (run.error || run.signal) {
    // Timed out or killed: the checks after the last one written never ran.
    lines.push(`ERROR the suite didn't finish (${run.error ? run.error.message : run.signal}) - it stopped after "${(lines[lines.length - 1] || 'nothing').slice(0, 80)}"`);
  } else if (lines.length === 0) {
    lines.push(`ERROR the suite wrote no results (VS Code exit code ${run.status})`);
  }
  return lines;
}

async function main() {
  const wanted = process.argv.slice(2);
  const suites = fs.readdirSync(suitesDir).filter(name => fs.existsSync(path.join(suitesDir, name, 'index.js')) && (wanted.length === 0 || wanted.includes(name)));
  const vscodePath = await findVsCode();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtl-reader-tests-'));
  let failed = 0;
  let passed = 0;
  try {
    for (const name of suites) {
      const lines = runSuite(vscodePath, name, temp);
      const bad = lines.filter(line => /^(FAIL|ERROR)/.test(line));
      const good = lines.filter(line => line.startsWith('PASS'));
      passed += good.length;
      failed += bad.length;
      console.log(`${bad.length === 0 ? 'ok  ' : 'FAIL'} ${name}: ${good.length} passed, ${bad.length} failed`);
      for (const line of bad) { console.log(`       ${line}`); }
      if (process.env.DTL_TEST_VERBOSE) { for (const line of lines) { console.log(`       ${line}`); } }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
