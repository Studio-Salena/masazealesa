# Masáže Alesa — nasazení backendu

## 1. Supabase — vytvořit tabulky
1. Otevři svůj Supabase projekt → **SQL Editor** → **New query**
2. Vlož obsah souboru `sql/schema.sql` a klikni **Run**
3. V **Project Settings → API** si zkopíruj:
   - **Project URL** (např. `https://xxxxx.supabase.co`)
   - **service_role** klíč (tajný! Ne "anon" klíč — service_role obchází zabezpečení a smí ho vidět jen backend, nikdy prohlížeč)

## 2. Nahrát backend na GitHub
1. Jdi na [github.com/new](https://github.com/new)
2. **Repository name:** např. `masaze-alesa-api`
3. Nastav na **Private** (ať to nevidí cizí lidi) a klikni **Create repository**
4. Na další stránce klikni na odkaz **"uploading an existing file"**
5. Přetáhni do okna v prohlížeči tyhle soubory ze složky, co jsem ti poslala:
   - `server.js`
   - `package.json`
   - celou složku `sql` (s `schema.sql` uvnitř)
6. Dole klikni **Commit changes**

## 3. Nasadit na Render (stejně jako u Dětských krůčků)
1. Render → **New → Web Service** → **Build and deploy from a Git repository** → vyber repozitář `masaze-alesa-api`
   (pokud ho Render nevidí, bude potřeba mu přes "Configure account" povolit přístup k tomuto repozitáři)
2. **Name:** např. `masaze-alesa-api`
3. **Build Command:** `npm install`
4. **Start Command:** `npm start`
5. **Instance Type:** Free
6. V sekci **Environment Variables** přidej tyto tři:
   - `SUPABASE_URL` = tvoje Project URL ze Supabase
   - `SUPABASE_SERVICE_KEY` = tvůj service_role klíč ze Supabase
   - `ADMIN_HESLO` = heslo, kterým se budeš přihlašovat do administrace (vymysli si silné heslo)
7. Klikni **Create Web Service** — Render začne nasazovat (chvíli to trvá), pak ti nahoře ukáže URL adresu, něco jako:
   `https://masaze-alesa-api.onrender.com`

## 4. Propojit s webem
Tuhle URL adresu (bez lomítka na konci) potřebuju doplnit na dvě místa:
- do `admin.html` (proměnná `API` úplně nahoře ve `<script>`)
- do veřejného webu `masaze-alesa.html` (proměnná `API`, zatím se z ní tahá jen Ceník — sekce Rezervace a Poukazy na webu ještě čekají na dodělání)

Jakmile budeš mít URL z Render, pošli mi ji a doplním ji na obě místa.

⚠️ **Poznámka k free tieru Renderu:** zdarma server po ~15 minutách nečinnosti "usne" a první požadavek po probuzení trvá pár sekund déle — přesně jako u projektu Dětské krůčky, takže to znáš.
