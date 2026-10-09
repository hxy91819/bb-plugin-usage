# bb-plugin-usage

BB plugin: coding-agent token usage and estimated API cost across enrolled machines.

Verification: `npm run check` (tsc), `npm test` (vitest), `npm run build` (bb plugin build).

<!-- open-source-fork-maintenance:start -->
## Local aggregate fork maintenance

This checkout is maintained as a non-maintainer fork. Its root workspace is the `local/aggregate` integration branch. It is based on the configured upstream ref and is the only checkout used for local integration, packaging, and experience. After verification, publish it to the personal fork as a reusable source snapshot; never use it for an upstream pull request.

Every product change starts on an independent `feature/*` or `fix/*` branch in its own worktree. That worktree owns implementation, tests, commits, `$autoreview` closeout, and fork publication. Invoke `$autoreview` there after development is complete; the branch is verified for aggregation only after that review reports no accepted/actionable findings. Publish every completed, verified source branch and the completed aggregate to the personal fork with normal non-forced pushes. The aggregate receives only verified commits through `git cherry-pick -x`; repair aggregate conflicts in the source worktree and reintroduce a new source commit instead of creating product-only aggregate fixes.

`config/local-aggregate-features.json` is the authoritative registry for each included branch's last packaged source commit, aggregate commit, and upstream feedback issue. Keep this overview synchronized with that registry. Every local `feature/*` and `fix/*` worktree is a default aggregation candidate once it is committed, verified, and registered.

Use `$open-source-fork-maintenance` before upstream synchronization, aggregate rebuilding, or local packaging. It checks new worktrees, source commit changes, upstream changes, and upstream feedback before asking for a rebase or packaging decision. Rebase affected source branches in their own worktrees before rebuilding the aggregate. When the user explicitly declines a rebase, incremental packaging on the existing local baseline remains allowed, but the registry must retain the previous upstream baseline and the result must report the outstanding upstream debt.

`feature/breakdown-tokens-toggle` was retired on 2026-09-30: upstream merged the equivalent change in f182aa0 (#64), so the branch carries no unique behavior; its upstream feedback issue #48 is resolved upstream.

`feature/copilot-session-usage` is covered completely by upstream 4c5e1bb (#78) and is no longer replayed in the aggregate. Its source branch remains available for history.

### Included branches

| Branch | Source commit | Aggregate commit | Upstream feedback |
|---|---|---|---|
| feature/additional-agent-usage | 5c3a34c | 04b01d9 | [#69](https://github.com/MayankBansal12/bb-plugin-usage/issues/69), [#75](https://github.com/MayankBansal12/bb-plugin-usage/pull/75) |
| feature/codex-profile-sessions | 30673a8 | 609944b | [#44](https://github.com/MayankBansal12/bb-plugin-usage/issues/44), [#81](https://github.com/MayankBansal12/bb-plugin-usage/pull/81) |
| fix/codebuddy-dsh-pricing | 59bea66 | e6b3e3f | [#70](https://github.com/MayankBansal12/bb-plugin-usage/issues/70), [#79](https://github.com/MayankBansal12/bb-plugin-usage/pull/79) |
| fix/stacked-chart-boundaries | 6c8f735 | 51148e4 | [#71](https://github.com/MayankBansal12/bb-plugin-usage/issues/71), [#77](https://github.com/MayankBansal12/bb-plugin-usage/pull/77) closed — superseded by feature/daily-stacked-bars; retained as a historical stack prerequisite |
| feature/breakdown-share-donut | b951c32 | 7eb4e0a | [#73](https://github.com/MayankBansal12/bb-plugin-usage/issues/73), [#76](https://github.com/MayankBansal12/bb-plugin-usage/pull/76) |
| feature/amp-provider-usage | afcad95 | f3bbf73 | [#74](https://github.com/MayankBansal12/bb-plugin-usage/issues/74), [#80](https://github.com/MayankBansal12/bb-plugin-usage/pull/80) |
| feature/daily-stacked-bars | 6b3d545 | e012096 | [#82](https://github.com/MayankBansal12/bb-plugin-usage/issues/82), [#83](https://github.com/MayankBansal12/bb-plugin-usage/pull/83) |
| fix/amp-initial-machine-latest | 59b307e | 0b72dc9 | [#87](https://github.com/MayankBansal12/bb-plugin-usage/pull/87) |
| fix/amp-local-default | 902c5c7 | feb1517 | [#88](https://github.com/MayankBansal12/bb-plugin-usage/pull/88) |
| fix/usage-skeleton-bars | 3fce600 | 085b260 | [#89](https://github.com/MayankBansal12/bb-plugin-usage/pull/89) |
| fix/cursor-sdk-token-accounting | 169eba2 | 12b5897 | [#86](https://github.com/MayankBansal12/bb-plugin-usage/pull/86) |
<!-- open-source-fork-maintenance:end -->
