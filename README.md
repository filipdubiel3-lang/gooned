# Goon Room 🎮

## Deploy to Railway (free, online in 5 minutes)

1. Go to https://railway.app and sign up (free)
2. Click "New Project" → "Deploy from GitHub repo"
   - OR click "New Project" → "Empty project" → drag this whole folder in
3. Railway auto-detects Node.js and runs `npm start`
4. Once deployed, click your project → Settings → Networking → Generate Domain
5. Share that URL with your friends!

## Passwords
- **Site password** (what players type to get in): `goonroom`
- **Admin password** (to change the site password): `admin123`

To change passwords, set environment variables in Railway:
- `SITE_PASSWORD` = whatever you want
- `ADMIN_PASSWORD` = whatever you want

## Run locally (optional)
```
npm install
npm start
```
Then open http://localhost:3000
