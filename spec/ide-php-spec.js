const fs = require("node:fs");
const path = require("node:path");
const { createProject, removeProject } = require("./helpers/project");

describe("ide-php executable discovery and managed installs", () => {
  let fixture, server;
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    await lumine.packages.activatePackage("ide-php");
    server = require("../lib/server");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-php");
    removeProject(fixture.rootPath);
  });
  it("prefers an explicit executable over a managed copy and PATH", async () => {
    spyOn(server, "probeServer").and.resolveTo("0.10.0");
    const launch = await server.resolveServer(process.execPath, {
      binaryPath: path.join(fixture.rootPath, "missing"),
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["--stdio"]);
    expect(launch.version).toBe("0.10.0");
  });
  it("launches a managed executable before consulting PATH", async () => {
    spyOn(server, "probeServer").and.resolveTo("0.10.0");
    spyOn(server, "findOnPath").and.returnValue(null);
    expect((await server.resolveServer("", { binaryPath: process.execPath })).command).toBe(
      process.execPath,
    );
    expect(server.findOnPath).not.toHaveBeenCalled();
  });
  it("finds a native PATH executable while skipping directories and shell wrappers", () => {
    const name = path.basename(process.execPath, path.extname(process.execPath));
    expect(server.findOnPath(name, { PATH: path.dirname(process.execPath) })).toBeTruthy();
    fs.mkdirSync(path.join(fixture.rootPath, "phpantom_lsp"));
    fs.writeFileSync(path.join(fixture.rootPath, "phpantom_lsp.cmd"), "wrapper");
    expect(server.findOnPath("phpantom_lsp", { PATH: fixture.rootPath }, "win32")).toBeNull();
  });
  it("refuses missing paths and directories before launching", async () => {
    await expectAsync(server.resolveServer(path.join(fixture.rootPath, "missing"))).toBeRejected();
    await expectAsync(server.resolveServer(fixture.rootPath)).toBeRejectedWithError(
      /executable file/,
    );
  });
  it("returns null when no executable is installed", async () => {
    spyOn(server, "findOnPath").and.returnValue(null);
    expect(await server.resolveServer()).toBeNull();
  });
  it("uses exact official archive names for every supported platform", () => {
    for (const [platform, arch, target] of [
      ["win32", "x64", "x86_64-pc-windows-msvc"],
      ["win32", "arm64", "aarch64-pc-windows-msvc"],
      ["darwin", "x64", "x86_64-apple-darwin"],
      ["darwin", "arm64", "aarch64-apple-darwin"],
      ["linux", "x64", "x86_64-unknown-linux-gnu"],
      ["linux", "arm64", "aarch64-unknown-linux-gnu"],
    ])
      expect(server.assetFor({ platform, arch })).toBe(
        `phpantom_lsp-${target}.${platform === "win32" ? "zip" : "tar.gz"}`,
      );
    expect(server.assetFor({ platform: "linux", arch: "arm" })).toBeNull();
  });
  it("passes the published SHA256 to extraction and makes the native file executable", async () => {
    const target = { platform: "linux", arch: "x64" },
      digest = `sha256:${"a".repeat(64)}`;
    const api = {
      githubReleaseByTag: jasmine.createSpy("release").and.resolveTo({
        version: "0.10.0",
        assets: [
          { name: server.assetFor(target), url: "https://example.com/server.tar.gz", digest },
        ],
      }),
      downloadFile: jasmine
        .createSpy("download")
        .and.callFake(async (_url, directory) =>
          fs.writeFileSync(path.join(directory, "phpantom_lsp"), "server"),
        ),
      makeFileExecutable: jasmine.createSpy("chmod").and.resolveTo(),
      setServerInstallationStatus() {},
    };
    const installed = await server.installServer(
      { storagePath: fixture.rootPath, version: "0.10.0", api },
      target,
    );
    expect(api.githubReleaseByTag).toHaveBeenCalledWith("PHPantom-dev/phpantom_lsp", "0.10.0");
    expect(api.downloadFile.calls.mostRecent().args[2]).toEqual({ type: "gzip-tar", digest });
    expect(api.makeFileExecutable).toHaveBeenCalledWith(
      path.join(fixture.rootPath, "phpantom_lsp"),
    );
    expect(installed).toEqual({ version: "0.10.0", binary: "phpantom_lsp" });
  });
  it("refuses unsupported platforms, absent assets and missing digests before downloading", async () => {
    const api = {
      latestGithubRelease: async () => ({ version: "0.10.0", assets: [] }),
      downloadFile: jasmine.createSpy("download"),
      setServerInstallationStatus() {},
    };
    await expectAsync(
      server.installServer(
        { storagePath: fixture.rootPath, api },
        { platform: "linux", arch: "arm" },
      ),
    ).toBeRejectedWithError(/no managed build/);
    await expectAsync(
      server.installServer(
        { storagePath: fixture.rootPath, api },
        { platform: "linux", arch: "x64" },
      ),
    ).toBeRejectedWithError(/no phpantom/);
    api.latestGithubRelease = async () => ({
      version: "0.10.0",
      assets: [
        {
          name: server.assetFor({ platform: "linux", arch: "x64" }),
          url: "https://example.com/server",
        },
      ],
    });
    await expectAsync(
      server.installServer(
        { storagePath: fixture.rootPath, api },
        { platform: "linux", arch: "x64" },
      ),
    ).toBeRejectedWithError(/SHA-256/);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });
});

