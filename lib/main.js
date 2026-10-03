const server = require("./server");

const setting = (key) => lumine.config.get(`ide-php.${key}`);

module.exports = {
  consumeIdeClient(service) {
    return service.registerAdapter({
      id: "ide-php",
      displayName: "PHPantom",
      grammarScopes: ["text.html.php", "source.php"],
      languageId: "php",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-php"],
      restartKeyPaths: ["ide-php.serverPath"],
      installServer: server.installServer,
      latestServerVersion: server.latestServerVersion,
      resolveRenameTarget: require("./rename-target"),
      async resolveServer(context) {
        const launch = await server.resolveServer(setting("serverPath"), context.managedServer);
        if (!launch) {
          service.reportMissingServer("ide-php", {
            description:
              "Install [PHPantom](https://github.com/PHPantom-dev/phpantom_lsp), select its executable in Server Path, or let Manage Servers download it.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
    });
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-php",
      tips: [
        "PHPantom reads your project's composer.json to resolve classes and imports across PHP files; its built-in intelligence needs no PHP runtime.",
      ],
    };
  },
};
