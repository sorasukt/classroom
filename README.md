# /sorasukt Classroom

ระบบเช็คชื่อนักเรียนสำหรับครูบน Cloudflare Workers ใช้หน้าเว็บ HTML/CSS/JS แบบไฟล์เดียวภายใน `worker.js` พร้อม API ใน Worker เดียวกัน

## ความสามารถ

- Dashboard สรุปห้องเรียน นักเรียน อัตราเข้าเรียน 14 วัน และคาบวันนี้
- จัดการห้องเรียนและรายชื่อนักเรียน
- เช็คชื่อสถานะ มา / สาย / ขาด / ลา
- สถิติและประวัติย้อนหลังรายบุคคล
- บันทึกและแก้ไขแผนการสอนรายห้องเรียน
- ส่งออก CSV แบบ UTF-8 BOM รองรับภาษาไทยใน Excel
- สร้างลิงก์สรุปรายวันและแชร์ผ่าน LINE
- Responsive พร้อม bottom navigation บนมือถือ
- D1 สำหรับข้อมูล และ R2 สำหรับเก็บสำเนาไฟล์ CSV ที่ส่งออก
- Auth0 Universal Login พร้อม session แบบ HttpOnly

## ติดตั้ง

1. สร้าง D1 และ R2

   ```bash
   npx wrangler d1 create classroom-db
   npx wrangler r2 bucket create classroom-exports
   ```

2. นำ `database_id` ที่ได้รับมาแทนค่า `REPLACE_WITH_D1_DATABASE_ID` ใน `wrangler.toml`

3. สร้าง Auth0 Application ประเภท **Regular Web Application** แล้วตั้งค่า:

   - Allowed Callback URLs: `https://YOUR_DOMAIN/api/auth/callback`
   - Allowed Logout URLs: `https://YOUR_DOMAIN`
   - Allowed Web Origins: `https://YOUR_DOMAIN`

   จากนั้นแก้ `AUTH0_DOMAIN` และ `AUTH0_CLIENT_ID` ใน `wrangler.toml`

4. ตั้ง Auth0 Client Secret เป็น Worker secret

   ```bash
   npx wrangler secret put AUTH0_CLIENT_SECRET
   ```

5. Deploy

   ```bash
   npx wrangler deploy
   ```

ตาราง D1 จะถูกสร้างโดยอัตโนมัติเมื่อ Worker รับคำขอครั้งแรก ระบบจะไม่เปิดให้เข้าถึงข้อมูลหากการตั้งค่า Auth0 ยังไม่ครบ

## Local development

```bash
npx wrangler dev
```

การเรียก `/api/bootstrap` จะตรวจสอบความพร้อมของฐานข้อมูล ส่วนตารางทั้งหมดจะถูกสร้างอัตโนมัติจาก Worker

## GitHub Actions

Workflow `.github/workflows/deploy.yml` จะตรวจ syntax ในทุก Pull Request และ Deploy ไป Cloudflare อัตโนมัติเมื่อ push หรือ merge เข้า `main` รวมถึงรองรับการกด Run workflow เอง

เพิ่มค่าที่ `Settings → Secrets and variables → Actions` ดังนี้

### Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `AUTH0_CLIENT_SECRET`

### Variables

- `D1_DATABASE_ID`
- `AUTH0_CLIENT_ID`

Workflow จะส่ง `AUTH0_CLIENT_SECRET` ไปเก็บเป็น Cloudflare Worker Secret ก่อน Deploy โดยอัตโนมัติ ส่วนกุญแจลงนาม session จะถูกสร้างแบบแยกบริบทจาก Client Secret ภายใน Worker และไม่ต้องตั้งค่าเพิ่ม
