# Masáže Alesa — nasazení

## Přehled architektury
- **Backend (server.js)** běží na **Render** (Node.js proces)
- **Databáze** je vlastní **PostgreSQL na Forpsi VPS** (žádný Supabase)
- **Web (masaze-alesa.html, admin.html, assets/)** je nahraný staticky na **Forpsi VPS**
- Kód je na GitHubu: [hasalovaalena-glitch/masazealesa](https://github.com/hasalovaalena-glitch/masazealesa)

## 1. PostgreSQL na Forpsi VPS
Na VPS (přes SSH / VS Code Remote-SSH):
1. Nainstaluj PostgreSQL, pokud tam ještě není (`apt install postgresql` na Debianu/Ubuntu)
2. Vytvoř databázi a uživatele pro backend, např.:
   ```sql
   CREATE DATABASE masaze_alesa;
   CREATE USER masaze_app WITH PASSWORD 'silné-heslo-sem';
   GRANT ALL PRIVILEGES ON DATABASE masaze_alesa TO masaze_app;
   ```
3. Spusť `schema.sql` proti téhle databázi, např.:
   ```bash
   psql -U masaze_app -d masaze_alesa -f schema.sql
   ```
4. Aby se na databázi mohl připojit Render (běží mimo VPS), musí PostgreSQL:
   - poslouchat i na veřejné síti (`listen_addresses = '*'` v `postgresql.conf`)
   - povolit připojení zvenčí pro uživatele `masaze_app` (řádek v `pg_hba.conf`, ideálně omezený jen na tuto databázi, s `scram-sha-256` heslem)
   - mít otevřený port 5432 ve firewallu jen pro nutné případy (zvaž změnu portu nebo omezení na Render IP rozsahy, pokud to Forpsi firewall umožňuje)
   - **doporučeno:** vynutit SSL spojení (v `postgresql.conf` `ssl = on` + certifikát)

## 2. Environment Variables na Render
V nastavení Render služby (Environment):
- `DATABASE_URL` = připojovací řetězec ve tvaru:
  `postgresql://masaze_app:silné-heslo-sem@TVOJE-VPS-IP:5432/masaze_alesa?sslmode=require`
  (bez `?sslmode=require` na konci, pokud SSL na VPS zatím nemáš zapnuté)
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
- `masaze-alesa.html` — stejná proměnná `API`

## 5. Web na Forpsi VPS
Nahraj tyto soubory/složky do docroot webového serveru na VPS:
- `masaze-alesa.html`
- `admin.html`
- celou složku `assets/` (obrázky poukazů)

⚠️ **Poznámka k free tieru Renderu:** zdarma server po ~15 minutách nečinnosti "usne" a první požadavek po probuzení trvá pár sekund déle.
