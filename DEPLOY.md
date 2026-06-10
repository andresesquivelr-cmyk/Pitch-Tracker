# Deployment Guide

Two services to deploy: **backend → Railway**, **frontend → Vercel**.
Do the backend first — you need its URL before deploying the frontend.

---

## Part 1 — Backend on Railway

### 1. Push your project to GitHub
If it's not already on GitHub, create a repo and push:
```bash
cd "Pitch Application for College teams"
git init
git add .
git commit -m "initial commit"
# Create a new repo at github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Create a Railway project
1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your repository
4. When Railway asks which folder to deploy, set the **Root Directory** to `backend`
5. Railway will auto-detect `railway.json` and use NIXPACKS to build

### 3. Set environment variables in Railway
In your Railway project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://uizadlkeulnvthyeknfa.supabase.co` |
| `SUPABASE_SERVICE_KEY` | your service role secret key |

### 4. Get your backend URL
After deployment, Railway gives you a public URL like:
```
https://your-app-name.up.railway.app
```
Copy this — you need it for the frontend step.

---

## Part 2 — Frontend on Vercel

### 1. Go to Vercel
1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **Add New → Project**
3. Import your same GitHub repository
4. Set **Root Directory** to `frontend`
5. Vercel will auto-detect Vite and use `vercel.json`

### 2. Set environment variables in Vercel
In the project settings → **Environment Variables**, add:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://uizadlkeulnvthyeknfa.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_mc8q_FBjQ6_P8z0ifuxQ3g_GkCub8s8` |
| `VITE_API_URL` | `https://your-app-name.up.railway.app` ← paste your Railway URL here |

> **Important:** `VITE_API_URL` must be the Railway URL with **no trailing slash**.

### 3. Deploy
Click **Deploy**. Vercel builds the frontend and publishes it at:
```
https://your-project-name.vercel.app
```

---

## Part 3 — Allow CORS from Vercel

Once you have your Vercel URL, update the CORS setting in `backend/main.py`.

Find this section:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    ...
)
```

Replace `"*"` with your actual Vercel URL for better security:
```python
allow_origins=["https://your-project-name.vercel.app"],
```

Then push to GitHub — Railway redeploys automatically.

---

## Summary of all environment variables

### Railway (backend)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

### Vercel (frontend)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_URL` — your Railway backend URL

---

## After deployment

- Share the Vercel URL with coaches — that's the app
- Railway free tier sleeps after inactivity; upgrade to Hobby ($5/mo) to keep it always-on
- Every `git push` to main auto-redeploys both Railway and Vercel
