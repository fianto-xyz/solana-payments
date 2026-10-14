# AGENTS.md

Notes for anyone (human or tool) changing this repository.

## Commands

- `pnpm install` once, then:
- `pnpm build` (tsdown into `dist/`), `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `pnpm check:package` (publint, attw, size-limit), `pnpm check:readme` (README `ts` blocks typecheck), `pnpm examples`
- `pnpm changeset` for any user-facing change

## Conventions

- Amounts are `bigint` base units. Never use floating point for money.
- Tests sit beside their source as `*.test.ts`.
- Validators return `{ ok: false, reason }` and never throw; a new refusal gets a new string literal in the union type.
- Never loosen an assertion or a validation check to make a test pass. A change that relaxes a check needs a test showing the attack it blocked is still refused.
- Three entry points: `src/index.ts`, `src/subscriptions/index.ts`, `src/money/index.ts`. `/money` imports no Solana code.
- Imports inside `src/` use `.js` extensions.
- Every `ts` block in README.md must typecheck against `dist/`.
