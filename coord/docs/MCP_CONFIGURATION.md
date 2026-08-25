# MCP Configuration

The default `.mcp.json` starts exactly one server: Concord's local governance
server at `coord/scripts/governance-mcp.js`. It does not invoke a package
manager, install a package, contact an external service, or contain credential
placeholders. MCP clients may still require project-level approval before they
make that local server available to a conversation; approval and transport
initialization are separate checks.

## Optional Sentry connector

Sentry is opt-in. Review the access-token scopes, export
`SENTRY_ACCESS_TOKEN`, then copy the `sentry` server entry from
`coord/examples/mcp/sentry.mcp.json` into the root `.mcp.json`. The example calls
`coord/scripts/mcp-optional-launcher.js`, which refuses to start without the
credential and launches the exact package `@sentry/mcp-server@0.37.0` only
after explicit activation. Updating that version is a reviewed source change;
never replace it with `latest`.

The local package and token flow are useful for stdio or self-hosted setups.
For Sentry's hosted OAuth service, follow the vendor instructions at
<https://mcp.sentry.dev/> instead of adding a token to a project file.

## Optional Datadog connector

Concord does not ship or auto-install a Datadog npm server. Datadog provides an
official remote OAuth server and an optional local binary. Configure either one
explicitly using <https://docs.datadoghq.com/mcp_server/setup/> and the least
privileged Datadog role appropriate to the requested toolsets. Do not place API
or application keys in `.mcp.json`.

After changing MCP configuration, restart the client, approve the project
server if prompted, and distinguish approval failures from transport failures.
The local governance transport can be checked with:

```sh
node --test --test-name-pattern='spawned-server smoke' coord/scripts/governance-mcp.test.js
```
