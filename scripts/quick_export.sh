#!/bin/bash

# Quick Database Export Script
# Fastest way to export your bot-oc database

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   🚀 Bot-OC Database Quick Export     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
    echo -e "${GREEN}✅ Loaded .env configuration${NC}"
else
    echo -e "${YELLOW}⚠️  .env file not found, using defaults${NC}"
fi

# Database configuration
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-3306}
DB_USER=${DB_USER:-root}
DB_PASSWORD=${DB_PASSWORD:-}
DB_NAME=${DB_NAME:-bot_oc}
OUTPUT_FILE=${1:-data.sql}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="data_${TIMESTAMP}.sql"

echo -e "${BLUE}Configuration:${NC}"
echo "  Database: $DB_NAME"
echo "  Host: $DB_HOST:$DB_PORT"
echo "  User: $DB_USER"
echo ""

# Check if mysqldump exists
if ! command -v mysqldump &> /dev/null; then
    echo -e "${YELLOW}⚠️  mysqldump not found. Trying Node.js export...${NC}"
    echo ""
    
    # Use Node.js script
    if [ -f scripts/export_database.js ]; then
        node scripts/export_database.js "$OUTPUT_FILE"
    else
        echo -e "${RED}❌ Error: export_database.js not found${NC}"
        exit 1
    fi
else
    echo -e "${BLUE}Using mysqldump for export...${NC}"
    echo ""
    
    # Use mysqldump
    if [ -z "$DB_PASSWORD" ]; then
        mysqldump \
            --host="$DB_HOST" \
            --port="$DB_PORT" \
            --user="$DB_USER" \
            --single-transaction \
            --lock-tables=false \
            --result-file="$OUTPUT_FILE" \
            "$DB_NAME"
    else
        mysqldump \
            --host="$DB_HOST" \
            --port="$DB_PORT" \
            --user="$DB_USER" \
            --password="$DB_PASSWORD" \
            --single-transaction \
            --lock-tables=false \
            --result-file="$OUTPUT_FILE" \
            "$DB_NAME"
    fi
    
    if [ $? -eq 0 ]; then
        FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
        echo -e "${GREEN}✅ Export completed successfully!${NC}"
        echo ""
        echo -e "${BLUE}📊 Export Summary:${NC}"
        echo "  File: $OUTPUT_FILE"
        echo "  Size: $FILE_SIZE"
        echo ""
        
        # Create backup copy with timestamp
        cp "$OUTPUT_FILE" "$BACKUP_FILE"
        echo -e "${GREEN}✅ Backup copy created: $BACKUP_FILE${NC}"
        echo ""
        
        # Show next steps
        echo -e "${[object Object]:${NC}"
        echo "  1. Compress: gzip $OUTPUT_FILE"
        echo "  2. Upload to cloud storage"
        echo "  3. Restore on cloud: mysql -h <host> -u <user> -p < $OUTPUT_FILE"
        echo ""
        
        # Show table statistics
        echo -e "${[object Object]:${NC}"
        INSERT_COUNT=$(grep -c "^INSERT" "$OUTPUT_FILE" || echo "0")
        echo "  Total INSERT statements: $INSERT_COUNT"
        
        TABLE_COUNT=$(grep -c "^CREATE TABLE" "$OUTPUT_FILE" || echo "0")
        echo "  Total tables: $TABLE_COUNT"
        
        echo ""
        echo -e "${GREEN}✨ Export ready for cloud migration!${NC}"
    else
        echo -e "${RED}❌ Export failed!${NC}"
        exit 1
    fi
fi
