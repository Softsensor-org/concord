# Follow-up prompt ownership

`gov open-followup` creates and registers `coord/prompts/tickets/<CHILD>.md`
by default. The prompt contains the child's ID, description and repository.
It does not inherit the parent's prompt or its likely-files list. The board row,
prompt and audit event use the same governed transaction; a persistence failure
rolls them back together. `split-ticket` uses this same path for each child.

```sh
coord/scripts/gov open-followup --prefix COORD --depends-on COORD-123 --repo X --type bug --pri P1 --description "Describe the separate repair"
```

Fill in the child's acceptance details and intended files before implementation,
as for a ticket filed with `file-ticket --with-prompt`.

## Deliberate references and sharing

An explicit `--prompt <existing-path>` references that file without changing it.
This supports genuinely shared prompts and child prompts prepared in advance:

```sh
coord/scripts/gov open-followup --prefix COORD --depends-on COORD-123 --repo X --type bug --pri P1 --description "A deliberately shared scope" --prompt coord/prompts/tickets/COORD-123.md
```

The journal event records `details.prompt.mode` as `child` or
`explicit-reference`, the normalized prompt path, whether a file was created,
and `shared_with`: other ticket IDs registered to that same normalized path.
Prompt choices are part of the request's idempotency key. For newly recorded
requests, repeating a successful explicit-ID request retains its existing retry
behavior; changing its prompt choice is not silently treated as the earlier
successful request. Automatic-ID calls continue to reserve new IDs using the
existing transaction protocol.

Default creation refuses an existing file or a path registered to another
ticket. Use an explicit reference to reuse it. New prompts are opened with exclusive creation.
`--prompt` is reference-only: do not combine it with creation or replacement
flags. `open-followup` never replaces an existing prompt. Historical mappings
are retained; this change does not relink previously filed children.

## Filing-surface audit

| Surface | Prompt registration behavior |
| --- | --- |
| `open-followup` | Creates the child's own prompt; an explicit existing reference records intent. |
| `split-ticket` | Calls `open-followup` for each child and creates separate prompt files. |
| `file-ticket` / `new` | No implicit parent lookup. `--with-prompt` creates/registers a prompt; `--prompt` alone is an explicit reference recorded in the request. |
| `register-prompt` | Explicit registration or creation; without a path it preserves the ticket's own existing mapping or uses its own default path. |
| Start-time auto-discovery | Looks only for the current ticket's default prompt when no mapping or waiver exists. |
| Release board stripping | Clears donor mappings; does not infer or share another ticket's scope. |

The former parent-inheritance resolver has been removed. Actual-consumer tests
cover filing, shared references, collision auditing, persistence rollback,
exclusive creation and split children. Existing filing and path tests continue
to cover the other writers.
