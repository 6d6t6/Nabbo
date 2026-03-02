export function createPublicRooms({ subscribe, ttlMs, onChange }) {
  const rooms = new Map()
  let sub = null
  let pruneTimer = null

  function prune() {
    const now = Date.now()
    let changed = false
    for (const [roomId, r] of rooms.entries()) {
      if (!r?.seenAt || now - r.seenAt >= ttlMs) {
        rooms.delete(roomId)
        changed = true
      }
    }
    if (changed) onChange?.()
  }

  function handleEvent(event) {
    let data
    try {
      data = JSON.parse(event.content)
    } catch {
      return
    }

    if (!data || !data.type) return

    if (data.type === "room_closed") {
      if (!data.roomId) return
      const existed = rooms.delete(data.roomId)
      if (existed) onChange?.()
      return
    }

    if (data.type !== "room") return
    if (!data.roomId || !data.ownerPubkey || !data.code) return

    const door = (() => {
      const d = data.door
      if (!d || typeof d !== "object") return null
      const x = Number(d.x)
      const z = Number(d.z)
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null
      return { x: Math.floor(x), z: Math.floor(z) }
    })()

    const createdAtSec = typeof event?.created_at === "number" ? event.created_at : null
    if (createdAtSec) {
      const ageMs = Date.now() - createdAtSec * 1000
      if (ageMs > ttlMs) return
    }

    const seenAt = createdAtSec ? createdAtSec * 1000 : Date.now()
    const prev = rooms.get(data.roomId)
    if (prev?.seenAt && prev.seenAt > seenAt) return

    rooms.set(data.roomId, {
      roomId: data.roomId,
      code: data.code,
      name: data.name,
      count: typeof data.count === "number" ? data.count : null,
      plan: typeof data.plan === "string" ? data.plan : null,
      door,
      ownerPubkey: data.ownerPubkey,
      seenAt
    })

    onChange?.()
  }

  function start() {
    stop()

    sub = subscribe(
      {
        kinds: [1],
        "#t": ["nabbo-room"],
        since: Math.floor(Date.now() / 1000) - Math.ceil(ttlMs / 1000) - 15
      },
      (event) => handleEvent(event)
    )

    pruneTimer = setInterval(() => prune(), 5_000)
  }

  function stop() {
    try {
      sub?.unsub?.()
    } catch {}
    sub = null

    if (pruneTimer) {
      clearInterval(pruneTimer)
      pruneTimer = null
    }
  }

  function list() {
    prune()
    return Array.from(rooms.values()).sort((a, b) => b.seenAt - a.seenAt)
  }

  function get(roomId) {
    return rooms.get(roomId)
  }

  function findByCode(code) {
    const c = (code || "").toUpperCase()
    for (const r of rooms.values()) {
      if (r.code === c) return r
    }
    return null
  }

  return {
    start,
    stop,
    list,
    get,
    findByCode
  }
}
