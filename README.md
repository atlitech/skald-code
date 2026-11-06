<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/skald/skald-code-logo-horizontal-on-dark.svg" />
  <img src="assets/skald/skald-code-logo-horizontal.svg" alt="Skald Code" width="320" />
</picture>

# Skald Code

Skald Code is Atli's internal agent workspace and execution host, built on
[T3 Code](https://github.com/pingdotgg/t3code). Work with coding agents from the
web, desktop, or mobile, and connect your environments to Skald for planning,
coordination, and reviewed software delivery.

The fork retains T3 Code's provider integrations and remote environment protocol.
Its command remains `t3`, and existing data directories and connection links stay
compatible across updates.

## Install and update

Use this fork's [releases](https://github.com/atlitech/skald-code/releases) and
[installation and release guide](docs/operations/fork-server.md). Releases include
the Linux server, macOS desktop app, and personal Android app; the personal iOS
app is distributed through TestFlight. Fork versions use the `-atli.N` suffix.

The public T3 Code website, app stores, and package-manager distributions install
upstream T3 Code. They are separate from Skald Code's internal releases.

## Development

Install [Vite+](https://viteplus.dev/guide/), then run:

```sh
vp i
vp run dev
```

See [AGENTS.md](AGENTS.md) for isolated development state and verification, and
[the architecture overview](docs/internals/overview.md) for the codebase.

Skald Code's SVG artwork comes from the [Atli brand system](https://github.com/atlitech/atli/tree/main/brand).
Run `vp run icons:export:skald` to regenerate its platform icons, or
`vp run icons:check:skald` to verify them. [Asset guidance](assets/README.md)
explains the platform formats.

## Documentation and upstream

The inherited [user guides](docs/user/) describe the shared functionality and
retain upstream product and service names. Fork installation and release
instructions live in the [fork guide](docs/operations/fork-server.md).

T3 Code is created and maintained by [the upstream contributors](https://github.com/pingdotgg/t3code/graphs/contributors).
Skald Code preserves their [MIT license and copyright notice](LICENSE).
