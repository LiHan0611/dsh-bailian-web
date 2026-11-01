# @local/bailian-web

Keeps the harness's model-facing `web_search` and `web_fetch` tools, but routes
them to Aliyun BaiLian's hosted MCP services instead of the shipped providers.

| Capability | MCP server | Upstream tool | Provider id |
|---|---|---|---|
| `web_search` | `EnhancedSearch` | `search_pro` | `bailian-search` |
| `web_fetch` | `WebFetch` | `web_fetch` | `bailian-fetch` |

## Endpoints and credentials

Both endpoints are workspace-scoped BaiLian MCP gateways:

- `https://ws-u0ho7scff8sgmt4e.cn-beijing.maas.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp`
- `https://ws-u0ho7scff8sgmt4e.cn-beijing.maas.aliyuncs.com/api/v1/mcps/WebFetch/mcp`

Every request carries `Authorization: Bearer <key>`. The key is resolved per
operation, in this order:

1. the managed credential store (`ctx.credentials`, the same store the settings
   UI writes), reference `BAILIAN_API_KEY`;
2. the launching process environment, `BAILIAN_API_KEY`.

## How it plugs in

`index.js` registers a search provider and a fetch provider on `ctx.web`;
`cordis.patch.yml` pins both ids as `searchProvider` / `fetchProvider` of the
`web` row. The tool layer, prompt guidance, result formatting, and UI cards are
unchanged. Removing the bundle, or overriding the two ids again, restores the
previous backends.

## Notes

- The gateway is stateless: each response is plain JSON (no `Mcp-Session-Id`),
  and a session id is forwarded if a future deployment starts issuing one.
- The handshake runs once per provider per process and is retried after a
  transport or session rejection.
- Search results are projected onto the seam's `WebSearchSource` shape from the
  upstream `pages[]` array; fetch results use `target_status_code` and
  `content`, and an unparseable body is returned as plain text.
- The provider stays registered even when the key is missing, so the tool
  reports a structured `WEB_PROVIDER_CREDENTIAL_MISSING` error instead of
  disappearing.