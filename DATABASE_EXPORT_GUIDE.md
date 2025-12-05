# 📊 Database Export & Cloud Migration Guide

Hướng dẫn xuất database bot-oc hiện tại thành file `data.sql` để di chuyển lên cloud.

## [object Object]ổng Quan

Bạn có 2 cách để export database:

1. **Cách 1: Sử dụng `mysqldump` (Khuyến nghị)** ⭐
   - Nhanh, hiệu quả, tối ưu cho production
   - Yêu cầu cài MySQL client tools

2. **Cách 2: Sử dụng Node.js script**
   - Không cần cài thêm công cụ
   - Phù hợp nếu chỉ có Node.js

---

## 🚀 Cách 1: Export với mysqldump (Khuyến nghị)

### Bước 1: Kiểm tra MySQL client

```bash
# Kiểm tra mysqldump đã cài chưa
which mysqldump

# Nếu chưa cài, cài theo hệ điều hành:
# Ubuntu/Debian:
sudo apt-get install mysql-client

# macOS:
brew install mysql-client

# Windows: Download MySQL Community Server
```

### Bước 2: Export database

```bash
# Cách đơn giản nhất - sử dụng script có sẵn
bash scripts/export_database_mysqldump.sh data.sql

# Hoặc chạy trực tiếp mysqldump:
mysqldump \
  --host=localhost \
  --port=3306 \
  --user=root \
  --password \
  --single-transaction \
  --lock-tables=false \
  bot_oc > data.sql
```

### Bước 3: Kiểm tra file export

```bash
# Kiểm tra kích thước file
ls -lh data.sql

# Kiểm tra nội dung (xem 20 dòng đầu)
head -20 data.sql

# Đếm số lượng INSERT statements
grep -c "^INSERT" data.sql
```

---

## 🔧 Cách 2: Export với Node.js Script

### Bước 1: Chạy export script

```bash
# Export với tên file mặc định (data.sql)
node scripts/export_database.js

# Hoặc chỉ định tên file khác
node scripts/export_database.js backup_2025_12_05.sql
```

### Bước 2: Kiểm tra kết quả

```bash
# Xem kích thước file
ls -lh data.sql

# Xem 30 dòng đầu
head -30 data.sql
```

---

## 📦 Chuẩn bị cho Cloud Migration

### Bước 1: Nén file (tùy chọn nhưng khuyến nghị)

```bash
# Nén file để giảm kích thước
gzip data.sql

# Kết quả: data.sql.gz (nhỏ hơn rất nhiều)
ls -lh data.sql.gz
```

### Bước 2: Upload lên Cloud

**Tùy theo nền tảng cloud bạn sử dụng:**

#### AWS S3
```bash
# Cài AWS CLI nếu chưa có
pip install awscli

# Upload file
aws s3 cp data.sql.gz s3://your-bucket/backups/

# Hoặc upload trực tiếp từ web console
```

#### Google Cloud Storage
```bash
# Cài Google Cloud SDK
curl https://sdk.cloud.google.com | bash

# Upload file
gsutil cp data.sql.gz gs://your-bucket/backups/
```

#### Azure Blob Storage
```bash
# Sử dụng Azure Storage Explorer
# Hoặc Azure CLI
az storage blob upload --file data.sql.gz --container-name backups
```

#### DigitalOcean Spaces
```bash
# Sử dụng s3cmd hoặc web console
s3cmd put data.sql.gz s3://your-space/backups/
```

---

## 🔄 Restore Database trên Cloud

### Bước 1: Download file từ cloud

```bash
# Ví dụ với AWS S3
aws s3 cp s3://your-bucket/backups/data.sql.gz .

# Giải nén
gunzip data.sql.gz
```

### Bước 2: Restore database

```bash
# Cách 1: Restore trực tiếp
mysql -h <cloud-db-host> -u <username> -p <database_name> < data.sql

# Cách 2: Từ MySQL shell
mysql -h <cloud-db-host> -u <username> -p
mysql> source data.sql;
```

### Bước 3: Xác minh dữ liệu

