import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js'

function colorFromString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 0xffffff
}

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

const faceTextureCache = new Map()

function makeFaceTexture(faceId) {
  const key = String(faceId || "smile")
  if (faceTextureCache.has(key)) return faceTextureCache.get(key)

  const c = document.createElement("canvas")
  c.width = 32
  c.height = 32
  const ctx = c.getContext("2d")
  ctx.clearRect(0, 0, 32, 32)

  const ink = "#111"
  ctx.fillStyle = ink

  // whites of eyes
  ctx.fillStyle = "#f7f7f7"
  ctx.fillRect(8, 10, 7, 6)
  ctx.fillRect(17, 10, 7, 6)

  // pupils
  ctx.fillStyle = ink
  ctx.fillRect(11, 12, 2, 2)
  ctx.fillRect(20, 12, 2, 2)

  // brows
  ctx.fillRect(9, 9, 5, 1)
  ctx.fillRect(18, 9, 5, 1)

  // mouths
  ctx.strokeStyle = ink
  ctx.lineWidth = 3
  ctx.lineCap = "round"
  if (key === "neutral") {
    ctx.beginPath()
    ctx.moveTo(11, 21)
    ctx.lineTo(21, 21)
    ctx.stroke()
  } else if (key === "sad") {
    ctx.beginPath()
    ctx.arc(16, 25, 7, Math.PI * 1.15, Math.PI * 1.85)
    ctx.stroke()
  } else if (key === "surprised") {
    ctx.beginPath()
    ctx.arc(16, 22, 4, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    // smile
    ctx.beginPath()
    ctx.arc(16, 19, 8, 0.15 * Math.PI, 0.85 * Math.PI)
    ctx.stroke()
  }

  // subtle blush
  ctx.globalAlpha = 0.25
  ctx.fillStyle = "#d86a7a"
  ctx.fillRect(6, 18, 4, 3)
  ctx.fillRect(22, 18, 4, 3)
  ctx.globalAlpha = 1

  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true
  faceTextureCache.set(key, tex)
  return tex
}

const skinTextureCache = new Map()

function hexToCss(hex) {
  const c = new THREE.Color(hex)
  const r = Math.round(c.r * 255)
  const g = Math.round(c.g * 255)
  const b = Math.round(c.b * 255)
  return `rgb(${r}, ${g}, ${b})`
}

function drawFaceFeatures(ctx, faceKey) {
  // draw into an 8x8 area at current origin
  ctx.fillStyle = "#111"

  // eyes
  ctx.fillRect(1, 2, 2, 2)
  ctx.fillRect(5, 2, 2, 2)

  // mouth
  ctx.strokeStyle = "#111"
  ctx.lineWidth = 1
  ctx.lineCap = "round"
  if (faceKey === "neutral") {
    ctx.beginPath()
    ctx.moveTo(2, 6)
    ctx.lineTo(6, 6)
    ctx.stroke()
  } else if (faceKey === "sad") {
    ctx.beginPath()
    ctx.moveTo(2, 6)
    ctx.quadraticCurveTo(4, 5, 6, 6)
    ctx.stroke()
  } else if (faceKey === "surprised") {
    ctx.beginPath()
    ctx.rect(3, 5, 2, 2)
    ctx.stroke()
  } else {
    // smile
    ctx.beginPath()
    ctx.moveTo(2, 5)
    ctx.quadraticCurveTo(4, 7, 6, 5)
    ctx.stroke()
  }
}

function makeSkinTexture(appearance) {
  const app = normalizeAppearance(appearance)
  const key = JSON.stringify(app)
  if (skinTextureCache.has(key)) return skinTextureCache.get(key)

  const skin = colorForAppearanceKey(app.skin)
  const hair = colorForAppearanceKey(app.hair === "none" ? "none" : app.hair)
  const top = colorForAppearanceKey(app.top)
  const bottom = colorForAppearanceKey(app.bottom)

  const c = document.createElement("canvas")
  c.width = 64
  c.height = 64
  const ctx = c.getContext("2d")
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, 64, 64)

  const fill = (x, y, w, h, colorHex) => {
    ctx.fillStyle = hexToCss(colorHex)
    ctx.fillRect(x, y, w, h)
  }

  // --- Head (8x8 faces)
  // layout (classic minecraft):
  // top  : (8,0)
  // bottom: (16,0)
  // left : (0,8)
  // front: (8,8)
  // right: (16,8)
  // back : (24,8)
  fill(0, 8, 32, 8, skin)
  fill(8, 0, 8, 8, hair)
  fill(16, 0, 8, 8, skin)
  // hair wrap on sides/back/top
  if (app.hair !== "none") {
    fill(0, 8, 32, 8, hair)
  }
  // face features on front (8,8)
  ctx.save()
  ctx.translate(8, 8)
  // skin base for face
  fill(0, 0, 8, 8, skin)
  drawFaceFeatures(ctx, app.face)
  ctx.restore()

  // --- Body (8x12 faces)
  // top: (20,16) 8x4; bottom: (28,16) 8x4
  // left: (16,20) 4x12; front: (20,20) 8x12; right: (28,20) 4x12; back: (32,20) 8x12
  fill(16, 16, 24, 16, top)

  // --- Right leg (4x12 faces)
  // top: (4,16) 4x4; bottom: (8,16) 4x4
  // left: (0,20) 4x12; front: (4,20) 4x12; right: (8,20) 4x12; back: (12,20) 4x12
  fill(0, 16, 16, 16, bottom)

  // --- Right arm (4x12 faces)
  // top: (44,16) 4x4; bottom: (48,16) 4x4
  // left: (40,20) 4x12; front: (44,20) 4x12; right: (48,20) 4x12; back: (52,20) 4x12
  fill(40, 16, 16, 16, top)

  // small skin-colored hand tip (bottom row of arm front)
  fill(44, 31, 4, 1, skin)
  fill(48, 31, 4, 1, skin)

  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true
  skinTextureCache.set(key, tex)
  return tex
}

