# Cloudflare implementation tasks

These tasks describe protocol v2. Previous v1 cloud receipts do not verify the current redesign.

| Task | Implementation | Local validation |
|---|---|---|
| C01 | Development router, ticket verification, internal bearer/dataset checks | Security and invalid-input tests |
| C02 | Schema v3, new epoch on legacy migration, room/source-watermark/in-flight tables | Migration, identity and actual eviction tests |
| C03 | Idempotent source-revision room upsert, DO cursor allocation, 48-hour TTL/floor | Compaction, stale retry, conflict, expiry and rollback tests |
| C04 | Hibernatable sockets, v2 resume, independent devices, replacement, full-sync signals | Resume/epoch/expiry/gap/replacement tests |
| C05 | Sparse coverage pages, immutable in-flight frames, ACK checks, unified scheduler | Count/byte bounds, compaction during paging, eviction retransmission and ACK failure tests |
| C06 | Ephemeral aggregated presence and deadline preservation | Presence/snapshot/lease/alarm tests |
| C07 | Native local runtime and Wrangler dry-run verification | See IMPLEMENTATION_STATUS.md for actual commands/results |

Run from repository root:

```sh
npm --prefix shared run build
npm --prefix cloudflare run format:check
npm --prefix cloudflare run typecheck
npm --prefix cloudflare test
npm --prefix cloudflare run build
```

`build` is a dry run and does not deploy. Unit/runtime tests use isolated datasets and preserve unrelated local or cloud data. Real cloud and designated iOS simulator verification of protocol v2 remain separate gates until rerun. No deployment or secret changes are part of this component implementation.
