# HANDOFF — Fruit Addicts CRM (ส่งต่อให้ Junior Dev)

เอกสารนี้สรุปทุกอย่างที่ต้องรู้เพื่อพาระบบขึ้น production ตัวระบบ **เขียนเสร็จแล้ว 100%**
งานที่เหลือคือ **การติดตั้ง (deploy) + ต่อ LINE จริง** ประเมินเวลารวม ~1 วันทำงาน

อ่านคู่กับ: [`README.md`](README.md) (สถาปัตยกรรม+endpoint ครบ), [`ASSUMPTIONS.md`](ASSUMPTIONS.md)
(กติกาธุรกิจที่รอเจ้าของยืนยัน 🔲), [`GO-LIVE.md`](GO-LIVE.md) (เช็กลิสต์ขึ้น production).

---

## 1. ระบบคืออะไร (30 วินาที)

Customer-360 CRM + Loyalty สำหรับร้านผลไม้ (LINE OA → LIFF → CRM API → SQLite → Staff Console).
- **Stack:** Node.js 24 native TypeScript, **zero runtime deps** (`node:sqlite` WAL, `node:http`, `node:crypto`, `node:test`). typescript เป็น devDep ไว้ lint/build เท่านั้น รันตรงจาก `src/*.ts` ได้เลย (Node strip types).
- **เงิน = สตางค์ (integer)**, แต้ม = FIFO lots + immutable ledger, ทุก write **atomic + idempotent**.
- ออกแบบให้ย้ายไป Postgres ได้ผ่าน seam ใน [`src/db/index.ts`](src/db/index.ts).

**รันในเครื่อง:**
```bash
npm install          # ครั้งแรก (ลง devDeps: typescript, @types/node)
npm run migrate      # สร้าง/อัปเดต schema (idempotent)
npm run seed         # ข้อมูลตัวอย่าง + สาขา
npm run reset-admin  # ตั้งรหัส admin ตาม .env
npm run dev          # เปิด server (auto-reload) → http://localhost:3000/admin
npm run check        # lint (tsc --noEmit) + test (112 tests) — ต้องเขียวก่อนส่ง
```
Windows: ดับเบิลคลิก `run.bat` ก็ได้ (แต่ไม่ auto-reload — แก้โค้ด backend ต้องปิด-เปิดใหม่ ใช้ `npm run dev` จะสะดวกกว่า).

---

## 2. สถานะ: ทำอะไรไปแล้ว / เหลืออะไร

**เสร็จแล้ว (มีเทสต์ครบ 112 ผ่าน, lint+build เขียว):**
members/360, points (FIFO+ledger), transactions, coupons, membership tiers (auto+paid),
referral, receipt-photo claims (+hybrid auto-approve), FoodStory CSV import (ตรวจกับไฟล์จริง
12.6MB/14k บิล ~2s), RBAC 6 roles + audit, business policy layer, PDPA (consent/export/anonymize/
encryption), campaigns/broadcast (consent-gated), rich menu designer, scheduled worker.

**ยังไม่เสร็จ = งานของคุณ (ดูข้อ 4):** LIFF production auth, deploy+HTTPS, LINE creds จริง,
backups. *(Phase 2 ไม่ใช่ blocker: predictive CLV, Google Sheets reporting, per-user rich menu,
folder-watcher — ยังไม่ต้องทำ)*

---

## 3. การตัดสินใจที่ "ล็อกแล้ว" (อย่ารื้อ — เสียเวลาเปล่า)

| เรื่อง | ตัดสินใจ | เหตุผล |
|---|---|---|
| **ฐานข้อมูล** | **SQLite (คงไว้)** — ห้ามเปลี่ยนเป็น Google Sheets | Sheets ไม่มี transaction/locking → แต้ม (=เงิน) หักซ้ำได้ + rate limit + ยังไงก็ต้องมี server อยู่ดี |
| **เก็บไฟล์ DB** | ดิสก์จริง (volume) — **ห้ามวางบน Google Drive/Dropbox** | sync filesystem ทำ SQLite corrupt. Drive ใช้เก็บ **backup** เท่านั้น |
| **LINE OA** | ใช้ **OA เดิม** (มี ~3,000 เพื่อน + SlipOK) — ไม่สร้างใหม่ | ระบบเรา**ไม่ใช้ webhook** (ดู §4.4) เลยไม่ชนกับ SlipOK; เก็บฐาน 3,000 คนไว้บรอดแคสต์เชิญสมัครได้ |
| **Config ธุรกิจ** | ปรับผ่าน Console → ตั้งค่าธุรกิจ (policy layer) ไม่ hardcode | ดู [`src/domain/policy.ts`](src/domain/policy.ts); ฟีเจอร์ที่รออนุมัติปิดไว้จนเจ้าของเปิด |

---

## 4. งานที่ต้องทำเพื่อขึ้น production (ตามลำดับ)

