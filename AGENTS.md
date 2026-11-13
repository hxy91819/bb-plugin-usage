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

`fix/security-dependency-bumps` was retired on 2026-11-06: upstream merged it as bef704c (#94, v0.3.27), which is now the aggregate baseline, so the branch carries no unique behavior.

### Included branches

| Branch | Source commit | Aggregate commit | Upstream feedback |
|---|---|---|---|
| feature/additional-agent-usage | 4a7fc72 | 24f6a98 | [#69](https://github.com/MayankBansal12/bb-plugin-usage/issues/69), [#75](https://github.com/MayankBansal12/bb-plugin-usage/pull/75) |
| feature/codex-profile-sessions | f2fa0eb | a57b8dd | [#44](https://github.com/MayankBansal12/bb-plugin-usage/issues/44), [#81](https://github.com/MayankBansal12/bb-plugin-usage/pull/81) |
| fix/codebuddy-dsh-pricing | 6b9666b | 6a730bb | [#70](https://github.com/MayankBansal12/bb-plugin-usage/issues/70), [#79](https://github.com/MayankBansal12/bb-plugin-usage/pull/79) |
| fix/stacked-chart-boundaries | 92cb456 | 49440c3 | [#71](https://github.com/MayankBansal12/bb-plugin-usage/issues/71), [#77](https://github.com/MayankBansal12/bb-plugin-usage/pull/77) closed — superseded by feature/daily-stacked-bars; retained as a historical stack prerequisite |
| feature/breakdown-share-donut | 87ca1cc | c5c4a51 | [#73](https://github.com/MayankBansal12/bb-plugin-usage/issues/73), [#76](https://github.com/MayankBansal12/bb-plugin-usage/pull/76) |
| feature/amp-provider-usage | f4a047f | 596c6e7 | [#74](https://github.com/MayankBansal12/bb-plugin-usage/issues/74), [#80](https://github.com/MayankBansal12/bb-plugin-usage/pull/80) |
| feature/daily-stacked-bars | ad45cef | 35b9302 | [#82](https://github.com/MayankBansal12/bb-plugin-usage/issues/82), [#83](https://github.com/MayankBansal12/bb-plugin-usage/pull/83) |
| fix/amp-initial-machine-latest | d00dda3 | 9236b3f | [#87](https://github.com/MayankBansal12/bb-plugin-usage/pull/87) |
| fix/amp-local-default | d00dda3 | 9236b3f | [#87](https://github.com/MayankBansal12/bb-plugin-usage/pull/87) includes this change; [#88](https://github.com/MayankBansal12/bb-plugin-usage/pull/88) closed as consolidated |
| fix/usage-skeleton-bars | 8944f59 | 35b9302 | [#83](https://github.com/MayankBansal12/bb-plugin-usage/pull/83) includes this change; [#89](https://github.com/MayankBansal12/bb-plugin-usage/pull/89) closed as consolidated |
| fix/cursor-sdk-token-accounting | f3f3718 | 1766383 | [#86](https://github.com/MayankBansal12/bb-plugin-usage/pull/86) |
| fix/dsh-v4-sessions | f2a3959 | 4b382b8 | Not submitted upstream |
| feature/usage-trends | 42655b9 | 6eda09e | Not submitted upstream |
| fix/codex-routing-model-prefix | b99dc05 | b703300 | Not submitted upstream |
| fix/hono-4.13.16 | 9c6e5a4 | 5398129 | [#96](https://github.com/MayankBansal12/bb-plugin-usage/pull/96) |
<!-- open-source-fork-maintenance:end -->
