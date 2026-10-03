import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import db from './db.js';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INSECURE_DEV_SECRET = 'super-secret-key-for-bookhaven';
const NODE_ENV = process.env.NODE_ENV || 'development';

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;

  if (NODE_ENV === 'production') {
    console.error(
      '\n FATAL: JWT_SECRET is not set.\n' +
      ' Refusing to start in production with the fallback secret.\n' +
      ' Add JWT_SECRET to your .env file (see README → Environment Variables).\n'
    );
    process.exit(1);
  }

  console.warn(
    '\n WARNING: JWT_SECRET is not set — using an insecure development fallback.\n' +
    ' Set JWT_SECRET in .env before deploying anywhere.\n'
  );
  return INSECURE_DEV_SECRET;
}

const JWT_SECRET = resolveJwtSecret();

function resolveTokenExpiry(): SignOptions['expiresIn'] {
  const raw = process.env.JWT_EXPIRES_IN?.trim();
  if (!raw) return '7d';
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^\d+(s|m|h|d|w|y)$/.test(raw)) return raw as SignOptions['expiresIn'];
  console.warn(
    `JWT_EXPIRES_IN "${raw}" is not a valid duration (use seconds like 900, or 12h / 7d) — using 7d`
  );
  return '7d';
}

const TOKEN_EXPIRES_IN = resolveTokenExpiry();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

const isValidEmail = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return 'Email is required';
  if (value.length > 254 || !EMAIL_RE.test(value.trim())) return 'Enter a valid email address';
  return null;
};

const isValidUsername = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return 'Username is required';
  if (!USERNAME_RE.test(value.trim())) {
    return 'Username must be 3-32 characters (letters, numbers, _ . -)';
  }
  return null;
};

