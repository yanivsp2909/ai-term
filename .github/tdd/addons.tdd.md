# Part C add-on evidence

All tests use stub engines and temporary state. The real PTY fixture executes a local Node stub, never a provider or the network; its HOME is temporary. Pilot tests run /plan, /prompt and /explain once each, assert Ask/read-only starts, and separately verify approval and isolated implementation-step spawning.

| Guarantee | RED commit/evidence | GREEN commit/evidence |
| --- | --- | --- |
| Strict definitions, explicit approval, private plan saves, bounded explain chunks | 29d4545: absent core module failed contracts | 14c00f6: core contracts passed |
| All engine handoffs use Ask; read-only pilots expose constrained tools | 89fdcaf: absent argv support failed assertions | bf1925d: engine/UI integration and stub pilots passed |
| Scanner-detected entropy secrets never reach the first message; echoed markers remain pending; changed bundle metadata/extra files refuse reuse | 171f2b8: five review regressions failed | Review fix commit: all passed |
| Literal submitted placeholders survive; selected long-plan steps remain visible and pageable; actual usage appears after results | c36a556: eight accumulated review regressions failed | Review fix commit: all passed, including protocol/flow actual-usage integration |

Fresh high-effort TypeScript and security reviewers reported one HIGH and five unique MEDIUM issues, all covered above. The native loader additionally verifies the content-addressed body hash before adding bundle instructions. Full verification and review follow-up results are recorded in PROGRESS.md.
