# Manual Acceptance Tests

Run with at least three clients: A, B, and C.

1. Start server and confirm player interaction startup log.
2. X on empty space opens nothing.
3. X on a door/container still opens access control.
4. A looks at B and sees `(X) MENU` only; no name/stranger prompt variant is displayed.
5. A looks at C near B and the prompt/menu targets C, not nearest B.
6. A presses X on B and sees only `INTRODUCE YOURSELF`, `TRADE`, `USE BINDS`.
7. A introduces to B; B sees A's current name above A's character.
8. A still sees no overhead name above B until B introduces back.
9. B introduces to A; both see overhead names above each other's characters.
10. Browser DOM does not contain hidden real names for unknown players.
11. A sends trade request to B; B sees `STRANGER WANTS TO TRADE` unless A introduced.
12. B accepts; full trade UI opens once for A and B.
13. B denies; no trade opens.
14. Request expires; no trade opens.
15. C cannot accept B's request.
16. F4 does not open nearest-player trade in production mode.
17. Direct browser `vgr:trading:request` is ignored in production mode.
18. A without cuffs sees Use Binds disabled.
19. A with one allowed cuffs item can bind B.
20. A with multiple cuff variants sees a server-provided selector.
21. Bind removes one cuff from A and adds it to B.
22. B cannot initiate trade while restrained.
23. Restrained B cannot mine, chop wood, or use emotes.
24. Original binder can remove B's bindings.
25. Ordinary unrelated C cannot remove B's bindings.
26. Access admin can force remove bindings.
27. Disconnect closes prompt/menu/request UI.
28. Cell/range change invalidates the session.
29. Mongo outage prevents successful introduction/bind mutations.
30. Native `Talk to NAME` leak prevention must be verified in the live client.
