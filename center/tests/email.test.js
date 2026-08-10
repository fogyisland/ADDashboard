import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPassword, nextAttemptDelay, send } from '../src/services/email.js';

test('maskPassword replaces a non-empty SMTP password', () => {
  const masked = maskPassword({ smtp_host: 'smtp.example.com', smtp_password: 'secret' });

  assert.equal(masked.smtp_password, '********');
});

test('maskPassword leaves an empty SMTP password empty', () => {
  const masked = maskPassword({ smtp_host: 'smtp.example.com', smtp_password: '' });

  assert.equal(masked.smtp_password, '');
});

test('maskPassword returns a shallow copy without mutating its input', () => {
  const input = { smtp_host: 'smtp.example.com', smtp_password: 'secret' };

  const masked = maskPassword(input);

  assert.notStrictEqual(masked, input);
  assert.equal(input.smtp_password, 'secret');
});

test('nextAttemptDelay doubles from the initial delay', () => {
  assert.equal(nextAttemptDelay(1, 30), 30);
  assert.equal(nextAttemptDelay(2, 30), 60);
  assert.equal(nextAttemptDelay(3, 30), 120);
});

test('nextAttemptDelay caps the delay at 3600 seconds', () => {
  assert.equal(nextAttemptDelay(20, 30), 3600);
});

test('send creates the requested SMTP transport and sends the message', async () => {
  const calls = { transport: [], mail: [] };
  const sendMail = async (message) => {
    calls.mail.push(message);
    return { messageId: 'message-1' };
  };
  const createTransport = (options) => {
    calls.transport.push(options);
    return { sendMail };
  };

  const result = await send({
    smtp: {
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_secure: false,
      smtp_user: 'smtp-user',
      smtp_password: 'smtp-password'
    },
    from: 'sender@example.com',
    to: 'recipient@example.com',
    cc: 'copy@example.com',
    subject: 'Test message',
    text: 'Plain text',
    html: '<p>HTML</p>'
  }, { createTransport });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.transport, [{
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    auth: { user: 'smtp-user', pass: 'smtp-password' }
  }]);
  assert.deepEqual(calls.mail, [{
    from: 'sender@example.com',
    to: 'recipient@example.com',
    cc: 'copy@example.com',
    subject: 'Test message',
    text: 'Plain text',
    html: '<p>HTML</p>'
  }]);
});