describe("ide-php service lifecycle", () => {
  let main, adapter, edge, cleanup;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-php")).mainModule;
    cleanup = jasmine.createSpy("cleanup");
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: cleanup };
      },
    });
  });
  afterEach(async () => {
    edge.dispose();
    lumine.config.unset("ide-php.serverPath");
    await lumine.packages.deactivatePackage("ide-php");
  });
  it("serves PHP and mixed PHP grammars through one project-root adapter", () => {
    expect(adapter.grammarScopes).toEqual(["text.html.php", "source.php"]);
    expect(adapter.languageId).toBe("php");
    expect(adapter.sessionScope).toBe("project-root");
    expect(adapter.restartKeyPaths).toEqual(["ide-php.serverPath"]);
  });
  it("returns cleanup for its exact consumed-service edge", () => {
    edge.dispose();
    expect(cleanup).toHaveBeenCalled();
  });
  it("keeps independent provider edges independent", () => {
    const secondCleanup = jasmine.createSpy("secondCleanup"),
      second = main.consumeIdeClient({
        registerAdapter() {
          return { dispose: secondCleanup };
        },
      });
    edge.dispose();
    expect(secondCleanup).not.toHaveBeenCalled();
    second.dispose();
    expect(secondCleanup).toHaveBeenCalled();
  });
  it("reacquires the module generation after unload", async () => {
    const packagePath = lumine.packages.getActivePackage("ide-php").path;
    await lumine.packages.deactivatePackage("ide-php");
    await lumine.packages.unloadPackage("ide-php");
    await lumine.packages.loadPackage(packagePath);
    const current = (await lumine.packages.activatePackage("ide-php")).mainModule;
    expect(current).not.toBe(main);
    expect(current.provideBackgroundTips().packageName).toBe("ide-php");
  });
  it("leaves composer and project server settings authoritative", () => {
    expect(adapter.getSettings).toBeUndefined();
    expect(adapter.getInitializationOptions).toBeUndefined();
    expect(
      require("../package.json").configSchema.features.properties.callHierarchy,
    ).toBeUndefined();
    expect(main.provideBackgroundTips().tips.length).toBe(1);
  });
  it("reports a missing server through the shared client", async () => {
    spyOn(require("../lib/server"), "resolveServer").and.resolveTo(null);
    let value;
    const missing = jasmine.createSpy("missing"),
      registration = main.consumeIdeClient({
        registerAdapter(v) {
          value = v;
          return { dispose() {} };
        },
        reportMissingServer: missing,
      });
    try {
      expect(await value.resolveServer({ rootPath: "/project" })).toBeNull();
      expect(missing.calls.mostRecent().args[0]).toBe("ide-php");
    } finally {
      registration.dispose();
    }
  });
});

