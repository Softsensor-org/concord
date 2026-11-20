# SQLite runtime requirements

Concord requires Node >=22.8. SQLite-dependent commands and tests use
Node's built-in SQLite module.

| Node version | SQLite activation |
| --- | --- |
| 22.8 through 22.12 | Add `--experimental-sqlite` when launching Node |
| 23.0 through 23.3 | Add `--experimental-sqlite` when launching Node |
| 22.13+, 23.4+, and newer release lines | Available by default |

These boundaries follow the [Node 22.8 SQLite documentation](https://nodejs.org/download/release/v22.8.0/docs/api/sqlite.html)
and [Node's flag history](https://nodejs.org/download/release/v25.9.0/docs/api/cli.html#--no-experimental-sqlite).
The declared minimum version is unchanged.

For example, on Node 22.8:

```sh
node --experimental-sqlite -e "console.log(require('node:sqlite').DatabaseSync.name)"
```

The same launch flag applies to commands that open a local SQLite store. It can also be supplied through `NODE_OPTIONS`. Preserve any
other options your process needs. An explicit `--no-experimental-sqlite`
disables the module; remove that option when you intend to use SQLite.

If SQLite is unavailable, the shared loader reports the detected Node version
and launch guidance before the store opens a database. Other loader and
database errors retain their existing behavior. Stores continue to use SQLite
and persist to the requested file; no alternate storage backend is selected.

## Running the tests

```sh
node coord/scripts/test-runner.js
```

The authoritative runner activates SQLite for test children on the affected
Node versions. It prepends the required flag before the caller's existing
`NODE_OPTIONS`, so Node's own parser honors later explicit choices. Repeated
normalization is idempotent, and the isolation guard and session-identity
stripping remain active. This behavior is shared by local, npm, artifact and
CI suite invocations; SQLite tests are executed on the declared minimum.

When invoking SQLite-dependent tests directly, use the runtime flag yourself:

```sh
node --experimental-sqlite --test coord/engine/scripts/sqlite-runtime.test.js
```

The shared runtime tests exercise activation, explicit-disable refusal,
caller options and isolation. Edition-specific persistence tests also exercise
store/sink constructors and file-backed CLI data across separate processes.
