const path = require("node:path");
const { fileURLToPath } = require("node:url");

const locationOf = (result) => {
  const value = Array.isArray(result) ? result[0] : result;
  if (!value) return null;
  return {
    uri: value.targetUri || value.uri,
    position: (value.targetSelectionRange || value.range)?.start,
  };
};

const contains = (range, position) =>
  range &&
  (position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character)) &&
  (position.line < range.end.line ||
    (position.line === range.end.line && position.character < range.end.character));
const validPosition = (value) =>
  Number.isInteger(value?.line) &&
  value.line >= 0 &&
  Number.isInteger(value?.character) &&
  value.character >= 0;
const validRange = (value) =>
  validPosition(value?.start) &&
  validPosition(value?.end) &&
  (value.start.line < value.end.line ||
    (value.start.line === value.end.line && value.start.character <= value.end.character));
const classKinds = new Set([5, 10, 11]);
const typeKey = (item) => {
  if (
    typeof item?.uri !== "string" ||
    !classKinds.has(item.kind) ||
    !validRange(item.selectionRange)
  )
    throw new Error(
      "PHPantom returned malformed type metadata; the method cannot be renamed safely.",
    );
  return `${item.uri}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
};
const validateSymbols = (items) => {
  for (const item of items) {
    if (
      !item ||
      typeof item.name !== "string" ||
      !Number.isInteger(item.kind) ||
      !validRange(item.selectionRange) ||
      (item.children !== undefined && !Array.isArray(item.children))
    )
      throw new Error(
        "PHPantom returned malformed declaration metadata; the method cannot be renamed safely.",
      );
    validateSymbols(item.children || []);
  }
};

const contractInspection = (session, signal) => {
  const documents = new Map();
  const parents = new Map();
  const symbols = async (uri) => {
    if (!documents.has(uri))
      documents.set(
        uri,
        session.request("textDocument/documentSymbol", { textDocument: { uri } }, { signal }),
      );
    const result = await documents.get(uri);
    if (result !== null && result !== undefined && !Array.isArray(result))
      throw new Error(
        "PHPantom returned malformed declaration metadata; the method cannot be renamed safely.",
      );
    validateSymbols(result || []);
    return Array.isArray(result) ? result : [];
  };
  const methodAt = async (target) => {
    const find = (items) => {
      for (const item of items) {
        if (classKinds.has(item.kind)) {
          const method = (item.children || []).find(
            (child) => child.kind === 6 && contains(child.selectionRange, target.position),
          );
          if (method) return { type: item, method };
        }
        const nested = find(item.children || []);
        if (nested) return nested;
      }
      return null;
    };
    return find(await symbols(target.uri));
  };
  const declaringType = async (item) => {
    const find = (items) => {
      for (const symbol of items) {
        if (
          classKinds.has(symbol.kind) &&
          contains(symbol.selectionRange, item.selectionRange.start)
        )
          return symbol;
        const nested = find(symbol.children || []);
        if (nested) return nested;
      }
      return null;
    };
    return find(await symbols(item.uri));
  };
  const ancestors = async (item) => {
    const key = typeKey(item);
    if (!parents.has(key))
      parents.set(key, session.request("typeHierarchy/supertypes", { item }, { signal }));
    const result = await parents.get(key);
    if (result !== null && result !== undefined && !Array.isArray(result))
      throw new Error(
        "PHPantom returned malformed type metadata; the method cannot be renamed safely.",
      );
    return Array.isArray(result) ? result : [];
  };
  const assertIndependentRootsAbsent = async (item, name) => {
    const nodes = new Map();
    const visit = async (current) => {
      const key = typeKey(current);
      if (nodes.has(key)) return;
      if (nodes.size >= 256)
        throw new Error("PHPantom's method hierarchy is too large to rename safely.");
      const symbol = await declaringType(current);
      if (!symbol)
        throw new Error(
          "PHPantom could not verify an inherited declaration; the method cannot be renamed safely.",
        );
      const declares = (symbol?.children || []).some(
        (child) => child.kind === 6 && child.name.toLowerCase() === name,
      );
      const node = { declares, parents: [] };
      nodes.set(key, node);
      for (const parent of await ancestors(current)) {
        node.parents.push(typeKey(parent));
        await visit(parent);
      }
    };
    await visit(item);
    const hasDeclaringAncestor = (node) => {
      const seen = new Set();
      const pending = [...node.parents];
      while (pending.length) {
        const key = pending.pop();
        if (seen.has(key)) continue;
        seen.add(key);
        const parent = nodes.get(key);
        if (parent?.declares) return true;
        pending.push(...(parent?.parents || []));
      }
      return false;
    };
    const roots = [...nodes.values()].filter(
      (node) => node.declares && !hasDeclaringAncestor(node),
    );
    if (roots.length > 1)
      throw new Error(
        "PHPantom 0.10.0 cannot safely rename a method that implements independent contracts. Rename the contracts together manually until the server supports this case.",
      );
  };
  const inspect = async (target, context) => {
    const prepared = await session.request(
      "textDocument/prepareTypeHierarchy",
      { textDocument: { uri: target.uri }, position: context.type.selectionRange.start },
      { signal },
    );
    const initial = prepared?.[0];
    if (!initial)
      throw new Error("PHPantom could not verify the method's contracts before renaming.");
    const name = context.method.name.toLowerCase();
    const seen = new Set();
    const visit = async (item) => {
      const key = typeKey(item);
      if (seen.has(key)) return;
      if (seen.size >= 256)
        throw new Error("PHPantom's method hierarchy is too large to rename safely.");
      seen.add(key);
      await assertIndependentRootsAbsent(item, name);
      const children = await session.request("typeHierarchy/subtypes", { item }, { signal });
      if (children !== null && children !== undefined && !Array.isArray(children))
        throw new Error(
          "PHPantom returned malformed type metadata; the method cannot be renamed safely.",
        );
      for (const child of children || []) await visit(child);
    };
    await visit(initial);
  };
  return { methodAt, inspect };
};

// PHPantom 0.10.0 renames a concrete method without its interface declaration.
// Its prototype links already identify the canonical declaration accurately.
module.exports = async (original, { session, signal }) => {
  const version = session.serverInfo?.version || session.launch?.version;
  if (!/^0\.10\.0(?:$|[-+])/.test(version || "")) return undefined;
  const inspection = contractInspection(session, signal);
  let target = original;
  let context = await inspection.methodAt(original);
  if (!context) {
    const definition = locationOf(
      await session.request(
        "textDocument/definition",
        { textDocument: { uri: original.uri }, position: original.position },
        { signal },
      ),
    );
    if (!definition?.uri || !definition.position) return undefined;
    context = await inspection.methodAt(definition);
    if (!context) return undefined;
    target = definition;
    await inspection.inspect(definition, context);
  } else {
    await inspection.inspect(original, context);
  }
  let changed = false;
  const seen = new Set();
  for (let depth = 0; depth < 16; depth += 1) {
    const key = `${target.uri}:${target.position.line}:${target.position.character}`;
    if (seen.has(key)) throw new Error("PHPantom returned a cyclic method prototype chain.");
    seen.add(key);
    const lenses = await session.request(
      "textDocument/codeLens",
      { textDocument: { uri: target.uri } },
      { signal },
    );
    let prototype;
    for (const lens of lenses || []) {
      if (
        lens.command?.command !== "phpantom.navigateToPrototype" ||
        lens.range?.start?.line !== target.position.line ||
        typeof lens.command.arguments?.[0] !== "string" ||
        !Number.isInteger(lens.command.arguments?.[1]?.line) ||
        !Number.isInteger(lens.command.arguments?.[1]?.character)
      )
        continue;
      const [uri, position] = lens.command.arguments;
      let relative;
      try {
        relative = path.relative(session.rootPath, fileURLToPath(uri));
      } catch {
        throw new Error("Cannot rename a PHP method whose prototype is external to this project.");
      }
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        throw new Error("Cannot rename a PHP method whose prototype is external to this project.");
      const declaration = await inspection.methodAt({ uri, position });
      if (!declaration)
        throw new Error("PHPantom could not verify the method's prototype before renaming.");
      if (declaration.method.name.toLowerCase() === context.method.name.toLowerCase()) {
        prototype = { uri, position };
        break;
      }
    }
    if (!prototype) return changed ? target : undefined;
    target = prototype;
    changed = true;
  }
  throw new Error("PHPantom's method prototype chain is too deep to rename safely.");
};
