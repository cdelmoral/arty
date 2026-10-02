# Domain docs

This repo uses a single-context domain model.

## Before exploring

- Read `GLOSSARY.md` at the repo root.
- Read ADRs under `docs/adr/` that affect the area you are about to change.

If either location does not exist, proceed without calling attention to it. The `/domain-modeling` skill creates these files when the project resolves a term or decision.

## File structure

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, proposal, hypothesis, or test name, use the term defined in `GLOSSARY.md`. Do not replace defined terms with synonyms.

If a needed concept is missing, reconsider whether the project uses that language. If it is a real gap, note it for `/domain-modeling`.

## Flag ADR conflicts

If work contradicts an existing ADR, state the conflict instead of overriding the decision silently:

> Contradicts ADR-0007, event-sourced orders, but worth reopening because...
