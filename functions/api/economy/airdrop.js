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
      ["p", toPubkey],
      ["d", "coins"],
      ["issuer", issuerPubkey]
    ],
    content: JSON.stringify(contentObj),
    pubkey: issuerPubkey
  }

  return tools.finishEvent(eventTemplate, issuerSk)
}

function makeClaimMarkerEvent({ tools, issuerSk, issuerPubkey, toPubkey, amount, createdAt }) {
  const day = startOfUtcDay(createdAt)
  const claimId = `claim:${day}:${toPubkey}`
  const contentObj = {
    type: "nabbo_econ_daily_claim",
    pubkey: toPubkey,
    amount,
    ts: createdAt,
    day
  }

  const eventTemplate = {
    kind: 1,
    created_at: createdAt,
    tags: [
      ["t", "nabbo-econ"],
      ["t", "nabbo-claim"],
      ["p", toPubkey],
      ["d", claimId],
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

function parseBalanceFromEvent(ev) {
  if (!ev || typeof ev !== "object") return null
  if (ev.kind !== 30078) return null
  if (!Array.isArray(ev.tags)) return null
  const d = ev.tags.find((t) => t?.[0] === "d")?.[1]
  if (d !== "coins") return null
  let obj
  try {
    obj = JSON.parse(ev.content || "{}")
  } catch {
    return null
  }
  if (obj?.type !== "nabbo_econ_balance") return null
  if (typeof obj.balance !== "number" || !Number.isFinite(obj.balance) || obj.balance < 0) return null
  if (!obj.pubkey || typeof obj.pubkey !== "string") return null
  return { pubkey: obj.pubkey, balance: obj.balance }
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

  const mkPool = () => new tools.SimplePool({ getTimeout: 1800, eoseSubTimeout: 1800 })

  const publishAtLeastOne = async ({ pool, relays, event, timeoutMs }) => {
    const pubs = pool.publish(relays, event)
    let t
    try {
      await Promise.race([
        Promise.any(pubs),
        new Promise((_, rej) => {
          t = setTimeout(() => rej(new Error("timeout")), timeoutMs)
        })
      ])
      return true
    } finally {
      if (t) clearTimeout(t)
    }
  }

  const withTimeout = async (p, ms) => {
    let t
    try {
      return await Promise.race([
        p,
        new Promise((_, rej) => {
          t = setTimeout(() => rej(new Error("timeout")), ms)
        })
      ])
    } finally {
      if (t) clearTimeout(t)
    }
  }

  // Daily claim: one issuer airdrop event per pubkey per UTC day.
  try {
    const pool = mkPool()
    const since = startOfUtcDay(createdAt)
    const claimId = `claim:${since}:${auth.pubkey}`
    let existing = await withTimeout(
      pool.get(relays, {
        kinds: [1],
        authors: [issuerPubkey],
        "#t": ["nabbo-claim"],
        "#p": [auth.pubkey],
        "#d": [claimId],
        since
      }),
      2200
    )

    // Back-compat: older claim marker events (before claimId) won't have the d tag.
    if (!existing) {
      existing = await withTimeout(
        pool.get(relays, {
          kinds: [1],
          authors: [issuerPubkey],
          "#t": ["nabbo-claim"],
          "#p": [auth.pubkey],
          since
        }),
        2200
      )
    }

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
  const dailyAmount = 100

  let currentBalance = 0
  try {
    const pool = mkPool()
    const evs = await withTimeout(
      pool.list(relays, [
        {
          kinds: [30078],
          authors: [issuerPubkey],
          "#t": ["nabbo-coins"],
          "#p": [auth.pubkey],
          "#d": ["coins"],
          limit: 10
        }
      ]),
      2200
    )
    const sorted = (evs || []).slice().sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0))
    const parsed = parseBalanceFromEvent(sorted[0])
    if (parsed && String(parsed.pubkey || "").toLowerCase() === auth.pubkey.toLowerCase()) {
      currentBalance = parsed.balance
    }
  } catch {
    // If we can't read current balance we must fail closed.
    return bad(503, "relays unavailable")
  }

  const newBalance = currentBalance + dailyAmount

  let signed
  try {
    signed = makeBalanceEvent({ tools, issuerSk, issuerPubkey, toPubkey: auth.pubkey, balance: newBalance, createdAt })
  } catch {
    return bad(500, "failed to sign")
  }

  let claimMarker
  try {
    claimMarker = makeClaimMarkerEvent({ tools, issuerSk, issuerPubkey, toPubkey: auth.pubkey, amount: dailyAmount, createdAt })
  } catch {
    return bad(500, "failed to sign claim")
  }

  try {
    const pool = mkPool()
    await publishAtLeastOne({ pool, relays, event: claimMarker, timeoutMs: 2500 })
    await publishAtLeastOne({ pool, relays, event: signed, timeoutMs: 2500 })
  } catch {
    return bad(503, "failed to publish claim")
  }

  return json(200, {
    ok: true,
    claim: claimMarker,
    event: signed,
    relays,
    balance: { before: currentBalance, after: newBalance, delta: dailyAmount },
    nextClaimAt: endOfUtcDay(createdAt)
  })
}
