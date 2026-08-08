# G112-G115 CodeQL Advanced closure

- implementation head: `702ae09e78c03d9590d316cc465b1bd30cb72a95`
- merged main head: `9c5dbc7e16438d2ba06c9220cd246aa532fa090b`
- exact-head PR run: `31270764773` — actions, JavaScript/TypeScript, Rust passed
- post-merge main run: `31271264847` — actions, JavaScript/TypeScript, Rust passed

The post-merge analyses registered on `refs/heads/main` as:

- actions: analysis `1590291634`
- JavaScript/TypeScript: analysis `1590292197`
- Rust: analysis `1590293759`

The open-alert query returned zero alerts. Alert `266` was not dismissed; its
most recent instance reports `state: fixed`.

The analysis list reported legacy PR-head default-setup analyses `1589878810`,
`1589879309`, and `1589880754` as `deletable:true`. A DELETE request without
`confirm_delete` nevertheless returned HTTP 400 for each with the message that
it was the last analysis of its type and deletion could lose historical alert
data. No confirmation override was used; all three remain present. Older main
default-setup records also remain because the list marked them
`deletable:false`.

CodeQL Advanced status: **PASS / NON-BLOCKING**.
