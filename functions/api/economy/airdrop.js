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

function makeClaimMarkerEvent({ tools, issuerSk, issuerPubkey, toPubkey, amount, createdAt }) {
  const day = startOfUtcDay(createdAt)
  const d = `claim:${toPubkey}:${day}`
  const contentObj = {
    type: "nabbo_econ_daily_claim",
    pubkey: toPubkey,
    amount,
    ts: createdAt
  }

  const eventTemplate = {
    kind: 30079,
    created_at: createdAt,
    tags: [
      ["t", "nabbo-econ"],
      ["t", "nabbo-claim"],
      ["p", toPubkey],
      ["d", d],
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

const PRICES = {
  chair_basic: 10,
  table_basic: 25,
  plant_basic: 15
}

function getPrice(defId) {
  const p = PRICES[String(defId || "")]
  return typeof p === "number" && isFinite(p) && p >= 0 ? p : null
}

function getTag(ev, key) {
  if (!ev?.tags || !Array.isArray(ev.tags)) return null
  return ev.tags.find((t) => t?.[0] === key)?.[1] || null
}

async function computeBalance({ tools, relays, issuerPubkey, toPubkey, dailyAmount, now }) {
  const mkPool = () => new tools.SimplePool({ getTimeout: 1800, eoseSubTimeout: 1800 })

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

  const since = 0

  const pool = mkPool()
  const [claims, mints] = await withTimeout(
    Promise.all([
      pool.list(relays, [
        {
          kinds: [30079],
          authors: [issuerPubkey],
          "#t": ["nabbo-claim"],
          "#p": [toPubkey],
          since,
          limit: 5000
        }
      ]),
      pool.list(relays, [
        {
          kinds: [1],
          authors: [issuerPubkey],
          "#t": ["nabbo-item"],
          "#p": [toPubkey],
          since,
          limit: 5000
        }
      ])
    ]),
    3200
  )

  const claimDays = new Set()
  for (const ev of claims || []) {
    const d = getTag(ev, "d")
    if (d && d.startsWith(`claim:${toPubkey}:`)) claimDays.add(d)
  }
  const earned = claimDays.size * dailyAmount

  let spent = 0
  for (const ev of mints || []) {
    if (getTag(ev, "op") !== "mint") continue
    const defId = getTag(ev, "def")
    const price = getPrice(defId)
    if (price != null) spent += price
  }

  const balance = Math.max(0, earned - spent)
  return {
    balance,
    earned,
    spent,
    claims: claimDays.size,
    asOf: typeof now === "number" ? now : Math.floor(Date.now() / 1000)
  }
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

  const dailyAmount = 100

  const utcDay = startOfUtcDay(createdAt)
  const d = `claim:${auth.pubkey}:${utcDay}`

  let alreadyClaimed = false
  try {
    const pool = mkPool()
    const existing = await withTimeout(
      pool.get(relays, {
        kinds: [30079],
        authors: [issuerPubkey],
        "#t": ["nabbo-claim"],
        "#p": [auth.pubkey],
        "#d": [d],
        since: utcDay
      }),
      2200
    )
    alreadyClaimed = Boolean(existing)
  } catch {
    // If we can't read relays, we can still attempt to publish; marker is idempotent per-day.
    alreadyClaimed = false
  }

  let claimMarker
  try {
    claimMarker = makeClaimMarkerEvent({ tools, issuerSk, issuerPubkey, toPubkey: auth.pubkey, amount: dailyAmount, createdAt })
  } catch {
    return bad(500, "failed to sign claim marker")
  }

  let publishOk = 0
  let publishFail = 0
  try {
    const pool = mkPool()
    const pubs = pool.publish(relays, claimMarker)
    let results
    try {
      results = await withTimeout(Promise.allSettled(pubs), 2500)
    } catch {
      results = null
    }

    if (Array.isArray(results)) {
      for (const r of results) {
        if (r.status === "fulfilled") publishOk += 1
        else publishFail += 1
      }
    } else {
      // timed out publishing
      publishFail = pubs.length
    }
  } catch {
    publishFail = relays.length
  }

  // If we failed to publish anywhere, fail the claim and release locks so user can retry.
  // Otherwise, we'd be decrementing/incrementing based on events that no relay has.
  if (publishOk === 0) {
    return bad(503, "failed to publish claim")
  }

  let bal
  try {
    bal = await computeBalance({ tools, relays, issuerPubkey, toPubkey: auth.pubkey, dailyAmount, now: createdAt })
  } catch {
    bal = { balance: null }
  }

  return json(200, {
    ok: true,
    claimed: !alreadyClaimed,
    claim: claimMarker,
    relays,
    publish: { ok: publishOk, fail: publishFail },
    balance: bal,
    nextClaimAt: endOfUtcDay(createdAt)
  })
}