export function quantizeYawTo8(yaw) {
  const step = (Math.PI * 2) / 8
  const n = Math.round(yaw / step)
  return n * step
}

function colorForAppearanceKey(key) {
  const map = {
    peach: 0xf2c6a0,
    tan: 0xd6a17a,
    brown: 0xa26c4a,
    dark: 0x6b3f2a,

    none: 0x000000,
    black: 0x1b1b1b,
    brown_short: 0x5a3a24,
    blonde_short: 0xcaa46a,
    red_short: 0x9b3b2e,

    tee_blue: 0x3f6fff,
    tee_red: 0xd94a4a,
    hoodie_green: 0x2f8f4e,
    jacket_black: 0x1f1f1f,

    pants_gray: 0x6e6e7a,
    pants_blue: 0x3b57b6,
    shorts_black: 0x262626,
    skirt_pink: 0xc95e8f
  }
  return map[String(key || "")] ?? 0xffffff
}

function makeUvMaterial(tex, x, y, w, h) {
  const t = tex.clone()
  t.needsUpdate = true
  const mat = new THREE.MeshBasicMaterial({ map: t })
  // texture space: (0,0) bottom-left in three.js
  mat.map.repeat.set(w / 64, h / 64)
  mat.map.offset.set(x / 64, 1 - (y + h) / 64)
  mat.map.wrapS = THREE.ClampToEdgeWrapping
  mat.map.wrapT = THREE.ClampToEdgeWrapping
  return mat
}

function createSkinnedBox(w, h, d, tex, uvs) {
  const geo = new THREE.BoxGeometry(w, h, d)
  // material order for BoxGeometry: +x, -x, +y, -y, +z, -z
  const mats = [
    makeUvMaterial(tex, ...uvs.px),
    makeUvMaterial(tex, ...uvs.nx),
    makeUvMaterial(tex, ...uvs.py),
    makeUvMaterial(tex, ...uvs.ny),
    makeUvMaterial(tex, ...uvs.pz),
    makeUvMaterial(tex, ...uvs.nz)
  ]
  const mesh = new THREE.Mesh(geo, mats)
  mesh.userData = mesh.userData || {}
  mesh.userData.uvs = uvs
  return mesh
}

