#!/bin/bash
# Startup script for local.assembly.fm on macOS
# Run this script in two terminals:
# Terminal 1: ./start-macos.sh dns
# Terminal 2: ./start-macos.sh server

set -e

# Configuration
MAC_IP="192.168.178.24"
ETHERNET_IF="en5"
PROJECT_DIR="/Users/capo_greco/Documents/local.assembly.fm"
DNSMASQ_BIN="/opt/homebrew/opt/dnsmasq/sbin/dnsmasq"
DNSMASQ_CONF="/opt/homebrew/etc/dnsmasq.d/assembly.conf"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_prerequisites() {
    echo_info "Checking prerequisites..."

    # Check if dnsmasq is installed
    if [ ! -f "$DNSMASQ_BIN" ]; then
        echo_error "dnsmasq not found. Install with: brew install dnsmasq"
        exit 1
    fi

    # Check if deno is installed
    if ! command -v deno &> /dev/null; then
        echo_error "deno not found. Install from https://deno.land/"
        exit 1
    fi

    # Check if certificates exist
    if [ ! -f "$PROJECT_DIR/cert.pem" ] || [ ! -f "$PROJECT_DIR/key.pem" ]; then
        echo_error "TLS certificates not found. Generate with:"
        echo "  brew install certbot"
        echo "  sudo certbot certonly --manual --preferred-challenges dns -d local.assembly.fm"
        exit 1
    fi

    # Check if dnsmasq config exists
    if [ ! -f "$DNSMASQ_CONF" ]; then
        echo_warn "dnsmasq config not found. Creating..."
        sudo mkdir -p "$(dirname $DNSMASQ_CONF)"
        echo "interface=$ETHERNET_IF
address=/#/$MAC_IP" | sudo tee "$DNSMASQ_CONF" > /dev/null
        echo_info "Created $DNSMASQ_CONF"
    fi

    # Check if ethernet interface has IP
    if ! ifconfig "$ETHERNET_IF" | grep -q "inet $MAC_IP"; then
        echo_warn "Ethernet interface $ETHERNET_IF doesn't have IP $MAC_IP"
        echo_warn "Current IP: $(ifconfig $ETHERNET_IF | grep 'inet ' | awk '{print $2}')"
        echo_warn "You may need to:"
        echo_warn "  1. Verify ethernet cable is connected"
        echo_warn "  2. Configure static IP in System Settings → Network"
        echo_warn "  3. Or ensure FritzBox DHCP assigns $MAC_IP"
    fi
}

start_dns() {
    echo_info "Starting dnsmasq DNS server..."
    echo_info "This will resolve ALL DNS queries to $MAC_IP"
    echo_info "Press Ctrl+C to stop"
    echo ""

    sudo "$DNSMASQ_BIN" \
        --keep-in-foreground \
        --bind-interfaces \
        --conf-file="$DNSMASQ_CONF"
}

start_server() {
    echo_info "Starting Deno server on ports 80 (HTTP) and 443 (HTTPS)..."
    echo_info "Captive portal: http://$MAC_IP (auto-redirects)"
    echo_info "Synth client: https://$MAC_IP"
    echo_info "Control interface: https://$MAC_IP/ctrl.html"
    echo_info "Press Ctrl+C to stop"
    echo ""

    cd "$PROJECT_DIR"
    sudo HOST_IP="$MAC_IP" deno task start
}

show_status() {
    echo_info "=== local.assembly.fm Status ==="
    echo ""

    # Check dnsmasq
    if pgrep -f "dnsmasq.*assembly.conf" > /dev/null; then
        echo_info "✓ dnsmasq is running"
    else
        echo_warn "✗ dnsmasq is NOT running"
        echo "  Start with: ./start-macos.sh dns"
    fi

    # Check Deno server
    if sudo lsof -i :443 | grep -q LISTEN; then
        echo_info "✓ Deno server is running on port 443"
    else
        echo_warn "✗ Deno server is NOT running"
        echo "  Start with: ./start-macos.sh server"
    fi

    # Check network
    echo ""
    echo_info "=== Network Status ==="
    echo "Ethernet interface: $ETHERNET_IF"
    echo "Expected IP: $MAC_IP"
    echo "Current IP: $(ifconfig $ETHERNET_IF 2>/dev/null | grep 'inet ' | awk '{print $2}' || echo 'NOT FOUND')"

    # Check APs
    echo ""
    echo_info "=== Access Points ==="
    if ping -c 1 -W 1 192.168.178.20 &>/dev/null; then
        echo_info "✓ AP #1 (192.168.178.20) is reachable"
    else
        echo_warn "✗ AP #1 (192.168.178.20) is NOT reachable"
    fi

    if ping -c 1 -W 1 192.168.178.21 &>/dev/null; then
        echo_info "✓ AP #2 (192.168.178.21) is reachable"
    else
        echo_warn "✗ AP #2 (192.168.178.21) is NOT reachable"
    fi

    echo ""
    echo_info "=== Quick Test ==="
    echo "On your phone:"
    echo "  1. Connect to WiFi 'assembly' (password: assembly)"
    echo "  2. Captive portal should auto-appear"
    echo "  3. Or visit any URL (e.g., example.com) to trigger redirect"
}

# Main
case "${1:-}" in
    dns)
        check_prerequisites
        start_dns
        ;;
    server)
        check_prerequisites
        start_server
        ;;
    status)
        show_status
        ;;
    *)
        echo "local.assembly.fm macOS startup script"
        echo ""
        echo "Usage:"
        echo "  ./start-macos.sh dns       Start DNS server (dnsmasq)"
        echo "  ./start-macos.sh server    Start Deno server (synth + captive portal)"
        echo "  ./start-macos.sh status    Show system status"
        echo ""
        echo "For performance, run in two terminals:"
        echo "  Terminal 1: ./start-macos.sh dns"
        echo "  Terminal 2: ./start-macos.sh server"
        echo ""
        echo "Or check current status:"
        echo "  ./start-macos.sh status"
        exit 1
        ;;
esac
