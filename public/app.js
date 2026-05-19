const state = {
  token: localStorage.getItem('token'),
  apiKey: localStorage.getItem('apiKey')
}

function setTheme(dark) {
  document.documentElement.classList.toggle('dark', dark)
  const icon = document.getElementById('themeIcon')
  const label = document.getElementById('themeLabel')
  if (icon) icon.className = dark ? 'ti ti-sun' : 'ti ti-moon'
  if (label) label.textContent = dark ? 'Light mode' : 'Dark mode'
  localStorage.setItem('darkMode', dark ? '1' : '0')
}

function toggleTheme() {
  setTheme(!document.documentElement.classList.contains('dark'))
}

function initTheme() {
  const stored = localStorage.getItem('darkMode')
  if (stored !== null) {
    setTheme(stored === '1')
  }
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`
  if (state.apiKey) headers['x-api-key'] = state.apiKey
  return headers
}

function setAuth(apiKey, token) {
  state.apiKey = apiKey
  state.token = token
  localStorage.setItem('apiKey', apiKey)
  localStorage.setItem('token', token)
}

function clearAuth() {
  state.apiKey = null
  state.token = null
  localStorage.removeItem('apiKey')
  localStorage.removeItem('token')
}

function showNotice(message, type = 'success') {
  const el = document.getElementById('notice')
  if (!el) return
  el.textContent = message
  el.className = `notice ${type}`
  el.classList.remove('hidden')
}

function hideNotice() {
  const el = document.getElementById('notice')
  if (el) el.classList.add('hidden')
}

function redirectIfAuthenticated() {
  const page = window.location.pathname
  if (!state.token) return
  if (page === '/login.html' || page === '/register.html') {
    location.href = '/dashboard.html'
  }
}

function requireAuthPage() {
  if (!state.token) {
    if (window.location.pathname !== '/login.html' && window.location.pathname !== '/register.html') {
      location.href = '/login.html'
    }
    return false
  }
  return true
}

function logout() {
  clearAuth()
  location.href = '/login.html'
}

async function loginPage() {
  const form = document.getElementById('loginForm')
  if (!form) return
  form.addEventListener('submit', async e => {
    e.preventDefault()
    hideNotice()
    const email = form.email.value.trim()
    const password = form.password.value.trim()
    if (!email || !password) return showNotice('Email and password are required', 'error')

    try {
      const res = await fetch('/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()
      if (!res.ok) return showNotice(data.error || 'Invalid login', 'error')
      setAuth(data.api_key, data.token)
      location.href = '/dashboard.html'
    } catch (err) {
      showNotice('Unable to login. Try again.', 'error')
    }
  })
}

async function registerPage() {
  const form = document.getElementById('registerForm')
  if (!form) return
  form.addEventListener('submit', async e => {
    e.preventDefault()
    hideNotice()
    const email = form.email.value.trim()
    const password = form.password.value.trim()
    const phone = form.phone.value.trim()
    const label = form.label.value.trim()
    if (!email || !password) return showNotice('Email and password are required', 'error')

    try {
      const res = await fetch('/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, phone, label })
      })
      const data = await res.json()
      if (!res.ok) return showNotice(data.error || 'Could not register', 'error')
      setAuth(data.api_key, data.token)
      showNotice('Account created. Redirecting…', 'success')
      setTimeout(() => location.href = '/dashboard.html', 900)
    } catch (err) {
      showNotice('Registration failed. Try again.', 'error')
    }
  })
}

async function loadDashboard() {
  if (!requireAuthPage()) return
  const statusEl = document.getElementById('dashboardStatus')
  const statsEl = document.getElementById('usageStats')
  const profileKey = document.getElementById('apiKeyValue')
  const planValue = document.getElementById('planValue')
  const remainingValue = document.getElementById('remainingValue')
  const usedValue = document.getElementById('usedValue')
  const welcomeName = document.getElementById('welcomeName')
  const jobsList = document.getElementById('jobsList')
  const jobs = new Map()
  let pollInterval = null
  const JOBS_KEY = 'tiktok_jobs'

  async function renderJobs() {
    if (jobs.size === 0) {
      jobsList.innerHTML = '<div style="grid-column:1/-1;color:var(--tx3);font-size:14px;padding:2rem;text-align:center">No downloads yet. Queue a video to get started.</div>'
      return
    }
    jobsList.innerHTML = Array.from(jobs.values()).map(job => `
      <div class="card" style="border-color:var(--bd2)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="flex:1">
            <h3 style="font-size:0.95rem">${job.status === 'completed' ? '✅' : job.status === 'failed' ? '❌' : '⏳'} Job ${job.jobId}</h3>
            <p style="font-size:0.9rem;color:var(--tx3);margin-bottom:6px">${job.status === 'active' ? 'Downloading...' : job.status === 'completed' ? 'Ready to download' : job.status === 'failed' ? 'Failed' : 'Waiting in queue...'}</p>
            ${job.progress !== undefined ? `<div style="width:100%;height:6px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;background:var(--accent);width:${job.progress}%;transition:width .3s"></div></div>` : ''}
          </div>
          ${job.status === 'completed' ? `<a href="${job.downloadUrl}" class="btn-primary" style="white-space:nowrap;text-decoration:none;padding:7px 12px;font-size:12px" download>Download</a>` : ''}
        </div>
      </div>
    `).join('')
  }

  async function pollJobs() {
    for (const [jobId, job] of jobs) {
      try {
        const res = await fetch(`/job/${jobId}`, { headers: authHeaders() })
        const data = await res.json()
        if (res.ok) {
          jobs.set(jobId, { ...job, ...data })
          if (data.status === 'completed' || data.status === 'failed') {
            removePersistedJobId(jobId)
          } else {
            persistJobId(jobId)
          }
        }
      } catch (err) {
        console.error(`Failed to poll job ${jobId}`, err)
      }
    }
    await renderJobs()
  }

  try {
    const res = await fetch('/auth/me', { headers: authHeaders() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not load profile')

    welcomeName.textContent = data.label || data.email
    profileKey.textContent = data.api_key || 'N/A'
    planValue.textContent = data.plan
    remainingValue.textContent = data.remaining_today
    usedValue.textContent = data.used_today
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat"><div class="stat-n">${data.stats?.downloads || 0}</div><div class="stat-l">Downloads</div></div>
        <div class="stat"><div class="stat-n">${data.stats?.requests || 0}</div><div class="stat-l">API calls</div></div>
        <div class="stat"><div class="stat-n">${data.stats?.errors || 0}</div><div class="stat-l">Errors</div></div>
      `
    }
    // Fetch backend health status
    const healthEl = document.getElementById('backendHealth')
    if (healthEl) {
      try {
        const hres = await fetch('/health')
        if (hres.ok) {
          const hj = await hres.json()
          if (hj && hj.status === 'ok') {
            healthEl.classList.remove('health-fail')
            healthEl.classList.add('health-ok')
            healthEl.innerHTML = '<span class="health-dot"></span><span>Backend healthy</span>'
          } else {
            healthEl.classList.remove('health-ok')
            healthEl.classList.add('health-fail')
            healthEl.innerHTML = '<span class="health-dot"></span><span>Backend issue</span>'
          }
        } else {
          healthEl.classList.remove('health-ok')
          healthEl.classList.add('health-fail')
          healthEl.innerHTML = '<span class="health-dot"></span><span>Backend unreachable</span>'
        }
      } catch (err) {
        healthEl.classList.remove('health-ok')
        healthEl.classList.add('health-fail')
        healthEl.innerHTML = '<span class="health-dot"></span><span>Health check failed</span>'
      }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Session expired. Redirecting…'
    setTimeout(() => logout(), 900)
  }

  const downloadForm = document.getElementById('downloadForm')
  if (downloadForm) {
    downloadForm.addEventListener('submit', async e => {
      e.preventDefault()
      hideNotice()
      const url = downloadForm.url.value.trim()
      const quality = downloadForm.quality.value
      if (!url) return showNotice('A TikTok URL is required', 'error')

      try {
        const res = await fetch('/download', {
          method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json', 'x-api-key': state.apiKey },
          body: JSON.stringify({ url, quality })
        })
        const data = await res.json()
        if (!res.ok) return showNotice(data.error || 'Could not queue download', 'error')
        jobs.set(data.jobId, { jobId: data.jobId, status: data.status, progress: 0, downloadUrl: null })
        // persist job id so it survives refresh
        persistJobId(String(data.jobId))
        await renderJobs()
        showNotice(`Queued! Job ID: ${data.jobId}`, 'success')
        downloadForm.url.value = ''
        downloadForm.quality.value = 'best'
      } catch (err) {
        showNotice('Unable to queue download.', 'error')
      }
    })
  }

  // restore persisted job IDs on load
  (function restoreJobs() {
    try {
      const stored = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]')
      if (Array.isArray(stored)) {
        for (const id of stored) {
          if (!jobs.has(String(id))) jobs.set(String(id), { jobId: String(id), status: 'queued', progress: 0 })
        }
      }
    } catch (err) {
      console.error('Failed to restore jobs from storage', err)
    }
  })()

  function persistJobId(id) {
    try {
      const arr = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]')
      const s = new Set(arr.map(String))
      s.add(String(id))
      localStorage.setItem(JOBS_KEY, JSON.stringify(Array.from(s)))
    } catch (err) {
      console.error('Failed to persist job id', err)
    }
  }

  function removePersistedJobId(id) {
    try {
      const arr = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]')
      const filtered = Array.isArray(arr) ? arr.map(String).filter(item => item !== String(id)) : []
      localStorage.setItem(JOBS_KEY, JSON.stringify(filtered))
    } catch (err) {
      console.error('Failed to remove job id', err)
    }
  }

  await renderJobs()
  pollInterval = setInterval(pollJobs, 5000)
  window.addEventListener('beforeunload', () => clearInterval(pollInterval))
}


