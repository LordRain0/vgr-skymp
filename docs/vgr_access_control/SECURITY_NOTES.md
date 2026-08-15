# Security Notes

- The browser never supplies or proves admin state. Admin authority is computed only on the server from `profileId`, Discord ID, and Discord roles already attached to the actor by the server login path.
- Access records store owners and users by stable `profileId`, not actor form description.
- Session IDs are generated with `crypto.randomBytes`.
- Every mutating request requires a live server session, target reach validation, and current revision.
- Locked managed objects deny normal activation for everyone. Owner/admin authority only allows management through the `X` UI, not direct `E` activation bypass.
- Object mutation failures caused by database outage disable further writes while preserving cached enforcement.
- Startup without MongoDB readiness blocks supported door/container activation rather than allowing unknown protected objects.
- Offline search escapes user input and uses bounded prefix regex queries with a result limit of 20.
- The new implementation does not install `mp.onTakeItem` or `mp.onPutItem` handlers.
