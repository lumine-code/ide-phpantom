const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const REPOSITORY = "PHPantom-dev/phpantom_lsp";
const TARGETS = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

exports.assetFor = ({ platform, arch }) => {
  const target = TARGETS[`${platform}-${arch}`];
  return target ? `phpantom_lsp-${target}.${platform === "win32" ? "zip" : "tar.gz"}` : null;
};

exports.probeServer = (command, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      ["--version"],
      { ...options, windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error(String(stderr || error.message).trim(), { cause: error }));
        const version = /^phpantom_lsp\s+(\S+)/m.exec(String(stdout))?.[1];
        if (!version)
          return reject(new Error("Server Path does not name a PHPantom language server."));
        resolve(version);
      },
    );
  });

exports.resolveServer = async (context, configuredPath = "") => {
  const selection = await context.resolver.select({
    kind: "executable",
    configuredPath,
    managedPath: context.managedServer?.binaryPath,
    managedVersion: context.managedServer?.version,
    env: context.env,
    cwd: context.rootPath,
    names: ["phpantom_lsp"],
    signal: context.signal,
    validate: async (command) => ({
      version: await exports.probeServer(command, {
        signal: context.signal,
        cwd: context.rootPath,
      }),
    }),
  });
  return selection
    ? context.resolver.launch(selection, {
        signal: context.signal,
        args: ["--stdio"],
        version: selection.data.version,
      })
    : null;
};

exports.latestServerVersion = async (api) => (await api.latestGithubRelease(REPOSITORY)).version;

exports.installServer = async (
  { storagePath, api, version },
  target = { platform: process.platform, arch: process.arch },
) => {
  const assetName = exports.assetFor(target);
  if (!assetName)
    throw new Error(`PHPantom has no managed build for ${target.platform}/${target.arch}.`);
  api.setServerInstallationStatus("checking");
  const release = version
    ? await api.githubReleaseByTag(REPOSITORY, version)
    : await api.latestGithubRelease(REPOSITORY);
  const asset = release.assets.find(({ name }) => name === assetName);
  if (!asset) throw new Error(`PHPantom ${release.version} has no ${assetName}.`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || ""))
    throw new Error(`The release has no SHA-256 digest for ${assetName}.`);
  api.setServerInstallationStatus("downloading");
  await api.downloadFile(asset.url, storagePath, {
    type: target.platform === "win32" ? "zip" : "gzip-tar",
    digest: asset.digest,
  });
  const binary = target.platform === "win32" ? "phpantom_lsp.exe" : "phpantom_lsp";
  const binaryPath = path.join(storagePath, binary);
  if (!(await fs.promises.stat(binaryPath)).isFile())
    throw new Error("The PHPantom archive did not contain its executable.");
  await api.makeFileExecutable(binaryPath);
  return { version: release.version, binary };
};
