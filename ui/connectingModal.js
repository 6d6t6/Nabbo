export function createConnectingModal({ win }) {
  let modalWinEl = null
  let modalTitleEl = null
  let modalBodyEl = null
  let modalDiagEl = null
  let closeBtn = null
  let copyBtn = null

  function ensure() {
    if (modalWinEl) return

    modalWinEl = document.createElement("div")
    modalWinEl.className = "window win-hidden"
    modalWinEl.setAttribute("data-window", "modal")
    modalWinEl.style.width = "420px"
    modalWinEl.style.left = "20px"
    modalWinEl.style.top = "20px"
    modalWinEl.style.transform = ""

    const bar = document.createElement("div")
    bar.className = "titlebar"

    const title = document.createElement("div")
    title.className = "title"
    title.textContent = "Connecting"

    closeBtn = document.createElement("button")
    closeBtn.className = "winclose"
    closeBtn.textContent = "×"
    closeBtn.style.display = "none"
    closeBtn.onclick = () => win.hideWindow(modalWinEl)

    bar.appendChild(title)
    bar.appendChild(closeBtn)

    const body = document.createElement("div")
    body.className = "winbody"
    body.style.padding = "10px"

    modalTitleEl = document.createElement("div")
    modalTitleEl.style.fontWeight = "700"
    modalTitleEl.style.marginBottom = "8px"

    modalBodyEl = document.createElement("div")
    modalBodyEl.style.opacity = "0.9"

    modalDiagEl = document.createElement("pre")
    modalDiagEl.style.marginTop = "10px"
    modalDiagEl.style.padding = "8px"
    modalDiagEl.style.borderRadius = "8px"
    modalDiagEl.style.background = "rgba(255,255,255,0.06)"
    modalDiagEl.style.fontSize = "12px"
    modalDiagEl.style.lineHeight = "1.35"
    modalDiagEl.style.maxHeight = "180px"
    modalDiagEl.style.overflow = "auto"
    modalDiagEl.style.whiteSpace = "pre-wrap"
    modalDiagEl.style.display = "none"

    copyBtn = document.createElement("button")
    copyBtn.className = "primary"
    copyBtn.textContent = "Copy diagnostics"
    copyBtn.style.marginTop = "10px"
    copyBtn.style.display = "none"
    copyBtn.onclick = async () => {
      const text = modalDiagEl?.textContent || ""
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        copyBtn.textContent = "Copied"
        setTimeout(() => {
          if (copyBtn) copyBtn.textContent = "Copy diagnostics"
        }, 900)
      } catch {}
    }

    body.appendChild(modalTitleEl)
    body.appendChild(modalBodyEl)
    body.appendChild(modalDiagEl)
    body.appendChild(copyBtn)

    modalWinEl.appendChild(bar)
    modalWinEl.appendChild(body)

    document.body.appendChild(modalWinEl)

    win.makeDraggable(modalWinEl)
  }

  function center() {
    ensure()
    win.centerWindow(modalWinEl, { force: true })
  }

  function show({ title, body } = {}) {
    ensure()
    modalTitleEl.textContent = title || "Connecting…"
    modalBodyEl.textContent = body || ""
    if (closeBtn) closeBtn.style.display = "none"
    center()
    win.showWindow(modalWinEl)
  }

  function showError({ title, body } = {}) {
    show({ title, body })
    if (closeBtn) closeBtn.style.display = ""
  }

  function setDiagnostics(text) {
    ensure()
    const t = String(text || "")
    modalDiagEl.textContent = t
    const showDiag = Boolean(t)
    modalDiagEl.style.display = showDiag ? "" : "none"
    copyBtn.style.display = showDiag ? "" : "none"
  }

  function hide() {
    if (!modalWinEl) return
    win.hideWindow(modalWinEl)
  }

  return {
    show,
    showError,
    setDiagnostics,
    hide
  }
}
