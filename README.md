# Restowise status

The public status page for [Restowise](https://restowise.app): **status.restowise.app**.

- `check.mjs` runs every 5 minutes on GitHub Actions (outside Restowise, so this
  page stays up when the apps don't) and publishes plain-language results to the
  `data` branch.
- `site/` is the static page. It reads `data/current.json` and `data/history.json`
  straight from this repo.

The list of what gets checked is a repository secret, not a file here.
