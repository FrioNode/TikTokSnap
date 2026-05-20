require('dotenv').config()
const { BrevoClient } = require('@getbrevo/brevo')

const api = new BrevoClient({
  apiKey: process.env.BREVO_API_KEY,
  timeoutInSeconds: 30,
  maxRetries: 2
})

const FROM = { name: 'TikTok Snap 🛡️', email: 'tiktoksnap@frionode.online' }

// ── Core send function ───────────────────
async function sendMail({ to, subject, html }) {
  try {
    await api.transactionalEmails.sendTransacEmail({
      sender: FROM,
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
    console.log(`✉️  Mail sent → ${to} | ${subject}`)
  } catch (err) {
    // Never crash the server over a failed email
    console.error(`❌ Mail failed → ${to} | ${err?.message}`)
  }
}

// ── Shared styles ────────────────────────
const base = (content) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:system-ui,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:12px;border:0.5px solid #e0ddd5;overflow:hidden">
    <div style="background:#1a1a18;padding:20px 28px;display:flex;align-items:center;gap:10px">
      <span style="font-size:22px">🎵</span>
      <span style="color:#ffffff;font-weight:500;font-size:16px">TikTokSnap 🛡️</span>
    </div>
    <div style="padding:28px">
      ${content}
    </div>
    <div style="padding:16px 28px;border-top:0.5px solid #e0ddd5;text-align:center">
      <p style="margin:0 0 8px;font-size:12px;color:#9a9994">© 2026 TikTokSnap · tiktoksnap@frionode.online</p>
      <p style="margin:0 0 8px;font-size:12px;color:#9a9994">⚠️ This is an automated system-generated message. Please do not reply to this mailbox.</p>
      <p style="margin:0;font-size:12px;color:#9a9994">Need support? Contact us at <a href="mailto:admin@frionode.online" style="color:#1a1a18;text-decoration:underline">admin@frionode.online</a></p>
    </div>
  </div>
</body>
</html>`

const h2 = (text) => `<h2 style="margin:0 0 8px;font-size:20px;font-weight:500;color:#1a1a18">${text}</h2>`
const p  = (text) => `<p style="margin:0 0 16px;font-size:14px;color:#5a5a56;line-height:1.6">${text}</p>`
const pill = (text, bg = '#E1F5EE', color = '#085041') =>
  `<span style="display:inline-block;background:${bg};color:${color};font-size:12px;font-weight:500;padding:3px 10px;border-radius:20px;margin-bottom:16px">${text}</span>`
const keyBox = (key) =>
  `<div style="background:#f7f7f5;border:0.5px solid #e0ddd5;border-radius:8px;padding:12px 16px;font-family:monospace;font-size:13px;color:#1a1a18;word-break:break-all;margin-bottom:16px">${key}</div>`
const btn = (text, url) =>
  `<a href="${url}" style="display:inline-block;background:#1a1a18;color:#ffffff;font-size:13px;font-weight:500;padding:10px 20px;border-radius:8px;text-decoration:none;margin-bottom:16px">${text}</a>`
const divider = () =>
  `<div style="border-top:0.5px solid #e0ddd5;margin:20px 0"></div>`

// ─────────────────────────────────────────
// 1. Welcome + API key on register
// ─────────────────────────────────────────
async function sendWelcome({ to, name, apiKey }) {
  await sendMail({
    to,
    subject: 'Welcome to TikTokSnap — your API key is ready',
    html: base(`
      ${pill('🎉 Account created')}
      ${h2(`Welcome, ${name || 'there'}!`)}
      ${p('Your account is active and your API key is ready to use. Keep it safe — treat it like a password.')}
      <p style="margin:0 0 8px;font-size:13px;font-weight:500;color:#1a1a18">Your API key:</p>
      ${keyBox(apiKey)}
      ${p('Use it in every request with the header: <code style="background:#f7f7f5;padding:2px 6px;border-radius:4px">x-api-key: YOUR_KEY</code>')}
      ${divider()}
      ${p('You are on the <strong>Free plan</strong> — 30 requests/day. Upgrade anytime from your dashboard.')}
      ${btn('Go to dashboard →', 'https://tiktoksnap.frionode.online/dashboard.html')}
    `)
  })
}

// ─────────────────────────────────────────
// 2. Key rotated
// ─────────────────────────────────────────
async function sendKeyRotated({ to, newKey }) {
  await sendMail({
    to,
    subject: 'Your TikTokSnap API key has been rotated',
    html: base(`
      ${pill('🔑 Key rotated', '#E6F1FB', '#0C447C')}
      ${h2('Your API key was rotated')}
      ${p('Your old key is now invalid. Here is your new key — update it in your app immediately.')}
      <p style="margin:0 0 8px;font-size:13px;font-weight:500;color:#1a1a18">New API key:</p>
      ${keyBox(newKey)}
      ${p('Your usage count is unchanged — rotation does not reset your daily limit.')}
      ${p('If you did not rotate this key, contact us immediately.')}
      ${btn('Go to dashboard →', 'https://tiktoksnap.frionode.online/dashboard.html')}
    `)
  })
}

// ─────────────────────────────────────────
// 3. Password changed
// ─────────────────────────────────────────
async function sendPasswordChanged({ to }) {
  await sendMail({
    to,
    subject: 'Your TikTokSnap password was changed',
    html: base(`
      ${pill('🔒 Password changed', '#FAEEDA', '#633806')}
      ${h2('Password updated successfully')}
      ${p('Your password was just changed. If this was you, no action needed.')}
      ${p('If you did not make this change, reset your password immediately and contact us.')}
      ${btn('Go to dashboard →', 'https://tiktoksnap.frionode.online/dashboard.html')}
    `)
  })
}

// ─────────────────────────────────────────
// 4. Usage warning — 80% of daily limit
// ─────────────────────────────────────────
async function sendUsageWarning({ to, used, limit, plan }) {
  await sendMail({
    to,
    subject: `Heads up — you've used ${used} of ${limit} requests today`,
    html: base(`
      ${pill('⚠️ Usage warning', '#FAEEDA', '#633806')}
      ${h2('You are close to your daily limit')}
      ${p(`You have used <strong>${used} of ${limit}</strong> requests today on the <strong>${plan}</strong> plan.`)}
      ${p('Once you hit the limit, requests will be blocked until midnight (UTC) when the counter resets.')}
      ${divider()}
      ${p('Upgrade your plan to get more requests per day and avoid interruptions.')}
      ${btn('Upgrade plan →', 'https://tiktoksnap.frionode.online/dashboard.html')}
    `)
  })
}

