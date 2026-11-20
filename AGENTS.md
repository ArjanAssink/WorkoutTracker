# Agents

The operating guide for this repository is `CLAUDE.md` — project state, how to deploy and
verify, where the data comes from, the scoring decisions, and what is in flight. Read it
first; it is written to let a fresh session continue without the previous conversation.

## Source control and deployment — required

- Commit all completed source, asset, test, and documentation changes and push them to GitHub. A deployment alone does not publish source changes.
- Preserve existing local commits as individual commits. Do not squash, rebase, amend, or otherwise rewrite them unless the user explicitly requests it. Verify every new commit is reachable on GitHub before reporting completion.
- Every deployment must run through the repository's GitHub Actions Deploy workflow (`.github/workflows/deploy.yml`), from committed and pushed code. Use the push-to-`main` trigger or `workflow_dispatch`.
- Never deploy directly to Azure from this workspace or a local machine: do not use zip deployment, `az functionapp deployment source config-zip`, `func azure functionapp publish`, or another direct upload as a shortcut or fallback.
- If Actions is disabled, missing credentials, failing, or awaiting approval, fix the workflow prerequisites where authorized or report the precise blocker. Do not bypass Actions with a direct deployment.
- After deployment, verify the Actions run succeeded for the intended commit and check the live application. Report source publication, workflow status, and live verification separately; never call a skipped workflow a successful deployment.
