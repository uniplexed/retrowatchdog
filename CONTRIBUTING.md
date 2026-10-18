# Contributing

Thank you for considering a contribution. RetroWatchdog is a personal project
published under the AGPL-3.0, and also offered under a commercial license by
its author (see `COMMERCIAL-LICENSE.md`). To keep that possible, every
contribution comes with a short agreement.

## Contributor license agreement

By submitting a contribution (a pull request, a patch, or code sent any other
way) you agree that:

1. You wrote it, or have the right to submit it under these terms.
2. You grant the project's author a perpetual, worldwide, irrevocable,
   royalty-free license to use, modify, distribute and sublicense your
   contribution under any license, including commercial ones, together with
   the rest of the project.
3. Your contribution is also published under the project's open-source
   license (AGPL-3.0), like everything else here.

You keep the copyright of your work; you are granting rights, not giving it
away. If you cannot agree to this, please open an issue describing the change
instead of sending code. The plugins, in their own repositories, are AGPL-3.0
only and ask for no such agreement.

## Legal notes

A new source, or a change to what a source is asked for, must update
[LEGAL.md](LEGAL.md): what that source's terms say, when they were read, and
what they mean for whoever runs the app. A plugin's manifest states the same
in its `caveat`, which the app shows under the source's prices.

## How to contribute

- **Bugs and ideas:** open an issue. Say what you did, what you expected and
  what happened; a screenshot helps.
- **A new price source:** write a plugin in its own repository. The
  [protocol](docs/sidecar-protocol.md) documents the contract; the three
  existing plugins are the examples.
- **Code:** fork, branch, add or update the tests for what you change, run
  `pnpm -r test` and `pnpm -r typecheck`, and open a pull request against
  `main`. Keep the change focused and explain the why in the description.

Code, comments and documentation are in English.

## Security

Do not open a public issue for a security problem. Use GitHub's "Report a
vulnerability" on this repository instead.
