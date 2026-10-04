# Contributing

Install dependencies with `npm ci` and `npm ci --prefix demo`.

Before submitting a change, run:

```sh
npm run format
npm run check
npm test
npm run check --prefix demo
npm test --prefix demo
```

Keep code readable: one statement per line, a blank line between logical phases, and function calls on one line when they fit. Keep provider-specific behavior in `src/providers/<provider>` and update [compatibility notes](docs/compatibility.md) when support changes.

Use Conventional Commits: `fix:` for patches, `feat:` for features, and `!` or `BREAKING CHANGE:` for breaking changes. These drive npm versions and Git tags through [semantic-release](docs/releasing.md).

Bug reports should include the provider, model, package version, and a minimal reproduction. Remove credentials, saved login state, and personal account details from logs and screenshots.
