import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js'
import { initNostr, publish, subscribe, list, getPubkey, getNip98AuthHeader } from "./nostr.js"
import { createRoom } from './room.js'
import { createAvatar, updateAvatarPosition, setAvatarPose, setAvatarAppearance, quantizeYawTo8 } from './avatar.js'
import { NabboNet, createRoomId, roomIdToCode } from "./webrtc.js"
import { createWindowManager } from "./ui/windowManager.js"
import { createDisconnectModal } from "./ui/disconnectModal.js"
import { createConnectingModal } from "./ui/connectingModal.js"
import { createPublicRooms } from "./lobby/publicRooms.js"

let scene, camera, renderer
let floor
let currentFloorPlan = null

let raycaster
let mouse

let avatars = {}

let currentDetails = null

const DETAILS_BASE_BOTTOM_PX = 118
const DETAILS_ACTIONS_GAP_PX = 10

function furniHasUse(def) {
  if (!def || typeof def !== "object") return false
  if (def.usable === true) return true
  if (Array.isArray(def.actions) && def.actions.includes("use")) return true
  if (Array.isArray(def.interactions) && def.interactions.length > 0) return true
  return false
}

function handleUseItemLocal(instanceId, fromPubkey) {
  const it = placedItems.get(instanceId)
  const defId = it?.defId
  const def = getFurniDef(defId)
  const name = String(def?.displayName || defId || "Furni")
  const who = fromPubkey ? getDisplayName(fromPubkey) || fromPubkey.slice(0, 8) + "…" : "someone"
  appendChatLine(`${who} used ${name}`)
}

function sendUseItem(instanceId) {
  if (!instanceId || !net) return
  const it = placedItems.get(instanceId)
  const def = getFurniDef(it?.defId)
  if (!furniHasUse(def)) return
  if (currentRoom?.isHost) {
    handleUseItemLocal(instanceId, myPubkey)
    net.broadcast({ type: "item_used", instanceId, from: myPubkey })
  } else {
    net.broadcast({ type: "use_item", instanceId, from: myPubkey })
  }
}

function closeDetailsPanel() {
  currentDetails = null
  try {
    if (detailsPanelEl) detailsPanelEl.style.display = "none"
    if (detailsBodyEl) detailsBodyEl.innerHTML = ""
    if (detailsActionsEl) {
      detailsActionsEl.style.display = "none"
      detailsActionsEl.innerHTML = ""
    }
    if (detailsPanelEl) detailsPanelEl.style.bottom = `${DETAILS_BASE_BOTTOM_PX}px`
  } catch {}
}

function syncDetailsBottomOffset() {
  if (!detailsPanelEl) return
  if (!detailsActionsEl || detailsActionsEl.style.display === "none") {
    detailsPanelEl.style.bottom = `${DETAILS_BASE_BOTTOM_PX}px`
    return
  }
  const h = detailsActionsEl.offsetHeight || 0
  detailsPanelEl.style.bottom = `${DETAILS_BASE_BOTTOM_PX + DETAILS_ACTIONS_GAP_PX + h}px`
}

function setDetailsRow(label, value, parentEl = null) {
  const parent = parentEl || detailsBodyEl
  if (!parent) return
  const row = document.createElement("div")
  row.className = "details-row"
  const l = document.createElement("div")
  l.className = "details-label"
  l.textContent = label
  const v = document.createElement("div")
  v.className = "details-value"
  v.textContent = value
  row.appendChild(l)
  row.appendChild(v)
  parent.appendChild(row)
}

function appendDetailsHero({ thumbEl, name, description, parentEl = null }) {
  const parent = parentEl || detailsBodyEl
  if (!parent) return
  const hero = document.createElement("div")
  hero.className = "details-hero"

  if (thumbEl) {
    const t = document.createElement("div")
    t.className = "details-hero-thumb"
    t.appendChild(thumbEl)
    hero.appendChild(t)
  }

  const meta = document.createElement("div")
  meta.className = "details-hero-meta"

  const title = document.createElement("div")
  title.className = "details-hero-name"
  title.textContent = name || ""
  meta.appendChild(title)

  if (description) {
    const desc = document.createElement("div")
    desc.className = "details-hero-desc"
    desc.textContent = description
    meta.appendChild(desc)
  }

  hero.appendChild(meta)
  parent.appendChild(hero)
}

function appendTechnicalSection(rows, parentEl = null) {
  const parent = parentEl || detailsBodyEl
  if (!parent) return null
  const entries = Array.isArray(rows) ? rows.filter(Boolean) : []
  if (!entries.length) return null

  const detailsEl = document.createElement("details")
  detailsEl.className = "details-tech"

  const summary = document.createElement("summary")
  summary.className = "details-tech-summary"
  summary.textContent = "Technical"
  detailsEl.appendChild(summary)

  const body = document.createElement("div")
  body.className = "details-tech-body"
  for (const [label, value] of entries) {
    setDetailsRow(label, value, body)
  }
  detailsEl.appendChild(body)
  parent.appendChild(detailsEl)
  return detailsEl
}

function openDetailsPanel(selection) {
  if (!selection || typeof selection !== "object") return
  currentDetails = selection

  if (detailsActionsEl) {
    detailsActionsEl.style.display = "none"
    detailsActionsEl.innerHTML = ""
    requestAnimationFrame(() => syncDetailsBottomOffset())
  }

  if (!detailsPanelEl || !detailsBodyEl || !detailsTitleEl) return
  detailsBodyEl.innerHTML = ""

  const card = document.createElement("div")
  card.className = "details-card"
  detailsBodyEl.appendChild(card)

  const kind = String(selection.kind || "")
  if (kind === "avatar" || kind === "bot") {
    const pubkey = String(selection.pubkey || "")
    const title = getDisplayName(pubkey) || "Avatar"
    detailsTitleEl.textContent = title
    appendDetailsHero({
      thumbEl: null,
      name: title,
      description: kind === "bot" ? "Bot" : "Avatar",
      parentEl: card
    })
    setDetailsRow("Type", kind === "bot" ? "Bot" : "Avatar", card)
    appendTechnicalSection([["Id", pubkey ? pubkey.slice(0, 12) + "…" : ""]], card)
    detailsPanelEl.style.display = "block"
    return
  }

  if (kind === "furni") {
    const instanceId = String(selection.instanceId || "")
    const it = placedItems.get(instanceId)
    const defId = it?.defId || selection.defId || ""
    const def = getFurniDef(defId)
    const title = String(def?.displayName || selection.name || defId || "Furni")
    detailsTitleEl.textContent = title
    appendDetailsHero({
      thumbEl: defId ? makeThumbEl(defId) : null,
      name: title,
      description: def?.description ? String(def.description) : "",
      parentEl: card
    })
    setDetailsRow("Type", "Furni", card)
    if (it?.tile && typeof it.tile.x === "number" && typeof it.tile.z === "number") {
      setDetailsRow("Tile", `${it.tile.x}, ${it.tile.z}`, card)
    }
    appendTechnicalSection(
      [
      defId ? ["Def", String(defId)] : null,
      instanceId ? ["Instance", String(instanceId).slice(0, 12) + "…"] : null
      ],
      card
    )

    const actions = document.createElement("div")
    actions.className = "details-actions"

    const canEdit = Boolean(currentRoom?.isHost)
    const canUse = furniHasUse(def)

    const addBtn = ({ label, kind, primary = false, onClick }) => {
      const b = document.createElement("button")
      b.type = "button"
      b.className = primary ? "primary" : ""
      b.dataset.kind = kind
      b.textContent = label
      b.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick?.()
      }
      actions.appendChild(b)
    }

    if (canEdit) {
      addBtn({
        label: "Move",
        kind: "move",
        onClick: () => {
          if (!instanceId) return
          movingInstanceId = instanceId
          movingStartTile = placedItems.get(instanceId)?.tile || null
          appendChatLine("click a tile to move item")
        }
      })
      addBtn({ label: "Rotate", kind: "rotate", onClick: () => sendRotateItem(instanceId) })
      addBtn({ label: "Pick up", kind: "pickup", onClick: () => sendPickupItem(instanceId) })
    }

    if (canUse) {
      addBtn({ label: "Use", kind: "use", primary: true, onClick: () => sendUseItem(instanceId) })
    }

    if (detailsActionsEl) {
      detailsActionsEl.innerHTML = ""
      if (actions.childNodes.length) {
        detailsActionsEl.appendChild(actions)
        detailsActionsEl.style.display = "block"
        requestAnimationFrame(() => syncDetailsBottomOffset())
      } else {
        detailsActionsEl.style.display = "none"
        requestAnimationFrame(() => syncDetailsBottomOffset())
      }
    }
    detailsPanelEl.style.display = "block"
    return
  }

  if (detailsActionsEl) {
    detailsActionsEl.style.display = "none"
    detailsActionsEl.innerHTML = ""
    requestAnimationFrame(() => syncDetailsBottomOffset())
  }
}

const appearances = {}
let myAppearance = null

function normalizeAppearance(app) {
  const a = app && typeof app === "object" ? app : {}
  return {
    skin: String(a.skin || "peach"),
    hair: String(a.hair || "brown_short"),
    top: String(a.top || "tee_blue"),
    bottom: String(a.bottom || "pants_gray"),
    face: String(a.face || "smile")
  }
}

const appearanceOptions = {
  skin: [
    { id: "peach", label: "Skin: Peach" },
    { id: "tan", label: "Skin: Tan" },
    { id: "brown", label: "Skin: Brown" },
    { id: "dark", label: "Skin: Dark" }
  ],
  hair: [
    { id: "none", label: "Hair: None" },
    { id: "black", label: "Hair: Black" },
    { id: "brown_short", label: "Hair: Brown" },
    { id: "blonde_short", label: "Hair: Blonde" },
    { id: "red_short", label: "Hair: Red" }
  ],
  top: [
    { id: "tee_blue", label: "Top: Blue Tee" },
    { id: "tee_red", label: "Top: Red Tee" },
    { id: "hoodie_green", label: "Top: Green Hoodie" },
    { id: "jacket_black", label: "Top: Black Jacket" }
  ],
  bottom: [
    { id: "pants_gray", label: "Bottom: Gray Pants" },
    { id: "pants_blue", label: "Bottom: Blue Pants" },
    { id: "shorts_black", label: "Bottom: Black Shorts" },
    { id: "skirt_pink", label: "Bottom: Pink Skirt" }
  ],
  face: [
    { id: "smile", label: "Face: Smile" },
    { id: "neutral", label: "Face: Neutral" },
    { id: "sad", label: "Face: Sad" },
    { id: "surprised", label: "Face: Surprised" }
  ]
}

function fillSelect(el, opts) {
  if (!el) return
  el.innerHTML = ""
  for (const o of opts) {
    const opt = document.createElement("option")
    opt.value = o.id
    opt.textContent = o.label
    el.appendChild(opt)
  }
}

function applyAppearanceForPubkey(pubkey, appearance) {
  const app = normalizeAppearance(appearance)
  appearances[pubkey] = app
  const av = avatars[pubkey]
  if (av) setAvatarAppearance(av, app)
}

function broadcastMyAppearance() {
  if (!net || !currentRoom || !myAppearance) return
  const msg = { type: "appearance", appearance: myAppearance }
  if (currentRoom.isHost) {
    const out = { ...msg, pubkey: myPubkey }
    handleNetMessage(myPubkey, out)
    net.broadcast(out)
  } else {
    net.broadcast(msg)
  }
}

function yawFromDir8(dir) {
  const step = (Math.PI * 2) / 8
  return (Number(dir || 0) || 0) * step
}

function getDir8FromYaw(yaw) {
  const step = (Math.PI * 2) / 8
  const n = Math.round((yaw || 0) / step)
  return ((n % 8) + 8) % 8
}

function shouldIncludePoseInNet() {
  return myPose === "sit"
}

function shouldIncludeSittingOnInNet() {
  return myPose === "sit" && Boolean(sittingOnInstanceId)
}

function shouldIncludeSitYInNet() {
  return myPose === "sit" && Boolean(sittingOnInstanceId) && Boolean(myAvatar)
}

function updateFurniAccessUi() {
  const host = Boolean(currentRoom?.isHost)
  if (inventoryPlaceEl) inventoryPlaceEl.disabled = !host
  if (inventoryCancelPlaceEl) inventoryCancelPlaceEl.disabled = !host || !isPlacing
}

 let issuerPubkey = ""

let selectedShopCategory = "All"

 function balanceCacheKey(pubkey) {
   return `nabbo_coins_balance_${String(pubkey || "").toLowerCase()}`
 }
 
 function loadCachedCoins() {
   if (!myPubkey) return
   try {
     const rawBal = localStorage.getItem(balanceCacheKey(myPubkey))
     const bal = rawBal == null ? null : Number(rawBal)
     if (typeof bal === "number" && Number.isFinite(bal) && bal >= 0) {
       coinsBalance = bal
     }
   } catch {}
 }
 
 function saveCachedCoins() {
   if (!myPubkey) return
   try {
     if (typeof coinsBalance === "number" && Number.isFinite(coinsBalance) && coinsBalance >= 0) {
       localStorage.setItem(balanceCacheKey(myPubkey), String(coinsBalance))
     }
   } catch {}
 }

function renderCoins() {
  if (!coinBalanceEl) return
  if (typeof coinsBalance === "number" && Number.isFinite(coinsBalance)) {
    coinBalanceEl.textContent = `Coins: ${coinsBalance}`
  } else {
    coinBalanceEl.textContent = "Coins: …"
  }
}

function stopCoinsSub() {
  try {
    coinsSub?.unsub?.()
  } catch {}
  coinsSub = null
}

function refreshCoins() {
  if (!myPubkey) return
  stopCoinsSub()

  loadCachedCoins()
  renderCoins()
  renderCatalog()

  ;(async () => {
    try {
      if (!issuerPubkey) return

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

      const [claims, mints] = await withTimeout(
        Promise.all([
          list({
            kinds: [30079],
            authors: [issuerPubkey],
            "#t": ["nabbo-claim"],
            "#p": [myPubkey],
            limit: 5000
          }),
          list({
            kinds: [1],
            authors: [issuerPubkey],
            "#t": ["nabbo-item"],
            "#p": [myPubkey],
            limit: 5000
          })
        ]),
        2500
      )

      const dailyAmount = 100
      const claimDays = new Set()
      for (const ev of claims || []) {
        const d = ev?.tags?.find((t) => t?.[0] === "d")?.[1]
        if (d && typeof d === "string" && d.startsWith(`claim:${myPubkey}:`)) claimDays.add(d)
      }
      lastClaimsSet = claimDays
      const earned = claimDays.size * dailyAmount

      let spent = 0
      for (const ev of mints || []) {
        const op = ev?.tags?.find((t) => t?.[0] === "op")?.[1]
        if (op !== "mint") continue
        const defId = ev?.tags?.find((t) => t?.[0] === "def")?.[1]
        const it = catalog.find((x) => x.defId === defId)
        if (it?.price) spent += Number(it.price) || 0
      }

      coinsBalance = Math.max(0, earned - spent)
      latestBalanceEvent = null
      saveCachedCoins()
      renderCoins()
      renderCatalog()
      updateClaimUi()
    } catch {}
  })()
}

function updateClaimUi() {
  if (!claimCoinsEl) return
  if (claimCountdownTimer) {
    clearInterval(claimCountdownTimer)
    claimCountdownTimer = null
  }

  const dayStart = startOfUtcDaySeconds(Date.now())
  const todayKey = `claim:${myPubkey}:${dayStart}`
  const hasClaimed = Boolean(lastClaimsSet && lastClaimsSet.has(todayKey))

  const tick = () => {
    const now = Math.floor(Date.now() / 1000)
    const resetAt = endOfUtcDaySeconds(Date.now())
    const left = resetAt - now
    claimCoinsEl.disabled = hasClaimed
    if (hasClaimed) {
      claimCoinsEl.textContent = `Daily Claim (${formatHMS(left)})`
    } else {
      claimCoinsEl.textContent = "Daily Claim"
    }
  }

  tick()
  if (hasClaimed) {
    claimCountdownTimer = setInterval(tick, 1000)
  }
}

function renderCatalog() {
  if (!catalogEl) return
  catalogEl.innerHTML = ""
  const selectedCat = String(selectedShopCategory || "All").trim() || "All"
  const visible = catalog.filter((it) => selectedCat === "All" || (it.category || "Other") === selectedCat)
  for (const it of visible) {
    const card = document.createElement("div")
    card.className = "card"
    card.classList.toggle("selected", selectedCatalogDefId === it.defId)

    const thumb = document.createElement("div")
    thumb.className = "thumb"
    thumb.appendChild(makeThumbEl(it.defId))
    card.appendChild(thumb)

    const title = document.createElement("div")
    title.className = "card-title"
    title.textContent = getFurniDef(it.defId)?.displayName || it.name
    card.appendChild(title)

    const sub = document.createElement("div")
    sub.className = "card-sub"
    sub.textContent = `${it.price} coins`
    card.appendChild(sub)

    card.onclick = () => {
      selectedCatalogDefId = it.defId
      renderCatalog()
    }

    const btn = document.createElement("button")
    btn.className = "primary"
    btn.textContent = "Buy"
    btn.type = "button"
    const price = Number(it.price || 0)
    if (typeof coinsBalance === "number" && Number.isFinite(coinsBalance)) {
      btn.disabled = coinsBalance < price
    } else {
      btn.disabled = true
    }
    btn.onclick = async () => {
      try {
        const url = new URL("/api/economy/mint", window.location.origin).toString()
        const auth = await getNip98AuthHeader(url, "POST")

        const priceNum = Number(it.price || 0)
        const hadBalance = typeof coinsBalance === "number" && Number.isFinite(coinsBalance)
        const optimisticAfter = hadBalance ? Math.max(0, coinsBalance - priceNum) : null

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: auth
          },
          body: JSON.stringify({ defId: it.defId, toPubkey: myPubkey })
        })
        const out = await res.json().catch(() => null)
        if (!out?.ok) {
          appendChatLine(`mint failed: ${out?.error || res.status}`)
          return
        }

        if (optimisticAfter != null) {
          coinsBalance = optimisticAfter
          saveCachedCoins()
          renderCoins()
          renderCatalog()
        }

        if (typeof out?.balance?.after === "number" && Number.isFinite(out.balance.after) && out.balance.after >= 0) {
          // Avoid overwriting an optimistic balance with a likely-incomplete computed snapshot.
          if (optimisticAfter == null || Math.abs(out.balance.after - optimisticAfter) <= 0.0001) {
            coinsBalance = out.balance.after
            saveCachedCoins()
            renderCoins()
            renderCatalog()
          }
        }

        appendChatLine(`bought: ${getFurniDef(it.defId)?.displayName || it.name}`)
        await new Promise((r) => setTimeout(r, 600))
        refreshInventory()
        refreshCoins()
      } catch (e) {
        appendChatLine("mint failed")
      }
    }
    card.appendChild(btn)
    catalogEl.appendChild(card)
  }
}

