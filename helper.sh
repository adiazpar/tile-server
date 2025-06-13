#!/bin/bash

# Event Horizon Tile Server Helper Script
# Usage: ./tile-helper.sh [command] [options]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_NAME="tile-server"
SERVER_SCRIPT="src/server.js"
PROCESS_SCRIPT="scripts/process-tiff.js"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_usage() {
    echo -e "${BLUE}Event Horizon Tile Server Helper${NC}"
    echo ""
    echo "Usage: $0 [command] [options]"
    echo ""
    echo "Server Management:"
    echo "  start         Start the tile server"
    echo "  stop          Stop the tile server"
    echo "  restart       Restart the tile server"
    echo "  status        Show server status"
    echo "  logs          Show server logs"
    echo "  health        Check server health"
    echo ""
    echo "Processing Commands:"
    echo "  process <file> [options]  Process a TIFF file"
    echo "  quick <file>              Quick process (max-zoom 6, web-mercator)"
    echo "  full <file>               Full process (max-zoom 12, web-mercator)"
    echo ""
    echo "System Management:"
    echo "  monitor       Show system resources"
    echo "  cleanup       Clean old logs and temp files"
    echo "  backup        Backup tiles directory"
    echo ""
    echo "Processing Options:"
    echo "  --min-zoom <n>       Minimum zoom level (default: 0)"
    echo "  --max-zoom <n>       Maximum zoom level (default: 12)"
    echo "  --force-web-mercator Force Web Mercator projection"
    echo "  --processes <n>      Number of parallel processes (default: 4)"
    echo ""
    echo "Examples:"
    echo "  $0 start"
    echo "  $0 process data/pollution.tif --max-zoom 8"
    echo "  $0 quick data/pollution.tif"
    echo "  $0 logs"
}

check_dependencies() {
    # Check if Node.js is installed
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is not installed${NC}"
        exit 1
    fi

    # Check if PM2 is installed
    if ! command -v pm2 &> /dev/null; then
        echo -e "${RED}Error: PM2 is not installed${NC}"
        echo "Install with: npm install -g pm2"
        exit 1
    fi

    # Check if GDAL is installed
    if ! command -v gdal2tiles.py &> /dev/null; then
        echo -e "${RED}Error: GDAL is not installed${NC}"
        echo "Install with: sudo apt-get install gdal-bin"
        exit 1
    fi
}

server_start() {
    echo -e "${BLUE}Starting tile server...${NC}"
    
    # Check if already running
    if pm2 describe "$SERVER_NAME" &> /dev/null; then
        echo -e "${YELLOW}Server is already running${NC}"
        pm2 describe "$SERVER_NAME"
        return 0
    fi

    # Start the server
    cd "$SCRIPT_DIR"
    pm2 start "$SERVER_SCRIPT" --name "$SERVER_NAME" --time
    
    # Configure startup
    pm2 startup --output-pid=/dev/null --silent
    pm2 save
    
    echo -e "${GREEN}Server started successfully${NC}"
    sleep 2
    server_status
}

server_stop() {
    echo -e "${BLUE}Stopping tile server...${NC}"
    pm2 stop "$SERVER_NAME"
    pm2 delete "$SERVER_NAME"
    echo -e "${GREEN}Server stopped${NC}"
}

server_restart() {
    echo -e "${BLUE}Restarting tile server...${NC}"
    pm2 restart "$SERVER_NAME"
    echo -e "${GREEN}Server restarted${NC}"
    sleep 2
    server_status
}

server_status() {
    echo -e "${BLUE}Server Status:${NC}"
    pm2 describe "$SERVER_NAME" 2>/dev/null || echo -e "${RED}Server is not running${NC}"
    echo ""
    echo -e "${BLUE}All PM2 processes:${NC}"
    pm2 status
}

server_logs() {
    echo -e "${BLUE}Showing server logs (Ctrl+C to exit):${NC}"
    pm2 logs "$SERVER_NAME"
}

