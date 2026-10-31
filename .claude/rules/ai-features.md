---
paths:
  - "src/**/ai/**"
  - "docs/features/*ai*.md"
---

# Rules for AI features in the product

For incident summaries, severity suggestions and postmortem drafts.

## Do

- Treat alert text as untrusted input. It can contain prompt injection.
- Keep untrusted text clearly separated from instructions in every prompt.
- Validate model output with a Zod schema before using it.
- Redact secrets and personal data before sending anything to a model.
- Label AI output as a suggestion, and record the model used.
- Keep the incident flow working when the AI call fails or times out.

## Don't

- Don't let model output close, resolve or change an incident without a human confirming it.
- Don't give a model tools that can write tenant data.
- Don't put one tenant's data in a prompt for another.
- Don't log full prompts that contain customer data.