function renderInventory() {
  if (!inventoryListEl) return
  inventoryListEl.innerHTML = ""
  const placedIds = new Set(Array.from(placedItems.keys()))
  const items = Array.from(inventoryItems.values())
    .filter((x) => x?.toPubkey?.toLowerCase?.() === myPubkey?.toLowerCase?.())
    .filter((x) => !placedIds.has(x.instanceId))
    .filter((x) => shouldShowInInventory(x))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))

  if (items.length === 0) {
    const empty = document.createElement("div")
    empty.className = "hint"
    empty.textContent = "No items yet. Buy something from the shop."
    inventoryListEl.appendChild(empty)
    return
  }

  const stacks = new Map()
  for (const it of items) {
    const key = String(it.defId || "")
    if (!stacks.has(key)) stacks.set(key, [])
    stacks.get(key).push(it)
  }

  const stackList = Array.from(stacks.entries())
    .map(([defId, arr]) => ({ defId, arr }))
    .sort((a, b) => (b.arr?.[0]?.ts || 0) - (a.arr?.[0]?.ts || 0))

  for (const st of stackList) {
    const defId = st.defId
    const arr = st.arr
    const selectedInStack = arr.some((x) => x.instanceId === selectedInstanceId)

    const card = document.createElement("div")
    card.className = "card"
    card.classList.toggle("selected", selectedInStack)

    const thumb = document.createElement("div")
    thumb.className = "thumb"
    thumb.appendChild(makeThumbEl(defId))
    card.appendChild(thumb)

    if (arr.length > 1) {
      const badge = document.createElement("div")
      badge.className = "badge"
      badge.textContent = String(arr.length)
      card.appendChild(badge)
    }

    const title = document.createElement("div")
    title.className = "card-title"
    title.textContent = defId
    card.appendChild(title)

    const sub = document.createElement("div")
    sub.className = "card-sub"
    sub.textContent = selectedInStack ? selectedInstanceId.slice(0, 6) : `${arr[0].instanceId.slice(0, 6)} · stack`
    card.appendChild(sub)

    card.onclick = () => {
      // Select the newest instance from this stack.
      selectedInstanceId = arr[0].instanceId
      renderInventory()
    }

    inventoryListEl.appendChild(card)
  }
}

function stopInventorySub() {
  try {
    inventorySub?.unsub?.()
  } catch {}
  inventorySub = null

  try {
    itemLocSub?.unsub?.()
  } catch {}
  itemLocSub = null
}

function refreshInventory() {
  if (!myPubkey) return
  stopInventorySub()
  inventoryItems.clear()
  itemLocations.clear()

  inventorySub = subscribe(
    {
      kinds: [1],
      "#t": ["nabbo-item"],
      "#p": [myPubkey],
      since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30
    },
    (ev) => {
      let obj
      try {
        obj = JSON.parse(ev?.content || "{}")
      } catch {
        return
      }
      if (obj?.type !== "nabbo_econ_mint") return
      if (!obj.instanceId || !obj.defId || !obj.toPubkey) return
      inventoryItems.set(obj.instanceId, obj)
      renderInventory()
    }
  )

  itemLocSub = subscribe(
    {
      kinds: [30081],
      "#t": ["nabbo-item-loc"],
      authors: [myPubkey],
      since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30
    },
    (ev) => {
      const d = ev?.tags?.find((t) => t?.[0] === "d")?.[1]
      if (!d) return
      let obj
      try {
        obj = JSON.parse(ev?.content || "{}")
      } catch {
        return
      }
      if (obj?.type !== "nabbo_item_loc") return
      if (String(obj.instanceId || "") !== String(d)) return
      itemLocations.set(String(d), obj)
      renderInventory()
    }
  )

  renderInventory()
}

function getEffectiveLocation(instanceId) {
  const loc = itemLocations.get(String(instanceId || ""))
  if (!loc || loc?.type !== "nabbo_item_loc") return null
  return loc
}

function shouldShowInInventory(it) {
  const instanceId = String(it?.instanceId || "")
  if (!instanceId) return false
  const loc = getEffectiveLocation(instanceId)
  if (!loc) return true
  if (loc.state === "inventory") return true
  if (loc.state === "placed") {
    const roomId = String(loc.roomId || "")
    const cur = String(currentRoom?.roomId || "")
    return Boolean(roomId && cur && roomId === cur)
  }
  return true
}

function clampToWalkable(pos) {
  if (!floor?.userData?.tileSet || isTileWalkable(pos)) return pos
  const parsed = floor?.userData?.planParsed
  const tileToWorld = floor?.userData?.tileToWorld
  if (!parsed || !tileToWorld || !Array.isArray(parsed.tiles) || parsed.tiles.length === 0) return pos

  const t = toTileCoord(pos)
  let best = null
  let bestD = Infinity
  for (const cand of parsed.tiles) {
    const d = Math.abs(cand.x - t.x) + Math.abs(cand.z - t.z)
    if (d < bestD) {
      bestD = d
      best = cand
      if (d === 0) break
    }
  }
  if (!best) return pos
  const w = tileToWorld(best.x, best.z)
  return { x: w.x, z: w.z }
}

function teardownRoom({ reason, showLobby = true } = {}) {
  if (reason) appendChatLine(reason)

  if (currentRoom?.isHost && currentRoom?.announcePublic) {
    publishRoomClosed({ roomId: currentRoom.roomId, code: currentRoom.code })
  }

  stopRoomAnnouncements()
  suppressDisconnectUntil = Date.now() + 1500

  try {
    net?.stop()
  } catch {}
  net = null

  currentRoom = null
  currentFloorPlan = null

  for (const k of Object.keys(avatars)) {
    scene.remove(avatars[k])
    delete avatars[k]
  }
  myAvatar = null
  remoteTargets = {}

  if (placedGroup) {
    try {
      scene.remove(placedGroup)
    } catch {}
    placedGroup = null
  }
  placedItems.clear()
  renderInventory()

  if (chatBubbles.length) {
    for (const b of chatBubbles) {
      try {
        b.el.remove()
      } catch {}
    }
    chatBubbles = []
  }

  setInRoom(false)
  updateFurniAccessUi()
  if (showLobby) {
    win.showWindow(lobbyEl, dockNavigator)
    win.focusWindow(lobbyEl)
  }
}

function ensurePlacedGroup() {
  if (placedGroup) return
  placedGroup = new THREE.Group()
  scene.add(placedGroup)
}

function removePlacedLocal(instanceId) {
  const existing = placedItems.get(instanceId)
  if (!existing) return
  if (existing.mesh && placedGroup) {
    try {
      placedGroup.remove(existing.mesh)
    } catch {}
  }
  placedItems.delete(instanceId)
  rebuildBlockedTiles()
  renderInventory()
  if (currentRoom?.isHost) {
    queueItemLocationPublish(instanceId, { state: "inventory" })
  }
  if (currentRoom?.isHost && !loadingRoomState) {
    scheduleSaveRoomFurni()
  }
}

function updatePlacedLocal({ instanceId, tile, rot, stackIndex, y }) {
  const existing = placedItems.get(instanceId)
  if (!existing) return
  const next = { ...existing }
  if (tile && typeof tile.x === "number" && typeof tile.z === "number") {
    next.tile = { x: tile.x, z: tile.z }

    const def = getFurniDef(existing.defId)
    const occupiedByOther = Array.from(placedItems.values()).some((it) => it?.instanceId !== instanceId && it?.tile?.x === tile.x && it?.tile?.z === tile.z)
    const canStack = Boolean(def?.stackable)

    const nextStackIndex = (() => {
      if (typeof stackIndex === "number" && Number.isFinite(stackIndex)) return Math.max(0, Math.floor(stackIndex))
      if (!canStack) return 0
      if (!occupiedByOther) return 0
      return getStackIndexForTileExcluding(tile, instanceId)
    })()

    next.stackIndex = nextStackIndex

    if (typeof stackIndex === "number" && Number.isFinite(stackIndex)) {
      next.stackIndex = Math.max(0, Math.floor(stackIndex))
    }

    if (typeof y === "number" && Number.isFinite(y)) {
      next.y = y
    } else {
      const movedDefId = existing.defId
      next.y = computePlacementY(tile, movedDefId, { excludeInstanceId: instanceId })
    }

    if (floor?.userData?.tileToWorld && existing.mesh) {
      const w = floor.userData.tileToWorld(tile.x, tile.z)
      existing.mesh.position.x = w.x
      existing.mesh.position.z = w.z

      if (typeof next.y === "number" && Number.isFinite(next.y)) {
        existing.mesh.position.y = next.y
      }
    }
  }
  if (typeof rot === "number" && Number.isFinite(rot)) {
    next.rot = rot
    if (existing.mesh) existing.mesh.rotation.y = rot * (Math.PI / 2)
  }
  placedItems.set(instanceId, next)
  rebuildBlockedTiles()
  if (currentRoom?.isHost) {
    const payload = { state: "placed", roomId: currentRoom.roomId }
    if (tile) payload.tile = tile
    if (typeof rot === "number") payload.rot = rot
    if (tile) payload.stackIndex = next.stackIndex
    if (typeof next.y === "number" && Number.isFinite(next.y)) payload.y = next.y
    queueItemLocationPublish(instanceId, payload)
  }
  if (currentRoom?.isHost && !loadingRoomState) {
    scheduleSaveRoomFurni()
  }
}

function queueItemLocationPublish(instanceId, patch) {
  if (!myPubkey) return
  const id = String(instanceId || "")
  if (!id) return
  const prev = pendingLocUpdates.get(id) || {}
  pendingLocUpdates.set(id, { ...prev, ...patch })
  if (pendingLocTimer) return
  pendingLocTimer = setTimeout(() => {
    pendingLocTimer = null
    flushItemLocationPublishes().catch(() => {})
  }, 2000)
}

async function flushItemLocationPublishes() {
  if (!pendingLocUpdates.size) return
  const batch = pendingLocUpdates
  pendingLocUpdates = new Map()

  const now = Math.floor(Date.now() / 1000)
  for (const [instanceId, patch] of batch.entries()) {
    const obj = {
      type: "nabbo_item_loc",
      instanceId,
      updatedAt: now,
      state: patch.state || "placed"
    }
    if (obj.state === "placed") {
      obj.roomId = String(patch.roomId || currentRoom?.roomId || "")
      if (patch.tile) obj.tile = patch.tile
      if (typeof patch.rot === "number") obj.rot = patch.rot
      if (typeof patch.stackIndex === "number") obj.stackIndex = patch.stackIndex
      if (typeof patch.y === "number") obj.y = patch.y
    }
    const tags = [
      ["t", "nabbo-item-loc"],
      ["d", instanceId]
    ]
    try {
      await publish(30081, JSON.stringify(obj), tags)
      itemLocations.set(instanceId, obj)
    } catch {}
  }
  renderInventory()
}

function pickPlacedInstanceFromEvent(e) {
  if (!raycaster || !mouse || !camera) return ""
  if (!placedGroup) return ""
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(mouse, camera)
  const hits = raycaster.intersectObject(placedGroup, true)
  const id = hits?.[0]?.object?.userData?.instanceId
  return typeof id === "string" ? id : ""
}

function pickAvatarPubkeyFromEvent(e) {
  if (!raycaster || !mouse || !camera) return ""
  const arr = Object.values(avatars || {})
  if (!arr.length) return ""
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(mouse, camera)
  const hits = raycaster.intersectObjects(arr, true)
  const pk = hits?.[0]?.object?.userData?.pubkey
  return typeof pk === "string" ? pk : ""
}

function sendRotateItem(instanceId) {
  if (!instanceId || !net) return
  if (!currentRoom?.isHost) return
  const it = placedItems.get(instanceId)
  if (!it) return
  const nextRot = ((Number(it.rot || 0) || 0) + 1) % 4
  if (currentRoom?.isHost) {
    updatePlacedLocal({ instanceId, rot: nextRot })
    net.broadcast({ type: "item_rotated", item: { instanceId, rot: nextRot } })
  } else {
    net.broadcast({ type: "rotate_item", item: { instanceId, rot: nextRot } })
  }
}

function sendPickupItem(instanceId) {
  if (!instanceId || !net) return
  if (!currentRoom?.isHost) return
  if (currentRoom?.isHost) {
    removePlacedLocal(instanceId)
    net.broadcast({ type: "item_picked_up", instanceId })
  } else {
    net.broadcast({ type: "pickup_item", instanceId })
  }
}

function sendMoveItem(instanceId, tile) {
  if (!instanceId || !net) return
  if (!currentRoom?.isHost) return
  if (!tile || typeof tile.x !== "number" || typeof tile.z !== "number") return

  const it = placedItems.get(instanceId)
  const def = getFurniDef(it?.defId)
  const occupiedByOther = Array.from(placedItems.values()).some((x) => x?.instanceId !== instanceId && x?.tile?.x === tile.x && x?.tile?.z === tile.z)
  if (occupiedByOther && !def?.stackable) {
    return
  }

  const stackIndex = def?.stackable ? (occupiedByOther ? getStackIndexForTileExcluding(tile, instanceId) : 0) : 0
  const y = computePlacementY(tile, it?.defId, { excludeInstanceId: instanceId })
  if (currentRoom?.isHost) {
    updatePlacedLocal({ instanceId, tile, stackIndex })
    net.broadcast({ type: "item_moved", item: { instanceId, tile, stackIndex, y } })
  } else {
    net.broadcast({ type: "move_item", item: { instanceId, tile } })
  }
}

function publishPlacedItemLocationsSoon() {
  if (!currentRoom?.isHost) return
  if (!currentRoom?.roomId) return
  for (const it of placedItems.values()) {
    if (!it?.instanceId || !it?.tile) continue
    queueItemLocationPublish(it.instanceId, {
      state: "placed",
      roomId: currentRoom.roomId,
      tile: it.tile,
      rot: it.rot || 0,
      stackIndex: it.stackIndex || 0
    })
  }
}

function colorFromString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 0xffffff
}

function createFurniMesh(defId) {
  const baseColor = colorFromString(defId || "furni")
  const group = new THREE.Group()

  const makeMat = (c) => new THREE.MeshBasicMaterial({ color: c })

  const blockColor = (() => {
    if (defId === "block_white") return 0xf1f5f9
    if (defId === "block_black") return 0x111827
    if (defId === "block_red") return 0xef4444
    if (defId === "block_green") return 0x22c55e
    if (defId === "block_blue") return 0x3b82f6
    if (defId === "block_yellow") return 0xf59e0b
    if (defId === "block_purple") return 0xa855f7
    return null
  })()

  if (blockColor != null) {
    const geom = new THREE.BoxGeometry(1.0, 1.0, 1.0)
    const mat = makeMat(blockColor)
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.y = 0.5
    group.add(mesh)
    return group
  }

  if (defId === "chair_basic") {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.14, 0.82), makeMat(baseColor))
    seat.position.y = 0.32
    group.add(seat)

    const back = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.52, 0.12), makeMat((baseColor + 0x202020) & 0xffffff))
    back.position.y = 0.58
    back.position.z = -0.35
    group.add(back)

    const legGeom = new THREE.BoxGeometry(0.12, 0.32, 0.12)
    const legMat = makeMat((baseColor + 0x101010) & 0xffffff)
    const leg = (x, z) => {
      const m = new THREE.Mesh(legGeom, legMat)
      m.position.set(x, 0.16, z)
      group.add(m)
    }
    leg(0.32, 0.32)
    leg(-0.32, 0.32)
    leg(0.32, -0.32)
    leg(-0.32, -0.32)
  } else if (defId === "table_basic") {
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.1, 0.92), makeMat(baseColor))
    top.position.y = 0.56
    group.add(top)

    const legGeom = new THREE.BoxGeometry(0.12, 0.56, 0.12)
    const legMat = makeMat((baseColor + 0x151515) & 0xffffff)
    const leg = (x, z) => {
      const m = new THREE.Mesh(legGeom, legMat)
      m.position.set(x, 0.28, z)
      group.add(m)
    }
    leg(0.34, 0.34)
    leg(-0.34, 0.34)
    leg(0.34, -0.34)
    leg(-0.34, -0.34)
  } else if (defId === "plant_basic") {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.26, 14), makeMat(0x6b3f2a))
    pot.position.y = 0.13
    group.add(pot)

    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.46, 10), makeMat(0x2d8a3a))
    stem.position.y = 0.42
    group.add(stem)

    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), makeMat(0x35b44a))
    leaf.position.y = 0.66
    group.add(leaf)
  } else {
    const geom = new THREE.BoxGeometry(0.86, 0.6, 0.86)
    const mat = makeMat(baseColor)
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.y = 0.31
    group.add(mesh)
  }

  return group
}

function createGhostFurniMesh(defId) {
  const group = createFurniMesh(defId)
  group.traverse((o) => {
    if (!o?.isMesh) return
    const c = o.material?.color?.getHex?.() ?? colorFromString(defId)
    o.material = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.35 })
  })
  return group
}

function placeItemLocal(item) {
  if (!item?.instanceId || !item?.tile) return
  if (!floor?.userData?.tileToWorld) return

  ensurePlacedGroup()

  const existing = placedItems.get(item.instanceId)
  if (existing?.mesh) {
    try {
      placedGroup.remove(existing.mesh)
    } catch {}
  }

  const w = floor.userData.tileToWorld(item.tile.x, item.tile.z)
  const mesh = createFurniMesh(item.defId)
  mesh.position.x = w.x
  mesh.position.z = w.z
  const rot = Number(item.rot || 0) || 0
  mesh.rotation.y = rot * (Math.PI / 2)
  const stackIndex = Number(item.stackIndex || 0) || 0
  const def = getFurniDef(item.defId)
  const y = typeof item.y === "number" && Number.isFinite(item.y) ? item.y : computePlacementY(item.tile, item.defId)
  mesh.position.y = y

  mesh.traverse((o) => {
    if (o && typeof o === "object") {
      o.userData = o.userData || {}
      o.userData.instanceId = item.instanceId
    }
  })

  placedGroup.add(mesh)

  placedItems.set(item.instanceId, { ...item, rot, stackIndex, y, mesh })
  rebuildBlockedTiles()
  renderInventory()

  if (currentRoom?.isHost) {
    if (!loadingRoomState) {
      queueItemLocationPublish(item.instanceId, {
        state: "placed",
        roomId: currentRoom.roomId,
        tile: item.tile,
        rot,
        stackIndex,
        y
      })
    }
  }

  if (currentRoom?.isHost && !loadingRoomState) {
    scheduleSaveRoomFurni()
  }
}

