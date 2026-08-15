# Manual Acceptance Tests

Use this checklist on a running server with MongoDB and at least two test characters.

1. X does nothing when the crosshair is not on a door or container.
2. X does nothing while a native menu or text input is open.
3. X on an unmanaged door as a non-admin shows no management controls.
4. X on an unmanaged door as an access admin offers Register.
5. Register a teleport door and confirm both refs appear in Identity.
6. Register a non-teleport door and confirm it has one ref.
7. Register a container and confirm it has one ref.
8. Assign an owner by searching a partial name.
9. Search rejects fewer than two characters.
10. Search returns at most 20 results.
11. Search treats regex characters as plain text.
12. Owner can open management with X.
13. Owner cannot add a user by profile search unless also access admin.
14. Owner cannot assign or remove owner unless also access admin.
15. Admin can assign and remove owner.
16. Owner can remove a user.
17. Owner, keyholder, and access administrator cannot activate a locked object through normal activation.
18. Unlisted player cannot activate a locked object.
19. Unlocked managed object activates normally for everyone.
20. Locking an unlocked object immediately blocks later activation until it is unlocked through management.
21. Looking at a locked managed object shows red locked owner hint without opening the `X` menu.
22. Looking at an unlocked managed object shows yellow unlocked owner hint without opening the `X` menu.
23. Pressing normal Activate on a locked object is blocked without showing a duplicate locked toast.
24. Opening the `X` access-control menu hides the passive locked/unlocked owner hint.
25. Toggling lock state in the management UI does not show a duplicate `Object locked/unlocked` toast.
26. Admin owner controls show `Assign` when no owner exists and `Replace` when an owner exists.
27. Admin owner controls do not expose a normal `Remove` button that leaves the object unassigned.
28. Selecting the current owner again is rejected as already assigned.
29. Object owner can remove a user/keyholder from guest access.
30. Non-owner guest/keyholder cannot remove another user's guest access.
31. Access admin can add a user/keyholder by profile search.
21. Revoking a user closes or refreshes their open management view.
22. Two viewers see updated revision after a mutation.
23. Stale session mutation is rejected after 60 seconds idle.
24. Target session expires after 15 seconds without use.
25. Session expires after 5 minutes absolute time.
26. Moving away from the target before mutating is rejected.
27. Cross-cell mutation is rejected.
28. Mongo startup failure blocks supported door/container activation.
29. Mongo runtime write outage disables mutations but enforces cached locks.
30. Taking or putting items in containers continues through the existing inventory system.
31. Legacy migration dry run writes no target documents.
32. Legacy migration with `--commit` is idempotent and leaves legacy source intact.
33. Door probe remains disabled unless configured.
34. Door probe writes no database state.
35. Browser `isAdmin` spoofing has no effect.
