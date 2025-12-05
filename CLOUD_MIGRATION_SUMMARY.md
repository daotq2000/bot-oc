# ☁️ Bot-OC Cloud Migration - Complete Guide

**Ngày tạo:** 2025-12-05  
**Phiên bản:** 1.0  
**Trạng thái:** Ready for Production

---

## 📌 Tóm Tắt Nhanh

Bạn muốn export database `bot_oc` hiện tại thành file `data.sql` để di chuyển lên cloud. Tôi đã tạo **3 cách** để thực hiện điều này:

### ✨ Cách Nhanh Nhất (Khuyến Nghị)

```bash
# Chạy script này - nó sẽ tự động chọn phương pháp tốt nhất
bash scripts/quick_export.sh data.sql
```

**Kết quả:** File `data.sql` sẵn sàng upload lên cloud ✅

---

## 🛠️ 3 Phương Pháp Export

### **Phương Pháp 1: mysqldump (Nhanh nhất) ⭐⭐⭐**

**Ưu điểm:**
- ⚡ Nhanh nhất
- 🔒 Tối ưu cho production
- 📦 Hỗ trợ compression
- ✅ Chuẩn MySQL

**Cách dùng:**
```bash
# Cách 1: Sử dụng script có sẵn
bash scripts/export_database_mysqldump.sh data.sql

# Cách 2: Chạy trực tiếp
mysqldump -h localhost -u root -p bot_oc > data.sql
```

**Yêu cầu:** Cài MySQL client
```bash
# Ubuntu/Debian
sudo apt-get install mysql-client

# macOS
brew install mysql-client
```

---

### **Phương Pháp 2: Node.js Script ⭐⭐**

**Ưu điểm:**
- ✅ Không cần cài thêm công cụ
- 📊 Hiển thị chi tiết quá trình
- 🔍 Có xử lý lỗi tốt

**Cách dùng:**
```bash
node scripts/export_database.js data.sql
```

**Yêu cầu:** Node.js (đã có)

---

### **Phương Pháp 3: Quick Export Script ⭐⭐⭐**

**Ưu điểm:**
- [object Object]ự động chọn phương pháp tốt nhất
- 🎨 Giao diện đẹp với màu sắc
- [object Object]ự động backup với timestamp
- 📊 Hiển thị thống kê

**Cách dùng:**
```bash
bash scripts/quick_export.sh data.sql
```

---

## 📋 Các Script Mới Được Tạo

| Script | Mục đích | Cách dùng |
|--------|---------|----------|
| `scripts/quick_export.sh` | Export nhanh (khuyến nghị) | `bash scripts/quick_export.sh data.sql` |
| `scripts/export_database_mysqldump.sh` | Export với mysqldump | `bash scripts/export_database_mysqldump.sh data.sql` |
| `scripts/export_database.js` | Export với Node.js | `node scripts/export_database.js data.sql` |
| `scripts/restore_database.sh` | Restore trên cloud | `bash scripts/restore_database.sh data.sql` |
| `scripts/verify_database.js` | Kiểm tra database | `node scripts/verify_database.js` |

---

## [object Object]uy Trình Hoàn Chỉnh

### **Bước 1: Export Database (Local)**

```bash
# Cách nhanh nhất
bash scripts/quick_export.sh data.sql

# Hoặc nếu muốn chỉ định tên file khác
bash scripts/quick_export.sh backup_$(date +%Y%m%d).sql
```

**Kết quả:**
- ✅ File `data.sql` được tạo
- ✅ Backup tự động với timestamp
- ✅ Hiển thị kích thước file

### **Bước 2: Kiểm Tra Database (Tùy Chọn)**

```bash
# Xem thống kê database
node scripts/verify_database.js

# Hoặc xem nội dung file
head -50 data.sql
```

### **Bước 3: Nén File (Tùy Chọn nhưng Khuyến Nghị)**

```bash
# Nén file để giảm kích thước
gzip data.sql

# Kết quả: data.sql.gz (nhỏ hơn rất nhiều)
ls -lh data.sql.gz
```

### **Bước 4: Upload lên Cloud**

**Tùy theo nền tảng:**

#### AWS S3
```bash
aws s3 cp data.sql.gz s3://your-bucket/backups/
```

#### Google Cloud Storage
```bash
gsutil cp data.sql.gz gs://your-bucket/backups/
```

#### DigitalOcean Spaces
```bash
s3cmd put data.sql.gz s3://your-space/backups/
```

#### Azure Blob Storage
```bash
az storage blob upload --file data.sql.gz --container-name backups
```

### **Bước 5: Restore trên Cloud Server**

```bash
# 1. Download file từ cloud
aws s3 cp s3://your-bucket/backups/data.sql.gz .

# 2. Giải nén
gunzip data.sql.gz

# 3. Restore database
bash scripts/restore_database.sh data.sql

# Hoặc chạy trực tiếp
mysql -h cloud-db-host -u username -p bot_oc < data.sql
```

### **Bước 6: Xác Minh Dữ Liệu**

```bash
# Kết nối tới cloud database
mysql -h cloud-db-host -u username -p bot_oc

# Kiểm tra các bảng
SHOW TABLES;

# Đếm bản ghi
SELECT COUNT(*) FROM bots;
SELECT COUNT(*) FROM strategies;
SELECT COUNT(*) FROM positions;
```

---

## 📊 Database Structure

**Các bảng được export:**

```
bot_oc/
├── bots (Bot configurations & credentials)
├── strategies (Trading strategies)
├── positions (Open/closed positions)
├── candles (OHLCV data)
├── transactions (Transfer & withdraw history)
├── app_configs (App configurations)
├── symbol_filters (Symbol filters)
└── price_alert_configs (Price alert configs)
```

