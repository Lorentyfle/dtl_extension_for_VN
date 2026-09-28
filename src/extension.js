// -----------------------------------------------------------------------------
// DTL Reader: language support for Dialogic 2 timelines (.dtl) and
// characters (.dch). activate() registers every feature; the features
// themselves are in the other modules of src/.
// -----------------------------------------------------------------------------
const vscode = require('vscode');
const state = require('./state');
const resources = require('./godot/resources');
const syntax = require('./timeline/syntax');
const project = require('./project');
const dch = require('./dch/features');
const problems = require('./diagnostics/index');
const completion = require('./completion/index');
const quickFixes = require('./quick-fixes/index');
const addToProject = require('./quick-fixes/project-godot');
const csvTranslations = require('./translation/translations');
const translationView = require('./translation/view');
const hover = require('./features/hover');
const definition = require('./features/definition');
const workspaceSymbols = require('./features/workspace-symbols');
const outline = require('./features/outline');
const semanticTokens = require('./features/semantic-tokens');
const colors = require('./features/colors');
const bbcodePreview = require('./features/bbcode-preview');
const labelReferences = require('./features/label-references');
const glossaryFeature = require('./features/glossary');
const customEvents = require('./features/custom-events');
const play = require('./features/play');

// =============================================================================
// ACTIVATE
// =============================================================================