```bash
# Kết nối tới cloud database
mysql -h <cloud-db-host> -u <username> -p bot_oc

# Kiểm tra các bảng
SHOW TABLES;

# Đếm số bản ghi trong mỗi bảng
SELECT TABLE_NAME, TABLE_ROWS 
FROM INFORMATION_SCHEMA.TABLES 
WHERE TABLE_SCHEMA = 'bot_oc';

# Kiểm tra dữ liệu cụ thể
SELECT COUNT(*) FROM bots;
SELECT COUNT(*) FROM strategies;
SELECT COUNT(*) FROM positions;
```

---

## 📋 Danh sách các bảng được export

Database `bot_oc` chứa các bảng sau:

| Bảng | Mô tả |
|------|-------|
| `bots` | Thông tin bot và exchange credentials |
| `strategies` | Chiến lược trading cho mỗi bot |
| `positions` | Các vị thế đang mở/đã đóng |
| `candles` | Dữ liệu nến (OHLCV) |
| `transactions` | Lịch sử transfer và withdraw |
| `app_configs` | Cấu hình ứng dụng |
| `symbol_filters` | Bộ lọc ký hiệu |
| `price_alert_configs` | Cấu hình cảnh báo giá |

---

## ⚠️ Lưu ý Quan Trọng

### Bảo mật
- ✅ File SQL chứa **tất cả dữ liệu nhạy cảm** (API keys, secrets)
- ⚠️ **Không commit vào Git** - thêm vào `.gitignore`
- 🔒 Mã hóa file trước khi upload
- 🔐 Sử dụng HTTPS/SSH khi transfer

### Dữ liệu
- 📊 Kiểm tra số lượng bản ghi trước/sau restore
- 🔄 Backup trước khi restore trên production
- ⏰ Thực hiện vào giờ off-peak

### Performance
- 💾 Nếu database lớn (>1GB), xem xét export từng bảng
- [object Object]ử dụng `--single-transaction` để tránh lock
- 📈 Có thể mất vài phút nếu dữ liệu lớn

---

## [object Object]eshooting

### Lỗi: "mysqldump: command not found"
```bash
# Cài MySQL client tools
sudo apt-get install mysql-client  # Ubuntu/Debian
brew install mysql-client          # macOS
```

### Lỗi: "Access denied for user"
```bash
# Kiểm tra credentials trong .env
cat .env | grep DB_

# Hoặc chỉ định trực tiếp
mysqldump -h localhost -u root -p bot_oc > data.sql
```

### Lỗi: "Unknown database"
```bash
# Kiểm tra database tồn tại
mysql -u root -p -e "SHOW DATABASES;"

# Tạo database nếu chưa có
mysql -u root -p -e "CREATE DATABASE bot_oc CHARACTER SET utf8mb4;"
```

### File quá lớn
```bash
# Export chỉ schema (không data)
mysqldump --no-data -u root -p bot_oc > schema.sql

# Export chỉ dữ liệu
mysqldump --no-create-info -u root -p bot_oc > data_only.sql

# Export từng bảng
mysqldump -u root -p bot_oc bots > bots.sql
```

---

## 📝 Ví dụ Hoàn Chỉnh

### Scenario: Migrate từ Local lên AWS RDS

```bash
# 1. Export từ local
bash scripts/export_database_mysqldump.sh data.sql

# 2. Nén file
gzip data.sql

# 3. Upload lên S3
aws s3 cp data.sql.gz s3://my-bucket/backups/

# 4. Trên cloud server, download
aws s3 cp s3://my-bucket/backups/data.sql.gz .

# 5. Giải nén
gunzip data.sql.gz

# 6. Restore vào RDS
mysql -h bot-oc-db.xxxxx.us-east-1.rds.amazonaws.com \
      -u admin \
      -p \
      bot_oc < data.sql

# 7. Xác minh
mysql -h bot-oc-db.xxxxx.us-east-1.rds.amazonaws.com \
      -u admin \
      -p \
      bot_oc -e "SELECT COUNT(*) FROM bots;"
```

---

## 🎓 Tài Liệu Tham Khảo

- [MySQL mysqldump Documentation](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html)
- [AWS RDS Import](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MySQL.Procedural.Importing.html)
- [DigitalOcean Database Migration](https://docs.digitalocean.com/products/databases/mysql/how-to/migrate/)

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

**Cần giúp gì thêm? Hãy liên hệ!** 🚀

