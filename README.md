# 📚 BookNest+

> A smart, personalized reading platform to discover, track, and manage books — powered by mood, behavior, and your reading obsessions.

![TypeScript](https://img.shields.io/badge/TypeScript-96.9%25-3178C6?style=flat-square&logo=typescript)
![Python](https://img.shields.io/badge/Python-2.9%25-3776AB?style=flat-square&logo=python)
![Node.js](https://img.shields.io/badge/Backend-Node.js%20%2B%20Express-339933?style=flat-square&logo=node.js)
![React](https://img.shields.io/badge/Frontend-React%2018-61DAFB?style=flat-square&logo=react)
![SQLite](https://img.shields.io/badge/Database-SQLite-003B57?style=flat-square&logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-Containerized-2496ED?style=flat-square&logo=docker)

---

## 🌐 Running Locally

This project runs entirely on your machine — no cloud account required. Frontend and
backend are served together from the Node/Express app on port `5000`.

| URL | Purpose |
|-----|---------|
| http://localhost:5000 | 🌍 Frontend + API (single Express server) |

See [Getting Started](#-getting-started-local) below.


---

## 🌿 Branches

> No CI/CD is configured in this repository. Build and run locally, or with
> `docker-compose up --build`.

---

## 🌟 Overview

**BookNest+** is a full-stack reading platform that combines:

- 🔍 **Book Discovery** — Search across Google Books and Open Library
- 📚 **Personal Library Management** — Organise your collection, wishlist, and reading progress
- 📊 **Reading Analytics** — Visualise your habits, streaks, and monthly progress
- 🧠 **Intelligent Recommendations** — Personalised picks via the DRPA engine

---

## 🗺️ Application Flowchart

```mermaid
flowchart TD
    A([👤 User]) --> B{Registered?}

    B -- No --> C[Register\nname · email · password]
    B -- Yes --> D[Login]

    C --> E[Onboarding\ngenres · mood · reading frequency]
    D --> F[🏠 Home / Dashboard]
    E --> F

    F --> G[🔍 Search Books\nGoogle Books · Open Library]
    F --> H[📚 My Library]
    F --> I[📊 Dashboard Analytics]
    F --> J[👤 Profile]
    F --> K[📦 Vault]

    G --> G1{Save Book?}
    G1 -- Yes --> H
    G1 -- No --> G

    H --> H1[Set Status\nWant to Read · Reading · Completed]
    H1 --> H2[Add Rating ⭐ and Notes]
    H2 --> H3[Log Mood 🎭]
    H3 --> L[🧠 DRPA Engine\nanalyses history · genre · mood · obsession]
    L --> M[Personalised Recommendations]

    I --> I1[Monthly Charts\nbooks added · completed · reading days]
    I --> I2[Streak Tracker 🔥]
    I --> I3[Mood Breakdown]

    K --> K1[Upload PDF / EPUB]
    K1 --> K2[💾 Saved to local uploads/ dir]
    K2 --> K3[📖 Read In-App epub.js]

    G --> N[🎬 Book-to-Movie Mode\nTMDB API]
    N --> N1[Compare Book vs Movie Rating]

    J --> J1[Edit Profile]
    J --> J2[Manage Uploaded Books]
    J --> J3[Logout]
```

---

## ✨ Features

### 🔍 Book Discovery
- Search books using **Google Books API** and **Open Library API**
- View covers, metadata, descriptions, and ratings
- Save books directly to your personal library

### 📚 Personal Library
- **My Collection** — All saved books in one place
- **Wishlist** — Books you want to read
- Organised reading status management

### 📊 Reading Tracker
- `Want to Read` → `Currently Reading` → `Completed`
- Track progress across multiple books simultaneously

### ⭐ Ratings & Notes
- Rate books from 1–5 stars
- Add personal notes and reflections per book

### 📦 Personal Book Vault
- Upload **PDF** and **EPUB** files
- Private file storage (local `uploads/` directory, served at `/uploads`)
- Access your uploaded books anytime

### 📖 In-App Reading
- **EPUB** reading powered by `epub.js`
- Smooth, browser-native reading experience with session tracking

### 🔗 Smart Availability
- Read via **Open Library** / **Internet Archive**
- Purchase links via **Kindle / Google Books** integration

### 📊 Dashboard & Analytics
- Monthly reading charts (books added, completed, reading days)
- Streak detection (last 7 days)
- Mood-based reading activity breakdown

### 🎯 Current Obsession
- Auto-detects your most-read genre or author
- Generates obsession-specific book recommendations

### 🎭 Mood-Based System
- Log reading moods per book (😊 😢 ❤️ ⚡ ☕ 🤔 🎉 😴 🤯 😍 🤗)
- Get mood-matched book suggestions

### 🎬 Book-to-Movie Mode
- Detect movie adaptations via **TMDB API**
- Compare book vs. movie ratings
- View posters and film details

### 👤 User Profile ("Me" Section)
- View & edit profile (name, email, gender, birthday)
- Manage uploaded books
- Onboarding flow with genre/mood/frequency preferences
- Secure JWT-based authentication

---

## 🧠 Core Algorithm — DRPA

### 🔥 Dynamic Reading Preference Algorithm

A custom recommendation engine that analyses:

| Signal | Description |
|--------|-------------|
| 📖 Reading history | Last 20 completed books with ratings |
| 🎯 Genre preferences | Set during onboarding |
| 🎭 Mood trends | Last logged reading mood |
| 🧠 Obsession tracking | User-set or auto-detected current obsession |
| 🔁 Reading frequency | Daily / Weekly / Monthly preference |

Outputs a **personality type** (e.g., *The Voracious Reader*, *The Deep Thinker*) and a curated set of recommendations.

---

## 🧱 Tech Stack

### 💻 Frontend
| Tech | Purpose |
|------|---------|
| React 18 + TypeScript | UI framework |
| Vite | Build tool |
| React Router | Client-side routing |
| Tailwind CSS | Styling |
| Framer Motion | Animations |
| Lucide React | Icons |
| epub.js | In-browser EPUB reader |

### ⚙️ Backend
| Tech | Purpose |
|------|---------|
| Node.js + Express | REST API server |
| TypeScript (via tsx) | Type-safe backend, runs directly |
| Multer | File uploads (PDF/EPUB), written to local disk |
| Local filesystem (`uploads/`) | PDF/EPUB file storage, served at `/uploads` |

### 🐳 Containerization
| Tech | Purpose |
|------|---------|
| Docker (`node:20-slim`) | Container runtime with glibc for better-sqlite3 |
| Docker Compose | Single-container orchestration, port 80→5000 |

### 🔐 Auth
| Tech | Purpose |
|------|---------|
| JSON Web Tokens (JWT) | Session management |
| bcryptjs | Password hashing |

### 🗄️ Database
| Tech | Purpose |
|------|---------|
| SQLite | Local relational DB |
| better-sqlite3 | Sync SQLite bindings |

### 🔗 External APIs
| API | Usage |
|-----|-------|
| Google Books API | Book search, covers, metadata |
| Open Library API | Additional book data |
| TMDB API | Movie adaptations, posters, ratings |

---

## ☁️ Deployment Architecture

```
User
 │
 ▼
Express Server (Node.js + TypeScript)   ← http://localhost:5000
 │   serves React dist/ (HTML, CSS, JS) + /api
 ▼
Docker Container (port 80→5000)
 │
 ├── SQLite DB (bookhaven.db)
 ├── uploads/                     ← PDF/EPUB files
 └── goodreads_books + FTS5       ← 6.4M-book search dataset
```

---

## 🔄 Build & Run

Fully automated with **Docker Compose**.

```
Push to master
      │
      ▼
GitHub Actions Workflow
      │
      ├── 1. Build
      │       npm install && npm run build → dist/
      │
      └── 2. Run
              docker-compose up --build -d
```

---

## 🚀 Getting Started (Local)

### Prerequisites
- Node.js v20+
- Python 3.x (for Goodreads import script)
- Docker (optional, for containerized run)

### Installation

```bash
# Clone the repository
git clone https://github.com/ria0304/BOOKNEST.git
cd BOOKNEST

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env and add your API keys
```

### Running the App

```bash
# Start frontend + backend (development)
npm run dev
```

Frontend: `http://localhost:5173` | Backend API: `http://localhost:5000`

### Running with Docker

```bash
docker-compose up --build
```

App available at `http://localhost:80`

### (Optional) Import Goodreads Data

Search runs against a local copy of the Goodreads books dataset (6,389,859
books). It is **resumable** — if the import is interrupted, run the same command
again and it continues from where it stopped.

```bash
pip install pyarrow          # only dependency; no `datasets` needed

python import_goodreads.py                 # resume, or no-op if complete
python import_goodreads.py --fresh         # drop the table and re-import
python import_goodreads.py --rebuild-fts  # force the FTS5 search index
```

The first run downloads the dataset (~16 GB cache) and can take a while. The
server builds the FTS5 index automatically on first start, and skips the rebuild
whenever the index is already current.

---

## 📁 Project Structure

```
BOOKNEST/
├── src/
│   ├── components/
│   │   └── Navbar.tsx          # Navigation bar
│   ├── context/
│   │   └── AuthContext.tsx     # Authentication context & state
│   ├── lib/
│   │   └── api.ts              # API utility / axios config
│   ├── pages/
│   │   ├── Auth.tsx            # Login / Register page
│   │   ├── BookDetails.tsx     # Book detail view
│   │   ├── Dashboard.tsx       # Reading analytics dashboard
│   │   ├── Home.tsx            # Landing / home page
│   │   ├── Library.tsx         # Personal library management
│   │   ├── Onboarding.tsx      # New user onboarding flow
│   │   ├── Profile.tsx         # User profile & settings
│   │   ├── Search.tsx          # Book search page
│   │   └── Vault.tsx           # Personal book vault (PDF/EPUB)
│   ├── App.tsx                 # Root component & routing
│   ├── index.css               # Global styles
│   └── main.tsx                # React entry point
├── uploads/                    # Local file upload storage
├── server.ts                   # Express backend (API server)
├── db.ts                       # SQLite database setup
├── Dockerfile                  # Docker image (node:20-slim)
├── docker-compose.yml          # Container orchestration (port 80:5000)
├── import_goodreads.py         # Resumable Goodreads dataset importer (Arrow streaming)
├── tests/
│   └── api.test.ts             # API smoke tests (`npm test`)
├── index.html                  # HTML entry point
├── vite.config.ts              # Vite configuration
├── tsconfig.json               # TypeScript config
├── package.json                # Dependencies & scripts
```

---

## 🔑 Environment Variables

Create a `.env` file in the root:

| Variable | Required | Purpose |
|----------|----------|---------|
| `JWT_SECRET` | **Yes in production** | Signing key for auth tokens. The server refuses to start in production without it; in development it falls back to an insecure default and warns. |
| `JWT_EXPIRES_IN` | No | Token lifetime — seconds (`900`) or a duration (`12h`, `7d`). Default `7d`. |
| `TMDB_API_KEY` | No | Enables Book-to-Movie comparisons. Without it the endpoint returns clearly-labelled mock data. |
| `PORT` | No | Defaults to `5000`. |
| `DB_PATH` | No | SQLite file location. Defaults to `./bookhaven.db`; set it to a mounted volume (the Docker image uses `/app/data/bookhaven.db`). |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS allow-list. Defaults to the local dev origins. |
| `DISABLE_HMR` | No | Set to `true` to turn off Vite HMR. |

Uploaded PDF/EPUB files are stored in the local `uploads/` directory — no cloud
credentials are required.

---

## 🧪 Tests

```bash
npm test
```

Runs an 18-case smoke suite against a real server on a random free port, using a
throwaway SQLite database so your development data is never touched. It covers
auth validation and token expiry, the partial-update regressions that used to
wipe ratings and profile fields, mood analytics, reading sessions, JSON 404s for
unknown API routes, and the security headers.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register a new user |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Get current user |
| PUT | `/api/auth/me` | Update profile |
| POST | `/api/auth/onboard` | Save onboarding preferences |
| GET | `/api/library` | Get user's library |
| POST | `/api/library` | Add book to library |
| PUT | `/api/library/:id` | Update book (status, rating, notes, mood) |
| DELETE | `/api/library/:id` | Remove book |
| POST | `/api/vault/upload` | Upload PDF/EPUB to local `uploads/` |
| GET | `/api/vault` | List uploaded files |
| DELETE | `/api/vault/:id` | Delete uploaded file |
| GET | `/api/analytics` | Reading stats by status and mood |
| GET | `/api/reading/monthly-books` | Monthly reading data |
| GET | `/api/recommendations/drpa` | DRPA-powered recommendations |
| GET | `/api/recommendations/mood` | Mood-based recommendations |
| GET | `/api/books/search` | Search books (Google/OpenLibrary) |
| GET | `/api/movies/search` | Search movie adaptations (TMDB) |

---

## License

This project is licensed under the [MIT License](LICENSE).
