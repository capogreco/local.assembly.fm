#!/bin/bash
# Startup script for local.assembly.fm on macOS
# Usage:
#   ./start-macos.sh            Start everything (dnsmasq + server)
#   ./start-macos.sh dns        Start DNS server only
#   ./start-macos.sh server     Start Deno server only
#   ./start-macos.sh dev        Start with auto-reload on file changes
#   ./start-macos.sh local      Patch-editing only — no dnsmasq, no subnet check (localhost)
#   ./start-macos.sh status     Show system status

set -e

# Fixed config
SUBNET="192.168.178"
STATIC_IP="192.168.178.24"  # must match FritzBox DNS server setting
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

# --- Auto-detect network interface and IP on the assembly subnet ---

detect_network() {
    local found_if=""
    local found_ip=""

    # scan all interfaces for one with an IP on the assembly subnet
    while IFS= read -r line; do
        if [[ "$line" =~ ^([a-z0-9]+): ]]; then
            current_if="${BASH_REMATCH[1]}"
        fi
        if [[ "$line" =~ inet\ ($SUBNET\.[0-9]+) ]]; then
            found_if="$current_if"
            found_ip="${BASH_REMATCH[1]}"
            break
        fi
    done < <(ifconfig)

    if [ -z "$found_if" ]; then
        echo_error "No interface found on $SUBNET.x subnet"
        echo_error "Is the ethernet cable connected to the network hardware?"
        echo ""
        echo "Available interfaces with IPs:"
        ifconfig | grep -E "^[a-z]|inet " | grep -B1 "inet " | grep -v "^--$"
        exit 1
    fi

    ETHERNET_IF="$found_if"

    # ensure the interface has the static IP the FritzBox expects
    if [ "$found_ip" != "$STATIC_IP" ]; then
        echo_warn "Interface $ETHERNET_IF has IP $found_ip, FritzBox expects $STATIC_IP"
        echo_info "Setting static IP $STATIC_IP on $ETHERNET_IF..."
        sudo ifconfig "$ETHERNET_IF" "$STATIC_IP" netmask 255.255.255.0
        # re-add the gateway so we stay routable on the subnet
        sudo route -n add -net "$SUBNET.0/24" "$STATIC_IP" 2>/dev/null || true
        echo_info "IP set to $STATIC_IP"
    fi

    MAC_IP="$STATIC_IP"
    echo_info "Detected interface: $ETHERNET_IF ($MAC_IP)"
}

# --- Kill stale dnsmasq if running on wrong interface/IP ---

DNSMASQ_ALREADY_OK=false

ensure_clean_dnsmasq() {
    if pgrep -f "dnsmasq" > /dev/null 2>&1; then
        # check if current config matches what we need
        local needs_restart=false

        if [ -f "$DNSMASQ_CONF" ]; then
            local conf_if=$(grep "^interface=" "$DNSMASQ_CONF" 2>/dev/null | cut -d= -f2)
            local conf_ip=$(grep "^address=" "$DNSMASQ_CONF" 2>/dev/null | sed 's|address=/\#/||')
            if [ "$conf_if" != "$ETHERNET_IF" ] || [ "$conf_ip" != "$MAC_IP" ]; then
                needs_restart=true
                echo_warn "Stale dnsmasq running (interface=$conf_if, ip=$conf_ip)"
            fi
        else
            needs_restart=true
        fi

        if [ "$needs_restart" = true ]; then
            echo_info "Killing stale dnsmasq..."
            sudo pkill -f dnsmasq || true
            sleep 1
        else
            echo_info "dnsmasq already running with correct config"
            DNSMASQ_ALREADY_OK=true
        fi
    fi
}

# --- Write dnsmasq config if needed ---

ensure_dnsmasq_conf() {
    local needs_update=false

    if [ ! -f "$DNSMASQ_CONF" ]; then
        needs_update=true
    else
        local conf_if=$(grep "^interface=" "$DNSMASQ_CONF" 2>/dev/null | cut -d= -f2)
        local conf_ip=$(grep "^address=" "$DNSMASQ_CONF" 2>/dev/null | sed 's|address=/\#/||')
        if [ "$conf_if" != "$ETHERNET_IF" ] || [ "$conf_ip" != "$MAC_IP" ]; then
            needs_update=true
            echo_warn "dnsmasq config out of date (was $conf_if/$conf_ip, now $ETHERNET_IF/$MAC_IP)"
        fi
    fi

    if [ "$needs_update" = true ]; then
        echo_info "Writing dnsmasq config..."
        sudo mkdir -p "$(dirname "$DNSMASQ_CONF")"
        echo "interface=$ETHERNET_IF
address=/#/$MAC_IP" | sudo tee "$DNSMASQ_CONF" > /dev/null
        echo_info "Updated $DNSMASQ_CONF"
    fi
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
        echo "  cd $PROJECT_DIR"
        echo "  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \\"
        echo "    -nodes -keyout key.pem -out cert.pem -days 365 \\"
        echo "    -subj '/CN=local.assembly.fm'"
        exit 1
    fi
}