function getRoomStateTags(roomId) {
  return [
    ["t", "nabbo-room"],
    ["t", "nabbo-room-state"],
    ["d", String(roomId)],
    ["room", String(roomId)]
  ]
}

function scheduleSaveRoomFurni() {
  if (!currentRoom?.isHost || !currentRoom?.roomId) return
  if (furniSaveTimer) {
    clearTimeout(furniSaveTimer)
  }
  furniSaveTimer = setTimeout(() => {
    furniSaveTimer = null
    saveRoomFurni().catch(() => {})
  }, 800)
}

async function saveRoomFurni() {
  if (!currentRoom?.isHost || !currentRoom?.roomId) return
  const roomId = currentRoom.roomId
  const items = Array.from(placedItems.values()).map((it) => ({
    instanceId: it.instanceId,
    defId: it.defId,
    tile: it.tile,
    rot: it.rot || 0,
    stackIndex: it.stackIndex || 0,
    y: typeof it.y === "number" && Number.isFinite(it.y) ? it.y : undefined
  }))
  const contentObj = {
    type: "nabbo_room_state",
    roomId,
    items,
    ts: Math.floor(Date.now() / 1000)
  }
  await publish(30078, JSON.stringify(contentObj), getRoomStateTags(roomId))
}

async function loadRoomFurni(roomId) {
  const evs = await list({
    kinds: [30078],
    "#t": ["nabbo-room-state"],
    "#d": [String(roomId)],
    limit: 10
  })
  const sorted = (evs || []).slice().sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0))
  const ev = sorted[0]
  if (!ev) return []
  let obj
  try {
    obj = JSON.parse(ev.content || "{}")
  } catch {
    return []
  }
  if (obj?.type !== "nabbo_room_state") return []
  if (String(obj.roomId || "") !== String(roomId)) return []
  if (!Array.isArray(obj.items)) return []
  return obj.items
    .filter((it) => it?.instanceId && it?.defId && it?.tile && typeof it.tile.x === "number" && typeof it.tile.z === "number")
    .map((it) => ({
      instanceId: it.instanceId,
      defId: it.defId,
      tile: it.tile,
      rot: it.rot || 0,
      stackIndex: it.stackIndex || 0,
      y: typeof it.y === "number" && Number.isFinite(it.y) ? it.y : undefined
    }))
}

const win = createWindowManager({ initialZ: 50, bottomMargin: 70 })
const disconnectModal = createDisconnectModal({ win })
const connectingModal = createConnectingModal({ win })
let remoteTargets = {}

let myPubkey
let myAvatar
let myTarget = { x: 0, z: 0 }
let lastSentPosAt = 0
let wasMoving = false

let myPose = "stand"
let sittingOnInstanceId = ""

let pendingSit = null

let myPath = null

let lastAnimAt = 0

let joinConnecting = false
let joinGotSnapshot = false
let joinConnectTimeout = null

let roomAnnounceInterval = null

const PUBLIC_ROOM_TTL_MS = 60_000
let publicRooms = null

let currentRoom = null
let net = null

const typingIndicators = new Map()
let myTypingActive = false
let myTypingIdleTimer = null

let furniSaveTimer = null
let loadingRoomState = false

let suppressDisconnectUntil = 0

let chatBubbleLayer = null
let chatBubbles = []

const zoomNotches = [0.65, 0.75, 0.85, 1.0, 1.15, 1.3, 1.5]
let zoomNotchIndex = 3
let zoomWheelAccum = 0
let pinchState = null

let myDisplayName = ""
const playerNames = {}
const nostrProfileRequested = new Set()

const chatLog = document.getElementById("chatLog")
const lobbyEl = document.getElementById("lobby")
const publicRoomsEl = document.getElementById("publicRooms")
const myRoomsEl = document.getElementById("myRooms")
const joinHintEl = document.getElementById("joinHint")

const roomInfoEl = document.getElementById("roomInfo")
const roomInfoNameEl = document.getElementById("roomInfoName")
const roomInfoCodeEl = document.getElementById("roomInfoCode")
const roomInfoHostEl = document.getElementById("roomInfoHost")
const roomInfoPlanEl = document.getElementById("roomInfoPlan")
const roomInfoCountEl = document.getElementById("roomInfoCount")
const roomInfoActionEl = document.getElementById("roomInfoAction")

const tabPublic = document.getElementById("tabPublic")
const tabMine = document.getElementById("tabMine")
const tabJoin = document.getElementById("tabJoin")

const viewPublic = document.getElementById("viewPublic")
const viewMine = document.getElementById("viewMine")
const viewJoin = document.getElementById("viewJoin")

const createRoomBtn = document.getElementById("createRoomBtn")
const joinBtn = document.getElementById("joinBtn")
const joinCode = document.getElementById("joinCode")

const sendBtn = document.getElementById("sendBtn")
const chatInput = document.getElementById("chatInput")

const detailsPanelEl = document.getElementById("detailsPanel")
const detailsTitleEl = document.getElementById("detailsTitle")
const detailsBodyEl = document.getElementById("detailsBody")
const detailsCloseEl = document.getElementById("detailsClose")
const detailsActionsEl = document.getElementById("detailsActions")

const dockNavigator = document.getElementById("dockNavigator")
const dockInventory = document.getElementById("dockInventory")
const dockShop = document.getElementById("dockShop")
const dockProfile = document.getElementById("dockProfile")
const dockWardrobe = document.getElementById("dockWardrobe")

const inventoryEl = document.getElementById("inventory")
const shopEl = document.getElementById("shop")
const catalogEl = document.getElementById("catalog")
const inventoryListEl = document.getElementById("inventoryList")
const inventoryRefreshEl = document.getElementById("inventoryRefresh")
const inventoryPlaceEl = document.getElementById("inventoryPlace")
const inventoryCancelPlaceEl = document.getElementById("inventoryCancelPlace")
const coinBalanceEl = document.getElementById("coinBalance")
const claimCoinsEl = document.getElementById("claimCoins")
const shopCategoriesEl = document.getElementById("shopCategories")
const profileEl = document.getElementById("profile")
const profileNameEl = document.getElementById("profileName")
const profileSaveEl = document.getElementById("profileSave")
const wardrobeEl = document.getElementById("wardrobe")
const wardrobeSaveEl = document.getElementById("wardrobeSave")
const avatarSkinEl = document.getElementById("avatarSkin")
const avatarHairEl = document.getElementById("avatarHair")
const avatarTopEl = document.getElementById("avatarTop")
const avatarBottomEl = document.getElementById("avatarBottom")
const avatarFaceEl = document.getElementById("avatarFace")
const createRoomWinEl = document.getElementById("createRoom")
const createRoomNameEl = document.getElementById("createRoomName")
const createRoomPlanEl = document.getElementById("createRoomPlan")
const createRoomTemplatesEl = document.getElementById("createRoomTemplates")
const createRoomPublicEl = document.getElementById("createRoomPublic")
const createRoomConfirmEl = document.getElementById("createRoomConfirm")
const createRoomCancelEl = document.getElementById("createRoomCancel")

let selectedCreateRoomPlan = ""
let selectedCreateRoomDoor = null
let selectedCreateRoomEntryDir = 2
let customScrollbarApi = null

const catalog = [
  { defId: "chair_basic", name: "Chair", price: 5, category: "Seating" },
  { defId: "table_basic", name: "Table", price: 10, category: "Tables" },
  { defId: "plant_basic", name: "Plant", price: 7, category: "Decor" },
  { defId: "block_white", name: "White Block", price: 1, category: "Blocks" },
  { defId: "block_black", name: "Black Block", price: 1, category: "Blocks" },
  { defId: "block_red", name: "Red Block", price: 1, category: "Blocks" },
  { defId: "block_green", name: "Green Block", price: 1, category: "Blocks" },
  { defId: "block_blue", name: "Blue Block", price: 1, category: "Blocks" },
  { defId: "block_yellow", name: "Yellow Block", price: 1, category: "Blocks" },
  { defId: "block_purple", name: "Purple Block", price: 1, category: "Blocks" }
]

const inventoryItems = new Map()
const itemLocations = new Map()
let inventorySub = null
let itemLocSub = null
let selectedInstanceId = ""

let coinsSub = null
let coinsBalance = null
let latestBalanceEvent = null

let selectedCatalogDefId = ""
let isPlacing = false
let ghostItem = null
let ghostInstanceId = ""

let placementStackDefId = ""

let thumbRenderer = null
let thumbCanvas = null
let thumbCache = new Map()

let lastClaimsSet = null

let claimCountdownTimer = null

let movingInstanceId = ""
let movingStartTile = null

let pendingLocUpdates = new Map()
let pendingLocTimer = null

let blockedTileSet = new Set()

let floorBaseYByKey = new Map()
let walkSurfaceYByKey = new Map()

const BLOCK_UNIT = 1
const MAX_STEP_UP = 1.05
const MAX_STEP_DOWN = 1.5

const furniDefs = {
  chair_basic: {
    displayName: "Chair",
    description: "A simple chair.",
    height: 0.9,
    footprint: { w: 1, d: 1 },
    blocksMovement: true,
    stackable: false,
    actions: ["sit"]
  },
  table_basic: {
    displayName: "Table",
    description: "A basic table.",
    height: 0.8,
    footprint: { w: 1, d: 1 },
    blocksMovement: true,
    stackable: false,
    actions: []
  },
  plant_basic: {
    displayName: "Plant",
    description: "A decorative plant.",
    height: 1.1,
    footprint: { w: 1, d: 1 },
    blocksMovement: true,
    stackable: true,
    stackHeightStep: 0.55,
    actions: []
  },
  block_white: {
    displayName: "White Block",
    description: "A cheap walkable block.",
    height: 1,
    footprint: { w: 1, d: 1 },
    blocksMovement: false,
    stackable: true,
    stackHeightStep: 1,
    actions: []
  },
  block_black: {
    displayName: "Black Block",
    description: "A cheap walkable block.",
    height: 1,
    footprint: { w: 1, d: 1 },
    blocksMovement: false,
    stackable: true,
    stackHeightStep: 1,
    actions: []
  },
  block_red: {
    displayName: "Red Block",
    description: "A cheap walkable block.",
    height: 1,
    footprint: { w: 1, d: 1 },
    blocksMovement: false,
    stackable: true,
    stackHeightStep: 1,
    actions: []
  },
  block_green: {
    displayName: "Green Block",
    description: "A cheap walkable block.",
    height: 1,
    footprint: { w: 1, d: 1 },
    blocksMovement: false,
    stackable: true,
    stackHeightStep: 1,
    actions: []
  },
  block_blue: {
    displayName: "Blue Block",
    description: "A cheap walkable block.",
    height: 1,
    footprint: { w: 1, d: 1 },
    blocksMovement: false,
    stackable: true,
    stackHeightStep: 1,
    actions: []
  },
  block_yellow: {
    displayName: "Yellow Block",
    description: "A cheap walkable block.",
    height: 1,
    footprint: { w: 1, d: 1 },
    blocksMovement: false,
    stackable: true,
    stackHeightStep: 1,
    actions: []
  },
  block_purple: {
    displayName: "Purple Block",
    description: "A cheap walkable block.",
    height: 1,
    footprint: { w: 1, d: 1 },
    blocksMovement: false,
    stackable: true,
    stackHeightStep: 1,
    actions: []
  }
}

function getFurniDef(defId) {
  return (
    furniDefs[String(defId || "")] || {
      displayName: "Furni",
      description: "",
      height: 0.7,
      footprint: { w: 1, d: 1 },
      blocksMovement: true,
      stackable: false,
      actions: []
    }
  )
}

function tileKey(x, z) {
  return `${x},${z}`
}

function getItemStackStep(defId) {
  const def = getFurniDef(defId)
  const v = Number(def?.stackHeightStep || def?.height)
  return Number.isFinite(v) && v > 0 ? v : 0.4
}

function getStackBaseY(tile, stackIndex) {
  if (!tile) return 0
  const si = Number(stackIndex || 0) || 0
  let y = getTileBaseY(tile)
  const below = Array.from(placedItems.values())
    .filter((it) => it?.tile?.x === tile.x && it?.tile?.z === tile.z)
    .map((it) => ({ it, si: Number(it.stackIndex || 0) || 0 }))
    .filter((x) => x.si < si)
    .sort((a, b) => a.si - b.si)
  for (const { it } of below) {
    y += getItemStackStep(it.defId)
  }
  return y
}

function computePlacementY(tile, defId, { excludeInstanceId = "" } = {}) {
  const def = getFurniDef(defId)
  const baseY = getTileBaseY(tile)
  if (!def?.stackable) return baseY

  let y = baseY
  for (const it of placedItems.values()) {
    if (!it?.tile) continue
    if (excludeInstanceId && String(it.instanceId || "") === String(excludeInstanceId)) continue
    if (it.tile.x !== tile.x || it.tile.z !== tile.z) continue
    const itY = typeof it.y === "number" && Number.isFinite(it.y) ? it.y : it.mesh?.position?.y
    if (typeof itY !== "number" || !Number.isFinite(itY)) continue
    const top = itY + getItemStackStep(it.defId)
    if (top > y) y = top
  }
  return y
}

function rebuildBlockedTiles() {
  const next = new Set()
  for (const it of placedItems.values()) {
    if (!it?.tile) continue
    const def = getFurniDef(it.defId)
    if (!def?.blocksMovement) continue
    next.add(tileKey(it.tile.x, it.tile.z))
  }
  blockedTileSet = next

  const base = new Map()
  const tiles = floor?.userData?.tiles?.children
  if (tiles && Array.isArray(tiles)) {
    for (const t of tiles) {
      const tt = t?.userData?.tile
      if (!tt) continue
      if (typeof tt.x !== "number" || typeof tt.z !== "number") continue
      const y = typeof t.position?.y === "number" ? t.position.y : 0
      base.set(tileKey(tt.x, tt.z), y)
    }
  }
  floorBaseYByKey = base

  const surface = new Map()
  for (const [k, y] of base.entries()) surface.set(k, y)

  for (const it of placedItems.values()) {
    if (!it?.tile) continue
    const def = getFurniDef(it.defId)
    if (def?.blocksMovement !== false) continue
    const k = tileKey(it.tile.x, it.tile.z)
    const by = base.get(k) ?? 0

    const step = getItemStackStep(it.defId)
    const h = Number(def?.height || step)
    const height = Number.isFinite(h) && h > 0 ? h : step
    const itY = typeof it.y === "number" && Number.isFinite(it.y) ? it.y : it.mesh?.position?.y
    if (typeof itY !== "number" || !Number.isFinite(itY)) continue

    const top = itY + height
    const prev = surface.get(k) ?? by
    if (top > prev) surface.set(k, top)
  }

  walkSurfaceYByKey = surface
}

function getTileBaseY(tile) {
  if (!tile) return 0
  const k = tileKey(tile.x, tile.z)
  if (floorBaseYByKey.has(k)) return floorBaseYByKey.get(k)
  return 0
}

function getWalkSurfaceY(tile) {
  if (!tile) return 0
  const k = tileKey(tile.x, tile.z)
  if (walkSurfaceYByKey.has(k)) return walkSurfaceYByKey.get(k)
  if (floorBaseYByKey.has(k)) return floorBaseYByKey.get(k)
  return 0
}

function getStackIndexForTile(tile) {
  if (!tile) return 0
  let max = -1
  for (const it of placedItems.values()) {
    if (!it?.tile) continue
    if (it.tile.x !== tile.x || it.tile.z !== tile.z) continue
    const si = Number(it.stackIndex || 0) || 0
    if (si > max) max = si
  }
  return max + 1
}

function getStackIndexForTileExcluding(tile, instanceId) {
  if (!tile) return 0
  let max = -1
  for (const it of placedItems.values()) {
    if (!it?.tile) continue
    if (it.instanceId === instanceId) continue
    if (it.tile.x !== tile.x || it.tile.z !== tile.z) continue
    const si = Number(it.stackIndex || 0) || 0
    if (si > max) max = si
  }
  return max + 1
}

function colorFromId(id) {
  return `#${colorFromString(String(id || "")).toString(16).padStart(6, "0")}`
}

function startOfUtcDaySeconds(tsMs = Date.now()) {
  const d = new Date(tsMs)
  d.setUTCHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function endOfUtcDaySeconds(tsMs = Date.now()) {
  return startOfUtcDaySeconds(tsMs) + 24 * 60 * 60
}

function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0))
  const hh = String(Math.floor(s / 3600)).padStart(2, "0")
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0")
  const ss = String(s % 60).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

function ensureThumbRenderer(size) {
  const s = Math.max(32, Math.floor(size || 64))
  if (!thumbCanvas) {
    thumbCanvas = document.createElement("canvas")
  }
  if (thumbCanvas.width !== s || thumbCanvas.height !== s) {
    thumbCanvas.width = s
    thumbCanvas.height = s
  }
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({
      canvas: thumbCanvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true
    })
  }
  thumbRenderer.setSize(s, s, false)
  thumbRenderer.setPixelRatio(1)
  return { renderer: thumbRenderer, canvas: thumbCanvas, size: s }
}

function getFurniThumbUrl(defId, size = 64) {
  const key = `${String(defId || "")}:${Math.floor(size)}`
  const cached = thumbCache.get(key)
  if (cached) return cached

  try {
    const { renderer, canvas, size: s } = ensureThumbRenderer(size)
    const sceneT = new THREE.Scene()
    const cam = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.01, 50)
    cam.rotation.order = "YXZ"
    cam.rotation.y = Math.PI / 4
    cam.rotation.x = -Math.atan(1 / Math.sqrt(2))
    cam.position.set(3.0, 3.0, 3.0)
    cam.lookAt(0, 0.4, 0)

    const mesh = createFurniMesh(defId)
    const box = new THREE.Box3().setFromObject(mesh)
    const sizeV = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(sizeV)
    box.getCenter(center)

    const maxDim = Math.max(sizeV.x, sizeV.y, sizeV.z) || 1
    const scale = 1.6 / maxDim
    mesh.scale.setScalar(scale)
    mesh.position.sub(center.multiplyScalar(scale))

    sceneT.add(mesh)

    renderer.setClearColor(0x000000, 0)
    renderer.render(sceneT, cam)
    const url = canvas.toDataURL("image/png")
    thumbCache.set(key, url)
    return url
  } catch {
    return ""
  }
}

function makeThumbEl(defId) {
  const img = document.createElement("img")
  img.className = "thumb-img"
  img.alt = ""
  img.draggable = false
  const url = getFurniThumbUrl(defId, 64)
  if (url) img.src = url
  return img
}

