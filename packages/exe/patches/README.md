# Patches to third-party components

## `claude-auth-proxy-provider-tools.patch`

Against [`ansg191/claude-auth-proxy`](https://github.com/ansg191/claude-auth-proxy)
at revision **`a62318f9`**, file `claude-auth-transform/src/transforms.rs`.

### What it fixes

The proxy obfuscates tool names before forwarding, which is reasonable for
tools an agent defines: the upstream never needs to see what a customer called
their internal tool.

It is wrong for Anthropic's **provider-defined** tools. Those carry a versioned
type (`web_search_20250305`) and are validated by name upstream, so renaming
`web_search` gets the whole request rejected with:

```
tools.8.web_search_20250305.name: Input should be 'web_search'
```

That error names a tool index and a schema, so it reads like a bug in the
agent's own tool definitions. Nothing in it suggests a rewrite happening in a
proxy in the middle, which is why this is worth writing down rather than
rediscovering.

The patch keeps obfuscation for custom tools and leaves provider-defined tools
exactly as they were, including in `tool_choice`.

### Why it lives here

It is a local modification to a third-party checkout, and it was previously
carried **only inside a Docker image tag**. That is one `docker build` away from
silent loss: the image would rebuild cleanly, the proxy would start, health
checks would pass, and web search would break again with an error pointing at
the wrong place entirely.

A patch file in version control is the minimum. Better still is upstreaming it
— the carve-out is correct for every consumer of that proxy, not only for us.

### Applying it

```bash
git clone https://github.com/ansg191/claude-auth-proxy.git
cd claude-auth-proxy
git checkout a62318f9
git apply /path/to/claude-auth-proxy-provider-tools.patch
docker build -t claude-auth-proxy:a62318f-provider-tools .
```

Run it bound to loopback only — the proxy spends a paid subscription and
requires no credential of its own:

```bash
docker run -d --name claude-subscription \
  --restart unless-stopped \
  --read-only \
  -v claude-subscription-data:/data \
  -p 127.0.0.1:3333:3000 \
  claude-auth-proxy:a62318f-provider-tools
```

`claudeSubscription()` refuses a non-loopback URL by default for that reason,
and `hostPreflight({ claudeProxyUrl })` reports both whether it is alive and
whether it is exposed.

### Before upgrading the proxy

Re-apply this patch, or confirm upstream has taken it. A run of the proxy's own
test suite is not enough to catch its absence — the failure only appears when a
request actually carries a provider-defined tool.
