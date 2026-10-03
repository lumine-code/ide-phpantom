const { Point } = require("lumine");
const { createProject, removeProject, position } = require("./helpers/project");
const serverPath = process.env.PHPANTOM_PATH || require("../lib/server").findOnPath("phpantom_lsp");
const liveSuite = serverPath ? describe : () => {};
const until = async (check, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};

liveSuite("ide-phpantom actual editor routing", () => {
  let fixture, editors, paths, service, timeout, published, subscription;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    editors = {};
    paths = lumine.project.getPaths();
    published = [];
    lumine.config.set("ide-phpantom.serverPath", serverPath);
    for (const name of ["language-php", "ide-client", "ide-phpantom"])
      await lumine.packages.activatePackage(name);
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
    subscription = service.onDidPublishDiagnostics((value) => published.push(value));
    lumine.project.setPaths([fixture.rootPath]);
    for (const key of ["main", "greeter", "named", "incomplete", "broken"]) {
      editors[key] = await lumine.workspace.open(fixture.files[key]);
      editors[key].setGrammar(lumine.grammars.grammarForScopeName("text.html.php"));
    }
  });
  afterEach(async () => {
    subscription.dispose();
    for (const editor of Object.values(editors)) editor?.destroy();
    for (const editor of lumine.workspace.getTextEditors())
      if (editor.getPath()?.startsWith(fixture.rootPath)) editor.destroy();
    for (const name of ["ide-phpantom", "ide-client", "language-php"])
      await lumine.packages.deactivatePackage(name);
    for (const key of [
      "serverPath",
      "features.format",
      "features.rename",
      "features.codeLens",
      "features.hover",
      "features.diagnostics",
    ])
      lumine.config.unset(`ide-phpantom.${key}`);
    lumine.project.setPaths(paths);
    await lumine.fileWatchClient.settlePendingTeardown();
    removeProject(fixture.rootPath);
  });
  const point = (key, fragment, inside = 1) => {
    const p = position(fixture.texts[key], fragment, inside);
    return new Point(p.line, p.character);
  };
  const sessionFor = () =>
    until(
      async () =>
        (await service.activeSessionsForEditor(editors.main)).find(
          ({ adapter }) => adapter.id === "ide-phpantom",
        ),
      "PHP session",
    );
  const ready = async () => {
    const session = await sessionFor();
    await until(
      () =>
        session.request("textDocument/hover", {
          textDocument: { uri: fixture.uris.main },
          position: position(fixture.texts.main, "greeting(", 2),
        }),
      "PHP project import",
    );
    return session;
  };
  const main = () => lumine.packages.getActivePackage("ide-client").mainModule;
  it("routes completion, hover, signature, symbols, references, hints, tokens and formatting", async () => {
    await ready();
    const m = main(),
      editor = editors.main;
    const suggestions = await m.provideAutocomplete().getSuggestions({
      editor,
      bufferPosition: point("main", "greeting(", 3),
      prefix: "gre",
      activatedManually: true,
    });
    expect(
      suggestions.some((item) =>
        (item.displayText || item.text || item.snippet || "").includes("greeting"),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(await m.provideHover().hover(editor, point("main", "greeting(", 2))),
    ).toContain("Build a greeting");
    expect(
      (await m.provideHoverSignature().getSignature(editor, point("main", "greeting(", 12)))
        .signatures[0].label,
    ).toContain("string $name");
    const refs = await m
      .provideFindReferences()
      .findReferences(editor, point("main", "greeting(", 2));
    for (const key of ["named", "greeter", "main"])
      expect(refs.references.some(({ path }) => path === fixture.files[key])).toBe(true);
    expect(
      (await m.provideSymbol().getSymbols({ type: "file", editor: editors.greeter })).some(
        ({ name }) => name === "greeting",
      ),
    ).toBe(true);
    expect(
      (await m.provideInlayHints().inlayHints(editor, [0, 3])).some(({ label }) =>
        label.includes("name:"),
      ),
    ).toBe(true);
    expect((await m.provideSemanticTokens().semanticTokens(editor)).length).toBeGreaterThan(0);
    expect((await m.provideCodeFormatFile().formatEntireFile(editor)).length).toBeGreaterThan(0);
  });
  it("renames all three contract files from both calls and concrete declarations", async () => {
    await ready();
    const refactor = main().provideRefactor();
    for (const origin of ["main", "greeter", "named"]) {
      const result = await refactor.rename(
        editors[origin],
        point(origin, "greeting(", 2),
        "welcome",
        { dryRun: true },
      );
      expect(result.outcome).toBe("edits");
      for (const key of ["named", "greeter", "main"])
        expect(
          result.edits.get(fixture.files[key])?.filter(({ newText }) => newText === "welcome")
            .length,
        ).toBe(1);
      const call = result.edits.get(fixture.files.main)[0];
      expect(Point.fromObject(call.oldRange.start || call.oldRange[0]).column).toBe(
        position(fixture.texts.main, "greeting(").character,
      );
    }
  });
  it("executes a prototype lens, applies an implementation action and honours feature gates", async () => {
    const session = await ready(),
      m = main();
    const lenses = await m.provideCodeLens().codeLenses(editors.greeter),
      prototype = lenses.find(({ title, execute }) => title.includes("Named") && execute);
    expect(prototype).toBeTruthy();
    await prototype.execute();
    await until(
      () => lumine.workspace.getActiveTextEditor()?.getPath() === fixture.files.named,
      "prototype lens opened interface",
    );
    const actions = await m
        .provideIntentionsList()
        .getIntentions({ textEditor: editors.incomplete, bufferPosition: new Point(2, 7) }),
      implement = actions.find(({ title }) => title.startsWith("Implement "));
    expect(implement).toBeTruthy();
    await implement.selected();
    expect(editors.incomplete.getText()).toContain(
      "public function greeting(string $name): string",
    );
    lumine.config.set("ide-phpantom.features.format", false);
    expect(await m.provideCodeFormatFile().formatEntireFile(editors.main)).toEqual([]);
    lumine.config.set("ide-phpantom.features.codeLens", false);
    expect(await m.provideCodeLens().codeLenses(editors.greeter)).toBeNull();
    const hiddenLensRename = await m
      .provideRefactor()
      .rename(editors.main, point("main", "greeting(", 2), "welcome", { dryRun: true });
    for (const key of ["named", "greeter", "main"])
      expect(
        hiddenLensRename.edits
          .get(fixture.files[key])
          ?.filter(({ newText }) => newText === "welcome").length,
      ).toBe(1);
    lumine.config.set("ide-phpantom.features.rename", false);
    expect(
      await m.provideRefactor().rename(editors.main, point("main", "greeting(", 2), "welcome"),
    ).toBeNull();
    lumine.config.set("ide-phpantom.features.hover", false);
    expect(await m.provideHover().hover(editors.main, point("main", "greeting(", 2))).toBeNull();
    expect(session.state).toBe("running");
  });
  it("publishes diagnostics, clears them after edits and replaces an unloaded generation", async () => {
    const previous = await ready();
    await until(
      () =>
        published.some(
          ({ uri, diagnostics }) =>
            uri === fixture.uris.broken &&
            diagnostics.some(({ message }) => message.includes("missingMember")),
        ),
      "PHP diagnostics through client",
    );
    const beforeChange = published.length;
    editors.broken.setText(fixture.texts.broken.replace("missingMember()", 'greeting("Ada")'));
    await until(
      () =>
        published
          .slice(beforeChange)
          .some(({ uri, diagnostics }) => uri === fixture.uris.broken && diagnostics.length === 0),
      "cleared PHP diagnostics",
    );
    const pkg = lumine.packages.getActivePackage("ide-phpantom"),
      oldMain = pkg.mainModule,
      packagePath = pkg.path;
    await lumine.packages.deactivatePackage("ide-phpantom");
    await until(() => previous.state === "stopped", "PHP teardown");
    expect(service.adaptersForEditor(editors.main)).toEqual([]);
    await lumine.packages.unloadPackage("ide-phpantom");
    await lumine.packages.loadPackage(packagePath);
    expect((await lumine.packages.activatePackage("ide-phpantom")).mainModule).not.toBe(oldMain);
    expect(await ready()).not.toBe(previous);
  });
});