### 4.1 ต่อ LIFF ให้ auth จริง (งาน code จริงชิ้นเดียว) — ~1-2 ชม.
ตอนนี้หน้า LIFF ส่ง `x-line-user-id` (dev เท่านั้น). Production ต้องใช้ LIFF SDK.
- **Backend พร้อมแล้ว:** [`src/lib/auth.ts`](src/lib/auth.ts) `requireLineUser()` — ถ้า `LINE_VERIFY_ID_TOKEN=true`
  จะอ่าน `Authorization: Bearer <idToken>` แล้ว verify ผ่าน provider.
- **ต้องแก้ frontend** [`public/liff/index.html`](public/liff/index.html) (ดู comment ท้ายไฟล์ บรรทัด ~294):
  1. เพิ่ม `<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>`
  2. `await liff.init({ liffId: CFG.liffId })` (มี `liffId` ให้แล้วใน `/api/config`)
  3. ถ้า `!liff.isLoggedIn()` → `liff.login()`
  4. `const idToken = liff.getIDToken()` แล้วส่งทุก request เป็น `Authorization: Bearer ${idToken}`
     แทน `x-line-user-id` (แก้ที่ฟังก์ชัน `api()` บรรทัด ~145)
  5. ซ่อน devbar (ช่องกรอก UID) เมื่อ `CFG.verifyIdToken===true`
- **เสร็จเมื่อ:** เปิด LIFF จาก LINE จริงบนมือถือ → login อัตโนมัติ → สมัคร/ดูแต้มได้ โดยไม่ต้องกรอก UID.

### 4.2 เตรียมเซิร์ฟเวอร์ + HTTPS + โดเมน — ~1-2 ชม.
- โฮสต์: **Railway** (ง่าย) หรือ **GCP VM + Caddy** (all-Google) — เจ้าของยังไม่เลือก ช่วยแนะนำ.
  ต้องมี **persistent volume** ให้ `/app/data` (SQLite).
