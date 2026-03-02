export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

export function createWindowManager({
  initialZ = 50,
  bottomMargin = 70
} = {}) {
  const state = {
    nextZ: initialZ,
    bottomMargin
  }

  let layoutRaf = 0
  const notifyLayout = () => {
    if (layoutRaf) return
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0
      try {
        document.dispatchEvent(new Event("wm:layout"))
      } catch {}
    })
  }

  const getMinSize = (winEl) => {
    const s = getComputedStyle(winEl)
    const minW = Number.parseFloat(s.minWidth || "0") || 0
    const minH = Number.parseFloat(s.minHeight || "0") || 0
    return {
      w: minW > 0 ? minW : 240,
      h: minH > 0 ? minH : 180
    }
  }

  function centerWindow(winEl, { force = false } = {}) {
    if (!winEl) return
    if (!force && winEl.dataset.wmCentered === "true") return

    const prevDisplay = winEl.style.display
    const isHidden = winEl.classList.contains("win-hidden")
    if (isHidden) {
      winEl.classList.remove("win-hidden")
      winEl.style.visibility = "hidden"
    }

    const rect = winEl.getBoundingClientRect()
    const left = Math.round((window.innerWidth - rect.width) / 2)
    const top = Math.round((window.innerHeight - rect.height) / 2)

    winEl.style.left = `${clamp(left, 10, window.innerWidth - rect.width - 10)}px`
    winEl.style.top = `${clamp(top, 10, window.innerHeight - rect.height - state.bottomMargin)}px`
    winEl.dataset.wmCentered = "true"

    if (isHidden) {
      winEl.classList.add("win-hidden")
      winEl.style.visibility = ""
      winEl.style.display = prevDisplay
    }
  }

  function focusWindow(winEl) {
    state.nextZ += 1
    winEl.style.zIndex = String(state.nextZ)
  }

  function showWindow(winEl, dockBtn) {
    if (winEl?.dataset?.centerOnOpen === "true") {
      centerWindow(winEl)
    }
    winEl.classList.remove("win-hidden")
    dockBtn?.classList.add("active")
    focusWindow(winEl)
  }

  function hideWindow(winEl, dockBtn) {
    winEl.classList.add("win-hidden")
    dockBtn?.classList.remove("active")
  }

  function toggleWindow(winEl, dockBtn) {
    const hidden = winEl.classList.contains("win-hidden")
    if (hidden) showWindow(winEl, dockBtn)
    else hideWindow(winEl, dockBtn)
  }

  function makeDraggable(winEl) {
    const bar = winEl.querySelector(".titlebar")
    if (!bar) return

    bar.addEventListener("pointerdown", (e) => {
      const target = e.target
      if (target && target.closest && target.closest("button")) return

      focusWindow(winEl)

      const rect = winEl.getBoundingClientRect()
      const startX = e.clientX
      const startY = e.clientY
      const offsetX = startX - rect.left
      const offsetY = startY - rect.top

      const vw = window.innerWidth
      const vh = window.innerHeight

      document.body.classList.add("dragging")
      bar.setPointerCapture(e.pointerId)

      const onMove = (ev) => {
        const x = clamp(ev.clientX - offsetX, 0, vw - rect.width)
        const y = clamp(ev.clientY - offsetY, 0, vh - rect.height - state.bottomMargin)
        winEl.style.left = `${x}px`
        winEl.style.top = `${y}px`
        notifyLayout()
      }

      const onUp = () => {
        document.body.classList.remove("dragging")
        bar.removeEventListener("pointermove", onMove)
        bar.removeEventListener("pointerup", onUp)
        bar.removeEventListener("pointercancel", onUp)
        notifyLayout()
      }

      bar.addEventListener("pointermove", onMove)
      bar.addEventListener("pointerup", onUp)
      bar.addEventListener("pointercancel", onUp)
    })

    winEl.addEventListener("pointerdown", () => focusWindow(winEl))
  }

  function makeResizable(winEl) {
    if (!winEl) return
    if (winEl.querySelector(".resize-handle")) return

    const handle = document.createElement("div")
    handle.className = "resize-handle"
    winEl.appendChild(handle)

    handle.addEventListener("pointerdown", (e) => {
      focusWindow(winEl)
      e.preventDefault()
      e.stopPropagation()

      const rect = winEl.getBoundingClientRect()
      const startX = e.clientX
      const startY = e.clientY
      const startW = rect.width
      const startH = rect.height
      const min = getMinSize(winEl)

      document.body.classList.add("dragging")
      handle.setPointerCapture(e.pointerId)

      const onMove = (ev) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY

        const maxW = window.innerWidth - rect.left - 10
        const maxH = window.innerHeight - rect.top - state.bottomMargin

        const w = clamp(startW + dx, min.w, Math.max(min.w, maxW))
        const h = clamp(startH + dy, min.h, Math.max(min.h, maxH))

        winEl.style.width = `${Math.round(w)}px`
        winEl.style.height = `${Math.round(h)}px`
        notifyLayout()
      }

      const onUp = () => {
        document.body.classList.remove("dragging")
        handle.removeEventListener("pointermove", onMove)
        handle.removeEventListener("pointerup", onUp)
        handle.removeEventListener("pointercancel", onUp)
        notifyLayout()
      }

      handle.addEventListener("pointermove", onMove)
      handle.addEventListener("pointerup", onUp)
      handle.addEventListener("pointercancel", onUp)
    })
  }

  return {
    focusWindow,
    showWindow,
    hideWindow,
    toggleWindow,
    makeDraggable,
    makeResizable,
    centerWindow,
    clamp,
    get nextZ() {
      return state.nextZ
    },
    set nextZ(v) {
      state.nextZ = v
    }
  }
}