export function createAvatar(scene, pubkey) {
  const group = new THREE.Group()

  group.userData.pubkey = String(pubkey || "")

  const baseColor = pubkey ? colorFromString(pubkey) : Math.random() * 0xffffff
  group.userData.baseColor = baseColor

  const initialApp = normalizeAppearance(null)
  const tex = makeSkinTexture(initialApp)

  // Minecraft-ish proportions (scaled to your world)
  const head = createSkinnedBox(0.64, 0.64, 0.64, tex, {
    px: [16, 8, 8, 8],
    nx: [0, 8, 8, 8],
    py: [8, 0, 8, 8],
    ny: [16, 0, 8, 8],
    pz: [8, 8, 8, 8],
    nz: [24, 8, 8, 8]
  })
  head.position.y = 1.70

  const torso = createSkinnedBox(0.64, 0.78, 0.32, tex, {
    px: [28, 20, 4, 12],
    nx: [16, 20, 4, 12],
    py: [20, 16, 8, 4],
    ny: [28, 16, 8, 4],
    pz: [20, 20, 8, 12],
    nz: [32, 20, 8, 12]
  })
  torso.position.y = 1.05

  const armL = createSkinnedBox(0.24, 0.74, 0.24, tex, {
    px: [48, 20, 4, 12],
    nx: [40, 20, 4, 12],
    py: [44, 16, 4, 4],
    ny: [48, 16, 4, 4],
    pz: [44, 20, 4, 12],
    nz: [52, 20, 4, 12]
  })
  armL.position.set(-0.46, 1.05, 0)

  const armR = createSkinnedBox(0.24, 0.74, 0.24, tex, {
    px: [48, 20, 4, 12],
    nx: [40, 20, 4, 12],
    py: [44, 16, 4, 4],
    ny: [48, 16, 4, 4],
    pz: [44, 20, 4, 12],
    nz: [52, 20, 4, 12]
  })
  armR.position.set(0.46, 1.05, 0)

  const legL = createSkinnedBox(0.24, 0.78, 0.24, tex, {
    px: [8, 20, 4, 12],
    nx: [0, 20, 4, 12],
    py: [4, 16, 4, 4],
    ny: [8, 16, 4, 4],
    pz: [4, 20, 4, 12],
    nz: [12, 20, 4, 12]
  })
  legL.position.set(-0.16, 0.39, 0)

  const legR = createSkinnedBox(0.24, 0.78, 0.24, tex, {
    px: [8, 20, 4, 12],
    nx: [0, 20, 4, 12],
    py: [4, 16, 4, 4],
    ny: [8, 16, 4, 4],
    pz: [4, 20, 4, 12],
    nz: [12, 20, 4, 12]
  })
  legR.position.set(0.16, 0.39, 0)

  group.add(head)
  group.add(torso)
  group.add(armL)
  group.add(armR)
  group.add(legL)
  group.add(legR)

  group.traverse((o) => {
    if (!o || typeof o !== "object") return
    o.userData = o.userData || {}
    o.userData.pubkey = String(pubkey || "")
  })

  group.userData.parts = { head, torso, armL, armR, legL, legR }
  group.userData.pose = "stand"
  group.userData.poseYOffset = 0
  group.userData.appearance = initialApp

  group.userData.restPose = {
    head: { pos: head.position.clone(), rot: head.rotation.clone() },
    torso: { pos: torso.position.clone(), rot: torso.rotation.clone() },
    armL: { pos: armL.position.clone(), rot: armL.rotation.clone() },
    armR: { pos: armR.position.clone(), rot: armR.rotation.clone() },
    legL: { pos: legL.position.clone(), rot: legL.rotation.clone() },
    legR: { pos: legR.position.clone(), rot: legR.rotation.clone() }
  }

  group.position.y = 0
  scene.add(group)

  setAvatarAppearance(group, group.userData.appearance)

  return group
}

export function setAvatarPose(avatar, pose) {
  if (!avatar) return
  const p = pose === "sit" ? "sit" : "stand"
  avatar.userData.pose = p
  avatar.userData.poseYOffset = 0

  const parts = avatar.userData?.parts
  const rest = avatar.userData?.restPose
  if (!parts || !rest) return

  const reset = () => {
    for (const k of ["head", "torso", "armL", "armR", "legL", "legR"]) {
      const part = parts[k]
      const r = rest[k]
      if (!part || !r) continue
      part.position.copy(r.pos)
      part.rotation.copy(r.rot)
    }
  }

  reset()

  if (p === "sit") {
    if (parts.torso) {
      parts.torso.position.y = 1.00
      parts.torso.position.z = -0.02
    }
    for (const leg of [parts.legL, parts.legR]) {
      if (!leg) continue
      leg.rotation.x = -Math.PI / 2
      leg.position.y = 0.56
      leg.position.z = 0.34
    }
    if (parts.armL) {
      parts.armL.rotation.x = 0.12
      parts.armL.rotation.z = 0.10
      parts.armL.position.y = 1.02
      parts.armL.position.z = 0.02
    }
    if (parts.armR) {
      parts.armR.rotation.x = 0.12
      parts.armR.rotation.z = -0.10
      parts.armR.position.y = 1.02
      parts.armR.position.z = 0.02
    }
  }
}

export function setAvatarAppearance(avatar, appearance) {
  if (!avatar) return
  const app = normalizeAppearance(appearance)
  avatar.userData.appearance = app

  const parts = avatar.userData?.parts
  if (!parts) return

  const tex = makeSkinTexture(app)
  for (const k of ["head", "torso", "armL", "armR", "legL", "legR"]) {
    const part = parts[k]
    const uvs = part?.userData?.uvs
    if (!part || !uvs) continue
    part.material = [
      makeUvMaterial(tex, ...uvs.px),
      makeUvMaterial(tex, ...uvs.nx),
      makeUvMaterial(tex, ...uvs.py),
      makeUvMaterial(tex, ...uvs.ny),
      makeUvMaterial(tex, ...uvs.pz),
      makeUvMaterial(tex, ...uvs.nz)
    ]
  }
}

export function updateAvatarPosition(avatar, pos) {
  if (!avatar || !pos) return
  const baseY = typeof avatar?.userData?.poseYOffset === "number" ? avatar.userData.poseYOffset : 0
  const y = typeof pos.y === "number" && Number.isFinite(pos.y) ? pos.y + baseY : baseY
  avatar.position.set(pos.x, y, pos.z)
}