function getSelectedPlacementDefId() {
  if (!selectedInstanceId) return ""
  const inv = inventoryItems.get(selectedInstanceId)
  return inv?.defId || ""
}

function setPlacingMode(on) {
  isPlacing = Boolean(on)
  if (inventoryPlaceEl) inventoryPlaceEl.classList.toggle("selected", isPlacing)
  if (inventoryCancelPlaceEl) inventoryCancelPlaceEl.disabled = !isPlacing

  if (!isPlacing) {
    placementStackDefId = ""
    ghostInstanceId = ""
    if (ghostItem) {
      try {
        scene.remove(ghostItem)
      } catch {}
      ghostItem = null
    }
  } else {
    ensureGhostForSelected()
  }
}

function ensureGhostForSelected() {
  const defId = getSelectedPlacementDefId()
  if (!defId) return
  if (ghostItem && ghostInstanceId === selectedInstanceId) return

  if (ghostItem) {
    try {
      scene.remove(ghostItem)
    } catch {}
    ghostItem = null
  }

  const mesh = createGhostFurniMesh(defId)
  ghostItem = mesh
  ghostInstanceId = selectedInstanceId
  scene.add(ghostItem)
}

function updateGhostFromMouseEvent(e) {
  if (!isPlacing) return
  if (!floor?.userData?.tiles) return
  if (!raycaster || !mouse || !camera) return

  ensureGhostForSelected()
  if (!ghostItem) return

  mouse.x = (e.clientX / window.innerWidth) * 2 - 1
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(mouse, camera)

  const hits = raycaster.intersectObject(floor.userData.tiles, true)
  if (!hits || hits.length === 0) {
    ghostItem.visible = false
    return
  }

  const tile = hits[0].object?.userData?.tile
  if (!tile || !floor?.userData?.tileToWorld) {
    ghostItem.visible = false
    return
  }

  const w = floor.userData.tileToWorld(tile.x, tile.z)
  ghostItem.visible = true
  ghostItem.position.x = w.x
  ghostItem.position.z = w.z

  const defId = getSelectedPlacementDefId()
  const def = getFurniDef(defId)
  if (def?.stackable) {
    const stackIndex = getStackIndexForTile(tile)
    let y = getTileBaseY(tile)
    const below = Array.from(placedItems.values())
      .filter((it) => it?.tile?.x === tile.x && it?.tile?.z === tile.z)
      .map((it) => ({ it, si: Number(it.stackIndex || 0) || 0 }))
      .filter((x) => x.si < stackIndex)
      .sort((a, b) => a.si - b.si)
    for (const { it } of below) {
      y += getItemStackStep(it.defId)
    }
    ghostItem.position.y = y
  } else {
    ghostItem.position.y = getTileBaseY(tile)
  }
}

function ensureShopCategories() {
  if (!shopCategoriesEl) return
  const cats = Array.from(new Set(catalog.map((x) => x.category || "Other")))
  cats.sort((a, b) => a.localeCompare(b))
  const all = ["All", ...cats]
  shopCategoriesEl.innerHTML = ""
  for (const c of all) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "shop-cat"
    btn.textContent = c
    btn.classList.toggle("selected", String(selectedShopCategory) === String(c))
    btn.onclick = () => {
      selectedShopCategory = c
      ensureShopCategories()
      renderCatalog()
    }
    shopCategoriesEl.appendChild(btn)
  }
}

function tryPlaceSelectedAtTile(tile) {
  if (!tile || typeof tile.x !== "number" || typeof tile.z !== "number") return false
  if (!currentRoom?.isHost) return false
  if (!selectedInstanceId || !net) return false
  const inv = inventoryItems.get(selectedInstanceId)
  if (!inv?.defId) return false

  const def = getFurniDef(inv.defId)
  const occupied = Array.from(placedItems.values()).some((it) => it?.tile?.x === tile.x && it?.tile?.z === tile.z)
  if (occupied && !def?.stackable) return false
  const stackIndex = def?.stackable ? getStackIndexForTile(tile) : 0

  const y = computePlacementY(tile, inv.defId)
  const item = { instanceId: selectedInstanceId, defId: inv.defId, tile: { x: tile.x, z: tile.z }, rot: 0, stackIndex, y }
  if (currentRoom?.isHost) {
    placeItemLocal(item)
    net.broadcast({ type: "item_placed", item })
  } else {
    net.broadcast({ type: "place_item", item })
  }

  if (placementStackDefId && placementStackDefId === inv.defId) {
    const placedIds = new Set(Array.from(placedItems.keys()))
    const next = Array.from(inventoryItems.values())
      .filter((x) => x?.defId === placementStackDefId)
      .filter((x) => x?.instanceId && !placedIds.has(x.instanceId))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0]

    if (next?.instanceId) {
      selectedInstanceId = next.instanceId
      ensureGhostForSelected()
      renderInventory()
    } else {
      setPlacingMode(false)
      if (inventoryEl) win.showWindow(inventoryEl, dockInventory)
    }
  }
  return true
}

const placedItems = new Map()
let placedGroup = null

function getDefaultPlanCode() {
  return [
    "xx0000xx",
    "x000000x",
    "00000000",
    "00000000",
    "x000000x",
    "xx0000xx"
  ].join("\n")
}

function renderPlanPreview(canvas, plan, door) {
  if (!canvas) return

  const cssW = canvas.clientWidth || 140
  const cssH = canvas.clientHeight || 90
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  const w = Math.max(1, Math.floor(cssW * dpr))
  const h = Math.max(1, Math.floor(cssH * dpr))

  const prevW = Number(canvas.dataset.previewW || 0)
  const prevH = Number(canvas.dataset.previewH || 0)
  const sizeChanged = prevW !== w || prevH !== h

  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h

  if (!sizeChanged && canvas.dataset.previewRendered === "true" && canvas.dataset.previewPlan === plan) {
    return
  }

  const scene = new THREE.Scene()

  const frustumSize = 26
  const aspect = w / h
  const cam = new THREE.OrthographicCamera(
    (frustumSize * aspect) / -2,
    (frustumSize * aspect) / 2,
    frustumSize / 2,
    frustumSize / -2,
    0.1,
    1000
  )

  cam.rotation.order = "YXZ"
  cam.rotation.y = Math.PI / 4
  cam.rotation.x = -Math.atan(1 / Math.sqrt(2))
  cam.position.set(28, 28, 28)

  let r
  try {
    r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  } catch {
    return
  }
  r.setPixelRatio(1)
  r.setSize(w, h, false)
  r.setClearColor(0x000000, 0)

  const previewFloor = createRoom(scene, { plan, door: door || null })
  r.render(scene, cam)

  try {
    r.dispose()
  } catch {}

  try {
    const tilesCount = previewFloor?.userData?.planParsed?.tiles?.length
    if (typeof tilesCount === "number") {
      canvas.dataset.planTiles = String(tilesCount)
      const titleEl = canvas.closest?.(".plan-card")?.querySelector?.(".plan-title")
      if (titleEl) titleEl.textContent = `${tilesCount} tiles`
    }
  } catch {}

  canvas.dataset.previewRendered = "true"
  canvas.dataset.previewPlan = plan
  canvas.dataset.previewW = String(w)
  canvas.dataset.previewH = String(h)
}

function renderPlanPreviews() {
  const host = document
  const canvases = host.querySelectorAll("canvas[data-plan-preview]")
  for (const c of canvases) {
    const card = c.closest?.(".plan-card")
    const code = card?.getAttribute?.("data-plan-code")
    const plan = code || selectedCreateRoomPlan || getDefaultPlanCode()
    const door = getDoorFromTemplateButton(card) || selectedCreateRoomDoor || null
    renderPlanPreview(c, plan, door)
  }
}

function getDoorFromTemplateButton(btn) {
  const xRaw = Number(btn?.getAttribute?.("data-door-x"))
  const zRaw = Number(btn?.getAttribute?.("data-door-z"))
  if (!Number.isFinite(xRaw) || !Number.isFinite(zRaw)) return null
  return { x: Math.floor(xRaw), z: Math.floor(zRaw) }
}

function getEntryDirFromTemplateButton(btn) {
  const raw = Number(btn?.getAttribute?.("data-entry-dir"))
  if (!Number.isFinite(raw)) return 2
  return raw
}

function initCustomScrollbars() {
  const clampLocal = (n, min, max) => Math.min(max, Math.max(min, n))

  const refreshCustomScrollbars = () => {
    for (const el of document.querySelectorAll(".cs-scroll")) {
      try {
        el._csUpdate?.()
      } catch {}
    }
  }

  const els = []

  for (const el of document.querySelectorAll(".view, .list, .chatlog")) {
    if (el.classList.contains("list") && el.closest(".view")) continue
    els.push(el)
  }

  for (const el of document.querySelectorAll(".winbody")) {
    if (el.querySelector(".view")) continue
    els.push(el)
  }

  const shouldSkip = (el) => {
    if (!el) return true
    if (el.classList.contains("cs-scroll")) return true
    if (el.closest(".cs-scroll")) return true
    if (el.closest(".cs-wrapper")) return true
    return false
  }

  const mount = (scrollEl) => {
    if (shouldSkip(scrollEl)) return

    if (scrollEl._csBar) return

    scrollEl.classList.add("cs-scroll")
    const cs = getComputedStyle(scrollEl)
    if (cs.position === "static") {
      scrollEl.style.position = "relative"
    }

    if (!scrollEl.dataset.csPadRight) {
      const pr = Number.parseFloat(cs.paddingRight || "0") || 0
      scrollEl.dataset.csPadRight = String(pr)
      scrollEl.style.paddingRight = `${pr + 22}px`
    }

    const bar = document.createElement("div")
    bar.className = "cs-bar"

    const overlayHost = scrollEl.closest?.(".window") || null
    if (!overlayHost) {
      bar.classList.add("cs-fixed")
    }

    const btnUp = document.createElement("button")
    btnUp.className = "cs-btn cs-up"
    btnUp.type = "button"
    btnUp.innerHTML = '<span class="cs-icon" aria-hidden="true">keyboard_arrow_up</span>'
    btnUp.setAttribute("aria-label", "Scroll up")

    const btnDown = document.createElement("button")
    btnDown.className = "cs-btn cs-down"
    btnDown.type = "button"
    btnDown.innerHTML = '<span class="cs-icon" aria-hidden="true">keyboard_arrow_down</span>'
    btnDown.setAttribute("aria-label", "Scroll down")

    const track = document.createElement("div")
    track.className = "cs-track"

    const thumb = document.createElement("div")
    thumb.className = "cs-thumb"
    const thumbIcon = document.createElement("span")
    thumbIcon.className = "cs-thumb-icon cs-icon"
    thumbIcon.setAttribute("aria-hidden", "true")
    thumbIcon.textContent = "drag_indicator"
    thumb.appendChild(thumbIcon)
    track.appendChild(thumb)

    bar.appendChild(btnUp)
    bar.appendChild(track)
    bar.appendChild(btnDown)

    ;(overlayHost || document.body).appendChild(bar)
    scrollEl._csBar = bar

    const update = () => {
      const rect = scrollEl.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0

      const scrollH = scrollEl.scrollHeight
      const clientH = scrollEl.clientHeight
      const maxScroll = Math.max(0, scrollH - clientH)
      const canScroll = maxScroll > 1
      bar.style.display = visible ? "flex" : "none"
      bar.classList.toggle("cs-disabled", !canScroll)
      btnUp.disabled = !canScroll
      btnDown.disabled = !canScroll

      const inset = 6
      const barW = 18

      const hostRect = overlayHost ? overlayHost.getBoundingClientRect() : null
      const topBase = hostRect ? hostRect.top : 0
      const leftBase = hostRect ? hostRect.left : 0

      const topPx = Math.round(rect.top - topBase + inset)
      const leftPx = Math.round(rect.right - leftBase - inset - barW)
      const heightPx = Math.max(0, Math.round(rect.height - inset * 2))

      bar.style.top = `${topPx}px`
      bar.style.left = `${leftPx}px`
      bar.style.height = `${heightPx}px`

      if (!canScroll) {
        thumb.style.display = "none"
        return
      }

      thumb.style.display = "flex"

      const trackH = track.clientHeight
      const btnSpace = 0
      const usable = Math.max(0, trackH - btnSpace)
      const ratio = clientH / scrollH
      const thumbH = clampLocal(Math.round(usable * ratio), 18, Math.max(18, usable))
      const maxThumbTop = Math.max(0, usable - thumbH)
      const t = maxScroll ? (scrollEl.scrollTop / maxScroll) : 0
      const top = Math.round(maxThumbTop * t)
      thumb.style.height = `${thumbH}px`
      thumb.style.transform = `translateY(${top}px)`
    }

    scrollEl._csUpdate = update

    const scrollStep = () => Math.max(24, Math.round(scrollEl.clientHeight * 0.12))
    btnUp.addEventListener("click", () => scrollEl.scrollBy({ top: -scrollStep(), behavior: "auto" }))
    btnDown.addEventListener("click", () => scrollEl.scrollBy({ top: scrollStep(), behavior: "auto" }))

    let drag = null
    const startDrag = (e) => {
      e.preventDefault()
      e.stopPropagation()

      const scrollH = scrollEl.scrollHeight
      const clientH = scrollEl.clientHeight
      const maxScroll = Math.max(0, scrollH - clientH)
      if (maxScroll <= 1) return

      const trackH = track.clientHeight
      const ratio = clientH / scrollH
      const thumbH = clampLocal(Math.round(trackH * ratio), 18, Math.max(18, trackH))
      const maxThumbTop = Math.max(0, trackH - thumbH)
      const startY = e.clientY
      const startScroll = scrollEl.scrollTop
      drag = { startY, startScroll, maxThumbTop, maxScroll }
      thumb.setPointerCapture(e.pointerId)
      document.body.classList.add("dragging")
    }

    const onDragMove = (e) => {
      if (!drag) return
      const dy = e.clientY - drag.startY
      const pct = drag.maxThumbTop ? (dy / drag.maxThumbTop) : 0
      scrollEl.scrollTop = clampLocal(drag.startScroll + pct * drag.maxScroll, 0, drag.maxScroll)
    }

    const endDrag = () => {
      if (!drag) return
      drag = null
      document.body.classList.remove("dragging")
    }

    thumb.addEventListener("pointerdown", startDrag)
    thumb.addEventListener("pointermove", onDragMove)
    thumb.addEventListener("pointerup", endDrag)
    thumb.addEventListener("pointercancel", endDrag)

    track.addEventListener("pointerdown", (e) => {
      if (e.target === thumb) return
      const rect = track.getBoundingClientRect()
      const y = e.clientY - rect.top
      const scrollH = scrollEl.scrollHeight
      const clientH = scrollEl.clientHeight
      const maxScroll = Math.max(0, scrollH - clientH)
      if (maxScroll <= 1) return

      const ratio = clientH / scrollH
      const thumbH = clampLocal(Math.round(track.clientHeight * ratio), 18, Math.max(18, track.clientHeight))
      const maxThumbTop = Math.max(0, track.clientHeight - thumbH)
      const targetThumbTop = clampLocal(y - thumbH / 2, 0, maxThumbTop)
      const t = maxThumbTop ? (targetThumbTop / maxThumbTop) : 0
      scrollEl.scrollTop = t * maxScroll
    })

    scrollEl.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(() => update())
    ro.observe(scrollEl)
    update()
  }

  for (const el of els) mount(el)

  requestAnimationFrame(() => refreshCustomScrollbars())
  window.addEventListener("resize", () => refreshCustomScrollbars())
  document.addEventListener("wm:layout", () => refreshCustomScrollbars())

  return { refreshCustomScrollbars }
}

init()
animate()

function setInRoom(inRoom) {
  document.body.classList.toggle("in-room", Boolean(inRoom))

  try {
    customScrollbarApi?.refreshCustomScrollbars?.()
  } catch {}

  if (floor) {
    floor.visible = Boolean(inRoom)
    const tiles = floor.userData?.tiles
    if (tiles) tiles.visible = Boolean(inRoom)
    const walls = floor.userData?.walls
    if (walls) walls.visible = Boolean(inRoom)
  }

  if (chatBubbleLayer) {
    chatBubbleLayer.style.display = inRoom ? "block" : "none"
  }
}

function snapToTileCenter(pos) {
  const wtt = floor?.userData?.worldToTile
  const ttw = floor?.userData?.tileToWorld
  if (wtt && ttw) {
    const t = wtt(pos.x, pos.z)
    const w = ttw(t.x, t.z)
    return { x: w.x, z: w.z }
  }

  const sx = Math.round(pos.x - 0.5) + 0.5
  const sz = Math.round(pos.z - 0.5) + 0.5
  return { x: sx, z: sz }
}

function toTileCoord(pos) {
  const wtt = floor?.userData?.worldToTile
  if (wtt) return wtt(pos.x, pos.z)
  return { x: Math.round(pos.x - 0.5), z: Math.round(pos.z - 0.5) }
}

function isTileWalkable(pos) {
  if (!floor?.userData?.tileSet) return true
  const t = toTileCoord(pos)
  if (!floor.userData.tileSet.has(`${t.x},${t.z}`)) return false
  return !blockedTileSet.has(tileKey(t.x, t.z))
}

function isTileCoordWalkable(tile, { allowBlocked = false } = {}) {
  if (!tile) return false
  if (!floor?.userData?.tileSet) return true
  const k = tileKey(tile.x, tile.z)
  if (!floor.userData.tileSet.has(k)) return false
  if (allowBlocked) return true
  return !blockedTileSet.has(k)
}

function canStepBetweenTiles(fromTile, toTile) {
  const y0 = getWalkSurfaceY(fromTile)
  const y1 = getWalkSurfaceY(toTile)
  const dy = y1 - y0
  if (dy > MAX_STEP_UP) return false
  if (-dy > MAX_STEP_DOWN) return false
  return true
}

