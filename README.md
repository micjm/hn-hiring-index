# HN Hiring Index

Monthly, seasonally adjusted index of the Hacker News job market, built from
top-level comment counts in the "Who is hiring?" and "Who wants to be hired?"
threads. Higher = worse for job seekers (more seekers per employer post).

**Live page:** https://micjm.github.io/hn-hiring-index/ — this is the page
linked from the blog post at micjm.com, and the one kept up to date.

## Updating

The page updates itself via
[`.github/workflows/refresh-index.yml`](.github/workflows/refresh-index.yml):

- It runs on a schedule at 09:17 UTC on the 22nd–28th of each month. A month
  only enters the index 21 days after its thread is posted, so that window is
  when the headline number changes.
- Each run refetches the HN/Algolia data (`npm run build`), rebuilds the
  static site into `docs/` (`npm run build:static`), commits any substantive
  change back to `main`, and deploys `docs/` to GitHub Pages.
- Runs whose only diff is a `generated_at` timestamp (or the in-progress
  month's ever-ticking `age_hours`) are discarded, so no-change days create
  neither commits nor deployments.
- It can also be run on demand from the Actions tab ("Refresh HN Hiring
  Index" → "Run workflow"), and it redeploys on pushes that touch
  `scripts/**`, `package.json`, or the workflow itself.

GitHub Pages must be configured with **Settings → Pages → Source: GitHub
Actions** for the deploy step to work (the workflow commits with
`GITHUB_TOKEN`, and such pushes do not trigger a branch-based Pages build).

> **One-time setup order matters.** If Pages is currently set to deploy from
> the `main` branch's `/docs` folder, do not switch the source until Actions
> jobs can actually start on this account: switching disconnects the working
> branch deployment, and until a workflow run succeeds nothing new will
> publish. First make sure a workflow run can start, then switch the source
> to GitHub Actions, then run this workflow once from the Actions tab.

To refresh by hand locally instead:

```sh
npm run build        # fetch + plots + index
npm run build:static # regenerate docs/
npm start            # preview at http://127.0.0.1:3000
```

Only top-level comments (`parent_id = story_id`) are counted; nested replies
under listings are excluded. See the methodology page on the live site for
details.
