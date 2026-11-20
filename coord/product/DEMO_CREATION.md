# Explicit demo creation

Installation is governance-only and never creates product repositories. To
create the optional demo after installation, preview and review the dedicated
transaction, then apply the exact digest:

```sh
npx create-concord-demo <workspace> --dry-run > demo-plan.json
npx create-concord-demo <workspace> --apply-plan <digest>
```

The command creates only the named demo siblings, requires a reviewed digest,
refuses collisions or changed destinations, and is idempotent after a
successful apply. Existing product repositories remain outside the transaction
and are never modified. A normal Concord install has no demo side effect.
