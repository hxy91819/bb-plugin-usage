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
| feature/additional-agent-usage | 4841976 | 2945262 | [#69](https://github.com/MayankBansal12/bb-plugin-usage/issues/69), [#75](https://github.com/MayankBansal12/bb-plugin-usage/pull/75) |
| feature/codex-profile-sessions | ce1b717 | ec27704 | [#44](https://github.com/MayankBansal12/bb-plugin-usage/issues/44), [#81](https://github.com/MayankBansal12/bb-plugin-usage/pull/81) |
| fix/codebuddy-dsh-pricing | af5bbff | 2aea58f | [#70](https://github.com/MayankBansal12/bb-plugin-usage/issues/70), [#79](https://github.com/MayankBansal12/bb-plugin-usage/pull/79) |
| fix/stacked-chart-boundaries | 500d6fd | d49a0b5 | [#71](https://github.com/MayankBansal12/bb-plugin-usage/issues/71), [#77](https://github.com/MayankBansal12/bb-plugin-usage/pull/77) |
| feature/copilot-session-usage | 5a31cde | bb27fbd | [#72](https://github.com/MayankBansal12/bb-plugin-usage/issues/72), [#78](https://github.com/MayankBansal12/bb-plugin-usage/pull/78) |
| feature/breakdown-share-donut | 654df6b | bce5839 | [#73](https://github.com/MayankBansal12/bb-plugin-usage/issues/73), [#76](https://github.com/MayankBansal12/bb-plugin-usage/pull/76) |
| feature/amp-provider-usage | 481729f | d9b862d | [#74](https://github.com/MayankBansal12/bb-plugin-usage/issues/74), [#80](https://github.com/MayankBansal12/bb-plugin-usage/pull/80) |
<!-- open-source-fork-maintenance:end -->
