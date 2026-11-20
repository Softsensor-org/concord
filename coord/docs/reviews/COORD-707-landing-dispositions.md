# COORD-707: append-only landing dispositions

Status: all 13 canonical append-only corrections applied through the installed COORD-756 writer on 2026-09-11. All 86 pre-existing landing records remain unchanged. Ticket qualification and publication are recorded separately in the governed plan and board; this document is not itself a landing receipt.

## Authority and scope

The human approved append-only corrected landing records while preserving the originals. No authority was inferred to edit historical `landing_index` entries, override locks, raise budgets, invent source provenance, or publish a public release. COORD-756 supplies the governed writer; COORD-707 executes the historical dispositions only after that writer is installed on canonical main.

Requirements: REQ-002, REQ-005, NFR-004. ADR-0002 requires canonical integration-tree mutations; ADR-0008 distinguishes the control-plane repository from product repositories.

## Mechanism and proof standard

The old writer passed landed prose and no-PR references to a SHA-token scavenger. The first resolvable source hash could become `commit_sha`. Ordinary remote ancestry then accepted it because a source parent is an ancestor too. Missing token boundaries could instead produce `local_only`, as happened for COORD-699. Neither result proved the actual governed integration merge.

New writes use the structured workspace-merge result or recovered merge receipt, never prose tokens. Historical originals remain readable unchanged. The correction writer appends a separate claim with the original-record digest, prior-correction digest, human approval, repair ticket, full source/merge SHAs, integration branch and freshly observed remote SHA.

Every correction must prove: the merge has multiple parents; it is on the remote integration first-parent history; its non-first parent contains the reviewed source; and its first parent does not already contain that source. Source provenance must match the original structured source (or the original recorded commit for the wrong-parent cases). Records without either require an exact ticket identifier in the independently committed merge subject. Missing remote verification, unrelated merges, altered originals, and nonmatching sources are refusals, not opportunities for inference.

## Applied dispositions

Read-only verification followed a successful fetch of origin/main at `03169bb6af0c109d6e7d404ae91733cd18b66acb`. The final writer must fetch again before each append; this older observation is not publication evidence for the repairs.

The 2026-09-11 continuation refreshed origin/main and observed the same tip.
All 13 proposals passed read-only merge/source verification again. Every one of
the 84 existing `landing_index` records was compared with that remote snapshot
and remained structurally identical; preservation was not limited to the 13
correction candidates. No correction was written during this check.

| Ticket | Reviewed source | Actual integration merge |
| --- | --- | --- |
| COORD-479 | edba6ccd97f1bccca7ab78540d039f8f901c1237 | e2426e4c2c5bc1f417ec6953244df7bf5bd80229 |
| COORD-484 | d6f58a91fe8d444e5311a5eaee0bd7b4538c7964 | 7e014139444a7c64f96d6f1820fd88656cb52598 |
| COORD-617 | ec3d250b5b0e4c6ddaebc2f6885961d43cad42c5 | e5524e0f9e33ea885329590a5efd3a2db31798b3 |
| COORD-618 | 4f0df6e29659252e94c545fe03c45178ea365938 | eeaa8e6e30edd3fb59ad2e03f57c3a19a2619d34 |
| COORD-619 | 82509e4aedb73e7792826e8db07eb1381a55f474 | a7fb2e0b8230e3b51c8ff58b84929f56c395c9dd |
| COORD-620 | f50c9fdace728d6e15f7620214d8fc375021d19a | e14168bf07717bf7e3da96b214dffcf3020d9de7 |
| COORD-696 | d9df4883a9d002b1ce840e3ddb766fa53a1def57 | bf47341e30d510ef040159f9566792990b70b69d |
| COORD-697 | 8bfb9c179214cb6e2a92f11411dee24aede2daee | 25f419696ac0992349bed72a6b699fa56a54d000 |
| COORD-699 | 660ea9c6b09714beffeb9f8b0458f4d80608d73b | a50b508946d4809c0bab49192c064bfadd07fba1 |
| COORD-701 | 7082ea7c70d41d9052ea678fbc6b759129b671e6 | 8abccf8fcaf63bb58207a9a92a37d95ed0d8596d |
| COORD-706 | 2fba664da5ee6f436d91fe3e86fa15f489dfaac1 | b04f90d4c80b7dd41208233c2d2c57c011ce6dec |
| COORD-731 | 98c74bb4afb8483b78d71f03da9f8583722ce267 | c6010be0d1ff05d03881663814896c0796d6d27f |
| COORD-734 | abd1b933349c215d3db5b9886325fed657890f0c | 49cfab50ccf7472ea9a18ff28ca39e6307c5e7bc |