function findPathAStar(startTile, goalTile, { allowGoalBlocked = false, allowStartBlocked = false } = {}) {
  if (!startTile || !goalTile) return null
  const startKey = tileKey(startTile.x, startTile.z)
  const goalKey = tileKey(goalTile.x, goalTile.z)
  if (startKey === goalKey) return [startTile]
  if (!allowStartBlocked && !isTileCoordWalkable(startTile)) return null
  if (!isTileCoordWalkable(goalTile, { allowBlocked: allowGoalBlocked })) return null

  const open = new Set([startKey])
  const cameFrom = new Map()
  const gScore = new Map([[startKey, 0]])
  const fScore = new Map([[startKey, 0]])

  const h = (a, b) => {
    const dx = Math.abs(a.x - b.x)
    const dz = Math.abs(a.z - b.z)
    return Math.max(dx, dz)
  }
  fScore.set(startKey, h(startTile, goalTile))

  const parseKey = (k) => {
    const [x, z] = k.split(",").map((n) => Number(n))
    return { x, z }
  }

  const neighbors = (t) => {
    const out = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue
        const nt = { x: t.x + dx, z: t.z + dz }
        const diag = dx !== 0 && dz !== 0
        if (diag) {
          const a = { x: t.x + dx, z: t.z }
          const b = { x: t.x, z: t.z + dz }
          if (!isTileCoordWalkable(a)) continue
          if (!isTileCoordWalkable(b)) continue
        }
        const allowBlocked = allowGoalBlocked && tileKey(nt.x, nt.z) === goalKey
        if (!isTileCoordWalkable(nt, { allowBlocked })) continue
        if (!canStepBetweenTiles(t, nt)) continue
        out.push(nt)
      }
    }
    return out
  }

  const dist = (a, b) => {
    const dx = Math.abs(a.x - b.x)
    const dz = Math.abs(a.z - b.z)
    return dx !== 0 && dz !== 0 ? 1.4142 : 1
  }

  while (open.size) {
    let currentKey = null
    let bestF = Infinity
    for (const k of open) {
      const f = fScore.get(k) ?? Infinity
      if (f < bestF) {
        bestF = f
        currentKey = k
      }
    }
    if (!currentKey) break
    if (currentKey === goalKey) {
      const path = []
      let ck = currentKey
      while (ck) {
        path.push(parseKey(ck))
        ck = cameFrom.get(ck)
      }
      path.reverse()
      return path
    }

    open.delete(currentKey)
    const current = parseKey(currentKey)
    const currentG = gScore.get(currentKey) ?? Infinity
    for (const nb of neighbors(current)) {
      const nbKey = tileKey(nb.x, nb.z)
      const tentativeG = currentG + dist(current, nb)
      const prevG = gScore.get(nbKey)
      if (prevG == null || tentativeG < prevG) {
        cameFrom.set(nbKey, currentKey)
        gScore.set(nbKey, tentativeG)
        fScore.set(nbKey, tentativeG + h(nb, goalTile))
        open.add(nbKey)
      }
    }
  }

  return null
}

function fromTileCoord(tile) {
  const ttw = floor?.userData?.tileToWorld
  if (ttw) {
    const w = ttw(tile.x, tile.z)
    return { x: w.x, z: w.z }
  }
  return { x: tile.x + 0.5, z: tile.z + 0.5 }
}

function getSpawnPos() {
  const door = floor?.userData?.door
  const tileToWorld = floor?.userData?.tileToWorld
  if (door && tileToWorld) {
    const t = door.outer || door.inner || door
    const w = tileToWorld(t.x, t.z)
    return { x: w.x, z: w.z }
  }

  const parsed = floor?.userData?.planParsed
  const tileToWorld2 = floor?.userData?.tileToWorld
  if (!parsed || !tileToWorld2 || !Array.isArray(parsed.tiles) || parsed.tiles.length === 0) {
    return { x: 0.5, z: 0.5 }
  }

  let best = parsed.tiles[0]
  for (const t of parsed.tiles) {
    if (t.z < best.z) best = t
    else if (t.z === best.z && t.x < best.x) best = t
  }
  const w = tileToWorld2(best.x, best.z)
  return { x: w.x, z: w.z }
}

function setTab(which) {
  tabPublic.classList.toggle("active", which === "public")
  tabMine.classList.toggle("active", which === "mine")
  tabJoin.classList.toggle("active", which === "join")

  viewPublic.classList.toggle("hidden", which !== "public")
  viewMine.classList.toggle("hidden", which !== "mine")
  viewJoin.classList.toggle("hidden", which !== "join")
}

function appendChatLine(text) {
  const line = document.createElement("div")
  line.textContent = text
  chatLog.appendChild(line)
  chatLog.scrollTop = chatLog.scrollHeight
}

function shortId(pubkey) {
  return pubkey ? pubkey.slice(0, 8) : ""
}

function getDisplayName(pubkey) {
  if (!pubkey) return ""
  if (pubkey === myPubkey && myDisplayName) return myDisplayName
  return playerNames[pubkey] || shortId(pubkey)
}

function maybeApplyNostrName(pubkey, name) {
  if (!pubkey || !name) return
  if (pubkey === myPubkey && myDisplayName) return

  const current = playerNames[pubkey]
  if (!current || current === shortId(pubkey)) {
    playerNames[pubkey] = name
  }
}

function requestNostrProfile(pubkey) {
  if (!pubkey) return
  if (nostrProfileRequested.has(pubkey)) return
  nostrProfileRequested.add(pubkey)

  const sub = subscribe({ kinds: [0], authors: [pubkey], limit: 1 }, (ev) => {
    try {
      const obj = JSON.parse(ev?.content || "{}")
      const nm = (obj.display_name || obj.name || "").trim()
      if (nm) maybeApplyNostrName(pubkey, nm)
    } catch {}

    try {
      sub?.unsub?.()
    } catch {}
  })
}

function ensureChatBubbleLayer() {
  if (chatBubbleLayer) return

  chatBubbleLayer = document.createElement("div")
  chatBubbleLayer.id = "chatBubbles"
  chatBubbleLayer.style.position = "absolute"
  chatBubbleLayer.style.left = "0"
  chatBubbleLayer.style.top = "0"
  chatBubbleLayer.style.width = "100%"
  chatBubbleLayer.style.height = "100%"
  chatBubbleLayer.style.pointerEvents = "none"
  chatBubbleLayer.style.overflow = "hidden"
  chatBubbleLayer.style.display = document.body.classList.contains("in-room") ? "block" : "none"
  document.body.appendChild(chatBubbleLayer)
}

function spawnChatBubble(pubkey, text) {
  if (!pubkey || !text) return
  if (!scene || !camera) return

  ensureChatBubbleLayer()

  requestNostrProfile(pubkey)

  const av = avatars[pubkey]
  const worldPos = av ? av.position.clone() : new THREE.Vector3(0, 0, 0)

  const el = document.createElement("div")
  el.className = "chat-bubble"
  el.textContent = `${getDisplayName(pubkey)}: ${text}`
  chatBubbleLayer.appendChild(el)

  chatBubbles.push({
    pubkey,
    el,
    worldPos,
    createdAt: performance.now(),
    bornFloatPx: 0,
    floatPx: 0,
    x: 0,
    y: 0,
    h: 0
  })
}

function updateChatBubbles() {
  if (!chatBubbleLayer || !camera || !renderer) return

  const now = performance.now()
  const stackGap = 6
  const stackXThresh = 90
  const bandMinY = 10
  const bandMaxY = renderer.domElement.clientHeight * 0.25
  const maxAgeMs = 120_000

  // Habbo-ish: move up a bit, pause, move up...
  const stepCycleMs = 1400
  const stepMoveMs = 240
  const stepPx = 12

  const globalStepFloat = (t) => {
    const cycles = Math.floor(t / stepCycleMs)
    const phase = t - cycles * stepCycleMs
    const moveT = Math.min(1, phase / stepMoveMs)
    return cycles * stepPx + moveT * stepPx
  }

  const globalFloatNow = globalStepFloat(now)

  for (let i = chatBubbles.length - 1; i >= 0; i--) {
    const b = chatBubbles[i]
    const age = now - b.createdAt
    if (age >= maxAgeMs) {
      try {
        b.el.remove()
      } catch {}
      chatBubbles.splice(i, 1)
      continue
    }

    b.el.style.opacity = "1"

    if (typeof b.bornFloatPx !== "number" || b.bornFloatPx === 0) {
      b.bornFloatPx = globalStepFloat(b.createdAt)
    }

    const floatPx = Math.max(0, globalFloatNow - b.bornFloatPx)

    const world = new THREE.Vector3(b.worldPos.x, b.worldPos.y + 2.4, b.worldPos.z)
    const projected = world.project(camera)

    const x = (projected.x * 0.5 + 0.5) * renderer.domElement.clientWidth

    b.h = b.el.offsetHeight || 0
    b.x = x
    const baseY = bandMaxY
    b.y = baseY - floatPx
    b.el.style.display = "block"
  }

  const placed = []
  const ordered = chatBubbles
    .filter((b) => b.el.style.display !== "none")
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)

  for (const b of ordered) {
    let yy = b.y
    for (const p of placed) {
      if (Math.abs(b.x - p.x) > stackXThresh) continue
      const pTop = p.y - p.h
      const bBottom = yy
      if (bBottom > pTop - stackGap) {
        yy = pTop - stackGap
      }
    }
    b.el.style.transform = `translate(-50%, -100%) translate(${b.x}px, ${yy}px)`
    b.finalY = yy
    placed.push({ x: b.x, y: yy, h: b.h })
  }

  for (let i = chatBubbles.length - 1; i >= 0; i--) {
    const b = chatBubbles[i]
    if (b.el.style.display === "none") continue

    const topY = (typeof b.finalY === "number" ? b.finalY : b.y) - (b.h || 0)
    if (topY < -(b.h || 0) - 60) {
      try {
        b.el.remove()
      } catch {}
      chatBubbles.splice(i, 1)
    }
  }
}

function kickToLobby(message) {
  leaveRoom(null)
  disconnectModal.show({ title: "Disconnected", body: message || "The host disconnected." })
}

function leaveRoom(reason) {
  teardownRoom({ reason, showLobby: true })
}

function loadMyRooms() {
  const raw = localStorage.getItem("nabbo_my_rooms")
  const list = raw ? JSON.parse(raw) : []
  return Array.isArray(list) ? list : []
}

function saveMyRooms(rooms) {
  localStorage.setItem("nabbo_my_rooms", JSON.stringify(rooms))
}

function upsertMyRoom(room) {
  const rooms = loadMyRooms()
  const idx = rooms.findIndex((r) => r.roomId === room.roomId)
  if (idx >= 0) rooms[idx] = room
  else rooms.unshift(room)
  saveMyRooms(rooms)
}

function openRoomInfo(room, { isHost } = {}) {
  if (!roomInfoEl) return

  const name = room?.name || room?.code || room?.roomId || "Room"
  const code = room?.code || ""
  const roomId = room?.roomId || ""
  const plan = room?.plan || ""
  const owner = room?.ownerPubkey || ""
  const count = typeof room?.count === "number" ? room.count : null

  if (roomInfoNameEl) roomInfoNameEl.textContent = name
  if (roomInfoCodeEl) roomInfoCodeEl.textContent = code ? `Code: ${code}` : ""
  if (roomInfoHostEl) roomInfoHostEl.textContent = owner ? `Host: ${owner.slice(0, 8)}...` : ""
  if (roomInfoPlanEl) roomInfoPlanEl.textContent = plan ? `Plan: ${plan}` : ""
  if (roomInfoCountEl) roomInfoCountEl.textContent = count === null ? "" : `Visitors: ${count}`

  if (roomInfoActionEl) {
    roomInfoActionEl.textContent = isHost ? "Host" : "Join"
    roomInfoActionEl.onclick = () =>
      startRoom({
        roomId,
        code,
        name: room?.name,
        plan: room?.plan,
        door: room?.door || null,
        entryDir: room?.entryDir ?? 2,
        ownerPubkey: isHost ? myPubkey : room?.ownerPubkey,
        isHost: Boolean(isHost)
      })
  }

  win.showWindow(roomInfoEl)
  win.focusWindow(roomInfoEl)

  try {
    customScrollbarApi?.refreshCustomScrollbars?.()
  } catch {}
}

function makeRoomListItem(room, { forceHost = false, source = "public" } = {}) {
  const r = room || {}
  const name = r.name || r.code || r.roomId || "Room"
  const count = typeof r.count === "number" ? r.count : null

  const isOwner = Boolean(forceHost || (r.ownerPubkey && myPubkey && r.ownerPubkey === myPubkey) || source === "mine")

  const item = document.createElement("div")
  item.className = "item room-item"

  const title = document.createElement("div")
  title.className = "title room-title"
  title.textContent = name
  item.appendChild(title)

  const right = document.createElement("div")
  right.className = "room-right"

  const badge = document.createElement("div")
  badge.className = "room-count"
  badge.textContent = String(count ?? 0)
  right.appendChild(badge)

  const infoBtn = document.createElement("button")
  infoBtn.className = "room-info"
  infoBtn.type = "button"
  infoBtn.setAttribute("aria-label", "Room info")
  infoBtn.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">info</span>'
  infoBtn.addEventListener("click", (e) => {
    e.preventDefault()
    e.stopPropagation()
    openRoomInfo(
      {
        ...r,
        count
      },
      { isHost: isOwner }
    )
  })
  right.appendChild(infoBtn)

  item.appendChild(right)

  item.addEventListener("click", () => {
    startRoom({
      roomId: r.roomId,
      code: r.code,
      name: r.name,
      plan: r.plan,
      door: r.door || null,
      entryDir: r.entryDir ?? 2,
      ownerPubkey: isOwner ? myPubkey : r.ownerPubkey,
      isHost: isOwner
    })
  })

  return item
}

function renderMyRooms() {
  myRoomsEl.innerHTML = ""
  const rooms = loadMyRooms()
  if (rooms.length === 0) {
    const empty = document.createElement("div")
    empty.className = "hint"
    empty.textContent = "No rooms saved yet. Create a room to host one."
    myRoomsEl.appendChild(empty)
    return
  }

  for (const r of rooms) {
    const pub = publicRooms?.get?.(r.roomId)
    const merged = pub ? { ...r, ...pub } : r
    myRoomsEl.appendChild(makeRoomListItem(merged, { source: "mine" }))
  }
}

function renderPublicRooms() {
  publicRoomsEl.innerHTML = ""
  const rooms = publicRooms ? publicRooms.list() : []

  if (rooms.length === 0) {
    const empty = document.createElement("div")
    empty.className = "hint"
    empty.textContent = "No active public rooms yet. Create one!"
    publicRoomsEl.appendChild(empty)
    return
  }

  for (const r of rooms) {
    publicRoomsEl.appendChild(makeRoomListItem(r, { source: "public" }))
  }
}

function startRoomAnnouncements({ roomId, code, name, plan, door }) {
  stopRoomAnnouncements()
  const announce = async () => {
    const count = Math.max(1, avatars ? Object.keys(avatars).length : 1)
    const entryDir = currentRoom?.entryDir
    const payload = JSON.stringify({ type: "room", roomId, code, name, plan, door: door || null, entryDir: entryDir == null ? 2 : entryDir, count, ownerPubkey: myPubkey, ts: Math.floor(Date.now() / 1000) })
    const tags = [["t", "nabbo-room"], ["room", roomId]]
    try {
      await publish(1, payload, tags)
    } catch {}
  }
  announce()
  roomAnnounceInterval = setInterval(announce, 25_000)
}

async function publishRoomClosed({ roomId, code } = {}) {
  const rid = roomId || currentRoom?.roomId
  const c = code || currentRoom?.code
  if (!rid || !c) return
  if (!myPubkey) return

  const payload = JSON.stringify({ type: "room_closed", roomId: rid, code: c, ownerPubkey: myPubkey, ts: Math.floor(Date.now() / 1000) })
  const tags = [["t", "nabbo-room"], ["room", rid]]
  try {
    await publish(1, payload, tags)
  } catch {}
}

function stopRoomAnnouncements() {
  if (roomAnnounceInterval) {
    clearInterval(roomAnnounceInterval)
    roomAnnounceInterval = null
  }
}

function ensureAvatar(pubkey) {
  if (!avatars[pubkey]) {
    avatars[pubkey] = createAvatar(scene, pubkey)
    const app = appearances[pubkey]
    if (app) applyAppearanceForPubkey(pubkey, app)
  }
  return avatars[pubkey]
}

function makeTypingIndicatorSprite() {
  const c = document.createElement("canvas")
  c.width = 96
  c.height = 56
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, c.width, c.height)

  // bubble
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)"
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)"
  ctx.lineWidth = 3
  const r = 16
  const x = 6
  const y = 6
  const w = c.width - 12
  const h = c.height - 18
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r + 10, y + h)
  ctx.lineTo(x + r - 2, y + h + 10) // tail
  ctx.lineTo(x + r - 6, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // dots
  ctx.fillStyle = "rgba(20, 22, 26, 0.75)"
  const cy = y + Math.floor(h * 0.55)
  const dotR = 4
  const spacing = 16
  const cx = x + Math.floor(w / 2)
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath()
    ctx.arc(cx + i * spacing, cy, dotR, 0, Math.PI * 2)
    ctx.fill()
  }

  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true

  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false })
  const spr = new THREE.Sprite(mat)
  spr.renderOrder = 10
  spr.scale.set(1.0, 0.7, 1)
  spr.position.set(0, 3.0, 0)
  return spr
}

function setTypingIndicator(pubkey, active) {
  if (!pubkey) return
  const av = avatars?.[pubkey]
  if (!av) return

  let spr = typingIndicators.get(pubkey)
  if (!spr) {
    spr = makeTypingIndicatorSprite()
    spr.visible = false
    av.add(spr)
    typingIndicators.set(pubkey, spr)
  }
  spr.visible = Boolean(active)
}

function broadcastMyTyping(active) {
  if (!net || !myPubkey) return
  ensureAvatar(myPubkey)
  setTypingIndicator(myPubkey, Boolean(active))
  const out = { type: "typing", active: Boolean(active), pubkey: myPubkey }
  if (currentRoom?.isHost) {
    handleNetMessage(myPubkey, out)
    net.broadcast(out)
  } else {
    net.broadcast(out)
  }
}

function setPoseForPubkey(pubkey, pose) {
  const av = avatars[pubkey]
  if (!av) return
  setAvatarPose(av, pose)
  if (pose !== "sit" && av?.userData) {
    av.userData.sittingOnInstanceId = ""
    av.userData.remoteSitY = undefined
  }
}

function setRemoteSitting(pubkey, instanceId, sitY) {
  const av = ensureAvatar(pubkey)
  av.userData.sittingOnInstanceId = String(instanceId || "")
  av.userData.remoteSitY = typeof sitY === "number" && Number.isFinite(sitY) ? sitY : av.userData.remoteSitY
  setAvatarPose(av, "sit")
  if (av.userData.sittingOnInstanceId) applySitTransform(av, av.userData.sittingOnInstanceId)
}

function setMyPose(pose, { sittingOn = "" } = {}) {
  const p = pose === "sit" ? "sit" : "stand"
  myPose = p
  sittingOnInstanceId = p === "sit" ? String(sittingOn || "") : ""
  if (myAvatar) {
    setAvatarPose(myAvatar, p)
    if (p === "stand") {
      updateAvatarPosition(myAvatar, { x: myAvatar.position.x, z: myAvatar.position.z })
    }
  }
}

