---
paths:
  - "src/domain/**"
  - "src/services/**"
  - "src/repository/**"
  - "src/containers/**"
---

# Architecture rules

Reference: the `incidents` module.

## Do

- Declare a port in `src/domain/<module>/types.ts` before writing the implementation.
- Depend on ports. Only `src/containers/` chooses a concrete class.
- Return `Result<T>` for expected failures, such as not found or forbidden.
- Throw only for bugs and infrastructure failures. `app.onError` turns them into a 500.
- Inject time and randomness when a test needs to control them.
- Split a port into reader and writer when callers need only one side.

## Don't

- Don't import `src/http`, `src/routes`, `src/repository` or `src/containers` from domain or services. `pnpm enforce` check 2 fails this.
- Don't import application code into `src/contract`. Check 3 fails this.
- Don't read `process.env` outside `src/config.ts`. Check 1 fails this.
- Don't add a helper for one caller.

## Every new repository

Ship an in-memory version and a parity test that runs the same calls against both implementations. In-memory doubles that drift from the real database make tests pass while production fails.
