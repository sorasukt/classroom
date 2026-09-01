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

## ติดตั้ง

1. สร้าง D1 และ R2

   ```bash
   npx wrangler d1 create classroom-db
   npx wrangler r2 bucket create classroom-exports
   ```

2. นำ `database_id` ที่ได้รับมาแทนค่า `REPLACE_WITH_D1_DATABASE_ID` ใน `wrangler.toml`

3. ตั้งรหัสผ่านสำหรับระบบ (แนะนำให้ใช้รหัสยาวและไม่ซ้ำบริการอื่น)

   ```bash
   npx wrangler secret put APP_PASSWORD
   ```

4. Deploy

   ```bash
   npx wrangler deploy
   ```

ตาราง D1 จะถูกสร้างโดยอัตโนมัติเมื่อ Worker รับคำขอครั้งแรก หากยังไม่ตั้ง `APP_PASSWORD` ระบบจะเปิดใช้งานโดยไม่ถามรหัสผ่านเพื่อให้ทดสอบใน local ได้ จึงควรตั้ง secret ก่อนเปิดใช้งานจริง

## Local development

```bash
npx wrangler dev
```

การเรียก `/api/bootstrap` จะตรวจสอบความพร้อมของฐานข้อมูล ส่วนตารางทั้งหมดจะถูกสร้างอัตโนมัติจาก Worker
