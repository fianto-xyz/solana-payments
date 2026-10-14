# Contributing

1. `pnpm install`
2. `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm check:package`
3. Add a changeset for any user-facing change: `pnpm changeset`

Validation functions are security-sensitive: a change that relaxes a check needs a test that
shows the attack it used to block is still refused, and a clear reason in the PR.