describe("ide-php canonical rename targets", () => {
  let fixture, adapter, edge;
  beforeEach(async () => {
    fixture = createProject();
    const main = (await lumine.packages.activatePackage("ide-php")).mainModule;
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
    });
  });
  afterEach(async () => {
    edge.dispose();
    await lumine.packages.deactivatePackage("ide-php");
    removeProject(fixture.rootPath);
  });
  const session = (version, request) => ({
    rootPath: fixture.rootPath,
    serverInfo: { version },
    launch: { version },
    canExecuteCommand: (command) => command === "phpantom.navigateToPrototype",
    request,
  });
  const protocol = (prototypeUri, title = "localized prototype label") => {
    const type = (key) => ({
      name: key === "greeter" ? "Greeter" : "Named",
      kind: key === "greeter" ? 5 : 11,
      uri: fixture.uris[key],
      selectionRange: {
        start: { line: 2, character: key === "greeter" ? 6 : 10 },
        end: { line: 2, character: key === "greeter" ? 13 : 15 },
      },
    });
    return async (method, params) => {
      const key =
        params.textDocument?.uri === fixture.uris.greeter
          ? "greeter"
          : params.textDocument?.uri === fixture.uris.named
            ? "named"
            : null;
      if (method === "textDocument/documentSymbol")
        return key
          ? [
              {
                ...type(key),
                range: {
                  start: { line: 2, character: 0 },
                  end: { line: key === "greeter" ? 5 : 2, character: key === "greeter" ? 1 : 66 },
                },
                children: [
                  {
                    name: "greeting",
                    kind: 6,
                    selectionRange: {
                      start: {
                        line: key === "greeter" ? 4 : 2,
                        character: key === "greeter" ? 16 : 34,
                      },
                      end: {
                        line: key === "greeter" ? 4 : 2,
                        character: key === "greeter" ? 24 : 42,
                      },
                    },
                  },
                ],
              },
            ]
          : [];
      if (method === "textDocument/prepareTypeHierarchy") return [type(key)];
      if (method === "typeHierarchy/supertypes")
        return params.item.uri === fixture.uris.greeter ? [type("named")] : [];
      if (method === "typeHierarchy/subtypes")
        return params.item.uri === fixture.uris.named ? [type("greeter")] : [];
      if (method === "textDocument/codeLens")
        return key === "greeter"
          ? [
              {
                range: { start: { line: 4, character: 0 } },
                command: {
                  title,
                  command: "phpantom.navigateToPrototype",
                  arguments: [prototypeUri, { line: 2, character: 34 }],
                },
              },
            ]
          : null;
      if (method === "textDocument/definition")
        return { uri: fixture.uris.greeter, range: { start: { line: 4, character: 16 } } };
      throw new Error(`Unexpected protocol request ${method}`);
    };
  };
  it("leaves other versions untouched without querying a prototype", async () => {
    const request = jasmine.createSpy("request");
    expect(
      await adapter.resolveRenameTarget(
        { uri: fixture.uris.main, position: { line: 3, character: 34 } },
        { session: session("0.11.0", request) },
      ),
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
  it("follows the protocol command arguments independently of a lens's human label", async () => {
    const request = protocol(fixture.uris.named);
    expect(
      await adapter.resolveRenameTarget(
        { uri: fixture.uris.main, position: { line: 3, character: 34 } },
        { session: session("0.10.0", request) },
      ),
    ).toEqual({ uri: fixture.uris.named, position: { line: 2, character: 34 } });
  });
  it("refuses external prototypes before returning an incomplete project rename", async () => {
    const external = require("node:url").pathToFileURL(
      path.join(path.dirname(fixture.rootPath), "external.php"),
    ).href;
    const request = protocol(external);
    await expectAsync(
      adapter.resolveRenameTarget(
        { uri: fixture.uris.greeter, position: { line: 4, character: 18 } },
        { session: session("0.10.0", request) },
      ),
    ).toBeRejectedWithError(/external/);
  });
});
