import nodemailer from 'nodemailer';

export function maskPassword(cfg) {
  const masked = { ...cfg };
  if (masked.smtp_password) masked.smtp_password = '********';
  return masked;
}

export function nextAttemptDelay(attemptCount, initialSeconds) {
  return Math.min(3600, initialSeconds * Math.pow(2, attemptCount - 1));
}

export async function send(
  { smtp, from, to, cc, subject, text, html },
  _deps = {}
) {
  try {
    const createTransport = _deps.createTransport ?? nodemailer.createTransport;
    const transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: Boolean(smtp.secure),
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined
    });
    await transport.sendMail({ from, to, cc, subject, text, html });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
