# @pipeworx/tx-dmv

Texas DMV (TxDMV) MCP — statewide vehicle, pickup and motorcycle registration totals by
fiscal year, from TxDMV's own published series.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `tx_dmv_vehicle_registrations(fiscal_year?, limit?)` — total vehicles registered in Texas
  for a fiscal year, split into passenger cars, pickup trucks of one ton or less and
  motorcycles, each with its share of the fleet. Answers "how many vehicles are registered in
  Texas", "how many motorcycles are registered in Texas", and growth across years.

## Auth

Keyless.

## Grain and vintage — read this before quoting a number

Two things about this dataset trip people up, so both are reported on every response:

1. **Statewide only.** TxDMV publishes one row per fiscal year for the whole state. There is
   no county, city or ZIP breakdown in this series, and no make/model/fuel split. Passing
   `county`, `zip`, `make`, `model_year` or `fuel_type` returns
   `{ found: false, reason: "grain_unavailable" }` with a hint rather than silently ignoring
   the argument. For a ZIP-level fleet breakdown, `ca_dmv_vehicle_registrations` covers
   California at ZIP × make × model-year × fuel.
2. **The series stops at FY2021.** TxDMV last refreshed it on **2023-03-06**, so it covers
   **fiscal years 2001 through 2021** and recent years are simply absent. `as_of` carries the
   refresh date, `covers_fiscal_years` the span, and a `note` says so in words. Asking for
   `fiscal_year="2024"` returns `fiscal_year_unavailable` rather than an empty row list.

`total_vehicles` is only set when a single fiscal year is requested, because that row genuinely
is the whole Texas fleet for that year. Rows from different fiscal years are **not** summed:
they are cumulative snapshots of largely the same vehicles, so a sum would double-count every
car that stayed registered.

Verified live 2026-07-29: FY2001 `total_all_vehicles_registered` = 17,906,116;
FY2021 = 25,236,442.

## Data sources

- `https://data.texas.gov/resource/cbmj-zeje.json` — TxDMV "Passenger Vehicle, Motorcycle,
  and Pickup Truck Registrations by Year". 21 rows, FY2001–FY2021.
- `https://data.texas.gov/api/views/cbmj-zeje.json` — `rowsUpdatedAt`, used for `as_of`.

The three `*_of_all_vehicles` columns are fractions of 1 (`0.5831`), not percentages; the pack
converts them to percentages. `fiscal_year` is stored as text, so it is filtered with a string
equality and ordered as a string — which is safe for four-digit years.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "tx-dmv": {
      "url": "https://gateway.pipeworx.io/tx-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/tx-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Tx Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
