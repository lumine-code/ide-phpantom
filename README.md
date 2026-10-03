# ide-php

Provide PHP language intelligence through PHPantom.

Registers the native [PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) language server with `ide-client` for PHP source and mixed HTML/PHP files. Its built-in analysis and formatter need no PHP runtime.

## Features

- **Code intelligence**: provides completion, hover documentation and function signatures.
- **Diagnostics**: reports syntax, type and member problems as source changes.
- **Navigation**: finds definitions, implementations, references and document or workspace symbols.
- **Refactoring**: renames symbols and offers edit-based fixes and extraction actions.
- **Inheritance**: exposes type ancestors and descendants plus executable method-prototype lenses.
- **Formatting**: formats PHP with the built-in formatter or tools selected by the project.
- **Presentation**: supplies inlay hints, semantic tokens, folding ranges and document links.
- **Composer awareness**: reads PSR-4 mappings and project dependencies for cross-file intelligence.
- **Managed installation**: downloads official native releases and verifies their SHA-256 digests.

## Installation

To install `ide-php` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-php`.

Install `ide-client`, `language-php` and the frontends you want, such as `autocomplete`, `linter`, `hover`, `hyperclick`, `refactor` and `code-format`. Select an existing `phpantom_lsp` executable in Server Path or install it through `ide-client:manage-servers`.

Managed releases support x64 and arm64 Windows, macOS and Linux. The core server needs no PHP or Composer executable; external tools such as PHPStan or PHP-CS-Fixer keep their own runtime requirements.

## Usage

Open the folder containing `composer.json` as a project. PHPantom resolves Composer autoload paths automatically and scans PHP files directly in projects without Composer. The adapter serves plain and mixed PHP files; Blade templates use their own grammar and are outside this adapter's document scope.

For PHPantom 0.10.0, the adapter resolves the canonical method prototype before renaming an implementation so the interface, implementation and callers change together. A method shared by independent inheritance contracts is refused before edits are applied because this upstream version cannot safely rename all contracts. Built-in or external prototypes remain outside project refactoring.

Reference-count lenses name another editor's client command, so the shared client omits them. Method-prototype lenses use a server command and remain executable; regular references are available through `find-references`. PHPantom does not implement call hierarchy or range formatting.

## Configuration

PHPantom reads `.phpantom.toml` in the project root and its optional global configuration directly. For example:

```toml
[php]
version = "8.3"

[semantic_tokens]
mode = "full"
```

Project configuration can also select indexing, diagnostics and external formatters. See the [upstream configuration reference](https://github.com/PHPantom-dev/phpantom_lsp/blob/0.10.0/docs/configuration.md) for supported options. Settings that affect initial indexing require a server restart.

## Services

- `ide-client`: consumed to register PHPantom and preserve safe project rename targets.
- `background-tips.provider`: provided to explain Composer-aware PHP intelligence.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
