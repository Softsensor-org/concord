# Vendored Babel parser

This directory contains the runtime source used by Concord's bounded, non-executing business-discovery source parser.

- Upstream package: `@babel/parser` 7.29.7
- Source file: `index.js` is upstream `package/lib/index.js`
- Registry tarball: `https://registry.npmjs.org/@babel/parser/-/parser-7.29.7.tgz`
- npm `package-lock.json` integrity: `sha512-hnORnjP/1P/zFEndoeX+n+t1RwWRJiJpM/jO7FW32Kn9r5+sJB2JWOdYo4L6k78j15eCwY3Gm/7364B1EMwtNg==`
- Tarball SHA-512: `8673919e33ffd4fff31449dda1e5fe9feb7547059126226933f8ceec55b7d8a9fdaf9fac241d8958e758a382fa93bf23d79782c18dc69bfef7eb807510cc2d36`
- `index.js` SHA-256: `201724d1415df7749087d9d6e88af50f2bcafe2eb68dfbe9347f49d3361ff426`
- `LICENSE` SHA-256: `2e97627cb278aa7556fb9e8817368302301a595b6c7582512b8d74c57b773652`
- License: MIT; see the unmodified upstream `LICENSE` in this directory.
- Runtime dependencies: none. Upstream declares `@babel/types` for type declarations only.

Refresh procedure: obtain a specific upstream tarball, verify its registry integrity against trusted lock metadata, inspect the package dependency/license metadata, extract only `package/lib/index.js` and `package/LICENSE`, and compare source/license digests. Update this provenance record and focused parser/installer/SEA tests in the same reviewed change. Do not auto-follow a semver range. Re-pin and refresh the engine manifest through the governed release process.

The parser accepts bounded source syntax and does not execute adopter code. Its outputs are candidate evidence; unsupported/dynamic semantics remain unknown. A package digest proves byte identity, not business meaning.

The first-party adapter limits each source input to 250,000 UTF-8 bytes and all mount-graph expansion within that input to 4,096 states. Expansion is iterative and cached per router; exhausted graph resolution is reported as unresolved, without a partial list of resolved paths. This bound is an adapter policy, not a modification of the upstream parser.
