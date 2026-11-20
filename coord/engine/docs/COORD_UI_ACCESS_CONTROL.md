# coord-ui access-control core

`coord/engine/scripts/coord-ui-access-core.js` is a pure decision and redaction library.
As of COORD-682 it has no production callers. These tests establish the library
contract; they do not prove that a deployed server enforces it.

A future server adapter must supply `req.socket.remoteAddress` from trusted
transport metadata. Host, forwarded headers and browser-provided fields must
never populate this value. If the runtime cannot provide trustworthy peer
metadata, omit it: local access fails closed, and an authenticated deployment
mode must be used. A proxy's loopback connection identifies the proxy, not the
remote user; explicit authentication remains necessary behind a proxy.

| Configuration | Access behavior |
|---|---|
| Development/default, no explicit mode | A genuine loopback socket gets the local role unless `trustLoopback` is false. |
| Production/default | Local trust is off; explicit `trustLoopback: true` opts in to socket-based local access. |
| Explicit `shared-token` | A configured matching token is required even for loopback peers. |
| Explicit `proxy-header` | A trusted role supplied by an operator-controlled proxy is required even for loopback peers. |
| Explicit `localhost-dev` | Socket-based local access requires loopback trust to be enabled. |
| Unknown explicit mode | Access is denied. |

The existing trusted-role fallback remains available for nonlocal requests.
Only pass `roleHeader` when a trusted proxy has authenticated the identity and
removed any client-supplied role header. The server must not be directly
reachable around that proxy. This library does not authenticate headers itself.

Loopback classification accepts IPv4 addresses in `127.0.0.0/8`, IPv6 `::1`,
and IPv4-mapped IPv6 loopback addresses. Wildcard bind addresses (`0.0.0.0`,
`::`), hostnames, port-qualified and malformed values cannot establish locality.
The legacy `isLoopbackHost` display helper is not an authorization API.

The local role sees full operational detail. Denied and viewer responses retain
redaction of sensitive paths, process details, identity, PR and cost fields.
No write permission or server integration is added by this repair.