server_health() {
    echo -e "${BLUE}Checking server health...${NC}"
    
    # Try to get server info
    local response=$(curl -s -w "%{http_code}" http://localhost:3001/health)
    local http_code="${response: -3}"
    local body="${response%???}"
    
    if [ "$http_code" = "200" ]; then
        echo -e "${GREEN}✓ Server is healthy${NC}"
        echo "$body" | jq . 2>/dev/null || echo "$body"
    else
        echo -e "${RED}✗ Server health check failed (HTTP $http_code)${NC}"
        echo "$body"
    fi
}

process_tiff() {
    local file="$1"
    shift
    local options="$@"
    
    if [ -z "$file" ]; then
        echo -e "${RED}Error: No file specified${NC}"
        print_usage
        exit 1
    fi
    
    if [ ! -f "$file" ]; then
        echo -e "${RED}Error: File '$file' not found${NC}"
        exit 1
    fi
    
    echo -e "${BLUE}Processing TIFF file: $file${NC}"
    echo -e "${BLUE}Options: $options${NC}"
    echo ""
    
    cd "$SCRIPT_DIR"
    node "$PROCESS_SCRIPT" "$file" $options
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Processing completed successfully${NC}"
    else
        echo -e "${RED}✗ Processing failed${NC}"
        exit 1
    fi
}

quick_process() {
    local file="$1"
    echo -e "${YELLOW}Quick processing: $file${NC}"
    process_tiff "$file" --force-web-mercator --max-zoom 6 --processes 4
}

full_process() {
    local file="$1"
    echo -e "${YELLOW}Full processing: $file${NC}"
    process_tiff "$file" --force-web-mercator --max-zoom 12 --processes 4
}

show_monitor() {
    echo -e "${BLUE}System Resources:${NC}"
    echo ""
    echo -e "${BLUE}Memory Usage:${NC}"
    free -h
    echo ""
    echo -e "${BLUE}Disk Usage:${NC}"
    df -h
    echo ""
    echo -e "${BLUE}CPU Usage:${NC}"
    top -b -n1 | grep "Cpu(s)" || echo "CPU info not available"
    echo ""
    echo -e "${BLUE}PM2 Monitoring:${NC}"
    pm2 monit --no-interaction || echo "PM2 monitoring not available"
}

cleanup_files() {
    echo -e "${BLUE}Cleaning up old files...${NC}"
    
    cd "$SCRIPT_DIR"
    
    # Clean old log files (older than 7 days)
    find logs/ -name "*.json" -mtime +7 -delete 2>/dev/null && echo "✓ Cleaned old log files"
    
    # Clean temporary files
    find data/ -name "*_temp*" -delete 2>/dev/null && echo "✓ Cleaned temporary files"
    find data/ -name "*_optimized*" -delete 2>/dev/null && echo "✓ Cleaned optimization files"
    
    # PM2 log cleanup
    pm2 flush
    
    echo -e "${GREEN}Cleanup completed${NC}"
}

backup_tiles() {
    local backup_dir="backups/tiles_$(date +%Y%m%d_%H%M%S)"
    
    echo -e "${BLUE}Creating backup of tiles directory...${NC}"
    
    cd "$SCRIPT_DIR"
    mkdir -p backups
    
    if [ -d "tiles" ] && [ "$(ls -A tiles)" ]; then
        tar -czf "${backup_dir}.tar.gz" tiles/
        echo -e "${GREEN}✓ Backup created: ${backup_dir}.tar.gz${NC}"
    else
        echo -e "${YELLOW}No tiles to backup${NC}"
    fi
}

# Main script logic
cd "$SCRIPT_DIR"

case "$1" in
    "start")
        check_dependencies
        server_start
        ;;
    "stop")
        server_stop
        ;;
    "restart")
        server_restart
        ;;
    "status")
        server_status
        ;;
    "logs")
        server_logs
        ;;
    "health")
        server_health
        ;;
    "process")
        check_dependencies
        shift
        process_tiff "$@"
        ;;
    "quick")
        check_dependencies
        quick_process "$2"
        ;;
    "full")
        check_dependencies
        full_process "$2"
        ;;
    "monitor")
        show_monitor
        ;;
    "cleanup")
        cleanup_files
        ;;
    "backup")
        backup_tiles
        ;;
    *)
        print_usage
        exit 1
        ;;
esac