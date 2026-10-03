const fs = require("node:fs");
const path = require("node:path");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, removeProject } = require("./helpers/project");
const exercise = require("./helpers/exercise-server");
const serverPath = process.env.PHPANTOM_PATH || require("../lib/server").findOnPath("phpantom_lsp");
if (process.env.REQUIRE_PHPANTOM && !serverPath)
  throw new Error("CI requires a native PHPantom executable.");
const liveSuite = serverPath ? describe : () => {};

liveSuite("ide-php real PHPantom protocol", () => {
  let fixture, client, adapter, edge, timeout;
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
    const main = (await lumine.packages.activatePackage("ide-php")).mainModule;
    lumine.config.set("ide-php.serverPath", serverPath);
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        client = new LiveLspClient(value, fixture.rootPath);
        return { dispose() {} };
      },
    });
  });
  afterEach(async () => {
    await client.stop();
    edge.dispose();
    lumine.config.unset("ide-php.serverPath");
    await lumine.packages.deactivatePackage("ide-php");
    removeProject(fixture.rootPath);
  });
  const start = async () => {
    const result = await client.start();
    expect(result.serverInfo.version).toBe(process.env.PHPANTOM_VERSION || "0.10.0");
    await exercise.openProject(client, fixture);
  };
  it("reports and clears actual pull diagnostics after a document edit", async () => {
    await start();
    await exercise.diagnostics(client, fixture);
  });
  it("resolves completion documentation, UTF-16 hover, signatures and embedded PHP stubs", async () => {
    await start();
    await exercise.intelligence(client, fixture);
  });
  it("finds all contract references and renames interface, implementation and Unicode invocation together", async () => {
    await start();
    await exercise.navigationAndRename(client, fixture);
  });
  it("follows the native prototype chain before renaming every parent and implementation", async () => {
    await start();
    await exercise.chainRename(client, fixture);
  });
  it("refuses partial renames of independent interface contracts from calls and both declarations", async () => {
    await start();
    await exercise.ambiguousRename(client, fixture);
  });
  it("returns symbols and formats native PHP plus mixed HTML without changing markup", async () => {
    await start();
    await exercise.symbolsAndFormat(client, fixture);
  });
  it("resolves usable implementation edits, parameter hints and full semantic tokens", async () => {
    await start();
    await exercise.actionsHintsAndTokens(client, fixture);
  });
  it("serves dynamic type hierarchies, executable prototype lenses, folding, selections and links", async () => {
    await start();
    await exercise.hierarchyAndProtocol(client, fixture);
  });
  it("installs the official verified native archive through the hub and launches the managed copy", async () => {
    const packagePath = (await lumine.packages.loadPackage("ide-client")).path;
    const ManagedServers = require(path.join(packagePath, "lib", "managed-servers"));
    const managed = new ManagedServers(
      {
        adapters: new Map([[adapter.id, adapter]]),
        allSessions: () => [],
        reattachAll: async () => {},
      },
      { storageRoot: path.join(fixture.rootPath, "managed") },
    );
    try {
      const record = await managed.install(adapter.id, {
        version: process.env.PHPANTOM_VERSION || "0.10.0",
      });
      expect(record.version).toBe("0.10.0");
      const installed = managed.installFor(adapter);
      expect(fs.statSync(installed.binaryPath).isFile()).toBe(true);
      lumine.config.set("ide-php.serverPath", "");
      await client.start(installed);
      await exercise.openProject(client, fixture);
      await exercise.navigationAndRename(client, fixture);
      await exercise.symbolsAndFormat(client, fixture);
    } finally {
      managed.emitter.dispose();
    }
  });
});
