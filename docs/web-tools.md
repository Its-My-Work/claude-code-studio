# Web access for bots (`web` MCP server)

Bots and agents have no web tools of their own. The CLI's built-in `WebSearch` runs on Anthropic's
side and `WebFetch` summarises with a small Claude model, so neither works behind a gateway that
serves other models. The `web` server is an ordinary client-side MCP server, so it works with any
model.

| Tool | What it does |
|---|---|
| `web_search` | asks a [SearXNG](https://docs.searxng.org/) instance: titles, URLs and snippets (`query`, `limit`, `time_range`, `language`, `page`) |
| `web_fetch` | reads **one** page as text: HTML is reduced to readable text, JSON/XML/plain text as is; long pages are paged with `start` (`url`, `max_chars`, `start`, `links`) |

## Turning it on

1. Run a SearXNG instance the app can reach, with the JSON format enabled and no limiter (it is meant
   to be internal only, never published). Minimal `settings.yml`:

   ```yaml
   use_default_settings: true
   server:
     secret_key: "<random>"
     limiter: false
     image_proxy: false
   search:
     formats: [html, json]
   engines:            # DuckDuckGo answers datacenter IPs with a CAPTCHA
     - name: duckduckgo
       disabled: true
   ```

2. Set `WEB_SEARCH_URL` for this app, e.g. `WEB_SEARCH_URL=http://main_searxng:8080`, and restart.
   Empty (the default) means there is no `web` server at all.

A `web` entry then appears in the **MCP** list like any other server: switch it on per chat there, and
edit or override it with a config entry of the same id. It is **not** available to unattended tasks
unless you also add it to `config.json`.

## Giving it to one bot only

The bot editor has an **MCP servers** list. Ticked servers are added to whatever the chat has
switched on, for that bot only, in a room, in `@`-mentions and in the subscription engine. Give
`web` to bots that read (a researcher, an architect) and not to ones that also run commands or edit
files: a page can contain text written to look like instructions.

## What it refuses, and why

`web_fetch` takes a URL from a model, i.e. from whatever text the model has read, on a host where a
URL can point at the panel, at other containers, at cloud metadata.

- Only `http` / `https`, no credentials in the URL, no `localhost` / `.local` / `.internal` names.
- **Every** address a name resolves to must be public (loopback, private, link-local, CGNAT,
  multicast, reserved, IPv4-mapped/NAT64/6to4 IPv6 forms are refused), for the URL, for **every
  redirect hop**, and at connection time with the same, already checked lookup — so a DNS answer
  cannot change between check and connect. Each request opens its own connection: a socket kept
  alive for another request (the search backend's, say) is never reused.
- Body limited to 2 MiB **after** decompression, whole request to 15 s, at most 5 redirects, text-like
  content types only (no PDF / binary), 60 calls per run.
- Tool output is labelled untrusted and the server instructions tell the model never to follow
  instructions found in a page and never to put secrets into a URL or query. That is a mitigation,
  not a guarantee.

Limits are `WEB_FETCH_MAX_BYTES`, `WEB_FETCH_TIMEOUT_MS`, `WEB_MAX_CHARS`, `WEB_MAX_CALLS`.

## Tests

`node test/mcp-web.test.js` (protocol, refusals, redirects, size/time limits, a gzip bomb, the
kept-alive-socket case, wiring) and `node --test test/render/bot-mcp.test.mjs` (the editor list).
