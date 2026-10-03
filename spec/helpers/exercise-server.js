const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { position, editsFor, applyEdits } = require("./project");
const { fileUri } = require("./live-lsp-client");

const at = (client, fixture, method, key, fragment, inside = 1, extra = {}) =>
  client.request(method, {
    textDocument: { uri: fixture.uris[key] },
    position: position(fixture.texts[key], fragment, inside),
    ...extra,
  });
const document = (fixture, key) => ({ textDocument: { uri: fixture.uris[key] } });
const openProject = async (client, fixture) => {
  for (const key of Object.keys(fixture.files))
    client.open(fixture.uris[key], "php", fixture.texts[key]);
  await client.waitFor(
    async () => await at(client, fixture, "textDocument/hover", "main", "greeting(", 2),
    "Composer project import",
  );
};
const diagnostics = async (client, fixture) => {
  const reported = await client.waitFor(async () => {
    const result = await client.request("textDocument/diagnostic", document(fixture, "broken"));
    return result.items?.some(({ message }) => message.includes("missingMember")) ? result : false;
  }, "undefined member diagnostic");
  const issue = reported.items.find(({ message }) => message.includes("missingMember"));
  assert.equal(issue.source, "phpantom");
  assert.equal(issue.range.start.line, 3);
  client.change(
    fixture.uris.broken,
    fixture.texts.broken.replace("missingMember()", 'greeting("Ada")'),
  );
  const cleared = await client.waitFor(async () => {
    const result = await client.request("textDocument/diagnostic", document(fixture, "broken"));
    return result.resultId !== reported.resultId && result.items?.length === 0 ? result : false;
  }, "diagnostic cleared after didChange");
  assert.equal(cleared.items.length, 0);
};
const intelligence = async (client, fixture) => {
  const result = await at(client, fixture, "textDocument/completion", "main", "greeting(", 3);
  const completion = (result.items || result).find(({ label }) => label.includes("greeting"));
  assert.ok(completion);
  const resolved = await client.request("completionItem/resolve", completion);
  assert.ok(JSON.stringify(resolved.documentation).includes("Build a greeting"));
  const hover = await at(client, fixture, "textDocument/hover", "main", "greeting(", 2);
  assert.ok(JSON.stringify(hover).includes("Build a greeting"));
  assert.equal(hover.range.start.character, position(fixture.texts.main, "greeting(").character);
  const signature = await at(
    client,
    fixture,
    "textDocument/signatureHelp",
    "main",
    "greeting(",
    12,
  );
  assert.ok(signature.signatures[0].label.includes("string $name"));
  const builtin = '<?php\n$length = strlen("hello");\n',
    uri = fileUri(path.join(fixture.rootPath, "builtin.php"));
  fs.writeFileSync(path.join(fixture.rootPath, "builtin.php"), builtin);
  client.open(uri, "php", builtin);
  const builtinHover = await client.waitFor(
    () =>
      client.request("textDocument/hover", {
        textDocument: { uri },
        position: position(builtin, "strlen(", 2),
      }),
    "embedded standard-library stubs",
  );
  assert.ok(JSON.stringify(builtinHover).includes("strlen"));
};
const navigationAndRename = async (client, fixture) => {
  const definition = await at(client, fixture, "textDocument/definition", "main", "greeting(", 2);
  assert.equal((Array.isArray(definition) ? definition[0] : definition).uri, fixture.uris.greeter);
  const refs = await at(client, fixture, "textDocument/references", "main", "greeting(", 2, {
    context: { includeDeclaration: true },
  });
  for (const key of ["named", "greeter", "main"])
    assert.ok(
      refs.some(({ uri }) => uri === fixture.uris[key]),
      `References omitted ${key}`,
    );
  assert.equal(
    refs.find(({ uri }) => uri === fixture.uris.main).range.start.character,
    position(fixture.texts.main, "greeting(").character,
  );
  const edit = await at(client, fixture, "textDocument/rename", "main", "greeting(", 2, {
    newName: "welcome",
  });
  for (const key of ["named", "greeter", "main"]) {
    const changes = editsFor(edit, fixture.uris[key]);
    assert.equal(changes.length, 1, `Safe rename omitted ${key}`);
    assert.equal(changes[0].newText, "welcome");
    assert.ok(applyEdits(fixture.texts[key], changes).includes("welcome("));
  }
  assert.equal(
    editsFor(edit, fixture.uris.main)[0].range.start.character,
    position(fixture.texts.main, "greeting(").character,
  );
  for (const origin of ["greeter", "named"]) {
    const fromDeclaration = await at(
      client,
      fixture,
      "textDocument/rename",
      origin,
      "greeting(",
      2,
      { newName: "welcome" },
    );
    for (const key of ["named", "greeter", "main"])
      assert.equal(
        editsFor(fromDeclaration, fixture.uris[key]).filter(({ newText }) => newText === "welcome")
          .length,
        1,
        `Rename from ${origin} omitted ${key}`,
      );
  }
  const parameter = await at(
    client,
    fixture,
    "textDocument/rename",
    "greeter",
    "greeting(string $name)",
    19,
    { newName: "person" },
  );
  assert.equal(editsFor(parameter, fixture.uris.greeter).length, 2);
  assert.equal(editsFor(parameter, fixture.uris.named).length, 0);
  assert.equal(editsFor(parameter, fixture.uris.main).length, 0);
  const variable = await at(client, fixture, "textDocument/rename", "main", "$message", 3, {
    newName: "content",
  });
  assert.equal(editsFor(variable, fixture.uris.main).length, 1);
  assert.equal(editsFor(variable, fixture.uris.main)[0].newText, "$content");
  assert.equal(editsFor(variable, fixture.uris.greeter).length, 0);
  assert.equal(editsFor(variable, fixture.uris.named).length, 0);
};
const chainRename = async (client, fixture) => {
  const base =
    '<?php\nnamespace App;\nclass BaseGreeter implements Named {\npublic function greeting(string $name): string {return "Hello ".$name;}\n}\n';
  const baseFile = path.join(fixture.rootPath, "src", "BaseGreeter.php"),
    baseUri = fileUri(baseFile);
  fs.writeFileSync(baseFile, base);
  client.open(baseUri, "php", base);
  const concrete = fixture.texts.greeter.replace("implements Named", "extends BaseGreeter");
  fs.writeFileSync(fixture.files.greeter, concrete);
  client.change(fixture.uris.greeter, concrete);
  await client.waitFor(async () => {
    const lenses = await client.request("textDocument/codeLens", document(fixture, "greeter"));
    return lenses?.some(({ command }) => command?.arguments?.[0] === baseUri);
  }, "concrete override prototype");
  const edit = await at(client, fixture, "textDocument/rename", "main", "greeting(", 2, {
    newName: "welcome",
  });
  for (const uri of [fixture.uris.named, baseUri, fixture.uris.greeter, fixture.uris.main])
    assert.equal(
      editsFor(edit, uri).filter(({ newText }) => newText === "welcome").length,
      1,
      `Canonical chain rename omitted ${uri}`,
    );
  // Two direct parents remain safe when they share the same declaring root.
  const branches = [];
  for (const name of ["LeftNamed", "RightNamed"]) {
    const text = `<?php\nnamespace App;\ninterface ${name} extends Named { public function greeting(string $name): string; }\n`;
    const file = path.join(fixture.rootPath, "src", `${name}.php`),
      uri = fileUri(file);
    fs.writeFileSync(file, text);
    client.open(uri, "php", text);
    branches.push(uri);
  }
  const diamond = fixture.texts.greeter.replace(
    "implements Named",
    "implements LeftNamed, RightNamed",
  );
  fs.writeFileSync(fixture.files.greeter, diamond);
  client.change(fixture.uris.greeter, diamond);
  await client.waitFor(async () => {
    const item = (
      await at(
        client,
        fixture,
        "textDocument/prepareTypeHierarchy",
        "greeter",
        "Greeter implements",
        2,
      )
    )[0];
    const parents = await client.request("typeHierarchy/supertypes", { item });
    return branches.every((uri) => parents.some((parent) => parent.uri === uri));
  }, "connected interface diamond");
  const connected = await at(client, fixture, "textDocument/rename", "main", "greeting(", 2, {
    newName: "welcome",
  });
  for (const uri of [fixture.uris.named, ...branches, fixture.uris.greeter, fixture.uris.main])
    assert.equal(
      editsFor(connected, uri).filter(({ newText }) => newText === "welcome").length,
      1,
      `Connected contract rename omitted ${uri}`,
    );
};
const ambiguousRename = async (client, fixture) => {
  const other =
    "<?php\nnamespace App;\ninterface OtherNamed {public function greeting(string $name): string;}\n";
  const file = path.join(fixture.rootPath, "src", "OtherNamed.php"),
    uri = fileUri(file);
  fs.writeFileSync(file, other);
  client.open(uri, "php", other);
  const concrete = fixture.texts.greeter.replace(
    "implements Named",
    "implements Named, OtherNamed",
  );
  fs.writeFileSync(fixture.files.greeter, concrete);
  client.change(fixture.uris.greeter, concrete);
  await client.waitFor(async () => {
    const result = await at(
      client,
      fixture,
      "textDocument/prepareTypeHierarchy",
      "greeter",
      "Greeter implements",
      2,
    );
    const parents = await client.request("typeHierarchy/supertypes", { item: result[0] });
    return parents.some((item) => item.uri === uri);
  }, "independent interface import");
  for (const origin of ["main", "greeter", "named"]) {
    const before = client.sentRequests.length;
    await assert.rejects(
      at(client, fixture, "textDocument/rename", origin, "greeting(", 2, { newName: "welcome" }),
      /independent contracts/,
    );
    assert.ok(
      !client.sentRequests.slice(before).some(({ method }) => method === "textDocument/rename"),
    );
  }
  // Keep the hierarchy real and drop only one known parent's metadata.
  const request = client.request;
  client.request = function (method, params, ...options) {
    if (method === "textDocument/documentSymbol" && params.textDocument.uri === uri)
      return Promise.resolve(null);
    return request.call(this, method, params, ...options);
  };
  try {
    const before = client.sentRequests.length;
    await assert.rejects(
      at(client, fixture, "textDocument/rename", "main", "greeting(", 2, { newName: "welcome" }),
      /verify an inherited declaration/,
    );
    assert.ok(
      !client.sentRequests.slice(before).some(({ method }) => method === "textDocument/rename"),
    );
  } finally {
    client.request = request;
  }
  assert.equal(fs.readFileSync(file, "utf8"), other);
  assert.equal(fs.readFileSync(fixture.files.named, "utf8"), fixture.texts.named);
};
const symbolsAndFormat = async (client, fixture) => {
  const symbols = await client.request("textDocument/documentSymbol", document(fixture, "greeter"));
  assert.ok(
    symbols.some(
      ({ name, children }) =>
        name === "Greeter" && children.some(({ name }) => name === "greeting"),
    ),
  );
  assert.ok(
    (await client.request("workspace/symbol", { query: "Greeter" })).some(
      ({ name }) => name === "App\\Greeter",
    ),
  );
  for (const key of ["greeter", "mixed"]) {
    const changes = await client.request("textDocument/formatting", {
      ...document(fixture, key),
      options: { tabSize: 4, insertSpaces: true },
    });
    assert.ok(changes.length > 0);
    const text = applyEdits(fixture.texts[key], changes);
    if (key === "mixed") {
      assert.ok(text.includes('<article class="profile">'));
      assert.ok(text.includes("<strong>Résumé 😀</strong>"));
      assert.ok(text.includes("$greeter = new Greeter();"));
    } else assert.ok(text.includes("public function greeting"));
  }
};
const actionsHintsAndTokens = async (client, fixture) => {
  const actions = await client.request("textDocument/codeAction", {
    ...document(fixture, "incomplete"),
    range: { start: { line: 2, character: 6 }, end: { line: 2, character: 16 } },
    context: { diagnostics: [] },
  });
  let action = actions.find(({ title }) => title.startsWith("Implement "));
  assert.ok(action);
  action = await client.request("codeAction/resolve", action);
  const newText = applyEdits(
    fixture.texts.incomplete,
    editsFor(action.edit, fixture.uris.incomplete),
  );
  assert.ok(newText.includes("public function greeting(string $name): string"));
  const hints = await client.request("textDocument/inlayHint", {
    ...document(fixture, "main"),
    range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
  });
  const hint = hints.find(({ label }) => JSON.stringify(label).includes("name:"));
  assert.ok(hint);
  assert.equal(hint.position.character, position(fixture.texts.main, '"Ada"').character);
  const tokens = await client.request(
    "textDocument/semanticTokens/full",
    document(fixture, "main"),
  );
  assert.ok(tokens.data.length > 0 && tokens.data.length % 5 === 0);
};
const hierarchyAndProtocol = async (client, fixture) => {
  await client.waitFor(
    () => client.registrations.some(({ method }) => method === "textDocument/prepareTypeHierarchy"),
    "PHPantom dynamic hierarchy registration",
  );
  assert.ok(
    client.registrations.some(({ method }) => method === "textDocument/prepareTypeHierarchy"),
  );
  const child = (
    await at(
      client,
      fixture,
      "textDocument/prepareTypeHierarchy",
      "greeter",
      "Greeter implements",
      2,
    )
  )[0];
  assert.equal(child.name, "Greeter");
  assert.ok(
    (await client.request("typeHierarchy/supertypes", { item: child })).some(
      ({ name }) => name === "Named",
    ),
  );
  const parent = (
    await at(client, fixture, "textDocument/prepareTypeHierarchy", "named", "Named {", 2)
  )[0];
  assert.ok(
    (await client.request("typeHierarchy/subtypes", { item: parent })).some(
      ({ name }) => name === "Greeter",
    ),
  );
  const lenses = await client.request("textDocument/codeLens", document(fixture, "greeter")),
    prototype = lenses.find(({ command }) => command?.command === "phpantom.navigateToPrototype");
  assert.ok(prototype);
  assert.equal(prototype.command.arguments[0], fixture.uris.named);
  await client.request("workspace/executeCommand", {
    command: prototype.command.command,
    arguments: prototype.command.arguments,
  });
  const shown = await client.waitFor(
    () =>
      client.serverRequests.find(
        ({ method, params }) =>
          method === "window/showDocument" && params.uri === fixture.uris.named,
      ),
    "prototype navigation request",
  );
  assert.equal(shown.params.selection.start.line, 2);
  assert.ok(
    (await client.request("textDocument/foldingRange", document(fixture, "greeter"))).some(
      ({ startLine, endLine }) => startLine === 2 && endLine === 5,
    ),
  );
  const selection = await client.request("textDocument/selectionRange", {
    ...document(fixture, "main"),
    positions: [position(fixture.texts.main, "greeting(", 2)],
  });
  assert.equal(
    selection[0].range.start.character,
    position(fixture.texts.main, "greeting(").character,
  );
  assert.ok(selection[0].parent);
  assert.ok(
    (await client.request("textDocument/documentLink", document(fixture, "links"))).some(
      ({ target }) => target === fixture.uris.greeter,
    ),
  );
};
module.exports = {
  at,
  document,
  openProject,
  diagnostics,
  intelligence,
  navigationAndRename,
  chainRename,
  ambiguousRename,
  symbolsAndFormat,
  actionsHintsAndTokens,
  hierarchyAndProtocol,
};
