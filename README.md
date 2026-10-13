# epoch-sync-gate

Gated verify-and-push for patch series headed to [epoch-sync](https://github.com/FL343/epoch-sync).

A patch series is pushed to epoch-sync only after:

1. **fetch**: the merge gate (pinned by fingerprint in `gate.json`) says the batch is waiting only on the epoch-sync push;
2. **test**: the series applies on epoch-sync `main`, its tests pass under four clocks, and the combined tree passes —
   all run as an unprivileged user with no access to any push credential;
3. **review**: an independent reviewer approves the protected `push` environment (it can only block, never relax a check);
4. **push**: commit messages and files pass the public-data checks, then the series is pushed and a signed mark is
   produced so the merge gate can verify the push really happened.

Dry runs stop after step 2 and keep the would-be result as `shadow/<batch>` for comparison.

Everything here is deployed from the maintainer's machine; workflow runs are started by `workflow_dispatch` only.
Logs that could contain private text are sealed before upload.
