const state = {
  token: localStorage.getItem('token'),
  apiKey: localStorage.getItem('apiKey')
}

const JOBS_KEY = 'tiktok_jobs'
const JOB_EXPIRY_MINUTES = 10 // Synced from backend /queue/config

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
  const otpStep = document.getElementById('otpStep')
  const otpForm = document.getElementById('otpForm')
  const resendBtn = document.getElementById('resendOtp')
  if (!form) return

  let pendingEmail = ''

  // Step 1 — submit registration, get OTP sent
  form.addEventListener('submit', async e => {
    e.preventDefault()
    hideNotice()
    const email = form.email.value.trim()
    const password = form.password.value.trim()
    const phone = form.phone.value.trim()
    const label = form.label.value.trim()
    if (!email || !password) return showNotice('Email and password are required', 'error')

    const btn = form.querySelector('button[type=submit]')
    btn.disabled = true
    btn.textContent = 'Sending OTP…'

    try {
      const res = await fetch('/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, phone, label })
      })
      const data = await res.json()
      if (!res.ok) {
        btn.disabled = false
        btn.textContent = 'Create account'
        return showNotice(data.error || 'Could not register', 'error')
      }
      pendingEmail = email
      form.classList.add('hidden')
      otpStep.classList.remove('hidden')
      showNotice(`We sent a 6-digit code to ${email}`, 'success')
    } catch (err) {
      btn.disabled = false
      btn.textContent = 'Create account'
      showNotice('Registration failed. Try again.', 'error')
    }
  })

  // Step 2 — verify OTP
  if (otpForm) {
    otpForm.addEventListener('submit', async e => {
      e.preventDefault()
      hideNotice()
      const otp = otpForm.otp.value.trim()
      if (!otp || otp.length !== 6) return showNotice('Enter the 6-digit code from your email', 'error')

      const btn = otpForm.querySelector('button[type=submit]')
      btn.disabled = true
      btn.textContent = 'Verifying…'

      try {
        const res = await fetch('/auth/verify-email', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingEmail, otp })
        })
        const data = await res.json()
        if (!res.ok) {
          btn.disabled = false
          btn.textContent = 'Verify'
          if (res.status === 410) {
            otpStep.classList.add('hidden')
            form.classList.remove('hidden')
            form.querySelector('button[type=submit]').disabled = false
            form.querySelector('button[type=submit]').textContent = 'Create account'
            return showNotice('Code expired — please register again', 'error')
          }
          return showNotice(data.error || 'Invalid code', 'error')
        }
        setAuth(data.api_key, data.token)
        showNotice('Account created. Redirecting…', 'success')
        setTimeout(() => location.href = '/dashboard.html', 900)
      } catch (err) {
        btn.disabled = false
        btn.textContent = 'Verify'
        showNotice('Verification failed. Try again.', 'error')
      }
    })
  }

  // Resend OTP
  if (resendBtn) {
    resendBtn.addEventListener('click', async () => {
      hideNotice()
      resendBtn.disabled = true
      resendBtn.textContent = 'Sending…'
      try {
        const formData = {
          email: form.email.value.trim(),
          password: form.password.value.trim(),
          phone: form.phone.value.trim(),
          label: form.label.value.trim()
        }
        const res = await fetch('/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        })
        const data = await res.json()
        if (!res.ok) return showNotice(data.error || 'Could not resend', 'error')
        showNotice('New code sent — check your email', 'success')
        if (otpForm) otpForm.otp.value = ''
      } catch (err) {
        showNotice('Could not resend. Try again.', 'error')
      } finally {
        setTimeout(() => {
          resendBtn.disabled = false
          resendBtn.textContent = 'Resend code'
        }, 5000)
      }
    })
  }
}

