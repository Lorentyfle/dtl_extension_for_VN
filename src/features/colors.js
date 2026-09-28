// -----------------------------------------------------------------------------
// Color swatches and pickers, in .dch files and BBCode tags.
// -----------------------------------------------------------------------------
const vscode = require('vscode');

// =============================================================================
// DIALOGIC CHARACTER FILES (.dch)
// =============================================================================
// A .dch file is Godot's var_to_str() of inst_to_dict(DialogicCharacter):
// a GDScript-literal dictionary. These describe its keys, per nesting level,
// for autocomplete and hover. Taken from Dialogic's own DialogicCharacter
// resource (addons/dialogic/Resources/character.gd) and character editor.

/** Round a color component for writing it back (at most 3 decimals, no trailing zeros). */
const formatColorComponent = value => String(Math.round(value * 1000) / 1000);

/**
 * Color swatches (and the color picker) for a .dch file's
 * `Color(r, g, b[, a])` values, e.g. the character's name color.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.ColorInformation[]}
 */
function provideDchColors(document) {
  const text = document.getText();
  const pattern = /Color\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*)?\)/g;
  const colors = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [r, g, b, a] = match.slice(1).map(value => (value === undefined ? 1 : Math.min(1, Math.max(0, parseFloat(value)))));
    colors.push(new vscode.ColorInformation(new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length)), new vscode.Color(r, g, b, a)));
  }
  return colors;
}

/**
 * @param {vscode.Color} color
 * @returns {vscode.ColorPresentation[]}
 */
function provideDchColorPresentations(color) {
  const parts = [color.red, color.green, color.blue, color.alpha].map(formatColorComponent);
  return [new vscode.ColorPresentation(`Color(${parts.join(', ')})`)];
}

/**
 * Color swatches (and the picker) for the `#hex` colors of BBCode tags in a
 * timeline: `[color=#ff0000]`, `[bgcolor=...]`, `[outline_color=...]`,
 * `[pulse color=...]`, etc. Named colors (`red`) are left to the preview.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.ColorInformation[]}
 */
function provideTimelineColors(document) {
  const colors = [];
  const pattern = /\[[A-Za-z_]*(?:=|[^\]]*\bcolor=)(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4}))\b/g;
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    if (!text.includes('#')) { continue; }
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let hex = match[1].slice(1);
      if (hex.length <= 4) { hex = hex.split('').map(ch => ch + ch).join(''); }
      const [r, g, b, a] = [0, 2, 4, 6].map(i => (i < hex.length ? parseInt(hex.slice(i, i + 2), 16) / 255 : 1));
      const start = match.index + match[0].length - match[1].length;
      colors.push(new vscode.ColorInformation(new vscode.Range(line, start, line, start + match[1].length), new vscode.Color(r, g, b, a)));
    }
  }
  return colors;
}

/**
 * @param {vscode.Color} color
 * @returns {vscode.ColorPresentation[]}
 */
function provideTimelineColorPresentations(color) {
  const toHex = value => Math.round(value * 255).toString(16).padStart(2, '0');
  const hex = `#${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}${color.alpha < 1 ? toHex(color.alpha) : ''}`;
  return [new vscode.ColorPresentation(hex)];
}

Object.assign(module.exports, {
  provideDchColors,
  provideDchColorPresentations,
  provideTimelineColors,
  provideTimelineColorPresentations,
});
