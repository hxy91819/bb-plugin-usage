# bb-plugin-usage

BB plugin: coding-agent token usage and estimated API cost across enrolled machines.

Verification: `npm run check` (tsc), `npm test` (vitest), `npm run build` (bb plugin build).

<!-- open-source-fork-maintenance:start -->
## Local aggregate fork maintenance

This checkout is maintained as a non-maintainer fork. Its root workspace is the `local/aggregate` integration branch. It is based on the configured upstream ref and is the only checkout used for local integration, packaging, and experience. After verification, publish it to the personal fork as a reusable source snapshot; never use it for an upstream pull request.

Every product change starts on an independent `feature/*` or `fix/*` branch in its own worktree. That worktree owns implementation, tests, commits, `$autoreview` closeout, and fork publication. Invoke `$autoreview` there after development is complete; the branch is verified for aggregation only after that review reports no accepted/actionable findings. Publish every completed, verified source branch and the completed aggregate to the personal fork with normal non-forced pushes. The aggregate receives only verified commits through `git cherry-pick -x`; repair aggregate conflicts in the source worktree and reintroduce a new source commit instead of creating product-only aggregate fixes.

`config/local-aggregate-features.json` is the authoritative registry for each included branch's last packaged source commit, aggregate commit, and upstream feedback issue. Keep this overview synchronized with that registry. Every local `feature/*` and `fix/*` worktree is a default aggregation candidate once it is committed, verified, and registered.

Use `$open-source-fork-maintenance` before upstream synchronization, aggregate rebuilding, or local packaging. It checks new worktrees, source commit changes, upstream changes, and upstream feedback before asking for a rebase or packaging decision. Rebase affected source branches in their own worktrees before rebuilding the aggregate. When the user explicitly declines a rebase, incremental packaging on the existing local baseline remains allowed, but the registry must retain the previous upstream baseline and the result must report the outstanding upstream debt.

`feature/breakdown-tokens-toggle` was retired on 2026-09-30: upstream merged the equivalent change in f182aa0 (#64), so the branch carries no unique commits; its upstream feedback issue #48 is resolved upstream.

### Included branches

| Branch | Source commit | Aggregate commit | Upstream feedback |
|---|---|---|---|
| feature/additional-agent-usage | 627a416 | 958ec39, 74d4e18 | [#69](https://github.com/MayankBansal12/bb-plugin-usage/issues/69), [#75](https://github.com/MayankBansal12/bb-plugin-usage/pull/75) |
| feature/codex-profile-sessions | 0c192c0 | b0cabfc, 37345b1, d5ebfe0, fffb0c8 | [#44](https://github.com/MayankBansal12/bb-plugin-usage/issues/44) |
| fix/codebuddy-dsh-pricing | 6b3c08c | 720057e, c0934a3, 7ecc0e9 | [#70](https://github.com/MayankBansal12/bb-plugin-usage/issues/70) |
| fix/stacked-chart-boundaries | b71c7f5 | a0e8e15 | [#71](https://github.com/MayankBansal12/bb-plugin-usage/issues/71) |
| feature/copilot-session-usage | 13f5529 | 781821c, 6c74253, 6d6a3cb, b123d32 | [#72](https://github.com/MayankBansal12/bb-plugin-usage/issues/72) |
| feature/breakdown-share-donut | 98b9742 | 1f9a808, 75e142d, 584dcb4 | [#73](https://github.com/MayankBansal12/bb-plugin-usage/issues/73), [#76](https://github.com/MayankBansal12/bb-plugin-usage/pull/76) |
| feature/amp-provider-usage | ac5c484 | 2b6bba4, f9c858f, c62357d, 6f4c026, 3005b5d, 451ccc3, 8ca1b96, b240fe9, bacc24f, 65fb128 | [#74](https://github.com/MayankBansal12/bb-plugin-usage/issues/74) |
<!-- open-source-fork-maintenance:end -->