function activate(context) {
  state.bbcodeCharDecorationType = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(state.bbcodeCharDecorationType, { dispose: () => bbcodePreview.bbcodeDecorationTypes.forEach(type => type.dispose()) });
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => bbcodePreview.scheduleBbcodePreview()),
    vscode.workspace.onDidChangeTextDocument(event => bbcodePreview.scheduleBbcodePreview(event.document)),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dtlReader.preview')) { bbcodePreview.scheduleBbcodePreview(); } })
  );
  bbcodePreview.scheduleBbcodePreview();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('dtl', { provideHover: glossaryFeature.provideGlossaryHover }),
    vscode.languages.registerHoverProvider('dtl-translation', { provideHover: glossaryFeature.provideGlossaryHover }),
    { dispose: () => glossaryFeature.glossaryDecorationTypes.forEach(type => type.dispose()) }
  );
  // Glossary files are .tres resources - a change to one listed in
  // project.godot re-reads the project (which re-reads the glossaries).
  const glossaryWatcher = vscode.workspace.createFileSystemWatcher('**/*.tres');
  const onGlossaryFile = uri => {
    const resPath = state.projectRootUri ? 'res://' + project.normalizeFsPath(uri.fsPath).slice(project.normalizeFsPath(state.projectRootUri.fsPath).length).replace(/^\/+/, '') : '';
    if (state.cachedGlossaryEntries.some(entry => entry.file.toLowerCase() === resPath)) { project.refreshProjectGodotData(); }
  };
  glossaryWatcher.onDidChange(onGlossaryFile);
  glossaryWatcher.onDidCreate(onGlossaryFile);
  context.subscriptions.push(glossaryWatcher);
  state.translationViewMemento = context.workspaceState || null;
  // Created before the first project refresh, which already paints it.
  state.translationDecorationType = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(state.translationDecorationType);
  // ---------------------------------------------------------------------------
  // Initial character cache
  // ---------------------------------------------------------------------------
  project.refreshProjectGodotData();
  // ---------------------------------------------------------------------------
  // Watch project.godot
  // ---------------------------------------------------------------------------
  const watcher = vscode.workspace.createFileSystemWatcher('**/project.godot');
  watcher.onDidChange(project.refreshProjectGodotData);
  watcher.onDidCreate(project.refreshProjectGodotData);
  watcher.onDidDelete(project.refreshProjectGodotData);
  context.subscriptions.push(watcher);
  // Resource files only need a re-list on create/delete (a file's content
  // changing doesn't affect its res:// path), so change events are ignored
  // to avoid needless rescans while e.g. an image is being edited.
  const resourceWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  resourceWatcher.onDidCreate(project.refreshResourcePaths);
  resourceWatcher.onDidDelete(project.refreshResourcePaths);
  context.subscriptions.push(resourceWatcher);
  // .dch (character) and .tscn (LayeredPortrait scene) files feed the
  // (mood) and extra_data="set ..." autocomplete - a full project.godot
  // refresh is simple and cheap enough to just re-run on any of them
  // changing, rather than tracking per-character invalidation by hand.
  const moodWatcher = vscode.workspace.createFileSystemWatcher('**/*.{dch,tscn}');
  moodWatcher.onDidChange(project.refreshProjectGodotData);
  moodWatcher.onDidCreate(project.refreshProjectGodotData);
  moodWatcher.onDidDelete(project.refreshProjectGodotData);
  context.subscriptions.push(moodWatcher);
  // Autoload scripts (declared in project.godot's [autoload] section) feed
  // the do/if/elif Global.member autocomplete and hover - same
  // full-refresh-on-any-change approach as the .dch/.tscn watcher above
  // (which also covers autoload nodes, i.e. autoloads pointing at a scene).
  const scriptWatcher = vscode.workspace.createFileSystemWatcher('**/*.gd');
  scriptWatcher.onDidChange(project.refreshProjectGodotData);
  scriptWatcher.onDidCreate(project.refreshProjectGodotData);
  scriptWatcher.onDidDelete(project.refreshProjectGodotData);
  context.subscriptions.push(scriptWatcher);
  // Timelines feed cross-timeline `jump Timeline/label` - re-read their
  // labels when one changes on disk, then re-check every open timeline.
  const timelineWatcher = vscode.workspace.createFileSystemWatcher('**/*.dtl');
  const refreshTimelines = async () => { await project.refreshTimelineLabels(); problems.refreshAllDiagnostics(); };
  timelineWatcher.onDidChange(refreshTimelines);
  timelineWatcher.onDidCreate(refreshTimelines);
  timelineWatcher.onDidDelete(refreshTimelines);
  context.subscriptions.push(timelineWatcher);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('dtlReader.includeAddonAutoloads')) { project.refreshProjectGodotData(); }
      if (event.affectsConfiguration('dtlReader')) {
        problems.refreshAllDiagnostics();
        csvTranslations.updateAllTranslationDecorations();
      }
    })
  );
  // ---------------------------------------------------------------------------
  // Translations: Dialogic's CSV files, commands, inline view, quick fix
  // ---------------------------------------------------------------------------
  const csvWatcher = vscode.workspace.createFileSystemWatcher('**/dialogic_*.csv');
  const refreshCsv = async () => { await csvTranslations.refreshTranslations(); problems.refreshAllDiagnostics(); };
  csvWatcher.onDidChange(refreshCsv);
  csvWatcher.onDidCreate(refreshCsv);
  csvWatcher.onDidDelete(refreshCsv);
  context.subscriptions.push(
    csvWatcher,
    vscode.commands.registerCommand('dtlReader.translateLine', csvTranslations.translateLineCommand),
    vscode.commands.registerCommand('dtlReader.nextUntranslated', csvTranslations.nextUntranslatedCommand),
    vscode.commands.registerCommand('dtlReader.selectTranslationLanguage', csvTranslations.selectTranslationLanguage),
    vscode.commands.registerCommand('dtlReader.openTranslationView', translationView.openTranslationViewCommand),
    vscode.window.onDidChangeActiveTextEditor(translationView.updateTranslationGlobeContext),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dtlReader.translation.globeButton')) { translationView.updateTranslationGlobeContext(); } }),
    vscode.commands.registerCommand('dtlReader.changeTranslationViewLanguages', translationView.changeTranslationViewLanguagesCommand),
    vscode.workspace.registerFileSystemProvider(translationView.TRANSLATION_VIEW_SCHEME, state.translationViewFileSystem = new translationView.TranslationViewFileSystem()),
    vscode.window.onDidChangeTextEditorSelection(translationView.syncTranslationScroll),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (!state.translationViewFileSystem) { return; }
      if (document.languageId === 'dtl') { state.translationViewFileSystem.refresh(document.uri); }
      else if (document.languageId === 'dch' || /\.tres$/i.test(document.uri.fsPath || '')) { state.translationViewFileSystem.refresh(); }
    }),
    vscode.languages.registerHoverProvider('dtl', { provideHover: csvTranslations.provideTranslationHover }),
    vscode.languages.registerCodeActionsProvider('dtl', { provideCodeActions: csvTranslations.provideTranslationCodeActions }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.window.onDidChangeVisibleTextEditors(csvTranslations.updateAllTranslationDecorations),
    vscode.workspace.onDidChangeTextDocument(event => {
      vscode.window.visibleTextEditors.filter(editor => editor.document === event.document).forEach(csvTranslations.updateTranslationDecorations);
    })
  );
  context.subscriptions.push(vscode.languages.registerHoverProvider('dtl', { provideHover: hover.provideTimelineHover }));
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('dch', { provideCompletionItems: dch.provideDchCompletions }, '"', ':', ' ', '/', '&'),
    vscode.languages.registerHoverProvider('dch', { provideHover: dch.provideDchHover }),
    vscode.languages.registerColorProvider('dch', { provideDocumentColors: colors.provideDchColors, provideColorPresentations: colors.provideDchColorPresentations }),
    vscode.languages.registerColorProvider('dtl', { provideDocumentColors: colors.provideTimelineColors, provideColorPresentations: colors.provideTimelineColorPresentations })
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider('dtl', { provideDocumentSymbols: outline.provideTimelineOutline }, { label: 'DTL' })
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider('dtl', { provideDocumentSemanticTokens: semanticTokens.provideAutoloadSemanticTokens }, semanticTokens.SEMANTIC_TOKENS_LEGEND)
  );
  // ===========================================================================
  // GO TO DEFINITION, QUICK FIXES AND WORKSPACE SYMBOLS
  // ===========================================================================
  const quickFixMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('dtl', { provideDefinition: definition.provideTimelineDefinition }),
    vscode.languages.registerDefinitionProvider('dch', { provideDefinition: definition.provideDchDefinition }),
    vscode.languages.registerCodeActionsProvider('dtl', { provideCodeActions: quickFixes.provideDiagnosticCodeActions }, quickFixMetadata),
    vscode.languages.registerCodeActionsProvider('dch', { provideCodeActions: quickFixes.provideDiagnosticCodeActions }, quickFixMetadata),
    vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: workspaceSymbols.provideWorkspaceSymbols }),
    vscode.commands.registerCommand('dtlReader.saveAndRefresh', addToProject.saveAndRefreshCommand),
    vscode.commands.registerCommand('dtlReader.addCharacter', addToProject.addCharacterCommand),
    vscode.commands.registerCommand('dtlReader.playTimeline', play.playTimelineCommand),
    vscode.commands.registerCommand('dtlReader.playTimelineFromLine', play.playTimelineFromLineCommand),
    { dispose: () => { if (state.godotOutputChannel) { state.godotOutputChannel.dispose(); } } }
  );
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider('dtl', { provideReferences: labelReferences.provideLabelReferences }),
    vscode.languages.registerRenameProvider('dtl', labelReferences.labelRenameProvider),
    vscode.languages.registerCodeLensProvider('dtl', { provideCodeLenses: labelReferences.provideLabelCodeLenses })
  );
  // ===========================================================================
  // DIAGNOSTICS (unresolved `jump` targets, unclosed BBCode-style balises)
  // ===========================================================================
  state.diagnosticCollection = vscode.languages.createDiagnosticCollection('dtl');
  context.subscriptions.push(state.diagnosticCollection);
  vscode.workspace.textDocuments.forEach(problems.updateDiagnostics);
  context.subscriptions.push(
    // A timeline opened (or closed) changes what the others jump to and
    // use - even one not registered yet - so all of them are re-checked.
    vscode.workspace.onDidOpenTextDocument(document => (document.languageId === 'dtl' ? problems.refreshAllDiagnostics() : problems.updateDiagnostics(document)))
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'dtl') { problems.refreshAllDiagnostics(); }
      if (event.document.languageId === 'dch') { problems.updateDiagnostics(event.document); }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.languageId === 'dtl') { problems.refreshAllDiagnostics(); }
      state.diagnosticCollection.delete(document.uri); // after: the re-check mustn't bring it back
    })
  );
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('dtl', { provideCompletionItems: completion.provideTimelineCompletions },
    ' ', '[', '=', '(', '/', '"', "'", '{', '.'));
  // Internals the test suite checks directly (`extension.exports`) - not an
  // API for other extensions.
  return { forTests: { rankCharacterFolders: addToProject.rankCharacterFolders, godotUserDataDir: play.godotUserDataDir, setConfigFileValues: resources.setConfigFileValues, parseCustomEventScript: customEvents.parseCustomEventScript, findGodotExecutable: play.findGodotExecutable, computeDialogicEventIndices: syntax.computeDialogicEventIndices, translationViewUri: translationView.translationViewUri, scriptStrings: () => state.cachedScriptStrings, resourcePaths: () => state.cachedResourcePaths } };
}

// =============================================================================
// DEACTIVATE
// =============================================================================

function deactivate() {}

Object.assign(module.exports, {
  activate,
  deactivate,
});
