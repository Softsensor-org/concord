# ADR-0016 acceptance baseline packet

Generated 2026-10-15T03:44:31.171Z by claudea767 for COORD-838 from branch agent/claudea767-coord-838-record-adr-0016-as-accepted-the-human-ad (working tree on top of 87cb6ceea2ca). These are the exact bytes that will be under coord/docs/decisions/ on dev once the COORD-838 PR lands, and the complete set the packet-bound gov reconcile may adopt. Any added, missing or changed path must refuse.

| # | path | sha256 |
|---|---|---|
| 1 | coord/docs/decisions/0001-resource-aware-multi-agent-test-architecture.md | ab228393cf0115da59cfb0bee15b3743c26d5f1963f8fce5b2e2eb620587261d |
| 2 | coord/docs/decisions/0002-canonical-ephemeral-runtime-boundary.md | b1994307eb46565db2a37adda81003dc235289034e218238022eddc52485259d |
| 3 | coord/docs/decisions/0003-governed-human-writes-use-trusted-sso-actors-and-the-coord-verb-layer.md | 65679e0ca5506a3bc0e1e0807a9de9518d9f208a2dffa59141e812bbbd61ef3a |
| 4 | coord/docs/decisions/0004-precision-first-governed-memory-kernel.md | 2a9ab2f151b2e8232e870998d46ff5bd01b0cbdca65002863c6052d76b6c7e2c |
| 5 | coord/docs/decisions/0005-agent-session-identity-uses-owner-lease-over-directory-locks.md | 542ebc5c6ad88a7d81fb4d3c7440c364c7db802d6ac0e32889dcc921fb346c76 |
| 6 | coord/docs/decisions/0006-engine-pin-verifies-drift-without-signing-in-community.md | 02d77059fb48a322a644d804aae98d248b021a3fa434c5124ef74d466b462002 |
| 7 | coord/docs/decisions/0007-installer-transactions-use-a-target-local-write-ahead-ledger-with-on-dis.md | c5b9ce46e1548dd0a24bd35654a5c6344aa0e46a822b5d7da42efd813ac33671 |
| 8 | coord/docs/decisions/0008-adopter-workspaces-use-a-non-git-container-and-an-independent-coord-cont.md | c1b9192475064e1c0bb061d6aec9b240b4ce58d35a6601840fd900c205bbc8ca |
| 9 | coord/docs/decisions/0009-control-plane-and-cross-repository-work-use-distinct-ticket-targets.md | 078ee4574a8acc0bec802fce6167e2b71de1a722390ec1f27eae9e4fac8e3e0d |
| 10 | coord/docs/decisions/0010-install-recovery-treats-its-own-write-ahead-ledger-and-mutex-as-untruste.md | 95b3c8a1c991fcd92f04d905f31b469762720f5638cd41de580a07b6706333f3 |
| 11 | coord/docs/decisions/0011-business-discovery-reads-an-adopter-project-config-statically-and-neve.md | 9aff269adb5968ae44f2e541b3d2b2da0e609ff93d8c0355600ea85267cf89a8 |
| 12 | coord/docs/decisions/0012-the-open-core-commercial-boundary-is-enforced-by-build-not-by-license.md | ca2433eee7047e5d2060e42e974a02ef246ff95b5087c1b80ab49aa2edadec28 |
| 13 | coord/docs/decisions/0013-engine-project-filesystem-seam.md | 512dde21917f1c36f45f32876e92465c7ec94116458323fea08974e48cda6f4f |
| 14 | coord/docs/decisions/0014-stable-leading-token-for-governed-claude-lifecycle-commands.md | 866f393751e0f2aa2b6f46be42257fb9d7b9e3bfa2fcf1856728ffae33763178 |
| 15 | coord/docs/decisions/0015-agent-writing-is-bounded-context-artefact-handoff-and-short-lived.md | c41717fd9523944c395d823b0cc957cd7554a28f969bb03e8f25c0b78ebf83fb |
| 16 | coord/docs/decisions/0016-bounded-static-source-parsing-ships-with-the-engine.md | 4549759ca4efe6be871dcd08392d86c0e50b4dd7e888308d14bfcec691a2dea9 |
| 17 | coord/docs/decisions/README.md | 6c282c14bd28fc89f5b32ac838dd5451890f806a7bcfab639aa5bf1905b08893 |

Differs from the COORD-722 baseline approved on 2026-10-14 (coord/docs/evidence/COORD-722-adr-baseline-packet.md) in exactly two paths:

- coord/docs/decisions/0016-bounded-static-source-parsing-ships-with-the-engine.md: 9111e6632811ccb9b66791760512736a5dd82e0d3ceefac04fbb7f83f0eab603 -> 4549759ca4efe6be871dcd08392d86c0e50b4dd7e888308d14bfcec691a2dea9
- coord/docs/decisions/README.md: 2cef77fa0d0ca5b9df688b8ce08f021cce14a72d01b1ce6c48c616f2f17b7e30 -> 6c282c14bd28fc89f5b32ac838dd5451890f806a7bcfab639aa5bf1905b08893

The only content changes are the ADR-0016 status line (Proposed -> Accepted) and the 0016 row of the decisions index (Proposed -> Accepted).