async function loadSettings() {
  if (!requireAuthPage()) return
  const profileForm = document.getElementById('profileForm')
  const passwordForm = document.getElementById('passwordForm')
  const rotateKeyBtn = document.getElementById('rotateKeyBtn')
  const currentApiKey = document.getElementById('currentApiKey')

  try {
    const res = await fetch('/auth/me', { headers: authHeaders() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not load profile')
    document.getElementById('profileEmail').textContent = data.email
    document.getElementById('phone').value = data.phone || ''
    document.getElementById('label').value = data.label || ''
    currentApiKey.textContent = data.api_key || 'No key'
  } catch (err) {
    logout()
  }

  if (rotateKeyBtn) {
    rotateKeyBtn.addEventListener('click', async () => {
      hideNotice()
      if (!confirm('Rotate your API key? The old key will become invalid immediately.')) return
      try {
        const res = await fetch('/auth/rotate-key', {
          method: 'POST', headers: authHeaders()
        })
        const data = await res.json()
        if (!res.ok) return showNotice(data.error || 'Could not rotate key', 'error')
        currentApiKey.textContent = data.api_key
        setAuth(data.api_key, state.token)
        showNotice('API key rotated successfully', 'success')
      } catch (err) {
        showNotice('Unable to rotate key.', 'error')
      }
    })
  }

  if (profileForm) {
    profileForm.addEventListener('submit', async e => {
      e.preventDefault(); hideNotice()
      const phone = profileForm.phone.value.trim()
      const label = profileForm.label.value.trim()
      const res = await fetch('/auth/update-profile', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ phone, label })
      })
      const data = await res.json()
      if (!res.ok) return showNotice(data.error || 'Could not update profile', 'error')
      showNotice('Profile updated successfully', 'success')
    })
  }

  if (passwordForm) {
    passwordForm.addEventListener('submit', async e => {
      e.preventDefault(); hideNotice()
      const current_password = passwordForm.current_password.value.trim()
      const new_password = passwordForm.new_password.value.trim()
      if (!current_password || !new_password) return showNotice('Fill both password fields', 'error')
      const res = await fetch('/auth/change-password', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ current_password, new_password })
      })
      const data = await res.json()
      if (!res.ok) return showNotice(data.error || 'Could not change password', 'error')
      showNotice('Password changed successfully', 'success')
      passwordForm.reset()
    })
  }
}

function initNav() {
  const navAuth = document.querySelectorAll('.auth-only')
  const navGuest = document.querySelectorAll('.guest-only')
  navAuth.forEach(el => el.classList.toggle('hidden', !state.token))
  navGuest.forEach(el => el.classList.toggle('hidden', !!state.token))
}

window.addEventListener('DOMContentLoaded', () => {
  initTheme()
  initNav()
  const page = window.location.pathname

  if (page === '/login.html') {
    redirectIfAuthenticated()
    loginPage()
  } else if (page === '/register.html') {
    redirectIfAuthenticated()
    registerPage()
  } else if (page === '/dashboard.html') {
    loadDashboard()
  } else if (page === '/settings.html') {
    loadSettings()
  }

  const logoutBtn = document.getElementById('logoutBtn')
  if (logoutBtn) logoutBtn.addEventListener('click', () => logout())
})
