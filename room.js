import * as THREE from 'https://unpkg.com/three@0.158.0/build/three.module.js'

export function createRoom(scene, { plan = "classic", door = null } = {}) {
  const heightFromChar = (ch) => {
    if (!ch) return null
    if (ch === "x" || ch === "X") return null
    if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - "0".charCodeAt(0)
    const lower = ch.toLowerCase()
    if (lower >= "a" && lower <= "q") return 10 + (lower.charCodeAt(0) - "a".charCodeAt(0))
    return null
  }

  const normalizePlanCode = (code) => {
    const src = String(code || "")
    const lines = src
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/g, ""))
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/ /g, "x"))
    return lines.join("\n")
  }

  const isRawPlanCode = (v) => {
    if (typeof v !== "string") return false
    const s = v.trim()
    if (!s) return false

    if (!/^[xX0-9a-qA-Q\s]+$/.test(s)) return false

    if (s.includes("\n")) {
      return /[xX0-9a-qA-Q]/.test(s)
    }

    return /[xX0-9]/.test(s) && s.length >= 4
  }

  const generateRectPlan = ({ w, h, padX = 2, padZ = 2, levelChar = "0" }) => {
    const rows = []
    const fullW = padX + w
    for (let z = 0; z < padZ; z++) rows.push("x".repeat(fullW))
    for (let z = 0; z < h; z++) rows.push("x".repeat(padX) + levelChar.repeat(w))
    return rows.join("\n")
  }

  const generateMaskPlan = ({ mask, padX = 2, padZ = 2, levelChar = "0" }) => {
    const lines = String(mask || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/g, ""))
      .filter((l) => l.length > 0)

    const w = lines.reduce((m, l) => Math.max(m, l.length), 0)
    const rows = []
    const fullW = padX + w
    for (let z = 0; z < padZ; z++) rows.push("x".repeat(fullW))
    for (const l of lines) {
      const padded = l.padEnd(w, " ")
      let row = "x".repeat(padX)
      for (let i = 0; i < w; i++) {
        const ch = padded[i]
        row += ch === "#" ? levelChar : "x"
      }
      rows.push(row)
    }
    return rows.join("\n")
  }

  const getPlanCode = (k) => {
    if (k === "small") return generateRectPlan({ w: 14, h: 14, padX: 2, padZ: 2, levelChar: "0" })
    if (k === "wide") return generateRectPlan({ w: 28, h: 16, padX: 2, padZ: 2, levelChar: "0" })
    if (k === "big") return generateRectPlan({ w: 24, h: 20, padX: 2, padZ: 2, levelChar: "0" })

    if (k === "l") {
      return generateMaskPlan({
        mask: `
####################
####################
####################
####################
####################
####################
####################
####################
####################
####################
##########          
##########          
##########          
##########          
##########          
##########          
##########          
##########          
##########          
##########          
`
      })
    }

    if (k === "hall") {
      return generateMaskPlan({
        mask: `
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
##########
`
      })
    }

    if (k === "cross") {
      return generateMaskPlan({
        mask: `
     ########     
     ########     
     ########     
     ########     
##################
##################
##################
##################
##################
     ########     
     ########     
     ########     
     ########     
`
      })
    }

    if (k === "steps") {
      return generateMaskPlan({
        mask: `
####################
################### 
##################  
#################   
################    
###############     
##############      
#############       
############        
###########         
##########          
#########           
########            
`
      })
    }
    return generateRectPlan({ w: 20, h: 20, padX: 2, padZ: 2, levelChar: "0" })
  }

  const parsePlan = (code) => {
    const lines = String(code || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/g, ""))
      .filter((l) => l.length > 0)

    const rows = lines.length
    const cols = lines.reduce((m, l) => Math.max(m, l.length), 0)

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity

    const tiles = []
    for (let z = 0; z < rows; z++) {
      const line = lines[z]
      for (let x = 0; x < cols; x++) {
        const h = heightFromChar(line[x])
        if (h === null) continue
        tiles.push({ x, z, h })
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minZ = Math.min(minZ, z)
        maxZ = Math.max(maxZ, z)
      }
    }

    if (tiles.length === 0) {
      minX = 0
      maxX = 0
      minZ = 0
      maxZ = 0
    }

    const widthTiles = maxX - minX + 1
    const depthTiles = maxZ - minZ + 1

    const toWorld = (x, z) => {
      const wx = (x - minX) + 0.5 - widthTiles / 2
      const wz = (z - minZ) + 0.5 - depthTiles / 2
      return { x: wx, z: wz }
    }

    const minWorld = toWorld(minX, minZ)
    const maxWorld = toWorld(maxX, maxZ)

    return {
      rows,
      cols,
      tiles,
      minX,
      maxX,
      minZ,
      maxZ,
      widthTiles,
      depthTiles,
      minWorld,
      maxWorld
    }
  }

  const planCode = isRawPlanCode(plan) ? normalizePlanCode(plan) : getPlanCode(plan)
  const parsed = parsePlan(planCode)

  const tileToWorld = (tx, tz) => {
    return {
      x: (tx - parsed.minX) + 0.5 - parsed.widthTiles / 2,
      z: (tz - parsed.minZ) + 0.5 - parsed.depthTiles / 2
    }
  }

  const worldToTile = (x, z) => {
    return {
      x: Math.round(x + parsed.widthTiles / 2 - 0.5) + parsed.minX,
      z: Math.round(z + parsed.depthTiles / 2 - 0.5) + parsed.minZ
    }
  }

  const tileSet = new Set()
  for (const t of parsed.tiles) {
    tileSet.add(`${t.x},${t.z}`)
  }

  const floorWidth = parsed.widthTiles
  const floorDepth = parsed.depthTiles

  const rayGeom = new THREE.PlaneGeometry(floorWidth, floorDepth)
  const rayMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
  const floor = new THREE.Mesh(rayGeom, rayMat)

  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, 0)
  scene.add(floor)

  const tiles = new THREE.Group()
  const tileGeom = new THREE.PlaneGeometry(1, 1)
  const matA = new THREE.MeshBasicMaterial({ color: 0xb88a4e })
  const matB = new THREE.MeshBasicMaterial({ color: 0xa97c45 })

  const heightScale = 0.16
  for (const t of parsed.tiles) {
    const useA = (t.x + t.z) % 2 === 0
    const tile = new THREE.Mesh(tileGeom, useA ? matA : matB)
    tile.rotation.x = -Math.PI / 2
    const wpos = parsed.widthTiles ? tileToWorld(t.x, t.z) : { x: 0, z: 0 }
    tile.position.set(wpos.x, 0.01 + t.h * heightScale, wpos.z)
    tile.userData.tile = { x: t.x, z: t.z, h: t.h }
    tiles.add(tile)
  }

  scene.add(tiles)

  const walls = new THREE.Group()
  const wallHeight = 6
  const wallMat = new THREE.MeshBasicMaterial({ color: 0xe0b244, side: THREE.FrontSide })
  const wallEdgeMat = new THREE.MeshBasicMaterial({ color: 0xc99934, side: THREE.FrontSide })

  const hasTile = (x, z) => tileSet.has(`${x},${z}`)

  const doorPicked = (() => {
    if (!door || typeof door !== "object") return null
    const dx = Number(door.x)
    const dz = Number(door.z)
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
    const x = Math.floor(dx)
    const z = Math.floor(dz)
    if (!hasTile(x, z)) return null
    // Spawn/join marker only. Doorway cutouts are determined by protruding tiles, not this coordinate.
    return { x, z }
  })()

  const doorways = (() => {
    // Any single-tile protrusion on the far (west/north) silhouette becomes a doorway cutout.
    const out = []
    for (const t of parsed.tiles) {
      const x = t.x
      const z = t.z

      // West protrusion doorway (outer step): nothing at x-1, but there is room tile immediately inside.
      if (!hasTile(x - 1, z) && hasTile(x + 1, z)) {
        // Must be a single step protruding, not a continuous ridge.
        if (!hasTile(x, z - 1) && !hasTile(x, z + 1)) {
          out.push({ side: "w", outer: { x, z }, inner: { x: x + 1, z } })
          continue
        }
      }

      // North protrusion doorway (outer step): nothing at z-1, but there is room tile immediately inside.
      if (!hasTile(x, z - 1) && hasTile(x, z + 1)) {
        if (!hasTile(x - 1, z) && !hasTile(x + 1, z)) {
          out.push({ side: "n", outer: { x, z }, inner: { x, z: z + 1 } })
          continue
        }
      }
    }
    return out
  })()

  const wallHasTile = (x, z) => {
    if (!hasTile(x, z)) return false
    if (!doorways || doorways.length === 0) return true
    // Exclude any outer doorway tiles from wall silhouette generation.
    for (const d of doorways) {
      if (x === d.outer.x && z === d.outer.z) return false
    }
    return true
  }

  const isDoorBoundaryTile = (side, x, z) => {
    if (!doorways || doorways.length === 0) return false
    for (const d of doorways) {
      if (d.side === side && d.inner.x === x && d.inner.z === z) return true
    }
    return false
  }

  const addWallPlane = ({ geomW, geomH, x, z, rotY, mat }) => {
    const g = new THREE.PlaneGeometry(geomW, geomH)
    const m = new THREE.Mesh(g, mat)
    m.position.set(x, geomH / 2, z)
    m.rotation.y = rotY
    walls.add(m)
  }

  const addWallPlaneAt = ({ geomW, geomH, x, y, z, rotY, mat }) => {
    const g = new THREE.PlaneGeometry(geomW, geomH)
    const m = new THREE.Mesh(g, mat)
    m.position.set(x, y, z)
    m.rotation.y = rotY
    walls.add(m)
  }

  // Furthest (silhouette) walls only: for each column/row, pick the furthest north/west tile.
  // This prevents interior/near walls that can hide the avatar.
  const minZByX = new Map()
  const minXByZ = new Map()

  for (const t of parsed.tiles) {
    if (!wallHasTile(t.x, t.z)) continue
    const prevZ = minZByX.get(t.x)
    if (prevZ === undefined || t.z < prevZ) minZByX.set(t.x, t.z)
    const prevX = minXByZ.get(t.z)
    if (prevX === undefined || t.x < prevX) minXByZ.set(t.z, t.x)
  }

  // North wall runs: group consecutive x that share the same minZ.
  {
    let runStartX = null
    let runEndX = null
    let runZ = null

    for (let x = parsed.minX; x <= parsed.maxX + 1; x++) {
      const mz = x <= parsed.maxX ? minZByX.get(x) : undefined
      const isSeg = mz !== undefined && !isDoorBoundaryTile("n", x, mz)

      if (isSeg) {
        if (runStartX === null) {
          runStartX = x
          runZ = mz
          runEndX = x
        } else if (runZ === mz) {
          runEndX = x
        } else {
          const len = runEndX - runStartX + 1
          const startW = tileToWorld(runStartX, runZ)
          const endW = tileToWorld(runEndX, runZ)
          const midX = (startW.x + endW.x) / 2
          const edgeZ = startW.z - 0.5
          addWallPlane({ geomW: len, geomH: wallHeight, x: midX, z: edgeZ, rotY: 0, mat: wallMat })
          runStartX = x
          runEndX = x
          runZ = mz
        }
      } else if (runStartX !== null) {
        const len = runEndX - runStartX + 1
        const startW = tileToWorld(runStartX, runZ)
        const endW = tileToWorld(runEndX, runZ)
        const midX = (startW.x + endW.x) / 2
        const edgeZ = startW.z - 0.5
        addWallPlane({ geomW: len, geomH: wallHeight, x: midX, z: edgeZ, rotY: 0, mat: wallMat })
        runStartX = null
        runEndX = null
        runZ = null
      }
    }
  }

  // West wall runs: group consecutive z that share the same minX.
  {
    let runStartZ = null
    let runEndZ = null
    let runX = null

    for (let z = parsed.minZ; z <= parsed.maxZ + 1; z++) {
      const mx = z <= parsed.maxZ ? minXByZ.get(z) : undefined
      const isSeg = mx !== undefined && !isDoorBoundaryTile("w", mx, z)

      if (isSeg) {
        if (runStartZ === null) {
          runStartZ = z
          runX = mx
          runEndZ = z
        } else if (runX === mx) {
          runEndZ = z
        } else {
          const len = runEndZ - runStartZ + 1
          const startW = tileToWorld(runX, runStartZ)
          const endW = tileToWorld(runX, runEndZ)
          const midZ = (startW.z + endW.z) / 2
          const edgeX = startW.x - 0.5
          addWallPlane({ geomW: len, geomH: wallHeight, x: edgeX, z: midZ, rotY: Math.PI / 2, mat: wallEdgeMat })
          runStartZ = z
          runEndZ = z
          runX = mx
        }
      } else if (runStartZ !== null) {
        const len = runEndZ - runStartZ + 1
        const startW = tileToWorld(runX, runStartZ)
        const endW = tileToWorld(runX, runEndZ)
        const midZ = (startW.z + endW.z) / 2
        const edgeX = startW.x - 0.5
        addWallPlane({ geomW: len, geomH: wallHeight, x: edgeX, z: midZ, rotY: Math.PI / 2, mat: wallEdgeMat })
        runStartZ = null
        runEndZ = null
        runX = null
      }
    }
  }

  // Intentionally omit south + east perimeter walls (Habbo-like: only far walls are shown).

  if (doorways && doorways.length) {
    const doorHeight = 2.1
    const lintelH = Math.max(0.1, wallHeight - doorHeight)
    const y = doorHeight + lintelH / 2
    for (const d of doorways) {
      const w = tileToWorld(d.inner.x, d.inner.z)
      if (d.side === "w") {
        addWallPlaneAt({ geomW: 1, geomH: lintelH, x: w.x - 0.5, y, z: w.z, rotY: Math.PI / 2, mat: wallEdgeMat })
      } else if (d.side === "n") {
        addWallPlaneAt({ geomW: 1, geomH: lintelH, x: w.x, y, z: w.z - 0.5, rotY: 0, mat: wallMat })
      }
    }
  }

  scene.add(walls)

  floor.userData.tiles = tiles
  floor.userData.plan = plan
  floor.userData.walls = walls
  floor.userData.planCode = planCode
  floor.userData.planParsed = parsed
  floor.userData.tileSet = tileSet
  floor.userData.tileToWorld = tileToWorld
  floor.userData.worldToTile = worldToTile
  floor.userData.door = doorPicked

  return floor
}