function standUpIfSitting() {
  const avatarPose = myAvatar?.userData?.pose
  const isSitting = myPose === "sit" || avatarPose === "sit" || Boolean(sittingOnInstanceId)
  if (!isSitting) return
  setMyPose("stand")
  sittingOnInstanceId = ""
  pendingSit = null
  if (myAvatar) {
    setAvatarPose(myAvatar, "stand")
    updateAvatarPosition(myAvatar, { x: myAvatar.position.x, z: myAvatar.position.z })
  }
}

function getPlacedAtTile(tile) {
  if (!tile) return []
  const out = []
  for (const it of placedItems.values()) {
    if (!it?.tile) continue
    if (it.tile.x === tile.x && it.tile.z === tile.z) out.push(it)
  }
  out.sort((a, b) => (Number(b.stackIndex || 0) || 0) - (Number(a.stackIndex || 0) || 0))
  return out
}

function trySitOnInstance(instanceId) {
  if (!currentRoom) return false
  const it = placedItems.get(instanceId)
  if (!it) return false
  const def = getFurniDef(it.defId)
  if (!def?.actions?.includes?.("sit")) return false
  if (!it.tile) return false

  const chairWorld = snapToTileCenter(fromTileCoord(it.tile))
  if (!isTileCoordWalkable(it.tile, { allowBlocked: true })) return false

  const wasSitting = myPose === "sit" && Boolean(sittingOnInstanceId)

  pendingSit = {
    instanceId,
    approach: chairWorld
  }
  setMyPose("stand")
  const startTile = toTileCoord({ x: myAvatar?.position?.x ?? 0, z: myAvatar?.position?.z ?? 0 })
  myPath = findPathAStar(startTile, it.tile, { allowGoalBlocked: true, allowStartBlocked: wasSitting })
  if (!myPath || myPath.length === 0) return false
  if (myPath.length > 1) myPath.shift()
  const nextTile = myPath[0]
  myTarget = snapToTileCenter(fromTileCoord(nextTile))
  return true
}

function getChairInstanceAtTile(tile) {
  if (!tile) return ""
  const at = getPlacedAtTile(tile)
  for (const it of at) {
    const def = getFurniDef(it.defId)
    if (def?.actions?.includes?.("sit")) return it.instanceId
  }
  return ""
}

function applySitTransform(avatar, instanceId) {
  const it = placedItems.get(instanceId)
  if (!avatar || !it?.mesh || !it?.tile) return
  const chairWorld = fromTileCoord(it.tile)
  avatar.position.x = chairWorld.x
  avatar.position.z = chairWorld.z
  if (typeof avatar.userData?.remoteSitY === "number" && Number.isFinite(avatar.userData.remoteSitY)) {
    avatar.position.y = avatar.userData.remoteSitY
  } else {
    const baseY = typeof it.y === "number" && Number.isFinite(it.y) ? it.y : typeof it.mesh.position?.y === "number" ? it.mesh.position.y : 0.5
    avatar.position.y = baseY + 0.6
  }
  const rot = Number(it.rot || 0) || 0
  avatar.rotation.y = rot * (Math.PI / 2)
}

function faceToward(avatar, from, to) {
  if (!avatar || !from || !to) return
  const dx = (to.x || 0) - (from.x || 0)
  const dz = (to.z || 0) - (from.z || 0)
  if (Math.abs(dx) < 0.0001 && Math.abs(dz) < 0.0001) return
  avatar.rotation.y = quantizeYawTo8(Math.atan2(dx, dz))
}

function isNear(a, b, eps = 0.06) {
  if (!a || !b) return false
  const dx = (a.x || 0) - (b.x || 0)
  const dz = (a.z || 0) - (b.z || 0)
  return Math.sqrt(dx * dx + dz * dz) <= eps
}

function setRemoteTarget(pubkey, pos) {
  const snapped = snapToTileCenter(pos)
  const clamped = clampToWalkable(snapped)
  remoteTargets[pubkey] = {
    pos: { x: clamped.x, z: clamped.z },
    tile: toTileCoord(clamped),
    dir: remoteTargets?.[pubkey]?.dir
  }
}

function setRemoteTargetTile(pubkey, tile) {
  const clamped = clampToWalkable(fromTileCoord(tile))
  remoteTargets[pubkey] = {
    pos: { x: clamped.x, z: clamped.z },
    tile: toTileCoord(clamped),
    dir: remoteTargets?.[pubkey]?.dir
  }
}

function handleNetMessage(fromPubkey, msg) {
  if (!msg || typeof msg !== "object") return

  if (fromPubkey) requestNostrProfile(fromPubkey)

  if (msg.type === "typing") {
    const who = msg.pubkey ?? fromPubkey
    if (!who) return
    ensureAvatar(who)
    setTypingIndicator(who, Boolean(msg.active))
    return
  }

  if (msg.type === "host_left") {
    if (currentRoom && !currentRoom.isHost) {
      kickToLobby("The host disconnected. You were returned to the lobby.")
    }
    return
  }

  if (msg.type === "appearance" && msg.appearance) {
    const who = msg.pubkey ?? fromPubkey
    if (who) applyAppearanceForPubkey(who, msg.appearance)
    return
  }

  if (msg.type === "snapshot" && Array.isArray(msg.players)) {
    if (joinConnecting) {
      joinGotSnapshot = true
      joinConnecting = false
      if (joinConnectTimeout) {
        clearTimeout(joinConnectTimeout)
        joinConnectTimeout = null
      }
      connectingModal.hide()
    }
    for (const p of msg.players) {
      if (!p?.pubkey || !p?.pos) continue
      if (p.pubkey === myPubkey) continue
      if (p.name && typeof p.name === "string") {
        maybeApplyNostrName(p.pubkey, p.name)
      }
      requestNostrProfile(p.pubkey)
      const av = ensureAvatar(p.pubkey)
      if (p.appearance) applyAppearanceForPubkey(p.pubkey, p.appearance)
      updateAvatarPosition(av, p.pos)
      if (typeof p.dir === "number") av.rotation.y = yawFromDir8(p.dir)
      remoteTargets[p.pubkey] = { pos: { x: p.pos.x, z: p.pos.z }, tile: p.tile || toTileCoord(p.pos), dir: typeof p.dir === "number" ? p.dir : undefined }
      if (p.pose === "sit" && p.sittingOn) {
        setRemoteSitting(p.pubkey, p.sittingOn, p.sitY)
      } else if (p.pose) {
        setPoseForPubkey(p.pubkey, p.pose)
      }
    }
    return
  }

  if (msg.type === "chat") {
    const speaker = msg.pubkey ?? fromPubkey
    if (speaker && msg.name && typeof msg.name === "string") {
      maybeApplyNostrName(speaker, msg.name)
    }
    if (speaker) requestNostrProfile(speaker)
    const who = speaker ? getDisplayName(speaker) : shortId(fromPubkey)
    appendChatLine(`${who}: ${msg.text}`)
    if (speaker) {
      ensureAvatar(speaker)
      spawnChatBubble(speaker, msg.text)
    }
    return
  }

  if (msg.type === "hello" && msg.pos) {
    const who = msg.pubkey ?? fromPubkey
    if (msg.name && typeof msg.name === "string") {
      maybeApplyNostrName(who, msg.name)
    }
    requestNostrProfile(who)
    const av = ensureAvatar(who)
    if (msg.appearance) applyAppearanceForPubkey(who, msg.appearance)
    updateAvatarPosition(av, msg.pos)
    if (typeof msg.dir === "number") av.rotation.y = yawFromDir8(msg.dir)
    remoteTargets[who] = { pos: { x: msg.pos.x, z: msg.pos.z }, tile: msg.tile || toTileCoord(msg.pos), dir: typeof msg.dir === "number" ? msg.dir : undefined }
    if (msg.pose === "sit" && msg.sittingOn) {
      setRemoteSitting(who, msg.sittingOn, msg.sitY)
    } else if (msg.pose) {
      setPoseForPubkey(who, msg.pose)
    }
    return
  }

  if (msg.type === "pos") {
    const who = msg.pubkey ?? fromPubkey
    const av = ensureAvatar(who)
    if (msg.pose === "sit" && msg.sittingOn) {
      setRemoteSitting(who, msg.sittingOn, msg.sitY)
    } else if (msg.pose) {
      setPoseForPubkey(who, msg.pose)
    }
    if (msg.pos && (av.userData?.netInit !== true)) {
      updateAvatarPosition(av, msg.pos)
      if (av.userData) av.userData.netInit = true
    } else if (msg.pos && typeof msg.pos.x === "number" && typeof msg.pos.z === "number") {
      const dx0 = msg.pos.x - av.position.x
      const dz0 = msg.pos.z - av.position.z
      const drift = Math.sqrt(dx0 * dx0 + dz0 * dz0)
      if (drift > 1.25) {
        updateAvatarPosition(av, msg.pos)
      }
    }
    if (typeof msg.dir === "number") {
      av.rotation.y = yawFromDir8(msg.dir)
      if (remoteTargets[who]) remoteTargets[who].dir = msg.dir
    }
    if (msg.tile && typeof msg.tile.x === "number" && typeof msg.tile.z === "number") {
      setRemoteTargetTile(who, msg.tile)
      if (remoteTargets[who] && typeof msg.dir === "number") remoteTargets[who].dir = msg.dir
    } else if (msg.pos && typeof msg.pos.x === "number" && typeof msg.pos.z === "number") {
      setRemoteTarget(who, msg.pos)
      if (remoteTargets[who] && typeof msg.dir === "number") remoteTargets[who].dir = msg.dir
    }
    return
  }

  if (msg.type === "room_items" && Array.isArray(msg.items)) {
    for (const it of msg.items) {
      if (!it?.instanceId || !it?.defId || !it?.tile) continue
      if (typeof it.tile.x !== "number" || typeof it.tile.z !== "number") continue
      placeItemLocal(it)
    }
    return
  }

  if (msg.type === "item_placed" && msg.item) {
    placeItemLocal(msg.item)
    return
  }

  if (msg.type === "item_moved" && msg.item) {
    const it = msg.item
    if (it?.instanceId && it?.tile && typeof it.tile.x === "number" && typeof it.tile.z === "number") {
      updatePlacedLocal({ instanceId: it.instanceId, tile: it.tile, stackIndex: it.stackIndex, y: it.y })
    }
    return
  }

  if (msg.type === "item_rotated" && msg.item) {
    const it = msg.item
    if (it?.instanceId && typeof it.rot === "number") {
      updatePlacedLocal({ instanceId: it.instanceId, rot: it.rot })
    }
    return
  }

  if (msg.type === "item_picked_up" && msg.instanceId) {
    removePlacedLocal(msg.instanceId)
    return
  }

  if ((msg.type === "use_item" || msg.type === "item_used") && msg.instanceId) {
    handleUseItemLocal(String(msg.instanceId), String(msg.from || fromPubkey || ""))
    if (currentDetails?.kind === "furni" && String(currentDetails.instanceId || "") === String(msg.instanceId)) {
      openDetailsPanel({ kind: "furni", instanceId: String(msg.instanceId) })
    }
    return
  }
}

function handlePeerState(peer, state) {
  if (state === "open") {
    appendChatLine(`connected: ${peer.slice(0, 8)}...`)

    if (currentRoom && !currentRoom.isHost && peer === currentRoom.ownerPubkey && joinConnecting && !joinGotSnapshot) {
      connectingModal.show({ title: "Connecting…", body: "Connected to host. Syncing room…" })
    }

    ensureAvatar(peer)

    if (!net || !currentRoom) return

    const myPos = myAvatar ? { x: myAvatar.position.x, z: myAvatar.position.z } : { x: 0, z: 0 }
    const snappedMyPos = snapToTileCenter(myPos)

    if (currentRoom.isHost) {
      const players = Object.keys(avatars).map((pubkey) => {
        const av = avatars[pubkey]
        const p = snapToTileCenter({ x: av.position.x, z: av.position.z })
        const out = {
          pubkey,
          name: getDisplayName(pubkey),
          pos: p,
          tile: toTileCoord(p),
          pose: av?.userData?.pose || "stand",
          dir: getDir8FromYaw(av?.rotation?.y || 0)
        }
        if (out.pose === "sit" && av?.userData?.sittingOnInstanceId) {
          out.sittingOn = av.userData.sittingOnInstanceId
          out.sitY = typeof av.position?.y === "number" && Number.isFinite(av.position.y) ? av.position.y : undefined
        }
        return out
      })
      net.sendTo(peer, { type: "snapshot", players })

      const items = Array.from(placedItems.values()).map((it) => ({
        instanceId: it.instanceId,
        defId: it.defId,
        tile: it.tile,
        rot: it.rot || 0,
        stackIndex: it.stackIndex || 0,
        y: typeof it.y === "number" && Number.isFinite(it.y) ? it.y : undefined
      }))
      if (items.length) {
        net.sendTo(peer, { type: "room_items", items })
      }
    } else {
      const hello = {
        type: "hello",
        name: myDisplayName,
        pos: snappedMyPos,
        tile: toTileCoord(snappedMyPos),
        dir: myAvatar ? getDir8FromYaw(myAvatar.rotation.y) : 0
      }
      hello.pose = myPose
      if (shouldIncludeSittingOnInNet()) hello.sittingOn = sittingOnInstanceId
      if (shouldIncludeSitYInNet()) hello.sitY = myAvatar.position.y
      net.sendTo(currentRoom.ownerPubkey, hello)
    }
  } else if (state === "failed" || state === "disconnected" || state === "closed") {
    appendChatLine(`connection ${state}: ${peer.slice(0, 8)}...`)

    if (joinConnecting && currentRoom && !currentRoom.isHost && peer === currentRoom.ownerPubkey) {
      joinConnecting = false
      joinGotSnapshot = false
      if (joinConnectTimeout) {
        clearTimeout(joinConnectTimeout)
        joinConnectTimeout = null
      }
      connectingModal.hide()
      disconnectModal.show({
        title: "Connection failed",
        body: `Could not connect to the host (${state}). Make sure both of you are online and try again.`
      })
    }

    if (Date.now() < suppressDisconnectUntil) {
      return
    }

    if (currentRoom && !currentRoom.isHost && peer === currentRoom.ownerPubkey) {
      kickToLobby("The host disconnected. You were returned to the lobby.")
      return
    }

    if (peer !== myPubkey && avatars[peer]) {
      scene.remove(avatars[peer])
      delete avatars[peer]
    }
    if (remoteTargets[peer]) {
      delete remoteTargets[peer]
    }
  }
}

async function startRoom({ roomId, code, name, plan, door, entryDir, ownerPubkey, isHost, announcePublic }) {
  if (currentRoom) {
    teardownRoom({ reason: null, showLobby: false })
  }
  if (isHost && typeof announcePublic !== "boolean") {
    announcePublic = true
  }
  const ed = entryDir == null ? 2 : Number(entryDir)
  currentRoom = { roomId, code, name, plan, door: door || null, entryDir: Number.isFinite(ed) ? ed : 2, ownerPubkey, isHost, announcePublic }
  setInRoom(true)
  updateFurniAccessUi()
  win.hideWindow(lobbyEl, dockNavigator)
  joinHintEl.textContent = ""

  appendChatLine(`room: ${code} (${roomId.slice(0, 8)}...)`)
  appendChatLine(isHost ? "you are the host" : `host: ${ownerPubkey.slice(0, 8)}...`)

  joinConnecting = false
  joinGotSnapshot = false
  if (joinConnectTimeout) {
    clearTimeout(joinConnectTimeout)
    joinConnectTimeout = null
  }
  connectingModal.hide()

  for (const k of Object.keys(avatars)) {
    scene.remove(avatars[k])
    delete avatars[k]
  }
  remoteTargets = {}

  if (isHost) {
    upsertMyRoom({ roomId, code, name, plan, door: door || null, entryDir: currentRoom.entryDir })
    const shouldAnnounce = Boolean(currentRoom.announcePublic)
    if (shouldAnnounce) startRoomAnnouncements({ roomId, code, name, plan, door: door || null })
    else {
      publishRoomClosed({ roomId, code })
      stopRoomAnnouncements()
    }
  } else {
    stopRoomAnnouncements()

    joinConnecting = true
    joinGotSnapshot = false
    connectingModal.show({ title: "Connecting…", body: "Contacting host…" })
    joinConnectTimeout = setTimeout(() => {
      if (!joinConnecting || joinGotSnapshot) return
      joinConnecting = false
      connectingModal.hide()
      disconnectModal.show({
        title: "Connection timed out",
        body: "Could not reach the host. The room may be closed, the host may be offline, or signaling is blocked. Try again in a moment."
      })
    }, 15000)
  }

  const effectivePlan = plan || currentFloorPlan || getDefaultPlanCode()
  if (!floor || currentFloorPlan !== effectivePlan) {
    try {
      if (floor) {
        const tiles = floor.userData?.tiles
        const walls = floor.userData?.walls
        if (tiles) scene.remove(tiles)
        if (walls) scene.remove(walls)
        scene.remove(floor)
      }
    } catch {}
    const ed2 = currentRoom?.entryDir
    floor = createRoom(scene, { plan: effectivePlan, door: door || null, entryDir: ed2 == null ? 2 : ed2 })
    currentFloorPlan = effectivePlan
    rebuildBlockedTiles()
  }

  if (isHost && roomId) {
    try {
      loadingRoomState = true
      const items = await loadRoomFurni(roomId)
      for (const it of items) {
        placeItemLocal(it)
      }
    } catch {
      // ignore restore failures
    } finally {
      loadingRoomState = false
    }

    publishPlacedItemLocationsSoon()
  }

  renderInventory()
  updateFurniAccessUi()

  myAvatar = ensureAvatar(myPubkey)
  setAvatarPose(myAvatar, myPose)
  if (myAppearance) setAvatarAppearance(myAvatar, myAppearance)
  const startPos = snapToTileCenter(getSpawnPos())
  updateAvatarPosition(myAvatar, startPos)
  {
    const d = floor?.userData?.entryDir
    if (typeof d === "number" && Number.isFinite(d)) {
      myAvatar.rotation.y = yawFromDir8(d)
    } else {
      myAvatar.rotation.y = yawFromDir8(0)
    }
  }
  myTarget = { x: startPos.x, z: startPos.z }

  suppressDisconnectUntil = Date.now() + 1500
  net?.stop()
  net = new NabboNet({
    publish,
    subscribe,
    myPubkey,
    roomId,
    ownerPubkey,
    isHost,
    onMessage: (peer, msg) => {
      if (isHost && msg && typeof msg === "object") {
        if (msg.type === "hello") {
          const out = { ...msg, pubkey: peer }
          handleNetMessage(peer, out)

          const players = Object.keys(avatars).map((pubkey) => {
            const av = avatars[pubkey]
            const pos = snapToTileCenter({ x: av.position.x, z: av.position.z })
            const p = {
              pubkey,
              name: getDisplayName(pubkey),
              pos,
              tile: toTileCoord(pos),
              pose: av?.userData?.pose || "stand",
              dir: getDir8FromYaw(av?.rotation?.y || 0)
            }
            if (p.pose === "sit" && av?.userData?.sittingOnInstanceId) {
              p.sittingOn = av.userData.sittingOnInstanceId
              p.sitY = typeof av.position?.y === "number" && Number.isFinite(av.position.y) ? av.position.y : undefined
            }
            const app = appearances[pubkey]
            if (app) p.appearance = app
            return p
          })
          net.sendTo(peer, { type: "snapshot", players })
          return
        }
        if (msg.type === "chat") {
          const out = { ...msg, pubkey: peer }
          handleNetMessage(peer, out)
          net.broadcast(out)
          return
        }
        if (msg.type === "pos") {
          const out = { ...msg, pubkey: peer }
          handleNetMessage(peer, out)
          net.broadcast(out)
          return
        }
      }
      handleNetMessage(peer, msg)
    },
    onPeerState: handlePeerState
  })

  await net.start()
}

