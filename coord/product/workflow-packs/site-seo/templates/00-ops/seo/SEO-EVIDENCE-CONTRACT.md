# SEO Evidence Contract

## Audit Ingestion

Required evidence:

- export path;
- export date;
- imported issue bucket;
- row count;
- commercial URL count;
- ignored URL count;
- comparison to prior export;
- new, fixed, and unchanged counts;
- registers updated.

## Admin Content Edit

Required evidence:

- object type and handle;
- admin object id if local policy permits storing it;
- fields changed;
- before value snapshot;
- after value snapshot;
- mutation result;
- admin read-back;
- live URL status;
- canonical;
- robots meta;
- H1 count;
- rendered internal links when relevant.

## Redirect Edit

Required evidence:

- source path;
- target path;
- before redirect state;
- expected final URL;
- live check after update;
- redirect hop count;
- no loop;
- commercial or cleanup reason.

## Theme SEO Change

Required evidence:

- theme/site repo ticket id;
- affected files;
- local QA commands;
- commit hash;
- deploy status;
- live rendered verification;
- rollback note.

## URL Inspection Or Request

Required evidence:

- URL;
- reason;
- source ticket;
- requested or blocked-browser status;
- request time when submitted;
- next check date.

## Monitoring Closeout

Required evidence:

- latest export date;
- prior status;
- current status;
- movement observed or explicit expected-excluded decision;
- closure reason;
- remaining next action if not closed.
