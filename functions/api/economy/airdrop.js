import "../../../lib/nostr.bundle.js"

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  })
}

function bad(status, message) {
  return json(status, { ok: false, error: message })
}

function requireTools() {
  const tools = globalThis.NostrTools
  if (!tools) throw new Error("NostrTools not available")
  const { finishEvent, getPublicKey, SimplePool, nip98 } = tools
  if (!finishEvent || !getPublicKey || !SimplePool || !nip98) throw new Error("NostrTools missing finishEvent/getPublicKey/SimplePool/nip98")
  return tools
}

function getRelays(env) {
  const raw = String(env?.RELAYS || "").trim()
  if (raw) {
    const parsed = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parsed.length) return parsed
  }
  return [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net"
  ]
}

function hexFromEnv(env, key) {
  const v = (env?.[key] || "").trim()
  if (!/^[0-9a-f]{64}$/i.test(v)) return null
  return v.toLowerCase()
}

async function requireAuthPubkey({ request, tools }) {
  const auth = request.headers.get("authorization") || request.headers.get("Authorization")
  if (!auth) return { ok: false, status: 401, error: "missing authorization" }

  try {
    const method = request.method
    const url = request.url
    await tools.nip98.validateToken(auth, url, method)
    const ev = await tools.nip98.unpackEventFromToken(auth)
    const pubkey = String(ev?.pubkey || "").trim()
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) return { ok: false, status: 401, error: "invalid authorization" }
    return { ok: true, pubkey }
  } catch {
    return { ok: false, status: 401, error: "invalid authorization" }
  }
}

function makeBalanceEvent({ tools, issuerSk, issuerPubkey, toPubkey, balance, createdAt }) {
  const contentObj = {
    type: "nabbo_econ_balance",
    pubkey: toPubkey,
    balance,
    ts: createdAt
  }

  const eventTemplate = {
    kind: 30078,
    created_at: createdAt,
    tags: [
      ["t", "nabbo-econ"],
      ["t", "nabbo-coins"],
      ["op", "airdrop"],
      ["p", toPubkey],
      ["d", "coins"],
      ["issuer", issuerPubkey]
    ],
    content: JSON.stringify(contentObj),
    pubkey: issuerPubkey
  }

  return tools.finishEvent(eventTemplate, issuerSk)
}

function startOfUtcDay(tsSeconds) {
  const ms = tsSeconds * 1000
  const d = new Date(ms)
  d.setUTCHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function endOfUtcDay(tsSeconds) {
  const start = startOfUtcDay(tsSeconds)
  return start + 24 * 60 * 60
}

export async function onRequestPost({ request, env }) {
  const tools = requireTools()

  const auth = await requireAuthPubkey({ request, tools })
  if (!auth.ok) return bad(auth.status, auth.error)

  const issuerSk = hexFromEnv(env, "ISSUER_SK")
  if (!issuerSk) return bad(500, "issuer key not configured")

  const issuerPubkey = tools.getPublicKey(issuerSk)
  const createdAt = Math.floor(Date.now() / 1000)

  const relays = getRelays(env)

  // Daily claim: one issuer airdrop event per pubkey per UTC day.
  try {
    const pool = new tools.SimplePool()
    const since = startOfUtcDay(createdAt)
    const existing = await pool.get(relays, {
      kinds: [30078],
      authors: [issuerPubkey],
      "#p": [auth.pubkey],
      "#d": ["coins"],
      "#op": ["airdrop"],
      since
    })

    if (existing) {
      return json(429, {
        ok: false,
        error: "already claimed today",
        nextClaimAt: endOfUtcDay(createdAt)
      })
    }
  } catch {
    // If we can't read relays, fail closed; otherwise daily claim can be bypassed.
    return bad(503, "relays unavailable")
  }

  // Stateless + free: airdrop sets your balance to a fixed starter amount.
  const starter = 100

  let signed
  try {
    signed = makeBalanceEvent({ tools, issuerSk, issuerPubkey, toPubkey: auth.pubkey, balance: starter, createdAt })
  } catch {
    return bad(500, "failed to sign")
  }

  let publishOk = 0
  let publishFail = 0
  try {
    const pool = new tools.SimplePool()
    const pubs = pool.publish(relays, signed)
    const results = await Promise.allSettled(pubs)
    for (const r of results) {
      if (r.status === "fulfilled") publishOk += 1
      else publishFail += 1
    }
  } catch {
    publishFail = relays.length
  }

  return json(200, {
    ok: true,
    event: signed,
    relays,
    publish: { ok: publishOk, fail: publishFail },
    nextClaimAt: endOfUtcDay(createdAt)
  })
}