function parseJoinInput(s) {
  const v = (s || "").trim()
  if (!v) return null

  if (v.length >= 16 && /^[0-9a-fA-F]+$/.test(v)) {
    return { roomId: v.toLowerCase() }
  }

  const code = v.toUpperCase()
  const match = publicRooms ? publicRooms.findByCode(code) : null
  if (match) {
    return { roomId: match.roomId, code: match.code, name: match.name, plan: match.plan, door: match.door || null, entryDir: match.entryDir ?? 2, ownerPubkey: match.ownerPubkey }
  }

  const mine = loadMyRooms().find((r) => r.code?.toUpperCase() === code)
  if (mine) {
    return {
      roomId: mine.roomId,
      ownerPubkey: myPubkey,
      code: mine.code,
      name: mine.name,
      plan: mine.plan,
      door: mine.door || null,
      entryDir: mine.entryDir ?? 2,
      isHost: true
    }
  }

  return { code }
}

async function init() {

  // ---------- THREE SETUP ----------
  scene = new THREE.Scene()

  const frustumSize = 26
  const aspect = window.innerWidth / window.innerHeight
  camera = new THREE.OrthographicCamera(
    (frustumSize * aspect) / -2,
    (frustumSize * aspect) / 2,
    frustumSize / 2,
    frustumSize / -2,
    0.1,
    1000
  )

  camera.rotation.order = "YXZ"
  camera.rotation.y = Math.PI / 4
  camera.rotation.x = -Math.atan(1 / Math.sqrt(2))
  camera.position.set(28, 28, 28)
  camera.zoom = zoomNotches[zoomNotchIndex]
  camera.updateProjectionMatrix()

  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById("scene")
  })

  renderer.setSize(window.innerWidth, window.innerHeight)

  renderer.setClearColor(0x0b0d10, 1)

  window.addEventListener("resize", () => {
    const aspect2 = window.innerWidth / window.innerHeight
    camera.left = (frustumSize * aspect2) / -2
    camera.right = (frustumSize * aspect2) / 2
    camera.top = frustumSize / 2
    camera.bottom = frustumSize / -2
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  const applyZoomNotch = (idx) => {
    const next = Math.max(0, Math.min(zoomNotches.length - 1, idx))
    zoomNotchIndex = next
    if (camera) {
      camera.zoom = zoomNotches[zoomNotchIndex]
      camera.updateProjectionMatrix()
    }
  }

  const zoomIn = () => applyZoomNotch(zoomNotchIndex + 1)
  const zoomOut = () => applyZoomNotch(zoomNotchIndex - 1)
  const zoomReset = () => applyZoomNotch(3)

  // Ctrl/Cmd +/- should zoom the room, not the browser page
  window.addEventListener(
    "keydown",
    (e) => {
      const hasCtrl = Boolean(e.ctrlKey || e.metaKey)
      if (!hasCtrl) return
      const k = e.key
      if (k === "+" || k === "=" ) {
        e.preventDefault()
        zoomIn()
        return
      }
      if (k === "-" || k === "_" ) {
        e.preventDefault()
        zoomOut()
        return
      }
      if (k === "0") {
        e.preventDefault()
        zoomReset()
      }
    },
    { passive: false }
  )

  // Trackpad pinch usually comes through as wheel events with ctrlKey=true
  window.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // prevent browser zoom
      e.preventDefault()
      const dy = Number(e.deltaY)
      if (!Number.isFinite(dy)) return

      zoomWheelAccum += dy
      const step = 120
      while (zoomWheelAccum <= -step) {
        zoomWheelAccum += step
        zoomIn()
      }
      while (zoomWheelAccum >= step) {
        zoomWheelAccum -= step
        zoomOut()
      }
    },
    { passive: false }
  )

  // Mobile touch pinch support (discrete notches)
  const getTouchDist = (t1, t2) => {
    const dx = (t1?.clientX ?? 0) - (t2?.clientX ?? 0)
    const dy = (t1?.clientY ?? 0) - (t2?.clientY ?? 0)
    return Math.sqrt(dx * dx + dy * dy)
  }

  window.addEventListener(
    "touchstart",
    (e) => {
      if (!e.touches || e.touches.length !== 2) return
      pinchState = {
        startDist: getTouchDist(e.touches[0], e.touches[1]),
        accum: 0
      }
    },
    { passive: true }
  )

  window.addEventListener(
    "touchmove",
    (e) => {
      if (!pinchState) return
      if (!e.touches || e.touches.length !== 2) return
      e.preventDefault()
      const d = getTouchDist(e.touches[0], e.touches[1])
      const delta = d - pinchState.startDist
      pinchState.startDist = d
      pinchState.accum += delta
      const pxStep = 28
      while (pinchState.accum >= pxStep) {
        pinchState.accum -= pxStep
        zoomIn()
      }
      while (pinchState.accum <= -pxStep) {
        pinchState.accum += pxStep
        zoomOut()
      }
    },
    { passive: false }
  )

  window.addEventListener(
    "touchend",
    (e) => {
      if (!pinchState) return
      if (e.touches && e.touches.length === 2) return
      pinchState = null
    },
    { passive: true }
  )

  // ---------- NOSTR SETUP ----------
  await initNostr()
  myPubkey = getPubkey()

  try {
    const raw = localStorage.getItem("nabbo_avatar")
    myAppearance = normalizeAppearance(raw ? JSON.parse(raw) : null)
  } catch {
    myAppearance = normalizeAppearance(null)
  }
  applyAppearanceForPubkey(myPubkey, myAppearance)

  try {
    const url = new URL("/api/economy/info", window.location.origin).toString()
    const res = await fetch(url)
    const out = await res.json().catch(() => null)
    if (out?.ok && typeof out.issuerPubkey === "string") {
      issuerPubkey = out.issuerPubkey
    }
  } catch {}

  myDisplayName = (localStorage.getItem("nabbo_name") || "").trim()
  if (myDisplayName) playerNames[myPubkey] = myDisplayName
  requestNostrProfile(myPubkey)

  renderCatalog()
  refreshInventory()
  refreshCoins()
  updateClaimUi()

  ensureShopCategories()

  setPlacingMode(false)
  if (inventoryPlaceEl) {
    inventoryPlaceEl.onclick = () => {
      if (!selectedInstanceId) {
        appendChatLine("select an item to place")
        return
      }
      placementStackDefId = getSelectedPlacementDefId() || ""
      setPlacingMode(true)
      if (inventoryEl) win.hideWindow(inventoryEl, dockInventory)
    }
  }
  if (inventoryCancelPlaceEl) {
    inventoryCancelPlaceEl.onclick = () => {
      setPlacingMode(false)
      if (inventoryEl) win.showWindow(inventoryEl, dockInventory)
    }
  }

  if (claimCoinsEl) {
    claimCoinsEl.onclick = async () => {
      claimCoinsEl.disabled = true
      claimCoinsEl.textContent = "Claiming…"
      try {
        const url = new URL("/api/economy/airdrop", window.location.origin).toString()
        const auth = await getNip98AuthHeader(url, "POST")
        const ctrl = new AbortController()
        const timeoutId = setTimeout(() => ctrl.abort(), 9000)
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: auth
          },
          signal: ctrl.signal
        })
        clearTimeout(timeoutId)
        const out = await res.json().catch(() => null)
        if (!out?.ok) {
          const msg = out?.error || res.status
          appendChatLine(`claim failed: ${msg}`)
          if (coinBalanceEl) coinBalanceEl.textContent = `Claim failed: ${msg}`
          return
        }

        if (typeof out?.balance?.balance === "number") {
          coinsBalance = out.balance.balance
          saveCachedCoins()
          renderCoins()
          renderCatalog()
        }

        if (out?.claimed === true) appendChatLine("daily claim +100")
        else appendChatLine("already claimed today")
        await new Promise((r) => setTimeout(r, 600))
        refreshCoins()
      } catch (e) {
        const msg = e?.name === "AbortError" ? "timeout" : "claim failed"
        appendChatLine(msg)
        if (coinBalanceEl) coinBalanceEl.textContent = msg
      } finally {
        updateClaimUi()
      }
    }
  }

  if (inventoryRefreshEl) {
    inventoryRefreshEl.onclick = () => {
      refreshInventory()
      refreshCoins()
    }
  }

  setInRoom(false)

  lobbyEl.dataset.centerOnOpen = "true"
  inventoryEl.dataset.centerOnOpen = "true"
  if (shopEl) shopEl.dataset.centerOnOpen = "true"
  if (profileEl) profileEl.dataset.centerOnOpen = "true"
  if (wardrobeEl) wardrobeEl.dataset.centerOnOpen = "true"
  if (createRoomWinEl) createRoomWinEl.dataset.centerOnOpen = "true"
  if (roomInfoEl) roomInfoEl.dataset.centerOnOpen = "true"

  win.centerWindow(lobbyEl, { force: true })
  win.centerWindow(inventoryEl, { force: true })
  if (shopEl) win.centerWindow(shopEl, { force: true })
  if (profileEl) win.centerWindow(profileEl, { force: true })
  if (wardrobeEl) win.centerWindow(wardrobeEl, { force: true })
  if (createRoomWinEl) win.centerWindow(createRoomWinEl, { force: true })
  if (roomInfoEl) win.centerWindow(roomInfoEl, { force: true })

  publicRooms = createPublicRooms({
    subscribe,
    ttlMs: PUBLIC_ROOM_TTL_MS,
    onChange: () => renderPublicRooms()
  })
  publicRooms.start()

  window.addEventListener("beforeunload", () => {
    try {
      if (currentRoom?.isHost && net) {
        net.broadcast({ type: "host_left" })
        if (currentRoom?.announcePublic) {
          publishRoomClosed({ roomId: currentRoom.roomId, code: currentRoom.code })
        }
      }
    } catch {}
  })

  tabPublic.onclick = () => {
    setTab("public")
    renderPublicRooms()
  }
  tabMine.onclick = () => {
    setTab("mine")
    renderMyRooms()
  }
  tabJoin.onclick = () => {
    setTab("join")
    joinHintEl.textContent = "Paste a room code from the Public Rooms list, or a saved room code, or a room id."
  }

  if (createRoomTemplatesEl) {
    createRoomTemplatesEl.addEventListener("click", (e) => {
      const btn = e?.target?.closest?.(".plan-card")
      if (!btn) return
      const code = btn.getAttribute("data-plan-code")
      if (!code) return
      selectedCreateRoomPlan = code
      selectedCreateRoomDoor = getDoorFromTemplateButton(btn)
      selectedCreateRoomEntryDir = getEntryDirFromTemplateButton(btn)
      renderPlanPreviews()
    })
  }

  if (!selectedCreateRoomPlan) {
    const first = createRoomTemplatesEl?.querySelector?.(".plan-card")
    const code = first?.getAttribute?.("data-plan-code")
    if (code) selectedCreateRoomPlan = code
    selectedCreateRoomDoor = getDoorFromTemplateButton(first)
    selectedCreateRoomEntryDir = getEntryDirFromTemplateButton(first)
  }

  renderPlanPreviews()

  if (profileEl && profileNameEl) {
    profileNameEl.value = myDisplayName
  }

  fillSelect(avatarSkinEl, appearanceOptions.skin)
  fillSelect(avatarHairEl, appearanceOptions.hair)
  fillSelect(avatarTopEl, appearanceOptions.top)
  fillSelect(avatarBottomEl, appearanceOptions.bottom)
  fillSelect(avatarFaceEl, appearanceOptions.face)

  const syncWardrobeUi = () => {
    if (!myAppearance) return
    if (avatarSkinEl) avatarSkinEl.value = myAppearance.skin
    if (avatarHairEl) avatarHairEl.value = myAppearance.hair
    if (avatarTopEl) avatarTopEl.value = myAppearance.top
    if (avatarBottomEl) avatarBottomEl.value = myAppearance.bottom
    if (avatarFaceEl) avatarFaceEl.value = myAppearance.face
  }
  syncWardrobeUi()

  const onAppearanceChange = () => {
    myAppearance = normalizeAppearance({
      skin: avatarSkinEl?.value,
      hair: avatarHairEl?.value,
      top: avatarTopEl?.value,
      bottom: avatarBottomEl?.value,
      face: avatarFaceEl?.value
    })
    applyAppearanceForPubkey(myPubkey, myAppearance)
    if (myAvatar) setAvatarAppearance(myAvatar, myAppearance)
  }

  if (avatarSkinEl) avatarSkinEl.onchange = onAppearanceChange
  if (avatarHairEl) avatarHairEl.onchange = onAppearanceChange
  if (avatarTopEl) avatarTopEl.onchange = onAppearanceChange
  if (avatarBottomEl) avatarBottomEl.onchange = onAppearanceChange
  if (avatarFaceEl) avatarFaceEl.onchange = onAppearanceChange

  if (wardrobeSaveEl) {
    wardrobeSaveEl.onclick = () => {
      onAppearanceChange()
      try {
        localStorage.setItem("nabbo_avatar", JSON.stringify(myAppearance))
      } catch {}
      broadcastMyAppearance()
      if (wardrobeEl) win.hideWindow(wardrobeEl, dockWardrobe)
    }
  }

  if (profileSaveEl) {
    profileSaveEl.onclick = () => {
      const v = (profileNameEl?.value || "").trim()
      myDisplayName = v
      if (myDisplayName) playerNames[myPubkey] = myDisplayName
      else delete playerNames[myPubkey]
      localStorage.setItem("nabbo_name", myDisplayName)
      if (myDisplayName) {
        try {
          publish(0, JSON.stringify({ name: myDisplayName, display_name: myDisplayName }))
        } catch {}
      }
      if (profileEl) win.hideWindow(profileEl, dockProfile)
    }
  }

  createRoomBtn.onclick = async () => {
    if (!createRoomWinEl) return
    if (createRoomNameEl) createRoomNameEl.value = ""
    if (!selectedCreateRoomPlan) selectedCreateRoomPlan = getDefaultPlanCode()
    if (!selectedCreateRoomDoor) {
      const first = createRoomTemplatesEl?.querySelector?.(".plan-card")
      selectedCreateRoomDoor = getDoorFromTemplateButton(first)
      selectedCreateRoomEntryDir = getEntryDirFromTemplateButton(first)
    }
    if (createRoomPublicEl) createRoomPublicEl.checked = true
    win.showWindow(createRoomWinEl)
    renderPlanPreviews()
    if (createRoomNameEl) createRoomNameEl.focus()
  }

  if (createRoomConfirmEl) {
    createRoomConfirmEl.onclick = async () => {
      const roomId = createRoomId(myPubkey)
      const code = roomIdToCode(roomId)
      const nameRaw = createRoomNameEl ? createRoomNameEl.value.trim() : ""
      const name = nameRaw || `Room ${code}`
      const plan = selectedCreateRoomPlan || getDefaultPlanCode()
      const door = selectedCreateRoomDoor || null
      const entryDir = selectedCreateRoomEntryDir ?? 2
      const announcePublic = Boolean(createRoomPublicEl?.checked)

      win.hideWindow(createRoomWinEl)
      await startRoom({ roomId, code, name, plan, door, entryDir, ownerPubkey: myPubkey, isHost: true, announcePublic })
    }
  }

  if (createRoomCancelEl) {
    createRoomCancelEl.onclick = () => {
      win.hideWindow(createRoomWinEl)
    }
  }

  joinBtn.onclick = async () => {
    const parsed = parseJoinInput(joinCode.value)
    if (!parsed) return

    if (parsed.isHost) {
      await startRoom({ roomId: parsed.roomId, code: parsed.code || roomIdToCode(parsed.roomId), name: parsed.name, plan: parsed.plan, door: parsed.door || null, entryDir: parsed.entryDir ?? 2, ownerPubkey: myPubkey, isHost: true })
      return
    }

    const roomId = parsed.roomId
    if (!roomId) {
      joinHintEl.textContent = "Room not found yet. Try selecting it from Public Rooms, or wait a second and try again."
      return
    }

    const r = publicRooms ? publicRooms.get(roomId) : null
    if (!r && !parsed.ownerPubkey) {
      joinHintEl.textContent = "Room not found yet. Try selecting it from Public Rooms."
      return
    }
    const owner = parsed.ownerPubkey ?? r.ownerPubkey
    const code = parsed.code ?? r.code ?? roomIdToCode(roomId)
    const name = parsed.name ?? r?.name
    const plan = parsed.plan ?? r?.plan
    const door = parsed.door ?? r?.door ?? null
    const entryDir = parsed.entryDir ?? r?.entryDir ?? 2
    await startRoom({ roomId, code, name, plan, door, entryDir, ownerPubkey: owner, isHost: false })
  }

  sendBtn.onclick = async () => {
    const msg = chatInput.value.trim()
    if (!msg) return
    chatInput.value = ""

    if (myTypingActive) {
      myTypingActive = false
      if (myTypingIdleTimer) {
        clearTimeout(myTypingIdleTimer)
        myTypingIdleTimer = null
      }
      broadcastMyTyping(false)
    }

    if (!net) return

    if (currentRoom?.isHost) {
      const out = { type: "chat", text: msg, pubkey: myPubkey, name: myDisplayName }
      handleNetMessage(myPubkey, out)
      net.broadcast(out)
    } else {
      net.broadcast({ type: "chat", text: msg, name: myDisplayName })
    }
  }

  if (detailsCloseEl) {
    detailsCloseEl.onclick = () => closeDetailsPanel()
  }

  chatInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return
    if (e.shiftKey) return
    e.preventDefault()
    sendBtn.click()
  })

  const markTypingActivity = () => {
    if (!currentRoom || !net || !myPubkey) return
    const hasText = Boolean((chatInput?.value || "").length)
    const nextActive = hasText

    if (nextActive && !myTypingActive) {
      myTypingActive = true
      broadcastMyTyping(true)
    }

    if (myTypingIdleTimer) {
      clearTimeout(myTypingIdleTimer)
      myTypingIdleTimer = null
    }

    if (myTypingActive) {
      myTypingIdleTimer = setTimeout(() => {
        myTypingIdleTimer = null
        if (!myTypingActive) return
        myTypingActive = false
        broadcastMyTyping(false)
      }, 5_000)
    }

    if (!nextActive && myTypingActive) {
      myTypingActive = false
      broadcastMyTyping(false)
    }
  }

  chatInput.addEventListener("input", markTypingActivity)
  chatInput.addEventListener("blur", () => {
    if (!myTypingActive) return
    myTypingActive = false
    if (myTypingIdleTimer) {
      clearTimeout(myTypingIdleTimer)
      myTypingIdleTimer = null
    }
    broadcastMyTyping(false)
  })

  raycaster = new THREE.Raycaster()
  mouse = new THREE.Vector2()

  let isPanning = false
  let panDidMove = false
  let panStart = { x: 0, y: 0 }
  let camStart = { x: 0, y: 0, z: 0 }
  let suppressClickUntil = 0

  const getPanBasis = () => {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)

    right.y = 0
    up.y = 0

    if (right.lengthSq() > 0) right.normalize()
    if (up.lengthSq() > 0) up.normalize()

    return { right, up }
  }

  const shouldIgnoreScenePointer = (target) => {
    if (!target || !target.closest) return false
    if (target.closest(".window")) return true
    if (target.closest(".dock")) return true
    if (target.closest("#ui")) return true
    if (target.closest(".chatlog")) return true
    if (target.closest(".details-actions-bar")) return true
    return false
  }

  const canvasEl = renderer.domElement

  canvasEl.addEventListener("dblclick", (e) => {
    if (!currentRoom) return
    if (shouldIgnoreScenePointer(e.target)) return
    if (document.body.classList.contains("dragging")) return

    const id = pickPlacedInstanceFromEvent(e)
    if (!id) return
    const it = placedItems.get(id)
    const def = getFurniDef(it?.defId)
    if (!furniHasUse(def)) return

    sendUseItem(id)
    e.preventDefault()
  })

  canvasEl.addEventListener(
    "pointermove",
    (e) => {
      if (shouldIgnoreScenePointer(e.target)) return
      updateGhostFromMouseEvent(e)
    },
    { passive: true }
  )

  canvasEl.addEventListener(
    "pointerleave",
    () => {
      if (ghostItem) ghostItem.visible = false
    },
    { passive: true }
  )

  canvasEl.addEventListener("pointerdown", (e) => {
    if (!currentRoom) return
    if (document.body.classList.contains("dragging")) return
    if (shouldIgnoreScenePointer(e.target)) return

    if (e.altKey && !isPlacing && currentRoom?.isHost) {
      const id = pickPlacedInstanceFromEvent(e)
      if (id) {
        movingInstanceId = id
        movingStartTile = placedItems.get(id)?.tile || null
        canvasEl.setPointerCapture(e.pointerId)
        e.preventDefault()
        return
      }
    }

    isPanning = true
    panDidMove = false
    panStart = { x: e.clientX, y: e.clientY }
    camStart = { x: camera.position.x, y: camera.position.y, z: camera.position.z }
    canvasEl.setPointerCapture(e.pointerId)
  })

  canvasEl.addEventListener("pointermove", (e) => {
    if (movingInstanceId) {
      if (!floor?.userData?.tiles) return
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObject(floor.userData.tiles, true)
      const tile = hits?.[0]?.object?.userData?.tile
      if (tile && typeof tile.x === "number" && typeof tile.z === "number") {
        const id = movingInstanceId
        const it = placedItems.get(id)
        const def = getFurniDef(it?.defId)
        const occupiedByOther = Array.from(placedItems.values()).some((x) => x?.instanceId !== id && x?.tile?.x === tile.x && x?.tile?.z === tile.z)
        if (!occupiedByOther || def?.stackable) {
          const si = def?.stackable ? (occupiedByOther ? getStackIndexForTileExcluding(tile, id) : 0) : 0
          updatePlacedLocal({ instanceId: id, tile: { x: tile.x, z: tile.z }, stackIndex: si })
        }
      }
      e.preventDefault()
      return
    }
    if (!isPanning) return

    const dx = e.clientX - panStart.x
    const dy = e.clientY - panStart.y
    if (!panDidMove && Math.abs(dx) + Math.abs(dy) > 3) panDidMove = true

    const worldPerPx = (camera.right - camera.left) / canvasEl.clientWidth
    const { right, up } = getPanBasis()

    const smallScreen = Math.min(window.innerWidth, window.innerHeight) <= 768
    const touchBoost = e.pointerType === "touch" ? (smallScreen ? 2.9 : 2.2) : 1
    const moveRight = -dx * worldPerPx * touchBoost
    const moveUp = dy * worldPerPx * touchBoost

    const xz = new THREE.Vector3()
      .addScaledVector(right, moveRight)
      .addScaledVector(up, moveUp)

    camera.position.x = camStart.x + xz.x
    camera.position.z = camStart.z + xz.z
  })

  const endPan = () => {
    if (movingInstanceId) {
      const id = movingInstanceId
      movingInstanceId = ""
      const t = placedItems.get(id)?.tile
      if (t && typeof t.x === "number" && typeof t.z === "number") {
        sendMoveItem(id, t)
      } else if (movingStartTile) {
        updatePlacedLocal({ instanceId: id, tile: movingStartTile })
      }
      movingStartTile = null
      return
    }
    if (!isPanning) return
    isPanning = false
    if (panDidMove) suppressClickUntil = Date.now() + 250
  }

  canvasEl.addEventListener("pointerup", endPan)
  canvasEl.addEventListener("pointercancel", endPan)

  window.addEventListener("click", (e) => {
    if (!currentRoom) return
    if (!floor) return

    if (Date.now() < suppressClickUntil) return

    if (movingInstanceId && currentRoom?.isHost) {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      const tileGroup = floor.userData?.tiles
      if (!tileGroup) return
      const hits = raycaster.intersectObject(tileGroup, true)
      const tile = hits?.[0]?.object?.userData?.tile
      if (tile && typeof tile.x === "number" && typeof tile.z === "number") {
        const id = movingInstanceId
        movingInstanceId = ""
        sendMoveItem(id, { x: tile.x, z: tile.z })
        movingStartTile = null
        e.preventDefault()
        return
      }
    }

    if (document.body.classList.contains("dragging")) return

    const t = e.target
    if (t && t.closest) {
      if (t.closest(".window")) return
      if (t.closest(".dock")) return
      if (t.closest("#ui")) return
      if (t.closest(".chatlog")) return
      if (t.closest(".details-panel")) return
      if (t.closest(".details-actions-bar")) return
    }

    if (!isPlacing) {
      const id = pickPlacedInstanceFromEvent(e)
      if (id) {
        if (e.shiftKey) {
          sendRotateItem(id)
          return
        }
        if (e.ctrlKey || e.metaKey) {
          sendPickupItem(id)
          return
        }
      }
    }

    if (!isPlacing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const pk = pickAvatarPubkeyFromEvent(e)
      if (pk) {
        openDetailsPanel({ kind: "avatar", pubkey: pk })
        return
      }
      const fid = pickPlacedInstanceFromEvent(e)
      if (fid) {
        openDetailsPanel({ kind: "furni", instanceId: fid })
      } else {
        closeDetailsPanel()
      }
    }

    mouse.x = (e.clientX / window.innerWidth) * 2 - 1
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
    raycaster.setFromCamera(mouse, camera)
    const tileGroup = floor.userData?.tiles
    if (!tileGroup) return
    const hits = raycaster.intersectObject(tileGroup, true)
    if (!hits || hits.length === 0) {
      if (isPlacing) {
        setPlacingMode(false)
        if (inventoryEl) win.showWindow(inventoryEl, dockInventory)
      }
      return
    }
    const hitObj = hits[0].object
    const tile = hitObj?.userData?.tile
    if (tile && floor?.userData?.tileToWorld) {
      if (isPlacing) {
        ensureGhostForSelected()
        if (tryPlaceSelectedAtTile(tile)) {
          if (!placementStackDefId) {
            setPlacingMode(false)
            if (inventoryEl) win.showWindow(inventoryEl, dockInventory)
          }
          return
        }
      }

      const chairId = getChairInstanceAtTile(tile)
      if (chairId) {
        if (trySitOnInstance(chairId)) {
          return
        }
      }

      const wasSittingBefore = myPose === "sit" && Boolean(sittingOnInstanceId)
      const w = floor.userData.tileToWorld(tile.x, tile.z)
      const target = { x: w.x, z: w.z }
      const startTile = toTileCoord({ x: myAvatar?.position?.x ?? 0, z: myAvatar?.position?.z ?? 0 })
      const allowStartBlocked = wasSittingBefore
      const path = findPathAStar(startTile, tile, { allowGoalBlocked: false, allowStartBlocked })
      if (!path || path.length === 0) return

      pendingSit = null
      standUpIfSitting()
      myPath = path
      if (myPath.length > 1) myPath.shift()
      const nextTile = myPath[0]
      myTarget = snapToTileCenter(fromTileCoord(nextTile))
      return
    }

    const p = hits[0].point
    const target = snapToTileCenter({ x: p.x, z: p.z })
    const goalTile = toTileCoord(target)
    const startTile = toTileCoord({ x: myAvatar?.position?.x ?? 0, z: myAvatar?.position?.z ?? 0 })
    const wasSittingBefore = myPose === "sit" && Boolean(sittingOnInstanceId)
    const path = findPathAStar(startTile, goalTile, { allowGoalBlocked: false, allowStartBlocked: wasSittingBefore })
    if (!path || path.length === 0) return

    pendingSit = null
    standUpIfSitting()
    myPath = path
    if (myPath.length > 1) myPath.shift()
    const nextTile = myPath[0]
    myTarget = snapToTileCenter(fromTileCoord(nextTile))
  })

  renderPublicRooms()
  renderMyRooms()

  win.makeDraggable(lobbyEl)
  win.makeDraggable(inventoryEl)
  if (shopEl) win.makeDraggable(shopEl)
  if (profileEl) win.makeDraggable(profileEl)
  if (wardrobeEl) win.makeDraggable(wardrobeEl)
  if (createRoomWinEl) win.makeDraggable(createRoomWinEl)
  if (roomInfoEl) win.makeDraggable(roomInfoEl)

  win.makeResizable(lobbyEl)
  win.makeResizable(inventoryEl)
  if (shopEl) win.makeResizable(shopEl)
  if (profileEl) win.makeResizable(profileEl)
  if (wardrobeEl) win.makeResizable(wardrobeEl)
  if (createRoomWinEl) win.makeResizable(createRoomWinEl)
  if (roomInfoEl) win.makeResizable(roomInfoEl)
  win.focusWindow(lobbyEl)

  customScrollbarApi = initCustomScrollbars()

  dockNavigator.onclick = () => win.toggleWindow(lobbyEl, dockNavigator)
  dockInventory.onclick = () => win.toggleWindow(inventoryEl, dockInventory)
  if (dockShop && shopEl) {
    dockShop.onclick = () => win.toggleWindow(shopEl, dockShop)
  }
  if (dockProfile && profileEl) {
    dockProfile.onclick = () => win.toggleWindow(profileEl, dockProfile)
  }
  if (dockWardrobe && wardrobeEl) {
    dockWardrobe.onclick = () => win.toggleWindow(wardrobeEl, dockWardrobe)
  }

  for (const btn of document.querySelectorAll("[data-winclose]") || []) {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-winclose")
      if (key === "navigator") win.hideWindow(lobbyEl, dockNavigator)
      if (key === "inventory") win.hideWindow(inventoryEl, dockInventory)
      if (key === "shop") win.hideWindow(shopEl, dockShop)
      if (key === "profile") win.hideWindow(profileEl, dockProfile)
      if (key === "wardrobe") win.hideWindow(wardrobeEl, dockWardrobe)
      if (key === "createRoom") win.hideWindow(createRoomWinEl)
      if (key === "roomInfo") win.hideWindow(roomInfoEl)
    })
  }
}

