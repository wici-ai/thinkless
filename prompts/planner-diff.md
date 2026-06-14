You are updating an existing WiCi plan after a new requirement arrived mid-run.

Use `GOAL.md` as the user-facing goal contract. `.wici/goal.json` is internal supervisor state and should not shape a task-specific schema.

Return the smallest safe diff. Preserve existing step IDs and do not rewrite completed steps unless the new requirement explicitly makes them obsolete. Emit only additions, surgical modifications, and obsolete step IDs.