const isValidPassword = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return 'Password is required';
  if (value.length < 8) return 'Password must be at least 8 characters';
  if (value.length > 200) return 'Password must be at most 200 characters';
  return null;
};

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 5000;

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5000,http://localhost:80')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  app.use(cors({
    origin(origin, callback) {
      // Allow same-origin/non-browser callers (curl, mobile webviews send no Origin)
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');
  app.use((req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Setup uploads directory
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use('/uploads', express.static(uploadsDir));

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const base = path.basename(file.originalname)
        .replace(/[/\\]/g, '')
        .replace(/\.{2,}/g, '.')
        .replace(/[\x00-\x1f]/g, '')
        .trim()
        .slice(0, 100) || 'book';
      cb(null, `${Date.now()}-${base}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.pdf' || ext === '.epub') {
        cb(null, true);
      } else {
        // Tag the status so the error handler returns 400, not a generic 500.
        const err: any = new Error('Only PDF and EPUB files are allowed');
        err.status = 400;
        cb(err);
      }
    }
  });

  // Auth Middleware
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.status(401).json({ error: 'Authentication required' });
    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) {
        const expired = err.name === 'TokenExpiredError';
        return res.status(401).json({
          error: expired ? 'Session expired, please sign in again' : 'Invalid token',
        });
      }
      req.user = user;
      next();
    });
  };

  const requireFields = (fields: Record<string, (value: unknown) => string | null>) =>
    (req: any, res: any, next: any) => {
      for (const [field, validate] of Object.entries(fields)) {
        const message = validate(req.body?.[field]);
        if (message) return res.status(400).json({ error: message });
      }
      next();
    };

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later' },
  });

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' },
  });

  app.use('/api/', apiLimiter);

  // --- API Routes ---

  app.post('/api/auth/register', authLimiter, requireFields({
    username: isValidUsername,
    email: isValidEmail,
    password: isValidPassword,
  }), async (req, res) => {
    const { username, email, password, name, gender, birthday } = req.body;
    try {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
      if (existing) {
        return res.status(409).json({ error: 'That email or username is already registered' });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      const stmt = db.prepare(
        'INSERT INTO users (username, email, password, name, gender, birthday) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const info = stmt.run(username, email, hashedPassword, name ?? null, gender ?? null, birthday ?? null);
      const token = jwt.sign({ id: info.lastInsertRowid, username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
      res.status(201).json({
        token,
        user: {
          id: info.lastInsertRowid,
          username,
          email,
          name: name ?? null,
          gender: gender ?? null,
          birthday: birthday ?? null,
          onboarded: 0,
        },
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/auth/login', authLimiter, requireFields({
    email: isValidEmail,
    password: (v) => (typeof v === 'string' && v ? null : 'Password is required'),
  }), async (req, res) => {
    const { email, password } = req.body;
    try {
      const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
      const user = stmt.get(email) as any;
      // Always run a bcrypt comparison so response time does not reveal whether
      // the account exists.
      const hash = user?.password || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
      const validPassword = await bcrypt.compare(password, hash);
      if (!user || !validPassword) {
        return res.status(401).json({ error: 'Incorrect email or password' });
      }
      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
      res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          gender: user.gender,
          birthday: user.birthday,
          onboarded: user.onboarded,
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.get('/api/auth/me', authenticateToken, (req: any, res) => {
    const stmt = db.prepare(
      'SELECT id, username, email, name, gender, birthday, onboarded, created_at FROM users WHERE id = ?'
    );
    const user = stmt.get(req.user.id);
    res.json(user);
  });

  app.post('/api/auth/onboard', authenticateToken, (req: any, res) => {
    const { favorite_genres, reading_frequency, preferred_mood, favorite_types } = req.body;
    try {
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO user_preferences (user_id, favorite_genres, reading_frequency, preferred_mood, favorite_types) VALUES (?, ?, ?, ?, ?)'
      );
      stmt.run(req.user.id, JSON.stringify(favorite_genres), reading_frequency, preferred_mood, JSON.stringify(favorite_types));
      const updateStmt = db.prepare('UPDATE users SET onboarded = 1 WHERE id = ?');
      updateStmt.run(req.user.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put('/api/auth/me', authenticateToken, async (req: any, res) => {
    const { username, email, password, name, gender, birthday } = req.body ?? {};
    const has = (field: string) => Object.prototype.hasOwnProperty.call(req.body, field);

    try {
      // Validate only what was actually sent, so this endpoint stays a true
      // partial update.
      if (has('username')) {
        const message = isValidUsername(username);
        if (message) return res.status(400).json({ error: message });
      }
      if (has('email')) {
        const message = isValidEmail(email);
        if (message) return res.status(400).json({ error: message });
      }
      if (password) {
        const message = isValidPassword(password);
        if (message) return res.status(400).json({ error: message });
      }

      // Partial update: omitted fields keep their stored value, so saving the
      // profile cannot blank out name/gender/birthday.
      const updates: string[] = [];
      const params: any[] = [];

      if (has('username') || has('email')) {
        const current = db.prepare('SELECT username, email FROM users WHERE id = ?')
          .get(req.user.id) as any;
        const nextUsername = has('username') ? username : current.username;
        const nextEmail = has('email') ? email : current.email;
        const conflict = db.prepare(
          'SELECT id FROM users WHERE (email = ? OR username = ?) AND id != ?'
        ).get(nextEmail, nextUsername, req.user.id);
        if (conflict) {
          return res.status(409).json({ error: 'That email or username is already in use' });
        }
      }

      if (has('username')) { updates.push('username = ?'); params.push(username); }
      if (has('email')) { updates.push('email = ?'); params.push(email); }
      if (has('name')) { updates.push('name = ?'); params.push(name ?? null); }
      if (has('gender')) { updates.push('gender = ?'); params.push(gender ?? null); }
      if (has('birthday')) { updates.push('birthday = ?'); params.push(birthday ?? null); }
      if (password) { updates.push('password = ?'); params.push(await bcrypt.hash(password, 10)); }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
        .run(...params, req.user.id);

      const user = db.prepare(
        'SELECT id, username, email, name, gender, birthday, onboarded FROM users WHERE id = ?'
      ).get(req.user.id);
      res.json({ success: true, user });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/library', authenticateToken, (req: any, res) => {
    const stmt = db.prepare(`
      SELECT ub.*, b.title, b.author, b.cover_url, b.open_library_id
      FROM user_books ub
      JOIN books b ON ub.book_id = b.id
      WHERE ub.user_id = ?
      ORDER BY ub.id DESC
    `);
    const books = stmt.all(req.user.id);
    res.json(books);
  });

  app.post('/api/library', authenticateToken, (req: any, res) => {
    const { title, author, cover_url, open_library_id, status } = req.body;
    try {
      let bookStmt = db.prepare('SELECT id FROM books WHERE open_library_id = ?');
      let book = bookStmt.get(open_library_id) as any;
      if (!book) {
        const insertBook = db.prepare(
          'INSERT INTO books (title, author, cover_url, open_library_id) VALUES (?, ?, ?, ?)'
        );
        const info = insertBook.run(title, author, cover_url, open_library_id);
        book = { id: info.lastInsertRowid };
      }
      const checkStmt = db.prepare('SELECT id FROM user_books WHERE user_id = ? AND book_id = ?');
      const existing = checkStmt.get(req.user.id, book.id);
      if (existing) {
        return res.status(400).json({ error: 'Already in library' });
      }
      const insertUserBook = db.prepare(
        'INSERT INTO user_books (user_id, book_id, status) VALUES (?, ?, ?)'
      );
      insertUserBook.run(req.user.id, book.id, status || 'want_to_read');
      res.json({ success: true });
    } catch (error: any) {
      if (error.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ error: 'Already in library' });
      }
      res.status(400).json({ error: error.message });
    }
  });

  app.put('/api/library/:id', authenticateToken, (req: any, res) => {
    // Partial update: only the fields present in the body are written, so
    // changing a book's status cannot wipe its rating, notes or mood.
    const allowed = ['status', 'rating', 'notes', 'mood'] as const;
    const updates: string[] = [];
    const params: any[] = [];

    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        let value = req.body[field];
        if (field === 'rating') {
          if (value === null || value === '') value = null;
          else {
            const rating = Number(value);
            if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
              return res.status(400).json({ error: 'Rating must be between 0 and 5' });
            }
            value = Math.round(rating);
          }
        }
        updates.push(`${field} = ?`);
        params.push(value);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    try {
      const stmt = db.prepare(
        `UPDATE user_books SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`
      );
      const info = stmt.run(...params, req.params.id, req.user.id);
      if (info.changes === 0) {
        return res.status(404).json({ error: 'Book not found in your library' });
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/library/:id', authenticateToken, (req: any, res) => {
    try {
      const stmt = db.prepare('DELETE FROM user_books WHERE id = ? AND user_id = ?');
      stmt.run(req.params.id, req.user.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/vault/upload', authenticateToken, upload.single('file'), (req: any, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { title } = req.body;
    const fileUrl = `/uploads/${req.file.filename}`;
    try {
      const stmt = db.prepare(
        'INSERT INTO uploaded_books (user_id, title, file_url, file_size, file_name) VALUES (?, ?, ?, ?, ?)'
      );
      const info = stmt.run(
        req.user.id,
        title || req.file.originalname.replace(/\.[^/.]+$/, ''),
        fileUrl,
        req.file.size,
        req.file.originalname
      );
      // Return the stored row so the client has created_at (and any other
      // column it renders) instead of rendering "Invalid Date".
      const saved = db.prepare('SELECT * FROM uploaded_books WHERE id = ?')
        .get(info.lastInsertRowid) as any;
      res.json(saved || {
        id: info.lastInsertRowid,
        title: title || req.file.originalname.replace(/\.[^/.]+$/, ''),
        file_url: fileUrl,
        file_size: req.file.size,
        file_name: req.file.originalname,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/vault', authenticateToken, (req: any, res) => {
    const stmt = db.prepare('SELECT * FROM uploaded_books WHERE user_id = ? ORDER BY created_at DESC');
    const books = stmt.all(req.user.id);
    res.json(books);
  });

  app.delete('/api/vault/:id', authenticateToken, (req: any, res) => {
    try {
      const getStmt = db.prepare('SELECT file_url FROM uploaded_books WHERE id = ? AND user_id = ?');
      const book = getStmt.get(req.params.id, req.user.id) as any;
      if (book) {
        const filePath = path.join(uploadsDir, path.basename(book.file_url));
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
      const stmt = db.prepare('DELETE FROM uploaded_books WHERE id = ? AND user_id = ?');
      stmt.run(req.params.id, req.user.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put('/api/preferences/obsession', authenticateToken, (req: any, res) => {
    const { obsession } = req.body;
    try {
      const checkStmt = db.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?');
      if (!checkStmt.get(req.user.id)) {
        db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(req.user.id);
      }
      const stmt = db.prepare('UPDATE user_preferences SET current_obsession = ? WHERE user_id = ?');
      stmt.run(obsession, req.user.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/preferences/mood', authenticateToken, (req: any, res) => {
    const { mood } = req.body;
    if (typeof mood !== 'string' || mood.trim().length === 0) {
      return res.status(400).json({ error: 'A mood is required' });
    }
    try {
      const checkStmt = db.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?');
      if (!checkStmt.get(req.user.id)) {
        db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(req.user.id);
      }
      db.prepare(
        'INSERT INTO mood_logs (user_id, mood) VALUES (?, ?)'
      ).run(req.user.id, mood.trim());
      const stmt = db.prepare(
        'UPDATE user_preferences SET last_mood = ?, last_mood_updated = CURRENT_TIMESTAMP WHERE user_id = ?'
      );
      stmt.run(mood.trim(), req.user.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/analytics', authenticateToken, (req: any, res) => {
    try {
      const stmt = db.prepare(`
        SELECT status, COUNT(*) as count 
        FROM user_books 
        WHERE user_id = ? 
        GROUP BY status
      `);
      const statusCounts = stmt.all(req.user.id);
      // Moods come from two places: explicit dashboard logs (mood_logs) and
      // moods stamped onto individual books (user_books.mood). Counting both
      // means the Mood Tracker panel reflects what the user actually logged.
      const moodStmt = db.prepare(`
        SELECT mood, SUM(cnt) as count FROM (
          SELECT mood, COUNT(*) as cnt
          FROM mood_logs
          WHERE user_id = ? AND mood IS NOT NULL AND TRIM(mood) != ''
          GROUP BY mood
          UNION ALL
          SELECT mood, COUNT(*) as cnt
          FROM user_books
          WHERE user_id = ? AND mood IS NOT NULL AND TRIM(mood) != ''
          GROUP BY mood
        )
        GROUP BY mood
        ORDER BY count DESC
      `);
      const moodCounts = moodStmt.all(req.user.id, req.user.id);
      res.json({ statusCounts, moodCounts });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/reading/session/start', authenticateToken, (req: any, res) => {
    const { uploaded_book_id, book_id, mood_before } = req.body ?? {};
    try {
      let libraryBookId: number | null = null;
      let vaultBookId: number | null = null;

      if (uploaded_book_id != null) {
        const id = parseInt(String(uploaded_book_id), 10);
        if (Number.isNaN(id)) {
          return res.status(400).json({ error: 'Invalid uploaded_book_id' });
        }
        const owns = db.prepare(
          'SELECT id FROM uploaded_books WHERE id = ? AND user_id = ?'
        ).get(id, req.user.id);
        if (!owns) {
          return res.status(404).json({ error: 'Uploaded book not found' });
        }
        vaultBookId = id;
      } else if (book_id != null) {
        const id = parseInt(String(book_id), 10);
        if (Number.isNaN(id)) {
          return res.status(400).json({ error: 'Invalid book_id' });
        }
        const owns = db.prepare(
          'SELECT book_id FROM user_books WHERE id = ? AND user_id = ?'
        ).get(id, req.user.id) as any;
        if (!owns) {
          return res.status(404).json({ error: 'Library book not found' });
        }
        libraryBookId = owns.book_id;
      } else {
        return res.status(400).json({ error: 'A book_id or uploaded_book_id is required' });
      }

      const mood = typeof mood_before === 'string' && mood_before.trim() ? mood_before.trim() : null;
      const info = db.prepare(`
        INSERT INTO reading_sessions (user_id, book_id, uploaded_book_id, mood_before)
        VALUES (?, ?, ?, ?)
      `).run(req.user.id, libraryBookId, vaultBookId, mood);

      res.json({ success: true, session_id: info.lastInsertRowid });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/reading/session/end', authenticateToken, (req: any, res) => {
    const { session_id, pages_read, duration_minutes, mood_after } = req.body ?? {};
    try {
      const id = parseInt(String(session_id), 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid session_id' });
      }
      const session = db.prepare(
        'SELECT id, session_end FROM reading_sessions WHERE id = ? AND user_id = ?'
      ).get(id, req.user.id) as any;
      if (!session) {
        return res.status(404).json({ error: 'Reading session not found' });
      }
      if (session.session_end) {
        return res.status(400).json({ error: 'Session already ended' });
      }

      const pages = Number.isFinite(Number(pages_read)) ? Math.max(0, Math.trunc(Number(pages_read))) : null;
      const suppliedDuration = Number.isFinite(Number(duration_minutes))
        ? Math.max(0, Math.trunc(Number(duration_minutes)))
        : null;
      const mood = typeof mood_after === 'string' && mood_after.trim() ? mood_after.trim() : null;

      db.prepare(`
        UPDATE reading_sessions
        SET session_end = CURRENT_TIMESTAMP,
            duration_minutes = COALESCE(
              ?,
              MAX(0, CAST((julianday('now') - julianday(session_start)) * 1440 AS INTEGER))
            ),
            pages_read = ?,
            mood_after = ?
        WHERE id = ? AND user_id = ?
      `).run(suppliedDuration, pages, mood, id, req.user.id);

      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch('/api/reading/session/:id', authenticateToken, (req: any, res) => {
    const { mood_before } = req.body ?? {};
    try {
      const id = parseInt(String(req.params.id), 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid session id' });

      const session = db.prepare(
        'SELECT id, session_end FROM reading_sessions WHERE id = ? AND user_id = ?'
      ).get(id, req.user.id) as any;
      if (!session) return res.status(404).json({ error: 'Reading session not found' });
      if (session.session_end) {
        return res.status(400).json({ error: 'Cannot update a session that has ended' });
      }

      const mood = typeof mood_before === 'string' && mood_before.trim()
        ? mood_before.trim()
        : null;
      db.prepare('UPDATE reading_sessions SET mood_before = ? WHERE id = ? AND user_id = ?')
        .run(mood, id, req.user.id);

      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/reading/monthly-books', authenticateToken, (req: any, res) => {
    const { year } = req.query;
    const currentYear = year ? parseInt(year as string) : new Date().getFullYear();
    try {
      const completedStmt = db.prepare(`
        SELECT 
          strftime('%m', updated_at) as month,
          COUNT(*) as books_completed
        FROM user_books
        WHERE user_id = ? 
          AND status = 'completed'
          AND strftime('%Y', updated_at) = ?
        GROUP BY strftime('%m', updated_at)
        ORDER BY month ASC
      `);
      const completedBooks = completedStmt.all(req.user.id, String(currentYear)) as any[];

      const addedStmt = db.prepare(`
        SELECT 
          strftime('%m', created_at) as month,
          COUNT(*) as books_added
        FROM user_books
        WHERE user_id = ? 
          AND strftime('%Y', created_at) = ?
        GROUP BY strftime('%m', created_at)
      `);
      const addedBooks = addedStmt.all(req.user.id, String(currentYear)) as any[];

      const sessionsStmt = db.prepare(`
        SELECT 
          strftime('%m', session_start) as month,
          COUNT(*) as reading_sessions,
          COUNT(DISTINCT DATE(session_start)) as reading_days
        FROM reading_sessions
        WHERE user_id = ? 
          AND strftime('%Y', session_start) = ?
        GROUP BY strftime('%m', session_start)
      `);
      const readingSessions = sessionsStmt.all(req.user.id, String(currentYear)) as any[];

      const vaultBooksReadStmt = db.prepare(`
        SELECT 
          strftime('%m', session_start) as month,
          COUNT(DISTINCT uploaded_book_id) as vault_books_read
        FROM reading_sessions
        WHERE user_id = ? 
          AND uploaded_book_id IS NOT NULL
          AND strftime('%Y', session_start) = ?
        GROUP BY strftime('%m', session_start)
      `);
      const vaultBooksRead = vaultBooksReadStmt.all(req.user.id, String(currentYear)) as any[];

      const monthlyMap = new Map();
      for (let i = 1; i <= 12; i++) {
        const monthStr = i.toString().padStart(2, '0');
        monthlyMap.set(monthStr, {
          month: i,
          books_completed: 0,
          vault_books_read: 0,
          books_added: 0,
          reading_sessions: 0,
          reading_days: 0,
        });
      }

      completedBooks.forEach((book: any) => {
        const monthStr = book.month.padStart(2, '0');
        const existing = monthlyMap.get(monthStr);
        if (existing) existing.books_completed = book.books_completed;
      });

      vaultBooksRead.forEach((v: any) => {
        const monthStr = v.month.padStart(2, '0');
        const existing = monthlyMap.get(monthStr);
        if (existing) existing.vault_books_read = v.vault_books_read;
      });

      addedBooks.forEach((book: any) => {
        const monthStr = book.month.padStart(2, '0');
        const existing = monthlyMap.get(monthStr);
        if (existing) existing.books_added = book.books_added;
      });

      readingSessions.forEach((session: any) => {
        const monthStr = session.month.padStart(2, '0');
        const existing = monthlyMap.get(monthStr);
        if (existing) {
          existing.reading_sessions = session.reading_sessions;
          existing.reading_days = session.reading_days;
        }
      });

      const monthlyData = Array.from(monthlyMap.values()).sort((a, b) => a.month - b.month);
      const totalBooksCompleted = completedBooks.reduce((sum, b) => sum + b.books_completed, 0);
      const totalVaultBooksRead = vaultBooksRead.reduce((sum, v) => sum + v.vault_books_read, 0);
      const totalBooksAdded = addedBooks.reduce((sum, b) => sum + b.books_added, 0);
      const totalReadingSessions = readingSessions.reduce((sum, s) => sum + s.reading_sessions, 0);
      const totalReadingDays = readingSessions.reduce((sum, s) => sum + s.reading_days, 0);

      res.json({
        success: true,
        monthlyData: monthlyData.map(m => ({
          ...m,
          total_books_read: m.books_completed + m.vault_books_read,
        })),
        summary: {
          totalBooksCompleted,
          totalVaultBooksRead,
          totalBooksAdded,
          totalReadingSessions,
          totalReadingDays,
          year: currentYear,
        },
      });
    } catch (error: any) {
      console.error('Monthly books error:', error);
      res.status(500).json({ error: error.message, monthlyData: [] });
    }
  });

  app.get('/api/ai/suggestions', authenticateToken, async (req: any, res) => {
    try {
      const historyStmt = db.prepare(`
        SELECT b.title, b.author, ub.rating, ub.mood
        FROM user_books ub
        JOIN books b ON ub.book_id = b.id
        WHERE ub.user_id = ? AND ub.status = 'completed'
        ORDER BY ub.updated_at DESC
        LIMIT 10
      `);
      const history = historyStmt.all(req.user.id) as any[];
      const moodStmt = db.prepare('SELECT last_mood FROM user_preferences WHERE user_id = ?');
      const mood = moodStmt.get(req.user.id) as any;
      const prefStmt = db.prepare('SELECT current_obsession FROM user_preferences WHERE user_id = ?');
      const obsession = prefStmt.get(req.user.id) as any;
      const suggestions = [];
      
      if (history.length > 0) {
        const topAuthor = history[0]?.author;
        if (topAuthor && topAuthor !== 'Unknown') {
          suggestions.push({
            type: 'author',
            title: `More by ${topAuthor}`,
            description: `You enjoyed books by ${topAuthor}. Check out their other works.`,
            icon: '👤',
            action: 'author',
            value: topAuthor,
          });
        }
      }
      
      const genreStmt = db.prepare('SELECT favorite_genres FROM user_preferences WHERE user_id = ?');
      const genres = genreStmt.get(req.user.id) as any;
      if (genres?.favorite_genres) {
        const favGenres = JSON.parse(genres.favorite_genres);
        if (favGenres.length > 0) {
          suggestions.push({
            type: 'genre',
            title: `More ${favGenres[0]} Books`,
            description: `Books in the ${favGenres[0]} genre that match your taste.`,
            icon: '📚',
            action: 'genre',
            value: favGenres[0],
          });
        }
      }
      
      if (mood?.last_mood) {
        const moodSuggestions: Record<string, { title: string; description: string; icon: string }> = {
          '😊': { title: 'Happy Reads', description: 'Uplifting books to match your cheerful mood', icon: '😊' },
          '😢': { title: 'Emotional Journey', description: 'Books that explore deep emotions', icon: '😢' },
          '❤️': { title: 'Romance Picks', description: 'Heartwarming love stories', icon: '❤️' },
          '⚡': { title: 'Thriller Mode', description: 'Fast-paced books for your excited mood', icon: '⚡' },
          '☕': { title: 'Cozy Reads', description: 'Comforting books for relaxation', icon: '☕' },
          '🤔': { title: 'Thought Provoking', description: 'Books that make you think', icon: '🤔' },
          '🎉': { title: 'Celebratory Reads', description: 'Joyful books to keep the celebration going', icon: '🎉' },
          '😴': { title: 'Easy Reads', description: 'Light books perfect for winding down', icon: '😴' },
          '🤯': { title: 'Mind-Bending', description: 'Complex books that challenge your thinking', icon: '🤯' },
          '😍': { title: 'Obsession Worthy', description: 'Addictive books you won\'t put down', icon: '😍' },
          '🤗': { title: 'Heartwarming', description: 'Feel-good books for your grateful mood', icon: '🤗' },
        };
        const suggestion = moodSuggestions[mood.last_mood];
        if (suggestion) {
          suggestions.push({
            type: 'mood',
            title: suggestion.title,
            description: suggestion.description,
            icon: suggestion.icon,
            action: 'mood',
            value: mood.last_mood,
          });
        }
      }
      
      if (obsession?.current_obsession) {
        suggestions.push({
          type: 'obsession',
          title: `More ${obsession.current_obsession}`,
          description: `You're obsessed with ${obsession.current_obsession}. Discover similar books.`,
          icon: '🔥',
          action: 'obsession',
          value: obsession.current_obsession,
        });
      }
      
      const streakStmt = db.prepare(`
        SELECT COUNT(DISTINCT DATE(session_start)) as streak
        FROM reading_sessions
        WHERE user_id = ? 
          AND session_start >= datetime('now', '-7 days')
      `);
      const streak = streakStmt.get(req.user.id) as any;
      if (streak?.streak && streak.streak >= 3) {
        suggestions.push({
          type: 'streak',
          title: 'Keep Your Streak Going!',
          description: `You've read ${streak.streak} days in the past week. Keep up the great work!`,
          icon: '🔥',
          action: 'streak',
        });
      }
      res.json({ suggestions });
    } catch (error: any) {
      console.error('AI suggestions error:', error);
      res.status(500).json({ error: error.message, suggestions: [] });
    }
  });

  app.get('/api/books/goodreads-search', authenticateToken, async (req: any, res: any) => {
    const rawQuery = req.query.q ?? req.query.query ?? '';
    const normalizedQuery = String(rawQuery).trim();
    const type = (req.query.type as string) ?? 'all';
    let limit = Number.parseInt(String(req.query.limit ?? 50), 10);
    limit = Math.min(limit, 100);

    if (!normalizedQuery) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    try {
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='goodreads_books'"
      ).get();
      if (!tableCheck) {
        return res.json({ success: true, results: [], message: 'Database not initialized' });
      }

      let results: any[] = [];
      let ftsMatch = '';
      const phraseQuery = normalizedQuery.includes(' ') ? `"${normalizedQuery}"` : `${normalizedQuery}*`;
      switch (type) {
        case 'book':
          ftsMatch = `title:${phraseQuery}`;
          break;
        case 'author':
          ftsMatch = `author:${phraseQuery}`;
          break;
        case 'genre':
          ftsMatch = `genres:${phraseQuery}`;
          break;
        default:
          ftsMatch = phraseQuery;
      }

      try {
        const ftsStmt = db.prepare(`
          SELECT 
            gb.id, gb.title, gb.author, 
            gb.star_rating as rating, 
            gb.num_ratings as ratings_count,
            gb.num_reviews, gb.summary as description, 
            gb.genres, gb.first_published as published_date, 
            gb.goodreads_url as url
          FROM goodreads_books gb
          JOIN goodreads_fts fts ON gb.id = fts.rowid
          WHERE goodreads_fts MATCH ?
          ORDER BY gb.num_ratings DESC, gb.star_rating DESC
          LIMIT ?
        `);
        results = ftsStmt.all(ftsMatch, limit);
      } catch (ftsError) {
        console.log('FTS5 not ready, using LIKE fallback');
      }

      if (results.length === 0) {
        const words = normalizedQuery.split(/\s+/).filter(w => w.length > 0);
        const conditions = [];
        const params = [];
        const phrasePattern = `%${normalizedQuery}%`;
        if (type === 'book' || type === 'all') {
          conditions.push(`title LIKE ?`);
          params.push(phrasePattern);
        }
        if (type === 'author' || type === 'all') {
          conditions.push(`author LIKE ?`);
          params.push(phrasePattern);
        }
        if (type === 'genre' || type === 'all') {
          conditions.push(`genres LIKE ?`);
          params.push(phrasePattern);
        }
        if (conditions.length === 0) {
          conditions.push(`title LIKE ?`);
          params.push(phrasePattern);
        }
        for (const word of words) {
          const wordPattern = `%${word}%`;
          if (type === 'book' || type === 'all') {
            conditions.push(`title LIKE ?`);
            params.push(wordPattern);
          }
          if (type === 'author' || type === 'all') {
            conditions.push(`author LIKE ?`);
            params.push(wordPattern);
          }
          if (type === 'genre' || type === 'all') {
            conditions.push(`genres LIKE ?`);
            params.push(wordPattern);
          }
        }
        const sql = `
          SELECT 
            id, title, author, 
            star_rating as rating, 
            num_ratings as ratings_count,
            num_reviews, summary as description, 
            genres, first_published as published_date, 
            goodreads_url as url
          FROM goodreads_books 
          WHERE ${conditions.join(' OR ')}
          ORDER BY num_ratings DESC 
          LIMIT ?
        `;
        params.push(limit);
        const likeStmt = db.prepare(sql);
        results = likeStmt.all(...params);
      }

      const formattedResults = results.map((book: any) => ({
        key: `goodreads-${book.id}`,
        title: book.title || 'Unknown Title',
        author: book.author || 'Unknown Author',
        author_name: [book.author || 'Unknown Author'],
        description: book.description || 'No summary available',
        rating: book.rating,
        ratings_count: book.ratings_count,
        published_date: book.published_date ? String(book.published_date).substring(0, 4) : null,
        categories: book.genres ? book.genres.split(',').slice(0, 5) : [],
        source: 'Goodreads',
        url: book.url
      }));

      res.json({
        success: true,
        results: formattedResults,
        totalResults: formattedResults.length,
        source: 'goodreads'
      });
    } catch (error: any) {
      console.error('Goodreads search error:', error);
      res.status(500).json({ error: error.message, results: [] });
    }
  });

  app.get('/api/books/test-goodreads', authenticateToken, (req: any, res: any) => {
    try {
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='goodreads_books'"
      ).get();
      if (!tableCheck) {
        return res.json({
          success: false,
          error: 'goodreads_books table does not exist',
          message: 'Run python import_goodreads_fixed.py first'
        });
      }
      const countStmt = db.prepare("SELECT COUNT(*) as count FROM goodreads_books");
      const count = countStmt.get() as any;
      const sampleStmt = db.prepare(
        "SELECT title, author FROM goodreads_books WHERE title IS NOT NULL LIMIT 5"
      );
      const sample = sampleStmt.all();
      res.json({
        success: true,
        totalBooks: count.count,
        sample,
        message: `Goodreads database has ${count.count.toLocaleString()} books`
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/books/search', authenticateToken, async (req: any, res) => {
    const { q, source = 'google' } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });
    // Track upstream failures so an outage is reported instead of masquerading
    // as "no books matched".
    const warnings: string[] = [];
    try {
      let allResults: any[] = [];
      if (source === 'google' || source === 'all') {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          const googleResponse = await fetch(
            `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q as string)}&maxResults=12&orderBy=relevance`,
            { signal: controller.signal }
          );
          clearTimeout(timeoutId);
          if (!googleResponse.ok) {
            warnings.push(`Google Books unavailable (HTTP ${googleResponse.status})`);
          }
          if (googleResponse.ok) {
            const googleData = await googleResponse.json();
            if (googleData.items) {
              const googleResults = googleData.items.map((item: any) => ({
                key: item.id,
                title: item.volumeInfo.title,
                author: item.volumeInfo.authors ? item.volumeInfo.authors[0] : 'Unknown',
                author_name: item.volumeInfo.authors || ['Unknown'],
                cover_url: item.volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:') || '',
                description: item.volumeInfo.description ? item.volumeInfo.description.replace(/<[^>]*>/g, '').substring(0, 500) : '',
                rating: item.volumeInfo.averageRating,
                ratings_count: item.volumeInfo.ratingsCount,
                published_date: item.volumeInfo.publishedDate,
                page_count: item.volumeInfo.pageCount,
                categories: item.volumeInfo.categories,
                preview_link: item.volumeInfo.previewLink,
                source: 'Google Books',
                url: `https://books.google.com/books?id=${item.id}`,
              }));
              allResults = [...allResults, ...googleResults];
            }
          }
        } catch (googleError) {
          console.error('Google Books error:', googleError);
        }
      }
      if (source === 'openlibrary' || source === 'all') {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          const openLibResponse = await fetch(
            `https://openlibrary.org/search.json?q=${encodeURIComponent(q as string)}&limit=12`,
            { signal: controller.signal }
          );
          clearTimeout(timeoutId);
          if (openLibResponse.ok) {
            const openLibData = await openLibResponse.json();
            if (openLibData.docs) {
              const openLibResults = openLibData.docs.map((doc: any) => ({
                key: doc.key,
                title: doc.title,
                author: doc.author_name ? doc.author_name[0] : 'Unknown',
                author_name: doc.author_name || ['Unknown'],
                cover_url: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : '',
                description: doc.first_sentence ? doc.first_sentence[0]?.substring(0, 300) : '',
                published_date: doc.first_publish_year ? `${doc.first_publish_year}` : '',
                source: 'Open Library',
                url: `https://openlibrary.org${doc.key}`,
              }));
              allResults = [...allResults, ...openLibResults];
            }
          }
          if (!openLibResponse.ok) {
            warnings.push(`Open Library unavailable (HTTP ${openLibResponse.status})`);
          }
        } catch (openLibError) {
          warnings.push('Open Library unavailable');
          console.error('Open Library error:', openLibError);
        }
      }
      const seenTitles = new Set();
      const deduplicated = allResults.filter(book => {
        const titleLower = book.title?.toLowerCase() || '';
        if (seenTitles.has(titleLower)) return false;
        seenTitles.add(titleLower);
        return true;
      });
      res.json({
        success: true,
        results: deduplicated,
        totalResults: deduplicated.length,
        warnings,
      });
    } catch (error: any) {
      console.error('Search error:', error);
      res.status(500).json({ success: false, error: 'Search failed', results: [] });
    }
  });

  app.get('/api/books/details/:id', authenticateToken, async (req: any, res) => {
    const { id } = req.params;
    const { source = 'google' } = req.query;
    try {
      if (source === 'google') {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (response.ok) {
          const data = await response.json();
          res.json({ success: true, details: data });
        } else {
          res.json({ success: false, error: 'Failed to fetch details' });
        }
      } else {
        res.json({ success: false, error: 'Source not supported' });
      }
    } catch (error) {
      console.error('Details fetch error:', error);
      res.json({ success: false, error: 'Failed to fetch details' });
    }
  });

  app.get('/api/recommendations/drpa', authenticateToken, async (req: any, res) => {
    try {
      const prefStmt = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?');
      const prefs = prefStmt.get(req.user.id) as any;

      // Reading history, including ratings and moods, plus the Goodreads ids of
      // everything already in the library so nothing is recommended twice.
      const historyStmt = db.prepare(`
        SELECT b.title, b.author, b.open_library_id, ub.rating, ub.mood
        FROM user_books ub
        JOIN books b ON ub.book_id = b.id
        WHERE ub.user_id = ? AND ub.status = 'completed'
        ORDER BY ub.updated_at DESC LIMIT 50
      `);
      const history = historyStmt.all(req.user.id) as any[];

      const libraryStmt = db.prepare(`
        SELECT b.open_library_id FROM user_books ub
        JOIN books b ON ub.book_id = b.id
        WHERE ub.user_id = ?
      `);
      const libraryIds = new Set<string>();
      const libraryTitles = new Set<string>();
      (libraryStmt.all(req.user.id) as any[]).forEach(row => {
        if (row.open_library_id) {
          libraryIds.add(String(row.open_library_id));
          const match = /^goodreads-(\d+)$/.exec(String(row.open_library_id));
          if (match) libraryIds.add(match[1]);
        }
      });
      history.forEach(h => h.title && libraryTitles.add(h.title.toLowerCase().trim()));

      const genres: string[] = prefs?.favorite_genres ? JSON.parse(prefs.favorite_genres) : [];
      const moodLogs = db.prepare(`
        SELECT mood, COUNT(*) as count FROM mood_logs
        WHERE user_id = ? GROUP BY mood ORDER BY count DESC LIMIT 5
      `).all(req.user.id) as any[];

      // ---- Build a weighted taste profile -------------------------------------
      // Ratings carry the most signal, so a 5-star book counts for far more than
      // an unrated one. Genres come from onboarding; authors and moods are
      // derived from actual behaviour.
      const authorWeights = new Map<string, number>();
      const moodWeights = new Map<string, number>();
      let ratingSum = 0;
      let ratingCount = 0;

      for (const entry of history) {
        const rating = typeof entry.rating === 'number' ? entry.rating : null;
        const weight = rating == null ? 1 : 0.4 + (rating / 5) * 1.6;
        if (rating != null) {
          ratingSum += rating;
          ratingCount += 1;
        }
        if (entry.author) {
          authorWeights.set(entry.author, (authorWeights.get(entry.author) || 0) + weight);
        }
        if (entry.mood) {
          moodWeights.set(entry.mood, (moodWeights.get(entry.mood) || 0) + weight);
        }
      }
      moodLogs.forEach(row => moodWeights.set(row.mood, (moodWeights.get(row.mood) || 0) + row.count * 0.5));
      if (prefs?.preferred_mood) {
        moodWeights.set(prefs.preferred_mood, (moodWeights.get(prefs.preferred_mood) || 0) + 1.5);
      }

      const topAuthors = [...authorWeights.entries()]
        .sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 3);
      const topMoods = [...moodWeights.entries()]
        .sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 3);

      const averageRating = ratingCount > 0 ? ratingSum / ratingCount : null;
      const distinctAuthors = new Set(history.map(h => h.author).filter(Boolean)).size;

      // ---- Obsession ----------------------------------------------------------
      let obsession = prefs?.current_obsession || 'Exploring';
      if (!prefs?.current_obsession) {
        if (topAuthors.length > 0 && (authorWeights.get(topAuthors[0]) || 0) >= 2) {
          obsession = `Obsessed with ${topAuthors[0]}`;
        } else if (genres.length > 0) {
          obsession = history.length > 0 ? `Bingeing ${genres[0]}` : `Craving ${genres[0]}`;
        } else if (topMoods.length > 0) {
          obsession = `In a ${topMoods[0].toLowerCase()} mood`;
        }
      }

      // ---- Personality -------------------------------------------------------
      // Scored rather than first-match-wins, so a voracious reader who also
      // prefers long-form books is described by what dominates.
      const traits: { label: string; score: number }[] = [
        { label: 'The Newcomer', score: history.length === 0 ? 3 : 0 },
        { label: 'The Voracious Reader', score: Math.min(history.length / 12, 3) },
        { label: 'The Steady Scholar', score: history.length >= 4 && history.length <= 12 ? 1.6 : 0 },
        { label: 'The Daily Devourer', score: prefs?.reading_frequency === 'Daily' ? 2.4 : 0 },
        { label: 'The Deep Thinker', score: prefs?.preferred_mood === 'Thought-provoking' ? 2.2 : 0 },
        { label: 'The World Wanderer', score: distinctAuthors >= 5 ? 1.4 + distinctAuthors * 0.15 : 0 },
        { label: 'The Discerning Critic', score: averageRating != null && averageRating >= 4 ? 2 : 0 },
      ];
      const personality = traits.reduce((best, t) => (t.score > best.score ? t : best)).label;

      // ---- Candidate queries -------------------------------------------------
      const ftsToken = (value: string) =>
        value.replace(/["*():^-]/g, ' ').replace(/\s+/g, ' ').trim();

      const queries: string[] = [];
      if (prefs?.current_obsession) {
        const token = ftsToken(prefs.current_obsession);
        if (token) queries.push(token);
      }
      genres.slice(0, 2).forEach(g => {
        const token = ftsToken(g);
        if (token) queries.push(`genres:${token}*`);
      });
      topAuthors.slice(0, 2).forEach(a => {
        const token = ftsToken(a);
        if (token) queries.push(`author:${token}*`);
      });
      if (queries.length === 0) queries.push('genres:fiction*');

      // ---- Score candidates from the local 6.4M-book index --------------------
      const candidates: any[] = [];
      const seen = new Set<string>();
      const ftsStmt = db.prepare(`
        SELECT gb.id, gb.title, gb.author, gb.star_rating AS rating,
               gb.num_ratings AS ratings_count, gb.summary AS description,
               gb.genres, bm25(goodreads_fts) AS relevance
        FROM goodreads_fts
        JOIN goodreads_books gb ON gb.id = goodreads_fts.rowid
        WHERE goodreads_fts MATCH ?
        ORDER BY relevance
        LIMIT 40
      `);

      for (const match of queries.slice(0, 3)) {
        if (candidates.length >= 24) break;
        try {
          const rows = ftsStmt.all(match) as any[];
          for (const row of rows) {
            const titleKey = (row.title || '').toLowerCase().trim();
            if (!row.title || !row.author || row.author === 'Unknown Author') continue;
            if (libraryIds.has(String(row.id))) continue;
            if (titleKey && libraryTitles.has(titleKey)) continue;
            if (seen.has(titleKey)) continue;
            seen.add(titleKey);

            // Quality: well-rated and widely rated beats a 5-star from 3 people.
            const quality = (row.rating || 0) * Math.log10((row.ratings_count || 0) + 10);
            candidates.push({ ...row, score: quality - (row.relevance || 0) });
          }
        } catch (err) {
          console.warn('DRPA candidate query failed:', match, (err as Error).message);
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      const shortlist = candidates.slice(0, 6);

      // ---- Fetch covers from Google Books, matched per title -----------------
      // goodreads_books has no cover column, so covers come from Google Books.
      // Queries are issued per shortlisted title because a single broad query
      // ("science fiction") never lines up with the locally ranked titles.
      const lookupCover = async (title: string, author?: string): Promise<string | null> => {
        const safeTitle = title.replace(/"/g, '');
        const safeAuthor = author ? author.replace(/"/g, '') : '';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
          const term = `intitle:"${safeTitle}"${safeAuthor ? `+inauthor:"${safeAuthor}"` : ''}`;
          const response = await fetch(
            `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(term)}&maxResults=3`,
            { signal: controller.signal }
          );
          // Google Books rate-limits aggressively (HTTP 429); fall through to
          // Open Library rather than returning no cover at all.
          if (response.ok) {
            const data: any = await response.json();
            for (const item of data.items || []) {
              const cover = item.volumeInfo?.imageLinks?.thumbnail;
              if (cover) return cover.replace('http:', 'https:');
            }
          }
        } catch {
          // fall through to Open Library
        } finally {
          clearTimeout(timeoutId);
        }

        try {
          const olController = new AbortController();
          const olTimeout = setTimeout(() => olController.abort(), 5000);
          const params = new URLSearchParams({ title: safeTitle, limit: '1', fields: 'cover_i' });
          if (safeAuthor) params.set('author', safeAuthor);
          const olResponse = await fetch(
            `https://openlibrary.org/search.json?${params.toString()}`,
            { signal: olController.signal }
          );
          clearTimeout(olTimeout);
          if (olResponse.ok) {
            const olData: any = await olResponse.json();
            const coverId = olData.docs?.[0]?.cover_i;
            if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
          }
        } catch {
          // A missing cover is cosmetic; never fail the recommendation.
        }
        return null;
      };

      const covers = await Promise.all(
        shortlist.map(book => lookupCover(book.title, book.author))
      );

      const recommendations = shortlist
        .map((book, index) => ({
          key: `goodreads-${book.id}`,
          title: book.title,
          author: book.author,
          cover_url: covers[index] || null,
          description: book.description || '',
          rating: book.rating,
          ratings_count: book.ratings_count,
          genres: book.genres ? book.genres.split(',').slice(0, 5) : [],
          source: 'Goodreads',
        }))
        .filter(book => book.title.length > 2);

      res.json({
        obsession,
        personality,
        recommendations,
        preferences: prefs
          ? {
              genres: JSON.parse(prefs.favorite_genres || '[]'),
              mood: prefs.preferred_mood,
              frequency: prefs.reading_frequency,
            }
          : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/recommendations/mood', authenticateToken, async (req: any, res) => {
    try {
      const { mood } = req.query;
      let targetMood = mood;
      if (!targetMood) {
        const stmt = db.prepare(`
          SELECT mood FROM user_books 
          WHERE user_id = ? AND mood IS NOT NULL 
          ORDER BY updated_at DESC LIMIT 1
        `);
        const recentMood = stmt.get(req.user.id) as any;
        if (recentMood) targetMood = recentMood.mood;
      }
      if (!targetMood) return res.json({ mood: null, recommendations: [] });
      const moodMap: Record<string, string> = {
        '😊': 'feel good uplifting bestselling books 2024',
        '😢': 'emotional moving literary fiction bestsellers 2024',
        '😐': 'contemporary fiction award winning books',
        '❤️': 'romance novels bestsellers 2024',
        '⚡': 'thriller suspense bestselling books 2024',
        '☕': 'cozy mystery comfort reads bestsellers',
        '🤔': 'thought provoking philosophical fiction',
        '🎉': 'celebratory joyful books uplifting stories',
        '😴': 'light easy reading books',
        '🤯': 'mind blowing science fiction fantasy',
        '😍': 'addictive books unputdownable',
        '🤗': 'heartwarming feel good books',
      };
      const searchTerm = moodMap[targetMood as string] || `${targetMood} bestselling books 2024`;
      let recommendations: any[] = [];
      let source = 'Google Books';

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(
          `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchTerm)}&maxResults=6&orderBy=relevance`,
          { signal: controller.signal }
        );
        // Without this check a 429/rate-limit body parses fine and looks
        // identical to "no matches", silently hiding the outage.
        if (!response.ok) {
          throw new Error(`Google Books responded ${response.status}`);
        }
        const data = await response.json();
        recommendations = (data.items || [])
          .map((item: any) => ({
            key: `google-${item.id}`,
            title: item.volumeInfo.title,
            author: item.volumeInfo.authors ? item.volumeInfo.authors[0] : 'Unknown',
            cover_url: item.volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:') || null,
            description: item.volumeInfo.description || '',
          }))
          .filter((book: any) => book.title && book.author !== 'Unknown');
      } catch (err) {
        console.warn('Mood recommendations: Google Books unavailable, using local index:', (err as Error).message);
      } finally {
        clearTimeout(timeoutId);
      }

      // Fall back to the local 6.4M-book index so this endpoint still returns
      // something useful when Google Books is rate-limiting or unreachable.
      if (recommendations.length === 0) {
        source = 'Goodreads';
        const token = searchTerm.replace(/["*():^-]/g, ' ').replace(/\s+/g, ' ').trim();
        try {
          const rows = db.prepare(`
            SELECT gb.id, gb.title, gb.author, gb.star_rating AS rating,
                   gb.num_ratings AS ratings_count, gb.summary AS description,
                   bm25(goodreads_fts) AS relevance
            FROM goodreads_fts
            JOIN goodreads_books gb ON gb.id = goodreads_fts.rowid
            WHERE goodreads_fts MATCH ?
            ORDER BY relevance
            LIMIT 6
          `).all(token) as any[];
          recommendations = rows
            .filter(row => row.title && row.author && row.author !== 'Unknown Author')
            .map(row => ({
              key: `goodreads-${row.id}`,
              title: row.title,
              author: row.author,
              cover_url: null,
              description: row.description || '',
              rating: row.rating,
              ratings_count: row.ratings_count,
            }));
        } catch (err) {
          console.warn('Mood recommendations: local lookup failed:', (err as Error).message);
        }
      }

      res.json({ mood: targetMood, recommendations, source });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/movies/search', authenticateToken, async (req: any, res) => {
    const { title } = req.query;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const TMDB_API_KEY = process.env.TMDB_API_KEY;
    if (!TMDB_API_KEY) {
      return res.json({
        mock: true,
        results: [
          {
            id: 1,
            title: `${title} (Movie Adaptation)`,
            overview: `A cinematic adaptation of the popular book "${title}".`,
            vote_average: 7.5,
            release_date: '2023-01-01',
          },
        ],
      });
    }
    try {
      const response = await fetch(
        `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`
      );
      const data = await response.json();
      res.json({ results: data.results || [] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Unmatched API routes must 404 as JSON, never fall through to the SPA shell
  app.use('/api', (req: any, res: any) => {
    res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` });
  });

  // Serve static frontend files in production
  const distPath = path.join(__dirname, 'dist');
  const indexHtml = path.join(distPath, 'index.html');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!fs.existsSync(indexHtml)) {
      return res.status(503).json({
        error: 'Frontend not built. Run `npm run build`, or use `npm run dev` for the Vite dev server.',
      });
    }
    res.sendFile(indexHtml);
  });

  app.use((err: any, req: any, res: any, next: any) => {
    if (res.headersSent) return next(err);
    if (err?.message?.includes('not allowed by CORS')) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413
      : err.status || err.statusCode || 500;
    if (status >= 500) console.error('Unhandled error:', err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Uploads directory: ${uploadsDir}`);
  });
}

startServer();
