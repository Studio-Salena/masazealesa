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
5. **Nepřidávej** na konec `?sslmode=require` — backend se šifrovaně připojuje vždy sám (viz `server.js`), a tenhle parametr by způsobil chybu "self-signed certificate in certificate chain"

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

## 6. Vánoční akce „Stromeček 2026“ (slevový kód STROMECEK2026)
**Pořadí je důležité: nejdřív databáze, pak teprve nahrát kód.** Nový server.js
počítá s novými sloupci — kdyby se nahrál dřív, rezervace z webu by nešly odeslat.

1. **Supabase → SQL Editor → New query** → vlož celý soubor `stromecek_2026.sql` → **Run**
   (jde spustit i opakovaně, nic nesmaže)
2. Nahraj změny na GitHub (commit + push). Render si nový `server.js` nasadí sám,
   GitHub Pages web (`index.html`, `admin.html`, `stromecek.html`) taky.
3. Za pár minut ověř:
   - `https://www.masazealesa.cz/stromecek` → „Dárek se rozbalí 30. listopadu“ (kód tam do té doby není)
   - administrace → **Akce Stromeček** → akce STROMECEK2026, začátek 30. 11. 2026
4. 30. 11. 2026 v 0:00 se akce spustí sama — stránka ukáže kód a v rezervaci
   i objednávce poukazu se objeví políčko „Slevový kód“.

Pravidla: sleva 100 Kč, jedna na rezervaci / poukaz, strop 50 použití, do 31. 12. 2026.
Zrušení rezervace nebo zamítnutí žádosti o poukaz slevu vrací samo (záznam zůstane
jako „Vráceno“, nic se nemaže). Strop, termíny a pauzu jde změnit v administraci.
Poukaz se slevou má plnou hodnotu (zůstatek), v účetnictví se počítá skutečně
zaplacená částka (hodnota − sleva).

Test: `ADMIN_HESLO=... TEST_API_BASE=http://localhost:3001/api node tests/stromecek.test.js`
