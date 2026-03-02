import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js'
import { initNostr, publish, subscribe, list, getPubkey, getNip98AuthHeader } from "./nostr.js"
import { createRoom } from './room.js'
import { createAvatar, updateAvatarPosition } from './avatar.js'
import { NabboNet, createRoomId, roomIdToCode } from "./webrtc.js"
import { createWindowManager } from "./ui/windowManager.js"
import { createDisconnectModal } from "./ui/disconnectModal.js"
import { createPublicRooms } from "./lobby/publicRooms.js"

let scene, camera, renderer
let floor
let currentFloorPlan = null

let avatars = {}

 let issuerPubkey = ""

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
     } catch {}
   })()
}

function renderCatalog() {
  if (!catalogEl) return
  catalogEl.innerHTML = ""
  const selectedCat = (shopCategoryEl?.value || "All").trim()
  const visible = catalog.filter((it) => selectedCat === "All" || (it.category || "Other") === selectedCat)
  for (const it of visible) {
    const card = document.createElement("div")
    card.className = "card"
    card.classList.toggle("selected", selectedCatalogDefId === it.defId)

    const thumb = document.createElement("div")
    thumb.className = "thumb"
    const sq = document.createElement("div")
    sq.className = "thumb-square"
    sq.style.background = colorFromId(it.defId)
    thumb.appendChild(sq)
    card.appendChild(thumb)

    const title = document.createElement("div")
    title.className = "card-title"
    title.textContent = it.name
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
        if (typeof out?.balance?.after === "number") {
          coinsBalance = out.balance.after
          saveCachedCoins()
          renderCoins()
          renderCatalog()
        } else {
          refreshCoins()
        }
        appendChatLine(`bought: ${it.name}`)
        await new Promise((r) => setTimeout(r, 600))
        refreshInventory()
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
    const sq = document.createElement("div")
    sq.className = "thumb-square"
    sq.style.background = colorFromId(defId)
    thumb.appendChild(sq)
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
}

function refreshInventory() {
  if (!myPubkey) return
  stopInventorySub()
  inventoryItems.clear()

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

  renderInventory()
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

function teardownRoom({ reason = null, showLobby = true } = {}) {
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

function colorFromString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 0xffffff
}

function createFurniMesh(defId) {
  const geom = new THREE.BoxGeometry(0.86, 0.6, 0.86)
  const mat = new THREE.MeshBasicMaterial({ color: colorFromString(defId || "furni") })
  const mesh = new THREE.Mesh(geom, mat)
  mesh.position.y = 0.31
  return mesh
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
  placedGroup.add(mesh)

  placedItems.set(item.instanceId, { ...item, mesh })
  renderInventory()

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
    tile: it.tile
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
    .map((it) => ({ instanceId: it.instanceId, defId: it.defId, tile: it.tile }))
}

const win = createWindowManager({ initialZ: 50, bottomMargin: 70 })
const disconnectModal = createDisconnectModal({ win })
let remoteTargets = {}

let myPubkey
let myAvatar
let myTarget = { x: 0, z: 0 }
let lastSentPosAt = 0
let wasMoving = false

let roomAnnounceInterval = null

const PUBLIC_ROOM_TTL_MS = 60_000
let publicRooms = null

let currentRoom = null
let net = null

let furniSaveTimer = null
let loadingRoomState = false

let suppressDisconnectUntil = 0

let chatBubbleLayer = null
let chatBubbles = []

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

const dockNavigator = document.getElementById("dockNavigator")
const dockInventory = document.getElementById("dockInventory")
const dockShop = document.getElementById("dockShop")
const dockProfile = document.getElementById("dockProfile")

const inventoryEl = document.getElementById("inventory")
const shopEl = document.getElementById("shop")
const catalogEl = document.getElementById("catalog")
const inventoryListEl = document.getElementById("inventoryList")
const inventoryRefreshEl = document.getElementById("inventoryRefresh")
const inventoryPlaceEl = document.getElementById("inventoryPlace")
const inventoryCancelPlaceEl = document.getElementById("inventoryCancelPlace")
const coinBalanceEl = document.getElementById("coinBalance")
const claimCoinsEl = document.getElementById("claimCoins")
const shopCategoryEl = document.getElementById("shopCategory")
const profileEl = document.getElementById("profile")
const profileNameEl = document.getElementById("profileName")
const profileSaveEl = document.getElementById("profileSave")
const createRoomWinEl = document.getElementById("createRoom")
const createRoomNameEl = document.getElementById("createRoomName")
const createRoomPlanEl = document.getElementById("createRoomPlan")
const createRoomTemplatesEl = document.getElementById("createRoomTemplates")
const createRoomPublicEl = document.getElementById("createRoomPublic")
const createRoomConfirmEl = document.getElementById("createRoomConfirm")
const createRoomCancelEl = document.getElementById("createRoomCancel")

let selectedCreateRoomPlan = ""
let selectedCreateRoomDoor = null
let customScrollbarApi = null

const catalog = [
  { defId: "chair_basic", name: "Chair", price: 10, category: "Seating" },
  { defId: "table_basic", name: "Table", price: 25, category: "Tables" },
  { defId: "plant_basic", name: "Plant", price: 15, category: "Decor" }
]

const inventoryItems = new Map()
let inventorySub = null
let selectedInstanceId = ""

let coinsSub = null
let coinsBalance = null
let latestBalanceEvent = null

let selectedCatalogDefId = ""
let isPlacing = false
let ghostItem = null
let ghostInstanceId = ""

function colorFromId(id) {
  return `#${colorFromString(String(id || "")).toString(16).padStart(6, "0")}`
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
    ghostInstanceId = ""
    if (ghostItem) {
      try {
        scene.remove(ghostItem)
      } catch {}
      ghostItem = null
    }
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

  const mat = new THREE.MeshBasicMaterial({ color: colorFromString(defId), transparent: true, opacity: 0.35 })
  const geom = new THREE.BoxGeometry(0.86, 0.6, 0.86)
  const mesh = new THREE.Mesh(geom, mat)
  mesh.position.y = 0.31
  ghostItem = mesh
  ghostInstanceId = selectedInstanceId
  scene.add(ghostItem)
}

function ensureShopCategories() {
  if (!shopCategoryEl) return
  const cats = Array.from(new Set(catalog.map((x) => x.category || "Other")))
  cats.sort((a, b) => a.localeCompare(b))
  const all = ["All", ...cats]
  shopCategoryEl.innerHTML = ""
  for (const c of all) {
    const opt = document.createElement("option")
    opt.value = c
    opt.textContent = c
    shopCategoryEl.appendChild(opt)
  }
}

function tryPlaceSelectedAtTile(tile) {
  if (!tile || typeof tile.x !== "number" || typeof tile.z !== "number") return false
  if (!selectedInstanceId || !net) return false
  const inv = inventoryItems.get(selectedInstanceId)
  if (!inv?.defId) return false
  const item = { instanceId: selectedInstanceId, defId: inv.defId, tile: { x: tile.x, z: tile.z } }
  if (currentRoom?.isHost) {
    placeItemLocal(item)
    net.broadcast({ type: "item_placed", item })
  } else {
    net.broadcast({ type: "place_item", item })
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
  return floor.userData.tileSet.has(`${t.x},${t.z}`)
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
    const payload = JSON.stringify({ type: "room", roomId, code, name, plan, door: door || null, count, ownerPubkey: myPubkey, ts: Math.floor(Date.now() / 1000) })
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
  }
  return avatars[pubkey]
}

function setRemoteTarget(pubkey, pos) {
  const snapped = snapToTileCenter(pos)
  const clamped = clampToWalkable(snapped)
  remoteTargets[pubkey] = {
    pos: { x: clamped.x, z: clamped.z },
    tile: toTileCoord(clamped)
  }
}

function setRemoteTargetTile(pubkey, tile) {
  const clamped = clampToWalkable(fromTileCoord(tile))
  remoteTargets[pubkey] = {
    pos: { x: clamped.x, z: clamped.z },
    tile: toTileCoord(clamped)
  }
}

function handleNetMessage(fromPubkey, msg) {
  if (!msg || typeof msg !== "object") return

  if (fromPubkey) requestNostrProfile(fromPubkey)

  if (msg.type === "host_left") {
    if (currentRoom && !currentRoom.isHost) {
      kickToLobby("The host disconnected. You were returned to the lobby.")
    }
    return
  }

  if (msg.type === "snapshot" && Array.isArray(msg.players)) {
    for (const p of msg.players) {
      if (!p?.pubkey || !p?.pos) continue
      if (p.pubkey === myPubkey) continue
      if (p.name && typeof p.name === "string") {
        maybeApplyNostrName(p.pubkey, p.name)
      }
      requestNostrProfile(p.pubkey)
      ensureAvatar(p.pubkey)
      setRemoteTarget(p.pubkey, p.pos)
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
    ensureAvatar(who)
    setRemoteTarget(who, msg.pos)
    return
  }

  if (msg.type === "pos") {
    const who = msg.pubkey ?? fromPubkey
    ensureAvatar(who)
    if (msg.tile && typeof msg.tile.x === "number" && typeof msg.tile.z === "number") {
      if (msg.pos && typeof msg.pos.x === "number" && typeof msg.pos.z === "number") {
        remoteTargets[who] = { pos: { x: msg.pos.x, z: msg.pos.z }, tile: msg.tile }
      } else {
        setRemoteTargetTile(who, msg.tile)
      }
    } else {
      setRemoteTarget(who, msg.pos)
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
}

function handlePeerState(peer, state) {
  if (state === "open") {
    appendChatLine(`connected: ${peer.slice(0, 8)}...`)

    ensureAvatar(peer)

    if (!net || !currentRoom) return

    const myPos = myAvatar ? { x: myAvatar.position.x, z: myAvatar.position.z } : { x: 0, z: 0 }
    const snappedMyPos = snapToTileCenter(myPos)

    if (currentRoom.isHost) {
      const players = Object.keys(avatars).map((pubkey) => {
        const av = avatars[pubkey]
        const p = snapToTileCenter({ x: av.position.x, z: av.position.z })
        return { pubkey, name: getDisplayName(pubkey), pos: p, tile: toTileCoord(p) }
      })
      net.sendTo(peer, { type: "snapshot", players })

      const items = Array.from(placedItems.values()).map((it) => ({ instanceId: it.instanceId, defId: it.defId, tile: it.tile }))
      if (items.length) {
        net.sendTo(peer, { type: "room_items", items })
      }
    } else {
      net.sendTo(currentRoom.ownerPubkey, { type: "hello", name: myDisplayName, pos: snappedMyPos, tile: toTileCoord(snappedMyPos) })
    }
  } else if (state === "failed" || state === "disconnected" || state === "closed") {
    appendChatLine(`connection ${state}: ${peer.slice(0, 8)}...`)

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

async function startRoom({ roomId, code, name, plan, door, ownerPubkey, isHost, announcePublic }) {
  if (currentRoom) {
    teardownRoom({ reason: null, showLobby: false })
  }
  if (isHost && typeof announcePublic !== "boolean") {
    announcePublic = true
  }
  currentRoom = { roomId, code, name, plan, door: door || null, ownerPubkey, isHost, announcePublic }
  setInRoom(true)
  win.hideWindow(lobbyEl, dockNavigator)
  joinHintEl.textContent = ""

  appendChatLine(`room: ${code} (${roomId.slice(0, 8)}...)`)
  appendChatLine(isHost ? "you are the host" : `host: ${ownerPubkey.slice(0, 8)}...`)

  for (const k of Object.keys(avatars)) {
    scene.remove(avatars[k])
    delete avatars[k]
  }
  remoteTargets = {}

  if (isHost) {
    upsertMyRoom({ roomId, code, name, plan, door: door || null })
    const shouldAnnounce = Boolean(currentRoom.announcePublic)
    if (shouldAnnounce) startRoomAnnouncements({ roomId, code, name, plan, door: door || null })
    else {
      publishRoomClosed({ roomId, code })
      stopRoomAnnouncements()
    }
  } else {
    stopRoomAnnouncements()
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
    floor = createRoom(scene, { plan: effectivePlan, door: door || null })
    currentFloorPlan = effectivePlan
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
  }

  myAvatar = ensureAvatar(myPubkey)
  const startPos = snapToTileCenter(getSpawnPos())
  updateAvatarPosition(myAvatar, startPos)
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
            return { pubkey, pos: { x: av.position.x, z: av.position.z } }
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

        if (msg.type === "place_item" && msg.item) {
          const item = msg.item
          if (item?.instanceId && item?.defId && item?.tile && typeof item.tile.x === "number" && typeof item.tile.z === "number") {
            placeItemLocal(item)
            net.broadcast({ type: "item_placed", item })
          }
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
    return { roomId: match.roomId, code: match.code, name: match.name, plan: match.plan, door: match.door || null, ownerPubkey: match.ownerPubkey }
  }

  const mine = loadMyRooms().find((r) => r.code?.toUpperCase() === code)
  if (mine) return { roomId: mine.roomId, ownerPubkey: myPubkey, code: mine.code, name: mine.name, plan: mine.plan, isHost: true }

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

  // ---------- NOSTR SETUP ----------
  await initNostr()
  myPubkey = getPubkey()

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

  ensureShopCategories()
  if (shopCategoryEl) {
    shopCategoryEl.onchange = () => renderCatalog()
  }

  setPlacingMode(false)
  if (inventoryPlaceEl) {
    inventoryPlaceEl.onclick = () => {
      if (!selectedInstanceId) {
        appendChatLine("select an item to place")
        return
      }
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
      const prevText = claimCoinsEl.textContent
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
        claimCoinsEl.disabled = false
        claimCoinsEl.textContent = prevText || "Daily Claim"
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
  if (createRoomWinEl) createRoomWinEl.dataset.centerOnOpen = "true"
  if (roomInfoEl) roomInfoEl.dataset.centerOnOpen = "true"

  win.centerWindow(lobbyEl, { force: true })
  win.centerWindow(inventoryEl, { force: true })
  if (shopEl) win.centerWindow(shopEl, { force: true })
  if (profileEl) win.centerWindow(profileEl, { force: true })
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
      renderPlanPreviews()
    })
  }

  if (!selectedCreateRoomPlan) {
    const first = createRoomTemplatesEl?.querySelector?.(".plan-card")
    const code = first?.getAttribute?.("data-plan-code")
    if (code) selectedCreateRoomPlan = code
    selectedCreateRoomDoor = getDoorFromTemplateButton(first)
  }

  renderPlanPreviews()

  if (profileEl && profileNameEl) {
    profileNameEl.value = myDisplayName
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
      const announcePublic = Boolean(createRoomPublicEl?.checked)

      win.hideWindow(createRoomWinEl)
      await startRoom({ roomId, code, name, plan, door, ownerPubkey: myPubkey, isHost: true, announcePublic })
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
      await startRoom({ roomId: parsed.roomId, code: parsed.code || roomIdToCode(parsed.roomId), name: parsed.name, plan: parsed.plan, door: parsed.door || null, ownerPubkey: myPubkey, isHost: true })
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
    await startRoom({ roomId, code, name, plan, door, ownerPubkey: owner, isHost: false })
  }

  sendBtn.onclick = async () => {
    const msg = chatInput.value.trim()
    if (!msg) return
    chatInput.value = ""

    if (!net) return

    if (currentRoom?.isHost) {
      const out = { type: "chat", text: msg, pubkey: myPubkey, name: myDisplayName }
      handleNetMessage(myPubkey, out)
      net.broadcast(out)
    } else {
      net.broadcast({ type: "chat", text: msg, name: myDisplayName })
    }
  }

  chatInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return
    if (e.shiftKey) return
    e.preventDefault()
    sendBtn.click()
  })

  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()

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
    return false
  }

  const canvasEl = renderer.domElement
  canvasEl.addEventListener("pointerdown", (e) => {
    if (!currentRoom) return
    if (document.body.classList.contains("dragging")) return
    if (shouldIgnoreScenePointer(e.target)) return

    isPanning = true
    panDidMove = false
    panStart = { x: e.clientX, y: e.clientY }
    camStart = { x: camera.position.x, y: camera.position.y, z: camera.position.z }
    canvasEl.setPointerCapture(e.pointerId)
  })

  canvasEl.addEventListener("pointermove", (e) => {
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

    if (document.body.classList.contains("dragging")) return

    const t = e.target
    if (t && t.closest) {
      if (t.closest(".window")) return
      if (t.closest(".dock")) return
      if (t.closest("#ui")) return
      if (t.closest(".chatlog")) return
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
          setPlacingMode(false)
          if (inventoryEl) win.showWindow(inventoryEl, dockInventory)
          return
        }
      }
      const w = floor.userData.tileToWorld(tile.x, tile.z)
      const target = { x: w.x, z: w.z }
      if (!isTileWalkable(target)) return
      myTarget = target
      return
    }

    const p = hits[0].point
    const target = snapToTileCenter({ x: p.x, z: p.z })
    if (!isTileWalkable(target)) return
    myTarget = target
  })

  renderPublicRooms()
  renderMyRooms()

  win.makeDraggable(lobbyEl)
  win.makeDraggable(inventoryEl)
  if (shopEl) win.makeDraggable(shopEl)
  if (profileEl) win.makeDraggable(profileEl)
  if (createRoomWinEl) win.makeDraggable(createRoomWinEl)
  if (roomInfoEl) win.makeDraggable(roomInfoEl)

  win.makeResizable(lobbyEl)
  win.makeResizable(inventoryEl)
  if (shopEl) win.makeResizable(shopEl)
  if (profileEl) win.makeResizable(profileEl)
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

  for (const btn of document.querySelectorAll("[data-winclose]") || []) {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-winclose")
      if (key === "navigator") win.hideWindow(lobbyEl, dockNavigator)
      if (key === "inventory") win.hideWindow(inventoryEl, dockInventory)
      if (key === "shop") win.hideWindow(shopEl, dockShop)
      if (key === "profile") win.hideWindow(profileEl, dockProfile)
      if (key === "createRoom") win.hideWindow(createRoomWinEl)
      if (key === "roomInfo") win.hideWindow(roomInfoEl)
    })
  }
}