// ─────────────────────────────────────────
// 5. Limit reached
// ─────────────────────────────────────────
async function sendLimitReached({ to, limit, plan }) {
  await sendMail({
    to,
    subject: 'Daily limit reached — upgrade to continue',
    html: base(`
      ${pill('🚫 Limit reached', '#FAECE7', '#712B13')}
      ${h2('You have hit your daily limit')}
      ${p(`Your <strong>${plan}</strong> plan allows <strong>${limit} requests/day</strong>. Your limit resets at midnight UTC.`)}
      ${p('Upgrade to Pro or Business to keep downloading without interruption.')}
      ${btn('Upgrade now →', 'https://tiktoksnap.frionode.online/dashboard.html')}
    `)
  })
}

// ─────────────────────────────────────────
// 6. OTP (for future email verification)
// ─────────────────────────────────────────
async function sendOtp({ to, otp }) {
  await sendMail({
    to,
    subject: `${otp} is your TikTokSnap verification code`,
    html: base(`
      ${pill('✉️ Verify your email', '#EAF3DE', '#27500A')}
      ${h2('Your verification code')}
      ${p('Enter this code to verify your email address. It expires in 10 minutes.')}
      <div style="text-align:center;margin:24px 0">
        <span style="font-size:36px;font-weight:500;letter-spacing:12px;color:#1a1a18">${otp}</span>
      </div>
      ${p('If you did not request this code, ignore this email.')}
    `)
  })
}

module.exports = {
  sendWelcome,
  sendKeyRotated,
  sendPasswordChanged,
  sendUsageWarning,
  sendLimitReached,
  sendOtp
}