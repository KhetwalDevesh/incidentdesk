---
name: new-feature
description: Turn a feature idea into a reviewed spec before any code is written.
argument-hint: "<feature name>"
disable-model-invocation: true
---

Feature: $ARGUMENTS

1. Read `docs/spec.md` and `docs/features/_template.md`.
2. Ask me about users, permissions, edge cases and what is out of scope. Ask one short round of questions.
3. Write `docs/features/<feature-name>.md` from the template.
4. List the API, data and security changes.
5. Stop for my review. Do not write code.