function animate() {
  requestAnimationFrame(animate)

  updateChatBubbles()

  if (myAvatar && currentRoom) {
    const speed = 3.0
    const dt = 1 / 60

    const dx = myTarget.x - myAvatar.position.x
    const dz = myTarget.z - myAvatar.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (dist > 0.02) {
      wasMoving = true
      const step = Math.min(dist, speed * dt)
      myAvatar.position.x += (dx / dist) * step
      myAvatar.position.z += (dz / dist) * step

      if (dist < 0.08) {
        updateAvatarPosition(myAvatar, myTarget)
      }

      const now = performance.now()
      if (net && now - lastSentPosAt > 100) {
        lastSentPosAt = now
        const pos = { x: myAvatar.position.x, z: myAvatar.position.z }
        const tile = toTileCoord(myTarget)
        if (currentRoom.isHost) {
          const out = { type: "pos", pos, tile, pubkey: myPubkey }
          net.broadcast(out)
        } else {
          net.broadcast({ type: "pos", pos, tile })
        }
      }
    } else if (wasMoving) {
      wasMoving = false
      if (net) {
        const pos = { x: myTarget.x, z: myTarget.z }
        const tile = toTileCoord(myTarget)
        if (currentRoom.isHost) {
          const out = { type: "pos", pos, tile, pubkey: myPubkey }
          net.broadcast(out)
        } else {
          net.broadcast({ type: "pos", pos, tile })
        }
      }
    }
  }

  for (const [pubkey, target] of Object.entries(remoteTargets)) {
    if (pubkey === myPubkey) continue
    const av = avatars[pubkey]
    if (!av) continue
    const tx = target?.pos?.x
    const tz = target?.pos?.z
    if (typeof tx !== "number" || typeof tz !== "number") continue

    const dx = tx - av.position.x
    const dz = tz - av.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)

    const lerp = 0.22
    const nx = av.position.x + dx * lerp
    const nz = av.position.z + dz * lerp

    const finalTile = target.tile
    if (finalTile && typeof finalTile.x === "number" && typeof finalTile.z === "number") {
      const fp = fromTileCoord(finalTile)
      const fdx = fp.x - nx
      const fdz = fp.z - nz
      const fdist = Math.sqrt(fdx * fdx + fdz * fdz)
      if (fdist < 0.06) {
        updateAvatarPosition(av, fp)
        continue
      }
    }

    updateAvatarPosition(av, { x: nx, z: nz })
  }

  renderer.render(scene, camera)
}