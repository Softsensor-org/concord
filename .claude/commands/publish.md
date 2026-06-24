# Publish — Gate, Submit, and Ship a Content Change (marketing track)

Take a prepared `WEB-`/`DOC-` change through the content gate and out to the live site. **Nothing
reaches the live domain ungated** — the content gate must pass before this skill submits or lands.

**Arguments:** `$ARGUMENTS` — the `WEB-`/`DOC-` ticket id to publish (e.g. `WEB-014`).

## Phase 1: Gate (content)

```bash
coord/scripts/gov gate $ARGUMENTS --track marketing --source local
```

This runs the **content** gate-proc (HTML validity, broken links, SEO/meta enforcement,
Lighthouse thresholds, and captures the Azure SWA **PR preview URL** as the visual review
artifact). If it fails, I stop here, report the failures, and point you at `/seo-check` /
`/content-edit`. **No fail, no publish.**

## Phase 2: Submit for review

```bash
coord/scripts/gov submit $ARGUMENTS --fill
```

This records the gate evidence (scores + preview link) and moves the ticket to review. A human
approver eyeballs the **Azure SWA preview URL** before anything merges.

## Phase 3: Land and deploy

Once approved:

```bash
coord/scripts/agent land $ARGUMENTS --method squash --delete-branch
```

Landing merges to the site's integration branch, which triggers the **Azure Static Web Apps**
GitHub Actions deploy. I then report:
- the **PR URL** and landed commit
- the **Azure SWA preview URL** that was reviewed
- the **production deploy** status once the SWA build completes

## Rules

- The content gate is mandatory and runs **first**. Nothing reaches the live domain ungated.
- A human approves the preview before landing — `/publish` does not self-approve.
- Use the governed verbs (`gov gate` / `gov submit` / `agent land`); never merge or deploy by hand.
- If the gate fails, stop and report — do not "force" a publish.