async function forgotPasswordPage() {
  const form = document.getElementById('forgotPasswordForm')
  if (!form) return
  
  form.addEventListener('submit', async e => {
    e.preventDefault()
    hideNotice()
    const email = form.email.value.trim()
    if (!email) return showNotice('Email is required', 'error')
    
    const btn = form.querySelector('button[type=submit]')
    btn.disabled = true
    btn.textContent = 'Sending...'
    
    try {
      const res = await fetch('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      const data = await res.json()
      btn.disabled = false
      btn.textContent = 'Send reset link'
      
      if (!res.ok) return showNotice(data.error || 'Something went wrong', 'error')
      
      showNotice('If that email is registered, a reset link has been sent', 'success')
      form.reset()
      
      setTimeout(() => location.href = '/login.html', 3000)
    } catch (err) {
      btn.disabled = false
      btn.textContent = 'Send reset link'
      showNotice('Unable to send reset link. Try again.', 'error')
    }
  })
}

async function setNewPasswordPage() {
  const urlParams = new URLSearchParams(window.location.search)
  const token = urlParams.get('token')
  
  if (!token) {
    showNotice('Invalid reset link. Please request a new one.', 'error')
    setTimeout(() => location.href = '/login.html', 2000)
    return
  }
  
  const form = document.getElementById('setPasswordForm')
  if (!form) return
  
  form.addEventListener('submit', async e => {
    e.preventDefault()
    hideNotice()
    
    const new_password = form.new_password.value.trim()
    const confirm_password = form.confirm_password.value.trim()
    
    if (!new_password || !confirm_password) {
      return showNotice('Both password fields are required', 'error')
    }
    
    if (new_password.length < 8) {
      return showNotice('Password must be at least 8 characters', 'error')
    }
    
    if (new_password !== confirm_password) {
      return showNotice('Passwords do not match', 'error')
    }
    
    const btn = form.querySelector('button[type=submit]')
    btn.disabled = true
    btn.textContent = 'Resetting password...'
    
    try {
      const res = await fetch('/auth/set-new-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password })
      })
      
      const data = await res.json()
      
      if (!res.ok) {
        btn.disabled = false
        btn.textContent = 'Reset password'
        return showNotice(data.error || 'Failed to reset password', 'error')
      }
      
      showNotice('Password reset successfully! Redirecting to login...', 'success')
      setTimeout(() => location.href = '/login.html', 2000)
    } catch (err) {
      btn.disabled = false
      btn.textContent = 'Reset password'
      showNotice('Unable to reset password. Try again.', 'error')
    }
  })
}