function animate() {
  requestAnimationFrame(animate)

  const now = performance.now()
  const dt = lastAnimAt ? Math.min(0.05, Math.max(0.005, (now - lastAnimAt) / 1000)) : 1 / 60
  lastAnimAt = now

  updateChatBubbles()

  if (myAvatar && currentRoom) {
    const speed = 3.0

    if (myPose === "sit" && sittingOnInstanceId) {
      applySitTransform(myAvatar, sittingOnInstanceId)
      myTarget = { x: myAvatar.position.x, z: myAvatar.position.z }
    }

    const dx = myTarget.x - myAvatar.position.x
    const dz = myTarget.z - myAvatar.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)

    const arrived = dist <= 0.02
    if (!arrived) {
      if (myPose === "sit") {
        standUpIfSitting()
      }
      const yaw = quantizeYawTo8(Math.atan2(dx, dz))
      myAvatar.rotation.y = yaw
      wasMoving = true
      const step = Math.min(dist, speed * dt)
      myAvatar.position.x += (dx / dist) * step
      myAvatar.position.z += (dz / dist) * step

      const curTile = toTileCoord({ x: myAvatar.position.x, z: myAvatar.position.z })
      myAvatar.position.y = getWalkSurfaceY(curTile) + (myAvatar.userData?.poseYOffset || 0)

      const now = performance.now()
      if (net && now - lastSentPosAt > 100) {
        lastSentPosAt = now
        const pos = { x: myAvatar.position.x, z: myAvatar.position.z }
        const tile = toTileCoord(myTarget)
        const dir = getDir8FromYaw(myAvatar.rotation.y)
        if (currentRoom.isHost) {
          const out = { type: "pos", pos, tile, dir, pubkey: myPubkey }
          out.pose = myPose
          if (shouldIncludeSittingOnInNet()) out.sittingOn = sittingOnInstanceId
          if (shouldIncludeSitYInNet()) out.sitY = myAvatar.position.y
          net.broadcast(out)
        } else {
          const out = { type: "pos", pos, tile, dir }
          out.pose = myPose
          if (shouldIncludeSittingOnInNet()) out.sittingOn = sittingOnInstanceId
          if (shouldIncludeSitYInNet()) out.sitY = myAvatar.position.y
          net.broadcast(out)
        }
      }
    } else {
      if (wasMoving) {
        wasMoving = false
      }
      const t = toTileCoord(myTarget)
      updateAvatarPosition(myAvatar, { x: myTarget.x, z: myTarget.z, y: getWalkSurfaceY(t) })

      if (myPath && Array.isArray(myPath) && myPath.length) {
        myPath.shift()
        if (myPath.length) {
          const nextTile = myPath[0]
          myTarget = snapToTileCenter(fromTileCoord(nextTile))
        } else {
          myPath = null
        }
      }

      const now = performance.now()
      if (net && now - lastSentPosAt > 120) {
        lastSentPosAt = now
        const pos = { x: myAvatar.position.x, z: myAvatar.position.z }
        const tile = toTileCoord(myTarget)
        const dir = getDir8FromYaw(myAvatar.rotation.y)
        if (currentRoom.isHost) {
          const out = { type: "pos", pos, tile, dir, pubkey: myPubkey }
          out.pose = myPose
          if (shouldIncludeSittingOnInNet()) out.sittingOn = sittingOnInstanceId
          if (shouldIncludeSitYInNet()) out.sitY = myAvatar.position.y
          net.broadcast(out)
        } else {
          const out = { type: "pos", pos, tile, dir }
          out.pose = myPose
          if (shouldIncludeSittingOnInNet()) out.sittingOn = sittingOnInstanceId
          if (shouldIncludeSitYInNet()) out.sitY = myAvatar.position.y
          net.broadcast(out)
        }
      }
    }

    if (pendingSit && myPose !== "sit" && isNear({ x: myAvatar.position.x, z: myAvatar.position.z }, pendingSit.approach)) {
      setMyPose("sit", { sittingOn: pendingSit.instanceId })
      applySitTransform(myAvatar, pendingSit.instanceId)
      myTarget = { x: myAvatar.position.x, z: myAvatar.position.z }
      pendingSit = null
    }
  }

  for (const [pubkey, target] of Object.entries(remoteTargets)) {
    if (pubkey === myPubkey) continue
    const av = avatars[pubkey]
    if (!av) continue

    if (av.userData?.pose === "sit" && av.userData?.sittingOnInstanceId) {
      applySitTransform(av, av.userData.sittingOnInstanceId)
      continue
    }

    let tx = target?.pos?.x
    let tz = target?.pos?.z
    const finalTile = target?.tile
    if (finalTile && typeof finalTile.x === "number" && typeof finalTile.z === "number") {
      const fp = fromTileCoord(finalTile)
      tx = fp.x
      tz = fp.z
    }
    if (typeof tx !== "number" || typeof tz !== "number") continue

    const dx = tx - av.position.x
    const dz = tz - av.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)

    const speed = 3.0
    const step = Math.min(dist, speed * dt)
    const nx = dist > 0.0001 ? av.position.x + (dx / dist) * step : av.position.x
    const nz = dist > 0.0001 ? av.position.z + (dz / dist) * step : av.position.z

    if (typeof target?.dir === "number") {
      av.rotation.y = yawFromDir8(target.dir)
    } else {
      faceToward(av, { x: av.position.x, z: av.position.z }, { x: tx, z: tz })
    }

    if (finalTile && typeof finalTile.x === "number" && typeof finalTile.z === "number") {
      const fp = fromTileCoord(finalTile)
      const fdx = fp.x - nx
      const fdz = fp.z - nz
      const fdist = Math.sqrt(fdx * fdx + fdz * fdz)
      if (fdist <= 0.02) {
        updateAvatarPosition(av, { x: fp.x, z: fp.z, y: getWalkSurfaceY(finalTile) })
        continue
      }
    }

    const rt = toTileCoord({ x: nx, z: nz })
    updateAvatarPosition(av, { x: nx, z: nz, y: getWalkSurfaceY(rt) })
  }

  renderer.render(scene, camera)
}