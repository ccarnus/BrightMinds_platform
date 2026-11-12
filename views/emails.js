// Account emails. Each builder returns { subject, html, text }: the HTML is table based with inline
// styles (what mail clients render reliably), and the text part is for clients that do not show HTML.
const config = require('../config');
const { MEDIA_DIRS, mediaUrl } = require('../services/media');
const { escapeHtml } = require('./escape');

const COLORS = {
  brand: '#00407A',
  action: '#2E8B57',
  page: '#F2F5F9',
  card: '#FFFFFF',
  text: '#1F2937',
  muted: '#6B7280',
  border: '#E5E7EB',
};
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const hours = (ms) => Math.round(ms / 3600000);
const describeDuration = (ms) => {
  const h = hours(ms);
  if (h >= 48 && h % 24 === 0) return `${h / 24} days`;
  return h === 1 ? '1 hour' : `${h} hours`;
};

const firstName = (username) => {
  const name = String(username || '')
    .trim()
    .split(/\s+/)[0];
  return name || 'there';
};

const render = ({ preheader, heading, paragraphs, button, note, fallbackUrl }) => {
  const logo = mediaUrl(MEDIA_DIRS.emailAssets, 'BrightMinds_title.png');
  const paragraphHtml = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${COLORS.text};">${p}</p>`
    )
    .join('');
  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:10px;background:${COLORS.action};"><a href="${escapeHtml(button.href)}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;font-family:${FONT};">${escapeHtml(button.label)}</a></td></tr></table>`
    : '';
  const fallbackHtml = fallbackUrl
    ? `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${COLORS.muted};">Button not working? Copy this link into your browser:<br><a href="${escapeHtml(fallbackUrl)}" style="color:${COLORS.brand};word-break:break-all;">${escapeHtml(fallbackUrl)}</a></p>`
    : '';
  const noteHtml = note
    ? `<p style="margin:0;padding-top:16px;border-top:1px solid ${COLORS.border};font-size:13px;line-height:20px;color:${COLORS.muted};">${note}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${COLORS.card};border-radius:16px;overflow:hidden;">
<tr><td align="center" bgcolor="${COLORS.brand}" style="background:${COLORS.brand};padding:28px 24px;">
<img src="${escapeHtml(logo)}" width="180" alt="BrightMinds Research" style="display:block;max-width:180px;height:auto;border:0;font-size:20px;font-weight:700;color:#FFFFFF;font-family:${FONT};">
</td></tr>
<tr><td style="padding:32px 28px 28px;font-family:${FONT};">
<h1 style="margin:0 0 20px;font-size:24px;line-height:30px;color:${COLORS.brand};">${escapeHtml(heading)}</h1>
${paragraphHtml}
${buttonHtml}
${fallbackHtml}
${noteHtml}
</td></tr>
</table>
<p style="max-width:560px;margin:16px 0 0;font-size:12px;line-height:18px;color:${COLORS.muted};text-align:center;font-family:${FONT};">BrightMinds Research &middot; Share your research, grow your knowledge.<br>This is an automatic message, please do not reply to it.</p>
</td></tr>
</table>
</body>
</html>`;
};

const verificationEmail = ({ username, token }) => {
  const url = `${config.publicUrl}/user/confirmation/${token}`;
  const validity = describeDuration(config.account.verificationTtlMs);
  const name = firstName(username);
  return {
    subject: 'Confirm your email - BrightMinds Research',
    html: render({
      preheader: 'One tap to confirm your email. You can already use the app.',
      heading: `Welcome to BrightMinds, ${name}!`,
      paragraphs: [
        'Thanks for joining. Please confirm that this email address is yours.',
        '<strong>You can already use BrightMinds right now</strong>: confirming only secures your account and lets you recover your password.',
      ],
      button: { href: url, label: 'Confirm my email' },
      fallbackUrl: url,
      note: `This link is valid for ${validity}. If you did not create a BrightMinds account, you can safely ignore this email.`,
    }),
    text: [
      `Welcome to BrightMinds, ${name}!`,
      '',
      'Please confirm that this email address is yours:',
      url,
      '',
      'You can already use BrightMinds right now: confirming only secures your account and lets you recover your password.',
      `This link is valid for ${validity}. If you did not create a BrightMinds account, ignore this email.`,
    ].join('\n'),
  };
};

const passwordResetEmail = ({ username, token }) => {
  const url = `${config.publicUrl}/user/reset-password/${token}`;
  const validity = describeDuration(config.account.resetTtlMs);
  const name = firstName(username);
  return {
    subject: 'Reset your password - BrightMinds Research',
    html: render({
      preheader: `Choose a new password. The link is valid for ${validity}.`,
      heading: 'Reset your password',
      paragraphs: [
        `Hi ${escapeHtml(name)},`,
        'We received a request to reset the password of your BrightMinds account. Tap the button to choose a new one.',
      ],
      button: { href: url, label: 'Choose a new password' },
      fallbackUrl: url,
      note: `This link is valid for ${validity} and can be used once. If you did not ask for it, ignore this email: your password stays the same.`,
    }),
    text: [
      `Hi ${name},`,
      '',
      'We received a request to reset the password of your BrightMinds account. Choose a new one here:',
      url,
      '',
      `This link is valid for ${validity} and can be used once. If you did not ask for it, ignore this email: your password stays the same.`,
    ].join('\n'),
  };
};

const passwordChangedEmail = ({ username }) => {
  const name = firstName(username);
  return {
    subject: 'Your password was changed - BrightMinds Research',
    html: render({
      preheader: 'Your BrightMinds password was just changed.',
      heading: 'Your password was changed',
      paragraphs: [
        `Hi ${escapeHtml(name)},`,
        'The password of your BrightMinds account was just changed. You can now log in with the new one.',
      ],
      note: 'If this was not you, reset your password again from the login screen ("Forgot password?") right away.',
    }),
    text: [
      `Hi ${name},`,
      '',
      'The password of your BrightMinds account was just changed.',
      'If this was not you, reset your password again from the login screen ("Forgot password?") right away.',
    ].join('\n'),
  };
};

module.exports = { verificationEmail, passwordResetEmail, passwordChangedEmail, COLORS };
