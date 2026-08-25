# Masáže Alesa — nasazení

## Přehled architektury
- **Backend (server.js)** běží na **Render** (Node.js proces)
- **Databáze** je **Supabase** — ale připojujeme se přímo přes PostgreSQL (ne přes jejich REST API/knihovnu)
- **Web (index.html, admin.html, assets/)** je nahraný na **GitHub Pages**, přímo z tohoto repozitáře
- Kód je na GitHubu: [Studio-Salena/masazealesa](https://github.com/Studio-Salena/masazealesa)

## 1. Supabase — databáze
1. Otevři svůj Supabase projekt → **SQL Editor** → **New query**
2. Vlož celý obsah souboru `schema.sql` a klikni **Run**
3. Jdi do **Project Settings → Database → Connection string**
4. Vyber formát **URI** a zkopíruj si připojovací řetězec — vypadá nějak takhle:
   `postgresql://postgres:[TVOJE-HESLO]@db.xxxxxxxxxxxx.supabase.co:5432/postgres`
   (heslo je to, které sis nastavila při založení projektu — pokud ho nemáš, dá se v Database nastavení resetovat)
5. Na konec připoj `?sslmode=require` — Supabase vyžaduje šifrované spojení

Žádné `SUPABASE_URL` ani `service_role` klíč už nepotřebuješ — backend mluví s databází přímo.

## 2. Environment Variables na Render
- `DATABASE_URL` = připojovací řetězec z kroku výše (včetně `?sslmode=require`)
- `ADMIN_HESLO` = heslo pro přihlášení do administrace

## 3. Nasazení backendu na Render
1. Render → **New → Web Service** → **Build and deploy from a Git repository** → vyber repozitář `masazealesa`
2. **Build Command:** `npm install`
3. **Start Command:** `npm start`
4. **Instance Type:** Free
5. Doplň Environment Variables (viz výše)
6. **Create Web Service** — po chvíli dostaneš URL jako `https://masazealesa-api.onrender.com`

## 4. Propojit web s backendem
URL z Render (bez lomítka na konci) patří na dvě místa:
- `admin.html` — proměnná `API` nahoře ve `<script>`
- `index.html` — stejná proměnná `API`

## 5. Web na GitHub Pages
1. Na GitHubu otevři repozitář `masazealesa` → **Settings → Pages**
2. V sekci **Build and deployment** vyber **Source: Deploy from a branch**
3. **Branch:** `master`, složka **/ (root)** → **Save**
4. Za pár desítek vteřin bude web dostupný na `https://studio-salena.github.io/masazealesa/`
5. Administrace bude na `https://studio-salena.github.io/masazealesa/admin.html`

⚠️ **Poznámka k free tieru Renderu:** zdarma server po ~15 minutách nečinnosti "usne" a první požadavek po probuzení trvá pár sekund déle.
