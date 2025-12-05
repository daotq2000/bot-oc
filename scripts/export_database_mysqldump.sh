#!/bin/bash

# Database Export Script using mysqldump
# This is the recommended method for exporting MySQL databases
# 
# Usage: bash scripts/export_database_mysqldump.sh [output_file]
# Example: bash scripts/export_database_mysqldump.sh data.sql

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
fi

# Default values
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-3306}
DB_USER=${DB_USER:-root}
DB_PASSWORD=${DB_PASSWORD:-}
DB_NAME=${DB_NAME:-bot_oc}
OUTPUT_FILE=${1:-data.sql}

echo "🔄 Database Export Tool (mysqldump)"
echo "=================================================="
echo "📊 Database: $DB_NAME"
echo "[object Object]Host: $DB_HOST:$DB_PORT"
echo "👤 User: $DB_USER"
echo "📁 Output: $OUTPUT_FILE"
echo "=================================================="
echo ""

# Check if mysqldump is installed
if ! command -v mysqldump &> /dev/null; then
    echo "❌ Error: mysqldump is not installed"
    echo "   Please install MySQL client tools:"
    echo "   - Ubuntu/Debian: sudo apt-get install mysql-client"
    echo "   - macOS: brew install mysql-client"
    echo "   - Windows: Download MySQL Community Server"
    exit 1
fi

echo "⏳ Starting database export..."
echo ""

# Export database
if [ -z "$DB_PASSWORD" ]; then
    # No password
    mysqldump \
        --host="$DB_HOST" \
        --port="$DB_PORT" \
        --user="$DB_USER" \
        --single-transaction \
        --lock-tables=false \
        --routines \
        --triggers \
        --events \
        --result-file="$OUTPUT_FILE" \
        "$DB_NAME"
else
    # With password
    mysqldump \
        --host="$DB_HOST" \
        --port="$DB_PORT" \
        --user="$DB_USER" \
        --password="$DB_PASSWORD" \
        --single-transaction \
        --lock-tables=false \
        --routines \
        --triggers \
        --events \
        --result-file="$OUTPUT_FILE" \
        "$DB_NAME"
fi

if [ $? -eq 0 ]; then
    FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
    echo "✅ Export completed successfully!"
    echo "📁 File saved to: $(pwd)/$OUTPUT_FILE"
    echo "📊 File size: $FILE_SIZE"
    echo ""
    echo "💡 Next steps for cloud deployment:"
    echo "   1. Compress the file: gzip $OUTPUT_FILE"
    echo "   2. Upload to cloud storage (S3, GCS, etc.)"
    echo "   3. On cloud server, restore with:"
    echo "      mysql -h <cloud-host> -u <user> -p < $OUTPUT_FILE"
else
    echo "❌ Export failed!"
    exit 1
fi

