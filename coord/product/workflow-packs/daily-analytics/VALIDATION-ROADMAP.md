# Daily Analytics Validation Roadmap

Do not start with engine enforcement. Start with operating governance files.

After repeated use proves the registers stable, evaluate validator checks for:

- unregistered data sources referenced in reports;
- unregistered utilities in `tools/`, scripts, notebooks, or recurring commands;
- missing raw evidence for a finding;
- reports without reconciliation labels;
- platform-write utilities without approval and rollback fields;
- daily runs without input-change checks;
- closed analytics tickets without evidence and decision links;
- mismatch ledger rows without next owner or next check date.

Decision rule:

- keep local team conventions as docs when they are subjective;
- move stable structural requirements to validators only when false positives
  are low and migration guidance exists.
