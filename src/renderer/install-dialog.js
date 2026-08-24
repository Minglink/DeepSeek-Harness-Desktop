// Plugin Install Dialog Renderer Script
let currentPayload = null

const pluginNameEl = document.getElementById('pluginName')
const pluginIdEl = document.getElementById('pluginId')
const pluginVersionEl = document.getElementById('pluginVersion')
const pluginRepoEl = document.getElementById('pluginRepo')
const permissionsListEl = document.getElementById('permissionsList')
const downloadUrlSectionEl = document.getElementById('downloadUrlSection')
const downloadUrlEl = document.getElementById('downloadUrl')

const progressSectionEl = document.getElementById('progressSection')
const progressStatusEl = document.getElementById('progressStatus')
const progressPctEl = document.getElementById('progressPct')
const progressBarFillEl = document.getElementById('progressBarFill')

const confirmBtn = document.getElementById('confirmBtn')
const cancelBtn = document.getElementById('cancelBtn')
const closeHeaderBtn = document.getElementById('closeHeaderBtn')

function renderPayload(payload) {
  currentPayload = payload
  pluginNameEl.textContent = payload.name || payload.id
  pluginIdEl.textContent = payload.id
  pluginVersionEl.textContent = `v${payload.version}`
  pluginRepoEl.textContent = payload.repo

  permissionsListEl.innerHTML = ''
  const perms = payload.permissions && payload.permissions.length > 0
    ? payload.permissions
    : ['常规权限']

  perms.forEach((perm) => {
    const chip = document.createElement('span')
    chip.className = 'perm-chip'
    chip.innerHTML = `🔒 ${perm}`
    permissionsListEl.appendChild(chip)
  })

  if (payload.downloadUrl) {
    downloadUrlSectionEl.style.display = 'flex'
    downloadUrlEl.textContent = payload.downloadUrl
  } else {
    downloadUrlSectionEl.style.display = 'none'
  }
}

// IPC listener from Electron Main
if (window.dshDesktop) {
  window.dshDesktop.getPendingPayload().then((payload) => {
    if (payload) {
      renderPayload(payload)
    }
  })

  window.dshDesktop.onPluginInstallRequest((payload) => {
    renderPayload(payload)
  })

  window.dshDesktop.onInstallProgress((progress) => {
    progressSectionEl.style.display = 'flex'
    progressStatusEl.textContent = progress.message || '正在处理...'

    if (progress.percent !== undefined) {
      progressPctEl.textContent = `${progress.percent}%`
      progressBarFillEl.style.width = `${progress.percent}%`
    } else {
      if (progress.status === 'downloading') {
        progressBarFillEl.style.width = '30%'
      } else if (progress.status === 'installing') {
        progressBarFillEl.style.width = '65%'
      } else if (progress.status === 'reconciling') {
        progressBarFillEl.style.width = '90%'
      } else if (progress.status === 'success') {
        progressBarFillEl.style.width = '100%'
      }
    }

    if (progress.status === 'success') {
      confirmBtn.disabled = false
      confirmBtn.innerHTML = '<span>✅ 安装完成</span>'
      confirmBtn.style.background = '#10b981'
      cancelBtn.textContent = '完成并关闭'
      setTimeout(() => {
        window.dshDesktop.closeDialog()
      }, 1500)
    } else if (progress.status === 'error') {
      confirmBtn.disabled = false
      confirmBtn.innerHTML = '<span>重试安装</span>'
      progressStatusEl.style.color = '#ef4444'
    }
  })
}

// User Actions
confirmBtn.addEventListener('click', async () => {
  if (!currentPayload || !window.dshDesktop) return

  confirmBtn.disabled = true
  cancelBtn.disabled = true
  confirmBtn.innerHTML = '<span>⏳ 正在安装...</span>'
  progressSectionEl.style.display = 'flex'
  progressBarFillEl.style.width = '15%'
  progressStatusEl.textContent = '正在发起安装请求...'

  const result = await window.dshDesktop.confirmInstall(currentPayload)
  if (!result.success) {
    progressStatusEl.textContent = `安装失败: ${result.message}`
    progressStatusEl.style.color = '#ef4444'
    confirmBtn.disabled = false
    cancelBtn.disabled = false
    confirmBtn.innerHTML = '<span>重试安装</span>'
  }
})

cancelBtn.addEventListener('click', () => {
  if (window.dshDesktop) {
    if (currentPayload) {
      window.dshDesktop.cancelInstall(currentPayload.id)
    }
    window.dshDesktop.closeDialog()
  } else {
    window.close() // Fallback to standard window.close
  }
})

closeHeaderBtn.addEventListener('click', () => {
  if (window.dshDesktop) {
    window.dshDesktop.closeDialog()
  } else {
    window.close()
  }
})

if (!window.dshDesktop) {
  pluginNameEl.textContent = "启动失败: Preload 环境未就绪"
  confirmBtn.disabled = true
}
