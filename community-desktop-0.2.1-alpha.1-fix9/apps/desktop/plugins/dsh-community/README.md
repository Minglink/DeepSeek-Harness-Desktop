---
kind: package-bundle
description: "Browse the DeepSeek Stream catalog, connect a community account, and manage desktop plugin installation tasks."
---
# dsh-community

English | [中文](README.zh.md)

## Summary

Browse the DeepSeek Stream catalog, read plugin documentation, and follow installation progress in the desktop application. The community edition includes this bundle and opens it from the sidebar, application menu, and Ctrl+M. Free native plugins require no model API key or additional download authorization; paid plugins follow the community account's unlock status. Downloads still require a network connection and artifact integrity checks. Installation and account credentials remain owned by Electron. This private bundle requires the desktop preload and does not add a market to ordinary web profiles.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Choose **Plugin market** in the upper-left sidebar between Plugins and Automation. Selecting it opens the market and highlights its sidebar row; the collapsed sidebar retains the icon and tooltip. The catalog supports server-side search, categories, environment and source filters, rankings, scene tags, and pagination. Details load full documentation separately from the short catalog response. The header keeps sign-in or account access visible. Its Community Hub button displays deepseek.stream and opens the website in the desktop community window.

The Installed tab enables or disables writable bundles and asks for confirmation before removal. The market's own entry stays protected on this page. Installation tasks show progress and failures, allow cancellation while active, and offer an explicit retry after failure or cancellation. These operations use the current desktop profile.

Expand **Show install log** on a task to read its saved diagnostic output, including installation phases, commands, working directories, process errors, and exit codes. Logs continue to update while the panel is open and remain available after restarting the app. Pause automatic scrolling to inspect earlier output, or copy or export the log when reporting a failure. Credentials are redacted before logs are saved. The panel reports truncated history and log storage or read failures explicitly.

Expand **Show runtime log** to read client warnings and original errors, with source files, line numbers and timestamps. This separate bounded log remains readable after an installation finishes, while the Host is unavailable, and after restarting the app; it does not assign client errors to an installation task. Copy and export include the sanitized retained history. Older desktop packages show an update instruction instead of invoking unsupported log APIs.

By default, archive downloads allow ten minutes overall, with 45-second limits for connecting or waiting without new data. Transient download failures get at most three attempts, waiting one then two seconds between attempts; the saved task log identifies the failed attempt and its reason.

Plugins distributed as complete packages show **Complete package**. Their details open the community website's download and author installation instructions. The desktop app does not download or execute author installation scripts. An older installation link reports that manual installation is required before downloading or invoking AI adaptation.

Build the module from the repository root:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build:market
```

<a id="understand-the-implementation"></a>
## Understand the implementation

The [bundle patch](cordis.patch.yml) mounts the package's [Host entry](index.js), which provides no Host behavior. This active Loader row makes the client module discoverable. The [client entry](src/client/index.ts) registers the panel and sidebar entry through disposable client services. Navigation requests remain pending until a live client selects the market; acknowledgements identify the selected request across module reloads. The [panel](src/client/CommunitySection.tsx) receives credential-free records from the [desktop community API](../../src/community-types.ts). The desktop build creates a module-loader factory that shares the application's React instance and UI primitives.

The [task log panel](src/client/CommunityTaskLogPanel.tsx) reads a bounded diagnostic tail only when expanded. Cursor-based reads append live entries without overlapping requests. Collapsing the panel releases its subscription; reopening it reads persisted history again. Copy and export use the main process's sanitized log, including entries outside the visible tail.

<a id="model-experience"></a>
## Model Experience

This bundle adds no model-visible tools or messages. The desktop installation service checks native package compatibility and publishes task phases for the panel. Ordinary native installation does not call a model; plugins that require AI adaptation use a separately configured model credential.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Server catalog and detail availability depend on deepseek.stream. An offline catalog remains readable when a refresh fails. Community login does not supply an official DeepSeek API key; a separate model credential is needed only for plugins that require AI adaptation. Product task results report restoration independently from installation failures.
