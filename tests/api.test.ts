/**
 * Smoke tests for the BookNest API.
 *
 * Runs against a real server + real SQLite database. To keep it isolated it
 * boots the server on a throwaway port with its own DB file, so your
 * development data is never touched.
 *
 *   npm test
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsx');

let PORT = 0;
let BASE = '';
let server: ChildProcess;
let workDir: string;
let token = '';

/** Ask the OS for a free port so parallel/repeat runs never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function api(
  endpoint: string,
  options: RequestInit & { auth?: boolean } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  // Multipart bodies must keep the boundary the runtime generates.
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE}${endpoint}`, { ...options, headers });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function waitForPort(port: number, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Server did not start on port ${port}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;

  // Isolate the database so tests never touch ./bookhaven.db
  workDir = mkdtempSync(path.join(tmpdir(), 'booknest-test-'));
  const dbPath = path.join(workDir, 'bookhaven.db');

  // detached + killing the process group guarantees the tsx/node child dies
  // too, instead of leaking a server that breaks the next run.
  server = spawn(TSX_BIN, [path.join(ROOT, 'server.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-for-smoke-tests',
      // Point the server at a throwaway database so ./bookhaven.db is untouched.
      DB_PATH: dbPath,
    },
    detached: true,
    stdio: 'ignore',
  });

  await waitForPort(PORT);
});

after(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      server.kill('SIGKILL');
    }
  }
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('auth', () => {
  test('rejects registration with invalid fields', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ username: 'ab', email: 'a@b.co', password: 'password123' }, /Username/],
      [{ username: 'validuser', email: 'not-an-email', password: 'password123' }, /email/],
      [{ username: 'validuser', email: 'a@b.co', password: 'short' }, /8 characters/],
      [{ username: 'validuser', email: 'not-an-email', password: 'x' }, /email/],
    ];

    for (const [payload, expected] of cases) {
      const { status, body } = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload),
        auth: false,
      });
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.match(body.error, expected);
    }
  });

  test('registers, rejects duplicates, and logs in', async () => {
    const payload = {
      username: 'smoketester',
      email: 'smoke@test.co',
      password: 'Test1234!',
    };

    const created = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false,
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.token, 'register should return a token');
    token = created.body.token;

    const duplicate = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
      auth: false,
    });
    assert.equal(duplicate.status, 409);

    const badLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: payload.email, password: 'wrong-password' }),
      auth: false,
    });
    assert.equal(badLogin.status, 401);
    assert.match(badLogin.body.error, /Incorrect email or password/);

    const unknownUser = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@test.co', password: 'Test1234!' }),
      auth: false,
    });
    assert.equal(unknownUser.status, 401);
    assert.equal(
      unknownUser.body.error,
      badLogin.body.error,
      'login errors must not reveal whether an account exists'
    );

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: payload.email, password: payload.password }),
      auth: false,
    });
    assert.equal(login.status, 200);
    token = login.body.token;
  });

  test('issues tokens that expire', async () => {
    const { body } = await api('/api/auth/me');
    assert.equal(body.username, 'smoketester');

    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.ok(claims.exp, 'token must carry an exp claim');
    assert.ok(claims.exp > claims.iat, 'token must expire in the future');
  });

  test('rejects missing and malformed tokens', async () => {
    const saved = token;
    token = '';
    assert.equal((await api('/api/library')).status, 401);
    token = 'not-a-real-token';
    assert.equal((await api('/api/library')).status, 401);
    token = saved;
  });
});

describe('library', () => {
  test('adds a book and refuses duplicates', async () => {
    const payload = {
      title: 'Dune',
      author: 'Frank Herbert',
      open_library_id: 'goodreads-dune-test',
      status: 'want_to_read',
    };
    const added = await api('/api/library', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(added.status, 200);

    const duplicate = await api('/api/library', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.error, /Already in library/);

    const list = await api('/api/library');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    assert.equal(list.body.length, 1);
  });

  test('partial update preserves rating, notes and mood', async () => {
    const [book] = (await api('/api/library')).body;

    const seeded = await api(`/api/library/${book.id}`, {
      method: 'PUT',
      body: JSON.stringify({ rating: 5, notes: 'great', mood: '😍' }),
    });
    assert.equal(seeded.status, 200);

    // The regression this guards: changing status used to NULL the other columns.
    const statusOnly = await api(`/api/library/${book.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(statusOnly.status, 200);

    const [updated] = (await api('/api/library')).body;
    assert.equal(updated.status, 'completed');
    assert.equal(updated.rating, 5, 'rating must survive a status-only update');
    assert.equal(updated.notes, 'great', 'notes must survive a status-only update');
    assert.equal(updated.mood, '😍', 'mood must survive a status-only update');
  });

  test('validates rating range and rejects unknown ids', async () => {
    const [book] = (await api('/api/library')).body;

    const bad = await api(`/api/library/${book.id}`, {
      method: 'PUT',
      body: JSON.stringify({ rating: 99 }),
    });
    assert.equal(bad.status, 400);

    const missing = await api('/api/library/999999', {
      method: 'PUT',
      body: JSON.stringify({ status: 'reading' }),
    });
    assert.equal(missing.status, 404);
  });
});

describe('profile', () => {
  test('partial update preserves name, gender and birthday', async () => {
    const seeded = await api('/api/auth/me', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Ada', gender: 'female', birthday: '1990-01-01' }),
    });
    assert.equal(seeded.status, 200);
    assert.equal(seeded.body.user.name, 'Ada');

    const renamed = await api('/api/auth/me', {
      method: 'PUT',
      body: JSON.stringify({ username: 'smoketester2', email: 'smoke@test.co' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.user.name, 'Ada', 'name must not be wiped by a rename');
    assert.equal(renamed.body.user.gender, 'female');
    assert.equal(renamed.body.user.birthday, '1990-01-01');
  });

  test('rejects weak passwords and duplicate usernames', async () => {
    const weak = await api('/api/auth/me', {
      method: 'PUT',
      body: JSON.stringify({ username: 'smoketester2', email: 'smoke@test.co', password: 'abc' }),
    });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /8 characters/);

    const conflict = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'anothersmoke',
        email: 'smoke@test.co',
        password: 'Test1234!',
      }),
      auth: false,
    });
    assert.equal(conflict.status, 409);
  });
});

describe('mood + analytics', () => {
  test('logged moods appear in analytics', async () => {
    for (const mood of ['😊', '😊', '😢']) {
      const logged = await api('/api/preferences/mood', {
        method: 'POST',
        body: JSON.stringify({ mood }),
      });
      assert.equal(logged.status, 200);
    }

    const { body } = await api('/api/analytics');
    const happy = body.moodCounts.find((m: any) => m.mood === '😊');
    const sad = body.moodCounts.find((m: any) => m.mood === '😢');
    assert.equal(happy?.count, 2, 'mood logs must be counted');
    assert.equal(sad?.count, 1);

    const statusCounts = body.statusCounts.find((s: any) => s.status === 'completed');
    assert.equal(statusCounts?.count, 1);
  });

  test('rejects an empty mood', async () => {
    const { status, body } = await api('/api/preferences/mood', {
      method: 'POST',
      body: JSON.stringify({ mood: '   ' }),
    });
    assert.equal(status, 400);
    assert.match(body.error, /mood/i);
  });
});

describe('reading sessions', () => {
  test('records a session and surfaces it in monthly analytics', async () => {
    const started = await api('/api/reading/session/start', {
      method: 'POST',
      body: JSON.stringify({ book_id: 1, mood_before: '😊' }),
    });
    assert.equal(started.status, 200);
    const sessionId = started.body.session_id;
    assert.ok(sessionId);

    const ended = await api('/api/reading/session/end', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, pages_read: 42, mood_after: '😍' }),
    });
    assert.equal(ended.status, 200);

    const again = await api('/api/reading/session/end', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    });
    assert.equal(again.status, 400, 'a session cannot be ended twice');
    assert.match(again.body.error, /already ended/i);

    const year = new Date().getFullYear();
    const monthly = await api(`/api/reading/monthly-books?year=${year}`);
    assert.equal(monthly.status, 200);
    assert.equal(monthly.body.monthlyData.length, 12);
    assert.ok(
      monthly.body.summary.totalReadingSessions >= 1,
      'session count must reach monthly analytics'
    );

    const withSession = monthly.body.monthlyData.find((m: any) => m.reading_sessions > 0);
    assert.ok(withSession, 'the month with the session must report it');
    assert.ok(withSession.reading_days >= 1);
  });

  test('refuses sessions for books the user does not own', async () => {
    const { status, body } = await api('/api/reading/session/start', {
      method: 'POST',
      body: JSON.stringify({ uploaded_book_id: 999999 }),
    });
    assert.equal(status, 404);
    assert.match(body.error, /not found/i);
  });

  test('can tag a running session with a mood picked after opening', async () => {
    const started = await api('/api/reading/session/start', {
      method: 'POST',
      body: JSON.stringify({ book_id: 1 }),
    });
    const sessionId = started.body.session_id;

    const tagged = await api(`/api/reading/session/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mood_before: '🤯' }),
    });
    assert.equal(tagged.status, 200);

    await api('/api/reading/session/end', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    });

    // A closed session must no longer accept updates.
    const afterEnd = await api(`/api/reading/session/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ mood_before: '😊' }),
    });
    assert.equal(afterEnd.status, 400);

    const missing = await api('/api/reading/session/424242', {
      method: 'PATCH',
      body: JSON.stringify({ mood_before: '😊' }),
    });
    assert.equal(missing.status, 404);
  });

  test('requires a book to start a session', async () => {
    const { status } = await api('/api/reading/session/start', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(status, 400);
  });
});

describe('vault', () => {
  test('upload returns the stored row including created_at', async () => {
    const form = new FormData();
    form.append('title', 'Vault Smoke Test');
    form.append('file', new Blob(['%PDF-1.4 smoke'], { type: 'application/pdf' }), 'smoke.pdf');

    const uploaded = await api('/api/vault/upload', { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    assert.ok(uploaded.body.id, 'upload must return the new row id');
    assert.ok(
      uploaded.body.created_at,
      'upload must include created_at so the client does not render "Invalid Date"'
    );
    assert.equal(Number.isNaN(new Date(uploaded.body.created_at).getTime()), false);

    const listed = await api('/api/vault');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.some((b: any) => b.id === uploaded.body.id));

    const removed = await api(`/api/vault/${uploaded.body.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);

    const afterDelete = await api('/api/vault');
    assert.equal(
      afterDelete.body.some((b: any) => b.id === uploaded.body.id),
      false
    );
  });

  test('rejects unsupported file types', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    const { status } = await api('/api/vault/upload', { method: 'POST', body: form });
    assert.ok([400, 413].includes(status), `unexpected status ${status}`);
  });
});

describe('upstream resilience', () => {
  test('search reports upstream outages instead of silently returning nothing', async () => {
    const { status, body } = await api('/api/books/search?q=dune&source=google');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.results));
    assert.ok(
      Array.isArray(body.warnings),
      'search must always include a warnings array'
    );
  });

  test('mood recommendations identify their source', async () => {
    const { status, body } = await api('/api/recommendations/mood?mood=%F0%9F%98%8D');
    assert.equal(status, 200);
    assert.ok(['Google Books', 'Goodreads'].includes(body.source));
    assert.ok(Array.isArray(body.recommendations));
  });
});

describe('api surface', () => {
  test('unknown API routes return JSON 404, not the SPA shell', async () => {
    const response = await fetch(`${BASE}/api/definitely-not-a-route`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    const body = await response.json();
    assert.ok(body.error);
  });

  test('sets baseline security headers', async () => {
    const response = await fetch(`${BASE}/api/analytics`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  test('recommendations respond for an onboarded user', async () => {
    const { status, body } = await api('/api/recommendations/drpa');
    assert.equal(status, 200);
    assert.ok(typeof body.personality === 'string');
    assert.ok(Array.isArray(body.recommendations));
  });

  test('rejects disallowed CORS origins', async () => {
    const response = await fetch(`${BASE}/api/library`, {
      headers: { Origin: 'https://evil.example.com', Authorization: `Bearer ${token}` },
    });
    assert.ok([403, 500].includes(response.status), `unexpected status ${response.status}`);
  });
});