---

## ⚠️ Lưu Ý Quan Trọng

### [object Object]ảo Mật
- ❌ **Không commit** file `data.sql` vào Git
- 🔐 Mã hóa file trước khi upload
- [object Object]ử dụng HTTPS/SSH khi transfer
- 🔑 Quản lý credentials an toàn

### 📊 Dữ Liệu
- ✅ Kiểm tra số lượng bản ghi trước/sau restore
- 💾 Backup trước khi restore trên production
- ⏰ Thực hiện vào giờ off-peak
- [object Object]ác minh tính toàn vẹn dữ liệu

### ⚡ Performance
- [object Object]ếu database lớn (>1GB), xem xét export từng bảng
- 🔒 Sử dụng `--single-transaction` để tránh lock
- ⏱️ Có thể mất vài phút nếu dữ liệu lớn

---

## 🎯 Ví Dụ Thực Tế

### Scenario: Migrate từ Local lên AWS RDS

```bash
# ===== BƯỚC 1: LOCAL MACHINE =====

# 1.1 Export database
bash scripts/quick_export.sh data.sql

# 1.2 Nén file
gzip data.sql

# 1.3 Upload lên S3
aws s3 cp data.sql.gz s3://my-bucket/backups/

# ===== BƯỚC 2: CLOUD SERVER =====

# 2.1 Download file
aws s3 cp s3://my-bucket/backups/data.sql.gz .

# 2.2 Giải nén
gunzip data.sql.gz

# 2.3 Restore vào RDS
mysql -h bot-oc-db.xxxxx.us-east-1.rds.amazonaws.com \
      -u admin \
      -p \
      bot_oc < data.sql

# 2.4 Xác minh
mysql -h bot-oc-db.xxxxx.us-east-1.rds.amazonaws.com \
      -u admin \
      -p \
      bot_oc -e "SELECT COUNT(*) FROM bots;"

# ===== BƯỚC 3: UPDATE APPLICATION =====

# 3.1 Cập nhật .env trên cloud
# DB_HOST=bot-oc-db.xxxxx.us-east-1.rds.amazonaws.com
# DB_USER=admin
# DB_PASSWORD=your-password
# DB_NAME=bot_oc

# 3.2 Restart application
npm start
```

---

## 🔧 Troubleshooting

### ❌ Lỗi: "mysqldump: command not found"
```bash
# Cài MySQL client tools
sudo apt-get install mysql-client  # Ubuntu/Debian
brew install mysql-client          # macOS
```

### ❌ Lỗi: "Access denied for user"
```bash
# Kiểm tra credentials trong .env
cat .env | grep DB_

# Hoặc chỉ định trực tiếp
mysqldump -h localhost -u root -p bot_oc > data.sql
```

### ❌ Lỗi: "Unknown database"
```bash
# Kiểm tra database tồn tại
mysql -u root -p -e "SHOW DATABASES;"

# Tạo database nếu chưa có
mysql -u root -p -e "CREATE DATABASE bot_oc CHARACTER SET utf8mb4;"
```

### ❌ File quá lớn
```bash
# Export chỉ schema (không data)
mysqldump --no-data -u root -p bot_oc > schema.sql

# Export chỉ dữ liệu
mysqldump --no-create-info -u root -p bot_oc > data_only.sql

# Export từng bảng
mysqldump -u root -p bot_oc bots > bots.sql
```

---

## ✅ Checklist trước Migration

- [ ] Export database thành công
- [ ] Kiểm tra kích thước file
- [ ] Xác minh số lượng bản ghi
- [ ] Backup file export
- [ ] Mã hóa/bảo vệ file
- [ ] Upload lên cloud storage
- [ ] Kiểm tra file trên cloud
- [ ] Restore vào cloud database
- [ ] Xác minh dữ liệu sau restore
- [ ] Cập nhật connection string trong app
- [ ] Test kết nối từ app tới cloud DB
- [ ] Xóa file export từ local (nếu không cần)

---

## 📚 Tài Liệu Tham Khảo

- [MySQL mysqldump Documentation](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html)
- [AWS RDS Import](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MySQL.Procedural.Importing.html)
- [DigitalOcean Database Migration](https://docs.digitalocean.com/products/databases/mysql/how-to/migrate/)
- [Google Cloud SQL Import](https://cloud.google.com/sql/docs/mysql/import-export/import-export-sql)

---

## 🎓 Các Lệnh Hữu Ích

```bash
# Xem kích thước file
ls -lh data.sql

# Xem 20 dòng đầu
head -20 data.sql

# Đếm số INSERT statements
grep -c "^INSERT" data.sql

# Đếm số bảng
grep -c "^CREATE TABLE" data.sql

# Xem thống kê database
node scripts/verify_database.js

# Nén file
gzip data.sql

# Giải nén file
gunzip data.sql.gz

# Kiểm tra integrity
mysql -u root -p bot_oc < data.sql --verbose
```

---

## [object Object]ắt Đầu Ngay

**Cách nhanh nhất để export:**

```bash
# 1. Chạy script export
bash scripts/quick_export.sh data.sql

# 2. Nén file
gzip data.sql

# 3. Upload lên cloud
aws s3 cp data.sql.gz s3://your-bucket/backups/

# Done! ✅
```

---

## 📞 Hỗ Trợ

Nếu gặp vấn đề:

1. Kiểm tra `.env` file có đúng không
2. Xác minh MySQL credentials
3. Chạy `node scripts/verify_database.js` để kiểm tra database
4. Xem logs trong `logs/` directory

---

**Chúc bạn migration thành công![object Object]Last updated: 2025-12-05*