COORD-617, COORD-699 and COORD-701 originally have no commit SHA and claim `local_only`. The other ten originally claim `remote_ancestry` against a source commit, not the actual merge. The broader read-only sweep added COORD-484, COORD-731 and COORD-734 as the same defect class; it did not assume that all matching merge subjects were correct.

For COORD-699, the merge subject names COORD-753. Binding comes from COORD-699's original structured source `660ea9c6...`, not the subject. For COORD-731 and COORD-734, the initially proposed implementation merges `1d374570...` and `77189c63...` were correctly rejected: the recorded reviewed source is the later integrity-restamp commit. Their separately verified restamp merges above first introduce that recorded source. Original push receipts also name those restamp integration tips; these corroborate, but do not replace, the Git checks.

## Original-record preservation anchors

SHA-256 digests use recursively sorted object keys and preserve array ordering. Each original must remain identical at correction and after closeout.

| Ticket | Original record digest |
| --- | --- |
| COORD-479 | 3d608d9a8bd4d9dc92cf164652164b3003fb73f327c971651ff5429ac118f4e8 |
| COORD-484 | 8a4d9cb30032520eab0dafee6a5de994e8cc24e68c775b95252dbbe0a21b6969 |
| COORD-617 | 6213e139aa04fd44409009559db69b44e5eae84a5a8b42cde14a3378c5b86882 |
| COORD-618 | 007daab48ab00a6d0992679777313e45b72b5eacbc1a9e2fa3b8602413625083 |
| COORD-619 | cf0e350871efe5b0d2ee5b09f2626fd00db8a5d477c68711d0f36a939fe566a5 |
| COORD-620 | c35bd3c448d6163c9aa67e594a8197ac205516f02b47610239d46bc449fcd33a |
| COORD-696 | 368672c2725e26dfa8fa3e2a679c7101cbb111cd29c192113bb1d1183e8ba6b4 |
| COORD-697 | 9c89c213c159c9f2cb948bc2407b102ebadcca42240fdc274a819200297aece6 |
| COORD-699 | c200ebd6ff5cc7e6444fdfee8936b3d81d65418b53ad71ef206ae37f0da6a17e |
| COORD-701 | 43d871434d04d157a847a557de0f5e1446b3678fb1383102b1bed560f5b4df18 |
| COORD-706 | 731ae2d02ef82784a4f85d793ff644727bc503585b42389f796f37c81c761f6f |
| COORD-731 | e26343d25a11261df328548915d8d7fe5647e76fe6790f49cce8916607add853 |
| COORD-734 | 05a45afe138c034c7dd3b251f0ccf7e56e6a4898054ef465f5bee35ce3c51610 |

## Execution and verification

COORD-756 landed through governed merge `d96bc38f33a441f7ecfe8b3a0d8bb84c738a0827` after complete donor and dual-release verification. The installed canonical CLI then executed `gov audit-landings --ticket <id> --correct-merge <merge> --source-commit <source> --correction-ticket COORD-707 --human-admin-override "<recorded approval>" --reason "<disposition>"` in dry-run mode before each append with `--write`. Every append freshly observed origin/main at `8d372cf9fff37e5826154fa8919113a00687b3dc`.

The execution pinned this document's reviewed proposal set and digest before mutation and rejected unexpected prior correction chains. All 13 corrections were appended exactly once. A deep comparison confirmed that every one of the 86 pre-existing `landing_index` records remained unchanged, including the newer COORD-757 and COORD-756 records in addition to the original 84-record snapshot. An identical live retry for COORD-699 fetched the remote again, reported `changed: false`, and preserved the entire board byte-for-byte.

The installed audit reports all 13 effective claims as merged, while exposing their unchanged originals and separate correction arrays. Full board validation passed, journal conformance reported no broken links, and engine integrity remained in sync. Evidence: `/tmp/coord707-applied.txt`, `/tmp/coord707-live-audit.json`, `/tmp/coord707-live-conform.json`, and `/tmp/coord707-live-integrity.json`; results and final qualification receipts are recorded in the governed COORD-707 plan.

Closeout additionally requires full frozen-source donor and release qualification plus verified remote publication. These requirements are not discharged by the local append operation or by this document alone. A failed batch can leave a verified prefix applied; unchanged retries are idempotent, never rollback-by-deletion of historical records.

An appended resolved approval does not retire the older QUESTIONS queue row. Its sanctioned retirement remains COORD-695; no unrelated historical question was silently edited.