start_dns() {
    detect_network
    ensure_clean_dnsmasq
    ensure_dnsmasq_conf

    echo_info "Starting dnsmasq DNS server..."
    echo_info "Interface: $ETHERNET_IF → resolving all DNS to $MAC_IP"
    echo_info "Press Ctrl+C to stop"
    echo ""

    sudo "$DNSMASQ_BIN" \
        --keep-in-foreground \
        --bind-interfaces \
        --conf-file="$DNSMASQ_CONF"
}

start_server() {
    detect_network

    echo_info "Starting Deno server on ports 80 (HTTP) and 443 (HTTPS)..."
    echo_info "Captive portal: http://$MAC_IP (auto-redirects)"
    echo_info "Synth client: https://$MAC_IP"
    echo_info "Control interface: https://$MAC_IP/ctrl.html"
    echo_info "Press Ctrl+C to stop"
    echo ""

    cd "$PROJECT_DIR"
    sudo $(which deno) run -A --unstable-net server.ts
}

start_dev() {
    detect_network

    echo_info "Starting Deno server in dev mode (auto-reload on file changes)..."
    echo_info "Captive portal: http://$MAC_IP (auto-redirects)"
    echo_info "Synth client: https://$MAC_IP"
    echo_info "Control interface: https://$MAC_IP/ctrl.html"
    echo_info "Press Ctrl+C to stop"
    echo ""

    cd "$PROJECT_DIR"
    sudo $(which deno) run -A --unstable-net --watch=server.ts,eval-engine.ts,hardware.ts,patch-state.ts,public/gpi-types.js,public/graph-core.js server.ts
}

show_status() {
    detect_network

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
    echo "Interface: $ETHERNET_IF"
    echo "IP: $MAC_IP"

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
    dev)
        check_prerequisites
        detect_network
        ensure_clean_dnsmasq
        ensure_dnsmasq_conf

        if [ "$DNSMASQ_ALREADY_OK" = false ]; then
            echo_info "Starting dnsmasq in background..."
            sudo "$DNSMASQ_BIN" \
                --bind-interfaces \
                --conf-file="$DNSMASQ_CONF"
            echo_info "dnsmasq running (interface=$ETHERNET_IF → $MAC_IP)"
        fi

        echo_info "Starting Deno server in dev mode (auto-reload on file changes)..."
        echo_info "Captive portal: http://$MAC_IP"
        echo_info "Ctrl+C to stop (will also kill dnsmasq)"
        echo ""

        trap 'sudo pkill -f "dnsmasq.*assembly.conf" 2>/dev/null; echo ""; echo_info "Stopped."' EXIT

        cd "$PROJECT_DIR"
        sudo $(which deno) run -A --unstable-net --watch=server.ts,eval-engine.ts,hardware.ts,patch-state.ts,public/gpi-types.js,public/graph-core.js server.ts
        ;;
    local)
        # Patch-editing mode — no dnsmasq, no network hardware required.
        # Serves on localhost so you can open https://localhost/ctrl.html
        # (or https://local.assembly.fm/ctrl.html if 127.0.0.1 is in /etc/hosts).
        check_prerequisites

        echo_info "Starting Deno server in local mode (auto-reload on file changes)..."
        echo_info "ctrl:     https://localhost/ctrl.html"
        echo_info "synth:    https://localhost/"
        echo_info "Ctrl+C to stop"
        echo ""

        cd "$PROJECT_DIR"
        sudo $(which deno) run -A --unstable-net --watch=server.ts,eval-engine.ts,hardware.ts,patch-state.ts,public/gpi-types.js,public/graph-core.js server.ts
        ;;
    status)
        show_status
        ;;
    *)
        check_prerequisites
        detect_network
        ensure_clean_dnsmasq
        ensure_dnsmasq_conf

        if [ "$DNSMASQ_ALREADY_OK" = false ]; then
            echo_info "Starting dnsmasq in background..."
            sudo "$DNSMASQ_BIN" \
                --bind-interfaces \
                --conf-file="$DNSMASQ_CONF"
            echo_info "dnsmasq running (interface=$ETHERNET_IF → $MAC_IP)"
        fi

        echo_info "Starting Deno server..."
        echo_info "Captive portal: http://$MAC_IP"
        echo_info "Ctrl+C to stop (will also kill dnsmasq)"
        echo ""

        # kill dnsmasq when the server exits
        trap 'sudo pkill -f "dnsmasq.*assembly.conf" 2>/dev/null; echo ""; echo_info "Stopped."' EXIT

        cd "$PROJECT_DIR"
        sudo $(which deno) run -A --unstable-net server.ts
        ;;
esac
