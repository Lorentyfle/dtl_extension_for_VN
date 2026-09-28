// -----------------------------------------------------------------------------
// Helpers for the test suites, which run inside VS Code (see run.js). Each
// result is written as soon as it's known, so a suite that hangs still
// reports how far it got.
// -----------------------------------------------------------------------------

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const resultsFile = process.env.DTL_TEST_RESULTS;
const lines = [];

function record(line) {
  lines.push(line);
  if (resultsFile) { fs.writeFileSync(resultsFile, lines.join('\n') + '\n'); }
}

/** Record a check: PASS, or FAIL with what was found instead. */
function check(name, condition, found) {
  record(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ' :: ' + JSON.stringify(found)}`);
}

/** Record a line of information (shown with DTL_TEST_VERBOSE=1). */
function info(text) {
  record(`INFO ${text}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wait until `condition()` is true (or `timeout` ms passed). */
async function waitFor(condition, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) { return true; }
    await sleep(200);
  }
  return false;
}

/**
 * Activate the extension, wait for the test project to be read, and give
 * the suite what it needs. The project is read once its script strings
 * include `readyString` - a string one of the suite's scripts contains - or
 * once any resource path is known.
 *
 * @param {string} [readyString]
 */
async function start(readyString) {
  const extension = vscode.extensions.all.find(candidate => candidate.id === 'lorentyfle.dtl-reader');
  await extension.activate();
  const internals = extension.exports.forTests;
  await waitFor(() => (readyString ? internals.scriptStrings().has(readyString) : internals.resourcePaths().length > 0));
  await sleep(1000);
  const root = vscode.workspace.workspaceFolders[0].uri;
  return { internals, root, at: (...parts) => vscode.Uri.joinPath(root, ...parts) };
}

/** Open a document in an editor. */
async function open(uri) {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  return document;
}

/** Run a suite body, recording an unexpected error as a failure. */
function suite(body) {
  return async function run() {
    try {
      await body();
    } catch (error) {
      record(`ERROR ${(error && error.stack) || error}`);
    }
  };
}

module.exports = { check, info, sleep, waitFor, start, open, suite, path, fs };
