export function createDisconnectModal({ win }) {
  let modalWinEl = null
  let modalTitleEl = null
  let modalBodyEl = null

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
    title.textContent = "Disconnected"

    const closeBtn = document.createElement("button")
    closeBtn.className = "winclose"
    closeBtn.textContent = "×"
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
    modalBodyEl.style.marginBottom = "12px"

    const okBtn = document.createElement("button")
    okBtn.className = "primary"
    okBtn.textContent = "OK"
    okBtn.onclick = () => win.hideWindow(modalWinEl)

    body.appendChild(modalTitleEl)
    body.appendChild(modalBodyEl)
    body.appendChild(okBtn)

    modalWinEl.appendChild(bar)
    modalWinEl.appendChild(body)

    document.body.appendChild(modalWinEl)

    win.makeDraggable(modalWinEl)
  }

  function center() {
    ensure()
    win.centerWindow(modalWinEl, { force: true })
  }

  function show({ title, body }) {
    ensure()
    modalTitleEl.textContent = title || ""
    modalBodyEl.textContent = body || ""
    center()
    win.showWindow(modalWinEl)
  }

  return {
    show
  }
}
