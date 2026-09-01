# /sorasukt Classroom

ระบบเช็คชื่อนักเรียนสำหรับครู โดย Host หน้าเว็บ `index.html` ผ่าน GitHub Pages และใช้ Cloudflare Worker สำหรับ API, Auth0 callback, D1 และ R2 เท่านั้น

## ความสามารถ

- Dashboard สรุปห้องเรียน นักเรียน อัตราเข้าเรียน 14 วัน และคาบวันนี้
- จัดการห้องเรียนและรายชื่อนักเรียน
- เช็คชื่อสถานะ มา / สาย / ขาด / ลา
- สถิติและประวัติย้อนหลังรายบุคคล
- บันทึกและแก้ไขแผนการสอนรายห้องเรียน
- ส่งออก CSV แบบ UTF-8 BOM รองรับภาษาไทยใน Excel
- สร้างลิงก์สรุปรายวันและแชร์ผ่าน LINE
- Responsive พร้อม bottom navigation บนมือถือ
- D1 เป็นฐานข้อมูลหลัก และ R2 เก็บ audit, snapshot การเช็คชื่อ และสำเนา CSV
- Auth0 Universal Login พร้อม signed session สำหรับเว็บ GitHub Pages

## การจัดเก็บข้อมูล

- **D1 (ข้อมูลหลัก):** ห้องเรียน นักเรียน การเช็คชื่อ แผนการสอน และลิงก์แชร์ ระบบอ่านข้อมูลสำหรับหน้าเว็บและรายงานจาก D1
- **R2 (สำเนาและไฟล์):** เป็น bucket แบบ private ที่เข้าถึงผ่าน Worker binding เท่านั้น
  - `audit/YYYY-MM-DD/*.json` เก็บเหตุการณ์สร้าง แก้ไข ลบ และแชร์ เพื่อใช้ตรวจสอบย้อนหลัง
  - `snapshots/attendance/{classroom_id}/{date}.json` เก็บภาพล่าสุดของการเช็คชื่อแต่ละวัน
  - `exports/*.csv` เก็บสำเนา CSV ที่ผู้ใช้ส่งออก

Worker จะบันทึก D1 ให้สำเร็จก่อน แล้วจึงส่งงานสำเนาไป R2 แบบ background ดังนั้น R2 ขัดข้องชั่วคราวจะไม่ทำให้การเช็คชื่อใน D1 สูญหาย ข้อมูลนักเรียนใน R2 ไม่ได้เปิดเป็น public URL

## ติดตั้ง

1. สร้าง D1 และ R2

   ```bash
   npx wrangler d1 create classroom-db
   npx wrangler r2 bucket create classroom-exports
   ```

2. นำ `database_id` ที่ได้รับมาแทนค่า `REPLACE_WITH_D1_DATABASE_ID` ใน `wrangler.toml`

3. สร้าง Auth0 Application ประเภท **Regular Web Application** แล้วตั้งค่า:

   - Allowed Callback URLs: `https://classroom.sorasukt.com/api/auth/callback`
   - Allowed Logout URLs: `https://sorasukt.github.io/classroom/`
   - Allowed Web Origins: `https://sorasukt.github.io`

   จากนั้นแก้ `AUTH0_DOMAIN` และ `AUTH0_CLIENT_ID` ใน `wrangler.toml`

4. ตั้ง Auth0 Client Secret เป็น Worker secret

   ```bash
   npx wrangler secret put AUTH0_CLIENT_SECRET
   ```

5. Deploy

   ```bash
   npx wrangler deploy
   ```

ตาราง D1 ถูกจัดการด้วยไฟล์ `migrations/0001_initial.sql` และต้อง apply ก่อน Deploy Worker ระบบไม่สร้างหรือแก้ schema ระหว่างคำขอของผู้ใช้

## Local development

```bash
npx wrangler dev
```

การเรียก `/api/health` จะตรวจสอบว่า Worker ได้รับ D1 และ R2 binding ครบ ส่วน `/api/bootstrap` ใช้ตรวจสอบการเข้าถึง API หลังเข้าสู่ระบบ

## GitHub Actions

Workflow `.github/workflows/deploy.yml` จะตรวจ syntax, migration และ Worker bundle ในทุก Pull Request เมื่อ merge เข้า `main` ระบบจะใส่ค่าจริงลงใน Wrangler config ชั่วคราวบน GitHub runner, ตรวจ D1, สร้าง R2 bucket หากยังไม่มี, apply D1 migrations, dry-run และ Deploy Worker ตามลำดับ รวมถึงรองรับการกด Run workflow เอง

เพิ่มค่าที่ `Settings → Secrets and variables → Actions` ดังนี้

### Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AUTH0_CLIENT_SECRET`

### Variables

- `D1_DATABASE_ID`
- `AUTH0_CLIENT_ID`

Workflow จะส่ง `AUTH0_CLIENT_SECRET` ไปเก็บเป็น Cloudflare Worker Secret ก่อน Deploy โดยอัตโนมัติ ส่วนกุญแจลงนาม session จะถูกสร้างแบบแยกบริบทจาก Client Secret ภายใน Worker และไม่ต้องตั้งค่าเพิ่ม

## Domains

- Frontend (GitHub Pages): `https://sorasukt.github.io/classroom/`
- API Worker: `https://classroom.sorasukt.com`
- Auth0 Universal Login: `https://auth.sorasukt.com`
- Auth0 callback: `https://classroom.sorasukt.com/api/auth/callback`
