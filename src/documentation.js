// -----------------------------------------------------------------------------
// Building the Markdown shown in hovers and suggestion details.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('./state');
const csvTranslations = require('./translation/translations');

// =============================================================================
// PROJECT.GODOT CACHE (characters + audio channels)
// =============================================================================

/**
 * Escape text for safe embedding inside SVG/XML markup (used when
 * rendering a character's display name as an inline SVG image).
 *
 * @param {string} text
 * @returns {string}
 */
function escapeXmlText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render `text` as a small inline SVG image, colored with `cssColor`, as
 * Markdown image syntax. VS Code's hover Markdown has no syntax of its own
 * for colored text, but does render inline images - an SVG data URI is the
 * standard workaround, used here to show a character's display name in
 * their declared `color` like a colored title.
 *
 * @param {string} text
 * @param {string} cssColor - e.g. "rgba(148, 99, 199, 1)"
 * @returns {string} Markdown image syntax
 */
function createColoredTitleMarkdown(text, cssColor) {
  const escaped = escapeXmlText(text);
  const width = Math.max(40, text.length * 9 + 10);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22">`
    + `<text x="0" y="16" font-family="sans-serif" font-size="15" font-weight="bold" fill="${cssColor}">${escaped}</text>`
    + `</svg>`;
  const base64 = Buffer.from(svg).toString('base64');
  return `![${escaped}](data:image/svg+xml;base64,${base64})`;
}

/**
 * Build the hover shown for a character name, from their `.dch`-declared
 * display_name/nicknames/description/color. The title uses display_name
 * if declared (falling back to however the name was written in the .dtl
 * file), colored via createColoredTitleMarkdown if a color was declared.
 *
 * @param {string} rawName - the name as written at the hovered position
 * @param {{displayName: string|null, nicknames: string[], description: string|null, color: string|null}} info
 * @returns {vscode.MarkdownString}
 */
function createCharacterDocumentation(rawName, info) {
  const markdown = new vscode.MarkdownString();
  const title = info.displayName || rawName;
  if (info.color) {
    markdown.appendMarkdown(createColoredTitleMarkdown(title, info.color) + '\n\n');
  } else {
    markdown.appendMarkdown(`**${title}**\n\n`);
  }
  if (info.nicknames.length > 0) {
    markdown.appendMarkdown(`_Also known as: ${info.nicknames.join(', ')}_\n\n`);
  }
  if (info.description) {
    markdown.appendMarkdown(info.description);
  }
  // Dialogic translates the name and nicknames with the keys
  // Character/<translation id>/name and .../nicknames (", "-separated).
  if (info.translationId) {
    const locales = state.cachedTranslationLocales.filter(locale => locale !== csvTranslations.getOriginalLocale());
    const rows = locales.map(locale => {
      const name = csvTranslations.getTranslation(`Character/${info.translationId}/name`, locale);
      const nicknames = csvTranslations.getTranslation(`Character/${info.translationId}/nicknames`, locale);
      return name || nicknames ? `| ${locale} | ${name || '_not translated_'} | ${nicknames || ''} |` : null;
    }).filter(Boolean);
    if (rows.length > 0) {
      markdown.appendMarkdown(`\n\n**Translations**\n\n| Locale | Name | Nicknames |\n|---|---|---|\n${rows.join('\n')}\n`);
    }
  }
  return markdown;
}

// =============================================================================
// MARKDOWN DOCUMENTATION HELPER
// =============================================================================

function createDocumentation(entry) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${entry.name}**\n\n`);
  markdown.appendMarkdown(`${entry.description}\n\n`);
  markdown.appendMarkdown(`**Syntax:** \`${entry.syntax}\`\n\n`);
  if (entry.variables && Object.keys(entry.variables).length > 0) {
    markdown.appendMarkdown('**Parameters:**\n\n');
    for (const [name, doc] of Object.entries(entry.variables)) {
      markdown.appendMarkdown(`- \`${name}\`: ${doc}\n`);
    }
    markdown.appendMarkdown('\n');
  }
  if (entry.example) {
    markdown.appendMarkdown('**Example:**\n\n');
    markdown.appendCodeblock(entry.example,'dtl');
  }
  if (entry.docsUrl) {
    markdown.appendMarkdown(`[${entry.docsLabel || 'Godot documentation'}](${entry.docsUrl})`);
  }
  return markdown;
}

// =============================================================================
// COMPLETION ITEM HELPERS
// =============================================================================

/**
 * Shorten an entry's description to its first sentence (at most ~60
 * characters, Markdown backticks and {placeholders} stripped), for use as
 * a completion label's `description`. VS Code shows that on the same row
 * as the suggestion itself, so what a command or BBCode tag does is
 * visible while scrolling the list - without having to open the details
 * side panel (Ctrl+Space), which still shows the full documentation.
 *
 * @param {string} description
 * @returns {string}
 */
function summarizeDescription(description) {
  const plain = description.replace(/`/g, '').replace(/\{(\w+)\}/g, '$1');
  const firstSentence = plain.match(/^.*?[.!?](?=\s|$)/);
  const summary = firstSentence ? firstSentence[0] : plain;
  return summary.length > 60 ? summary.slice(0, 57).trimEnd() + '...' : summary;
}

// =============================================================================
// LABEL / JUMP HELPERS
// =============================================================================

/**
 * Build the hover shown for a label, on either its `label NAME`
 * declaration or a `jump` pointing at it.
 *
 * @param {string} name
 * @param {DtlLabelInfo} labelInfo
 * @param {string|null} [timeline] - the timeline it belongs to, if not the hovered one
 * @returns {vscode.MarkdownString}
 */
function createLabelDocumentation(name, labelInfo, timeline) {
  const markdown = new vscode.MarkdownString();
  const where = timeline ? `${timeline}, line ${labelInfo.line + 1}` : `line ${labelInfo.line + 1}`;
  markdown.appendMarkdown(`**label ${name}**${labelInfo.displayName ? ` - ${labelInfo.displayName}` : ''} _(${where})_\n\n`);
  markdown.appendMarkdown(labelInfo.doc || '_No `##` comment above this label. Write one or more `## ...` lines right above it to document it._');
  return markdown;
}

Object.assign(module.exports, {
  createColoredTitleMarkdown,
  createCharacterDocumentation,
  createDocumentation,
  summarizeDescription,
  createLabelDocumentation,
});
