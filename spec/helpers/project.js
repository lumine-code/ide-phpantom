const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const createProject = () => {
  const rootPath = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-php-"));
  fs.mkdirSync(path.join(rootPath, "src"));
  fs.writeFileSync(
    path.join(rootPath, "composer.json"),
    JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
  );
  fs.writeFileSync(path.join(rootPath, ".phpantom.toml"), '[semantic_tokens]\nmode = "full"\n');
  const texts = {
    named:
      "<?php\nnamespace App;\ninterface Named { public function greeting(string $name): string; }\n",
    greeter:
      '<?php\nnamespace App;\nclass Greeter implements Named {\n/** Build a greeting. */\npublic function greeting(string $name): string {return "Hello ".$name;}\n}\n',
    main: '<?php\nnamespace App;\n$greeter = new Greeter();\n$message = "😀"; echo $greeter->greeting("Ada");\n',
    broken: "<?php\nnamespace App;\n$greeter = new Greeter();\necho $greeter->missingMember();\n",
    mixed:
      '<article class="profile">\n<?php\nnamespace App;\n$greeter=new Greeter();\necho $greeter->greeting("Ada");\n?>\n<strong>Résumé 😀</strong>\n</article>\n',
    links: '<?php\nrequire_once __DIR__ . "/src/Greeter.php";\n',
    incomplete: "<?php\nnamespace App;\nclass Unfinished implements Named {\n}\n",
  };
  const files = Object.fromEntries(
    Object.entries({
      named: "src/Named.php",
      greeter: "src/Greeter.php",
      main: "main.php",
      broken: "broken.php",
      mixed: "mixed.php",
      links: "links.php",
      incomplete: "src/Unfinished.php",
    }).map(([key, relative]) => [key, path.join(rootPath, relative)]),
  );
  for (const [key, filePath] of Object.entries(files)) fs.writeFileSync(filePath, texts[key]);
  return {
    rootPath,
    texts,
    files,
    uris: Object.fromEntries(
      Object.entries(files).map(([key, file]) => [key, pathToFileURL(file).href]),
    ),
  };
};
const removeProject = (rootPath) => {
  const target = path.resolve(rootPath),
    parent = fs.realpathSync.native(os.tmpdir());
  if (path.dirname(target) !== parent || !path.basename(target).startsWith("ide-php-"))
    throw new Error(`Refusing to remove a non-test directory: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};
const position = (text, fragment, inside = 0) => {
  const offset = text.indexOf(fragment);
  if (offset < 0) throw new Error(`Missing fixture fragment ${fragment}`);
  const before = text.slice(0, offset + inside).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
};
const editsFor = (edit, uri) => [
  ...(edit.changes?.[uri] || []),
  ...(edit.documentChanges || [])
    .filter((change) => change.textDocument?.uri === uri)
    .flatMap((change) => change.edits || []),
];
const applyEdits = (text, edits) => {
  const lines = text.split("\n"),
    offset = (point) =>
      lines.slice(0, point.line).reduce((sum, line) => sum + line.length + 1, 0) + point.character;
  for (const edit of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start)))
    text =
      text.slice(0, offset(edit.range.start)) + edit.newText + text.slice(offset(edit.range.end));
  return text;
};
module.exports = { createProject, removeProject, position, editsFor, applyEdits };
