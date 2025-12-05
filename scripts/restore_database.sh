#!/bin/bash

# Database Restore Script
# Restore exported database on cloud server

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   🔄 Bot-OC Database Restore          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check arguments
if [ $# -lt 1 ]; then
    echo -e "${RED}❌ Usage: bash scripts/restore_database.sh <sql_file>${NC}"
    echo ""
    echo "Examples:"
    echo "  bash scripts/restore_database.sh data.sql"
    echo "  bash scripts/restore_database.sh /path/to/backup.sql"
    exit 1
fi

SQL_FILE=$1

# Check if file exists
if [ ! -f "$SQL_FILE" ]; then
    echo -e "${RED}❌ Error: File not found: $SQL_FILE${NC}"
    exit 1
fi

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

echo ""
echo -e "${BLUE}Configuration:${NC}"
echo "  Host: $DB_HOST:$DB_PORT"
echo "  User: $DB_USER"
echo "  Database: $DB_NAME"
echo "  SQL File: $SQL_FILE"
echo "  File Size: $(du -h "$SQL_FILE" | cut -f1)"
echo ""

# Confirm before restore
echo -e "${YELLOW}⚠️  WARNING: This will restore the database from the SQL file${NC}"
read -p "Continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo -e "${YELLOW}Restore cancelled${NC}"
    exit 0
fi

echo ""
echo -e "${BLUE}Starting restore...${NC}"
echo ""

# Check if mysql is installed
if ! command -v mysql &> /dev/null; then
    echo -e "${RED}❌ Error: mysql client not found${NC}"
    echo "   Install with: sudo apt-get install mysql-client"
    exit 1
fi

# Restore database
START_TIME=$(date +%s)

if [ -z "$DB_PASSWORD" ]; then
    mysql \
        --host="$DB_HOST" \
        --port="$DB_PORT" \
        --user="$DB_USER" \
        "$DB_NAME" < "$SQL_FILE"
else
    mysql \
        --host="$DB_HOST" \
        --port="$DB_PORT" \
        --user="$DB_USER" \
        --password="$DB_PASSWORD" \
        "$DB_NAME" < "$SQL_FILE"
fi

if [ $? -eq 0 ]; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    
    echo ""
    echo -e "${GREEN}✅ Restore completed successfully!${NC}"
    echo "   Duration: ${DURATION}s"
    echo ""
    
    # Verify restore
    echo -e "${BLUE}[object Object]NC}"
    
    if [ -z "$DB_PASSWORD" ]; then
        mysql --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" "$DB_NAME" << EOF
SELECT 
    TABLE_NAME,
    TABLE_ROWS
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = '$DB_NAME'
ORDER BY TABLE_NAME;
EOF
    else
        mysql --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --password="$DB_PASSWORD" "$DB_NAME" << EOF
SELECT 
    TABLE_NAME,
    TABLE_ROWS
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = '$DB_NAME'
ORDER BY TABLE_NAME;
EOF
    fi
    
    echo ""
    echo -e "${GREEN}✨ Database restore complete!${NC}"
    echo ""
    echo -e "${BLUE}Next Steps:${NC}"
    echo "  1. Update your application connection string"
    echo "  2. Test database connectivity"
    echo "  3. Verify all data is present"
    echo "  4. Run any necessary migrations"
    
else
    echo -e "${RED}❌ Restore failed!${NC}"
    exit 1
fi