- Docker พร้อมแล้ว: [`Dockerfile`](Dockerfile) + [`docker-compose.yml`](docker-compose.yml) (service `crm` + `worker` แชร์ volume `crm-data` + healthcheck).
- **HTTPS จำเป็น** (LINE บังคับ). VPS → เพิ่ม Caddy reverse proxy (auto Let's Encrypt). Railway/Fly → มี HTTPS ให้.
- โดเมน: เจ้าของมี **fruitaddicts89.com** อยู่แล้ว → ใช้ `crm.fruitaddicts89.com` (ชี้ DNS มาที่โฮสต์).
- **เสร็จเมื่อ:** `https://crm.fruitaddicts89.com/health` คืน `{"ok":true}`.

### 4.3 ตั้ง `.env` production (secrets) — ~30 นาที
คัดลอกจาก [`.env.example`](.env.example) → ตั้งค่าจริง:
```
NODE_ENV=production
LINE_PROVIDER=line
LINE_VERIFY_ID_TOKEN=true
LINE_CHANNEL_ID=...            # จาก Messaging API channel (OA เดิม)
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
LIFF_ID=...                    # จาก LIFF app ใหม่ (ดู 4.4)
PII_ENCRYPTION_KEY=...         # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" → แล้ว BACKUP ไว้ (หายแล้วกู้ข้อมูลเข้ารหัสไม่ได้)
ADMIN_BOOTSTRAP_PASSWORD=...   # เปลี่ยนจาก changeme-admin-8chars
```
- **เสร็จเมื่อ:** `.env` ครบ, `.env` ถูก git-ignore (ห้าม commit).

### 4.4 ตั้ง LINE (บน OA เดิม — อยู่ร่วมกับ SlipOK ได้) — ~1 ชม.
ระบบเราต้องการ 2 อย่างจาก LINE ซึ่ง **ไม่แตะ webhook ของ SlipOK**:
1. **Channel Access Token** (จาก Messaging API channel ของ OA เดิม) — ไว้ push/broadcast/rich menu.
   ⚠️ **อย่ากด "Reissue" token ตัวที่ SlipOK ใช้อยู่** (จะทำ SlipOK หลุด) — ถามคนตั้ง SlipOK หรือใช้ stateless token.
2. **LIFF app ใหม่** บน channel เดิม → endpoint = `https://crm.fruitaddicts89.com/liff/` → ได้ `LIFF_ID`.
   (channel เดียวมีหลาย LIFF app ได้ ไม่ชนกัน)
- **ไม่ต้องตั้ง webhook ของเรา** — `webhook_events` ถูก insert อย่างเดียว ไม่มี flow ไหนพึ่ง (ยืนยันแล้ว).
- **เสร็จเมื่อ:** มี token + LIFF_ID ใส่ใน `.env` แล้ว.

### 4.5 Deploy — ~30-60 นาที
```bash
docker compose up -d --build      # ขึ้น server + worker (migrate รันอัตโนมัติใน Dockerfile CMD)
docker compose exec crm node src/seed.ts        # seed สาขา (ครั้งแรก)
docker compose exec crm node src/reset-admin.ts # ตั้งรหัส admin
```
- **worker ต้องรัน** (ใน compose มีให้แล้ว) ไม่งั้นแต้มไม่หมดอายุ/ข้อความไม่ส่ง/แคมเปญไม่ยิง.
- **เสร็จเมื่อ:** login Console ได้ + worker log ขึ้น "daemon up".

### 4.6 Backup SQLite → Google Drive ทุกคืน — ~1 ชม.
- ไอเดียเจ้าของ (Drive) ใช้ตรงนี้ได้: cron รายวัน → `sqlite3 crm.db ".backup"` (หรือ copy ไฟล์ตอน worker/idle)
  → gzip → อัปขึ้น Google Drive (แนะนำ `rclone` หรือ service account).
- อย่าลืม backup ไฟล์ `-wal`/`-shm` ด้วย หรือ checkpoint ก่อน copy.
- **เสร็จเมื่อ:** มีไฟล์ backup ใน Drive + ลอง restore สำเร็จ 1 ครั้ง.

### 4.7 Rich Menu — ~30 นาที
แนะนำทำผ่าน **LINE Official Account Manager** (ง่ายกว่า):
- ใช้ภาพต้นแบบ + ตารางลิงก์ที่เตรียมไว้ (ปุ่ม → `https://liff.line.me/<LIFF_ID>?p=<section>`;
  section: `points`/`coupons`/`receipt`/`referral`/`purchases`/home).
- หรือใช้ในระบบ: Console → การตลาด → Rich Menu (อัปโหลดรูป → เผยแพร่ → ตั้ง default).
- **เสร็จเมื่อ:** เปิด LINE เห็นเมนู กดปุ่มเข้า LIFF ถูกหน้า.

### 4.8 Verify ก่อนเปิดจริง
`npm run check` เขียว → smoke ทุก flow บน production (สมัคร/ซื้อ-ได้แต้ม/แลกคูปอง/ใบเสร็จ/
broadcast/PDPA export). ดูเช็กลิสต์เต็มใน [`GO-LIVE.md`](GO-LIVE.md).

---

## 5. Gotchas (บันทึกจากที่เจอมาแล้ว — กันเสียเวลา)

- **`DB_FILE` ไม่ใช่ `DB_PATH`** — config อ่าน `DB_FILE` (ดู `src/config.ts`). ตั้งผิดชื่อ = เขียนลง DB default โดยไม่รู้ตัว.
- **แก้โค้ด backend ต้อง restart server** (`run.bat`/`npm start` ไม่ auto-reload — ใช้ `npm run dev`). แก้เฉพาะ HTML/CSS/JS ใน `public/` เห็นผลทันทีที่รีเฟรช (server อ่านไฟล์ทุก request).
- **ภาษาไทยผ่าน curl/bash -e มักเพี้ยนเป็น `????`** — เวลาใส่ข้อมูลไทยให้เขียนเป็นไฟล์แล้วรัน อย่าส่งผ่าน shell.
- **EADDRINUSE 3000** — มี server ค้างพอร์ตอยู่ (`pkill -f "node src/server.ts"` หรือใช้พอร์ตอื่นทดสอบ).
- **node:sqlite rows** ไม่ cast ตรงเข้า interface — ใช้ helper `asRow/asRows` (`src/db/index.ts`).

---

## 6. ข้อมูลทดสอบที่ค้างใน `data/crm.db` (dev เครื่องนี้)
เจ้าของเลือก "เก็บไว้ก่อน" — production เริ่ม DB ใหม่จะสะอาดเอง ไม่ต้องกังวล. ถ้าจะล้างใน dev:
rich_menus #1 `????????`, members #3-5 (Camp One/Two/anonymized), campaign #1 Smoke Promo คือขยะทดสอบ
(seed จริง: สมชาย/สมหญิง #1-2, คูปอง WELCOME10/DOUBLEPOINT/SAVE50 = เก็บ).

---

## 7. ถ้าติดตรงไหน
- endpoint + สถาปัตยกรรมทั้งหมด → [`README.md`](README.md)
- กติกาธุรกิจที่ยังต้องให้เจ้าของยืนยัน (🔲) → [`ASSUMPTIONS.md`](ASSUMPTIONS.md)
- เช็กลิสต์ blocker ก่อนเปิด → [`GO-LIVE.md`](GO-LIVE.md)
- โครงสร้างโค้ด: `src/domain/*` (business logic), `src/routes/*` (HTTP), `src/db/migrations/*` (schema, เพิ่มไฟล์ใหม่ `016_*.sql` เท่านั้น ห้ามแก้ของเก่า), `public/{admin,liff}/index.html` (UI).
