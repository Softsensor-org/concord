# Expected Noise Policy

Some URLs are expected to appear in crawler or Search Console exports but should
not become content-improvement work.

Classify a URL as `expected-excluded` only when it is not a commercial indexing
target and does not block user discovery of a commercial page.

Common examples:

- account, login, cart, checkout, and password reset URLs;
- internal search result URLs;
- filtered or faceted URLs with crawl traps;
- CDN, app, tracking, or asset URLs;
- pagination variants with a canonical target;
- deleted campaign URLs with an intentional redirect or gone policy.

Required evidence:

- URL or pattern;
- why it is expected noise;
- whether it has a canonical or redirect target;
- owner ticket;
- next review date if the policy could change.

Do not classify product, collection, article, documentation, pricing, or location
pages as expected noise without owner approval.
