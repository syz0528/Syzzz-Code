# Historical Scripts

The scripts in this directory are archived diagnostic artifacts. They are not
part of the formal test suite and must not be run by default.

Important limitations:

- Some scripts read `~/.syzzz-code/config.json`.
- Some scripts make real network requests and may incur charges.
- They do not correctly support every provider protocol.
- Their output and pass/fail status are not release evidence.
- They must never print API keys or key prefixes.

Use `npm test` for the isolated, repeatable test suite.