// ─────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────
async function loadDashboard() {
  if (!requireAuthPage()) return
  const statusEl = document.getElementById('dashboardStatus')
  const statsEl = document.getElementById('usageStats')
  const profileKey = document.getElementById('apiKeyValue')
  const planValue = document.getElementById('planValue')
  const remainingValue = document.getElementById('remainingValue')
  const usedValue = document.getElementById('usedValue')
  const recentTableBody = document.getElementById('recentTableBody')
  const welcomeName = document.getElementById('welcomeName')
  const jobsList = document.getElementById('jobsList')
  const jobs = new Map()
  let pollInterval = null
  let jobExpiryMs = JOB_EXPIRY_MINUTES * 60 * 1000 // Will be updated from backend

  // Fetch queue config to get job expiry minutes
  async function fetchQueueConfig() {
    try {
      const res = await fetch('/queue/config')
      if (res.ok) {
        const config = await res.json()
        jobExpiryMs = config.jobExpiryMinutes * 60 * 1000
      }
    } catch (err) {
      console.warn('Could not fetch queue config, using default 10 minutes')
    }
  }

  async function renderJobs() {
    if (jobs.size === 0) {
      jobsList.innerHTML = '<div style="grid-column:1/-1;color:var(--tx3);font-size:14px;padding:2rem;text-align:center">No downloads yet. Queue a video to get started.</div>'
      return
    }
    
    jobsList.innerHTML = Array.from(jobs.values()).map(job => `
      <div class="card job-card" data-job-id="${job.jobId}" style="border-color:var(--bd2)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="flex:1">
            <h3 style="font-size:0.95rem">${job.status === 'completed' ? '✅' : job.status === 'failed' ? '❌' : '⏳'} Job ${job.jobId}</h3>
            <p style="font-size:0.9rem;color:var(--tx3);margin-bottom:6px">${job.status === 'active' ? 'Downloading...' : job.status === 'completed' ? 'Ready to download' : job.status === 'failed' ? 'Failed' : 'Waiting in queue...'}</p>
            ${job.progress !== undefined ? `<div style="width:100%;height:6px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;background:var(--accent);width:${job.progress}%;transition:width .3s"></div></div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            ${job.status === 'completed' ? `<button class="btn-download" data-job-id="${job.jobId}" data-download-url="${job.downloadUrl}" style="background:#3b82f6;color:white;padding:7px 14px;border-radius:12px;border:none;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer">Download</button>` : ''}
            <button class="btn-close-job" data-job-id="${job.jobId}" style="background:var(--bg2);color:var(--tx2);padding:7px 14px;border-radius:12px;border:none;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer">Close</button>
          </div>
        </div>
      </div>
    `).join('')
    
    // Download button listeners
    document.querySelectorAll('.btn-download').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const jobId = btn.dataset.jobId
        const downloadUrl = btn.dataset.downloadUrl
        try {
          const a = document.createElement('a')
          a.href = downloadUrl
          a.download = `tiktok_${jobId}.mp4`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          
          // Remove job after download
          jobs.delete(jobId)
          removePersistedJobId(jobId)
          await renderJobs()
          showNotice('Download started!', 'success')
        } catch (err) {
          console.error('Download failed:', err)
          showNotice('Download failed', 'error')
        }
      })
    })

    // Close button listeners (new)
    document.querySelectorAll('.btn-close-job').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const jobId = btn.dataset.jobId
        jobs.delete(jobId)
        removePersistedJobId(jobId)
        await renderJobs()
        showNotice(`Job ${jobId} removed`, 'info')
      })
    })
  }

  async function pollJobs() {
    if (jobs.size === 0) return
    const now = Date.now()
    
    for (const [jobId, job] of jobs) {
      // Auto-remove jobs older than jobExpiryMs
      if (job.createdAt && (now - job.createdAt) > jobExpiryMs) {
        console.log(`🗑️ Auto-removing expired job ${jobId}`)
        jobs.delete(jobId)
        removePersistedJobId(jobId)
        continue
      }

      try {
        const res = await fetch(`/job/${jobId}`, { headers: authHeaders() })
        const data = await res.json()
        if (res.ok) {
          jobs.set(jobId, { ...job, ...data })
        } else if (res.status === 404) {
          // Job expired on backend
          console.log(`Backend returned 404 for job ${jobId}`)
          jobs.delete(jobId)
          removePersistedJobId(jobId)
          showNotice(`Job ${jobId} has expired`, 'info')
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
        <div class="stat"><div class="stat-n">${data.stats?.total_requests || 0}</div><div class="stat-l">API calls</div></div>
        <div class="stat"><div class="stat-n">${data.stats?.errors || 0}</div><div class="stat-l">Errors</div></div>
      `
    }

    if (recentTableBody) {
      const rows = (data.stats?.recent || []).map(item => {
        const when = new Date(item.created_at).toLocaleString()
        return `
          <tr>
            <td>${when}</td>
            <td>${item.endpoint}</td>
            <td>${item.status}</td>
            <td style="min-width:260px;max-width:420px;white-space:pre-wrap;word-break:break-word;">${item.url || ''}</td>
            <td>${item.job_id || '-'}</td>
            <td>${item.ip || '-'}</td>
          </tr>
        `
      })
      recentTableBody.innerHTML = rows.length > 0 ? rows.join('') : '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:var(--tx3)">No recent activity yet.</td></tr>'
    }

    // Backend health check
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
        jobs.set(data.jobId, { 
          jobId: data.jobId, 
          status: data.status, 
          progress: 0, 
          downloadUrl: null,
          createdAt: Date.now() // ← Track creation time
        })
        persistJobId(String(data.jobId), Date.now()) // ← Persist with timestamp
        await renderJobs()
        showNotice(`Queued! Job ID: ${data.jobId}`, 'success')
        downloadForm.url.value = ''
        downloadForm.quality.value = 'best'
      } catch (err) {
        showNotice('Unable to queue download.', 'error')
      }
    })
  }

  // Restore persisted jobs with timestamps
  (async function restoreJobs() {
    try {
      const stored = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]')
      if (Array.isArray(stored) && stored.length > 0) {
        for (const item of stored) {
          // Support both old format (string) and new format (object)
          const jobId = typeof item === 'string' ? item : item.id
          const createdAt = typeof item === 'string' ? Date.now() : (item.createdAt || Date.now())

          try {
            const res = await fetch(`/job/${jobId}`, { headers: authHeaders() })
            const data = await res.json()
            if (res.ok) {
              jobs.set(String(jobId), { jobId: String(jobId), ...data, createdAt })
            } else if (res.status === 404) {
              removePersistedJobId(jobId)
            } else {
              jobs.set(String(jobId), { jobId: String(jobId), status: 'queued', progress: 0, createdAt })
            }
          } catch (err) {
            jobs.set(String(jobId), { jobId: String(jobId), status: 'queued', progress: 0, createdAt })
          }
        }
      }
    } catch (err) {
      console.error('Failed to restore jobs from storage', err)
    }
    await renderJobs()
  })()

  function persistJobId(id, createdAt = Date.now()) {
    try {
      const arr = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]')
      const s = new Set(arr.map(item => typeof item === 'string' ? item : item.id))
      s.delete(String(id))
      s.add(String(id))
      
      const newArr = Array.from(s).map(jobId => ({
        id: jobId,
        createdAt: jobId === String(id) ? createdAt : Date.now()
      }))
      localStorage.setItem(JOBS_KEY, JSON.stringify(newArr))
    } catch (err) {
      console.error('Failed to persist job id', err)
    }
  }

  function removePersistedJobId(id) {
    try {
      const arr = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]')
      const filtered = arr.filter(item => {
        const jobId = typeof item === 'string' ? item : item.id
        return jobId !== String(id)
      })
      localStorage.setItem(JOBS_KEY, JSON.stringify(filtered))
    } catch (err) {
      console.error('Failed to remove job id', err)
    }
  }

  // Fetch config, render, and start polling
  await fetchQueueConfig()
  await renderJobs()
  pollInterval = setInterval(pollJobs, 2000)
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
  } else if (page === '/forgot-password.html') {
    forgotPasswordPage()
  } else if (page === '/set-new-password.html') {
    setNewPasswordPage()
  }

  const logoutBtn = document.getElementById('logoutBtn')
  if (logoutBtn) logoutBtn.addEventListener('click', () => logout())
})